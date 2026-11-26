/**
 * ProcessingDataProvider - Runtime Data from Recipe Manifests
 *
 * Builds cooking, firemaking, smelting, and smithing lookup tables from
 * dedicated recipe manifest files. This is the data-driven approach where
 * each skill's recipes are in separate JSON files:
 *
 *   - recipes/cooking.json
 *   - recipes/firemaking.json
 *   - recipes/smelting.json
 *   - recipes/smithing.json
 *
 * Usage:
 *   const provider = ProcessingDataProvider.getInstance();
 *   await provider.initialize(); // Called after DataManager loads manifests
 *   const cookingData = provider.getCookingData("raw_shrimp");
 *   const smeltingData = provider.getSmeltingData("bronze_bar");
 *
 * @see packages/server/world/assets/manifests/recipes/ for source data
 */

import { ITEMS } from "./items";
import type { SmithingCategory } from "./smithing-recipes";
import { SMITHING_CONSTANTS } from "../constants/SmithingConstants";
import { PROCESSING_CONSTANTS } from "../constants/ProcessingConstants";

// ============================================================================
// RECIPE MANIFEST TYPES - Structures matching the JSON files
// ============================================================================

/**
 * Cooking recipe from recipes/cooking.json
 */
export interface CookingRecipeManifest {
  raw: string;
  cooked: string;
  burnt: string;
  level: number;
  xp: number;
  ticks: number;
  stopBurnLevel: { fire: number; range: number };
}

/**
 * Firemaking recipe from recipes/firemaking.json
 */
export interface FiremakingRecipeManifest {
  log: string;
  level: number;
  xp: number;
  ticks: number;
}

/**
 * Smelting recipe from recipes/smelting.json
 */
export interface SmeltingRecipeManifest {
  output: string;
  inputs: Array<{ item: string; amount: number }>;
  level: number;
  xp: number;
  ticks: number;
  successRate: number;
}

/**
 * Crafting recipe input from recipes/crafting.json
 */
export interface CraftingRecipeInput {
  item: string;
  amount: number;
}

/**
 * Crafting consumable from recipes/crafting.json
 */
export interface CraftingConsumable {
  item: string;
  uses: number;
}

/**
 * Crafting recipe from recipes/crafting.json
 */
export interface CraftingRecipeManifest {
  output: string;
  category: string;
  inputs: CraftingRecipeInput[];
  tools: string[];
  consumables: CraftingConsumable[];
  level: number;
  xp: number;
  ticks: number;
  station: string;
}

/**
 * Full manifest structure for recipes/crafting.json
 */
export interface CraftingManifest {
  recipes: CraftingRecipeManifest[];
}

/**
 * Tanning recipe from recipes/tanning.json
 */
export interface TanningRecipeManifest {
  input: string;
  output: string;
  cost: number;
  name: string;
}

/**
 * Full manifest structure for recipes/tanning.json
 */
export interface TanningManifest {
  recipes: TanningRecipeManifest[];
}

/**
 * Fletching recipe input from recipes/fletching.json
 */
export interface FletchingRecipeInput {
  item: string;
  amount: number;
}

/**
 * Fletching recipe from recipes/fletching.json
 */
export interface FletchingRecipeManifest {
  output: string;
  outputQuantity: number;
  category: string;
  inputs: FletchingRecipeInput[];
  tools: string[];
  level: number;
  xp: number;
  ticks: number;
  skill: string;
}

/**
 * Full manifest structure for recipes/fletching.json
 */
export interface FletchingManifest {
  recipes: FletchingRecipeManifest[];
}

/**
 * Runecrafting recipe from recipes/runecrafting.json
 */
export interface RunecraftingRecipeManifest {
  runeType: string;
  runeItemId: string;
  levelRequired: number;
  xpPerEssence: number;
  essenceTypes: string[];
  multiRuneLevels: number[];
}

/**
 * Full manifest structure for recipes/runecrafting.json
 */
export interface RunecraftingManifest {
  recipes: RunecraftingRecipeManifest[];
}

/**
 * Tanning recipe data for runtime use
 */
export interface TanningRecipeData {
  /** Input hide item ID (e.g., "cowhide") */
  input: string;
  /** Output leather item ID (e.g., "leather") */
  output: string;
  /** Coin cost per hide tanned */
  cost: number;
  /** Display name */
  name: string;
}

/**
 * Fletching recipe data for runtime use.
 * Keyed by recipeId (output:primaryInput) since multiple recipes can share an output (e.g., arrow shafts from different logs).
 */
export interface FletchingRecipeData {
  /** Unique recipe ID (auto-generated as output:primaryInput) */
  recipeId: string;
  /** Output item ID */
  output: string;
  /** Display name for the output item */
  name: string;
  /** Number of items produced per action (e.g., 15 arrow shafts per log) */
  outputQuantity: number;
  /** Category for UI grouping (arrow_shafts, headless_arrows, shortbows, longbows, stringing, arrows) */
  category: string;
  /** Input materials required */
  inputs: FletchingRecipeInput[];
  /** Tool item IDs required in inventory (not consumed). Empty for no-tool recipes like stringing */
  tools: string[];
  /** Fletching level required */
  level: number;
  /** XP granted per action (total for all outputQuantity items) */
  xp: number;
  /** Time in game ticks (600ms per tick) */
  ticks: number;
}

/**
 * Runecrafting recipe data for runtime use.
 * Keyed by runeType (e.g., "air", "water", "chaos").
 */
export interface RunecraftingRecipeData {
  /** Rune type identifier (e.g., "air", "mind", "water") */
  runeType: string;
  /** Output rune item ID (e.g., "air_rune") */
  runeItemId: string;
  /** Display name for the rune */
  name: string;
  /** Runecrafting level required */
  levelRequired: number;
  /** XP granted per essence converted */
  xpPerEssence: number;
  /** Essence item IDs that can be used (e.g., ["rune_essence", "pure_essence"]) */
  essenceTypes: string[];
  /** Levels at which the player crafts an additional rune per essence (sorted ascending) */
  multiRuneLevels: number[];
}

/**
 * Crafting recipe data for runtime use
 */
export interface CraftingRecipeData {
  /** Output item ID */
  output: string;
  /** Display name for the item */
  name: string;
  /** Category for UI grouping (leather, studded, dragonhide, jewelry, gem_cutting) */
  category: string;
  /** Input materials required */
  inputs: CraftingRecipeInput[];
  /** Tool item IDs required in inventory (not consumed) */
  tools: string[];
  /** Consumable items with limited uses (e.g., thread with 5 uses) */
  consumables: CraftingConsumable[];
  /** Crafting level required */
  level: number;
  /** XP granted per item made */
  xp: number;
  /** Time in game ticks (600ms per tick) */
  ticks: number;
  /** Station required ("none" or "furnace") */
  station: string;
}

/**
 * Smithing recipe from recipes/smithing.json
 */
export interface SmithingRecipeManifest {
  output: string;
  bar: string;
  barsRequired: number;
  level: number;
  xp: number;
  ticks: number;
  category: string;
  /** Number of items produced per action (default: 1). Used for arrowtips (15 per action). */
  outputQuantity?: number;
}

/**
 * Full manifest structure for recipes/cooking.json
 */
export interface CookingManifest {
  recipes: CookingRecipeManifest[];
}

/**
 * Full manifest structure for recipes/firemaking.json
 */
export interface FiremakingManifest {
  recipes: FiremakingRecipeManifest[];
}

/**
 * Full manifest structure for recipes/smelting.json
 */
export interface SmeltingManifest {
  recipes: SmeltingRecipeManifest[];
}

/**
 * Full manifest structure for recipes/smithing.json
 */
export interface SmithingManifest {
  recipes: SmithingRecipeManifest[];
}

/**
 * Smithing recipe data extracted from item manifest
 * Note: This replaces the hardcoded SMITHING_RECIPES from smithing-recipes.ts
 */
export interface SmithingRecipeData {
  /** Output item ID */
  itemId: string;
  /** Display name for the item */
  name: string;
  /** Bar type required (e.g., "bronze_bar") */
  barType: string;
  /** Number of bars needed */
  barsRequired: number;
  /** Smithing level required */
  levelRequired: number;
  /** XP granted per item made */
  xp: number;
  /** Category for UI grouping */
  category: SmithingCategory;
  /** Time in game ticks (600ms per tick). Default: 4 */
  ticks: number;
  /** Number of items produced per action. Default: 1. Arrowtips produce 15. */
  outputQuantity: number;
}

/**
 * Smithing recipe with availability info for UI display.
 * Includes flags to show whether player can actually make the item.
 */
