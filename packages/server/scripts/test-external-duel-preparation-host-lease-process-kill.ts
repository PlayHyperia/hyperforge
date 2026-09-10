import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  getPacketId,
  readPacket,
  writePacket,
  type ExternalDuelPreparationStrategyDecision,
  type ExternalDuelPreparationStrategyRequest,
  type ExternalDuelPreparationStrategyResponse,
  type World,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import WebSocket, {
  WebSocketServer,
  type RawData,
  type WebSocket as ServerWebSocket,
} from "ws";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import type {
  DuelPreparationPlanCommitRequest,
  DuelPreparationPlanRecoveryEvidence,
  ServerSocket,
} from "../src/shared/types/index.js";
import {
  getDuelPreparationBankId,
  openAuthoritativeAgentBank,
} from "../src/eliza/AuthoritativeAgentBanking.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../src/systems/StreamingDuelScheduler/competitive-tactical-strategy.js";
import {
  DUEL_PREPARATION_BANK_ACTIONS,
  PostgresDuelPreparationStore,
} from "../src/systems/StreamingDuelScheduler/preparation.js";
import { handleDuelPreparationHostLease } from "../src/systems/ServerNetwork/handlers/duel/preparation-host-lease.js";
import { handleDuelPreparationStrategy } from "../src/systems/ServerNetwork/handlers/duel/preparation-strategy.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DATABASE_URL_ENV =
  "EXTERNAL_DUEL_PREPARATION_HOST_LEASE_TEST_DATABASE_URL" as const;
const CHILD_MODE_ENV =
  "EXTERNAL_DUEL_PREPARATION_HOST_LEASE_CHILD_MODE" as const;
const SOCKET_URL_ENV =
  "EXTERNAL_DUEL_PREPARATION_HOST_LEASE_SOCKET_URL" as const;
const AGENT_ID_ENV = "EXTERNAL_DUEL_PREPARATION_HOST_LEASE_AGENT_ID" as const;
const PLUGIN_RUNTIME_ENV =
  "EXTERNAL_DUEL_PREPARATION_HOST_LEASE_PLUGIN_RUNTIME" as const;
const EXTERNAL_BUILD_ALLOWLIST_ENV =
  "DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS" as const;
const HOST_LEASE_MS_ENV = "DUEL_PREPARATION_AGENT_HOST_LEASE_MS" as const;
const HOST_HEARTBEAT_MS_ENV =
  "DUEL_PREPARATION_AGENT_HOST_HEARTBEAT_MS" as const;
const HOST_CLAIM_GRACE_MS_ENV =
  "DUEL_PREPARATION_AGENT_HOST_CLAIM_GRACE_MS" as const;
const TEST_HOST_LEASE_MS = 5_000;
const TEST_HOST_HEARTBEAT_MS = 1_000;
const TEST_HOST_CLAIM_GRACE_MS = 1_000;
const STRATEGY_PLAN_MELEE_ID = "11111111-1111-4111-8111-111111111111";
const STRATEGY_PLAN_RANGED_ID = "22222222-2222-4222-8222-222222222222";
const STRATEGY_FOOD_ID = "33333333-3333-4333-8333-333333333333";
const STRATEGY_ARMOR_MELEE_ID = "44444444-4444-4444-8444-444444444444";
const STRATEGY_ARMOR_RANGED_ID = "55555555-5555-4555-8555-555555555555";

const EXTERNAL_STRATEGY_DECISION: ExternalDuelPreparationStrategyDecision = {
  planOptionId: STRATEGY_PLAN_RANGED_ID,
  foodOptionId: STRATEGY_FOOD_ID,
  armorOptionId: STRATEGY_ARMOR_RANGED_ID,
  primaryStyle: "ranged",
  reason: "Use the owned ranged option and preserve distance.",
  tacticalStrategy: {
    approach: "balanced",
    tacticalMacro: "kite",
    attackStyle: "accurate",
    prayer: null,
    preferredCombatRole: "ranged",
    foodThreshold: 40,
    switchDefensiveAt: 30,
    reasoning: "Maintain legal distance and reassess from live authority.",
  },
};

type PluginRuntime = "source" | "built";

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
  waitFor: (
    predicate: (event: JsonEvent) => boolean,
    timeoutMs: number,
    label: string,
  ) => Promise<JsonEvent>;
};

type LeasePacket = {
  requestId: string;
  preparationId: string;
  ownerId: string;
  executableBuildId: string;
  action: "claim" | "heartbeat";
};

type LeaseResponse = {
  requestId: string;
  preparationId: string;
  action: "claim" | "heartbeat";
  status: "active" | "rejected" | "unavailable";
  heartbeatAfterMs: number;
};

type SocketRequestRecord = LeasePacket & { connectionId: number };
type SocketResponseRecord = LeaseResponse & { connectionId: number };
type SocketActivationRecord = {
  preparationId: string;
  agentId: string;
  ownerId: string;
  executableBuildId: string;
};
type SocketStrategyResponseRecord = ExternalDuelPreparationStrategyResponse & {
  connectionId: number;
};
type SocketStrategyActivationRecord =
  ExternalDuelPreparationStrategyResponse & {
    agentId: string;
  };

type SocketHost = {
  server: WebSocketServer;
  baseUrl: string;
  authenticatedUrl: string;
  connections: Array<{ id: number; socket: ServerWebSocket }>;
  requests: SocketRequestRecord[];
  responses: SocketResponseRecord[];
  activations: SocketActivationRecord[];
  strategyResponses: SocketStrategyResponseRecord[];
  strategyActivations: SocketStrategyActivationRecord[];
  errors: Error[];
};

const createStrategyRequest = (input: {
  requestId: string;
  preparationId: string;
  expiresAt: number;
}): ExternalDuelPreparationStrategyRequest => ({
  requestId: input.requestId,
  preparationId: input.preparationId,
  policyVersion: "duel-preparation-role-v3",
  protocolVersion: "external-duel-preparation-strategy-v5",
  expiresAt: input.expiresAt,
  decisionDeadlineAt: Math.min(input.expiresAt - 100, Date.now() + 5_000),
  agentName: "External Host Alpha",
  opponentName: "External Host Beta",
  ownPublicProfile: { narrative: "Adaptive fighter.", pillars: ["patient"] },
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
});

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const delay = async (durationMs: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
};

