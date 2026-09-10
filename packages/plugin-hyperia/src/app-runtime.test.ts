import http from "node:http";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectHyperiaLaunchDiagnostics,
  ensureHyperiaRuntimeReady,
  prepareHyperiaAppLaunch,
  resolveHyperiaViewerAuthMessage,
  type HyperiaBridgeRuntimeLike,
} from "./app-runtime.js";

type WalletAuthFixtureServer = {
  close: () => Promise<void>;
  requests: Array<Record<string, unknown>>;
  url: string;
};

const base58Alphabet =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(data: Buffer | Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(data).toString("hex")}`);
  const characters: string[] = [];
  while (value > 0n) {
    characters.unshift(base58Alphabet[Number(value % 58n)]!);
    value /= 58n;
  }
  for (const byte of data) {
    if (byte !== 0) break;
    characters.unshift("1");
  }
  return characters.join("") || "1";
}

function base58Decode(value: string): Buffer {
  let decoded = 0n;
  for (const character of value) {
    const index = base58Alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid test base58 value");
    decoded = decoded * 58n + BigInt(index);
  }
  const hex = decoded.toString(16);
  const body = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex");
  const leadingZeros = value.match(/^1*/u)?.[0].length ?? 0;
  return Buffer.concat([Buffer.alloc(leadingZeros), body]);
}

function createTestSolanaWallet() {
  const seed = Buffer.alloc(32, 7);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = (
    crypto
      .createPublicKey(privateKey)
      .export({ format: "der", type: "spki" }) as Buffer
  ).subarray(12, 44);
  return {
    address: base58Encode(publicKey),
    privateKey: base58Encode(Buffer.concat([seed, publicKey])),
  };
}

const TEST_SOLANA_WALLET = createTestSolanaWallet();
const FIXTURE_CHALLENGE_ID = "00000000-0000-4000-8000-000000000001";
const FIXTURE_MESSAGE = "Hyperia test SOL wallet challenge";

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function startWalletAuthFixtureServer(options?: {
  credentialStatus?: number;
  errorMessage?: string;
  status?: number;
}): Promise<WalletAuthFixtureServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Content-Type", "application/json");

    if (
      req.method === "GET" &&
      url.pathname === "/api/agents/credentials/status"
    ) {
      requests.push({
        authorization: req.headers.authorization,
        path: url.pathname,
      });
      const status = options?.credentialStatus ?? 200;
      res.statusCode = status;
      res.end(
        status === 200
          ? JSON.stringify({ success: true, active: true })
          : JSON.stringify({ success: false, active: false }),
      );
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/agents/sol-wallet-auth/challenge"
    ) {
      requests.push({
        ...((await readJsonBody(req)) ?? {}),
        path: url.pathname,
      });
      const status = options?.status ?? 200;
      res.statusCode = status;
      if (status >= 400) {
        res.end(
          JSON.stringify({
            success: false,
            error: options?.errorMessage ?? "wallet auth unavailable",
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          success: true,
          challengeId: FIXTURE_CHALLENGE_ID,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          message: FIXTURE_MESSAGE,
          signatureEncoding: "base58",
        }),
      );
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/agents/sol-wallet-auth/verify"
    ) {
      requests.push({
        ...((await readJsonBody(req)) ?? {}),
        path: url.pathname,
      });
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          authToken: "runtime-auth-token",
          characterId: "runtime-character-id",
          accountId: "runtime-account-id",
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents/mappings") {
      requests.push({
        ...((await readJsonBody(req)) ?? {}),
        authorization: req.headers.authorization,
        path: url.pathname,
      });
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", onListening);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind wallet auth fixture server");
  }

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    requests,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function createRuntime(options?: {
  agentId?: string;
  authToken?: string | null;
  characterId?: string | null;
  hasService?: boolean;
  solanaPrivateKey?: string | null;
}) {
  const settings = new Map<string, string>();
  if (options?.authToken !== null) {
    settings.set(
      "HYPERIA_AUTH_TOKEN",
      options?.authToken ?? "existing-auth-token",
    );
  }
  if (options?.characterId !== null) {
    settings.set(
      "HYPERIA_CHARACTER_ID",
      options?.characterId ?? "existing-character-id",
    );
  }
  const setSetting = vi.fn((key: string, value: string) => {
    settings.set(key, value);
  });
  const getServiceLoadPromise = vi.fn(async () => ({}));

  return {
    agentId: options?.agentId ?? "runtime-agent-id",
    character: {
      name: "Chen",
      walletAddresses: {
        solana: TEST_SOLANA_WALLET.address,
      },
      settings: {
        secrets:
          options?.solanaPrivateKey === null
            ? {}
            : {
                SOLANA_PRIVATE_KEY:
                  options?.solanaPrivateKey ?? TEST_SOLANA_WALLET.privateKey,
              },
      },
      secrets: {},
    },
    getSetting: (key: string) => settings.get(key) ?? null,
    hasService: (serviceType: string) =>
      serviceType === "hyperiaService" && options?.hasService !== false,
    getServiceLoadPromise,
    setSetting,
  } satisfies HyperiaBridgeRuntimeLike & {
    getServiceLoadPromise: typeof getServiceLoadPromise;
    setSetting: typeof setSetting;
  };
}

afterEach(() => {
  delete process.env.HYPERIA_API_URL;
  delete process.env.HYPERIA_AUTH_TOKEN;
  delete process.env.HYPERIA_CHARACTER_ID;
  delete process.env.HYPERIA_ACCOUNT_ID;
  delete process.env.SOLANA_PRIVATE_KEY;
});

describe("plugin-hyperia app runtime helpers", () => {
  it("retains an existing credential only after the server confirms its active session", async () => {
    const fixtureServer = await startWalletAuthFixtureServer();
    process.env.HYPERIA_API_URL = fixtureServer.url;
    try {
      const runtime = createRuntime();
      await expect(prepareHyperiaAppLaunch(runtime)).resolves.toEqual([]);
      expect(fixtureServer.requests).toEqual([
        {
          authorization: "Bearer existing-auth-token",
          path: "/api/agents/credentials/status",
        },
      ]);
      expect(runtime.setSetting).not.toHaveBeenCalled();
    } finally {
      await fixtureServer.close();
    }
  });

  it("re-proves wallet possession and rotates a rejected stored credential", async () => {
    const fixtureServer = await startWalletAuthFixtureServer({
      credentialStatus: 401,
    });
    process.env.HYPERIA_API_URL = fixtureServer.url;
    try {
      const runtime = createRuntime();
      await expect(prepareHyperiaAppLaunch(runtime)).resolves.toEqual([]);
      expect(fixtureServer.requests.map((request) => request.path)).toEqual([
        "/api/agents/credentials/status",
        "/api/agents/sol-wallet-auth/challenge",
        "/api/agents/sol-wallet-auth/verify",
        "/api/agents/mappings",
      ]);
      expect(runtime.setSetting).toHaveBeenCalledWith(
        "HYPERIA_AUTH_TOKEN",
        "runtime-auth-token",
        true,
      );
    } finally {
      await fixtureServer.close();
    }
  });

  it("provisions and persists Hyperia credentials through wallet auth", async () => {
    const fixtureServer = await startWalletAuthFixtureServer();
    process.env.HYPERIA_API_URL = fixtureServer.url;

    try {
      const runtime = createRuntime({
        authToken: null,
        characterId: null,
      });

      await expect(prepareHyperiaAppLaunch(runtime)).resolves.toEqual([]);
      expect(fixtureServer.requests).toEqual([
        expect.objectContaining({
          walletAddress: TEST_SOLANA_WALLET.address,
          agentName: "Chen",
          path: "/api/agents/sol-wallet-auth/challenge",
        }),
        expect.objectContaining({
          challengeId: FIXTURE_CHALLENGE_ID,
          message: FIXTURE_MESSAGE,
          signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]+$/u),
          walletAddress: TEST_SOLANA_WALLET.address,
          path: "/api/agents/sol-wallet-auth/verify",
        }),
        expect.objectContaining({
          accountId: "runtime-account-id",
          agentId: "runtime-agent-id",
          characterId: "runtime-character-id",
          authorization: "Bearer runtime-auth-token",
          path: "/api/agents/mappings",
        }),
      ]);
      const verifyRequest = fixtureServer.requests[1]!;
      const verificationKey = crypto.createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          base58Decode(TEST_SOLANA_WALLET.address),
        ]),
        format: "der",
        type: "spki",
      });
      expect(
        crypto.verify(
          null,
          Buffer.from(FIXTURE_MESSAGE, "utf8"),
          verificationKey,
          base58Decode(String(verifyRequest.signature)),
        ),
      ).toBe(true);
      expect(runtime.setSetting).toHaveBeenCalledWith(
        "HYPERIA_AUTH_TOKEN",
        "runtime-auth-token",
        true,
      );
      expect(runtime.setSetting).toHaveBeenCalledWith(
        "HYPERIA_CHARACTER_ID",
        "runtime-character-id",
        false,
      );
      expect(runtime.setSetting).toHaveBeenCalledWith(
        "HYPERIA_ACCOUNT_ID",
        "runtime-account-id",
        false,
      );
      expect(process.env.HYPERIA_AUTH_TOKEN).toBe("runtime-auth-token");
      expect(process.env.HYPERIA_CHARACTER_ID).toBe("runtime-character-id");
      expect(process.env.HYPERIA_ACCOUNT_ID).toBe("runtime-account-id");
    } finally {
      await fixtureServer.close();
    }
  });

  it("returns a warning diagnostic when wallet auth provisioning fails", async () => {
    const fixtureServer = await startWalletAuthFixtureServer({
      status: 503,
      errorMessage: "temporarily unavailable",
    });
    process.env.HYPERIA_API_URL = fixtureServer.url;

    try {
      const runtime = createRuntime({
        authToken: null,
        characterId: null,
      });
      const diagnostics = await prepareHyperiaAppLaunch(runtime);

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "hyperia-auth-provisioning-failed",
          severity: "warning",
          message: expect.stringContaining("temporarily unavailable"),
        }),
      ]);
      expect(runtime.setSetting).not.toHaveBeenCalled();
    } finally {
      await fixtureServer.close();
    }
  });

  it("fails before the network when the agent has an address but no matching signing key", async () => {
    const fixtureServer = await startWalletAuthFixtureServer();
    process.env.HYPERIA_API_URL = fixtureServer.url;
    try {
      const runtime = createRuntime({
        authToken: null,
        characterId: null,
        solanaPrivateKey: null,
      });
      await expect(prepareHyperiaAppLaunch(runtime)).resolves.toEqual([
        expect.objectContaining({
          code: "hyperia-auth-provisioning-failed",
          message: expect.stringContaining("signing key"),
        }),
      ]);
      expect(fixtureServer.requests).toEqual([]);
    } finally {
      await fixtureServer.close();
    }
  });

  it("builds viewer auth payloads only when runtime auth is available", () => {
    expect(
      resolveHyperiaViewerAuthMessage(
        createRuntime({ authToken: null, characterId: null }),
      ),
    ).toBeNull();

    expect(resolveHyperiaViewerAuthMessage(createRuntime())).toEqual({
      type: "HYPERIA_AUTH",
      authToken: "existing-auth-token",
      agentId: "runtime-agent-id",
      characterId: "existing-character-id",
      followEntity: "existing-character-id",
    });
  });

  it("waits for the Hyperia runtime service and errors when it is absent", async () => {
    const readyRuntime = createRuntime();
    await expect(
      ensureHyperiaRuntimeReady(readyRuntime),
    ).resolves.toBeUndefined();
    expect(readyRuntime.getServiceLoadPromise).toHaveBeenCalledWith(
      "hyperiaService",
    );

    const missingRuntime = createRuntime({ hasService: false });
    await expect(ensureHyperiaRuntimeReady(missingRuntime)).rejects.toThrow(
      "Hyperia service was not registered on the agent runtime.",
    );
  });

  it("reports launch diagnostics for missing auth, inactive runtime bridge, and absent live sessions", () => {
    const runtime = createRuntime({
      authToken: null,
      characterId: "runtime-character-id",
      hasService: false,
    });

    expect(
      collectHyperiaLaunchDiagnostics({
        requestedViewerAuth: true,
        runtime,
        sessionFound: false,
        viewerAuthMessage: null,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "hyperia-auth-unavailable" }),
        expect.objectContaining({ code: "hyperia-runtime-bridge-inactive" }),
        expect.objectContaining({ code: "hyperia-session-not-found" }),
      ]),
    );
  });

  it("does not emit auth diagnostics when viewer auth is not requested or the session is already attached", () => {
    const runtime = createRuntime();

    expect(
      collectHyperiaLaunchDiagnostics({
        requestedViewerAuth: false,
        runtime,
        sessionFound: true,
        viewerAuthMessage: {
          type: "HYPERIA_AUTH",
          authToken: "existing-auth-token",
          characterId: "existing-character-id",
        },
      }),
    ).toEqual([]);
  });
});
