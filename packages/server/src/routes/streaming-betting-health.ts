import type { StreamingGuardrailPhase } from "@hyperforge/shared";
import {
  deriveStreamingGuardrailReason,
  isActiveStreamingGuardrailPhase,
} from "@hyperforge/shared";
import type { StreamingDuelCycle } from "../systems/StreamingDuelScheduler/types.js";
import { getStreamCapture } from "../streaming/stream-capture.js";
import type {
  BettingFeedRendererDerivation,
  BettingFeedRendererHealth,
} from "./streaming-betting-feed.js";
import type { ExternalRtmpStatusSnapshot } from "./streaming-external-status.js";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeRendererHealthSnapshot(
  value: unknown,
): BettingFeedRendererHealth | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return {
    ready: candidate.ready === true,
    degradedReason: asString(candidate.degradedReason),
    updatedAt: asFiniteNumber(candidate.updatedAt),
  };
}

function deriveCycleGuardrailReason(
  cycle: StreamingDuelCycle | null,
): string | null {
  if (!cycle) {
    return null;
  }
  return deriveStreamingGuardrailReason({
    phase: cycle.phase as StreamingGuardrailPhase | null | undefined,
    agent1: cycle.agent1
      ? {
          id: cycle.agent1.characterId,
          name: cycle.agent1.name,
          hp: cycle.agent1.currentHp,
          maxHp: cycle.agent1.maxHp,
        }
      : null,
    agent2: cycle.agent2
      ? {
          id: cycle.agent2.characterId,
          name: cycle.agent2.name,
          hp: cycle.agent2.currentHp,
          maxHp: cycle.agent2.maxHp,
        }
      : null,
    arenaPositions: cycle.arenaPositions,
  });
}

function deriveBettingRendererHealthValue(
  cycle: StreamingDuelCycle | null,
  options?: {
    externalStatusSnapshot?: ExternalRtmpStatusSnapshot | null;
    externalStatusMaxAgeMs?: number;
    nowMs?: number;
    captureStats?: {
      clientConnected: boolean;
      ffmpegRunning: boolean;
    };
  },
  observeCaptureStats?: (stats: {
    clientConnected: boolean;
    ffmpegRunning: boolean;
  }) => void,
): BettingFeedRendererHealth {
  const updatedAt = options?.nowMs ?? Date.now();
  const guardrailReason = deriveCycleGuardrailReason(cycle);
  if (guardrailReason) {
    return {
      ready: false,
      degradedReason: guardrailReason,
      updatedAt,
    };
  }

  const externalSnapshot = options?.externalStatusSnapshot ?? null;
  const externalRendererHealth = normalizeRendererHealthSnapshot(
    externalSnapshot?.rendererHealth,
  );
  if (externalRendererHealth) {
    const ageMs =
      externalRendererHealth.updatedAt != null
        ? Math.max(0, updatedAt - externalRendererHealth.updatedAt)
        : null;
    if (
      externalRendererHealth.updatedAt != null &&
      ageMs != null &&
      ageMs > (options?.externalStatusMaxAgeMs ?? 15_000)
    ) {
      return {
        ready: false,
        degradedReason: "renderer_health_stale",
        updatedAt,
      };
    }
    if (
      externalRendererHealth.ready &&
      isActiveStreamingGuardrailPhase(cycle?.phase as StreamingGuardrailPhase)
    ) {
      if (externalSnapshot?.stats?.clientConnected === false) {
        return {
          ready: false,
          degradedReason: "capture_client_disconnected",
          updatedAt,
        };
      }
      if (externalSnapshot?.stats?.ffmpegRunning === false) {
        return {
          ready: false,
          degradedReason: "capture_pipeline_inactive",
          updatedAt,
        };
      }
      const scene =
        externalSnapshot?.rendererHealth?.diagnostics?.sceneReadiness;
      if (!scene || !cycle) {
        return {
          ready: false,
          degradedReason: "renderer_scene_evidence_missing",
          updatedAt,
        };
      }
      if (!scene.ready) {
        return {
          ready: false,
          degradedReason: "renderer_scene_not_ready",
          updatedAt,
        };
      }
      if (scene.cycleId !== cycle.cycleId) {
        return {
          ready: false,
          degradedReason: "renderer_cycle_mismatch",
          updatedAt,
        };
      }
      if (
        scene.phase !== cycle.phase ||
        externalSnapshot?.rendererHealth?.phase !== cycle.phase
      ) {
        return {
          ready: false,
          degradedReason: "renderer_phase_mismatch",
          updatedAt,
        };
      }
    }
    return externalRendererHealth;
  }

  const captureStats = options?.captureStats ?? getStreamCapture().getStats();
  observeCaptureStats?.(captureStats);
  if (
    isActiveStreamingGuardrailPhase(cycle?.phase as StreamingGuardrailPhase)
  ) {
    if (!captureStats.clientConnected) {
      return {
        ready: false,
        degradedReason: "capture_client_disconnected",
        updatedAt,
      };
    }
    if (!captureStats.ffmpegRunning) {
      return {
        ready: false,
        degradedReason: "capture_pipeline_inactive",
        updatedAt,
      };
    }
  }

  return {
    ready: true,
    degradedReason: null,
    updatedAt,
  };
}

function diagnosticTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function diagnosticToken(value: unknown, limit: number): string | null {
  return typeof value === "string" &&
    value.length <= limit &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : null;
}

function diagnosticBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Snapshot the same inputs synchronously; diagnostics do not affect authority. */
export function deriveBettingRendererHealth(
  cycle: StreamingDuelCycle | null,
  options?: Parameters<typeof deriveBettingRendererHealthValue>[1],
): BettingFeedRendererHealth {
  const evaluatedAtMs = options?.nowMs ?? Date.now();
  let observedCaptureStats: {
    clientConnected: boolean;
    ffmpegRunning: boolean;
  } | null = null;
  const health = deriveBettingRendererHealthValue(
    cycle,
    { ...options, nowMs: evaluatedAtMs },
    (stats) => {
      observedCaptureStats = stats;
    },
  );
  const snapshot = options?.externalStatusSnapshot;
  const renderer = snapshot?.rendererHealth;
  const scene = renderer?.diagnostics?.sceneReadiness;
  const transport = renderer ? snapshot?.stats : observedCaptureStats;
  const derivation: BettingFeedRendererDerivation = {
    schemaVersion: 1,
    evaluatedAtMs: diagnosticTimestamp(evaluatedAtMs),
    canonicalCycleId: diagnosticToken(cycle?.cycleId, 128),
    canonicalPhase: diagnosticToken(cycle?.phase, 32),
    externalSnapshotPresent: snapshot != null,
    externalSnapshotUpdatedAt: diagnosticTimestamp(snapshot?.updatedAt),
    rendererPresent: renderer != null,
    rendererReady: diagnosticBoolean(renderer?.ready),
    rendererPhase: diagnosticToken(renderer?.phase, 32),
    rendererDegradedReason: diagnosticToken(renderer?.degradedReason, 128),
    rendererUpdatedAt: diagnosticTimestamp(renderer?.updatedAt),
    scenePresent: scene != null,
    sceneReady: diagnosticBoolean(scene?.ready),
    sceneCycleId: diagnosticToken(scene?.cycleId, 128),
    scenePhase: diagnosticToken(scene?.phase, 32),
    captureClientConnected: diagnosticBoolean(transport?.clientConnected),
    captureFfmpegRunning: diagnosticBoolean(transport?.ffmpegRunning),
  };
  return { ...health, derivation };
}
