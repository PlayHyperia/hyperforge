import { createServer, type ServerResponse } from "node:http";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import {
  buildBettingFeedPayload,
  type BettingFeedPayload,
  type BettingFeedTerminalOverride,
} from "../src/routes/streaming-betting-feed.js";
import { StreamingDuelScheduler } from "../src/systems/StreamingDuelScheduler/index.js";
import {
  AGENT_IDS,
  driveAuthoritativeCombatToNaturalTerminal,
  installAuthoritativeCombatRuntime,
  openPersistedCycle,
  seedAgents,
  startWorkerRuntime,
  stopWorkerRuntime,
  waitFor,
  waitForPostgres,
  type AuthoritativeCombatRuntime,
  type WorkerRuntime,
} from "./test-agent-duel-cycle-process-kill.js";

const databaseUrl = process.env.AGENT_DUEL_BET_SYNC_DATABASE_URL?.trim() || "";
const bettingToken = process.env.BETTING_FEED_ACCESS_TOKEN?.trim() || "";
const port = Number.parseInt(
  process.env.AGENT_DUEL_BET_SYNC_PORT?.trim() || "",
  10,
);
const naturalTerminalModeValue =
  process.env.AGENT_DUEL_BET_SYNC_NATURAL_TERMINAL?.trim().toLowerCase() ||
  "false";
if (
  naturalTerminalModeValue !== "true" &&
  naturalTerminalModeValue !== "false"
) {
  throw new Error("AGENT_DUEL_BET_SYNC_NATURAL_TERMINAL must be true or false");
}
const naturalTerminalMode = naturalTerminalModeValue === "true";
const naturalCombatTimeoutMs = Number.parseInt(
  process.env.AGENT_DUEL_BET_SYNC_COMBAT_TIMEOUT_MS?.trim() || "300000",
  10,
);
if (
  !Number.isSafeInteger(naturalCombatTimeoutMs) ||
  naturalCombatTimeoutMs < 10_000 ||
  naturalCombatTimeoutMs > 900_000
) {
  throw new Error(
    "AGENT_DUEL_BET_SYNC_COMBAT_TIMEOUT_MS must be an integer between 10000 and 900000",
  );
}

if (!databaseUrl) {
  throw new Error("AGENT_DUEL_BET_SYNC_DATABASE_URL is required");
}
if (!bettingToken) {
  throw new Error("BETTING_FEED_ACCESS_TOKEN is required");
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("AGENT_DUEL_BET_SYNC_PORT must be a valid TCP port");
}
const shutdownAckUrl =
  process.env.AGENT_DUEL_BET_SYNC_SHUTDOWN_ACK_URL?.trim() || "";
const shutdownAckTimeoutMs = Number.parseInt(
  process.env.AGENT_DUEL_BET_SYNC_SHUTDOWN_ACK_TIMEOUT_MS?.trim() || "15000",
  10,
);
if (shutdownAckUrl) {
  const parsed = new URL(shutdownAckUrl);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "AGENT_DUEL_BET_SYNC_SHUTDOWN_ACK_URL must be credential-free HTTP(S)",
    );
  }
  if (
    !Number.isSafeInteger(shutdownAckTimeoutMs) ||
    shutdownAckTimeoutMs < 1_000 ||
    shutdownAckTimeoutMs > 20_000
  ) {
    throw new Error(
      "AGENT_DUEL_BET_SYNC_SHUTDOWN_ACK_TIMEOUT_MS must be 1000..20000",
    );
  }
}

type RetainedFrame = {
  seq: number;
  payload: BettingFeedPayload;
  json: string;
};

type StreamingState = ReturnType<StreamingDuelScheduler["getStreamingState"]>;

type StreamingStateFrame = {
  seq: number;
  emittedAt: number;
  payload: StreamingState & {
    type: "STREAMING_STATE_UPDATE";
    seq: number;
    emittedAt: number;
    cycle: StreamingState["cycle"] & {
      rendererHealth: {
        ready: true;
        degradedReason: null;
        updatedAt: number;
      };
    };
  };
  json: string;
};

let runtime: WorkerRuntime | null = null;
let scheduler: StreamingDuelScheduler | null = null;
let authoritativeCombat: AuthoritativeCombatRuntime | null = null;
let shuttingDown = false;
const sourceEpoch = Date.now();
let sequence = 0;
let streamingSequence = 0;
const retainedFrames: RetainedFrame[] = [];
const streamingClients = new Set<ServerResponse>();
let streamingBroadcastTimer: ReturnType<typeof setInterval> | null = null;

type AuthoritativeBettingSource = {
  cycle: NonNullable<ReturnType<StreamingDuelScheduler["getCurrentCycle"]>>;
  terminal: BettingFeedTerminalOverride | null;
};

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

