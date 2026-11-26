/**
 * Gathering Constants
 *
 * Centralized constants for the resource gathering system.
 * rules-accurate timing and gathering values.
 *
 */

export const GATHERING_CONSTANTS = {
  // === Skill-Specific Mechanics (rules-accurate) ===
  /**
   * Different gathering skills have fundamentally different mechanics in classic MMORPG.
   *
   * WOODCUTTING: Fixed roll frequency (4 ticks), tool tier affects SUCCESS RATE
   * MINING: Variable roll frequency (tool-dependent), tool does NOT affect success rate
   * FISHING: Fixed roll frequency (5 ticks), equipment doesn't affect anything
   *
   */
  SKILL_MECHANICS: {
    woodcutting: {
      /** Tool affects success rate per roll, not roll frequency */
      type: "fixed-roll-variable-success" as const,
      /** Rolls happen every 4 ticks regardless of axe tier */
      baseRollTicks: 4,
      /** Axe tier modifies success rate via low/high interpolation */
      toolAffectsSuccess: true,
      toolAffectsSpeed: false,
    },
    mining: {
      /** Tool affects roll frequency, not success rate */
      type: "variable-roll-fixed-success" as const,
      /** Base roll ticks (bronze pickaxe), better picks = fewer ticks */
      baseRollTicks: 8,
      /** Pickaxe tier modifies time between rolls */
      toolAffectsSuccess: false,
      toolAffectsSpeed: true,
    },
    fishing: {
      /** Fixed mechanics, equipment doesn't affect speed or success */
      type: "fixed-roll-fixed-success" as const,
      /** Rolls happen every 5 ticks */
      baseRollTicks: 5,
      /** Fishing equipment doesn't affect rates */
      toolAffectsSuccess: false,
      toolAffectsSpeed: false,
    },
  } as const,

  // === Tile-Based Range (tiles) ===
  /**
   * Gathering interaction range in tiles.
   * Uses cardinal-only adjacent tiles (N/S/E/W) like standard melee combat.
   *
   * classic MMORPG: Players must stand on a cardinal adjacent tile to gather resources.
   * This is equivalent to COMBAT_CONSTANTS.MELEE_RANGE_STANDARD.
   *
   */
  GATHERING_RANGE: 1,

  // === Proximity and Range (world units - legacy) ===
  /** Maximum distance to search for nearby resources when exact match fails */
  PROXIMITY_SEARCH_RADIUS: 15,
  /** Default interaction range for gathering (world units, legacy) */
  DEFAULT_INTERACTION_RANGE: 4.0,
  /** Horizontal shore-to-water reach permitted for fishing interactions. */
  FISHING_INTERACTION_RANGE: 4.0,
  /** Floating point tolerance for position comparison (classic MMORPG: any movement cancels) */
  POSITION_EPSILON: 0.01,

  // === Timing (ticks/ms) ===
  /** Minimum ticks between gather attempts (prevents instant gathering) */
  MINIMUM_CYCLE_TICKS: 2,
  /** Rate limit cooldown in milliseconds (matches 1 tick) */
  RATE_LIMIT_MS: 600,
  /** Stale rate limit threshold for cleanup (10 seconds) */
  STALE_RATE_LIMIT_MS: 10000,
  /** Rate limit cleanup interval (60 seconds) */
  RATE_LIMIT_CLEANUP_INTERVAL_MS: 60000,

  // === classic MMORPG Success Rate Formula (LERP Interpolation) ===
  /**
   * classic MMORPG uses linear interpolation between low (level 1) and high (level 99) values.
   *
   * Formula: P(Level) = (1 + floor(low × (99 - L) / 98 + high × (L - 1) / 98 + 0.5)) / 256
   *
   */

  /**
   * Woodcutting success rates by tree type and axe tier.
   * Values are x/256 (success numerator).
   *
   * classic MMORPG: Axe tier significantly affects success rate.
   * - Bronze axe at level 1 on regular tree: ~25% (64/256)
   * - Bronze axe at level 99 on regular tree: ~78% (200/256)
   * - Iron axe reaches 100% at level 78 on regular trees
   * - Dragon axe reaches 100% at level 4 on regular trees
   *
   * Higher tier trees (oak, willow) have lower success rates.
   *
   */
  WOODCUTTING_SUCCESS_RATES: {
    // Regular tree (level 1) - easiest
    tree_normal: {
      bronze: { low: 64, high: 200 },
      iron: { low: 96, high: 256 },
      steel: { low: 142, high: 256 },
      mithril: { low: 160, high: 256 },
      adamant: { low: 192, high: 256 },
      rune: { low: 224, high: 256 },
      dragon: { low: 240, high: 256 },
      crystal: { low: 248, high: 256 },
    },
    // Oak tree (level 15) - moderate
    tree_oak: {
      bronze: { low: 32, high: 100 },
      iron: { low: 48, high: 130 },
      steel: { low: 64, high: 160 },
      mithril: { low: 80, high: 190 },
      adamant: { low: 96, high: 220 },
      rune: { low: 112, high: 245 },
      dragon: { low: 128, high: 256 },
      crystal: { low: 140, high: 256 },
    },
    // Willow tree (level 30) - harder
    tree_willow: {
      bronze: { low: 24, high: 80 },
      iron: { low: 36, high: 100 },
      steel: { low: 48, high: 120 },
      mithril: { low: 60, high: 150 },
      adamant: { low: 72, high: 180 },
      rune: { low: 84, high: 210 },
      dragon: { low: 96, high: 240 },
      crystal: { low: 108, high: 256 },
    },
  } as const,

  /**
   * Mining success rates by ore type (rules-accurate).
   * Values are x/256 (success numerator) for the LERP formula.
   *
   * classic MMORPG: Pickaxe tier does NOT affect success rate, only roll frequency.
   * Success rate depends only on Mining level.
   *
   * Formula: P(Level) = (1 + floor(low × (99 - L) / 98 + high × (L - 1) / 98 + 0.5)) / 256
   *
   * Reference gathering data:
   * - Copper/Tin: ~39.5% at L1, 100% at L62
   * - Iron: ~52% at L15, 100% at L63
   * - Coal: ~16.4% at L30, ~39.5% at L99
   * - Mithril: ~11.7% at L55, ~19.9% at L99
   * - Adamantite: ~7.4% at L70, ~10.2% at L99
   * - Runite: 17/256 (~6.64%) at L85, 19/256 (~7.42%) at L97+
   *
   */
  MINING_SUCCESS_RATES: {
    // Copper ore (level 1) - 39.5% at L1, 100% at L62
    ore_copper: { low: 100, high: 256 },
    // Tin ore (level 1) - same as copper
    ore_tin: { low: 100, high: 256 },
    // Iron ore (level 15) - 52% at L15, 100% at L63
    ore_iron: { low: 133, high: 256 },
    // Coal (level 30) - 16.4% at L30, 39.5% at L99
    ore_coal: { low: 42, high: 101 },
    // Mithril ore (level 55) - 11.7% at L55, 19.9% at L99
    ore_mithril: { low: 30, high: 51 },
    // Adamantite ore (level 70) - 7.4% at L70, 10.2% at L99
    ore_adamant: { low: 19, high: 26 },
    // Runite ore (level 85) - 6.64% at L85, 7.42% at L97+
    // 17/256 at L85, 19/256 at L97+
    ore_runite: { low: 17, high: 19 },
  } as const,

  /**
   * Fishing success rates by spot type.
   * Values are x/256 (success numerator).
   *
   * classic MMORPG: Equipment does NOT affect success rate.
   * Success rate depends only on Fishing level.
   *
   */
  FISHING_SUCCESS_RATES: {
    // Net fishing - Shrimp/Anchovies (level 1+)
    fishing_spot_net: { low: 48, high: 180 },
    // Bait fishing - Sardine/Herring/Pike (level 5+)
    fishing_spot_bait: { low: 45, high: 170 },
    // Fly fishing - Trout/Salmon (level 20+)
    fishing_spot_fly: { low: 40, high: 150 },
    // Legacy fallback for old fishing_spot_normal
    fishing_spot_normal: { low: 48, high: 180 },
  } as const,

  /**
   * Default success rate values for unknown resources.
   * Used as fallback when resource type not in tables above.
   */
  DEFAULT_SUCCESS_RATE: { low: 48, high: 180 },

  // === Resource ID Validation ===
  /** Maximum allowed length for resource IDs */
  MAX_RESOURCE_ID_LENGTH: 100,
  /** Pattern for valid resource IDs (alphanumeric, underscore, hyphen, dot) */
  VALID_RESOURCE_ID_PATTERN: /^[a-zA-Z0-9_.-]+$/,

  // === Tree Despawn Times (ticks) - Forestry System ===
  /**
   * classic MMORPG Forestry-style tree depletion timer.
   * Timer starts on FIRST LOG, counts down while chopping, regenerates when idle.
   * Tree only depletes when timer=0 AND player receives a log.
   *
   */
  TREE_DESPAWN_TICKS: {
    tree: 0, // Regular trees use 1/8 chance, not timer
    oak: 45, // 27 seconds
    willow: 50, // 30 seconds
    teak: 50, // 30 seconds
    maple: 100, // 60 seconds
    yew: 190, // 114 seconds
    magic: 390, // 234 seconds
    redwood: 440, // 264 seconds
  } as const,

  // === Tree Respawn Times (ticks) ===
  /**
   * Time for depleted trees to respawn.
   *
   */
  TREE_RESPAWN_TICKS: {
    tree: 10, // ~6 seconds
    oak: 14, // ~8.4 seconds
    willow: 14, // ~8.4 seconds
    teak: 15, // ~9 seconds
    maple: 59, // ~35.4 seconds
    yew: 100, // ~60 seconds
    magic: 199, // ~119.4 seconds
    redwood: 199, // ~119.4 seconds
  } as const,

  // === Timer Regeneration ===
  /**
   * Rate at which tree timers regenerate when no one is gathering.
   * classic MMORPG: 1 tick of regeneration per 1 tick of not being gathered.
   */
  TIMER_REGEN_PER_TICK: 1,

  // === Fishing Spot Movement (rules-accurate) ===
  /**
   * Fishing spots don't deplete - they periodically move to a nearby tile.
   * In classic MMORPG, spots move randomly every ~4-12 minutes.
   * Using 300 ticks (3 minutes) as base with ±100 tick variance for gameplay.
   *
   */
  FISHING_SPOT_MOVE: {
    /** Base ticks before spot moves (300 ticks = 3 minutes) */
    baseTicks: 300,
    /** Random variance in ticks (±100 ticks = ±1 minute) */
    varianceTicks: 100,
    /** Maximum distance to search for a new spot across a compact water body. */
    relocateRadius: 15,
    /** Keep a relocation visually distinct from the current position. */
    relocateMinDistance: 3.5,
    /** Keep simultaneous pond interactions comfortably separated. */
    shoreMinSpacing: 3.5,
  } as const,
} as const;

export type GatheringConstants = typeof GATHERING_CONSTANTS;
