import { createHash } from "node:crypto";

const MINIMUM_SOAK_DURATION_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_SOURCE_AGE_MS = 15_000;
const MAXIMUM_STRATEGY_AUDIT_QUERY_LIMIT = 50_000;
const VALID_PHASES = new Set([
  "IDLE",
  "ANNOUNCEMENT",
  "COUNTDOWN",
  "FIGHTING",
  "RESOLUTION",
]);

function positiveInteger(value, label, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

export function validateDuelFullTopologySoakConfiguration({
  durationSeconds,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sseClients = 50,
  hlsClients = 12,
  statePollers = 4,
  duelContextPollers = 2,
  withHyperbet = false,
  withKeeper = false,
  withLocalSolana = false,
}) {
  const duration = Number(durationSeconds);
  if (duration === 0) {
    return Object.freeze({ enabled: false, durationSeconds: 0 });
  }
  const validatedDuration = positiveInteger(
    duration,
    "Full-topology soak duration",
    MINIMUM_SOAK_DURATION_SECONDS,
  );
  if (!withHyperbet || !withKeeper || !withLocalSolana) {
    throw new Error(
      "Full-topology soak requires Hyperbet, keeper, and managed local Solana",
    );
  }

  return Object.freeze({
    enabled: true,
    durationSeconds: validatedDuration,
    pollIntervalMs: positiveInteger(
      pollIntervalMs,
      "Full-topology soak poll interval",
      500,
    ),
    sseClients: positiveInteger(sseClients, "Full-topology soak SSE clients"),
    hlsClients: positiveInteger(hlsClients, "Full-topology soak HLS clients"),
    statePollers: positiveInteger(
      statePollers,
      "Full-topology soak state pollers",
    ),
    duelContextPollers: positiveInteger(
      duelContextPollers,
      "Full-topology soak duel-context pollers",
    ),
  });
}

export function buildDuelFullTopologyLoadArgs({
  configuration,
  serverUrl,
  bettingUrl,
  evidencePath,
}) {
  if (!configuration?.enabled) {
    throw new Error("Full-topology soak load cannot run while disabled");
  }
  for (const [label, value] of [
    ["server URL", serverUrl],
    ["betting URL", bettingUrl],
    ["evidence path", evidencePath],
  ]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Full-topology soak ${label} is required`);
    }
  }

  return Object.freeze([
    "scripts/load-test-streaming.mjs",
    `--server-url=${serverUrl}`,
    `--betting-url=${bettingUrl}`,
    `--duration-s=${configuration.durationSeconds}`,
    `--sse-clients=${configuration.sseClients}`,
    `--hls-clients=${configuration.hlsClients}`,
    `--state-pollers=${configuration.statePollers}`,
    `--duel-context-pollers=${configuration.duelContextPollers}`,
    "--integrity-poll-ms=1000",
    "--metrics-poll-ms=5000",
    "--telemetry-snapshot-ms=60000",
    "--min-resolved-duels=1",
    "--max-cancelled-duels=0",
    "--max-hls-failure-rate=0",
    "--max-api-failure-rate=0",
    "--require-full-phase-coverage",
    "--require-server-telemetry",
    "--require-renderer-telemetry",
    "--require-resource-telemetry",
    "--require-resource-ecology-telemetry",
    `--json-output=${evidencePath}`,
  ]);
}

export function buildDuelFullTopologyStrategyAuditArgs({
  queryLimit = MAXIMUM_STRATEGY_AUDIT_QUERY_LIMIT,
} = {}) {
  const validatedLimit = positiveInteger(
    queryLimit,
    "Full-topology strategy audit query limit",
  );
  if (validatedLimit > MAXIMUM_STRATEGY_AUDIT_QUERY_LIMIT) {
    throw new Error(
      `Full-topology strategy audit query limit must not exceed ${MAXIMUM_STRATEGY_AUDIT_QUERY_LIMIT}`,
    );
  }
  return Object.freeze([
    "packages/server/scripts/audit-competitive-strategy-outcomes.ts",
    "--limit",
    String(validatedLimit),
    "--include-diagnostics",
  ]);
}

export async function settleDuelFullTopologySoakTasks({
  loadPromise,
  continuityPromise,
  viewerPromise,
  abortController,
}) {
  if (
    typeof abortController?.abort !== "function" ||
    typeof abortController?.signal?.aborted !== "boolean"
  ) {
    throw new Error("Full-topology soak abort controller is required");
  }

  const abortForFailure = (label, error) => {
    if (abortController.signal.aborted) return;
    const detail = error instanceof Error ? error.message : String(error);
    abortController.abort(
      new Error(`Full-topology soak ${label} failed: ${detail}`),
    );
  };
  const guard = (label, promise, requirePassingEvidence) =>
    Promise.resolve(promise).then(
      (value) => {
        if (requirePassingEvidence && value?.ok !== true) {
          abortForFailure(label, "configured checks did not pass");
        }
        return value;
      },
      (error) => {
        abortForFailure(label, error);
        throw error;
      },
    );

  return Promise.allSettled([
    guard("stream load", loadPromise, false),
    guard("continuity monitor", continuityPromise, true),
    guard("viewer monitor", viewerPromise, true),
  ]);
}

function safeSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function redactDuelFullTopologyDiagnostic(value) {
  if (value == null) return null;
  return String(value)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, "$1***$2")
    .replace(
      /([?&](?:api[-_]?key|token|secret|authorization|credential)=)[^&#\s]*/gi,
      "$1***",
    )
    .replace(/(authorization:\s*bearer\s+)[^\s,;]+/gi, "$1***")
    .replace(
      /((?:api[-_]?key|token|secret|credential)\s*[=:]\s*)[^\s,&;]+/gi,
      "$1***",
    )
    .slice(0, 2_000);
}

function sequenceRange(first, last) {
  return {
    first,
    last,
    advanced: first != null && last != null && last > first,
    delta: first != null && last != null ? last - first : null,
  };
}

export class DuelFullTopologyContinuityTracker {
  constructor({
    expectedSourceUrl,
    maxSourceAgeMs = DEFAULT_MAX_SOURCE_AGE_MS,
    maxIssueSamples = 50,
  }) {
    if (!nonEmptyString(expectedSourceUrl)) {
      throw new Error("Full-topology soak expected source URL is required");
    }
    this.expectedSourceUrl = expectedSourceUrl;
    this.maxSourceAgeMs = positiveInteger(
      maxSourceAgeMs,
      "Full-topology soak maximum source age",
      1_000,
    );
    this.maxIssueSamples = positiveInteger(
      maxIssueSamples,
      "Full-topology soak issue sample limit",
    );
    this.observations = 0;
    this.validObservations = 0;
    this.violationObservations = 0;
    this.issueOccurrences = 0;
    this.issueCounts = new Map();
    this.issueSamples = [];
    this.phases = new Set();
    this.cycleIds = new Set();
    this.marketLifecycleCounts = new Map();
    this.maxObservedSourceAgeMs = 0;
    this.firstObservedAt = null;
    this.lastObservedAt = null;
    this.firstSample = null;
    this.lastSample = null;
    this.sequences = {
      hyperbetStatus: { first: null, last: null },
      hyperbetProxy: { first: null, last: null },
    };
  }

  recordFailure(code, detail = null, observedAt = Date.now()) {
    this.observations += 1;
    this.violationObservations += 1;
    this.recordIssue(code, detail, observedAt);
  }

  recordIssue(code, detail, observedAt) {
    this.issueOccurrences += 1;
    this.issueCounts.set(code, (this.issueCounts.get(code) ?? 0) + 1);
    if (this.issueSamples.length < this.maxIssueSamples) {
      this.issueSamples.push({ code, detail, observedAt });
    }
  }

  observe({
    canonicalState,
    hyperbetStatus,
    hyperbetState,
    solanaHealth,
    bettingUi,
    observedAt = Date.now(),
  }) {
    this.observations += 1;
    this.firstObservedAt ??= observedAt;
    this.lastObservedAt = observedAt;
    const issues = [];
    const addIssue = (code, detail = null) => issues.push({ code, detail });

    if (!canonicalState || typeof canonicalState !== "object") {
      addIssue("canonical_state_invalid");
    }
    if (!hyperbetStatus || typeof hyperbetStatus !== "object") {
      addIssue("hyperbet_status_invalid");
    }
    if (!hyperbetState || typeof hyperbetState !== "object") {
      addIssue("hyperbet_proxy_state_invalid");
    }
    if (solanaHealth?.result !== "ok" || solanaHealth?.error != null) {
      addIssue("solana_rpc_unhealthy", solanaHealth?.error ?? null);
    }
    if (bettingUi?.ok !== true || bettingUi?.status !== 200) {
      addIssue("hyperbet_ui_unhealthy", bettingUi?.status ?? null);
    }

    const canonicalPhaseVersion = safeSequence(
      canonicalState?.cycle?.phaseVersion,
    );
    const statusSeq = safeSequence(hyperbetStatus?.stream?.seq);
    const proxySeq = safeSequence(hyperbetState?.seq);
    for (const [label, value] of [
      ["hyperbetStatus", statusSeq],
      ["hyperbetProxy", proxySeq],
    ]) {
      if (value == null) {
        addIssue(`${label}_sequence_invalid`);
        continue;
      }
      const tracked = this.sequences[label];
      tracked.first ??= value;
      if (tracked.last != null && value < tracked.last) {
        addIssue(`${label}_sequence_regressed`, `${tracked.last}->${value}`);
      }
      tracked.last = Math.max(tracked.last ?? value, value);
    }

    const canonicalPhase = canonicalState?.cycle?.phase;
    const statusPhase = hyperbetStatus?.stream?.phase;
    const proxyPhase = hyperbetState?.cycle?.phase;
    for (const [label, phase] of [
      ["canonical", canonicalPhase],
      ["hyperbetStatus", statusPhase],
      ["hyperbetProxy", proxyPhase],
    ]) {
      if (!VALID_PHASES.has(phase)) addIssue(`${label}_phase_invalid`, phase);
    }
    if (canonicalPhaseVersion == null) {
      addIssue("canonical_phase_version_invalid");
    }

    if (statusSeq != null && proxySeq != null && statusSeq === proxySeq) {
      if (
        hyperbetStatus?.stream?.cycleId !==
          (hyperbetState?.cycle?.cycleId ?? null) ||
        statusPhase !== proxyPhase
      ) {
        addIssue("hyperbet_same_sequence_state_mismatch", statusSeq);
      }
    }

    if (hyperbetStatus?.service !== "hyperbet-solana-backend") {
      addIssue("hyperbet_service_identity_invalid", hyperbetStatus?.service);
    }
    if (
      hyperbetStatus?.readiness?.ready !== true ||
      !Array.isArray(hyperbetStatus?.readiness?.reasons) ||
      hyperbetStatus.readiness.reasons.length !== 0
    ) {
      const activeBotRecovery = Array.isArray(
        hyperbetStatus?.bot?.health?.recovery,
      )
        ? hyperbetStatus.bot.health.recovery
            .filter((entry) => entry?.active === true)
            .map((entry) => ({
              code: entry.code ?? null,
              details: entry.details ?? null,
            }))
        : [];
      const activeMarketRecovery = Array.isArray(
        hyperbetStatus?.bot?.health?.markets,
      )
        ? hyperbetStatus.bot.health.markets
            .filter(
              (market) =>
                Array.isArray(market?.recovery) && market.recovery.length > 0,
            )
            .map((market) => ({
              duelId: market.duelId ?? null,
              lifecycleStatus: market.lifecycleStatus ?? null,
              recovery: market.recovery,
            }))
        : [];
      addIssue("hyperbet_readiness_failed", {
        reasons: hyperbetStatus?.readiness?.reasons ?? null,
        solanaParser: {
          enabled: hyperbetStatus?.parsers?.solana?.enabled === true,
          lastSuccessAt:
            Number(hyperbetStatus?.parsers?.solana?.lastSuccessAt) || null,
          lastError: redactDuelFullTopologyDiagnostic(
            hyperbetStatus?.parsers?.solana?.lastError,
          ),
        },
        activeBotRecovery,
        activeMarketRecovery,
      });
    }
    if (hyperbetStatus?.bot?.running !== true) {
      addIssue("hyperbet_keeper_not_running");
    }
    if (hyperbetStatus?.stream?.sourceUrl !== this.expectedSourceUrl) {
      addIssue(
        "hyperbet_source_url_mismatch",
        hyperbetStatus?.stream?.sourceUrl ?? null,
      );
    }
    if (hyperbetStatus?.stream?.lastSourceError != null) {
      addIssue(
        "hyperbet_source_poll_error",
        hyperbetStatus.stream.lastSourceError,
      );
    }
    if (hyperbetStatus?.stream?.sourceEventsConnected !== true) {
      addIssue("hyperbet_source_events_disconnected");
    }
    if (hyperbetStatus?.stream?.sourceEventsLastError != null) {
      addIssue(
        "hyperbet_source_events_error",
        hyperbetStatus.stream.sourceEventsLastError,
      );
    }

    const lastSourcePollAt = Number(hyperbetStatus?.stream?.lastSourcePollAt);
    const sourceAgeMs =
      Number.isFinite(lastSourcePollAt) && lastSourcePollAt > 0
        ? Math.max(0, observedAt - lastSourcePollAt)
        : null;
    if (sourceAgeMs == null || sourceAgeMs > this.maxSourceAgeMs) {
      addIssue("hyperbet_source_stale", sourceAgeMs);
    } else {
      this.maxObservedSourceAgeMs = Math.max(
        this.maxObservedSourceAgeMs,
        sourceAgeMs,
      );
    }

    const markets = hyperbetStatus?.predictionMarkets?.chains;
    if (
      !Array.isArray(markets) ||
      markets.length === 0 ||
      hyperbetStatus?.predictionMarkets?.marketCount !== markets.length
    ) {
      addIssue("hyperbet_market_inventory_invalid");
    } else {
      for (const market of markets) {
        if (market?.chainKey !== "solana") {
          addIssue("non_solana_market_observed", market?.chainKey ?? null);
        }
        const lifecycle = nonEmptyString(market?.lifecycleStatus)
          ? market.lifecycleStatus
          : "UNKNOWN";
        this.marketLifecycleCounts.set(
          lifecycle,
          (this.marketLifecycleCounts.get(lifecycle) ?? 0) + 1,
        );
      }
    }

    if (VALID_PHASES.has(canonicalPhase)) this.phases.add(canonicalPhase);
    const cycleId = canonicalState?.cycle?.cycleId;
    if (nonEmptyString(cycleId)) this.cycleIds.add(cycleId);

    const sample = {
      observedAt,
      canonical: {
        phaseVersion: canonicalPhaseVersion,
        cycleId: cycleId ?? null,
        phase: canonicalPhase,
      },
      hyperbet: {
        seq: statusSeq,
        cycleId: hyperbetStatus?.stream?.cycleId ?? null,
        phase: statusPhase ?? null,
        ready: hyperbetStatus?.readiness?.ready === true,
        sourceAgeMs,
        marketCount: Array.isArray(markets) ? markets.length : null,
      },
      proxy: {
        seq: proxySeq,
        cycleId: hyperbetState?.cycle?.cycleId ?? null,
        phase: proxyPhase ?? null,
      },
      solanaHealthy:
        solanaHealth?.result === "ok" && solanaHealth?.error == null,
      bettingUiHealthy: bettingUi?.ok === true && bettingUi?.status === 200,
    };
    this.firstSample ??= sample;
    this.lastSample = sample;

    if (issues.length === 0) {
      this.validObservations += 1;
    } else {
      this.violationObservations += 1;
      for (const issue of issues) {
        this.recordIssue(issue.code, issue.detail, observedAt);
      }
    }
  }

  summary() {
    const sequences = Object.fromEntries(
      Object.entries(this.sequences).map(([label, range]) => [
        label,
        sequenceRange(range.first, range.last),
      ]),
    );
    return {
      observations: this.observations,
      validObservations: this.validObservations,
      violationObservations: this.violationObservations,
      issueOccurrences: this.issueOccurrences,
      issueCounts: Object.fromEntries(this.issueCounts),
      issueSamples: [...this.issueSamples],
      firstObservedAt: this.firstObservedAt,
      lastObservedAt: this.lastObservedAt,
      elapsedMs:
        this.firstObservedAt != null && this.lastObservedAt != null
          ? this.lastObservedAt - this.firstObservedAt
          : 0,
      phases: [...this.phases],
      cycleIds: [...this.cycleIds],
      marketLifecycleCounts: Object.fromEntries(this.marketLifecycleCounts),
      maxObservedSourceAgeMs: this.maxObservedSourceAgeMs,
      sequences,
      firstSample: this.firstSample,
      lastSample: this.lastSample,
    };
  }
}

export function buildDuelFullTopologyContinuityChecks(summary) {
  return [
    {
      label: "SOL full-topology continuity observations retained",
      pass: Number(summary?.observations) > 0,
      actual: Number(summary?.observations ?? 0),
    },
    {
      label: "SOL full-topology continuity violations == 0",
      pass:
        Number(summary?.violationObservations) === 0 &&
        Number(summary?.issueOccurrences) === 0,
      actual: `${summary?.violationObservations ?? 0} observations, ${summary?.issueOccurrences ?? 0} issues`,
    },
    ...["hyperbetStatus", "hyperbetProxy"].map((label) => ({
      label: `${label} stream sequence advanced`,
      pass: summary?.sequences?.[label]?.advanced === true,
      actual: summary?.sequences?.[label]?.delta ?? null,
    })),
  ];
}

export function buildDuelFullTopologyTerminalChecks(
  initialSummary,
  postSoakSummary,
) {
  const initialSucceeded = Number(initialSummary?.SUCCEEDED ?? 0);
  const postSucceeded = Number(postSoakSummary?.SUCCEEDED ?? 0);
  const unsafeCount =
    Number(postSoakSummary?.PENDING ?? 0) +
    Number(postSoakSummary?.PROCESSING ?? 0) +
    Number(postSoakSummary?.MANUAL_REVIEW ?? 0) +
    Number(postSoakSummary?.DEAD_LETTER ?? 0);
  return [
    {
      label:
        "at least one additional SOL terminal operation completed during soak",
      pass:
        Number.isSafeInteger(initialSucceeded) &&
        Number.isSafeInteger(postSucceeded) &&
        postSucceeded > initialSucceeded,
      actual: `${initialSucceeded}->${postSucceeded}`,
    },
    {
      label: "post-soak terminal queue and unsafe terminal states == 0",
      pass: unsafeCount === 0,
      actual: unsafeCount,
    },
  ];
}

export function buildDuelFullTopologyExactTerminalCheck(
  soakBoundary,
  exactTerminal,
) {
  const expectedDuelId = soakBoundary?.duelId;
  const expectedDuelKey = soakBoundary?.duelKey;
  const operation = exactTerminal?.operation;
  const market = exactTerminal?.market;
  const pass =
    nonEmptyString(expectedDuelId) &&
    typeof expectedDuelKey === "string" &&
    /^[0-9a-f]{64}$/.test(expectedDuelKey) &&
    operation?.status === "SUCCEEDED" &&
    operation?.duelId === expectedDuelId &&
    operation?.duelKey === expectedDuelKey &&
    market?.duelId === expectedDuelId &&
    market?.duelKey === expectedDuelKey &&
    market?.lifecycleStatus === "RESOLVED";
  return {
    label: "exact soak-boundary duel reached resolved SOL terminal success",
    pass,
    actual: pass
      ? {
          duelId: operation.duelId,
          duelKey: operation.duelKey,
          marketRef: market.marketRef,
          terminalOperationId: operation.id,
        }
      : {
          expectedDuelId: expectedDuelId ?? null,
          expectedDuelKey: expectedDuelKey ?? null,
          actualDuelId: operation?.duelId ?? null,
          actualDuelKey: operation?.duelKey ?? null,
          lifecycleStatus: market?.lifecycleStatus ?? null,
        },
  };
}

export function buildDuelFullTopologyDisputeEvidenceCheck(
  soakBoundary,
  disputeEvidence,
) {
  const pass =
    disputeEvidence?.ok === true &&
    disputeEvidence?.duelId === soakBoundary?.duelId &&
    disputeEvidence?.duelKey === soakBoundary?.duelKey &&
    disputeEvidence?.classification?.chain === "solana" &&
    disputeEvidence?.classification?.cluster === "localnet" &&
    disputeEvidence?.classification?.externalValue === false &&
    disputeEvidence?.classification?.productionEquivalentInfrastructure ===
      false &&
    disputeEvidence?.classification?.releaseEligible === false &&
    Number.isSafeInteger(disputeEvidence?.transactionCount) &&
    disputeEvidence.transactionCount >= 6 &&
    /^[0-9a-f]{64}$/.test(disputeEvidence?.packageDigest ?? "") &&
    /^[0-9a-f]{64}$/.test(disputeEvidence?.artifactSha256 ?? "");
  return {
    label:
      "exact soak-boundary duel retained a local-only immutable dispute package",
    pass,
    actual: disputeEvidence ?? null,
  };
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactNonNegativeRecord(value, keys) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(":") === [...keys].sort().join(":") &&
    keys.every((key) => nonNegativeSafeInteger(value[key]))
  );
}

function recordTotal(value, keys) {
  return keys.reduce((total, key) => total + value[key], 0);
}

function executionCountsAreConsistent(execution) {
  if (!execution || typeof execution !== "object") return false;
  const admissionConsistent = (summary, outcomes) =>
    summary != null &&
    nonNegativeSafeInteger(summary.attempts) &&
    outcomes.every((field) => nonNegativeSafeInteger(summary[field])) &&
    summary.attempts ===
      outcomes.reduce((total, field) => total + summary[field], 0);
  if (
    !nonNegativeSafeInteger(execution.observations) ||
    !admissionConsistent(execution.movement, [
      "accepted",
      "rejected",
      "errors",
    ]) ||
    !admissionConsistent(execution.engagement, [
      "accepted",
      "rejected",
      "errors",
    ]) ||
    !admissionConsistent(execution.food, [
      "committed",
      "deferred",
      "rejected",
      "errors",
    ]) ||
    !admissionConsistent(execution.prayer, [
      "committed",
      "rejected",
      "errors",
    ]) ||
    !admissionConsistent(execution.style, ["accepted", "rejected", "errors"]) ||
    !admissionConsistent(execution.roleSwitch, [
      "committed",
      "deferred",
      "rejected",
      "errors",
    ]) ||
    !nonNegativeSafeInteger(execution.damage?.hits) ||
    !nonNegativeSafeInteger(execution.damage?.total) ||
    !nonNegativeSafeInteger(execution.food?.totalHealing)
  ) {
    return false;
  }
  const prayerKeys = [
    "superhuman_strength",
    "rock_skin",
    "hawk_eye",
    "mystic_lore",
  ];
  const styleKeys = [
    "accurate",
    "aggressive",
    "controlled",
    "defensive",
    "longrange",
    "rapid",
  ];
  const roleKeys = ["melee", "ranged", "mage"];
  const macroKeys = [
    "pressure",
    "hold_range",
    "kite",
    "orbit",
    "defensive_reset",
    "finish",
  ];
  if (
    !exactNonNegativeRecord(execution.prayer.committedByPrayer, prayerKeys) ||
    !exactNonNegativeRecord(execution.style.acceptedByStyle, styleKeys) ||
    !exactNonNegativeRecord(
      execution.roleSwitch.committedByTargetRole,
      roleKeys,
    ) ||
    !exactNonNegativeRecord(execution.observedCombatRoles, roleKeys) ||
    !exactNonNegativeRecord(execution.observedTacticalMacros, macroKeys)
  ) {
    return false;
  }
  return (
    execution.engagement.initialAccepted +
      execution.engagement.keepAliveAccepted ===
      execution.engagement.accepted &&
    recordTotal(execution.prayer.committedByPrayer, prayerKeys) ===
      execution.prayer.committed &&
    recordTotal(execution.style.acceptedByStyle, styleKeys) ===
      execution.style.accepted &&
    recordTotal(execution.roleSwitch.committedByTargetRole, roleKeys) ===
      execution.roleSwitch.committed &&
    recordTotal(execution.observedCombatRoles, roleKeys) ===
      execution.observations &&
    recordTotal(execution.observedTacticalMacros, macroKeys) ===
      execution.observations &&
    execution.food.totalHealing >= execution.food.committed &&
    execution.damage.total >= execution.damage.hits &&
    execution.observations ===
      execution.movement.attempts +
        execution.engagement.attempts +
        execution.food.attempts +
        execution.prayer.attempts +
        execution.style.attempts +
        execution.roleSwitch.attempts +
        execution.damage.hits
  );
}

function strategySummaryIsConsistent(sample) {
  const strategy = sample?.strategy;
  const exactKeys = [
    "approach",
    "attackStyle",
    "foodThreshold",
    "policyVersion",
    "prayer",
    "preferredCombatRole",
    "schemaVersion",
    "source",
    "switchDefensiveAt",
    "tacticalMacro",
  ];
  if (
    strategy == null ||
    typeof strategy !== "object" ||
    Array.isArray(strategy) ||
    Object.keys(strategy).sort().join(":") !== exactKeys.sort().join(":") ||
    strategy.schemaVersion !== 1 ||
    !["aggressive", "defensive", "balanced", "outlast"].includes(
      strategy.approach,
    ) ||
    ![
      "pressure",
      "hold_range",
      "kite",
      "orbit",
      "defensive_reset",
      "finish",
    ].includes(strategy.tacticalMacro) ||
    !["accurate", "aggressive", "controlled", "defensive"].includes(
      strategy.attackStyle,
    ) ||
    !(
      strategy.prayer === null ||
      ["superhuman_strength", "rock_skin", "hawk_eye", "mystic_lore"].includes(
        strategy.prayer,
      )
    ) ||
    !(
      strategy.preferredCombatRole === null ||
      ["melee", "ranged", "mage"].includes(strategy.preferredCombatRole)
    ) ||
    !Number.isSafeInteger(strategy.foodThreshold) ||
    strategy.foodThreshold < 20 ||
    strategy.foodThreshold > 60 ||
    !Number.isSafeInteger(strategy.switchDefensiveAt) ||
    strategy.switchDefensiveAt < 20 ||
    strategy.switchDefensiveAt > 40 ||
    !["model", "deterministic", "diagnostic"].includes(strategy.source) ||
    typeof strategy.policyVersion !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(strategy.policyVersion)
  ) {
    return false;
  }
  const expectedHash = createHash("sha256")
    .update(
      JSON.stringify({
        openingStyle: sample.openingStyle,
        schemaVersion: strategy.schemaVersion,
        approach: strategy.approach,
        tacticalMacro: strategy.tacticalMacro,
        attackStyle: strategy.attackStyle,
        prayer: strategy.prayer,
        preferredCombatRole: strategy.preferredCombatRole,
        foodThreshold: strategy.foodThreshold,
        switchDefensiveAt: strategy.switchDefensiveAt,
        source: strategy.source,
        policyVersion: strategy.policyVersion,
      }),
    )
    .digest("hex");
  return sample.strategyHash === expectedHash;
}

function participantSamplesAreConsistent(samples) {
  if (!Array.isArray(samples)) return false;
  const samplesByCycle = new Map();
  for (const sample of samples) {
    if (
      sample?.schemaVersion !== 1 ||
      !nonEmptyString(sample.cycleId) ||
      !nonEmptyString(sample.duelId) ||
      !nonEmptyString(sample.agentId) ||
      !nonEmptyString(sample.opponentId) ||
      sample.agentId === sample.opponentId ||
      !["win", "loss", "draw"].includes(sample.result) ||
      !["melee", "ranged", "mage"].includes(sample.openingStyle) ||
      !/^[0-9a-f]{64}$/.test(sample.strategyHash ?? "") ||
      !["kill", "forfeit", "hp_advantage", "damage_advantage", "draw"].includes(
        sample.winReason,
      ) ||
      !nonNegativeSafeInteger(sample.finishedAt) ||
      !nonNegativeSafeInteger(sample.damageDealt) ||
      !nonNegativeSafeInteger(sample.damageTaken) ||
      !strategySummaryIsConsistent(sample) ||
      !executionCountsAreConsistent(sample.execution)
    ) {
      return false;
    }
    const cycleSamples = samplesByCycle.get(sample.cycleId) ?? [];
    cycleSamples.push(sample);
    samplesByCycle.set(sample.cycleId, cycleSamples);
  }
  for (const cycleSamples of samplesByCycle.values()) {
    if (cycleSamples.length !== 2) return false;
    const [first, second] = cycleSamples;
    const outcomes = [first.result, second.result].sort().join(":");
    if (
      first.duelId !== second.duelId ||
      first.finishedAt !== second.finishedAt ||
      first.agentId !== second.opponentId ||
      first.opponentId !== second.agentId ||
      first.damageDealt !== second.damageTaken ||
      first.damageTaken !== second.damageDealt ||
      first.winReason !== second.winReason ||
      (outcomes === "draw:draw") !== (first.winReason === "draw") ||
      !["draw:draw", "loss:win"].includes(outcomes)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Qualify immutable strategy/outcome analytics without inventing gameplay or
 * balance thresholds. The only occurrence gate proves the exact soak duel
 * retained at least one public receipt produced by an acting agent.
 */
export function buildDuelFullTopologyStrategyAnalyticsChecks(
  soakBoundary,
  analytics,
) {
  const report = analytics?.report;
  const samples = Array.isArray(report?.samples) ? report.samples : [];
  const completedDuels = report?.completedDuels;
  const participantSamples = report?.participantSamples;
  const totalExecutionObservations = samples.reduce(
    (total, sample) => total + Number(sample?.execution?.observations ?? 0),
    0,
  );
  const observedFinishedAtRange = samples.reduce(
    (range, sample) => ({
      first:
        range.first === null
          ? sample.finishedAt
          : Math.min(range.first, sample.finishedAt),
      last:
        range.last === null
          ? sample.finishedAt
          : Math.max(range.last, sample.finishedAt),
    }),
    { first: null, last: null },
  );
  const envelopeIsValid =
    analytics?.audit === "competitive_strategy_outcomes" &&
    analytics?.databaseAccess === "repeatable_read_read_only" &&
    analytics?.descriptiveOnly === true &&
    analytics?.diagnosticScope?.included === true &&
    analytics?.diagnosticScope?.boundary === "owned_local_no_value" &&
    analytics?.diagnosticScope?.productionMetricsEligible === false &&
    nonEmptyString(analytics?.generatedAt) &&
    Number.isFinite(Date.parse(analytics.generatedAt)) &&
    nonNegativeSafeInteger(analytics?.terminalRows) &&
    nonNegativeSafeInteger(analytics?.actionObservationRows) &&
    nonNegativeSafeInteger(analytics?.queryLimit) &&
    analytics.queryLimit >= 1 &&
    analytics.queryLimit <= MAXIMUM_STRATEGY_AUDIT_QUERY_LIMIT &&
    analytics.terminalRows <= analytics.queryLimit &&
    report?.schemaVersion === 1 &&
    Array.isArray(report?.aggregates);
  const populationIsConsistent =
    envelopeIsValid &&
    analytics.truncated === false &&
    nonNegativeSafeInteger(completedDuels) &&
    nonNegativeSafeInteger(participantSamples) &&
    analytics.terminalRows === completedDuels &&
    participantSamples === completedDuels * 2 &&
    samples.length === participantSamples &&
    participantSamplesAreConsistent(samples) &&
    nonNegativeSafeInteger(totalExecutionObservations) &&
    totalExecutionObservations === analytics.actionObservationRows &&
    report.firstFinishedAt === observedFinishedAtRange.first &&
    report.lastFinishedAt === observedFinishedAtRange.last;
  const boundarySamples = samples.filter(
    (sample) =>
      sample?.cycleId === soakBoundary?.cycleId &&
      sample?.duelId === soakBoundary?.duelId,
  );
  const boundaryIsCovered =
    populationIsConsistent &&
    nonEmptyString(soakBoundary?.cycleId) &&
    nonEmptyString(soakBoundary?.duelId) &&
    boundarySamples.length === 2;
  const boundaryExecutionObservations = boundarySamples.reduce(
    (total, sample) => total + Number(sample?.execution?.observations ?? 0),
    0,
  );

  return [
    {
      label:
        "competitive strategy analytics used immutable read-only authority",
      pass: envelopeIsValid,
      actual: {
        audit: analytics?.audit ?? null,
        databaseAccess: analytics?.databaseAccess ?? null,
        descriptiveOnly: analytics?.descriptiveOnly ?? null,
        diagnosticScope: analytics?.diagnosticScope ?? null,
        schemaVersion: report?.schemaVersion ?? null,
      },
    },
    {
      label:
        "competitive strategy analytics population is untruncated and internally consistent",
      pass: populationIsConsistent,
      actual: {
        truncated: analytics?.truncated ?? null,
        terminalRows: analytics?.terminalRows ?? null,
        completedDuels: completedDuels ?? null,
        participantSamples: participantSamples ?? null,
        actionObservationRows: analytics?.actionObservationRows ?? null,
        executionObservations: totalExecutionObservations,
      },
    },
    {
      label:
        "exact soak-boundary duel is represented by two reciprocal analytics samples",
      pass: boundaryIsCovered,
      actual: {
        cycleId: soakBoundary?.cycleId ?? null,
        duelId: soakBoundary?.duelId ?? null,
        participantSamples: boundarySamples.length,
      },
    },
    {
      label:
        "exact soak-boundary duel retained public agent execution receipts",
      pass: boundaryIsCovered && boundaryExecutionObservations > 0,
      actual: boundaryExecutionObservations,
    },
  ];
}
