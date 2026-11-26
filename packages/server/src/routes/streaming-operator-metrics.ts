import type { StreamingRuntimeHealth } from "./streaming-runtime-health.js";

const RUNTIME_CHECKS = [
  "schedulerAuthority",
  "bettingFeed",
  "renderer",
  "captureClient",
  "encoder",
  "audio",
  "rtmpDelivery",
  "keeper",
  "projectileCostCustody",
] as const satisfies readonly (keyof StreamingRuntimeHealth["checks"])[];

type RuntimeCheckName = (typeof RUNTIME_CHECKS)[number];

export type StreamingOperatorMetrics = {
  schemaVersion: 1;
  observedAtMs: number;
  ready: boolean;
  agesMs: Record<RuntimeCheckName, number | null>;
  frames: {
    rendererSamples: number;
    rendererEstimatedFps: number | null;
    rendererFrameIntervalP95Ms: number | null;
    rendererFrameWorkP95Ms: number | null;
    rendererLongFrameCount: number;
    captureTargetFps: number | null;
    captureMeasuredFps: number | null;
    encoderReportedFps: number | null;
    droppedFrames: number;
  };
};

type RendererPerformanceInput = {
  overall: {
    frames: number;
    frameIntervalMs: { average: number; p95: number };
    frameWorkMs: { p95: number };
  };
  longFrames: readonly unknown[];
};

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function safeCount(value: unknown): number {
  const normalized = finiteNonNegative(value);
  return normalized === null ? 0 : Math.floor(normalized);
}

function roundedMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function ageMs(nowMs: number, observedAt: number | null): number | null {
  const normalized = finiteNonNegative(observedAt);
  return normalized === null ? null : Math.max(0, nowMs - normalized);
}

export function buildStreamingOperatorMetrics(input: {
  nowMs: number;
  health: StreamingRuntimeHealth;
  rendererPerformance: RendererPerformanceInput | null;
  captureHealth:
    { targetFps: number; measuredFps: number | null } | null | undefined;
  encoderFps: number | null | undefined;
  droppedFrames: number;
}): StreamingOperatorMetrics {
  const observedAtMs = finiteNonNegative(input.nowMs);
  if (observedAtMs === null) {
    throw new Error("streaming operator observation time is invalid");
  }
  const rendererSamples = safeCount(input.rendererPerformance?.overall.frames);
  const averageFrameIntervalMs = finiteNonNegative(
    input.rendererPerformance?.overall.frameIntervalMs.average,
  );
  const rendererEstimatedFps =
    rendererSamples > 0 &&
    averageFrameIntervalMs !== null &&
    averageFrameIntervalMs > 0
      ? roundedMetric(1_000 / averageFrameIntervalMs)
      : null;

  const agesMs = {} as Record<RuntimeCheckName, number | null>;
  for (const checkName of RUNTIME_CHECKS) {
    agesMs[checkName] = ageMs(
      observedAtMs,
      input.health.checks[checkName].observedAt,
    );
  }

  return {
    schemaVersion: 1,
    observedAtMs,
    ready: input.health.ready,
    agesMs,
    frames: {
      rendererSamples,
      rendererEstimatedFps,
      rendererFrameIntervalP95Ms: finiteNonNegative(
        input.rendererPerformance?.overall.frameIntervalMs.p95,
      ),
      rendererFrameWorkP95Ms: finiteNonNegative(
        input.rendererPerformance?.overall.frameWorkMs.p95,
      ),
      rendererLongFrameCount: safeCount(
        input.rendererPerformance?.longFrames.length,
      ),
      captureTargetFps: finiteNonNegative(input.captureHealth?.targetFps),
      captureMeasuredFps: finiteNonNegative(input.captureHealth?.measuredFps),
      encoderReportedFps: finiteNonNegative(input.encoderFps),
      droppedFrames: safeCount(input.droppedFrames),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableMetric(value: unknown): value is number | null {
  return value === null || finiteNonNegative(value) !== null;
}

export function parseStreamingOperatorMetrics(
  value: unknown,
): StreamingOperatorMetrics | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isCount(value.observedAtMs) ||
    typeof value.ready !== "boolean"
  ) {
    return null;
  }
  if (!isRecord(value.agesMs) || !isRecord(value.frames)) return null;
  const agesMs = value.agesMs;
  if (
    RUNTIME_CHECKS.some((checkName) => !isNullableMetric(agesMs[checkName]))
  ) {
    return null;
  }
  const frames = value.frames;
  if (
    !isCount(frames.rendererSamples) ||
    !isNullableMetric(frames.rendererEstimatedFps) ||
    !isNullableMetric(frames.rendererFrameIntervalP95Ms) ||
    !isNullableMetric(frames.rendererFrameWorkP95Ms) ||
    !isCount(frames.rendererLongFrameCount) ||
    !isNullableMetric(frames.captureTargetFps) ||
    !isNullableMetric(frames.captureMeasuredFps) ||
    !isNullableMetric(frames.encoderReportedFps) ||
    !isCount(frames.droppedFrames)
  ) {
    return null;
  }
  if (
    (frames.rendererSamples === 0) !== (frames.rendererEstimatedFps === null) ||
    frames.rendererLongFrameCount > frames.rendererSamples
  ) {
    return null;
  }
  return value as unknown as StreamingOperatorMetrics;
}
