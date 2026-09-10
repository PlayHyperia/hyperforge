import {
  parseStreamingDuelStrategySummary,
  STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION,
  type StreamingDuelStrategySummary,
} from "@hyperforge/shared";

import type { CompetitiveSnapshotContestant } from "./competitive-snapshot.js";

/** Project persisted strategy authority without exposing free-form reasoning. */
export function toPublicStrategySummary(
  contestant: CompetitiveSnapshotContestant | undefined,
): StreamingDuelStrategySummary | null {
  const strategy = contestant?.preparation.tacticalStrategy;
  if (!strategy) return null;
  return parseStreamingDuelStrategySummary({
    schemaVersion: STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION,
    approach: strategy.approach,
    tacticalMacro: strategy.tacticalMacro,
    attackStyle: strategy.attackStyle,
    prayer: strategy.prayer,
    preferredCombatRole: strategy.preferredCombatRole,
    foodThreshold: strategy.foodThreshold,
    switchDefensiveAt: strategy.switchDefensiveAt,
    source: contestant.preparation.planningSource,
    policyVersion: contestant.preparation.planningPolicyVersion,
  });
}
