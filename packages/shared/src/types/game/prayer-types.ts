/**
 * Prayer Type Definitions
 *
 * Types for the manifest-driven prayer system.
 * Includes type guards for runtime validation.
 *
 */

// === Constants ===

/** Maximum length for prayer IDs (security: prevent DoS via huge strings) */
export const MAX_PRAYER_ID_LENGTH = 64;

/** Maximum active prayers at once (balance + anti-exploit) */
export const MAX_ACTIVE_PRAYERS = 5;

/** Minimum milliseconds between prayer toggles (anti-spam) */
export const PRAYER_TOGGLE_COOLDOWN_MS = 100;

/** Maximum toggles per second before flagging (anti-cheat) */
export const PRAYER_TOGGLE_RATE_LIMIT = 5;

/** Pattern for valid prayer IDs: lowercase alphanumeric + underscore */
export const PRAYER_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

// === Core Types ===

export type PrayerCategory = "offensive" | "defensive" | "utility";

export interface PrayerBonuses {
  // Melee bonuses
  readonly attackMultiplier?: number;
  readonly strengthMultiplier?: number;
  readonly defenseMultiplier?: number;
  // Ranged bonuses
  readonly rangedAttackMultiplier?: number;
  readonly rangedStrengthMultiplier?: number;
  // Magic bonuses
  readonly magicAttackMultiplier?: number;
  readonly magicDefenseMultiplier?: number;
}

export interface PrayerDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly level: number;
  readonly category: PrayerCategory;
  readonly drainEffect: number;
  readonly bonuses: PrayerBonuses;
  readonly conflicts: readonly string[];
}

export interface PrayerManifest {
  readonly prayers: readonly PrayerDefinition[];
}

export interface PrayerState {
  readonly level: number;
  readonly xp: number;
  points: number; // Mutable - changes during gameplay
  maxPoints: number; // Mutable - changes on level up
  active: string[]; // Mutable - changes on toggle
}

export interface PrayerTogglePayload {
  readonly prayerId: string;
  /** Optional client correlation ID; never used as the persistence operation ID. */
  readonly requestId?: string;
}

export interface PrayerToggledEvent {
  readonly playerId: string;
  readonly prayerId: string;
  readonly active: boolean;
  readonly points: number;
}

export interface PrayerStateSyncPayload {
  readonly playerId: string;
  readonly level: number;
  readonly xp: number;
  readonly points: number;
  readonly maxPoints: number;
  readonly active: readonly string[];
}

// === Type Guards (Runtime Validation) ===

/**
 * Validates prayer ID format (security + anti-exploit)
 * - Max 64 characters
 * - Lowercase alphanumeric + underscore only
 * - Must start with letter
 */
export function isValidPrayerId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > MAX_PRAYER_ID_LENGTH) return false;
  return PRAYER_ID_PATTERN.test(id);
}

/**
 * Validates PrayerTogglePayload from network
 */
export function isValidPrayerTogglePayload(
  data: unknown,
): data is PrayerTogglePayload {
  if (!data || typeof data !== "object") return false;
  const payload = data as Record<string, unknown>;
  return (
    isValidPrayerId(payload.prayerId) &&
    (payload.requestId === undefined ||
      (typeof payload.requestId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          payload.requestId,
        )))
  );
}

/**
 * Validates prayer bonuses from manifest
 */
export function isValidPrayerBonuses(
  bonuses: unknown,
): bonuses is PrayerBonuses {
  if (!bonuses || typeof bonuses !== "object") return false;
  const b = bonuses as Record<string, unknown>;

  // All multipliers must be positive numbers if present
  for (const key of [
    "attackMultiplier",
    "strengthMultiplier",
    "defenseMultiplier",
    "rangedAttackMultiplier",
    "rangedStrengthMultiplier",
    "magicAttackMultiplier",
    "magicDefenseMultiplier",
  ]) {
    if (
      key in b &&
      (typeof b[key] !== "number" || b[key] <= 0 || (b[key] as number) > 10)
    ) {
      return false;
    }
  }
  return true;
}

// === Player Type Interface (for proper typing without 'any') ===

/**
 * Interface for player prayer data access
 * Use this instead of (player as any) to maintain type safety
 */
export interface PlayerWithPrayerStats {
  id: string;
  stats?: {
    prayer?: {
      level: number;
      xp: number;
      points?: number;
      maxPoints?: number;
    };
    combatBonuses?: {
      prayerBonus?: number;
    };
  };
  skills?: {
    prayer?: {
      level: number;
      xp: number;
    };
  };
}

/**
 * Safely extract prayer level from player entity
 */
