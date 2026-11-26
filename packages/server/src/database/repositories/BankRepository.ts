/**
 * BankRepository - Player bank storage operations
 *
 * Handles player bank storage with 480 slots (12 tabs × 40 slots).
 * All items stack in bank for MVP simplification.
 *
 * Responsibilities:
 * - Load player bank from database
 * - Save complete bank state (atomic replace)
 * - Deposit items (with stacking)
 * - Withdraw items
 *
 * Used by: Banking system, bank UI interactions
 */

import { eq } from "drizzle-orm";
import { BaseRepository } from "./BaseRepository";
import * as schema from "../schema";

/**
 * Bank item representation
 */
export interface BankItem {
  itemId: string;
  quantity: number;
  slot: number;
  tabIndex: number;
}

/**
 * Bank tab representation
 */
export interface BankTab {
  tabIndex: number;
  iconItemId: string | null;
}

/**
 * Bank placeholder representation (classic MMORPG-style slot reservation)
 */
export interface BankPlaceholder {
  tabIndex: number;
  slot: number;
  itemId: string;
}

/**
 * BankRepository class
 *
 * Provides all bank storage management operations.
 */
export class BankRepository extends BaseRepository {
  /**
   * Load player bank from database
   *
   * Retrieves all items in a player's bank, ordered by tab and slot.
   *
   * @param playerId - The player ID to fetch bank for
   * @returns Array of bank items
   */
  async getPlayerBank(playerId: string): Promise<BankItem[]> {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.bankStorage)
      .where(eq(schema.bankStorage.playerId, playerId))
      .orderBy(schema.bankStorage.tabIndex, schema.bankStorage.slot);

    return results.map((row) => ({
      itemId: row.itemId,
      quantity: row.quantity ?? 1,
      slot: row.slot ?? 0,
      tabIndex: row.tabIndex ?? 0,
    }));
  }

  /**
   * Load player bank tabs from database
   *
   * Retrieves all custom tabs (1-9) for a player.
   * Tab 0 (main) is implicit and not stored.
   *
   * @param playerId - The player ID to fetch tabs for
   * @returns Array of bank tabs
   */
  async getPlayerTabs(playerId: string): Promise<BankTab[]> {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.bankTabs)
      .where(eq(schema.bankTabs.playerId, playerId))
      .orderBy(schema.bankTabs.tabIndex);

    return results.map((row) => ({
      tabIndex: row.tabIndex,
      iconItemId: row.iconItemId,
    }));
  }

  /**
   * Save player bank to database
   *
   * Performs an atomic replace of the entire bank using a transaction.
   *
   * @param playerId - The player ID to save bank for
   * @param items - Complete bank state to save
   */
  async savePlayerBank(playerId: string, items: BankItem[]): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.withTransaction(async (tx) => {
      // Delete existing bank items
      await tx
        .delete(schema.bankStorage)
        .where(eq(schema.bankStorage.playerId, playerId));

      // Insert new items
      if (items.length > 0) {
        await tx.insert(schema.bankStorage).values(
          items.map((item) => ({
            playerId,
            itemId: item.itemId,
            quantity: item.quantity,
            slot: item.slot,
            tabIndex: item.tabIndex,
          })),
        );
      }
    });
  }

  /**
   * Save player bank tabs to database
   *
   * Performs an atomic replace of all tabs using a transaction.
   *
   * @param playerId - The player ID to save tabs for
   * @param tabs - Complete tabs state to save
   */
  async savePlayerTabs(playerId: string, tabs: BankTab[]): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.withTransaction(async (tx) => {
      // Delete existing tabs
      await tx
        .delete(schema.bankTabs)
        .where(eq(schema.bankTabs.playerId, playerId));

      // Insert new tabs (only custom tabs 1-9, tab 0 is implicit)
      const customTabs = tabs.filter((tab) => tab.tabIndex > 0);
      if (customTabs.length > 0) {
        await tx.insert(schema.bankTabs).values(
          customTabs.map((tab) => ({
            playerId,
            tabIndex: tab.tabIndex,
            iconItemId: tab.iconItemId,
          })),
        );
      }
    });
  }

  /**
   * Save complete bank state (items and tabs) atomically
   *
   * Performs an atomic replace of both items and tabs in a single transaction.
   * This ensures consistency - either both succeed or both fail.
   *
   * @param playerId - The player ID to save bank for
   * @param data - Complete bank state including items and tabs
   */
  async savePlayerBankComplete(
    playerId: string,
    data: { items: BankItem[]; tabs: BankTab[] },
  ): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.withTransaction(async (tx) => {
      // Delete existing bank items
      await tx
        .delete(schema.bankStorage)
        .where(eq(schema.bankStorage.playerId, playerId));

      // Delete existing tabs
      await tx
        .delete(schema.bankTabs)
        .where(eq(schema.bankTabs.playerId, playerId));

      // Insert new items
      if (data.items.length > 0) {
        await tx.insert(schema.bankStorage).values(
          data.items.map((item) => ({
            playerId,
            itemId: item.itemId,
            quantity: item.quantity,
            slot: item.slot,
            tabIndex: item.tabIndex,
          })),
        );
      }

      // Insert new tabs (only custom tabs 1-9, tab 0 is implicit)
      const customTabs = data.tabs.filter((tab) => tab.tabIndex > 0);
      if (customTabs.length > 0) {
        await tx.insert(schema.bankTabs).values(
          customTabs.map((tab) => ({
            playerId,
            tabIndex: tab.tabIndex,
            iconItemId: tab.iconItemId,
          })),
        );
      }
    });
  }

  /**
   * Load player placeholders from database
   *
   * Retrieves all placeholders (reserved slots) for a player.
   * Placeholders show grayed-out items where withdrawn items can return.
   *
   * @param playerId - The player ID to fetch placeholders for
   * @returns Array of bank placeholders
   */
  async getPlayerPlaceholders(playerId: string): Promise<BankPlaceholder[]> {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.bankPlaceholders)
      .where(eq(schema.bankPlaceholders.playerId, playerId))
      .orderBy(schema.bankPlaceholders.tabIndex, schema.bankPlaceholders.slot);

    return results.map((row) => ({
      tabIndex: row.tabIndex ?? 0,
      slot: row.slot,
      itemId: row.itemId,
    }));
  }

  /**
   * Get player's placeholder setting
   *
   * @param playerId - The player ID
   * @returns Whether "always set placeholder" is enabled
   */
  async getAlwaysSetPlaceholder(playerId: string): Promise<boolean> {
    this.ensureDatabase();

    const result = await this.db
      .select({ alwaysSetPlaceholder: schema.characters.alwaysSetPlaceholder })
      .from(schema.characters)
      .where(eq(schema.characters.id, playerId));

    if (result.length === 0) {
      return false;
    }

    return result[0].alwaysSetPlaceholder === 1;
  }
}
