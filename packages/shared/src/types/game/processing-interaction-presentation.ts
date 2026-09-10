/** Public processing families that may own a preparation presentation. */
export const PROCESSING_SKILLS = Object.freeze([
  "firemaking",
  "cooking",
  "smelting",
  "smithing",
  "crafting",
  "fletching",
  "runecrafting",
  "tanning",
] as const);

export type ProcessingSkill = (typeof PROCESSING_SKILLS)[number];

export type ProcessingInteractionPresentationPhase = "idle" | "working";

export interface ProcessingInteractionTargetPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * Privacy-safe, server-authored preparation presentation. It intentionally
 * contains no recipe, inventory, bank, route, request, station, or NPC IDs.
 */
export interface ProcessingInteractionPresentationState {
  revision: number;
  skill: ProcessingSkill | null;
  phase: ProcessingInteractionPresentationPhase;
  phaseStartedAtServerTimeMs: number | null;
  targetPosition: ProcessingInteractionTargetPosition | null;
}

const PROCESSING_SKILL_SET = new Set<string>(PROCESSING_SKILLS);
const STATE_KEYS = new Set([
  "revision",
  "skill",
  "phase",
  "phaseStartedAtServerTimeMs",
  "targetPosition",
]);
const MAX_WORLD_COORDINATE = 1_000_000;

export function isProcessingSkill(value: unknown): value is ProcessingSkill {
  return typeof value === "string" && PROCESSING_SKILL_SET.has(value);
}

function hasExactStateKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === STATE_KEYS.size && keys.every((key) => STATE_KEYS.has(key))
  );
}

function normalizeTargetPosition(
  value: unknown,
): ProcessingInteractionTargetPosition | null {
  if (!value || typeof value !== "object") return null;
  const position = value as Record<string, unknown>;
  const keys = Object.keys(position);
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === "x" || key === "y" || key === "z")
  ) {
    return null;
  }
  if (
    ![position.x, position.y, position.z].every(
      (coordinate) =>
        typeof coordinate === "number" &&
        Number.isFinite(coordinate) &&
        Math.abs(coordinate) <= MAX_WORLD_COORDINATE,
    )
  ) {
    return null;
  }
  return {
    x: position.x as number,
    y: position.y as number,
    z: position.z as number,
  };
}

/** Reject malformed, contradictory, or privacy-expanded network state. */
export function normalizeProcessingInteractionPresentationState(
  value: unknown,
): ProcessingInteractionPresentationState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (
    !hasExactStateKeys(state) ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 1 ||
    (state.revision as number) > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }

  if (state.phase === "idle") {
    if (
      state.skill !== null ||
      state.phaseStartedAtServerTimeMs !== null ||
      state.targetPosition !== null
    ) {
      return null;
    }
    return {
      revision: state.revision as number,
      skill: null,
      phase: "idle",
      phaseStartedAtServerTimeMs: null,
      targetPosition: null,
    };
  }

  if (
    state.phase !== "working" ||
    !isProcessingSkill(state.skill) ||
    typeof state.phaseStartedAtServerTimeMs !== "number" ||
    !Number.isFinite(state.phaseStartedAtServerTimeMs) ||
    state.phaseStartedAtServerTimeMs < 0 ||
    state.phaseStartedAtServerTimeMs > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  const targetPosition =
    state.targetPosition === null
      ? null
      : normalizeTargetPosition(state.targetPosition);
  if (state.targetPosition !== null && !targetPosition) return null;
  return {
    revision: state.revision as number,
    skill: state.skill,
    phase: "working",
    phaseStartedAtServerTimeMs: state.phaseStartedAtServerTimeMs,
    targetPosition,
  };
}

/** Only return body motions backed by a reviewed asset in the current build. */
export function resolveProcessingInteractionBodyEmote(
  skill: ProcessingSkill,
): "squat" | null {
  return skill === "firemaking" || skill === "cooking" ? "squat" : null;
}
