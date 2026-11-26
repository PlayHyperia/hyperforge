import {
  DUEL_SCENE_CAPTURE_LIMITS,
  parseDuelSafeCrop,
} from "./duel-capture-scenarios.mjs";

const DUEL_MOTION_COMBAT_ROLES = new Set(["melee", "ranged", "mage"]);

export function parseDuelMotionRoles(value, multiStyle = false) {
  const roles = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const expectedCount = multiStyle ? 3 : 2;
  const invalidMultiStyleSet =
    multiStyle && new Set(roles).size !== expectedCount;
  if (
    roles.length !== expectedCount ||
    invalidMultiStyleSet ||
    roles.some((role) => !DUEL_MOTION_COMBAT_ROLES.has(role))
  ) {
    throw new TypeError(
      multiStyle
        ? "multi-style roles must contain melee,ranged,mage exactly once"
        : "roles must contain exactly two melee/ranged/mage values; same-style pairs are allowed",
    );
  }
  return roles;
}

export function parseDuelMotionSafeCrop(maxNdcXValue, maxNdcYValue) {
  return parseDuelSafeCrop(maxNdcXValue, maxNdcYValue);
}

export const DUEL_MOTION_TELEMETRY_LIMITS = Object.freeze({
  minimumSamples: 32,
  minimumObservationMs: 7_500,
  minimumTravelXZPerAgent: 0.35,
  minimumMovingSegmentsPerAgent: 4,
  minimumDiagonalSegments: 2,
  minimumDiagonalSegmentsPerAgent: 2,
  minimumDirectionCoverage: 3,
  maximumStationaryRatio: 0.85,
  maximumSharpReversalRatio: 0.75,
  maximumFacingP95Degrees: 20,
  maximumFacingDegrees: 75,
  maximumYawDeltaP95Degrees: 45,
  maximumYawDeltaDegrees: 120,
  minimumFightingFrames: 240,
  maximumFrameIntervalP50Ms: 18.5,
  maximumFrameIntervalP95Ms: 25,
  maximumFrameIntervalP99Ms: 33.34,
  maximumFrameWorkP95Ms: 8,
  maximumFrameWorkP99Ms: 16,
  maximumOver33MsFrameRatio: 0.02,
});

export const DUEL_FIGHT_COMPOSITION_LIMITS = Object.freeze({
  minimumBodyHeightNdcP05: 0.32,
  minimumBodyHeightNdcP50: 0.38,
  maximumBodyHeightNdcP95: 0.78,
  maximumBodyProjectionAbsX: 0.72,
  minimumFootNdcY: -0.78,
  maximumHeadNdcY: 0.58,
  minimumFrameCenterNdcY: -0.24,
  maximumFrameCenterNdcY: 0.2,
  maximumFrameCenterDeltaP95: 0.12,
  maximumFrameCenterDelta: 0.3,
  maximumBodyScaleDeltaP95: 0.08,
  maximumBodyScaleDelta: 0.2,
});

const MOVEMENT_EPSILON = 0.015;
const DIAGONAL_EPSILON = 0.01;
const DUEL_MOTION_SAMPLING_RACES = new Set([
  "browser_server_state_disagreement",
  "scene:camera_expected_target_mismatch",
  "scene:camera_target_lost",
  "scene:cycle_mismatch",
  "scene:phase_mismatch",
  "scene:scene_cycle_mismatch",
  "scene:scene_phase_mismatch",
  "post_screenshot_state_invalid",
]);

/**
 * Browser state, server state, and scene telemetry are independent snapshots.
 * A phase/cycle transition can legitimately land between those reads; the
 * capture must retry that poll without treating an unretained sample as a
 * renderer integrity failure.
 */
export function isDuelMotionSamplingRace(reason) {
  return DUEL_MOTION_SAMPLING_RACES.has(reason);
}

function round(value, places = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function percentile(values, quantile) {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return round(sorted[index]);
}

function distanceXZ(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return null;
  return Math.hypot(left[0] - right[0], left[2] - right[2]);
}

function normalizedYawDegrees(quaternion) {
  if (!Array.isArray(quaternion) || quaternion.length !== 4) return null;
  const length = Math.hypot(...quaternion);
  if (!Number.isFinite(length) || length < 0.001) return null;
  const [rawX, rawY, rawZ, rawW] = quaternion;
  const x = rawX / length;
  const y = rawY / length;
  const z = rawZ / length;
  const w = rawW / length;
  const forwardX = -2 * (x * z + w * y);
  const forwardZ = -1 + 2 * (x * x + y * y);
  return (Math.atan2(forwardX, forwardZ) * 180) / Math.PI;
}

function angularDistanceDegrees(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.abs(((((right - left + 180) % 360) + 360) % 360) - 180);
}

function metricSummary(values) {
  const finite = values.filter(Number.isFinite);
  return {
    samples: finite.length,
    min: finite.length > 0 ? round(Math.min(...finite)) : null,
    p05: percentile(finite, 0.05),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
    max: finite.length > 0 ? round(Math.max(...finite)) : null,
  };
}

function finiteNdcPosition(value) {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every(Number.isFinite)
    ? value
    : null;
}

function check(label, pass, actual) {
  return { label, pass: pass === true, actual: String(actual) };
}

function summarizeAgent(agentId, observations) {
  const ordered = [...observations].sort(
    (left, right) => left.observedAt - right.observedAt,
  );
  let travelXZ = 0;
  let movingSegments = 0;
  let stationarySegments = 0;
  let diagonalSegments = 0;
  let sharpReversals = 0;
  let comparableMovementPairs = 0;
  const directionCoverage = new Set();
  const yawDeltas = [];
  const movementVectors = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.cycleId !== current.cycleId) {
      movementVectors.length = 0;
      continue;
    }
    const dx = current.renderPosition[0] - previous.renderPosition[0];
    const dz = current.renderPosition[2] - previous.renderPosition[2];
    const distance = Math.hypot(dx, dz);
    travelXZ += distance;
    if (distance >= MOVEMENT_EPSILON) {
      movingSegments += 1;
      if (dx >= MOVEMENT_EPSILON) directionCoverage.add("+x");
      if (dx <= -MOVEMENT_EPSILON) directionCoverage.add("-x");
      if (dz >= MOVEMENT_EPSILON) directionCoverage.add("+z");
      if (dz <= -MOVEMENT_EPSILON) directionCoverage.add("-z");
      if (
        Math.abs(dx) >= DIAGONAL_EPSILON &&
        Math.abs(dz) >= DIAGONAL_EPSILON
      ) {
        diagonalSegments += 1;
      }
      const normalized = [dx / distance, dz / distance];
      const previousVector = movementVectors[movementVectors.length - 1];
      if (previousVector) {
        comparableMovementPairs += 1;
        if (
          previousVector[0] * normalized[0] +
            previousVector[1] * normalized[1] <=
          -0.5
        ) {
          sharpReversals += 1;
        }
      }
      movementVectors.push(normalized);
    } else {
      stationarySegments += 1;
    }

    const yawDelta = angularDistanceDegrees(
      normalizedYawDegrees(previous.renderQuaternion),
      normalizedYawDegrees(current.renderQuaternion),
    );
    if (yawDelta != null) yawDeltas.push(yawDelta);
  }

  const totalSegments = movingSegments + stationarySegments;
  return {
    id: agentId,
    role: ordered.find((entry) => entry.role)?.role ?? null,
    samples: ordered.length,
    travelXZ: round(travelXZ),
    movingSegments,
    stationarySegments,
    stationaryRatio:
      totalSegments > 0 ? round(stationarySegments / totalSegments) : null,
    diagonalSegments,
    directionCoverage: [...directionCoverage].sort(),
    sharpReversals,
    sharpReversalRatio:
      comparableMovementPairs > 0
        ? round(sharpReversals / comparableMovementPairs)
        : 0,
    facingErrorDegrees: metricSummary(
      ordered.map((entry) => entry.facingTargetErrorDegrees),
    ),
    yawDeltaDegrees: metricSummary(yawDeltas),
    simulationDriftXZ: metricSummary(
      ordered.map((entry) =>
        distanceXZ(entry.simulationPosition, entry.renderPosition),
      ),
    ),
    avatarDriftXZ: metricSummary(
      ordered.map((entry) =>
        distanceXZ(entry.avatarPosition, entry.renderPosition),
      ),
    ),
    outsideArenaSamples: ordered.filter((entry) => !entry.insideCombatArena)
      .length,
    outsideAssignedArenaSamples: ordered.filter(
      (entry) => entry.insideAssignedCombatArena === false,
    ).length,
    missingAssignedArenaSamples: ordered.filter(
      (entry) => typeof entry.insideAssignedCombatArena !== "boolean",
    ).length,
    occludedHeadSamples: ordered.filter(
      (entry) => entry.cameraLineOfSight?.head === false,
    ).length,
    occludedTorsoSamples: ordered.filter(
      (entry) => entry.cameraLineOfSight?.torso === false,
    ).length,
    occludedLowerBodySamples: ordered.filter(
      (entry) => entry.cameraLineOfSight?.lowerBody === false,
    ).length,
    missingLineOfSightSamples: ordered.filter(
      (entry) =>
        typeof entry.cameraLineOfSight?.head !== "boolean" ||
        typeof entry.cameraLineOfSight?.torso !== "boolean" ||
        typeof entry.cameraLineOfSight?.lowerBody !== "boolean",
    ).length,
    hiddenSamples: ordered.filter((entry) => !entry.visible).length,
    inactiveSamples: ordered.filter((entry) => !entry.active).length,
    avatarNotReadySamples: ordered.filter((entry) => !entry.avatarReady).length,
  };
}

