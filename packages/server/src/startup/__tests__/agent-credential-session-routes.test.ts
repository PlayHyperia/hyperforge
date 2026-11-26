import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  revoke: vi.fn(),
  rotate: vi.fn(),
  verify: vi.fn(),
}));
const jwtMocks = vi.hoisted(() => ({
  create: vi.fn(async () => "rotated-agent-token"),
  verify: vi.fn(async (): Promise<Record<string, unknown> | null> => ({
    userId: "account-1",
  })),
}));

vi.mock("../../database/agent-credential-sessions.js", () => {
  class AgentCredentialSessionRejectedError extends Error {}
  return {
    AgentCredentialSessionRejectedError,
    revokeAgentCredentialSessions: sessionMocks.revoke,
    rotateAgentCredentialSession: sessionMocks.rotate,
    verifyAgentCredentialSession: sessionMocks.verify,
  };
});

vi.mock("../../shared/utils.js", () => ({
  createJWT: jwtMocks.create,
  verifyJWT: jwtMocks.verify,
}));

vi.mock("../../infrastructure/auth/privy-auth.js", () => ({
  isPrivyEnabled: () => false,
  verifyPrivyToken: vi.fn(),
}));

vi.mock("../../eliza/index.js", () => ({
  getAgentManager: () => null,
  getRunningAgents: () => new Map(),
}));

import { AgentCredentialSessionRejectedError } from "../../database/agent-credential-sessions.js";
import { registerAgentRoutes } from "../routes/agent-routes.js";

