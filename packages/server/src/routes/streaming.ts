/**
 * Streaming Mode API Routes
 *
 * Provides endpoints for streaming mode functionality:
 * - Leaderboard data
 * - Current duel state
 * - Streaming configuration
 * - RTMP bridge status
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RateLimitOptions } from "@fastify/rate-limit";
import type { World } from "@hyperforge/shared";
import { getStreamingDuelScheduler } from "../systems/StreamingDuelScheduler/index.js";
import { getStreamingDuelAuthoritySnapshot } from "../systems/StreamingDuelScheduler/authority.js";
import {
  STREAMING_TIMING,
  type StreamingPhase,
} from "../systems/StreamingDuelScheduler/types.js";
import { peekRTMPBridge } from "../streaming/index.js";
import { getStreamCapture } from "../streaming/stream-capture.js";
import {
  STREAMING_CANONICAL_PLATFORM,
  STREAMING_CANONICAL_SOURCE_URL,
  STREAMING_PUBLIC_DELAY_DEFAULT_MS,
  STREAMING_PUBLIC_DELAY_MS,
  STREAMING_PUBLIC_DELAY_OVERRIDDEN,
} from "../streaming/streaming-policy.js";
import {
  deriveBettingRendererHealth,
  loadExternalRtmpStatusSnapshot,
  registerStreamingBettingRoutes,
  type StreamingBettingAuthorityHealth,
  type StreamingBettingTerminalFrame,
} from "./streaming-betting-routes.js";
import {
  shouldDeliverSseFrame,
  trimReplayFrames,
} from "./streaming-sse-buffer.js";
import { getDefaultPublicWsUrl } from "../shared/public-ws-url.js";
import {
  evaluateStreamingRuntimeHealth,
  loadKeeperRuntimeObservation,
  resolveStreamingLiveAudioRequired,
} from "./streaming-runtime-health.js";
import { StreamingRuntimeAlertDispatcher } from "./streaming-runtime-alerts.js";
import { resolveStreamingRuntimeAlertConfig } from "./streaming-runtime-alert-config.js";
import { buildStreamingOperatorMetrics } from "./streaming-operator-metrics.js";
import {
  derivePublicBettingAvailability,
  sanitizePublicRecentDuel,
  sanitizePublicOperationalMetrics,
  sanitizePublicStreamingState,
} from "./streaming-public-presentation.js";
import { hasValidStreamingViewerAccessToken } from "../streaming/stream-viewer-access-token.js";
import type { DatabaseSystem } from "../systems/DatabaseSystem/index.js";
import { checkProjectileCostCustodyHealth } from "../startup/routes/health-routes.js";
type InventorySnapshotItem = {
  slot: number;
  itemId: string;
  quantity: number;
};

type ThoughtSnapshot = {
  id: string;
  type: string;
  content: string;
  timestamp: number;
};

type StreamingSseFrame = {
  seq: number;
  emittedAt: number;
  payload: string;
  payloadBytes: number;
};

type SseSendStatus = "ok" | "closed" | "slow" | "error";
type SseDropReason =
  | "client-close"
  | "shutdown"
  | "slow-consumer"
  | "write-failed"
  | "closed-socket";
type StreamingSseAudience = "all" | "authoritative" | "public";

export function shouldDeliverStreamingFrameToClient(
  audience: StreamingSseAudience,
  allowAuthoritativeState: boolean,
): boolean {
  if (audience === "all") return true;
  return audience === "authoritative"
    ? allowAuthoritativeState
    : !allowAuthoritativeState;
}

export function parseStreamingReplayFrameState(
  frame: Pick<StreamingSseFrame, "payload"> | null,
): {
  cycle: unknown;
  leaderboard: unknown;
  terminalNotice: unknown;
  cameraTarget: unknown;
} | null {
  if (!frame) return null;
  try {
    const parsed = JSON.parse(frame.payload) as {
      cycle?: unknown;
      leaderboard?: unknown;
      terminalNotice?: unknown;
      cameraTarget?: unknown;
    };
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.cycle || !Array.isArray(parsed.leaderboard)) return null;
    return {
      cycle: parsed.cycle,
      leaderboard: parsed.leaderboard,
      terminalNotice: parsed.terminalNotice ?? null,
      cameraTarget: parsed.cameraTarget ?? null,
    };
  } catch {
    return null;
  }
}

export function parseStreamingReplayFramePayload(
  frame: StreamingSseFrame | null,
): Record<string, unknown> | null {
  if (!frame) return null;
  try {
    const parsed = JSON.parse(frame.payload) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.seq !== frame.seq ||
      parsed.emittedAt !== frame.emittedAt
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const STREAMING_SSE_REPLAY_BUFFER = Math.max(
  128,
  Math.min(
    8192,
    Number.parseInt(process.env.STREAMING_SSE_REPLAY_BUFFER || "2048", 10),
  ),
);
const STREAMING_SSE_PUSH_INTERVAL_MS = Math.max(
  250,
  Number.parseInt(process.env.STREAMING_SSE_PUSH_INTERVAL_MS || "250", 10),
);
const STREAMING_SSE_HEARTBEAT_MS = Math.max(
  5000,
  Number.parseInt(process.env.STREAMING_SSE_HEARTBEAT_MS || "15000", 10),
);
const STREAMING_SSE_MAX_PENDING_BYTES = Math.max(
  128 * 1024,
  Math.min(
    16 * 1024 * 1024,
    Number.parseInt(
      process.env.STREAMING_SSE_MAX_PENDING_BYTES || "1048576",
      10,
    ),
  ),
);
const STREAMING_SSE_REPLAY_MAX_BYTES = Math.max(
  512 * 1024,
  Math.min(
    64 * 1024 * 1024,
    Number.parseInt(
      process.env.STREAMING_SSE_REPLAY_MAX_BYTES || `${32 * 1024 * 1024}`,
      10,
    ),
  ),
);
const STREAMING_SSE_MAX_CLIENTS = Math.max(
  4,
  Math.min(
    256,
    Number.parseInt(process.env.STREAMING_SSE_MAX_CLIENTS || "64", 10),
  ),
);
const EXTERNAL_RTMP_STATUS_FILE = (process.env.RTMP_STATUS_FILE || "").trim();
const EXTERNAL_RTMP_STATUS_MAX_AGE_MS = Math.max(
  5000,
  Number.parseInt(process.env.RTMP_STATUS_MAX_AGE_MS || "15000", 10),
);
const STREAMING_FEED_MAX_AGE_MS = Math.max(
  5_000,
  Number.parseInt(process.env.STREAMING_FEED_MAX_AGE_MS || "15000", 10),
);
const STREAMING_REQUIRE_LIVE_AUDIO = resolveStreamingLiveAudioRequired(
  process.env.STREAMING_REQUIRE_LIVE_AUDIO,
  process.env.NODE_ENV,
);
const STREAMING_KEEPER_HEALTH_URL =
  process.env.HYPERBET_KEEPER_HEALTH_URL?.trim() || null;
const STREAMING_KEEPER_HEALTH_TIMEOUT_MS = Math.max(
  250,
  Number.parseInt(process.env.STREAMING_KEEPER_HEALTH_TIMEOUT_MS || "2000", 10),
);
const STREAMING_KEEPER_HEALTH_MAX_AGE_MS = Math.max(
  5_000,
  Number.parseInt(
    process.env.STREAMING_KEEPER_HEALTH_MAX_AGE_MS || "30000",
    10,
  ),
);
const STREAMING_ALERT_CONFIG = resolveStreamingRuntimeAlertConfig(process.env);
const BETTING_BOOTSTRAP_RATE_LIMIT: RateLimitOptions = {
  max: 240,
  timeWindow: "1 minute",
};
const BETTING_EVENTS_RATE_LIMIT: RateLimitOptions = {
  max: 60,
  timeWindow: "1 minute",
};

function isStreamingDestinationConnected(
  destination: Record<string, unknown>,
): boolean {
  if (destination.connected === true) return true;
  const status =
    typeof destination.status === "string"
      ? destination.status.trim().toLowerCase()
      : "";
  return (
    status === "connected" || status === "streaming" || status === "healthy"
  );
}

function findStaleStreamingPhase(
  cycle: ReturnType<
    NonNullable<ReturnType<typeof getStreamingDuelScheduler>>["getCurrentCycle"]
  >,
  nowMs: number,
): { phase: string; phaseStartedAt: number } | null {
  if (!cycle) return null;
  const phaseMaxAgeMs: Partial<Record<StreamingPhase, number>> = {
    ANNOUNCEMENT: STREAMING_TIMING.ANNOUNCEMENT_DURATION + 10_000,
    COUNTDOWN: STREAMING_TIMING.COUNTDOWN_DURATION + 5_000,
    FIGHTING:
      STREAMING_TIMING.FIGHTING_DURATION +
      STREAMING_TIMING.END_WARNING_DURATION +
      10_000,
    RESOLUTION: STREAMING_TIMING.RESOLUTION_DURATION + 10_000,
  };
  const maxAgeMs = phaseMaxAgeMs[cycle.phase];
  return maxAgeMs !== undefined && nowMs - cycle.phaseStartTime > maxAgeMs
    ? { phase: cycle.phase, phaseStartedAt: cycle.phaseStartTime }
    : null;
}

function getInventorySnapshot(
  world: World,
  characterId: string,
): InventorySnapshotItem[] {
  const inventorySystem = world.getSystem("inventory") as
    | {
        getInventoryData?: (id: string) => {
          items: Array<{
            slot?: number;
            itemId?: string;
            quantity?: number;
          }>;
        };
        getInventory?: (id: string) => {
          items: Array<{
            slot?: number;
            itemId?: string;
            quantity?: number;
          }>;
        };
      }
    | undefined;

  const sourceItems =
    inventorySystem?.getInventoryData?.(characterId)?.items ??
    inventorySystem?.getInventory?.(characterId)?.items ??
    [];

  return sourceItems
    .map((item, index) => ({
      slot: item.slot ?? index,
      itemId: item.itemId ?? "unknown",
      quantity: item.quantity ?? 1,
    }))
    .sort((a, b) => a.slot - b.slot);
}

async function getThoughtsSnapshot(
  characterId: string,
  limit: number = 10,
): Promise<ThoughtSnapshot[]> {
  const { ServerNetwork } = await import("../systems/ServerNetwork/index.js");
  const thoughts =
    (
      ServerNetwork as {
        agentThoughts?: Map<string, ThoughtSnapshot[]>;
      }
    ).agentThoughts?.get(characterId) || [];

  return thoughts.slice(0, Math.max(1, Math.min(limit, 50)));
}

/**
 * Register streaming routes
 */
