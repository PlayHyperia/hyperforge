/**
 * Duel System Configuration
 *
 * Centralized configuration constants for the duel system.
 * Eliminates magic numbers throughout the codebase.
 *
 * All timing values are in game ticks (600ms each, rules-accurate).
 * Use ticksToMs() helper or multiply by TICK_DURATION_MS for setTimeout/setInterval.
 * All distance values are in tiles/units.
 */

import {
  TICK_DURATION_MS,
  DUEL_CHALLENGE_TIMEOUT_MS,
} from "@hyperforge/shared";

// ============================================================================
// TIMING CONFIGURATION (in game ticks, 600ms each)
// ============================================================================

/**
 * How long a challenge remains valid before expiring.
 * Derived from shared DUEL_CHALLENGE_TIMEOUT_MS (single source of truth).
 */
export const CHALLENGE_TIMEOUT_TICKS = Math.ceil(
  DUEL_CHALLENGE_TIMEOUT_MS / TICK_DURATION_MS,
);

/**
 * How long a disconnected player has to reconnect before auto-forfeit
 * 50 ticks = 30 seconds
 */
export const DISCONNECT_TIMEOUT_TICKS = 50;

/**
 * Grace period for disconnects during setup phases (RULES, STAKES, CONFIRMING).
 * Shorter than combat disconnect because setup is less critical.
 * 12 ticks ≈ 7.2 seconds — long enough for brief connection hiccups,
 * short enough to not leave opponent waiting.
 */
export const SETUP_DISCONNECT_GRACE_TICKS = 12;

/**
 * Maximum age for a duel session before automatic cleanup
 * 3000 ticks = 30 minutes
 */
export const SESSION_MAX_AGE_TICKS = 3000;

/**
 * Delay before resolving duel after death to allow animation
 * rules-accurate: 8 ticks ≈ 4.8 seconds (close to 5s, aligned to tick boundary)
 */
export const DEATH_RESOLUTION_DELAY_TICKS = 8;

/**
 * Interval for cleanup checks
 * 17 ticks ≈ 10.2 seconds
 */
export const CLEANUP_INTERVAL_TICKS = 17;

/**
 * Interval for distance checks on pending challenges
 * 8 ticks ≈ 4.8 seconds
 */
export const CHALLENGE_CLEANUP_INTERVAL_TICKS = 8;

// ============================================================================
// TIMING HELPERS
// ============================================================================

/**
 * Convert ticks to milliseconds for use with setTimeout/setInterval
 */
export const ticksToMs = (ticks: number): number => ticks * TICK_DURATION_MS;

// Re-export for convenience
export { TICK_DURATION_MS };

// ============================================================================
// DISTANCE CONFIGURATION
// ============================================================================

/**
 * Maximum distance (in tiles) between players to create/maintain a challenge
 * rules-accurate: 15 tiles
 */
export const CHALLENGE_DISTANCE_TILES = 15;

// ============================================================================
// LIMITS
// ============================================================================

/**
 * Maximum number of staked items per player (matches inventory size)
 */
export const MAX_STAKES_PER_PLAYER = 28;

/**
 * Tolerance for position checking (in units)
 */
export const POSITION_TOLERANCE = 0.5;

/**
 * Cooldown (in ms) before a challenger can re-challenge the same target
 * after a decline or expiry. Prevents harassment spam.
 * 10 seconds.
 */
export const CHALLENGE_COOLDOWN_MS = 10_000;

// ============================================================================
// ID GENERATION
// ============================================================================

let _idCounter = 0;

/**
 * Generate a unique numeric duel-related ID (fits in u64)
 */
export function generateDuelId(): string {
  _idCounter = (_idCounter + 1) % 1000;
  return `${Date.now()}${_idCounter.toString().padStart(3, "0")}`;
}