const MAX_SCREENSHOT_PERFORMANCE_CHARACTERS = 262_144;

function hasScreenshotPerformanceEnvelope(value) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schemaVersion === 1 &&
    Number.isSafeInteger(value.sessionStartedAt) &&
    value.sessionStartedAt >= 0 &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= value.sessionStartedAt &&
    value.uptimeMs === value.updatedAt - value.sessionStartedAt &&
    Number.isSafeInteger(value.overall?.frames) &&
    value.overall.frames >= 0
  );
}

export function cloneDuelScreenshotPerformanceSnapshot(value) {
  if (!hasScreenshotPerformanceEnvelope(value)) {
    throw new TypeError("Screenshot performance snapshot envelope is invalid");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_SCREENSHOT_PERFORMANCE_CHARACTERS) {
    throw new RangeError(
      "Screenshot performance snapshot exceeds retention limit",
    );
  }
  return JSON.parse(serialized);
}

export function evaluateDuelScreenshotPerformanceSnapshot({
  before,
  after,
  captureEndedAt,
  afterObservedAt,
}) {
  if (
    !hasScreenshotPerformanceEnvelope(before) ||
    !hasScreenshotPerformanceEnvelope(after) ||
    !Number.isSafeInteger(captureEndedAt) ||
    !Number.isSafeInteger(afterObservedAt) ||
    captureEndedAt < before.updatedAt ||
    afterObservedAt < captureEndedAt ||
    after.updatedAt > afterObservedAt
  ) {
    return { status: "invalid", reason: "invalid_snapshot_or_clock" };
  }
  if (after.sessionStartedAt !== before.sessionStartedAt) {
    return { status: "invalid", reason: "telemetry_session_changed" };
  }
  if (
    after.updatedAt < before.updatedAt ||
    after.overall.frames < before.overall.frames
  ) {
    return { status: "invalid", reason: "telemetry_progress_regressed" };
  }
  if (
    after.updatedAt <= before.updatedAt ||
    after.overall.frames <= before.overall.frames ||
    after.updatedAt < captureEndedAt
  ) {
    return { status: "pending", reason: "cached_or_pre_capture_snapshot" };
  }
  return { status: "ready", reason: null };
}

function summarizePerformance(performance) {
  const fighting = performance?.byPhase?.FIGHTING;
  const frames = fighting?.frames;
  const interval = fighting?.frameIntervalMs;
  const work = fighting?.frameWorkMs;
  const over33 = fighting?.frameBudget?.above33_33Ms;
  const over33Ratio =
    Number.isFinite(frames) && frames > 0 && Number.isFinite(over33)
      ? over33 / frames
      : null;
  const longFrames = Array.isArray(performance?.longFrames)
    ? performance.longFrames
        .filter((entry) => entry?.phase === "FIGHTING")
        .slice(-32)
        .map((entry) => {
          const observedAt =
            Number.isSafeInteger(performance.sessionStartedAt) &&
            performance.sessionStartedAt >= 0 &&
            Number.isSafeInteger(entry.uptimeMs) &&
            entry.uptimeMs >= 0 &&
            Number.isSafeInteger(
              performance.sessionStartedAt + entry.uptimeMs,
            ) &&
            performance.sessionStartedAt + entry.uptimeMs <=
              performance.updatedAt
              ? performance.sessionStartedAt + entry.uptimeMs
              : null;
          return {
            frameSequence: entry.frameSequence ?? null,
            phaseFrame: entry.phaseFrame ?? null,
            uptimeMs: entry.uptimeMs ?? null,
            observedAt,
            // Date.now is sampled after the monotonic frame interval, so this
            // start is an estimate for correlation, never a cause attribution.
            estimatedIntervalStartedAt:
              observedAt !== null &&
              Number.isFinite(entry.frameIntervalMs) &&
              entry.frameIntervalMs >= 0
                ? observedAt - entry.frameIntervalMs
                : null,
            frameIntervalMs: entry.frameIntervalMs ?? null,
            frameWorkMs: entry.frameWorkMs ?? null,
            cpuMs: entry.cpuMs ?? null,
            renderSubmitMs: entry.renderSubmitMs ?? null,
            drawCalls: entry.drawCalls ?? null,
            triangles: entry.triangles ?? null,
            textures: entry.textures ?? null,
            geometries: entry.geometries ?? null,
            jsHeapUsedBytes: entry.jsHeapUsedBytes ?? null,
            resourceEntries: entry.resourceEntries ?? null,
            topSystems: Array.isArray(entry.topSystems)
              ? entry.topSystems.slice(0, 8)
              : [],
          };
        })
    : [];
  return {
    sessionStartedAt: Number.isSafeInteger(performance?.sessionStartedAt)
      ? performance.sessionStartedAt
      : null,
    overallFrames: Number.isSafeInteger(performance?.overall?.frames)
      ? performance.overall.frames
      : null,
    frames: Number.isFinite(frames) ? frames : null,
    frameIntervalMs: interval ?? null,
    frameWorkMs: work ?? null,
    cpuMs: fighting?.cpuMs ?? null,
    renderSubmitMs: fighting?.renderSubmitMs ?? null,
    framesAbove33_33Ms: Number.isFinite(over33) ? over33 : null,
    over33_33MsRatio: round(over33Ratio),
    renderer: fighting?.renderer ?? null,
    viewport: performance?.viewport ?? null,
    jsHeap: performance?.jsHeap ?? null,
    resources: performance?.resources ?? null,
    longFrames,
    snapshotUpdatedAt: Number.isSafeInteger(performance?.updatedAt)
      ? performance.updatedAt
      : null,
  };
}

