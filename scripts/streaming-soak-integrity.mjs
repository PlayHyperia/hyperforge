const ACTIVE_PHASES = Object.freeze([
  "ANNOUNCEMENT",
  "COUNTDOWN",
  "FIGHTING",
  "RESOLUTION",
]);

const PHASE_INDEX = new Map(
  ACTIVE_PHASES.map((phase, index) => [phase, index]),
);
// Public streaming state is deliberately delayed and a fresh qualification
// process still needs a short endpoint warmup. Five seconds admits only the
// beginning of ANNOUNCEMENT while preserving meaningful full-phase coverage.
const PHASE_COVERAGE_START_TOLERANCE_MS = 5_000;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function agentIdentity(agent) {
  return agent && isNonEmptyString(agent.id) ? agent.id : null;
}

function validateAgent(agent) {
  if (!agent || typeof agent !== "object") return "missing_agent";
  if (!isNonEmptyString(agent.id)) return "invalid_agent_id";
  if (!isFiniteNumber(agent.hp) || !isFiniteNumber(agent.maxHp)) {
    return "invalid_agent_health";
  }
  if (agent.maxHp <= 0 || agent.hp < 0 || agent.hp > agent.maxHp) {
    return "agent_health_out_of_bounds";
  }
  if (
    !isFiniteNumber(agent.damageDealtThisFight) ||
    agent.damageDealtThisFight < 0
  ) {
    return "invalid_agent_damage";
  }
  if (!Number.isSafeInteger(agent.attacksLanded) || agent.attacksLanded < 0) {
    return "invalid_agent_hits";
  }
  return null;
}