const writeJsonEvent = (event: JsonEvent): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const resolvePluginRuntime = (): PluginRuntime => {
  const value = process.env[PLUGIN_RUNTIME_ENV]?.trim() || "source";
  if (value !== "source" && value !== "built") {
    throw new Error(`${PLUGIN_RUNTIME_ENV} must be source or built`);
  }
  return value;
};

function planEvidence(agentId: string) {
  return {
    primaryStyle: "melee" as const,
    availableStyles: ["melee" as const],
    planningSource: "deterministic" as const,
    planningPolicyVersion: "external-host-lease-process-kill-v1",
    agentPolicyFingerprint: "ab".repeat(32),
    modelProvider: "process-kill-test",
    model: agentId,
    tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy("melee"),
  };
}

function externalStrategyPlanEvidence(
  decision: ExternalDuelPreparationStrategyDecision,
): DuelPreparationPlanRecoveryEvidence {
  return {
    primaryStyle: decision.primaryStyle,
    availableStyles: ["melee", "ranged"],
    planningSource: "model",
    planningPolicyVersion: "duel-preparation-role-v3",
    agentPolicyFingerprint: "cd".repeat(32),
    modelProvider: "external-elizaos",
    model: "authenticated-remote-strategy-v5",
    tacticalStrategy: decision.tacticalStrategy,
    decisionOutcome: "model_selected",
    decisionLatencyMs: 1,
    selectedPlanOptionId: decision.planOptionId,
    selectedPlanStyleRank: 1,
    selectedFoodOptionId: decision.foodOptionId,
    selectedFoodRecoveryRank: decision.foodOptionId ? 1 : null,
    selectedArmorOptionId: decision.armorOptionId,
    selectedArmorOffenseRank: 1,
    selectedArmorFocusedDefenseRank: null,
    selectedArmorTotalDefenseRank: 1,
  };
}

