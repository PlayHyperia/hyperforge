import {
  STREAMING_DUEL_PUBLIC_PRAYERS,
  STREAMING_DUEL_PUBLIC_TACTICAL_MACROS,
} from "@hyperforge/shared";
import type { SwitchableStreamingCombatRole } from "./types.js";

export const COMPETITIVE_TACTICAL_PRAYERS = STREAMING_DUEL_PUBLIC_PRAYERS;

export type CompetitiveTacticalPrayer =
  (typeof COMPETITIVE_TACTICAL_PRAYERS)[number];

export const COMPETITIVE_TACTICAL_MACROS =
  STREAMING_DUEL_PUBLIC_TACTICAL_MACROS;

export type CompetitiveTacticalMacro =
  (typeof COMPETITIVE_TACTICAL_MACROS)[number];

export type CompetitiveTacticalStrategy = {
  approach: "aggressive" | "defensive" | "balanced" | "outlast";
  tacticalMacro: CompetitiveTacticalMacro;
  attackStyle: "accurate" | "aggressive" | "controlled" | "defensive";
  prayer: CompetitiveTacticalPrayer | null;
  preferredCombatRole: SwitchableStreamingCombatRole | null;
  foodThreshold: number;
  switchDefensiveAt: number;
  reasoning: string;
};

const STRATEGY_KEYS = [
  "approach",
  "attackStyle",
  "foodThreshold",
  "prayer",
  "preferredCombatRole",
  "reasoning",
  "switchDefensiveAt",
  "tacticalMacro",
] as const;
const APPROACHES = new Set(["aggressive", "defensive", "balanced", "outlast"]);
const ATTACK_STYLES = new Set([
  "accurate",
  "aggressive",
  "controlled",
  "defensive",
]);
const PRAYERS = new Set<CompetitiveTacticalPrayer>(
  COMPETITIVE_TACTICAL_PRAYERS,
);
const ROLES = new Set<SwitchableStreamingCombatRole>([
  "melee",
  "ranged",
  "mage",
]);
const MACROS = new Set<CompetitiveTacticalMacro>(COMPETITIVE_TACTICAL_MACROS);

const normalizeReasoning = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
};

/** Strict public strategy validator shared by preparation, persistence, and AI. */
export function normalizeCompetitiveTacticalStrategy(
  value: unknown,
  availableRoles: readonly SwitchableStreamingCombatRole[],
  availablePrayerIds: readonly string[] = COMPETITIVE_TACTICAL_PRAYERS,
): CompetitiveTacticalStrategy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== STRATEGY_KEYS.length ||
    keys.some((key, index) => key !== STRATEGY_KEYS[index])
  ) {
    return null;
  }
  const available = new Set(availableRoles.filter((role) => ROLES.has(role)));
  const availablePrayers = new Set(
    availablePrayerIds.filter(
      (prayerId): prayerId is CompetitiveTacticalPrayer =>
        PRAYERS.has(prayerId as CompetitiveTacticalPrayer),
    ),
  );
  const preferredCombatRole = record.preferredCombatRole;
  const reasoning = normalizeReasoning(record.reasoning);
  if (
    !APPROACHES.has(record.approach as string) ||
    !MACROS.has(record.tacticalMacro as CompetitiveTacticalMacro) ||
    !ATTACK_STYLES.has(record.attackStyle as string) ||
    !(
      record.prayer === null ||
      (typeof record.prayer === "string" &&
        PRAYERS.has(record.prayer as CompetitiveTacticalPrayer) &&
        availablePrayers.has(record.prayer as CompetitiveTacticalPrayer))
    ) ||
    !(
      preferredCombatRole === null ||
      (typeof preferredCombatRole === "string" &&
        ROLES.has(preferredCombatRole as SwitchableStreamingCombatRole) &&
        available.has(preferredCombatRole as SwitchableStreamingCombatRole))
    ) ||
    !Number.isSafeInteger(record.foodThreshold) ||
    (record.foodThreshold as number) < 20 ||
    (record.foodThreshold as number) > 60 ||
    !Number.isSafeInteger(record.switchDefensiveAt) ||
    (record.switchDefensiveAt as number) < 20 ||
    (record.switchDefensiveAt as number) > 40 ||
    !reasoning
  ) {
    return null;
  }

  return {
    approach: record.approach as CompetitiveTacticalStrategy["approach"],
    tacticalMacro:
      record.tacticalMacro as CompetitiveTacticalStrategy["tacticalMacro"],
    attackStyle:
      record.attackStyle as CompetitiveTacticalStrategy["attackStyle"],
    prayer: record.prayer as CompetitiveTacticalStrategy["prayer"],
    preferredCombatRole:
      preferredCombatRole as CompetitiveTacticalStrategy["preferredCombatRole"],
    foodThreshold: record.foodThreshold as number,
    switchDefensiveAt: record.switchDefensiveAt as number,
    reasoning,
  };
}

export function buildDeterministicCompetitiveTacticalStrategy(
  primaryStyle: SwitchableStreamingCombatRole | "prayer",
  availablePrayerIds: readonly string[] = COMPETITIVE_TACTICAL_PRAYERS,
): CompetitiveTacticalStrategy {
  const rolePrayer =
    primaryStyle === "ranged"
      ? "hawk_eye"
      : primaryStyle === "mage"
        ? "mystic_lore"
        : primaryStyle === "melee"
          ? "superhuman_strength"
          : null;
  const prayer =
    rolePrayer !== null && availablePrayerIds.includes(rolePrayer)
      ? rolePrayer
      : null;
  return {
    approach: "balanced",
    tacticalMacro:
      primaryStyle === "ranged" || primaryStyle === "mage"
        ? "orbit"
        : "pressure",
    attackStyle: "aggressive",
    prayer,
    preferredCombatRole: null,
    foodThreshold: 40,
    switchDefensiveAt: 30,
    reasoning: "Use the deterministic role-aware competitive fallback.",
  };
}
