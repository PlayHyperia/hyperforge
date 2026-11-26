import { describe, expect, it } from "vitest";

import {
  normalizeDuelPreparationDecisionReceiptEvidence,
  type DuelPreparationDecisionReceiptEvidence,
} from "../preparation-decision-receipt";

const evidence = (): DuelPreparationDecisionReceiptEvidence => ({
  primaryStyle: "ranged",
  availableStyles: ["melee", "ranged"],
  planningSource: "deterministic",
  planningPolicyVersion: "duel-preparation-role-v3",
  agentPolicyFingerprint:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  modelProvider: "elizaos",
  model: "test-model",
  tacticalStrategy: {
    approach: "balanced",
    tacticalMacro: "kite",
    attackStyle: "accurate",
    prayer: "hawk_eye",
    preferredCombatRole: "ranged",
    foodThreshold: 40,
    switchDefensiveAt: 30,
    reasoning: "Use the deterministic role-aware competitive fallback.",
  },
  decisionOutcome: "deterministic_runtime_unavailable",
  decisionLatencyMs: 7,
});

describe("duel preparation decision receipt", () => {
  it("normalizes one bounded fallback receipt without retaining private prose", () => {
    const normalized =
      normalizeDuelPreparationDecisionReceiptEvidence(evidence());

    expect(normalized).toEqual(evidence());
    expect(normalized).not.toHaveProperty("reason");
    expect(normalized).not.toHaveProperty("prompt");
    expect(normalized).not.toHaveProperty("bank");
  });

  it("requires model-selected and deterministic outcomes to match their source", () => {
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        planningSource: "model",
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        decisionOutcome: "model_selected",
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");

    expect(
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        planningSource: "model",
        decisionOutcome: "model_selected",
      }),
    ).toMatchObject({
      planningSource: "model",
      decisionOutcome: "model_selected",
    });
  });

  it("durably binds an optional opaque plan choice without accepting partial or malformed bindings", () => {
    expect(
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        selectedPlanOptionId: "11111111-1111-4111-8111-111111111111",
        selectedPlanStyleRank: 2,
      }),
    ).toMatchObject({
      selectedPlanOptionId: "11111111-1111-4111-8111-111111111111",
      selectedPlanStyleRank: 2,
    });
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        selectedPlanOptionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        selectedPlanOptionId: "not-a-uuid",
        selectedPlanStyleRank: 3,
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");
  });

  it("durably binds an optional opaque food choice without accepting partial or malformed bindings", () => {
    expect(
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        selectedFoodOptionId: "22222222-2222-4222-8222-222222222222",
        selectedFoodRecoveryRank: 2,
      }),
    ).toMatchObject({
      selectedFoodOptionId: "22222222-2222-4222-8222-222222222222",
      selectedFoodRecoveryRank: 2,
    });
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        selectedFoodOptionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        selectedFoodOptionId: "not-a-uuid",
        selectedFoodRecoveryRank: 1,
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        selectedFoodOptionId: "22222222-2222-4222-8222-222222222222",
        selectedFoodRecoveryRank: 3,
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");
  });

  it("durably binds one opaque armor choice and all of its server-derived ranks", () => {
    const armorBinding = {
      selectedArmorOptionId: "33333333-3333-4333-8333-333333333333",
      selectedArmorOffenseRank: 2,
      selectedArmorFocusedDefenseRank: null,
      selectedArmorTotalDefenseRank: 1,
    } as const;
    expect(
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        ...armorBinding,
      }),
    ).toMatchObject(armorBinding);
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        ...armorBinding,
        selectedArmorTotalDefenseRank: undefined,
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        ...armorBinding,
        selectedArmorFocusedDefenseRank: 4,
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");
  });

  it.each([
    ["extra private field", { privateReason: "provider failed" }],
    ["negative latency", { decisionLatencyMs: -1 }],
    ["oversized latency", { decisionLatencyMs: 10_001 }],
    ["unknown outcome", { decisionOutcome: "model_bypassed" }],
  ])("rejects %s", (_name, mutation) => {
    expect(() =>
      normalizeDuelPreparationDecisionReceiptEvidence({
        ...evidence(),
        ...mutation,
      }),
    ).toThrow("duel_preparation_decision_receipt_invalid");
  });
});