function externalWholePlanRequest(input: {
  operationId: string;
  preparationId: string;
  playerId: string;
  expectedBank: Array<{
    itemId: string;
    quantity: number;
    slot: number;
    tabIndex: number;
  }>;
  decision: ExternalDuelPreparationStrategyDecision;
}): DuelPreparationPlanCommitRequest {
  assert(
    input.decision.planOptionId === STRATEGY_PLAN_RANGED_ID &&
      input.decision.foodOptionId === STRATEGY_FOOD_ID &&
      input.decision.armorOptionId === STRATEGY_ARMOR_RANGED_ID &&
      input.decision.primaryStyle === "ranged",
    "external decision did not select the server-owned ranged plan",
  );
  return {
    operationId: input.operationId,
    preparationId: input.preparationId,
    playerId: input.playerId,
    requestFingerprint: "external-socket-selected-plan:ranged:v1",
    expected: {
      bank: input.expectedBank,
      inventory: [
        { itemId: "test_junk", quantity: 1, slotIndex: 0, metadata: null },
      ],
      equipment: [
        { slotType: "body", itemId: "bronze_platebody", quantity: 1 },
        { slotType: "weapon", itemId: "bronze_longsword", quantity: 1 },
      ],
      selectedSpell: null,
    },
    committed: {
      bank: [
        { itemId: "test_junk", quantity: 1, slot: 0, tabIndex: 0 },
        {
          itemId: "bronze_longsword",
          quantity: 1,
          slot: 1,
          tabIndex: 0,
        },
        {
          itemId: "bronze_platebody",
          quantity: 1,
          slot: 2,
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
    },
    recoveryEvidence: externalStrategyPlanEvidence(input.decision),
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

async function resolveDatabaseAuthority(): Promise<{
  databaseUrl: string;
  ownedContainerName: string | null;
}> {
  const configured = process.env[DATABASE_URL_ENV]?.trim();
  if (configured) {
    return { databaseUrl: configured, ownedContainerName: null };
  }

  await docker(["info", "--format", "{{.ServerVersion}}"]);
  const ownedContainerName = `hyperia-external-host-lease-${process.pid}`;
  const databaseUser = "external_host_lease_test";
  const databasePassword = `external-host-lease-${randomUUID()}`;
  const image =
    process.env.EXTERNAL_HOST_LEASE_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let started = false;
  try {
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      ownedContainerName,
      "-e",
      `POSTGRES_USER=${databaseUser}`,
      "-e",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "-p",
      "127.0.0.1::5432",
      image,
    ]);
    started = true;
    const port = Number(
      (await docker(["port", ownedContainerName, "5432/tcp"]))
        .split(":")
        .at(-1),
    );
    assert(
      Number.isSafeInteger(port) && port > 0,
      "owned PostgreSQL port missing",
    );
    const databaseUrl = `postgres://${databaseUser}:${databasePassword}@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const probe = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await probe.query("SELECT 1");
        await probe.end();
        return { databaseUrl, ownedContainerName };
      } catch {
        await probe.end().catch(() => undefined);
      }
      await delay(200);
    }
    throw new Error("owned PostgreSQL did not become ready within 30 seconds");
  } catch (error) {
    if (started) {
      await docker(["rm", "-f", ownedContainerName]).catch(() => undefined);
    }
    throw error;
  }
}

function createChildMonitor(child: ChildProcess): ChildMonitor {
  assert(child.stdout && child.stderr, "plugin host pipes are missing");
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
        // Runtime diagnostics can share stdout with the structured evidence.
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
            `${label}: plugin host exited code=${exit.code} signal=${exit.signal}: ${stderrTail}`,
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
  agentId: string;
  executableBuildId: string;
  pluginRuntime: PluginRuntime;
}): ChildMonitor {
  const child = spawn(process.execPath, [SCRIPT_PATH], {
    env: {
      ...process.env,
      NODE_ENV: input.pluginRuntime === "built" ? "production" : "test",
      [CHILD_MODE_ENV]: "plugin-host",
      [SOCKET_URL_ENV]: input.socketUrl,
      [AGENT_ID_ENV]: input.agentId,
      [PLUGIN_RUNTIME_ENV]: input.pluginRuntime,
      [EXTERNAL_BUILD_ALLOWLIST_ENV]: input.executableBuildId,
      [HOST_LEASE_MS_ENV]: String(TEST_HOST_LEASE_MS),
      [HOST_HEARTBEAT_MS_ENV]: String(TEST_HOST_HEARTBEAT_MS),
      [HOST_CLAIM_GRACE_MS_ENV]: String(TEST_HOST_CLAIM_GRACE_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return createChildMonitor(child);
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
  return waitForChildExit(monitor, 5_000, "owned plugin-host cleanup").catch(
    () => null,
  );
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return new Uint8Array(data);
}

function isLeasePacket(value: unknown): value is LeasePacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<LeasePacket>;
  return (
    typeof packet.requestId === "string" &&
    typeof packet.preparationId === "string" &&
    typeof packet.ownerId === "string" &&
    typeof packet.executableBuildId === "string" &&
    (packet.action === "claim" || packet.action === "heartbeat")
  );
}

function isLeaseResponse(value: unknown): value is LeaseResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<LeaseResponse>;
  return (
    typeof response.requestId === "string" &&
    typeof response.preparationId === "string" &&
    (response.action === "claim" || response.action === "heartbeat") &&
    (response.status === "active" ||
      response.status === "rejected" ||
      response.status === "unavailable") &&
    typeof response.heartbeatAfterMs === "number"
  );
}

function isStrategyResponse(
  value: unknown,
): value is ExternalDuelPreparationStrategyResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const response = value as Partial<ExternalDuelPreparationStrategyResponse>;
  return (
    typeof response.requestId === "string" &&
    typeof response.preparationId === "string" &&
    (response.status === "selected" || response.status === "fallback") &&
    ((response.status === "selected" &&
      response.decision !== null &&
      typeof response.decision === "object") ||
      (response.status === "fallback" && response.decision === null))
  );
}

async function startSocketHost(input: {
  credential: string;
  agentId: string;
  pool: pg.Pool;
}): Promise<SocketHost> {
  const connections: SocketHost["connections"] = [];
  const requests: SocketRequestRecord[] = [];
  const responses: SocketResponseRecord[] = [];
  const activations: SocketActivationRecord[] = [];
  const strategyResponses: SocketStrategyResponseRecord[] = [];
  const strategyActivations: SocketStrategyActivationRecord[] = [];
  const errors: Error[] = [];
  const drizzleDb = drizzle(input.pool, { schema });
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: ({ req }) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      return (
        url.pathname === "/external-duel-preparation" &&
        url.searchParams.get("credential") === input.credential
      );
    },
  });

  server.on("connection", (socket) => {
    const connectionId = connections.length + 1;
    connections.push({ id: connectionId, socket });
    const socketFacade = {
      player: { id: input.agentId },
      send(packetName: string, data: unknown): void {
        if (packetName !== "duelPreparationHostLease") {
          errors.push(new Error(`unexpected response packet ${packetName}`));
          return;
        }
        if (!isLeaseResponse(data)) {
          errors.push(new Error("invalid host-lease response shape"));
          return;
        }
        responses.push({ connectionId, ...data });
        socket.send(writePacket(packetName, data));
      },
    } as unknown as ServerSocket;
    const world = {
      pgPool: input.pool,
      drizzleDb,
      emit(eventName: string, data: unknown): void {
        if (eventName === "duel:preparation:external_host_active") {
          const activation = data as SocketActivationRecord;
          activations.push({ ...activation });
        } else if (
          eventName === "duel:preparation:external_strategy_response"
        ) {
          const activation = data as SocketStrategyActivationRecord;
          strategyActivations.push({ ...activation });
        }
      },
    } as unknown as World;

    socket.on("message", (data) => {
      void (async () => {
        const [method, payload] = readPacket(rawDataBytes(data));
        if (method === "onDuelPreparationHostLease" && isLeasePacket(payload)) {
          requests.push({ connectionId, ...payload });
          await handleDuelPreparationHostLease(socketFacade, payload, world);
          return;
        }
        if (
          method === "onDuelPreparationStrategy" &&
          isStrategyResponse(payload)
        ) {
          strategyResponses.push({ connectionId, ...payload });
          handleDuelPreparationStrategy(socketFacade, payload, world);
          return;
        }
        throw new Error(`unexpected external-host packet method ${method}`);
      })().catch((error) => {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        socket.close(1011, "test handler failure");
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(
    address && typeof address === "object" && address.port > 0,
    "external-host WebSocket address missing",
  );
  const baseUrl = `ws://127.0.0.1:${address.port}/external-duel-preparation`;
  return {
    server,
    baseUrl,
    authenticatedUrl: `${baseUrl}?credential=${encodeURIComponent(input.credential)}`,
    connections,
    requests,
    responses,
    activations,
    strategyResponses,
    strategyActivations,
    errors,
  };
}

async function assertInvalidCredentialRejected(baseUrl: string): Promise<void> {
  const socket = new WebSocket(`${baseUrl}?credential=invalid`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("invalid test credential was not rejected in time"));
    }, 5_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error("invalid test credential opened the socket"));
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      // Bun's WebSocket client exposes a rejected upgrade as an error rather
      // than ws's `unexpected-response`; the server-side connection count
      // below proves the unauthenticated request never reached the handler.
      resolve();
    });
  });
}

async function waitForValue<T>(input: {
  read: () => T | undefined;
  errors?: () => readonly Error[];
  timeoutMs: number;
  label: string;
}): Promise<T> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const errors = input.errors?.() ?? [];
    if (errors.length > 0) throw errors[0];
    const value = input.read();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error(`${input.label}: timed out after ${input.timeoutMs}ms`);
}

