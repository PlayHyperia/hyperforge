/**
 * CombatCalculations Unit Tests
 *
 * Tests for classic MMORPG-style combat calculation functions:
 * - Damage calculation with accuracy system
 * - Attack range checking (melee tile-adjacent)
 * - Attack cooldown checking (tick-based)
 * - Combat timeout checking (tick-based)
 * - Tick conversion utilities
 * - Retaliation delay calculation
 */

import { describe, it, expect } from "vitest";
import {
  calculateDamage,
  isInAttackRange,
  isAttackOnCooldownTicks,
  calculateRetaliationDelay,
  attackSpeedSecondsToTicks,
  attackSpeedMsToTicks,
  shouldCombatTimeoutTicks,
  msToTicks,
  ticksToMs,
  calculateDistance3D,
  calculateDistance2D,
  getStyleBonus,
} from "../CombatCalculations";
import { AttackType } from "../../../types/core/core";
import { SeededRandom } from "../../SeededRandom";

describe("CombatCalculations", () => {
  describe("calculateDamage", () => {
    it("returns valid damage result structure", () => {
      const attacker = { stats: { attack: 10, strength: 10 } };
      const target = { stats: { defense: 1 } };

      const result = calculateDamage(attacker, target, AttackType.MELEE);

      expect(result).toHaveProperty("damage");
      expect(result).toHaveProperty("isCritical");
      expect(result).toHaveProperty("damageType");
      expect(result).toHaveProperty("didHit");
      expect(result.damageType).toBe(AttackType.MELEE);
      expect(result.isCritical).toBe(false); // classic MMORPG has no critical system
    });

    it("returns non-negative damage", () => {
      const attacker = { stats: { attack: 50, strength: 50 } };
      const target = { stats: { defense: 10 } };

      // Run multiple times due to randomness
      for (let i = 0; i < 50; i++) {
        const result = calculateDamage(attacker, target, AttackType.MELEE);
        expect(result.damage).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(result.damage)).toBe(true);
      }
    });

    it("can miss (return 0 damage with didHit=false)", () => {
      // High defense target should cause some misses
      const attacker = { stats: { attack: 1, strength: 1 } };
      const target = { stats: { defense: 99 } };

      let missCount = 0;
      for (let i = 0; i < 100; i++) {
        const result = calculateDamage(attacker, target, AttackType.MELEE);
        if (!result.didHit) {
          missCount++;
          expect(result.damage).toBe(0);
        }
      }

      // Should have some misses against high defense
      expect(missCount).toBeGreaterThan(0);
    });

    it("hits more often with higher attack vs low defense", () => {
      const strongAttacker = { stats: { attack: 99, strength: 50 } };
      const weakTarget = { stats: { defense: 1 } };

      let hitCount = 0;
      for (let i = 0; i < 100; i++) {
        const result = calculateDamage(
          strongAttacker,
          weakTarget,
          AttackType.MELEE,
        );
        if (result.didHit) hitCount++;
      }

      // High attack vs low defense should hit most of the time
      expect(hitCount).toBeGreaterThan(50);
    });

    it("handles mob config attackPower", () => {
      const mob = { config: { attackPower: 20 } };
      const target = { stats: { defense: 1 } };

      const result = calculateDamage(mob, target, AttackType.MELEE);
      expect(result.damage).toBeGreaterThanOrEqual(0);
    });

    it("handles missing stats gracefully", () => {
      const attacker = {};
      const target = {};

      const result = calculateDamage(attacker, target, AttackType.MELEE);
      expect(result.damage).toBeGreaterThanOrEqual(0);
    });

    it("incorporates equipment stats", () => {
      const attacker = { stats: { attack: 50, strength: 50 } };
      const target = { stats: { defense: 10 } };
      const equipment = { attack: 50, strength: 50, defense: 0, ranged: 0 };

      // With equipment bonuses, max hit should be higher
      let maxDamage = 0;
      for (let i = 0; i < 100; i++) {
        const result = calculateDamage(
          attacker,
          target,
          AttackType.MELEE,
          equipment,
        );
        if (result.damage > maxDamage) maxDamage = result.damage;
      }

      // Equipment should allow for higher damage
      expect(maxDamage).toBeGreaterThan(0);
    });

    it("returns attack type in result", () => {
      const attacker = { stats: { attack: 10, strength: 10 } };
      const target = { stats: { defense: 1 } };

      const result = calculateDamage(attacker, target, AttackType.MELEE);
      expect(result.damageType).toBe(AttackType.MELEE);
    });

    // Phase 3: Style bonus tests
    it("applies aggressive style bonus to max hit", () => {
      // Aggressive style adds +3 to effective strength
      // This should result in higher potential damage
      const attacker = { stats: { attack: 60, strength: 60 } };
      const target = { stats: { defense: 1 } };

      let maxWithAggressive = 0;
      let maxWithAccurate = 0;

      // Sample many attacks with aggressive style
      for (let i = 0; i < 100; i++) {
        const result = calculateDamage(
          attacker,
          target,
          AttackType.MELEE,
          undefined,
          "aggressive",
        );
        if (result.damage > maxWithAggressive)
          maxWithAggressive = result.damage;
      }

      // Sample many attacks with accurate style (no strength bonus)
      for (let i = 0; i < 100; i++) {
        const result = calculateDamage(
          attacker,
          target,
          AttackType.MELEE,
          undefined,
          "accurate",
        );
        if (result.damage > maxWithAccurate) maxWithAccurate = result.damage;
      }

      // Aggressive should allow higher max hits due to +3 strength bonus
      // Note: This may not always be true due to RNG, but over 100 samples should be consistent
      expect(maxWithAggressive).toBeGreaterThanOrEqual(maxWithAccurate);
    });

    it("applies controlled style bonus to all combat stats", () => {
      // Controlled gives +1 to attack, strength, and defense
      const attacker = { stats: { attack: 60, strength: 60 } };
      const target = { stats: { defense: 1 } };

      // Should work without errors
      const result = calculateDamage(
        attacker,
        target,
        AttackType.MELEE,
        undefined,
        "controlled",
      );

      expect(result).toHaveProperty("damage");
      expect(result.damage).toBeGreaterThanOrEqual(0);
    });

    it("uses default accurate style when not specified", () => {
      const attacker = { stats: { attack: 60, strength: 60 } };
      const target = { stats: { defense: 1 } };

      // Should use accurate style by default
      const result = calculateDamage(attacker, target, AttackType.MELEE);
      expect(result).toHaveProperty("damage");
    });

    it("replays melee accuracy and damage exactly with an explicit seed", () => {
      const attacker = { stats: { attack: 60, strength: 60 } };
      const target = { stats: { defense: 60, defenseBonus: 20 } };
      const equipment = { attack: 40, strength: 40, defense: 0, ranged: 0 };
      const run = () => {
        const random = new SeededRandom(42);
        return Array.from({ length: 64 }, () =>
          calculateDamage(
            attacker,
            target,
            AttackType.MELEE,
            equipment,
            "aggressive",
            "defensive",
            undefined,
            undefined,
            random,
          ),
        );
      };

      expect(run()).toEqual(run());
    });
  });

  describe("getStyleBonus", () => {
    it("returns +3 attack for accurate style", () => {
      const bonus = getStyleBonus("accurate");
      expect(bonus).toEqual({ attack: 3, strength: 0, defense: 0 });
    });

    it("returns +3 strength for aggressive style", () => {
      const bonus = getStyleBonus("aggressive");
      expect(bonus).toEqual({ attack: 0, strength: 3, defense: 0 });
    });

    it("returns +3 defense for defensive style", () => {
      const bonus = getStyleBonus("defensive");
      expect(bonus).toEqual({ attack: 0, strength: 0, defense: 3 });
    });

    it("returns +1 to all for controlled style", () => {
      const bonus = getStyleBonus("controlled");
      expect(bonus).toEqual({ attack: 1, strength: 1, defense: 1 });
    });
  });

  describe("isInAttackRange", () => {
    // TILE_SIZE = 1.0 in TileSystem
    // tilesAdjacent requires different tiles with Chebyshev distance = 1

    it("returns true for horizontally adjacent tiles (melee)", () => {
      // Attacker at tile (0, 0), target at tile (1, 0) - horizontally adjacent
      const attacker = { x: 0.5, y: 0, z: 0.5 };
      const target = { x: 1.5, y: 0, z: 0.5 };
      expect(isInAttackRange(attacker, target, AttackType.MELEE)).toBe(true);
    });

    it("returns false for diagonally adjacent tiles (range-1 melee rules-accurate)", () => {
      // classic MMORPG: Range-1 melee (standard weapons) EXCLUDES diagonals
      // Only cardinal directions (N, S, E, W) are valid for range-1
      // Diagonal attacks require range-2+ weapons (halberds, spears)
      const attacker = { x: 0.5, y: 0, z: 0.5 };
      const target = { x: 1.5, y: 0, z: 1.5 };
      expect(isInAttackRange(attacker, target, AttackType.MELEE)).toBe(false);
    });

    it("returns true for diagonally adjacent tiles with range-2 melee (halberd)", () => {
      // classic MMORPG: Range-2+ melee (halberds, spears) INCLUDES diagonals
      const attacker = { x: 0.5, y: 0, z: 0.5 };
      const target = { x: 1.5, y: 0, z: 1.5 };
      // Using meleeRange parameter = 2 (halberd range)
      expect(isInAttackRange(attacker, target, AttackType.MELEE, 2)).toBe(true);
    });

    it("returns false for tiles too far apart (melee)", () => {
      // Attacker at tile (0, 0), target at tile (2, 0) - 2 tiles away
      const attacker = { x: 0.5, y: 0, z: 0.5 };
      const target = { x: 2.5, y: 0, z: 0.5 };
      expect(isInAttackRange(attacker, target, AttackType.MELEE)).toBe(false);
    });

    it("returns false for same tile (classic MMORPG requires adjacent, not overlapping)", () => {
      // Both on same tile - cannot attack from same tile
      const attacker = { x: 0.3, y: 0, z: 0.3 };
      const target = { x: 0.7, y: 0, z: 0.7 };
      expect(isInAttackRange(attacker, target, AttackType.MELEE)).toBe(false);
    });

    it("ignores Y position for melee range", () => {
      // Attacker at tile (0, 0), target at tile (1, 0) - adjacent despite Y diff
      const attacker = { x: 0.5, y: 0, z: 0.5 };
      const target = { x: 1.5, y: 100, z: 0.5 };
      expect(isInAttackRange(attacker, target, AttackType.MELEE)).toBe(true);
    });
  });

  describe("isAttackOnCooldownTicks", () => {
    it("returns true when current tick is before next attack tick", () => {
      expect(isAttackOnCooldownTicks(5, 10)).toBe(true);
      expect(isAttackOnCooldownTicks(0, 4)).toBe(true);
    });

    it("returns false when current tick equals next attack tick", () => {
      expect(isAttackOnCooldownTicks(10, 10)).toBe(false);
    });

    it("returns false when current tick is past next attack tick", () => {
      expect(isAttackOnCooldownTicks(15, 10)).toBe(false);
    });
  });

  describe("calculateRetaliationDelay", () => {
    it("calculates correct delay for 4-tick weapon", () => {
      // ceil(4/2) + 1 = 3 ticks
      expect(calculateRetaliationDelay(4)).toBe(3);
    });

    it("calculates correct delay for 3-tick weapon", () => {
      // ceil(3/2) + 1 = 3 ticks
      expect(calculateRetaliationDelay(3)).toBe(3);
    });

    it("calculates correct delay for 5-tick weapon", () => {
      // ceil(5/2) + 1 = 4 ticks
      expect(calculateRetaliationDelay(5)).toBe(4);
    });

    it("calculates correct delay for 6-tick weapon", () => {
      // ceil(6/2) + 1 = 4 ticks
      expect(calculateRetaliationDelay(6)).toBe(4);
    });

    it("calculates correct delay for 7-tick weapon", () => {
      // ceil(7/2) + 1 = 5 ticks
      expect(calculateRetaliationDelay(7)).toBe(5);
    });
  });

  describe("attackSpeedSecondsToTicks", () => {
    it("converts standard 2.4s to 4 ticks", () => {
      expect(attackSpeedSecondsToTicks(2.4)).toBe(4);
    });

    it("converts fast 1.8s to 3 ticks", () => {
      expect(attackSpeedSecondsToTicks(1.8)).toBe(3);
    });

    it("converts slow 3.6s to 6 ticks", () => {
      expect(attackSpeedSecondsToTicks(3.6)).toBe(6);
    });

    it("returns minimum of 1 tick", () => {
      expect(attackSpeedSecondsToTicks(0)).toBe(1);
      expect(attackSpeedSecondsToTicks(0.1)).toBe(1);
      expect(attackSpeedSecondsToTicks(-5)).toBe(1);
    });

    it("rounds to nearest tick", () => {
      // 3.0s = 5000ms / 600ms = 5 ticks exactly
      expect(attackSpeedSecondsToTicks(3.0)).toBe(5);
    });
  });

  describe("attackSpeedMsToTicks", () => {
    it("converts 2400ms to 4 ticks", () => {
      expect(attackSpeedMsToTicks(2400)).toBe(4);
    });

    it("converts 1800ms to 3 ticks", () => {
      expect(attackSpeedMsToTicks(1800)).toBe(3);
    });

    it("converts 3000ms to 5 ticks", () => {
      expect(attackSpeedMsToTicks(3000)).toBe(5);
    });

    it("returns minimum of 1 tick", () => {
      expect(attackSpeedMsToTicks(0)).toBe(1);
      expect(attackSpeedMsToTicks(100)).toBe(1);
      expect(attackSpeedMsToTicks(-1000)).toBe(1);
    });

    it("rounds to nearest tick", () => {
      // 650ms is closer to 1 tick (600ms) than 2 ticks (1200ms)
      expect(attackSpeedMsToTicks(650)).toBe(1);
      // 900ms is closer to 2 ticks (1200ms) than 1 tick (600ms)
      expect(attackSpeedMsToTicks(900)).toBe(2);
    });
  });

  describe("shouldCombatTimeoutTicks", () => {
    it("returns false before timeout tick", () => {
      expect(shouldCombatTimeoutTicks(5, 10)).toBe(false);
    });

    it("returns true at timeout tick", () => {
      expect(shouldCombatTimeoutTicks(10, 10)).toBe(true);
    });

    it("returns true after timeout tick", () => {
      expect(shouldCombatTimeoutTicks(15, 10)).toBe(true);
    });
  });

  describe("msToTicks", () => {
    it("converts milliseconds to ticks correctly", () => {
      expect(msToTicks(600)).toBe(1);
      expect(msToTicks(1200)).toBe(2);
      expect(msToTicks(2400)).toBe(4);
    });

    it("rounds to nearest tick", () => {
      expect(msToTicks(650)).toBe(1);
      expect(msToTicks(900)).toBe(2);
    });

    it("uses default minimum of 1 tick", () => {
      expect(msToTicks(0)).toBe(1);
      expect(msToTicks(100)).toBe(1);
    });

    it("respects custom minimum ticks", () => {
      expect(msToTicks(0, 5)).toBe(5);
      expect(msToTicks(100, 3)).toBe(3);
      expect(msToTicks(10000, 2)).toBe(17); // 10000/600 = 16.67 rounds to 17
    });
  });

  describe("ticksToMs", () => {
    it("converts ticks to milliseconds correctly", () => {
      expect(ticksToMs(1)).toBe(600);
      expect(ticksToMs(4)).toBe(2400);
      expect(ticksToMs(8)).toBe(4800);
    });

    it("handles zero ticks", () => {
      expect(ticksToMs(0)).toBe(0);
    });

    it("is inverse of msToTicks for exact values", () => {
      expect(ticksToMs(msToTicks(2400))).toBe(2400);
      expect(ticksToMs(msToTicks(1800))).toBe(1800);
    });
  });

  describe("calculateDistance3D", () => {
    it("calculates 3D distance correctly", () => {
      const pos1 = { x: 0, y: 0, z: 0 };
      const pos2 = { x: 3, y: 4, z: 0 };
      // sqrt(3^2 + 4^2 + 0^2) = 5
      expect(calculateDistance3D(pos1, pos2)).toBe(5);
    });

    it("returns 0 for same position", () => {
      const pos = { x: 5, y: 10, z: 15 };
      expect(calculateDistance3D(pos, pos)).toBe(0);
    });

    it("includes Y axis in calculation", () => {
      const pos1 = { x: 0, y: 0, z: 0 };
      const pos2 = { x: 0, y: 10, z: 0 };
      expect(calculateDistance3D(pos1, pos2)).toBe(10);
    });
  });

  describe("calculateDistance2D", () => {
    it("calculates 2D distance (ignoring Y)", () => {
      const pos1 = { x: 0, y: 100, z: 0 };
      const pos2 = { x: 3, y: 200, z: 4 };
      // sqrt(3^2 + 4^2) = 5, Y is ignored
      expect(calculateDistance2D(pos1, pos2)).toBe(5);
    });

    it("returns 0 for same XZ position regardless of Y", () => {
      const pos1 = { x: 5, y: 0, z: 10 };
      const pos2 = { x: 5, y: 100, z: 10 };
      expect(calculateDistance2D(pos1, pos2)).toBe(0);
    });
  });
});