function summarizeDurations(values) {
  if (values.length === 0) {
    return {
      count: 0,
      average: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.floor((sorted.length - 1) * value)];
  return {
    count: sorted.length,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted[sorted.length - 1],
  };
}

function createCycle(cycle, observedAt) {
  const phaseDurationMs =
    isFiniteNumber(cycle.phaseStartTime) && isFiniteNumber(cycle.phaseEndTime)
      ? Math.max(0, cycle.phaseEndTime - cycle.phaseStartTime)
      : null;
  const firstPhaseElapsedMs =
    phaseDurationMs != null && isFiniteNumber(cycle.timeRemaining)
      ? Math.max(0, phaseDurationMs - cycle.timeRemaining)
      : null;
  return {
    cycleId: cycle.cycleId,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    agent1Id: agentIdentity(cycle.agent1),
    agent2Id: agentIdentity(cycle.agent2),
    duelId: isNonEmptyString(cycle.duelId) ? cycle.duelId : null,
    duelKeyHex: isNonEmptyString(cycle.duelKeyHex) ? cycle.duelKeyHex : null,
    firstPhase: PHASE_INDEX.has(cycle.phase) ? cycle.phase : null,
    firstPhaseElapsedMs,
    phaseCoverageEligible:
      cycle.phase === "ANNOUNCEMENT" &&
      firstPhaseElapsedMs != null &&
      firstPhaseElapsedMs <= PHASE_COVERAGE_START_TOLERANCE_MS,
    lastPhaseIndex: -1,
    lastPhaseVersion: null,
    phases: new Set(),
    maxDamageAgent1: 0,
    maxDamageAgent2: 0,
    maxHitsAgent1: 0,
    maxHitsAgent2: 0,
    fightStartTime: null,
    firstHitAt: null,
    resolution: null,
    cancellation: null,
  };
}

export class StreamingSoakIntegrityTracker {
  constructor({ maxIssueSamples = 50 } = {}) {
    this.maxIssueSamples = Math.max(1, maxIssueSamples);
    this.observations = 0;
    this.validObservations = 0;
    this.cycles = new Map();
    this.issueKeys = new Set();
    this.issues = [];
    this.cancellationKeys = new Set();
    this.phaseCounts = Object.fromEntries(
      ["IDLE", ...ACTIVE_PHASES].map((phase) => [phase, 0]),
    );
  }

  recordIssue(code, cycleId = null, detail = null) {
    const key = JSON.stringify([code, cycleId, detail]);
    if (this.issueKeys.has(key)) return;
    this.issueKeys.add(key);
    if (this.issues.length < this.maxIssueSamples) {
      this.issues.push({ code, cycleId, detail });
    }
  }

  observe(payload, observedAt = Date.now()) {
    this.observations += 1;
    if (!payload || typeof payload !== "object") {
      this.recordIssue("invalid_state_payload");
      return;
    }

    const cycle = payload.cycle;
    if (!cycle || typeof cycle !== "object") {
      this.recordIssue("missing_cycle_payload");
      return;
    }

    const phase = cycle.phase;
    if (phase !== "IDLE" && !PHASE_INDEX.has(phase)) {
      this.recordIssue("invalid_phase", null, String(phase));
      return;
    }

    this.validObservations += 1;
    this.phaseCounts[phase] += 1;

    if (payload.terminalNotice != null) {
      this.observeCancellation(payload.terminalNotice, observedAt);
    }

    if (phase === "IDLE") return;
    if (!isNonEmptyString(cycle.cycleId)) {
      this.recordIssue("missing_active_cycle_id");
      return;
    }

    const cycleId = cycle.cycleId;
    let tracked = this.cycles.get(cycleId);
    if (!tracked) {
      tracked = createCycle(cycle, observedAt);
      this.cycles.set(cycleId, tracked);
    }
    tracked.lastObservedAt = observedAt;

    if (
      !isFiniteNumber(cycle.cycleStartTime) ||
      !isFiniteNumber(cycle.phaseStartTime) ||
      !isFiniteNumber(cycle.phaseEndTime) ||
      cycle.cycleStartTime <= 0 ||
      cycle.phaseStartTime < cycle.cycleStartTime ||
      cycle.phaseEndTime < cycle.phaseStartTime ||
      !isFiniteNumber(cycle.timeRemaining) ||
      cycle.timeRemaining < 0
    ) {
      this.recordIssue("invalid_phase_timing", cycleId);
    }

    const agent1Error = validateAgent(cycle.agent1);
    const agent2Error = validateAgent(cycle.agent2);
    if (agent1Error) this.recordIssue(agent1Error, cycleId, "agent1");
    if (agent2Error) this.recordIssue(agent2Error, cycleId, "agent2");

    const agent1Id = agentIdentity(cycle.agent1);
    const agent2Id = agentIdentity(cycle.agent2);
    if (agent1Id && agent2Id && agent1Id === agent2Id) {
      this.recordIssue("duplicate_contestant_identity", cycleId, agent1Id);
    }
    for (const [field, initial, current] of [
      ["agent1", tracked.agent1Id, agent1Id],
      ["agent2", tracked.agent2Id, agent2Id],
    ]) {
      if (initial && current && initial !== current) {
        this.recordIssue("contestant_identity_changed", cycleId, field);
      }
    }

    this.observeStableIdentity(tracked, cycle, "duelId");
    this.observeStableIdentity(tracked, cycle, "duelKeyHex");
    if (phase !== "ANNOUNCEMENT" && (!tracked.duelId || !tracked.duelKeyHex)) {
      this.recordIssue("missing_duel_identity_after_announcement", cycleId);
    }

    const phaseIndex = PHASE_INDEX.get(phase);
    const previousPhaseIndex = tracked.lastPhaseIndex;
    if (phaseIndex < tracked.lastPhaseIndex) {
      this.recordIssue(
        "phase_regressed",
        cycleId,
        `${ACTIVE_PHASES[tracked.lastPhaseIndex]}->${phase}`,
      );
    }
    tracked.lastPhaseIndex = Math.max(tracked.lastPhaseIndex, phaseIndex);
    tracked.phases.add(phase);

    if (!Number.isSafeInteger(cycle.phaseVersion) || cycle.phaseVersion < 0) {
      this.recordIssue("invalid_phase_version", cycleId);
    } else if (
      tracked.lastPhaseVersion != null &&
      cycle.phaseVersion < tracked.lastPhaseVersion
    ) {
      this.recordIssue("phase_version_regressed", cycleId);
    } else {
      if (
        tracked.lastPhaseVersion != null &&
        phaseIndex > previousPhaseIndex &&
        cycle.phaseVersion <= tracked.lastPhaseVersion
      ) {
        this.recordIssue("phase_advanced_without_version", cycleId);
      }
      tracked.lastPhaseVersion = cycle.phaseVersion;
    }

    this.observeDamage(tracked, cycle.agent1, "agent1");
    this.observeDamage(tracked, cycle.agent2, "agent2");
    this.observeHits(tracked, cycle.agent1, "agent1");
    this.observeHits(tracked, cycle.agent2, "agent2");
    this.observeFirstHit(tracked, cycle);

    if (phase === "RESOLUTION") {
      this.observeResolution(tracked, cycle, observedAt);
    }
  }

  observeStableIdentity(tracked, cycle, field) {
    const current = isNonEmptyString(cycle[field]) ? cycle[field] : null;
    if (tracked[field] && current && tracked[field] !== current) {
      this.recordIssue(`${field}_changed`, tracked.cycleId);
      return;
    }
    if (!tracked[field] && current) tracked[field] = current;
  }

  observeDamage(tracked, agent, label) {
    if (!agent || !isFiniteNumber(agent.damageDealtThisFight)) return;
    const key = label === "agent1" ? "maxDamageAgent1" : "maxDamageAgent2";
    if (agent.damageDealtThisFight < tracked[key]) {
      this.recordIssue("damage_regressed", tracked.cycleId, label);
      return;
    }
    tracked[key] = agent.damageDealtThisFight;
  }

  observeHits(tracked, agent, label) {
    if (!agent || !Number.isSafeInteger(agent.attacksLanded)) return;
    const key = label === "agent1" ? "maxHitsAgent1" : "maxHitsAgent2";
    if (agent.attacksLanded < tracked[key]) {
      this.recordIssue("hits_regressed", tracked.cycleId, label);
      return;
    }
    tracked[key] = agent.attacksLanded;
  }

  observeFirstHit(tracked, cycle) {
    if (isFiniteNumber(cycle.fightStartTime)) {
      if (
        tracked.fightStartTime != null &&
        tracked.fightStartTime !== cycle.fightStartTime
      ) {
        this.recordIssue("fight_start_time_changed", tracked.cycleId);
      } else {
        tracked.fightStartTime = cycle.fightStartTime;
      }
    }
    if (cycle.firstHitAt == null) return;
    if (!isFiniteNumber(cycle.firstHitAt)) {
      this.recordIssue("invalid_first_hit_time", tracked.cycleId);
      return;
    }
    if (tracked.firstHitAt != null && tracked.firstHitAt !== cycle.firstHitAt) {
      this.recordIssue("first_hit_time_changed", tracked.cycleId);
      return;
    }
    tracked.firstHitAt = cycle.firstHitAt;
    if (
      tracked.fightStartTime != null &&
      tracked.firstHitAt < tracked.fightStartTime
    ) {
      this.recordIssue("first_hit_before_fight", tracked.cycleId);
    }
  }

  observeResolution(tracked, cycle, observedAt) {
    if (tracked.resolution) {
      const repeated = {
        outcome: cycle.outcome,
        winnerId: cycle.winnerId ?? null,
        winReason: cycle.winReason ?? null,
        duelEndTime: cycle.duelEndTime ?? null,
        seed: cycle.seed ?? null,
        replayHash: cycle.replayHash ?? null,
      };
      const original = {
        outcome: tracked.resolution.outcome,
        winnerId: tracked.resolution.winnerId,
        winReason: tracked.resolution.winReason,
        duelEndTime: tracked.resolution.duelEndTime,
        seed: tracked.resolution.seed,
        replayHash: tracked.resolution.replayHash,
      };
      if (JSON.stringify(repeated) !== JSON.stringify(original)) {
        this.recordIssue("contradictory_resolution", tracked.cycleId);
      }
      return;
    }
    if (tracked.cancellation) {
      this.recordIssue("cancelled_cycle_resolved", tracked.cycleId);
    }
    if (cycle.outcome !== "win" && cycle.outcome !== "draw") {
      this.recordIssue("invalid_resolution_outcome", tracked.cycleId);
      return;
    }
    if (!tracked.duelId || !tracked.duelKeyHex) {
      this.recordIssue("incomplete_resolution_identity", tracked.cycleId);
    }
    if (
      !isFiniteNumber(cycle.duelEndTime) ||
      cycle.duelEndTime <= 0 ||
      !isNonEmptyString(cycle.seed) ||
      !isNonEmptyString(cycle.replayHash)
    ) {
      this.recordIssue("incomplete_resolution_proof", tracked.cycleId);
    }

    if (cycle.outcome === "win") {
      const participantIds = new Set([tracked.agent1Id, tracked.agent2Id]);
      if (!participantIds.has(cycle.winnerId)) {
        this.recordIssue("invalid_resolution_winner", tracked.cycleId);
      }
    } else if (cycle.winnerId != null) {
      this.recordIssue("draw_with_winner", tracked.cycleId);
    }
    if (
      tracked.maxDamageAgent1 + tracked.maxDamageAgent2 <= 0 &&
      cycle.winReason !== "forfeit"
    ) {
      this.recordIssue("resolution_without_combat_activity", tracked.cycleId);
    }
    if (
      tracked.maxDamageAgent1 + tracked.maxDamageAgent2 > 0 &&
      (tracked.firstHitAt == null || tracked.fightStartTime == null)
    ) {
      this.recordIssue("missing_first_hit_timing", tracked.cycleId);
    }
    if (
      tracked.firstHitAt != null &&
      isFiniteNumber(cycle.duelEndTime) &&
      tracked.firstHitAt > cycle.duelEndTime
    ) {
      this.recordIssue("first_hit_after_duel_end", tracked.cycleId);
    }

    tracked.resolution = {
      outcome: cycle.outcome,
      winnerId: cycle.winnerId ?? null,
      winReason: cycle.winReason ?? null,
      duelEndTime: cycle.duelEndTime ?? null,
      seed: cycle.seed ?? null,
      replayHash: cycle.replayHash ?? null,
      observedAt,
    };
  }

  observeCancellation(notice, observedAt) {
    if (!notice || typeof notice !== "object") return;
    const cycleId = isNonEmptyString(notice.cycleId) ? notice.cycleId : null;
    const reason = isNonEmptyString(notice.reason) ? notice.reason : null;
    if (
      !cycleId ||
      notice.outcome !== "cancelled" ||
      !reason ||
      !isFiniteNumber(notice.occurredAt) ||
      !isFiniteNumber(notice.expiresAt) ||
      notice.expiresAt <= notice.occurredAt
    ) {
      this.recordIssue("invalid_cancellation_notice", cycleId);
      return;
    }

    const key = `${cycleId}:${reason}:${notice.occurredAt}`;
    if (this.cancellationKeys.has(key)) return;
    this.cancellationKeys.add(key);

    let tracked = this.cycles.get(cycleId);
    if (!tracked) {
      tracked = createCycle({ cycleId }, observedAt);
      this.cycles.set(cycleId, tracked);
    }
    if (tracked.resolution) {
      this.recordIssue("resolved_cycle_cancelled", cycleId);
    }
    if (tracked.cancellation && tracked.cancellation.reason !== reason) {
      this.recordIssue("contradictory_cancellation", cycleId);
    }
    tracked.cancellation = { reason, observedAt };
  }

  summary() {
    const trackedCycles = [...this.cycles.values()];
    const resolutions = trackedCycles.filter((cycle) => cycle.resolution);
    const cancellations = trackedCycles.filter((cycle) => cycle.cancellation);
    const phaseCoverageEligibleResolutions = resolutions.filter(
      (cycle) => cycle.phaseCoverageEligible,
    );
    const fullyObservedResolutions = phaseCoverageEligibleResolutions.filter(
      (cycle) => ACTIVE_PHASES.every((phase) => cycle.phases.has(phase)),
    );
    const phaseCoverageExcludedResolutions = resolutions.filter(
      (cycle) => !cycle.phaseCoverageEligible,
    );
    const phaseCoverageIncompleteSamples = phaseCoverageEligibleResolutions
      .filter(
        (cycle) => !ACTIVE_PHASES.every((phase) => cycle.phases.has(phase)),
      )
      .slice(0, 20)
      .map((cycle) => ({
        cycleId: cycle.cycleId,
        missingPhases: ACTIVE_PHASES.filter(
          (phase) => !cycle.phases.has(phase),
        ),
      }));
    const cancellationReasons = {};
    for (const cycle of cancellations) {
      const reason = cycle.cancellation.reason;
      cancellationReasons[reason] = (cancellationReasons[reason] ?? 0) + 1;
    }
    const firstHitDurations = resolutions
      .map((cycle) =>
        cycle.firstHitAt != null && cycle.fightStartTime != null
          ? cycle.firstHitAt - cycle.fightStartTime
          : null,
      )
      .filter((value) => value != null && value >= 0);

    return {
      observations: this.observations,
      validObservations: this.validObservations,
      trackedCycles: trackedCycles.length,
      resolvedDuels: resolutions.length,
      phaseCoverageEligibleResolvedDuels:
        phaseCoverageEligibleResolutions.length,
      fullyObservedResolvedDuels: fullyObservedResolutions.length,
      phaseCoverageExcludedResolvedDuels:
        phaseCoverageExcludedResolutions.length,
      phaseCoverageIncompleteSamples,
      cancelledDuels: cancellations.length,
      wins: resolutions.filter((cycle) => cycle.resolution.outcome === "win")
        .length,
      draws: resolutions.filter((cycle) => cycle.resolution.outcome === "draw")
        .length,
      cyclesWithTwoSidedDamage: resolutions.filter(
        (cycle) => cycle.maxDamageAgent1 > 0 && cycle.maxDamageAgent2 > 0,
      ).length,
      totalDamageDealt: resolutions.reduce(
        (sum, cycle) => sum + cycle.maxDamageAgent1 + cycle.maxDamageAgent2,
        0,
      ),
      totalHitsLanded: resolutions.reduce(
        (sum, cycle) => sum + cycle.maxHitsAgent1 + cycle.maxHitsAgent2,
        0,
      ),
      timeToFirstHitMs: summarizeDurations(firstHitDurations),
      cancellationReasons,
      phaseCounts: { ...this.phaseCounts },
      integrityViolationCount: this.issueKeys.size,
      integrityViolationSamples: [...this.issues],
    };
  }
}

/**
 * @param {{
 *   integrityViolationCount: number,
 *   resolvedDuels: number,
 *   phaseCoverageEligibleResolvedDuels: number,
 *   fullyObservedResolvedDuels: number,
 *   cancelledDuels: number,
 * }} summary
 * @param {{
 *   minResolvedDuels?: number,
 *   maxCancelledDuels?: number | null,
 *   requireFullPhaseCoverage?: boolean,
 * }} [options]
 * @returns {Array<{ label: string, pass: boolean, actual: number | string }>}
 */
export function buildStreamingSoakChecks(
  summary,
  {
    minResolvedDuels = 0,
    maxCancelledDuels = null,
    requireFullPhaseCoverage = false,
  } = {},
) {
  const checks = [
    {
      label: "duel lifecycle integrity violations == 0",
      pass: summary.integrityViolationCount === 0,
      actual: summary.integrityViolationCount,
    },
  ];

  if (minResolvedDuels > 0) {
    checks.push({
      label: `authoritative resolved duels >= ${minResolvedDuels}`,
      pass: summary.resolvedDuels >= minResolvedDuels,
      actual: summary.resolvedDuels,
    });
  }
  if (maxCancelledDuels != null) {
    checks.push({
      label: `observed cancelled duels <= ${maxCancelledDuels}`,
      pass: summary.cancelledDuels <= maxCancelledDuels,
      actual: summary.cancelledDuels,
    });
  }
  if (requireFullPhaseCoverage) {
    checks.push({
      label: "every observed resolution has full phase coverage",
      pass:
        summary.phaseCoverageEligibleResolvedDuels > 0 &&
        summary.fullyObservedResolvedDuels ===
          summary.phaseCoverageEligibleResolvedDuels,
      actual: `${summary.fullyObservedResolvedDuels}/${summary.phaseCoverageEligibleResolvedDuels}`,
    });
  }

  return checks;
}
