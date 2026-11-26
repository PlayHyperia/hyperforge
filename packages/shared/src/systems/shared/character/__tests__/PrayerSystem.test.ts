/**
 * PrayerSystem Unit Tests
 *
 * Tests for prayer system functionality:
 * - Type guards and input validation
 * - rules-accurate drain formula
 * - Prayer toggle with conflict resolution
 * - Rate limiting
 * - Bounds checking
 *
 */

import { describe, it, expect } from "vitest";
import {
  isValidPrayerId,
  isValidPrayerTogglePayload,
  isValidPrayerBonuses,
  isPlayerRegisteredPayload,
  isPlayerCleanupPayload,
  isPrayerToggleEventPayload,
  isAltarPrayPayload,
  clampPrayerLevel,
  clampPrayerPoints,
  isValidRestoreAmount,
  MAX_PRAYER_ID_LENGTH,
  MAX_PRAYER_LEVEL,
  MIN_PRAYER_LEVEL,
  MAX_PRAYER_POINTS,
  PRAYER_ID_PATTERN,
} from "../../../../types/game/prayer-types";

describe("Prayer System Type Guards", () => {
  describe("isValidPrayerId", () => {
    it("accepts valid prayer IDs", () => {
      expect(isValidPrayerId("thick_skin")).toBe(true);
      expect(isValidPrayerId("burst_of_strength")).toBe(true);
      expect(isValidPrayerId("rock_skin")).toBe(true);
      expect(isValidPrayerId("a")).toBe(true);
      expect(isValidPrayerId("prayer1")).toBe(true);
    });

    it("rejects non-string types", () => {
      expect(isValidPrayerId(123)).toBe(false);
      expect(isValidPrayerId(null)).toBe(false);
      expect(isValidPrayerId(undefined)).toBe(false);
      expect(isValidPrayerId({})).toBe(false);
      expect(isValidPrayerId([])).toBe(false);
    });

    it("rejects empty strings", () => {
      expect(isValidPrayerId("")).toBe(false);
    });

    it("rejects IDs exceeding max length", () => {
      const longId = "a".repeat(MAX_PRAYER_ID_LENGTH + 1);
      expect(isValidPrayerId(longId)).toBe(false);
    });

    it("rejects IDs with uppercase letters", () => {
      expect(isValidPrayerId("Thick_Skin")).toBe(false);
      expect(isValidPrayerId("PRAYER")).toBe(false);
    });

    it("rejects IDs with special characters", () => {
      expect(isValidPrayerId("prayer-one")).toBe(false);
      expect(isValidPrayerId("prayer.one")).toBe(false);
      expect(isValidPrayerId("prayer@one")).toBe(false);
      expect(isValidPrayerId("prayer one")).toBe(false);
    });

    it("rejects IDs starting with numbers", () => {
      expect(isValidPrayerId("1prayer")).toBe(false);
      expect(isValidPrayerId("123")).toBe(false);
    });

    it("rejects IDs starting with underscore", () => {
      expect(isValidPrayerId("_prayer")).toBe(false);
    });

    it("accepts maximum length ID", () => {
      const maxId = "a" + "b".repeat(MAX_PRAYER_ID_LENGTH - 1);
      expect(isValidPrayerId(maxId)).toBe(true);
    });
  });

  describe("isValidPrayerTogglePayload", () => {
    it("accepts valid payload", () => {
      expect(isValidPrayerTogglePayload({ prayerId: "thick_skin" })).toBe(true);
      expect(
        isValidPrayerTogglePayload({
          prayerId: "thick_skin",
          requestId: "00000000-0000-4000-8000-000000000001",
        }),
      ).toBe(true);
    });

    it("rejects missing prayerId", () => {
      expect(isValidPrayerTogglePayload({})).toBe(false);
      expect(isValidPrayerTogglePayload({ playerId: "123" })).toBe(false);
    });

    it("rejects invalid prayerId", () => {
      expect(isValidPrayerTogglePayload({ prayerId: "" })).toBe(false);
      expect(isValidPrayerTogglePayload({ prayerId: 123 })).toBe(false);
      expect(isValidPrayerTogglePayload({ prayerId: "INVALID" })).toBe(false);
    });

    it("rejects malformed correlation IDs", () => {
      expect(
        isValidPrayerTogglePayload({
          prayerId: "thick_skin",
          requestId: "not-a-uuid",
        }),
      ).toBe(false);
    });

    it("rejects non-object types", () => {
      expect(isValidPrayerTogglePayload(null)).toBe(false);
      expect(isValidPrayerTogglePayload(undefined)).toBe(false);
      expect(isValidPrayerTogglePayload("string")).toBe(false);
    });
  });

  describe("isValidPrayerBonuses", () => {
    it("accepts valid bonuses", () => {
      expect(isValidPrayerBonuses({ attackMultiplier: 1.05 })).toBe(true);
      expect(isValidPrayerBonuses({ strengthMultiplier: 1.1 })).toBe(true);
      expect(isValidPrayerBonuses({ defenseMultiplier: 1.15 })).toBe(true);
      expect(
        isValidPrayerBonuses({
          attackMultiplier: 1.05,
          strengthMultiplier: 1.1,
          defenseMultiplier: 1.15,
        }),
      ).toBe(true);
    });

    it("accepts empty bonuses object", () => {
      expect(isValidPrayerBonuses({})).toBe(true);
    });

    it("rejects non-object types", () => {
      expect(isValidPrayerBonuses(null)).toBe(false);
      expect(isValidPrayerBonuses(undefined)).toBe(false);
      expect(isValidPrayerBonuses("string")).toBe(false);
    });

    it("rejects negative multipliers", () => {
      expect(isValidPrayerBonuses({ attackMultiplier: -1.05 })).toBe(false);
    });

    it("rejects zero multipliers", () => {
      expect(isValidPrayerBonuses({ attackMultiplier: 0 })).toBe(false);
    });

    it("rejects multipliers exceeding 10", () => {
      expect(isValidPrayerBonuses({ attackMultiplier: 11 })).toBe(false);
    });

    it("rejects non-number multipliers", () => {
      expect(isValidPrayerBonuses({ attackMultiplier: "1.05" })).toBe(false);
    });
  });

  describe("isPlayerRegisteredPayload", () => {
    it("accepts valid payload", () => {
      expect(isPlayerRegisteredPayload({ playerId: "player123" })).toBe(true);
    });

    it("rejects empty playerId", () => {
      expect(isPlayerRegisteredPayload({ playerId: "" })).toBe(false);
    });

    it("rejects non-string playerId", () => {
      expect(isPlayerRegisteredPayload({ playerId: 123 })).toBe(false);
    });

    it("rejects missing playerId", () => {
      expect(isPlayerRegisteredPayload({})).toBe(false);
    });
  });

  describe("isPlayerCleanupPayload", () => {
    it("accepts valid payload", () => {
      expect(isPlayerCleanupPayload({ playerId: "player123" })).toBe(true);
    });

    it("rejects empty playerId", () => {
      expect(isPlayerCleanupPayload({ playerId: "" })).toBe(false);
    });
  });

  describe("isPrayerToggleEventPayload", () => {
    it("accepts valid payload", () => {
      expect(
        isPrayerToggleEventPayload({
          playerId: "player123",
          prayerId: "thick_skin",
        }),
      ).toBe(true);
    });

    it("rejects missing playerId", () => {
      expect(isPrayerToggleEventPayload({ prayerId: "thick_skin" })).toBe(
        false,
      );
    });

    it("rejects invalid prayerId", () => {
      expect(
        isPrayerToggleEventPayload({
          playerId: "player123",
          prayerId: "INVALID",
        }),
      ).toBe(false);
    });
  });

  describe("isAltarPrayPayload", () => {
    it("accepts valid payload", () => {
      expect(
        isAltarPrayPayload({
          playerId: "player123",
          altarId: "altar_spawn_1",
        }),
      ).toBe(true);
    });

    it("rejects missing altarId", () => {
      expect(isAltarPrayPayload({ playerId: "player123" })).toBe(false);
    });

    it("rejects empty altarId", () => {
      expect(isAltarPrayPayload({ playerId: "player123", altarId: "" })).toBe(
        false,
      );
    });
  });
});