async function waitForExpiredLeaseReport(
  store: PostgresDuelPreparationStore,
  preparationId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = await store.reportExpiredContestantHostLease({
      preparationId,
      claimGraceMs: TEST_HOST_CLAIM_GRACE_MS,
    });
    if (report) return report;
    await delay(100);
  }
  throw new Error("timed out waiting for external host-lease expiry report");
}

async function closeSocketHost(host: SocketHost | null): Promise<void> {
  if (!host) return;
  for (const client of host.server.clients) client.terminate();
  await new Promise<void>((resolve) => {
    host.server.close(() => resolve());
  });
}

async function runPluginHostChild(): Promise<never> {
  const socketUrl = requireEnv(SOCKET_URL_ENV);
  const agentId = requireEnv(AGENT_ID_ENV);
  const pluginRuntime = resolvePluginRuntime();
  const serviceModule =
    pluginRuntime === "built"
      ? await import("../../plugin-hyperia/dist/services/HyperiaService.js")
      : await import("../../plugin-hyperia/src/services/HyperiaService.ts");
  const identityModule =
    pluginRuntime === "built"
      ? await import("../../plugin-hyperia/dist/externalAgentBuildIdentity.js")
      : await import("../../plugin-hyperia/src/externalAgentBuildIdentity.ts");
  const { HyperiaService } = serviceModule;
  const { getExternalAgentExecutableBuildIdentity } = identityModule;
  const executableBuild = getExternalAgentExecutableBuildIdentity();
  const service = new HyperiaService({
    agentId,
    character: { name: "External Host Lease Agent" },
    getSetting: () => null,
    useModel: async () => JSON.stringify(EXTERNAL_STRATEGY_DECISION),
  } as never);
  const internals = service as unknown as {
    characterId: string;
    connectionState: { connected: boolean; connecting: boolean };
    gameState: { playerEntity: { id: string } | null };
    ws: WebSocket | null;
    duelPreparationHostOwnerId: string;
    externalAgentExecutableBuild: { buildId: string; verified: boolean };
    handleMessage: (data: RawData) => void;
    broadcastEvent: (eventType: string, data: unknown) => void;
  };
  assert(
    internals.externalAgentExecutableBuild.buildId ===
      executableBuild.buildId &&
      internals.externalAgentExecutableBuild.verified ===
        executableBuild.verified,
    "plugin service executable-build identity diverged",
  );

  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("plugin WebSocket connection timed out")),
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
  internals.characterId = agentId;
  internals.connectionState.connected = true;
  internals.connectionState.connecting = false;
  internals.gameState.playerEntity = { id: agentId };
  internals.ws = socket;
  internals.broadcastEvent = (eventType, data) => {
    if (eventType === "DUEL_ON_DECK") {
      writeJsonEvent({ type: "duel_on_deck", data });
    } else if (eventType === "DUEL_PREPARATION_REVOKED") {
      writeJsonEvent({ type: "lease_revoked", data });
    }
  };
  socket.on("message", (data) => internals.handleMessage(data));
  socket.once("close", (code, reason) => {
    internals.connectionState.connected = false;
    writeJsonEvent({
      type: "transport_closed",
      code,
      reason: reason.toString(),
    });
  });
  writeJsonEvent({
    type: "transport_ready",
    agentId,
    ownerId: internals.duelPreparationHostOwnerId,
    executableBuildId: executableBuild.buildId,
    executableBuildVerified: executableBuild.verified,
    pluginRuntime,
  });
  await new Promise<never>(() => undefined);
  throw new Error("plugin host hold unexpectedly resolved");
}

