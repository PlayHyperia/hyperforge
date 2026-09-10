const PHASES = new Set([
  "IDLE",
  "ANNOUNCEMENT",
  "COUNTDOWN",
  "FIGHTING",
  "RESOLUTION",
]);
const AVATAR_AUTHORED_MOTION_ACTION_LIMIT = 8;

export const REQUIRED_DUEL_CAPTURE_SCENARIOS = Object.freeze([
  "idle",
  "announcement",
  "countdown",
  "fighting",
  "fighting-low-health",
  "resolution-win",
  "resolution-draw",
  "cancelled",
]);

export function attachStreamingViewerToken(rawUrl, rawToken) {
  const url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(String(rawUrl));
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token) return url;
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  fragment.set("streamToken", token);
  url.hash = fragment.toString();
  return url;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function boundedString(value, maxLength = 160, allowEmpty = false) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    (!allowEmpty && normalized.length === 0) ||
    normalized.length > maxLength
  ) {
    return null;
  }
  return normalized;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function finiteTuple(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    return null;
  }
  return [...value];
}

function normalizeArenaPositions(value) {
  if (value == null) return null;
  const candidate = record(value);
  const agent1 = finiteTuple(candidate?.agent1);
  const agent2 = finiteTuple(candidate?.agent2);
  return candidate && agent1 && agent2 ? { agent1, agent2 } : undefined;
}

function nullableBoundedString(value, maxLength = 160) {
  if (value == null) return null;
  return boundedString(value, maxLength) ?? undefined;
}

function normalizeAgent(value) {
  if (value == null) return null;
  const candidate = record(value);
  if (!candidate) return undefined;
  const id = boundedString(candidate.id, 160);
  const hp = finiteNonNegative(candidate.hp);
  const maxHp = finiteNonNegative(candidate.maxHp);
  const damageDealtThisFight = finiteNonNegative(
    candidate.damageDealtThisFight,
  );
  if (
    !id ||
    hp == null ||
    maxHp == null ||
    maxHp <= 0 ||
    hp > maxHp ||
    damageDealtThisFight == null
  ) {
    return undefined;
  }
  return { id, hp, maxHp, damageDealtThisFight };
}

/**
 * Strictly reduce the public state into only the fields needed to classify and
 * cross-check a visual capture. No equipment, wallet, URL, or auth data enters
 * the evidence manifest.
 */
export function normalizeDuelCaptureState(value) {
  const candidate = record(value);
  const cycle = record(candidate?.cycle);
  if (candidate?.type !== "STREAMING_STATE_UPDATE" || !cycle) return null;
  const phase = boundedString(cycle.phase, 32);
  const cycleId = boundedString(cycle.cycleId, 160, true);
  const phaseVersion = finiteNonNegative(cycle.phaseVersion ?? 0);
  const agent1 = normalizeAgent(cycle.agent1);
  const agent2 = normalizeAgent(cycle.agent2);
  const arenaPositions = normalizeArenaPositions(cycle.arenaPositions);
  const cameraTarget = nullableBoundedString(candidate.cameraTarget);
  if (
    !phase ||
    !PHASES.has(phase) ||
    cycleId == null ||
    phaseVersion == null ||
    !Number.isSafeInteger(phaseVersion) ||
    agent1 === undefined ||
    agent2 === undefined ||
    arenaPositions === undefined ||
    cameraTarget === undefined
  ) {
    return null;
  }

  const outcome =
    cycle.outcome === "win" || cycle.outcome === "draw"
      ? cycle.outcome
      : cycle.outcome == null
        ? null
        : undefined;
  let winnerId = null;
  if (cycle.winnerId != null) {
    winnerId = boundedString(cycle.winnerId, 160);
    if (!winnerId) return null;
  }
  if (outcome === undefined) return null;

  let terminalNotice = null;
  if (candidate.terminalNotice != null) {
    const notice = record(candidate.terminalNotice);
    const terminalCycleId = boundedString(notice?.cycleId, 160);
    const reason = boundedString(notice?.reason, 160);
    const expiresAt = finiteNonNegative(notice?.expiresAt);
    if (
      !notice ||
      notice.outcome !== "cancelled" ||
      !terminalCycleId ||
      !reason ||
      expiresAt == null
    ) {
      return null;
    }
    terminalNotice = { cycleId: terminalCycleId, reason, expiresAt };
  }

  return {
    cycleId,
    phase,
    phaseVersion,
    agent1,
    agent2,
    arenaPositions,
    cameraTarget,
    outcome,
    winnerId,
    terminalNotice,
  };
}

