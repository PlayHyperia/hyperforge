#!/usr/bin/env bun

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import pg from "pg";
import WebSocket, {
  WebSocketServer,
  type RawData,
  type WebSocket as ServerWebSocket,
} from "ws";

import { isRetryablePostgresTransactionConflict } from "../src/database/postgres-transaction.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "../..");
const FRAMEWORK_PATH = path.join(
  REPO_ROOT,
  "packages/shared/build/framework.js",
);
const CONTAINER_NAME = `hyperia-agent-websocket-auth-${process.pid}`;
const PLUGIN_RUNTIME_ENV = "AGENT_WEBSOCKET_AUTH_PLUGIN_RUNTIME" as const;
const CHILD_MODE_ENV = "AGENT_WEBSOCKET_AUTH_CHILD_MODE" as const;
const CHILD_SOCKET_URL_ENV = "AGENT_WEBSOCKET_AUTH_CHILD_SOCKET_URL" as const;
const CHILD_AUTH_TOKEN_ENV = "AGENT_WEBSOCKET_AUTH_CHILD_TOKEN" as const;
const CHILD_CHARACTER_ID_ENV =
  "AGENT_WEBSOCKET_AUTH_CHILD_CHARACTER_ID" as const;
const CHILD_MODEL_MODE_ENV = "AGENT_WEBSOCKET_AUTH_CHILD_MODEL_MODE" as const;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HOST_LEASE_MS = 5_000;
const HOST_HEARTBEAT_MS = 1_000;
const HOST_CLAIM_GRACE_MS = 1_000;
const STRATEGY_PLAN_MELEE_ID = "11111111-1111-4111-8111-111111111111";
const STRATEGY_PLAN_RANGED_ID = "22222222-2222-4222-8222-222222222222";
const STRATEGY_FOOD_ID = "33333333-3333-4333-8333-333333333333";
const STRATEGY_ARMOR_MELEE_ID = "44444444-4444-4444-8444-444444444444";
const STRATEGY_ARMOR_RANGED_ID = "55555555-5555-4555-8555-555555555555";
const VALID_STRATEGY_DECISION = {
  planOptionId: STRATEGY_PLAN_RANGED_ID,
  foodOptionId: STRATEGY_FOOD_ID,
  armorOptionId: STRATEGY_ARMOR_RANGED_ID,
  primaryStyle: "ranged",
  reason: "Use the bounded ranged option and preserve distance.",
  tacticalStrategy: {
    approach: "balanced",
    tacticalMacro: "kite",
    attackStyle: "accurate",
    prayer: null,
    preferredCombatRole: "ranged",
    foodThreshold: 40,
    switchDefensiveAt: 30,
    reasoning: "Maintain legal distance and adapt from live authority.",
  },
} as const;

type PluginRuntime = "source" | "built";
type ChildModelMode = "invalid" | "hang" | "valid";

type PacketRecord = {
  method: string;
  data: unknown;
};

type ServiceInternals = {
  autoReconnect: boolean;
  characterId?: string;
  connectionState: { connected: boolean; connecting: boolean };
  duelPreparationHostLease: { preparationId: string } | null;
  gameState: { playerEntity: { id: string } | null };
  ws: WebSocket | null;
};

type PluginService = {
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  setAuthToken(authToken: string): void;
  setAutonomousBehaviorEnabled(enabled: boolean): void;
};