export interface SmithingRecipeWithAvailability extends SmithingRecipeData {
  /** True if player meets the level requirement */
  meetsLevel: boolean;
  /** True if player has enough bars */
  hasBars: boolean;
}

/**
 * Cooking data extracted from item manifest
 */
export interface CookingItemData {
  rawItemId: string;
  cookedItemId: string;
  burntItemId: string;
  levelRequired: number;
  xp: number;
  /** Exact authored duration in game ticks. */
  ticks: number;
  stopBurnLevel: {
    fire: number;
    range: number;
  };
}

/**
 * Firemaking data extracted from item manifest
 */
export interface FiremakingItemData {
  logId: string;
  levelRequired: number;
  xp: number;
  /** Exact authored duration in game ticks. */
  ticks: number;
}

/**
 * Smelting data extracted from item manifest (defined on bars)
 */
export interface SmeltingItemData {
  barItemId: string;
  /** Exact authored inputs, retained so downstream planners do not reconstruct recipes. */
  inputs?: Array<{ itemId: string; quantity: number }>;
  primaryOre: string;
  secondaryOre: string | null;
  coalRequired: number;
  levelRequired: number;
  xp: number;
  successRate: number;
  /** Time in game ticks (600ms per tick). Default: 4 */
  ticks: number;
}

/**
 * Runtime data provider for cooking, firemaking, smelting, and smithing systems.
 * Builds lookup tables from recipe manifest files loaded by DataManager.
 */
export class ProcessingDataProvider {
  private static instance: ProcessingDataProvider;
  private isInitialized = false;

  // Cooking lookup tables (built from recipes/cooking.json)
  private cookingDataMap = new Map<string, CookingItemData>();
  private cookableItemIds = new Set<string>();

  // Firemaking lookup tables (built from recipes/firemaking.json)
  private firemakingDataMap = new Map<string, FiremakingItemData>();
  private burneableLogIds = new Set<string>();

  // Smelting lookup tables (built from recipes/smelting.json)
  private smeltingDataMap = new Map<string, SmeltingItemData>();
  private smeltableBarIds = new Set<string>();

  // Smithing lookup tables (built from recipes/smithing.json)
  private smithingRecipeMap = new Map<string, SmithingRecipeData>();
  private smithableItemIds = new Set<string>();
  private smithingRecipesByBar = new Map<string, SmithingRecipeData[]>();

  // Crafting lookup tables (built from recipes/crafting.json)
  private craftingRecipeMap = new Map<string, CraftingRecipeData>();
  private craftableItemIds = new Set<string>();
  private craftingRecipesByCategory = new Map<string, CraftingRecipeData[]>();
  private craftingInputsByTool = new Map<string, Set<string>>();
  private allCraftingInputIds = new Set<string>();

  // Fletching lookup tables (built from recipes/fletching.json)
  private fletchingRecipeMap = new Map<string, FletchingRecipeData>();
  private fletchableItemIds = new Set<string>();
  private fletchingRecipesByCategory = new Map<string, FletchingRecipeData[]>();
  private fletchingRecipesByInput = new Map<string, FletchingRecipeData[]>();
  private fletchingInputsByTool = new Map<string, Set<string>>();
  private allFletchingInputIds = new Set<string>();

  // Runecrafting lookup tables (built from recipes/runecrafting.json)
  private runecraftingRecipeMap = new Map<string, RunecraftingRecipeData>();
  private runecraftingEssenceTypes = new Set<string>();

  // Loaded recipe manifests (set by DataManager)
  private cookingManifest: CookingManifest | null = null;
  private firemakingManifest: FiremakingManifest | null = null;
  private smeltingManifest: SmeltingManifest | null = null;
  private smithingManifest: SmithingManifest | null = null;
  private craftingManifest: CraftingManifest | null = null;
  private tanningManifest: TanningManifest | null = null;
  private fletchingManifest: FletchingManifest | null = null;
  private runecraftingManifest: RunecraftingManifest | null = null;

  // Tanning lookup tables
  private tanningRecipeMap = new Map<string, TanningRecipeData>();

  // ============================================================================
  // PRE-ALLOCATED BUFFERS (Memory optimization - avoid allocation in hot paths)
  // ============================================================================

  /**
   * Pre-allocated Map for inventory counting operations.
   * Reused across getSmithableItemsFromInventory and getSmeltableBarsFromInventory
   * to avoid creating new Map instances on every call.
   */
  private readonly inventoryCountBuffer = new Map<string, number>();

  private constructor() {
    // Singleton
  }

  public static getInstance(): ProcessingDataProvider {
    if (!ProcessingDataProvider.instance) {
      ProcessingDataProvider.instance = new ProcessingDataProvider();
    }
    return ProcessingDataProvider.instance;
  }

  // ==========================================================================
  // RECIPE MANIFEST LOADING (called by DataManager)
  // ==========================================================================

  /**
   * Load cooking recipes from manifest
   */
  public loadCookingRecipes(manifest: CookingManifest): void {
    this.cookingManifest = manifest;
  }

  /**
   * Load firemaking recipes from manifest
   */
  public loadFiremakingRecipes(manifest: FiremakingManifest): void {
    this.firemakingManifest = manifest;
  }

  /**
   * Load smelting recipes from manifest
   */
  public loadSmeltingRecipes(manifest: SmeltingManifest): void {
    this.smeltingManifest = manifest;
  }

  /**
   * Load smithing recipes from manifest
   */
  public loadSmithingRecipes(manifest: SmithingManifest): void {
    this.smithingManifest = manifest;
  }

  /**
   * Load crafting recipes from manifest
   */
  public loadCraftingRecipes(manifest: CraftingManifest): void {
    this.craftingManifest = manifest;
  }

  /**
   * Load tanning recipes from manifest
   */
  public loadTanningRecipes(manifest: TanningManifest): void {
    this.tanningManifest = manifest;
  }

  /**
   * Load fletching recipes from manifest
   */
  public loadFletchingRecipes(manifest: FletchingManifest): void {
    this.fletchingManifest = manifest;
  }

  /**
   * Load runecrafting recipes from manifest
   */
  public loadRunecraftingRecipes(manifest: RunecraftingManifest): void {
    this.runecraftingManifest = manifest;
  }

  /**
   * Check if recipe manifests are loaded
   */
  public hasRecipeManifests(): boolean {
    return !!(
      this.cookingManifest ||
      this.firemakingManifest ||
      this.smeltingManifest ||
      this.smithingManifest ||
      this.craftingManifest ||
      this.tanningManifest ||
      this.fletchingManifest ||
      this.runecraftingManifest
    );
  }

  /**
   * Initialize the data provider by building lookup tables.
   * Uses recipe manifests if loaded, otherwise falls back to embedded item data.
   * Must be called AFTER DataManager.initialize() has loaded the manifests.
   */
  public initialize(): void {
    if (this.isInitialized) {
      return;
    }

    // Build from recipe manifests if available, else fall back to items
    if (this.cookingManifest) {
      this.buildCookingDataFromManifest();
    } else {
      this.buildCookingDataFromItems();
    }

    if (this.firemakingManifest) {
      this.buildFiremakingDataFromManifest();
    } else {
      this.buildFiremakingDataFromItems();
    }

    if (this.smeltingManifest) {
      this.buildSmeltingDataFromManifest();
    } else {
      this.buildSmeltingDataFromItems();
    }

    if (this.smithingManifest) {
      this.buildSmithingDataFromManifest();
    } else {
      this.buildSmithingDataFromItems();
    }

    if (this.craftingManifest) {
      this.buildCraftingDataFromManifest();
    }

    if (this.tanningManifest) {
      this.buildTanningDataFromManifest();
    }

    if (this.fletchingManifest) {
      this.buildFletchingDataFromManifest();
    }

    if (this.runecraftingManifest) {
      this.buildRunecraftingDataFromManifest();
    }

    this.isInitialized = true;

    console.log(
      `[ProcessingDataProvider] Initialized: ${this.cookableItemIds.size} cookable items, ${this.burneableLogIds.size} burnable logs, ${this.smeltableBarIds.size} smeltable bars, ${this.smithableItemIds.size} smithable items, ${this.craftableItemIds.size} craftable items, ${this.tanningRecipeMap.size} tanning recipes, ${this.fletchingRecipeMap.size} fletching recipes, ${this.runecraftingRecipeMap.size} runecrafting recipes`,
    );
  }