export function classifyDuelCaptureScenarios(state, observedAt = Date.now()) {
  const normalized = normalizeDuelCaptureState(state);
  if (!normalized) return [];
  const matches = [];

  if (
    normalized.terminalNotice &&
    normalized.terminalNotice.expiresAt >= observedAt
  ) {
    // The public overlay intentionally presents a cancellation only while the
    // scheduler is IDLE. Never credit a screenshot from a contradictory later
    // phase merely because a delayed/stale envelope still carries the notice.
    return normalized.phase === "IDLE" ? ["cancelled"] : [];
  }

  if (normalized.phase === "IDLE") {
    matches.push("idle");
  } else if (normalized.phase === "ANNOUNCEMENT") {
    matches.push("announcement");
  } else if (normalized.phase === "COUNTDOWN") {
    matches.push("countdown");
  } else if (normalized.phase === "FIGHTING") {
    matches.push("fighting");
    const hpRatios = [normalized.agent1, normalized.agent2]
      .filter(Boolean)
      .map((agent) => agent.hp / agent.maxHp);
    if (hpRatios.length === 2 && Math.min(...hpRatios) <= 0.35) {
      matches.push("fighting-low-health");
    }
  } else if (
    normalized.phase === "RESOLUTION" &&
    normalized.outcome === "win" &&
    normalized.winnerId
  ) {
    matches.push("resolution-win");
  } else if (
    normalized.phase === "RESOLUTION" &&
    normalized.outcome === "draw" &&
    normalized.winnerId === null
  ) {
    matches.push("resolution-draw");
  }

  return matches;
}

export function duelCaptureStatesAgree(left, right) {
  const normalizedLeft = normalizeDuelCaptureState(left);
  const normalizedRight = normalizeDuelCaptureState(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft.cycleId === normalizedRight.cycleId &&
    normalizedLeft.phase === normalizedRight.phase &&
    normalizedLeft.phaseVersion === normalizedRight.phaseVersion &&
    normalizedLeft.agent1?.id === normalizedRight.agent1?.id &&
    normalizedLeft.agent2?.id === normalizedRight.agent2?.id &&
    normalizedLeft.agent1?.hp === normalizedRight.agent1?.hp &&
    normalizedLeft.agent2?.hp === normalizedRight.agent2?.hp &&
    normalizedLeft.agent1?.maxHp === normalizedRight.agent1?.maxHp &&
    normalizedLeft.agent2?.maxHp === normalizedRight.agent2?.maxHp &&
    normalizedLeft.agent1?.damageDealtThisFight ===
      normalizedRight.agent1?.damageDealtThisFight &&
    normalizedLeft.agent2?.damageDealtThisFight ===
      normalizedRight.agent2?.damageDealtThisFight &&
    JSON.stringify(normalizedLeft.arenaPositions) ===
      JSON.stringify(normalizedRight.arenaPositions) &&
    normalizedLeft.cameraTarget === normalizedRight.cameraTarget &&
    normalizedLeft.outcome === normalizedRight.outcome &&
    normalizedLeft.winnerId === normalizedRight.winnerId &&
    normalizedLeft.terminalNotice?.cycleId ===
      normalizedRight.terminalNotice?.cycleId &&
    normalizedLeft.terminalNotice?.reason ===
      normalizedRight.terminalNotice?.reason &&
    normalizedLeft.terminalNotice?.expiresAt ===
      normalizedRight.terminalNotice?.expiresAt
  );
}

export function captureScenarioIdentity(state, scenario) {
  const normalized = normalizeDuelCaptureState(state);
  if (!normalized || !REQUIRED_DUEL_CAPTURE_SCENARIOS.includes(scenario)) {
    return null;
  }
  return {
    scenario,
    cycleId: normalized.terminalNotice?.cycleId || normalized.cycleId || "idle",
    phase: normalized.phase,
    phaseVersion: normalized.phaseVersion,
    agent1Id: normalized.agent1?.id ?? null,
    agent2Id: normalized.agent2?.id ?? null,
    agent1Hp: normalized.agent1?.hp ?? null,
    agent2Hp: normalized.agent2?.hp ?? null,
    arenaPositions: normalized.arenaPositions,
    cameraTarget: normalized.cameraTarget,
    outcome:
      scenario === "cancelled" ? "cancelled" : (normalized.outcome ?? null),
    winnerId: normalized.winnerId,
    cancellationReason: normalized.terminalNotice?.reason ?? null,
  };
}

const PRESENTATION_COUNT_KEYS = Object.freeze([
  "rootCount",
  "bodyTextLength",
  "errorOverlayCount",
  "victoryOverlayCount",
  "postFightCardCount",
  "countdownOverlayCount",
  "combatLogCount",
  "leaderboardCount",
  "betweenStripCount",
  "activeHudCount",
  "agentStatsCount",
  "cancellationStatusCount",
  "healPopupCount",
]);

function finiteNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Strict, content-free DOM evidence for the broadcast presentation layers. */
export function normalizeDuelPresentationDiagnostics(value) {
  const candidate = record(value);
  if (!candidate || candidate.schemaVersion !== 1) return null;
  const normalized = { schemaVersion: 1 };
  for (const key of PRESENTATION_COUNT_KEYS) {
    const count = finiteNonNegativeInteger(candidate[key]);
    if (count === null) return null;
    normalized[key] = count;
  }
  return normalized;
}

function requireExactCount(issues, actual, expected, missing, stale) {
  if (actual === expected) return;
  issues.push(actual < expected ? missing : stale);
}

/**
 * Cross-check the public phase against the actual mounted DOM layers. This is
 * deliberately independent from screenshot pixels so stale React timers and
 * overlays fail before they can be credited as visual evidence.
 */
