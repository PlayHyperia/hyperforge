import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const agentManagerSource = readFileSync(
  fileURLToPath(new URL("../AgentManager.ts", import.meta.url)),
  "utf8",
);
const behaviorBridgeSource = readFileSync(
  fileURLToPath(new URL("../managers/AgentBehaviorBridge.ts", import.meta.url)),
  "utf8",
);
const behaviorEngineSource = readFileSync(
  fileURLToPath(new URL("../worker/AgentBehaviorEngine.ts", import.meta.url)),
  "utf8",
);
const ordinaryShoppingSource = behaviorEngineSource.slice(
  behaviorEngineSource.indexOf("function manageShopping("),
  behaviorEngineSource.indexOf("function isNearbyObject("),
);
const questDependencySource = behaviorEngineSource.slice(
  behaviorEngineSource.indexOf("function getEligibleGatheringRequirements("),
  behaviorEngineSource.indexOf("function pickCookableRecipe("),
);
const workerTypesSource = readFileSync(
  fileURLToPath(new URL("../worker/workerTypes.ts", import.meta.url)),
  "utf8",
);
const behaviorTickerSource = readFileSync(
  fileURLToPath(new URL("../managers/AgentBehaviorTicker.ts", import.meta.url)),
  "utf8",
);
const ordinaryBankingSource = readFileSync(
  fileURLToPath(new URL("../ordinaryAgentBanking.ts", import.meta.url)),
  "utf8",
);
const ordinaryQuestProgressionSource = readFileSync(
  fileURLToPath(
    new URL("../ordinaryAgentQuestProgression.ts", import.meta.url),
  ),
  "utf8",
);
const embeddedServiceSource = readFileSync(
  fileURLToPath(new URL("../EmbeddedHyperiaService.ts", import.meta.url)),
  "utf8",
);
const storeHandlerSource = readFileSync(
  fileURLToPath(
    new URL("../../systems/ServerNetwork/handlers/store.ts", import.meta.url),
  ),
  "utf8",
);
const ordinaryPrayerSource = readFileSync(
  fileURLToPath(new URL("../ordinaryAgentPrayerTraining.ts", import.meta.url)),
  "utf8",
);
const ordinaryGatheringSource = readFileSync(
  fileURLToPath(new URL("../ordinaryAgentGathering.ts", import.meta.url)),
  "utf8",
);
const ordinaryProcessingSource = readFileSync(
  fileURLToPath(new URL("../ordinaryAgentProcessing.ts", import.meta.url)),
  "utf8",
);
const ordinaryStoreSource = readFileSync(
  fileURLToPath(new URL("../ordinaryAgentStore.ts", import.meta.url)),
  "utf8",
);
const authoritativeBankingSource = readFileSync(
  fileURLToPath(new URL("../AuthoritativeAgentBanking.ts", import.meta.url)),
  "utf8",
);
const modelDecisionSource = readFileSync(
  fileURLToPath(new URL("../llmBehaviorDecision.ts", import.meta.url)),
  "utf8",
);