  /**
   * Rebuild data (for hot-reload scenarios)
   */
  public rebuild(): void {
    this.cookingDataMap.clear();
    this.cookableItemIds.clear();
    this.firemakingDataMap.clear();
    this.burneableLogIds.clear();
    this.smeltingDataMap.clear();
    this.smeltableBarIds.clear();
    this.smithingRecipeMap.clear();
    this.smithableItemIds.clear();
    this.smithingRecipesByBar.clear();
    this.craftingRecipeMap.clear();
    this.craftableItemIds.clear();
    this.craftingRecipesByCategory.clear();
    this.craftingInputsByTool.clear();
    this.allCraftingInputIds.clear();
    this.tanningRecipeMap.clear();
    this.fletchingRecipeMap.clear();
    this.fletchableItemIds.clear();
    this.fletchingRecipesByCategory.clear();
    this.fletchingRecipesByInput.clear();
    this.fletchingInputsByTool.clear();
    this.allFletchingInputIds.clear();
    this.runecraftingRecipeMap.clear();
    this.runecraftingEssenceTypes.clear();
    this.isInitialized = false;
    this.initialize();
  }

  // ==========================================================================
  // BUILD FROM RECIPE MANIFESTS (Primary - uses recipe JSON files)
  // ==========================================================================

  /**
   * Build cooking lookup tables from recipes/cooking.json
   */
  private buildCookingDataFromManifest(): void {
    if (!this.cookingManifest) return;

    // Validate recipes array exists
    if (!Array.isArray(this.cookingManifest.recipes)) {
      console.warn(
        "[ProcessingDataProvider] cookingManifest.recipes is missing or invalid, skipping cooking data",
      );
      return;
    }

    const errors: string[] = [];
    for (const recipe of this.cookingManifest.recipes) {
      if (!Number.isSafeInteger(recipe.ticks) || recipe.ticks <= 0) {
        errors.push(
          `[${recipe.raw || "unknown"}] ticks must be a positive integer, got ${recipe.ticks}`,
        );
        continue;
      }
      const cookingData: CookingItemData = {
        rawItemId: recipe.raw,
        cookedItemId: recipe.cooked,
        burntItemId: recipe.burnt,
        levelRequired: recipe.level,
        xp: recipe.xp,
        ticks: recipe.ticks,
        stopBurnLevel: {
          fire: recipe.stopBurnLevel.fire,
          range: recipe.stopBurnLevel.range,
        },
      };
      this.cookingDataMap.set(recipe.raw, cookingData);
      this.cookableItemIds.add(recipe.raw);
    }
    if (errors.length > 0) {
      throw new Error(`Invalid cooking manifest:\n${errors.join("\n")}`);
    }
  }

  /**
   * Build firemaking lookup tables from recipes/firemaking.json
   */
  private buildFiremakingDataFromManifest(): void {
    if (!this.firemakingManifest) return;

    // Validate recipes array exists
    if (!Array.isArray(this.firemakingManifest.recipes)) {
      console.warn(
        "[ProcessingDataProvider] firemakingManifest.recipes is missing or invalid, skipping firemaking data",
      );
      return;
    }

    const errors: string[] = [];
    for (const recipe of this.firemakingManifest.recipes) {
      if (!Number.isSafeInteger(recipe.ticks) || recipe.ticks <= 0) {
        errors.push(
          `[${recipe.log || "unknown"}] ticks must be a positive integer, got ${recipe.ticks}`,
        );
        continue;
      }
      const firemakingData: FiremakingItemData = {
        logId: recipe.log,
        levelRequired: recipe.level,
        xp: recipe.xp,
        ticks: recipe.ticks,
      };
      this.firemakingDataMap.set(recipe.log, firemakingData);
      this.burneableLogIds.add(recipe.log);
    }
    if (errors.length > 0) {
      throw new Error(`Invalid firemaking manifest:\n${errors.join("\n")}`);
    }
  }

  /**
   * Build smelting lookup tables from recipes/smelting.json
   */
  private buildSmeltingDataFromManifest(): void {
    if (!this.smeltingManifest) return;

    // Validate recipes array exists
    if (!Array.isArray(this.smeltingManifest.recipes)) {
      console.warn(
        "[ProcessingDataProvider] smeltingManifest.recipes is missing or invalid, skipping smelting data",
      );
      return;
    }

    for (const recipe of this.smeltingManifest.recipes) {
      // Parse inputs to extract primary ore, secondary ore, and coal count
      let primaryOre = "";
      let secondaryOre: string | null = null;
      let coalRequired = 0;

      for (const input of recipe.inputs) {
        if (input.item === "coal") {
          coalRequired = input.amount;
        } else if (!primaryOre) {
          primaryOre = input.item;
        } else {
          secondaryOre = input.item;
        }
      }

      const smeltingData: SmeltingItemData = {
        barItemId: recipe.output,
        inputs: recipe.inputs.map((input) => ({
          itemId: input.item,
          quantity: input.amount,
        })),
        primaryOre,
        secondaryOre,
        coalRequired,
        levelRequired: recipe.level,
        xp: recipe.xp,
        successRate: recipe.successRate,
        ticks: recipe.ticks ?? SMITHING_CONSTANTS.DEFAULT_SMELTING_TICKS,
      };
      this.smeltingDataMap.set(recipe.output, smeltingData);
      this.smeltableBarIds.add(recipe.output);
    }
  }

  /**
   * Build smithing lookup tables from recipes/smithing.json
   */
  private buildSmithingDataFromManifest(): void {
    if (!this.smithingManifest) return;

    // Validate recipes array exists
    if (!Array.isArray(this.smithingManifest.recipes)) {
      console.warn(
        "[ProcessingDataProvider] smithingManifest.recipes is missing or invalid, skipping smithing data",
      );
      return;
    }

    for (const recipe of this.smithingManifest.recipes) {
      // Get item name from ITEMS map
      const item = ITEMS.get(recipe.output);
      const name = item?.name || recipe.output;

      const recipeData: SmithingRecipeData = {
        itemId: recipe.output,
        name,
        barType: recipe.bar,
        barsRequired: recipe.barsRequired,
        levelRequired: recipe.level,
        xp: recipe.xp,
        category: recipe.category as SmithingCategory,
        ticks: recipe.ticks ?? SMITHING_CONSTANTS.DEFAULT_SMITHING_TICKS,
        outputQuantity: recipe.outputQuantity ?? 1,
      };

      // Add to main map (keyed by output item ID)
      this.smithingRecipeMap.set(recipe.output, recipeData);
      this.smithableItemIds.add(recipe.output);

      // Add to bar-grouped map for UI lookups
      const barRecipes = this.smithingRecipesByBar.get(recipe.bar) || [];
      barRecipes.push(recipeData);
      this.smithingRecipesByBar.set(recipe.bar, barRecipes);
    }
  }

  // ==========================================================================
  // BUILD FROM EMBEDDED ITEM DATA (Fallback - for backwards compatibility)
  // ==========================================================================

  /**
   * Scan ITEMS for items with `cooking` property (fallback)
   */
  private buildCookingDataFromItems(): void {
    for (const [itemId, item] of ITEMS) {
      if (item.cooking) {
        const cookingData: CookingItemData = {
          rawItemId: itemId,
          cookedItemId: item.cooking.cookedItemId,
          burntItemId: item.cooking.burntItemId,
          levelRequired: item.cooking.levelRequired,
          xp: item.cooking.xp,
          ticks: PROCESSING_CONSTANTS.SKILL_MECHANICS.cooking.ticksPerItem,
          stopBurnLevel: {
            fire: item.cooking.stopBurnLevel.fire,
            range: item.cooking.stopBurnLevel.range,
          },
        };
        this.cookingDataMap.set(itemId, cookingData);
        this.cookableItemIds.add(itemId);
      }
    }
  }

  /**
   * Scan ITEMS for items with `firemaking` property (fallback)
   */
  private buildFiremakingDataFromItems(): void {
    for (const [itemId, item] of ITEMS) {
      if (item.firemaking) {
        const firemakingData: FiremakingItemData = {
          logId: itemId,
          levelRequired: item.firemaking.levelRequired,
          xp: item.firemaking.xp,
          ticks: PROCESSING_CONSTANTS.SKILL_MECHANICS.firemaking.baseRollTicks,
        };
        this.firemakingDataMap.set(itemId, firemakingData);
        this.burneableLogIds.add(itemId);
      }
    }
  }

