import http from "node:http";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectLaunchDiagnostics,
  ensureRuntimeReady,
  handleAppRoutes,
  hyperiaAppBridge,
  prepareLaunch,
  refreshRunSession,
  resolveLaunchSession,
  resolveViewerAuthMessage,
  type HyperiaAppRouteContext,
} from "./app.js";

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

function createTestSolanaWallet() {
  const seed = Buffer.alloc(32, 11);
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
const FIXTURE_MESSAGE = "Hyperia bridge SOL wallet challenge";

type HyperiaFixtureServer = {
  close: () => Promise<void>;
  headers: {
    goalStop: string[];
    message: string[];
    thoughts: string[];
  };
  requests: {
    goalStop: Array<Record<string, unknown>>;
    message: Array<Record<string, unknown>>;
    walletAuth: Array<Record<string, unknown>>;
  };
  url: string;
};

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

async function startFixtureServer(options?: {
  agentStateDelayMs?: number;
  embeddedAgents?: Array<{
    agentId?: string;
    characterId?: string;
    name?: string;
    state?: string;
    entityId?: string | null;
    lastActivity?: number;
    startedAt?: number;
  }>;
  malformedThoughtsRoute?: boolean;
  mappedQuickActionsMessage?: string;
  omitThoughtsRoute?: boolean;
}): Promise<HyperiaFixtureServer> {
  const headers = {
    goalStop: [] as string[],
    message: [] as string[],
    thoughts: [] as string[],
  };
  const requests = {
    goalStop: [] as Array<Record<string, unknown>>,
    message: [] as Array<Record<string, unknown>>,
    walletAuth: [] as Array<Record<string, unknown>>,
  };
  const sleep = async () => {
    if ((options?.agentStateDelayMs ?? 0) > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, options?.agentStateDelayMs),
      );
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readJsonBody(req);
    const genericAgentRouteMatch = url.pathname.match(
      /^\/api\/agents\/([^/]+)\/(goal|quick-actions|thoughts)$/,
    );
    const genericEmbeddedAgent =
      genericAgentRouteMatch?.[1] && options?.embeddedAgents
        ? options.embeddedAgents.find(
            (agent) => agent.agentId === genericAgentRouteMatch[1],
          )
        : null;
    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && url.pathname === "/api/embedded-agents") {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          agents: options?.embeddedAgents ?? [],
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/agents/mapping/agent-1"
    ) {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          agentId: "agent-1",
          characterId: "character-1",
          accountId: "account-1",
          agentName: "Chen",
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/agents/mapping/agent-connecting"
    ) {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          agentId: "agent-connecting",
          characterId: "character-connecting",
          accountId: "account-connecting",
          agentName: "Dormant Scout",
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agents/agent-1/goal") {
      await sleep();
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          goal: {
            description: "Scout the moon gate",
            type: "scout",
          },
          availableGoals: [{ description: "Hold position", type: "idle" }],
          goalsPaused: false,
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/agents/agent-connecting/goal"
    ) {
      await sleep();
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          goal: null,
          availableGoals: [
            {
              description: "Reconnect to Hyperia",
              type: "reconnect",
            },
          ],
          goalsPaused: false,
          message: "Agent session is reconnecting.",
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/agents/agent-1/quick-actions"
    ) {
      await sleep();
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          quickCommands: [
            { label: "Check the gate", command: "Check the moon gate" },
          ],
          nearbyLocations: [{ name: "Moon Gate" }],
          availableGoals: [
            { description: "Scout the moon gate", type: "scout" },
          ],
          playerPosition: [12, 0, 8],
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/agents/agent-connecting/quick-actions"
    ) {
      await sleep();
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          quickCommands: [
            {
              label: "Reconnect",
              command: "Retry connecting to Hyperia",
            },
          ],
          nearbyLocations: [],
          availableGoals: [
            {
              description: "Reconnect to Hyperia",
              type: "reconnect",
            },
          ],
          message:
            options?.mappedQuickActionsMessage ??
            "Agent not connected to Hyperia yet.",
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/agents/agent-1/thoughts" &&
      !options?.omitThoughtsRoute
    ) {
      headers.thoughts.push(req.headers.authorization ?? "");
      await sleep();
      if (options?.malformedThoughtsRoute) {
        res.statusCode = 200;
        res.end("{not-json");
        return;
      }
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          thoughts: [
            {
              id: "thought-1",
              type: "reasoning",
              content: "The moon gate is the safest scouting route.",
              timestamp: 1_710_000_100_000,
            },
          ],
          count: 1,
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/agents/agent-connecting/thoughts"
    ) {
      headers.thoughts.push(req.headers.authorization ?? "");
      await sleep();
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          thoughts: [],
          count: 0,
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      genericEmbeddedAgent &&
      genericAgentRouteMatch?.[2] === "goal"
    ) {
      await sleep();
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          goal: {
            description: `Follow ${genericEmbeddedAgent.name ?? genericEmbeddedAgent.agentId}`,
            type: "observe",
          },
          availableGoals: [
            {
              description: `Follow ${genericEmbeddedAgent.name ?? genericEmbeddedAgent.agentId}`,
              type: "observe",
            },
          ],
          goalsPaused: false,
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      genericEmbeddedAgent &&
      genericAgentRouteMatch?.[2] === "quick-actions"
    ) {
      await sleep();
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          quickCommands: [
            {
              label: "Observe",
              command: `Check ${genericEmbeddedAgent.name ?? genericEmbeddedAgent.agentId}`,
            },
          ],
          nearbyLocations: [
            {
              name:
                genericEmbeddedAgent.name ??
                genericEmbeddedAgent.agentId ??
                "Unknown",
            },
          ],
          availableGoals: [
            {
              description: `Follow ${genericEmbeddedAgent.name ?? genericEmbeddedAgent.agentId}`,
              type: "observe",
            },
          ],
          playerPosition: [1, 0, 1],
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      genericEmbeddedAgent &&
      genericAgentRouteMatch?.[2] === "thoughts"
    ) {
      headers.thoughts.push(req.headers.authorization ?? "");
      await sleep();
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          thoughts: [
            {
              id: `thought-${genericEmbeddedAgent.agentId ?? "embedded"}`,
              type: "note",
              content: `Tracking ${
                genericEmbeddedAgent.name ?? genericEmbeddedAgent.agentId
              }`,
              timestamp: 1_710_000_200_000,
            },
          ],
          count: 1,
        }),
      );
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/agents/sol-wallet-auth/challenge"
    ) {
      requests.walletAuth.push({ ...(body ?? {}), path: url.pathname });
      res.statusCode = 200;
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
      requests.walletAuth.push({ ...(body ?? {}), path: url.pathname });
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          authToken: "fixture-auth-token",
          characterId: "character-1",
          accountId: "account-1",
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents/mappings") {
      requests.walletAuth.push({
        ...(body ?? {}),
        authorization: req.headers.authorization,
        path: url.pathname,
      });
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/agents/agent-1/message"
    ) {
      headers.message.push(req.headers.authorization ?? "");
      requests.message.push(body ?? {});
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, message: "Message delivered." }));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/agents/agent-1/goal/stop"
    ) {
      headers.goalStop.push(req.headers.authorization ?? "");
      requests.goalStop.push(body ?? {});
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, message: "Goal stopped." }));
      return;
    }

    res.statusCode = 404;
    res.end(
      JSON.stringify({
        success: false,
        error: `Unhandled ${req.method} ${url.pathname}`,
      }),
    );
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
    throw new Error("Failed to bind Hyperia fixture server");
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
    headers,
    requests,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function createRuntime(
  serverUrl: string,
  options?: {
    agentId?: string | null;
    authToken?: string | null;
    characterId?: string | null;
    hasService?: boolean;
  },
) {
  const settings = new Map<string, string>([["HYPERIA_API_URL", serverUrl]]);
  if (options?.authToken !== null) {
    settings.set("HYPERIA_AUTH_TOKEN", options?.authToken ?? "runtime-token");
  }
  if (options?.characterId !== null) {
    settings.set("HYPERIA_CHARACTER_ID", options?.characterId ?? "character-1");
  }
  const getServiceLoadPromise = vi.fn(async () => ({}));

  return {
    agentId:
      options?.agentId === null ? undefined : (options?.agentId ?? "agent-1"),
    character: {
      name: "Chen",
      walletAddresses: {
        solana: TEST_SOLANA_WALLET.address,
      },
      settings: {
        secrets: {
          SOLANA_PRIVATE_KEY: TEST_SOLANA_WALLET.privateKey,
        },
      },
    },
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      settings.set(key, value);
    },
    hasService: (serviceType: string) =>
      serviceType === "hyperiaService" && options?.hasService !== false,
    getServiceLoadPromise,
  };
}