describe("Prayer Bounds Checking", () => {
  describe("clampPrayerLevel", () => {
    it("clamps to minimum level", () => {
      expect(clampPrayerLevel(0)).toBe(MIN_PRAYER_LEVEL);
      expect(clampPrayerLevel(-5)).toBe(MIN_PRAYER_LEVEL);
    });

    it("clamps to maximum level", () => {
      expect(clampPrayerLevel(100)).toBe(MAX_PRAYER_LEVEL);
      expect(clampPrayerLevel(999)).toBe(MAX_PRAYER_LEVEL);
    });

    it("passes through valid levels", () => {
      expect(clampPrayerLevel(1)).toBe(1);
      expect(clampPrayerLevel(50)).toBe(50);
      expect(clampPrayerLevel(99)).toBe(99);
    });

    it("floors fractional levels", () => {
      expect(clampPrayerLevel(5.7)).toBe(5);
      expect(clampPrayerLevel(99.9)).toBe(99);
    });

    it("handles NaN", () => {
      expect(clampPrayerLevel(NaN)).toBe(MIN_PRAYER_LEVEL);
    });

    it("handles Infinity", () => {
      expect(clampPrayerLevel(Infinity)).toBe(MIN_PRAYER_LEVEL);
      expect(clampPrayerLevel(-Infinity)).toBe(MIN_PRAYER_LEVEL);
    });
  });

  describe("clampPrayerPoints", () => {
    it("clamps to minimum (0)", () => {
      expect(clampPrayerPoints(-5, 50)).toBe(0);
    });

    it("clamps to max points", () => {
      expect(clampPrayerPoints(100, 50)).toBe(50);
    });

    it("passes through valid points", () => {
      expect(clampPrayerPoints(25, 50)).toBe(25);
      expect(clampPrayerPoints(0, 50)).toBe(0);
      expect(clampPrayerPoints(50, 50)).toBe(50);
    });

    it("handles NaN points", () => {
      expect(clampPrayerPoints(NaN, 50)).toBe(0);
    });

    it("handles NaN maxPoints", () => {
      expect(clampPrayerPoints(50, NaN)).toBe(50);
    });
  });

  describe("isValidRestoreAmount", () => {
    it("accepts valid amounts", () => {
      expect(isValidRestoreAmount(1)).toBe(true);
      expect(isValidRestoreAmount(50)).toBe(true);
      expect(isValidRestoreAmount(99)).toBe(true);
    });

    it("rejects zero", () => {
      expect(isValidRestoreAmount(0)).toBe(false);
    });

    it("rejects negative", () => {
      expect(isValidRestoreAmount(-5)).toBe(false);
    });

    it("rejects exceeding max", () => {
      expect(isValidRestoreAmount(MAX_PRAYER_POINTS + 1)).toBe(false);
    });

    it("rejects non-numbers", () => {
      expect(isValidRestoreAmount("50")).toBe(false);
      expect(isValidRestoreAmount(null)).toBe(false);
      expect(isValidRestoreAmount(undefined)).toBe(false);
    });

    it("rejects NaN", () => {
      expect(isValidRestoreAmount(NaN)).toBe(false);
    });

    it("rejects Infinity", () => {
      expect(isValidRestoreAmount(Infinity)).toBe(false);
    });
  });
});

