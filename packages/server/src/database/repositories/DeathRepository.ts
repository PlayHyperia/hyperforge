/**
 * DeathRepository - Player death state persistence
 *
 * Manages persistent storage of active player deaths (death locks) to prevent
 * item duplication exploits on server restart or reconnection.
 *
 * CRITICAL FOR SECURITY:
 * - Death locks prevent duplicate item spawns on server crash/restart
 * - Prevents players from dying multiple times simultaneously
 * - Enables reconnect validation to restore death state
 *
 * Responsibilities:
 * - Save death locks when player dies
 * - Retrieve active death locks on reconnect/restart
 * - Delete death locks when player respawns or loots all items
 * - Query all active deaths for server recovery
 *
 * Used by: DeathStateManager, PlayerDeathSystem
 */

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { BaseRepository } from "./BaseRepository";
import * as schema from "../schema";

/**
 * Safely parse JSON with fallback value on error
 * Prevents server crash on corrupted database data
 */
function safeJsonParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    console.error(`[DeathRepository] Failed to parse JSON: ${json}`, error);
    return fallback;
  }
}

/**
 * Item data for crash recovery
 */
export interface DeathItemData {
  itemId: string;
  quantity: number;
}

/**
 * Death lock data structure
 */
export interface DeathLockData {
  playerId: string;
  gravestoneId: string | null;
  groundItemIds: string[]; // IDs of spawned ground items
  position: { x: number; y: number; z: number };
  timestamp: number;
  zoneType: string; // "safe_area" | "wilderness" | "pvp_zone"
  itemCount: number;
  // Crash recovery fields
  items: DeathItemData[]; // Actual item data for recovery
  keptItems?: DeathItemData[];
  deathOperationId?: string | null;
  killedBy: string; // What killed the player
  recovered: boolean; // Whether death was processed during crash recovery
}

/**
 * DeathRepository class
 *
 * Provides all death lock persistence operations.
 */
export class DeathRepository extends BaseRepository {
  /**
   * Save or update a death lock for a player
   *
   * Creates a death lock record when a player dies. If a death lock already
   * exists for this player (shouldn't happen, but defensive), it will be updated.
   * Uses PostgreSQL's ON CONFLICT to atomically insert or update.
   *
   * CRITICAL: This prevents item duplication on server restart!
   *
   * @param data - Death lock data including position, items, gravestone ID
   * @param tx - Optional transaction context for atomic operations
   */
  async saveDeathLockAsync(
    data: DeathLockData,
    tx?: NodePgDatabase<typeof schema>,
  ): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    const now = Date.now();
    const db = tx || this.db; // Use transaction if provided, otherwise regular db