  /**
   * Scan ITEMS for items with `smelting` property (fallback)
   */
  private buildSmeltingDataFromItems(): void {
    for (const [itemId, item] of ITEMS) {
      if (item.smelting) {
        const smeltingData: SmeltingItemData = {
          barItemId: itemId,
          inputs: [
            { itemId: item.smelting.primaryOre, quantity: 1 },
            ...(item.smelting.secondaryOre
              ? [{ itemId: item.smelting.secondaryOre, quantity: 1 }]
              : []),
            ...(item.smelting.coalRequired > 0
              ? [{ itemId: "coal", quantity: item.smelting.coalRequired }]
              : []),
          ],
          primaryOre: item.smelting.primaryOre,
          secondaryOre: item.smelting.secondaryOre || null,
          coalRequired: item.smelting.coalRequired,
          levelRequired: item.smelting.levelRequired,
          xp: item.smelting.xp,
          successRate: item.smelting.successRate,
          ticks:
            item.smelting.ticks ?? SMITHING_CONSTANTS.DEFAULT_SMELTING_TICKS,
        };
        this.smeltingDataMap.set(itemId, smeltingData);
        this.smeltableBarIds.add(itemId);
      }
    }
  }

  /**
   * Scan ITEMS for items with `smithing` property (fallback)
   */
  private buildSmithingDataFromItems(): void {
    for (const [itemId, item] of ITEMS) {
      if (item.smithing) {
        const recipeData: SmithingRecipeData = {
          itemId,
          name: item.name,
          barType: item.smithing.barType,
          barsRequired: item.smithing.barsRequired,
          levelRequired: item.smithing.levelRequired,
          xp: item.smithing.xp,
          category: item.smithing.category as SmithingCategory,
          ticks:
            item.smithing.ticks ?? SMITHING_CONSTANTS.DEFAULT_SMITHING_TICKS,
          outputQuantity: item.smithing.outputQuantity ?? 1,
        };

        // Add to main map (keyed by output item ID)
        this.smithingRecipeMap.set(itemId, recipeData);
        this.smithableItemIds.add(itemId);

        // Add to bar-grouped map for UI lookups
        const barRecipes =
          this.smithingRecipesByBar.get(item.smithing.barType) || [];
        barRecipes.push(recipeData);
        this.smithingRecipesByBar.set(item.smithing.barType, barRecipes);
      }
    }
  }

  // ==========================================================================
  // COOKING ACCESSORS
  // ==========================================================================

  /**
   * Check if an item is cookable
   */
  public isCookable(itemId: string): boolean {
    this.ensureInitialized();
    return this.cookableItemIds.has(itemId);
  }

  /**
   * Get cooking data for a raw food item
   */
  public getCookingData(rawItemId: string): CookingItemData | null {
    this.ensureInitialized();
    return this.cookingDataMap.get(rawItemId) || null;
  }

  /**
   * Get all cookable item IDs (replaces VALID_RAW_FOOD_IDS)
   */
  public getCookableItemIds(): Set<string> {
    this.ensureInitialized();
    return this.cookableItemIds;
  }

  /**
   * Get cooked item ID for a raw food
   */
  public getCookedItemId(rawItemId: string): string | null {
    const data = this.getCookingData(rawItemId);
    return data?.cookedItemId || null;
  }

  /**
   * Get burnt item ID for a raw food
   */
  public getBurntItemId(rawItemId: string): string | null {
    const data = this.getCookingData(rawItemId);
    return data?.burntItemId || null;
  }

  /**
   * Get cooking level requirement
   */
  public getCookingLevel(rawItemId: string): number {
    const data = this.getCookingData(rawItemId);
    return data?.levelRequired ?? 1;
  }

  /**
   * Get cooking XP
   */
  public getCookingXP(rawItemId: string): number {
    const data = this.getCookingData(rawItemId);
    return data?.xp ?? 0;
  }

  /**
   * Get stop burn level for a cooking source
   */
  public getStopBurnLevel(rawItemId: string, source: "fire" | "range"): number {
    const data = this.getCookingData(rawItemId);
    return data?.stopBurnLevel[source] ?? 99;
  }

  // ==========================================================================
  // FIREMAKING ACCESSORS
  // ==========================================================================

  /**
   * Check if an item is a burnable log
   */
  public isBurnableLog(itemId: string): boolean {
    this.ensureInitialized();
    return this.burneableLogIds.has(itemId);
  }

  /**
   * Get firemaking data for a log
   */
  public getFiremakingData(logId: string): FiremakingItemData | null {
    this.ensureInitialized();
    return this.firemakingDataMap.get(logId) || null;
  }

  /**
   * Get all burnable log IDs (replaces VALID_LOG_IDS)
   */
  public getBurnableLogIds(): Set<string> {
    this.ensureInitialized();
    return this.burneableLogIds;
  }

  /**
   * Get firemaking level requirement
   */
  public getFiremakingLevel(logId: string): number {
    const data = this.getFiremakingData(logId);
    return data?.levelRequired ?? 1;
  }

  /**
   * Get firemaking XP
   */
  public getFiremakingXP(logId: string): number {
    const data = this.getFiremakingData(logId);
    return data?.xp ?? 0;
  }

  // ==========================================================================
  // SMELTING ACCESSORS
  // ==========================================================================

  /**
   * Check if an item is a smeltable bar
   */
  public isSmeltableBar(itemId: string): boolean {
    this.ensureInitialized();
    return this.smeltableBarIds.has(itemId);
  }

  /**
   * Get smelting data for a bar
   */
  public getSmeltingData(barItemId: string): SmeltingItemData | null {
    this.ensureInitialized();
    return this.smeltingDataMap.get(barItemId) || null;
  }

  /**
   * Get all smeltable bar IDs
   */
  public getSmeltableBarIds(): Set<string> {
    this.ensureInitialized();
    return this.smeltableBarIds;
  }

  /**
   * Get smelting level requirement for a bar
   */
  public getSmeltingLevel(barItemId: string): number {
    const data = this.getSmeltingData(barItemId);
    return data?.levelRequired ?? 1;
  }

  /**
   * Get smelting XP for a bar
   */
  public getSmeltingXP(barItemId: string): number {
    const data = this.getSmeltingData(barItemId);
    return data?.xp ?? 0;
  }

  /**
   * Get smelting ticks for a bar (time in game ticks)
   */
  public getSmeltingTicks(barItemId: string): number {
    const data = this.getSmeltingData(barItemId);
    return data?.ticks ?? SMITHING_CONSTANTS.DEFAULT_SMELTING_TICKS;
  }

