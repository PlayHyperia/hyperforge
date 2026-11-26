/**
 * Processing Constants
 *
 * Centralized constants for firemaking and cooking systems.
 * rules-accurate timing and mechanics.
 *
 * NOTE: Item-specific data (XP values, level requirements, burn levels)
 * is now defined in the item manifest (items.json) and accessed via
 * ProcessingDataProvider. This file contains only mechanic constants.
 *
 * @see packages/server/world/assets/manifests/items.json for item data
 * @see packages/shared/src/data/ProcessingDataProvider.ts for runtime access
 */

export const PROCESSING_CONSTANTS = {
  // === Skill-Specific Mechanics (rules-accurate) ===
  /**
   * FIREMAKING: Fixed 4-tick attempts, level affects success rate
   * COOKING: Fixed 4-tick per item, level affects burn rate
   */
  SKILL_MECHANICS: {
    firemaking: {
      type: "fixed-roll-retry-on-fail" as const,
      /** Attempt to light every 4 ticks */
      baseRollTicks: 4,
      /** On failure, retry immediately (next 4 ticks) */
      retryOnFail: true,
      /** Success rate varies by level */
      levelAffectsSuccess: true,
    },
    cooking: {
      type: "fixed-tick-continuous" as const,
      /** Each item takes 4 ticks to cook */
      ticksPerItem: 4,
      /** Level affects burn chance, not speed */
      levelAffectsBurn: true,
      levelAffectsSpeed: false,
    },
  } as const,

  // === Firemaking Success Rates (classic combat formula) ===
  /**
   * classic MMORPG Firemaking: 65/256 at level 1, 513/256 at level 99
   * 100% success reached at level 43
   *
   */
  FIREMAKING_SUCCESS_RATE: {
    low: 65, // Numerator at level 1 (65/256 = 25.4%)
    high: 513, // Numerator at level 99 (capped to 100%)
  },

  // === Fire Properties ===
  FIRE: {
    /** Minimum fire duration in ticks (60 seconds). */
    minDurationTicks: 100,
    /** Maximum fire duration in ticks (119 seconds). */
    maxDurationTicks: 198,
    /** Maximum fires per player */
    maxFiresPerPlayer: 3,
    /** Maximum fires per tile area (performance limit) */
    maxFiresPerArea: 20,
    /** Fire interaction range in tiles */
    interactionRange: 1,
  },

  // === Walk-West Movement Priority (classic MMORPG) ===
  /**
   * After lighting fire, player walks in this priority order:
   * 1. West (preferred)
   * 2. East (if west blocked)
   * 3. South (if east blocked)
   * 4. North (if south blocked)
   */
  FIRE_WALK_PRIORITY: ["west", "east", "south", "north"] as const,

  // === Timing ===
  // NOTE: All game logic uses TICKS, not milliseconds
  // RATE_LIMIT_MS is ONLY for anti-spam (uses Date.now())
  RATE_LIMIT_MS: 600, // Anti-spam cooldown (ms) - matches GatheringConstants pattern
  MINIMUM_CYCLE_TICKS: 2, // Min ticks between actions (game logic)
} as const;

// === Type Exports ===
export type CookingSourceType = "fire" | "range";