export function evaluateDuelPresentationCapture(
  presentationValue,
  stateValue,
  observedAt = Date.now(),
) {
  const presentation = normalizeDuelPresentationDiagnostics(presentationValue);
  const state = normalizeDuelCaptureState(stateValue);
  const issues = [];
  if (!presentation)
    return { ok: false, presentation: null, issues: ["invalid"] };
  if (!state) return { ok: false, presentation, issues: ["state_invalid"] };

  if (presentation.rootCount !== 1) issues.push("overlay_root_count_invalid");
  if (presentation.bodyTextLength < 100) issues.push("page_content_missing");
  if (presentation.errorOverlayCount > 0)
    issues.push("framework_error_overlay");
  if (presentation.victoryOverlayCount > 1)
    issues.push("victory_overlay_duplicate");
  if (presentation.postFightCardCount > 1)
    issues.push("post_fight_card_duplicate");
  if (presentation.countdownOverlayCount > 1)
    issues.push("countdown_overlay_duplicate");
  if (presentation.cancellationStatusCount > 1)
    issues.push("cancellation_status_duplicate");

  const hasMatchup = Boolean(state.agent1 && state.agent2);
  const activeCancellation = Boolean(
    state.phase === "IDLE" &&
    state.terminalNotice &&
    state.terminalNotice.expiresAt >= observedAt,
  );

  if (state.phase !== "FIGHTING" && presentation.healPopupCount > 0) {
    issues.push("heal_popup_outside_fight");
  }

  switch (state.phase) {
    case "IDLE":
      requireExactCount(
        issues,
        presentation.victoryOverlayCount,
        0,
        "victory_overlay_missing",
        "victory_overlay_stale",
      );
      requireExactCount(
        issues,
        presentation.postFightCardCount,
        0,
        "post_fight_card_missing",
        "post_fight_card_stale",
      );
      requireExactCount(
        issues,
        presentation.countdownOverlayCount,
        0,
        "countdown_overlay_missing",
        "countdown_overlay_stale",
      );
      if (presentation.activeHudCount > 0) issues.push("active_hud_stale");
      if (presentation.combatLogCount > 0) issues.push("combat_log_stale");
      requireExactCount(
        issues,
        presentation.cancellationStatusCount,
        activeCancellation ? 1 : 0,
        "cancellation_status_missing",
        "cancellation_status_stale",
      );
      if (!activeCancellation && hasMatchup) {
        requireExactCount(
          issues,
          presentation.betweenStripCount,
          1,
          "between_strip_missing",
          "between_strip_duplicate",
        );
        requireExactCount(
          issues,
          presentation.agentStatsCount,
          2,
          "agent_stats_missing",
          "agent_stats_duplicate",
        );
      } else if (activeCancellation && presentation.agentStatsCount > 0) {
        issues.push("agent_stats_stale");
      }
      break;
    case "ANNOUNCEMENT":
      requireExactCount(
        issues,
        presentation.betweenStripCount,
        hasMatchup ? 1 : 0,
        "between_strip_missing",
        "between_strip_duplicate",
      );
      requireExactCount(
        issues,
        presentation.agentStatsCount,
        hasMatchup ? 2 : 0,
        "agent_stats_missing",
        "agent_stats_duplicate",
      );
      if (presentation.activeHudCount > 0) issues.push("active_hud_stale");
      if (presentation.combatLogCount > 0) issues.push("combat_log_stale");
      if (presentation.victoryOverlayCount > 0)
        issues.push("victory_overlay_stale");
      if (presentation.postFightCardCount > 0)
        issues.push("post_fight_card_stale");
      if (presentation.countdownOverlayCount > 0)
        issues.push("countdown_overlay_stale");
      if (presentation.cancellationStatusCount > 0)
        issues.push("cancellation_status_stale");
      break;
    case "COUNTDOWN":
    case "FIGHTING":
      requireExactCount(
        issues,
        presentation.activeHudCount,
        hasMatchup ? 1 : 0,
        "active_hud_missing",
        "active_hud_duplicate",
      );
      requireExactCount(
        issues,
        presentation.combatLogCount,
        1,
        "combat_log_missing",
        "combat_log_duplicate",
      );
      requireExactCount(
        issues,
        presentation.agentStatsCount,
        hasMatchup ? 2 : 0,
        "agent_stats_missing",
        "agent_stats_duplicate",
      );
      if (
        state.phase === "COUNTDOWN" &&
        presentation.countdownOverlayCount !== 1
      ) {
        issues.push(
          presentation.countdownOverlayCount === 0
            ? "countdown_overlay_missing"
            : "countdown_overlay_duplicate",
        );
      }
      if (presentation.betweenStripCount > 0)
        issues.push("between_strip_stale");
      if (presentation.victoryOverlayCount > 0)
        issues.push("victory_overlay_stale");
      if (presentation.postFightCardCount > 0)
        issues.push("post_fight_card_stale");
      if (presentation.cancellationStatusCount > 0)
        issues.push("cancellation_status_stale");
      break;
    case "RESOLUTION": {
      if (presentation.activeHudCount > 0) issues.push("active_hud_stale");
      if (presentation.combatLogCount > 0) issues.push("combat_log_stale");
      if (presentation.countdownOverlayCount > 0)
        issues.push("countdown_overlay_stale");
      if (presentation.cancellationStatusCount > 0)
        issues.push("cancellation_status_stale");
      requireExactCount(
        issues,
        presentation.betweenStripCount,
        hasMatchup ? 1 : 0,
        "between_strip_missing",
        "between_strip_duplicate",
      );
      requireExactCount(
        issues,
        presentation.agentStatsCount,
        hasMatchup ? 2 : 0,
        "agent_stats_missing",
        "agent_stats_duplicate",
      );
      const expectsWinnerPresentation =
        state.outcome === "win" && Boolean(state.winnerId);
      requireExactCount(
        issues,
        presentation.victoryOverlayCount,
        expectsWinnerPresentation ? 1 : 0,
        "victory_overlay_missing",
        "victory_overlay_stale",
      );
      requireExactCount(
        issues,
        presentation.postFightCardCount,
        expectsWinnerPresentation ? 1 : 0,
        "post_fight_card_missing",
        "post_fight_card_stale",
      );
      break;
    }
  }

  return {
    ok: issues.length === 0,
    presentation,
    issues: [...new Set(issues)],
  };
}

