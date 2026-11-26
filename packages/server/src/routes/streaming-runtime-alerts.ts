import type { StreamingRuntimeHealth } from "./streaming-runtime-health.js";
import type { ProjectileCostCustodyHealthResult } from "../startup/routes/health-routes.js";

export type StreamingRuntimeAlertObservation = {
  health: StreamingRuntimeHealth;
  projectileCostCustody: ProjectileCostCustodyHealthResult;
  keeperReasons: string[];
  keeperCorrelationIds: string[];
  droppedFrames: number;
  stalePhase: {
    phase: string;
    phaseStartedAt: number;
  } | null;
};

const DUEL_CORRELATION_ID = /^[0-9a-f]{64}$/u;
const PROJECTILE_COST_CUSTODY_STATUSES = new Set([
  "healthy",
  "processing",
  "stalled",
  "invalid",
  "unavailable",
  "timeout",
]);

export type StreamingRuntimeAlertIssue = {
  key: string;
  component: string;
  reason: string;
  observedAt: number | null;
};

type StreamingRuntimeAlertDispatcherOptions = {
  webhookUrl: string | null;
  routeId: string;
  reminderMs: number;
  retryMs: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

function normalizeAlertCode(reason: string, fallback: string): string {
  const normalized = reason.trim();
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(normalized)
    ? normalized
    : fallback;
}

function normalizeKeeperReasons(reasons: string[]): string[] {
  return [
    ...new Set(
      reasons
        .map((reason) => reason.trim())
        .filter(Boolean)
        .map((reason) =>
          normalizeAlertCode(reason, "unclassified_keeper_reason"),
        )
        .slice(0, 64),
    ),
  ].sort();
}

function normalizeKeeperCorrelationIds(values: string[]): string[] {
  return [...new Set(values.filter((value) => DUEL_CORRELATION_ID.test(value)))]
    .sort()
    .slice(0, 64);
}

function safeAggregateCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function sanitizeProjectileCostCustody(
  custody: ProjectileCostCustodyHealthResult,
): ProjectileCostCustodyHealthResult {
  const status = PROJECTILE_COST_CUSTODY_STATUSES.has(custody.status)
    ? custody.status
    : "invalid";
  return {
    healthy: custody.healthy === true,
    status,
    maxAgeMs: safeAggregateCount(custody.maxAgeMs),
    pendingAmmunitionShots: safeAggregateCount(custody.pendingAmmunitionShots),
    firedAmmunitionShots: safeAggregateCount(custody.firedAmmunitionShots),
    pendingRuneCosts: safeAggregateCount(custody.pendingRuneCosts),
    firedRuneCosts: safeAggregateCount(custody.firedRuneCosts),
    invalidOperations: safeAggregateCount(custody.invalidOperations),
    futureTimestampOperations: safeAggregateCount(
      custody.futureTimestampOperations,
    ),
    oldestUnresolvedAgeMs: safeAggregateCount(custody.oldestUnresolvedAgeMs),
  };
}

export class StreamingRuntimeAlertDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private deliveredSignature = "";
  private lastDeliveredAt = Number.NEGATIVE_INFINITY;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private acknowledgedDroppedFrames = 0;
  private inFlight = false;

  constructor(
    private readonly options: StreamingRuntimeAlertDispatcherOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  isEnabled(): boolean {
    return Boolean(this.options.webhookUrl);
  }

  async observe(
    observation: StreamingRuntimeAlertObservation,
  ): Promise<{ attempted: boolean; sent: boolean; issues: string[] }> {
    const nowMs = this.now();
    const issues = this.buildIssues(observation);
    const correlationIds = issues.some((issue) => issue.component === "keeper")
      ? normalizeKeeperCorrelationIds(observation.keeperCorrelationIds)
      : [];
    const signature =
      issues.length === 0
        ? ""
        : JSON.stringify({
            issues: issues.map((issue) => issue.key).sort(),
            correlationIds,
          });
    const isRecovery = signature === "" && this.deliveredSignature !== "";
    const changed = signature !== this.deliveredSignature;
    const reminderDue =
      signature !== "" &&
      nowMs - this.lastDeliveredAt >= this.options.reminderMs;
    const retryReady = nowMs - this.lastAttemptAt >= this.options.retryMs;

    if (
      !this.options.webhookUrl ||
      this.inFlight ||
      (!changed && !reminderDue) ||
      (!retryReady && changed)
    ) {
      return {
        attempted: false,
        sent: false,
        issues: issues.map((issue) => issue.key),
      };
    }
    if (signature === "" && !isRecovery) {
      return { attempted: false, sent: false, issues: [] };
    }

    this.inFlight = true;
    this.lastAttemptAt = nowMs;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(this.options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "STREAMING_RUNTIME_ALERT",
          routeId: this.options.routeId,
          status: isRecovery ? "recovered" : "firing",
          emittedAt: observation.health.emittedAt,
          ready: observation.health.ready,
          issues,
          keeperReasons: normalizeKeeperReasons(observation.keeperReasons),
          correlationIds: isRecovery ? [] : correlationIds,
          droppedFrames: observation.droppedFrames,
          projectileCostCustody: sanitizeProjectileCostCustody(
            observation.projectileCostCustody,
          ),
        }),
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        return {
          attempted: true,
          sent: false,
          issues: issues.map((issue) => issue.key),
        };
      }
      this.deliveredSignature = signature;
      this.lastDeliveredAt = nowMs;
      if (Number.isFinite(observation.droppedFrames)) {
        this.acknowledgedDroppedFrames = Math.max(
          this.acknowledgedDroppedFrames,
          observation.droppedFrames,
        );
      }
      return {
        attempted: true,
        sent: true,
        issues: issues.map((issue) => issue.key),
      };
    } catch {
      return {
        attempted: true,
        sent: false,
        issues: issues.map((issue) => issue.key),
      };
    } finally {
      clearTimeout(timeout);
      this.inFlight = false;
    }
  }

  private buildIssues(
    observation: StreamingRuntimeAlertObservation,
  ): StreamingRuntimeAlertIssue[] {
    const issues: StreamingRuntimeAlertIssue[] = [];
    for (const [component, runtimeCheck] of Object.entries(
      observation.health.checks,
    )) {
      if (!runtimeCheck.ready) {
        const reason = normalizeAlertCode(
          runtimeCheck.reason ?? "not_ready",
          "unclassified_not_ready",
        );
        issues.push({
          key: `health:${component}:${reason}`,
          component,
          reason,
          observedAt: runtimeCheck.observedAt,
        });
      }
    }
    for (const reason of normalizeKeeperReasons(observation.keeperReasons)) {
      issues.push({
        key: `keeper:${reason}`,
        component: "keeper",
        reason,
        observedAt: observation.health.checks.keeper.observedAt,
      });
    }
    if (observation.stalePhase) {
      const phase = normalizeAlertCode(
        observation.stalePhase.phase.toLowerCase(),
        "unclassified",
      );
      issues.push({
        key: `scheduler:stale_phase:${phase}`,
        component: "schedulerPhase",
        reason: `stale_${phase}_phase`,
        observedAt: observation.stalePhase.phaseStartedAt,
      });
    }
    if (
      Number.isFinite(observation.droppedFrames) &&
      observation.droppedFrames > this.acknowledgedDroppedFrames
    ) {
      issues.push({
        key: "encoder:dropped_frames_increased",
        component: "encoder",
        reason: "dropped_frames_increased",
        observedAt: observation.health.emittedAt,
      });
    }
    return issues;
  }
}
