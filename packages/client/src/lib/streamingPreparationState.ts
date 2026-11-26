import {
  parseStreamingDuelPreparationSummary,
  type StreamingDuelPreparationSummary,
} from "@hyperforge/shared";

export function normalizeStreamingPreparationState<
  T extends { preparation?: unknown },
>(state: T): T & { preparation: StreamingDuelPreparationSummary | null } {
  return {
    ...state,
    preparation: parseStreamingDuelPreparationSummary(state.preparation),
  };
}

export function sameStreamingPreparationState(
  left: StreamingDuelPreparationSummary | null | undefined,
  right: StreamingDuelPreparationSummary | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.status === right.status &&
    left.selectedAt === right.selectedAt &&
    left.expiresAt === right.expiresAt &&
    left.agent1.id === right.agent1.id &&
    left.agent1.ready === right.agent1.ready &&
    left.agent1.activity === right.agent1.activity &&
    left.agent1.mode === right.agent1.mode &&
    sameActivityTrail(left.agent1.activityTrail, right.agent1.activityTrail) &&
    left.agent2.id === right.agent2.id &&
    left.agent2.ready === right.agent2.ready &&
    left.agent2.activity === right.agent2.activity &&
    left.agent2.mode === right.agent2.mode &&
    sameActivityTrail(left.agent2.activityTrail, right.agent2.activityTrail)
  );
}

function sameActivityTrail(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((activity, index) => activity === right[index])
  );
}
