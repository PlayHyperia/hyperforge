import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AttackType,
  SeededRandom,
  calculateDamage,
  calculateMagicDamage,
  calculateRangedDamage,
  type FoodConsumptionReceipt,
  type PrayerBonuses,
} from "@hyperforge/shared";

import type { EmbeddedGameState } from "../../eliza/types.js";
import { ORDINARY_COMBAT_AMMUNITION_TARGET } from "../../eliza/ordinaryCombatSpecialization.js";
import type { CompetitiveTacticalStrategy } from "../../systems/StreamingDuelScheduler/competitive-tactical-strategy.js";
import { DuelCombatAI } from "../DuelCombatAI.js";

const TICK_MS = 600;
const MAX_TICKS = 180;
const ARENA_MIN = -8;
const ARENA_MAX = 8;
const DEFAULT_SEED_COUNT = 256;

type FighterId = "fighter-a" | "fighter-b";
type Winner = FighterId | "draw";
type CombatRole = "melee" | "ranged" | "mage";
type PreparationCohortName =
  | "baseline"
  | "trained"
  | "equipped"
  | "ammunition_provisioned"
  | "food_provisioned"
  | "fully_prepared";
type PreparationDimension =
  "training" | "equipment" | "ammunition" | "food" | "combined";
type VariantName =
  | "deterministic_fallback"
  | "frozen_pressure"
  | "frozen_hold_range"
  | "frozen_kite"
  | "frozen_orbit"
  | "frozen_defensive_reset"
  | "frozen_finish";

type FighterWorldState = {
  id: FighterId;
  name: string;
  role: CombatRole;
  weaponId: string;
  position: [number, number, number];
  health: number;
  maxHealth: number;
  alive: boolean;
  inCombat: boolean;
  currentTarget: FighterId | null;
  activePrayers: string[];
  currentStyle: string;
  nextAttackTick: number;
  attacks: number;
  hits: number;
  damage: number;
  movementActions: number;
  engagementActions: number;
  movementDestination: [number, number, number] | null;
  movementStep: number;
  yieldAttackTick: number;
  rangedLevel: number;
  rangedAttackBonus: number;
  rangedStrengthBonus: number;
  ammunitionId: string | null;
  ammunitionRemaining: number | null;
  foodItemId: string | null;
  foodRemaining: number;
  foodHealAmount: number;
  foodConsumed: number;
};

type FighterPreparationProfile = {
  cohort: PreparationCohortName;
  dimension: PreparationDimension;
  rangedLevel: number;
  weaponId: string;
  weaponRangedRequirement: number;
  rangedAttackBonus: number;
  ammunitionId: string;
  ammunitionRangedRequirement: number;
  rangedStrengthBonus: number;
  ammunitionQuantity: number;
  foodItemId: string | null;
  foodQuantity: number;
  foodHealAmount: number;
};

type AuthoredManifestItem = {
  id?: unknown;
  type?: unknown;
  attackType?: unknown;
  bonuses?: {
    attackRanged?: unknown;
    rangedStrength?: unknown;
  };
  requirements?: {
    skills?: {
      ranged?: unknown;
    };
  };
  healAmount?: unknown;
};

export type TacticalAblationDuelResult = {
  seed: number;
  variant: VariantName;
  winner: Winner;
  ticks: number;
  fighterAHealth: number;
  fighterBHealth: number;
  fighterAAttacks: number;
  fighterBAttacks: number;
  fighterAHits: number;
  fighterBHits: number;
  fighterADamage: number;
  fighterBDamage: number;
  fighterAMovementActions: number;
  fighterBMovementActions: number;
  fighterAEngagementActions: number;
  fighterBEngagementActions: number;
  fighterARoleSwitches: number;
  fighterAPrayerToggleCommits: number;
  fighterAAmmoRemaining: number | null;
  fighterAFoodConsumed: number;
  illegalActionAttempts: number;
  traceHash: string;
};

type VariantSummary = {
  variant: VariantName;
  frozenMacro: CompetitiveTacticalStrategy["tacticalMacro"] | null;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  winRateWilson95: [number, number];
  meanScore: number;
  meanTicks: number;
  meanDamage: number;
  meanDamageReceived: number;
  meanMovementActions: number;
  illegalActionAttempts: number;
  cohortHash: string;
  behaviorHash: string;
};

type PairedComparison = {
  variant: VariantName;
  baseline: "deterministic_fallback";
  meanScoreDelta: number;
  improvedSeeds: number;
  regressedSeeds: number;
  tiedSeeds: number;
  twoSidedSignTestP: number;
};

type PreparationCohortSummary = {
  cohort: PreparationCohortName;
  dimension: PreparationDimension;
  rangedLevel: number;
  weaponId: string;
  weaponRangedRequirement: number;
  rangedAttackBonus: number;
  ammunitionId: string;
  ammunitionRangedRequirement: number;
  rangedStrengthBonus: number;
  ammunitionQuantity: number;
  foodItemId: string | null;
  foodQuantity: number;
  foodHealAmount: number;
  wins: number;
  losses: number;
  draws: number;
  meanScore: number;
  meanHealthMargin: number;
  meanDamage: number;
  meanFoodConsumed: number;
  meanAmmunitionRemaining: number;
  illegalActionAttempts: number;
  cohortHash: string;
};

type PreparationPairedComparison = {
  cohort: Exclude<PreparationCohortName, "baseline">;
  dimension: PreparationDimension;
  baseline: "baseline";
  meanScoreDelta: number;
  meanHealthMarginDelta: number;
  improvedSeeds: number;
  regressedSeeds: number;
  tiedSeeds: number;
  twoSidedSignTestP: number;
};

type SupplyChainCohortSummary = Omit<
  PreparationCohortSummary,
  "cohort" | "dimension"
> & {
  cohort: "one_batch_incomplete" | "minimum_complete_batches";
  dimension: "gathering_processing";
};

type AuthoredSupplyChainLineage = {
  targetItemId: "bronze_arrow";
  readinessTargetQuantity: number;
  outputQuantityPerBatch: number;
  incompleteBatchCount: 1;
  incompleteOutputQuantity: number;
  completeBatchCount: number;
  completeOutputQuantity: number;
  exactGatheringInputs: Array<{
    itemId: "copper_ore" | "tin_ore" | "logs";
    quantity: number;
    resourceId: string;
  }>;
  exactStoreLeafInputs: Array<{
    itemId: "feathers";
    quantity: number;
    storeId: string;
  }>;
  exactProcessingActions: Array<{
    activity: "smelting" | "smithing" | "fletching";
    stableId: string;
    actions: number;
    outputItemId: string;
    outputQuantity: number;
  }>;
};

type PrayerAblationSummary = {
  role: CombatRole;
  prayerId: "superhuman_strength" | "hawk_eye" | "mystic_lore";
  enabled: VariantSummary;
  disabled: VariantSummary;
  meanHealthMarginDelta: number;
  enabledImprovedSeeds: number;
  enabledRegressedSeeds: number;
  tiedSeeds: number;
  twoSidedSignTestP: number;
  meanEnabledPrayerCommits: number;
  disabledPrayerCommits: number;
};

export type CompetitiveTacticalAblationReport = {
  schemaVersion: 3;
  harness: {
    subject: "DuelCombatAI";
    seedCount: number;
    retainedExecutions: number;
    tickMs: number;
    maxTicks: number;
    arenaBounds: [number, number];
    fighterA: "ranged";
    fighterB: "melee";
    commonRandomNumbers: true;
    noModelRuntimeInCombat: true;
    boundedAuthorityAppliesEveryMovementTarget: true;
    technicalResultOnly: true;
    productAcceptanceThreshold: null;
    combatFixture: {
      outcomeRule: "kill_or_max_tick_health_advantage";
      fighterA: {
        formula: "calculateRangedDamage";
        health: 100;
        attackRange: 7;
        rangedLevel: 60;
        rangedAttackBonus: 20;
        rangedStrengthBonus: 25;
        targetDefenseLevel: 60;
        targetRangedDefenseBonus: 20;
        rapidAttackTicks: 3;
        ordinaryAttackTicks: 4;
      };
      fighterB: {
        formula: "calculateDamage";
        health: 100;
        attackRange: 2.2;
        attackLevel: 60;
        strengthLevel: 60;
        attackBonus: 40;
        strengthBonus: 40;
        targetDefenseLevel: 60;
        targetDefenseBonus: 20;
        attackTicks: 4;
        approachStep: 2.4;
      };
      mage: {
        formula: "calculateMagicDamage";
        health: 100;
        attackRange: 10;
        magicLevel: 60;
        magicAttackBonus: 20;
        spellBaseMaxHit: 8;
        targetMagicLevel: 60;
        targetDefenseLevel: 60;
        targetMagicDefenseBonus: 20;
        attackTicks: 5;
      };
    };
  };
  replayVerified: true;
  variants: VariantSummary[];
  pairedAgainstFallback: PairedComparison[];
  movementAblation: {
    macro: "deterministic_fallback";
    facingAblationIncluded: false;
    opponentMovementRetained: true;
    enabled: VariantSummary;
    disabled: VariantSummary;
    disabledMinusEnabledMeanScore: number;
    disabledImprovedSeeds: number;
    disabledRegressedSeeds: number;
    tiedSeeds: number;
    twoSidedSignTestP: number;
  };
  roleMatrix: {
    seedCountPerPairing: number;
    allPairingsReplayed: true;
    pairings: Array<{
      fighterA: CombatRole;
      fighterB: CombatRole;
      wins: number;
      losses: number;
      draws: number;
      meanScore: number;
      meanTicks: number;
      illegalActionAttempts: number;
      cohortHash: string;
    }>;
  };
  styleAblation: {
    initialRole: "melee";
    opponentRole: "melee";
    frozenAlternatives: readonly ["melee", "ranged", "mage"];
    fixed: VariantSummary;
    multiStyle: VariantSummary;
    meanSuccessfulSwitches: number;
    multiStyleMinusFixedMeanScore: number;
    multiStyleImprovedSeeds: number;
    multiStyleRegressedSeeds: number;
    tiedSeeds: number;
    twoSidedSignTestP: number;
    durableCustodyIncluded: false;
  };
  preparationAblation: {
    fighterA: "ranged";
    fighterB: "melee";
    authoredManifestInputs: true;
    authoredManifestSourceFiles: readonly [
      "world/assets/manifests/items/weapons.json",
      "world/assets/manifests/items/ammunition.json",
      "world/assets/manifests/items/food.json",
    ];
    authoredInputHash: string;
    requirementsValidated: true;
    allCohortsReplayed: true;
    commonRandomNumbers: true;
    technicalResultOnly: true;
    productAcceptanceThreshold: null;
    productionInventoryAuthorityIncluded: false;
    durableCustodyIncluded: false;
    profiles: PreparationCohortSummary[];
    pairedAgainstBaseline: PreparationPairedComparison[];
  };
  supplyChainAblation: {
    fighterA: "ranged";
    fighterB: "melee";
    authoredManifestInputs: true;
    authoredManifestSourceFiles: readonly [
      "world/assets/manifests/recipes/fletching.json",
      "world/assets/manifests/recipes/smelting.json",
      "world/assets/manifests/recipes/smithing.json",
      "world/assets/manifests/gathering/mining.json",
      "world/assets/manifests/gathering/woodcutting.json",
      "world/assets/manifests/stores.json",
    ];
    authoredInputHash: string;
    recipeGraphValidated: true;
    commonRandomNumbers: true;
    allCohortsReplayed: true;
    technicalResultOnly: true;
    productAcceptanceThreshold: null;
    acquisitionProvenanceChangesCombatStats: false;
    productionProcessingAuthorityIncluded: false;
    productionInventoryAuthorityIncluded: false;
    durableCustodyIncluded: false;
    lineage: AuthoredSupplyChainLineage;
    incomplete: SupplyChainCohortSummary;
    completed: SupplyChainCohortSummary;
    completedMinusIncompleteMeanScore: number;
    completedMinusIncompleteMeanHealthMargin: number;
    completedImprovedSeeds: number;
    completedRegressedSeeds: number;
    tiedSeeds: number;
    twoSidedSignTestP: number;
  };
  prayerAblation: {
    authoredManifestInput: true;
    authoredManifestSourceFile: "world/assets/manifests/prayers.json";
    authoredInputHash: string;
    productionModifierRetentionCovered: true;
    allCohortsReplayed: true;
    commonRandomNumbers: true;
    technicalResultOnly: true;
    productAcceptanceThreshold: null;
    productionPrayerCustodyIncluded: false;
    roles: PrayerAblationSummary[];
  };
  reportHash: string;
};

