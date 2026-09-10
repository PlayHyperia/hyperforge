import type { CompetitivePreparationEvidence } from "./competitive-snapshot.js";
import { normalizeCompetitivePreparationEvidence } from "./preparation.js";

/**
 * Bounded, private explanations for how the pre-market role decision resolved.
 * Free-form model reasoning and provider errors must never enter this receipt.
 */
export const DUEL_PREPARATION_DECISION_OUTCOMES = [
  "model_selected",
  "deterministic_single_legal_role",
  "deterministic_invalid_role_set",
  "deterministic_runtime_unavailable",
  "deterministic_deadline_exhausted",
  "deterministic_model_empty",
  "deterministic_model_rejected",
  "deterministic_model_failed",
] as const;

export type DuelPreparationDecisionOutcome =
  (typeof DUEL_PREPARATION_DECISION_OUTCOMES)[number];

export type DuelPreparationDecisionReceiptEvidence =
  CompetitivePreparationEvidence & {
    decisionOutcome: DuelPreparationDecisionOutcome;
    decisionLatencyMs: number;
    selectedPlanOptionId?: string;
    selectedPlanStyleRank?: number;
    selectedFoodOptionId?: string;
    selectedFoodRecoveryRank?: number;
    selectedArmorOptionId?: string;
    selectedArmorOffenseRank?: number;
    selectedArmorFocusedDefenseRank?: number | null;
    selectedArmorTotalDefenseRank?: number;
  };

const OUTCOMES = new Set<string>(DUEL_PREPARATION_DECISION_OUTCOMES);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const MAX_DUEL_PREPARATION_DECISION_LATENCY_MS = 10_000;

/**
 * Validate the immutable decision receipt stored beside the atomic whole-plan
 * custody transition. The receipt is intentionally stricter than the legacy
 * recovery-evidence object so a new plan cannot omit its fallback class.
 */
