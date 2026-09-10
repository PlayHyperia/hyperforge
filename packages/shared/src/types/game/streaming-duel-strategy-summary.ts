/**
 * Public, immutable summary of the strategy frozen before a duel market opens.
 *
 * Free-form model output, bank custody, inventory quantities, opponent history,
 * provider details, and internal policy fingerprints are intentionally absent.
 */

import {
  STREAMING_DUEL_PUBLIC_COMBAT_ROLES,
  STREAMING_DUEL_PUBLIC_PRAYERS,
  STREAMING_DUEL_PUBLIC_TACTICAL_MACROS,
  type StreamingDuelPublicCombatRole,
  type StreamingDuelPublicPrayer,
  type StreamingDuelPublicTacticalMacro,
} from "./streaming-duel-action-observation";

export const STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION = 1 as const;

export const STREAMING_DUEL_PUBLIC_STRATEGY_APPROACHES = [
  "aggressive",
  "defensive",
  "balanced",
  "outlast",
] as const;

export const STREAMING_DUEL_PUBLIC_STRATEGY_ATTACK_STYLES = [
  "accurate",
  "aggressive",
  "controlled",
  "defensive",
] as const;

export const STREAMING_DUEL_PUBLIC_STRATEGY_SOURCES = [
  "model",
  "deterministic",
  "diagnostic",
] as const;

export type StreamingDuelPublicStrategyApproach =
  (typeof STREAMING_DUEL_PUBLIC_STRATEGY_APPROACHES)[number];
export type StreamingDuelPublicStrategyAttackStyle =
  (typeof STREAMING_DUEL_PUBLIC_STRATEGY_ATTACK_STYLES)[number];
export type StreamingDuelPublicStrategySource =
  (typeof STREAMING_DUEL_PUBLIC_STRATEGY_SOURCES)[number];

export type StreamingDuelStrategySummary = {
  readonly schemaVersion: typeof STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION;
  readonly approach: StreamingDuelPublicStrategyApproach;
  readonly tacticalMacro: StreamingDuelPublicTacticalMacro;
  readonly attackStyle: StreamingDuelPublicStrategyAttackStyle;
  readonly prayer: StreamingDuelPublicPrayer | null;
  readonly preferredCombatRole: StreamingDuelPublicCombatRole | null;
  readonly foodThreshold: number;
  readonly switchDefensiveAt: number;
  readonly source: StreamingDuelPublicStrategySource;
  readonly policyVersion: string;
};

const EXACT_KEYS = [
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
] as const;

const APPROACHES = new Set<string>(STREAMING_DUEL_PUBLIC_STRATEGY_APPROACHES);
const ATTACK_STYLES = new Set<string>(
  STREAMING_DUEL_PUBLIC_STRATEGY_ATTACK_STYLES,
);
const SOURCES = new Set<string>(STREAMING_DUEL_PUBLIC_STRATEGY_SOURCES);
const COMBAT_ROLES = new Set<string>(STREAMING_DUEL_PUBLIC_COMBAT_ROLES);
const PRAYERS = new Set<string>(STREAMING_DUEL_PUBLIC_PRAYERS);
const TACTICAL_MACROS = new Set<string>(STREAMING_DUEL_PUBLIC_TACTICAL_MACROS);
const SAFE_POLICY_VERSION = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === EXACT_KEYS.length &&
    EXACT_KEYS.every((key, index) => keys[index] === key)
  );
}

/**
 * Strictly parse a summary crossing a process or network boundary. The fresh,
 * frozen result prevents later caller mutation from changing disclosed truth.
 */
export function parseStreamingDuelStrategySummary(
  input: unknown,
): StreamingDuelStrategySummary | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!hasExactKeys(value)) return null;
  if (
    value.schemaVersion !== STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION ||
    typeof value.approach !== "string" ||
    !APPROACHES.has(value.approach) ||
    typeof value.tacticalMacro !== "string" ||
    !TACTICAL_MACROS.has(value.tacticalMacro) ||
    typeof value.attackStyle !== "string" ||
    !ATTACK_STYLES.has(value.attackStyle) ||
    !(
      value.prayer === null ||
      (typeof value.prayer === "string" && PRAYERS.has(value.prayer))
    ) ||
    !(
      value.preferredCombatRole === null ||
      (typeof value.preferredCombatRole === "string" &&
        COMBAT_ROLES.has(value.preferredCombatRole))
    ) ||
    !Number.isSafeInteger(value.foodThreshold) ||
    Number(value.foodThreshold) < 20 ||
    Number(value.foodThreshold) > 60 ||
    !Number.isSafeInteger(value.switchDefensiveAt) ||
    Number(value.switchDefensiveAt) < 20 ||
    Number(value.switchDefensiveAt) > 40 ||
    typeof value.source !== "string" ||
    !SOURCES.has(value.source) ||
    typeof value.policyVersion !== "string" ||
    !SAFE_POLICY_VERSION.test(value.policyVersion)
  ) {
    return null;
  }

  return Object.freeze({
    schemaVersion: value.schemaVersion,
    approach: value.approach,
    tacticalMacro: value.tacticalMacro,
    attackStyle: value.attackStyle,
    prayer: value.prayer,
    preferredCombatRole: value.preferredCombatRole,
    foodThreshold: value.foodThreshold,
    switchDefensiveAt: value.switchDefensiveAt,
    source: value.source,
    policyVersion: value.policyVersion,
  }) as StreamingDuelStrategySummary;
}