export function registerStreamingRoutes(
  fastify: FastifyInstance,
  world: World,
): StreamingRoutesRuntime {
  const sseClients = new Map<
    number,
    {
      reply: FastifyReply;
      lastDeliveredSeq: number;
      allowAuthoritativeState: boolean;
    }
  >();
  const replayFrames: StreamingSseFrame[] = [];
  let replayFramesTotalBytes = 0;
  const sseMetrics = {
    startedAt: Date.now(),
    totalConnected: 0,
    totalDisconnected: 0,
    peakConnected: 0,
    droppedSlowConsumers: 0,
    droppedWriteFailures: 0,
    droppedClosedSockets: 0,
    generatedFrames: 0,
    broadcastBatches: 0,
    deliveredLiveStateEvents: 0,
    deliveredReplayStateEvents: 0,
    deliveredBootstrapStateEvents: 0,
    deliveredReplayResetEvents: 0,
    deliveredUnavailableEvents: 0,
    heartbeatsSent: 0,
    heartbeatFailures: 0,
    lastFanoutDurationMs: 0,
    averageFanoutDurationMs: 0,
    maxFanoutDurationMs: 0,
    fanoutOver50Ms: 0,
    fanoutOver100Ms: 0,
  };
  let nextClientId = 1;
  let sequence = 0;
  let lastSerializedState = "";
  let lastBroadcastSeq = 0;
  let statePushInterval: ReturnType<typeof setInterval> | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  const bettingRoutes = registerStreamingBettingRoutes({
    fastify,
    world,
    replayBuffer: STREAMING_SSE_REPLAY_BUFFER,
    replayMaxBytes: STREAMING_SSE_REPLAY_MAX_BYTES,
    pushIntervalMs: STREAMING_SSE_PUSH_INTERVAL_MS,
    heartbeatMs: STREAMING_SSE_HEARTBEAT_MS,
    maxPendingBytes: STREAMING_SSE_MAX_PENDING_BYTES,
    maxClients: Math.max(
      4,
      Math.min(
        128,
        Number.parseInt(process.env.BETTING_SSE_MAX_CLIENTS || "32", 10),
      ),
    ),
    bootstrapRateLimit: BETTING_BOOTSTRAP_RATE_LIMIT,
    eventsRateLimit: BETTING_EVENTS_RATE_LIMIT,
    internalAllowedOrigin:
      process.env.INTERNAL_BET_SYNC_ALLOWED_ORIGIN?.trim() || null,
    externalStatusFile: EXTERNAL_RTMP_STATUS_FILE || null,
    externalStatusMaxAgeMs: EXTERNAL_RTMP_STATUS_MAX_AGE_MS,
  });

  const withPublicRendererHealth = <T extends { cycle: object }>(
    state: T,
  ): T & {
    cycle: T["cycle"] & {
      rendererHealth: ReturnType<typeof bettingRoutes.getRendererHealth>;
    };
  } => ({
    ...state,
    cycle: {
      ...state.cycle,
      rendererHealth: bettingRoutes.getRendererHealth(),
    },
  });

  const formatSseEvent = (event: string, data: string, id?: number): string => {
    const normalizedData = data.replace(/\n/g, "\ndata: ");
    const idLine = typeof id === "number" ? `id: ${id}\n` : "";
    return `${idLine}event: ${event}\ndata: ${normalizedData}\n\n`;
  };

  const writeSseMessage = (
    reply: FastifyReply,
    message: string,
  ): SseSendStatus => {
    const raw = reply.raw;
    if (raw.destroyed || raw.writableEnded) {
      return "closed";
    }
    if (raw.writableLength > STREAMING_SSE_MAX_PENDING_BYTES) {
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

  const removeSseClient = (
    clientId: number,
    reason: SseDropReason = "client-close",
  ): void => {
    const client = sseClients.get(clientId);
    if (!client) return;

    sseClients.delete(clientId);
    sseMetrics.totalDisconnected += 1;
    if (reason === "slow-consumer") sseMetrics.droppedSlowConsumers += 1;
    if (reason === "write-failed") sseMetrics.droppedWriteFailures += 1;
    if (reason === "closed-socket") sseMetrics.droppedClosedSockets += 1;

    try {
      if (!client.reply.raw.writableEnded) {
        client.reply.raw.end();
      }
    } catch {
      // ignore socket close errors
    }
    if (sseClients.size === 0) {
      if (statePushInterval) {
        clearInterval(statePushInterval);
        statePushInterval = null;
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      // When delayed mode is disabled, replay is only needed for active SSE
      // clients; drop it aggressively to keep dev memory bounded.
      if (STREAMING_PUBLIC_DELAY_MS <= 0 && replayFrames.length > 0) {
        replayFrames.length = 0;
        replayFramesTotalBytes = 0;
      }
    }
  };

  const removeSseClientForStatus = (
    clientId: number,
    status: SseSendStatus,
  ): void => {
    if (status === "slow") {
      removeSseClient(clientId, "slow-consumer");
      return;
    }
    if (status === "error") {
      removeSseClient(clientId, "write-failed");
      return;
    }
    removeSseClient(clientId, "closed-socket");
  };

  const recordFanoutDuration = (durationMs: number): void => {
    sseMetrics.lastFanoutDurationMs = durationMs;
    sseMetrics.maxFanoutDurationMs = Math.max(
      sseMetrics.maxFanoutDurationMs,
      durationMs,
    );
    const batches = sseMetrics.broadcastBatches;
    sseMetrics.averageFanoutDurationMs =
      batches <= 1
        ? durationMs
        : (sseMetrics.averageFanoutDurationMs * (batches - 1) + durationMs) /
          batches;
    if (durationMs >= 50) sseMetrics.fanoutOver50Ms += 1;
    if (durationMs >= 100) sseMetrics.fanoutOver100Ms += 1;
  };

  const pushFrame = (
    event: string,
    frame: StreamingSseFrame,
    audience: StreamingSseAudience = "all",
  ): void => {
    const startedAt = Date.now();
    const message = formatSseEvent(event, frame.payload, frame.seq);
    sseMetrics.broadcastBatches += 1;
    let delivered = 0;
    for (const [clientId, client] of sseClients.entries()) {
      if (
        !shouldDeliverStreamingFrameToClient(
          audience,
          client.allowAuthoritativeState,
        )
      ) {
        continue;
      }
      if (!shouldDeliverSseFrame(client.lastDeliveredSeq, frame.seq)) {
        continue;
      }
      const status = writeSseMessage(client.reply, message);
      if (status !== "ok") {
        removeSseClientForStatus(clientId, status);
        continue;
      }
      client.lastDeliveredSeq = frame.seq;
      delivered += 1;
    }
    sseMetrics.deliveredLiveStateEvents += delivered;
    recordFanoutDuration(Date.now() - startedAt);
  };

  const getFirstReplayIndexAfter = (seqValue: number): number => {
    let low = 0;
    let high = replayFrames.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (replayFrames[mid].seq <= seqValue) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  };

  const getOldestEligibleReplayFrame = (
    nowMs: number = Date.now(),
    allowAuthoritativeState = false,
  ): StreamingSseFrame | null => {
    if (replayFrames.length === 0) return null;
    if (allowAuthoritativeState || STREAMING_PUBLIC_DELAY_MS <= 0) {
      return replayFrames[0];
    }

    const cutoff = nowMs - STREAMING_PUBLIC_DELAY_MS;
    for (let index = 0; index < replayFrames.length; index += 1) {
      const frame = replayFrames[index];
      if (frame.emittedAt <= cutoff) return frame;
    }
    return null;
  };

  const getLatestEligibleReplayFrame = (
    nowMs: number = Date.now(),
    allowAuthoritativeState = false,
  ): StreamingSseFrame | null => {
    if (replayFrames.length === 0) return null;
    if (allowAuthoritativeState || STREAMING_PUBLIC_DELAY_MS <= 0)
      return replayFrames[replayFrames.length - 1];

    const cutoff = nowMs - STREAMING_PUBLIC_DELAY_MS;
    for (let index = replayFrames.length - 1; index >= 0; index -= 1) {
      const frame = replayFrames[index];
      if (frame.emittedAt <= cutoff) return frame;
    }
    return null;
  };

  const getEligibleReplayFramesAfter = (
    seqValue: number,
    nowMs: number = Date.now(),
    allowAuthoritativeState = false,
  ): StreamingSseFrame[] => {
    const startIndex = getFirstReplayIndexAfter(seqValue);
    if (startIndex >= replayFrames.length) return [];
    if (allowAuthoritativeState || STREAMING_PUBLIC_DELAY_MS <= 0) {
      return replayFrames.slice(startIndex);
    }

    const cutoff = nowMs - STREAMING_PUBLIC_DELAY_MS;
    const frames: StreamingSseFrame[] = [];
    for (let index = startIndex; index < replayFrames.length; index += 1) {
      const frame = replayFrames[index];
      if (frame.emittedAt > cutoff) break;
      frames.push(frame);
    }
    return frames;
  };

  const getPublicStreamingState = (
    scheduler: NonNullable<ReturnType<typeof getStreamingDuelScheduler>>,
    allowAuthoritativeState = false,
  ): ReturnType<typeof scheduler.getStreamingState> | null => {
    if (allowAuthoritativeState || STREAMING_PUBLIC_DELAY_MS <= 0) {
      return withPublicRendererHealth(
        sanitizePublicStreamingState(scheduler.getStreamingState()),
      );
    }

    // Keep delayed replay frames fresh for REST polling consumers
    // even when no SSE clients are connected.
    if (!statePushInterval) {
      captureStreamingFrame(false);
    }

    if (replayFrames.length === 0) {
      captureStreamingFrame(true);
    }

    const delayed = parseStreamingReplayFrameState(
      getLatestEligibleReplayFrame(),
    );
    if (!delayed) return null;

    return withPublicRendererHealth({
      type: "STREAMING_STATE_UPDATE" as const,
      cycle: delayed.cycle as ReturnType<
        typeof scheduler.getStreamingState
      >["cycle"],
      leaderboard: delayed.leaderboard as ReturnType<
        typeof scheduler.getStreamingState
      >["leaderboard"],
      terminalNotice: (delayed.terminalNotice ?? null) as ReturnType<
        typeof scheduler.getStreamingState
      >["terminalNotice"],
      cameraTarget:
        typeof delayed.cameraTarget === "string" ||
        delayed.cameraTarget === null
          ? delayed.cameraTarget
          : null,
    });
  };

  const captureStreamingFrame = (
    forceNewFrame = false,
  ): StreamingSseFrame | null => {
    const scheduler = getStreamingDuelScheduler();
    if (!scheduler) return null;

    const publicState = withPublicRendererHealth(
      sanitizePublicStreamingState(scheduler.getStreamingState()),
    );
    const serialized = JSON.stringify(publicState);
    if (
      !forceNewFrame &&
      serialized === lastSerializedState &&
      replayFrames.length > 0
    ) {
      return null;
    }

    lastSerializedState = serialized;
    sequence += 1;

    const emittedAt = Date.now();
    const payload = JSON.stringify({
      ...publicState,
      type: "STREAMING_STATE_UPDATE",
      seq: sequence,
      emittedAt,
    });
    const frame: StreamingSseFrame = {
      seq: sequence,
      emittedAt,
      payload,
      payloadBytes: Buffer.byteLength(payload, "utf8"),
    };

    replayFrames.push(frame);
    replayFramesTotalBytes += frame.payloadBytes;
    sseMetrics.generatedFrames += 1;

    replayFramesTotalBytes = trimReplayFrames(
      replayFrames,
      replayFramesTotalBytes,
      {
        maxFrames: STREAMING_SSE_REPLAY_BUFFER,
        maxBytes: STREAMING_SSE_REPLAY_MAX_BYTES,
      },
    );

    return frame;
  };

  const startSseLoopsIfNeeded = (): void => {
    if (statePushInterval) return;

    lastBroadcastSeq = getLatestEligibleReplayFrame()?.seq ?? 0;

    statePushInterval = setInterval(() => {
      const frame = captureStreamingFrame(false);
      if (STREAMING_PUBLIC_DELAY_MS <= 0) {
        if (frame) {
          pushFrame("state", frame);
          lastBroadcastSeq = frame.seq;
        }
        return;
      }

      // Internal consumers authenticated with the viewer-access token need
      // the same current timeline that the authorized REST route exposes.
      // Public clients continue to receive only delay-eligible frames below.
      if (frame) {
        pushFrame("state", frame, "authoritative");
      }

      const eligibleFrames = getEligibleReplayFramesAfter(lastBroadcastSeq);
      for (const eligibleFrame of eligibleFrames) {
        pushFrame("state", eligibleFrame, "public");
        lastBroadcastSeq = eligibleFrame.seq;
      }
    }, STREAMING_SSE_PUSH_INTERVAL_MS);

    heartbeatInterval = setInterval(() => {
      const heartbeatMessage = `:hb ${Date.now()}\n\n`;
      for (const [clientId, client] of sseClients.entries()) {
        const status = writeSseMessage(client.reply, heartbeatMessage);
        if (status === "ok") {
          sseMetrics.heartbeatsSent += 1;
          continue;
        }
        sseMetrics.heartbeatFailures += 1;
        removeSseClientForStatus(clientId, status);
      }
    }, STREAMING_SSE_HEARTBEAT_MS);
  };

  // Graceful shutdown reaches HTTP close after its terminal/ACK barrier.
  // Active SSE responses must end before Fastify waits for HTTP close; onClose
  // runs too late and would depend on downstream clients disconnecting first.
  fastify.addHook("preClose", (done) => {
    if (statePushInterval) {
      clearInterval(statePushInterval);
      statePushInterval = null;
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    for (const clientId of [...sseClients.keys()]) {
      removeSseClient(clientId, "shutdown");
    }
    bettingRoutes.close();
    done();
  });

  // Get current streaming state
  fastify.get(
    "/api/streaming/state",
    {
      config: { rateLimit: false },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const scheduler = getStreamingDuelScheduler();

      if (!scheduler) {
        return reply.status(503).send({
          error: "Streaming mode not active",
          message: "The streaming duel scheduler is not running",
        });
      }

      // REST polling and SSE replay must expose the same authoritative cursor.
      // Publishing a cursor-less live snapshot here would force downstream
      // consumers to invent sequence/timestamp values and then reject valid
      // replay frames as regressions.
      const capturedFrame = captureStreamingFrame(false);
      const bypassPublicDelay =
        STREAMING_PUBLIC_DELAY_MS <= 0 ||
        hasValidStreamingViewerAccessToken(request.headers.authorization);
      if (capturedFrame) {
        if (STREAMING_PUBLIC_DELAY_MS <= 0) {
          pushFrame("state", capturedFrame);
          lastBroadcastSeq = capturedFrame.seq;
        } else {
          pushFrame("state", capturedFrame, "authoritative");
        }
      }
      const frame = bypassPublicDelay
        ? (replayFrames[replayFrames.length - 1] ?? null)
        : getLatestEligibleReplayFrame();
      const state = parseStreamingReplayFramePayload(frame);
      if (!state) {
        return reply.status(503).send({
          error: "Streaming delay warmup",
          message: `Delayed streaming state is not yet available (${STREAMING_PUBLIC_DELAY_MS}ms delay window)`,
        });
      }
      return reply.send(state);
    },
  );

  fastify.get(
    "/api/streaming/metrics",
    {
      config: { rateLimit: false },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const bettingMetrics = bettingRoutes.getMetrics();
      const scheduler = getStreamingDuelScheduler();
      return reply.send({
        type: "STREAMING_METRICS",
        emittedAt: Date.now(),
        uptimeMs: Date.now() - sseMetrics.startedAt,
        sse: {
          config: {
            replayBuffer: STREAMING_SSE_REPLAY_BUFFER,
            pushIntervalMs: STREAMING_SSE_PUSH_INTERVAL_MS,
            heartbeatMs: STREAMING_SSE_HEARTBEAT_MS,
            maxPendingBytes: STREAMING_SSE_MAX_PENDING_BYTES,
            publicDelayMs: STREAMING_PUBLIC_DELAY_MS,
            canonicalPlatform: STREAMING_CANONICAL_PLATFORM,
            canonicalSourceUrl: STREAMING_CANONICAL_SOURCE_URL,
            publicDelayDefaultMs: STREAMING_PUBLIC_DELAY_DEFAULT_MS,
            publicDelayOverridden: STREAMING_PUBLIC_DELAY_OVERRIDDEN,
          },
          clients: {
            connected: sseClients.size,
            peakConnected: sseMetrics.peakConnected,
            totalConnected: sseMetrics.totalConnected,
            totalDisconnected: sseMetrics.totalDisconnected,
            droppedSlowConsumers: sseMetrics.droppedSlowConsumers,
            droppedWriteFailures: sseMetrics.droppedWriteFailures,
            droppedClosedSockets: sseMetrics.droppedClosedSockets,
          },
          replay: {
            size: replayFrames.length,
            totalBytes: replayFramesTotalBytes,
            oldestSeq: replayFrames[0]?.seq ?? null,
            latestSeq: replayFrames[replayFrames.length - 1]?.seq ?? null,
          },
          events: {
            generatedFrames: sseMetrics.generatedFrames,
            broadcastBatches: sseMetrics.broadcastBatches,
            deliveredLiveStateEvents: sseMetrics.deliveredLiveStateEvents,
            deliveredReplayStateEvents: sseMetrics.deliveredReplayStateEvents,
            deliveredBootstrapStateEvents:
              sseMetrics.deliveredBootstrapStateEvents,
            deliveredReplayResetEvents: sseMetrics.deliveredReplayResetEvents,
            deliveredUnavailableEvents: sseMetrics.deliveredUnavailableEvents,
            heartbeatsSent: sseMetrics.heartbeatsSent,
            heartbeatFailures: sseMetrics.heartbeatFailures,
          },
          fanout: {
            lastDurationMs: sseMetrics.lastFanoutDurationMs,
            averageDurationMs: Number(
              sseMetrics.averageFanoutDurationMs.toFixed(3),
            ),
            maxDurationMs: sseMetrics.maxFanoutDurationMs,
            batchesOver50Ms: sseMetrics.fanoutOver50Ms,
            batchesOver100Ms: sseMetrics.fanoutOver100Ms,
          },
        },
        betting: {
          schemaVersion: bettingMetrics.schemaVersion,
          sourceEpoch: bettingMetrics.sourceEpoch,
          clients: bettingMetrics.clients,
          replay: bettingMetrics.replay,
        },
        duels: scheduler
          ? sanitizePublicOperationalMetrics(scheduler.getOperationalMetrics())
          : null,
      });
    },
  );

  const sampleStreamingRuntimeHealth = async () => {
    const nowMs = Date.now();
    const scheduler = getStreamingDuelScheduler();
    const schedulerAuthority = getStreamingDuelAuthoritySnapshot();
    bettingRoutes.captureCurrentState();
    const bettingMetrics = bettingRoutes.getMetrics();
    const captureStats = getStreamCapture().getStats();
    const externalStatus = await loadExternalRtmpStatusSnapshot(
      EXTERNAL_RTMP_STATUS_FILE || null,
      EXTERNAL_RTMP_STATUS_MAX_AGE_MS,
      { allowStale: true },
    );
    const externalStatusFresh = Boolean(
      externalStatus &&
      externalStatus.updatedAt > 0 &&
      nowMs - externalStatus.updatedAt <= EXTERNAL_RTMP_STATUS_MAX_AGE_MS,
    );
    const inProcessBridge = peekRTMPBridge();
    const inProcessBridgeStatus = inProcessBridge?.getStatus() ?? null;
    const inProcessBridgeStats = inProcessBridge?.getStats() ?? null;
    const destinations = externalStatusFresh
      ? (externalStatus?.destinations ?? [])
      : (inProcessBridgeStatus?.destinations ?? []);
    const deliveryConfigured = destinations.length > 0;
    const deliveryHealthy =
      deliveryConfigured &&
      destinations.every((destination) =>
        isStreamingDestinationConnected(destination as Record<string, unknown>),
      );
    const currentCycle = scheduler?.getCurrentCycle() ?? null;
    const renderer = deriveBettingRendererHealth(currentCycle, {
      externalStatusSnapshot: externalStatus,
      externalStatusMaxAgeMs: EXTERNAL_RTMP_STATUS_MAX_AGE_MS,
      nowMs,
      captureStats,
    });
    const databaseSystem = world.getSystem("database") as
      DatabaseSystem | undefined;
    const [keeper, projectileCostCustody] = await Promise.all([
      loadKeeperRuntimeObservation({
        url: STREAMING_KEEPER_HEALTH_URL,
        timeoutMs: STREAMING_KEEPER_HEALTH_TIMEOUT_MS,
      }),
      checkProjectileCostCustodyHealth(databaseSystem),
    ]);
    const health = evaluateStreamingRuntimeHealth({
      nowMs,
      schedulerRunning:
        scheduler != null && schedulerAuthority.schedulerRunning,
      schedulerAuthorityVerified: schedulerAuthority.verified,
      schedulerAuthorityObservedAt: schedulerAuthority.renewedAt,
      // A valid betting state can remain semantically unchanged for longer
      // than the health freshness window. Measure successful source
      // observation, not the timestamp of the last deduplicated payload.
      feedObservedAt: bettingMetrics.replay.latestObservedAt,
      feedMaxAgeMs: STREAMING_FEED_MAX_AGE_MS,
      renderer,
      captureClientConnected: externalStatusFresh
        ? externalStatus?.stats.clientConnected === true
        : captureStats.clientConnected,
      encoderRunning: externalStatusFresh
        ? externalStatus?.stats.ffmpegRunning === true
        : captureStats.ffmpegRunning,
      encoderHealthy: externalStatusFresh
        ? externalStatus?.stats.healthy === true
        : captureStats.ffmpegRunning && captureStats.clientConnected,
      audioRequired: STREAMING_REQUIRE_LIVE_AUDIO,
      audioSource: externalStatusFresh
        ? (externalStatus?.stats.audioSource ?? null)
        : (inProcessBridgeStatus?.audioSource ?? null),
      audioHealthy: externalStatusFresh
        ? externalStatus?.stats.audioHealthy === true
        : inProcessBridgeStatus?.audioHealthy === true,
      deliveryConfigured,
      deliveryHealthy,
      deliveryObservedAt: externalStatusFresh
        ? (externalStatus?.updatedAt ?? null)
        : inProcessBridgeStatus
          ? nowMs
          : null,
      keeper,
      keeperMaxAgeMs: STREAMING_KEEPER_HEALTH_MAX_AGE_MS,
      projectileCostCustody,
    });
    const droppedFrames = Number(
      externalStatusFresh
        ? (externalStatus?.stats.droppedFrames ?? 0)
        : (inProcessBridgeStats?.droppedFrames ?? 0),
    );
    const normalizedDroppedFrames = Number.isFinite(droppedFrames)
      ? droppedFrames
      : 0;
    const operatorMetrics = buildStreamingOperatorMetrics({
      nowMs,
      health,
      rendererPerformance: externalStatusFresh
        ? (externalStatus?.rendererPerformance ?? null)
        : null,
      captureHealth: externalStatusFresh
        ? (externalStatus?.captureHealth ?? null)
        : null,
      encoderFps: externalStatusFresh
        ? (externalStatus?.stats.fps ?? null)
        : null,
      droppedFrames: normalizedDroppedFrames,
    });
    return {
      health,
      rendererPerformance: externalStatusFresh
        ? (externalStatus?.rendererPerformance ?? null)
        : null,
      operatorMetrics,
      projectileCostCustody,
      keeperReasons: keeper.reasons,
      keeperCorrelationIds: keeper.correlationIds,
      droppedFrames: normalizedDroppedFrames,
      stalePhase: findStaleStreamingPhase(currentCycle, nowMs),
    };
  };

  const runtimeAlerts = new StreamingRuntimeAlertDispatcher({
    webhookUrl: STREAMING_ALERT_CONFIG.webhookUrl,
    routeId: STREAMING_ALERT_CONFIG.routeId,
    reminderMs: STREAMING_ALERT_CONFIG.reminderMs,
    retryMs: STREAMING_ALERT_CONFIG.retryMs,
    timeoutMs: STREAMING_ALERT_CONFIG.timeoutMs,
  });
  let runtimeMonitorInFlight = false;
  let runtimeMonitorInterval: ReturnType<typeof setInterval> | null = null;
  if (runtimeAlerts.isEnabled()) {
    runtimeMonitorInterval = setInterval(() => {
      if (runtimeMonitorInFlight) return;
      runtimeMonitorInFlight = true;
      void sampleStreamingRuntimeHealth()
        .then((observation) => runtimeAlerts.observe(observation))
        .catch((error) => {
          fastify.log.error(
            { error },
            "streaming runtime health monitor failed",
          );
        })
        .finally(() => {
          runtimeMonitorInFlight = false;
        });
    }, STREAMING_ALERT_CONFIG.monitorIntervalMs);
    runtimeMonitorInterval.unref?.();
  }
  fastify.addHook("onClose", async () => {
    if (runtimeMonitorInterval) {
      clearInterval(runtimeMonitorInterval);
      runtimeMonitorInterval = null;
    }
  });

  fastify.get(
    "/api/streaming/health",
    {
      config: { rateLimit: false },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const { health, rendererPerformance, operatorMetrics } =
        await sampleStreamingRuntimeHealth();
      return reply
        .status(health.ready ? 200 : 503)
        .header("Cache-Control", "no-store")
        .send({
          type: "STREAMING_RUNTIME_HEALTH",
          ...health,
          rendererPerformance,
          operatorMetrics,
        });
    },
  );

  // SSE push endpoint with replay support (Last-Event-ID / ?since=)
  fastify.get<{
    Querystring: { since?: string };
  }>(
    "/api/streaming/state/events",
    {
      config: { rateLimit: false },
    },
    async (request, reply) => {
      if (sseClients.size >= STREAMING_SSE_MAX_CLIENTS) {
        return reply.status(503).send({
          error: "Streaming SSE capacity reached",
          message: "Too many concurrent streaming SSE clients",
        });
      }

      const raw = reply.raw;
      reply.hijack();

      raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      raw.setHeader("Cache-Control", "no-cache, no-transform");
      raw.setHeader("Connection", "keep-alive");
      raw.setHeader("X-Accel-Buffering", "no");
      raw.setHeader("Access-Control-Allow-Origin", "*");
      raw.socket?.setNoDelay?.(true);
      raw.socket?.setKeepAlive?.(true, STREAMING_SSE_HEARTBEAT_MS * 2);
      raw.flushHeaders?.();
      raw.write("retry: 2000\n\n");

      const headerLastEventId = request.headers["last-event-id"];
      const normalizedHeaderId = Array.isArray(headerLastEventId)
        ? headerLastEventId[0]
        : headerLastEventId;
      const querySince = Number.parseInt(request.query.since || "", 10);
      const headerSince = Number.parseInt(normalizedHeaderId || "", 10);
      const lastSeenSeq = Number.isFinite(querySince)
        ? querySince
        : Number.isFinite(headerSince)
          ? headerSince
          : 0;
      const allowAuthoritativeState =
        STREAMING_PUBLIC_DELAY_MS <= 0 ||
        hasValidStreamingViewerAccessToken(request.headers.authorization);
      const clientId = nextClientId++;
      const client = {
        reply,
        lastDeliveredSeq: Math.max(0, lastSeenSeq),
        allowAuthoritativeState,
      };
      sseClients.set(clientId, client);
      sseMetrics.totalConnected += 1;
      sseMetrics.peakConnected = Math.max(
        sseMetrics.peakConnected,
        sseClients.size,
      );

      if (replayFrames.length === 0) {
        captureStreamingFrame(true);
      }

      const oldestSeq =
        getOldestEligibleReplayFrame(Date.now(), allowAuthoritativeState)
          ?.seq ?? 0;
      const latestFrame = getLatestEligibleReplayFrame(
        Date.now(),
        allowAuthoritativeState,
      );

      if (lastSeenSeq > 0 && latestFrame) {
        if (lastSeenSeq < oldestSeq || lastSeenSeq > latestFrame.seq) {
          // A replay gap or future client cursor requires an exact reset.
          const status = writeSseEvent(
            reply,
            "reset",
            latestFrame.payload,
            latestFrame.seq,
          );
          if (status !== "ok") {
            removeSseClientForStatus(clientId, status);
            return;
          }
          client.lastDeliveredSeq = latestFrame.seq;
          sseMetrics.deliveredReplayResetEvents += 1;
        } else {
          let deliveredReplayFrames = 0;
          const replayFramesForClient = getEligibleReplayFramesAfter(
            lastSeenSeq,
            Date.now(),
            allowAuthoritativeState,
          );
          for (const frame of replayFramesForClient) {
            const status = writeSseEvent(
              reply,
              "state",
              frame.payload,
              frame.seq,
            );
            if (status !== "ok") {
              removeSseClientForStatus(clientId, status);
              return;
            }
            client.lastDeliveredSeq = frame.seq;
            deliveredReplayFrames += 1;
          }
          sseMetrics.deliveredReplayStateEvents += deliveredReplayFrames;
        }
      } else if (latestFrame) {
        const status = writeSseEvent(
          reply,
          "state",
          latestFrame.payload,
          latestFrame.seq,
        );
        if (status !== "ok") {
          removeSseClientForStatus(clientId, status);
          return;
        }
        client.lastDeliveredSeq = latestFrame.seq;
        sseMetrics.deliveredBootstrapStateEvents += 1;
      } else {
        // No eligible delayed frame can validate a reconnect cursor yet. Start
        // live delivery from the first frame that becomes publicly eligible.
        client.lastDeliveredSeq = 0;
        const status = writeSseEvent(
          reply,
          "unavailable",
          JSON.stringify({
            error:
              STREAMING_PUBLIC_DELAY_MS > 0
                ? "Delayed stream warming up"
                : "Streaming mode not active",
            message:
              STREAMING_PUBLIC_DELAY_MS > 0
                ? `No delayed frame available yet (${STREAMING_PUBLIC_DELAY_MS}ms delay window)`
                : "The streaming duel scheduler is not running",
            emittedAt: Date.now(),
          }),
        );
        if (status !== "ok") {
          removeSseClientForStatus(clientId, status);
          return;
        }
        sseMetrics.deliveredUnavailableEvents += 1;
      }

      request.raw.on("close", () => {
        removeSseClient(clientId, "client-close");
      });

      startSseLoopsIfNeeded();
    },
  );

  // Get enriched duel context (state + inventories + internal monologues)
  fastify.get(
    "/api/streaming/duel-context",
    {
      config: { rateLimit: false },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const scheduler = getStreamingDuelScheduler();
      if (!scheduler) {
        return reply.status(503).send({
          error: "Streaming mode not active",
          message: "The streaming duel scheduler is not running",
        });
      }

      const state = getPublicStreamingState(scheduler);
      if (!state) {
        return reply.status(503).send({
          error: "Streaming delay warmup",
          message: `Delayed duel context is not yet available (${STREAMING_PUBLIC_DELAY_MS}ms delay window)`,
        });
      }
      const includeDetailedAgentTelemetry = STREAMING_PUBLIC_DELAY_MS <= 0;
      const enrichAgent = async (
        agent: {
          id: string;
          name: string;
          provider: string;
          model: string;
          hp: number;
          maxHp: number;
          combatLevel: number;
          wins: number;
          losses: number;
          damageDealtThisFight: number;
        } | null,
      ) => {
        if (!agent) return null;
        return {
          ...agent,
          inventory: includeDetailedAgentTelemetry
            ? getInventorySnapshot(world, agent.id)
            : [],
          monologues: includeDetailedAgentTelemetry
            ? await getThoughtsSnapshot(agent.id, 10)
            : [],
        };
      };

      return reply.send({
        type: "STREAMING_DUEL_CONTEXT",
        cycle: {
          ...state.cycle,
          agent1: await enrichAgent(state.cycle.agent1),
          agent2: await enrichAgent(state.cycle.agent2),
        },
        leaderboard: state.leaderboard,
        cameraTarget: state.cameraTarget,
      });
    },
  );

  fastify.get<{
    Params: { characterId: string };
    Querystring: { limit?: string };
  }>(
    "/api/streaming/agent/:characterId/monologues",
    {
      config: { rateLimit: false },
    },
    async (request, reply) => {
      if (STREAMING_PUBLIC_DELAY_MS > 0) {
        return reply.send({
          characterId: request.params.characterId,
          thoughts: [],
          count: 0,
          delayed: true,
        });
      }
      const limit = Number.parseInt(request.query.limit || "20", 10);
      const thoughts = await getThoughtsSnapshot(
        request.params.characterId,
        limit,
      );
      return reply.send({
        characterId: request.params.characterId,
        thoughts,
        count: thoughts.length,
      });
    },
  );

  fastify.get<{
    Params: { characterId: string };
  }>(
    "/api/streaming/agent/:characterId/inventory",
    {
      config: { rateLimit: false },
    },
    async (request, reply) => {
      if (STREAMING_PUBLIC_DELAY_MS > 0) {
        return reply.send({
          characterId: request.params.characterId,
          inventory: [],
          count: 0,
          delayed: true,
        });
      }
      const inventory = getInventorySnapshot(world, request.params.characterId);
      return reply.send({
        characterId: request.params.characterId,
        inventory,
        count: inventory.length,
      });
    },
  );

  // Get leaderboard
  fastify.get(
    "/api/streaming/leaderboard",
    {
      config: { rateLimit: false },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const scheduler = getStreamingDuelScheduler();

      if (!scheduler) {
        return reply.status(503).send({
          error: "Streaming mode not active",
          message: "The streaming duel scheduler is not running",
        });
      }

      const state = getPublicStreamingState(scheduler);
      if (!state) {
        return reply.status(503).send({
          error: "Streaming delay warmup",
          message: `Delayed leaderboard is not yet available (${STREAMING_PUBLIC_DELAY_MS}ms delay window)`,
        });
      }

      return reply.send({ leaderboard: state.leaderboard });
    },
  );

  // Get leaderboard + current duel cycle + recent duel history
  fastify.get<{
    Querystring: { historyLimit?: string };
  }>(
    "/api/streaming/leaderboard/details",
    {
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const scheduler = getStreamingDuelScheduler();

      if (!scheduler) {
        return reply.status(503).send({
          error: "Streaming mode not active",
          message: "The streaming duel scheduler is not running",
        });
      }

      const parsedLimit = Number.parseInt(
        request.query.historyLimit || "40",
        10,
      );
      const historyLimit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(parsedLimit, 200))
        : 40;

      const state = getPublicStreamingState(scheduler);
      if (!state) {
        return reply.status(503).send({
          error: "Streaming delay warmup",
          message: `Delayed leaderboard details are not yet available (${STREAMING_PUBLIC_DELAY_MS}ms delay window)`,
        });
      }

      const cutoff =
        STREAMING_PUBLIC_DELAY_MS > 0
          ? Date.now() - STREAMING_PUBLIC_DELAY_MS
          : Number.POSITIVE_INFINITY;
      const recentDuels = scheduler
        .getRecentDuels(historyLimit)
        .filter((duel) => duel.finishedAt <= cutoff)
        .map(sanitizePublicRecentDuel);
      const delayedUpdatedAt =
        STREAMING_PUBLIC_DELAY_MS > 0
          ? (getLatestEligibleReplayFrame()?.emittedAt ?? Date.now())
          : Date.now();

      return reply.send({
        leaderboard: state.leaderboard,
        cycle: state.cycle,
        terminalNotice: state.terminalNotice,
        recentDuels,
        updatedAt: delayedUpdatedAt,
      });
    },
  );

  // Get streaming configuration
  fastify.get(
    "/api/streaming/config",
    {
      config: { rateLimit: false },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const betUrl =
        (process.env.STREAMING_PUBLIC_BET_URL || "").trim() || null;
      const schedulerAuthority = getStreamingDuelAuthoritySnapshot();
      return reply.send({
        enabled: process.env.STREAMING_DUEL_ENABLED !== "false",
        timingContractVersion: STREAMING_TIMING.CONTRACT_VERSION,
        timeoutPolicy: STREAMING_TIMING.TIMEOUT_POLICY,
        preparationDuration: STREAMING_TIMING.PREPARATION_DURATION,
        cycleDuration: STREAMING_TIMING.CYCLE_DURATION,
        announcementDuration: STREAMING_TIMING.ANNOUNCEMENT_DURATION,
        countdownTicks: STREAMING_TIMING.COUNTDOWN_TICKS,
        countdownDuration: STREAMING_TIMING.COUNTDOWN_DURATION,
        fightDuration: STREAMING_TIMING.FIGHTING_DURATION,
        endWarningDuration: STREAMING_TIMING.END_WARNING_DURATION,
        maxFightDuration: STREAMING_TIMING.MAX_FIGHT_DURATION,
        resolutionDuration: STREAMING_TIMING.RESOLUTION_DURATION,
        interCycleDelay: STREAMING_TIMING.INTER_CYCLE_DELAY_MS,
        stateBroadcastInterval: STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
        fightBroadcastInterval: STREAMING_TIMING.FIGHT_BROADCAST_INTERVAL,
        canonicalPlatform: STREAMING_CANONICAL_PLATFORM,
        canonicalSourceUrl: STREAMING_CANONICAL_SOURCE_URL,
        publicDelayMs: STREAMING_PUBLIC_DELAY_MS,
        publicDelayDefaultMs: STREAMING_PUBLIC_DELAY_DEFAULT_MS,
        publicDelayOverridden: STREAMING_PUBLIC_DELAY_OVERRIDDEN,
        wsUrl: process.env.PUBLIC_WS_URL || getDefaultPublicWsUrl(),
        betUrl,
        bettingBridgeEnabled: process.env.DUEL_BETTING_ENABLED === "true",
        schedulerRole: schedulerAuthority.role,
        localSchedulerAuthorityVerified: schedulerAuthority.verified,
      });
    },
  );

  /**
   * Public betting CTA for stream overlays (no secrets).
   * Set STREAMING_PUBLIC_BET_URL to your prediction-market / wallet-connect page.
   */
  fastify.get(
    "/api/streaming/betting",
    {
      config: { rateLimit: false },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const betUrl =
        (process.env.STREAMING_PUBLIC_BET_URL || "").trim() || null;
      const bettingBridgeEnabled = process.env.DUEL_BETTING_ENABLED === "true";
      const runtime = await sampleStreamingRuntimeHealth();
      const { ready, unavailableReason } = derivePublicBettingAvailability({
        betUrl,
        bettingBridgeEnabled,
        runtimeReady: runtime.health.ready,
      });
      return reply.send({
        configured: betUrl != null,
        betUrl: ready ? betUrl : null,
        bettingBridgeEnabled,
        ready,
        unavailableReason,
        checkedAt: runtime.health.emittedAt,
        hint: ready
          ? "Wagers lock at the announced deadline. Pick a side before the bell."
          : null,
      });
    },
  );

  // Get RTMP bridge status
  fastify.get(
    "/api/streaming/rtmp/status",
    {
      config: { rateLimit: false },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const externalSnapshot = await loadExternalRtmpStatusSnapshot(
        EXTERNAL_RTMP_STATUS_FILE || null,
        EXTERNAL_RTMP_STATUS_MAX_AGE_MS,
      );
      if (externalSnapshot) {
        return reply.send(externalSnapshot);
      }

      try {
        const bridge = peekRTMPBridge();
        if (!bridge) {
          return reply.status(503).send({
            error: "RTMP bridge unavailable",
            message: "The RTMP streaming bridge has not been started",
          });
        }
        const status = bridge.getStatus();
        const stats = bridge.getStats();

        return reply.send({
          ...status,
          stats: {
            bytesReceived: stats.bytesReceived,
            bytesReceivedMB: (stats.bytesReceived / 1024 / 1024).toFixed(2),
            uptimeSeconds: Math.floor(stats.uptime / 1000),
            destinations: stats.destinations,
            healthy: stats.healthy,
            droppedFrames: stats.droppedFrames,
            backpressured: stats.backpressured,
            spectators: stats.spectators,
            processMemory: stats.processMemory,
          },
          rendererHealth: deriveBettingRendererHealth(
            getStreamingDuelScheduler()?.getCurrentCycle() ?? null,
            {
              externalStatusSnapshot: externalSnapshot,
              externalStatusMaxAgeMs: EXTERNAL_RTMP_STATUS_MAX_AGE_MS,
            },
          ),
        });
      } catch {
        return reply.status(503).send({
          error: "RTMP bridge not initialized",
          message: "The RTMP streaming bridge has not been started",
        });
      }
    },
  );

  // Get stream capture status (headless browser → HLS pipeline)
  fastify.get(
    "/api/streaming/capture/status",
    {
      config: { rateLimit: false },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const capture = getStreamCapture();
        const externalSnapshot = await loadExternalRtmpStatusSnapshot(
          EXTERNAL_RTMP_STATUS_FILE || null,
          EXTERNAL_RTMP_STATUS_MAX_AGE_MS,
          { allowStale: true },
        );
        return reply.send({
          ...capture.getStats(),
          rendererPerformance: externalSnapshot?.rendererPerformance ?? null,
          rendererHealth: deriveBettingRendererHealth(
            getStreamingDuelScheduler()?.getCurrentCycle() ?? null,
            {
              externalStatusSnapshot: externalSnapshot,
              externalStatusMaxAgeMs: EXTERNAL_RTMP_STATUS_MAX_AGE_MS,
            },
          ),
        });
      } catch {
        return reply.status(503).send({
          error: "Stream capture not initialized",
          message: "The stream capture pipeline has not been started",
        });
      }
    },
  );

  return {
    getBettingAuthorityHealth: () => bettingRoutes.getAuthorityHealth(),
    waitForBettingTerminalFrame: (input) =>
      bettingRoutes.waitForTerminalFrame(input),
  };
}

export type StreamingRoutesRuntime = {
  getBettingAuthorityHealth(): Promise<StreamingBettingAuthorityHealth>;
  waitForBettingTerminalFrame(input: {
    duelId: string;
    cancellationReason: string;
    timeoutMs?: number;
  }): Promise<StreamingBettingTerminalFrame>;
};
