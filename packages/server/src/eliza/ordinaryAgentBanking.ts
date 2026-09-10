import { eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import {
  INVENTORY_CONSTANTS,
  ProcessingDataProvider,
  SMITHING_CONSTANTS,
  getAllStores,
  getCombatNPCs,
  getExternalResources,
  getItem,
} from "@hyperforge/shared";

import type { Database } from "../database/client.js";
import { agentBankOperations } from "../database/schema.js";
import type {
  AgentBankActionReceipt,
  AgentBankItemView,
  AgentBankRetainedItem,
  AgentBankTransferItem,
} from "./AuthoritativeAgentBanking.js";
import type { AgentAutonomyActionResult } from "./agentAutonomyCheckpoint.js";
import type { AgentAutonomyProgressionAttempt } from "./agentAutonomyProgression.js";
import type { AgentInstance } from "./managers/AgentBehaviorTicker.js";
import { resolveOrdinaryCombatSpecialization } from "./ordinaryCombatSpecialization.js";
import { buildOrdinaryCombatReadinessCatalog } from "./ordinaryCombatReadinessCatalog.js";
import {
  getOrdinaryCombatSupplyNeed,
  selectOrdinaryCombatReadiness,
  type OrdinaryCombatReadinessCatalog,
} from "./ordinaryCombatReadinessSelection.js";
import {
  findOrdinaryQuestEntrySkillTarget,
  getProcessingActivitySkill,
} from "./ordinaryAgentQuestProgression.js";
import { orderOrdinarySupplyAlternatives } from "./ordinarySupplyAlternativeSelection.js";

const ORDINARY_BANK_OPERATION_NAMESPACE =
  "c78561cb-80fd-40bf-af7b-9832fbad71c9";
const ORDINARY_BANK_STAGE_OPERATION_NAMESPACE =
  "fd575467-74c1-4d06-ad49-1257c83f70db";
const INITIAL_RECONCILIATION_DELAY_MS = 25;
const MAX_RECONCILIATION_DELAY_MS = 1_000;
const ORDINARY_PROCESSING_BATCH_SIZE = 5;

export interface OrdinaryBankExecutionResult {
  settled: boolean;
  applied: boolean;
  receipt: AgentBankActionReceipt | null;
  operationId: string;
  retainedItems: AgentBankRetainedItem[];
  reconciliationAttempts: number;
}

export type OrdinaryBankStagePlan =
  | {
      activity: "survival_food";
      itemId: string;
      quantity: number;
    }
  | {
      activity: "survival_supply_tool";
      itemId: string;
      quantity: 1;
    }
  | {
      activity: "combat_supply";
      itemId: string;
      quantity: number;
    }
  | {
      activity: "combat_supply_precursors";
      targetItemId: string;
      /** Whole target-output actions represented by the current deficit. */
      actionCount: number;
      items: AgentBankTransferItem[];
    }
  | {
      activity: "cooking";
      itemId: string;
      quantity: number;
    }
  | {
      activity: "smithing";
      recipeId: string;
      itemId: string;
      quantity: number;
      actionCount: number;
      items: AgentBankTransferItem[];
    }
  | {
      activity:
        | "smelting"
        | "crafting"
        | "fletching"
        | "firemaking"
        | "runecrafting"
        | "tanning";
      recipeId: string;
      actionCount: number;
      items: AgentBankTransferItem[];
      /** Private partial staging before public-source recovery fills the rest. */
      entryTrainingRecovery?: boolean;
      questId?: string;
    };

export interface OrdinaryBankStageExecutionResult extends OrdinaryBankExecutionResult {
  plan: OrdinaryBankStagePlan | null;
  reason:
    | "completed"
    | "bank_open_rejected"
    | "nothing_to_stage"
    | "withdraw_rejected"
    | "shutdown_unsettled";
}

const BANK_STAGE_MISS_REASSESSMENT_MS = 300_000;
const BANK_STAGE_TECHNICAL_RETRY_MS = 30_000;

/**
 * Record only a public acquisition-control edge after an exact private bank
 * miss. Infrastructure/open/withdrawal failures never authorize a different
 * source path, and no bank item identity or quantity leaves this module.
 */
export function recordOrdinaryBankStageOutcome(
  instance: AgentInstance,
  result: OrdinaryBankStageExecutionResult,
  now = Date.now(),
): void {
  const questId =
    instance.goal?.type === "banking" ? instance.goal.questId : undefined;
  const survivalFoodRequest =
    instance.goal?.type === "banking" &&
    instance.goal.bankPurpose === "survival_food";
  const combatSupplyRequest =
    instance.goal?.type === "banking" &&
    instance.goal.bankPurpose === "combat_supply";
  const exactTrainingMiss =
    !result.applied && result.reason === "nothing_to_stage" && Boolean(questId);
  const exactGeneralProcessingMiss =
    !result.applied &&
    result.reason === "nothing_to_stage" &&
    !questId &&
    !survivalFoodRequest &&
    !combatSupplyRequest;
  const exactCombatSupplyMiss =
    !result.applied &&
    result.reason === "nothing_to_stage" &&
    combatSupplyRequest;
  const processingAcquisitionAuthorized =
    exactGeneralProcessingMiss || exactCombatSupplyMiss;
  const exactSurvivalFoodMiss =
    !result.applied &&
    result.reason === "nothing_to_stage" &&
    survivalFoodRequest;
  const stagedSurvivalSupplyTool =
    result.applied && result.plan?.activity === "survival_supply_tool";
  const survivalRecoveryAuthorized =
    exactSurvivalFoodMiss || stagedSurvivalSupplyTool;

  instance.bankStageRetryAfter =
    result.applied && !stagedSurvivalSupplyTool
      ? 0
      : now +
        (exactTrainingMiss ||
        processingAcquisitionAuthorized ||
        survivalRecoveryAuthorized
          ? BANK_STAGE_MISS_REASSESSMENT_MS
          : BANK_STAGE_TECHNICAL_RETRY_MS);
  instance.questEntryAcquisition = exactTrainingMiss
    ? {
        questId: questId!,
        expiresAt: now + BANK_STAGE_MISS_REASSESSMENT_MS,
      }
    : null;
  instance.ordinaryProcessingAcquisition = processingAcquisitionAuthorized
    ? { expiresAt: now + BANK_STAGE_MISS_REASSESSMENT_MS }
    : null;
  instance.survivalFoodAcquisition = survivalRecoveryAuthorized
    ? { expiresAt: now + BANK_STAGE_MISS_REASSESSMENT_MS }
    : null;
}

export function getOrdinaryBankOperationId(attemptId: string): string {
  return uuidv5(
    `ordinary-bank-deposit-surplus:v1:${attemptId}`,
    ORDINARY_BANK_OPERATION_NAMESPACE,
  );
}

export function getOrdinaryBankStageOperationId(attemptId: string): string {
  return uuidv5(
    `ordinary-bank-stage-materials:v1:${attemptId}`,
    ORDINARY_BANK_STAGE_OPERATION_NAMESPACE,
  );
}

function getSafeQuantity(value: unknown): number {
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
}

export interface OrdinaryCombatSupplyRecipe {
  activity: "smelting" | "smithing" | "fletching" | "runecrafting";
  stableId: string;
  outputItemId: string;
  outputQuantity: number;
  levelRequired: number;
  inputAlternatives: Array<Array<{ itemId: string; quantity: number }>>;
  tools: string[];
}

export interface OrdinaryBankRetentionPolicyOptions {
  /** Main-process time authority used to bound private-miss acquisition. */
  now?: number;
  /** Injectable only so policy tests can prove an exact authored snapshot. */
  combatReadinessCatalog?: OrdinaryCombatReadinessCatalog;
  /** Injectable only so policy tests can prove an exact authored snapshot. */
  combatSupplyRecipes?: OrdinaryCombatSupplyRecipe[];
  /** Injectable only so policy tests can prove an exact authored snapshot. */
  combatSupplyGatheringSources?: OrdinaryCombatSupplyGatheringSource[];
  /** Injectable only so policy tests can prove an exact authored snapshot. */
  combatSupplyPublicSourceItemIds?: string[];
}

export interface OrdinaryCombatSupplyGatheringSource {
  resourceId: string;
  harvestSkill: string;
  toolRequired: string | null;
  levelRequired: number;
  outputItemIds: string[];
}

/**
 * Rebuild the exact authored combat-supply recipe graph on the private main
 * thread. Its ordering matches the public worker graph, so private precursor
 * staging cannot redirect the agent into another recipe or product strategy.
 */
export function buildOrdinaryCombatSupplyRecipeCatalog(): OrdinaryCombatSupplyRecipe[] {
  const provider = ProcessingDataProvider.getInstance();
  return [
    ...[...provider.getSmeltableBarIds()].map((barItemId) => {
      const recipe = provider.getSmeltingData(barItemId)!;
      return {
        activity: "smelting" as const,
        stableId: barItemId,
        outputItemId: barItemId,
        outputQuantity: 1,
        levelRequired: recipe.levelRequired,
        inputAlternatives: [
          recipe.inputs ?? [
            { itemId: recipe.primaryOre, quantity: 1 },
            ...(recipe.secondaryOre
              ? [{ itemId: recipe.secondaryOre, quantity: 1 }]
              : []),
            ...(recipe.coalRequired > 0
              ? [{ itemId: "coal", quantity: recipe.coalRequired }]
              : []),
          ],
        ],
        tools: [],
      };
    }),
    ...provider.getAllSmithingRecipes().map((recipe) => ({
      activity: "smithing" as const,
      stableId: recipe.itemId,
      outputItemId: recipe.itemId,
      outputQuantity: recipe.outputQuantity,
      levelRequired: recipe.levelRequired,
      inputAlternatives: [
        [{ itemId: recipe.barType, quantity: recipe.barsRequired }],
      ],
      tools: [SMITHING_CONSTANTS.HAMMER_ITEM_ID],
    })),
    ...provider.getAllFletchingRecipes().map((recipe) => ({
      activity: "fletching" as const,
      stableId: recipe.recipeId,
      outputItemId: recipe.output,
      outputQuantity: recipe.outputQuantity,
      levelRequired: recipe.level,
      inputAlternatives: [
        recipe.inputs.map((input) => ({
          itemId: input.item,
          quantity: input.amount,
        })),
      ],
      tools: [...recipe.tools],
    })),
    ...provider.getAllRunecraftingRecipes().map((recipe) => ({
      activity: "runecrafting" as const,
      stableId: recipe.runeType,
      outputItemId: recipe.runeItemId,
      outputQuantity: 1,
      levelRequired: recipe.levelRequired,
      inputAlternatives: recipe.essenceTypes.map((itemId) => [
        { itemId, quantity: 1 },
      ]),
      tools: [],
    })),
  ].sort(
    (left, right) =>
      left.levelRequired - right.levelRequired ||
      left.activity.localeCompare(right.activity) ||
      left.stableId.localeCompare(right.stableId),
  );
}

/**
 * Rebuild the worker's public gathering-source view on the private main
 * thread. Only public manifest identities cross this derivation; bank custody
 * remains private and can select only a compatible tool for an exact leaf.
 */
export function buildOrdinaryCombatSupplyGatheringCatalog(): OrdinaryCombatSupplyGatheringSource[] {
  return [...getExternalResources().values()]
    .map((resource) => ({
      resourceId: resource.id,
      harvestSkill: resource.harvestSkill,
      toolRequired: resource.toolRequired,
      levelRequired: resource.levelRequired,
      outputItemIds: [
        ...new Set(resource.harvestYield.map((drop) => drop.itemId)),
      ].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

/**
 * Rebuild the worker's non-gathering public acquisition boundary on the
 * private main thread. The set contains public manifest identities only: no
 * store choice, mob choice, balance preference, or private custody crosses it.
 */
export function buildOrdinaryCombatSupplyPublicSourceCatalog(
  authoredStores = getAllStores(),
  combatNpcs = getCombatNPCs(),
): string[] {
  return [
    ...new Set([
      ...authoredStores.flatMap((store) =>
        store.items.map((item) => item.itemId),
      ),
      ...combatNpcs.flatMap((npc) => [
        ...(npc.drops.defaultDrop.enabled
          ? [npc.drops.defaultDrop.itemId]
          : []),
        ...[
          ...npc.drops.always,
          ...npc.drops.common,
          ...npc.drops.uncommon,
          ...npc.drops.rare,
          ...npc.drops.veryRare,
        ]
          .filter((drop) => drop.chance === 1)
          .map((drop) => drop.itemId),
      ]),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

function buildCombatSupplyPrecursorItems(
  targetItemId: string,
  targetQuantity: number,
  recipes: OrdinaryCombatSupplyRecipe[],
  inventoryCounts: ReadonlyMap<string, number>,
  bankCounts: ReadonlyMap<string, number>,
  freeSlots: number,
  gatheringSources: OrdinaryCombatSupplyGatheringSource[],
  publicSourceItemIds: string[],
  getSkillLevel: (skill: string) => number,
): {
  actionCount: number;
  items: AgentBankTransferItem[];
  retainedItems: AgentBankRetainedItem[];
} {
  const remainingInventory = new Map(inventoryCounts);
  const remainingBank = new Map(bankCounts);
  const requested = new Map<string, number>();
  const retainedInventory = new Map<string, number>();
  const selectedGatheringTools = new Set<string>();
  const publicSourceItems = new Set(publicSourceItemIds);
  const recipesByOutput = new Map<string, OrdinaryCombatSupplyRecipe[]>();
  for (const recipe of recipes) {
    const candidates = recipesByOutput.get(recipe.outputItemId) ?? [];
    candidates.push(recipe);
    recipesByOutput.set(recipe.outputItemId, candidates);
  }
  const gatheringByOutput = new Map<
    string,
    OrdinaryCombatSupplyGatheringSource[]
  >();
  for (const source of gatheringSources) {
    for (const itemId of source.outputItemIds) {
      const candidates = gatheringByOutput.get(itemId) ?? [];
      candidates.push(source);
      gatheringByOutput.set(itemId, candidates);
    }
  }

  const getEligibleGatheringSources = (
    itemId: string,
  ): OrdinaryCombatSupplyGatheringSource[] =>
    (gatheringByOutput.get(itemId) ?? [])
      .filter(
        (source) => getSkillLevel(source.harvestSkill) >= source.levelRequired,
      )
      .sort(
        (left, right) =>
          left.levelRequired - right.levelRequired ||
          left.resourceId.localeCompare(right.resourceId),
      );

  const consume = (
    counts: Map<string, number>,
    itemId: string,
    quantity: number,
  ) => {
    const available = counts.get(itemId) ?? 0;
    const consumed = Math.min(available, quantity);
    if (consumed > 0) counts.set(itemId, available - consumed);
    return consumed;
  };
  const consumeInventory = (itemId: string, quantity: number): number => {
    const consumed = consume(remainingInventory, itemId, quantity);
    if (consumed > 0) {
      retainedInventory.set(
        itemId,
        (retainedInventory.get(itemId) ?? 0) + consumed,
      );
    }
    return consumed;
  };
  const isCompatibleGatheringTool = (
    source: OrdinaryCombatSupplyGatheringSource,
    itemId: string,
  ): boolean =>
    source.harvestSkill === "fishing"
      ? itemId === source.toolRequired
      : getItem(itemId)?.tool?.skill === source.harvestSkill;
  const collectGatheringTool = (
    itemId: string,
    path: ReadonlySet<string>,
  ): void => {
    const sources = getEligibleGatheringSources(itemId);
    if (
      sources.length === 0 ||
      sources.some((source) => !source.toolRequired) ||
      sources.some((source) =>
        [...selectedGatheringTools].some((toolId) =>
          isCompatibleGatheringTool(source, toolId),
        ),
      )
    ) {
      return;
    }

    const ownedToolIds = new Set([
      ...[...remainingInventory]
        .filter(([, quantity]) => quantity > 0)
        .map(([ownedItemId]) => ownedItemId),
      ...[...remainingBank]
        .filter(([, quantity]) => quantity > 0)
        .map(([ownedItemId]) => ownedItemId),
    ]);
    const candidate = sources
      .flatMap((source) =>
        [...ownedToolIds]
          .filter((toolId) => isCompatibleGatheringTool(source, toolId))
          .map((toolId) => ({
            toolId,
            carried: (remainingInventory.get(toolId) ?? 0) > 0,
            priority: Number(getItem(toolId)?.tool?.priority),
            resourceId: source.resourceId,
          })),
      )
      .sort(
        (left, right) =>
          Number(right.carried) - Number(left.carried) ||
          (Number.isFinite(left.priority)
            ? left.priority
            : Number.MAX_SAFE_INTEGER) -
            (Number.isFinite(right.priority)
              ? right.priority
              : Number.MAX_SAFE_INTEGER) ||
          left.toolId.localeCompare(right.toolId) ||
          left.resourceId.localeCompare(right.resourceId),
      )[0];
    if (!candidate) return;
    selectedGatheringTools.add(candidate.toolId);
    collect(candidate.toolId, 1, path);
  };

  const getAvailableQuantity = (itemId: string): number =>
    (remainingInventory.get(itemId) ?? 0) + (remainingBank.get(itemId) ?? 0);

  function getResolvableRecipeInputs(
    recipe: OrdinaryCombatSupplyRecipe,
    path: ReadonlySet<string>,
  ): Array<{ itemId: string; quantity: number }> | null {
    const alternatives = orderOrdinarySupplyAlternatives(
      recipe.inputAlternatives,
      getAvailableQuantity,
    );
    for (const alternative of alternatives) {
      if (
        alternative.every((input) =>
          isResolvable(input.itemId, input.quantity, path),
        ) &&
        recipe.tools.every((toolId) => isResolvable(toolId, 1, path))
      ) {
        return alternative;
      }
    }
    return null;
  }

  function isResolvable(
    itemId: string,
    quantity: number,
    path: ReadonlySet<string>,
  ): boolean {
    if (getAvailableQuantity(itemId) >= quantity) return true;
    if (path.has(itemId)) return false;
    const nextPath = new Set(path).add(itemId);
    const outputRecipes = recipesByOutput.get(itemId) ?? [];
    const legalRecipes = outputRecipes.filter((recipe) => {
      const skill = getProcessingActivitySkill(recipe.activity);
      return skill !== null && recipe.levelRequired <= getSkillLevel(skill);
    });
    if (
      legalRecipes.some(
        (recipe) => getResolvableRecipeInputs(recipe, nextPath) !== null,
      )
    ) {
      return true;
    }

    const lockedRecipe = outputRecipes[0];
    if (lockedRecipe) {
      const lockedSkill = getProcessingActivitySkill(lockedRecipe.activity);
      if (
        lockedSkill !== null &&
        recipes.some(
          (recipe) =>
            getProcessingActivitySkill(recipe.activity) === lockedSkill &&
            recipe.outputItemId !== itemId &&
            recipe.levelRequired <= getSkillLevel(lockedSkill) &&
            getResolvableRecipeInputs(recipe, nextPath) !== null,
        )
      ) {
        return true;
      }
    }

    return (
      getEligibleGatheringSources(itemId).length > 0 ||
      publicSourceItems.has(itemId)
    );
  }

  const collect = (
    itemId: string,
    quantity: number,
    path: ReadonlySet<string>,
  ): void => {
    let missing = Math.max(0, quantity);
    missing -= consumeInventory(itemId, missing);
    if (missing <= 0) return;

    const banked = consume(remainingBank, itemId, missing);
    if (banked > 0) {
      requested.set(itemId, (requested.get(itemId) ?? 0) + banked);
      missing -= banked;
    }
    if (missing <= 0 || path.has(itemId)) return;

    const outputRecipes = recipesByOutput.get(itemId) ?? [];
    const legalRecipe = outputRecipes.find((candidate) => {
      const skill = getProcessingActivitySkill(candidate.activity);
      return skill !== null && candidate.levelRequired <= getSkillLevel(skill);
    });
    // The worker attempts level-legal output recipes before using the first
    // authored output recipe as the exact skill-lock identity.
    const recipe = legalRecipe ?? outputRecipes[0];
    if (!recipe || recipe.outputQuantity <= 0) {
      collectGatheringTool(itemId, path);
      return;
    }
    const recipeSkill = getProcessingActivitySkill(recipe.activity);
    if (
      !legalRecipe &&
      recipeSkill !== null &&
      recipe.levelRequired > getSkillLevel(recipeSkill)
    ) {
      const nextPath = new Set(path).add(itemId);
      const trainingRecipe = recipes.find(
        (candidate) =>
          getProcessingActivitySkill(candidate.activity) === recipeSkill &&
          candidate.outputItemId !== itemId &&
          candidate.levelRequired <= getSkillLevel(recipeSkill) &&
          getResolvableRecipeInputs(candidate, nextPath) !== null,
      );
      if (trainingRecipe) {
        // A banked training output cannot award the XP needed to unlock the
        // target. Stage exactly one action of its source-complete inputs/tools.
        const inputs = getResolvableRecipeInputs(trainingRecipe, nextPath);
        for (const input of inputs ?? []) {
          collect(input.itemId, input.quantity, nextPath);
        }
        for (const toolId of trainingRecipe.tools) {
          collect(toolId, 1, nextPath);
        }
      } else {
        collectGatheringTool(itemId, path);
      }
      return;
    }
    const actionCount = Math.ceil(missing / recipe.outputQuantity);
    const nextPath = new Set(path).add(itemId);
    const alternatives = recipe.inputAlternatives.map((alternative) =>
      alternative.map((input) => ({
        itemId: input.itemId,
        quantity: input.quantity * actionCount,
      })),
    );
    const inputs =
      orderOrdinarySupplyAlternatives(
        alternatives,
        (candidateItemId) =>
          (remainingInventory.get(candidateItemId) ?? 0) +
          (remainingBank.get(candidateItemId) ?? 0),
      )[0] ?? [];
    for (const input of inputs) {
      collect(input.itemId, input.quantity, nextPath);
    }
    for (const toolId of recipe.tools) collect(toolId, 1, nextPath);
  };

  const rootRecipe = recipesByOutput.get(targetItemId)?.[0];
  const targetDeficit = Math.max(
    0,
    targetQuantity - (inventoryCounts.get(targetItemId) ?? 0),
  );
  const actionCount = rootRecipe
    ? Math.ceil(targetDeficit / rootRecipe.outputQuantity)
    : 0;
  collect(targetItemId, targetQuantity, new Set());

  let remainingSlots = freeSlots;
  const items: AgentBankTransferItem[] = [];
  for (const [itemId, desiredQuantity] of [...requested].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const definition = getItem(itemId);
    if (!definition || desiredQuantity <= 0) continue;
    if (definition.stackable) {
      const needsSlot = (inventoryCounts.get(itemId) ?? 0) === 0;
      if (needsSlot && remainingSlots <= 0) continue;
      if (needsSlot) remainingSlots -= 1;
      items.push({ itemId, quantity: desiredQuantity });
      continue;
    }
    const quantity = Math.min(desiredQuantity, remainingSlots);
    if (quantity <= 0) continue;
    items.push({ itemId, quantity });
    remainingSlots -= quantity;
  }
  const retainedItems = [...retainedInventory]
    .map(([itemId, quantity]) => ({ itemId, quantity }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  return { actionCount, items, retainedItems };
}

function getCookingRecipe(itemId: string): {
  cookedItemId: string;
  levelRequired: number;
} | null {
  const authored = ProcessingDataProvider.getInstance().getCookingData(itemId);
  if (authored) {
    return {
      cookedItemId: authored.cookedItemId,
      levelRequired: authored.levelRequired,
    };
  }
  const fallback = getItem(itemId)?.cooking;
  return fallback
    ? {
        cookedItemId: fallback.cookedItemId,
        levelRequired: fallback.levelRequired,
      }
    : null;
}

/**
 * Choose one complete, immediately executable processing batch from private
 * bank contents. Recipe eligibility comes from the loaded item/recipe
 * manifests; the model never sees or supplies bank item identities or counts.
 *
 * Every selected recipe is the largest complete capacity-safe batch up to
 * five actions. Single-item transfers retain the narrow receipt shape;
 * multi-item plans use one atomic composite withdrawal.
 */
export function buildOrdinaryBankStagePlan(
  instance: Pick<AgentInstance, "service" | "goal" | "config">,
  bankItems: AgentBankItemView[],
  combatReadinessCatalog = buildOrdinaryCombatReadinessCatalog(),
  combatSupplyRecipes = buildOrdinaryCombatSupplyRecipeCatalog(),
  combatSupplyGatheringSources = buildOrdinaryCombatSupplyGatheringCatalog(),
  combatSupplyPublicSourceItemIds = buildOrdinaryCombatSupplyPublicSourceCatalog(),
): OrdinaryBankStagePlan | null {
  const gameState = instance.service.getGameState();
  if (!gameState || gameState.inCombat) return null;

  const readSkillLevel = (skill: string): number => {
    const level = Number(gameState.skills[skill]?.level ?? 1);
    return Number.isSafeInteger(level) && level >= 1 && level <= 99 ? level : 0;
  };
  const cookingLevel = readSkillLevel("cooking");
  const smithingLevel = readSkillLevel("smithing");
  const craftingLevel = readSkillLevel("crafting");
  const fletchingLevel = readSkillLevel("fletching");
  const firemakingLevel = readSkillLevel("firemaking");
  const runecraftingLevel = readSkillLevel("runecrafting");
  const privateCoinBalance = (
    instance.service as typeof instance.service & {
      getPrivateCoinBalance?: () => number | null;
    }
  ).getPrivateCoinBalance?.();
  const coinBalance =
    typeof privateCoinBalance === "number" &&
    Number.isSafeInteger(privateCoinBalance) &&
    privateCoinBalance >= 0
      ? privateCoinBalance
      : null;
  const inventoryCounts = new Map<string, number>();
  const occupiedSlots = new Set<number>();
  for (const entry of gameState.inventory) {
    const quantity = getSafeQuantity(entry.quantity);
    if (quantity <= 0) continue;
    inventoryCounts.set(
      entry.itemId,
      (inventoryCounts.get(entry.itemId) ?? 0) + quantity,
    );
    if (
      Number.isSafeInteger(entry.slot) &&
      entry.slot >= 0 &&
      entry.slot < INVENTORY_CONSTANTS.MAX_INVENTORY_SLOTS
    ) {
      occupiedSlots.add(entry.slot);
    }
  }

  // Do not stage another batch while an authored cookable batch is already
  // carried. This prevents a bank-adjacent loop from filling the inventory.
  const carriedCookableQuantity = [...inventoryCounts].reduce(
    (total, [itemId, quantity]) => {
      const cooking = getCookingRecipe(itemId);
      return cooking && cooking.levelRequired <= cookingLevel
        ? total + quantity
        : total;
    },
    0,
  );
  const hasCarriedCookingBatch =
    carriedCookableQuantity >= ORDINARY_PROCESSING_BATCH_SIZE;

  const bankCounts = new Map<string, number>();
  for (const entry of bankItems) {
    const quantity = getSafeQuantity(entry.quantity);
    if (quantity <= 0) continue;
    bankCounts.set(
      entry.itemId,
      (bankCounts.get(entry.itemId) ?? 0) + quantity,
    );
  }

  const questState = instance.service.getQuestState();
  const activeQuestTargets = new Set(
    questState
      .filter((quest) => quest.status === "in_progress")
      .map((quest) => quest.stageTarget)
      .filter((target): target is string => Boolean(target)),
  );
  const serviceView = instance.service as typeof instance.service & {
    getAvailableQuests?: () => ReturnType<
      typeof instance.service.getAvailableQuests
    >;
    getWorld?: () => {
      getSystem?: (name: string) => unknown;
    };
  };
  const hasActiveQuest = questState.some(
    (quest) =>
      quest.status === "in_progress" || quest.status === "ready_to_complete",
  );
  const trainingTarget = hasActiveQuest
    ? null
    : findOrdinaryQuestEntrySkillTarget({
        availableQuests: serviceView.getAvailableQuests?.() ?? [],
        skills: gameState.skills,
        resourceSystemAvailable: Boolean(
          serviceView.getWorld?.()?.getSystem?.("resource"),
        ),
      });
  const requestedTrainingQuestId =
    instance.goal?.type === "banking" ? instance.goal.questId : undefined;
  if (
    requestedTrainingQuestId &&
    trainingTarget?.questId !== requestedTrainingQuestId
  ) {
    return null;
  }
  const freeSlots =
    INVENTORY_CONSTANTS.MAX_INVENTORY_SLOTS - occupiedSlots.size;

  // A combat-supply request carries only a purpose bit. Rebuild the exact
  // public readiness catalog and specialization on the private main thread,
  // then move only the currently missing selected item or an exact authored
  // precursor in its deterministic supply graph. A compromised worker cannot
  // name or enumerate arbitrary bank custody through this boundary.
  if (
    instance.goal?.type === "banking" &&
    instance.goal.bankPurpose === "combat_supply"
  ) {
    const readiness = selectOrdinaryCombatReadiness(
      combatReadinessCatalog,
      resolveOrdinaryCombatSpecialization(instance.config),
      (skill) => readSkillLevel(skill),
    );
    if (!readiness) return null;
    const equippedQuantity = (itemId: string): number =>
      Object.values(gameState.equipment)
        .filter((entry) => entry.itemId === itemId)
        .reduce((total, entry) => {
          const quantity = getSafeQuantity(entry.quantity ?? 1);
          return total + (quantity > 0 ? quantity : 1);
        }, 0);
    const need = getOrdinaryCombatSupplyNeed(
      combatReadinessCatalog,
      readiness,
      (itemId) => (inventoryCounts.get(itemId) ?? 0) + equippedQuantity(itemId),
    );
    if (!need) return null;
    const definition = getItem(need.itemId);
    const privateQuantity = bankCounts.get(need.itemId) ?? 0;
    const carriedQuantity = inventoryCounts.get(need.itemId) ?? 0;
    const deficit = Math.max(
      0,
      need.targetQuantity - carriedQuantity - equippedQuantity(need.itemId),
    );
    if (definition && privateQuantity > 0 && deficit > 0) {
      const capacity = definition.stackable
        ? carriedQuantity > 0
          ? privateQuantity
          : freeSlots > 0
            ? privateQuantity
            : 0
        : freeSlots;
      const quantity = Math.min(deficit, privateQuantity, capacity);
      if (quantity > 0) {
        return { activity: "combat_supply", itemId: need.itemId, quantity };
      }
    }

    const precursorPlan = buildCombatSupplyPrecursorItems(
      need.itemId,
      Math.max(0, need.targetQuantity - equippedQuantity(need.itemId)),
      combatSupplyRecipes,
      inventoryCounts,
      bankCounts,
      freeSlots,
      combatSupplyGatheringSources,
      combatSupplyPublicSourceItemIds,
      readSkillLevel,
    );
    return precursorPlan.items.length > 0 && precursorPlan.actionCount > 0
      ? {
          activity: "combat_supply_precursors",
          targetItemId: need.itemId,
          actionCount: precursorPlan.actionCount,
          items: precursorPlan.items,
        }
      : null;
  }

  // A survival-food request is intentionally narrower than general material
  // staging. The worker supplies only this purpose bit; exact private bank
  // contents and quantities remain on the main thread. Prefer the strongest
  // authored ready-to-eat item and withdraw at most one full health bar.
  if (
    instance.goal?.type === "banking" &&
    instance.goal.bankPurpose === "survival_food"
  ) {
    const maxHealth = Number(gameState.maxHealth);
    if (!Number.isFinite(maxHealth) || maxHealth <= 0) return null;

    const candidate = [...bankCounts]
      .map(([itemId, bankQuantity]) => {
        const definition = getItem(itemId);
        const healAmount = Number(definition?.healAmount ?? 0);
        return definition &&
          Number.isFinite(healAmount) &&
          healAmount > 0 &&
          bankQuantity > 0
          ? { itemId, bankQuantity, definition, healAmount }
          : null;
      })
      .filter(
        (
          entry,
        ): entry is {
          itemId: string;
          bankQuantity: number;
          definition: NonNullable<ReturnType<typeof getItem>>;
          healAmount: number;
        } => entry !== null,
      )
      .sort(
        (left, right) =>
          right.healAmount - left.healAmount ||
          left.itemId.localeCompare(right.itemId),
      )[0];
    if (!candidate) {
      if (freeSlots <= 0) return null;

      // An empty cooked-food reserve must not strand an agent whose authored
      // non-combat supply tool is already in private custody. Select only a
      // banked tool that can gather a level-eligible, cookable resource. The
      // worker still learns nothing about unselected bank contents; after the
      // withdrawal it observes the tool through normal carried state and
      // performs the gathering/cooking loop itself.
      const supplyTool = [...getExternalResources().values()]
        .flatMap((resource) => {
          const harvestSkill = String(resource.harvestSkill ?? "");
          const toolRequired = resource.toolRequired;
          if (
            !harvestSkill ||
            !toolRequired ||
            resource.levelRequired > readSkillLevel(harvestSkill)
          ) {
            return [];
          }
          const cookableYields = resource.harvestYield
            .map((drop) => {
              const cooking = getCookingRecipe(drop.itemId);
              const cookedHealAmount = Number(
                cooking ? (getItem(cooking.cookedItemId)?.healAmount ?? 0) : 0,
              );
              return cooking &&
                cooking.levelRequired <= cookingLevel &&
                Number.isFinite(cookedHealAmount) &&
                cookedHealAmount > 0
                ? {
                    rawItemId: drop.itemId,
                    cookingLevelRequired: cooking.levelRequired,
                    cookedHealAmount,
                  }
                : null;
            })
            .filter(
              (entry): entry is NonNullable<typeof entry> => entry !== null,
            );
          if (cookableYields.length === 0) return [];

          return [...bankCounts]
            .filter(([itemId, quantity]) => {
              if (quantity <= 0 || (inventoryCounts.get(itemId) ?? 0) > 0) {
                return false;
              }
              return harvestSkill === "fishing"
                ? itemId === toolRequired
                : getItem(itemId)?.tool?.skill === harvestSkill;
            })
            .flatMap(([itemId]) =>
              cookableYields.map((yieldData) => ({
                itemId,
                resourceId: resource.id,
                resourceLevelRequired: resource.levelRequired,
                ...yieldData,
              })),
            );
        })
        .sort(
          (left, right) =>
            left.resourceLevelRequired - right.resourceLevelRequired ||
            left.cookingLevelRequired - right.cookingLevelRequired ||
            right.cookedHealAmount - left.cookedHealAmount ||
            left.rawItemId.localeCompare(right.rawItemId) ||
            left.resourceId.localeCompare(right.resourceId) ||
            left.itemId.localeCompare(right.itemId),
        )[0];
      return supplyTool
        ? {
            activity: "survival_supply_tool",
            itemId: supplyTool.itemId,
            quantity: 1,
          }
        : null;
    }

    const carriedHealing = [...inventoryCounts].reduce(
      (total, [itemId, quantity]) => {
        const healAmount = Number(getItem(itemId)?.healAmount ?? 0);
        return Number.isFinite(healAmount) && healAmount > 0
          ? total + healAmount * quantity
          : total;
      },
      0,
    );
    const desiredQuantity = Math.ceil(
      Math.max(0, maxHealth - carriedHealing) / candidate.healAmount,
    );
    const capacity = candidate.definition.stackable
      ? (inventoryCounts.get(candidate.itemId) ?? 0) > 0
        ? candidate.bankQuantity
        : freeSlots > 0
          ? candidate.bankQuantity
          : 0
      : freeSlots;
    const quantity = Math.min(
      desiredQuantity,
      candidate.bankQuantity,
      capacity,
    );
    return quantity > 0
      ? { activity: "survival_food", itemId: candidate.itemId, quantity }
      : null;
  }

  if (
    cookingLevel === 0 &&
    smithingLevel === 0 &&
    craftingLevel === 0 &&
    fletchingLevel === 0 &&
    firemakingLevel === 0 &&
    runecraftingLevel === 0
  ) {
    return null;
  }

  const buildMissingItems = (
    requirements: AgentBankTransferItem[],
  ): AgentBankTransferItem[] => {
    const totals = new Map<string, number>();
    for (const requirement of requirements) {
      totals.set(
        requirement.itemId,
        (totals.get(requirement.itemId) ?? 0) + requirement.quantity,
      );
    }
    return [...totals]
      .map(([itemId, requiredQuantity]) => ({
        itemId,
        quantity: Math.max(
          0,
          requiredQuantity - (inventoryCounts.get(itemId) ?? 0),
        ),
      }))
      .filter((entry) => entry.quantity > 0)
      .sort((left, right) => left.itemId.localeCompare(right.itemId));
  };
  const hasCompleteRequirements = (
    requirements: AgentBankTransferItem[],
  ): boolean =>
    requirements.every(
      (requirement) =>
        (inventoryCounts.get(requirement.itemId) ?? 0) >= requirement.quantity,
    );
  const planFits = (items: AgentBankTransferItem[]): boolean => {
    let requiredSlots = 0;
    for (const item of items) {
      if ((bankCounts.get(item.itemId) ?? 0) < item.quantity) return false;
      const definition = getItem(item.itemId);
      if (!definition) return false;
      if (definition.stackable) {
        if ((inventoryCounts.get(item.itemId) ?? 0) === 0) requiredSlots += 1;
      } else {
        requiredSlots += item.quantity;
      }
      if (requiredSlots > freeSlots) return false;
    }
    return items.length > 0;
  };
  const selectLargestCompositeBatch = (
    requirementsForActionCount: (
      actionCount: number,
    ) => AgentBankTransferItem[],
    maximumActionCount = ORDINARY_PROCESSING_BATCH_SIZE,
  ): { actionCount: number; items: AgentBankTransferItem[] } | null => {
    for (
      let actionCount = maximumActionCount;
      actionCount >= 1;
      actionCount -= 1
    ) {
      const items = buildMissingItems(requirementsForActionCount(actionCount));
      if (planFits(items)) return { actionCount, items };
    }
    return null;
  };

  const cookingCandidates = hasCarriedCookingBatch
    ? []
    : [...bankCounts].map(([itemId, bankQuantity]) => {
        const cooking = getCookingRecipe(itemId);
        const carriedQuantity = inventoryCounts.get(itemId) ?? 0;
        const neededQuantity = Math.max(
          0,
          ORDINARY_PROCESSING_BATCH_SIZE - carriedQuantity,
        );
        return {
          plan: {
            activity: "cooking" as const,
            itemId,
            quantity: neededQuantity,
          },
          stableId: itemId,
          levelRequired: cooking?.levelRequired ?? Number.MAX_SAFE_INTEGER,
          questPriority:
            cooking && activeQuestTargets.has(cooking.cookedItemId) ? 1 : 0,
          eligible:
            Boolean(cooking) &&
            cookingLevel > 0 &&
            cooking!.levelRequired <= cookingLevel &&
            neededQuantity > 0 &&
            bankQuantity >= neededQuantity &&
            planFits([{ itemId, quantity: neededQuantity }]),
        };
      });

  const processingData = ProcessingDataProvider.getInstance();
  const hasCarriedSmeltingBatch = [...processingData.getSmeltableBarIds()].some(
    (barItemId) => {
      const recipe = processingData.getSmeltingData(barItemId);
      if (
        !recipe ||
        smithingLevel === 0 ||
        recipe.levelRequired > smithingLevel
      ) {
        return false;
      }
      const inputs = recipe.inputs ?? [
        { itemId: recipe.primaryOre, quantity: 1 },
        ...(recipe.secondaryOre
          ? [{ itemId: recipe.secondaryOre, quantity: 1 }]
          : []),
        ...(recipe.coalRequired > 0
          ? [{ itemId: "coal", quantity: recipe.coalRequired }]
          : []),
      ];
      return inputs.every(
        (input) =>
          (inventoryCounts.get(input.itemId) ?? 0) >=
          input.quantity * ORDINARY_PROCESSING_BATCH_SIZE,
      );
    },
  );
  const smithingRecipes = processingData.getAllSmithingRecipes();
  const smithingRequirements = (
    recipe: (typeof smithingRecipes)[number],
    actionCount: number,
  ): AgentBankTransferItem[] => [
    {
      itemId: recipe.barType,
      quantity: recipe.barsRequired * actionCount,
    },
    { itemId: SMITHING_CONSTANTS.HAMMER_ITEM_ID, quantity: 1 },
  ];
  const hasCarriedSmithingBatch = smithingRecipes.some(
    (recipe) =>
      smithingLevel > 0 &&
      recipe.levelRequired <= smithingLevel &&
      hasCompleteRequirements(
        smithingRequirements(recipe, ORDINARY_PROCESSING_BATCH_SIZE),
      ),
  );
  const craftingRecipes = processingData.getAllCraftingRecipes();
  const getGuaranteedConsumableUnits = (
    itemId: string,
    usesPerItem: number,
    actionCount: number,
  ): number => {
    const carriedUnits = inventoryCounts.get(itemId) ?? 0;
    // A persisted partial-use head always has at least one use. Every later
    // carried unit is fresh. This lower bound never guesses private remaining
    // uses and may conservatively stage at most one additional unit.
    const guaranteedCarriedUses =
      carriedUnits > 0 ? 1 + (carriedUnits - 1) * usesPerItem : 0;
    const additionalUnits = Math.ceil(
      Math.max(0, actionCount - guaranteedCarriedUses) / usesPerItem,
    );
    return carriedUnits + additionalUnits;
  };
  const craftingRequirements = (
    recipe: (typeof craftingRecipes)[number],
    actionCount: number,
  ) => [
    ...recipe.inputs.map((input) => ({
      itemId: input.item,
      quantity: input.amount * actionCount,
    })),
    ...recipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
    ...recipe.consumables.map((consumable) => ({
      itemId: consumable.item,
      quantity: getGuaranteedConsumableUnits(
        consumable.item,
        consumable.uses,
        actionCount,
      ),
    })),
  ];
  const fletchingRecipes = processingData.getAllFletchingRecipes();
  const fletchingRequirements = (recipe: (typeof fletchingRecipes)[number]) => [
    ...recipe.inputs.map((input) => ({
      itemId: input.item,
      quantity: input.amount * ORDINARY_PROCESSING_BATCH_SIZE,
    })),
    ...recipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
  ];
  const hasCarriedCraftingBatch = craftingRecipes.some(
    (recipe) =>
      craftingLevel > 0 &&
      recipe.level <= craftingLevel &&
      hasCompleteRequirements(
        craftingRequirements(recipe, ORDINARY_PROCESSING_BATCH_SIZE),
      ),
  );
  const hasCarriedFletchingBatch = fletchingRecipes.some(
    (recipe) =>
      fletchingLevel > 0 &&
      recipe.level <= fletchingLevel &&
      hasCompleteRequirements(fletchingRequirements(recipe)),
  );
  const firemakingRecipes = [...processingData.getBurnableLogIds()]
    .map((logItemId) => ({
      logItemId,
      levelRequired:
        processingData.getFiremakingData(logItemId)?.levelRequired ?? 0,
    }))
    .filter((recipe) => recipe.levelRequired > 0);
  const firemakingRequirements = (
    logItemId: string,
    actionCount: number,
  ): AgentBankTransferItem[] => [
    { itemId: logItemId, quantity: actionCount },
    { itemId: "tinderbox", quantity: 1 },
  ];
  const hasCarriedFiremakingBatch = firemakingRecipes.some(
    (recipe) =>
      recipe.levelRequired <= firemakingLevel &&
      hasCompleteRequirements(
        firemakingRequirements(
          recipe.logItemId,
          ORDINARY_PROCESSING_BATCH_SIZE,
        ),
      ),
  );
  const runecraftingRecipes = processingData.getAllRunecraftingRecipes();
  const hasCarriedRunecraftingBatch = runecraftingRecipes.some(
    (recipe) =>
      recipe.levelRequired <= runecraftingLevel &&
      recipe.essenceTypes.reduce(
        (total, itemId) => total + (inventoryCounts.get(itemId) ?? 0),
        0,
      ) >= ORDINARY_PROCESSING_BATCH_SIZE,
  );
  const tanningRecipes = processingData.getAllTanningRecipes();
  const hasCarriedTanningBatch =
    coinBalance !== null &&
    tanningRecipes.some(
      (recipe) =>
        (inventoryCounts.get(recipe.input) ?? 0) >=
          ORDINARY_PROCESSING_BATCH_SIZE &&
        coinBalance >= recipe.cost * ORDINARY_PROCESSING_BATCH_SIZE,
    );
  if (
    hasCarriedCookingBatch ||
    hasCarriedSmeltingBatch ||
    hasCarriedSmithingBatch ||
    hasCarriedCraftingBatch ||
    hasCarriedFletchingBatch ||
    hasCarriedFiremakingBatch ||
    hasCarriedRunecraftingBatch ||
    hasCarriedTanningBatch
  ) {
    return null;
  }
  const smithingCandidates = hasCarriedSmithingBatch
    ? []
    : smithingRecipes.map((recipe) => {
        const batch = selectLargestCompositeBatch((actionCount) =>
          smithingRequirements(recipe, actionCount),
        );
        const items = batch?.items ?? [];
        const neededQuantity =
          items.find((item) => item.itemId === recipe.barType)?.quantity ?? 0;
        return {
          plan: {
            activity: "smithing" as const,
            recipeId: recipe.itemId,
            itemId: recipe.barType,
            quantity: neededQuantity,
            actionCount: batch?.actionCount ?? 0,
            items,
          },
          stableId: recipe.itemId,
          levelRequired: recipe.levelRequired,
          questPriority: activeQuestTargets.has(recipe.itemId) ? 1 : 0,
          eligible:
            smithingLevel > 0 &&
            recipe.levelRequired <= smithingLevel &&
            batch !== null,
        };
      });

  const smeltingCandidates = [...processingData.getSmeltableBarIds()].map(
    (barItemId) => {
      const recipe = processingData.getSmeltingData(barItemId);
      const batch = recipe
        ? selectLargestCompositeBatch((actionCount) =>
            (recipe.inputs ?? []).map((input) => ({
              itemId: input.itemId,
              quantity: input.quantity * actionCount,
            })),
          )
        : null;
      return {
        plan: {
          activity: "smelting" as const,
          recipeId: barItemId,
          actionCount: batch?.actionCount ?? 0,
          items: batch?.items ?? [],
        },
        stableId: barItemId,
        levelRequired: recipe?.levelRequired ?? Number.MAX_SAFE_INTEGER,
        questPriority: activeQuestTargets.has(barItemId) ? 1 : 0,
        eligible:
          Boolean(recipe) &&
          smithingLevel > 0 &&
          recipe!.levelRequired <= smithingLevel &&
          batch !== null,
      };
    },
  );
  const craftingCandidates = craftingRecipes.map((recipe) => {
    const batch = selectLargestCompositeBatch((actionCount) =>
      craftingRequirements(recipe, actionCount),
    );
    return {
      plan: {
        activity: "crafting" as const,
        recipeId: recipe.output,
        actionCount: batch?.actionCount ?? 0,
        items: batch?.items ?? [],
      },
      stableId: recipe.output,
      levelRequired: recipe.level,
      questPriority: activeQuestTargets.has(recipe.output) ? 1 : 0,
      eligible: recipe.level <= craftingLevel && batch !== null,
    };
  });
  const fletchingCandidates = fletchingRecipes.map((recipe) => {
    const batch = selectLargestCompositeBatch((actionCount) => [
      ...recipe.inputs.map((input) => ({
        itemId: input.item,
        quantity: input.amount * actionCount,
      })),
      ...recipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
    ]);
    return {
      plan: {
        activity: "fletching" as const,
        recipeId: recipe.recipeId,
        actionCount: batch?.actionCount ?? 0,
        items: batch?.items ?? [],
      },
      stableId: recipe.recipeId,
      levelRequired: recipe.level,
      questPriority: activeQuestTargets.has(recipe.output) ? 1 : 0,
      eligible: recipe.level <= fletchingLevel && batch !== null,
    };
  });
  const firemakingCandidates = firemakingRecipes.map((recipe) => {
    const batch = selectLargestCompositeBatch((actionCount) =>
      firemakingRequirements(recipe.logItemId, actionCount),
    );
    return {
      plan: {
        activity: "firemaking" as const,
        recipeId: recipe.logItemId,
        actionCount: batch?.actionCount ?? 0,
        items: batch?.items ?? [],
      },
      stableId: recipe.logItemId,
      levelRequired: recipe.levelRequired,
      questPriority: activeQuestTargets.has("fire") ? 1 : 0,
      eligible:
        recipe.levelRequired <= firemakingLevel &&
        batch !== null &&
        // The fire action cannot execute without the authored gameplay tool.
        ((inventoryCounts.get("tinderbox") ?? 0) > 0 ||
          (bankCounts.get("tinderbox") ?? 0) > 0),
    };
  });
  const runecraftingCandidates = runecraftingRecipes.map((recipe) => {
    const carriedEssence = recipe.essenceTypes.reduce(
      (total, itemId) => total + (inventoryCounts.get(itemId) ?? 0),
      0,
    );
    let remaining = Math.max(
      0,
      ORDINARY_PROCESSING_BATCH_SIZE - carriedEssence,
    );
    const items: AgentBankTransferItem[] = [];
    for (const itemId of [...recipe.essenceTypes].sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (remaining <= 0) break;
      const quantity = Math.min(bankCounts.get(itemId) ?? 0, remaining);
      if (quantity <= 0) continue;
      items.push({ itemId, quantity });
      remaining -= quantity;
    }
    return {
      plan: {
        activity: "runecrafting" as const,
        recipeId: recipe.runeType,
        actionCount: 1,
        items,
      },
      stableId: recipe.runeType,
      levelRequired: recipe.levelRequired,
      questPriority: activeQuestTargets.has(recipe.runeItemId) ? 1 : 0,
      eligible:
        recipe.levelRequired <= runecraftingLevel &&
        remaining === 0 &&
        planFits(items),
    };
  });
  const tanningCandidates = tanningRecipes.map((recipe) => {
    const affordableActions =
      coinBalance === null
        ? 0
        : recipe.cost === 0
          ? ORDINARY_PROCESSING_BATCH_SIZE
          : Math.min(
              ORDINARY_PROCESSING_BATCH_SIZE,
              Math.floor(coinBalance / recipe.cost),
            );
    const boundedBatch =
      affordableActions > 0
        ? selectLargestCompositeBatch(
            (actionCount) => [{ itemId: recipe.input, quantity: actionCount }],
            affordableActions,
          )
        : null;
    return {
      plan: {
        activity: "tanning" as const,
        recipeId: recipe.output,
        actionCount: boundedBatch?.actionCount ?? 0,
        items: boundedBatch?.items ?? [],
      },
      stableId: recipe.output,
      levelRequired: 1,
      questPriority: activeQuestTargets.has(recipe.output) ? 1 : 0,
      eligible: boundedBatch !== null,
    };
  });

  const eligibleCandidates = [
    ...cookingCandidates,
    ...smithingCandidates,
    ...smeltingCandidates,
    ...craftingCandidates,
    ...fletchingCandidates,
    ...firemakingCandidates,
    ...runecraftingCandidates,
    ...tanningCandidates,
  ].filter((candidate) => candidate.eligible);
  const candidates = (
    trainingTarget
      ? eligibleCandidates.filter(
          (candidate) =>
            getProcessingActivitySkill(candidate.plan.activity) ===
            trainingTarget.skill,
        )
      : eligibleCandidates
  ).sort(
    (left, right) =>
      right.questPriority - left.questPriority ||
      right.levelRequired - left.levelRequired ||
      left.plan.activity.localeCompare(right.plan.activity) ||
      left.stableId.localeCompare(right.stableId),
  );
  const selected = candidates[0];
  if (selected) return selected.plan;

  // A bank miss should mean the bank truly has no useful piece of the exact
  // entry-training baseline. For the live skill-only target, stage any private
  // subset of one five-action minimum-level recipe before authorizing public
  // acquisition. A tanned Crafting input may be substituted by its authored
  // precursor, but no bank identity or quantity leaves this process.
  if (!trainingTarget) return null;
  const trainingRecipe =
    trainingTarget.skill === "crafting"
      ? craftingRecipes
          .filter((recipe) => recipe.level <= craftingLevel)
          .sort(
            (a, b) => a.level - b.level || a.output.localeCompare(b.output),
          )[0]
      : null;
  const trainingFletchingRecipe =
    trainingTarget.skill === "fletching"
      ? fletchingRecipes
          .filter((recipe) => recipe.level <= fletchingLevel)
          .sort(
            (a, b) => a.level - b.level || a.recipeId.localeCompare(b.recipeId),
          )[0]
      : null;
  if (!trainingRecipe && !trainingFletchingRecipe) return null;

  const requirements = trainingRecipe
    ? craftingRequirements(trainingRecipe, ORDINARY_PROCESSING_BATCH_SIZE)
    : [
        ...trainingFletchingRecipe!.inputs.map((input) => ({
          itemId: input.item,
          quantity: input.amount * ORDINARY_PROCESSING_BATCH_SIZE,
        })),
        ...trainingFletchingRecipe!.tools.map((itemId) => ({
          itemId,
          quantity: 1,
        })),
      ];
  const requirementTotals = new Map<string, number>();
  for (const requirement of requirements) {
    requirementTotals.set(
      requirement.itemId,
      (requirementTotals.get(requirement.itemId) ?? 0) + requirement.quantity,
    );
  }
  const requested = new Map<string, number>();
  for (const [itemId, requiredQuantity] of [...requirementTotals].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const missingQuantity = Math.max(
      0,
      requiredQuantity - (inventoryCounts.get(itemId) ?? 0),
    );
    if (missingQuantity <= 0) continue;
    const exactQuantity = Math.min(
      missingQuantity,
      bankCounts.get(itemId) ?? 0,
    );
    if (exactQuantity > 0) requested.set(itemId, exactQuantity);

    const tanning = trainingRecipe
      ? tanningRecipes.find((recipe) => recipe.output === itemId)
      : undefined;
    const precursorQuantity = tanning
      ? Math.min(
          missingQuantity - exactQuantity,
          bankCounts.get(tanning.input) ?? 0,
        )
      : 0;
    if (tanning && precursorQuantity > 0) {
      requested.set(
        tanning.input,
        (requested.get(tanning.input) ?? 0) + precursorQuantity,
      );
    }
  }

  let remainingSlots = freeSlots;
  const partialItems: AgentBankTransferItem[] = [];
  for (const [itemId, desiredQuantity] of [...requested].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const definition = getItem(itemId);
    if (!definition || desiredQuantity <= 0) continue;
    if (definition.stackable) {
      const needsSlot = (inventoryCounts.get(itemId) ?? 0) === 0;
      if (needsSlot && remainingSlots <= 0) continue;
      if (needsSlot) remainingSlots -= 1;
      partialItems.push({ itemId, quantity: desiredQuantity });
      continue;
    }
    const quantity = Math.min(desiredQuantity, remainingSlots);
    if (quantity <= 0) continue;
    partialItems.push({ itemId, quantity });
    remainingSlots -= quantity;
  }
  if (partialItems.length === 0) return null;

  return trainingRecipe
    ? {
        activity: "crafting",
        recipeId: trainingRecipe.output,
        actionCount: ORDINARY_PROCESSING_BATCH_SIZE,
        items: partialItems,
        entryTrainingRecovery: true,
        questId: trainingTarget.questId,
      }
    : {
        activity: "fletching",
        recipeId: trainingFletchingRecipe!.recipeId,
        actionCount: ORDINARY_PROCESSING_BATCH_SIZE,
        items: partialItems,
        entryTrainingRecovery: true,
        questId: trainingTarget.questId,
      };
}

function addRetention(
  retained: Map<string, number>,
  owned: Map<string, number>,
  itemId: string,
  requestedQuantity: number,
): void {
  const ownedQuantity = owned.get(itemId) ?? 0;
  if (ownedQuantity <= 0 || requestedQuantity <= 0) return;
  retained.set(
    itemId,
    Math.min(
      ownedQuantity,
      Math.max(retained.get(itemId) ?? 0, requestedQuantity),
    ),
  );
}

/**
 * Build the private ordinary-carry policy entirely from authoritative item,
 * quest, health, equipment, and inventory state. It deliberately contains no
 * market/economic tuning: keep operational tools, exact active quest inputs,
 * one full-health-bar of the best carried food, combat consumables usable by
 * the current style, and only the carried quantities consumed by an active
 * exact combat-supply recipe lineage.
 */
export function buildOrdinaryBankRetentionManifest(
  instance: Pick<AgentInstance, "service"> &
    Partial<
      Pick<AgentInstance, "config" | "goal" | "ordinaryProcessingAcquisition">
    >,
  options: OrdinaryBankRetentionPolicyOptions = {},
): AgentBankRetainedItem[] {
  const gameState = instance.service.getGameState();
  if (!gameState) return [];

  const owned = new Map<string, number>();
  for (const entry of gameState.inventory) {
    const quantity = Number(entry.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
    owned.set(entry.itemId, (owned.get(entry.itemId) ?? 0) + quantity);
  }
  const retained = new Map<string, number>();

  // Keep the manifest's best owned tool for each gathering capability. General
  // tools without a gathering category remain distinct executable capabilities.
  const bestGatheringTools = new Map<
    string,
    { itemId: string; priority: number }
  >();
  for (const [itemId] of owned) {
    const item = getItem(itemId);
    if (item?.type !== "tool") continue;
    if (!item.tool) {
      addRetention(retained, owned, itemId, 1);
      continue;
    }
    const priority = Number.isFinite(item.tool.priority)
      ? item.tool.priority
      : Number.MAX_SAFE_INTEGER;
    const current = bestGatheringTools.get(item.tool.skill);
    if (
      !current ||
      priority < current.priority ||
      (priority === current.priority &&
        itemId.localeCompare(current.itemId) < 0)
    ) {
      bestGatheringTools.set(item.tool.skill, { itemId, priority });
    }
  }
  for (const tool of bestGatheringTools.values()) {
    addRetention(retained, owned, tool.itemId, 1);
  }

  // Active quest counts are authored requirements, not inferred balance knobs.
  // Preserve every item-bearing artifact in the active definition, not only
  // the current stage target. Multi-stage production quests legitimately carry
  // an earlier gather output into a later processing stage (for example ore
  // gathered before the next ore type, then consumed together at a furnace).
  // Treating that earlier output as generic surplus can make capacity recovery
  // destroy the only immediately executable quest path. Definitions remain
  // private/main-process authority; the worker still supplies no item IDs.
  const questRequirements = new Map<string, number>();
  const activeQuests = instance.service
    .getQuestState()
    .filter((quest) => quest.status === "in_progress");
  const activeQuestIds = new Set(activeQuests.map((quest) => quest.questId));
  const availableQuests = (
    instance.service as typeof instance.service & {
      getAvailableQuests?: () => Array<{
        questId: string;
        requirements?: { items?: string[] };
        onStartItems?: Array<{ itemId: string; quantity: number }>;
        stages?: Array<{ target?: string; count?: number }>;
      }>;
    }
  ).getAvailableQuests?.();
  const addQuestRequirement = (itemId: unknown, rawQuantity: unknown): void => {
    if (typeof itemId !== "string" || !getItem(itemId)) return;
    const quantity = getSafeQuantity(rawQuantity);
    if (quantity <= 0) return;
    questRequirements.set(
      itemId,
      (questRequirements.get(itemId) ?? 0) + quantity,
    );
  };

  for (const definition of availableQuests ?? []) {
    if (!activeQuestIds.has(definition.questId)) continue;
    for (const itemId of definition.requirements?.items ?? []) {
      addQuestRequirement(itemId, 1);
    }
    for (const item of definition.onStartItems ?? []) {
      addQuestRequirement(item.itemId, item.quantity);
    }
    for (const stage of definition.stages ?? []) {
      addQuestRequirement(stage.target, stage.count ?? 1);
    }
  }

  // Retain the exact live stage as a fail-closed fallback if its definition is
  // temporarily unavailable during hydration. A missing definition can reduce
  // useful capacity but must never discard currently named quest custody.
  for (const quest of activeQuests) {
    if (quest.status !== "in_progress" || !quest.stageTarget) continue;
    const quantity =
      Number.isSafeInteger(quest.stageCount) && (quest.stageCount ?? 0) > 0
        ? quest.stageCount!
        : 1;
    if (!questRequirements.has(quest.stageTarget)) {
      addQuestRequirement(quest.stageTarget, quantity);
    }
  }
  for (const [itemId, quantity] of questRequirements) {
    addRetention(retained, owned, itemId, quantity);
  }

  // Retain enough of the strongest carried foods to restore one complete
  // health bar. Quest-retained food counts toward the same survival reserve.
  const food = [...owned.entries()]
    .map(([itemId, quantity]) => ({
      itemId,
      quantity,
      healAmount: Number(getItem(itemId)?.healAmount ?? 0),
    }))
    .filter(
      (entry) => Number.isFinite(entry.healAmount) && entry.healAmount > 0,
    )
    .sort(
      (left, right) =>
        right.healAmount - left.healAmount ||
        left.itemId.localeCompare(right.itemId),
    );
  const rawMaxHealth = Number(gameState.maxHealth);
  const healingTarget =
    Number.isFinite(rawMaxHealth) && rawMaxHealth > 0
      ? Math.floor(rawMaxHealth)
      : 0;
  let retainedHealing = food.reduce(
    (total, entry) =>
      total + (retained.get(entry.itemId) ?? 0) * entry.healAmount,
    0,
  );
  for (const entry of food) {
    if (retainedHealing >= healingTarget) break;
    const alreadyRetained = retained.get(entry.itemId) ?? 0;
    const available = Math.max(0, entry.quantity - alreadyRetained);
    const needed = Math.ceil(
      (healingTarget - retainedHealing) / entry.healAmount,
    );
    const additional = Math.min(available, needed);
    if (additional <= 0) continue;
    addRetention(retained, owned, entry.itemId, alreadyRetained + additional);
    retainedHealing += additional * entry.healAmount;
  }

  const specialization = instance.config
    ? resolveOrdinaryCombatSpecialization(instance.config)
    : null;
  if (specialization && specialization !== "melee") {
    const styleScore = (itemId: string, style: "melee" | "ranged" | "mage") => {
      const bonuses = getItem(itemId)?.bonuses;
      if (style === "ranged") return Number(bonuses?.attackRanged ?? 0);
      if (style === "mage") return Number(bonuses?.attackMagic ?? 0);
      return Number(bonuses?.attack ?? 0) + Number(bonuses?.strength ?? 0);
    };
    const meetsRequirements = (itemId: string): boolean => {
      const requirements = getItem(itemId)?.requirements?.skills;
      if (!requirements) return true;
      return Object.entries(requirements).every(([skill, required]) => {
        const normalizedSkill = skill === "defence" ? "defense" : skill;
        const requiredLevel = Number(required);
        return (
          Number.isSafeInteger(requiredLevel) &&
          requiredLevel > 0 &&
          Number(gameState.skills?.[normalizedSkill]?.level ?? 1) >=
            requiredLevel
        );
      });
    };
    for (const style of [specialization, "melee"] as const) {
      const weapon = [...owned]
        .filter(([itemId]) => {
          const item = getItem(itemId);
          const attackStyle = String(item?.attackType ?? "")
            .trim()
            .toLowerCase();
          return (
            item?.type === "weapon" &&
            (item.equipSlot === "weapon" || item.equipSlot === "2h") &&
            (attackStyle === style ||
              (style === "mage" && attackStyle === "magic")) &&
            meetsRequirements(itemId)
          );
        })
        .map(([itemId]) => ({ itemId, score: styleScore(itemId, style) }))
        .sort(
          (left, right) =>
            right.score - left.score || left.itemId.localeCompare(right.itemId),
        )[0];
      if (weapon) addRetention(retained, owned, weapon.itemId, 1);
    }
  }

  const weaponId = gameState.equipment.weapon?.itemId ?? null;
  const equippedAttackType = String(getItem(weaponId ?? "")?.attackType ?? "")
    .trim()
    .toLowerCase();
  const attackType =
    specialization === "mage" || specialization === "ranged"
      ? specialization === "mage"
        ? "magic"
        : "ranged"
      : equippedAttackType;
  if (attackType === "magic") {
    for (const [itemId, quantity] of owned) {
      if (itemId.endsWith("_rune")) {
        addRetention(retained, owned, itemId, quantity);
      }
    }
  } else if (attackType === "ranged") {
    for (const [itemId, quantity] of owned) {
      if (getItem(itemId)?.type === "ammunition") {
        addRetention(retained, owned, itemId, quantity);
      }
    }
  }

  const now = options.now ?? Date.now();
  const hasActiveCombatSupplyCustody =
    (instance.goal?.type === "banking" &&
      instance.goal.bankPurpose === "combat_supply") ||
    (Boolean(instance.ordinaryProcessingAcquisition) &&
      instance.ordinaryProcessingAcquisition!.expiresAt > now);
  if (hasActiveCombatSupplyCustody && instance.config) {
    const catalog =
      options.combatReadinessCatalog ?? buildOrdinaryCombatReadinessCatalog();
    const recipes =
      options.combatSupplyRecipes ?? buildOrdinaryCombatSupplyRecipeCatalog();
    const gatheringSources =
      options.combatSupplyGatheringSources ??
      buildOrdinaryCombatSupplyGatheringCatalog();
    const publicSourceItemIds =
      options.combatSupplyPublicSourceItemIds ??
      buildOrdinaryCombatSupplyPublicSourceCatalog();
    const readSkillLevel = (skill: string) => {
      const level = Number(gameState.skills?.[skill]?.level ?? 1);
      return Number.isSafeInteger(level) && level >= 1 && level <= 99
        ? level
        : 0;
    };
    const readiness = selectOrdinaryCombatReadiness(
      catalog,
      resolveOrdinaryCombatSpecialization(instance.config),
      readSkillLevel,
    );
    const equippedQuantity = (itemId: string): number =>
      Object.values(gameState.equipment)
        .filter((entry) => entry.itemId === itemId)
        .reduce((total, entry) => {
          const quantity = getSafeQuantity(entry.quantity ?? 1);
          return total + (quantity > 0 ? quantity : 1);
        }, 0);
    const need = readiness
      ? getOrdinaryCombatSupplyNeed(
          catalog,
          readiness,
          (itemId) => (owned.get(itemId) ?? 0) + equippedQuantity(itemId),
        )
      : null;
    if (need) {
      const precursorPlan = buildCombatSupplyPrecursorItems(
        need.itemId,
        Math.max(0, need.targetQuantity - equippedQuantity(need.itemId)),
        recipes,
        owned,
        new Map(),
        0,
        gatheringSources,
        publicSourceItemIds,
        readSkillLevel,
      );
      for (const item of precursorPlan.retainedItems) {
        addRetention(retained, owned, item.itemId, item.quantity);
      }
    }
  }

  return [...retained]
    .map(([itemId, quantity]) => ({ itemId, quantity }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
}

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

/**
 * Execute one logical ordinary bank action until its durable receipt and live
 * inventory agree. An unresolved COMMIT or post-commit reload never releases
 * the agent into another action or private duel preparation; process shutdown
 * leaves the immutable autonomy head open for startup reconciliation.
 */
export async function executeOrdinaryBankDepositSurplus(
  instance: AgentInstance,
  bankId: string,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<OrdinaryBankExecutionResult> {
  const operationId = getOrdinaryBankOperationId(attempt.attemptId);
  const retainedItems = buildOrdinaryBankRetentionManifest(instance);
  let reconciliationAttempts = 0;
  let delayMs = INITIAL_RECONCILIATION_DELAY_MS;
  let lastReceipt: AgentBankActionReceipt | null = null;

  while (instance.state === "running") {
    try {
      lastReceipt = await instance.service.executeBankDepositAll(
        operationId,
        retainedItems,
        bankId,
      );
    } catch {
      lastReceipt = null;
    }
    reconciliationAttempts += 1;

    if (lastReceipt?.success) {
      return {
        settled: true,
        applied: true,
        receipt: lastReceipt,
        operationId,
        retainedItems,
        reconciliationAttempts,
      };
    }
    if (
      lastReceipt &&
      lastReceipt.commitState !== "unknown" &&
      lastReceipt.commitState !== "committed"
    ) {
      return {
        settled: true,
        applied: false,
        receipt: lastReceipt,
        operationId,
        retainedItems,
        reconciliationAttempts,
      };
    }

    await wait(delayMs);
    delayMs = Math.min(delayMs * 2, MAX_RECONCILIATION_DELAY_MS);
  }

  return {
    settled: false,
    applied: false,
    receipt: lastReceipt,
    operationId,
    retainedItems,
    reconciliationAttempts,
  };
}

/**
 * Open the exact physical bank, privately derive one complete authored batch,
 * and reconcile a single idempotent withdrawal receipt before returning.
 */
export async function executeOrdinaryBankStageMaterials(
  instance: AgentInstance,
  bankId: string,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<OrdinaryBankStageExecutionResult> {
  const operationId = getOrdinaryBankStageOperationId(attempt.attemptId);
  let reconciliationAttempts = 0;
  let lastReceipt: AgentBankActionReceipt | null = null;

  const opened = await instance.service.executeBankOpen(bankId);
  if (!opened.success || !opened.bankItems) {
    return {
      settled: true,
      applied: false,
      receipt: opened,
      operationId,
      retainedItems: [],
      reconciliationAttempts,
      plan: null,
      reason: "bank_open_rejected",
    };
  }
  const plan = buildOrdinaryBankStagePlan(instance, opened.bankItems);
  if (!plan) {
    return {
      settled: true,
      applied: false,
      receipt: opened,
      operationId,
      retainedItems: [],
      reconciliationAttempts,
      plan: null,
      reason: "nothing_to_stage",
    };
  }

  let delayMs = INITIAL_RECONCILIATION_DELAY_MS;
  const transferItems: AgentBankTransferItem[] =
    "items" in plan
      ? plan.items
      : [{ itemId: plan.itemId, quantity: plan.quantity }];
  while (instance.state === "running") {
    try {
      lastReceipt =
        transferItems.length === 1
          ? await instance.service.executeBankWithdraw(
              transferItems[0].itemId,
              transferItems[0].quantity,
              operationId,
            )
          : await instance.service.executeBankWithdrawPlan(
              transferItems,
              operationId,
            );
    } catch {
      lastReceipt = null;
    }
    reconciliationAttempts += 1;

    if (lastReceipt?.success) {
      return {
        settled: true,
        applied: true,
        receipt: lastReceipt,
        operationId,
        retainedItems: [],
        reconciliationAttempts,
        plan,
        reason: "completed",
      };
    }
    if (
      lastReceipt &&
      lastReceipt.commitState !== "unknown" &&
      lastReceipt.commitState !== "committed"
    ) {
      return {
        settled: true,
        applied: false,
        receipt: lastReceipt,
        operationId,
        retainedItems: [],
        reconciliationAttempts,
        plan,
        reason: "withdraw_rejected",
      };
    }

    await wait(delayMs);
    delayMs = Math.min(delayMs * 2, MAX_RECONCILIATION_DELAY_MS);
  }

  return {
    settled: false,
    applied: false,
    receipt: lastReceipt,
    operationId,
    retainedItems: [],
    reconciliationAttempts,
    plan,
    reason: "shutdown_unsettled",
  };
}

/** Resolve a process-killed ordinary bank attempt from its immutable receipt. */
export async function resolveOrdinaryBankingRecovery(
  db: Database,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<AgentAutonomyActionResult | null> {
  if (
    attempt.actionType !== "bankDepositAll" &&
    attempt.actionType !== "bankWithdraw"
  ) {
    return null;
  }
  const isWithdrawal = attempt.actionType === "bankWithdraw";
  const operationId = isWithdrawal
    ? getOrdinaryBankStageOperationId(attempt.attemptId)
    : getOrdinaryBankOperationId(attempt.attemptId);
  const rows = await db
    .select({
      playerId: agentBankOperations.playerId,
      action: agentBankOperations.action,
      itemId: agentBankOperations.itemId,
      itemCount: agentBankOperations.itemCount,
      requestedQuantity: agentBankOperations.requestedQuantity,
      committedQuantity: agentBankOperations.committedQuantity,
    })
    .from(agentBankOperations)
    .where(eq(agentBankOperations.operationId, operationId))
    .limit(1);
  const receipt = rows[0];
  if (!receipt) return null;
  if (
    receipt.playerId !== attempt.characterId ||
    receipt.action !== (isWithdrawal ? "withdraw" : "deposit_all") ||
    receipt.requestedQuantity !== receipt.committedQuantity ||
    receipt.committedQuantity <= 0 ||
    (isWithdrawal
      ? !(
          (receipt.itemId !== null && receipt.itemCount === 1) ||
          (receipt.itemId === null && receipt.itemCount >= 2)
        )
      : receipt.itemId !== null || receipt.itemCount !== 0)
  ) {
    throw new Error("ordinary_bank_recovery_receipt_identity_mismatch");
  }
  return {
    attemptedActionType: attempt.actionType,
    appliedActionType: isWithdrawal ? "bankWithdraw" : "bankDepositAll",
    outcome: "completed",
  };
}