type JsonEvent = {
  type: string;
  [key: string]: unknown;
};

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type ChildMonitor = {
  child: ChildProcess;
  events: JsonEvent[];
  stderr: () => string;
  exit: () => ChildExit | null;
  waitFor(
    predicate: (event: JsonEvent) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<JsonEvent>;
};

function assert(
  condition: unknown,
  message: string,
  details?: unknown,
): asserts condition {
  if (condition) return;
  throw new Error(
    details === undefined ? message : `${message}: ${JSON.stringify(details)}`,
  );
}

function resolvePluginRuntime(): PluginRuntime {
  const runtime = process.env[PLUGIN_RUNTIME_ENV]?.trim() || "built";
  if (runtime !== "source" && runtime !== "built") {
    throw new Error(`${PLUGIN_RUNTIME_ENV} must be source or built`);
  }
  return runtime;
}

function resolveChildModelMode(): ChildModelMode {
  const mode = process.env[CHILD_MODEL_MODE_ENV]?.trim() || "invalid";
  if (mode !== "invalid" && mode !== "hang" && mode !== "valid") {
    throw new Error(`${CHILD_MODEL_MODE_ENV} must be invalid, hang, or valid`);
  }
  return mode;
}

function createProviderStrategyRequest(input: {
  preparationId: string;
  expiresAt: number;
  agentName: string;
  opponentName: string;
}): Record<string, unknown> {
  return {
    requestId: randomUUID(),
    preparationId: input.preparationId,
    policyVersion: "duel-preparation-role-v3",
    protocolVersion: "external-duel-preparation-strategy-v5",
    expiresAt: input.expiresAt,
    decisionDeadlineAt: Math.min(input.expiresAt - 100, Date.now() + 3_000),
    agentName: input.agentName,
    opponentName: input.opponentName,
    ownPublicProfile: {
      narrative: "Adaptive authenticated fighter.",
      pillars: ["patient"],
    },
    opponentPublicProfile: null,
    opponentHistorySummary: {
      sampleSize: 1,
      observedOpponentOpeningStyleFocus: "ranged",
      recent: [
        {
          result: "loss",
          ownOpeningStyle: "melee",
          opponentOpeningStyle: "ranged",
          winReason: "kill",
        },
      ],
    },
    availableRoles: ["melee", "ranged"],
    availablePrayerIds: [],
    preparationOptions: [
      {
        planOptionId: STRATEGY_PLAN_MELEE_ID,
        primaryStyle: "melee",
        styleRank: 1,
        attackSupplyUnits: null,
        canUseShield: true,
      },
      {
        planOptionId: STRATEGY_PLAN_RANGED_ID,
        primaryStyle: "ranged",
        styleRank: 1,
        attackSupplyUnits: 20,
        canUseShield: false,
      },
    ],
    foodOptions: [
      { foodOptionId: STRATEGY_FOOD_ID, recoveryRank: 1, quantity: 4 },
    ],
    armorOptions: [
      {
        armorOptionId: STRATEGY_ARMOR_MELEE_ID,
        planOptionId: STRATEGY_PLAN_MELEE_ID,
        offenseRank: 1,
        focusedDefenseRank: null,
        totalDefenseRank: 1,
      },
      {
        armorOptionId: STRATEGY_ARMOR_RANGED_ID,
        planOptionId: STRATEGY_PLAN_RANGED_ID,
        offenseRank: 1,
        focusedDefenseRank: null,
        totalDefenseRank: 1,
      },
    ],
    deterministicPlanOptionId: STRATEGY_PLAN_MELEE_ID,
    deterministicFoodOptionId: STRATEGY_FOOD_ID,
    deterministicArmorOptionId: STRATEGY_ARMOR_MELEE_ID,
    deterministicRole: "melee",
  };
}

async function docker(args: string[]): Promise<string> {
  const result = await execFileAsync(
    process.env.DOCKER_BIN?.trim() || "docker",
    args,
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return result.stdout.trim();
}

async function delay(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

function trace(message: string): void {
  if (process.env.AGENT_WEBSOCKET_AUTH_TRACE === "true") {
    process.stderr.write(`[agent-websocket-auth] ${message}\n`);
  }
}

async function settleWithin(
  label: string,
  action: () => Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    trace(`${label} cleanup warning: ${String(error)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForPostgres(connectionString: string): Promise<pg.Pool> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 1_000,
      statement_timeout: 2_000,
      query_timeout: 3_000,
    });
    try {
      await pool.query("SELECT 1");
      return pool;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => undefined);
      await delay(200);
    }
  }
  throw new Error(
    `owned PostgreSQL did not become ready: ${String(lastError)}`,
  );
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`${message} after ${timeoutMs}ms`);
}

async function waitForExpiredHostLeaseReport(
  store: {
    reportExpiredContestantHostLease(input: {
      preparationId: string;
      claimGraceMs: number;
    }): Promise<{
      preparationId: string;
      agentId: string;
      reason: string;
      reportedAt: number;
    } | null>;
  },
  preparationId: string,
  timeoutMs = 15_000,
): Promise<{
  preparationId: string;
  agentId: string;
  reason: string;
  reportedAt: number;
}> {
  const deadline = Date.now() + timeoutMs;
  let conflictAttempt = 0;
  while (Date.now() < deadline) {
    let report;
    try {
      report = await store.reportExpiredContestantHostLease({
        preparationId,
        claimGraceMs: HOST_CLAIM_GRACE_MS,
      });
    } catch (error) {
      if (
        !isRetryablePostgresTransactionConflict(error) ||
        conflictAttempt >= 4
      ) {
        throw error;
      }
      conflictAttempt += 1;
      await delay(10 * conflictAttempt);
      continue;
    }
    if (report) return report;
    await delay(100);
  }
  throw new Error(
    `on-deck host loss was not durably reported after ${timeoutMs}ms`,
  );
}

function writeJsonEvent(event: JsonEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createChildMonitor(child: ChildProcess): ChildMonitor {
  assert(child.stdout && child.stderr, "agent host pipes are missing");
  const events: JsonEvent[] = [];
  let stdoutBuffer = "";
  let stderrTail = "";
  let exit: ChildExit | null = null;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { type?: unknown }).type === "string"
        ) {
          events.push(parsed as JsonEvent);
        }
      } catch {
        // Runtime diagnostics may share stdout with structured child evidence.
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-20_000);
  });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });

  return {
    child,
    events,
    stderr: () => stderrTail,
    exit: () => exit,
    async waitFor(predicate, timeoutMs, label) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = events.find(predicate);
        if (match) return match;
        if (exit) {
          throw new Error(
            `${label}: agent host exited code=${exit.code} signal=${exit.signal}: ${stderrTail}`,
          );
        }
        await delay(25);
      }
      throw new Error(
        `${label}: timed out after ${timeoutMs}ms: ${stderrTail}`,
      );
    },
  };
}

function spawnPluginHost(input: {
  socketUrl: string;
  authToken: string;
  characterId: string;
  pluginRuntime: PluginRuntime;
  modelMode?: ChildModelMode;
}): ChildMonitor {
  return createChildMonitor(
    spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        [CHILD_MODE_ENV]: "plugin-host",
        [CHILD_SOCKET_URL_ENV]: input.socketUrl,
        [CHILD_AUTH_TOKEN_ENV]: input.authToken,
        [CHILD_CHARACTER_ID_ENV]: input.characterId,
        [CHILD_MODEL_MODE_ENV]: input.modelMode || "invalid",
        [PLUGIN_RUNTIME_ENV]: input.pluginRuntime,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

async function waitForChildExit(
  monitor: ChildMonitor,
  timeoutMs: number,
  label: string,
): Promise<ChildExit> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exit = monitor.exit();
    if (exit) return exit;
    await delay(25);
  }
  throw new Error(`${label}: child did not exit within ${timeoutMs}ms`);
}

async function killOwnedChild(
  monitor: ChildMonitor | null,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<ChildExit | null> {
  if (!monitor) return null;
  const existing = monitor.exit();
  if (existing) return existing;
  monitor.child.kill(signal);
  return waitForChildExit(monitor, 5_000, "owned agent-host cleanup").catch(
    () => null,
  );
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return new Uint8Array(data);
}

function normalizePacketMethod(method: string): string {
  if (
    method.length > 2 &&
    method.startsWith("on") &&
    /[A-Z]/u.test(method[2])
  ) {
    return `${method[2].toLowerCase()}${method.slice(3)}`;
  }
  return method;
}

async function listen(server: WebSocketServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(
    address && typeof address === "object" && address.port > 0,
    "WebSocket listener address is unavailable",
  );
  return address.port;
}

async function closeServer(
  server: WebSocketServer | null,
  transportSockets: ReadonlySet<Socket>,
): Promise<void> {
  if (!server) return;
  for (const socket of server.clients) socket.terminate();
  for (const socket of transportSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function openRawSocket(socketUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("raw WebSocket connection timed out")),
      5_000,
    );
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return socket;
}

async function proveMismatchedCharacterRejected(input: {
  socketUrl: string;
  authToken: string;
  accountId: string;
  characterId: string;
  wrongCharacterId: string;
  network: {
    flush(): void;
    sockets: Map<string, Record<string, unknown>>;
  };
  readPacket(packet: Uint8Array): [string, unknown] | [] | null;
  writePacket(name: string, data: unknown): Uint8Array | ArrayBuffer;
}): Promise<void> {
  const packets: PacketRecord[] = [];
  const socket = await openRawSocket(input.socketUrl);
  socket.on("message", (raw) => {
    const packet = input.readPacket(rawDataBytes(raw));
    if (!packet || packet.length !== 2) return;
    const [wireMethod, data] = packet;
    const method = normalizePacketMethod(wireMethod);
    packets.push({ method, data });
    if (
      method === "authResult" ||
      method === "snapshot" ||
      method === "enterWorldRejected"
    ) {
      trace(`mismatch probe received ${method}`);
    }
  });
  socket.send(
    input.writePacket("authenticate", {
      authToken: input.authToken,
      name: "Bound Agent Mismatch Probe",
    }),
  );

  await waitFor(() => {
    input.network.flush();
    return packets.some(
      ({ method, data }) =>
        method === "authResult" &&
        (data as { success?: unknown } | null)?.success === true,
    );
  }, "mismatch probe did not authenticate");
  trace("mismatch probe authenticated");
  await waitFor(() => {
    input.network.flush();
    return packets.some(({ method }) => method === "snapshot");
  }, "mismatch probe did not receive a snapshot");
  trace("mismatch probe received snapshot");

  socket.send(
    input.writePacket("characterSelected", {
      characterId: input.wrongCharacterId,
    }),
  );
  socket.send(
    input.writePacket("enterWorld", {
      characterId: input.wrongCharacterId,
    }),
  );

  await waitFor(() => {
    input.network.flush();
    return packets.some(
      ({ method, data }) =>
        method === "enterWorldRejected" &&
        (data as { reason?: unknown } | null)?.reason ===
          "credential_character_mismatch",
    );
  }, "credential-bound character mismatch was not rejected");
  trace("mismatch probe rejected wrong character");

  const probeSocket = [...input.network.sockets.values()].find(
    (candidate) =>
      candidate.accountId === input.accountId &&
      candidate.agentCredentialCharacterId === input.characterId &&
      candidate.player === undefined,
  );
  assert(probeSocket, "authenticated mismatch probe socket was not found");
  assert(
    probeSocket.selectedCharacterId === undefined &&
      probeSocket.characterId === undefined,
    "mismatch probe claimed a character before rejection",
  );
  socket.close(1000, "mismatch proof complete");
  await waitFor(() => {
    input.network.flush();
    return !input.network.sockets.has(String(probeSocket.id));
  }, "mismatch probe socket did not cleanly detach");
  trace("mismatch probe detached");
}

async function runPluginHostChild(): Promise<never> {
  const socketUrl = requireEnv(CHILD_SOCKET_URL_ENV);
  const authToken = requireEnv(CHILD_AUTH_TOKEN_ENV);
  const characterId = requireEnv(CHILD_CHARACTER_ID_ENV);
  const pluginRuntime = resolvePluginRuntime();
  const modelMode = resolveChildModelMode();
  const pluginModule =
    pluginRuntime === "built"
      ? await import("../../plugin-hyperia/dist/services/HyperiaService.js")
      : await import("../../plugin-hyperia/src/services/HyperiaService.ts");
  let service: PluginService | null = null;
  const runtime = {
    agentId: characterId,
    character: { name: `Process Host ${characterId}` },
    getSetting: (key: string) =>
      key === "HYPERIA_AUTH_TOKEN"
        ? authToken
        : key === "HYPERIA_CHARACTER_ID"
          ? characterId
          : null,
    getService: () => service,
    useModel: async () => {
      writeJsonEvent({ type: "model_requested", characterId, modelMode });
      if (modelMode === "hang") {
        return await new Promise<string>(() => undefined);
      }
      if (modelMode === "valid") {
        return JSON.stringify(VALID_STRATEGY_DECISION);
      }
      return "{}";
    },
  };
  service = new pluginModule.HyperiaService(runtime as never);
  service.setAuthToken(authToken);
  service.setAutonomousBehaviorEnabled(false);
  const internals = service as unknown as ServiceInternals & {
    broadcastEvent(eventType: string, data: unknown): void;
  };
  internals.characterId = characterId;
  internals.autoReconnect = false;
  internals.broadcastEvent = (eventType, data) => {
    if (eventType === "DUEL_ON_DECK") {
      writeJsonEvent({ type: "duel_on_deck", characterId, data });
    } else if (eventType === "DUEL_PREPARATION_REVOKED") {
      writeJsonEvent({ type: "lease_revoked", characterId, data });
    }
  };
  await service.connect(socketUrl);
  writeJsonEvent({
    type: "transport_ready",
    characterId,
    pid: process.pid,
    credentialInUrl: socketUrl.includes(authToken),
    pluginRuntime,
    modelMode,
  });
  await new Promise<never>(() => undefined);
  throw new Error("agent host hold unexpectedly resolved");
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  if (process.env.AGENT_WEBSOCKET_AUTH_VERBOSE !== "true") {
    console.log = () => undefined;
    console.warn = () => undefined;
  }
  const pluginRuntime = resolvePluginRuntime();
  const databaseUser = "agent_websocket_auth";
  const databaseName = "agent_websocket_auth";
  const databasePassword = `agent-auth-${randomUUID()}`;
  const accountId = `agent-auth-account-${randomUUID()}`;
  const characterId = `agent-auth-character-${randomUUID()}`;
  const survivorAccountId = `agent-auth-survivor-account-${randomUUID()}`;
  const survivorCharacterId = `agent-auth-survivor-character-${randomUUID()}`;
  const wrongAccountId = `agent-auth-wrong-account-${randomUUID()}`;
  const wrongCharacterId = `agent-auth-wrong-character-${randomUUID()}`;
  const sessionId = randomUUID();
  const survivorSessionId = randomUUID();
  const preparationId = randomUUID();
  const preparationFencingToken = "901";
  const processPreparationId = randomUUID();
  const processPreparationFencingToken = "902";
  const stalledProcessPreparationId = randomUUID();
  const stalledProcessPreparationFencingToken = "903";
  const selectedWholePlanOperationId = randomUUID();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
  const jwtKeyId = "agent-websocket-auth-v1";
  const jwtSecret = `agent-websocket-auth-${randomUUID()}-${randomUUID()}`;
  const rateLimitSecret = `agent-websocket-rate-limit-${randomUUID()}-${randomUUID()}`;
  let containerStarted = false;
  let verificationPool: pg.Pool | null = null;
  let closeDatabase: (() => Promise<void>) | null = null;
  let databaseSystem: { waitForPendingOperations(): Promise<void> } | null =
    null;
  let world: { destroy?: () => void } | null = null;
  let server: WebSocketServer | null = null;
  const serverTransportSockets = new Set<Socket>();
  let service: PluginService | null = null;
  let survivorService: PluginService | null = null;
  let revokedService: PluginService | null = null;
  let killedHost: ChildMonitor | null = null;
  let survivingHost: ChildMonitor | null = null;
  let replacementHost: ChildMonitor | null = null;
  let stalledHost: ChildMonitor | null = null;
  let stalledPeerHost: ChildMonitor | null = null;
  let report: Record<string, unknown> | null = null;
  let onDeckEvidence: Record<string, unknown> | null = null;

  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(
        `Docker is required for the production agent auth gate: ${String(error)}`,
      );
    });
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      CONTAINER_NAME,
      "-e",
      `POSTGRES_USER=${databaseUser}`,
      "-e",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      process.env.AGENT_WEBSOCKET_AUTH_POSTGRES_IMAGE?.trim() ||
        "postgres:16-alpine",
    ]);
    containerStarted = true;
    const port = Number(
      (await docker(["port", CONTAINER_NAME, "5432/tcp"])).split(":").pop(),
    );
    assert(Number.isSafeInteger(port) && port > 0, "invalid PostgreSQL port");
    const connectionString = `postgres://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
    verificationPool = await waitForPostgres(connectionString);

    process.chdir(path.join(SERVER_DIR, "world"));
    process.env.NODE_ENV = "production";
    process.env.SKIP_VALIDATION = "true";
    process.env.DISABLE_BOTS = "true";
    process.env.DISABLE_ACTIVITY_LOGGER = "true";
    process.env.DISABLE_WORLD_CHUNK_PERSISTENCE = "true";
    process.env.DATA_OPTIONAL_MANIFEST_WARNINGS = "false";
    process.env.TERRAIN_SERVER_MESH_COLLISION_ENABLED = "false";
    process.env.RECONNECT_GRACE_MS = "5000";
    process.env.HYPERIA_DATA_DIR = path.join(SERVER_DIR, "world");
    process.env.ASSETS_DIR = path.join(SERVER_DIR, "world/assets");
    process.env.POSTGRES_CONNECTION_TIMEOUT_MS = "1000";
    process.env.POSTGRES_STATEMENT_TIMEOUT_MS = "2000";
    process.env.POSTGRES_QUERY_TIMEOUT_MS = "3000";
    process.env.DUEL_PREPARATION_AGENT_HOST_LEASE_MS = String(HOST_LEASE_MS);
    process.env.DUEL_PREPARATION_AGENT_HOST_HEARTBEAT_MS =
      String(HOST_HEARTBEAT_MS);
    process.env.DUEL_PREPARATION_AGENT_HOST_CLAIM_GRACE_MS =
      String(HOST_CLAIM_GRACE_MS);
    process.env.JWT_ACTIVE_KEY_ID = jwtKeyId;
    process.env.JWT_SIGNING_KEYS = JSON.stringify({
      [jwtKeyId]: jwtSecret,
    });
    process.env.DISTRIBUTED_RATE_LIMIT_KEY_SECRET = rateLimitSecret;
    delete process.env.JWT_SECRET;

    const framework = await import(pathToFileURL(FRAMEWORK_PATH).href);
    const [
      databaseClient,
      databaseAdapter,
      databaseModule,
      networkModule,
      credentialClaims,
      jwtUtils,
      shared,
      pluginModule,
      externalBuildModule,
      preparationModule,
      agentBankingModule,
    ] = await Promise.all([
      import("../src/database/client.ts"),
      import("../src/database/adapter.ts"),
      import("../src/systems/DatabaseSystem/index.ts"),
      import("../src/systems/ServerNetwork/index.ts"),
      import("../src/infrastructure/auth/agent-credential-session.ts"),
      import("../src/shared/utils.ts"),
      import("@hyperforge/shared"),
      pluginRuntime === "built"
        ? import("../../plugin-hyperia/dist/services/HyperiaService.js")
        : import("../../plugin-hyperia/src/services/HyperiaService.ts"),
      pluginRuntime === "built"
        ? import("../../plugin-hyperia/dist/externalAgentBuildIdentity.js")
        : import("../../plugin-hyperia/src/externalAgentBuildIdentity.ts"),
      import("../src/systems/StreamingDuelScheduler/preparation.ts"),
      import("../src/eliza/AuthoritativeAgentBanking.ts"),
    ]);

    const externalBuildIdentity =
      externalBuildModule.getExternalAgentExecutableBuildIdentity();
    assert(
      externalBuildIdentity.verified === (pluginRuntime === "built"),
      "external agent executable-build verification classification diverged",
    );
    process.env.DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS =
      externalBuildIdentity.buildId;

    const initialized =
      await databaseClient.initializeDatabase(connectionString);
    closeDatabase = databaseClient.closeDatabase;
    const systemDatabase = databaseAdapter.createDrizzleAdapter(
      initialized.db as Parameters<
        typeof databaseAdapter.createDrizzleAdapter
      >[0],
    );
    await databaseClient.assertAgentCredentialSessionDatabaseAuthority(
      verificationPool,
      { NODE_ENV: "production" },
    );

    await verificationPool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, 'Production Auth Agent', 'agent', $3),
              ($2, 'Wrong Account', 'agent', $4),
              ($3, 'Production Auth Survivor', 'agent', $4)`,
      [accountId, wrongAccountId, survivorAccountId, issuedAt.toISOString()],
    );
    await verificationPool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent")
       VALUES ($1, $2, 'Production Auth Agent', 1),
              ($3, $4, 'Wrong Account Agent', 1),
              ($5, $6, 'Production Auth Survivor', 1)`,
      [
        characterId,
        accountId,
        wrongCharacterId,
        wrongAccountId,
        survivorCharacterId,
        survivorAccountId,
      ],
    );
    await verificationPool.query(
      `INSERT INTO agent_credential_sessions
         (session_id, account_id, character_id, auth_method, issued_at, expires_at)
       VALUES ($1, $2, $3, 'server-managed-agent-v1', $7, $8),
              ($4, $5, $6, 'server-managed-agent-v1', $7, $8)`,
      [
        sessionId,
        accountId,
        characterId,
        survivorSessionId,
        survivorAccountId,
        survivorCharacterId,
        issuedAt,
        expiresAt,
      ],
    );
    await verificationPool.query(
      `INSERT INTO agent_mappings (
         agent_id, account_id, character_id, agent_name,
         streaming_duel_enabled, created_at, updated_at
       ) VALUES
         ($1, $3, $1, 'Production Auth Agent', true, NOW(), NOW()),
         ($2, $4, $2, 'Production Auth Survivor', true, NOW(), NOW())`,
      [characterId, survivorCharacterId, accountId, survivorAccountId],
    );
    await verificationPool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'lobster', 1, 0)`,
      [survivorCharacterId],
    );
    await verificationPool.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'body', 'bronze_platebody', 1),
              ($1, 'weapon', 'bronze_longsword', 1)`,
      [survivorCharacterId],
    );
    await verificationPool.query(
      `INSERT INTO bank_storage
         ("playerId", "itemId", quantity, slot, "tabIndex")
       VALUES ($1, 'shortbow', 1, 0, 0),
              ($1, 'bronze_arrow', 50, 1, 0),
              ($1, 'lobster', 3, 2, 0),
              ($1, 'wizard_robe_top', 1, 3, 0)`,
      [survivorCharacterId],
    );

    const authToken = await jwtUtils.createJWT(
      credentialClaims.buildAgentCredentialJwtPayload({
        accountId,
        authMethod: "server-managed-agent-v1",
        characterId,
        expiresAt: expiresAt.toISOString(),
        sessionId,
      }),
    );
    const survivorAuthToken = await jwtUtils.createJWT(
      credentialClaims.buildAgentCredentialJwtPayload({
        accountId: survivorAccountId,
        authMethod: "server-managed-agent-v1",
        characterId: survivorCharacterId,
        expiresAt: expiresAt.toISOString(),
        sessionId: survivorSessionId,
      }),
    );
    assert(!authToken.includes(jwtSecret), "JWT exposed its signing secret");
    assert(
      !survivorAuthToken.includes(jwtSecret),
      "survivor JWT exposed its signing secret",
    );

    world = await framework.createServerWorld();
    const liveWorld = world as Record<string, unknown> & {
      assetsUrl: string;
      drizzleDb: unknown;
      emit(event: string, data: unknown): boolean;
      entities: {
        get(id: string): Record<string, unknown> | undefined;
      };
      getSystem(name: string): unknown;
      on(
        event: string,
        listener: (data: Record<string, unknown>) => void,
      ): void;
      pgPool: pg.Pool;
      register(name: string, system: unknown): void;
      settings: { model?: string };
      init(options: Record<string, unknown>): Promise<void>;
    };
    liveWorld.register("database", databaseModule.DatabaseSystem);
    liveWorld.register("network", networkModule.ServerNetwork);
    liveWorld.pgPool = initialized.pool;
    liveWorld.drizzleDb = initialized.db;
    liveWorld.settings.model = "asset://world/base-environment.glb";
    liveWorld.assetsUrl = "http://127.0.0.1/agent-auth-assets/";
    await liveWorld.init({
      assetsDir: path.join(SERVER_DIR, "world/assets"),
      db: systemDatabase,
      physics: false,
      renderer: "headless",
      storage: new framework.NodeStorage(),
    });
    databaseSystem = liveWorld.getSystem("database") as {
      waitForPendingOperations(): Promise<void>;
    };

    const joinedEvents: Record<string, unknown>[] = [];
    const leftEvents: Record<string, unknown>[] = [];
    const hostLeaseActivations: Record<string, unknown>[] = [];
    const externalStrategyResponses: Array<
      Record<string, unknown> & { receivedAt: number }
    > = [];
    liveWorld.on(shared.EventType.PLAYER_JOINED, (event) => {
      if (event.playerId === characterId) joinedEvents.push(event);
    });
    liveWorld.on(shared.EventType.PLAYER_LEFT, (event) => {
      if (event.playerId === characterId) leftEvents.push(event);
    });
    liveWorld.on(
      "duel:preparation:external_host_active",
      (event: Record<string, unknown>) => {
        if (
          (event.preparationId === preparationId ||
            event.preparationId === processPreparationId ||
            event.preparationId === stalledProcessPreparationId) &&
          (event.agentId === characterId ||
            event.agentId === survivorCharacterId)
        ) {
          hostLeaseActivations.push(event);
        }
      },
    );
    liveWorld.on(
      "duel:preparation:external_strategy_response",
      (event: Record<string, unknown>) => {
        externalStrategyResponses.push({ ...event, receivedAt: Date.now() });
      },
    );

    const network = liveWorld.getSystem("network") as {
      flush(): void;
      onConnection(
        socket: unknown,
        params: Record<string, unknown>,
      ): Promise<void>;
      sockets: Map<
        string,
        {
          id: string;
          accountId?: string;
          agentCredentialCharacterId?: string;
          agentCredentialSessionId?: string;
          characterId?: string;
          player?: {
            id: string;
            data: Record<string, unknown>;
          };
          selectedCharacterId?: string;
          send(name: string, data: unknown): void;
        }
      >;
    };
    assert(network, "live ServerNetwork was not registered");

    const requestUrls: string[] = [];
    server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ws" });
    server.on("connection", (socket: ServerWebSocket, request) => {
      serverTransportSockets.add(request.socket);
      request.socket.once("close", () => {
        serverTransportSockets.delete(request.socket);
      });
      requestUrls.push(request.url || "");
      (
        socket as ServerWebSocket & { __remoteAddress?: string }
      ).__remoteAddress = request.socket.remoteAddress;
      void network.onConnection(socket, {}).catch((error) => {
        socket.close(1011, "connection handler failed");
        console.error(error);
      });
    });
    const socketPort = await listen(server);
    const socketUrl = `ws://127.0.0.1:${socketPort}/ws`;

    const runtime = {
      agentId: characterId,
      character: { name: "Production Auth Agent" },
      getSetting: (key: string) =>
        key === "HYPERIA_AUTH_TOKEN"
          ? authToken
          : key === "HYPERIA_CHARACTER_ID"
            ? characterId
            : null,
      getService: () => service,
      useModel: async () => "{}",
    };
    service = new pluginModule.HyperiaService(runtime as never);
    service.setAuthToken(authToken);
    service.setAutonomousBehaviorEnabled(false);
    const serviceInternals = service as unknown as ServiceInternals;
    serviceInternals.characterId = characterId;
    serviceInternals.autoReconnect = false;

    const survivorRuntime = {
      agentId: survivorCharacterId,
      character: { name: "Production Auth Survivor" },
      getSetting: (key: string) =>
        key === "HYPERIA_AUTH_TOKEN"
          ? survivorAuthToken
          : key === "HYPERIA_CHARACTER_ID"
            ? survivorCharacterId
            : null,
      getService: () => survivorService,
      useModel: async () => "{}",
    };
    survivorService = new pluginModule.HyperiaService(survivorRuntime as never);
    survivorService.setAuthToken(survivorAuthToken);
    survivorService.setAutonomousBehaviorEnabled(false);
    const survivorServiceInternals =
      survivorService as unknown as ServiceInternals;
    survivorServiceInternals.characterId = survivorCharacterId;
    survivorServiceInternals.autoReconnect = false;

    await service.connect(socketUrl);
    await survivorService.connect(socketUrl);
    await waitFor(() => {
      network.flush();
      const sockets = [...network.sockets.values()];
      return (
        sockets.some(
          (socket) =>
            socket.accountId === accountId &&
            socket.agentCredentialSessionId === sessionId &&
            socket.agentCredentialCharacterId === characterId,
        ) &&
        sockets.some(
          (socket) =>
            socket.accountId === survivorAccountId &&
            socket.agentCredentialSessionId === survivorSessionId &&
            socket.agentCredentialCharacterId === survivorCharacterId,
        )
      );
    }, "signed agent credentials did not bind to both live sockets");

    await waitFor(
      () => {
        network.flush();
        const sockets = [...network.sockets.values()];
        const primarySocket = sockets.find(
          (candidate) => candidate.accountId === accountId && candidate.player,
        );
        const survivorSocket = sockets.find(
          (candidate) =>
            candidate.accountId === survivorAccountId && candidate.player,
        );
        return Boolean(
          primarySocket?.player?.id === characterId &&
          primarySocket.characterId === characterId &&
          primarySocket.player.data.isAgent === true &&
          primarySocket.player.data.isLoading === false &&
          serviceInternals.gameState.playerEntity?.id === characterId &&
          survivorSocket?.player?.id === survivorCharacterId &&
          survivorSocket.characterId === survivorCharacterId &&
          survivorSocket.player.data.isAgent === true &&
          survivorSocket.player.data.isLoading === false &&
          survivorServiceInternals.gameState.playerEntity?.id ===
            survivorCharacterId,
        );
      },
      "built agents did not complete authoritative character entry",
      30_000,
    );
    trace("both credential-bound agents completed authoritative world entry");

    const firstSocket = [...network.sockets.values()].find(
      (candidate) => candidate.accountId === accountId && candidate.player,
    );
    assert(firstSocket?.player, "first authenticated player socket is missing");
    const retainedEntity = firstSocket.player;
    assert(
      joinedEvents.some(
        (event) => event.playerId === characterId && event.isAgent === true,
      ),
      "initial PLAYER_JOINED did not identify the credential-bound agent",
    );
    const initialPrimaryJoinCount = joinedEvents.length;
    assert(
      initialPrimaryJoinCount === 1,
      "initial plugin connection emitted duplicate world-entry authority",
      { joinedEvents },
    );
    assert(
      requestUrls.every(
        (url) => !url.includes("authToken") && !url.includes(authToken),
      ),
      "agent credential leaked into the WebSocket URL",
    );

    await proveMismatchedCharacterRejected({
      socketUrl,
      authToken,
      accountId,
      characterId,
      wrongCharacterId,
      network: network as never,
      readPacket: shared.readPacket,
      writePacket: shared.writePacket,
    });
    trace("cross-account character proof completed");

    serviceInternals.ws?.terminate();
    await waitFor(() => {
      network.flush();
      return (
        !network.sockets.has(firstSocket.id) &&
        liveWorld.entities.get(characterId) === retainedEntity &&
        leftEvents.some(
          (event) =>
            event.playerId === characterId &&
            event.reconnectGraceActive === true &&
            typeof event.reconnectGraceExpiresAt === "number",
        )
      );
    }, "abnormal disconnect did not retain the exact agent entity");
    trace("abnormal disconnect retained exact entity");
    await waitFor(
      () => serviceInternals.connectionState.connected === false,
      "plugin did not observe its abnormal transport loss",
    );
    trace("plugin observed abnormal transport loss");

    await service.connect(socketUrl);
    await waitFor(
      () => {
        network.flush();
        const replacement = [...network.sockets.values()].find(
          (candidate) => candidate.accountId === accountId && candidate.player,
        );
        return Boolean(
          replacement &&
          replacement.id !== firstSocket.id &&
          replacement.player === retainedEntity &&
          replacement.agentCredentialSessionId === sessionId &&
          replacement.agentCredentialCharacterId === characterId &&
          retainedEntity.data.owner === replacement.id &&
          joinedEvents.some(
            (event) =>
              event.playerId === characterId &&
              event.isReconnect === true &&
              event.isAgent === true,
          ),
        );
      },
      "credential-bound reconnect did not reattach the retained entity",
      30_000,
    );
    trace("credential-bound reconnect reattached exact entity");
    assert(
      joinedEvents.length === initialPrimaryJoinCount + 1,
      "plugin reconnect emitted duplicate world-entry authority",
      { initialPrimaryJoinCount, joinedEvents },
    );

    const reconnectedSocket = [...network.sockets.values()].find(
      (candidate) => candidate.accountId === accountId && candidate.player,
    );
    const survivorSocket = [...network.sockets.values()].find(
      (candidate) =>
        candidate.accountId === survivorAccountId && candidate.player,
    );
    assert(
      reconnectedSocket?.player?.id === characterId &&
        survivorSocket?.player?.id === survivorCharacterId,
      "authenticated on-deck contestant sockets are missing",
    );

    const preparationStore = new preparationModule.PostgresDuelPreparationStore(
      verificationPool,
    );
    const preparation = await preparationStore.create({
      preparationId,
      fencingToken: preparationFencingToken,
      agent1Id: characterId,
      agent2Id: survivorCharacterId,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: preparationModule.DUEL_PREPARATION_BANK_ACTIONS,
    });
    reconnectedSocket.send("duelOnDeck", {
      preparationId,
      selectedAt: preparation.selectedAt,
      expiresAt: preparation.expiresAt,
      opponentId: survivorCharacterId,
      opponentName: "Production Auth Survivor",
    });
    survivorSocket.send("duelOnDeck", {
      preparationId,
      selectedAt: preparation.selectedAt,
      expiresAt: preparation.expiresAt,
      opponentId: characterId,
      opponentName: "Production Auth Agent",
    });

    type HostLeaseRow = {
      agentId: string;
      ownerId: string;
      executableBuildId: string | null;
      claimedAt: string;
      heartbeatAt: string;
      expiresAt: string;
    };
    let activeHostLeases: HostLeaseRow[] = [];
    await waitFor(async () => {
      network.flush();
      const rows = await verificationPool!.query<HostLeaseRow>(
        `SELECT "agentId", "ownerId", "executableBuildId",
                "claimedAt"::text AS "claimedAt",
                "heartbeatAt"::text AS "heartbeatAt",
                "expiresAt"::text AS "expiresAt"
           FROM streaming_duel_preparation_agent_host_leases
          WHERE "preparationId" = $1
          ORDER BY "agentId"`,
        [preparationId],
      );
      activeHostLeases = rows.rows;
      return (
        rows.rows.length === 2 &&
        rows.rows.every(
          (row) =>
            row.executableBuildId === externalBuildIdentity.buildId &&
            Number(row.heartbeatAt) >= Number(row.claimedAt) &&
            Number(row.expiresAt) > Number(row.heartbeatAt),
        ) &&
        hostLeaseActivations.length === 2
      );
    }, "authenticated contestants did not claim and refresh both host leases");
    assert(
      new Set(activeHostLeases.map((row) => row.ownerId)).size === 1,
      "contestants hosted by one plugin process diverged on process identity",
    );
    assert(
      hostLeaseActivations.every(
        (activation) =>
          activation.executableBuildId === externalBuildIdentity.buildId &&
          activeHostLeases.some(
            (lease) =>
              lease.agentId === activation.agentId &&
              lease.ownerId === activation.ownerId,
          ),
      ),
      "real ServerNetwork host activation diverged from durable lease authority",
    );
    trace("both authenticated contestants claimed durable on-deck leases");

    const disconnectedLease = activeHostLeases.find(
      (row) => row.agentId === characterId,
    );
    assert(disconnectedLease, "primary contestant host lease is missing");
    serviceInternals.ws?.terminate();
    await waitFor(() => {
      network.flush();
      return (
        serviceInternals.connectionState.connected === false &&
        ![...network.sockets.values()].some(
          (candidate) => candidate.accountId === accountId,
        ) &&
        [...network.sockets.values()].some(
          (candidate) =>
            candidate.accountId === survivorAccountId && candidate.player,
        )
      );
    }, "on-deck transport loss did not isolate the exact contestant");

    const earlyReport = await preparationStore.reportExpiredContestantHostLease(
      {
        preparationId,
        claimGraceMs: HOST_CLAIM_GRACE_MS,
      },
    );
    assert(
      earlyReport === null,
      "on-deck contestant was reported unavailable before its lease expired",
    );
    const hostLossReport = await waitForExpiredHostLeaseReport(
      preparationStore,
      preparationId,
    );
    assert(
      hostLossReport.preparationId === preparationId &&
        hostLossReport.agentId === characterId &&
        hostLossReport.reason === "agent_unavailable" &&
        hostLossReport.reportedAt >= Number(disconnectedLease.expiresAt),
      "durable on-deck host-loss report diverged from the disconnected contestant",
      hostLossReport,
    );
    assert(
      (await preparationStore.freeze({
        preparationId,
        fencingToken: preparationFencingToken,
      })) === null,
      "host-lost private preparation unexpectedly froze",
    );
    const cancelledPreparation = await preparationStore.cancel({
      preparationId,
      fencingToken: preparationFencingToken,
      reason: "agent_preparation_failed",
    });
    assert(
      cancelledPreparation?.status === "cancelled" &&
        cancelledPreparation.cancellationReason === "agent_preparation_failed",
      "host-lost private preparation did not cancel behind durable authority",
    );
    const terminalGraph = await verificationPool.query<{
      hostLeaseCount: string;
      reportCount: string;
      snapshotCount: string;
    }>(
      `SELECT
         (SELECT count(*)::text
            FROM streaming_duel_preparation_agent_host_leases
           WHERE "preparationId" = $1) AS "hostLeaseCount",
         (SELECT count(*)::text
            FROM streaming_duel_preparation_unavailability_reports
           WHERE "preparationId" = $1) AS "reportCount",
         (SELECT count(*)::text
            FROM streaming_duel_competitive_snapshots
           WHERE "preparationId" = $1) AS "snapshotCount"`,
      [preparationId],
    );
    assert(
      terminalGraph.rows[0]?.hostLeaseCount === "2" &&
        terminalGraph.rows[0]?.reportCount === "1" &&
        terminalGraph.rows[0]?.snapshotCount === "0",
      "on-deck host-loss graph created duplicate reports or competitive authority",
      terminalGraph.rows[0],
    );

    await service.connect(socketUrl);
    await waitFor(() => {
      network.flush();
      return (
        serviceInternals.connectionState.connected === true &&
        [...network.sockets.values()].some(
          (candidate) => candidate.accountId === accountId && candidate.player,
        ) &&
        serviceInternals.duelPreparationHostLease === null
      );
    }, "reported contestant reconnect did not revoke stale on-deck authority");
    assert(
      hostLeaseActivations.length === 2,
      "reported contestant reconnect reactivated terminal preparation authority",
    );
    onDeckEvidence = {
      preparationId,
      contestantCount: 2,
      credentialSessionCount: 2,
      hostLeaseCount: Number(terminalGraph.rows[0].hostLeaseCount),
      activationCount: hostLeaseActivations.length,
      uniqueHostOwnerCount: new Set(activeHostLeases.map((row) => row.ownerId))
        .size,
      sharedPluginProcessIdentityPreserved: true,
      disconnectedAgentId: hostLossReport.agentId,
      reportReason: hostLossReport.reason,
      reportCount: Number(terminalGraph.rows[0].reportCount),
      snapshotCount: Number(terminalGraph.rows[0].snapshotCount),
      terminalStatus: cancelledPreparation.status,
      staleAuthorityRevokedAfterReconnect: true,
    };
    trace("on-deck host loss remained fail-closed across reconnect");

    await service.disconnect();
    await survivorService.disconnect();
    await waitFor(() => {
      network.flush();
      return ![...network.sockets.values()].some(
        (candidate) =>
          candidate.accountId === accountId ||
          candidate.accountId === survivorAccountId,
      );
    }, "authenticated services did not disconnect before revocation");
    trace("authenticated services disconnected before revocation");

    const processPreparation = await preparationStore.create({
      preparationId: processPreparationId,
      fencingToken: processPreparationFencingToken,
      agent1Id: characterId,
      agent2Id: survivorCharacterId,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: preparationModule.DUEL_PREPARATION_BANK_ACTIONS,
    });
    killedHost = spawnPluginHost({
      socketUrl,
      authToken,
      characterId,
      pluginRuntime,
    });
    survivingHost = spawnPluginHost({
      socketUrl,
      authToken: survivorAuthToken,
      characterId: survivorCharacterId,
      pluginRuntime,
    });
    const [killedTransport, survivingTransport] = await Promise.all([
      killedHost.waitFor(
        (event) => event.type === "transport_ready",
        15_000,
        "kill-target authenticated process transport",
      ),
      survivingHost.waitFor(
        (event) => event.type === "transport_ready",
        15_000,
        "surviving authenticated process transport",
      ),
    ]);
    assert(
      killedTransport.characterId === characterId &&
        survivingTransport.characterId === survivorCharacterId &&
        killedTransport.pluginRuntime === "built" &&
        survivingTransport.pluginRuntime === "built" &&
        killedTransport.credentialInUrl === false &&
        survivingTransport.credentialInUrl === false &&
        Number.isSafeInteger(killedTransport.pid) &&
        Number.isSafeInteger(survivingTransport.pid) &&
        killedTransport.pid !== survivingTransport.pid,
      "separate built agent processes did not preserve exact authenticated identity",
    );
    await waitFor(
      () => {
        network.flush();
        const sockets = [...network.sockets.values()];
        return (
          sockets.some(
            (candidate) =>
              candidate.accountId === accountId &&
              candidate.player?.id === characterId,
          ) &&
          sockets.some(
            (candidate) =>
              candidate.accountId === survivorAccountId &&
              candidate.player?.id === survivorCharacterId,
          )
        );
      },
      "separate authenticated agent processes did not enter the world",
      30_000,
    );
    const processPrimarySocket = [...network.sockets.values()].find(
      (candidate) =>
        candidate.accountId === accountId &&
        candidate.player?.id === characterId,
    );
    const processSurvivorSocket = [...network.sockets.values()].find(
      (candidate) =>
        candidate.accountId === survivorAccountId &&
        candidate.player?.id === survivorCharacterId,
    );
    assert(
      processPrimarySocket && processSurvivorSocket,
      "separate process contestant sockets are missing",
    );
    processPrimarySocket.send("duelOnDeck", {
      preparationId: processPreparationId,
      selectedAt: processPreparation.selectedAt,
      expiresAt: processPreparation.expiresAt,
      opponentId: survivorCharacterId,
      opponentName: "Production Auth Survivor",
    });
    processSurvivorSocket.send("duelOnDeck", {
      preparationId: processPreparationId,
      selectedAt: processPreparation.selectedAt,
      expiresAt: processPreparation.expiresAt,
      opponentId: characterId,
      opponentName: "Production Auth Agent",
    });

    await Promise.all([
      killedHost.waitFor(
        (event) =>
          event.type === "duel_on_deck" &&
          (event.data as { preparationId?: unknown } | null)?.preparationId ===
            processPreparationId,
        10_000,
        "kill-target lease-gated on-deck announcement",
      ),
      survivingHost.waitFor(
        (event) =>
          event.type === "duel_on_deck" &&
          (event.data as { preparationId?: unknown } | null)?.preparationId ===
            processPreparationId,
        10_000,
        "survivor lease-gated on-deck announcement",
      ),
    ]);
    let processHostLeases: HostLeaseRow[] = [];
    await waitFor(async () => {
      network.flush();
      const rows = await verificationPool!.query<HostLeaseRow>(
        `SELECT "agentId", "ownerId", "executableBuildId",
                "claimedAt"::text AS "claimedAt",
                "heartbeatAt"::text AS "heartbeatAt",
                "expiresAt"::text AS "expiresAt"
           FROM streaming_duel_preparation_agent_host_leases
          WHERE "preparationId" = $1
          ORDER BY "agentId"`,
        [processPreparationId],
      );
      processHostLeases = rows.rows;
      return (
        rows.rows.length === 2 &&
        rows.rows.every(
          (row) =>
            row.executableBuildId === externalBuildIdentity.buildId &&
            Number(row.heartbeatAt) >= Number(row.claimedAt) &&
            Number(row.expiresAt) > Number(row.heartbeatAt),
        ) &&
        hostLeaseActivations.filter(
          (activation) => activation.preparationId === processPreparationId,
        ).length === 2
      );
    }, "separate agent processes did not claim exact host leases");
    assert(
      new Set(processHostLeases.map((row) => row.ownerId)).size === 2,
      "separate agent processes did not present distinct host identities",
    );

    assert(
      killedHost.child.kill("SIGKILL"),
      "could not SIGKILL the authenticated on-deck agent process",
    );
    const killedHostExit = await waitForChildExit(
      killedHost,
      5_000,
      "authenticated on-deck agent SIGKILL",
    );
    assert(
      killedHostExit.signal === "SIGKILL",
      "authenticated on-deck agent did not exit by SIGKILL",
      killedHostExit,
    );
    await waitFor(() => {
      network.flush();
      return (
        ![...network.sockets.values()].some(
          (candidate) => candidate.accountId === accountId,
        ) &&
        [...network.sockets.values()].some(
          (candidate) =>
            candidate.accountId === survivorAccountId && candidate.player,
        )
      );
    }, "agent-process SIGKILL did not preserve only the surviving contestant");
    const killedLeaseRows = await verificationPool.query<HostLeaseRow>(
      `SELECT "agentId", "ownerId", "executableBuildId",
                "claimedAt"::text AS "claimedAt",
                "heartbeatAt"::text AS "heartbeatAt",
                "expiresAt"::text AS "expiresAt"
           FROM streaming_duel_preparation_agent_host_leases
          WHERE "preparationId" = $1 AND "agentId" = $2`,
      [processPreparationId, characterId],
    );
    const killedProcessLease = killedLeaseRows.rows[0];
    assert(killedProcessLease, "SIGKILL target lease is missing");
    const processEarlyReport =
      await preparationStore.reportExpiredContestantHostLease({
        preparationId: processPreparationId,
        claimGraceMs: HOST_CLAIM_GRACE_MS,
      });
    assert(
      processEarlyReport === null,
      "SIGKILL target was reported unavailable before lease expiry",
    );
    const processHostLossReport = await waitForExpiredHostLeaseReport(
      preparationStore,
      processPreparationId,
    );
    assert(
      processHostLossReport.agentId === characterId &&
        processHostLossReport.reason === "agent_unavailable" &&
        processHostLossReport.reportedAt >=
          Number(killedProcessLease.expiresAt),
      "SIGKILL host-loss report diverged from database-clock lease authority",
      processHostLossReport,
    );
    assert(
      (await preparationStore.freeze({
        preparationId: processPreparationId,
        fencingToken: processPreparationFencingToken,
      })) === null,
      "SIGKILL host-lost preparation unexpectedly froze",
    );
    const processCancelled = await preparationStore.cancel({
      preparationId: processPreparationId,
      fencingToken: processPreparationFencingToken,
      reason: "agent_preparation_failed",
    });
    assert(
      processCancelled?.status === "cancelled",
      "SIGKILL host-lost preparation did not cancel",
    );
    const processTerminalGraph = await verificationPool.query<{
      hostLeaseCount: string;
      reportCount: string;
      snapshotCount: string;
    }>(
      `SELECT
         (SELECT count(*)::text
            FROM streaming_duel_preparation_agent_host_leases
           WHERE "preparationId" = $1) AS "hostLeaseCount",
         (SELECT count(*)::text
            FROM streaming_duel_preparation_unavailability_reports
           WHERE "preparationId" = $1) AS "reportCount",
         (SELECT count(*)::text
            FROM streaming_duel_competitive_snapshots
           WHERE "preparationId" = $1) AS "snapshotCount"`,
      [processPreparationId],
    );
    assert(
      processTerminalGraph.rows[0]?.hostLeaseCount === "2" &&
        processTerminalGraph.rows[0]?.reportCount === "1" &&
        processTerminalGraph.rows[0]?.snapshotCount === "0",
      "SIGKILL terminal preparation graph diverged",
      processTerminalGraph.rows[0],
    );

    replacementHost = spawnPluginHost({
      socketUrl,
      authToken,
      characterId,
      pluginRuntime,
    });
    const replacementTransport = await replacementHost.waitFor(
      (event) => event.type === "transport_ready",
      15_000,
      "replacement authenticated process transport",
    );
    assert(
      Number.isSafeInteger(replacementTransport.pid) &&
        replacementTransport.pid !== killedTransport.pid,
      "replacement agent process did not present a fresh OS identity",
    );
    await waitFor(() => {
      network.flush();
      return [...network.sockets.values()].some(
        (candidate) =>
          candidate.accountId === accountId &&
          candidate.player?.id === characterId,
      );
    }, "replacement authenticated process did not enter the world");
    const replacementSocket = [...network.sockets.values()].find(
      (candidate) =>
        candidate.accountId === accountId &&
        candidate.player?.id === characterId,
    );
    assert(replacementSocket, "replacement authenticated socket is missing");
    replacementSocket.send("duelOnDeck", {
      preparationId: processPreparationId,
      selectedAt: processPreparation.selectedAt,
      expiresAt: processPreparation.expiresAt,
      opponentId: survivorCharacterId,
      opponentName: "Production Auth Survivor",
    });
    await delay(HOST_HEARTBEAT_MS + 500);
    const killedLeaseAfterReplacement = await verificationPool.query<{
      ownerId: string;
    }>(
      `SELECT "ownerId"
           FROM streaming_duel_preparation_agent_host_leases
          WHERE "preparationId" = $1 AND "agentId" = $2`,
      [processPreparationId, characterId],
    );
    assert(
      killedLeaseAfterReplacement.rows[0]?.ownerId ===
        killedProcessLease.ownerId &&
        !replacementHost.events.some(
          (event) => event.type === "duel_on_deck",
        ) &&
        hostLeaseActivations.filter(
          (activation) => activation.preparationId === processPreparationId,
        ).length === 2,
      "replacement process revived or announced terminal on-deck authority",
    );
    await killOwnedChild(replacementHost);
    await killOwnedChild(survivingHost);
    await waitFor(() => {
      network.flush();
      return ![...network.sockets.values()].some(
        (candidate) =>
          candidate.accountId === accountId ||
          candidate.accountId === survivorAccountId,
      );
    }, "owned agent-host processes did not detach before revocation");
    assert(onDeckEvidence, "socket-loss on-deck evidence is missing");
    onDeckEvidence.separateHostProcessKill = {
      preparationId: processPreparationId,
      killedPid: killedTransport.pid,
      survivorPid: survivingTransport.pid,
      replacementPid: replacementTransport.pid,
      distinctHostOwnerCount: new Set(
        processHostLeases.map((row) => row.ownerId),
      ).size,
      killedSignal: killedHostExit.signal,
      survivingTransportRetained: true,
      reportReason: processHostLossReport.reason,
      reportCount: Number(processTerminalGraph.rows[0].reportCount),
      snapshotCount: Number(processTerminalGraph.rows[0].snapshotCount),
      terminalStatus: processCancelled.status,
      replacementAuthorityRejected: true,
    };
    trace("separate authenticated host-process SIGKILL remained fail-closed");

    const stalledPreparation = await preparationStore.create({
      preparationId: stalledProcessPreparationId,
      fencingToken: stalledProcessPreparationFencingToken,
      agent1Id: characterId,
      agent2Id: survivorCharacterId,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: preparationModule.DUEL_PREPARATION_BANK_ACTIONS,
    });
    stalledHost = spawnPluginHost({
      socketUrl,
      authToken,
      characterId,
      pluginRuntime,
      modelMode: "hang",
    });
    stalledPeerHost = spawnPluginHost({
      socketUrl,
      authToken: survivorAuthToken,
      characterId: survivorCharacterId,
      pluginRuntime,
      modelMode: "valid",
    });
    const [stalledTransport, stalledPeerTransport] = await Promise.all([
      stalledHost.waitFor(
        (event) => event.type === "transport_ready",
        15_000,
        "stall-target authenticated process transport",
      ),
      stalledPeerHost.waitFor(
        (event) => event.type === "transport_ready",
        15_000,
        "stall-peer authenticated process transport",
      ),
    ]);
    assert(
      stalledTransport.characterId === characterId &&
        stalledPeerTransport.characterId === survivorCharacterId &&
        stalledTransport.pluginRuntime === "built" &&
        stalledPeerTransport.pluginRuntime === "built" &&
        stalledTransport.modelMode === "hang" &&
        stalledPeerTransport.modelMode === "valid" &&
        Number.isSafeInteger(stalledTransport.pid) &&
        Number.isSafeInteger(stalledPeerTransport.pid) &&
        stalledTransport.pid !== stalledPeerTransport.pid,
      "stalled-host pair did not preserve separate built process identity",
    );
    await waitFor(
      () => {
        network.flush();
        const sockets = [...network.sockets.values()];
        return (
          sockets.some(
            (candidate) =>
              candidate.accountId === accountId &&
              candidate.player?.id === characterId,
          ) &&
          sockets.some(
            (candidate) =>
              candidate.accountId === survivorAccountId &&
              candidate.player?.id === survivorCharacterId,
          )
        );
      },
      "stalled-host pair did not enter the world",
      30_000,
    );
    const stalledSocket = [...network.sockets.values()].find(
      (candidate) =>
        candidate.accountId === accountId &&
        candidate.player?.id === characterId,
    );
    const stalledPeerSocket = [...network.sockets.values()].find(
      (candidate) =>
        candidate.accountId === survivorAccountId &&
        candidate.player?.id === survivorCharacterId,
    );
    assert(
      stalledSocket && stalledPeerSocket,
      "stalled-host contestant sockets are missing",
    );
    stalledSocket.send("duelOnDeck", {
      preparationId: stalledProcessPreparationId,
      selectedAt: stalledPreparation.selectedAt,
      expiresAt: stalledPreparation.expiresAt,
      opponentId: survivorCharacterId,
      opponentName: "Production Auth Survivor",
    });
    stalledPeerSocket.send("duelOnDeck", {
      preparationId: stalledProcessPreparationId,
      selectedAt: stalledPreparation.selectedAt,
      expiresAt: stalledPreparation.expiresAt,
      opponentId: characterId,
      opponentName: "Production Auth Agent",
    });
    await Promise.all([
      stalledHost.waitFor(
        (event) =>
          event.type === "duel_on_deck" &&
          (event.data as { preparationId?: unknown } | null)?.preparationId ===
            stalledProcessPreparationId,
        10_000,
        "stall-target lease-gated on-deck announcement",
      ),
      stalledPeerHost.waitFor(
        (event) =>
          event.type === "duel_on_deck" &&
          (event.data as { preparationId?: unknown } | null)?.preparationId ===
            stalledProcessPreparationId,
        10_000,
        "stall-peer lease-gated on-deck announcement",
      ),
    ]);

    const hungStrategyRequest = createProviderStrategyRequest({
      preparationId: stalledProcessPreparationId,
      expiresAt: stalledPreparation.expiresAt,
      agentName: "Production Auth Agent",
      opponentName: "Production Auth Survivor",
    });
    const hungStrategyRequestId = String(hungStrategyRequest.requestId);
    const hungStrategyDeadlineAt = Number(
      hungStrategyRequest.decisionDeadlineAt,
    );
    const serializedHungStrategyRequest = JSON.stringify(hungStrategyRequest);
    assert(
      !/itemId|bank|inventory|wallet|prompt|modelOutput/u.test(
        serializedHungStrategyRequest,
      ),
      "hung-provider request leaked private preparation authority",
    );
    const hungStrategySentAt = Date.now();
    stalledSocket.send("duelPreparationStrategy", hungStrategyRequest);
    const hungModelRequest = await stalledHost.waitFor(
      (event) => event.type === "model_requested" && event.modelMode === "hang",
      5_000,
      "hung ElizaOS provider invocation",
    );
    assert(
      hungModelRequest.characterId === characterId,
      "hung model invocation used the wrong authenticated contestant",
    );
    await waitFor(
      () => {
        network.flush();
        return externalStrategyResponses.some(
          (response) => response.requestId === hungStrategyRequestId,
        );
      },
      "hung ElizaOS provider did not return a bounded fallback",
      5_000,
    );
    const hungStrategyResponse = externalStrategyResponses.find(
      (response) => response.requestId === hungStrategyRequestId,
    );
    assert(
      hungStrategyResponse?.agentId === characterId &&
        hungStrategyResponse.preparationId === stalledProcessPreparationId &&
        hungStrategyResponse.status === "fallback" &&
        hungStrategyResponse.decision === null &&
        hungStrategyResponse.receivedAt - hungStrategySentAt >= 2_000 &&
        hungStrategyResponse.receivedAt <= hungStrategyDeadlineAt,
      "hung ElizaOS provider fallback escaped its identity or deadline bounds",
      {
        hungStrategySentAt,
        hungStrategyDeadlineAt,
        hungStrategyResponse,
      },
    );
    await delay(250);
    assert(
      stalledHost.events.filter((event) => event.type === "model_requested")
        .length === 1 &&
        externalStrategyResponses.filter(
          (response) => response.requestId === hungStrategyRequestId,
        ).length === 1,
      "hung provider invoked or answered the semantic strategy request more than once",
    );

    const selectedStrategyRequest = createProviderStrategyRequest({
      preparationId: stalledProcessPreparationId,
      expiresAt: stalledPreparation.expiresAt,
      agentName: "Production Auth Survivor",
      opponentName: "Production Auth Agent",
    });
    const selectedStrategyRequestId = String(selectedStrategyRequest.requestId);
    const selectedStrategyDeadlineAt = Number(
      selectedStrategyRequest.decisionDeadlineAt,
    );
    assert(
      !/itemId|bank|inventory|wallet|prompt|modelOutput/u.test(
        JSON.stringify(selectedStrategyRequest),
      ),
      "selected-provider request leaked private preparation authority",
    );
    const selectedStrategySentAt = Date.now();
    stalledPeerSocket.send("duelPreparationStrategy", selectedStrategyRequest);
    const selectedModelRequest = await stalledPeerHost.waitFor(
      (event) =>
        event.type === "model_requested" && event.modelMode === "valid",
      5_000,
      "valid ElizaOS provider invocation",
    );
    assert(
      selectedModelRequest.characterId === survivorCharacterId,
      "valid model invocation used the wrong authenticated contestant",
    );
    await waitFor(
      () => {
        network.flush();
        return externalStrategyResponses.some(
          (response) => response.requestId === selectedStrategyRequestId,
        );
      },
      "valid ElizaOS provider did not return its bounded selection",
      5_000,
    );
    const selectedStrategyResponse = externalStrategyResponses.find(
      (response) => response.requestId === selectedStrategyRequestId,
    );
    assert(
      selectedStrategyResponse?.agentId === survivorCharacterId &&
        selectedStrategyResponse.preparationId ===
          stalledProcessPreparationId &&
        selectedStrategyResponse.status === "selected" &&
        isDeepStrictEqual(
          selectedStrategyResponse.decision,
          VALID_STRATEGY_DECISION,
        ) &&
        selectedStrategyResponse.receivedAt >= selectedStrategySentAt &&
        selectedStrategyResponse.receivedAt <= selectedStrategyDeadlineAt,
      "valid ElizaOS selection escaped its identity, allowlist, or deadline bounds",
      {
        selectedStrategySentAt,
        selectedStrategyDeadlineAt,
        selectedStrategyResponse,
      },
    );

    const selectedReplayRequestId = randomUUID();
    const selectedReplayRequest = {
      ...selectedStrategyRequest,
      requestId: selectedReplayRequestId,
      decisionDeadlineAt: Math.min(
        stalledPreparation.expiresAt - 100,
        Date.now() + 3_000,
      ),
    };
    stalledPeerSocket.send("duelPreparationStrategy", selectedReplayRequest);
    await waitFor(
      () => {
        network.flush();
        return externalStrategyResponses.some(
          (response) => response.requestId === selectedReplayRequestId,
        );
      },
      "semantic strategy replay did not return the cached selection",
      5_000,
    );
    const selectedReplayResponse = externalStrategyResponses.find(
      (response) => response.requestId === selectedReplayRequestId,
    );
    await delay(100);
    assert(
      selectedReplayResponse?.agentId === survivorCharacterId &&
        selectedReplayResponse.preparationId === stalledProcessPreparationId &&
        selectedReplayResponse.status === "selected" &&
        isDeepStrictEqual(
          selectedReplayResponse.decision,
          VALID_STRATEGY_DECISION,
        ) &&
        stalledPeerHost.events.filter(
          (event) => event.type === "model_requested",
        ).length === 1 &&
        externalStrategyResponses.filter(
          (response) =>
            response.requestId === selectedStrategyRequestId ||
            response.requestId === selectedReplayRequestId,
        ).length === 2,
      "semantic strategy replay changed the decision or reinvoked the model",
      { selectedStrategyResponse, selectedReplayResponse },
    );

    const selectedDecision =
      selectedStrategyResponse.decision as typeof VALID_STRATEGY_DECISION;
    const selectedStrategyLatencyMs =
      selectedStrategyResponse.receivedAt - selectedStrategySentAt;
    const selectedPlanRecoveryEvidence = {
      primaryStyle: selectedDecision.primaryStyle,
      availableStyles: ["melee", "ranged"] as Array<"melee" | "ranged">,
      planningSource: "model" as const,
      planningPolicyVersion: "duel-preparation-role-v3",
      agentPolicyFingerprint: "ef".repeat(32),
      modelProvider: "external-elizaos",
      model: "authenticated-production-strategy-v5",
      tacticalStrategy: selectedDecision.tacticalStrategy,
      decisionOutcome: "model_selected" as const,
      decisionLatencyMs: selectedStrategyLatencyMs,
      selectedPlanOptionId: selectedDecision.planOptionId,
      selectedPlanStyleRank: 1,
      selectedFoodOptionId: selectedDecision.foodOptionId,
      selectedFoodRecoveryRank: 1,
      selectedArmorOptionId: selectedDecision.armorOptionId,
      selectedArmorOffenseRank: 1,
      selectedArmorFocusedDefenseRank: null,
      selectedArmorTotalDefenseRank: 1,
    };
    const expectedPrivateBank = [
      { itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 },
      { itemId: "bronze_arrow", quantity: 50, slot: 1, tabIndex: 0 },
      { itemId: "lobster", quantity: 3, slot: 2, tabIndex: 0 },
      { itemId: "wizard_robe_top", quantity: 1, slot: 3, tabIndex: 0 },
    ];
    const selectedPreparationBankId =
      agentBankingModule.getDuelPreparationBankId(stalledProcessPreparationId);
    const selectedPrivateBankOpen =
      await agentBankingModule.openAuthoritativeAgentBank({
        world: liveWorld as never,
        playerId: survivorCharacterId,
        bankId: selectedPreparationBankId,
        preparationId: stalledProcessPreparationId,
      });
    assert(
      selectedPrivateBankOpen.success &&
        selectedPrivateBankOpen.playerId === survivorCharacterId &&
        selectedPrivateBankOpen.bankId === selectedPreparationBankId &&
        isDeepStrictEqual(
          selectedPrivateBankOpen.bankItems,
          expectedPrivateBank,
        ),
      "authenticated selected contestant could not open its exact private preparation bank",
      selectedPrivateBankOpen,
    );

    const committedSelectedPlan = {
      bank: [
        {
          itemId: "bronze_longsword",
          quantity: 1,
          slot: 0,
          tabIndex: 0,
        },
        {
          itemId: "bronze_platebody",
          quantity: 1,
          slot: 1,
          tabIndex: 0,
        },
      ],
      inventory: [0, 1, 2, 3].map((slotIndex) => ({
        itemId: "lobster",
        quantity: 1,
        slotIndex,
        metadata: null,
      })),
      equipment: [
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
        { slotType: "body", itemId: "wizard_robe_top", quantity: 1 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ],
      selectedSpell: null,
    };
    type SelectedPlanReceipt = {
      ok: boolean;
      playerId: string;
      operationId: string;
      preparationId: string;
      requestFingerprint?: string;
      changed: boolean;
      replayed: boolean;
      committed?: typeof committedSelectedPlan;
      recoveryEvidence?: typeof selectedPlanRecoveryEvidence;
      reason?: string;
    };
    const equipmentSystem = liveWorld.getSystem("equipment") as
      | {
          commitOwnedDuelPreparationPlan?: (
            playerId: string,
            request: {
              operationId: string;
              preparationId: string;
              expectedBank: typeof expectedPrivateBank;
              committed: typeof committedSelectedPlan;
              recoveryEvidence: typeof selectedPlanRecoveryEvidence;
            },
          ) => Promise<SelectedPlanReceipt>;
          recoverOwnedDuelPreparationPlan?: (
            playerId: string,
            request: { operationId: string; preparationId: string },
          ) => Promise<SelectedPlanReceipt | null>;
          getPlayerEquipment(
            playerId: string,
          ):
            | Record<
                string,
                { itemId?: unknown; quantity?: unknown } | null | undefined
              >
            | undefined;
        }
      | undefined;
    const inventorySystem = liveWorld.getSystem("inventory") as
      | {
          getInventory(playerId: string):
            | {
                items: Array<{
                  itemId: unknown;
                  quantity: unknown;
                  slot: unknown;
                }>;
              }
            | undefined;
        }
      | undefined;
    assert(
      equipmentSystem?.commitOwnedDuelPreparationPlan &&
        equipmentSystem.recoverOwnedDuelPreparationPlan &&
        inventorySystem?.getInventory,
      "production live custody systems are unavailable",
    );
    const selectedWholePlanRequest = {
      operationId: selectedWholePlanOperationId,
      preparationId: stalledProcessPreparationId,
      expectedBank: expectedPrivateBank,
      committed: committedSelectedPlan,
      recoveryEvidence: selectedPlanRecoveryEvidence,
    };
    const selectedWholePlanReceipt =
      await equipmentSystem.commitOwnedDuelPreparationPlan(
        survivorCharacterId,
        selectedWholePlanRequest,
      );
    assert(
      selectedWholePlanReceipt.ok &&
        selectedWholePlanReceipt.changed &&
        !selectedWholePlanReceipt.replayed &&
        selectedWholePlanReceipt.playerId === survivorCharacterId &&
        selectedWholePlanReceipt.operationId === selectedWholePlanOperationId &&
        selectedWholePlanReceipt.preparationId ===
          stalledProcessPreparationId &&
        Boolean(selectedWholePlanReceipt.requestFingerprint) &&
        isDeepStrictEqual(
          selectedWholePlanReceipt.committed,
          committedSelectedPlan,
        ) &&
        isDeepStrictEqual(
          selectedWholePlanReceipt.recoveryEvidence,
          selectedPlanRecoveryEvidence,
        ),
      "authenticated selected strategy did not atomically commit its exact whole plan",
      selectedWholePlanReceipt,
    );
    const recoveredSelectedWholePlan =
      await equipmentSystem.recoverOwnedDuelPreparationPlan(
        survivorCharacterId,
        {
          operationId: selectedWholePlanOperationId,
          preparationId: stalledProcessPreparationId,
        },
      );
    assert(
      recoveredSelectedWholePlan?.ok &&
        !recoveredSelectedWholePlan.changed &&
        recoveredSelectedWholePlan.replayed &&
        recoveredSelectedWholePlan.requestFingerprint ===
          selectedWholePlanReceipt.requestFingerprint &&
        isDeepStrictEqual(
          recoveredSelectedWholePlan.committed,
          committedSelectedPlan,
        ) &&
        isDeepStrictEqual(
          recoveredSelectedWholePlan.recoveryEvidence,
          selectedPlanRecoveryEvidence,
        ),
      "authenticated whole-plan recovery was not an exact immutable replay",
      recoveredSelectedWholePlan,
    );

    const selectedReady = await preparationStore.markReady({
      preparationId: stalledProcessPreparationId,
      fencingToken: stalledProcessPreparationFencingToken,
      agentId: survivorCharacterId,
      planEvidence: selectedPlanRecoveryEvidence,
    });
    const selectedPublicReadinessEvidence = {
      primaryStyle: selectedPlanRecoveryEvidence.primaryStyle,
      availableStyles: selectedPlanRecoveryEvidence.availableStyles,
      planningSource: selectedPlanRecoveryEvidence.planningSource,
      planningPolicyVersion: selectedPlanRecoveryEvidence.planningPolicyVersion,
      agentPolicyFingerprint:
        selectedPlanRecoveryEvidence.agentPolicyFingerprint,
      modelProvider: selectedPlanRecoveryEvidence.modelProvider,
      model: selectedPlanRecoveryEvidence.model,
      tacticalStrategy: selectedPlanRecoveryEvidence.tacticalStrategy,
    };
    assert(
      selectedReady?.agent2ReadyAt !== null &&
        selectedReady?.agent2PlanEvidence &&
        isDeepStrictEqual(
          selectedReady.agent2PlanEvidence,
          selectedPublicReadinessEvidence,
        ) &&
        selectedReady.status === "preparing",
      "authenticated selected contestant readiness did not preserve the exact public plan projection",
      selectedReady,
    );

    const expectedCommittedInventory = [0, 1, 2, 3].map((slotIndex) => ({
      itemId: "lobster",
      quantity: 1,
      slotIndex,
    }));
    const expectedCommittedEquipment = [
      { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
      { slotType: "body", itemId: "wizard_robe_top", quantity: 1 },
      { slotType: "weapon", itemId: "shortbow", quantity: 1 },
    ];
    const expectedCommittedBank = committedSelectedPlan.bank;
    const readSelectedCommittedCustody = async () => {
      const [inventory, equipment, bank, edges] = await Promise.all([
        verificationPool!.query(
          `SELECT "itemId", quantity, "slotIndex"
             FROM inventory
            WHERE "playerId" = $1
            ORDER BY "slotIndex"`,
          [survivorCharacterId],
        ),
        verificationPool!.query(
          `SELECT "slotType", "itemId", quantity
             FROM equipment
            WHERE "playerId" = $1
            ORDER BY "slotType"`,
          [survivorCharacterId],
        ),
        verificationPool!.query(
          `SELECT "itemId", quantity, slot, "tabIndex"
             FROM bank_storage
            WHERE "playerId" = $1
            ORDER BY "tabIndex", slot`,
          [survivorCharacterId],
        ),
        verificationPool!.query<{
          bankOpenCount: string;
          operationCount: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM streaming_duel_bank_open_events
               WHERE "preparationId" = $1 AND "playerId" = $2)
               AS "bankOpenCount",
             (SELECT count(*)::text FROM operations_log
               WHERE id = $3 AND "playerId" = $2
                 AND "operationType" = 'duel_preparation_plan'
                 AND completed = true) AS "operationCount"`,
          [
            stalledProcessPreparationId,
            survivorCharacterId,
            selectedWholePlanOperationId,
          ],
        ),
      ]);
      return {
        inventory: inventory.rows,
        equipment: equipment.rows,
        bank: bank.rows,
        bankOpenCount: Number(edges.rows[0]?.bankOpenCount),
        operationCount: Number(edges.rows[0]?.operationCount),
      };
    };
    const assertSelectedCommittedCustody = (
      custody: Awaited<ReturnType<typeof readSelectedCommittedCustody>>,
      label: string,
    ): void => {
      assert(
        isDeepStrictEqual(custody.inventory, expectedCommittedInventory) &&
          isDeepStrictEqual(custody.equipment, expectedCommittedEquipment) &&
          isDeepStrictEqual(custody.bank, expectedCommittedBank) &&
          custody.bankOpenCount === 1 &&
          custody.operationCount === 1,
        label,
        custody,
      );
    };
    const selectedCustodyBeforeHostLoss = await readSelectedCommittedCustody();
    assertSelectedCommittedCustody(
      selectedCustodyBeforeHostLoss,
      "selected strategy custody diverged before host loss",
    );
    const readLiveSelectedCustody = () => {
      const inventory = inventorySystem
        .getInventory(survivorCharacterId)!
        .items.map((item) => ({
          itemId: String(item.itemId),
          quantity: Number(item.quantity),
          slotIndex: Number(item.slot),
        }))
        .sort((left, right) => left.slotIndex - right.slotIndex);
      const equipment = equipmentSystem.getPlayerEquipment(survivorCharacterId);
      return {
        inventory,
        equipment: ["arrows", "body", "weapon"].map((slotType) => ({
          slotType,
          itemId: String(equipment?.[slotType]?.itemId ?? ""),
          quantity: Number(equipment?.[slotType]?.quantity ?? 0),
        })),
      };
    };
    const assertLiveSelectedCustody = (
      custody: ReturnType<typeof readLiveSelectedCustody>,
      label: string,
    ): void => {
      assert(
        isDeepStrictEqual(custody.inventory, expectedCommittedInventory) &&
          isDeepStrictEqual(custody.equipment, expectedCommittedEquipment),
        label,
        custody,
      );
    };
    const liveSelectedCustodyBeforeHostLoss = readLiveSelectedCustody();
    assertLiveSelectedCustody(
      liveSelectedCustodyBeforeHostLoss,
      "live inventory/equipment did not synchronize to the committed selected plan",
    );
    trace(
      "authenticated selected strategy committed, synchronized, recovered, and reached readiness",
    );

    const readStallLeases = async (): Promise<HostLeaseRow[]> =>
      (
        await verificationPool!.query<HostLeaseRow>(
          `SELECT "agentId", "ownerId", "executableBuildId",
                  "claimedAt"::text AS "claimedAt",
                  "heartbeatAt"::text AS "heartbeatAt",
                  "expiresAt"::text AS "expiresAt"
             FROM streaming_duel_preparation_agent_host_leases
            WHERE "preparationId" = $1
            ORDER BY "agentId"`,
          [stalledProcessPreparationId],
        )
      ).rows;
    let stalledProcessLeases: HostLeaseRow[] = [];
    await waitFor(async () => {
      network.flush();
      stalledProcessLeases = await readStallLeases();
      return (
        stalledProcessLeases.length === 2 &&
        stalledProcessLeases.every(
          (row) => row.executableBuildId === externalBuildIdentity.buildId,
        ) &&
        hostLeaseActivations.filter(
          (activation) =>
            activation.preparationId === stalledProcessPreparationId,
        ).length === 2
      );
    }, "stalled-host pair did not claim exact host leases");
    assert(
      new Set(stalledProcessLeases.map((row) => row.ownerId)).size === 2,
      "stalled-host pair did not present distinct host identities",
    );
    const stalledLease = stalledProcessLeases.find(
      (row) => row.agentId === characterId,
    );
    assert(stalledLease, "stall-target host lease is missing");

    assert(
      stalledHost.child.kill("SIGSTOP"),
      "could not SIGSTOP the authenticated on-deck agent process",
    );
    await delay(100);
    network.flush();
    assert(
      stalledHost.exit() === null &&
        [...network.sockets.values()].some(
          (candidate) => candidate.accountId === accountId && candidate.player,
        ) &&
        [...network.sockets.values()].some(
          (candidate) =>
            candidate.accountId === survivorAccountId && candidate.player,
        ),
      "SIGSTOP did not preserve the half-open contestant transports",
    );
    const stallSampleA = await readStallLeases();
    await delay(HOST_HEARTBEAT_MS + 500);
    const stallSampleB = await readStallLeases();
    const stalledA = stallSampleA.find((row) => row.agentId === characterId);
    const stalledB = stallSampleB.find((row) => row.agentId === characterId);
    const peerA = stallSampleA.find(
      (row) => row.agentId === survivorCharacterId,
    );
    const peerB = stallSampleB.find(
      (row) => row.agentId === survivorCharacterId,
    );
    assert(
      stalledA &&
        stalledB &&
        peerA &&
        peerB &&
        stalledA.heartbeatAt === stalledB.heartbeatAt &&
        Number(peerB.heartbeatAt) > Number(peerA.heartbeatAt),
      "paused host heartbeat advanced or the live peer heartbeat stalled",
      { stallSampleA, stallSampleB },
    );
    const stallEarlyReport =
      await preparationStore.reportExpiredContestantHostLease({
        preparationId: stalledProcessPreparationId,
        claimGraceMs: HOST_CLAIM_GRACE_MS,
      });
    assert(
      stallEarlyReport === null,
      "stalled host was reported unavailable before lease expiry",
    );
    const stalledHostLossReport = await waitForExpiredHostLeaseReport(
      preparationStore,
      stalledProcessPreparationId,
    );
    assert(
      stalledHostLossReport.agentId === characterId &&
        stalledHostLossReport.reason === "agent_unavailable" &&
        stalledHostLossReport.reportedAt >= Number(stalledLease.expiresAt),
      "stalled-host report diverged from database-clock lease authority",
      stalledHostLossReport,
    );
    network.flush();
    assert(
      stalledHost.exit() === null &&
        [...network.sockets.values()].some(
          (candidate) => candidate.accountId === accountId,
        ) &&
        [...network.sockets.values()].some(
          (candidate) =>
            candidate.accountId === survivorAccountId && candidate.player,
        ),
      "stalled-host expiry relied on transport closure or lost the live peer",
    );
    assert(
      (await preparationStore.freeze({
        preparationId: stalledProcessPreparationId,
        fencingToken: stalledProcessPreparationFencingToken,
      })) === null,
      "stalled-host preparation unexpectedly froze",
    );
    const stalledPreparationCancelled = await preparationStore.cancel({
      preparationId: stalledProcessPreparationId,
      fencingToken: stalledProcessPreparationFencingToken,
      reason: "agent_preparation_failed",
    });
    assert(
      stalledPreparationCancelled?.status === "cancelled",
      "stalled-host preparation did not cancel",
    );
    const stalledTerminalGraph = await verificationPool.query<{
      hostLeaseCount: string;
      reportCount: string;
      snapshotCount: string;
    }>(
      `SELECT
         (SELECT count(*)::text
            FROM streaming_duel_preparation_agent_host_leases
           WHERE "preparationId" = $1) AS "hostLeaseCount",
         (SELECT count(*)::text
            FROM streaming_duel_preparation_unavailability_reports
           WHERE "preparationId" = $1) AS "reportCount",
         (SELECT count(*)::text
            FROM streaming_duel_competitive_snapshots
           WHERE "preparationId" = $1) AS "snapshotCount"`,
      [stalledProcessPreparationId],
    );
    assert(
      stalledTerminalGraph.rows[0]?.hostLeaseCount === "2" &&
        stalledTerminalGraph.rows[0]?.reportCount === "1" &&
        stalledTerminalGraph.rows[0]?.snapshotCount === "0",
      "stalled-host terminal preparation graph diverged",
      stalledTerminalGraph.rows[0],
    );

    assert(
      stalledHost.child.kill("SIGCONT"),
      "could not SIGCONT the stalled authenticated agent process",
    );
    const stalledRevocation = await stalledHost.waitFor(
      (event) =>
        event.type === "lease_revoked" &&
        (event.data as { preparationId?: unknown } | null)?.preparationId ===
          stalledProcessPreparationId,
      10_000,
      "resumed stalled-host lease revocation",
    );
    const stallLeaseAfterResume = await readStallLeases();
    assert(
      (stalledRevocation.data as { reason?: unknown } | null)?.reason ===
        "host_lease_inactive" &&
        stallLeaseAfterResume.find((row) => row.agentId === characterId)
          ?.ownerId === stalledLease.ownerId &&
        hostLeaseActivations.filter(
          (activation) =>
            activation.preparationId === stalledProcessPreparationId,
        ).length === 2 &&
        stalledHost.events.filter(
          (event) =>
            event.type === "duel_on_deck" &&
            (event.data as { preparationId?: unknown } | null)
              ?.preparationId === stalledProcessPreparationId,
        ).length === 1,
      "resumed stalled host revived or duplicated terminal preparation authority",
    );
    const selectedCustodyAfterHostLoss = await readSelectedCommittedCustody();
    assertSelectedCommittedCustody(
      selectedCustodyAfterHostLoss,
      "selected strategy custody changed after peer host loss and cancellation",
    );
    const liveSelectedCustodyAfterHostLoss = readLiveSelectedCustody();
    assertLiveSelectedCustody(
      liveSelectedCustodyAfterHostLoss,
      "live selected strategy custody changed after peer host loss and cancellation",
    );

    await killOwnedChild(stalledHost);
    await killOwnedChild(stalledPeerHost);
    await waitFor(() => {
      network.flush();
      return ![...network.sockets.values()].some(
        (candidate) =>
          candidate.accountId === accountId ||
          candidate.accountId === survivorAccountId,
      );
    }, "stalled-host pair did not detach before credential revocation");
    assert(onDeckEvidence, "socket-loss on-deck evidence is missing");
    onDeckEvidence.separateHostProcessStall = {
      preparationId: stalledProcessPreparationId,
      stalledPid: stalledTransport.pid,
      peerPid: stalledPeerTransport.pid,
      distinctHostOwnerCount: new Set(
        stalledProcessLeases.map((row) => row.ownerId),
      ).size,
      stalledSignal: "SIGSTOP",
      resumedSignal: "SIGCONT",
      stalledHeartbeatFrozen: true,
      peerHeartbeatContinued: true,
      halfOpenTransportsRetained: true,
      reportReason: stalledHostLossReport.reason,
      reportCount: Number(stalledTerminalGraph.rows[0].reportCount),
      snapshotCount: Number(stalledTerminalGraph.rows[0].snapshotCount),
      terminalStatus: stalledPreparationCancelled.status,
      resumedAuthorityRevoked: true,
      hungProviderFallback: {
        requestId: hungStrategyRequestId,
        modelMode: "hang",
        invocationCount: 1,
        responseCount: 1,
        status: hungStrategyResponse.status,
        decision: hungStrategyResponse.decision,
        latencyMs: hungStrategyResponse.receivedAt - hungStrategySentAt,
        deadlineAt: hungStrategyDeadlineAt,
        receivedAt: hungStrategyResponse.receivedAt,
        privateAuthorityAbsent: true,
      },
      selectedProviderDecision: {
        requestId: selectedStrategyRequestId,
        replayRequestId: selectedReplayRequestId,
        modelMode: "valid",
        invocationCount: 1,
        responseCount: 2,
        status: selectedStrategyResponse.status,
        decision: selectedStrategyResponse.decision,
        latencyMs: selectedStrategyResponse.receivedAt - selectedStrategySentAt,
        deadlineAt: selectedStrategyDeadlineAt,
        receivedAt: selectedStrategyResponse.receivedAt,
        semanticReplayExact: true,
        privateAuthorityAbsent: true,
      },
      authenticatedSelectedWholePlan: {
        operationId: selectedWholePlanOperationId,
        bankId: selectedPreparationBankId,
        bankOpenCount: selectedCustodyAfterHostLoss.bankOpenCount,
        operationCount: selectedCustodyAfterHostLoss.operationCount,
        committed: !selectedWholePlanReceipt.replayed,
        recoveredExactly: recoveredSelectedWholePlan.replayed,
        liveCustodySynchronized: true,
        readinessCommitted: selectedReady.agent2ReadyAt !== null,
        privateDecisionReceiptExcludedFromPublicReadiness: true,
        custodyStableAfterPeerLoss: isDeepStrictEqual(
          selectedCustodyAfterHostLoss,
          selectedCustodyBeforeHostLoss,
        ),
        liveCustodyStableAfterPeerLoss: isDeepStrictEqual(
          liveSelectedCustodyAfterHostLoss,
          liveSelectedCustodyBeforeHostLoss,
        ),
        selectedWeaponId: "shortbow",
        selectedAmmunitionId: "bronze_arrow",
        selectedArmorBodyId: "wizard_robe_top",
        selectedFoodItemId: "lobster",
        privateItemIdsSentToPlugin: false,
      },
    };
    trace("separate authenticated host-process stall remained fail-closed");

    const revokedAt = new Date();
    await verificationPool.query(
      `UPDATE agent_credential_sessions
          SET revoked_at = $2, revoked_reason = 'security_revoked'
        WHERE session_id = $1`,
      [sessionId, revokedAt],
    );
    const revokedRow = await verificationPool.query<{
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>(
      `SELECT revoked_at, revoked_reason
         FROM agent_credential_sessions
        WHERE session_id = $1`,
      [sessionId],
    );
    assert(
      revokedRow.rows[0]?.revoked_at instanceof Date &&
        revokedRow.rows[0]?.revoked_reason === "security_revoked",
      "credential session revocation was not durable",
    );

    revokedService = new pluginModule.HyperiaService(runtime as never);
    revokedService.setAuthToken(authToken);
    revokedService.setAutonomousBehaviorEnabled(false);
    const revokedInternals = revokedService as unknown as ServiceInternals;
    revokedInternals.characterId = characterId;
    revokedInternals.autoReconnect = false;
    let revokedCredentialRejected = false;
    try {
      await revokedService.connect(socketUrl);
    } catch (error) {
      revokedCredentialRejected = /Authentication failed/u.test(String(error));
    }
    assert(
      revokedCredentialRejected,
      "revoked credential unexpectedly authenticated",
    );
    trace("revoked credential was rejected");
    await waitFor(() => {
      network.flush();
      return ![...network.sockets.values()].some(
        (candidate) => candidate.agentCredentialSessionId === sessionId,
      );
    }, "revoked credential left an authenticated socket registered");

    const sessionRows = await verificationPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_credential_sessions
        WHERE session_id = $1 AND account_id = $2 AND character_id = $3`,
      [sessionId, accountId, characterId],
    );
    assert(
      Number(sessionRows.rows[0]?.count) === 1,
      "credential authority row count diverged",
    );
    assert(onDeckEvidence, "on-deck disconnect evidence is missing");

    report = {
      status: "passed",
      pluginRuntime,
      runtime: {
        nodeEnv: process.env.NODE_ENV,
        postgres: "16-alpine owned temporary container",
        jwtAuthority: "key-ring",
      },
      assertions: {
        actualWebSocket: true,
        actualMsgpack: true,
        firstMessageAuthentication: true,
        credentialAbsentFromUrl: true,
        keyedJwtSignatureVerified: true,
        migratedPostgresSessionVerified: true,
        productionDrizzleAdapter: true,
        serverNetworkLifecycle: true,
        exactCharacterBoundToSocket: true,
        crossAccountCharacterRejected: true,
        credentialBoundPlayerMarkedAgent: true,
        clientReadyCompleted: true,
        retainedEntityReconnected: true,
        reconnectAgentIdentityPreserved: true,
        singleWorldEntryPerConnection: true,
        twoAuthenticatedOnDeckContestants: true,
        exactExecutableBuildLeases: true,
        onDeckDisconnectReportedDurably: true,
        separateAuthenticatedHostProcesses: true,
        onDeckProcessSigkillReportedDurably: true,
        onDeckProcessStallReportedDurably: true,
        stalledPeerHeartbeatContinued: true,
        resumedStaleHostAuthorityRevoked: true,
        hungElizaOsProviderBoundedFallback: true,
        hungProviderSingleInvocation: true,
        hungProviderPrivateAuthorityAbsent: true,
        productionAuthenticatedSelectedStrategy: true,
        selectedStrategySemanticReplayExact: true,
        selectedProviderSingleInvocation: true,
        selectedProviderPrivateAuthorityAbsent: true,
        authenticatedPrivatePreparationBankOpened: true,
        authenticatedSelectedWholePlanCommitted: true,
        authenticatedSelectedWholePlanRecoveredExactly: true,
        authenticatedSelectedWholePlanLiveStateSynchronized: true,
        authenticatedSelectedWholePlanReadinessCommitted: true,
        authenticatedSelectedReadinessPrivateDecisionExcluded: true,
        authenticatedSelectedWholePlanStableAfterPeerLoss: true,
        replacementHostAuthorityRejected: true,
        marketAuthorityBlockedAfterHostLoss: true,
        staleOnDeckAuthorityRevokedAfterReconnect: true,
        revokedCredentialRejected: true,
        externalValue: false,
        productionEquivalentInfrastructure: false,
      },
      onDeckDisconnect: onDeckEvidence,
    };
  } finally {
    trace("cleanup started");
    await killOwnedChild(replacementHost);
    await killOwnedChild(survivingHost);
    await killOwnedChild(killedHost);
    await killOwnedChild(stalledPeerHost);
    await killOwnedChild(stalledHost);
    await settleWithin("revoked service disconnect", async () => {
      await revokedService?.disconnect();
    });
    await settleWithin("service disconnect", async () => {
      await service?.disconnect();
    });
    await settleWithin("survivor service disconnect", async () => {
      await survivorService?.disconnect();
    });
    await settleWithin("WebSocket server close", async () => {
      await closeServer(server, serverTransportSockets);
    });
    await settleWithin("pending database operations", async () => {
      await databaseSystem?.waitForPendingOperations();
    });
    world?.destroy?.();
    await settleWithin("application database close", async () => {
      await closeDatabase?.();
    });
    await settleWithin("verification database close", async () => {
      await verificationPool?.end();
    });
    if (containerStarted) {
      await docker(["rm", "-f", CONTAINER_NAME]);
      containerStarted = false;
    }
    trace("cleanup completed");
    process.chdir(originalCwd);
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
  }

  assert(report, "production agent WebSocket authentication evidence missing");
  const webSocketListenerClosed = server === null || server.address() === null;
  assert(
    webSocketListenerClosed && serverTransportSockets.size === 0,
    "owned WebSocket listener or transport sockets survived cleanup",
  );
  report.cleanup = {
    ownedTemporaryContainerRemoved: !containerStarted,
    webSocketListenerClosed,
    transportSocketCount: serverTransportSockets.size,
    externalServicesTouched: false,
  };
  originalConsoleLog(JSON.stringify(report));
  // The real server world intentionally owns long-lived scheduler handles. This
  // executable has completed and cleaned every resource it created, so terminate
  // its isolated process instead of allowing framework background timers to keep
  // the CI job open indefinitely.
  process.exit(0);
}

if (process.env[CHILD_MODE_ENV] === "plugin-host") {
  await runPluginHostChild().catch((error) => {
    writeJsonEvent({
      type: "child_error",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
} else {
  await main();
}
