/**
 * Combat Constants
 *
 * rules-accurate timing and combat values.
 * All tick-based values assume 600ms per tick.
 *
 */

import { WeaponType } from "../types/game/item-types";

/**
 * Melee attack style determines which per-style attack/defence bonuses are used.
 * classic MMORPG: Each weapon type has a default style (e.g., swords slash, daggers stab).
 */
export type MeleeAttackStyle = "stab" | "slash" | "crush";

/** Default melee attack style per weapon type (rules-accurate) */
export const WEAPON_DEFAULT_ATTACK_STYLE: Record<string, MeleeAttackStyle> = {
  [WeaponType.SWORD]: "slash",
  [WeaponType.LONGSWORD]: "slash",
  [WeaponType.SCIMITAR]: "slash",
  [WeaponType.AXE]: "slash",
  [WeaponType.MACE]: "crush",
  [WeaponType.DAGGER]: "stab",
  [WeaponType.SPEAR]: "stab",
  [WeaponType.TWO_HAND_SWORD]: "slash",
  [WeaponType.HALBERD]: "slash",
  [WeaponType.NONE]: "crush", // unarmed = crush (fists)
};

export const COMBAT_CONSTANTS = {
  // === Ranges (tiles) ===
  RANGED_RANGE: 10,
  MAGIC_RANGE: 10,
  MELEE_RANGE_STANDARD: 1,
  MELEE_RANGE_HALBERD: 2,
  PICKUP_RANGE: 2.5,

  // === Tick System ===
  TICK_DURATION_MS: 600,

  // === Combat Timing (ticks) ===
  DEFAULT_ATTACK_SPEED_TICKS: 4,
  COMBAT_TIMEOUT_TICKS: 17, // rules-accurate: 10.2 seconds (17 ticks * 600ms)
  LOGOUT_PREVENTION_TICKS: 16,
  HEALTH_REGEN_COOLDOWN_TICKS: 17,
  HEALTH_REGEN_INTERVAL_TICKS: 100,
  AFK_DISABLE_RETALIATE_TICKS: 2000,

  // === Food Consumption (rules-accurate) ===
  /** Ticks before player can eat again after eating (3 ticks = 1.8s) */
  EAT_DELAY_TICKS: 3,
  /** Ticks added to attack cooldown when eating during combat */
  EAT_ATTACK_DELAY_TICKS: 3,
  /** Maximum heal amount per food item (prevents exploit with modified manifests) */
  MAX_HEAL_AMOUNT: 99,

  // === Hit Delay ===
  // Formula: MELEE=0, RANGED=1+floor((3+dist)/6), MAGIC=1+floor((1+dist)/3)
  HIT_DELAY: {
    MELEE_BASE: 0,
    RANGED_BASE: 1,
    RANGED_DISTANCE_OFFSET: 3,
    RANGED_DISTANCE_DIVISOR: 6,
    MAGIC_BASE: 1,
    MAGIC_DISTANCE_OFFSET: 1,
    MAGIC_DISTANCE_DIVISOR: 3,
    MAX_HIT_DELAY: 10,
  },

  // === Projectile Launch Delays (ms) ===
  /** Delay before spell projectile spawns (allows cast animation wind-up) */
  SPELL_LAUNCH_DELAY_MS: 600,
  /** Delay before arrow projectile spawns (allows draw animation wind-up) */
  ARROW_LAUNCH_DELAY_MS: 400,
  /** Hard server-side lifetime for an unresolved projectile. */
  PROJECTILE_MAX_LIFETIME_TICKS: 20,
  /** Client delivery allowance after that server lifetime elapses. */
  PROJECTILE_TERMINAL_DELIVERY_GRACE_MS: 1_500,

  // === Visual Rotation (client-side, exponential decay) ===
  ROTATION: {
    /** Combat facing slerp speed — ~95% convergence in 150ms. Tuned empirically. */
    COMBAT_SLERP_SPEED: 20.0,
    /** Movement facing slerp speed — ~90% convergence in 200ms. Tuned empirically. */
    MOVEMENT_SLERP_SPEED: 12.0,
    /** Max distance (tiles) to resolve a combat facing target. Beyond this, stop tracking. */
    FACING_MAX_DISTANCE: 20,
    /** Min squared distance (tiles²) to rotate toward target. Prevents flips when overlapping (0.5² = half-tile). */
    MIN_ROTATION_DISTANCE_SQ: 0.25,
  },

  // === Animation ===
  ANIMATION: {
    HIT_FRAME_RATIO: 0.5,
    MIN_ANIMATION_TICKS: 2,
    HITSPLAT_DELAY_TICKS: 0,
    HITSPLAT_DURATION_TICKS: 2,
    EMOTE_COMBAT: "combat",
    EMOTE_SWORD_SWING: "sword_swing",
    EMOTE_2H_SLASH: "2h_slash",
    EMOTE_2H_IDLE: "2h_idle",
    EMOTE_RANGED: "ranged",
    EMOTE_MAGIC: "magic",
    EMOTE_IDLE: "idle",
    /** Duration (seconds) for GLB animation crossfades. modern MMORPG uses 300-400ms; 350ms splits the range. */
    CROSSFADE_DURATION: 0.35,
  },

  // === Death & Loot (ticks) ===
  RESPAWN_TICKS_RANDOMNESS: 8,
  GRAVESTONE_TICKS: 1500,
  GROUND_ITEM_DESPAWN_TICKS: 6000, // rules-accurate: 60 minutes (was 300 = 3 min)
  UNTRADEABLE_DESPAWN_TICKS: 6000, // rules-accurate: 60 minutes (was 300 = 3 min)
  LOOT_PROTECTION_TICKS: 100,
  CORPSE_DESPAWN_TICKS: 200,

  DEATH: {
    ANIMATION_TICKS: 7,
    COOLDOWN_TICKS: 17,
    RECONNECT_RESPAWN_DELAY_TICKS: 1,
    STALE_LOCK_AGE_TICKS: 3000, // 30 minutes (was 6000 = 1 hour)
    DEFAULT_RESPAWN_POSITION: { x: 0, y: 0, z: 0 } as const,
    DEFAULT_RESPAWN_TOWN: "Central Haven",
  } as const,

  // === Damage Formulas ===
  BASE_CONSTANT: 64,
  EFFECTIVE_LEVEL_CONSTANT: 8,
  DAMAGE_DIVISOR: 640,
  MIN_DAMAGE: 0,
  MAX_DAMAGE: 200,

  // === XP per Damage ===
  XP: {
    COMBAT_XP_PER_DAMAGE: 4,
    HITPOINTS_XP_PER_DAMAGE: 1.33,
    CONTROLLED_XP_PER_DAMAGE: 1.33,
  },

  COMBAT_STATES: {
    IDLE: "idle",
    IN_COMBAT: "in_combat",
    FLEEING: "fleeing",
  } as const,

  // === Manifest Defaults (fallback when not specified) ===
  DEFAULTS: {
    NPC: {
      ATTACK_SPEED_TICKS: 4,
      AGGRO_RANGE: 4,
      COMBAT_RANGE: 1,
      LEASH_RANGE: 42, // Extended from classic MMORPG default of 7 for better gameplay
      RESPAWN_TICKS: 25,
      WANDER_RADIUS: 5,
    },
    ITEM: {
      ATTACK_SPEED: 4,
      ATTACK_RANGE: 1,
    },
  } as const,
} as const;