const VARIANTS: ReadonlyArray<{
  name: VariantName;
  macro: CompetitiveTacticalStrategy["tacticalMacro"] | null;
}> = [
  { name: "deterministic_fallback", macro: null },
  { name: "frozen_pressure", macro: "pressure" },
  { name: "frozen_hold_range", macro: "hold_range" },
  { name: "frozen_kite", macro: "kite" },
  { name: "frozen_orbit", macro: "orbit" },
  { name: "frozen_defensive_reset", macro: "defensive_reset" },
  { name: "frozen_finish", macro: "finish" },
];

const AUTHORED_MANIFEST_SOURCES = [
  {
    reportPath: "world/assets/manifests/items/weapons.json" as const,
    url: new URL(
      "../../../world/assets/manifests/items/weapons.json",
      import.meta.url,
    ),
  },
  {
    reportPath: "world/assets/manifests/items/ammunition.json" as const,
    url: new URL(
      "../../../world/assets/manifests/items/ammunition.json",
      import.meta.url,
    ),
  },
  {
    reportPath: "world/assets/manifests/items/food.json" as const,
    url: new URL(
      "../../../world/assets/manifests/items/food.json",
      import.meta.url,
    ),
  },
] as const;

const AUTHORED_SUPPLY_CHAIN_SOURCES = [
  {
    reportPath: "world/assets/manifests/recipes/fletching.json" as const,
    url: new URL(
      "../../../world/assets/manifests/recipes/fletching.json",
      import.meta.url,
    ),
  },
  {
    reportPath: "world/assets/manifests/recipes/smelting.json" as const,
    url: new URL(
      "../../../world/assets/manifests/recipes/smelting.json",
      import.meta.url,
    ),
  },
  {
    reportPath: "world/assets/manifests/recipes/smithing.json" as const,
    url: new URL(
      "../../../world/assets/manifests/recipes/smithing.json",
      import.meta.url,
    ),
  },
  {
    reportPath: "world/assets/manifests/gathering/mining.json" as const,
    url: new URL(
      "../../../world/assets/manifests/gathering/mining.json",
      import.meta.url,
    ),
  },
  {
    reportPath: "world/assets/manifests/gathering/woodcutting.json" as const,
    url: new URL(
      "../../../world/assets/manifests/gathering/woodcutting.json",
      import.meta.url,
    ),
  },
  {
    reportPath: "world/assets/manifests/stores.json" as const,
    url: new URL(
      "../../../world/assets/manifests/stores.json",
      import.meta.url,
    ),
  },
] as const;

const requireFiniteNumber = (value: unknown, description: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `authored ${description} must be a finite non-negative number`,
    );
  }
  return value;
};

const loadAuthoredPreparationProfiles = async (): Promise<{
  profiles: FighterPreparationProfile[];
  authoredInputHash: string;
}> => {
  const entries: AuthoredManifestItem[] = [];
  for (const source of AUTHORED_MANIFEST_SOURCES) {
    const parsed: unknown = JSON.parse(await readFile(source.url, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error(
        `authored item manifest is not an array: ${source.reportPath}`,
      );
    }
    entries.push(...(parsed as AuthoredManifestItem[]));
  }
  const items = new Map<string, AuthoredManifestItem>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    if (items.has(entry.id)) {
      throw new Error(
        `duplicate authored item id in preparation manifests: ${entry.id}`,
      );
    }
    items.set(entry.id, entry);
  }

  const requireItem = (itemId: string): AuthoredManifestItem => {
    const item = items.get(itemId);
    if (!item)
      throw new Error(`authored preparation item is missing: ${itemId}`);
    return item;
  };
  const makeProfile = (
    cohort: PreparationCohortName,
    dimension: PreparationDimension,
    rangedLevel: number,
    weaponId: string,
    ammunitionId: string,
    ammunitionQuantity: number,
    foodItemId: string | null,
    foodQuantity: number,
  ): FighterPreparationProfile => {
    const weapon = requireItem(weaponId);
    if (
      weapon.type !== "weapon" ||
      String(weapon.attackType).toUpperCase() !== "RANGED"
    ) {
      throw new Error(`authored preparation weapon is not ranged: ${weaponId}`);
    }
    const weaponRangedRequirement = requireFiniteNumber(
      weapon.requirements?.skills?.ranged ?? 0,
      `${weaponId} ranged requirement`,
    );
    const rangedAttackBonus = requireFiniteNumber(
      weapon.bonuses?.attackRanged,
      `${weaponId} ranged attack bonus`,
    );
    const ammunition = requireItem(ammunitionId);
    if (ammunition.type !== "ammunition") {
      throw new Error(
        `authored preparation ammunition has the wrong type: ${ammunitionId}`,
      );
    }
    const ammunitionRangedRequirement = requireFiniteNumber(
      ammunition.requirements?.skills?.ranged ?? 0,
      `${ammunitionId} ranged requirement`,
    );
    const rangedStrengthBonus = requireFiniteNumber(
      ammunition.bonuses?.rangedStrength,
      `${ammunitionId} ranged strength bonus`,
    );
    if (
      weaponRangedRequirement > rangedLevel ||
      ammunitionRangedRequirement > rangedLevel
    ) {
      throw new Error(
        `preparation profile ${cohort} does not meet authored ranged requirements`,
      );
    }
    if (!Number.isSafeInteger(ammunitionQuantity) || ammunitionQuantity < 1) {
      throw new Error(`preparation profile ${cohort} has invalid ammunition`);
    }
    if (!Number.isSafeInteger(foodQuantity) || foodQuantity < 0) {
      throw new Error(
        `preparation profile ${cohort} has invalid food quantity`,
      );
    }
    let foodHealAmount = 0;
    if (foodItemId) {
      const food = requireItem(foodItemId);
      if (food.type !== "consumable") {
        throw new Error(
          `authored preparation food is not consumable: ${foodItemId}`,
        );
      }
      foodHealAmount = requireFiniteNumber(
        food.healAmount,
        `${foodItemId} heal amount`,
      );
      if (foodHealAmount <= 0 || foodQuantity <= 0) {
        throw new Error(
          `preparation profile ${cohort} has unusable authored food`,
        );
      }
    } else if (foodQuantity !== 0) {
      throw new Error(
        `preparation profile ${cohort} has food quantity without an item`,
      );
    }
    return {
      cohort,
      dimension,
      rangedLevel,
      weaponId,
      weaponRangedRequirement,
      rangedAttackBonus,
      ammunitionId,
      ammunitionRangedRequirement,
      rangedStrengthBonus,
      ammunitionQuantity,
      foodItemId,
      foodQuantity,
      foodHealAmount,
    };
  };

  const profiles = [
    makeProfile(
      "baseline",
      "combined",
      30,
      "shortbow",
      "bronze_arrow",
      6,
      null,
      0,
    ),
    makeProfile(
      "trained",
      "training",
      60,
      "shortbow",
      "bronze_arrow",
      6,
      null,
      0,
    ),
    makeProfile(
      "equipped",
      "equipment",
      30,
      "maple_shortbow",
      "adamant_arrow",
      6,
      null,
      0,
    ),
    makeProfile(
      "ammunition_provisioned",
      "ammunition",
      30,
      "shortbow",
      "bronze_arrow",
      100,
      null,
      0,
    ),
    makeProfile(
      "food_provisioned",
      "food",
      30,
      "shortbow",
      "bronze_arrow",
      6,
      "lobster",
      4,
    ),
    makeProfile(
      "fully_prepared",
      "combined",
      60,
      "magic_shortbow",
      "rune_arrow",
      100,
      "lobster",
      4,
    ),
  ];
  const selectedItemIds = [
    ...new Set(
      profiles.flatMap((profile) => [
        profile.weaponId,
        profile.ammunitionId,
        ...(profile.foodItemId ? [profile.foodItemId] : []),
      ]),
    ),
  ].sort();
  return {
    profiles,
    authoredInputHash: sha256(
      selectedItemIds.map((itemId) => [itemId, requireItem(itemId)]),
    ),
  };
};

