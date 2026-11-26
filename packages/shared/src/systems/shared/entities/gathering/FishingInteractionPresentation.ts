export const SPECIAL_FISHING_INTERACTION_ITEM_IDS = Object.freeze([
  "small_fishing_net",
  "harpoon",
  "lobster_pot",
] as const);

export type SpecialFishingInteractionItemId =
  (typeof SPECIAL_FISHING_INTERACTION_ITEM_IDS)[number];

export const FISHING_INTERACTION_PHASES = Object.freeze([
  "idle",
  "held",
  "released",
  "deployed",
  "striking",
  "retrieving",
  "recovering",
] as const);

export type FishingInteractionPhase =
  (typeof FISHING_INTERACTION_PHASES)[number];

export const FISHING_INTERACTION_OUTCOMES = Object.freeze([
  "none",
  "pending",
  "verifying",
  "miss",
  "caught",
] as const);

export type FishingInteractionOutcome =
  (typeof FISHING_INTERACTION_OUTCOMES)[number];

export interface FishingInteractionTargetPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * Public, server-authored fishing presentation state. This deliberately omits
 * private inventory and durable-storage details while retaining enough exact
 * identity for a late spectator to reconstruct the current interaction.
 */
export interface FishingInteractionPresentationState {
  revision: number;
  interactionId: string | null;
  resourceId: string | null;
  itemId: SpecialFishingInteractionItemId | null;
  phase: FishingInteractionPhase;
  outcome: FishingInteractionOutcome;
  attempt: number;
  serverTick: number;
  /**
   * Server `performance.now()` value captured when `phase` began. The initial
   * snapshot carries the matching server clock, allowing a late spectator to
   * seek deterministic one-shot motion without trusting client wall time.
   */
  phaseStartedAtServerTimeMs?: number;
  targetPosition: FishingInteractionTargetPosition | null;
}

/** One authoritative game tick; harpoon strike and recovery each own one. */
export const FISHING_INTERACTION_PHASE_DURATION_SECONDS = 0.6;

/** Exact duration of the certified strike plus recovery body motion. */
export const HARPOON_INTERACTION_BODY_MOTION_DURATION_SECONDS =
  FISHING_INTERACTION_PHASE_DURATION_SECONDS * 2;

/** Exact duration of every certified net/pot one-shot body motion. */
export const FISHING_WORLD_INTERACTION_BODY_MOTION_DURATION_SECONDS =
  FISHING_INTERACTION_PHASE_DURATION_SECONDS * 2;

/**
 * Certified hand/world contact landmarks within the 1.2 s one-shots.
 * Release phases begin at 0.6 s, so release delays are phase-local.
 */
export const FISHING_WORLD_TRANSFER_TIMING = Object.freeze({
  small_fishing_net: Object.freeze({
    releaseDelaySeconds: 0.18,
    releaseArcHeightMetres: 0.35,
  }),
  lobster_pot: Object.freeze({
    releaseDelaySeconds: 0.48,
    releaseArcHeightMetres: 0.06,
  }),
  retrieve: Object.freeze({ pickupDelaySeconds: 0.42 }),
});

const SPECIAL_ITEM_ID_SET = new Set<string>(
  SPECIAL_FISHING_INTERACTION_ITEM_IDS,
);
const PHASE_SET = new Set<string>(FISHING_INTERACTION_PHASES);
const OUTCOME_SET = new Set<string>(FISHING_INTERACTION_OUTCOMES);
const MAX_PUBLIC_ID_LENGTH = 256;
const MAX_WORLD_COORDINATE = 1_000_000;

const VALID_PHASES_BY_ITEM: Readonly<
  Record<SpecialFishingInteractionItemId, ReadonlySet<FishingInteractionPhase>>
> = Object.freeze({
  small_fishing_net: new Set<FishingInteractionPhase>([
    "held",
    "released",
    "deployed",
    "retrieving",
  ]),
  harpoon: new Set<FishingInteractionPhase>(["held", "striking", "recovering"]),
  lobster_pot: new Set<FishingInteractionPhase>([
    "held",
    "released",
    "deployed",
    "retrieving",
  ]),
});

