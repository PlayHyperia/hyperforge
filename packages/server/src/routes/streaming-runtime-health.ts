export type StreamingRuntimeCheck = {
  ready: boolean;
  reason: string | null;
  observedAt: number | null;
};

export type KeeperRuntimeObservation = {
  configured: boolean;
  ready: boolean;
  observedAt: number | null;
  error: string | null;
  reasons: string[];
  correlationIds: string[];
};

const DUEL_CORRELATION_ID = /^[0-9a-f]{64}$/u;

function keeperReadinessReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((reason): reason is string => typeof reason === "string")
        .map((reason) => reason.trim())
        .filter(Boolean)
        .slice(0, 64),
    ),
  ];
}

function keeperCorrelationIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (correlationId): correlationId is string =>
          typeof correlationId === "string" &&
          DUEL_CORRELATION_ID.test(correlationId),
      ),
    ),
  ]
    .sort()
    .slice(0, 64);
}

export type StreamingRuntimeHealth = {
  ready: boolean;
  emittedAt: number;
  checks: {
    schedulerAuthority: StreamingRuntimeCheck;
    bettingFeed: StreamingRuntimeCheck;
    renderer: StreamingRuntimeCheck;
    captureClient: StreamingRuntimeCheck;
    encoder: StreamingRuntimeCheck;
    audio: StreamingRuntimeCheck;
    rtmpDelivery: StreamingRuntimeCheck;
    keeper: StreamingRuntimeCheck;
    projectileCostCustody: StreamingRuntimeCheck;
  };
};

function check(
  ready: boolean,
  reason: string,
  observedAt: number | null,
): StreamingRuntimeCheck {
  return {
    ready,
    reason: ready ? null : reason,
    observedAt,
  };
}

export function evaluateStreamingRuntimeHealth(input: {
  nowMs: number;
  schedulerRunning: boolean;
  schedulerAuthorityVerified: boolean;
  schedulerAuthorityObservedAt: number | null;
  feedObservedAt: number | null;
  feedMaxAgeMs: number;
  renderer: {
    ready: boolean;
    degradedReason: string | null;
    updatedAt: number | null;
  };
  captureClientConnected: boolean;
  encoderRunning: boolean;
  encoderHealthy: boolean;
  audioRequired: boolean;
  audioSource: "uninitialized" | "browser" | "pulse" | "silent" | null;
  audioHealthy: boolean;
  deliveryConfigured: boolean;
  deliveryHealthy: boolean;
  deliveryObservedAt: number | null;
  keeper: KeeperRuntimeObservation;
  keeperMaxAgeMs: number;
  projectileCostCustody: {
    healthy: boolean;
    status:
      | "healthy"
      | "processing"
      | "stalled"
      | "invalid"
      | "unavailable"
      | "timeout";
  };
}): StreamingRuntimeHealth {
  const feedAgeMs =
    input.feedObservedAt == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.nowMs - input.feedObservedAt);
  const keeperAgeMs =
    input.keeper.observedAt == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.nowMs - input.keeper.observedAt);

  const checks: StreamingRuntimeHealth["checks"] = {
    schedulerAuthority: check(
      input.schedulerRunning && input.schedulerAuthorityVerified,
      input.schedulerRunning
        ? "scheduler_leadership_unverified"
        : "scheduler_authority_unavailable",
      input.schedulerAuthorityObservedAt,
    ),
    bettingFeed: check(
      feedAgeMs <= input.feedMaxAgeMs,
      input.feedObservedAt == null
        ? "betting_feed_uninitialized"
        : "betting_feed_stale",
      input.feedObservedAt,
    ),
    renderer: check(
      input.renderer.ready,
      input.renderer.degradedReason ?? "renderer_not_ready",
      input.renderer.updatedAt,
    ),
    captureClient: check(
      input.captureClientConnected,
      "capture_client_disconnected",
      input.deliveryObservedAt,
    ),
    encoder: check(
      input.encoderRunning && input.encoderHealthy,
      input.encoderRunning ? "encoder_unhealthy" : "encoder_not_running",
      input.deliveryObservedAt,
    ),
    audio: check(
      !input.audioRequired ||
        ((input.audioSource === "pulse" || input.audioSource === "browser") &&
          input.audioHealthy),
      input.audioSource === "silent"
        ? "stream_audio_silent_fallback"
        : input.audioSource === "browser" || input.audioSource === "pulse"
          ? "stream_audio_source_stale"
          : "stream_audio_source_unavailable",
      input.deliveryObservedAt,
    ),
    rtmpDelivery: check(
      input.deliveryConfigured && input.deliveryHealthy,
      input.deliveryConfigured
        ? "rtmp_destination_unhealthy"
        : "rtmp_destination_unconfigured",
      input.deliveryObservedAt,
    ),
    keeper: check(
      input.keeper.configured &&
        input.keeper.ready &&
        !input.keeper.error &&
        keeperAgeMs <= input.keeperMaxAgeMs,
      !input.keeper.configured
        ? "keeper_health_unconfigured"
        : input.keeper.error
          ? "keeper_health_unavailable"
          : keeperAgeMs > input.keeperMaxAgeMs
            ? "keeper_health_stale"
            : "keeper_not_ready",
      input.keeper.observedAt,
    ),
    projectileCostCustody: check(
      input.projectileCostCustody.healthy,
      `projectile_cost_custody_${input.projectileCostCustody.status}`,
      input.nowMs,
    ),
  };

  return {
    ready: Object.values(checks).every((entry) => entry.ready),
    emittedAt: input.nowMs,
    checks,
  };
}

export function resolveStreamingLiveAudioRequired(
  rawValue: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  if (nodeEnv === "production") return true;
  if (rawValue === undefined || rawValue.trim() === "") return false;
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(
    `STREAMING_REQUIRE_LIVE_AUDIO must be true or false; received ${JSON.stringify(rawValue)}`,
  );
}

export async function loadKeeperRuntimeObservation(input: {
  url: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<KeeperRuntimeObservation> {
  if (!input.url) {
    return {
      configured: false,
      ready: false,
      observedAt: null,
      error: null,
      reasons: [],
      correlationIds: [],
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      cache: "no-store",
      headers: { connection: "close" },
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const readiness =
      payload.readiness && typeof payload.readiness === "object"
        ? (payload.readiness as Record<string, unknown>)
        : null;
    const observedAt =
      typeof payload.now === "number" && Number.isFinite(payload.now)
        ? payload.now
        : Date.now();
    const reasons = keeperReadinessReasons(readiness?.reasons);
    const correlationIds = keeperCorrelationIds(payload.correlationIds);
    if (!response.ok) {
      return {
        configured: true,
        ready: false,
        observedAt,
        error: `HTTP ${response.status}`,
        reasons,
        correlationIds,
      };
    }
    return {
      configured: true,
      ready: payload.ok === true && readiness?.ready === true,
      observedAt,
      error: null,
      reasons,
      correlationIds,
    };
  } catch (error) {
    return {
      configured: true,
      ready: false,
      observedAt: Date.now(),
      error:
        error instanceof Error && error.name === "AbortError"
          ? `timeout after ${input.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "request failed",
      reasons: [],
      correlationIds: [],
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