const TERMINAL_HANDOFF_SCENARIOS = new Set([
  "resolution-win",
  "resolution-draw",
  "cancelled",
]);

export function createDuelTerminalHandoff(scenario) {
  if (!TERMINAL_HANDOFF_SCENARIOS.has(scenario)) {
    throw new TypeError(`unsupported terminal handoff scenario: ${scenario}`);
  }
  return {
    scenario,
    terminalCycleId: null,
    terminalObservedAt: null,
    presentationClearedAt: null,
    nextCycleId: null,
    nextAnnouncementObservedAt: null,
    nextFightObservedAt: null,
    lastObservedAt: null,
    complete: false,
  };
}

/** Prove a terminal layer clears and the following announced cycle can fight. */
export function advanceDuelTerminalHandoff(
  previous,
  stateValue,
  presentationValue,
  observedAt = Date.now(),
) {
  if (previous.complete) return previous;
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) return previous;
  if (
    previous.lastObservedAt != null &&
    observedAt <= previous.lastObservedAt
  ) {
    return previous;
  }
  const state = normalizeDuelCaptureState(stateValue);
  const presentationEvaluation = evaluateDuelPresentationCapture(
    presentationValue,
    stateValue,
    observedAt,
  );
  if (!state || !presentationEvaluation.ok) {
    return { ...previous, lastObservedAt: observedAt };
  }

  if (!previous.terminalCycleId) {
    if (
      !classifyDuelCaptureScenarios(stateValue, observedAt).includes(
        previous.scenario,
      )
    ) {
      return { ...previous, lastObservedAt: observedAt };
    }
    const terminalCycleId =
      state.terminalNotice?.cycleId || state.cycleId || null;
    return terminalCycleId
      ? {
          ...previous,
          terminalCycleId,
          terminalObservedAt: observedAt,
          lastObservedAt: observedAt,
        }
      : { ...previous, lastObservedAt: observedAt };
  }

  const terminalStillPresented =
    (state.phase === "RESOLUTION" &&
      state.cycleId === previous.terminalCycleId) ||
    (state.phase === "IDLE" &&
      state.terminalNotice?.cycleId === previous.terminalCycleId &&
      state.terminalNotice.expiresAt >= observedAt);
  let next = { ...previous, lastObservedAt: observedAt };
  if (!next.presentationClearedAt && !terminalStillPresented) {
    next.presentationClearedAt = observedAt;
  }
  if (
    next.presentationClearedAt &&
    !next.nextCycleId &&
    state.phase === "ANNOUNCEMENT" &&
    state.cycleId &&
    state.cycleId !== next.terminalCycleId
  ) {
    next.nextCycleId = state.cycleId;
    next.nextAnnouncementObservedAt = observedAt;
  }
  if (
    next.nextCycleId &&
    state.phase === "FIGHTING" &&
    state.cycleId === next.nextCycleId
  ) {
    next.nextFightObservedAt = observedAt;
    next.complete = true;
  }
  return next;
}

export const DUEL_SCENE_CAPTURE_LIMITS = Object.freeze({
  maximumAgeMs: 2_000,
  maximumFutureSkewMs: 1_000,
  maximumSimulationDriftXZ: 0.75,
  maximumAvatarDriftXZ: 0.15,
  // The moving-target regression stays within four degrees. Fifteen degrees
  // leaves packet/render headroom while rejecting a visibly incomplete
  // quarter-turn after the capture's settle window.
  maximumCombatFacingErrorDegrees: 15,
  minimumRenderedSeparationXZ: 0.55,
  maximumNdcMagnitude: 1.1,
});

