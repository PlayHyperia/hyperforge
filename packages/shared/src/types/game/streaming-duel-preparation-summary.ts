/**
 * Public, pre-market status for the exact contestants selected to prepare for
 * the next duel. Private preparation identity, custody, inventory quantities,
 * goals, model output, and failure details are intentionally absent.
 */

export const STREAMING_DUEL_PREPARATION_SUMMARY_SCHEMA_VERSION = 2 as const;

export const STREAMING_DUEL_PUBLIC_PREPARATION_STATUSES = [
  "preparing",
  "ready",
] as const;

export type StreamingDuelPublicPreparationStatus =
  (typeof STREAMING_DUEL_PUBLIC_PREPARATION_STATUSES)[number];

export const STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITIES = [
  "planning",
  "gathering",
  "training",
  "crafting",
  "provisioning",
  "questing",
  "exploring",
  "reassessing",
] as const;

export type StreamingDuelPublicPreparationActivity =
  (typeof STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITIES)[number];

/**
 * A deliberately coarse movement dimension for public preparation coverage.
 * It distinguishes work from travel without revealing a destination, target,
 * route, coordinate, inventory item, or private strategy.
 */
export const STREAMING_DUEL_PUBLIC_PREPARATION_MODES = [
  "working",
  "traveling",
] as const;

export type StreamingDuelPublicPreparationMode =
  (typeof STREAMING_DUEL_PUBLIC_PREPARATION_MODES)[number];

export const STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITY_TRAIL_LIMIT =
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITIES.length;

export type StreamingDuelPreparationContestantSummary = {
  readonly id: string;
  readonly ready: boolean;
  /** Durable, category-only autonomy status; null until one is known. */
  readonly activity: StreamingDuelPublicPreparationActivity | null;
  /** Privacy-safe work/travel state; null until an activity is known. */
  readonly mode: StreamingDuelPublicPreparationMode | null;
  /** Ordered category-only recap, capped to the public vocabulary size. */
  readonly activityTrail: readonly StreamingDuelPublicPreparationActivity[];
};

export type StreamingDuelPreparationSummary = {
  readonly schemaVersion: typeof STREAMING_DUEL_PREPARATION_SUMMARY_SCHEMA_VERSION;
  readonly status: StreamingDuelPublicPreparationStatus;
  readonly selectedAt: number;
  readonly expiresAt: number;
  readonly agent1: StreamingDuelPreparationContestantSummary;
  readonly agent2: StreamingDuelPreparationContestantSummary;
};

const SUMMARY_KEYS = [
  "agent1",
  "agent2",
  "expiresAt",
  "schemaVersion",
  "selectedAt",
  "status",
] as const;
const CONTESTANT_KEYS = [
  "activity",
  "activityTrail",
  "id",
  "mode",
  "ready",
] as const;
const STATUSES = new Set<string>(STREAMING_DUEL_PUBLIC_PREPARATION_STATUSES);
const ACTIVITIES = new Set<string>(
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITIES,
);
const MODES = new Set<string>(STREAMING_DUEL_PUBLIC_PREPARATION_MODES);
const SAFE_CONTESTANT_ID = /^[^\u0000-\u001f\u007f]{1,256}$/u;

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    expected.every((key, index) => keys[index] === key)
  );
}

function parseContestant(
  input: unknown,
): StreamingDuelPreparationContestantSummary | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!hasExactKeys(value, CONTESTANT_KEYS)) return null;
  const activityTrail = parseActivityTrail(value.activityTrail);
  if (
    typeof value.id !== "string" ||
    value.id !== value.id.trim() ||
    !SAFE_CONTESTANT_ID.test(value.id) ||
    typeof value.ready !== "boolean" ||
    (value.activity !== null &&
      (typeof value.activity !== "string" ||
        !ACTIVITIES.has(value.activity))) ||
    !activityTrail ||
    (value.activity === null) !== (activityTrail.length === 0) ||
    (value.activity !== null && activityTrail.at(-1) !== value.activity) ||
    (value.mode !== null &&
      (typeof value.mode !== "string" || !MODES.has(value.mode))) ||
    (value.activity === null) !== (value.mode === null) ||
    ((value.activity === "planning" || value.activity === "reassessing") &&
      value.mode !== "working")
  ) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    ready: value.ready,
    activity: value.activity as StreamingDuelPublicPreparationActivity | null,
    mode: value.mode as StreamingDuelPublicPreparationMode | null,
    activityTrail,
  });
}

function parseActivityTrail(
  input: unknown,
): readonly StreamingDuelPublicPreparationActivity[] | null {
  if (
    !Array.isArray(input) ||
    input.length > STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITY_TRAIL_LIMIT
  ) {
    return null;
  }
  const trail: StreamingDuelPublicPreparationActivity[] = [];
  for (const activity of input) {
    if (
      typeof activity !== "string" ||
      !ACTIVITIES.has(activity) ||
      trail.at(-1) === activity
    ) {
      return null;
    }
    trail.push(activity as StreamingDuelPublicPreparationActivity);
  }
  return Object.freeze(trail);
}

/** Strictly parse and freeze the status crossing a process/network boundary. */
export function parseStreamingDuelPreparationSummary(
  input: unknown,
): StreamingDuelPreparationSummary | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!hasExactKeys(value, SUMMARY_KEYS)) return null;
  const agent1 = parseContestant(value.agent1);
  const agent2 = parseContestant(value.agent2);
  if (
    value.schemaVersion !== STREAMING_DUEL_PREPARATION_SUMMARY_SCHEMA_VERSION ||
    typeof value.status !== "string" ||
    !STATUSES.has(value.status) ||
    !Number.isSafeInteger(value.selectedAt) ||
    Number(value.selectedAt) < 0 ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) <= Number(value.selectedAt) ||
    !agent1 ||
    !agent2 ||
    agent1.id === agent2.id
  ) {
    return null;
  }

  const bothReady = agent1.ready && agent2.ready;
  if (
    (value.status === "ready") !== bothReady ||
    (value.status === "preparing" && bothReady)
  ) {
    return null;
  }

  return Object.freeze({
    schemaVersion: value.schemaVersion,
    status: value.status,
    selectedAt: value.selectedAt,
    expiresAt: value.expiresAt,
    agent1,
    agent2,
  }) as StreamingDuelPreparationSummary;
}
