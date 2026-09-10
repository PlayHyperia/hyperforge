import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RateLimitOptions } from "@fastify/rate-limit";
import type { DatabaseSystem } from "../systems/DatabaseSystem/index.js";
import type { World } from "@hyperforge/shared";
import { getStreamingDuelScheduler } from "../systems/StreamingDuelScheduler/index.js";
import {
  getStreamingDuelAuthoritySnapshot,
  type StreamingDuelAuthoritySnapshot,
} from "../systems/StreamingDuelScheduler/authority.js";
import type { StreamingDuelCycle } from "../systems/StreamingDuelScheduler/types.js";
import { storage } from "../database/schema.js";
import {
  BETTING_FEED_SCHEMA_VERSION,
  BETTING_SOURCE_EPOCH_STORAGE_KEY,
  buildBettingFeedDedupKey,
  buildBettingFeedPayload,
  selectReplayDelivery,
  type BettingFeedFrame,
  type BettingFeedRendererHealth,
  type BettingFeedTerminalOverride,
} from "./streaming-betting-feed.js";
import {
  authorizeBettingFeedToken,
  extractBettingFeedToken,
  isBettingFeedAuthorizationActive,
  resolveBettingFeedAccessToken,
  resolveBettingFeedAuthorizationStatus,
  shouldSkipBettingFeedAuth,
  type BettingFeedAuthorization,
} from "./streaming-betting-auth.js";
import { trimReplayFrames } from "./streaming-sse-buffer.js";
import { deriveBettingRendererHealth } from "./streaming-betting-health.js";
import { acquireExternalStatusPoller } from "./streaming-external-status.js";

// Re-exports so existing consumers (streaming.ts, tests) don't need import changes.
export { deriveBettingRendererHealth } from "./streaming-betting-health.js";
export {
  loadExternalRtmpStatusSnapshot,
  parseExternalRtmpStatusSnapshot,
} from "./streaming-external-status.js";

type RegisterStreamingBettingRoutesOptions = {
  fastify: FastifyInstance;
  world: World;
  replayBuffer: number;
  replayMaxBytes: number;
  pushIntervalMs: number;
  heartbeatMs: number;
  maxPendingBytes: number;
  maxClients: number;
  bootstrapRateLimit: RateLimitOptions;
  eventsRateLimit: RateLimitOptions;
  internalAllowedOrigin: string | null;
  externalStatusFile: string | null;
  externalStatusMaxAgeMs: number;
  getStreamingDuelScheduler?: typeof getStreamingDuelScheduler;
  getStreamingDuelAuthoritySnapshot?: () => StreamingDuelAuthoritySnapshot;
  getStreamCaptureStats?: () => {
    clientConnected: boolean;
    ffmpegRunning: boolean;
  };
  getAuthNowMs?: () => number;
};

type BettingRouteMetrics = {
  schemaVersion: number;
  sourceEpoch: number;
  clients: {
    connected: number;
  };
  replay: {
    size: number;
    totalBytes: number;
    oldestSeq: number | null;
    latestSeq: number | null;
    latestEmittedAt: number | null;
    latestObservedAt: number | null;
    lastBroadcastSeq: number;
  };
};

export type StreamingBettingAuthorityHealth = {
  ready: boolean;
  sourceEpoch: number;
  duelId: string | null;
  duelKeyHex: string | null;
  snapshotDigest: string | null;
  phase: string | null;
  outcome: string | null;
  cancellationReason: string | null;
  competitiveSnapshotPersisted: boolean;
  competitiveSnapshotDiagnostic: boolean | null;
};

export type StreamingBettingTerminalFrame = {
  sourceEpoch: number;
  terminalFrameSeq: number;
  duelId: string;
  duelKeyHex: string;
  competitiveSnapshotDigest: string;
  outcome: "cancelled";
  cancellationReason: string;
};

export type StreamingBettingRoutesRuntime = {
  close(): void;
  captureCurrentState(): void;
  getRendererHealth(): BettingFeedRendererHealth;
  getMetrics(): BettingRouteMetrics;
  getAuthorityHealth(): Promise<StreamingBettingAuthorityHealth>;
  waitForTerminalFrame(input: {
    duelId: string;
    cancellationReason: string;
    timeoutMs?: number;
  }): Promise<StreamingBettingTerminalFrame>;
};

type SseSendStatus = "ok" | "closed" | "slow" | "error";

type DatabaseSystemLike = Pick<DatabaseSystem, "getDb">;

type BettingClientIdAllocation = {
  clientId: number;
  nextCursor: number;
};

type BettingClientAuthorization =
  | BettingFeedAuthorization
  | {
      kind: "development-bypass";
      authorizedUntilMs: null;
    };

type BettingClient = {
  reply: FastifyReply;
  authorization: BettingClientAuthorization;
};

type StreamingCycleAbortedEvent = {
  cycleId: string | null;
  duelId: string | null;
  reason: string;
};

type StreamingResolutionStartEvent = {
  cycleId: string | null;
  duelId: string | null;
  outcome: "win" | "draw" | null;
};

function parseStreamingCycleAbortedEvent(
  payload: unknown,
): StreamingCycleAbortedEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (!reason) return null;

  return {
    cycleId: typeof record.cycleId === "string" ? record.cycleId : null,
    duelId: typeof record.duelId === "string" ? record.duelId : null,
    reason,
  };
}