export function getPlayerPrayerLevel(
  player: PlayerWithPrayerStats | undefined,
): number {
  if (!player) return 1;
  return player.stats?.prayer?.level ?? player.skills?.prayer?.level ?? 1;
}

/**
 * Safely extract prayer bonus from player equipment
 */
export function getPlayerPrayerBonus(
  player: PlayerWithPrayerStats | undefined,
): number {
  if (!player) return 0;
  return player.stats?.combatBonuses?.prayerBonus ?? 0;
}

/**
 * Safely extract prayer XP from player entity
 */
export function getPlayerPrayerXp(
  player: PlayerWithPrayerStats | undefined,
): number {
  if (!player) return 0;
  return player.stats?.prayer?.xp ?? player.skills?.prayer?.xp ?? 0;
}

// === Internal Event Payloads (for PrayerSystem event handlers) ===

/**
 * Payload for PLAYER_REGISTERED event
 */
export interface PlayerRegisteredPayload {
  readonly playerId: string;
}

/**
 * Payload for PLAYER_CLEANUP event
 */
export interface PlayerCleanupPayload {
  readonly playerId: string;
}

/**
 * Payload for PRAYER_TOGGLE event (internal, from handler to system)
 */
export interface PrayerToggleEventPayload {
  readonly playerId: string;
  readonly prayerId: string;
}

/**
 * Payload for ALTAR_PRAY event
 */
export interface AltarPrayPayload {
  readonly playerId: string;
  readonly altarId: string;
}

/**
 * Payload for PRAYER_DEACTIVATED event
 */
export interface PrayerDeactivatedPayload {
  readonly playerId: string;
  readonly prayerId: string;
  readonly reason: "conflict" | "depleted" | "manual" | "deactivate_all";
}

/**
 * Payload for PRAYER_POINTS_CHANGED event
 */
export interface PrayerPointsChangedPayload {
  readonly playerId: string;
  readonly points: number;
  readonly maxPoints: number;
}

// === Type Guards for Event Payloads ===

/**
 * Validates PlayerRegisteredPayload
 */
export function isPlayerRegisteredPayload(
  data: unknown,
): data is PlayerRegisteredPayload {
  if (!data || typeof data !== "object") return false;
  const payload = data as Record<string, unknown>;
  return typeof payload.playerId === "string" && payload.playerId.length > 0;
}

/**
 * Validates PlayerCleanupPayload
 */
export function isPlayerCleanupPayload(
  data: unknown,
): data is PlayerCleanupPayload {
  if (!data || typeof data !== "object") return false;
  const payload = data as Record<string, unknown>;
  return typeof payload.playerId === "string" && payload.playerId.length > 0;
}

/**
 * Validates PrayerToggleEventPayload
 */
export function isPrayerToggleEventPayload(
  data: unknown,
): data is PrayerToggleEventPayload {
  if (!data || typeof data !== "object") return false;
  const payload = data as Record<string, unknown>;
  return (
    typeof payload.playerId === "string" &&
    payload.playerId.length > 0 &&
    isValidPrayerId(payload.prayerId)
  );
}

/**
 * Validates AltarPrayPayload
 */
export function isAltarPrayPayload(data: unknown): data is AltarPrayPayload {
  if (!data || typeof data !== "object") return false;
  const payload = data as Record<string, unknown>;
  return (
    typeof payload.playerId === "string" &&
    payload.playerId.length > 0 &&
    typeof payload.altarId === "string" &&
    payload.altarId.length > 0
  );
}

// === Bounds Checking Helpers ===

/** Minimum prayer level */
export const MIN_PRAYER_LEVEL = 1;

/** Maximum prayer level */
export const MAX_PRAYER_LEVEL = 99;

/** Maximum prayer points (equals max level) */
export const MAX_PRAYER_POINTS = 99;

/**
 * Clamp prayer level to valid range [1, 99]
 */
export function clampPrayerLevel(level: number): number {
  if (!Number.isFinite(level)) return MIN_PRAYER_LEVEL;
  return Math.max(
    MIN_PRAYER_LEVEL,
    Math.min(MAX_PRAYER_LEVEL, Math.floor(level)),
  );
}

/**
 * Clamp prayer points to valid range [0, max]
 */
export function clampPrayerPoints(points: number, maxPoints: number): number {
  if (!Number.isFinite(points)) return 0;
  if (!Number.isFinite(maxPoints)) maxPoints = MAX_PRAYER_POINTS;
  return Math.max(0, Math.min(maxPoints, points));
}

/**
 * Validate a number is a valid positive amount for restoration
 */
export function isValidRestoreAmount(amount: unknown): amount is number {
  return (
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= MAX_PRAYER_POINTS
  );
}