const loadAuthoredSupplyChainLineage = async (): Promise<{
  lineage: AuthoredSupplyChainLineage;
  authoredInputHash: string;
}> => {
  const parsed = await Promise.all(
    AUTHORED_SUPPLY_CHAIN_SOURCES.map(async (source) => ({
      source,
      value: JSON.parse(await readFile(source.url, "utf8")) as unknown,
    })),
  );
  const requireRecord = (
    value: unknown,
    description: string,
  ): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`authored ${description} must be an object`);
    }
    return value as Record<string, unknown>;
  };
  const requireArray = (value: unknown, description: string): unknown[] => {
    if (!Array.isArray(value)) {
      throw new Error(`authored ${description} must be an array`);
    }
    return value;
  };
  const requirePositiveInteger = (
    value: unknown,
    description: string,
  ): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      throw new Error(`authored ${description} must be a positive integer`);
    }
    return Number(value);
  };
  const sourceValue = (index: number): Record<string, unknown> =>
    requireRecord(
      parsed[index]?.value,
      AUTHORED_SUPPLY_CHAIN_SOURCES[index]?.reportPath ?? `source ${index}`,
    );
  const fletchingRecipes = requireArray(
    sourceValue(0).recipes,
    "Fletching recipes",
  ).map((entry) => requireRecord(entry, "Fletching recipe"));
  const smeltingRecipes = requireArray(
    sourceValue(1).recipes,
    "Smelting recipes",
  ).map((entry) => requireRecord(entry, "Smelting recipe"));
  const smithingRecipes = requireArray(
    sourceValue(2).recipes,
    "Smithing recipes",
  ).map((entry) => requireRecord(entry, "Smithing recipe"));
  const miningResources = requireArray(
    sourceValue(3).rocks,
    "Mining resources",
  ).map((entry) => requireRecord(entry, "Mining resource"));
  const woodcuttingResources = requireArray(
    sourceValue(4).trees,
    "Woodcutting resources",
  ).map((entry) => requireRecord(entry, "Woodcutting resource"));
  const stores = requireArray(parsed[5]?.value, "stores").map((entry) =>
    requireRecord(entry, "store"),
  );

  const requireRecipe = (
    recipes: Record<string, unknown>[],
    outputItemId: string,
    inputItemId?: string,
  ): Record<string, unknown> => {
    const candidates = recipes.filter((recipe) => {
      if (recipe.output !== outputItemId) return false;
      if (!inputItemId) return true;
      return requireArray(recipe.inputs, `${outputItemId} inputs`).some(
        (input) =>
          requireRecord(input, `${outputItemId} input`).item === inputItemId,
      );
    });
    if (candidates.length !== 1) {
      throw new Error(
        `expected one authored ${outputItemId}${inputItemId ? `/${inputItemId}` : ""} recipe, found ${candidates.length}`,
      );
    }
    return candidates[0];
  };
  const recipeInputs = (
    recipe: Record<string, unknown>,
    outputItemId: string,
  ): Array<{ itemId: string; quantity: number }> =>
    requireArray(recipe.inputs, `${outputItemId} inputs`).map((entry) => {
      const input = requireRecord(entry, `${outputItemId} input`);
      if (typeof input.item !== "string" || input.item.length === 0) {
        throw new Error(`authored ${outputItemId} input has an invalid item`);
      }
      return {
        itemId: input.item,
        quantity: requirePositiveInteger(
          input.amount,
          `${outputItemId}/${input.item} amount`,
        ),
      };
    });
  const requireInput = (
    inputs: Array<{ itemId: string; quantity: number }>,
    itemId: string,
    outputItemId: string,
  ): number => {
    const matches = inputs.filter((input) => input.itemId === itemId);
    if (matches.length !== 1) {
      throw new Error(
        `expected one authored ${itemId} input for ${outputItemId}`,
      );
    }
    return matches[0].quantity;
  };

  const arrowRecipe = requireRecipe(fletchingRecipes, "bronze_arrow");
  const headlessRecipe = requireRecipe(fletchingRecipes, "headless_arrow");
  const shaftRecipe = requireRecipe(fletchingRecipes, "arrow_shaft", "logs");
  const arrowtipRecipe = requireRecipe(smithingRecipes, "bronze_arrowtips");
  const barRecipe = requireRecipe(smeltingRecipes, "bronze_bar");
  const arrowOutput = requirePositiveInteger(
    arrowRecipe.outputQuantity,
    "bronze_arrow output quantity",
  );
  const headlessOutput = requirePositiveInteger(
    headlessRecipe.outputQuantity,
    "headless_arrow output quantity",
  );
  const shaftOutput = requirePositiveInteger(
    shaftRecipe.outputQuantity,
    "arrow_shaft output quantity",
  );
  const arrowtipOutput = requirePositiveInteger(
    arrowtipRecipe.outputQuantity,
    "bronze_arrowtips output quantity",
  );
  const arrowInputs = recipeInputs(arrowRecipe, "bronze_arrow");
  const headlessInputs = recipeInputs(headlessRecipe, "headless_arrow");
  const shaftInputs = recipeInputs(shaftRecipe, "arrow_shaft");
  const barInputs = recipeInputs(barRecipe, "bronze_bar");
  const arrowtipsPerBatch = requireInput(
    arrowInputs,
    "bronze_arrowtips",
    "bronze_arrow",
  );
  const headlessPerBatch = requireInput(
    arrowInputs,
    "headless_arrow",
    "bronze_arrow",
  );
  const shaftsPerHeadlessAction = requireInput(
    headlessInputs,
    "arrow_shaft",
    "headless_arrow",
  );
  const feathersPerHeadlessAction = requireInput(
    headlessInputs,
    "feathers",
    "headless_arrow",
  );
  const logsPerShaftAction = requireInput(shaftInputs, "logs", "arrow_shaft");
  if (arrowtipRecipe.bar !== "bronze_bar") {
    throw new Error("authored bronze_arrowtips recipe must consume bronze_bar");
  }
  const barsPerArrowtipAction = requirePositiveInteger(
    arrowtipRecipe.barsRequired,
    "bronze_arrowtips barsRequired",
  );
  const completeBatchCount = Math.ceil(
    ORDINARY_COMBAT_AMMUNITION_TARGET / arrowOutput,
  );
  const incompleteBatchCount = 1 as const;
  const arrowtipActions = Math.ceil(
    (completeBatchCount * arrowtipsPerBatch) / arrowtipOutput,
  );
  const headlessActions = Math.ceil(
    (completeBatchCount * headlessPerBatch) / headlessOutput,
  );
  const shaftActions = Math.ceil(
    (headlessActions * shaftsPerHeadlessAction) / shaftOutput,
  );
  const barActions = arrowtipActions * barsPerArrowtipAction;

  const requireGatheringSource = (
    itemId: "copper_ore" | "tin_ore" | "logs",
  ): { itemId: typeof itemId; resourceId: string } => {
    const candidates = [...miningResources, ...woodcuttingResources]
      .filter((resource) =>
        requireArray(
          resource.harvestYield,
          `${String(resource.id)} yield`,
        ).some((entry) => {
          const drop = requireRecord(entry, `${String(resource.id)} drop`);
          return (
            drop.itemId === itemId && drop.chance === 1 && drop.quantity === 1
          );
        }),
      )
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const selected = candidates[0];
    if (!selected || typeof selected.id !== "string") {
      throw new Error(
        `no probability-one authored gathering source for ${itemId}`,
      );
    }
    return { itemId, resourceId: selected.id };
  };
  const featherStores = stores
    .filter((store) =>
      requireArray(store.items, `${String(store.id)} items`).some(
        (entry) =>
          requireRecord(entry, `${String(store.id)} item`).itemId ===
          "feathers",
      ),
    )
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const featherStore = featherStores[0];
  if (!featherStore || typeof featherStore.id !== "string") {
    throw new Error("no authored store source for feathers");
  }
  const copperPerBar = requireInput(barInputs, "copper_ore", "bronze_bar");
  const tinPerBar = requireInput(barInputs, "tin_ore", "bronze_bar");
  const lineage: AuthoredSupplyChainLineage = {
    targetItemId: "bronze_arrow",
    readinessTargetQuantity: ORDINARY_COMBAT_AMMUNITION_TARGET,
    outputQuantityPerBatch: arrowOutput,
    incompleteBatchCount,
    incompleteOutputQuantity: incompleteBatchCount * arrowOutput,
    completeBatchCount,
    completeOutputQuantity: completeBatchCount * arrowOutput,
    exactGatheringInputs: [
      {
        ...requireGatheringSource("copper_ore"),
        quantity: barActions * copperPerBar,
      },
      {
        ...requireGatheringSource("tin_ore"),
        quantity: barActions * tinPerBar,
      },
      {
        ...requireGatheringSource("logs"),
        quantity: shaftActions * logsPerShaftAction,
      },
    ],
    exactStoreLeafInputs: [
      {
        itemId: "feathers",
        quantity: headlessActions * feathersPerHeadlessAction,
        storeId: featherStore.id,
      },
    ],
    exactProcessingActions: [
      {
        activity: "smelting",
        stableId: "bronze_bar",
        actions: barActions,
        outputItemId: "bronze_bar",
        outputQuantity: barActions,
      },
      {
        activity: "smithing",
        stableId: "bronze_arrowtips",
        actions: arrowtipActions,
        outputItemId: "bronze_arrowtips",
        outputQuantity: arrowtipActions * arrowtipOutput,
      },
      {
        activity: "fletching",
        stableId: "arrow_shaft:logs",
        actions: shaftActions,
        outputItemId: "arrow_shaft",
        outputQuantity: shaftActions * shaftOutput,
      },
      {
        activity: "fletching",
        stableId: "headless_arrow",
        actions: headlessActions,
        outputItemId: "headless_arrow",
        outputQuantity: headlessActions * headlessOutput,
      },
      {
        activity: "fletching",
        stableId: "bronze_arrow:bronze_arrowtips",
        actions: completeBatchCount,
        outputItemId: "bronze_arrow",
        outputQuantity: completeBatchCount * arrowOutput,
      },
    ],
  };
  if (
    lineage.incompleteOutputQuantity >= lineage.readinessTargetQuantity ||
    lineage.completeOutputQuantity < lineage.readinessTargetQuantity
  ) {
    throw new Error("authored supply-chain cohorts do not straddle readiness");
  }
  return {
    lineage,
    authoredInputHash: sha256({
      readinessTargetQuantity: ORDINARY_COMBAT_AMMUNITION_TARGET,
      arrowRecipe,
      headlessRecipe,
      shaftRecipe,
      arrowtipRecipe,
      barRecipe,
      gathering: lineage.exactGatheringInputs,
      featherStore,
    }),
  };
};

const PRAYER_MANIFEST_SOURCE = {
  reportPath: "world/assets/manifests/prayers.json" as const,
  url: new URL("../../../world/assets/manifests/prayers.json", import.meta.url),
};
const PRAYER_BONUS_KEYS = [
  "attackMultiplier",
  "strengthMultiplier",
  "defenseMultiplier",
  "rangedAttackMultiplier",
  "rangedStrengthMultiplier",
  "magicAttackMultiplier",
  "magicDefenseMultiplier",
] as const satisfies readonly (keyof PrayerBonuses)[];