function parseStreamingResolutionStartEvent(
  payload: unknown,
): StreamingResolutionStartEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const outcome =
    record.outcome === "win" || record.outcome === "draw"
      ? record.outcome
      : null;
  if (!outcome) return null;

  return {
    cycleId: typeof record.cycleId === "string" ? record.cycleId : null,
    duelId: typeof record.duelId === "string" ? record.duelId : null,
    outcome,
  };
}

function formatSseEvent(event: string, data: string, id?: number): string {
  const normalizedData = data.replace(/\n/g, "\ndata: ");
  const idLine = typeof id === "number" ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${normalizedData}\n\n`;
}

export function normalizeInternalAllowedOrigin(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "*" || trimmed === "null") {
    return null;
  }
  if (trimmed.includes(",")) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function hasAllowedInternalBettingOrigin(
  requestOrigin: string | string[] | undefined,
  allowedOrigin: string | null,
): boolean {
  const normalizedRequestOrigin = Array.isArray(requestOrigin)
    ? requestOrigin[0]
    : requestOrigin;
  if (!normalizedRequestOrigin) return true;
  return allowedOrigin !== null && normalizedRequestOrigin === allowedOrigin;
}

export function parseReplayCursor(
  request: FastifyRequest<{ Querystring: { since?: string } }>,
): number {
  const headerLastEventId = request.headers["last-event-id"];
  const normalizedHeaderId = Array.isArray(headerLastEventId)
    ? headerLastEventId[0]
    : headerLastEventId;
  const querySince = Number.parseInt(request.query.since || "", 10);
  const headerSince = Number.parseInt(normalizedHeaderId || "", 10);
  return Number.isFinite(headerSince)
    ? headerSince
    : Number.isFinite(querySince)
      ? querySince
      : 0;
}

export function allocateNextBettingClientId(
  nextCursor: number,
  activeClientIds: Iterable<number>,
): BettingClientIdAllocation {
  const activeIds = new Set(activeClientIds);
  const maxClientId = Number.MAX_SAFE_INTEGER - 1;
  let clientId = nextCursor;
  let wrapped = false;

  while (activeIds.has(clientId)) {
    clientId += 1;
    if (clientId > maxClientId) {
      clientId = 1;
      wrapped = true;
    }
    if (wrapped && clientId === nextCursor) {
      throw new Error("No betting SSE client ids available");
    }
  }

  const nextId = clientId >= maxClientId ? 1 : clientId + 1;
  return {
    clientId,
    nextCursor: nextId,
  };
}

export function registerStreamingBettingRoutes(
  options: RegisterStreamingBettingRoutesOptions,
): StreamingBettingRoutesRuntime {
  const {
    fastify,
    world,
    replayBuffer,
    replayMaxBytes,
    pushIntervalMs,
    heartbeatMs,
    maxPendingBytes,
    maxClients,
    bootstrapRateLimit,
    eventsRateLimit,
    internalAllowedOrigin,
    externalStatusFile,
    externalStatusMaxAgeMs,
    getStreamingDuelScheduler: getStreamingDuelSchedulerOverride,
    getStreamingDuelAuthoritySnapshot:
      getStreamingDuelAuthoritySnapshotOverride,
    getStreamCaptureStats,
    getAuthNowMs,
  } = options;

  const authNow = getAuthNowMs ?? Date.now;
  const getAuthoritySnapshot =
    getStreamingDuelAuthoritySnapshotOverride ??
    getStreamingDuelAuthoritySnapshot;
  const tokenResolution = resolveBettingFeedAccessToken(process.env, authNow());
  const skipAuth = shouldSkipBettingFeedAuth(process.env);
  const allowedOrigin = normalizeInternalAllowedOrigin(internalAllowedOrigin);
  const viewerTokenConfigured = Boolean(
    process.env.STREAMING_VIEWER_ACCESS_TOKEN?.trim(),
  );
  const getScheduler =
    getStreamingDuelSchedulerOverride ?? getStreamingDuelScheduler;
  if (tokenResolution.configurationError) {
    throw new Error(
      `Invalid betting feed token rotation configuration: ${tokenResolution.configurationError}`,
    );
  }
  const externalStatusPoller = acquireExternalStatusPoller(
    externalStatusFile,
    externalStatusMaxAgeMs,
  );
  if (!tokenResolution.token && process.env.NODE_ENV === "production") {
    fastify.log.warn(
      "BETTING_FEED_ACCESS_TOKEN is unset in production; internal betting feed will fail closed",
    );
  } else if (!tokenResolution.token && skipAuth) {
    fastify.log.warn(
      "BETTING_FEED_SKIP_AUTH=true with no betting-feed token configured; internal betting feed auth bypass is enabled for development use only",
    );
  } else if (!tokenResolution.token && viewerTokenConfigured) {
    fastify.log.warn(
      "STREAMING_VIEWER_ACCESS_TOKEN is configured but is no longer accepted for internal betting feed auth; set BETTING_FEED_ACCESS_TOKEN instead",
    );
  } else if (!tokenResolution.token) {
    fastify.log.warn(
      "BETTING_FEED_ACCESS_TOKEN is unset; internal betting feed will fail closed unless BETTING_FEED_SKIP_AUTH=true is set in development",
    );
  } else if (viewerTokenConfigured) {
    fastify.log.info(
      "STREAMING_VIEWER_ACCESS_TOKEN remains separate from internal betting feed auth; BETTING_FEED_ACCESS_TOKEN is the canonical betting secret",
    );
  }
  if (tokenResolution.rotationState === "active") {
    fastify.log.warn(
      {
        previousTokenExpiresAtMs: tokenResolution.previousTokenExpiresAtMs,
      },
      "BETTING_FEED_ACCESS_TOKEN_PREVIOUS is active for a bounded token-rotation overlap",
    );
  } else if (tokenResolution.rotationState === "expired") {
    fastify.log.warn(
      "BETTING_FEED_ACCESS_TOKEN_PREVIOUS has expired and is rejected; remove the stale previous-token settings",
    );
  }
  if (internalAllowedOrigin && !allowedOrigin) {
    fastify.log.warn(
      {
        configuredOrigin: internalAllowedOrigin,
      },
      "Ignoring invalid INTERNAL_BET_SYNC_ALLOWED_ORIGIN; expected one explicit http(s) origin with no path, query, or hash",
    );
  }

  const bettingClients = new Map<number, BettingClient>();
  const requestAuthorizations = new WeakMap<
    FastifyRequest,
    BettingClientAuthorization
  >();
  const bettingReplayFrames: BettingFeedFrame[] = [];
  let bettingReplayFramesTotalBytes = 0;
  let latestBettingObservationAt: number | null = null;
  let bettingSequence = 0;
  let lastSerializedBettingState = "";
  let lastBettingBroadcastSeq = 0;
  let bettingPushInterval: ReturnType<typeof setInterval> | null = null;
  let bettingHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let bettingAuthExpiryTimeout: ReturnType<typeof setTimeout> | null = null;
  let scheduledBettingAuthExpiryMs: number | null = null;
  let bettingSourceEpoch = Date.now();
  let bettingSourceEpochInit: Promise<number> | null = null;
  let bettingSourceEpochReady = false;
  let nextBettingClientId = 1;
  let closed = false;
  let onStreamingCycleAborted: ((payload: unknown) => void) | null = null;
  let onStreamingResolutionStart: ((payload: unknown) => void) | null = null;
  let lastTerminalObservation: {
    identity: string;
    outcome: "draw" | "cancelled";
    reason: string;
    duelEndTime: number;
  } | null = null;

  const writeSseMessage = (
    reply: FastifyReply,
    message: string,
  ): SseSendStatus => {
    const raw = reply.raw;
    if (raw.destroyed || raw.writableEnded || !raw.writable) {
      return "closed";
    }
    if (raw.writableLength > maxPendingBytes) {
      return "slow";
    }

    try {
      raw.write(message);
      return "ok";
    } catch {
      return "error";
    }
  };

  const writeSseEvent = (
    reply: FastifyReply,
    event: string,
    data: string,
    id?: number,
  ): SseSendStatus => writeSseMessage(reply, formatSseEvent(event, data, id));

  const clearBettingAuthExpiry = (): void => {
    if (bettingAuthExpiryTimeout) {
      clearTimeout(bettingAuthExpiryTimeout);
      bettingAuthExpiryTimeout = null;
    }
    scheduledBettingAuthExpiryMs = null;
  };

  const refreshBettingClientAuthorizations = (
    currentTokenResolution: ReturnType<typeof resolveBettingFeedAccessToken>,
    nowMs: number,
  ): void => {
    for (const [clientId, client] of bettingClients.entries()) {
      const authorizationActive =
        client.authorization.kind === "development-bypass"
          ? !currentTokenResolution.token &&
            shouldSkipBettingFeedAuth(process.env)
          : resolveBettingFeedAuthorizationStatus(
              currentTokenResolution,
              client.authorization,
              nowMs,
            ).active;
      if (!authorizationActive) {
        removeBettingClient(clientId);
      }
    }
    scheduleBettingAuthExpiry(currentTokenResolution, nowMs);
  };

  const handleBettingAuthExpiry = (): void => {
    bettingAuthExpiryTimeout = null;
    scheduledBettingAuthExpiryMs = null;
    const nowMs = authNow();
    refreshBettingClientAuthorizations(
      resolveBettingFeedAccessToken(process.env, nowMs),
      nowMs,
    );
  };

  const scheduleBettingAuthExpiry = (
    resolution: ReturnType<typeof resolveBettingFeedAccessToken>,
    nowMs: number,
  ): void => {
    const expiryMs =
      resolution.rotationState === "active"
        ? resolution.previousTokenExpiresAtMs
        : null;
    if (expiryMs === null || bettingClients.size === 0) {
      clearBettingAuthExpiry();
      return;
    }
    if (bettingAuthExpiryTimeout && scheduledBettingAuthExpiryMs === expiryMs) {
      return;
    }
    clearBettingAuthExpiry();
    scheduledBettingAuthExpiryMs = expiryMs;
    const remainingMs = Math.max(0, expiryMs - nowMs);
    const timerDelayMs = Math.min(remainingMs, 2_147_000_000);
    bettingAuthExpiryTimeout = setTimeout(
      handleBettingAuthExpiry,
      timerDelayMs,
    );
  };

  const clearBettingLoops = (): void => {
    if (bettingPushInterval) {
      clearInterval(bettingPushInterval);
      bettingPushInterval = null;
    }
    if (bettingHeartbeatInterval) {
      clearInterval(bettingHeartbeatInterval);
      bettingHeartbeatInterval = null;
    }
    clearBettingAuthExpiry();
  };

  const closeRoutes = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (onStreamingCycleAborted) {
      world.off("streaming:cycle:aborted", onStreamingCycleAborted);
      onStreamingCycleAborted = null;
    }
    if (onStreamingResolutionStart) {
      world.off("streaming:resolution:start", onStreamingResolutionStart);
      onStreamingResolutionStart = null;
    }
    clearBettingLoops();
    externalStatusPoller?.release();
    for (const clientId of [...bettingClients.keys()]) {
      removeBettingClient(clientId);
    }
  };

  const removeBettingClient = (clientId: number): void => {
    const client = bettingClients.get(clientId);
    if (!client) return;

    bettingClients.delete(clientId);
    try {
      if (!client.reply.raw.writableEnded) {
        client.reply.raw.end();
      }
    } catch {
      // ignore socket close errors
    }

    if (bettingClients.size === 0) {
      clearBettingLoops();
    }
  };

  const getDatabaseSystem = (): DatabaseSystemLike | null =>
    (world.getSystem("database") ?? null) as DatabaseSystemLike | null;

  const persistBettingSourceEpoch = async (epoch: number): Promise<void> => {
    const db = getDatabaseSystem()?.getDb?.();
    if (!db) return;

    const value = JSON.stringify({
      sourceEpoch: epoch,
      updatedAt: Date.now(),
    });
    try {
      await db
        .insert(storage)
        .values({
          key: BETTING_SOURCE_EPOCH_STORAGE_KEY,
          value,
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: storage.key,
          set: {
            value,
            updatedAt: Date.now(),
          },
        });
    } catch {
      // Best-effort durability only.
    }
  };

  const ensureBettingSourceEpoch = async (): Promise<number> => {
    if (bettingSourceEpochReady) {
      return bettingSourceEpoch;
    }
    if (bettingSourceEpochInit) {
      return bettingSourceEpochInit;
    }

    bettingSourceEpochInit = (async () => {
      const db = getDatabaseSystem()?.getDb?.();
      if (!db) {
        bettingSourceEpochReady = true;
        return bettingSourceEpoch;
      }

      try {
        const rows = await db
          .select()
          .from(storage)
          .where(eq(storage.key, BETTING_SOURCE_EPOCH_STORAGE_KEY))
          .limit(1);
        const rawValue = rows[0]?.value ?? "";
        let parsedEpoch = Number.NaN;
        try {
          const parsed = JSON.parse(rawValue) as {
            sourceEpoch?: number;
          };
          parsedEpoch = Number(parsed?.sourceEpoch);
        } catch {
          // Stored value is not valid JSON — fall through to Date.now().
        }

        bettingSourceEpoch = Number.isFinite(parsedEpoch)
          ? Math.max(parsedEpoch + 1, Date.now())
          : Date.now();
        await persistBettingSourceEpoch(bettingSourceEpoch);
      } catch {
        bettingSourceEpoch = Date.now();
      }

      bettingSourceEpochReady = true;
      return bettingSourceEpoch;
    })();

    return bettingSourceEpochInit;
  };

  const currentRendererHealthSnapshot = (
    cycle: StreamingDuelCycle | null,
    nowMs?: number,
  ): BettingFeedRendererHealth =>
    deriveBettingRendererHealth(cycle, {
      externalStatusSnapshot: externalStatusPoller?.getSnapshot() ?? null,
      externalStatusMaxAgeMs,
      nowMs,
      captureStats: getStreamCaptureStats?.() ?? undefined,
    });

  const captureBettingFrame = (
    forceNewFrame = false,
    snapshot?: {
      cycle: StreamingDuelCycle;
      terminal?: BettingFeedTerminalOverride | null;
    },
  ): BettingFeedFrame | null => {
    const scheduler = getScheduler();
    const cycle = snapshot?.cycle ?? scheduler?.getCurrentCycle() ?? null;
    const nextSeq = bettingSequence + 1;
    const emittedAt = Date.now();
    const rendererHealth = currentRendererHealthSnapshot(cycle, emittedAt);
    const payload = buildBettingFeedPayload({
      sourceEpoch: bettingSourceEpoch,
      seq: nextSeq,
      emittedAt,
      cycle,
      rendererHealth,
      terminal: snapshot?.terminal ?? null,
    });
    const dedupKey = buildBettingFeedDedupKey(payload);

    if (
      !forceNewFrame &&
      dedupKey === lastSerializedBettingState &&
      bettingReplayFrames.length > 0
    ) {
      return null;
    }

    lastSerializedBettingState = dedupKey;
    bettingSequence = nextSeq;
    const payloadJson = JSON.stringify(payload);

    const frame: BettingFeedFrame = {
      seq: nextSeq,
      emittedAt: payload.emittedAt,
      payload,
      payloadJson,
      payloadBytes: Buffer.byteLength(payloadJson, "utf8"),
    };

    bettingReplayFrames.push(frame);
    bettingReplayFramesTotalBytes += frame.payloadBytes;
    bettingReplayFramesTotalBytes = trimReplayFrames(
      bettingReplayFrames,
      bettingReplayFramesTotalBytes,
      {
        maxFrames: replayBuffer,
        maxBytes: replayMaxBytes,
      },
    );

    return frame;
  };

  const broadcastBettingFrame = (frame: BettingFeedFrame): void => {
    const nowMs = authNow();
    const currentTokenResolution = resolveBettingFeedAccessToken(
      process.env,
      nowMs,
    );
    scheduleBettingAuthExpiry(currentTokenResolution, nowMs);
    for (const [clientId, client] of bettingClients.entries()) {
      const authorizationActive =
        client.authorization.kind === "development-bypass"
          ? !currentTokenResolution.token &&
            shouldSkipBettingFeedAuth(process.env)
          : isBettingFeedAuthorizationActive(
              currentTokenResolution,
              client.authorization,
              nowMs,
            );
      if (!authorizationActive) {
        removeBettingClient(clientId);
        continue;
      }
      const status = writeSseEvent(
        client.reply,
        "betting",
        frame.payloadJson,
        frame.seq,
      );
      if (status !== "ok") {
        removeBettingClient(clientId);
      }
    }
    lastBettingBroadcastSeq = frame.seq;
  };

  const captureCurrentBettingFrameForPoll = (): void => {
    const scheduler = getScheduler();
    if (!scheduler) return;
    latestBettingObservationAt = Date.now();
    const cycle = scheduler.getCurrentCycle() ?? null;
    const durableTerminal = (
      scheduler as typeof scheduler & {
        getDurableBettingTerminal?: () => {
          cycle: StreamingDuelCycle;
          terminal: BettingFeedTerminalOverride | null;
        } | null;
      }
    ).getDurableBettingTerminal?.();
    const latestFrame = bettingReplayFrames[bettingReplayFrames.length - 1];
    if (!cycle) {
      if (durableTerminal) {
        const latestMatchesTerminal =
          latestFrame?.payload.duelId === durableTerminal.cycle.duelId &&
          (latestFrame.payload.outcome === "win" ||
            latestFrame.payload.outcome === "draw" ||
            latestFrame.payload.outcome === "cancelled");
        if (!latestMatchesTerminal) {
          captureBettingFrame(false, durableTerminal);
        }
        return;
      }
      if (!latestFrame) captureBettingFrame(false);
      return;
    }

    const latestOutcome = latestFrame?.payload.outcome ?? null;
    const latestIsTerminal =
      latestOutcome === "win" ||
      latestOutcome === "draw" ||
      latestOutcome === "cancelled";
    if (
      latestIsTerminal &&
      latestFrame?.payload.duelId === cycle.duelId &&
      latestFrame.payload.duelKey === cycle.duelKeyHex
    ) {
      return;
    }
    captureBettingFrame(false);
  };

  const getRetainedTerminalFrame = (): BettingFeedFrame | null => {
    const frame = bettingReplayFrames[bettingReplayFrames.length - 1] ?? null;
    const payload = frame?.payload;
    const terminal =
      payload?.outcome === "win" ||
      payload?.outcome === "draw" ||
      payload?.outcome === "cancelled";
    if (
      !frame ||
      !terminal ||
      typeof payload.duelId !== "string" ||
      payload.duelId.length === 0 ||
      typeof payload.duelKey !== "string" ||
      payload.duelKey.length === 0 ||
      typeof payload.competitiveSnapshotDigest !== "string" ||
      payload.competitiveSnapshotDigest.length === 0
    ) {
      return null;
    }
    return frame;
  };

  const getAuthorityHealth =
    async (): Promise<StreamingBettingAuthorityHealth> => {
      await ensureBettingSourceEpoch();
      captureCurrentBettingFrameForPoll();

      const scheduler = getScheduler();
      const liveCycle = scheduler?.getCurrentCycle() ?? null;
      const durableTerminal = scheduler?.getDurableBettingTerminal?.() ?? null;
      const source = liveCycle
        ? { cycle: liveCycle, terminal: null }
        : durableTerminal;
      const cycle = source?.cycle ?? null;
      const authority = getAuthoritySnapshot();
      const snapshot = cycle?.competitiveSnapshot ?? null;
      const ready = Boolean(
        authority.verified &&
        authority.schedulerRunning &&
        cycle?.duelId &&
        cycle.duelKeyHex &&
        cycle.competitiveSnapshotDigest &&
        snapshot?.persisted === true &&
        snapshot.diagnostic === false,
      );

      return {
        ready,
        sourceEpoch: bettingSourceEpoch,
        duelId: cycle?.duelId ?? null,
        duelKeyHex: cycle?.duelKeyHex ?? null,
        snapshotDigest: cycle?.competitiveSnapshotDigest ?? null,
        phase: liveCycle?.phase ?? null,
        outcome: source?.terminal?.outcome ?? liveCycle?.outcome ?? null,
        cancellationReason: source?.terminal?.cancellationReason ?? null,
        competitiveSnapshotPersisted: snapshot?.persisted ?? false,
        competitiveSnapshotDiagnostic: snapshot?.diagnostic ?? null,
      };
    };

  const toTerminalFrame = (
    frame: BettingFeedFrame | undefined,
    input: { duelId: string; cancellationReason: string },
  ): StreamingBettingTerminalFrame | null => {
    const payload = frame?.payload;
    if (
      !frame ||
      payload?.duelId !== input.duelId ||
      payload.outcome !== "cancelled" ||
      payload.cancellationReason !== input.cancellationReason ||
      typeof payload.duelKey !== "string" ||
      payload.duelKey.length === 0 ||
      typeof payload.competitiveSnapshotDigest !== "string" ||
      payload.competitiveSnapshotDigest.length === 0
    ) {
      return null;
    }
    return {
      sourceEpoch: payload.sourceEpoch,
      terminalFrameSeq: frame.seq,
      duelId: payload.duelId,
      duelKeyHex: payload.duelKey,
      competitiveSnapshotDigest: payload.competitiveSnapshotDigest,
      outcome: "cancelled",
      cancellationReason: payload.cancellationReason,
    };
  };

  const waitForTerminalFrame = async (input: {
    duelId: string;
    cancellationReason: string;
    timeoutMs?: number;
  }): Promise<StreamingBettingTerminalFrame> => {
    const timeoutMs = input.timeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 20_000
    ) {
      throw new Error("terminal betting frame timeout must be 1..20000ms");
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      captureCurrentBettingFrameForPoll();
      const terminal = toTerminalFrame(
        bettingReplayFrames[bettingReplayFrames.length - 1],
        input,
      );
      if (terminal) return terminal;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Timed out waiting for terminal betting frame: duel=${input.duelId} reason=${input.cancellationReason}`,
    );
  };

  onStreamingCycleAborted = (payload: unknown): void => {
    const event = parseStreamingCycleAbortedEvent(payload);
    const scheduler = getScheduler();
    const liveCycle = scheduler?.getCurrentCycle() ?? null;
    const durableTerminal = scheduler?.getDurableBettingTerminal?.() ?? null;
    const cycleMatchesEvent = (candidate: StreamingDuelCycle | null): boolean =>
      Boolean(
        candidate &&
        (!event?.cycleId || event.cycleId === candidate.cycleId) &&
        (!event?.duelId || event.duelId === candidate.duelId),
      );
    const cycle = cycleMatchesEvent(liveCycle)
      ? liveCycle
      : cycleMatchesEvent(durableTerminal?.cycle ?? null)
        ? (durableTerminal?.cycle ?? null)
        : null;
    if (!event || !cycle) {
      fastify.log.warn(
        { payload },
        "Skipping terminal betting frame because the aborted cycle snapshot is unavailable",
      );
      return;
    }
    if (
      (event.cycleId && event.cycleId !== cycle.cycleId) ||
      (event.duelId && cycle.duelId && event.duelId !== cycle.duelId)
    ) {
      fastify.log.warn(
        {
          eventCycleId: event.cycleId,
          eventDuelId: event.duelId,
          activeCycleId: cycle.cycleId,
          activeDuelId: cycle.duelId,
        },
        "Skipping terminal betting frame for a mismatched aborted cycle",
      );
      return;
    }

    const outcome =
      cycle.outcome === "draw" || event.reason === "draw"
        ? "draw"
        : "cancelled";
    const identity = `${cycle.cycleId}:${cycle.duelId ?? ""}`;
    const observedDuelEndTime =
      lastTerminalObservation?.identity === identity &&
      lastTerminalObservation.outcome === outcome &&
      lastTerminalObservation.reason === event.reason
        ? lastTerminalObservation.duelEndTime
        : (durableTerminal?.terminal?.duelEndTime ??
          cycle.duelEndTime ??
          Date.now());
    lastTerminalObservation = {
      identity,
      outcome,
      reason: event.reason,
      duelEndTime: observedDuelEndTime,
    };
    const terminal: BettingFeedTerminalOverride = {
      outcome,
      cancellationReason: event.reason,
      duelEndTime: observedDuelEndTime,
    };
    const captureTerminalFrame = (): void => {
      if (closed) return;
      const frame = captureBettingFrame(false, { cycle, terminal });
      if (frame) broadcastBettingFrame(frame);
    };

    if (bettingSourceEpochReady) {
      captureTerminalFrame();
      return;
    }
    void ensureBettingSourceEpoch()
      .then(captureTerminalFrame)
      .catch((error: unknown) => {
        fastify.log.error(
          { error },
          "Failed to initialize betting source epoch for terminal frame",
        );
      });
  };
  world.on("streaming:cycle:aborted", onStreamingCycleAborted);
  onStreamingResolutionStart = (payload: unknown): void => {
    const event = parseStreamingResolutionStartEvent(payload);
    if (!event || event.outcome !== "win") return;

    const cycle = getScheduler()?.getCurrentCycle() ?? null;
    if (!cycle) {
      fastify.log.warn(
        { payload },
        "Skipping terminal win frame because the resolution cycle snapshot is unavailable",
      );
      return;
    }
    if (
      cycle.outcome !== "win" ||
      (event.cycleId && event.cycleId !== cycle.cycleId) ||
      (event.duelId && cycle.duelId && event.duelId !== cycle.duelId)
    ) {
      fastify.log.warn(
        {
          eventCycleId: event.cycleId,
          eventDuelId: event.duelId,
          activeCycleId: cycle.cycleId,
          activeDuelId: cycle.duelId,
          activeOutcome: cycle.outcome,
        },
        "Skipping terminal win frame for a mismatched resolution cycle",
      );
      return;
    }

    const captureWinFrame = (): void => {
      if (closed) return;
      const frame = captureBettingFrame(false, { cycle });
      if (frame) broadcastBettingFrame(frame);
    };

    if (bettingSourceEpochReady) {
      captureWinFrame();
      return;
    }
    void ensureBettingSourceEpoch()
      .then(captureWinFrame)
      .catch((error: unknown) => {
        fastify.log.error(
          { error },
          "Failed to initialize betting source epoch for terminal win frame",
        );
      });
  };
  world.on("streaming:resolution:start", onStreamingResolutionStart);
  void ensureBettingSourceEpoch();

  const startBettingLoopsIfNeeded = (): void => {
    if (bettingPushInterval) return;

    lastBettingBroadcastSeq =
      bettingReplayFrames[bettingReplayFrames.length - 1]?.seq ?? 0;

    bettingPushInterval = setInterval(() => {
      const frame = captureBettingFrame(false);
      if (!frame) return;
      broadcastBettingFrame(frame);
    }, pushIntervalMs);

    bettingHeartbeatInterval = setInterval(() => {
      const heartbeatMessage = `:hb ${Date.now()}\n\n`;
      const nowMs = authNow();
      const currentTokenResolution = resolveBettingFeedAccessToken(
        process.env,
        nowMs,
      );
      scheduleBettingAuthExpiry(currentTokenResolution, nowMs);
      for (const [clientId, client] of bettingClients.entries()) {
        const authorizationActive =
          client.authorization.kind === "development-bypass"
            ? !currentTokenResolution.token &&
              shouldSkipBettingFeedAuth(process.env)
            : isBettingFeedAuthorizationActive(
                currentTokenResolution,
                client.authorization,
                nowMs,
              );
        if (!authorizationActive) {
          removeBettingClient(clientId);
          continue;
        }
        const status = writeSseMessage(client.reply, heartbeatMessage);
        if (status === "ok") {
          continue;
        }
        removeBettingClient(clientId);
      }
    }, heartbeatMs);
  };

  const assertBettingAuth = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (
      !hasAllowedInternalBettingOrigin(request.headers.origin, allowedOrigin)
    ) {
      reply.status(403).send({
        error: "Forbidden",
        message: "Origin is not allowed for the internal betting feed",
      });
      return false;
    }

    const nowMs = authNow();
    const requiredTokens = resolveBettingFeedAccessToken(process.env, nowMs);
    refreshBettingClientAuthorizations(requiredTokens, nowMs);
    if (requiredTokens.configurationError) {
      reply.status(503).send({
        error: "Service unavailable",
        message: "Betting feed token rotation configuration is invalid",
      });
      return false;
    }
    if (!requiredTokens.token) {
      if (process.env.NODE_ENV === "production" || !skipAuth) {
        reply.status(503).send({
          error: "Service unavailable",
          message: "Betting feed auth token is not configured",
        });
        return false;
      }
      requestAuthorizations.set(request, {
        kind: "development-bypass",
        authorizedUntilMs: null,
      });
      return true;
    }

    const token = extractBettingFeedToken({
      authorizationHeader: request.headers.authorization,
    });

    const authorization = authorizeBettingFeedToken(
      requiredTokens,
      token,
      nowMs,
    );
    if (authorization) {
      requestAuthorizations.set(request, authorization);
      return true;
    }

    reply.status(401).send({
      error: "Unauthorized",
      message: "Missing or invalid betting feed token",
    });
    return false;
  };

  const buildBettingBootstrapResponse = (frame: BettingFeedFrame | null) => {
    const fallbackEmittedAt = Date.now();
    const fallbackPayload = buildBettingFeedPayload({
      sourceEpoch: bettingSourceEpoch,
      seq: bettingSequence,
      emittedAt: fallbackEmittedAt,
      cycle: null,
      rendererHealth: currentRendererHealthSnapshot(null, fallbackEmittedAt),
    });

    return {
      ...(frame?.payload ?? fallbackPayload),
      schemaVersion: BETTING_FEED_SCHEMA_VERSION,
      sourceEpoch: bettingSourceEpoch,
      seq: frame?.seq ?? bettingSequence,
      emittedAt: frame?.emittedAt ?? fallbackEmittedAt,
      replay: {
        sourceEpoch: bettingSourceEpoch,
        latestSeq:
          bettingReplayFrames[bettingReplayFrames.length - 1]?.seq ?? null,
        oldestSeq: bettingReplayFrames[0]?.seq ?? null,
        bufferedFrames: bettingReplayFrames.length,
        bufferedBytes: bettingReplayFramesTotalBytes,
        lastBroadcastSeq: lastBettingBroadcastSeq,
      },
    };
  };

  const bettingBootstrapAuthPreHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!(await assertBettingAuth(request, reply))) {
      return;
    }
  };

  const bettingEventsAuthPreHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!(await assertBettingAuth(request, reply))) {
      return;
    }
  };

  const handleBettingBootstrap = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const scheduler = getScheduler();
    // Graceful shutdown clears the scheduler singleton only after its exact
    // terminal frame has been captured. Keep that immutable frame available
    // long enough for the authenticated keeper to poll and acknowledge the
    // corresponding terminal market operation; never substitute a stale
    // nonterminal frame when no authority remains.
    if (!scheduler && !getRetainedTerminalFrame()) {
      return reply.status(503).send({
        error: "Streaming mode not active",
        message: "The streaming duel scheduler is not running",
      });
    }

    await ensureBettingSourceEpoch();
    captureCurrentBettingFrameForPoll();

    return reply.send(
      buildBettingBootstrapResponse(
        bettingReplayFrames[bettingReplayFrames.length - 1] ?? null,
      ),
    );
  };

  const handleBettingEvents = async (
    request: FastifyRequest<{ Querystring: { since?: string } }>,
    reply: FastifyReply,
  ) => {
    const authorization = requestAuthorizations.get(request);
    if (!authorization) {
      return reply.status(503).send({
        error: "Service unavailable",
        message: "Betting feed authorization context is unavailable",
      });
    }
    if (authorization.kind !== "development-bypass") {
      const nowMs = authNow();
      if (
        !isBettingFeedAuthorizationActive(
          resolveBettingFeedAccessToken(process.env, nowMs),
          authorization,
          nowMs,
        )
      ) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Betting feed token is no longer active",
        });
      }
    }
    const scheduler = getScheduler();
    if (!scheduler && !getRetainedTerminalFrame()) {
      return reply.status(503).send({
        error: "Streaming mode not active",
        message: "The streaming duel scheduler is not running",
      });
    }

    await ensureBettingSourceEpoch();
    captureCurrentBettingFrameForPoll();

    if (bettingClients.size >= maxClients) {
      return reply.status(503).send({
        error: "Bet sync SSE capacity reached",
        message: "Too many concurrent betting SSE clients",
      });
    }

    const raw = reply.raw;
    reply.hijack();

    raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    raw.setHeader("Cache-Control", "no-cache, no-transform");
    raw.setHeader("Connection", "keep-alive");
    raw.setHeader("X-Accel-Buffering", "no");
    if (allowedOrigin) {
      raw.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    }
    raw.socket?.setNoDelay?.(true);
    raw.socket?.setKeepAlive?.(true, heartbeatMs * 2);
    raw.flushHeaders?.();
    raw.write("retry: 2000\n\n");

    const allocation = allocateNextBettingClientId(
      nextBettingClientId,
      bettingClients.keys(),
    );
    nextBettingClientId = allocation.nextCursor;
    const clientId = allocation.clientId;
    bettingClients.set(clientId, { reply, authorization });
    const connectionAuthNowMs = authNow();
    scheduleBettingAuthExpiry(
      resolveBettingFeedAccessToken(process.env, connectionAuthNowMs),
      connectionAuthNowMs,
    );

    const delivery = selectReplayDelivery(
      bettingReplayFrames,
      parseReplayCursor(request),
    );
    if (delivery.mode === "reset") {
      const status = writeSseEvent(
        reply,
        "reset",
        delivery.latestFrame.payloadJson,
        delivery.latestFrame.seq,
      );
      if (status !== "ok") {
        removeBettingClient(clientId);
        return;
      }
    } else if (delivery.frames.length > 0) {
      for (const frame of delivery.frames) {
        const status = writeSseEvent(
          reply,
          "betting",
          frame.payloadJson,
          frame.seq,
        );
        if (status !== "ok") {
          removeBettingClient(clientId);
          return;
        }
      }
    } else if (delivery.mode === "bootstrap" && delivery.latestFrame) {
      const status = writeSseEvent(
        reply,
        "betting",
        delivery.latestFrame.payloadJson,
        delivery.latestFrame.seq,
      );
      if (status !== "ok") {
        removeBettingClient(clientId);
        return;
      }
    }

    request.raw.on("close", () => {
      removeBettingClient(clientId);
    });

    startBettingLoopsIfNeeded();
  };

  // Legacy compatibility alias. Canonical internal betting bootstrap route:
  // /api/internal/bet-sync/state
  fastify.get(
    "/api/streaming/betting/bootstrap",
    {
      config: { rateLimit: bootstrapRateLimit },
      preHandler: bettingBootstrapAuthPreHandler,
    },
    handleBettingBootstrap,
  );

  // Canonical internal betting bootstrap route.
  fastify.get(
    "/api/internal/bet-sync/state",
    {
      config: { rateLimit: bootstrapRateLimit },
      preHandler: bettingBootstrapAuthPreHandler,
    },
    handleBettingBootstrap,
  );

  // Exact internal source authority used by keepers and launch verification.
  // Keep this separate from the broad public/server health routes so a generic
  // process-level 200 can never be mistaken for an authoritative duel source.
  fastify.get(
    "/api/internal/bet-sync/authority-health",
    {
      config: { rateLimit: bootstrapRateLimit },
      preHandler: bettingBootstrapAuthPreHandler,
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const health = await getAuthorityHealth();
      return reply
        .status(health.ready ? 200 : 503)
        .header("Cache-Control", "no-store")
        .send(health);
    },
  );

  // Legacy compatibility alias. Canonical internal betting SSE route:
  // /api/internal/bet-sync/events
  fastify.get<{
    Querystring: { since?: string };
  }>(
    "/api/streaming/betting/events",
    {
      config: { rateLimit: eventsRateLimit },
      preHandler: bettingEventsAuthPreHandler,
    },
    handleBettingEvents,
  );

  // Canonical internal betting SSE route.
  fastify.get<{
    Querystring: { since?: string };
  }>(
    "/api/internal/bet-sync/events",
    {
      config: { rateLimit: eventsRateLimit },
      preHandler: bettingEventsAuthPreHandler,
    },
    handleBettingEvents,
  );

  // HTTP close is requested after the server's terminal/ACK barrier. End these
  // long-lived responses before Fastify waits for its HTTP server to close.
  fastify.addHook("preClose", async () => {
    closeRoutes();
  });

  return {
    close(): void {
      closeRoutes();
    },
    captureCurrentState(): void {
      captureCurrentBettingFrameForPoll();
    },
    getRendererHealth(): BettingFeedRendererHealth {
      return currentRendererHealthSnapshot(
        getScheduler()?.getCurrentCycle() ?? null,
      );
    },
    getMetrics(): BettingRouteMetrics {
      return {
        schemaVersion: BETTING_FEED_SCHEMA_VERSION,
        sourceEpoch: bettingSourceEpoch,
        clients: {
          connected: bettingClients.size,
        },
        replay: {
          size: bettingReplayFrames.length,
          totalBytes: bettingReplayFramesTotalBytes,
          oldestSeq: bettingReplayFrames[0]?.seq ?? null,
          latestSeq:
            bettingReplayFrames[bettingReplayFrames.length - 1]?.seq ?? null,
          latestEmittedAt:
            bettingReplayFrames[bettingReplayFrames.length - 1]?.emittedAt ??
            null,
          latestObservedAt: latestBettingObservationAt,
          lastBroadcastSeq: lastBettingBroadcastSeq,
        },
      };
    },
    getAuthorityHealth,
    waitForTerminalFrame,
  };
}
