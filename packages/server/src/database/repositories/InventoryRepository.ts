/**
 * InventoryRepository - Player inventory management operations
 *
 * Handles player inventory storage with 28 slots (like classic fantasy MMORPG classic).
 * Each item has an ID, quantity, slot index, and optional metadata.
 *
 * Responsibilities:
 * - Load player inventory from database
 * - Save complete inventory state (atomic slot replacement)
 * - Handle item metadata (JSON serialization)
 *
 * Used by: Inventory system, item pickup/drop, trading
 */

import { eq, sql } from "drizzle-orm";
import { BaseRepository } from "./BaseRepository";
import * as schema from "../schema";
import type { InventoryRow, InventorySaveItem } from "../../shared/types";

/**
 * InventoryRepository class
 *
 * Provides all inventory management operations.
 */
export class InventoryRepository extends BaseRepository {
  /**
   * Load player inventory from database
   *
   * Retrieves all items in a player's inventory, ordered by slot index.
   * Metadata is automatically parsed from JSON string to object.
   * Includes automatic retry for transient connection failures.
   *
   * @param playerId - The player ID to fetch inventory for
   * @returns Array of inventory items
   */
  async getPlayerInventoryAsync(playerId: string): Promise<InventoryRow[]> {
    this.ensureDatabase();

    return this.withRetry(async () => {
      const results = await this.db
        .select()
        .from(schema.inventory)
        .where(eq(schema.inventory.playerId, playerId))
        .orderBy(schema.inventory.slotIndex);

      return results.map((row) => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
      })) as InventoryRow[];
    }, `getPlayerInventory(${playerId})`);
  }

  /**
   * Save player inventory to database
   *
   * Uses a two-phase approach to handle race conditions:
   * 1. Delete slots that are no longer occupied
   * 2. Replace current items per slot (delete slot then insert)
   *
   * This prevents duplicate key errors when concurrent saves occur and avoids
   * dependence on the partial unique index in local/dev databases.
   *
   * Includes automatic retry for:
   * - Transient connection failures (handled by withRetry)
   * - Deadlocks (handled by internal retry loop)
   *
   * @param playerId - The player ID to save inventory for
   * @param items - Complete inventory state to save
   */
  async savePlayerInventoryAsync(
    playerId: string,
    items: InventorySaveItem[],
  ): Promise<void> {
    if (this.isDestroying) {
      // Gracefully skip during shutdown
      return;
    }

    this.ensureDatabase();

    // Get the slots currently occupied (valid slots only)
    const validItems = items.filter((item) => (item.slotIndex ?? -1) >= 0);
    const occupiedSlots = validItems.map((item) => item.slotIndex!);

    // Wrap in connection retry for transient failures
    return this.withRetry(async () => {
      // Retry logic for deadlocks (PostgreSQL error code 40P01)
      const maxDeadlockRetries = 3;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < maxDeadlockRetries; attempt++) {
        try {
          await this.withTransaction(async (tx) => {
            // Step 1: Delete items in slots that are no longer occupied
            if (occupiedSlots.length > 0) {
              // Delete slots NOT in the current occupied list
              await tx.execute(
                sql`DELETE FROM inventory
                    WHERE "playerId" = ${playerId}
                    AND "slotIndex" >= 0
                    AND "slotIndex" NOT IN (${sql.join(
                      occupiedSlots.map((s) => sql`${s}`),
                      sql`, `,
                    )})`,
              );
            } else {
              // No items - delete all inventory for this player
              await tx
                .delete(schema.inventory)
                .where(eq(schema.inventory.playerId, playerId));
            }

            // Step 2: Replace each slot deterministically.
            // Delete+insert avoids ON CONFLICT failures (42P10) when the partial
            // unique index is missing in local/dev databases.
            for (const item of validItems) {
              const slotIndex = item.slotIndex!;
              const metadata = item.metadata
                ? JSON.stringify(item.metadata)
                : null;

              await tx.execute(
                sql`DELETE FROM inventory
                    WHERE "playerId" = ${playerId}
                    AND "slotIndex" = ${slotIndex}`,
              );
              await tx.execute(
                sql`INSERT INTO inventory ("playerId", "itemId", "quantity", "slotIndex", "metadata")
                    VALUES (${playerId}, ${item.itemId}, ${item.quantity}, ${slotIndex}, ${metadata})`,
              );
            }
          });
          // Success - exit retry loop
          return;
        } catch (error) {
          lastError = error as Error;
          const errorMsg = String(error);
          // Check for deadlock (40P01) or serialization failure (40001)
          if (
            errorMsg.includes("deadlock") ||
            errorMsg.includes("40P01") ||
            errorMsg.includes("could not serialize") ||
            errorMsg.includes("40001")
          ) {
            if (attempt < maxDeadlockRetries - 1) {
              // Exponential backoff: 50ms, 100ms, 200ms
              const delay = 50 * Math.pow(2, attempt);
              console.warn(
                `[InventoryRepository] Deadlock detected for ${playerId}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxDeadlockRetries})`,
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }
          }
          // Non-retryable error or max retries exceeded
          throw error;
        }
      }

      // This should only be reached if all retries failed
      if (lastError) {
        throw lastError;
      }
    }, `savePlayerInventory(${playerId})`);
  }
}