const loadAuthoredPrayerBonuses = async (): Promise<{
  bonusesById: ReadonlyMap<string, PrayerBonuses>;
  authoredInputHash: string;
}> => {
  const parsed: unknown = JSON.parse(
    await readFile(PRAYER_MANIFEST_SOURCE.url, "utf8"),
  );
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { prayers?: unknown }).prayers)
  ) {
    throw new Error("authored prayer manifest has an invalid shape");
  }
  const definitions = (parsed as { prayers: unknown[] }).prayers;
  const bonusesById = new Map<string, PrayerBonuses>();
  for (const definition of definitions) {
    if (!definition || typeof definition !== "object") {
      throw new Error("authored prayer definition is not an object");
    }
    const record = definition as { id?: unknown; bonuses?: unknown };
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new Error("authored prayer definition has an invalid id");
    }
    if (
      !record.bonuses ||
      typeof record.bonuses !== "object" ||
      Array.isArray(record.bonuses)
    ) {
      throw new Error(`authored prayer bonuses are invalid: ${record.id}`);
    }
    if (bonusesById.has(record.id)) {
      throw new Error(`duplicate authored prayer id: ${record.id}`);
    }
    const bonuses: Partial<Record<keyof PrayerBonuses, number>> = {};
    for (const key of PRAYER_BONUS_KEYS) {
      const value = (record.bonuses as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > 10
      ) {
        throw new Error(
          `authored prayer multiplier is invalid: ${record.id}.${key}`,
        );
      }
      bonuses[key] = value;
    }
    bonusesById.set(record.id, bonuses);
  }
  for (const prayerId of ["superhuman_strength", "hawk_eye", "mystic_lore"]) {
    if (!bonusesById.has(prayerId)) {
      throw new Error(
        `required authored offensive prayer is missing: ${prayerId}`,
      );
    }
  }
  return {
    bonusesById,
    authoredInputHash: sha256(definitions),
  };
};

const combinePrayerBonuses = (
  fighter: FighterWorldState,
  bonusesById: ReadonlyMap<string, PrayerBonuses>,
): PrayerBonuses | undefined => {
  const combined: Partial<Record<keyof PrayerBonuses, number>> = {};
  let found = false;
  for (const prayerId of fighter.activePrayers) {
    const bonuses = bonusesById.get(prayerId);
    if (!bonuses) continue;
    for (const key of PRAYER_BONUS_KEYS) {
      const multiplier = bonuses[key];
      if (multiplier === undefined) continue;
      combined[key] = Math.max(combined[key] ?? 1, multiplier);
      found = true;
    }
  }
  return found ? combined : undefined;
};

const round = (value: number, places = 6): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const clamp = (value: number): number =>
  Math.max(ARENA_MIN + 0.25, Math.min(ARENA_MAX - 0.25, value));

const moveToward = (
  fighter: FighterWorldState,
  target: [number, number, number],
  maximumStep: number,
): void => {
  const dx = target[0] - fighter.position[0];
  const dz = target[2] - fighter.position[2];
  const distance = Math.hypot(dx, dz);
  const scale = distance > maximumStep ? maximumStep / distance : 1;
  fighter.position = [
    clamp(fighter.position[0] + dx * scale),
    0,
    clamp(fighter.position[2] + dz * scale),
  ];
};

const advanceMovementPath = (fighter: FighterWorldState): void => {
  const destination = fighter.movementDestination;
  if (!destination) return;
  moveToward(fighter, destination, fighter.movementStep);
  if (
    Math.hypot(
      destination[0] - fighter.position[0],
      destination[2] - fighter.position[2],
    ) <= 0.001
  ) {
    fighter.movementDestination = null;
    fighter.movementStep = 0;
  }
};

const distanceBetween = (
  left: FighterWorldState,
  right: FighterWorldState,
): number =>
  Math.hypot(
    right.position[0] - left.position[0],
    right.position[2] - left.position[2],
  );

/**
 * Stateless per-tick randomness keeps the exact hit/damage sample for a
 * fighter stable across tactical variants even when movement changes whether
 * that attack is legal. This is the common-random-numbers ablation boundary.
 */
const deterministicUnit = (
  seed: number,
  tick: number,
  fighter: FighterId,
  channel: number,
): number => {
  let value =
    (seed ^
      Math.imul(tick + 1, 0x9e3779b1) ^
      Math.imul(fighter === "fighter-a" ? 17 : 31, 0x85ebca6b) ^
      Math.imul(channel + 1, 0xc2b2ae35)) >>>
    0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
};

const buildStrategy = (
  macro: CompetitiveTacticalStrategy["tacticalMacro"],
  role: CombatRole,
): CompetitiveTacticalStrategy => ({
  approach:
    macro === "pressure" || macro === "finish"
      ? "aggressive"
      : macro === "defensive_reset"
        ? "defensive"
        : "balanced",
  tacticalMacro: macro,
  attackStyle: role === "ranged" ? "accurate" : "aggressive",
  prayer:
    role === "ranged"
      ? "hawk_eye"
      : role === "mage"
        ? "mystic_lore"
        : "superhuman_strength",
  preferredCombatRole: null,
  foodThreshold: 40,
  switchDefensiveAt: 30,
  reasoning: `Retained deterministic ${macro} ablation policy.`,
});

const createFighter = (
  id: FighterId,
  role: CombatRole,
  x: number,
  preparation?: FighterPreparationProfile,
): FighterWorldState => ({
  id,
  name: id === "fighter-a" ? "Ranged Agent" : "Melee Agent",
  role,
  weaponId:
    role === "ranged" && preparation
      ? preparation.weaponId
      : role === "ranged"
        ? "shortbow"
        : role === "mage"
          ? "staff_of_air"
          : "bronze_longsword",
  position: [x, 0, 0],
  health: 100,
  maxHealth: 100,
  alive: true,
  inCombat: false,
  currentTarget: null,
  activePrayers: [],
  currentStyle: "accurate",
  nextAttackTick: 1,
  attacks: 0,
  hits: 0,
  damage: 0,
  movementActions: 0,
  engagementActions: 0,
  movementDestination: null,
  movementStep: 0,
  yieldAttackTick: -1,
  rangedLevel: preparation?.rangedLevel ?? 60,
  rangedAttackBonus: preparation?.rangedAttackBonus ?? 20,
  rangedStrengthBonus: preparation?.rangedStrengthBonus ?? 25,
  ammunitionId:
    role === "ranged" ? (preparation?.ammunitionId ?? "bronze_arrow") : null,
  ammunitionRemaining:
    role === "ranged" && preparation ? preparation.ammunitionQuantity : null,
  foodItemId: preparation?.foodItemId ?? null,
  foodRemaining: preparation?.foodQuantity ?? 0,
  foodHealAmount: preparation?.foodHealAmount ?? 0,
  foodConsumed: 0,
});