export function parseDuelSafeCrop(maxNdcXValue, maxNdcYValue) {
  const rawX = String(maxNdcXValue ?? "").trim();
  const rawY = String(maxNdcYValue ?? "").trim();
  if (!rawX && !rawY) return null;
  if (!rawX || !rawY) {
    throw new TypeError(
      "safe crop requires both maximum NDC X and maximum NDC Y",
    );
  }
  const maxAbsX = Number(rawX);
  const maxAbsY = Number(rawY);
  if (
    !Number.isFinite(maxAbsX) ||
    !Number.isFinite(maxAbsY) ||
    maxAbsX <= 0 ||
    maxAbsX > 1 ||
    maxAbsY <= 0 ||
    maxAbsY > 1
  ) {
    throw new RangeError(
      "safe crop NDC limits must be greater than 0 and at most 1",
    );
  }
  return Object.freeze({ maxAbsX, maxAbsY });
}

const IDLE_STREAMING_CAMERA_TARGET_ID = "streaming-arena-anchor";

function distanceXZ(left, right) {
  if (!left || !right) return null;
  return Math.hypot(left[0] - right[0], left[2] - right[2]);
}

function positionsAgree(left, right, tolerance = 0.001) {
  return Boolean(
    left &&
    right &&
    left.every(
      (coordinate, index) => Math.abs(coordinate - right[index]) <= tolerance,
    ),
  );
}

function finiteQuaternionTuple(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    return null;
  }
  return [...value];
}

function facingTargetErrorDegrees(position, target, quaternion) {
  if (!position || !target || !quaternion) return null;
  const targetX = target[0] - position[0];
  const targetZ = target[2] - position[2];
  const targetLength = Math.hypot(targetX, targetZ);
  const quaternionLength = Math.hypot(...quaternion);
  if (targetLength < 0.001 || quaternionLength < 0.001) return null;

  const [rawX, rawY, rawZ, rawW] = quaternion;
  const x = rawX / quaternionLength;
  const y = rawY / quaternionLength;
  const z = rawZ / quaternionLength;
  const w = rawW / quaternionLength;
  // Registered avatars face local -Z.
  const forwardX = -2 * (x * z + w * y);
  const forwardZ = -1 + 2 * (x * x + y * y);
  const forwardLength = Math.hypot(forwardX, forwardZ);
  if (forwardLength < 0.001) return null;
  const dot = Math.max(
    -1,
    Math.min(
      1,
      (forwardX * targetX + forwardZ * targetZ) /
        (forwardLength * targetLength),
    ),
  );
  return Math.round((Math.acos(dot) * 180 * 1_000) / Math.PI) / 1_000;
}

function normalizeSceneAgent(value) {
  if (value == null) return null;
  const candidate = record(value);
  const id = boundedString(candidate?.id, 160);
  const arenaSpawnPosition = finiteTuple(candidate?.arenaSpawnPosition);
  const simulationPosition = finiteTuple(candidate?.simulationPosition);
  const renderPosition = finiteTuple(candidate?.renderPosition);
  const avatarPosition = finiteTuple(candidate?.avatarPosition);
  const renderQuaternion = finiteQuaternionTuple(candidate?.renderQuaternion);
  const facingError = normalizeNullableMetric(
    candidate?.facingTargetErrorDegrees,
  );
  const ndcPosition = finiteTuple(candidate?.ndcPosition);
  const ndcHeadPosition = finiteTuple(candidate?.ndcHeadPosition);
  const insideAssignedCombatArena = normalizeNullableBoolean(
    candidate?.insideAssignedCombatArena,
  );
  const cameraLineOfSight = normalizeCameraLineOfSight(
    candidate?.cameraLineOfSight,
  );
  const hitReaction = normalizeSceneHitReaction(candidate?.hitReaction);
  const authoredMotion = normalizeSceneAuthoredMotion(
    candidate?.authoredMotion,
  );
  const avatarEmote = boundedString(candidate?.avatarEmote, 200);
  if (
    !candidate ||
    !id ||
    (candidate.arenaSpawnPosition != null && !arenaSpawnPosition) ||
    (candidate.simulationPosition != null && !simulationPosition) ||
    (candidate.renderPosition != null && !renderPosition) ||
    (candidate.avatarPosition != null && !avatarPosition) ||
    (candidate.renderQuaternion != null && !renderQuaternion) ||
    facingError === undefined ||
    (candidate.ndcPosition != null && !ndcPosition) ||
    (candidate.ndcHeadPosition != null && !ndcHeadPosition) ||
    insideAssignedCombatArena === undefined ||
    cameraLineOfSight === undefined ||
    (candidate.hitReaction != null && !hitReaction) ||
    (candidate.authoredMotion != null && !authoredMotion) ||
    (candidate.avatarEmote != null && !avatarEmote) ||
    typeof candidate.avatarReady !== "boolean" ||
    typeof candidate.insideCombatArena !== "boolean" ||
    typeof candidate.visible !== "boolean" ||
    typeof candidate.active !== "boolean"
  ) {
    return undefined;
  }
  return {
    id,
    arenaSpawnPosition,
    simulationPosition,
    renderPosition,
    avatarPosition,
    renderQuaternion,
    facingTargetErrorDegrees: facingError,
    avatarReady: candidate.avatarReady,
    ndcPosition,
    ndcHeadPosition,
    insideCombatArena: candidate.insideCombatArena,
    insideAssignedCombatArena,
    cameraLineOfSight,
    visible: candidate.visible,
    active: candidate.active,
    ...(hitReaction ? { hitReaction } : {}),
    ...(authoredMotion ? { authoredMotion } : {}),
    ...(avatarEmote ? { avatarEmote } : {}),
  };
}

