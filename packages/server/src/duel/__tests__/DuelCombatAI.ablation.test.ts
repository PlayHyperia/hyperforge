import { beforeAll, describe, expect, it } from "vitest";

import { runCompetitiveTacticalAblation } from "./competitiveTacticalAblationHarness.js";

let fullReport: Awaited<ReturnType<typeof runCompetitiveTacticalAblation>>;

beforeAll(async () => {
  fullReport = await runCompetitiveTacticalAblation(256);
}, 60_000);

describe("DuelCombatAI retained tactical ablation", () => {
  it("replays every matched-seed macro cohort exactly through legal authority", async () => {
    const report = await runCompetitiveTacticalAblation(32);

    expect(report.replayVerified).toBe(true);
    expect(report.harness.noModelRuntimeInCombat).toBe(true);
    expect(report.harness.productAcceptanceThreshold).toBeNull();
    expect(report.harness.technicalResultOnly).toBe(true);
    expect(report.harness.retainedExecutions).toBe(
      report.harness.seedCount * 48 +
        Math.min(report.harness.seedCount, 64) * 18,
    );
    expect(report.variants).toHaveLength(7);
    expect(
      report.variants.every((variant) => variant.illegalActionAttempts === 0),
    ).toBe(true);
    expect(
      new Set(report.variants.map((variant) => variant.behaviorHash)).size,
    ).toBe(report.variants.length);
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reports matched-seed outcome effects without inventing a product threshold", () => {
    const report = fullReport;
    const changed = report.pairedAgainstFallback.filter(
      (comparison) => comparison.improvedSeeds + comparison.regressedSeeds > 0,
    );

    expect(changed.length).toBeGreaterThan(0);
    expect(
      changed.some((comparison) => comparison.twoSidedSignTestP < 0.05),
    ).toBe(true);
    expect(report.movementAblation.facingAblationIncluded).toBe(false);
    expect(report.movementAblation.opponentMovementRetained).toBe(true);
    expect(report.movementAblation.disabled.illegalActionAttempts).toBe(0);
    expect(report.movementAblation.disabled.behaviorHash).not.toBe(
      report.movementAblation.enabled.behaviorHash,
    );
    expect(report.movementAblation.disabledMinusEnabledMeanScore).toBeLessThan(
      0,
    );
    expect(report.movementAblation.disabledRegressedSeeds).toBeGreaterThan(
      report.movementAblation.disabledImprovedSeeds,
    );
    expect(report.movementAblation.twoSidedSignTestP).toBeLessThan(0.05);
    expect(report.roleMatrix.allPairingsReplayed).toBe(true);
    expect(report.roleMatrix.pairings).toHaveLength(9);
    expect(
      report.roleMatrix.pairings.every(
        (pairing) => pairing.illegalActionAttempts === 0,
      ),
    ).toBe(true);
    expect(
      new Set(report.roleMatrix.pairings.map((pairing) => pairing.cohortHash))
        .size,
    ).toBeGreaterThan(3);
    expect(report.styleAblation.durableCustodyIncluded).toBe(false);
    expect(report.styleAblation.meanSuccessfulSwitches).toBeGreaterThan(0);
    expect(report.styleAblation.multiStyle.illegalActionAttempts).toBe(0);
    expect(report.styleAblation.multiStyle.behaviorHash).not.toBe(
      report.styleAblation.fixed.behaviorHash,
    );
  });

  it("proves authored training, equipment, ammunition, and food preparation have causal outcome effects", () => {
    const report = fullReport;
    const preparation = report.preparationAblation;

    expect(preparation.authoredManifestInputs).toBe(true);
    expect(preparation.authoredInputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(preparation.requirementsValidated).toBe(true);
    expect(preparation.allCohortsReplayed).toBe(true);
    expect(preparation.productAcceptanceThreshold).toBeNull();
    expect(preparation.productionInventoryAuthorityIncluded).toBe(false);
    expect(preparation.durableCustodyIncluded).toBe(false);
    expect(preparation.profiles).toHaveLength(6);
    expect(
      preparation.profiles.every(
        (profile) => profile.illegalActionAttempts === 0,
      ),
    ).toBe(true);
    expect(
      new Set(preparation.profiles.map((profile) => profile.cohortHash)).size,
    ).toBe(6);

    for (const dimension of [
      "training",
      "equipment",
      "ammunition",
      "food",
    ] as const) {
      const comparison = preparation.pairedAgainstBaseline.find(
        (candidate) => candidate.dimension === dimension,
      );
      expect(comparison, dimension).toBeDefined();
      expect(comparison?.meanHealthMarginDelta, dimension).toBeGreaterThan(0);
      expect(comparison?.improvedSeeds, dimension).toBeGreaterThan(0);
      expect(comparison?.twoSidedSignTestP, dimension).toBeLessThan(0.05);
    }

    const fullyPrepared = preparation.pairedAgainstBaseline.find(
      (comparison) => comparison.cohort === "fully_prepared",
    );
    expect(fullyPrepared?.meanHealthMarginDelta).toBeGreaterThan(0);
    expect(fullyPrepared?.twoSidedSignTestP).toBeLessThan(0.05);
    expect(
      preparation.profiles.find(
        (profile) => profile.cohort === "food_provisioned",
      )?.meanFoodConsumed,
    ).toBeGreaterThan(0);
    expect(
      preparation.profiles.find(
        (profile) => profile.cohort === "ammunition_provisioned",
      )?.meanAmmunitionRemaining,
    ).toBeLessThan(100);
  });

  it("binds exact gathered and processed inputs to a causally effective launch-ammunition output", () => {
    const supply = fullReport.supplyChainAblation;

    expect(supply.authoredManifestInputs).toBe(true);
    expect(supply.authoredInputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(supply.recipeGraphValidated).toBe(true);
    expect(supply.commonRandomNumbers).toBe(true);
    expect(supply.allCohortsReplayed).toBe(true);
    expect(supply.productAcceptanceThreshold).toBeNull();
    expect(supply.acquisitionProvenanceChangesCombatStats).toBe(false);
    expect(supply.productionProcessingAuthorityIncluded).toBe(false);
    expect(supply.productionInventoryAuthorityIncluded).toBe(false);
    expect(supply.durableCustodyIncluded).toBe(false);
    expect(supply.lineage.targetItemId).toBe("bronze_arrow");
    expect(supply.lineage.incompleteBatchCount).toBe(1);
    expect(supply.lineage.incompleteOutputQuantity).toBeLessThan(
      supply.lineage.readinessTargetQuantity,
    );
    expect(supply.lineage.completeOutputQuantity).toBeGreaterThanOrEqual(
      supply.lineage.readinessTargetQuantity,
    );
    expect(supply.lineage.completeOutputQuantity).toBe(
      supply.lineage.completeBatchCount * supply.lineage.outputQuantityPerBatch,
    );
    expect(
      supply.lineage.exactGatheringInputs.map((input) => input.itemId).sort(),
    ).toEqual(["copper_ore", "logs", "tin_ore"]);
    expect(supply.lineage.exactStoreLeafInputs).toContainEqual(
      expect.objectContaining({ itemId: "feathers" }),
    );
    expect(
      supply.lineage.exactProcessingActions.map((action) => action.activity),
    ).toEqual(["smelting", "smithing", "fletching", "fletching", "fletching"]);
    expect(supply.incomplete.illegalActionAttempts).toBe(0);
    expect(supply.completed.illegalActionAttempts).toBe(0);
    expect(supply.completed.cohortHash).not.toBe(supply.incomplete.cohortHash);
    expect(supply.completedMinusIncompleteMeanHealthMargin).toBeGreaterThan(0);
    expect(supply.completedImprovedSeeds).toBeGreaterThan(0);
    expect(supply.twoSidedSignTestP).toBeLessThan(0.05);
  });

  it("proves every authored role prayer survives production combination and causally affects outcomes", () => {
    const report = fullReport;
    const prayer = report.prayerAblation;

    expect(prayer.authoredManifestInput).toBe(true);
    expect(prayer.authoredInputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(prayer.productionModifierRetentionCovered).toBe(true);
    expect(prayer.allCohortsReplayed).toBe(true);
    expect(prayer.productAcceptanceThreshold).toBeNull();
    expect(prayer.productionPrayerCustodyIncluded).toBe(false);
    expect(prayer.roles).toHaveLength(3);
    expect(prayer.roles.map((role) => role.prayerId).sort()).toEqual([
      "hawk_eye",
      "mystic_lore",
      "superhuman_strength",
    ]);
    for (const role of prayer.roles) {
      expect(role.enabled.illegalActionAttempts, role.role).toBe(0);
      expect(role.disabled.illegalActionAttempts, role.role).toBe(0);
      expect(role.enabled.cohortHash, role.role).not.toBe(
        role.disabled.cohortHash,
      );
      expect(role.meanEnabledPrayerCommits, role.role).toBeGreaterThan(0);
      expect(role.disabledPrayerCommits, role.role).toBe(0);
      expect(role.meanHealthMarginDelta, role.role).toBeGreaterThan(0);
      expect(role.enabledImprovedSeeds, role.role).toBeGreaterThan(0);
      expect(role.twoSidedSignTestP, role.role).toBeLessThan(0.05);
    }
  });
});