export const AGGRO_CONSTANTS = {
  DEFAULT_BEHAVIOR: "passive" as const,
  AGGRO_UPDATE_INTERVAL_MS: 100,
  ALWAYS_AGGRESSIVE_LEVEL: 999,
} as const;

export const LEVEL_CONSTANTS = {
  DEFAULT_COMBAT_LEVEL: 3,
  MIN_COMBAT_LEVEL: 3,
  MAX_LEVEL: 99,

  XP_BASE: 50,
  XP_GROWTH_FACTOR: 8,

  COMBAT_LEVEL_WEIGHTS: {
    DEFENSE_WEIGHT: 0.25,
    OFFENSE_WEIGHT: 0.325,
    RANGED_MULTIPLIER: 1.5,
  },
} as const;

export type CombatState =
  (typeof COMBAT_CONSTANTS.COMBAT_STATES)[keyof typeof COMBAT_CONSTANTS.COMBAT_STATES];

// ============================================================================
// Ranged & Magic Style Bonuses (moved from types/game/combat-types.ts)
// ============================================================================

export type RangedCombatStyle = "accurate" | "rapid" | "longrange";
export type MagicCombatStyle = "accurate" | "longrange" | "autocast";

export interface RangedStyleBonus {
  readonly attackBonus: number;
  readonly speedModifier: number;
  readonly rangeModifier: number;
  readonly xpSplit: "ranged" | "ranged_defence";
}

export interface MagicStyleBonus {
  readonly attackBonus: number;
  readonly speedModifier: number;
  readonly rangeModifier: number;
  readonly xpSplit: "magic" | "magic_defence";
}

/** Pre-allocated frozen style bonuses for ranged combat (rules-accurate) */
export const RANGED_STYLE_BONUSES: Readonly<
  Record<RangedCombatStyle, Readonly<RangedStyleBonus>>
> = Object.freeze({
  accurate: Object.freeze({
    attackBonus: 3,
    speedModifier: 0,
    rangeModifier: 0,
    xpSplit: "ranged" as const,
  }),
  rapid: Object.freeze({
    attackBonus: 0,
    speedModifier: -1,
    rangeModifier: 0,
    xpSplit: "ranged" as const,
  }),
  longrange: Object.freeze({
    attackBonus: 0,
    speedModifier: 0,
    rangeModifier: 2,
    xpSplit: "ranged_defence" as const,
  }),
});

/** Pre-allocated frozen style bonuses for magic combat */
export const MAGIC_STYLE_BONUSES: Readonly<
  Record<MagicCombatStyle, Readonly<MagicStyleBonus>>
> = Object.freeze({
  accurate: Object.freeze({
    attackBonus: 3,
    speedModifier: 0,
    rangeModifier: 0,
    xpSplit: "magic" as const,
  }),
  longrange: Object.freeze({
    attackBonus: 1,
    speedModifier: 0,
    rangeModifier: 2,
    xpSplit: "magic_defence" as const,
  }),
  autocast: Object.freeze({
    attackBonus: 0,
    speedModifier: 0,
    rangeModifier: 0,
    xpSplit: "magic" as const,
  }),
});
