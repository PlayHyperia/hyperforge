/**
 * ResourceSystem Unit Tests
 *
 * Tests for resource gathering system functionality:
 * - Drop rolling with probability distribution
 * - Resource ID validation (security)
 * - Tool category extraction
 * - Success rate calculation (classic MMORPG-style)
 * - Cycle time calculation
 *
 * Note: Some tests access private methods via bracket notation for unit testing.
 * Module functions (lerpSuccessRate, rollFishDrop) are imported directly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { ResourceSystem } from "../ResourceSystem";
import type { ResourceDrop } from "../../../../types/core/core";
// Import module functions directly for testing
import {
  lerpSuccessRate as lerpSuccessRateModule,
  rollFishDrop as rollFishDropModule,
} from "../gathering/DropRoller";

// Mock world object for testing
const createMockWorld = () => ({
  isServer: true,
  currentTick: 0,
  entities: new Map(),
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  getPlayer: vi.fn(),
  getSystem: vi.fn(),
  $eventBus: {
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    subscribeOnce: vi.fn(() => ({ unsubscribe: vi.fn() })),
    emitEvent: vi.fn(),
    request: vi.fn(),
    respond: vi.fn(),
  },
});

describe("ResourceSystem", () => {
  let system: ResourceSystem;
  let mockWorld: ReturnType<typeof createMockWorld>;

  beforeEach(() => {
    mockWorld = createMockWorld();
    system = new ResourceSystem(mockWorld as never);
  });

  it("retries a deferred fishing area from terrain bake readiness even when walkable probes have zero flags", () => {
    const area = {
      id: "launch_pond",
      bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    };
    const hasBakedWalkabilityAt = vi
      .fn<(x: number, z: number) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const spawnDynamicFishingSpots = vi.fn();
    const internals = system as unknown as {
      terrainSystem: { hasBakedWalkabilityAt: typeof hasBakedWalkabilityAt };
      pendingFishingAreas: Map<string, typeof area>;
      spawnDynamicFishingSpots: typeof spawnDynamicFishingSpots;
    };
    internals.terrainSystem = { hasBakedWalkabilityAt };
    internals.pendingFishingAreas.set(area.id, area);
    internals.spawnDynamicFishingSpots = spawnDynamicFishingSpots;

    system.processGatheringTick(10);
    expect(spawnDynamicFishingSpots).not.toHaveBeenCalled();

    system.processGatheringTick(20);
    expect(spawnDynamicFishingSpots).toHaveBeenCalledWith(area.id, area);
  });

  it("stages the authored launch fishing spot on the visible pond surface before dynamic ecology", async () => {
    await DataManager.getInstance().initialize();
    const registerTerrainResources = vi.fn().mockResolvedValue(undefined);
    const spawnDynamicFishingSpots = vi.fn();
    const internals = system as unknown as {
      terrainSystem: {
        getHeightAt(x: number, z: number): number;
        getWaterBodyRegistry(): {
          getWaterSurfaceAt(x: number, z: number): number;
        };
      };
      initializeWorldAreaResources(): Promise<void>;
      registerTerrainResources: typeof registerTerrainResources;
      spawnDynamicFishingSpots: typeof spawnDynamicFishingSpots;
    };
    internals.terrainSystem = {
      getHeightAt: () => 7,
      getWaterBodyRegistry: () => ({ getWaterSurfaceAt: () => 28.2 }),
    };
    internals.registerTerrainResources = registerTerrainResources;
    internals.spawnDynamicFishingSpots = spawnDynamicFishingSpots;

    await internals.initializeWorldAreaResources();

    const spawnPoints = registerTerrainResources.mock.calls.flatMap(
      ([input]) => input.spawnPoints,
    ) as Array<{
      position: { x: number; y: number; z: number };
      type: string;
      subType?: string;
    }>;
    const authoredFishing = Object.values(ALL_WORLD_AREAS)
      .flatMap((area) => area.resources)
      .find((resource) => resource.resourceId === "fishing_spot_net");
    expect(authoredFishing).toBeDefined();
    expect(spawnPoints).toContainEqual({
      position: {
        x: authoredFishing!.position.x,
        y: 28.2,
        z: authoredFishing!.position.z,
      },
      type: "fish",
      subType: "net",
    });
    expect(spawnDynamicFishingSpots).toHaveBeenCalledWith(
      "haven_pond",
      ALL_WORLD_AREAS.haven_pond,
    );
  });

  // ===== DROP ROLLING TESTS =====
  describe("rollDrop", () => {
    // Access private method for testing
    const rollDrop = (sys: ResourceSystem, drops: ResourceDrop[]) =>
      (
        sys as unknown as { rollDrop: (drops: ResourceDrop[]) => ResourceDrop }
      ).rollDrop(drops);

    it("should return single drop when only one exists", () => {
      const drops: ResourceDrop[] = [
        {
          itemId: "logs",
          itemName: "Logs",
          quantity: 1,
          chance: 1.0,
          xpAmount: 25,
          stackable: true,
        },
      ];
      const result = rollDrop(system, drops);
      expect(result.itemId).toBe("logs");
    });

    it("should respect chance distribution for multiple drops", () => {
      const drops: ResourceDrop[] = [
        {
          itemId: "shrimp",
          itemName: "Raw Shrimp",
          quantity: 1,
          chance: 0.7,
          xpAmount: 10,
          stackable: false,
        },
        {
          itemId: "anchovies",
          itemName: "Raw Anchovies",
          quantity: 1,
          chance: 0.3,
          xpAmount: 15,
          stackable: false,
        },
      ];

      const results: Record<string, number> = { shrimp: 0, anchovies: 0 };
      for (let i = 0; i < 1000; i++) {
        const drop = rollDrop(system, drops);
        results[drop.itemId]++;
      }

      // Should be roughly 70/30 split (allow 15% variance for randomness)
      expect(results.shrimp).toBeGreaterThan(550);
      expect(results.shrimp).toBeLessThan(850);
      expect(results.anchovies).toBeGreaterThan(150);
      expect(results.anchovies).toBeLessThan(450);
    });

    it("should throw for empty drops array", () => {
      expect(() => rollDrop(system, [])).toThrow();
    });

    it("should return first drop if chances don't sum to 1.0", () => {
      const drops: ResourceDrop[] = [
        {
          itemId: "item1",
          itemName: "Item 1",
          quantity: 1,
          chance: 0.1,
          xpAmount: 10,
          stackable: false,
        },
        {
          itemId: "item2",
          itemName: "Item 2",
          quantity: 1,
          chance: 0.1,
          xpAmount: 10,
          stackable: false,
        },
      ];
      // With only 0.2 total chance, ~80% of rolls should fall through to fallback
      let fallbackCount = 0;
      for (let i = 0; i < 100; i++) {
        const result = rollDrop(system, drops);
        if (result.itemId === "item1") fallbackCount++;
      }
      // First item should be returned more often due to fallback
      expect(fallbackCount).toBeGreaterThan(50);
    });
  });

  // ===== RESOURCE ID VALIDATION TESTS =====
  describe("isValidResourceId", () => {
    const isValidResourceId = (sys: ResourceSystem, id: string) =>
      (
        sys as unknown as { isValidResourceId: (id: string) => boolean }
      ).isValidResourceId(id);

    it("should accept valid alphanumeric resource IDs", () => {
      expect(isValidResourceId(system, "tree_normal")).toBe(true);
      expect(isValidResourceId(system, "ore_copper")).toBe(true);
      expect(isValidResourceId(system, "fishing_spot_1")).toBe(true);
      expect(isValidResourceId(system, "resource-123")).toBe(true);
      expect(isValidResourceId(system, "node.tree.oak")).toBe(true);
    });

    it("should reject empty or null resource IDs", () => {
      expect(isValidResourceId(system, "")).toBe(false);
      expect(isValidResourceId(system, null as unknown as string)).toBe(false);
      expect(isValidResourceId(system, undefined as unknown as string)).toBe(
        false,
      );
    });

    it("should reject resource IDs that are too long", () => {
      const longId = "a".repeat(101);
      expect(isValidResourceId(system, longId)).toBe(false);
      // 100 chars should be fine
      const maxLengthId = "a".repeat(100);
      expect(isValidResourceId(system, maxLengthId)).toBe(true);
    });

    it("should reject resource IDs with special characters", () => {
      expect(isValidResourceId(system, "tree<script>")).toBe(false);
      expect(isValidResourceId(system, "ore;DROP TABLE")).toBe(false);
      expect(isValidResourceId(system, "resource\n\ninjection")).toBe(false);
      expect(isValidResourceId(system, "tree/../../../etc")).toBe(false);
      expect(isValidResourceId(system, "node with spaces")).toBe(false);
    });
  });

  // ===== TOOL CATEGORY TESTS =====
  describe("getToolCategory", () => {
    const getToolCategory = (sys: ResourceSystem, toolRequired: string) =>
      (
        sys as unknown as { getToolCategory: (t: string) => string }
      ).getToolCategory(toolRequired);

    it("should extract hatchet category from various axe names", () => {
      expect(getToolCategory(system, "bronze_hatchet")).toBe("hatchet");
      expect(getToolCategory(system, "dragon_axe")).toBe("hatchet");
      expect(getToolCategory(system, "rune_hatchet")).toBe("hatchet");
    });

    it("should extract pickaxe category from various pickaxe names", () => {
      expect(getToolCategory(system, "bronze_pickaxe")).toBe("pickaxe");
      expect(getToolCategory(system, "dragon_pick")).toBe("pickaxe");
      expect(getToolCategory(system, "rune_pickaxe")).toBe("pickaxe");
    });

    it("should return exact tool ID for fishing equipment (rules-accurate)", () => {
      // RULES ACCURACY: Fishing tools require exact matching, not interchangeable
      expect(getToolCategory(system, "fishing_rod")).toBe("fishing_rod");
      expect(getToolCategory(system, "small_fishing_net")).toBe(
        "small_fishing_net",
      );
      expect(getToolCategory(system, "harpoon")).toBe("harpoon");
    });

    it("should fallback to last segment for unknown tools", () => {
      expect(getToolCategory(system, "bronze_hammer")).toBe("hammer");
      expect(getToolCategory(system, "magic_wand")).toBe("wand");
    });
  });

  // ===== TOOL DISPLAY NAME TESTS =====
  describe("getToolDisplayName", () => {
    const getToolDisplayName = (sys: ResourceSystem, category: string) =>
      (
        sys as unknown as { getToolDisplayName: (c: string) => string }
      ).getToolDisplayName(category);

    it("should return friendly names for known categories", () => {
      expect(getToolDisplayName(system, "hatchet")).toBe("hatchet");
      expect(getToolDisplayName(system, "pickaxe")).toBe("pickaxe");
      // rules-accurate: fishing tools use exact IDs, not "fishing equipment"
      expect(getToolDisplayName(system, "fishing_rod")).toBe("fishing rod");
      expect(getToolDisplayName(system, "small_fishing_net")).toBe(
        "small fishing net",
      );
    });

    it("should return category name for unknown categories", () => {
      expect(getToolDisplayName(system, "hammer")).toBe("hammer");
      expect(getToolDisplayName(system, "chisel")).toBe("chisel");
    });
  });

  // ===== SUCCESS RATE CALCULATION TESTS =====
  // NOTE: computeSuccessRate now uses classic MMORPG lerpSuccessRate formula internally.
  // Detailed formula tests are in the lerpSuccessRate test suite.
  // These tests verify the integration works correctly.
  describe("computeSuccessRate", () => {
    const computeSuccessRate = (
      sys: ResourceSystem,
      skillLevel: number,
      skill: string,
      resourceVariant: string,
      toolTier: string | null,
    ) =>
      (
        sys as unknown as {
          computeSuccessRate: (
            skillLevel: number,
            skill: string,
            resourceVariant: string,
            toolTier: string | null,
          ) => number;
        }
      ).computeSuccessRate(skillLevel, skill, resourceVariant, toolTier);

    it("should return rate between 0 and 1", () => {
      const rate = computeSuccessRate(system, 1, "woodcutting", "normal", null);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    });

    it("should increase rate with higher skill level", () => {
      const lowRate = computeSuccessRate(
        system,
        1,
        "woodcutting",
        "normal",
        null,
      );
      const highRate = computeSuccessRate(
        system,
        50,
        "woodcutting",
        "normal",
        null,
      );
      expect(highRate).toBeGreaterThan(lowRate);
    });

    it("should cap at maximum rate (classic combat formula bounds)", () => {
      const rate = computeSuccessRate(
        system,
        99,
        "woodcutting",
        "normal",
        null,
      );
      expect(rate).toBeLessThanOrEqual(1);
    });

    it("should not go below 0", () => {
      const rate = computeSuccessRate(system, 1, "woodcutting", "oak", null);
      expect(rate).toBeGreaterThanOrEqual(0);
    });
  });

  // ===== CYCLE TIME CALCULATION TESTS =====
  // NOTE: computeCycleTicks now uses GATHERING_CONSTANTS.SKILL_MECHANICS
  // which has different behaviors per skill type (fixed-roll vs variable).
  describe("computeCycleTicks", () => {
    const computeCycleTicks = (
      sys: ResourceSystem,
      skill: string,
      tuned: { baseCycleTicks: number; levelRequired: number },
      toolData: { tier: string; speedMultiplier: number } | null,
    ) =>
      (
        sys as unknown as {
          computeCycleTicks: (
            skill: string,
            tuned: { baseCycleTicks: number; levelRequired: number },
            toolData: { tier: string; speedMultiplier: number } | null,
          ) => number;
        }
      ).computeCycleTicks(skill, tuned, toolData);

    it("should return ticks for woodcutting (fixed-roll skill)", () => {
      // Woodcutting uses fixed roll frequency from SKILL_MECHANICS
      const ticks = computeCycleTicks(
        system,
        "woodcutting",
        { baseCycleTicks: 4, levelRequired: 1 },
        null,
      );
      // Should return a positive integer
      expect(ticks).toBeGreaterThanOrEqual(1);
    });

    it("should return ticks for fishing (variable-roll skill)", () => {
      // Fishing uses base cycle ticks from resource
      const ticks = computeCycleTicks(
        system,
        "fishing",
        { baseCycleTicks: 5, levelRequired: 1 },
        null,
      );
      expect(ticks).toBeGreaterThanOrEqual(1);
    });

    it("should never go below minimum cycle ticks", () => {
      const ticks = computeCycleTicks(
        system,
        "mining",
        { baseCycleTicks: 1, levelRequired: 1 },
        { tier: "dragon", speedMultiplier: 0.5 },
      );
      expect(ticks).toBeGreaterThanOrEqual(1);
    });
  });

  // ===== classic MMORPG CATCH RATE FORMULA TESTS =====
  // Tests the module function directly (no ResourceSystem dependency)
  describe("lerpSuccessRate", () => {
    it("should use low value at level 1", () => {
      // At level 1: numerator = 1 + floor(low + 0.5) = 1 + low
      const rate = lerpSuccessRateModule(48, 127, 1);
      // Expected: (1 + floor(48 + 0 + 0.5)) / 256 = 49/256 ≈ 0.191
      expect(rate).toBeCloseTo(49 / 256, 2);
    });

    it("should use high value at level 99", () => {
      // At level 99: numerator = 1 + floor(0 + high + 0.5) = 1 + high
      const rate = lerpSuccessRateModule(48, 127, 99);
      // Expected: (1 + floor(0 + 127 + 0.5)) / 256 = 128/256 = 0.5
      expect(rate).toBeCloseTo(128 / 256, 2);
    });

    it("should interpolate between low and high at mid levels", () => {
      const rate1 = lerpSuccessRateModule(48, 127, 1);
      const rate50 = lerpSuccessRateModule(48, 127, 50);
      const rate99 = lerpSuccessRateModule(48, 127, 99);

      // Mid-level should be between level 1 and level 99
      expect(rate50).toBeGreaterThan(rate1);
      expect(rate50).toBeLessThan(rate99);
    });

    it("should clamp level to valid range [1, 99]", () => {
      const rateAt1 = lerpSuccessRateModule(48, 127, 1);
      const rateAt0 = lerpSuccessRateModule(48, 127, 0);
      const rateAt99 = lerpSuccessRateModule(48, 127, 99);
      const rateAt150 = lerpSuccessRateModule(48, 127, 150);

      expect(rateAt0).toBe(rateAt1); // Clamped to 1
      expect(rateAt150).toBe(rateAt99); // Clamped to 99
    });

    it("should clamp result to [0, 1]", () => {
      // Even with extreme values, rate should be bounded
      const lowRate = lerpSuccessRateModule(0, 0, 1);
      const highRate = lerpSuccessRateModule(255, 255, 99);

      expect(lowRate).toBeGreaterThanOrEqual(0);
      expect(highRate).toBeLessThanOrEqual(1);
    });
  });

  // ===== classic MMORPG PRIORITY FISH ROLLING TESTS =====
  // Tests the module function directly (no ResourceSystem dependency)
  describe("rollFishDrop", () => {
    // Test drops ordered by level requirement (highest first, like classic MMORPG)
    const fishDrops: ResourceDrop[] = [
      {
        itemId: "swordfish",
        itemName: "Raw Swordfish",
        quantity: 1,
        chance: 0.33,
        xpAmount: 100,
        stackable: false,
        levelRequired: 50,
        catchLow: 45,
        catchHigh: 130,
      },
      {
        itemId: "lobster",
        itemName: "Raw Lobster",
        quantity: 1,
        chance: 0.33,
        xpAmount: 90,
        stackable: false,
        levelRequired: 40,
        catchLow: 40,
        catchHigh: 120,
      },
      {
        itemId: "shrimp",
        itemName: "Raw Shrimp",
        quantity: 1,
        chance: 0.34,
        xpAmount: 10,
        stackable: false,
        levelRequired: 1,
        catchLow: 48,
        catchHigh: 127,
      },
    ];

    it("should only catch fish at or below player level", () => {
      // Level 30 player can only catch shrimp (level 1)
      const results: Record<string, number> = {
        swordfish: 0,
        lobster: 0,
        shrimp: 0,
      };

      for (let i = 0; i < 100; i++) {
        const drop = rollFishDropModule(fishDrops, 30);
        results[drop.itemId]++;
      }

      expect(results.swordfish).toBe(0); // Requires level 50
      expect(results.lobster).toBe(0); // Requires level 40
      expect(results.shrimp).toBeGreaterThan(0); // Requires level 1
    });

    it("should catch higher level fish when player meets requirement", () => {
      // Level 50 player can catch all fish, but priority rolling favors higher level fish
      const results: Record<string, number> = {
        swordfish: 0,
        lobster: 0,
        shrimp: 0,
      };

      for (let i = 0; i < 500; i++) {
        const drop = rollFishDropModule(fishDrops, 50);
        results[drop.itemId]++;
      }

      // All fish should be catchable
      expect(results.swordfish).toBeGreaterThan(0);
      expect(results.lobster).toBeGreaterThan(0);
      expect(results.shrimp).toBeGreaterThan(0);
    });

    it("should use priority rolling (higher level fish checked first)", () => {
      // At level 99, swordfish should be caught more often due to priority
      // (swordfish is checked first, if it fails, lobster is checked, then shrimp)
      const results: Record<string, number> = {
        swordfish: 0,
        lobster: 0,
        shrimp: 0,
      };

      for (let i = 0; i < 1000; i++) {
        const drop = rollFishDropModule(fishDrops, 99);
        results[drop.itemId]++;
      }

      // At high level, should catch higher-level fish more often
      // due to priority order and increased catch rates
      expect(results.swordfish).toBeGreaterThan(results.shrimp);
    });

    it("should fallback to lowest level fish when all rolls fail", () => {
      // Even with bad luck, should eventually get the lowest level fish
      const singleDrop: ResourceDrop[] = [
        {
          itemId: "shrimp",
          itemName: "Raw Shrimp",
          quantity: 1,
          chance: 1.0,
          xpAmount: 10,
          stackable: false,
          levelRequired: 1,
          catchLow: 48,
          catchHigh: 127,
        },
      ];

      // Should always succeed with only one fish option
      const drop = rollFishDropModule(singleDrop, 99);
      expect(drop.itemId).toBe("shrimp");
    });
  });

  // NOTE: TOOL_TIERS tests removed - tool tier data is now managed via
  // manifest system (manifest.toolCategory + GatheringToolData) rather than
  // a static TOOL_TIERS constant. Tool behavior is tested implicitly through
  // computeCycleTicks and computeSuccessRate tests.
});