function isValidOutcomeForPhase(
  itemId: SpecialFishingInteractionItemId,
  phase: FishingInteractionPhase,
  outcome: FishingInteractionOutcome,
): boolean {
  if (itemId === "harpoon") {
    if (phase === "held") return outcome === "none";
    if (phase === "striking") {
      return outcome === "pending" || outcome === "miss";
    }
    if (phase === "recovering") {
      return (
        outcome === "miss" || outcome === "caught" || outcome === "verifying"
      );
    }
    return false;
  }

  if (phase === "held") {
    return (
      outcome === "none" ||
      outcome === "miss" ||
      outcome === "caught" ||
      outcome === "verifying"
    );
  }
  if (phase === "released") {
    return outcome === "none";
  }
  if (phase === "deployed") {
    return (
      outcome === "none" || outcome === "pending" || outcome === "verifying"
    );
  }
  if (phase === "retrieving") {
    return (
      outcome === "pending" ||
      outcome === "verifying" ||
      outcome === "miss" ||
      outcome === "caught"
    );
  }
  return false;
}

function validPublicId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PUBLIC_ID_LENGTH &&
    value === value.trim()
  );
}

function validTargetPosition(
  value: unknown,
): value is FishingInteractionTargetPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as Partial<FishingInteractionTargetPosition>;
  return [position.x, position.y, position.z].every(
    (coordinate) =>
      typeof coordinate === "number" &&
      Number.isFinite(coordinate) &&
      Math.abs(coordinate) <= MAX_WORLD_COORDINATE,
  );
}

export function isSpecialFishingInteractionItemId(
  itemId: unknown,
): itemId is SpecialFishingInteractionItemId {
  return typeof itemId === "string" && SPECIAL_ITEM_ID_SET.has(itemId);
}

/**
 * Symbolic body-emote authority for an exact fishing interaction phase.
 *
 * Every special item is phase-specific. Deployment and retrieval never borrow
 * each other's clips, and a world-deployed prop leaves the body at idle.
 */
export function resolveFishingInteractionBodyEmote(
  itemId: SpecialFishingInteractionItemId,
  phase: FishingInteractionPhase,
): string {
  if (itemId === "harpoon") {
    return phase === "striking" || phase === "recovering" ? "harpoon" : "idle";
  }
  if (phase === "retrieving") return "fishing_retrieve";
  if (phase === "held" || phase === "released") return itemId;
  return "idle";
}

/**
 * Resolve the authoritative seek point for a certified fishing one-shot.
 *
 * Each public phase owns one bounded 600 ms segment. A delayed persistence
 * receipt may hold the presentation at the end of a segment, but it can never
 * make the client run ahead into another server-owned phase. Older snapshots
 * without a monotonic timestamp safely fall back to the start of their exact
 * phase rather than replaying recovery from frame zero.
 */
export function resolveFishingInteractionBodyMotionOffsetSeconds(
  state: FishingInteractionPresentationState,
  currentServerTimeSeconds: number | null | undefined,
): number | null {
  const isHarpoonAction =
    state.itemId === "harpoon" &&
    (state.phase === "striking" || state.phase === "recovering");
  const isWorldDeployAction =
    (state.itemId === "small_fishing_net" || state.itemId === "lobster_pot") &&
    (state.phase === "held" || state.phase === "released");
  const isWorldRetrieveAction =
    (state.itemId === "small_fishing_net" || state.itemId === "lobster_pot") &&
    state.phase === "retrieving";
  if (!isHarpoonAction && !isWorldDeployAction && !isWorldRetrieveAction) {
    return null;
  }

  const phaseOffset =
    state.phase === "recovering" || state.phase === "released"
      ? FISHING_INTERACTION_PHASE_DURATION_SECONDS
      : 0;
  const phaseDuration = isWorldRetrieveAction
    ? FISHING_WORLD_INTERACTION_BODY_MOTION_DURATION_SECONDS
    : FISHING_INTERACTION_PHASE_DURATION_SECONDS;
  const phaseStartedAtServerTimeMs = state.phaseStartedAtServerTimeMs;
  if (
    typeof phaseStartedAtServerTimeMs !== "number" ||
    !Number.isFinite(phaseStartedAtServerTimeMs) ||
    typeof currentServerTimeSeconds !== "number" ||
    !Number.isFinite(currentServerTimeSeconds)
  ) {
    return phaseOffset;
  }

  const elapsedSeconds = Math.max(
    0,
    currentServerTimeSeconds - phaseStartedAtServerTimeMs / 1000,
  );
  return phaseOffset + Math.min(elapsedSeconds, phaseDuration);
}