function normalizeSceneAuthoredMotionAction(value) {
  const candidate = record(value);
  const url = boundedString(candidate?.url, 200);
  if (
    !candidate ||
    !url ||
    url !== candidate.url ||
    /[?#\u0000-\u001f\u007f]/.test(url) ||
    typeof candidate.running !== "boolean" ||
    typeof candidate.paused !== "boolean" ||
    !Number.isFinite(candidate.effectiveWeight) ||
    candidate.effectiveWeight <= 0 ||
    candidate.effectiveWeight > 1
  ) {
    return null;
  }
  return {
    url,
    running: candidate.running,
    paused: candidate.paused,
    effectiveWeight: candidate.effectiveWeight,
  };
}

function normalizeSceneAuthoredMotion(value) {
  if (value == null) return null;
  const candidate = record(value);
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.overflow !== "boolean" ||
    !Number.isSafeInteger(candidate.invalidActionCount) ||
    candidate.invalidActionCount < 0 ||
    candidate.invalidActionCount > AVATAR_AUTHORED_MOTION_ACTION_LIMIT + 1 ||
    !Array.isArray(candidate.actions) ||
    candidate.actions.length > AVATAR_AUTHORED_MOTION_ACTION_LIMIT
  ) {
    return null;
  }
  const actions = candidate.actions.map(normalizeSceneAuthoredMotionAction);
  if (actions.some((action) => action === null)) return null;
  return {
    schemaVersion: 1,
    overflow: candidate.overflow,
    invalidActionCount: candidate.invalidActionCount,
    actions,
  };
}

function normalizeSceneHitReaction(value) {
  if (value == null) return null;
  const candidate = record(value);
  const elapsedSeconds = candidate?.elapsedSeconds;
  const requiredBoneCount = candidate?.requiredBoneCount;
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    !(
      requiredBoneCount === undefined ||
      (Number.isSafeInteger(requiredBoneCount) &&
        requiredBoneCount >= 1 &&
        requiredBoneCount <= 5)
    ) ||
    !Number.isSafeInteger(candidate.availableBoneCount) ||
    candidate.availableBoneCount < 0 ||
    candidate.availableBoneCount > 5 ||
    !Number.isSafeInteger(candidate.triggerCount) ||
    candidate.triggerCount < 0 ||
    typeof candidate.active !== "boolean" ||
    !(
      elapsedSeconds === null ||
      (Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0)
    ) ||
    candidate.active !== (elapsedSeconds !== null) ||
    !Number.isFinite(candidate.currentWeight) ||
    candidate.currentWeight < 0 ||
    candidate.currentWeight > 1.25 ||
    !Number.isFinite(candidate.lastIntensity) ||
    candidate.lastIntensity < 0 ||
    candidate.lastIntensity > 1.25 ||
    (candidate.lastSide !== -1 && candidate.lastSide !== 1)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    ...(requiredBoneCount === undefined ? {} : { requiredBoneCount }),
    availableBoneCount: candidate.availableBoneCount,
    triggerCount: candidate.triggerCount,
    active: candidate.active,
    elapsedSeconds,
    currentWeight: candidate.currentWeight,
    lastIntensity: candidate.lastIntensity,
    lastSide: candidate.lastSide,
  };
}

function normalizeNullableMetric(value) {
  if (value == null) return null;
  return finiteNonNegative(value) ?? undefined;
}

function normalizeNullableBoolean(value) {
  if (value === null) return null;
  return typeof value === "boolean" ? value : undefined;
}

function normalizeCameraLineOfSight(value) {
  if (value === null) return null;
  const candidate = record(value);
  if (!candidate) return undefined;
  const head = normalizeNullableBoolean(candidate.head);
  const torso = normalizeNullableBoolean(candidate.torso);
  const lowerBody = normalizeNullableBoolean(candidate.lowerBody);
  if (head === undefined || torso === undefined || lowerBody === undefined) {
    return undefined;
  }
  return { head, torso, lowerBody };
}