async function runParent(): Promise<void> {
  const pluginRuntime = resolvePluginRuntime();
  process.env.NODE_ENV = pluginRuntime === "built" ? "production" : "test";
  process.env[HOST_LEASE_MS_ENV] = String(TEST_HOST_LEASE_MS);
  process.env[HOST_HEARTBEAT_MS_ENV] = String(TEST_HOST_HEARTBEAT_MS);
  process.env[HOST_CLAIM_GRACE_MS_ENV] = String(TEST_HOST_CLAIM_GRACE_MS);
  const identityModule =
    pluginRuntime === "built"
      ? await import("../../plugin-hyperia/dist/externalAgentBuildIdentity.js")
      : await import("../../plugin-hyperia/src/externalAgentBuildIdentity.ts");
  const { getExternalAgentExecutableBuildIdentity } = identityModule;
  const executableBuild = getExternalAgentExecutableBuildIdentity();
  assert(
    executableBuild.verified === (pluginRuntime === "built"),
    `${pluginRuntime} external executable verification classification diverged`,
  );
  process.env[EXTERNAL_BUILD_ALLOWLIST_ENV] = executableBuild.buildId;

  const databaseAuthority = await resolveDatabaseAuthority();
  const runId = randomUUID();
  const preparationId = randomUUID();
  const agent1Id = `external-host-alpha-${runId}`;
  const agent2Id = `external-host-beta-${runId}`;
  const account1Id = `external-host-account-alpha-${runId}`;
  const account2Id = `external-host-account-beta-${runId}`;
  const fencingToken = "801";
  const wholePlanOperationId = randomUUID();
  const survivingOwnerId = randomUUID();
  const credential = randomUUID();
  let pool: pg.Pool | null = null;
  let socketHost: SocketHost | null = null;
  let killedHost: ChildMonitor | null = null;
  let replacementHost: ChildMonitor | null = null;

  try {
    pool = new Pool({
      connectionString: databaseAuthority.databaseUrl,
      max: 8,
    });
    if (databaseAuthority.ownedContainerName) {
      const migrationClient = await pool.connect();
      try {
        await migrate(createPostgresClientDatabase(migrationClient), {
          migrationsFolder: path.resolve(
            path.dirname(SCRIPT_PATH),
            "../src/database/migrations",
          ),
        });
      } finally {
        migrationClient.release();
      }
    }
    const store = new PostgresDuelPreparationStore(pool);
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, 'External Host Alpha', '[]', '2026-08-31T00:00:00.000Z'),
              ($2, 'External Host Beta', '[]', '2026-08-31T00:00:00.000Z')`,
      [account1Id, account2Id],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name)
       VALUES ($1, $3, 'External Host Alpha'),
              ($2, $4, 'External Host Beta')`,
      [agent1Id, agent2Id, account1Id, account2Id],
    );
    await pool.query(
      `INSERT INTO agent_mappings (
         agent_id, account_id, character_id, agent_name,
         streaming_duel_enabled, created_at, updated_at
       ) VALUES
         ($1, $3, $1, 'External Host Alpha', true, NOW(), NOW()),
         ($2, $4, $2, 'External Host Beta', true, NOW(), NOW())`,
      [agent1Id, agent2Id, account1Id, account2Id],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'test_junk', 1, 0)`,
      [agent1Id],
    );
    await pool.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'body', 'bronze_platebody', 1),
              ($1, 'weapon', 'bronze_longsword', 1)`,
      [agent1Id],
    );
    await pool.query(
      `INSERT INTO bank_storage
         ("playerId", "itemId", quantity, slot, "tabIndex")
       VALUES ($1, 'shortbow', 1, 0, 0),
              ($1, 'bronze_arrow', 50, 1, 0),
              ($1, 'lobster', 4, 2, 0),
              ($1, 'wizard_robe_top', 1, 3, 0)`,
      [agent1Id],
    );

    const preparation = await store.create({
      preparationId,
      fencingToken,
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    const survivorLease = await store.claimContestantHostLease({
      preparationId,
      agentId: agent2Id,
      ownerId: survivingOwnerId,
      leaseDurationMs: 60_000,
    });
    assert(survivorLease, "surviving contestant lease was not claimed");

    socketHost = await startSocketHost({ credential, agentId: agent1Id, pool });
    await assertInvalidCredentialRejected(socketHost.baseUrl);
    assert(
      socketHost.connections.length === 0,
      "invalid credential reached the authenticated connection handler",
    );

    killedHost = spawnPluginHost({
      socketUrl: socketHost.authenticatedUrl,
      agentId: agent1Id,
      executableBuildId: executableBuild.buildId,
      pluginRuntime,
    });
    const firstTransport = await killedHost.waitFor(
      (event) => event.type === "transport_ready",
      10_000,
      "first plugin transport",
    );
    assert(
      firstTransport.agentId === agent1Id &&
        typeof firstTransport.ownerId === "string" &&
        firstTransport.executableBuildId === executableBuild.buildId &&
        firstTransport.executableBuildVerified === executableBuild.verified &&
        firstTransport.pluginRuntime === pluginRuntime,
      "first plugin transport identity diverged",
    );
    const firstOwnerId = firstTransport.ownerId;
    const firstConnection = await waitForValue({
      read: () => socketHost!.connections.find(({ id }) => id === 1),
      errors: () => socketHost!.errors,
      timeoutMs: 5_000,
      label: "first authenticated socket",
    });
    firstConnection.socket.send(
      writePacket("duelOnDeck", {
        preparationId,
        selectedAt: preparation.selectedAt,
        expiresAt: preparation.expiresAt,
        opponentId: agent2Id,
        opponentName: "External Host Beta",
      }),
    );

    const firstClaim = await waitForValue({
      read: () =>
        socketHost!.requests.find(
          (request) =>
            request.connectionId === firstConnection.id &&
            request.action === "claim",
        ),
      errors: () => socketHost!.errors,
      timeoutMs: 10_000,
      label: "first external claim",
    });
    assert(
      firstClaim.ownerId === firstOwnerId &&
        firstClaim.executableBuildId === executableBuild.buildId &&
        firstClaim.preparationId === preparationId,
      "first claim did not preserve plugin owner/build/preparation identity",
    );
    const firstClaimResponse = await waitForValue({
      read: () =>
        socketHost!.responses.find(
          (response) => response.requestId === firstClaim.requestId,
        ),
      errors: () => socketHost!.errors,
      timeoutMs: 10_000,
      label: "first external claim response",
    });
    assert(
      firstClaimResponse.status === "active" &&
        firstClaimResponse.heartbeatAfterMs === TEST_HOST_HEARTBEAT_MS,
      "first external claim did not become active with the configured heartbeat",
    );
    const announced = await killedHost.waitFor(
      (event) => event.type === "duel_on_deck",
      5_000,
      "lease-gated on-deck broadcast",
    );
    assert(
      (announced.data as { preparationId?: unknown })?.preparationId ===
        preparationId,
      "plugin announced the wrong preparation",
    );

    const privateBankOpen = await openAuthoritativeAgentBank({
      world: {
        pgPool: pool,
        entities: {
          get: (playerId: string) =>
            playerId === agent1Id
              ? {
                  id: agent1Id,
                  data: {
                    alive: true,
                    health: 20,
                    inStreamingDuel: false,
                  },
                }
              : undefined,
        },
        getSystem: () => null,
      } as unknown as World,
      playerId: agent1Id,
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
    });
    assert(
      privateBankOpen.success &&
        privateBankOpen.bankItems?.length === 4 &&
        privateBankOpen.bankItems[0]?.itemId === "shortbow" &&
        privateBankOpen.bankItems[1]?.itemId === "bronze_arrow" &&
        privateBankOpen.bankItems[2]?.itemId === "lobster" &&
        privateBankOpen.bankItems[3]?.itemId === "wizard_robe_top",
      "actual private preparation bank did not open with exact owned custody",
    );

    const strategyRequest = createStrategyRequest({
      requestId: randomUUID(),
      preparationId,
      expiresAt: preparation.expiresAt,
    });
    firstConnection.socket.send(
      writePacket("duelPreparationStrategy", strategyRequest),
    );
    const strategyResponse = await waitForValue({
      read: () =>
        socketHost!.strategyResponses.find(
          (response) => response.requestId === strategyRequest.requestId,
        ),
      errors: () => socketHost!.errors,
      timeoutMs: 5_000,
      label: "built external strategy response",
    });
    assert(
      strategyResponse.connectionId === firstConnection.id &&
        strategyResponse.preparationId === preparationId &&
        strategyResponse.status === "selected" &&
        isDeepStrictEqual(
          strategyResponse.decision,
          EXTERNAL_STRATEGY_DECISION,
        ),
      "built external strategy response diverged from the bounded model decision",
    );
    const strategyActivation = await waitForValue({
      read: () =>
        socketHost!.strategyActivations.find(
          (activation) => activation.requestId === strategyRequest.requestId,
        ),
      errors: () => socketHost!.errors,
      timeoutMs: 5_000,
      label: "authenticated strategy handler activation",
    });
    assert(
      strategyActivation.agentId === agent1Id &&
        strategyActivation.preparationId === preparationId &&
        strategyActivation.status === "selected" &&
        isDeepStrictEqual(
          strategyActivation.decision,
          EXTERNAL_STRATEGY_DECISION,
        ),
      "server strategy handler did not derive the exact authenticated contestant decision",
    );
    assert(
      strategyActivation.decision,
      "authenticated strategy activation omitted its selected decision",
    );
    const authorityDb = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof authorityDb }).db = authorityDb;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const wholePlanRequest = externalWholePlanRequest({
      operationId: wholePlanOperationId,
      preparationId,
      playerId: agent1Id,
      expectedBank: privateBankOpen.bankItems,
      decision: strategyActivation.decision,
    });
    const wholePlanReceipt =
      await databaseSystem.commitDuelPreparationPlanOperationAsync(
        wholePlanRequest,
      );
    assert(
      !wholePlanReceipt.replayed &&
        wholePlanReceipt.operationId === wholePlanOperationId &&
        wholePlanReceipt.preparationId === preparationId &&
        wholePlanReceipt.playerId === agent1Id &&
        isDeepStrictEqual(
          wholePlanReceipt.recoveryEvidence,
          wholePlanRequest.recoveryEvidence,
        ),
      "server-owned whole-plan commit did not preserve the authenticated decision",
    );
    const recoveredWholePlan =
      await databaseSystem.getDuelPreparationPlanOperationAsync({
        operationId: wholePlanOperationId,
        preparationId,
        playerId: agent1Id,
      });
    assert(
      recoveredWholePlan?.replayed === true &&
        isDeepStrictEqual(
          recoveredWholePlan.committed,
          wholePlanRequest.committed,
        ) &&
        isDeepStrictEqual(
          recoveredWholePlan.recoveryEvidence,
          wholePlanRequest.recoveryEvidence,
        ),
      "server-owned whole-plan recovery was not exact",
    );
    const serializedStrategy = JSON.stringify({
      request: strategyRequest,
      response: strategyResponse,
      activation: strategyActivation,
    });
    assert(
      !/itemId|bank|inventory|wallet|prompt|modelOutput/u.test(
        serializedStrategy,
      ),
      "external strategy transport leaked private authority",
    );

    const firstHeartbeat = await waitForValue({
      read: () =>
        socketHost!.requests.find(
          (request) =>
            request.connectionId === firstConnection.id &&
            request.action === "heartbeat",
        ),
      errors: () => socketHost!.errors,
      timeoutMs: 5_000,
      label: "first external heartbeat",
    });
    assert(
      firstHeartbeat.ownerId === firstOwnerId &&
        firstHeartbeat.executableBuildId === executableBuild.buildId,
      "external heartbeat changed immutable owner/build identity",
    );
    const firstHeartbeatResponse = await waitForValue({
      read: () =>
        socketHost!.responses.find(
          (response) => response.requestId === firstHeartbeat.requestId,
        ),
      errors: () => socketHost!.errors,
      timeoutMs: 5_000,
      label: "first external heartbeat response",
    });
    assert(
      firstHeartbeatResponse.status === "active",
      "first external heartbeat was not active",
    );

    const persistedBeforeKill = await pool.query<{
      ownerId: string;
      executableBuildId: string | null;
      claimedAt: string;
      heartbeatAt: string;
      expiresAt: string;
    }>(
      `SELECT "ownerId", "executableBuildId",
              "claimedAt"::text AS "claimedAt",
              "heartbeatAt"::text AS "heartbeatAt",
              "expiresAt"::text AS "expiresAt"
         FROM streaming_duel_preparation_agent_host_leases
        WHERE "preparationId" = $1 AND "agentId" = $2`,
      [preparationId, agent1Id],
    );
    const killedLease = persistedBeforeKill.rows[0];
    assert(killedLease, "external host lease did not persist before kill");
    assert(
      killedLease.ownerId === firstOwnerId &&
        killedLease.executableBuildId === executableBuild.buildId &&
        Number(killedLease.heartbeatAt) >= Number(killedLease.claimedAt) &&
        Number(killedLease.expiresAt) > Number(killedLease.heartbeatAt),
      "persisted external lease identity or DB-clock timestamps diverged",
    );
    const firstReady = await store.markReady({
      preparationId,
      fencingToken,
      agentId: agent1Id,
      planEvidence: externalStrategyPlanEvidence(strategyActivation.decision),
    });
    assert(
      firstReady?.agent1ReadyAt !== null && firstReady?.status === "preparing",
      "externally leased contestant did not reach first readiness",
    );

    assert(killedHost.child.kill("SIGKILL"), "could not SIGKILL plugin host");
    const killedExit = await waitForChildExit(
      killedHost,
      5_000,
      "first plugin SIGKILL",
    );
    assert(
      killedExit.signal === "SIGKILL",
      `plugin host was not hard-killed: ${JSON.stringify(killedExit)}`,
    );

    const report = await waitForExpiredLeaseReport(
      store,
      preparationId,
      12_000,
    );
    assert(
      report.agentId === agent1Id && report.reason === "agent_unavailable",
      "expired external lease did not report the exact contestant unavailable",
    );
    assert(
      report.reportedAt >= Number(killedLease.expiresAt),
      "external host was reported unavailable before its DB-clock lease expired",
    );

    replacementHost = spawnPluginHost({
      socketUrl: socketHost.authenticatedUrl,
      agentId: agent1Id,
      executableBuildId: executableBuild.buildId,
      pluginRuntime,
    });
    const replacementTransport = await replacementHost.waitFor(
      (event) => event.type === "transport_ready",
      10_000,
      "replacement plugin transport",
    );
    assert(
      typeof replacementTransport.ownerId === "string" &&
        replacementTransport.ownerId !== firstOwnerId &&
        replacementTransport.executableBuildId === executableBuild.buildId,
      "replacement process did not present a fresh owner and pinned build",
    );
    const replacementOwnerId = replacementTransport.ownerId;
    const replacementConnection = await waitForValue({
      read: () => socketHost!.connections.find(({ id }) => id === 2),
      errors: () => socketHost!.errors,
      timeoutMs: 5_000,
      label: "replacement authenticated socket",
    });
    replacementConnection.socket.send(
      writePacket("duelOnDeck", {
        preparationId,
        selectedAt: preparation.selectedAt,
        expiresAt: preparation.expiresAt,
        opponentId: agent2Id,
        opponentName: "External Host Beta",
      }),
    );
    const replacementClaim = await waitForValue({
      read: () =>
        socketHost!.requests.find(
          (request) =>
            request.connectionId === replacementConnection.id &&
            request.action === "claim",
        ),
      errors: () => socketHost!.errors,
      timeoutMs: 5_000,
      label: "replacement external claim",
    });
    assert(
      replacementClaim.ownerId === replacementOwnerId &&
        replacementClaim.executableBuildId === executableBuild.buildId,
      "replacement claim identity diverged",
    );
    const replacementResponse = await waitForValue({
      read: () =>
        socketHost!.responses.find(
          (response) => response.requestId === replacementClaim.requestId,
        ),
      errors: () => socketHost!.errors,
      timeoutMs: 5_000,
      label: "replacement external claim response",
    });
    assert(
      replacementResponse.status === "rejected",
      "replacement process reclaimed a reported private preparation",
    );
    const rejectedStrategyRequest = createStrategyRequest({
      requestId: randomUUID(),
      preparationId,
      expiresAt: preparation.expiresAt,
    });
    replacementConnection.socket.send(
      writePacket("duelPreparationStrategy", rejectedStrategyRequest),
    );
    await delay(TEST_HOST_HEARTBEAT_MS + 250);
    assert(
      !replacementHost.events.some((event) => event.type === "duel_on_deck"),
      "rejected replacement plugin announced private preparation",
    );
    assert(
      !socketHost.requests.some(
        (request) =>
          request.connectionId === replacementConnection.id &&
          request.action === "heartbeat",
      ),
      "rejected replacement plugin started a heartbeat loop",
    );
    assert(
      !socketHost.strategyResponses.some(
        (response) =>
          response.connectionId === replacementConnection.id &&
          response.requestId === rejectedStrategyRequest.requestId,
      ) &&
        !socketHost.strategyActivations.some(
          (activation) =>
            activation.requestId === rejectedStrategyRequest.requestId,
        ),
      "rejected replacement plugin answered a private strategy request",
    );

    assert(
      (await store.heartbeatContestantHostLease({
        preparationId,
        agentId: agent1Id,
        ownerId: firstOwnerId,
        executableBuildId: executableBuild.buildId,
        leaseDurationMs: TEST_HOST_LEASE_MS,
      })) === null,
      "killed external owner revived its expired lease",
    );
    assert(
      !(
        await store.authorizeBankAccess({
          preparationId,
          playerId: agent2Id,
          action: "open",
        })
      ).ok,
      "private bank access survived external host loss",
    );
    assert(
      (await store.markReady({
        preparationId,
        fencingToken,
        agentId: agent2Id,
        planEvidence: planEvidence(agent2Id),
      })) === null,
      "second readiness survived external host loss",
    );
    assert(
      (await store.freeze({ preparationId, fencingToken })) === null,
      "private preparation froze after external host loss",
    );

    const cancelled = await store.cancel({
      preparationId,
      fencingToken,
      reason: "agent_preparation_failed",
    });
    assert(
      cancelled?.status === "cancelled" && cancelled.version === 4,
      "scheduler cancellation did not preserve external host-loss fencing",
    );
    const final = await pool.query<{
      hostLeaseCount: string;
      reportCount: string;
      snapshotCount: string;
      killedOwnerId: string | null;
      killedBuildId: string | null;
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
           WHERE "preparationId" = $1) AS "snapshotCount",
         (SELECT "ownerId"
            FROM streaming_duel_preparation_agent_host_leases
           WHERE "preparationId" = $1 AND "agentId" = $2) AS "killedOwnerId",
         (SELECT "executableBuildId"
            FROM streaming_duel_preparation_agent_host_leases
           WHERE "preparationId" = $1 AND "agentId" = $2) AS "killedBuildId"`,
      [preparationId, agent1Id],
    );
    const graph = final.rows[0];
    assert(
      graph?.hostLeaseCount === "2" &&
        graph.reportCount === "1" &&
        graph.snapshotCount === "0" &&
        graph.killedOwnerId === firstOwnerId &&
        graph.killedBuildId === executableBuild.buildId,
      "final external lease/report/snapshot identity graph diverged",
    );
    const [committedInventory, committedEquipment, committedBank, planEdges] =
      await Promise.all([
        pool.query(
          `SELECT "itemId", quantity, "slotIndex"
             FROM inventory
            WHERE "playerId" = $1
            ORDER BY "slotIndex"`,
          [agent1Id],
        ),
        pool.query(
          `SELECT "slotType", "itemId", quantity
             FROM equipment
            WHERE "playerId" = $1
            ORDER BY "slotType"`,
          [agent1Id],
        ),
        pool.query(
          `SELECT "itemId", quantity, slot, "tabIndex"
             FROM bank_storage
            WHERE "playerId" = $1
            ORDER BY "tabIndex", slot`,
          [agent1Id],
        ),
        pool.query<{ operationCount: string; bankOpenCount: string }>(
          `SELECT
             (SELECT count(*)::text FROM operations_log
               WHERE id = $1 AND "playerId" = $2
                 AND "operationType" = 'duel_preparation_plan'
                 AND completed = true) AS "operationCount",
             (SELECT count(*)::text FROM streaming_duel_bank_open_events
               WHERE "preparationId" = $3 AND "playerId" = $2)
               AS "bankOpenCount"`,
          [wholePlanOperationId, agent1Id, preparationId],
        ),
      ]);
    const exactCommittedCustody =
      isDeepStrictEqual(committedInventory.rows, [
        { itemId: "lobster", quantity: 1, slotIndex: 0 },
        { itemId: "lobster", quantity: 1, slotIndex: 1 },
        { itemId: "lobster", quantity: 1, slotIndex: 2 },
        { itemId: "lobster", quantity: 1, slotIndex: 3 },
      ]) &&
      isDeepStrictEqual(committedEquipment.rows, [
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
        { slotType: "body", itemId: "wizard_robe_top", quantity: 1 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ]) &&
      isDeepStrictEqual(committedBank.rows, [
        { itemId: "test_junk", quantity: 1, slot: 0, tabIndex: 0 },
        {
          itemId: "bronze_longsword",
          quantity: 1,
          slot: 1,
          tabIndex: 0,
        },
        {
          itemId: "bronze_platebody",
          quantity: 1,
          slot: 2,
          tabIndex: 0,
        },
      ]);
    assert(
      exactCommittedCustody &&
        planEdges.rows[0]?.operationCount === "1" &&
        planEdges.rows[0]?.bankOpenCount === "1",
      "external socket decision did not produce one exact bank/whole-plan custody graph",
    );
    assert(
      socketHost.activations.length === 1 &&
        socketHost.activations[0]?.preparationId === preparationId &&
        socketHost.activations[0]?.agentId === agent1Id &&
        socketHost.activations[0]?.ownerId === firstOwnerId &&
        socketHost.activations[0]?.executableBuildId ===
          executableBuild.buildId,
      "real handler emitted an inexact external-host activation set",
    );
    assert(
      socketHost.strategyResponses.length === 1 &&
        socketHost.strategyActivations.length === 1,
      "external strategy transport emitted an inexact response/activation set",
    );
    assert(
      socketHost.errors.length === 0,
      "socket host recorded a handler error",
    );

    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        ok: true,
        runId,
        preparationId,
        transport: {
          actualWebSocket: true,
          actualMsgpack: true,
          leasePacketId: getPacketId("duelPreparationHostLease"),
          strategyPacketId: getPacketId("duelPreparationStrategy"),
          invalidTestCredentialRejected: true,
          boundedStrategyRoundTrip: true,
          productionAuthenticationCovered: false,
          serverNetworkLifecycleCovered: false,
        },
        executableBuild: {
          runtime: pluginRuntime,
          buildId: executableBuild.buildId,
          verifiedArtifact: executableBuild.verified,
          exactAllowlistEnforced: true,
        },
        killedHost: {
          ownerId: firstOwnerId,
          signal: killedExit.signal,
          claimStatus: firstClaimResponse.status,
          heartbeatStatus: firstHeartbeatResponse.status,
          announcedAfterActiveClaim: true,
          leaseExpiresAt: Number(killedLease.expiresAt),
        },
        replacementHost: {
          ownerId: replacementOwnerId,
          freshProcessOwner: true,
          claimStatus: replacementResponse.status,
          announced: false,
          heartbeatStarted: false,
          strategyAnswered: false,
        },
        strategy: {
          requestId: strategyRequest.requestId,
          status: strategyResponse.status,
          selectedPlanOptionId: strategyResponse.decision?.planOptionId,
          selectedFoodOptionId: strategyResponse.decision?.foodOptionId,
          selectedArmorOptionId: strategyResponse.decision?.armorOptionId,
          selectedPrimaryStyle: strategyResponse.decision?.primaryStyle,
          authenticatedAgentId: strategyActivation.agentId,
          privateAuthorityLeakDetected: false,
          responseCount: socketHost.strategyResponses.length,
          activationCount: socketHost.strategyActivations.length,
        },
        serverOwnedPreparation: {
          privateBankOpened: privateBankOpen.success,
          bankOpenEventCount: Number(planEdges.rows[0]?.bankOpenCount),
          wholePlanOperationId,
          wholePlanCommitted: !wholePlanReceipt.replayed,
          wholePlanRecoveredExactly: recoveredWholePlan.replayed,
          wholePlanOperationCount: Number(planEdges.rows[0]?.operationCount),
          exactCommittedCustody,
          readinessCommitted: firstReady.agent1ReadyAt !== null,
          readinessStatusBeforeHostLoss: firstReady.status,
          selectedWeaponId: "shortbow",
          selectedAmmunitionId: "bronze_arrow",
          selectedArmorBodyId: "wizard_robe_top",
          selectedFoodItemId: "lobster",
          privateItemIdsSentToPlugin: false,
        },
        report,
        fences: {
          expiredOwnerHeartbeatRejected: true,
          bankAccessRejected: true,
          readinessRejected: true,
          freezeRejected: true,
          competitiveSnapshotCount: Number(graph.snapshotCount),
        },
        terminal: {
          status: cancelled.status,
          cancellationReason: cancelled.cancellationReason,
          preparationVersion: cancelled.version,
          hostLeaseCount: Number(graph.hostLeaseCount),
          reportCount: Number(graph.reportCount),
          externalActivationCount: socketHost.activations.length,
          externalStrategyActivationCount:
            socketHost.strategyActivations.length,
        },
      })}\n`,
    );
  } finally {
    await killOwnedChild(replacementHost);
    await killOwnedChild(killedHost);
    await closeSocketHost(socketHost);
    await pool?.end().catch(() => undefined);
    if (databaseAuthority.ownedContainerName) {
      await docker(["rm", "-f", databaseAuthority.ownedContainerName]).catch(
        () => undefined,
      );
    }
  }
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
  await runParent();
}