function createRouteContext(
  url: string,
  method: string,
  runtime: ReturnType<typeof createRuntime>,
  body?: Record<string, unknown>,
) {
  const chunks: Buffer[] = [];
  const headers = new Map<string, string | string[]>();
  const request = {} as http.IncomingMessage;
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(
        name.toLowerCase(),
        Array.isArray(value) ? [...value] : String(value),
      );
      return response as unknown as http.ServerResponse;
    },
    end(chunk?: unknown) {
      if (chunk === undefined || chunk === null) {
        return response as unknown as http.ServerResponse;
      }
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === "string"
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk)),
      );
      return response as unknown as http.ServerResponse;
    },
  } as unknown as http.ServerResponse;

  const parsedUrl = new URL(url);

  const ctx: HyperiaAppRouteContext = {
    req: request,
    res: response,
    method,
    pathname: parsedUrl.pathname,
    url: parsedUrl,
    runtime,
    readJsonBody: async () => (body ?? null) as Record<string, unknown> | null,
    json: (res, data, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    },
    error: (res, message, status = 500) => {
      res.statusCode = status;
      res.end(JSON.stringify({ error: message }));
    },
  };

  return {
    ctx,
    getBody: () => Buffer.concat(chunks).toString("utf8"),
    getHeaders: () => headers,
    getStatus: () => response.statusCode,
  };
}