export function normalizeDuelSceneDiagnostics(value) {
  const candidate = record(value);
  const camera = record(candidate?.camera);
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.updatedAt) ||
    candidate.updatedAt < 0 ||
    !Array.isArray(candidate.agents) ||
    candidate.agents.length !== 2 ||
    typeof candidate.arenaVisualsReady !== "boolean" ||
    !camera
  ) {
    return null;
  }
  const cycleId = boundedString(candidate.cycleId, 160, true);
  const phase = boundedString(candidate.phase, 32);
  const agents = candidate.agents.map(normalizeSceneAgent);
  const arenaSpawnSeparationXZ = normalizeNullableMetric(
    candidate.arenaSpawnSeparationXZ,
  );
  const renderedSeparationXZ = normalizeNullableMetric(
    candidate.renderedSeparationXZ,
  );
  const cameraPosition = finiteTuple(camera.position);
  const cameraTarget = nullableBoundedString(camera.targetId);
  const expectedTarget = nullableBoundedString(camera.expectedTargetId);
  const fov = camera.fov;
  const aspect = camera.aspect;
  if (
    cycleId == null ||
    !phase ||
    !PHASES.has(phase) ||
    agents.some((agent) => agent === undefined) ||
    arenaSpawnSeparationXZ === undefined ||
    renderedSeparationXZ === undefined ||
    !cameraPosition ||
    typeof fov !== "number" ||
    !Number.isFinite(fov) ||
    fov <= 0 ||
    fov >= 180 ||
    typeof aspect !== "number" ||
    !Number.isFinite(aspect) ||
    aspect <= 0 ||
    aspect > 10 ||
    cameraTarget === undefined ||
    expectedTarget === undefined
  ) {
    return null;
  }

  const normalizedAgents = agents;
  const computedArenaSeparation = distanceXZ(
    normalizedAgents[0]?.arenaSpawnPosition,
    normalizedAgents[1]?.arenaSpawnPosition,
  );
  const computedRenderedSeparation = distanceXZ(
    normalizedAgents[0]?.renderPosition,
    normalizedAgents[1]?.renderPosition,
  );
  const computedFacingErrors = normalizedAgents.map((agent, index) =>
    facingTargetErrorDegrees(
      agent?.renderPosition,
      normalizedAgents[index === 0 ? 1 : 0]?.renderPosition,
      agent?.renderQuaternion,
    ),
  );
  if (
    (computedArenaSeparation == null) !== (arenaSpawnSeparationXZ == null) ||
    (computedArenaSeparation != null &&
      Math.abs(computedArenaSeparation - arenaSpawnSeparationXZ) > 0.002) ||
    (computedRenderedSeparation == null) !== (renderedSeparationXZ == null) ||
    (computedRenderedSeparation != null &&
      Math.abs(computedRenderedSeparation - renderedSeparationXZ) > 0.002) ||
    computedFacingErrors.some((computedError, index) => {
      const reportedError =
        normalizedAgents[index]?.facingTargetErrorDegrees ?? null;
      return (
        (computedError == null) !== (reportedError == null) ||
        (computedError != null &&
          reportedError != null &&
          Math.abs(computedError - reportedError) > 0.002)
      );
    })
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    updatedAt: candidate.updatedAt,
    cycleId,
    phase,
    agents: normalizedAgents,
    arenaSpawnSeparationXZ,
    renderedSeparationXZ,
    arenaVisualsReady: candidate.arenaVisualsReady,
    camera: {
      position: cameraPosition,
      fov,
      aspect,
      targetId: cameraTarget,
      expectedTargetId: expectedTarget,
    },
  };
}

export function evaluateDuelSafeCrop(diagnosticsValue, safeCropValue) {
  if (safeCropValue == null) {
    return { ok: true, issues: [], metrics: null };
  }
  const safeCrop = parseDuelSafeCrop(
    safeCropValue.maxAbsX,
    safeCropValue.maxAbsY,
  );
  const diagnostics = normalizeDuelSceneDiagnostics(diagnosticsValue);
  if (!diagnostics) {
    return {
      ok: false,
      issues: ["safe_crop_scene_invalid"],
      metrics: null,
    };
  }
  if (diagnostics.phase === "IDLE") {
    return {
      ok: true,
      issues: [],
      metrics: {
        ...safeCrop,
        expectedProjectionCount: 0,
        retainedProjectionCount: 0,
        violations: 0,
        maximumObservedAbsX: null,
        maximumObservedAbsY: null,
      },
    };
  }

  const issues = [];
  const projectedPositions = [];
  let expectedProjectionCount = 0;
  diagnostics.agents.forEach((agent, index) => {
    if (!agent) return;
    expectedProjectionCount += 1;
    const label = "agent" + (index + 1);
    if (!agent.ndcPosition) {
      issues.push(label + "_safe_projection_missing");
      return;
    }
    projectedPositions.push(agent.ndcPosition);
    if (
      Math.abs(agent.ndcPosition[0]) > safeCrop.maxAbsX ||
      Math.abs(agent.ndcPosition[1]) > safeCrop.maxAbsY
    ) {
      issues.push(label + "_outside_safe_crop");
    }
  });

  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      ...safeCrop,
      expectedProjectionCount,
      retainedProjectionCount: projectedPositions.length,
      violations: issues.length,
      maximumObservedAbsX:
        projectedPositions.length > 0
          ? Math.max(...projectedPositions.map((entry) => Math.abs(entry[0])))
          : null,
      maximumObservedAbsY:
        projectedPositions.length > 0
          ? Math.max(...projectedPositions.map((entry) => Math.abs(entry[1])))
          : null,
    },
  };
}

/**
 * Validate that a logically correct duel state is also represented by a sane
 * 3D scene. Issue strings are stable machine-readable evidence categories.
 */