const runDuel = async (
  seed: number,
  variant: (typeof VARIANTS)[number],
  fighterAMovementApplied = true,
  fighterARole: CombatRole = "ranged",
  fighterBRole: CombatRole = "melee",
  fixedOpponentStrategy = true,
  multiStyleA = false,
  fighterAPreparation?: FighterPreparationProfile,
  prayerBonusesById: ReadonlyMap<string, PrayerBonuses> = new Map(),
  fighterAPrayerEnabled = true,
): Promise<TacticalAblationDuelResult> => {
  if (fighterAPreparation && fighterARole !== "ranged") {
    throw new Error("fighter A preparation profiles require the ranged role");
  }
  const fighterA = createFighter(
    "fighter-a",
    fighterARole,
    -3,
    fighterAPreparation,
  );
  const fighterB = createFighter("fighter-b", fighterBRole, 3);
  let illegalActionAttempts = 0;
  let currentTick = 0;
  let now = 10_000;
  const trace: unknown[] = [];

  const buildGameState = (
    own: FighterWorldState,
    opponent: FighterWorldState,
  ): EmbeddedGameState => {
    const buildInventory = (): EmbeddedGameState["inventory"] => {
      const items = [
        ...(multiStyleA && own.id === "fighter-a"
          ? [
              { itemId: "bronze_longsword", quantity: 1 },
              { itemId: "shortbow", quantity: 1 },
              {
                itemId: "bronze_arrow",
                quantity: own.ammunitionRemaining ?? 100,
              },
              { itemId: "staff_of_air", quantity: 1 },
              { itemId: "mind_rune", quantity: 100 },
            ].filter(
              (item) =>
                item.itemId !== own.weaponId &&
                !(own.role === "ranged" && item.itemId === "bronze_arrow"),
            )
          : []),
        ...(own.foodItemId && own.foodRemaining > 0
          ? [{ itemId: own.foodItemId, quantity: own.foodRemaining }]
          : []),
      ];
      return items.map((item, slot) => ({ slot, ...item }));
    };
    const equipment: EmbeddedGameState["equipment"] = {
      weapon: { itemId: own.weaponId, quantity: 1 },
    };
    if (own.role === "ranged" && own.ammunitionId) {
      equipment.arrows = {
        itemId: own.ammunitionId,
        quantity: own.ammunitionRemaining ?? 100,
      };
    }
    return {
      playerId: own.id,
      position: [...own.position],
      health: own.health,
      maxHealth: own.maxHealth,
      alive: own.alive,
      skills: {
        ranged: { level: own.rangedLevel, xp: 0 },
      },
      inventory: buildInventory(),
      equipment,
      nearbyEntities: [
        {
          id: opponent.id,
          name: opponent.name,
          type: "player",
          position: [...opponent.position],
          distance: distanceBetween(own, opponent),
          health: opponent.health,
          maxHealth: opponent.maxHealth,
          equippedWeapon: opponent.weaponId,
        },
      ],
      inCombat: own.inCombat,
      currentTarget: own.currentTarget,
      activePrayers: [...own.activePrayers],
      prayerPointUnits: 100_000_000,
      prayerPoints: 100,
      prayerMaxPoints: 100,
    };
  };

  const createService = (
    own: FighterWorldState,
    opponent: FighterWorldState,
  ) => ({
    getGameState: (): EmbeddedGameState => buildGameState(own, opponent),
    getWeaponAttackRange: (): number =>
      own.role === "ranged" ? 7 : own.role === "mage" ? 10 : 2.2,
    getLiveEntityPosition: (entityId: string) =>
      entityId === opponent.id ? [...opponent.position] : null,
    executeUse: async (itemId: string): Promise<FoodConsumptionReceipt> => {
      if (
        itemId !== own.foodItemId ||
        own.foodRemaining <= 0 ||
        own.foodHealAmount <= 0 ||
        own.health >= own.maxHealth
      ) {
        illegalActionAttempts++;
        return {
          ok: false,
          committed: false,
          consumed: false,
          playerId: own.id,
          itemId,
          operationId: `rejected-food:${own.id}:${currentTick}`,
          replayed: false,
          healedAmount: 0,
          newHealth: own.health,
          reason: "item_not_owned",
        };
      }
      const healedAmount = Math.min(
        own.foodHealAmount,
        own.maxHealth - own.health,
      );
      own.foodRemaining--;
      own.foodConsumed++;
      own.health += healedAmount;
      return {
        ok: true,
        committed: true,
        consumed: true,
        playerId: own.id,
        itemId,
        operationId: `food:${own.id}:${currentTick}:${own.foodConsumed}`,
        replayed: false,
        healedAmount,
        newHealth: own.health,
      };
    },
    executeAttack: async (targetId: string): Promise<boolean> => {
      if (targetId !== opponent.id || !own.alive || !opponent.alive) {
        illegalActionAttempts++;
        return false;
      }
      own.inCombat = true;
      own.currentTarget = opponent.id;
      own.engagementActions++;
      return true;
    },
    executeMove: async (
      target: [number, number, number],
      run: boolean,
    ): Promise<boolean> => {
      if (
        target.some((coordinate) => !Number.isFinite(coordinate)) ||
        target[0] < ARENA_MIN ||
        target[0] > ARENA_MAX ||
        target[2] < ARENA_MIN ||
        target[2] > ARENA_MAX
      ) {
        illegalActionAttempts++;
        return false;
      }
      own.movementActions++;
      if (own.id === "fighter-b" || fighterAMovementApplied) {
        own.movementDestination = [...target];
        own.movementStep = run ? 2 : 1;
      }
      return true;
    },
    executeCombatApproach: (targetId: string): boolean => {
      if (targetId !== opponent.id || !own.alive || !opponent.alive) {
        illegalActionAttempts++;
        return false;
      }
      own.movementActions++;
      if (own.id === "fighter-b" || fighterAMovementApplied) {
        own.movementDestination = [...opponent.position];
        own.movementStep = 2.4;
      }
      return true;
    },
    getMovementDebugState: () => {
      const destination = own.movementDestination;
      return {
        activePath: destination !== null,
        currentTile: {
          x: Math.round(own.position[0]),
          z: Math.round(own.position[2]),
        },
        nextTile: destination
          ? {
              x: Math.round(destination[0]),
              z: Math.round(destination[2]),
            }
          : null,
        destinationTile: destination
          ? {
              x: Math.round(destination[0]),
              z: Math.round(destination[2]),
            }
          : null,
        remainingPathTiles: destination
          ? Math.ceil(
              Math.hypot(
                destination[0] - own.position[0],
                destination[2] - own.position[2],
              ),
            )
          : 0,
        moveSeq: own.movementActions,
      };
    },
    executeChangeStyle: async (style: string): Promise<boolean> => {
      if (
        ![
          "accurate",
          "aggressive",
          "controlled",
          "defensive",
          "rapid",
          "longrange",
        ].includes(style)
      ) {
        illegalActionAttempts++;
        return false;
      }
      own.currentStyle = style;
      return true;
    },
    executePrayerToggle: async (prayerId: string) => {
      const allowed =
        prayerBonusesById.size > 0
          ? new Set(prayerBonusesById.keys())
          : new Set([
              "superhuman_strength",
              "rock_skin",
              "hawk_eye",
              "mystic_lore",
              "protect_from_melee",
              "protect_from_missiles",
              "protect_from_magic",
            ]);
      if (!allowed.has(prayerId)) {
        illegalActionAttempts++;
        return {
          success: false,
          committed: false,
          playerId: own.id,
          operationId: `rejected-prayer:${own.id}:${currentTick}`,
          replayed: false,
          pointUnits: 100_000_000,
          points: 100,
          maxPoints: 100,
          activePrayers: [...own.activePrayers],
          reason: "unknown_prayer" as const,
        };
      }
      const active = new Set(own.activePrayers);
      if (active.has(prayerId)) active.delete(prayerId);
      else active.add(prayerId);
      own.activePrayers = [...active].sort();
      return {
        success: true,
        committed: true,
        playerId: own.id,
        operationId: `prayer:${own.id}:${currentTick}:${prayerId}`,
        replayed: false,
        pointUnits: 100_000_000,
        points: 100,
        maxPoints: 100,
        activePrayers: [...own.activePrayers],
      };
    },
  });

  const offensivePrayerForRole = (
    role: CombatRole,
  ): "superhuman_strength" | "hawk_eye" | "mystic_lore" =>
    role === "ranged"
      ? "hawk_eye"
      : role === "mage"
        ? "mystic_lore"
        : "superhuman_strength";
  const aiA = new DuelCombatAI(
    createService(fighterA, fighterB) as never,
    fighterB.id,
    {
      combatRole: fighterARole,
      noFood: fighterA.foodItemId === null,
      ...(prayerBonusesById.size > 0
        ? {
            availablePrayerIds: fighterAPrayerEnabled
              ? [offensivePrayerForRole(fighterARole)]
              : [],
          }
        : {}),
      tacticalStrategy: variant.macro
        ? buildStrategy(variant.macro, fighterARole)
        : undefined,
      initialStrafeSign: 1,
      movementClampBounds: {
        minX: ARENA_MIN,
        maxX: ARENA_MAX,
        minZ: ARENA_MIN,
        maxZ: ARENA_MAX,
      },
      combatLoadouts: multiStyleA
        ? {
            melee: {
              role: "melee",
              weaponId: "bronze_longsword",
              arrowsId: null,
              shieldId: null,
              spellId: null,
            },
            ranged: {
              role: "ranged",
              weaponId: "shortbow",
              arrowsId: "bronze_arrow",
              shieldId: null,
              spellId: null,
            },
            mage: {
              role: "mage",
              weaponId: "staff_of_air",
              arrowsId: null,
              shieldId: null,
              spellId: "wind_strike",
            },
          }
        : undefined,
      loadoutSwitchOperationPrefix: multiStyleA
        ? `ablation:${seed}:fighter-a`
        : undefined,
      switchCombatRole: multiStyleA
        ? async (role) => {
            if (!(["melee", "ranged", "mage"] as const).includes(role)) {
              illegalActionAttempts++;
              return { ok: false, retryable: false };
            }
            fighterA.role = role;
            fighterA.weaponId =
              role === "ranged"
                ? "shortbow"
                : role === "mage"
                  ? "staff_of_air"
                  : "bronze_longsword";
            fighterA.ammunitionId = role === "ranged" ? "bronze_arrow" : null;
            if (role === "ranged" && fighterA.ammunitionRemaining === null) {
              fighterA.ammunitionRemaining = 100;
            }
            fighterA.currentStyle = "accurate";
            fighterA.yieldAttackTick = currentTick;
            return { ok: true, retryable: false };
          }
        : undefined,
    },
  );
  const aiB = new DuelCombatAI(
    createService(fighterB, fighterA) as never,
    fighterA.id,
    {
      combatRole: fighterBRole,
      noFood: true,
      ...(prayerBonusesById.size > 0
        ? { availablePrayerIds: [offensivePrayerForRole(fighterBRole)] }
        : {}),
      tacticalStrategy: fixedOpponentStrategy
        ? buildStrategy("pressure", fighterBRole)
        : undefined,
      initialStrafeSign: -1,
      movementClampBounds: {
        minX: ARENA_MIN,
        maxX: ARENA_MAX,
        minZ: ARENA_MIN,
        maxZ: ARENA_MAX,
      },
    },
  );

  const originalDateNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => now;
  Math.random = () => deterministicUnit(seed, currentTick, "fighter-a", 99);

  const resolveAttack = (
    attacker: FighterWorldState,
    target: FighterWorldState,
  ): number => {
    if (
      !attacker.alive ||
      !target.alive ||
      !attacker.inCombat ||
      attacker.currentTarget !== target.id ||
      currentTick < attacker.nextAttackTick ||
      attacker.yieldAttackTick === currentTick
    ) {
      return 0;
    }
    const attackRange =
      attacker.role === "ranged" ? 7 : attacker.role === "mage" ? 10 : 2.2;
    if (distanceBetween(attacker, target) > attackRange) return 0;
    if (
      attacker.role === "ranged" &&
      attacker.ammunitionRemaining !== null &&
      attacker.ammunitionRemaining <= 0
    ) {
      return 0;
    }
    if (attacker.role === "ranged" && attacker.ammunitionRemaining !== null) {
      attacker.ammunitionRemaining--;
    }
    attacker.attacks++;
    attacker.nextAttackTick =
      currentTick +
      (attacker.role === "ranged" && attacker.currentStyle === "rapid"
        ? 3
        : attacker.role === "mage"
          ? 5
          : 4);
    const attackSeed =
      (seed ^
        Math.imul(currentTick + 1, 0x9e3779b1) ^
        Math.imul(attacker.id === "fighter-a" ? 17 : 31, 0x85ebca6b)) >>>
      0;
    const random = new SeededRandom(attackSeed);
    const attackerPrayerBonuses = combinePrayerBonuses(
      attacker,
      prayerBonusesById,
    );
    const defenderPrayerBonuses = combinePrayerBonuses(
      target,
      prayerBonusesById,
    );
    if (attacker.role === "ranged") {
      const result = calculateRangedDamage(
        {
          rangedLevel: attacker.rangedLevel,
          rangedAttackBonus: attacker.rangedAttackBonus,
          rangedStrengthBonus: attacker.rangedStrengthBonus,
          style: attacker.currentStyle === "rapid" ? "rapid" : "accurate",
          targetDefenseLevel: 60,
          targetRangedDefenseBonus: 20,
          prayerBonuses: attackerPrayerBonuses,
          targetPrayerBonuses: defenderPrayerBonuses,
        },
        random,
      );
      if (result.didHit) attacker.hits++;
      return result.damage;
    }
    if (attacker.role === "mage") {
      const result = calculateMagicDamage(
        {
          magicLevel: 60,
          magicAttackBonus: 20,
          style: "autocast",
          spellBaseMaxHit: 8,
          targetType: "player",
          targetMagicLevel: 60,
          targetDefenseLevel: 60,
          targetMagicDefenseBonus: 20,
          prayerBonuses: attackerPrayerBonuses,
          targetPrayerBonuses: defenderPrayerBonuses,
        },
        random,
      );
      if (result.didHit) attacker.hits++;
      return result.damage;
    }
    const meleeStyle = [
      "accurate",
      "aggressive",
      "controlled",
      "defensive",
    ].includes(attacker.currentStyle)
      ? (attacker.currentStyle as
          "accurate" | "aggressive" | "controlled" | "defensive")
      : "accurate";
    const defenderStyle = [
      "accurate",
      "aggressive",
      "controlled",
      "defensive",
    ].includes(target.currentStyle)
      ? (target.currentStyle as
          "accurate" | "aggressive" | "controlled" | "defensive")
      : undefined;
    const result = calculateDamage(
      { stats: { attack: 60, strength: 60 } },
      { stats: { defense: 60, defenseBonus: 20 } },
      AttackType.MELEE,
      { attack: 40, strength: 40, defense: 0, ranged: 0 },
      meleeStyle,
      defenderStyle,
      attackerPrayerBonuses,
      defenderPrayerBonuses,
      random,
    );
    if (result.didHit) attacker.hits++;
    return result.damage;
  };

  try {
    aiA.start();
    aiB.start();
    for (currentTick = 1; currentTick <= MAX_TICKS; currentTick++) {
      if (fighterAMovementApplied) advanceMovementPath(fighterA);
      advanceMovementPath(fighterB);
      await aiA.externalTick();
      await aiB.externalTick();
      const damageToB = resolveAttack(fighterA, fighterB);
      const damageToA = resolveAttack(fighterB, fighterA);
      fighterA.damage += damageToB;
      fighterB.damage += damageToA;
      fighterA.health = Math.max(0, fighterA.health - damageToA);
      fighterB.health = Math.max(0, fighterB.health - damageToB);
      fighterA.alive = fighterA.health > 0;
      fighterB.alive = fighterB.health > 0;
      trace.push({
        tick: currentTick,
        a: [
          round(fighterA.position[0], 3),
          round(fighterA.position[2], 3),
          fighterA.health,
          fighterA.attacks,
          fighterA.hits,
          fighterA.ammunitionRemaining,
          fighterA.foodRemaining,
          fighterA.foodConsumed,
          fighterA.activePrayers,
        ],
        b: [
          round(fighterB.position[0], 3),
          round(fighterB.position[2], 3),
          fighterB.health,
          fighterB.attacks,
          fighterB.hits,
          fighterB.activePrayers,
        ],
      });
      if (!fighterA.alive || !fighterB.alive) break;
      now += TICK_MS;
    }
  } finally {
    aiA.stop();
    aiB.stop();
    Date.now = originalDateNow;
    Math.random = originalRandom;
  }

  const winner: Winner =
    fighterA.health === fighterB.health
      ? "draw"
      : fighterA.health > fighterB.health
        ? fighterA.id
        : fighterB.id;
  return {
    seed,
    variant: variant.name,
    winner,
    ticks: currentTick,
    fighterAHealth: fighterA.health,
    fighterBHealth: fighterB.health,
    fighterAAttacks: fighterA.attacks,
    fighterBAttacks: fighterB.attacks,
    fighterAHits: fighterA.hits,
    fighterBHits: fighterB.hits,
    fighterADamage: fighterA.damage,
    fighterBDamage: fighterB.damage,
    fighterAMovementActions: fighterA.movementActions,
    fighterBMovementActions: fighterB.movementActions,
    fighterAEngagementActions: fighterA.engagementActions,
    fighterBEngagementActions: fighterB.engagementActions,
    fighterARoleSwitches: aiA.getStats().successfulRoleSwitches,
    fighterAPrayerToggleCommits: aiA.getStats().prayerToggleCommits,
    fighterAAmmoRemaining: fighterA.ammunitionRemaining,
    fighterAFoodConsumed: fighterA.foodConsumed,
    illegalActionAttempts,
    traceHash: sha256(trace),
  };
};