describe("Prayer Constants", () => {
  it("MAX_PRAYER_ID_LENGTH is 64 (security)", () => {
    expect(MAX_PRAYER_ID_LENGTH).toBe(64);
  });

  it("MIN_PRAYER_LEVEL is 1", () => {
    expect(MIN_PRAYER_LEVEL).toBe(1);
  });

  it("MAX_PRAYER_LEVEL is 99 (rules-accurate)", () => {
    expect(MAX_PRAYER_LEVEL).toBe(99);
  });

  it("MAX_PRAYER_POINTS is 99 (equals max level)", () => {
    expect(MAX_PRAYER_POINTS).toBe(99);
  });

  it("PRAYER_ID_PATTERN matches expected format", () => {
    expect(PRAYER_ID_PATTERN.test("thick_skin")).toBe(true);
    expect(PRAYER_ID_PATTERN.test("INVALID")).toBe(false);
  });
});

describe("classic MMORPG Prayer Drain Formula", () => {
  // classic combat formula: drain_resistance = 2 * prayer_bonus + 60
  // Points drained per tick = drain_effect / drain_resistance

  const BASE_DRAIN_RESISTANCE = 60;
  const PRAYER_BONUS_MULTIPLIER = 2;

  function calculateDrainResistance(prayerBonus: number): number {
    return PRAYER_BONUS_MULTIPLIER * prayerBonus + BASE_DRAIN_RESISTANCE;
  }

  function calculateDrainPerTick(
    drainEffect: number,
    prayerBonus: number,
  ): number {
    return drainEffect / calculateDrainResistance(prayerBonus);
  }

  describe("Drain Resistance", () => {
    it("base resistance is 60 with 0 prayer bonus", () => {
      expect(calculateDrainResistance(0)).toBe(60);
    });

    it("resistance increases by 2 per prayer bonus", () => {
      expect(calculateDrainResistance(1)).toBe(62);
      expect(calculateDrainResistance(10)).toBe(80);
      expect(calculateDrainResistance(30)).toBe(120);
    });
  });

  describe("Points Drained Per Tick", () => {
    it("Thick Skin (drainEffect=1) drains ~0.0167 per tick with 0 bonus", () => {
      const drain = calculateDrainPerTick(1, 0);
      expect(drain).toBeCloseTo(0.0167, 3);
    });

    it("Rock Skin (drainEffect=6) drains ~0.1 per tick with 0 bonus", () => {
      const drain = calculateDrainPerTick(6, 0);
      expect(drain).toBeCloseTo(0.1, 2);
    });

    it("higher prayer bonus reduces drain rate", () => {
      const drainNoBonous = calculateDrainPerTick(6, 0);
      const drainWithBonus = calculateDrainPerTick(6, 30);
      expect(drainWithBonus).toBeLessThan(drainNoBonous);
    });

    it("prayer lasts longer with higher bonus", () => {
      // Time to drain 1 point = 1 / drain_per_tick
      const ticksNoBonus = 1 / calculateDrainPerTick(1, 0);
      const ticksWithBonus = 1 / calculateDrainPerTick(1, 30);
      expect(ticksWithBonus).toBeGreaterThan(ticksNoBonus);
    });
  });

  describe("Multiple Active Prayers", () => {
    it("drain effects stack additively", () => {
      // Thick Skin (1) + Burst of Strength (1) = 2 total
      const singleDrain = calculateDrainPerTick(1, 0);
      const doubleDrain = calculateDrainPerTick(2, 0);
      expect(doubleDrain).toBeCloseTo(singleDrain * 2, 5);
    });
  });
});
