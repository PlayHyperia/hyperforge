/**
 * EquipmentRepository - Player equipment management operations
 *
 * Handles equipment (worn/wielded items) for players including weapons, armor, etc.
 * Each slot type (e.g., "weapon", "helmet") can hold one item.
 *
 * Responsibilities:
 * - Load player equipment from database
 * - Save complete equipment state (atomic replace)
 * - Handle equipment slots (weapon, helmet, chest, legs, boots, etc.)
 *
 * Used by: Equipment system, combat calculations, character display
 */

import { eq, and, notInArray } from "drizzle-orm";
import { BaseRepository } from "./BaseRepository";
import * as schema from "../schema";
import type { EquipmentRow, EquipmentSaveItem } from "../../shared/types";

/**
 * EquipmentRepository class
 *
 * Provides all equipment management operations.
 */
export class EquipmentRepository extends BaseRepository {
  /**
   * Load player equipment from database
   *
   * Retrieves all equipped items for a player across all equipment slots.
   * Returns empty array if player has no equipped items.
   *
   * @param playerId - The player ID to fetch equipment for
   * @returns Array of equipped items by slot
   */
  async getPlayerEquipmentAsync(playerId: string): Promise<EquipmentRow[]> {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.equipment)
      .where(eq(schema.equipment.playerId, playerId));

    return results as EquipmentRow[];
  }

  /**
   * Save player equipment to database
   *
   * Uses upsert pattern to handle concurrent saves safely.
   * For each equipped item, inserts or updates the row.
   * Removes any slots not in the current equipment set.
   *
   * @param playerId - The player ID to save equipment for
   * @param items - Complete equipment state to save
   */
  async savePlayerEquipmentAsync(
    playerId: string,
    items: EquipmentSaveItem[],
  ): Promise<void> {
    if (this.isDestroying) {
      // Gracefully skip during shutdown
      return;
    }

    this.ensureDatabase();

    await this.withTransaction(async (tx) => {
      if (items.length > 0) {
        // Upsert each equipment slot - handles concurrent saves safely
        for (const item of items) {
          await tx
            .insert(schema.equipment)
            .values({
              playerId,
              slotType: item.slotType,
              itemId: item.itemId || null,
              quantity: item.quantity ?? 1,
            })
            .onConflictDoUpdate({
              target: [schema.equipment.playerId, schema.equipment.slotType],
              set: {
                itemId: item.itemId || null,
                quantity: item.quantity ?? 1,
              },
            });
        }

        // Delete any slots not in the current equipment set
        const equippedSlots = items.map((item) => item.slotType);
        await tx
          .delete(schema.equipment)
          .where(
            and(
              eq(schema.equipment.playerId, playerId),
              notInArray(schema.equipment.slotType, equippedSlots),
            ),
          );
      } else {
        // No equipment - delete all
        await tx
          .delete(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
      }
    });
  }
}
