import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authStoreMocks = vi.hoisted(() => ({
  issue: vi.fn(),
  verify: vi.fn(),
}));
const jwtMocks = vi.hoisted(() => ({
  create: vi.fn(async () => "signed-agent-token"),
}));

vi.mock("../../database/solana-agent-auth.js", () => {
  class SolanaAgentAuthRejectedError extends Error {}
  class SolanaAgentAuthRateLimitError extends Error {}
  class SolanaAgentAuthProvisioningError extends Error {
    code = "character_not_available";
  }
  return {
    issueSolanaAgentAuthChallenge: authStoreMocks.issue,
    SolanaAgentAuthProvisioningError,
    SolanaAgentAuthRateLimitError,
    SolanaAgentAuthRejectedError,
    verifyAndConsumeSolanaAgentAuthChallenge: authStoreMocks.verify,
  };
});

vi.mock("../../shared/utils.js", () => ({
  createJWT: jwtMocks.create,
  verifyJWT: vi.fn(),
}));

vi.mock("../../infrastructure/auth/privy-auth.js", () => ({
  isPrivyEnabled: () => false,
  verifyPrivyToken: vi.fn(),
}));

vi.mock("../../eliza/index.js", () => ({
  getAgentManager: () => null,
  getRunningAgents: () => new Map(),
}));

import { SolanaAgentAuthRejectedError } from "../../database/solana-agent-auth.js";
import { registerAgentRoutes } from "../routes/agent-routes.js";

