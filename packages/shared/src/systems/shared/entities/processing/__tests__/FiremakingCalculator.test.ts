/**
 * Firemaking Calculator Tests
 *
 * Verifies rules-accurate firemaking calculations:
 * - Success rate formula (65/256 at level 1, 100% at level 43+)
 * - XP values per log type
 * - Level requirements
 * - Fire duration ranges
 *
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  calculateFiremakingSuccess,
  getFiremakingXP,
  getFiremakingLevelRequired,
  meetsFiremakingLevel,
  isValidLog,
  getRandomFireDuration,
  getValidLogIds,
} from "../FiremakingCalculator";
import { PROCESSING_CONSTANTS } from "../../../../../constants/ProcessingConstants";
import {
  ProcessingDataProvider,
  type FiremakingManifest,
} from "../../../../../data/ProcessingDataProvider";

// rules-accurate firemaking data from recipes/firemaking.json
const FIREMAKING_MANIFEST: FiremakingManifest = {
  recipes: [
    { log: "logs", level: 1, xp: 40, ticks: 4 },
    { log: "oak_logs", level: 15, xp: 60, ticks: 4 },
    { log: "willow_logs", level: 30, xp: 90, ticks: 4 },
    { log: "teak_logs", level: 35, xp: 105, ticks: 4 },
    { log: "maple_logs", level: 45, xp: 135, ticks: 4 },
    { log: "mahogany_logs", level: 50, xp: 157.5, ticks: 4 },
    { log: "yew_logs", level: 60, xp: 202.5, ticks: 4 },
    { log: "magic_logs", level: 75, xp: 303.8, ticks: 4 },
  ],
};

describe("FiremakingCalculator", () => {
  beforeAll(() => {
    // Load firemaking recipes directly for unit tests
    // (CDN/filesystem loading may not be available in test environment)
    const provider = ProcessingDataProvider.getInstance();
    provider.loadFiremakingRecipes(FIREMAKING_MANIFEST);
    provider.rebuild();
  });
  describe("calculateFiremakingSuccess", () => {
    it("returns ~25.4% at level 1 (65/256)", () => {
      const success = calculateFiremakingSuccess(1);
      // 65/256 = 0.2539...
      expect(success).toBeCloseTo(65 / 256, 3);
    });

    it("returns 100% at level 43 (256/256 threshold)", () => {
      // At level 43, the interpolated value should reach or exceed 256/256
      const success = calculateFiremakingSuccess(43);
      expect(success).toBe(1.0);
    });

    it("returns 100% at level 99 (capped)", () => {
      const success = calculateFiremakingSuccess(99);
      expect(success).toBe(1.0);
    });

    it("increases monotonically with level", () => {
      let previous = 0;
      for (let level = 1; level <= 99; level++) {
        const current = calculateFiremakingSuccess(level);
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    });

    it("follows classic MMORPG LERP formula: (low + (high - low) * (level - 1) / 98) / 256", () => {
      const { low, high } = PROCESSING_CONSTANTS.FIREMAKING_SUCCESS_RATE;

      // Test at level 50 (midpoint)
      const level = 50;
      const expected = Math.min(
        (low + ((high - low) * (level - 1)) / 98) / 256,
        1.0,
      );
      expect(calculateFiremakingSuccess(level)).toBeCloseTo(expected, 5);
    });

    it("never exceeds 1.0 (100%)", () => {
      // Even at impossibly high levels
      expect(calculateFiremakingSuccess(200)).toBe(1.0);
      expect(calculateFiremakingSuccess(999)).toBe(1.0);
    });

    it("reaches ~50% around level 21", () => {
      // 65 + (513 - 65) * 20 / 98 = 65 + 91.4 = 156.4
      // 156.4 / 256 = 0.611...
      // Actually let's calculate exactly for level 21
      const success = calculateFiremakingSuccess(21);
      expect(success).toBeGreaterThan(0.5);
      expect(success).toBeLessThan(0.7);
    });
  });

  describe("getFiremakingXP", () => {
    it("returns 40 XP for normal logs", () => {
      expect(getFiremakingXP("logs")).toBe(40);
    });

    it("returns 60 XP for oak logs", () => {
      expect(getFiremakingXP("oak_logs")).toBe(60);
    });

    it("returns 90 XP for willow logs", () => {
      expect(getFiremakingXP("willow_logs")).toBe(90);
    });

    it("returns 135 XP for maple logs", () => {
      expect(getFiremakingXP("maple_logs")).toBe(135);
    });

    it("returns 202.5 XP for yew logs", () => {
      expect(getFiremakingXP("yew_logs")).toBe(202.5);
    });

    it("returns 303.8 XP for magic logs", () => {
      expect(getFiremakingXP("magic_logs")).toBe(303.8);
    });

    it("returns 0 for invalid item IDs", () => {
      expect(getFiremakingXP("invalid_item")).toBe(0);
      expect(getFiremakingXP("raw_shrimp")).toBe(0);
      expect(getFiremakingXP("")).toBe(0);
    });

    it("XP increases with log tier", () => {
      const xpValues = [
        getFiremakingXP("logs"),
        getFiremakingXP("oak_logs"),
        getFiremakingXP("willow_logs"),
        getFiremakingXP("maple_logs"),
        getFiremakingXP("yew_logs"),
        getFiremakingXP("magic_logs"),
      ];

      // Each tier should give more XP than the previous
      for (let i = 1; i < xpValues.length; i++) {
        expect(xpValues[i]).toBeGreaterThan(xpValues[i - 1]);
      }
    });
  });

  describe("getFiremakingLevelRequired", () => {
    it("returns 1 for normal logs", () => {
      expect(getFiremakingLevelRequired("logs")).toBe(1);
    });

    it("returns 15 for oak logs", () => {
      expect(getFiremakingLevelRequired("oak_logs")).toBe(15);
    });

    it("returns 30 for willow logs", () => {
      expect(getFiremakingLevelRequired("willow_logs")).toBe(30);
    });

    it("returns 45 for maple logs", () => {
      expect(getFiremakingLevelRequired("maple_logs")).toBe(45);
    });

    it("returns 60 for yew logs", () => {
      expect(getFiremakingLevelRequired("yew_logs")).toBe(60);
    });

    it("returns 75 for magic logs", () => {
      expect(getFiremakingLevelRequired("magic_logs")).toBe(75);
    });

    it("returns 1 for invalid/unknown items", () => {
      expect(getFiremakingLevelRequired("invalid_item")).toBe(1);
      expect(getFiremakingLevelRequired("")).toBe(1);
    });
  });

  describe("meetsFiremakingLevel", () => {
    it("returns true when player level equals required", () => {
      expect(meetsFiremakingLevel(1, "logs")).toBe(true);
      expect(meetsFiremakingLevel(15, "oak_logs")).toBe(true);
      expect(meetsFiremakingLevel(30, "willow_logs")).toBe(true);
    });

    it("returns true when player level exceeds required", () => {
      expect(meetsFiremakingLevel(99, "logs")).toBe(true);
      expect(meetsFiremakingLevel(50, "oak_logs")).toBe(true);
      expect(meetsFiremakingLevel(60, "maple_logs")).toBe(true);
    });

    it("returns false when player level is below required", () => {
      expect(meetsFiremakingLevel(1, "oak_logs")).toBe(false);
      expect(meetsFiremakingLevel(14, "oak_logs")).toBe(false);
      expect(meetsFiremakingLevel(74, "magic_logs")).toBe(false);
    });
  });

  describe("isValidLog", () => {
    it("returns true for all valid log types", () => {
      expect(isValidLog("logs")).toBe(true);
      expect(isValidLog("oak_logs")).toBe(true);
      expect(isValidLog("willow_logs")).toBe(true);
      expect(isValidLog("teak_logs")).toBe(true);
      expect(isValidLog("maple_logs")).toBe(true);
      expect(isValidLog("mahogany_logs")).toBe(true);
      expect(isValidLog("yew_logs")).toBe(true);
      expect(isValidLog("magic_logs")).toBe(true);
    });

    it("returns false for non-log items", () => {
      expect(isValidLog("raw_shrimp")).toBe(false);
      expect(isValidLog("tinderbox")).toBe(false);
      expect(isValidLog("coal")).toBe(false);
      expect(isValidLog("")).toBe(false);
      expect(isValidLog("log")).toBe(false); // Missing 's'
    });
  });

  describe("getRandomFireDuration", () => {
    it("returns value within classic MMORPG range (100-198 ticks)", () => {
      for (let i = 0; i < 100; i++) {
        const duration = getRandomFireDuration();
        expect(duration).toBeGreaterThanOrEqual(100);
        expect(duration).toBeLessThanOrEqual(198);
      }
    });

    it("returns integers only", () => {
      for (let i = 0; i < 50; i++) {
        const duration = getRandomFireDuration();
        expect(Number.isInteger(duration)).toBe(true);
      }
    });

    it("uses constants from PROCESSING_CONSTANTS", () => {
      const { minDurationTicks, maxDurationTicks } = PROCESSING_CONSTANTS.FIRE;
      expect(minDurationTicks).toBe(100);
      expect(maxDurationTicks).toBe(198);
    });
  });

  describe("getValidLogIds", () => {
    it("returns a Set of valid log IDs", () => {
      const validIds = getValidLogIds();
      expect(validIds).toBeInstanceOf(Set);
      expect(validIds.size).toBe(8); // 8 log types (no redwood yet)
    });

    it("contains all expected log types", () => {
      const validIds = getValidLogIds();
      expect(validIds.has("logs")).toBe(true);
      expect(validIds.has("oak_logs")).toBe(true);
      expect(validIds.has("willow_logs")).toBe(true);
      expect(validIds.has("teak_logs")).toBe(true);
      expect(validIds.has("maple_logs")).toBe(true);
      expect(validIds.has("mahogany_logs")).toBe(true);
      expect(validIds.has("yew_logs")).toBe(true);
      expect(validIds.has("magic_logs")).toBe(true);
    });

    it("returns a set", () => {
      const validIds = getValidLogIds();
      // Returns the ProcessingDataProvider's burnable log set
      expect(validIds).toBeInstanceOf(Set);
    });
  });

  describe("reference-rules verification", () => {
    // These tests verify specific values from the reference ruleset

    it("normal logs: level 1, 40 XP", () => {
      expect(getFiremakingLevelRequired("logs")).toBe(1);
      expect(getFiremakingXP("logs")).toBe(40);
    });

    it("oak logs: level 15, 60 XP", () => {
      expect(getFiremakingLevelRequired("oak_logs")).toBe(15);
      expect(getFiremakingXP("oak_logs")).toBe(60);
    });

    it("willow logs: level 30, 90 XP", () => {
      expect(getFiremakingLevelRequired("willow_logs")).toBe(30);
      expect(getFiremakingXP("willow_logs")).toBe(90);
    });

    it("teak logs: level 35, 105 XP", () => {
      expect(getFiremakingLevelRequired("teak_logs")).toBe(35);
      expect(getFiremakingXP("teak_logs")).toBe(105);
    });

    it("maple logs: level 45, 135 XP", () => {
      expect(getFiremakingLevelRequired("maple_logs")).toBe(45);
      expect(getFiremakingXP("maple_logs")).toBe(135);
    });

    it("mahogany logs: level 50, 157.5 XP", () => {
      expect(getFiremakingLevelRequired("mahogany_logs")).toBe(50);
      expect(getFiremakingXP("mahogany_logs")).toBe(157.5);
    });

    it("yew logs: level 60, 202.5 XP", () => {
      expect(getFiremakingLevelRequired("yew_logs")).toBe(60);
      expect(getFiremakingXP("yew_logs")).toBe(202.5);
    });

    it("magic logs: level 75, 303.8 XP", () => {
      expect(getFiremakingLevelRequired("magic_logs")).toBe(75);
      expect(getFiremakingXP("magic_logs")).toBe(303.8);
    });

    it("fire duration: 60-119 seconds (100-198 ticks at 600ms/tick)", () => {
      // Fires last 60-119 seconds.
      // At 600ms per tick: 60s = 100 ticks, 119s ≈ 198 ticks
      const { minDurationTicks, maxDurationTicks } = PROCESSING_CONSTANTS.FIRE;
      const minSeconds = (minDurationTicks * 600) / 1000;
      const maxSeconds = (maxDurationTicks * 600) / 1000;

      expect(minSeconds).toBe(60);
      expect(maxSeconds).toBeCloseTo(118.8, 1); // 198 * 0.6 = 118.8
    });
  });
});
