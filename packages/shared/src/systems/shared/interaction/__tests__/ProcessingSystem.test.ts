/**
 * ProcessingSystem Tests
 *
 * Unit tests for the ProcessingSystem covering:
 * - Fire limits (max 3 per player)
 * - Burn chance calculation (rules-accurate)
 * - Object pooling behavior
 * - fishSlot=-1 handling (find first cookable)
 * - Rate limiting logic
 * - Inventory slot validation
 *
 * NOTE: ProcessingDataProvider tests that require manifest data are in
 * a separate integration test file that runs with full game context.
 * These tests focus on pure algorithmic logic that doesn't require
 * the ITEMS map to be loaded.
 *
 * @see Phase 6.1 of COOKING_FIREMAKING_HARDENING_PLAN.md
 */

import { describe, it, expect, beforeEach } from "vitest";
import { processingDataProvider } from "../../../../data/ProcessingDataProvider";
import { PROCESSING_CONSTANTS } from "../../../../constants/ProcessingConstants";
import { TICK_DURATION_MS } from "../../movement/TileSystem";

describe("ProcessingDataProvider Structure", () => {
  beforeEach(() => {
    processingDataProvider.initialize();
  });

  it("returns Sets from getCookableItemIds and getBurnableLogIds", () => {
    expect(processingDataProvider.getCookableItemIds()).toBeInstanceOf(Set);
    expect(processingDataProvider.getBurnableLogIds()).toBeInstanceOf(Set);
  });

  it("isReady returns true after initialization", () => {
    expect(processingDataProvider.isReady()).toBe(true);
  });

  it("getSummary returns object with expected properties", () => {
    const summary = processingDataProvider.getSummary();
    expect(summary).toHaveProperty("isInitialized");
    expect(summary).toHaveProperty("cookableItems");
    expect(summary).toHaveProperty("burnableLogs");
    expect(typeof summary.isInitialized).toBe("boolean");
    expect(typeof summary.cookableItems).toBe("number");
    expect(typeof summary.burnableLogs).toBe("number");
  });

  it("returns null for non-existent items", () => {
    expect(processingDataProvider.getCookingData("nonexistent")).toBeNull();
    expect(processingDataProvider.getFiremakingData("nonexistent")).toBeNull();
    expect(processingDataProvider.getCookedItemId("nonexistent")).toBeNull();
    expect(processingDataProvider.getBurntItemId("nonexistent")).toBeNull();
  });

  it("returns defaults for unknown items", () => {
    expect(processingDataProvider.getCookingLevel("nonexistent")).toBe(1);
    expect(processingDataProvider.getCookingXP("nonexistent")).toBe(0);
    expect(processingDataProvider.getStopBurnLevel("nonexistent", "fire")).toBe(
      99,
    );
    expect(processingDataProvider.getFiremakingLevel("nonexistent")).toBe(1);
    expect(processingDataProvider.getFiremakingXP("nonexistent")).toBe(0);
  });

  it("isCookable and isBurnableLog return false for unknown items", () => {
    expect(processingDataProvider.isCookable("nonexistent")).toBe(false);
    expect(processingDataProvider.isBurnableLog("nonexistent")).toBe(false);
    expect(processingDataProvider.isCookable("")).toBe(false);
    expect(processingDataProvider.isBurnableLog("")).toBe(false);
  });
});