function isAuthorized(authorization: string | undefined): boolean {
  return authorization === `Bearer ${bettingToken}`;
}

function getAuthoritativeBettingSource(): AuthoritativeBettingSource | null {
  if (!scheduler) return null;
  const cycle = scheduler.getCurrentCycle();
  if (cycle) return { cycle, terminal: null };
  return scheduler.getDurableBettingTerminal();
}

function captureFrame(): RetainedFrame {
  const source = getAuthoritativeBettingSource();
  if (!source) throw new Error("competitive cycle is not ready");
  const emittedAt = Date.now();
  const payload = buildBettingFeedPayload({
    sourceEpoch,
    seq: sequence + 1,
    emittedAt,
    cycle: source.cycle,
    terminal: source.terminal,
    rendererHealth: {
      ready: true,
      degradedReason: null,
      updatedAt: emittedAt,
    },
  });
  sequence += 1;
  const frame = { seq: sequence, payload, json: JSON.stringify(payload) };
  retainedFrames.push(frame);
  if (retainedFrames.length > 128) retainedFrames.shift();
  return frame;
}

async function waitForShutdownAcknowledgement(
  frame: RetainedFrame,
): Promise<boolean> {
  if (!shutdownAckUrl) return false;
  const duelId = frame.payload.duelId;
  if (!duelId) {
    throw new Error("shutdown terminal frame is missing its duel identity");
  }
  const deadline = Date.now() + shutdownAckTimeoutMs;
  let lastFailure = "keeper acknowledgement was not observed";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(shutdownAckUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else {
        const body = (await response.json()) as {
          running?: unknown;
          health?: {
            markets?: Array<{
              duelId?: unknown;
              lifecycleStatus?: unknown;
            }>;
          } | null;
        };
        const acknowledged =
          body.running === true &&
          body.health?.markets?.some(
            (market) =>
              market.duelId === duelId &&
              market.lifecycleStatus === "CANCELLED",
          ) === true;
        if (acknowledged) return true;
        lastFailure = `duel ${duelId} is not CANCELLED`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for shutdown cancellation acknowledgement: ${lastFailure}`,
  );
}

function captureStreamingStateFrame(): StreamingStateFrame {
  if (!scheduler) throw new Error("streaming scheduler is not ready");
  const state = scheduler.getStreamingState();
  const emittedAt = Date.now();
  const seq = streamingSequence + 1;
  const payload = {
    ...state,
    type: "STREAMING_STATE_UPDATE" as const,
    seq,
    emittedAt,
    cycle: {
      ...state.cycle,
      rendererHealth: {
        ready: true as const,
        degradedReason: null,
        updatedAt: emittedAt,
      },
    },
  };
  streamingSequence = seq;
  return { seq, emittedAt, payload, json: JSON.stringify(payload) };
}

function writeStreamingStateEvent(
  response: ServerResponse,
  frame: StreamingStateFrame,
): boolean {
  if (response.destroyed || response.writableEnded) return false;
  try {
    response.write(`id: ${frame.seq}\nevent: state\ndata: ${frame.json}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcastStreamingState(): void {
  if (streamingClients.size === 0) return;
  const frame = captureStreamingStateFrame();
  for (const response of streamingClients) {
    if (!writeStreamingStateEvent(response, frame)) {
      streamingClients.delete(response);
    }
  }
}

async function initializeDatabase(): Promise<void> {
  const pool = await waitForPostgres(databaseUrl);
  try {
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          import.meta.dirname,
          "../src/database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }

    const existing = await pool.query<{ id: string }>(
      `SELECT id
         FROM characters
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [[...AGENT_IDS]],
    );
    if (existing.rows.length === 0) {
      await seedAgents(drizzle(pool, { schema }));
    } else if (
      existing.rows.length !== AGENT_IDS.length ||
      existing.rows.some((row) => !AGENT_IDS.includes(row.id as never))
    ) {
      throw new Error("persisted Hyperia E2E contestant set is incomplete");
    }
  } finally {
    await pool.end();
  }
}

async function nextFencingToken(): Promise<string> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const result = await pool.query<{ maximum: string }>(
      `SELECT COALESCE(MAX("fencingToken"), 0)::text AS maximum
         FROM streaming_duel_preparations`,
    );
    return (BigInt(result.rows[0]?.maximum || "0") + 1n).toString();
  } finally {
    await pool.end();
  }
}

async function hasRecoverableCycle(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM streaming_duel_competitive_snapshots
        WHERE "lifecycleStatus" = 'frozen'`,
    );
    return result.rows[0]?.count === "1";
  } finally {
    await pool.end();
  }
}

async function initializeRuntime(): Promise<void> {
  await initializeDatabase();
  const recoverableCycle = await hasRecoverableCycle();
  runtime = await startWorkerRuntime(databaseUrl);
  scheduler = new StreamingDuelScheduler(runtime.world, {
    fencingToken: await nextFencingToken(),
  });
  scheduler.init();

  if (recoverableCycle) {
    await waitFor(
      () => {
        const source = getAuthoritativeBettingSource();
        return Boolean(
          source &&
          (source.cycle.phase === "ANNOUNCEMENT" ||
            source.terminal?.outcome === "cancelled"),
        );
      },
      "persisted Hyperia betting cycle or terminal recovery",
      60_000,
    );
  } else {
    await openPersistedCycle(runtime, scheduler);
  }

  await waitFor(() => {
    const source = getAuthoritativeBettingSource();
    const cycle = source?.cycle;
    const activeAnnouncementReady =
      cycle?.phase === "ANNOUNCEMENT" && Boolean(cycle.arenaPositions);
    const terminalCancellationReady = source?.terminal?.outcome === "cancelled";
    return Boolean(
      cycle &&
      (activeAnnouncementReady || terminalCancellationReady) &&
      cycle.competitiveSnapshot?.persisted === true &&
      cycle.competitiveSnapshot.diagnostic === false &&
      cycle.competitiveSnapshotDigest &&
      cycle.duelId &&
      cycle.duelKeyHex,
    );
  }, "production-owned Hyperia betting feed readiness");

  if (naturalTerminalMode) {
    authoritativeCombat = await installAuthoritativeCombatRuntime(runtime);
  }
}

await initializeRuntime();

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${port}`);

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    const source = getAuthoritativeBettingSource();
    const cycle = scheduler?.getCurrentCycle() ?? null;
    const authoritativeCycle = source?.cycle ?? null;
    sendJson(response, authoritativeCycle ? 200 : 503, {
      ready: Boolean(authoritativeCycle),
      sourceEpoch,
      duelId: authoritativeCycle?.duelId ?? null,
      duelKeyHex: authoritativeCycle?.duelKeyHex ?? null,
      snapshotDigest: authoritativeCycle?.competitiveSnapshotDigest ?? null,
      phase: cycle?.phase ?? null,
      outcome: source?.terminal?.outcome ?? cycle?.outcome ?? null,
      cancellationReason: source?.terminal?.cancellationReason ?? null,
      competitiveSnapshotPersisted:
        authoritativeCycle?.competitiveSnapshot?.persisted ?? false,
      competitiveSnapshotDiagnostic:
        authoritativeCycle?.competitiveSnapshot?.diagnostic ?? null,
    });
    return;
  }

  if (
    request.method === "GET" &&
    requestUrl.pathname === "/api/streaming/state"
  ) {
    try {
      sendJson(response, 200, captureStreamingStateFrame().payload);
    } catch {
      sendJson(response, 503, { error: "Streaming state unavailable" });
    }
    return;
  }

  if (
    request.method === "GET" &&
    requestUrl.pathname === "/api/streaming/state/events"
  ) {
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.socket?.setNoDelay(true);
    response.socket?.setKeepAlive(true, 2_000);
    response.flushHeaders();
    response.write("retry: 1000\n\n");
    const frame = captureStreamingStateFrame();
    if (!writeStreamingStateEvent(response, frame)) {
      response.end();
      return;
    }
    streamingClients.add(response);
    request.once("close", () => streamingClients.delete(response));
    return;
  }

  if (
    request.method === "GET" &&
    requestUrl.pathname === "/api/internal/bet-sync/state"
  ) {
    if (!isAuthorized(request.headers.authorization)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    try {
      sendJson(response, 200, captureFrame().payload);
    } catch {
      sendJson(response, 503, { error: "Betting feed unavailable" });
    }
    return;
  }

  if (
    request.method === "GET" &&
    requestUrl.pathname === "/api/internal/bet-sync/events"
  ) {
    if (!isAuthorized(request.headers.authorization)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    const since = Number.parseInt(
      requestUrl.searchParams.get("since") || "0",
      10,
    );
    const oldest = retainedFrames[0]?.seq ?? sequence;
    const frames = retainedFrames.filter((frame) => frame.seq > since);
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "close",
      "content-type": "text/event-stream; charset=utf-8",
    });
    if (since > 0 && since < oldest - 1 && retainedFrames.length > 0) {
      const latest = retainedFrames[retainedFrames.length - 1]!;
      response.write(
        `id: ${latest.seq}\nevent: reset\ndata: ${latest.json}\n\n`,
      );
    } else {
      for (const frame of frames) {
        response.write(
          `id: ${frame.seq}\nevent: betting\ndata: ${frame.json}\n\n`,
        );
      }
    }
    response.end();
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

streamingBroadcastTimer = setInterval(broadcastStreamingState, 1_000);

server.listen(port, "127.0.0.1", () => {
  const cycle = getAuthoritativeBettingSource()?.cycle;
  process.stdout.write(
    `${JSON.stringify({
      event: "ready",
      port,
      sourceEpoch,
      duelId: cycle?.duelId,
      duelKeyHex: cycle?.duelKeyHex,
      snapshotDigest: cycle?.competitiveSnapshotDigest,
      naturalTerminalMode,
    })}\n`,
  );
});

async function runNaturalTerminalMode(): Promise<void> {
  if (!naturalTerminalMode) return;
  if (!runtime || !scheduler || !authoritativeCombat) {
    throw new Error("natural terminal authority was not initialized");
  }
  const evidence = await driveAuthoritativeCombatToNaturalTerminal(
    runtime,
    scheduler,
    authoritativeCombat,
    { combatTimeoutMs: naturalCombatTimeoutMs },
  );
  const { resolvedCycle, projectileDiagnostics, diagnostics } = evidence;
  if (
    resolvedCycle.phase !== "RESOLUTION" ||
    resolvedCycle.outcome !== "win" ||
    resolvedCycle.winReason !== "kill" ||
    !resolvedCycle.winnerId ||
    !resolvedCycle.loserId ||
    evidence.authoritativeCombatTicks < 5 ||
    projectileDiagnostics.launched < 2 ||
    projectileDiagnostics.hit < 1 ||
    projectileDiagnostics.active !== 0 ||
    diagnostics.length !== 2 ||
    diagnostics.some(
      (entry) =>
        entry.tickCount < 5 ||
        entry.engagementAccepts < 1 ||
        entry.engagementErrors !== 0 ||
        entry.movementErrors !== 0 ||
        entry.styleChangeRejects !== 0 ||
        entry.styleChangeErrors !== 0 ||
        entry.prayerToggleRejects !== 0,
    )
  ) {
    throw new Error(
      `natural terminal acceptance diagnostics drifted: ${JSON.stringify(evidence)}`,
    );
  }
  const terminalFrame = captureFrame();
  process.stdout.write(
    `${JSON.stringify({
      event: "natural-terminal",
      sourceEpoch,
      duelId: terminalFrame.payload.duelId,
      duelKeyHex: terminalFrame.payload.duelKey,
      competitiveSnapshotDigest:
        terminalFrame.payload.competitiveSnapshotDigest,
      winnerId: resolvedCycle.winnerId,
      loserId: resolvedCycle.loserId,
      outcome: resolvedCycle.outcome,
      winReason: resolvedCycle.winReason,
      authoritativeCombatTicks: evidence.authoritativeCombatTicks,
      projectileDiagnostics,
    })}\n`,
  );
}

void runNaturalTerminalMode().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      event: "natural-terminal-failed",
      sourceEpoch,
      reason: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  void shutdown().finally(() => process.exit(1));
});

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (streamingBroadcastTimer) {
    clearInterval(streamingBroadcastTimer);
    streamingBroadcastTimer = null;
  }
  let terminalFrame: RetainedFrame | null = null;
  let downstreamAcknowledged = false;
  if (scheduler) {
    scheduler.destroy("scheduler_shutdown");
    await scheduler.waitForShutdownCleanup().catch(() => undefined);
    const terminal = getAuthoritativeBettingSource()?.terminal ?? null;
    if (terminal?.outcome === "cancelled") {
      terminalFrame = captureFrame();
      downstreamAcknowledged =
        await waitForShutdownAcknowledgement(terminalFrame);
    }
  }
  for (const response of streamingClients) {
    try {
      response.end();
    } catch {
      // The source may already have lost this client during shutdown.
    }
  }
  streamingClients.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  authoritativeCombat?.destroy();
  authoritativeCombat = null;
  if (runtime) await stopWorkerRuntime(runtime).catch(() => undefined);
  const terminalPayload = terminalFrame?.payload ?? null;
  process.stdout.write(
    `${JSON.stringify({
      event: "shutdown-complete",
      sourceEpoch,
      terminalFrameSeq: terminalFrame?.seq ?? null,
      duelId: terminalPayload?.duelId ?? null,
      duelKeyHex: terminalPayload?.duelKey ?? null,
      competitiveSnapshotDigest:
        terminalPayload?.competitiveSnapshotDigest ?? null,
      outcome: terminalPayload?.outcome ?? null,
      cancellationReason: terminalPayload?.cancellationReason ?? null,
      downstreamAcknowledged,
    })}\n`,
  );
}

function requestShutdown(signal: "SIGINT" | "SIGTERM"): void {
  void shutdown().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(
        `${JSON.stringify({
          event: "shutdown-failed",
          signal,
          reason: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
      process.exit(1);
    },
  );
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