const wilson95 = (wins: number, total: number): [number, number] => {
  if (total === 0) return [0, 0];
  const z = 1.959963984540054;
  const proportion = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / total + (z * z) / (4 * total * total),
    );
  return [round(center - margin), round(center + margin)];
};

const score = (result: TacticalAblationDuelResult): number =>
  result.winner === "fighter-a" ? 1 : result.winner === "draw" ? 0.5 : 0;

const healthMargin = (result: TacticalAblationDuelResult): number =>
  result.fighterAHealth - result.fighterBHealth;

const twoSidedSignTest = (improved: number, regressed: number): number => {
  const trials = improved + regressed;
  if (trials === 0) return 1;
  const observed = Math.min(improved, regressed);
  let probability = 0;
  let combination = 1;
  for (let successes = 0; successes <= observed; successes++) {
    if (successes > 0) {
      combination = (combination * (trials - successes + 1)) / successes;
    }
    probability += combination * 0.5 ** trials;
  }
  return Number(Math.min(1, probability * 2).toPrecision(12));
};

const summarize = (
  variant: (typeof VARIANTS)[number],
  results: TacticalAblationDuelResult[],
): VariantSummary => {
  const wins = results.filter((result) => result.winner === "fighter-a").length;
  const losses = results.filter(
    (result) => result.winner === "fighter-b",
  ).length;
  const draws = results.length - wins - losses;
  const total = results.length;
  return {
    variant: variant.name,
    frozenMacro: variant.macro,
    wins,
    losses,
    draws,
    winRate: round(wins / total),
    winRateWilson95: wilson95(wins, total),
    meanScore: round(
      results.reduce((sum, result) => sum + score(result), 0) / total,
    ),
    meanTicks: round(
      results.reduce((sum, result) => sum + result.ticks, 0) / total,
      3,
    ),
    meanDamage: round(
      results.reduce((sum, result) => sum + result.fighterADamage, 0) / total,
      3,
    ),
    meanDamageReceived: round(
      results.reduce((sum, result) => sum + result.fighterBDamage, 0) / total,
      3,
    ),
    meanMovementActions: round(
      results.reduce((sum, result) => sum + result.fighterAMovementActions, 0) /
        total,
      3,
    ),
    illegalActionAttempts: results.reduce(
      (sum, result) => sum + result.illegalActionAttempts,
      0,
    ),
    cohortHash: sha256(results),
    // The retained cohort hash intentionally binds the variant label as well
    // as its outcomes. Keep a second label-free hash so a renamed or aliased
    // macro cannot masquerade as a distinct tactical execution.
    behaviorHash: sha256(
      results.map(
        ({ variant: _variant, ...executedOutcome }) => executedOutcome,
      ),
    ),
  };
};

const summarizePreparation = (
  profile: FighterPreparationProfile,
  results: TacticalAblationDuelResult[],
): PreparationCohortSummary => {
  const wins = results.filter((result) => result.winner === "fighter-a").length;
  const losses = results.filter(
    (result) => result.winner === "fighter-b",
  ).length;
  const total = results.length;
  return {
    ...profile,
    wins,
    losses,
    draws: total - wins - losses,
    meanScore: round(
      results.reduce((sum, result) => sum + score(result), 0) / total,
    ),
    meanHealthMargin: round(
      results.reduce((sum, result) => sum + healthMargin(result), 0) / total,
      3,
    ),
    meanDamage: round(
      results.reduce((sum, result) => sum + result.fighterADamage, 0) / total,
      3,
    ),
    meanFoodConsumed: round(
      results.reduce((sum, result) => sum + result.fighterAFoodConsumed, 0) /
        total,
      3,
    ),
    meanAmmunitionRemaining: round(
      results.reduce(
        (sum, result) => sum + (result.fighterAAmmoRemaining ?? 0),
        0,
      ) / total,
      3,
    ),
    illegalActionAttempts: results.reduce(
      (sum, result) => sum + result.illegalActionAttempts,
      0,
    ),
    cohortHash: sha256(results),
  };
};

const summarizeSupplyChain = (
  cohort: SupplyChainCohortSummary["cohort"],
  profile: FighterPreparationProfile,
  results: TacticalAblationDuelResult[],
): SupplyChainCohortSummary => {
  const summary = summarizePreparation(profile, results);
  return {
    ...summary,
    cohort,
    dimension: "gathering_processing",
  };
};