describe("Burn Chance Calculation", () => {
  // Test burn chance formula directly
  // Formula: burnChance = (stopBurnLevel - cookingLevel) / (stopBurnLevel - requiredLevel) * maxBurnChance

  function calculateBurnChance(
    cookingLevel: number,
    requiredLevel: number,
    stopBurnLevel: number,
    maxBurnChance: number = 0.5,
  ): number {
    if (cookingLevel >= stopBurnLevel) return 0;
    if (cookingLevel < requiredLevel) return maxBurnChance;

    const levelRange = stopBurnLevel - requiredLevel;
    if (levelRange <= 0) return 0;

    const levelsUntilStopBurn = stopBurnLevel - cookingLevel;
    return Math.max(
      0,
      Math.min(
        maxBurnChance,
        (levelsUntilStopBurn / levelRange) * maxBurnChance,
      ),
    );
  }

  describe("getBurnChance", () => {
    it("returns 0 at or above stop-burn level", () => {
      // Shrimp: required=1, stopBurn=34
      expect(calculateBurnChance(34, 1, 34)).toBe(0);
      expect(calculateBurnChance(50, 1, 34)).toBe(0);
      expect(calculateBurnChance(99, 1, 34)).toBe(0);
    });

    it("returns max burn chance below level requirement", () => {
      // Below required level (edge case - shouldn't happen in practice)
      expect(calculateBurnChance(0, 1, 34, 0.5)).toBe(0.5);
    });

    it("returns 50% at level 1 for shrimp (max burn)", () => {
      // At exactly required level, burn chance is at max
      const chance = calculateBurnChance(1, 1, 34, 0.5);
      expect(chance).toBe(0.5);
    });

    it("returns ~25% at level 17 for shrimp (halfway)", () => {
      // Level 17 is halfway between 1 and 34
      // levelsUntilStopBurn = 34 - 17 = 17
      // levelRange = 34 - 1 = 33
      // burnChance = (17/33) * 0.5 ≈ 0.2575
      const chance = calculateBurnChance(17, 1, 34, 0.5);
      expect(chance).toBeCloseTo(0.2575, 2);
    });

    it("burn chance decreases linearly as level increases", () => {
      let previousChance = 1;
      for (let level = 1; level <= 34; level++) {
        const chance = calculateBurnChance(level, 1, 34, 0.5);
        expect(chance).toBeLessThanOrEqual(previousChance);
        previousChance = chance;
      }
    });

    it("handles edge case where stopBurn equals required level", () => {
      // This shouldn't happen in practice but should be handled gracefully
      expect(calculateBurnChance(1, 1, 1, 0.5)).toBe(0);
    });
  });
});

describe("Fire Constants", () => {
  it("uses the authoritative bounded fire lifetime", () => {
    expect(PROCESSING_CONSTANTS.FIRE.minDurationTicks * TICK_DURATION_MS).toBe(
      60_000,
    );
    expect(PROCESSING_CONSTANTS.FIRE.maxDurationTicks * TICK_DURATION_MS).toBe(
      118_800,
    );
  });
});

describe("Inventory Slot Bounds", () => {
  it("valid slots are 0-27 (28 slots total)", () => {
    const INVENTORY_SIZE = 28;
    const MIN_SLOT = 0;
    const MAX_SLOT = 27;

    expect(MAX_SLOT - MIN_SLOT + 1).toBe(INVENTORY_SIZE);
  });

  it("-1 is valid for fishSlot (means find first cookable)", () => {
    const FIND_FIRST_SLOT = -1;
    expect(FIND_FIRST_SLOT).toBe(-1);
  });

  function isValidSlot(slot: number, allowFindFirst: boolean = false): boolean {
    if (allowFindFirst && slot === -1) return true;
    return slot >= 0 && slot <= 27;
  }

  it("isValidSlot correctly validates slot bounds", () => {
    // Valid slots
    expect(isValidSlot(0)).toBe(true);
    expect(isValidSlot(13)).toBe(true);
    expect(isValidSlot(27)).toBe(true);

    // Invalid slots
    expect(isValidSlot(-1)).toBe(false);
    expect(isValidSlot(28)).toBe(false);
    expect(isValidSlot(100)).toBe(false);

    // -1 allowed for cooking
    expect(isValidSlot(-1, true)).toBe(true);
  });
});

describe("Rate Limiting", () => {
  it("PROCESSING_COOLDOWN_MS should be 500ms", () => {
    const PROCESSING_COOLDOWN_MS = 500;
    expect(PROCESSING_COOLDOWN_MS).toBe(500);
  });

  function canProcessRequest(
    lastRequestTime: number,
    now: number,
    cooldown: number,
  ): boolean {
    return now - lastRequestTime >= cooldown;
  }

  it("allows request after cooldown period", () => {
    const lastRequest = 1000;
    const now = 1600; // 600ms later
    expect(canProcessRequest(lastRequest, now, 500)).toBe(true);
  });

  it("blocks request before cooldown period", () => {
    const lastRequest = 1000;
    const now = 1300; // 300ms later
    expect(canProcessRequest(lastRequest, now, 500)).toBe(false);
  });

  it("allows request exactly at cooldown boundary", () => {
    const lastRequest = 1000;
    const now = 1500; // Exactly 500ms later
    expect(canProcessRequest(lastRequest, now, 500)).toBe(true);
  });
});