function replyRecorder() {
  return {
    headers: {} as Record<string, string>,
    payload: undefined as unknown,
    statusCode: 200,
    send(payload: unknown) {
      this.payload = payload;
      return payload;
    },
    header(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(statusCode: number) {
      this.statusCode = statusCode;
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
  const pool = {
    connect: vi.fn(),
    query: vi.fn(async () => ({ rows: [{ roles: "player" }] })),
  };
  const socket = {
    agentCredentialSessionId: "00000000-0000-4000-8000-000000000001",
    disconnect: vi.fn(),
    send: vi.fn(),
  };
  const database = {
    getCharactersAsync: vi.fn(async () => [
      { id: "character-1", name: "Agent One" },
    ]),
    getPool: () => pool,
  };
  const network = { sockets: new Map([["socket-1", socket]]) };
  const world = {
    getSystem: (name: string) =>
      name === "database" ? database : name === "network" ? network : undefined,
  };
  registerAgentRoutes(fastify as never, world as never);
  return { database, pool, routes, socket };
}

describe("agent credential session routes", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sessionMocks.revoke.mockReset();
    sessionMocks.rotate.mockReset();
    sessionMocks.verify.mockReset();
    sessionMocks.verify.mockResolvedValue({
      accountId: "account-1",
      authMethod: "owner-credential-v1",
      characterId: "character-1",
      expiresAt: "2026-09-03T12:00:00.000Z",
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    jwtMocks.create.mockClear();
    jwtMocks.verify.mockClear();
    jwtMocks.verify.mockResolvedValue({
      agentCredentialVersion: 1,
      agentSessionExpiresAt: "2026-09-03T12:00:00.000Z",
      agentSessionId: "00000000-0000-4000-8000-000000000001",
      authMethod: "owner-credential-v1",
      characterId: "character-1",
      isAgent: true,
      jti: "00000000-0000-4000-8000-000000000001",
      userId: "account-1",
    });
  });

  it("rotates owner credentials, binds the new JWT, and evicts the old live session", async () => {
    sessionMocks.rotate.mockResolvedValue({
      accountId: "account-1",
      authMethod: "owner-credential-v1",
      characterId: "character-1",
      expiresAt: "2026-09-03T12:00:00.000Z",
      revokedSessionIds: ["00000000-0000-4000-8000-000000000001"],
      sessionId: "00000000-0000-4000-8000-000000000002",
    });
    const { pool, routes, socket } = setupRoutes();
    const reply = replyRecorder();
    await routes.get("POST /api/agents/credentials")!(
      {
        body: { accountId: "account-1", characterId: "character-1" },
        headers: { authorization: "Bearer owner-token" },
      },
      reply,
    );

    expect(sessionMocks.rotate).toHaveBeenCalledWith({
      accountId: "account-1",
      authMethod: "owner-credential-v1",
      characterId: "character-1",
      pool,
    });
    expect(jwtMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentCredentialVersion: 1,
        agentSessionId: "00000000-0000-4000-8000-000000000002",
        isAgent: true,
        jti: "00000000-0000-4000-8000-000000000002",
      }),
    );
    expect(socket.send).toHaveBeenCalledWith(
      "kick",
      "agent_credentials_rotated",
    );
    expect(socket.disconnect).toHaveBeenCalledWith("agent_credentials_rotated");
    expect(reply.payload).toMatchObject({
      authToken: "rotated-agent-token",
      success: true,
    });
  });

  it("exposes a no-store status probe only after bearer verification", async () => {
    const { routes } = setupRoutes();
    const reply = replyRecorder();
    await routes.get("GET /api/agents/credentials/status")!(
      { headers: { authorization: "Bearer agent-token" } },
      reply,
    );
    expect(reply.headers).toEqual({ "Cache-Control": "no-store" });
    expect(reply.payload).toEqual({ active: true, success: true });
    expect(sessionMocks.verify).toHaveBeenCalled();

    jwtMocks.verify.mockResolvedValueOnce(null);
    const rejected = replyRecorder();
    await routes.get("GET /api/agents/credentials/status")!(
      { headers: { authorization: "Bearer invalid-token" } },
      rejected,
    );
    expect(rejected.statusCode).toBe(401);
    expect(rejected.payload).toMatchObject({ active: false, success: false });
  });

  it("does not treat an ordinary human JWT as an active agent credential", async () => {
    jwtMocks.verify.mockResolvedValueOnce({ userId: "account-1" });
    const { routes } = setupRoutes();
    const reply = replyRecorder();

    await routes.get("GET /api/agents/credentials/status")!(
      { headers: { authorization: "Bearer human-token" } },
      reply,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toMatchObject({ active: false, success: false });
    expect(sessionMocks.verify).not.toHaveBeenCalled();
  });

  it("fails closed when the persisted agent session is revoked or unavailable", async () => {
    const { routes } = setupRoutes();
    sessionMocks.verify.mockResolvedValueOnce(null);
    const revoked = replyRecorder();
    await routes.get("GET /api/agents/credentials/status")!(
      { headers: { authorization: "Bearer revoked-agent-token" } },
      revoked,
    );
    expect(revoked.statusCode).toBe(401);

    sessionMocks.verify.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const unavailable = replyRecorder();
    await routes.get("GET /api/agents/credentials/status")!(
      { headers: { authorization: "Bearer agent-token" } },
      unavailable,
    );
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.payload).toMatchObject({
      active: false,
      success: false,
    });
  });

  it("revokes the exact owner's active sessions and evicts their live sockets", async () => {
    sessionMocks.revoke.mockResolvedValue([
      "00000000-0000-4000-8000-000000000001",
    ]);
    const { pool, routes, socket } = setupRoutes();
    const reply = replyRecorder();
    await routes.get("DELETE /api/agents/credentials/:characterId")!(
      {
        headers: { authorization: "Bearer owner-token" },
        params: { characterId: "character-1" },
      },
      reply,
    );
    expect(sessionMocks.revoke).toHaveBeenCalledWith({
      accountId: "account-1",
      characterId: "character-1",
      pool,
    });
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(reply.payload).toEqual({
      disconnectedSocketCount: 1,
      revokedSessionCount: 1,
      success: true,
    });
  });

  it("does not reveal whether another owner's character exists", async () => {
    sessionMocks.revoke.mockRejectedValue(
      new AgentCredentialSessionRejectedError(),
    );
    const { routes } = setupRoutes();
    const reply = replyRecorder();
    await routes.get("DELETE /api/agents/credentials/:characterId")!(
      {
        headers: { authorization: "Bearer owner-token" },
        params: { characterId: "other-character" },
      },
      reply,
    );
    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toMatchObject({
      error: "Character not found or access denied",
      success: false,
    });
  });
});
