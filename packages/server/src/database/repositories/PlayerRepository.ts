/**
 * PlayerRepository - Player data persistence operations
 *
 * Handles all player-related database operations including stats, levels, XP,
 * health, coins, and position. This is the core persistence for character progression.
 *
 * Responsibilities:
 * - Load player data from database
 * - Save/update player data (partial updates supported)
 * - Handle skill levels and XP
 * - Persist player position and health
 *
 * Used by: ServerNetwork, game systems that modify player state
 */

import { eq, sql } from "drizzle-orm";
import { BaseRepository } from "./BaseRepository";
import * as schema from "../schema";
import type { PlayerPersistenceUpdate, PlayerRow } from "../../shared/types";
import {
  assertGenericPlayerUpdateExcludesAttackStyleAuthority,
  assertGenericPlayerUpdateExcludesPrayerAuthority,
} from "../prayer-custody-policy";
import {
  buildGenericCharacterUpdate,
  type GenericCharacterUpdate,
} from "../generic-player-update";

/**
 * PlayerRepository class
 *
 * Provides all player data persistence operations.
 */
export class PlayerRepository extends BaseRepository {
  /**
   * Load player data from database
   *
   * Retrieves all persistent data for a player including stats, levels, position,
   * and currency. Returns null if the player doesn't exist in the database yet.
   * Includes automatic retry for transient connection failures.
   *
   * @param playerId - The character/player ID to load
   * @returns Player data or null if not found
   */
  async getPlayerAsync(playerId: string): Promise<PlayerRow | null> {
    this.ensureDatabase();

    return this.withRetry(async () => {
      const results = await this.db
        .select()
        .from(schema.characters)
        .where(eq(schema.characters.id, playerId))
        .limit(1);

      if (results.length === 0) return null;

      const row = results[0];
      return {
        ...row,
        playerId: row.id,
        createdAt: row.createdAt || Date.now(),
        lastLogin: row.lastLogin || Date.now(),
      } as PlayerRow;
    }, `getPlayer(${playerId})`);
  }

  /**
   * Save player data to database
   *
   * Updates existing player data ONLY. Does NOT create new characters.
   * Characters must be created explicitly via CharacterRepository.createCharacter().
   * Only the fields provided in the data parameter are updated; others remain unchanged.
   * This allows for partial updates (e.g., just updating health without touching XP).
   *
   * @param playerId - The character/player ID to save
   * @param data - Partial player data to save (only provided fields are updated)
   */
  /**
   * Build the Drizzle update object from a partial PlayerRow.
   * Maps only the fields that were actually provided in the data param.
   * Shared by savePlayerAsync and batchSavePlayersAsync.
   */
  private buildUpdateData(
    data: PlayerPersistenceUpdate,
  ): GenericCharacterUpdate {
    assertGenericPlayerUpdateExcludesPrayerAuthority(
      data,
      "PlayerRepository.buildUpdateData",
    );
    assertGenericPlayerUpdateExcludesAttackStyleAuthority(
      data,
      "PlayerRepository.buildUpdateData",
    );
    return buildGenericCharacterUpdate(data);
  }

  async savePlayerAsync(
    playerId: string,
    data: PlayerPersistenceUpdate,
  ): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    const updateData = this.buildUpdateData(data);

    if (Object.keys(updateData).length === 0) {
      return;
    }

    // UPDATE ONLY - does NOT create characters
    // Includes automatic retry for transient connection failures
    await this.withRetry(async () => {
      await this.db
        .update(schema.characters)
        .set(updateData)
        .where(eq(schema.characters.id, playerId));
    }, `savePlayer(${playerId})`);
  }

  /**
   * Batch save multiple players in a single database transaction.
   *
   * Instead of acquiring N separate pool connections (one per player),
   * this runs all UPDATEs sequentially within one transaction on a single
   * connection. This prevents connection pool exhaustion when many players
   * are being saved concurrently (e.g., from the debounce flush).
   *
   * @param players - Map of playerId → partial data to save
   */
  async batchSavePlayersAsync(
    players: Map<string, PlayerPersistenceUpdate>,
  ): Promise<void> {
    if (this.isDestroying || players.size === 0) {
      return;
    }

    this.ensureDatabase();

    // Build all update objects up front, filter out empty updates
    const updates: Array<{
      playerId: string;
      data: GenericCharacterUpdate;
    }> = [];

    for (const [playerId, playerData] of players) {
      const updateData = this.buildUpdateData(playerData);
      if (Object.keys(updateData).length > 0) {
        updates.push({ playerId, data: updateData });
      }
    }

    if (updates.length === 0) {
      return;
    }

    // Run all updates in a single transaction (1 connection, N sequential writes)
    await this.withRetry(async () => {
      await this.withTransaction(async (tx) => {
        for (const { playerId, data } of updates) {
          await tx
            .update(schema.characters)
            .set(data)
            .where(eq(schema.characters.id, playerId));
        }
      }, `batchSavePlayers(${updates.length})`);
    }, `batchSavePlayers(${updates.length})`);
  }

  /**
   * Get count of all players
   *
   * Returns the total number of characters in the database.
   * Includes automatic retry for transient connection failures.
   *
   * @returns Total number of players
   */
  async getPlayerCountAsync(): Promise<number> {
    this.ensureDatabase();

    return this.withRetry(async () => {
      const result = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.characters);

      return result[0]?.count ?? 0;
    }, "getPlayerCount");
  }
}