export function normalizeFishingInteractionPresentationState(
  value: unknown,
): FishingInteractionPresentationState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<FishingInteractionPresentationState>;
  if (
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 1 ||
    !Number.isSafeInteger(state.attempt) ||
    (state.attempt as number) < 0 ||
    !Number.isSafeInteger(state.serverTick) ||
    (state.serverTick as number) < 0 ||
    (state.phaseStartedAtServerTimeMs !== undefined &&
      (typeof state.phaseStartedAtServerTimeMs !== "number" ||
        !Number.isFinite(state.phaseStartedAtServerTimeMs) ||
        state.phaseStartedAtServerTimeMs < 0 ||
        state.phaseStartedAtServerTimeMs > Number.MAX_SAFE_INTEGER)) ||
    typeof state.phase !== "string" ||
    !PHASE_SET.has(state.phase) ||
    typeof state.outcome !== "string" ||
    !OUTCOME_SET.has(state.outcome)
  ) {
    return null;
  }

  if (state.phase === "idle") {
    if (
      state.interactionId !== null ||
      state.resourceId !== null ||
      state.itemId !== null ||
      state.targetPosition !== null ||
      state.outcome !== "none" ||
      state.attempt !== 0
    ) {
      return null;
    }
    return {
      revision: state.revision as number,
      interactionId: null,
      resourceId: null,
      itemId: null,
      phase: "idle",
      outcome: "none",
      attempt: 0,
      serverTick: state.serverTick as number,
      ...(state.phaseStartedAtServerTimeMs !== undefined
        ? { phaseStartedAtServerTimeMs: state.phaseStartedAtServerTimeMs }
        : {}),
      targetPosition: null,
    };
  }

  if (
    !validPublicId(state.interactionId) ||
    !validPublicId(state.resourceId) ||
    !isSpecialFishingInteractionItemId(state.itemId) ||
    !validTargetPosition(state.targetPosition) ||
    !VALID_PHASES_BY_ITEM[state.itemId].has(state.phase) ||
    !isValidOutcomeForPhase(
      state.itemId,
      state.phase,
      state.outcome as FishingInteractionOutcome,
    )
  ) {
    return null;
  }

  return {
    revision: state.revision as number,
    interactionId: state.interactionId,
    resourceId: state.resourceId,
    itemId: state.itemId,
    phase: state.phase,
    outcome: state.outcome as FishingInteractionOutcome,
    attempt: state.attempt as number,
    serverTick: state.serverTick as number,
    ...(state.phaseStartedAtServerTimeMs !== undefined
      ? { phaseStartedAtServerTimeMs: state.phaseStartedAtServerTimeMs }
      : {}),
    targetPosition: {
      x: state.targetPosition.x,
      y: state.targetPosition.y,
      z: state.targetPosition.z,
    },
  };
}

export function firstFishingInteractionAttemptTick(
  itemId: SpecialFishingInteractionItemId,
  startTick: number,
): number {
  switch (itemId) {
    case "small_fishing_net":
      return startTick + 3;
    case "lobster_pot":
      return startTick + 3;
    case "harpoon":
      return startTick + 1;
  }
}

export function initialFishingInteractionTransition(
  itemId: SpecialFishingInteractionItemId,
  startTick: number,
): { phase: FishingInteractionPhase; nextTransitionTick: number | null } {
  return {
    phase: "held",
    nextTransitionTick:
      itemId === "harpoon" ? null : Math.max(0, startTick) + 1,
  };
}

export function nextFishingInteractionTransition(
  itemId: SpecialFishingInteractionItemId,
  phase: FishingInteractionPhase,
  outcome: FishingInteractionOutcome,
  tickNumber: number,
): {
  phase: FishingInteractionPhase;
  outcome: FishingInteractionOutcome;
  nextTransitionTick: number | null;
} | null {
  if (itemId === "small_fishing_net" || itemId === "lobster_pot") {
    if (phase === "retrieving") {
      return {
        phase: "held",
        outcome,
        nextTransitionTick: tickNumber + 1,
      };
    }
    if (phase === "held") {
      return {
        phase: "released",
        outcome: "none",
        nextTransitionTick: tickNumber + 1,
      };
    }
    if (phase === "released") {
      return { phase: "deployed", outcome: "none", nextTransitionTick: null };
    }
    return null;
  }

  if (phase === "striking") {
    const isAwaitingVerifiedOutcome = outcome === "pending";
    return {
      phase: "recovering",
      outcome: isAwaitingVerifiedOutcome ? "verifying" : outcome,
      nextTransitionTick: isAwaitingVerifiedOutcome ? null : tickNumber + 1,
    };
  }
  if (phase === "recovering") {
    return { phase: "held", outcome: "none", nextTransitionTick: null };
  }
  return null;
}