export async function runCompetitiveTacticalAblation(
  seedCount = DEFAULT_SEED_COUNT,
): Promise<CompetitiveTacticalAblationReport> {
  if (!Number.isSafeInteger(seedCount) || seedCount < 1 || seedCount > 4_096) {
    throw new Error("seedCount must be an integer from 1 through 4096");
  }
  const { profiles: preparationProfiles, authoredInputHash } =
    await loadAuthoredPreparationProfiles();
  const {
    lineage: authoredSupplyChainLineage,
    authoredInputHash: authoredSupplyChainInputHash,
  } = await loadAuthoredSupplyChainLineage();
  const {
    bonusesById: authoredPrayerBonuses,
    authoredInputHash: authoredPrayerInputHash,
  } = await loadAuthoredPrayerBonuses();
  const cohorts = new Map<VariantName, TacticalAblationDuelResult[]>();
  for (const variant of VARIANTS) {
    const first: TacticalAblationDuelResult[] = [];
    const replay: TacticalAblationDuelResult[] = [];
    for (let index = 0; index < seedCount; index++) {
      first.push(await runDuel(index + 1, variant));
    }
    for (let index = 0; index < seedCount; index++) {
      replay.push(await runDuel(index + 1, variant));
    }
    if (sha256(first) !== sha256(replay)) {
      throw new Error(`non-deterministic tactical replay for ${variant.name}`);
    }
    if (first.some((result) => result.illegalActionAttempts !== 0)) {
      throw new Error(`illegal action requested by ${variant.name}`);
    }
    cohorts.set(variant.name, first);
  }

  const baseline = cohorts.get("deterministic_fallback");
  if (!baseline) throw new Error("deterministic fallback cohort missing");
  const fallbackVariant = VARIANTS[0];
  const movementDisabled: TacticalAblationDuelResult[] = [];
  const movementDisabledReplay: TacticalAblationDuelResult[] = [];
  for (let index = 0; index < seedCount; index++) {
    movementDisabled.push(await runDuel(index + 1, fallbackVariant, false));
  }
  for (let index = 0; index < seedCount; index++) {
    movementDisabledReplay.push(
      await runDuel(index + 1, fallbackVariant, false),
    );
  }
  if (sha256(movementDisabled) !== sha256(movementDisabledReplay)) {
    throw new Error("non-deterministic movement-disabled tactical replay");
  }
  if (movementDisabled.some((result) => result.illegalActionAttempts !== 0)) {
    throw new Error("illegal action requested by movement-disabled cohort");
  }
  const variants = VARIANTS.map((variant) =>
    summarize(variant, cohorts.get(variant.name) ?? []),
  );
  const pairedAgainstFallback = VARIANTS.filter(
    (variant) => variant.name !== "deterministic_fallback",
  ).map((variant): PairedComparison => {
    const candidate = cohorts.get(variant.name) ?? [];
    let improvedSeeds = 0;
    let regressedSeeds = 0;
    let tiedSeeds = 0;
    let scoreDelta = 0;
    for (let index = 0; index < baseline.length; index++) {
      const delta = score(candidate[index]) - score(baseline[index]);
      scoreDelta += delta;
      if (delta > 0) improvedSeeds++;
      else if (delta < 0) regressedSeeds++;
      else tiedSeeds++;
    }
    return {
      variant: variant.name,
      baseline: "deterministic_fallback",
      meanScoreDelta: round(scoreDelta / seedCount),
      improvedSeeds,
      regressedSeeds,
      tiedSeeds,
      twoSidedSignTestP: twoSidedSignTest(improvedSeeds, regressedSeeds),
    };
  });
  let disabledImprovedSeeds = 0;
  let disabledRegressedSeeds = 0;
  let movementTiedSeeds = 0;
  let disabledScoreDelta = 0;
  for (let index = 0; index < baseline.length; index++) {
    const delta = score(movementDisabled[index]) - score(baseline[index]);
    disabledScoreDelta += delta;
    if (delta > 0) disabledImprovedSeeds++;
    else if (delta < 0) disabledRegressedSeeds++;
    else movementTiedSeeds++;
  }
  const movementAblation = {
    macro: "deterministic_fallback" as const,
    facingAblationIncluded: false as const,
    opponentMovementRetained: true as const,
    enabled: summarize(fallbackVariant, baseline),
    disabled: summarize(fallbackVariant, movementDisabled),
    disabledMinusEnabledMeanScore: round(disabledScoreDelta / seedCount),
    disabledImprovedSeeds,
    disabledRegressedSeeds,
    tiedSeeds: movementTiedSeeds,
    twoSidedSignTestP: twoSidedSignTest(
      disabledImprovedSeeds,
      disabledRegressedSeeds,
    ),
  };
  const roleMatrixSeedCount = Math.min(seedCount, 64);
  const combatRoles: readonly CombatRole[] = ["melee", "ranged", "mage"];
  const rolePairings: CompetitiveTacticalAblationReport["roleMatrix"]["pairings"] =
    [];
  for (const fighterARole of combatRoles) {
    for (const fighterBRole of combatRoles) {
      const first: TacticalAblationDuelResult[] = [];
      const replay: TacticalAblationDuelResult[] = [];
      for (let index = 0; index < roleMatrixSeedCount; index++) {
        first.push(
          await runDuel(
            index + 1,
            fallbackVariant,
            true,
            fighterARole,
            fighterBRole,
            false,
          ),
        );
      }
      for (let index = 0; index < roleMatrixSeedCount; index++) {
        replay.push(
          await runDuel(
            index + 1,
            fallbackVariant,
            true,
            fighterARole,
            fighterBRole,
            false,
          ),
        );
      }
      if (sha256(first) !== sha256(replay)) {
        throw new Error(
          `non-deterministic role-matrix replay for ${fighterARole}/${fighterBRole}`,
        );
      }
      const illegalActionAttempts = first.reduce(
        (total, result) => total + result.illegalActionAttempts,
        0,
      );
      if (illegalActionAttempts !== 0) {
        throw new Error(
          `illegal action requested by role matrix ${fighterARole}/${fighterBRole}`,
        );
      }
      const wins = first.filter(
        (result) => result.winner === "fighter-a",
      ).length;
      const losses = first.filter(
        (result) => result.winner === "fighter-b",
      ).length;
      rolePairings.push({
        fighterA: fighterARole,
        fighterB: fighterBRole,
        wins,
        losses,
        draws: first.length - wins - losses,
        meanScore: round(
          first.reduce((total, result) => total + score(result), 0) /
            first.length,
        ),
        meanTicks: round(
          first.reduce((total, result) => total + result.ticks, 0) /
            first.length,
          3,
        ),
        illegalActionAttempts,
        cohortHash: sha256(first),
      });
    }
  }
  const roleMatrix = {
    seedCountPerPairing: roleMatrixSeedCount,
    allPairingsReplayed: true as const,
    pairings: rolePairings,
  };
  const fixedStyle: TacticalAblationDuelResult[] = [];
  const fixedStyleReplay: TacticalAblationDuelResult[] = [];
  const multiStyle: TacticalAblationDuelResult[] = [];
  const multiStyleReplay: TacticalAblationDuelResult[] = [];
  for (let index = 0; index < seedCount; index++) {
    fixedStyle.push(
      await runDuel(
        index + 1,
        fallbackVariant,
        true,
        "melee",
        "melee",
        false,
        false,
      ),
    );
    multiStyle.push(
      await runDuel(
        index + 1,
        fallbackVariant,
        true,
        "melee",
        "melee",
        false,
        true,
      ),
    );
  }
  for (let index = 0; index < seedCount; index++) {
    fixedStyleReplay.push(
      await runDuel(
        index + 1,
        fallbackVariant,
        true,
        "melee",
        "melee",
        false,
        false,
      ),
    );
    multiStyleReplay.push(
      await runDuel(
        index + 1,
        fallbackVariant,
        true,
        "melee",
        "melee",
        false,
        true,
      ),
    );
  }
  if (
    sha256(fixedStyle) !== sha256(fixedStyleReplay) ||
    sha256(multiStyle) !== sha256(multiStyleReplay)
  ) {
    throw new Error("non-deterministic fixed/multi-style replay");
  }
  if (
    [...fixedStyle, ...multiStyle].some(
      (result) => result.illegalActionAttempts !== 0,
    )
  ) {
    throw new Error("illegal action requested by fixed/multi-style cohort");
  }
  let multiStyleImprovedSeeds = 0;
  let multiStyleRegressedSeeds = 0;
  let styleTiedSeeds = 0;
  let multiStyleScoreDelta = 0;
  for (let index = 0; index < seedCount; index++) {
    const delta = score(multiStyle[index]) - score(fixedStyle[index]);
    multiStyleScoreDelta += delta;
    if (delta > 0) multiStyleImprovedSeeds++;
    else if (delta < 0) multiStyleRegressedSeeds++;
    else styleTiedSeeds++;
  }
  const styleAblation = {
    initialRole: "melee" as const,
    opponentRole: "melee" as const,
    frozenAlternatives: ["melee", "ranged", "mage"] as const,
    fixed: summarize(fallbackVariant, fixedStyle),
    multiStyle: summarize(fallbackVariant, multiStyle),
    meanSuccessfulSwitches: round(
      multiStyle.reduce(
        (total, result) => total + result.fighterARoleSwitches,
        0,
      ) / seedCount,
    ),
    multiStyleMinusFixedMeanScore: round(multiStyleScoreDelta / seedCount),
    multiStyleImprovedSeeds,
    multiStyleRegressedSeeds,
    tiedSeeds: styleTiedSeeds,
    twoSidedSignTestP: twoSidedSignTest(
      multiStyleImprovedSeeds,
      multiStyleRegressedSeeds,
    ),
    durableCustodyIncluded: false as const,
  };
  const preparationCohorts = new Map<
    PreparationCohortName,
    TacticalAblationDuelResult[]
  >();
  for (const profile of preparationProfiles) {
    const first: TacticalAblationDuelResult[] = [];
    const replay: TacticalAblationDuelResult[] = [];
    for (let index = 0; index < seedCount; index++) {
      first.push(
        await runDuel(
          index + 1,
          fallbackVariant,
          true,
          "ranged",
          "melee",
          true,
          false,
          profile,
        ),
      );
    }
    for (let index = 0; index < seedCount; index++) {
      replay.push(
        await runDuel(
          index + 1,
          fallbackVariant,
          true,
          "ranged",
          "melee",
          true,
          false,
          profile,
        ),
      );
    }
    if (sha256(first) !== sha256(replay)) {
      throw new Error(
        `non-deterministic preparation replay for ${profile.cohort}`,
      );
    }
    if (first.some((result) => result.illegalActionAttempts !== 0)) {
      throw new Error(`illegal action requested by ${profile.cohort}`);
    }
    preparationCohorts.set(profile.cohort, first);
  }
  const preparationBaseline = preparationCohorts.get("baseline");
  if (!preparationBaseline) {
    throw new Error("preparation baseline cohort missing");
  }
  const preparationSummaries = preparationProfiles.map((profile) =>
    summarizePreparation(profile, preparationCohorts.get(profile.cohort) ?? []),
  );
  const preparationComparisons: PreparationPairedComparison[] = [];
  for (const profile of preparationProfiles) {
    if (profile.cohort === "baseline") continue;
    const candidate = preparationCohorts.get(profile.cohort);
    if (!candidate || candidate.length !== preparationBaseline.length) {
      throw new Error(`preparation cohort missing: ${profile.cohort}`);
    }
    let improvedSeeds = 0;
    let regressedSeeds = 0;
    let tiedSeeds = 0;
    let scoreDelta = 0;
    let healthMarginDelta = 0;
    for (let index = 0; index < seedCount; index++) {
      const seedScoreDelta =
        score(candidate[index]) - score(preparationBaseline[index]);
      const seedHealthMarginDelta =
        healthMargin(candidate[index]) -
        healthMargin(preparationBaseline[index]);
      scoreDelta += seedScoreDelta;
      healthMarginDelta += seedHealthMarginDelta;
      if (seedHealthMarginDelta > 0) improvedSeeds++;
      else if (seedHealthMarginDelta < 0) regressedSeeds++;
      else tiedSeeds++;
    }
    preparationComparisons.push({
      cohort: profile.cohort,
      dimension: profile.dimension,
      baseline: "baseline",
      meanScoreDelta: round(scoreDelta / seedCount),
      meanHealthMarginDelta: round(healthMarginDelta / seedCount, 3),
      improvedSeeds,
      regressedSeeds,
      tiedSeeds,
      twoSidedSignTestP: twoSidedSignTest(improvedSeeds, regressedSeeds),
    });
  }
  const preparationAblation = {
    fighterA: "ranged" as const,
    fighterB: "melee" as const,
    authoredManifestInputs: true as const,
    authoredManifestSourceFiles: [
      AUTHORED_MANIFEST_SOURCES[0].reportPath,
      AUTHORED_MANIFEST_SOURCES[1].reportPath,
      AUTHORED_MANIFEST_SOURCES[2].reportPath,
    ] as const,
    authoredInputHash,
    requirementsValidated: true as const,
    allCohortsReplayed: true as const,
    commonRandomNumbers: true as const,
    technicalResultOnly: true as const,
    productAcceptanceThreshold: null,
    productionInventoryAuthorityIncluded: false as const,
    durableCustodyIncluded: false as const,
    profiles: preparationSummaries,
    pairedAgainstBaseline: preparationComparisons,
  };
  const supplyChainBaseProfile = preparationProfiles.find(
    (profile) => profile.cohort === "baseline",
  );
  if (!supplyChainBaseProfile) {
    throw new Error("supply-chain combat profile is missing");
  }
  const supplyChainProfiles = {
    one_batch_incomplete: {
      ...supplyChainBaseProfile,
      ammunitionQuantity: authoredSupplyChainLineage.incompleteOutputQuantity,
    },
    minimum_complete_batches: {
      ...supplyChainBaseProfile,
      ammunitionQuantity: authoredSupplyChainLineage.completeOutputQuantity,
    },
  } as const;
  const runSupplyChainCohort = async (
    profile: FighterPreparationProfile,
    description: string,
  ): Promise<TacticalAblationDuelResult[]> => {
    const first: TacticalAblationDuelResult[] = [];
    const replay: TacticalAblationDuelResult[] = [];
    for (let index = 0; index < seedCount; index++) {
      first.push(
        await runDuel(
          index + 1,
          fallbackVariant,
          true,
          "ranged",
          "melee",
          true,
          false,
          profile,
        ),
      );
    }
    for (let index = 0; index < seedCount; index++) {
      replay.push(
        await runDuel(
          index + 1,
          fallbackVariant,
          true,
          "ranged",
          "melee",
          true,
          false,
          profile,
        ),
      );
    }
    if (sha256(first) !== sha256(replay)) {
      throw new Error(
        `non-deterministic supply-chain replay for ${description}`,
      );
    }
    if (first.some((result) => result.illegalActionAttempts !== 0)) {
      throw new Error(`illegal action requested by ${description}`);
    }
    return first;
  };
  const supplyIncomplete = await runSupplyChainCohort(
    supplyChainProfiles.one_batch_incomplete,
    "one_batch_incomplete",
  );
  const supplyCompleted = await runSupplyChainCohort(
    supplyChainProfiles.minimum_complete_batches,
    "minimum_complete_batches",
  );
  let completedImprovedSeeds = 0;
  let completedRegressedSeeds = 0;
  let supplyTiedSeeds = 0;
  let completedScoreDelta = 0;
  let completedHealthMarginDelta = 0;
  for (let index = 0; index < seedCount; index++) {
    const scoreDelta =
      score(supplyCompleted[index]) - score(supplyIncomplete[index]);
    const marginDelta =
      healthMargin(supplyCompleted[index]) -
      healthMargin(supplyIncomplete[index]);
    completedScoreDelta += scoreDelta;
    completedHealthMarginDelta += marginDelta;
    if (marginDelta > 0) completedImprovedSeeds++;
    else if (marginDelta < 0) completedRegressedSeeds++;
    else supplyTiedSeeds++;
  }
  const supplyChainAblation = {
    fighterA: "ranged" as const,
    fighterB: "melee" as const,
    authoredManifestInputs: true as const,
    authoredManifestSourceFiles: [
      AUTHORED_SUPPLY_CHAIN_SOURCES[0].reportPath,
      AUTHORED_SUPPLY_CHAIN_SOURCES[1].reportPath,
      AUTHORED_SUPPLY_CHAIN_SOURCES[2].reportPath,
      AUTHORED_SUPPLY_CHAIN_SOURCES[3].reportPath,
      AUTHORED_SUPPLY_CHAIN_SOURCES[4].reportPath,
      AUTHORED_SUPPLY_CHAIN_SOURCES[5].reportPath,
    ] as const,
    authoredInputHash: authoredSupplyChainInputHash,
    recipeGraphValidated: true as const,
    commonRandomNumbers: true as const,
    allCohortsReplayed: true as const,
    technicalResultOnly: true as const,
    productAcceptanceThreshold: null,
    // Acquisition provenance must never alter combat math. The causal input is
    // the conserved authored output quantity that preparation made available.
    acquisitionProvenanceChangesCombatStats: false as const,
    productionProcessingAuthorityIncluded: false as const,
    productionInventoryAuthorityIncluded: false as const,
    durableCustodyIncluded: false as const,
    lineage: authoredSupplyChainLineage,
    incomplete: summarizeSupplyChain(
      "one_batch_incomplete",
      supplyChainProfiles.one_batch_incomplete,
      supplyIncomplete,
    ),
    completed: summarizeSupplyChain(
      "minimum_complete_batches",
      supplyChainProfiles.minimum_complete_batches,
      supplyCompleted,
    ),
    completedMinusIncompleteMeanScore: round(completedScoreDelta / seedCount),
    completedMinusIncompleteMeanHealthMargin: round(
      completedHealthMarginDelta / seedCount,
      3,
    ),
    completedImprovedSeeds,
    completedRegressedSeeds,
    tiedSeeds: supplyTiedSeeds,
    twoSidedSignTestP: twoSidedSignTest(
      completedImprovedSeeds,
      completedRegressedSeeds,
    ),
  };
  const prayerRoles: PrayerAblationSummary[] = [];
  for (const fighterARole of combatRoles) {
    const enabled: TacticalAblationDuelResult[] = [];
    const enabledReplay: TacticalAblationDuelResult[] = [];
    const disabled: TacticalAblationDuelResult[] = [];
    const disabledReplay: TacticalAblationDuelResult[] = [];
    for (let index = 0; index < seedCount; index++) {
      enabled.push(
        await runDuel(
          index + 1,
          fallbackVariant,
          true,
          fighterARole,
          "melee",
          true,
          false,
          undefined,
          authoredPrayerBonuses,
          true,
        ),
      );
      disabled.push(
        await runDuel(
          index + 1,
          fallbackVariant,
          true,
          fighterARole,
          "melee",
          true,
          false,
          undefined,
          authoredPrayerBonuses,
          false,
        ),
      );
    }
    for (let index = 0; index < seedCount; index++) {
      enabledReplay.push(
        await runDuel(
          index + 1,
          fallbackVariant,
          true,
          fighterARole,
          "melee",
          true,
          false,
          undefined,
          authoredPrayerBonuses,
          true,
        ),
      );
      disabledReplay.push(
        await runDuel(
          index + 1,
          fallbackVariant,
          true,
          fighterARole,
          "melee",
          true,
          false,
          undefined,
          authoredPrayerBonuses,
          false,
        ),
      );
    }
    if (
      sha256(enabled) !== sha256(enabledReplay) ||
      sha256(disabled) !== sha256(disabledReplay)
    ) {
      throw new Error(`non-deterministic prayer replay for ${fighterARole}`);
    }
    if (
      [...enabled, ...disabled].some(
        (result) => result.illegalActionAttempts !== 0,
      )
    ) {
      throw new Error(`illegal action requested by prayer ${fighterARole}`);
    }
    let enabledImprovedSeeds = 0;
    let enabledRegressedSeeds = 0;
    let tiedSeeds = 0;
    let healthMarginDelta = 0;
    for (let index = 0; index < seedCount; index++) {
      const delta =
        healthMargin(enabled[index]) - healthMargin(disabled[index]);
      healthMarginDelta += delta;
      if (delta > 0) enabledImprovedSeeds++;
      else if (delta < 0) enabledRegressedSeeds++;
      else tiedSeeds++;
    }
    prayerRoles.push({
      role: fighterARole,
      prayerId:
        fighterARole === "ranged"
          ? "hawk_eye"
          : fighterARole === "mage"
            ? "mystic_lore"
            : "superhuman_strength",
      enabled: summarize(fallbackVariant, enabled),
      disabled: summarize(fallbackVariant, disabled),
      meanHealthMarginDelta: round(healthMarginDelta / seedCount, 3),
      enabledImprovedSeeds,
      enabledRegressedSeeds,
      tiedSeeds,
      twoSidedSignTestP: twoSidedSignTest(
        enabledImprovedSeeds,
        enabledRegressedSeeds,
      ),
      meanEnabledPrayerCommits: round(
        enabled.reduce(
          (total, result) => total + result.fighterAPrayerToggleCommits,
          0,
        ) / seedCount,
        3,
      ),
      disabledPrayerCommits: disabled.reduce(
        (total, result) => total + result.fighterAPrayerToggleCommits,
        0,
      ),
    });
  }
  const prayerAblation = {
    authoredManifestInput: true as const,
    authoredManifestSourceFile: PRAYER_MANIFEST_SOURCE.reportPath,
    authoredInputHash: authoredPrayerInputHash,
    productionModifierRetentionCovered: true as const,
    allCohortsReplayed: true as const,
    commonRandomNumbers: true as const,
    technicalResultOnly: true as const,
    productAcceptanceThreshold: null,
    productionPrayerCustodyIncluded: false as const,
    roles: prayerRoles,
  };
  const unsigned = {
    schemaVersion: 3 as const,
    harness: {
      subject: "DuelCombatAI" as const,
      seedCount,
      retainedExecutions:
        seedCount * (VARIANTS.length * 2 + 2) +
        roleMatrixSeedCount * combatRoles.length * combatRoles.length * 2 +
        seedCount * 4 +
        seedCount * preparationProfiles.length * 2 +
        seedCount * 4 +
        seedCount * combatRoles.length * 4,
      tickMs: TICK_MS,
      maxTicks: MAX_TICKS,
      arenaBounds: [ARENA_MIN, ARENA_MAX] as [number, number],
      fighterA: "ranged" as const,
      fighterB: "melee" as const,
      commonRandomNumbers: true as const,
      noModelRuntimeInCombat: true as const,
      boundedAuthorityAppliesEveryMovementTarget: true as const,
      technicalResultOnly: true as const,
      productAcceptanceThreshold: null,
      combatFixture: {
        outcomeRule: "kill_or_max_tick_health_advantage" as const,
        fighterA: {
          formula: "calculateRangedDamage" as const,
          health: 100 as const,
          attackRange: 7 as const,
          rangedLevel: 60 as const,
          rangedAttackBonus: 20 as const,
          rangedStrengthBonus: 25 as const,
          targetDefenseLevel: 60 as const,
          targetRangedDefenseBonus: 20 as const,
          rapidAttackTicks: 3 as const,
          ordinaryAttackTicks: 4 as const,
        },
        fighterB: {
          formula: "calculateDamage" as const,
          health: 100 as const,
          attackRange: 2.2 as const,
          attackLevel: 60 as const,
          strengthLevel: 60 as const,
          attackBonus: 40 as const,
          strengthBonus: 40 as const,
          targetDefenseLevel: 60 as const,
          targetDefenseBonus: 20 as const,
          attackTicks: 4 as const,
          approachStep: 2.4 as const,
        },
        mage: {
          formula: "calculateMagicDamage" as const,
          health: 100 as const,
          attackRange: 10 as const,
          magicLevel: 60 as const,
          magicAttackBonus: 20 as const,
          spellBaseMaxHit: 8 as const,
          targetMagicLevel: 60 as const,
          targetDefenseLevel: 60 as const,
          targetMagicDefenseBonus: 20 as const,
          attackTicks: 5 as const,
        },
      },
    },
    replayVerified: true as const,
    variants,
    pairedAgainstFallback,
    movementAblation,
    roleMatrix,
    styleAblation,
    preparationAblation,
    supplyChainAblation,
    prayerAblation,
  };
  return { ...unsigned, reportHash: sha256(unsigned) };
}