    await db
      .insert(schema.playerDeaths)
      .values({
        playerId: data.playerId,
        gravestoneId: data.gravestoneId,
        groundItemIds: JSON.stringify(data.groundItemIds),
        position: JSON.stringify(data.position),
        timestamp: data.timestamp,
        zoneType: data.zoneType,
        itemCount: data.itemCount,
        // Crash recovery fields
        items: data.items,
        keptItems: data.keptItems ?? [],
        deathOperationId: data.deathOperationId ?? null,
        killedBy: data.killedBy,
        recovered: data.recovered,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.playerDeaths.playerId,
        set: {
          gravestoneId: data.gravestoneId,
          groundItemIds: JSON.stringify(data.groundItemIds),
          position: JSON.stringify(data.position),
          timestamp: data.timestamp,
          zoneType: data.zoneType,
          itemCount: data.itemCount,
          // Crash recovery fields
          items: data.items,
          keptItems: data.keptItems ?? [],
          deathOperationId: data.deathOperationId ?? null,
          killedBy: data.killedBy,
          recovered: data.recovered,
          updatedAt: now,
        },
      });
  }

  /**
   * Get active death lock for a player
   *
   * Retrieves the death lock if the player has an active death state.
   * Returns null if no death lock exists (player is alive or has already respawned).
   *
   * Used for:
   * - Reconnect validation (restore death screen)
   * - Preventing multiple simultaneous deaths
   * - Tracking gravestone/ground item state
   *
   * @param playerId - The player ID to check
   * @returns Death lock data or null if no active death
   */
  async getDeathLockAsync(playerId: string): Promise<DeathLockData | null> {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.playerDeaths)
      .where(eq(schema.playerDeaths.playerId, playerId))
      .limit(1);

    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      playerId: row.playerId,
      gravestoneId: row.gravestoneId,
      groundItemIds: safeJsonParse<string[]>(row.groundItemIds, []),
      position: safeJsonParse<{ x: number; y: number; z: number }>(
        row.position,
        { x: 0, y: 0, z: 0 },
      ),
      timestamp: row.timestamp,
      zoneType: row.zoneType,
      itemCount: row.itemCount,
      // Crash recovery fields
      items: (row.items as DeathItemData[]) || [],
      keptItems: (row.keptItems as DeathItemData[]) || [],
      deathOperationId: row.deathOperationId,
      killedBy: row.killedBy,
      recovered: row.recovered,
    };
  }

  /**
   * Delete a death lock for a player
   *
   * Removes the death lock when:
   * - Player respawns
   * - All items are looted from gravestone/ground
   * - Death is fully resolved
   *
   * IMPORTANT: Only call this when death is completely resolved!
   *
   * @param playerId - The player ID whose death lock to remove
   */
  async deleteDeathLockAsync(playerId: string): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.db
      .delete(schema.playerDeaths)
      .where(eq(schema.playerDeaths.playerId, playerId));
  }

  /**
   * Get all active death locks
   *
   * Used for server restart recovery:
   * - Restore all active gravestones/ground items
   * - Re-initialize timers for gravestone expiration
   * - Validate player states on reconnect
   *
   * This is called during server startup to prevent item loss/duplication.
   *
   * @returns Array of all active death locks
   */
  async getAllActiveDeathsAsync(): Promise<DeathLockData[]> {
    this.ensureDatabase();

    const results = await this.db.select().from(schema.playerDeaths);

    return results.map((row) => ({
      playerId: row.playerId,
      gravestoneId: row.gravestoneId,
      groundItemIds: safeJsonParse<string[]>(row.groundItemIds, []),
      position: safeJsonParse<{ x: number; y: number; z: number }>(
        row.position,
        { x: 0, y: 0, z: 0 },
      ),
      timestamp: row.timestamp,
      zoneType: row.zoneType,
      itemCount: row.itemCount,
      // Crash recovery fields
      items: (row.items as DeathItemData[]) || [],
      keptItems: (row.keptItems as DeathItemData[]) || [],
      deathOperationId: row.deathOperationId,
      killedBy: row.killedBy,
      recovered: row.recovered,
    }));
  }

  /**
   * Update ground item IDs when gravestone expires
   *
   * When a gravestone expires and transitions to ground items, we need to
   * update the death lock to track the new ground item IDs instead of the gravestone.
   *
   * @param playerId - The player ID
   * @param groundItemIds - Array of spawned ground item IDs
   */
  async updateGroundItemsAsync(
    playerId: string,
    groundItemIds: string[],
  ): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.db
      .update(schema.playerDeaths)
      .set({
        gravestoneId: null, // Gravestone no longer exists
        groundItemIds: JSON.stringify(groundItemIds),
        updatedAt: Date.now(),
      })
      .where(eq(schema.playerDeaths.playerId, playerId));
  }

  /**
   * Get all unrecovered deaths for crash recovery
   *
   * Called during server startup to find deaths that weren't properly
   * processed (server crashed during death sequence). These need to have
   * their gravestones/ground items recreated.
   *
   * @returns Array of death locks that need recovery
   */
  async getUnrecoveredDeathsAsync(): Promise<DeathLockData[]> {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.playerDeaths)
      .where(eq(schema.playerDeaths.recovered, false));

    return results.map((row) => ({
      playerId: row.playerId,
      gravestoneId: row.gravestoneId,
      groundItemIds: safeJsonParse<string[]>(row.groundItemIds, []),
      position: safeJsonParse<{ x: number; y: number; z: number }>(
        row.position,
        { x: 0, y: 0, z: 0 },
      ),
      timestamp: row.timestamp,
      zoneType: row.zoneType,
      itemCount: row.itemCount,
      items: (row.items as DeathItemData[]) || [],
      keptItems: (row.keptItems as DeathItemData[]) || [],
      deathOperationId: row.deathOperationId,
      killedBy: row.killedBy,
      recovered: row.recovered,
    }));
  }

  /**
   * Mark a death as recovered after crash recovery processing
   *
   * Called after successfully recreating gravestones/ground items during
   * server startup recovery. This prevents duplicate recovery on subsequent restarts.
   *
   * @param playerId - The player ID whose death was recovered
   */
  async markDeathRecoveredAsync(playerId: string): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.db
      .update(schema.playerDeaths)
      .set({
        recovered: true,
        updatedAt: Date.now(),
      })
      .where(eq(schema.playerDeaths.playerId, playerId));
  }

  /**
   * Atomic death lock acquisition (check-and-create)
   *
   * Atomically checks if a player already has a death lock and creates one if not.
   * This prevents race conditions where a player could die multiple times simultaneously.
   *
   * Uses PostgreSQL's INSERT ... ON CONFLICT DO NOTHING with RETURNING to achieve
   * atomic check-and-create semantics.
   *
   * @param data - Death lock data to create
   * @param tx - Optional transaction context
   * @returns true if death lock was created, false if player already has one
   */
  async acquireDeathLockAsync(
    data: DeathLockData,
    tx?: NodePgDatabase<typeof schema>,
  ): Promise<boolean> {
    if (this.isDestroying) {
      return false;
    }

    this.ensureDatabase();

    const now = Date.now();
    const db = tx || this.db;

    // Use INSERT ... ON CONFLICT DO NOTHING with RETURNING
    // If conflict occurs (player already has death lock), nothing is returned
    const result = await db
      .insert(schema.playerDeaths)
      .values({
        playerId: data.playerId,
        gravestoneId: data.gravestoneId,
        groundItemIds: JSON.stringify(data.groundItemIds),
        position: JSON.stringify(data.position),
        timestamp: data.timestamp,
        zoneType: data.zoneType,
        itemCount: data.itemCount,
        items: data.items,
        keptItems: data.keptItems ?? [],
        deathOperationId: data.deathOperationId ?? null,
        killedBy: data.killedBy,
        recovered: data.recovered,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: schema.playerDeaths.playerId })
      .returning({ playerId: schema.playerDeaths.playerId });

    // If result has a row, the insert succeeded (lock acquired)
    // If result is empty, conflict occurred (player already has death lock)
    return result.length > 0;
  }
}