describe("embedded autonomy source policy", () => {
  it("keeps one authoritative worker-bridge scheduler", () => {
    expect(
      agentManagerSource.match(
        /this\.behaviorBridge\.startAgent\(characterId\);/g,
      ),
    ).toHaveLength(2);
    expect(agentManagerSource).not.toMatch(
      /startEmbeddedAgentLlmPlanningLoop|stopEmbeddedAgentLlmPlanningLoop|EMBEDDED_AGENT_LLM_PLANNING/,
    );
  });

  it("fails closed instead of teleporting when movement authority is absent", () => {
    expect(embeddedServiceSource).toContain(
      "Authoritative movement system not available",
    );
    expect(embeddedServiceSource).not.toContain("applyDirectPositionFallback");
  });

  it("fails closed instead of acknowledging unadmitted gathering", () => {
    const gatherExecutor = embeddedServiceSource.slice(
      embeddedServiceSource.indexOf("async executeGather("),
      embeddedServiceSource.indexOf("async executePickup("),
    );
    expect(gatherExecutor).toContain(
      "!networkSystem?.pendingGatherManager || !networkSystem.tickSystem",
    );
    expect(gatherExecutor).toContain(
      "networkSystem.pendingGatherManager.queuePendingGather",
    );
    expect(gatherExecutor).not.toContain(
      "this.world.emit(EventType.RESOURCE_GATHER",
    );
  });

  it("records ground-item pickup only after authoritative completion", () => {
    const pickupExecutor = embeddedServiceSource.slice(
      embeddedServiceSource.indexOf("async executePickup("),
      embeddedServiceSource.indexOf("async executeLootGravestone("),
    );
    expect(pickupExecutor).toContain("networkSystem.requestServerPickup");
    expect(pickupExecutor).toContain(
      "getGroundItemPickupOperationIdForAttempt(autonomyAttemptId)",
    );
    expect(pickupExecutor).not.toContain(
      "this.world.emit(EventType.ITEM_PICKUP",
    );
    for (const autonomySource of [behaviorBridgeSource, behaviorTickerSource]) {
      expect(autonomySource).toContain(
        'actionResult("pickup", "completed", "pickup")',
      );
      expect(autonomySource).not.toContain(
        'actionResult("pickup", "dispatched", "pickup")',
      );
      const pickupCase = autonomySource.slice(
        autonomySource.indexOf('case "pickup"'),
        autonomySource.indexOf('case "lootGravestone"'),
      );
      expect(pickupCase).toContain("progressionAttempt.attemptId");
    }
    const receiptBoundSet = behaviorBridgeSource.slice(
      behaviorBridgeSource.indexOf("RECEIPT_BOUND_CUSTODY_ACTIONS"),
      behaviorBridgeSource.indexOf("function isReceiptBoundCustodyAction"),
    );
    expect(receiptBoundSet).toContain('"pickup"');
  });

  it("routes every embedded unequip surface through conserved equipment authority", () => {
    const legacyUnequip = embeddedServiceSource.slice(
      embeddedServiceSource.indexOf("async executeUnequip(slot:"),
      embeddedServiceSource.indexOf("async executeSetAutoRetaliate("),
    );
    expect(legacyUnequip).toContain("this.executeUnequipOwned(slot)");
    expect(legacyUnequip).not.toContain("EventType.EQUIPMENT_UNEQUIP");
  });

  it("propagates authoritative movement admission through follow", () => {
    const followExecutor = embeddedServiceSource.slice(
      embeddedServiceSource.indexOf("async executeFollow("),
      embeddedServiceSource.indexOf("async executeRespawn("),
    );
    expect(followExecutor).toContain(
      "return this.executeMove(targetPos, true)",
    );
    expect(followExecutor).not.toMatch(
      /await this\.executeMove\(targetPos, true\);\s*return true/,
    );
  });

  it("records respawn success only after player-death authority completes", () => {
    const respawnExecutor = embeddedServiceSource.slice(
      embeddedServiceSource.indexOf("async executeRespawn("),
      embeddedServiceSource.indexOf("isSpawned()"),
    );
    expect(respawnExecutor).toContain("deathSystem.requestPlayerRespawn");
    expect(respawnExecutor).not.toContain(
      'this.world.emit("player:respawn:request"',
    );
  });

  it("prefetches model decisions off the action path and fences stale output", () => {
    expect(behaviorBridgeSource).toContain(
      "pickBehaviorActionWithLlm(instance, freshState)",
    );
    expect(behaviorBridgeSource).toContain(
      "const llmResult = instance.pendingLlmResult ?? null",
    );
    expect(behaviorBridgeSource).toContain(
      "instance.behaviorEpoch === behaviorEpoch",
    );
    expect(behaviorBridgeSource).toContain(
      "result.behaviorEpoch !== instance.behaviorEpoch",
    );
  });

  it("forbids hidden worker mutations before the one typed action", () => {
    expect(workerTypesSource).not.toMatch(/AgentSideEffect|sideEffects/);
    expect(behaviorEngineSource).not.toMatch(/AgentSideEffect|sideEffects/);
    expect(behaviorBridgeSource).not.toMatch(/result\.sideEffects/);
    expect(behaviorEngineSource).toContain(
      "Every tick may emit exactly one typed action",
    );
    expect(behaviorTickerSource).toContain("const maintenanceAction =");
    expect(behaviorTickerSource).not.toMatch(
      /manageInventory|instance\.service\.executeDrop/,
    );
  });

  it("keeps ordinary banking exact, surplus-only, and causally retryable", () => {
    expect(behaviorTickerSource).toContain(
      '{ type: "bankDepositAll"; bankId: string }',
    );
    expect(behaviorTickerSource).toContain(
      '{ type: "bankWithdraw"; bankId: string }',
    );
    expect(behaviorEngineSource).toContain(
      '{ type: "bankDepositAll", bankId: bank.entityId }',
    );
    expect(behaviorEngineSource).toContain(
      '{ type: "bankWithdraw", bankId: bank.entityId }',
    );
    expect(modelDecisionSource).toContain("model text never does");
    expect(ordinaryBankingSource).toContain(
      "getOrdinaryBankOperationId(attempt.attemptId)",
    );
    expect(ordinaryBankingSource).toContain(
      "getOrdinaryBankStageOperationId(attempt.attemptId)",
    );
    expect(ordinaryBankingSource).toContain(
      "model never sees or supplies bank item identities or counts",
    );
    expect(ordinaryBankingSource).toContain(
      'lastReceipt.commitState !== "unknown"',
    );
    expect(authoritativeBankingSource).toContain(
      "Only a new custody mutation reaches this branch",
    );
    expect(authoritativeBankingSource).not.toContain(
      'DELETE FROM inventory WHERE "playerId" = $1',
    );
  });

  it("keeps ordinary processing choices on the loaded recipe manifests", () => {
    expect(behaviorBridgeSource).toContain(
      "ProcessingDataProvider.getInstance()",
    );
    expect(behaviorBridgeSource).toContain(
      "smelting.inputs?.map((input) => ({ ...input }))",
    );
    expect(behaviorEngineSource).toContain("COOKING_RECIPES");
    expect(behaviorEngineSource).toContain("SMELTING_RECIPES");
    expect(behaviorEngineSource).toContain("SMITHING_RECIPES");
    expect(behaviorEngineSource).toContain("FIREMAKING_RECIPES");
    expect(behaviorEngineSource).toContain("CRAFTING_RECIPES");
    expect(behaviorEngineSource).toContain("FLETCHING_RECIPES");
    expect(behaviorEngineSource).toContain("RUNECRAFTING_RECIPES");
    expect(behaviorEngineSource).not.toMatch(
      /COOKABLE_ITEMS|SMELTABLE_ORES|CRAFTABLE_ITEMS|FLETCHABLE_ITEMS|bronze_dagger|airAltar|logTypes/,
    );
  });

  it("keeps private processing custody state out of the worker protocol", () => {
    expect(ordinaryBankingSource).toContain("getPrivateCoinBalance");
    for (const workerFacingSource of [
      behaviorBridgeSource,
      behaviorEngineSource,
      workerTypesSource,
    ]) {
      expect(workerFacingSource).not.toMatch(
        /coinBalance|processingConsumableUses/,
      );
    }
    expect(workerTypesSource).toContain(
      "ordinaryProcessingAcquisitionAuthorized?: boolean",
    );
    expect(behaviorBridgeSource).toContain(
      "Boolean(instance.ordinaryProcessingAcquisition)",
    );
    expect(behaviorEngineSource).toContain(
      "getOrdinaryProcessingAcquisitionStep",
    );
    expect(behaviorEngineSource).toContain("getOrdinaryCombatSupplyTarget");
    expect(behaviorEngineSource).toContain("pickCombatSupplyBankAction");
    expect(behaviorEngineSource).toContain(
      'if (itemData.type !== "weapon") continue;',
    );
    expect(ordinaryBankingSource).toContain(
      'instance.goal.bankPurpose === "combat_supply"',
    );
    expect(ordinaryBankingSource).toContain("selectOrdinaryCombatReadiness");
    expect(ordinaryBankingSource).toContain("getOrdinaryCombatSupplyNeed");
    expect(ordinaryBankingSource).toContain(
      "buildOrdinaryCombatSupplyRecipeCatalog",
    );
    expect(ordinaryBankingSource).toContain(
      "buildOrdinaryCombatSupplyGatheringCatalog",
    );
    expect(ordinaryBankingSource).toContain(
      "buildOrdinaryCombatSupplyPublicSourceCatalog",
    );
    expect(ordinaryBankingSource).toContain("getResolvableRecipeInputs");
    expect(ordinaryBankingSource).toContain("getExternalResources");
    expect(ordinaryBankingSource).toContain("isCompatibleGatheringTool");
    expect(ordinaryBankingSource).toContain("combat_supply_precursors");
    expect(ordinaryBankingSource).toContain("orderOrdinarySupplyAlternatives");
    expect(ordinaryBankingSource).toContain("hasActiveCombatSupplyCustody");
    expect(ordinaryBankingSource).toContain("precursorPlan.retainedItems");
    expect(behaviorEngineSource).toContain("orderOrdinarySupplyAlternatives");
    expect(behaviorBridgeSource).toContain(
      'actionExecution.appliedActionType === "gather"',
    );
    expect(behaviorTickerSource).toContain("restoreUncommittedGatherThrottle");
    expect(workerTypesSource).not.toContain("retainedItems");
    expect(workerTypesSource).not.toMatch(/bankItems|bankQuantities/);
  });

  it("derives ordinary basic and gathering provisioning from loaded catalogs", () => {
    expect(ordinaryShoppingSource).toContain(
      "getEligibleGatheringRequirements",
    );
    expect(questDependencySource).toContain("GATHERING_BY_OUTPUT");
    expect(questDependencySource).toContain("getFletchingQuestStep");
    expect(ordinaryShoppingSource).toContain("findCheapestLoadedCatalogItem");
    expect(ordinaryShoppingSource).not.toMatch(
      /bronze_shortsword|bronze_hatchet|bronze_pickaxe|small_fishing_net|sword_store|general_store|fishing_store/,
    );
  });

  it("keeps skill-only quest entry training shared, manifest-derived, and bank-private", () => {
    expect(ordinaryQuestProgressionSource).toContain(
      "findOrdinaryQuestEntrySkillTarget",
    );
    expect(ordinaryQuestProgressionSource).toContain(
      "quest.requirements.quests.length > 0",
    );
    expect(ordinaryQuestProgressionSource).toContain(
      "quest.requirements.items.length > 0",
    );
    expect(behaviorEngineSource).toContain("findOrdinaryQuestEntrySkillTarget");
    expect(behaviorTickerSource).toContain("findOrdinaryQuestEntrySkillTarget");
    expect(ordinaryBankingSource).toContain(
      "findOrdinaryQuestEntrySkillTarget",
    );
    expect(ordinaryBankingSource).toContain("requestedTrainingQuestId");
    expect(behaviorBridgeSource).toContain('action.type === "bankWithdraw"');
    expect(behaviorBridgeSource).toContain('instance.goal?.type === "banking"');
    expect(ordinaryBankingSource).toContain(
      'result.reason === "nothing_to_stage"',
    );
    expect(behaviorEngineSource).toContain("GUARANTEED_MOB_TYPES_BY_DROP");
    expect(behaviorEngineSource).toContain(
      "guaranteedMobTypes.has(entity.mobType)",
    );
    expect(workerTypesSource).toContain("questEntryAcquisitionQuestId");
    expect(workerTypesSource).toContain("coinRecoveryAuthorized");
    expect(behaviorEngineSource).toContain(
      'GUARANTEED_MOB_TYPES_BY_DROP.get("coins")',
    );
    expect(behaviorEngineSource).toContain("entity.mobType");
    expect(behaviorBridgeSource).toContain(
      "hasOrdinaryCoinRecoveryAuthorization",
    );
    expect(ordinaryStoreSource).toContain("getPrivateCoinBalance");
    expect(ordinaryStoreSource).toContain("getStoreById");
    expect(
      behaviorBridgeSource.indexOf(
        "const coinRecoveryAuthorized = hasOrdinaryCoinRecoveryAuthorization",
      ),
    ).toBeLessThan(
      behaviorBridgeSource.indexOf("storeRetryAfter: instance.storeRetryAfter"),
    );
    expect(behaviorBridgeSource).not.toContain("coinBalance:");
    expect(workerTypesSource).not.toMatch(/bankItems|bankQuantities/);
  });

  it("routes embedded store sales through exact secure session authority", () => {
    expect(embeddedServiceSource).toContain("handleStoreSell");
    expect(embeddedServiceSource).toContain("executeSecureStoreTransaction");
    expect(embeddedServiceSource).not.toContain(
      "this.world.emit(EventType.STORE_SELL",
    );
    expect(storeHandlerSource).toContain(
      "storeSession?.targetStoreId !== data.storeId",
    );
    expect(storeHandlerSource).toContain(
      'sendErrorToast(socket, "You can\'t sell items during a duel.")',
    );
  });

  it("binds autonomous purchases to immutable attempts and restart receipts", () => {
    expect(behaviorBridgeSource).toContain("executeOrdinaryStoreBuy(");
    expect(behaviorTickerSource).toContain("executeOrdinaryStoreBuy(");
    expect(behaviorBridgeSource).not.toContain(
      "instance.service.executeStoreBuy(",
    );
    expect(behaviorBridgeSource).toContain(
      "!isReceiptBoundCustodyAction(fallback)",
    );
    expect(ordinaryStoreSource).toContain(
      "getOrdinaryStoreBuyOperationId(attempt.attemptId)",
    );
    expect(ordinaryStoreSource).toContain("resolveOrdinaryStoreRecovery");
    expect(storeHandlerSource).toContain("agentStoreOperations");
    expect(embeddedServiceSource).toContain('status: "unknown"');
  });

  it("keeps every receipt-bound custody action out of generic fallback execution", () => {
    const fallbackExecutor = behaviorBridgeSource.slice(
      behaviorBridgeSource.indexOf("private async executeAction("),
      behaviorBridgeSource.indexOf("// ─── PRIVATE: WORLD SCAN CACHES"),
    );
    for (const actionType of [
      "gather",
      "lootGravestone",
      "bury",
      "firemake",
      "cook",
      "smelt",
      "smith",
      "runecraft",
      "craft",
      "fletch",
      "tan",
      "storeBuy",
      "bankDepositAll",
      "bankWithdraw",
    ]) {
      expect(behaviorBridgeSource).toContain(`"${actionType}"`);
    }
    expect(fallbackExecutor).toContain("isReceiptBoundCustodyAction(action)");
    expect(fallbackExecutor).not.toMatch(
      /executeLootGravestone|executeOrdinaryBoneBurial|executeOrdinaryStoreBuy|executeOrdinaryBankDepositSurplus|executeOrdinaryBankStageMaterials/,
    );
    for (const source of [behaviorBridgeSource, behaviorTickerSource]) {
      for (const actionType of [
        "gather",
        "lootGravestone",
        "bury",
        "firemake",
        "cook",
        "smelt",
        "smith",
        "runecraft",
        "craft",
        "fletch",
        "tan",
        "storeBuy",
        "bankDepositAll",
        "bankWithdraw",
      ]) {
        const actionCase = source.slice(
          source.indexOf(`case "${actionType}":`),
          source.indexOf(`case "${actionType}":`) + 180,
        );
        expect(actionCase).toContain("if (!progressionAttempt) break;");
      }
    }
    expect(ordinaryBankingSource).not.toContain("randomUUID");
    expect(ordinaryStoreSource).not.toContain("randomUUID");
    expect(ordinaryProcessingSource).not.toContain("randomUUID");

    const gravestoneExecutor = embeddedServiceSource.slice(
      embeddedServiceSource.indexOf("async executeLootGravestone("),
      embeddedServiceSource.indexOf("async executeDrop("),
    );
    expect(gravestoneExecutor).toContain(
      "`agent-grave-loot:${normalizedAttemptId}`",
    );
    expect(gravestoneExecutor).not.toContain("crypto.randomUUID");
  });

  it("binds autonomous gathering to its first durable reward and restart receipt", () => {
    for (const source of [behaviorBridgeSource, behaviorTickerSource]) {
      const gatherCase = source.slice(
        source.indexOf('case "gather":'),
        source.indexOf('case "gather":') + 420,
      );
      expect(gatherCase).toContain("if (!progressionAttempt) break;");
      expect(gatherCase).toContain("progressionAttempt.attemptId");
      expect(gatherCase).toContain(
        'actionResult("gather", "completed", "gather")',
      );
      expect(gatherCase).not.toContain(
        'actionResult("gather", "dispatched", "gather")',
      );
    }
    expect(ordinaryGatheringSource).toContain(
      "getOrdinaryGatheringRewardOperationId(attempt.attemptId)",
    );
    expect(ordinaryGatheringSource).toContain(
      "resolveOrdinaryGatheringRecovery",
    );
    expect(agentManagerSource).toContain(
      "resolveOrdinaryGatheringRecovery(db, attempt)",
    );
  });

  it("binds every autonomous processing family to its exact attempt receipt", () => {
    for (const source of [behaviorBridgeSource, behaviorTickerSource]) {
      for (const actionType of [
        "firemake",
        "cook",
        "smelt",
        "smith",
        "runecraft",
        "craft",
        "fletch",
        "tan",
      ]) {
        const actionCase = source.slice(
          source.indexOf(`case "${actionType}":`),
          source.indexOf(`case "${actionType}":`) + 520,
        );
        expect(actionCase).toContain("if (!progressionAttempt) break;");
        expect(actionCase).toContain("progressionAttempt.attemptId");
      }
    }
    expect(ordinaryProcessingSource).toContain(
      "getProcessingRequestOperationId(",
    );
    expect(ordinaryProcessingSource).toContain(
      "resolveOrdinaryProcessingRecovery",
    );
    expect(agentManagerSource).toContain(
      "resolveOrdinaryProcessingRecovery(db, attempt)",
    );
  });

  it("keeps prayer-resource training typed, attempt-bound, and receipt-recoverable", () => {
    expect(behaviorTickerSource).toContain('{ type: "bury"; itemId: string }');
    expect(behaviorEngineSource).toContain(
      'return candidates[0]\n    ? { type: "bury"',
    );
    expect(ordinaryPrayerSource).toContain(
      "getOrdinaryBoneBurialOperationId(attempt.attemptId)",
    );
    expect(ordinaryPrayerSource).not.toContain("randomUUID");
    expect(ordinaryPrayerSource).toContain("resolveOrdinaryBoneBurialRecovery");
    expect(ordinaryPrayerSource).toContain(
      "lastReceipt?.ok && lastReceipt.liveStateApplied",
    );
  });
});