export function evaluateDuelSceneCapture(
  diagnosticsValue,
  stateValue,
  observedAt = Date.now(),
) {
  const diagnostics = normalizeDuelSceneDiagnostics(diagnosticsValue);
  const state = normalizeDuelCaptureState(stateValue);
  const issues = [];
  if (!diagnostics)
    return { ok: false, diagnostics: null, issues: ["invalid"] };
  if (!state) return { ok: false, diagnostics, issues: ["state_invalid"] };

  if (diagnostics.cycleId !== state.cycleId) issues.push("cycle_mismatch");
  if (diagnostics.phase !== state.phase) issues.push("phase_mismatch");
  if (!diagnostics.arenaVisualsReady) issues.push("arena_visuals_not_ready");
  if (
    diagnostics.updatedAt >
    observedAt + DUEL_SCENE_CAPTURE_LIMITS.maximumFutureSkewMs
  ) {
    issues.push("timestamp_in_future");
  }
  if (
    observedAt - diagnostics.updatedAt >
    DUEL_SCENE_CAPTURE_LIMITS.maximumAgeMs
  ) {
    issues.push("stale");
  }
  if (diagnostics.camera.expectedTargetId !== state.cameraTarget) {
    issues.push("camera_expected_target_mismatch");
  }
  const activeArenaPhase = state.phase !== "IDLE";
  const expectedSceneCameraTarget = activeArenaPhase
    ? state.cameraTarget
    : IDLE_STREAMING_CAMERA_TARGET_ID;
  if (
    expectedSceneCameraTarget &&
    diagnostics.camera.targetId !== expectedSceneCameraTarget
  ) {
    issues.push("camera_target_lost");
  }

  const stateAgents = [state.agent1, state.agent2];
  const stateArenaPositions = [
    state.arenaPositions?.agent1 ?? null,
    state.arenaPositions?.agent2 ?? null,
  ];
  for (let index = 0; index < stateAgents.length; index += 1) {
    const stateAgent = stateAgents[index];
    const sceneAgent = diagnostics.agents[index];
    const label = `agent${index + 1}`;
    if (!stateAgent) {
      if (sceneAgent) issues.push(`${label}_unexpected`);
      continue;
    }
    if (!sceneAgent) {
      issues.push(`${label}_missing`);
      continue;
    }
    if (sceneAgent.id !== stateAgent.id) issues.push(`${label}_id_mismatch`);
    if (
      activeArenaPhase &&
      !positionsAgree(sceneAgent.arenaSpawnPosition, stateArenaPositions[index])
    ) {
      issues.push(`${label}_arena_spawn_mismatch`);
    }
    if (!sceneAgent.simulationPosition)
      issues.push(`${label}_simulation_missing`);
    if (!sceneAgent.renderPosition) issues.push(`${label}_render_missing`);
    if (!sceneAgent.avatarPosition) issues.push(`${label}_avatar_missing`);
    if (!sceneAgent.renderQuaternion) issues.push(`${label}_rotation_missing`);
    if (!sceneAgent.avatarReady) issues.push(`${label}_avatar_not_ready`);
    if (!sceneAgent.active) issues.push(`${label}_inactive`);
    if (activeArenaPhase) {
      if (!sceneAgent.ndcPosition) issues.push(`${label}_projection_missing`);
      if (!sceneAgent.visible) issues.push(`${label}_hidden`);
      if (!sceneAgent.insideCombatArena) issues.push(`${label}_outside_arena`);
    }
    if (state.phase === "FIGHTING") {
      if (sceneAgent.facingTargetErrorDegrees == null) {
        issues.push(`${label}_combat_facing_missing`);
      } else if (
        sceneAgent.facingTargetErrorDegrees >
        DUEL_SCENE_CAPTURE_LIMITS.maximumCombatFacingErrorDegrees
      ) {
        issues.push(`${label}_combat_facing_error`);
      }
    }

    const simulationDrift = distanceXZ(
      sceneAgent.simulationPosition,
      sceneAgent.renderPosition,
    );
    if (
      simulationDrift != null &&
      simulationDrift > DUEL_SCENE_CAPTURE_LIMITS.maximumSimulationDriftXZ
    ) {
      issues.push(`${label}_simulation_drift`);
    }
    const avatarDrift = distanceXZ(
      sceneAgent.avatarPosition,
      sceneAgent.renderPosition,
    );
    if (
      avatarDrift != null &&
      avatarDrift > DUEL_SCENE_CAPTURE_LIMITS.maximumAvatarDriftXZ
    ) {
      issues.push(`${label}_avatar_drift`);
    }
    if (
      activeArenaPhase &&
      sceneAgent.ndcPosition &&
      (Math.abs(sceneAgent.ndcPosition[0]) >
        DUEL_SCENE_CAPTURE_LIMITS.maximumNdcMagnitude ||
        Math.abs(sceneAgent.ndcPosition[1]) >
          DUEL_SCENE_CAPTURE_LIMITS.maximumNdcMagnitude ||
        sceneAgent.ndcPosition[2] < -1.1 ||
        sceneAgent.ndcPosition[2] > 1.1)
    ) {
      issues.push(`${label}_outside_view`);
    }
  }

  if (
    activeArenaPhase &&
    state.agent1 &&
    state.agent2 &&
    (diagnostics.renderedSeparationXZ == null ||
      diagnostics.renderedSeparationXZ <
        DUEL_SCENE_CAPTURE_LIMITS.minimumRenderedSeparationXZ)
  ) {
    issues.push("agents_overlap");
  }

  return { ok: issues.length === 0, diagnostics, issues };
}