function createReplyRecorder() {
  return {
    payload: undefined as unknown,
    statusCode: 200,
    send(payload: unknown) {
      this.payload = payload;
      return payload;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}

function setupRoutes() {
  const routes = new Map<string, Function>();
  const register = (
    method: string,
    path: string,
    optionsOrHandler: Function | { handler?: Function },
    maybeHandler?: Function,
  ) => {
    const handler =
      typeof optionsOrHandler === "function"
        ? optionsOrHandler
        : (maybeHandler ?? optionsOrHandler.handler);
    if (handler) routes.set(`${method} ${path}`, handler);
  };
  const fastify = {
    delete: (path: string, options: never, handler?: Function) => {
      register("DELETE", path, options, handler);
      return fastify;
    },
    get: (path: string, options: never, handler?: Function) => {
      register("GET", path, options, handler);
      return fastify;
    },
    patch: (path: string, options: never, handler?: Function) => {
      register("PATCH", path, options, handler);
      return fastify;
    },
    post: (path: string, options: never, handler?: Function) => {
      register("POST", path, options, handler);
      return fastify;
    },
    put: (path: string, options: never, handler?: Function) => {
      register("PUT", path, options, handler);
      return fastify;
    },
  };
  const pool = { connect: vi.fn() };
  const world = {
    getSystem: (name: string) =>
      name === "database" ? { getPool: () => pool } : undefined,
  };
  registerAgentRoutes(fastify as never, world as never);
  return {
    challenge: routes.get("POST /api/agents/sol-wallet-auth/challenge")!,
    pool,
    verify: routes.get("POST /api/agents/sol-wallet-auth/verify")!,
  };
}

function enableAuthEnvironment() {
  vi.stubEnv("HYPERIA_SOL_AGENT_AUTH_CLUSTER", "devnet");
  vi.stubEnv("HYPERIA_SOL_AGENT_AUTH_DOMAIN", "api.hyperia.test");
  vi.stubEnv("HYPERIA_SOL_AGENT_AUTH_ENABLED", "true");
  vi.stubEnv("HYPERIA_SOL_AGENT_AUTH_ORIGIN", "https://hyperia.test");
  vi.stubEnv("HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS", "120");
}

describe("SOL agent authentication routes", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    authStoreMocks.issue.mockReset();
    authStoreMocks.verify.mockReset();
    jwtMocks.create.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is absent until exact production configuration explicitly enables it", async () => {
    const { challenge } = setupRoutes();
    const reply = createReplyRecorder();
    await challenge(
      { body: {}, headers: { host: "api.hyperia.test" } } as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(404);
    expect(authStoreMocks.issue).not.toHaveBeenCalled();
  });

  it("rejects a request whose API host or browser origin does not match the signed authority", async () => {
    enableAuthEnvironment();
    const { challenge } = setupRoutes();
    const reply = createReplyRecorder();
    await challenge(
      {
        body: {},
        headers: {
          host: "api.hyperia.test",
          origin: "https://evil.test",
        },
      } as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(403);
    expect(authStoreMocks.issue).not.toHaveBeenCalled();
  });

  it("issues only a canonical SOL challenge through the bounded store", async () => {
    enableAuthEnvironment();
    const walletAddress = bs58.encode(ed25519.keygen().publicKey);
    authStoreMocks.issue.mockResolvedValue({
      challengeId: "00000000-0000-4000-8000-000000000001",
      expiresAt: "2026-08-27T12:02:00.000Z",
      message: "exact-message",
      signatureEncoding: "base58",
    });
    const { challenge, pool } = setupRoutes();
    const reply = createReplyRecorder();
    await challenge(
      {
        body: { agentName: "Agent One", walletAddress },
        headers: {
          host: "api.hyperia.test",
          origin: "https://hyperia.test",
        },
      } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toMatchObject({
      challengeId: "00000000-0000-4000-8000-000000000001",
      signatureEncoding: "base58",
      success: true,
    });
    expect(authStoreMocks.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "Agent One",
        characterId: null,
        pool,
        walletAddress,
      }),
    );
  });

  it("mints an agent token only after the atomic store consumes a valid proof", async () => {
    enableAuthEnvironment();
    const walletAddress = bs58.encode(ed25519.keygen().publicKey);
    authStoreMocks.verify.mockResolvedValue({
      accountId: `wallet:solana:${walletAddress}`,
      agentName: "Agent One",
      characterId: "character-1",
      credentialSession: {
        accountId: `wallet:solana:${walletAddress}`,
        authMethod: "sol-wallet-signature-v1",
        characterId: "character-1",
        expiresAt: "2026-09-03T12:00:00.000Z",
        revokedSessionIds: [],
        sessionId: "00000000-0000-4000-8000-000000000002",
      },
      walletAddress,
    });
    const { verify, pool } = setupRoutes();
    const reply = createReplyRecorder();
    await verify(
      {
        body: {
          challengeId: "00000000-0000-4000-8000-000000000001",
          message: "exact-message",
          signature: bs58.encode(new Uint8Array(64).fill(1)),
          walletAddress,
        },
        headers: { host: "api.hyperia.test" },
      } as never,
      reply as never,
    );

    expect(authStoreMocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        walletAddress,
      }),
    );
    expect(jwtMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        authMethod: "sol-wallet-signature-v1",
        agentCredentialVersion: 1,
        agentSessionId: "00000000-0000-4000-8000-000000000002",
        characterId: "character-1",
        jti: "00000000-0000-4000-8000-000000000002",
        userId: `wallet:solana:${walletAddress}`,
        walletType: "solana",
      }),
    );
    expect(reply.payload).toMatchObject({
      authToken: "signed-agent-token",
      characterId: "character-1",
      success: true,
    });
  });

  it("does not mint a token when proof consumption rejects the request", async () => {
    enableAuthEnvironment();
    const walletAddress = bs58.encode(ed25519.keygen().publicKey);
    authStoreMocks.verify.mockRejectedValue(new SolanaAgentAuthRejectedError());
    const { verify } = setupRoutes();
    const reply = createReplyRecorder();
    await verify(
      {
        body: {
          challengeId: "00000000-0000-4000-8000-000000000001",
          message: "exact-message",
          signature: bs58.encode(new Uint8Array(64).fill(1)),
          walletAddress,
        },
        headers: { host: "api.hyperia.test" },
      } as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(401);
    expect(jwtMocks.create).not.toHaveBeenCalled();
  });
});