export function summarizeDuelStyleSwitchTelemetry(
  samples,
  maximumUiStyleSwitchEvents = 0,
) {
  const byAgent = new Map();
  for (const sample of [...samples].sort(
    (left, right) => left.observedAt - right.observedAt,
  )) {
    for (const agent of sample.agents) {
      const entry = byAgent.get(agent.id) ?? {
        id: agent.id,
        roles: new Set(),
        switches: 0,
        lastCycleId: null,
        lastRole: null,
      };
      entry.roles.add(agent.role);
      if (
        entry.lastCycleId === sample.cycleId &&
        entry.lastRole !== null &&
        entry.lastRole !== agent.role
      ) {
        entry.switches += 1;
      }
      entry.lastCycleId = sample.cycleId;
      entry.lastRole = agent.role;
      byAgent.set(agent.id, entry);
    }
  }
  const agents = [...byAgent.values()]
    .map((entry) => ({
      id: entry.id,
      roles: [...entry.roles].sort(),
      switches: entry.switches,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    agents,
    totalSwitches: agents.reduce((total, agent) => total + agent.switches, 0),
    maximumUiStyleSwitchEvents,
  };
}

export function evaluateDuelStyleSwitchTelemetry(metrics, expectedRoles) {
  const observedRoles = [
    ...new Set(metrics.agents.flatMap((agent) => agent.roles)),
  ].sort();
  const expected = [...new Set(expectedRoles)].sort();
  return [
    check(
      "both contestants execute a frozen mid-fight role switch",
      metrics.agents.length === 2 &&
        metrics.agents.every((agent) => agent.switches >= 1),
      metrics.agents.map((agent) => `${agent.id}:${agent.switches}`).join(","),
    ),
    check(
      "all frozen combat roles are observed live",
      JSON.stringify(observedRoles) === JSON.stringify(expected),
      observedRoles.join(","),
    ),
    check(
      "style-switch event is visible in the fight log",
      metrics.maximumUiStyleSwitchEvents >= 1,
      metrics.maximumUiStyleSwitchEvents,
    ),
  ];
}

export const DUEL_HIT_REACTION_TELEMETRY_LIMITS = Object.freeze({
  requiredBoneCount: 5,
  minimumHealthDropEvents: 4,
  minimumPositiveWeightSamples: 2,
  maximumAlignmentMs: 500,
  resolutionGraceMs: 350,
  minimumCleanResolutionSamples: 2,
  maximumAuthoredMotionActions: 8,
});

function normalizeAuthoredMotionEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.overflow !== "boolean" ||
    !Number.isSafeInteger(value.invalidActionCount) ||
    value.invalidActionCount < 0 ||
    value.invalidActionCount >
      DUEL_HIT_REACTION_TELEMETRY_LIMITS.maximumAuthoredMotionActions + 1 ||
    !Array.isArray(value.actions) ||
    value.actions.length >
      DUEL_HIT_REACTION_TELEMETRY_LIMITS.maximumAuthoredMotionActions
  ) {
    return null;
  }
  const actions = [];
  for (const action of value.actions) {
    if (
      !action ||
      typeof action !== "object" ||
      Array.isArray(action) ||
      typeof action.url !== "string" ||
      action.url.length === 0 ||
      action.url.length > 200 ||
      action.url !== action.url.trim() ||
      /[?#\u0000-\u001f\u007f]/.test(action.url) ||
      typeof action.running !== "boolean" ||
      typeof action.paused !== "boolean" ||
      !Number.isFinite(action.effectiveWeight) ||
      action.effectiveWeight <= 0 ||
      action.effectiveWeight > 1
    ) {
      return null;
    }
    actions.push(action);
  }
  return {
    clean: !value.overflow && value.invalidActionCount === 0,
    actions,
  };
}

function isActiveNonIdleAuthoredMotion(action) {
  return (
    action.running &&
    !action.paused &&
    action.effectiveWeight > 0 &&
    !/(?:^|[-_/])(idle|death)(?:[-_.?/]|$)/i.test(action.url)
  );
}

function exactRequiredHitReactionBoneCount(reaction) {
  return Number.isSafeInteger(reaction?.requiredBoneCount) &&
    reaction.requiredBoneCount >= 1 &&
    reaction.requiredBoneCount <=
      DUEL_HIT_REACTION_TELEMETRY_LIMITS.requiredBoneCount
    ? reaction.requiredBoneCount
    : DUEL_HIT_REACTION_TELEMETRY_LIMITS.requiredBoneCount;
}

export function summarizeDuelHitReactionTelemetry(samples) {
  const ordered = [...samples].sort(
    (left, right) => left.observedAt - right.observedAt,
  );
  const firstSampleByCycle = new Map();
  for (const sample of ordered) {
    if (sample?.cycleId && !firstSampleByCycle.has(sample.cycleId)) {
      firstSampleByCycle.set(sample.cycleId, sample);
    }
  }
  const incompleteCycleIds = new Set(
    [...firstSampleByCycle.entries()]
      .filter(([, sample]) =>
        (sample.agents ?? []).some((agent) => {
          const attacksLanded = Number(agent.attacksLanded);
          const hp = Number(agent.hp);
          const maxHp = Number(agent.maxHp);
          return (
            (Number.isFinite(attacksLanded) && attacksLanded > 0) ||
            (Number.isFinite(hp) &&
              Number.isFinite(maxHp) &&
              maxHp > 0 &&
              hp < maxHp)
          );
        }),
      )
      .map(([cycleId]) => cycleId),
  );
  // A capture can finish loading after a fight's first hit. Its first retained
  // trigger count is then only a baseline, while a later state update can expose
  // the corresponding HP loss as if it were new. Keep those partial cycles for
  // motion/performance evidence, but require complete observed cycles for exact
  // damage/reaction sequence accounting.
  const evaluated = ordered.filter(
    (sample) => !incompleteCycleIds.has(sample.cycleId),
  );
  const previousByCycleAgent = new Map();
  const healthDrops = [];
  const triggerIncrements = [];
  const agents = new Map();
  let expectedDiagnostics = 0;
  let retainedDiagnostics = 0;
  let expectedAuthoredMotionDiagnostics = 0;
  let retainedAuthoredMotionDiagnostics = 0;
  let invalidAuthoredMotionDiagnostics = 0;
  let positiveWeightSamples = 0;
  let activeAuthoredMotionSamples = 0;
  let sequenceResets = 0;

  for (const sample of evaluated) {
    for (const agent of sample.agents ?? []) {
      expectedDiagnostics += 1;
      const key = `${sample.cycleId}\0${agent.id}`;
      const previous = previousByCycleAgent.get(key);
      const reaction = agent.hitReaction;
      const authoredMotion = normalizeAuthoredMotionEvidence(
        agent.authoredMotion,
      );
      expectedAuthoredMotionDiagnostics += 1;
      if (authoredMotion) {
        retainedAuthoredMotionDiagnostics += 1;
        if (!authoredMotion.clean) invalidAuthoredMotionDiagnostics += 1;
      }
      const metrics = agents.get(agent.id) ?? {
        id: agent.id,
        healthDropEvents: 0,
        triggerIncrements: 0,
        positiveWeightSamples: 0,
        activeSamples: 0,
        availableBoneCounts: new Set(),
        requiredBoneCounts: new Set(),
      };

      if (reaction) {
        retainedDiagnostics += 1;
        metrics.availableBoneCounts.add(reaction.availableBoneCount);
        metrics.requiredBoneCounts.add(
          exactRequiredHitReactionBoneCount(reaction),
        );
        if (reaction.active) metrics.activeSamples += 1;
        if (reaction.currentWeight > 0) {
          positiveWeightSamples += 1;
          metrics.positiveWeightSamples += 1;
          if (
            authoredMotion?.clean &&
            authoredMotion.actions.some(isActiveNonIdleAuthoredMotion)
          ) {
            activeAuthoredMotionSamples += 1;
          }
        }
      }

      if (previous) {
        if (agent.hp < previous.hp) {
          const event = {
            agentId: agent.id,
            cycleId: sample.cycleId,
            observedAt: sample.observedAt,
            observationWindowStartMs: previous.observedAt,
            observationWindowEndMs: sample.observedAt,
            damage: previous.hp - agent.hp,
          };
          healthDrops.push(event);
          metrics.healthDropEvents += 1;
        }
        if (reaction && previous.hitReaction) {
          const delta =
            reaction.triggerCount - previous.hitReaction.triggerCount;
          if (delta < 0) {
            sequenceResets += 1;
          } else if (delta > 0) {
            triggerIncrements.push({
              agentId: agent.id,
              cycleId: sample.cycleId,
              observedAt: sample.observedAt,
              observationWindowStartMs: previous.observedAt,
              observationWindowEndMs: sample.observedAt,
              count: delta,
            });
            metrics.triggerIncrements += delta;
          }
        }
      }
      previousByCycleAgent.set(key, {
        hp: agent.hp,
        hitReaction: reaction ?? null,
        observedAt: sample.observedAt,
      });
      agents.set(agent.id, metrics);
    }
  }

  // State HP and mixer diagnostics are independent projections sampled at a
  // finite cadence. A delta therefore happened somewhere between its previous
  // and current observation, not necessarily at the current poll timestamp.
  // Compare those uncertainty windows in strict sequence order: adjacent
  // windows may touch, while a full clean sample between them exposes real
  // presentation lag and still fails the 500 ms budget.
  const observationWindowGapMs = (left, right) => {
    if (left.observationWindowEndMs < right.observationWindowStartMs) {
      return right.observationWindowStartMs - left.observationWindowEndMs;
    }
    if (right.observationWindowEndMs < left.observationWindowStartMs) {
      return left.observationWindowStartMs - right.observationWindowEndMs;
    }
    return 0;
  };
  const healthByCycleAgent = new Map();
  const triggersByCycleAgent = new Map();
  for (const drop of healthDrops) {
    const key = `${drop.cycleId}\0${drop.agentId}`;
    const entries = healthByCycleAgent.get(key) ?? [];
    entries.push(drop);
    healthByCycleAgent.set(key, entries);
  }
  for (const trigger of triggerIncrements) {
    const key = `${trigger.cycleId}\0${trigger.agentId}`;
    const entries = triggersByCycleAgent.get(key) ?? [];
    for (let index = 0; index < trigger.count; index += 1) {
      entries.push(trigger);
    }
    triggersByCycleAgent.set(key, entries);
  }
  const alignmentKeys = new Set([
    ...healthByCycleAgent.keys(),
    ...triggersByCycleAgent.keys(),
  ]);
  let unmatchedHealthDrops = 0;
  let unmatchedTriggerIncrements = 0;
  let maximumAlignmentGapMs = 0;
  let maximumObservedPointSkewMs = 0;
  for (const key of alignmentKeys) {
    const drops = healthByCycleAgent.get(key) ?? [];
    const triggers = triggersByCycleAgent.get(key) ?? [];
    const pairedCount = Math.min(drops.length, triggers.length);
    for (let index = 0; index < pairedCount; index += 1) {
      const gapMs = observationWindowGapMs(drops[index], triggers[index]);
      maximumAlignmentGapMs = Math.max(maximumAlignmentGapMs, gapMs);
      maximumObservedPointSkewMs = Math.max(
        maximumObservedPointSkewMs,
        Math.abs(drops[index].observedAt - triggers[index].observedAt),
      );
      if (gapMs > DUEL_HIT_REACTION_TELEMETRY_LIMITS.maximumAlignmentMs) {
        unmatchedHealthDrops += 1;
        unmatchedTriggerIncrements += 1;
      }
    }
    unmatchedHealthDrops += Math.max(0, drops.length - triggers.length);
    unmatchedTriggerIncrements += Math.max(0, triggers.length - drops.length);
  }
  const agentMetrics = [...agents.values()]
    .map((entry) => ({
      ...entry,
      availableBoneCounts: [...entry.availableBoneCounts].sort(
        (left, right) => left - right,
      ),
      requiredBoneCounts: [...entry.requiredBoneCounts].sort(
        (left, right) => left - right,
      ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const checks = [
    check(
      "hit-reaction alignment includes a complete observed duel cycle",
      firstSampleByCycle.size > incompleteCycleIds.size,
      `${firstSampleByCycle.size - incompleteCycleIds.size} complete, ${incompleteCycleIds.size} partial`,
    ),
    check(
      "every retained contestant exposes complete hit-reaction diagnostics",
      expectedDiagnostics > 0 &&
        retainedDiagnostics === expectedDiagnostics &&
        agentMetrics.length === 2 &&
        agentMetrics.every(
          (agent) =>
            agent.availableBoneCounts.length === 1 &&
            agent.requiredBoneCounts.length === 1 &&
            agent.availableBoneCounts[0] === agent.requiredBoneCounts[0],
        ),
      `${retainedDiagnostics}/${expectedDiagnostics} samples; ${agentMetrics
        .map(
          (agent) =>
            `${agent.id}:${agent.availableBoneCounts.join("/")} of ${agent.requiredBoneCounts.join("/")}`,
        )
        .join(",")}`,
    ),
    check(
      "both contestants receive repeated authoritative damage reactions",
      healthDrops.length >=
        DUEL_HIT_REACTION_TELEMETRY_LIMITS.minimumHealthDropEvents &&
        agentMetrics.length === 2 &&
        agentMetrics.every(
          (agent) => agent.healthDropEvents > 0 && agent.triggerIncrements > 0,
        ),
      `${healthDrops.length} health drops; ${triggerIncrements.reduce(
        (total, event) => total + event.count,
        0,
      )} triggers`,
    ),
    check(
      "every retained contestant exposes bounded authored-motion diagnostics",
      expectedAuthoredMotionDiagnostics > 0 &&
        retainedAuthoredMotionDiagnostics ===
          expectedAuthoredMotionDiagnostics &&
        invalidAuthoredMotionDiagnostics === 0,
      `${retainedAuthoredMotionDiagnostics}/${expectedAuthoredMotionDiagnostics} samples; ${invalidAuthoredMotionDiagnostics} invalid or overflowed`,
    ),
    check(
      "health loss and avatar reaction sequences remain aligned",
      unmatchedHealthDrops === 0 &&
        unmatchedTriggerIncrements === 0 &&
        sequenceResets === 0,
      `unmatched health=${unmatchedHealthDrops}, triggers=${unmatchedTriggerIncrements}, resets=${sequenceResets}, window gap max=${maximumAlignmentGapMs}ms`,
    ),
    check(
      "non-zero reaction weight is sampled in the real mixer",
      positiveWeightSamples >=
        DUEL_HIT_REACTION_TELEMETRY_LIMITS.minimumPositiveWeightSamples,
      `${positiveWeightSamples} weighted samples`,
    ),
    check(
      "reaction overlays an active authored motion",
      activeAuthoredMotionSamples > 0,
      `${activeAuthoredMotionSamples} weighted non-idle samples`,
    ),
  ];

  return {
    ok: checks.every((entry) => entry.pass),
    metrics: {
      sampleCount: ordered.length,
      evaluatedSampleCount: evaluated.length,
      completeCycleCount: firstSampleByCycle.size - incompleteCycleIds.size,
      incompleteCycleCount: incompleteCycleIds.size,
      retainedDiagnostics,
      expectedDiagnostics,
      retainedAuthoredMotionDiagnostics,
      expectedAuthoredMotionDiagnostics,
      invalidAuthoredMotionDiagnostics,
      healthDropEvents: healthDrops.length,
      triggerIncrements: triggerIncrements.reduce(
        (total, event) => total + event.count,
        0,
      ),
      positiveWeightSamples,
      activeAuthoredMotionSamples,
      unmatchedHealthDrops,
      unmatchedTriggerIncrements,
      maximumAlignmentGapMs,
      maximumObservedPointSkewMs,
      sequenceResets,
      agents: agentMetrics,
    },
    checks,
  };
}

/**
 * Prove that a reaction sequence observed during a fight is fully removed from
 * the same avatars after that cycle enters resolution. The grace period allows
 * an in-flight 280 ms recoil to finish, but every later retained resolution
 * sample must be clean and preserve the monotonically increasing trigger
 * sequence.
 */
export function summarizeDuelHitReactionResolutionTelemetry(
  fightingSamples,
  lifecycleSamples,
) {
  const fightingByCycle = new Map();
  for (const sample of fightingSamples ?? []) {
    if (sample?.cycleId && sample?.agents?.length === 2) {
      const retained = fightingByCycle.get(sample.cycleId) ?? [];
      retained.push(sample);
      fightingByCycle.set(sample.cycleId, retained);
    }
  }

  const resolutionByCycle = new Map();
  for (const sample of lifecycleSamples ?? []) {
    if (
      sample?.phase === "RESOLUTION" &&
      sample?.cycleId &&
      sample?.agents?.length === 2
    ) {
      const retained = resolutionByCycle.get(sample.cycleId) ?? [];
      retained.push(sample);
      resolutionByCycle.set(sample.cycleId, retained);
    }
  }

  const cycles = [];
  for (const [cycleId, rawFighting] of fightingByCycle) {
    const rawResolution = resolutionByCycle.get(cycleId);
    if (!rawResolution?.length) continue;
    const fighting = [...rawFighting].sort(
      (left, right) => left.observedAt - right.observedAt,
    );
    const resolution = [...rawResolution].sort(
      (left, right) => left.observedAt - right.observedAt,
    );
    const fightingAgents = new Map();
    for (const sample of fighting) {
      for (const agent of sample.agents) {
        const previous = fightingAgents.get(agent.id) ?? {
          triggerCount: 0,
          requiredBoneCount: exactRequiredHitReactionBoneCount(
            agent.hitReaction,
          ),
        };
        fightingAgents.set(agent.id, {
          triggerCount: Math.max(
            previous.triggerCount,
            agent.hitReaction?.triggerCount ?? 0,
          ),
          requiredBoneCount: exactRequiredHitReactionBoneCount(
            agent.hitReaction,
          ),
        });
      }
    }
    if (
      fightingAgents.size !== 2 ||
      ![...fightingAgents.values()].some(({ triggerCount }) => triggerCount > 0)
    ) {
      continue;
    }

    const graceEndsAt =
      resolution[0].observedAt +
      DUEL_HIT_REACTION_TELEMETRY_LIMITS.resolutionGraceMs;
    const settled = resolution.filter(
      (sample) => sample.observedAt >= graceEndsAt,
    );
    let dirtySamples = 0;
    let sequenceRegressions = 0;
    let completeDiagnostics = 0;
    for (const sample of settled) {
      let sampleClean = true;
      for (const agent of sample.agents) {
        const reaction = agent.hitReaction;
        if (
          reaction &&
          reaction.availableBoneCount ===
            fightingAgents.get(agent.id)?.requiredBoneCount
        ) {
          completeDiagnostics += 1;
        } else {
          sampleClean = false;
        }
        if (
          !reaction ||
          reaction.active ||
          reaction.elapsedSeconds !== null ||
          reaction.currentWeight !== 0 ||
          reaction.lastIntensity !== 0
        ) {
          sampleClean = false;
        }
        if (
          reaction &&
          reaction.triggerCount <
            (fightingAgents.get(agent.id)?.triggerCount ?? 0)
        ) {
          sequenceRegressions += 1;
          sampleClean = false;
        }
      }
      if (!sampleClean) dirtySamples += 1;
    }
    cycles.push({
      cycleId,
      fightingSamples: fighting.length,
      resolutionSamples: resolution.length,
      settledSamples: settled.length,
      completeDiagnostics,
      expectedDiagnostics: settled.length * 2,
      dirtySamples,
      sequenceRegressions,
      clean:
        settled.length >=
          DUEL_HIT_REACTION_TELEMETRY_LIMITS.minimumCleanResolutionSamples &&
        completeDiagnostics === settled.length * 2 &&
        dirtySamples === 0 &&
        sequenceRegressions === 0,
    });
  }

  const cleanCycles = cycles.filter((cycle) => cycle.clean);
  const checks = [
    check(
      "a reacted fighting cycle reaches sampled resolution",
      cycles.length > 0,
      `${cycles.length} paired cycles`,
    ),
    check(
      "post-fight reaction offsets fully clear after the bounded grace period",
      cleanCycles.length > 0,
      cycles.length > 0
        ? cycles
            .map(
              (cycle) =>
                `${cycle.cycleId}:settled=${cycle.settledSamples},dirty=${cycle.dirtySamples}`,
            )
            .join(", ")
        : "no paired cycle",
    ),
    check(
      "reaction trigger sequences remain monotonic through resolution",
      cleanCycles.length > 0 &&
        cycles.every((cycle) => cycle.sequenceRegressions === 0),
      `${cycles.reduce(
        (total, cycle) => total + cycle.sequenceRegressions,
        0,
      )} regressions`,
    ),
  ];

  return {
    ok: checks.every((entry) => entry.pass),
    metrics: {
      fightingCycleCount: fightingByCycle.size,
      resolutionCycleCount: resolutionByCycle.size,
      pairedCycleCount: cycles.length,
      cleanCycleCount: cleanCycles.length,
      cycles,
    },
    checks,
  };
}

export function summarizeDuelMotionTelemetry({
  samples,
  performance,
  expectedRoles,
  safeCrop = null,
}) {
  const orderedSamples = [...samples].sort(
    (left, right) => left.observedAt - right.observedAt,
  );
  const cycles = new Map();
  const agentObservations = new Map();
  const observedRoles = new Set();
  const separations = [];
  const projectedPositions = [];
  const projectedBodies = [];
  const compositionFrames = [];

  for (const sample of orderedSamples) {
    const times = cycles.get(sample.cycleId) ?? [];
    times.push(sample.observedAt);
    cycles.set(sample.cycleId, times);
    if (Number.isFinite(sample.renderedSeparationXZ)) {
      separations.push(sample.renderedSeparationXZ);
    }
    const sampleBodies = [];
    for (const agent of sample.agents) {
      observedRoles.add(agent.role);
      const foot = finiteNdcPosition(agent.ndcPosition);
      const head = finiteNdcPosition(agent.ndcHeadPosition);
      if (foot) {
        projectedPositions.push(foot);
      }
      if (foot && head) {
        const body = {
          foot,
          head,
          height: head[1] - foot[1],
          centerX: (head[0] + foot[0]) * 0.5,
          centerY: (head[1] + foot[1]) * 0.5,
          maximumAbsX: Math.max(Math.abs(head[0]), Math.abs(foot[0])),
        };
        projectedBodies.push(body);
        sampleBodies.push(body);
      }
      const observations = agentObservations.get(agent.id) ?? [];
      observations.push({
        ...agent,
        observedAt: sample.observedAt,
        cycleId: sample.cycleId,
      });
      agentObservations.set(agent.id, observations);
    }
    if (sampleBodies.length === 2) {
      compositionFrames.push({
        cycleId: sample.cycleId,
        centerX: (sampleBodies[0].centerX + sampleBodies[1].centerX) * 0.5,
        centerY: (sampleBodies[0].centerY + sampleBodies[1].centerY) * 0.5,
        bodyScale: (sampleBodies[0].height + sampleBodies[1].height) * 0.5,
      });
    }
  }

  const observationMs = [...cycles.values()].reduce((total, timestamps) => {
    if (timestamps.length < 2) return total;
    return total + Math.max(...timestamps) - Math.min(...timestamps);
  }, 0);
  const agents = [...agentObservations.entries()]
    .map(([agentId, observations]) => summarizeAgent(agentId, observations))
    .sort((left, right) => left.id.localeCompare(right.id));
  const performanceSummary = summarizePerformance(performance);
  const expectedRoleSet = [...new Set(expectedRoles)].sort();
  const observedRoleSet = [...observedRoles].sort();
  const combinedDiagonalSegments = agents.reduce(
    (total, agent) => total + agent.diagonalSegments,
    0,
  );
  const combinedDirectionCoverage = [
    ...new Set(agents.flatMap((agent) => agent.directionCoverage)),
  ].sort();
  const containmentFailures = agents.reduce(
    (total, agent) =>
      total +
      agent.outsideArenaSamples +
      agent.hiddenSamples +
      agent.inactiveSamples +
      agent.avatarNotReadySamples,
    0,
  );
  const assignedArenaFailures = agents.reduce(
    (total, agent) =>
      total +
      agent.outsideAssignedArenaSamples +
      agent.missingAssignedArenaSamples,
    0,
  );
  const lineOfSightCoverageFailures = agents.reduce(
    (total, agent) => total + agent.missingLineOfSightSamples,
    0,
  );
  const lineOfSightOcclusions = agents.reduce(
    (total, agent) =>
      total +
      agent.occludedHeadSamples +
      agent.occludedTorsoSamples +
      agent.occludedLowerBodySamples,
    0,
  );
  const expectedProjectionCount = orderedSamples.length * 2;
  const frameCenterDeltas = [];
  const bodyScaleDeltas = [];
  for (let index = 1; index < compositionFrames.length; index += 1) {
    const previous = compositionFrames[index - 1];
    const current = compositionFrames[index];
    if (previous.cycleId !== current.cycleId) continue;
    frameCenterDeltas.push(
      Math.hypot(
        current.centerX - previous.centerX,
        current.centerY - previous.centerY,
      ),
    );
    bodyScaleDeltas.push(Math.abs(current.bodyScale - previous.bodyScale));
  }
  const compositionMetrics = {
    expectedBodyCount: expectedProjectionCount,
    retainedBodyCount: projectedBodies.length,
    expectedFrameCount: orderedSamples.length,
    retainedFrameCount: compositionFrames.length,
    bodyHeightNdc: metricSummary(projectedBodies.map((body) => body.height)),
    maximumObservedAbsX:
      projectedBodies.length > 0
        ? round(Math.max(...projectedBodies.map((body) => body.maximumAbsX)))
        : null,
    minimumObservedFootY:
      projectedBodies.length > 0
        ? round(Math.min(...projectedBodies.map((body) => body.foot[1])))
        : null,
    maximumObservedHeadY:
      projectedBodies.length > 0
        ? round(Math.max(...projectedBodies.map((body) => body.head[1])))
        : null,
    frameCenterNdcY: metricSummary(
      compositionFrames.map((frame) => frame.centerY),
    ),
    frameCenterDeltaNdc: metricSummary(frameCenterDeltas),
    bodyScaleDeltaNdc: metricSummary(bodyScaleDeltas),
  };
  const safeCropViolations = safeCrop
    ? projectedPositions.filter(
        (position) =>
          Math.abs(position[0]) > safeCrop.maxAbsX ||
          Math.abs(position[1]) > safeCrop.maxAbsY,
      ).length
    : 0;
  const safeCropMetrics = safeCrop
    ? {
        ...safeCrop,
        expectedProjectionCount,
        retainedProjectionCount: projectedPositions.length,
        violations: safeCropViolations,
        maximumObservedAbsX:
          projectedPositions.length > 0
            ? round(
                Math.max(
                  ...projectedPositions.map((entry) => Math.abs(entry[0])),
                ),
              )
            : null,
        maximumObservedAbsY:
          projectedPositions.length > 0
            ? round(
                Math.max(
                  ...projectedPositions.map((entry) => Math.abs(entry[1])),
                ),
              )
            : null,
      }
    : null;

  const checks = [
    check(
      "requested combat roles observed",
      JSON.stringify(observedRoleSet) === JSON.stringify(expectedRoleSet),
      observedRoleSet.join(",") || "none",
    ),
    check(
      "bounded fighting time series retained",
      orderedSamples.length >= DUEL_MOTION_TELEMETRY_LIMITS.minimumSamples &&
        observationMs >= DUEL_MOTION_TELEMETRY_LIMITS.minimumObservationMs,
      `${orderedSamples.length} samples over ${observationMs}ms`,
    ),
    check(
      "exactly two contestants retained",
      agents.length === 2,
      `${agents.length} contestants`,
    ),
    check(
      "every contestant demonstrates tactical travel",
      agents.length === 2 &&
        agents.every(
          (agent) =>
            agent.travelXZ >=
              DUEL_MOTION_TELEMETRY_LIMITS.minimumTravelXZPerAgent &&
            agent.movingSegments >=
              DUEL_MOTION_TELEMETRY_LIMITS.minimumMovingSegmentsPerAgent,
        ),
      agents
        .map(
          (agent) =>
            `${agent.role}:${agent.travelXZ}m/${agent.movingSegments} segments`,
        )
        .join(", "),
    ),
    check(
      "diagonal movement observed",
      combinedDiagonalSegments >=
        DUEL_MOTION_TELEMETRY_LIMITS.minimumDiagonalSegments,
      `${combinedDiagonalSegments} diagonal segments`,
    ),
    check(
      "every contestant demonstrates diagonal movement",
      agents.length === 2 &&
        agents.every(
          (agent) =>
            agent.diagonalSegments >=
            DUEL_MOTION_TELEMETRY_LIMITS.minimumDiagonalSegmentsPerAgent,
        ),
      agents
        .map((agent) => `${agent.role}:${agent.diagonalSegments}`)
        .join(", "),
    ),
    check(
      "multi-direction movement observed",
      combinedDirectionCoverage.length >=
        DUEL_MOTION_TELEMETRY_LIMITS.minimumDirectionCoverage,
      combinedDirectionCoverage.join(",") || "none",
    ),
    check(
      "contestants do not remain mostly stationary",
      agents.length === 2 &&
        agents.every(
          (agent) =>
            agent.stationaryRatio != null &&
            agent.stationaryRatio <=
              DUEL_MOTION_TELEMETRY_LIMITS.maximumStationaryRatio,
        ),
      agents
        .map((agent) => `${agent.role}:${agent.stationaryRatio}`)
        .join(", "),
    ),
    check(
      "movement avoids pathological reversal oscillation",
      agents.length === 2 &&
        agents.every(
          (agent) =>
            agent.sharpReversalRatio <=
            DUEL_MOTION_TELEMETRY_LIMITS.maximumSharpReversalRatio,
        ),
      agents
        .map((agent) => `${agent.role}:${agent.sharpReversalRatio}`)
        .join(", "),
    ),
    check(
      "opponent-facing rotation remains settled",
      agents.length === 2 &&
        agents.every(
          (agent) =>
            agent.facingErrorDegrees.samples >=
              DUEL_MOTION_TELEMETRY_LIMITS.minimumSamples &&
            agent.facingErrorDegrees.p95 <=
              DUEL_MOTION_TELEMETRY_LIMITS.maximumFacingP95Degrees &&
            agent.facingErrorDegrees.max <=
              DUEL_MOTION_TELEMETRY_LIMITS.maximumFacingDegrees,
        ),
      agents
        .map(
          (agent) =>
            `${agent.role}:p95=${agent.facingErrorDegrees.p95},max=${agent.facingErrorDegrees.max}`,
        )
        .join(", "),
    ),
    check(
      "rotation changes remain smooth",
      agents.length === 2 &&
        agents.every(
          (agent) =>
            agent.yawDeltaDegrees.samples > 0 &&
            agent.yawDeltaDegrees.p95 <=
              DUEL_MOTION_TELEMETRY_LIMITS.maximumYawDeltaP95Degrees &&
            agent.yawDeltaDegrees.max <=
              DUEL_MOTION_TELEMETRY_LIMITS.maximumYawDeltaDegrees,
        ),
      agents
        .map(
          (agent) =>
            `${agent.role}:p95=${agent.yawDeltaDegrees.p95},max=${agent.yawDeltaDegrees.max}`,
        )
        .join(", "),
    ),
    check(
      "avatars stay visible, active, loaded, and inside the arena",
      agents.length === 2 && containmentFailures === 0,
      `${containmentFailures} violations`,
    ),
    check(
      "contestants remain inside their exact assigned combat ring",
      agents.length === 2 && assignedArenaFailures === 0,
      `${assignedArenaFailures} assigned-ring violations or missing samples`,
    ),
    check(
      "complete camera line-of-sight telemetry retained",
      agents.length === 2 && lineOfSightCoverageFailures === 0,
      `${lineOfSightCoverageFailures} missing head/torso/lower-body probes`,
    ),
    check(
      "contestants remain visually unobstructed from head through lower body",
      agents.length === 2 && lineOfSightOcclusions === 0,
      `${lineOfSightOcclusions} obstructed head/torso/lower-body probes`,
    ),
    check(
      "complete head-to-foot composition telemetry retained",
      projectedBodies.length === expectedProjectionCount &&
        compositionFrames.length === orderedSamples.length,
      `${projectedBodies.length}/${expectedProjectionCount} bodies, ${compositionFrames.length}/${orderedSamples.length} frames`,
    ),
    check(
      "contestants remain readable at broadcast scale",
      compositionMetrics.bodyHeightNdc.p05 >=
        DUEL_FIGHT_COMPOSITION_LIMITS.minimumBodyHeightNdcP05 &&
        compositionMetrics.bodyHeightNdc.p50 >=
          DUEL_FIGHT_COMPOSITION_LIMITS.minimumBodyHeightNdcP50 &&
        compositionMetrics.bodyHeightNdc.p95 <=
          DUEL_FIGHT_COMPOSITION_LIMITS.maximumBodyHeightNdcP95,
      `heightNdc p05=${compositionMetrics.bodyHeightNdc.p05},p50=${compositionMetrics.bodyHeightNdc.p50},p95=${compositionMetrics.bodyHeightNdc.p95}`,
    ),
    check(
      "contestants remain inside HUD-safe body framing",
      compositionMetrics.maximumObservedAbsX <=
        DUEL_FIGHT_COMPOSITION_LIMITS.maximumBodyProjectionAbsX &&
        compositionMetrics.minimumObservedFootY >=
          DUEL_FIGHT_COMPOSITION_LIMITS.minimumFootNdcY &&
        compositionMetrics.maximumObservedHeadY <=
          DUEL_FIGHT_COMPOSITION_LIMITS.maximumHeadNdcY,
      `maxAbsX=${compositionMetrics.maximumObservedAbsX},footMinY=${compositionMetrics.minimumObservedFootY},headMaxY=${compositionMetrics.maximumObservedHeadY}`,
    ),
    check(
      "fighting composition remains vertically balanced",
      compositionMetrics.frameCenterNdcY.min >=
        DUEL_FIGHT_COMPOSITION_LIMITS.minimumFrameCenterNdcY &&
        compositionMetrics.frameCenterNdcY.max <=
          DUEL_FIGHT_COMPOSITION_LIMITS.maximumFrameCenterNdcY,
      `centerY min=${compositionMetrics.frameCenterNdcY.min},max=${compositionMetrics.frameCenterNdcY.max}`,
    ),
    check(
      "camera composition transitions remain continuous",
      compositionMetrics.frameCenterDeltaNdc.samples > 0 &&
        compositionMetrics.frameCenterDeltaNdc.p95 <=
          DUEL_FIGHT_COMPOSITION_LIMITS.maximumFrameCenterDeltaP95 &&
        compositionMetrics.frameCenterDeltaNdc.max <=
          DUEL_FIGHT_COMPOSITION_LIMITS.maximumFrameCenterDelta &&
        compositionMetrics.bodyScaleDeltaNdc.p95 <=
          DUEL_FIGHT_COMPOSITION_LIMITS.maximumBodyScaleDeltaP95 &&
        compositionMetrics.bodyScaleDeltaNdc.max <=
          DUEL_FIGHT_COMPOSITION_LIMITS.maximumBodyScaleDelta,
      `centerDelta p95=${compositionMetrics.frameCenterDeltaNdc.p95},max=${compositionMetrics.frameCenterDeltaNdc.max}; scaleDelta p95=${compositionMetrics.bodyScaleDeltaNdc.p95},max=${compositionMetrics.bodyScaleDeltaNdc.max}`,
    ),
    ...(safeCropMetrics
      ? [
          check(
            "contestants stay inside the declared stream-safe crop",
            projectedPositions.length === expectedProjectionCount &&
              safeCropViolations === 0,
            [
              projectedPositions.length,
              "/",
              expectedProjectionCount,
              " projections, ",
              safeCropViolations,
              " violations, maxAbsX=",
              safeCropMetrics.maximumObservedAbsX,
              ", maxAbsY=",
              safeCropMetrics.maximumObservedAbsY,
            ].join(""),
          ),
        ]
      : []),
    check(
      "simulation and render transforms agree",
      agents.length === 2 &&
        agents.every(
          (agent) =>
            agent.simulationDriftXZ.max != null &&
            agent.simulationDriftXZ.max <=
              DUEL_SCENE_CAPTURE_LIMITS.maximumSimulationDriftXZ,
        ),
      agents
        .map((agent) => `${agent.role}:${agent.simulationDriftXZ.max}`)
        .join(", "),
    ),
    check(
      "avatar and render transforms agree",
      agents.length === 2 &&
        agents.every(
          (agent) =>
            agent.avatarDriftXZ.max != null &&
            agent.avatarDriftXZ.max <=
              DUEL_SCENE_CAPTURE_LIMITS.maximumAvatarDriftXZ,
        ),
      agents
        .map((agent) => `${agent.role}:${agent.avatarDriftXZ.max}`)
        .join(", "),
    ),
    check(
      "contestants remain visibly separated",
      separations.length >= DUEL_MOTION_TELEMETRY_LIMITS.minimumSamples &&
        Math.min(...separations) >=
          DUEL_SCENE_CAPTURE_LIMITS.minimumRenderedSeparationXZ,
      separations.length > 0
        ? `min=${round(Math.min(...separations))}`
        : "none",
    ),
    check(
      "60 FPS fighting telemetry retained",
      performanceSummary.frames >=
        DUEL_MOTION_TELEMETRY_LIMITS.minimumFightingFrames,
      `${performanceSummary.frames ?? 0} frames`,
    ),
    check(
      "60 FPS cadence meets percentile budget",
      performanceSummary.frameIntervalMs?.p50 <=
        DUEL_MOTION_TELEMETRY_LIMITS.maximumFrameIntervalP50Ms &&
        performanceSummary.frameIntervalMs?.p95 <=
          DUEL_MOTION_TELEMETRY_LIMITS.maximumFrameIntervalP95Ms &&
        performanceSummary.frameIntervalMs?.p99 <=
          DUEL_MOTION_TELEMETRY_LIMITS.maximumFrameIntervalP99Ms,
      `p50=${performanceSummary.frameIntervalMs?.p50 ?? null},p95=${performanceSummary.frameIntervalMs?.p95 ?? null},p99=${performanceSummary.frameIntervalMs?.p99 ?? null}`,
    ),
    check(
      "render work meets frame budget",
      performanceSummary.frameWorkMs?.p95 <=
        DUEL_MOTION_TELEMETRY_LIMITS.maximumFrameWorkP95Ms &&
        performanceSummary.frameWorkMs?.p99 <=
          DUEL_MOTION_TELEMETRY_LIMITS.maximumFrameWorkP99Ms,
      `p95=${performanceSummary.frameWorkMs?.p95 ?? null},p99=${performanceSummary.frameWorkMs?.p99 ?? null}`,
    ),
    check(
      "slow-frame ratio remains bounded",
      performanceSummary.over33_33MsRatio != null &&
        performanceSummary.over33_33MsRatio <=
          DUEL_MOTION_TELEMETRY_LIMITS.maximumOver33MsFrameRatio,
      `${performanceSummary.over33_33MsRatio ?? null}`,
    ),
  ];

  return {
    ok: checks.every((entry) => entry.pass),
    metrics: {
      sampleCount: orderedSamples.length,
      observationMs,
      cycleCount: cycles.size,
      observedRoles: observedRoleSet,
      agents,
      combinedDiagonalSegments,
      combinedDirectionCoverage,
      renderedSeparationXZ: metricSummary(separations),
      fightCompositionNdc: compositionMetrics,
      safeCropNdc: safeCropMetrics,
      performance: performanceSummary,
    },
    checks,
  };
}