  /**
   * Check if an item is an ore that can be used for smelting.
   * Returns true for primary ores (copper, tin, iron, mithril) and coal.
   */
  public isSmeltableOre(itemId: string): boolean {
    this.ensureInitialized();

    // Check if this ore is used in any smelting recipe
    for (const smeltingData of this.smeltingDataMap.values()) {
      if (smeltingData.primaryOre === itemId) {
        return true;
      }
      if (smeltingData.secondaryOre === itemId) {
        return true;
      }
      // Coal is always smeltable if any recipe uses it
      if (smeltingData.coalRequired > 0 && itemId === "coal") {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all ore IDs that can be used for smelting.
   */
  public getSmeltableOreIds(): Set<string> {
    this.ensureInitialized();
    const oreIds = new Set<string>();

    for (const smeltingData of this.smeltingDataMap.values()) {
      oreIds.add(smeltingData.primaryOre);
      if (smeltingData.secondaryOre) {
        oreIds.add(smeltingData.secondaryOre);
      }
      if (smeltingData.coalRequired > 0) {
        oreIds.add("coal");
      }
    }
    return oreIds;
  }

  /**
   * Build inventory item counts using pre-allocated buffer.
   * Clears and reuses the buffer to avoid allocations.
   *
   * @param inventory - Array of items with itemId and quantity
   * @returns Reference to the internal count buffer (do not store long-term)
   */
  private buildInventoryCounts(
    inventory: Array<{ itemId: string; quantity?: number }>,
  ): Map<string, number> {
    // Clear and reuse pre-allocated buffer
    this.inventoryCountBuffer.clear();

    for (const item of inventory) {
      const current = this.inventoryCountBuffer.get(item.itemId) || 0;
      this.inventoryCountBuffer.set(
        item.itemId,
        current + (item.quantity || 1),
      );
    }

    return this.inventoryCountBuffer;
  }

  /**
   * Get all bars that can be smelted from the given inventory items.
   * Returns bars where player has all required ores and coal.
   *
   * @param inventory - Array of items with itemId and quantity
   * @param smithingLevel - Player's smithing level
   */
  public getSmeltableBarsFromInventory(
    inventory: Array<{ itemId: string; quantity?: number }>,
    smithingLevel: number,
  ): SmeltingItemData[] {
    this.ensureInitialized();

    // Build inventory counts using pre-allocated buffer
    const itemCounts = this.buildInventoryCounts(inventory);

    const result: SmeltingItemData[] = [];

    for (const smeltingData of this.smeltingDataMap.values()) {
      // Check level requirement
      if (smeltingData.levelRequired > smithingLevel) {
        continue;
      }

      // Check primary ore
      const primaryCount = itemCounts.get(smeltingData.primaryOre) || 0;
      if (primaryCount < 1) {
        continue;
      }

      // Check secondary ore (for bronze)
      if (smeltingData.secondaryOre) {
        const secondaryCount = itemCounts.get(smeltingData.secondaryOre) || 0;
        if (secondaryCount < 1) {
          continue;
        }
      }

      // Check coal requirement
      if (smeltingData.coalRequired > 0) {
        const coalCount = itemCounts.get("coal") || 0;
        if (coalCount < smeltingData.coalRequired) {
          continue;
        }
      }

      result.push(smeltingData);
    }

    return result;
  }

  /**
   * Get bars the player has ores for but lacks the smithing level to smelt.
   * Used to provide helpful feedback when no smeltable bars are available.
   */
  public getLevelBlockedBars(
    inventory: Array<{ itemId: string; quantity?: number }>,
    smithingLevel: number,
  ): SmeltingItemData[] {
    this.ensureInitialized();

    const itemCounts = this.buildInventoryCounts(inventory);
    const result: SmeltingItemData[] = [];

    for (const smeltingData of this.smeltingDataMap.values()) {
      // Only interested in bars blocked by level
      if (smeltingData.levelRequired <= smithingLevel) {
        continue;
      }

      // Check if player has the ores for this bar
      const primaryCount = itemCounts.get(smeltingData.primaryOre) || 0;
      if (primaryCount < 1) continue;

      if (smeltingData.secondaryOre) {
        const secondaryCount = itemCounts.get(smeltingData.secondaryOre) || 0;
        if (secondaryCount < 1) continue;
      }

      if (smeltingData.coalRequired > 0) {
        const coalCount = itemCounts.get("coal") || 0;
        if (coalCount < smeltingData.coalRequired) continue;
      }

      result.push(smeltingData);
    }

    return result;
  }

  // ==========================================================================
  // SMITHING ACCESSORS (built from manifest)
  // ==========================================================================

  /**
   * Check if an item is smithable (can be made at an anvil)
   */
  public isSmithableItem(itemId: string): boolean {
    this.ensureInitialized();
    return this.smithableItemIds.has(itemId);
  }

  /**
   * Get smithing recipe data for an output item
   */
  public getSmithingRecipe(itemId: string): SmithingRecipeData | null {
    this.ensureInitialized();
    return this.smithingRecipeMap.get(itemId) || null;
  }

  /**
   * Get all smithable item IDs
   */
  public getSmithableItemIds(): Set<string> {
    this.ensureInitialized();
    return this.smithableItemIds;
  }

  /**
   * Get smithing recipes for a specific bar type
   */
  public getSmithingRecipesForBar(barType: string): SmithingRecipeData[] {
    this.ensureInitialized();
    return this.smithingRecipesByBar.get(barType) || [];
  }

  /**
   * Get a specific smithing recipe by output item ID
   * @deprecated Use getSmithingRecipe instead
   */
  public getSmithingRecipeByItemId(
    itemId: string,
  ): SmithingRecipeData | undefined {
    this.ensureInitialized();
    return this.smithingRecipeMap.get(itemId);
  }

  /**
   * Get all smithing recipes
   */
  public getAllSmithingRecipes(): SmithingRecipeData[] {
    this.ensureInitialized();
    return Array.from(this.smithingRecipeMap.values());
  }

  /**
   * Get smithing level requirement for an item
   */
  public getSmithingLevel(itemId: string): number {
    const recipe = this.getSmithingRecipe(itemId);
    return recipe?.levelRequired ?? 1;
  }

  /**
   * Get smithing XP for an item
   */
  public getSmithingXP(itemId: string): number {
    const recipe = this.getSmithingRecipe(itemId);
    return recipe?.xp ?? 0;
  }

  /**
   * Get smithing ticks for an item (time in game ticks)
   */
  public getSmithingTicks(itemId: string): number {
    const recipe = this.getSmithingRecipe(itemId);
    return recipe?.ticks ?? SMITHING_CONSTANTS.DEFAULT_SMITHING_TICKS;
  }

  /**
   * Get all recipes the player can make with their smithing level
   */
  public getAvailableSmithingRecipes(
    smithingLevel: number,
  ): SmithingRecipeData[] {
    this.ensureInitialized();
    return Array.from(this.smithingRecipeMap.values()).filter(
      (recipe) => recipe.levelRequired <= smithingLevel,
    );
  }

  /**
   * Get recipes grouped by category for a specific bar type (for UI display)
   */
  public getSmithingRecipesByCategory(
    barType: string,
  ): Map<SmithingCategory, SmithingRecipeData[]> {
    const recipes = this.getSmithingRecipesForBar(barType);
    const grouped = new Map<SmithingCategory, SmithingRecipeData[]>();

    for (const recipe of recipes) {
      const existing = grouped.get(recipe.category) || [];
      existing.push(recipe);
      grouped.set(recipe.category, existing);
    }

    return grouped;
  }

  /**
   * Get all items that can be smithed from the given inventory items.
   * Returns recipes where player has required bars AND meets level requirement.
   *
   * @param inventory - Array of items with itemId and quantity
   * @param smithingLevel - Player's smithing level
   * @deprecated Use getSmithableItemsWithAvailability for UI display
   */
  public getSmithableItemsFromInventory(
    inventory: Array<{ itemId: string; quantity?: number }>,
    smithingLevel: number,
  ): SmithingRecipeData[] {
    this.ensureInitialized();

    // Build inventory counts using pre-allocated buffer
    const itemCounts = this.buildInventoryCounts(inventory);

    const result: SmithingRecipeData[] = [];

    for (const recipe of this.smithingRecipeMap.values()) {
      // Check level requirement
      if (recipe.levelRequired > smithingLevel) {
        continue;
      }

      // Check bar requirement
      const barCount = itemCounts.get(recipe.barType) || 0;
      if (barCount < recipe.barsRequired) {
        continue;
      }

      result.push(recipe);
    }

    return result;
  }

  /**
   * Get all smithable items with availability info for UI display.
   * Returns ALL recipes for bar types the player has, with flags indicating:
   * - meetsLevel: whether player has sufficient smithing level
   * - hasBars: whether player has enough bars for this specific recipe
   *
   * Items that don't meet level requirements should be shown greyed out in UI.
   *
   * @param inventory - Array of items with itemId and quantity
   * @param smithingLevel - Player's smithing level
   */
  public getSmithableItemsWithAvailability(
    inventory: Array<{ itemId: string; quantity?: number }>,
    smithingLevel: number,
  ): SmithingRecipeWithAvailability[] {
    this.ensureInitialized();

    // Build inventory counts using pre-allocated buffer
    const itemCounts = this.buildInventoryCounts(inventory);

    // Find all bar types the player has at least 1 of
    const availableBarTypes = new Set<string>();
    for (const [itemId, count] of itemCounts) {
      if (count >= 1 && this.smithingRecipesByBar.has(itemId)) {
        availableBarTypes.add(itemId);
      }
    }

    const result: SmithingRecipeWithAvailability[] = [];

    // Get all recipes for available bar types
    for (const barType of availableBarTypes) {
      const recipes = this.smithingRecipesByBar.get(barType) || [];
      const barCount = itemCounts.get(barType) || 0;

      for (const recipe of recipes) {
        result.push({
          ...recipe,
          meetsLevel: smithingLevel >= recipe.levelRequired,
          hasBars: barCount >= recipe.barsRequired,
        });
      }
    }

    return result;
  }

  // ==========================================================================
  // BUILD CRAFTING DATA FROM MANIFEST
  // ==========================================================================

  /**
   * Build crafting lookup tables from recipes/crafting.json
   */
  private buildCraftingDataFromManifest(): void {
    if (!this.craftingManifest) return;

    // Validate recipes array exists
    if (!Array.isArray(this.craftingManifest.recipes)) {
      console.warn(
        "[ProcessingDataProvider] craftingManifest.recipes is missing or invalid, skipping crafting data",
      );
      return;
    }

    const VALID_STATIONS = new Set(["none", "furnace"]);
    const errors: string[] = [];

    for (let i = 0; i < this.craftingManifest.recipes.length; i++) {
      const recipe = this.craftingManifest.recipes[i];
      const label = recipe.output || `index ${i}`;

      // Required string fields
      if (!recipe.output || typeof recipe.output !== "string") {
        errors.push(`[${label}] missing or invalid 'output'`);
        continue;
      }
      if (!recipe.category || typeof recipe.category !== "string") {
        errors.push(`[${label}] missing or invalid 'category'`);
        continue;
      }

      // Level: integer in [1, 99]
      if (
        typeof recipe.level !== "number" ||
        !Number.isFinite(recipe.level) ||
        recipe.level < 1 ||
        recipe.level > 99
      ) {
        errors.push(`[${label}] level must be 1–99, got ${recipe.level}`);
        continue;
      }

      // XP > 0
      if (
        typeof recipe.xp !== "number" ||
        !Number.isFinite(recipe.xp) ||
        recipe.xp <= 0
      ) {
        errors.push(`[${label}] xp must be > 0, got ${recipe.xp}`);
        continue;
      }

      // Ticks > 0
      if (
        typeof recipe.ticks !== "number" ||
        !Number.isFinite(recipe.ticks) ||
        recipe.ticks <= 0
      ) {
        errors.push(`[${label}] ticks must be > 0, got ${recipe.ticks}`);
        continue;
      }

      // Station must be "none" or "furnace"
      if (!VALID_STATIONS.has(recipe.station)) {
        errors.push(
          `[${label}] station must be 'none' or 'furnace', got '${recipe.station}'`,
        );
        continue;
      }

      // Inputs: non-empty array with valid entries
      if (!Array.isArray(recipe.inputs) || recipe.inputs.length === 0) {
        errors.push(`[${label}] inputs must be a non-empty array`);
        continue;
      }

      let inputsValid = true;
      for (const inp of recipe.inputs) {
        if (!inp.item || typeof inp.item !== "string") {
          errors.push(`[${label}] input has missing/invalid 'item'`);
          inputsValid = false;
          break;
        }
        if (
          typeof inp.amount !== "number" ||
          !Number.isFinite(inp.amount) ||
          inp.amount < 1
        ) {
          errors.push(
            `[${label}] input '${inp.item}' has invalid amount: ${inp.amount}`,
          );
          inputsValid = false;
          break;
        }
        if (!ITEMS.has(inp.item)) {
          errors.push(
            `[${label}] input '${inp.item}' not found in ITEMS manifest`,
          );
          inputsValid = false;
          break;
        }
      }
      if (!inputsValid) continue;

      // Tools: validate each exists in ITEMS
      if (!Array.isArray(recipe.tools)) {
        errors.push(`[${label}] tools must be an array`);
        continue;
      }
      let toolsValid = true;
      for (const tool of recipe.tools) {
        if (!tool || typeof tool !== "string") {
          errors.push(`[${label}] tool has invalid ID`);
          toolsValid = false;
          break;
        }
        if (!ITEMS.has(tool)) {
          errors.push(`[${label}] tool '${tool}' not found in ITEMS manifest`);
          toolsValid = false;
          break;
        }
      }
      if (!toolsValid) continue;

      // Consumables: validate if present
      const consumables = recipe.consumables || [];
      if (!Array.isArray(consumables)) {
        errors.push(`[${label}] consumables must be an array`);
        continue;
      }
      let consumablesValid = true;
      for (const con of consumables) {
        if (!con.item || typeof con.item !== "string") {
          errors.push(`[${label}] consumable has missing/invalid 'item'`);
          consumablesValid = false;
          break;
        }
        if (
          typeof con.uses !== "number" ||
          !Number.isFinite(con.uses) ||
          con.uses < 1
        ) {
          errors.push(
            `[${label}] consumable '${con.item}' has invalid uses: ${con.uses}`,
          );
          consumablesValid = false;
          break;
        }
      }
      if (!consumablesValid) continue;

      // Output item should exist in ITEMS
      if (!ITEMS.has(recipe.output)) {
        errors.push(`[${label}] output not found in ITEMS manifest`);
        continue;
      }

      // ---- Validated — build runtime data ----

      const item = ITEMS.get(recipe.output);
      const name = item?.name || recipe.output;

      const recipeData: CraftingRecipeData = {
        output: recipe.output,
        name,
        category: recipe.category,
        inputs: recipe.inputs,
        tools: recipe.tools,
        consumables: consumables,
        level: recipe.level,
        xp: recipe.xp,
        ticks: recipe.ticks,
        station: recipe.station,
      };

      this.craftingRecipeMap.set(recipe.output, recipeData);
      this.craftableItemIds.add(recipe.output);

      const categoryRecipes =
        this.craftingRecipesByCategory.get(recipe.category) || [];
      categoryRecipes.push(recipeData);
      this.craftingRecipesByCategory.set(recipe.category, categoryRecipes);

      // Build tool → input item lookups for TargetValidator
      for (const tool of recipe.tools) {
        if (!this.craftingInputsByTool.has(tool)) {
          this.craftingInputsByTool.set(tool, new Set<string>());
        }
        const toolInputs = this.craftingInputsByTool.get(tool)!;
        for (const input of recipe.inputs) {
          toolInputs.add(input.item);
          this.allCraftingInputIds.add(input.item);
        }
      }
    }

    if (errors.length > 0) {
      console.warn(
        `[ProcessingDataProvider] Crafting manifest validation errors (${errors.length}):\n  ${errors.join("\n  ")}`,
      );
    }
  }

  // ==========================================================================
  // BUILD FLETCHING DATA FROM MANIFEST
  // ==========================================================================

  /**
   * Build fletching lookup tables from recipes/fletching.json
   */
  private buildFletchingDataFromManifest(): void {
    if (!this.fletchingManifest) return;

    // Validate recipes array exists
    if (!Array.isArray(this.fletchingManifest.recipes)) {
      console.warn(
        "[ProcessingDataProvider] fletchingManifest.recipes is missing or invalid, skipping fletching data",
      );
      return;
    }

    const errors: string[] = [];

    for (let i = 0; i < this.fletchingManifest.recipes.length; i++) {
      const recipe = this.fletchingManifest.recipes[i];
      const label = recipe.output || `index ${i}`;

      // Required string fields
      if (!recipe.output || typeof recipe.output !== "string") {
        errors.push(`[${label}] missing or invalid 'output'`);
        continue;
      }
      if (!recipe.category || typeof recipe.category !== "string") {
        errors.push(`[${label}] missing or invalid 'category'`);
        continue;
      }

      // Skill must be "fletching"
      if (recipe.skill !== "fletching") {
        errors.push(
          `[${label}] skill must be 'fletching', got '${recipe.skill}'`,
        );
        continue;
      }

      // Level: integer in [1, 99]
      if (
        typeof recipe.level !== "number" ||
        !Number.isFinite(recipe.level) ||
        recipe.level < 1 ||
        recipe.level > 99
      ) {
        errors.push(`[${label}] level must be 1–99, got ${recipe.level}`);
        continue;
      }

      // XP > 0
      if (
        typeof recipe.xp !== "number" ||
        !Number.isFinite(recipe.xp) ||
        recipe.xp <= 0
      ) {
        errors.push(`[${label}] xp must be > 0, got ${recipe.xp}`);
        continue;
      }

      // Ticks > 0
      if (
        typeof recipe.ticks !== "number" ||
        !Number.isFinite(recipe.ticks) ||
        recipe.ticks <= 0
      ) {
        errors.push(`[${label}] ticks must be > 0, got ${recipe.ticks}`);
        continue;
      }

      // OutputQuantity >= 1
      const outputQuantity = recipe.outputQuantity ?? 1;
      if (
        typeof outputQuantity !== "number" ||
        !Number.isFinite(outputQuantity) ||
        outputQuantity < 1
      ) {
        errors.push(
          `[${label}] outputQuantity must be >= 1, got ${outputQuantity}`,
        );
        continue;
      }

      // Inputs: non-empty array with valid entries
      if (!Array.isArray(recipe.inputs) || recipe.inputs.length === 0) {
        errors.push(`[${label}] inputs must be a non-empty array`);
        continue;
      }

      let inputsValid = true;
      for (const inp of recipe.inputs) {
        if (!inp.item || typeof inp.item !== "string") {
          errors.push(`[${label}] input has missing/invalid 'item'`);
          inputsValid = false;
          break;
        }
        if (
          typeof inp.amount !== "number" ||
          !Number.isFinite(inp.amount) ||
          inp.amount < 1
        ) {
          errors.push(
            `[${label}] input '${inp.item}' has invalid amount: ${inp.amount}`,
          );
          inputsValid = false;
          break;
        }
        if (!ITEMS.has(inp.item)) {
          errors.push(
            `[${label}] input '${inp.item}' not found in ITEMS manifest`,
          );
          inputsValid = false;
          break;
        }
      }
      if (!inputsValid) continue;

      // Tools: validate each exists in ITEMS (can be empty for no-tool recipes)
      const tools = recipe.tools || [];
      if (!Array.isArray(tools)) {
        errors.push(`[${label}] tools must be an array`);
        continue;
      }
      let toolsValid = true;
      for (const tool of tools) {
        if (!tool || typeof tool !== "string") {
          errors.push(`[${label}] tool has invalid ID`);
          toolsValid = false;
          break;
        }
        if (!ITEMS.has(tool)) {
          errors.push(`[${label}] tool '${tool}' not found in ITEMS manifest`);
          toolsValid = false;
          break;
        }
      }
      if (!toolsValid) continue;

      // Output item should exist in ITEMS
      if (!ITEMS.has(recipe.output)) {
        errors.push(`[${label}] output not found in ITEMS manifest`);
        continue;
      }

      // ---- Validated — build runtime data ----

      const item = ITEMS.get(recipe.output);
      const name = item?.name || recipe.output;

      // Generate unique recipe ID from output + primary input
      const primaryInput = recipe.inputs[0].item;
      const recipeId = `${recipe.output}:${primaryInput}`;

      const recipeData: FletchingRecipeData = {
        recipeId,
        output: recipe.output,
        name,
        outputQuantity,
        category: recipe.category,
        inputs: recipe.inputs,
        tools,
        level: recipe.level,
        xp: recipe.xp,
        ticks: recipe.ticks,
      };

      // Add to main map (keyed by unique recipeId)
      this.fletchingRecipeMap.set(recipeId, recipeData);
      this.fletchableItemIds.add(recipe.output);

      // Category grouping
      const categoryRecipes =
        this.fletchingRecipesByCategory.get(recipe.category) || [];
      categoryRecipes.push(recipeData);
      this.fletchingRecipesByCategory.set(recipe.category, categoryRecipes);

      // Input-based lookups (for filtering when player uses item on item)
      for (const inp of recipe.inputs) {
        const inputRecipes = this.fletchingRecipesByInput.get(inp.item) || [];
        inputRecipes.push(recipeData);
        this.fletchingRecipesByInput.set(inp.item, inputRecipes);
        this.allFletchingInputIds.add(inp.item);
      }

      // Build tool → input item lookups
      for (const tool of tools) {
        if (!this.fletchingInputsByTool.has(tool)) {
          this.fletchingInputsByTool.set(tool, new Set<string>());
        }
        const toolInputs = this.fletchingInputsByTool.get(tool)!;
        for (const input of recipe.inputs) {
          toolInputs.add(input.item);
        }
      }
    }

    if (errors.length > 0) {
      console.warn(
        `[ProcessingDataProvider] Fletching manifest validation errors (${errors.length}):\n  ${errors.join("\n  ")}`,
      );
    }
  }

  // ==========================================================================
  // CRAFTING ACCESSORS
  // ==========================================================================

  /**
   * Get valid crafting input item IDs for a tool.
   * e.g., "needle" → leather, green_dragon_leather, etc.
   * e.g., "chisel" → uncut_sapphire, uncut_emerald, etc.
   */
  public getCraftingInputsForTool(toolId: string): Set<string> {
    this.ensureInitialized();
    return this.craftingInputsByTool.get(toolId) || new Set<string>();
  }

  /**
   * Check if an item is a crafting input in any recipe.
   */
  public isCraftingInput(itemId: string): boolean {
    this.ensureInitialized();
    return this.allCraftingInputIds.has(itemId);
  }

  /**
   * Get the tool ID required for a crafting input item.
   * Returns the first matching tool or null if not found.
   */
  public getCraftingToolForInput(inputItemId: string): string | null {
    this.ensureInitialized();
    for (const [toolId, inputs] of this.craftingInputsByTool) {
      if (inputs.has(inputItemId)) {
        return toolId;
      }
    }
    return null;
  }

  /**
   * Check if an item is craftable
   */
  public isCraftableItem(itemId: string): boolean {
    this.ensureInitialized();
    return this.craftableItemIds.has(itemId);
  }

  /**
   * Get crafting recipe data for an output item
   */
  public getCraftingRecipe(outputItemId: string): CraftingRecipeData | null {
    this.ensureInitialized();
    return this.craftingRecipeMap.get(outputItemId) || null;
  }

  /**
   * Get all craftable item IDs
   */
  public getCraftableItemIds(): Set<string> {
    this.ensureInitialized();
    return this.craftableItemIds;
  }

  /**
   * Get all crafting recipes
   */
  public getAllCraftingRecipes(): CraftingRecipeData[] {
    this.ensureInitialized();
    return Array.from(this.craftingRecipeMap.values());
  }

  /**
   * Get crafting recipes for a specific category
   */
  public getCraftingRecipesByCategory(category: string): CraftingRecipeData[] {
    this.ensureInitialized();
    return this.craftingRecipesByCategory.get(category) || [];
  }

  /**
   * Get all crafting category names
   */
  public getCraftingCategories(): string[] {
    this.ensureInitialized();
    return Array.from(this.craftingRecipesByCategory.keys());
  }

  /**
   * Get crafting level requirement for an item
   */
  public getCraftingLevel(outputItemId: string): number {
    const recipe = this.getCraftingRecipe(outputItemId);
    return recipe?.level ?? 1;
  }

  /**
   * Get crafting XP for an item
   */
  public getCraftingXP(outputItemId: string): number {
    const recipe = this.getCraftingRecipe(outputItemId);
    return recipe?.xp ?? 0;
  }

  /**
   * Get crafting ticks for an item
   */
  public getCraftingTicks(outputItemId: string): number {
    const recipe = this.getCraftingRecipe(outputItemId);
    return recipe?.ticks ?? 3;
  }

  /**
   * Get all recipes the player can make with their crafting level
   */
  public getAvailableCraftingRecipes(
    craftingLevel: number,
  ): CraftingRecipeData[] {
    this.ensureInitialized();
    return Array.from(this.craftingRecipeMap.values()).filter(
      (recipe) => recipe.level <= craftingLevel,
    );
  }

  /**
   * Get crafting recipes that require a specific station
   */
  public getCraftingRecipesByStation(station: string): CraftingRecipeData[] {
    this.ensureInitialized();
    return Array.from(this.craftingRecipeMap.values()).filter(
      (recipe) => recipe.station === station,
    );
  }

  // ==========================================================================
  // TANNING DATA
  // ==========================================================================

  /**
   * Build tanning data from manifest
   */
  private buildTanningDataFromManifest(): void {
    if (!this.tanningManifest) return;

    // Validate recipes array exists
    if (!Array.isArray(this.tanningManifest.recipes)) {
      console.warn(
        "[ProcessingDataProvider] tanningManifest.recipes is missing or invalid, skipping tanning data",
      );
      return;
    }

    for (const recipe of this.tanningManifest.recipes) {
      const data: TanningRecipeData = {
        input: recipe.input,
        output: recipe.output,
        cost: recipe.cost,
        name: recipe.name,
      };
      this.tanningRecipeMap.set(recipe.input, data);
    }
  }

  /**
   * Get tanning recipe by input hide item ID
   */
  public getTanningRecipe(inputItemId: string): TanningRecipeData | null {
    this.ensureInitialized();
    return this.tanningRecipeMap.get(inputItemId) || null;
  }

  /**
   * Get all tanning recipes
   */
  public getAllTanningRecipes(): TanningRecipeData[] {
    this.ensureInitialized();
    return Array.from(this.tanningRecipeMap.values());
  }

  /**
   * Check if an item can be tanned
   */
  public isTannableItem(itemId: string): boolean {
    this.ensureInitialized();
    return this.tanningRecipeMap.has(itemId);
  }

  // ==========================================================================
  // FLETCHING ACCESSORS
  // ==========================================================================

  /**
   * Get valid fletching input item IDs for a tool.
   * e.g., "knife" → logs, oak_logs, willow_logs, etc.
   */
  public getFletchingInputsForTool(toolId: string): Set<string> {
    this.ensureInitialized();
    return this.fletchingInputsByTool.get(toolId) || new Set<string>();
  }

  /**
   * Check if an item is a fletching input in any recipe.
   */
  public isFletchingInput(itemId: string): boolean {
    this.ensureInitialized();
    return this.allFletchingInputIds.has(itemId);
  }

  /**
   * Get the tool ID required for a fletching input item.
   * Returns the first matching tool or null if not found (no-tool recipes return null).
   */
  public getFletchingToolForInput(inputItemId: string): string | null {
    this.ensureInitialized();
    for (const [toolId, inputs] of this.fletchingInputsByTool) {
      if (inputs.has(inputItemId)) {
        return toolId;
      }
    }
    return null;
  }

  /**
   * Check if an item is a fletchable output
   */
  public isFletchableItem(itemId: string): boolean {
    this.ensureInitialized();
    return this.fletchableItemIds.has(itemId);
  }

  /**
   * Get fletching recipe by its unique recipe ID (output:primaryInput)
   */
  public getFletchingRecipe(recipeId: string): FletchingRecipeData | null {
    this.ensureInitialized();
    return this.fletchingRecipeMap.get(recipeId) || null;
  }

  /**
   * Get all fletchable item IDs (output items)
   */
  public getFletchableItemIds(): Set<string> {
    this.ensureInitialized();
    return this.fletchableItemIds;
  }

  /**
   * Get all fletching recipes
   */
  public getAllFletchingRecipes(): FletchingRecipeData[] {
    this.ensureInitialized();
    return Array.from(this.fletchingRecipeMap.values());
  }

  /**
   * Get fletching recipes for a specific category
   */
  public getFletchingRecipesByCategory(
    category: string,
  ): FletchingRecipeData[] {
    this.ensureInitialized();
    return this.fletchingRecipesByCategory.get(category) || [];
  }

  /**
   * Get all fletching category names
   */
  public getFletchingCategories(): string[] {
    this.ensureInitialized();
    return Array.from(this.fletchingRecipesByCategory.keys());
  }

  /**
   * Get all fletching recipes that use a specific input item.
   * Used for filtering when player uses knife on a specific log type.
   */
  public getFletchingRecipesForInput(
    inputItemId: string,
  ): FletchingRecipeData[] {
    this.ensureInitialized();
    return this.fletchingRecipesByInput.get(inputItemId) || [];
  }

  /**
   * Get fletching recipes that match BOTH input items (for item-on-item interactions).
   * e.g., bowstring + shortbow_u → stringing recipe, arrowtips + headless_arrow → tipping recipe.
   */
  public getFletchingRecipesForInputPair(
    itemA: string,
    itemB: string,
  ): FletchingRecipeData[] {
    this.ensureInitialized();
    const recipesA = this.fletchingRecipesByInput.get(itemA) || [];
    return recipesA.filter((recipe) =>
      recipe.inputs.some((inp) => inp.item === itemB),
    );
  }

  // ==========================================================================
  // BUILD RUNECRAFTING DATA FROM MANIFEST
  // ==========================================================================

  /**
   * Build runecrafting lookup tables from recipes/runecrafting.json
   */
  private buildRunecraftingDataFromManifest(): void {
    if (!this.runecraftingManifest) return;

    // Validate recipes array exists
    if (!Array.isArray(this.runecraftingManifest.recipes)) {
      console.warn(
        "[ProcessingDataProvider] runecraftingManifest.recipes is missing or invalid, skipping runecrafting data",
      );
      return;
    }

    const errors: string[] = [];

    for (let i = 0; i < this.runecraftingManifest.recipes.length; i++) {
      const recipe = this.runecraftingManifest.recipes[i];
      const label = recipe.runeType || `index ${i}`;

      // Required string fields
      if (!recipe.runeType || typeof recipe.runeType !== "string") {
        errors.push(`[${label}] missing or invalid 'runeType'`);
        continue;
      }
      if (!recipe.runeItemId || typeof recipe.runeItemId !== "string") {
        errors.push(`[${label}] missing or invalid 'runeItemId'`);
        continue;
      }

      // Level: integer in [1, 99]
      if (
        typeof recipe.levelRequired !== "number" ||
        !Number.isFinite(recipe.levelRequired) ||
        recipe.levelRequired < 1 ||
        recipe.levelRequired > 99
      ) {
        errors.push(
          `[${label}] levelRequired must be 1–99, got ${recipe.levelRequired}`,
        );
        continue;
      }

      // XP > 0
      if (
        typeof recipe.xpPerEssence !== "number" ||
        !Number.isFinite(recipe.xpPerEssence) ||
        recipe.xpPerEssence <= 0
      ) {
        errors.push(
          `[${label}] xpPerEssence must be > 0, got ${recipe.xpPerEssence}`,
        );
        continue;
      }

      // Essence types: non-empty array
      if (
        !Array.isArray(recipe.essenceTypes) ||
        recipe.essenceTypes.length === 0
      ) {
        errors.push(`[${label}] essenceTypes must be a non-empty array`);
        continue;
      }

      // Multi-rune levels: must be an array of numbers (can be empty)
      if (!Array.isArray(recipe.multiRuneLevels)) {
        errors.push(`[${label}] multiRuneLevels must be an array`);
        continue;
      }

      // ---- Validated — build runtime data ----

      const item = ITEMS.get(recipe.runeItemId);
      const name = item?.name || recipe.runeItemId;

      const recipeData: RunecraftingRecipeData = {
        runeType: recipe.runeType,
        runeItemId: recipe.runeItemId,
        name,
        levelRequired: recipe.levelRequired,
        xpPerEssence: recipe.xpPerEssence,
        essenceTypes: recipe.essenceTypes,
        multiRuneLevels: [...recipe.multiRuneLevels].sort((a, b) => a - b),
      };

      this.runecraftingRecipeMap.set(recipe.runeType, recipeData);

      for (const essenceType of recipe.essenceTypes) {
        this.runecraftingEssenceTypes.add(essenceType);
      }
    }

    if (errors.length > 0) {
      console.warn(
        `[ProcessingDataProvider] Runecrafting manifest validation errors (${errors.length}):\n  ${errors.join("\n  ")}`,
      );
    }
  }

  // ==========================================================================
  // RUNECRAFTING ACCESSORS
  // ==========================================================================

  /**
   * Get runecrafting recipe by rune type (e.g., "air", "water", "chaos")
   */
  public getRunecraftingRecipe(
    runeType: string,
  ): RunecraftingRecipeData | null {
    this.ensureInitialized();
    return this.runecraftingRecipeMap.get(runeType) || null;
  }

  /**
   * Get all runecrafting recipes
   */
  public getAllRunecraftingRecipes(): RunecraftingRecipeData[] {
    this.ensureInitialized();
    return Array.from(this.runecraftingRecipeMap.values());
  }

  /**
   * Check if an item is a runecrafting essence
   */
  public isRunecraftingEssence(itemId: string): boolean {
    this.ensureInitialized();
    return this.runecraftingEssenceTypes.has(itemId);
  }

  /**
   * Calculate the multi-rune multiplier for a given rune type and level.
   * Returns how many runes are produced per essence at the given level.
   *
   * In classic MMORPG, each threshold in multiRuneLevels grants +1 rune per essence.
   * e.g., air rune thresholds [11, 22, 33, ...]: at level 22, you get 3 runes per essence.
   */
  public getRunecraftingMultiplier(runeType: string, level: number): number {
    this.ensureInitialized();
    const recipe = this.runecraftingRecipeMap.get(runeType);
    if (!recipe) return 1;

    let multiplier = 1;
    for (const threshold of recipe.multiRuneLevels) {
      if (level >= threshold) {
        multiplier++;
      } else {
        break; // Sorted ascending, no need to check further
      }
    }
    return multiplier;
  }

  // ==========================================================================
  // UTILITY
  // ==========================================================================

  /**
   * Ensure initialization has occurred
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      // Auto-initialize on first access (lazy initialization)
      this.initialize();
    }
  }

  /**
   * Check if provider is ready
   */
  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Get summary for debugging
   */
  public getSummary(): {
    cookableItems: number;
    burnableLogs: number;
    smeltableBars: number;
    smithingRecipes: number;
    craftingRecipes: number;
    tanningRecipes: number;
    fletchingRecipes: number;
    runecraftingRecipes: number;
    isInitialized: boolean;
  } {
    this.ensureInitialized();
    return {
      cookableItems: this.cookableItemIds.size,
      burnableLogs: this.burneableLogIds.size,
      smeltableBars: this.smeltableBarIds.size,
      smithingRecipes: this.smithingRecipeMap.size,
      craftingRecipes: this.craftingRecipeMap.size,
      tanningRecipes: this.tanningRecipeMap.size,
      fletchingRecipes: this.fletchingRecipeMap.size,
      runecraftingRecipes: this.runecraftingRecipeMap.size,
      isInitialized: this.isInitialized,
    };
  }
}

// Export singleton instance
export const processingDataProvider = ProcessingDataProvider.getInstance();