afterEach(() => {
  delete process.env.HYPERIA_API_URL;
  delete process.env.HYPERIA_AUTH_TOKEN;
  delete process.env.HYPERIA_CLIENT_URL;
  delete process.env.PUBLIC_APP_URL;
  delete process.env.CLIENT_URL;
});

describe("plugin-hyperia app bridge", () => {
  it("safely declines malformed host route contexts", async () => {
    await expect(hyperiaAppBridge.handleAppRoutes(null)).resolves.toBe(false);
    await expect(hyperiaAppBridge.handleAppRoutes({})).resolves.toBe(false);
    await expect(
      hyperiaAppBridge.handleAppRoutes({
        method: "GET",
        pathname: "/api/apps/hyperia/embedded-agents",
      }),
    ).resolves.toBe(false);
  });

  it("resolves a mapped session using runtime-scoped API configuration", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url);
      const session = await resolveLaunchSession({
        runtime,
        viewer: {
          authMessage: {
            agentId: "agent-1",
            characterId: "character-1",
            followEntity: "character-1",
          },
        },
      });

      expect(session).toEqual(
        expect.objectContaining({
          sessionId: "agent-1",
          appName: "@hyperforge/plugin-hyperia",
          status: "running",
          canSendCommands: true,
          followEntity: "character-1",
          suggestedPrompts: ["Check the moon gate"],
          telemetry: expect.objectContaining({
            recentThoughts: [
              expect.objectContaining({
                content: "The moon gate is the safest scouting route.",
                type: "reasoning",
              }),
            ],
            recommendedGoals: [
              expect.objectContaining({
                description: "Hold position",
                type: "idle",
              }),
            ],
          }),
        }),
      );
      expect(fixtureServer.headers.thoughts).toEqual(["Bearer runtime-token"]);
    } finally {
      await fixtureServer.close();
    }
  });

  it("treats a missing thoughts endpoint as optional session telemetry", async () => {
    const fixtureServer = await startFixtureServer({ omitThoughtsRoute: true });
    try {
      const runtime = createRuntime(fixtureServer.url);
      const session = await resolveLaunchSession({
        runtime,
        viewer: {
          authMessage: {
            agentId: "agent-1",
            characterId: "character-1",
            followEntity: "character-1",
          },
        },
      });

      expect(session).toEqual(
        expect.objectContaining({
          sessionId: "agent-1",
          activity: [],
          telemetry: expect.objectContaining({
            recentThoughts: [],
          }),
        }),
      );
    } finally {
      await fixtureServer.close();
    }
  });

  it("uses the runtime auth token for proxied message and control routes", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url);

      const message = createRouteContext(
        "http://localhost/api/apps/hyperia/session/agent-1/message",
        "POST",
        runtime,
        { content: "Check the gate" },
      );
      expect(await handleAppRoutes(message.ctx)).toBe(true);
      expect(message.getStatus()).toBe(200);
      expect(JSON.parse(message.getBody())).toEqual(
        expect.objectContaining({
          success: true,
          session: expect.objectContaining({
            sessionId: "agent-1",
          }),
        }),
      );

      const control = createRouteContext(
        "http://localhost/api/apps/hyperia/session/agent-1/control",
        "POST",
        runtime,
        { action: "pause" },
      );
      expect(await handleAppRoutes(control.ctx)).toBe(true);
      expect(control.getStatus()).toBe(200);
      expect(JSON.parse(control.getBody())).toEqual(
        expect.objectContaining({
          success: true,
          message: expect.stringContaining("Goal stopped"),
        }),
      );

      expect(fixtureServer.headers.message).toEqual(["Bearer runtime-token"]);
      expect(fixtureServer.headers.goalStop).toEqual(["Bearer runtime-token"]);
      expect(fixtureServer.requests.message).toEqual([
        { content: "Check the gate" },
      ]);
    } finally {
      await fixtureServer.close();
    }
  });

  it("returns 400 for missing or blank session message content", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url);

      const missingBody = createRouteContext(
        "http://localhost/api/apps/hyperia/session/agent-1/message",
        "POST",
        runtime,
      );
      expect(await handleAppRoutes(missingBody.ctx)).toBe(true);
      expect(missingBody.getStatus()).toBe(400);
      expect(JSON.parse(missingBody.getBody())).toEqual({
        error: "request body is required",
      });

      const blankMessage = createRouteContext(
        "http://localhost/api/apps/hyperia/session/agent-1/message",
        "POST",
        runtime,
        { content: "   " },
      );
      expect(await handleAppRoutes(blankMessage.ctx)).toBe(true);
      expect(blankMessage.getStatus()).toBe(400);
      expect(JSON.parse(blankMessage.getBody())).toEqual({
        error: "content is required",
      });

      expect(fixtureServer.requests.message).toEqual([]);
    } finally {
      await fixtureServer.close();
    }
  });

  it("returns 400 for invalid control actions and missing control bodies", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url);

      const missingBody = createRouteContext(
        "http://localhost/api/apps/hyperia/session/agent-1/control",
        "POST",
        runtime,
      );
      expect(await handleAppRoutes(missingBody.ctx)).toBe(true);
      expect(missingBody.getStatus()).toBe(400);
      expect(JSON.parse(missingBody.getBody())).toEqual({
        error: "request body is required",
      });

      const invalidAction = createRouteContext(
        "http://localhost/api/apps/hyperia/session/agent-1/control",
        "POST",
        runtime,
        { action: "rewind" },
      );
      expect(await handleAppRoutes(invalidAction.ctx)).toBe(true);
      expect(invalidAction.getStatus()).toBe(400);
      expect(JSON.parse(invalidAction.getBody())).toEqual({
        error: "action must be pause or resume",
      });

      expect(fixtureServer.requests.goalStop).toEqual([]);
    } finally {
      await fixtureServer.close();
    }
  });

  it("returns 400 when embedded command routes omit their request body", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url);
      const embeddedCommand = createRouteContext(
        "http://localhost/api/apps/hyperia/embedded-agents/character-1/command",
        "POST",
        runtime,
      );

      expect(await handleAppRoutes(embeddedCommand.ctx)).toBe(true);
      expect(embeddedCommand.getStatus()).toBe(400);
      expect(JSON.parse(embeddedCommand.getBody())).toEqual({
        error: "request body is required",
      });
    } finally {
      await fixtureServer.close();
    }
  });

  it("proxies the thoughts route with runtime authorization", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url);
      const thoughts = createRouteContext(
        "http://localhost/api/apps/hyperia/agents/agent-1/thoughts?limit=1",
        "GET",
        runtime,
      );

      expect(await handleAppRoutes(thoughts.ctx)).toBe(true);
      expect(thoughts.getStatus()).toBe(200);
      expect(JSON.parse(thoughts.getBody())).toEqual(
        expect.objectContaining({
          success: true,
          thoughts: [
            expect.objectContaining({
              content: "The moon gate is the safest scouting route.",
            }),
          ],
        }),
      );
      expect(fixtureServer.headers.thoughts).toEqual(["Bearer runtime-token"]);
    } finally {
      await fixtureServer.close();
    }
  });

  it("returns 502 when an upstream proxy route returns malformed JSON", async () => {
    const fixtureServer = await startFixtureServer({
      malformedThoughtsRoute: true,
    });
    try {
      const runtime = createRuntime(fixtureServer.url);
      const thoughts = createRouteContext(
        "http://localhost/api/apps/hyperia/agents/agent-1/thoughts?limit=1",
        "GET",
        runtime,
      );

      expect(await handleAppRoutes(thoughts.ctx)).toBe(true);
      expect(thoughts.getStatus()).toBe(502);
      expect(JSON.parse(thoughts.getBody())).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("Hyperia route failed"),
        }),
      );
    } finally {
      await fixtureServer.close();
    }
  });

  it("prepares launch by provisioning runtime auth through wallet auth", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url, {
        authToken: null,
        characterId: null,
      });

      await expect(prepareLaunch({ runtime })).resolves.toEqual(
        expect.objectContaining({
          launchUrl: "http://localhost:3333",
          viewer: expect.objectContaining({
            url: "http://localhost:3333",
            embedParams: expect.objectContaining({
              embedded: "true",
              mode: "spectator",
              surface: "agent-control",
            }),
            postMessageAuth: true,
          }),
        }),
      );
      expect(fixtureServer.requests.walletAuth).toEqual([
        expect.objectContaining({
          walletAddress: TEST_SOLANA_WALLET.address,
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
          accountId: "account-1",
          agentId: "agent-1",
          authorization: "Bearer fixture-auth-token",
          characterId: "character-1",
          path: "/api/agents/mappings",
        }),
      ]);
      await expect(resolveViewerAuthMessage({ runtime })).resolves.toEqual(
        expect.objectContaining({
          type: "HYPERIA_AUTH",
          authToken: "fixture-auth-token",
          agentId: "agent-1",
          characterId: "character-1",
          followEntity: "character-1",
        }),
      );
    } finally {
      await fixtureServer.close();
    }
  });

  it("selects the embedded launch session by runtime character name when identifiers are absent", async () => {
    const fixtureServer = await startFixtureServer({
      embeddedAgents: [
        {
          agentId: "agent-2",
          characterId: "character-2",
          entityId: "entity-2",
          name: "Other",
          state: "running",
        },
        {
          agentId: "agent-1",
          characterId: "character-1",
          entityId: "entity-1",
          name: "Chen",
          state: "running",
        },
      ],
    });
    try {
      const runtime = createRuntime(fixtureServer.url);
      const session = await resolveLaunchSession({ runtime, viewer: null });

      expect(session).toEqual(
        expect.objectContaining({
          sessionId: "agent-1",
          characterId: "character-1",
          followEntity: "entity-1",
        }),
      );
    } finally {
      await fixtureServer.close();
    }
  });

  it("falls back to the only embedded agent when launch identifiers are unavailable", async () => {
    const fixtureServer = await startFixtureServer({
      embeddedAgents: [
        {
          agentId: "solo-agent",
          characterId: "solo-character",
          entityId: "solo-entity",
          name: "Solo Scout",
          state: "running",
        },
      ],
    });
    try {
      const runtime = createRuntime(fixtureServer.url, {
        agentId: null,
        characterId: "missing-character",
      });
      const session = await resolveLaunchSession({
        runtime,
        viewer: {
          authMessage: {
            agentId: "missing-agent",
          },
        },
      });

      expect(session).toEqual(
        expect.objectContaining({
          sessionId: "solo-agent",
          characterId: "solo-character",
          followEntity: "solo-entity",
        }),
      );
    } finally {
      await fixtureServer.close();
    }
  });

  it("returns mapped sessions as connecting until the agent reports a live player position", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url);
      const session = await resolveLaunchSession({
        runtime,
        viewer: {
          authMessage: {
            agentId: "agent-connecting",
          },
        },
      });

      expect(session).toEqual(
        expect.objectContaining({
          sessionId: "agent-connecting",
          status: "connecting",
          canSendCommands: false,
          controls: [],
          summary: "Agent not connected to Hyperia yet.",
        }),
      );
      expect(session?.telemetry).toEqual(
        expect.objectContaining({
          playerPosition: null,
          nearbyLocationCount: 0,
        }),
      );
    } finally {
      await fixtureServer.close();
    }
  });

  it("loads goal, quick-action, and thought state concurrently during session refresh", async () => {
    const fixtureServer = await startFixtureServer({ agentStateDelayMs: 120 });
    try {
      const runtime = createRuntime(fixtureServer.url);
      const startedAt = Date.now();
      const session = await resolveLaunchSession({
        runtime,
        viewer: {
          authMessage: {
            agentId: "agent-1",
            characterId: "character-1",
          },
        },
      });
      const elapsedMs = Date.now() - startedAt;

      expect(session).toEqual(
        expect.objectContaining({
          sessionId: "agent-1",
          goalLabel: "Scout the moon gate",
        }),
      );
      expect(elapsedMs).toBeLessThan(260);
    } finally {
      await fixtureServer.close();
    }
  });

  it("refreshes launch sessions when a run snapshot does not have a session id yet", async () => {
    const fixtureServer = await startFixtureServer({
      embeddedAgents: [
        {
          agentId: "agent-1",
          characterId: "character-1",
          entityId: "entity-1",
          name: "Chen",
          state: "running",
        },
      ],
    });
    try {
      const runtime = createRuntime(fixtureServer.url);
      const session = await refreshRunSession({
        runtime,
        viewer: null,
        session: {},
      });

      expect(session).toEqual(
        expect.objectContaining({
          sessionId: "agent-1",
          characterId: "character-1",
        }),
      );
    } finally {
      await fixtureServer.close();
    }
  });

  it("waits for the runtime service through the bridge hook", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url, { hasService: true });

      await expect(ensureRuntimeReady({ runtime })).resolves.toBeUndefined();
      expect(runtime.getServiceLoadPromise).toHaveBeenCalledWith(
        "hyperiaService",
      );
    } finally {
      await fixtureServer.close();
    }
  });

  it("reports launch diagnostics when auth or runtime readiness is missing", async () => {
    const fixtureServer = await startFixtureServer();
    try {
      const runtime = createRuntime(fixtureServer.url, {
        authToken: null,
        hasService: false,
      });

      const diagnostics = await collectLaunchDiagnostics({
        runtime,
        viewer: {
          postMessageAuth: true,
          authMessage: null,
        },
        session: null,
      });

      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "hyperia-auth-unavailable" }),
          expect.objectContaining({
            code: "hyperia-runtime-bridge-inactive",
          }),
          expect.objectContaining({ code: "hyperia-session-not-found" }),
        ]),
      );
    } finally {
      await fixtureServer.close();
    }
  });
});
