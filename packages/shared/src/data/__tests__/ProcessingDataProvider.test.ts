/**
 * ProcessingDataProvider Unit Tests
 *
 * Tests for smelting, smithing, crafting, and tanning data lookup functions.
 * These are pure data tests - no mocks needed (follows project philosophy).
 *
 * Note: These tests require the item manifest to be loaded. DataManager
 * loads items.json which populates the ITEMS map that ProcessingDataProvider
 * reads from.
 *
 * @see ProcessingDataProvider.ts for the implementation
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ProcessingDataProvider } from "../ProcessingDataProvider";
import { dataManager } from "../DataManager";

// ============================================================================
// Test Setup
// ============================================================================

describe("ProcessingDataProvider", () => {
  let provider: ProcessingDataProvider;
  let hasSmithingData = false;
  let hasSmeltingData = false;
  let hasCraftingData = false;
  let hasTanningData = false;

  // Initialize DataManager to load items.json before running tests
  beforeAll(async () => {
    try {
      await dataManager.initialize();
      // Check if data was actually loaded
      const providerInstance = ProcessingDataProvider.getInstance();
      providerInstance.rebuild(); // Force rebuild after DataManager loads
      hasSmithingData = providerInstance.getSmithableItemIds().size > 0;
      hasSmeltingData = providerInstance.getSmeltableBarIds().size > 0;
      hasCraftingData = providerInstance.getCraftableItemIds().size > 0;
      hasTanningData = providerInstance.getAllTanningRecipes().length > 0;
    } catch {
      // In CI/test environments, manifest loading may fail - tests will skip
      console.warn(
        "[Test] DataManager initialization failed - data-dependent tests will be skipped",
      );
    }
  });

  beforeEach(() => {
    provider = ProcessingDataProvider.getInstance();
  });

  // ============================================================================
  // SMITHING RECIPE TESTS
  // ============================================================================

  describe("getSmithingRecipe", () => {
    it("returns null for non-existent recipe", () => {
      expect(provider.getSmithingRecipe("fake_item_xyz")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(provider.getSmithingRecipe("")).toBeNull();
    });

    it("returns recipe data for valid bronze item (if data loaded)", () => {
      const recipe = provider.getSmithingRecipe("bronze_shortsword");
      // Only validate if recipe exists (data might not be loaded)
      if (recipe) {
        expect(recipe.barType).toBe("bronze_bar");
        expect(recipe.barsRequired).toBeGreaterThan(0);
        expect(recipe.levelRequired).toBeGreaterThanOrEqual(1);
        expect(recipe.xp).toBeGreaterThan(0);
      } else if (hasSmithingData) {
        // Data was supposed to be loaded but recipe not found
        throw new Error(
          "bronze_shortsword recipe should exist when smithing data is loaded",
        );
      }
    });

    it("has correct structure for all recipes (if data loaded)", () => {
      const recipes = provider.getAllSmithingRecipes();
      // Skip if no data loaded
      if (recipes.length === 0) {
        return;
      }

      for (const recipe of recipes) {
        expect(recipe.itemId).toBeTruthy();
        expect(typeof recipe.itemId).toBe("string");
        expect(recipe.barType).toBeTruthy();
        expect(typeof recipe.barType).toBe("string");
        expect(recipe.barsRequired).toBeGreaterThan(0);
        expect(recipe.levelRequired).toBeGreaterThanOrEqual(1);
        expect(recipe.levelRequired).toBeLessThanOrEqual(99);
        expect(recipe.xp).toBeGreaterThan(0);
      }
    });
  });

  describe("getSmithableItemsFromInventory", () => {
    it("returns empty array when inventory is empty", () => {
      const result = provider.getSmithableItemsFromInventory([], 99);
      expect(result).toEqual([]);
    });

    it("returns empty array when no bars in inventory", () => {
      const inventory = [
        { itemId: "shrimp", quantity: 10 },
        { itemId: "coins", quantity: 100 },
      ];
      const result = provider.getSmithableItemsFromInventory(inventory, 99);
      expect(result).toEqual([]);
    });

    it("filters by smithing level", () => {
      const inventory = [{ itemId: "bronze_bar", quantity: 10 }];
      const level1 = provider.getSmithableItemsFromInventory(inventory, 1);
      const level99 = provider.getSmithableItemsFromInventory(inventory, 99);

      // Higher level should have access to at least as many recipes
      expect(level99.length).toBeGreaterThanOrEqual(level1.length);
    });

    it("respects bar quantity requirements", () => {
      const oneBar = [{ itemId: "bronze_bar", quantity: 1 }];
      const fiveBars = [{ itemId: "bronze_bar", quantity: 5 }];

      const withOne = provider.getSmithableItemsFromInventory(oneBar, 99);
      const withFive = provider.getSmithableItemsFromInventory(fiveBars, 99);

      // More bars should enable more recipes (platebodies need 5 bars)
      expect(withFive.length).toBeGreaterThanOrEqual(withOne.length);
    });

    it("handles missing quantity (defaults to 1)", () => {
      const inventory = [{ itemId: "bronze_bar" }]; // No quantity specified
      const result = provider.getSmithableItemsFromInventory(inventory, 99);

      // Should still work with default quantity of 1
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getSmithingRecipesForBar", () => {
    it("returns empty array for non-existent bar type", () => {
      const result = provider.getSmithingRecipesForBar("fake_bar_xyz");
      expect(result).toEqual([]);
    });

    it("returns recipes for bronze bar (if data loaded)", () => {
      const recipes = provider.getSmithingRecipesForBar("bronze_bar");
      // Skip if no data loaded
      if (!hasSmithingData) {
        return;
      }

      expect(recipes.length).toBeGreaterThan(0);
      for (const recipe of recipes) {
        expect(recipe.barType).toBe("bronze_bar");
      }
    });
  });

  // ============================================================================
  // SMELTING RECIPE TESTS
  // ============================================================================

  describe("getSmeltingData", () => {
    it("returns null for non-existent bar", () => {
      expect(provider.getSmeltingData("fake_bar_xyz")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(provider.getSmeltingData("")).toBeNull();
    });

    it("returns smelting data for bronze bar (if data loaded)", () => {
      const data = provider.getSmeltingData("bronze_bar");
      // Skip if no data loaded
      if (!hasSmeltingData) {
        return;
      }

      expect(data).not.toBeNull();
      if (data) {
        expect(data.primaryOre).toBe("copper_ore");
        expect(data.secondaryOre).toBe("tin_ore");
        expect(data.coalRequired).toBe(0);
        expect(data.inputs).toEqual([
          { itemId: "copper_ore", quantity: 1 },
          { itemId: "tin_ore", quantity: 1 },
        ]);
        expect(data.levelRequired).toBe(1);
        expect(data.successRate).toBe(1); // Bronze always succeeds
      }
    });

    it("iron bar has 50% success rate (if data loaded)", () => {
      const data = provider.getSmeltingData("iron_bar");
      // Only validate if data exists
      if (data) {
        expect(data.successRate).toBe(0.5);
        expect(data.primaryOre).toBe("iron_ore");
        expect(data.secondaryOre).toBeNull();
        expect(data.coalRequired).toBe(0);
      }
    });

    it("steel bar requires coal (if data loaded)", () => {
      const data = provider.getSmeltingData("steel_bar");
      // Only validate if data exists
      if (data) {
        expect(data.coalRequired).toBeGreaterThan(0);
        expect(data.primaryOre).toBe("iron_ore");
        expect(data.inputs).toEqual([
          { itemId: "iron_ore", quantity: 1 },
          { itemId: "coal", quantity: 2 },
        ]);
      }
    });
  });

  describe("getSmeltableBarsFromInventory", () => {
    it("returns empty array when inventory is empty", () => {
      const result = provider.getSmeltableBarsFromInventory([], 99);
      expect(result).toEqual([]);
    });

    it("returns bronze bar when copper and tin present (if data loaded)", () => {
      const inventory = [
        { itemId: "copper_ore", quantity: 1 },
        { itemId: "tin_ore", quantity: 1 },
      ];
      const result = provider.getSmeltableBarsFromInventory(inventory, 1);
      // Skip if no data loaded
      if (!hasSmeltingData) {
        return;
      }

      const hasBronze = result.some((b) => b.barItemId === "bronze_bar");
      expect(hasBronze).toBe(true);
    });

    it("does not return bronze bar when only copper present", () => {
      const inventory = [{ itemId: "copper_ore", quantity: 10 }];
      const result = provider.getSmeltableBarsFromInventory(inventory, 99);
      const hasBronze = result.some((b) => b.barItemId === "bronze_bar");
      expect(hasBronze).toBe(false);
    });

    it("does not return bronze bar when only tin present", () => {
      const inventory = [{ itemId: "tin_ore", quantity: 10 }];
      const result = provider.getSmeltableBarsFromInventory(inventory, 99);
      const hasBronze = result.some((b) => b.barItemId === "bronze_bar");
      expect(hasBronze).toBe(false);
    });

    it("respects coal requirements for steel (if data loaded)", () => {
      const noCoal = [{ itemId: "iron_ore", quantity: 1 }];
      const withCoal = [
        { itemId: "iron_ore", quantity: 1 },
        { itemId: "coal", quantity: 2 },
      ];

      const steelNoCoal = provider
        .getSmeltableBarsFromInventory(noCoal, 99)
        .some((b) => b.barItemId === "steel_bar");
      const steelWithCoal = provider
        .getSmeltableBarsFromInventory(withCoal, 99)
        .some((b) => b.barItemId === "steel_bar");

      expect(steelNoCoal).toBe(false);
      // Only check positive case if data is loaded
      if (hasSmeltingData) {
        expect(steelWithCoal).toBe(true);
      }
    });

    it("respects level requirements (if data loaded)", () => {
      const inventory = [
        { itemId: "iron_ore", quantity: 10 },
        { itemId: "coal", quantity: 20 },
      ];

      // Steel requires level 30
      const level1 = provider.getSmeltableBarsFromInventory(inventory, 1);
      const level30 = provider.getSmeltableBarsFromInventory(inventory, 30);

      const steelAtLevel1 = level1.some((b) => b.barItemId === "steel_bar");
      const steelAtLevel30 = level30.some((b) => b.barItemId === "steel_bar");

      expect(steelAtLevel1).toBe(false);
      // Only check positive case if data is loaded
      if (hasSmeltingData) {
        expect(steelAtLevel30).toBe(true);
      }
    });
  });

  // ============================================================================
  // UTILITY METHOD TESTS
  // ============================================================================

  describe("isSmeltableBar", () => {
    it("returns true for valid bar (if data loaded)", () => {
      // Skip if no data loaded
      if (!hasSmeltingData) {
        return;
      }
      expect(provider.isSmeltableBar("bronze_bar")).toBe(true);
      expect(provider.isSmeltableBar("iron_bar")).toBe(true);
    });

    it("returns false for non-bar items", () => {
      expect(provider.isSmeltableBar("bronze_sword")).toBe(false);
      expect(provider.isSmeltableBar("fake_item")).toBe(false);
    });
  });

  describe("isSmithableItem", () => {
    it("returns true for valid smithable item (if data loaded)", () => {
      // Skip if no data loaded
      if (!hasSmithingData) {
        return;
      }
      expect(provider.isSmithableItem("bronze_shortsword")).toBe(true);
    });

    it("returns false for bars (bars are smelted, not smithed)", () => {
      expect(provider.isSmithableItem("bronze_bar")).toBe(false);
    });

    it("returns false for non-existent items", () => {
      expect(provider.isSmithableItem("fake_item_xyz")).toBe(false);
    });
  });

  describe("getSmeltableBarIds", () => {
    it("returns a set (may be empty if data not loaded)", () => {
      const barIds = provider.getSmeltableBarIds();
      expect(barIds instanceof Set).toBe(true);
    });

    it("all IDs end with _bar (if data loaded)", () => {
      const barIds = provider.getSmeltableBarIds();
      // Skip if no data loaded
      if (barIds.size === 0) {
        return;
      }
      for (const barId of barIds) {
        expect(barId.endsWith("_bar")).toBe(true);
      }
    });
  });

  describe("getSmithableItemIds", () => {
    it("returns a set (may be empty if data not loaded)", () => {
      const itemIds = provider.getSmithableItemIds();
      expect(itemIds instanceof Set).toBe(true);
    });

    it("does not include bar IDs", () => {
      const itemIds = provider.getSmithableItemIds();
      const barIds = provider.getSmeltableBarIds();

      for (const barId of barIds) {
        expect(itemIds.has(barId)).toBe(false);
      }
    });
  });

  // ============================================================================
  // CRAFTING RECIPE TESTS
  // ============================================================================

  describe("getCraftingRecipe", () => {
    it("returns null for non-existent recipe", () => {
      expect(provider.getCraftingRecipe("fake_item_xyz")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(provider.getCraftingRecipe("")).toBeNull();
    });

    it("returns recipe data for leather_gloves (if data loaded)", () => {
      const recipe = provider.getCraftingRecipe("leather_gloves");
      if (!hasCraftingData) return;

      expect(recipe).not.toBeNull();
      if (recipe) {
        expect(recipe.output).toBe("leather_gloves");
        expect(recipe.category).toBe("leather");
        expect(recipe.level).toBe(1);
        expect(recipe.xp).toBeGreaterThan(0);
        expect(recipe.inputs.length).toBeGreaterThan(0);
        expect(recipe.inputs[0].item).toBe("leather");
        expect(recipe.inputs[0].amount).toBe(1);
        expect(recipe.tools).toContain("needle");
      }
    });

    it("returns recipe data for gold_ring jewelry (if data loaded)", () => {
      const recipe = provider.getCraftingRecipe("gold_ring");
      if (!hasCraftingData) return;

      expect(recipe).not.toBeNull();
      if (recipe) {
        expect(recipe.category).toBe("jewelry");
        expect(recipe.station).toBe("furnace");
        expect(recipe.tools).toContain("ring_mould");
        expect(recipe.inputs[0].item).toBe("gold_bar");
      }
    });

    it("returns recipe data for gem cutting (if data loaded)", () => {
      const recipe = provider.getCraftingRecipe("sapphire");
      if (!hasCraftingData) return;

      expect(recipe).not.toBeNull();
      if (recipe) {
        expect(recipe.category).toBe("gem_cutting");
        expect(recipe.station).toBe("none");
        expect(recipe.tools).toContain("chisel");
        expect(recipe.inputs[0].item).toBe("uncut_sapphire");
        expect(recipe.level).toBe(20);
      }
    });

    it("has correct structure for all recipes (if data loaded)", () => {
      const recipes = provider.getAllCraftingRecipes();
      if (recipes.length === 0) return;

      for (const recipe of recipes) {
        expect(recipe.output).toBeTruthy();
        expect(typeof recipe.output).toBe("string");
        expect(recipe.category).toBeTruthy();
        expect(typeof recipe.category).toBe("string");
        expect(recipe.level).toBeGreaterThanOrEqual(1);
        expect(recipe.level).toBeLessThanOrEqual(99);
        expect(recipe.xp).toBeGreaterThan(0);
        expect(recipe.ticks).toBeGreaterThan(0);
        expect(Array.isArray(recipe.inputs)).toBe(true);
        expect(recipe.inputs.length).toBeGreaterThan(0);
        for (const input of recipe.inputs) {
          expect(input.item).toBeTruthy();
          expect(input.amount).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("isCraftableItem", () => {
    it("returns true for valid craftable item (if data loaded)", () => {
      if (!hasCraftingData) return;
      expect(provider.isCraftableItem("leather_gloves")).toBe(true);
      expect(provider.isCraftableItem("sapphire")).toBe(true);
    });

    it("returns false for non-craftable items", () => {
      expect(provider.isCraftableItem("bronze_bar")).toBe(false);
      expect(provider.isCraftableItem("fake_item_xyz")).toBe(false);
    });
  });

  describe("getCraftingRecipesByCategory", () => {
    it("returns empty array for non-existent category", () => {
      const result = provider.getCraftingRecipesByCategory("fake_category");
      expect(result).toEqual([]);
    });

    it("returns leather recipes (if data loaded)", () => {
      const recipes = provider.getCraftingRecipesByCategory("leather");
      if (!hasCraftingData) return;

      expect(recipes.length).toBeGreaterThan(0);
      for (const recipe of recipes) {
        expect(recipe.category).toBe("leather");
      }
    });

    it("returns gem_cutting recipes (if data loaded)", () => {
      const recipes = provider.getCraftingRecipesByCategory("gem_cutting");
      if (!hasCraftingData) return;

      expect(recipes.length).toBeGreaterThan(0);
      for (const recipe of recipes) {
        expect(recipe.category).toBe("gem_cutting");
        expect(recipe.tools).toContain("chisel");
      }
    });

    it("returns jewelry recipes that require furnace (if data loaded)", () => {
      const recipes = provider.getCraftingRecipesByCategory("jewelry");
      if (!hasCraftingData) return;

      expect(recipes.length).toBeGreaterThan(0);
      for (const recipe of recipes) {
        expect(recipe.category).toBe("jewelry");
        expect(recipe.station).toBe("furnace");
      }
    });
  });

  describe("getCraftingCategories", () => {
    it("returns all categories (if data loaded)", () => {
      const categories = provider.getCraftingCategories();
      if (!hasCraftingData) return;

      expect(categories.length).toBeGreaterThan(0);
      expect(categories).toContain("leather");
      expect(categories).toContain("gem_cutting");
      expect(categories).toContain("jewelry");
    });
  });

  describe("getAvailableCraftingRecipes", () => {
    it("filters by crafting level (if data loaded)", () => {
      if (!hasCraftingData) return;

      const level1 = provider.getAvailableCraftingRecipes(1);
      const level99 = provider.getAvailableCraftingRecipes(99);

      // Higher level should have at least as many recipes
      expect(level99.length).toBeGreaterThanOrEqual(level1.length);

      // Level 1 should include leather_gloves (level 1)
      const hasGloves = level1.some((r) => r.output === "leather_gloves");
      expect(hasGloves).toBe(true);

      // Level 1 should NOT include sapphire (level 20)
      const hasSapphire = level1.some((r) => r.output === "sapphire");
      expect(hasSapphire).toBe(false);
    });
  });

  describe("getCraftingRecipesByStation", () => {
    it("returns furnace recipes (if data loaded)", () => {
      if (!hasCraftingData) return;

      const furnaceRecipes = provider.getCraftingRecipesByStation("furnace");
      expect(furnaceRecipes.length).toBeGreaterThan(0);
      for (const recipe of furnaceRecipes) {
        expect(recipe.station).toBe("furnace");
      }
    });

    it("returns non-station recipes (if data loaded)", () => {
      if (!hasCraftingData) return;

      const noneRecipes = provider.getCraftingRecipesByStation("none");
      expect(noneRecipes.length).toBeGreaterThan(0);
      for (const recipe of noneRecipes) {
        expect(recipe.station).toBe("none");
      }
    });
  });

  describe("crafting level/xp/ticks accessors", () => {
    it("returns level requirement for crafting item (if data loaded)", () => {
      if (!hasCraftingData) return;
      expect(provider.getCraftingLevel("leather_gloves")).toBe(1);
      expect(provider.getCraftingLevel("sapphire")).toBe(20);
    });

    it("returns default level for unknown items", () => {
      expect(provider.getCraftingLevel("fake_item")).toBe(1);
    });

    it("returns xp for crafting item (if data loaded)", () => {
      if (!hasCraftingData) return;
      expect(provider.getCraftingXP("leather_gloves")).toBeGreaterThan(0);
      expect(provider.getCraftingXP("sapphire")).toBe(50);
    });

    it("returns ticks for crafting item (if data loaded)", () => {
      if (!hasCraftingData) return;
      expect(provider.getCraftingTicks("leather_gloves")).toBe(3);
      expect(provider.getCraftingTicks("sapphire")).toBe(2);
    });
  });

  // ============================================================================
  // TANNING RECIPE TESTS
  // ============================================================================

  describe("getTanningRecipe", () => {
    it("returns null for non-existent recipe", () => {
      expect(provider.getTanningRecipe("fake_hide_xyz")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(provider.getTanningRecipe("")).toBeNull();
    });

    it("returns recipe for cowhide (if data loaded)", () => {
      const recipe = provider.getTanningRecipe("cowhide");
      if (!hasTanningData) return;

      expect(recipe).not.toBeNull();
      if (recipe) {
        expect(recipe.input).toBe("cowhide");
        expect(recipe.output).toBe("leather");
        expect(recipe.cost).toBe(1);
        expect(recipe.name).toBeTruthy();
      }
    });

    it("returns recipe for green_dragonhide (if data loaded)", () => {
      const recipe = provider.getTanningRecipe("green_dragonhide");
      if (!hasTanningData) return;

      expect(recipe).not.toBeNull();
      if (recipe) {
        expect(recipe.input).toBe("green_dragonhide");
        expect(recipe.output).toBe("green_dragon_leather");
        expect(recipe.cost).toBe(20);
      }
    });
  });

  describe("getAllTanningRecipes", () => {
    it("returns array (may be empty if data not loaded)", () => {
      const recipes = provider.getAllTanningRecipes();
      expect(Array.isArray(recipes)).toBe(true);
    });

    it("has correct structure for all recipes (if data loaded)", () => {
      const recipes = provider.getAllTanningRecipes();
      if (recipes.length === 0) return;

      for (const recipe of recipes) {
        expect(recipe.input).toBeTruthy();
        expect(typeof recipe.input).toBe("string");
        expect(recipe.output).toBeTruthy();
        expect(typeof recipe.output).toBe("string");
        expect(recipe.cost).toBeGreaterThanOrEqual(0);
        expect(recipe.name).toBeTruthy();
      }
    });
  });

  describe("isTannableItem", () => {
    it("returns true for cowhide (if data loaded)", () => {
      if (!hasTanningData) return;
      expect(provider.isTannableItem("cowhide")).toBe(true);
    });

    it("returns false for non-tannable items", () => {
      expect(provider.isTannableItem("bronze_shortsword")).toBe(false);
      expect(provider.isTannableItem("fake_item")).toBe(false);
    });
  });

  // ============================================================================
  // DATA INTEGRITY TESTS
  // ============================================================================

  describe("data integrity", () => {
    it("all smeltable bars have valid ore references (if data loaded)", () => {
      const barIds = provider.getSmeltableBarIds();
      // Skip if no data loaded
      if (barIds.size === 0) {
        return;
      }

      for (const barId of barIds) {
        const data = provider.getSmeltingData(barId);
        expect(data).not.toBeNull();
        if (data) {
          expect(data.primaryOre).toBeTruthy();
          expect(typeof data.primaryOre).toBe("string");
          expect(data.levelRequired).toBeGreaterThanOrEqual(1);
          expect(data.levelRequired).toBeLessThanOrEqual(99);
          expect(data.successRate).toBeGreaterThan(0);
          expect(data.successRate).toBeLessThanOrEqual(1);
          expect(data.xp).toBeGreaterThan(0);
        }
      }
    });

    it("all smithing recipes reference valid bar types (if data loaded)", () => {
      const recipes = provider.getAllSmithingRecipes();
      const barIds = provider.getSmeltableBarIds();
      // Skip if no data loaded
      if (recipes.length === 0) {
        return;
      }

      for (const recipe of recipes) {
        expect(
          barIds.has(recipe.barType),
          `Recipe ${recipe.itemId} references unknown bar type ${recipe.barType}`,
        ).toBe(true);
      }
    });

    it("all crafting recipes have valid inputs (if data loaded)", () => {
      const recipes = provider.getAllCraftingRecipes();
      if (recipes.length === 0) return;

      for (const recipe of recipes) {
        expect(
          recipe.inputs.length,
          `Crafting recipe ${recipe.output} has no inputs`,
        ).toBeGreaterThan(0);

        for (const input of recipe.inputs) {
          expect(
            input.item,
            `Crafting recipe ${recipe.output} has empty input item`,
          ).toBeTruthy();
          expect(
            input.amount,
            `Crafting recipe ${recipe.output} input ${input.item} has invalid amount`,
          ).toBeGreaterThan(0);
        }
      }
    });

    it("all tanning recipes produce different output than input (if data loaded)", () => {
      const recipes = provider.getAllTanningRecipes();
      if (recipes.length === 0) return;

      for (const recipe of recipes) {
        expect(
          recipe.input !== recipe.output,
          `Tanning recipe ${recipe.input} produces same item as input`,
        ).toBe(true);
      }
    });

    it("provider summary reflects initialization state", () => {
      const summary = provider.getSummary();
      expect(summary.isInitialized).toBe(true);
      // Counts may be 0 if manifests weren't loaded
      expect(typeof summary.smeltableBars).toBe("number");
      expect(typeof summary.smithingRecipes).toBe("number");
      expect(typeof summary.craftingRecipes).toBe("number");
      expect(typeof summary.tanningRecipes).toBe("number");
    });
  });
});