export function normalizeDuelPreparationDecisionReceiptEvidence(
  input: unknown,
): DuelPreparationDecisionReceiptEvidence {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("duel_preparation_decision_receipt_invalid");
  }
  const value = input as Record<string, unknown>;
  const hasSelectedPlanOption = value.selectedPlanOptionId !== undefined;
  const hasSelectedPlanStyleRank = value.selectedPlanStyleRank !== undefined;
  const hasSelectedFoodOption = value.selectedFoodOptionId !== undefined;
  const hasSelectedFoodRecoveryRank =
    value.selectedFoodRecoveryRank !== undefined;
  const hasSelectedArmorOption = value.selectedArmorOptionId !== undefined;
  const hasSelectedArmorOffenseRank =
    value.selectedArmorOffenseRank !== undefined;
  const hasSelectedArmorFocusedDefenseRank =
    value.selectedArmorFocusedDefenseRank !== undefined;
  const hasSelectedArmorTotalDefenseRank =
    value.selectedArmorTotalDefenseRank !== undefined;
  const expectedKeys = [
    "agentPolicyFingerprint",
    "availableStyles",
    "decisionLatencyMs",
    "decisionOutcome",
    "model",
    "modelProvider",
    "planningPolicyVersion",
    "planningSource",
    "primaryStyle",
    ...(hasSelectedArmorFocusedDefenseRank
      ? ["selectedArmorFocusedDefenseRank"]
      : []),
    ...(hasSelectedArmorOffenseRank ? ["selectedArmorOffenseRank"] : []),
    ...(hasSelectedArmorOption ? ["selectedArmorOptionId"] : []),
    ...(hasSelectedArmorTotalDefenseRank
      ? ["selectedArmorTotalDefenseRank"]
      : []),
    ...(hasSelectedFoodOption ? ["selectedFoodOptionId"] : []),
    ...(hasSelectedFoodRecoveryRank ? ["selectedFoodRecoveryRank"] : []),
    ...(hasSelectedPlanOption ? ["selectedPlanOptionId"] : []),
    ...(hasSelectedPlanStyleRank ? ["selectedPlanStyleRank"] : []),
    ...(value.tacticalStrategy === undefined ? [] : ["tacticalStrategy"]),
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    typeof value.decisionOutcome !== "string" ||
    !OUTCOMES.has(value.decisionOutcome) ||
    !Number.isSafeInteger(value.decisionLatencyMs) ||
    Number(value.decisionLatencyMs) < 0 ||
    Number(value.decisionLatencyMs) >
      MAX_DUEL_PREPARATION_DECISION_LATENCY_MS ||
    hasSelectedPlanOption !== hasSelectedPlanStyleRank ||
    hasSelectedFoodOption !== hasSelectedFoodRecoveryRank ||
    !(
      hasSelectedArmorOption === hasSelectedArmorOffenseRank &&
      hasSelectedArmorOption === hasSelectedArmorFocusedDefenseRank &&
      hasSelectedArmorOption === hasSelectedArmorTotalDefenseRank
    ) ||
    (hasSelectedPlanOption &&
      (typeof value.selectedPlanOptionId !== "string" ||
        !UUID_PATTERN.test(value.selectedPlanOptionId) ||
        !Number.isSafeInteger(value.selectedPlanStyleRank) ||
        Number(value.selectedPlanStyleRank) < 1 ||
        Number(value.selectedPlanStyleRank) > 2)) ||
    (hasSelectedFoodOption &&
      (typeof value.selectedFoodOptionId !== "string" ||
        !UUID_PATTERN.test(value.selectedFoodOptionId) ||
        !Number.isSafeInteger(value.selectedFoodRecoveryRank) ||
        Number(value.selectedFoodRecoveryRank) < 1 ||
        Number(value.selectedFoodRecoveryRank) > 2)) ||
    (hasSelectedArmorOption &&
      (typeof value.selectedArmorOptionId !== "string" ||
        !UUID_PATTERN.test(value.selectedArmorOptionId) ||
        !Number.isSafeInteger(value.selectedArmorOffenseRank) ||
        Number(value.selectedArmorOffenseRank) < 1 ||
        Number(value.selectedArmorOffenseRank) > 3 ||
        !(
          value.selectedArmorFocusedDefenseRank === null ||
          (Number.isSafeInteger(value.selectedArmorFocusedDefenseRank) &&
            Number(value.selectedArmorFocusedDefenseRank) >= 1 &&
            Number(value.selectedArmorFocusedDefenseRank) <= 3)
        ) ||
        !Number.isSafeInteger(value.selectedArmorTotalDefenseRank) ||
        Number(value.selectedArmorTotalDefenseRank) < 1 ||
        Number(value.selectedArmorTotalDefenseRank) > 3))
  ) {
    throw new Error("duel_preparation_decision_receipt_invalid");
  }

  const planEvidence = normalizeCompetitivePreparationEvidence(
    value as CompetitivePreparationEvidence,
  );
  const decisionOutcome =
    value.decisionOutcome as DuelPreparationDecisionOutcome;
  if (
    (planEvidence.planningSource === "model") !==
      (decisionOutcome === "model_selected") ||
    planEvidence.planningSource === "diagnostic"
  ) {
    throw new Error("duel_preparation_decision_receipt_invalid");
  }

  return {
    ...planEvidence,
    decisionOutcome,
    decisionLatencyMs: Number(value.decisionLatencyMs),
    ...(hasSelectedPlanOption
      ? {
          selectedPlanOptionId: value.selectedPlanOptionId as string,
          selectedPlanStyleRank: Number(value.selectedPlanStyleRank),
        }
      : {}),
    ...(hasSelectedFoodOption
      ? {
          selectedFoodOptionId: value.selectedFoodOptionId as string,
          selectedFoodRecoveryRank: Number(value.selectedFoodRecoveryRank),
        }
      : {}),
    ...(hasSelectedArmorOption
      ? {
          selectedArmorOptionId: value.selectedArmorOptionId as string,
          selectedArmorOffenseRank: Number(value.selectedArmorOffenseRank),
          selectedArmorFocusedDefenseRank:
            value.selectedArmorFocusedDefenseRank === null
              ? null
              : Number(value.selectedArmorFocusedDefenseRank),
          selectedArmorTotalDefenseRank: Number(
            value.selectedArmorTotalDefenseRank,
          ),
        }
      : {}),
  };
}
