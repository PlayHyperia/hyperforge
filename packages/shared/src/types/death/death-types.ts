/**
 * Death System Type Definitions
 * Centralized types for player death, loot, and resurrection mechanics
 */

import type { InventoryItem } from "../core/core";

// =============================================================================
// DATABASE TRANSACTION SUPPORT
// =============================================================================

/**
 * Opaque transaction context type for database operations
 *
 * This is a branded type that provides type safety without exposing
 * the underlying database implementation (Drizzle, Knex, etc.).
 *
 * Benefits over `any`:
 * - Type-distinct: Can't accidentally pass unrelated values
 * - Self-documenting: Clearly indicates transaction semantics
 * - Future-proof: Can add methods if needed without breaking changes
 *
 * The actual implementation is injected by the server's DatabaseSystem.
 * On the server, this is a Drizzle transaction handle (NodePgDatabase).
 *
 * @example
 * ```typescript
 * async handleDeath(playerId: string, ..., tx?: TransactionContext): Promise<void> {
 *   // Pass tx through to database operations for atomic execution
 *   await this.databaseSystem.saveDeathLockAsync(data, tx);
 * }
 * ```
 */
export type TransactionContext = {
  /** Brand to make this type distinct from other object types */
  readonly __brand: unique symbol;
};

/**
 * Zone types for death handling
 */
export enum ZoneType {
  SAFE_AREA = "safe_area",
  WILDERNESS = "wilderness",
  PVP_ZONE = "pvp_zone",
  UNKNOWN = "unknown",
}

/**
 * Zone properties for death mechanics
 */
export interface ZoneProperties {
  type: ZoneType;
  isSafe: boolean;
  isPvPEnabled: boolean;
  isWilderness: boolean;
  name: string;
  difficultyLevel: number;
  /** Zone identifier (e.g., "duel_arena", "central_haven") */
  id?: string;
}

/**
 * Item data stored with death lock for crash recovery
 */
export interface DeathItemData {
  itemId: string;
  quantity: number;
}

/**
 * Death lock state stored in database
 * Prevents item duplication on reconnect
 */
export interface DeathLock {
  playerId: string;
  gravestoneId?: string; // Present in safe zones
  groundItemIds?: string[]; // Present in wilderness or after gravestone expires
  position: { x: number; y: number; z: number };
  timestamp: number;
  zoneType: ZoneType;
  itemCount: number;
  // Crash recovery fields (optional for backwards compatibility)
  items?: DeathItemData[]; // Dropped items for recovery (gravestone/ground)
  keptItems?: DeathItemData[]; // classic MMORPG keep-3 items returned on respawn
  deathOperationId?: string; // Immutable database custody operation for this death
  killedBy?: string; // What killed the player
  recovered?: boolean; // Whether death was processed during crash recovery
}

/**
 * Ground item spawn options
 * Config accepts milliseconds for backwards compatibility,
 * internally converted to ticks by GroundItemSystem
 */
export interface GroundItemOptions {
  despawnTime: number; // Milliseconds until despawn (converted to ticks internally)
  droppedBy?: string; // Player who dropped it
  lootProtection?: number; // Milliseconds of loot protection (converted to ticks internally)
  scatter?: boolean; // Scatter items around position
  scatterRadius?: number; // Radius for scattering
}

/**
 * Ground item data tracked by GroundItemSystem (TICK-BASED)
 * Uses tick numbers for rules-accurate despawn timing
 */
export interface GroundItemData {
  entityId: string;
  itemId: string;
  quantity: number;
  position: { x: number; y: number; z: number };
  despawnTick: number; // Tick number when item despawns
  droppedBy?: string;
  lootProtectionTick?: number; // Tick number when loot protection ends
  spawnedAt: number; // Timestamp for logging only
}

/**
 * Ground item pile data - tracks all items at a single tile
 * Used for classic MMORPG-style item stacking where only top item is visible
 */
export interface GroundItemPileData {
  tileKey: string; // "x_z" format for Map key
  tile: { x: number; z: number }; // Tile coordinates
  items: GroundItemData[]; // Ordered by drop time (newest first)
  topItemEntityId: string; // The currently visible item entity
}

/**
 * Death event data
 */
export interface DeathEventData {
  playerId: string;
  position: { x: number; y: number; z: number };
  items: InventoryItem[];
  killedBy: string;
  zoneType: ZoneType;
}

/**
 * Reconnect validation result
 */
export interface ReconnectValidation {
  hasActiveDeath: boolean;
  gravestoneExists: boolean;
  groundItemsExist: string[]; // List of existing ground item IDs
  shouldBlockInventoryLoad: boolean;
  deathData?: DeathLock;
}

// =============================================================================
// LOOT RESULT TYPES (Shadow State Support)
// =============================================================================

/**
 * Loot operation failure reasons
 */
export type LootFailureReason =
  | "ITEM_NOT_FOUND" // Item already looted by someone else
  | "INVENTORY_FULL" // Player's inventory is full
  | "PROTECTED" // Loot protection still active
  | "GRAVESTONE_GONE" // Gravestone despawned
  | "RATE_LIMITED" // Too many requests
  | "INVALID_REQUEST" // Malformed request
  | "PLAYER_DYING"; // Player is dying/dead, cannot loot

/**
 * Loot operation result - sent from server to client
 * Used for shadow state confirmation/rejection
 */
export interface LootResult {
  /** Unique ID matching the client's request */
  transactionId: string;
  /** Whether the loot was successful */
  success: boolean;
  /** Item that was looted (on success) */
  itemId?: string;
  /** Quantity looted (on success) */
  quantity?: number;
  /** Failure reason (on failure) */
  reason?: LootFailureReason;
  /** Server timestamp for ordering */
  timestamp: number;
}

/**
 * Pending loot transaction for client shadow state
 */
export interface PendingLootTransaction {
  transactionId: string;
  itemId: string;
  quantity: number;
  requestedAt: number;
  /** Optimistically removed item for rollback */
  originalItem: InventoryItem;
  /** Original index in the loot items array */
  originalIndex: number;
}

// =============================================================================
// AUDIT LOGGING TYPES
// =============================================================================

/**
 * Death/loot audit action types
 */
export type DeathAuditAction =
  | "DEATH_STARTED" // Player death initiated
  | "DEATH_COMPLETED" // Death processing finished
  | "GRAVESTONE_CREATED" // Gravestone spawned
  | "GRAVESTONE_EXPIRED" // Gravestone → ground items
  | "LOOT_ATTEMPTED" // Loot request received
  | "LOOT_SUCCESS" // Item successfully looted
  | "LOOT_FAILED" // Loot attempt failed
  | "DEATH_RECOVERED"; // Crash recovery processed death

/**
 * Audit log entry for death/loot operations
 * Stored in database for forensic analysis
 */
export interface DeathAuditEntry {
  /** Unique audit entry ID */
  id: string;
  /** Type of operation */
  action: DeathAuditAction;
  /** Player who died or owns the gravestone */
  playerId: string;
  /** Player performing the action (for loot, may differ from playerId) */
  actorId: string;
  /** Gravestone or ground item entity ID */
  entityId?: string;
  /** Items involved in operation */
  items?: Array<{ itemId: string; quantity: number }>;
  /** Zone where action occurred */
  zoneType: ZoneType;
  /** Position of action */
  position: { x: number; y: number; z: number };
  /** Success or failure */
  success: boolean;
  /** Failure reason if applicable */
  failureReason?: string;
  /** Transaction ID for loot operations */
  transactionId?: string;
  /** Server timestamp */
  timestamp: number;
}
