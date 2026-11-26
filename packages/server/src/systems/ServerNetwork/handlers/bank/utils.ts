/**
 * Bank Handler Utilities
 *
 * Shared utilities for all bank handler modules.
 * IMPORTANT: This module must NOT import from any handler module to prevent circular imports.
 */

import { getItem, INPUT_LIMITS } from "@hyperforge/shared";
import type { ServerSocket } from "../../../../shared/types";
import { BankRepository } from "../../../../database/repositories/BankRepository";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type * as schema from "../../../../database/schema";
import { sql } from "drizzle-orm";
import { RateLimitService } from "../../services";
import { sendToSocket, type DrizzleTransaction } from "../common";

// ============================================================================
// SHARED STATE
// ============================================================================

/** Single rate limiter instance shared across all bank modules */
export const rateLimiter = new RateLimitService();

/** Local aliases for shared constants */
export const MAX_INVENTORY_SLOTS = INPUT_LIMITS.MAX_INVENTORY_SLOTS;
export const MAX_BANK_SLOTS = INPUT_LIMITS.MAX_BANK_SLOTS;

// ============================================================================
// BANK OPERATION CONSTANTS
// ============================================================================

/**
 * Maximum number of custom tabs (tabs 1-9).
 * Tab 0 is the main tab and always exists.
 */
export const MAX_CUSTOM_TABS = 9;

/**
 * Temporary slot offset used in two-phase updates to avoid unique constraint violations.
 * PostgreSQL doesn't guarantee UPDATE order, so we use a large offset to move slots
 * far away from normal range, then adjust to final values in a second pass.
 */
export const SLOT_OFFSET_TEMP = 1000;

/**
 * Recovery offset for two-phase updates: SLOT_OFFSET_TEMP + 1.
 * Subtracting this from offset slots gives the final value (shifted down by 1).
 */
export const SLOT_OFFSET_RECOVER = 1001;

/**
 * Temporary slot value used during swap operations.
 * Must be outside valid slot range to avoid conflicts.
 */
export const TEMP_SWAP_SLOT = -1000;

/**
 * Coin threshold for audit logging.
 * Transactions >= this amount are logged for security monitoring.
 */
export const AUDIT_COIN_THRESHOLD = 1_000_000;

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Validate item exists in game database
 * Prevents issues with items removed from game after being deposited
 */
export function isValidGameItem(itemId: string): boolean {
  const item = getItem(itemId);
  return item !== null;
}

// ============================================================================
// SQL ROW TYPE DEFINITIONS
// ============================================================================

/**
 * Inventory row data from database
 */
export interface InventoryRowData {
  id: number;
  playerId: string;
  itemId: string;
  quantity: number | null;
  slotIndex: number | null;
}

/**
 * Bank storage row data from database
 */
export interface BankRowData {
  id: number;
  playerId: string;
  itemId: string;
  quantity: number;
  slot: number;
  tabIndex: number;
}

/**
 * Bank tab row data from database
 */
export interface BankTabRowData {
  id: number;
  playerId: string;
  tabIndex: number;
  iconItemId: string | null;
}

// ============================================================================
// SQL ROW VALIDATORS
// ============================================================================

/**
 * Validate and cast inventory rows from SQL result
 * Throws on invalid data to prevent silent failures
 */
export function validateInventoryRows(rows: unknown[]): InventoryRowData[] {
  return rows.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`INVALID_INVENTORY_ROW_${index}: not an object`);
    }
    const r = row as Record<string, unknown>;

    if (typeof r.id !== "number") {
      throw new Error(`INVALID_INVENTORY_ROW_${index}: invalid id`);
    }
    if (typeof r.playerId !== "string") {
      throw new Error(`INVALID_INVENTORY_ROW_${index}: invalid playerId`);
    }
    if (typeof r.itemId !== "string") {
      throw new Error(`INVALID_INVENTORY_ROW_${index}: invalid itemId`);
    }
    // quantity and slotIndex can be null
    if (r.quantity !== null && typeof r.quantity !== "number") {
      throw new Error(`INVALID_INVENTORY_ROW_${index}: invalid quantity`);
    }
    if (r.slotIndex !== null && typeof r.slotIndex !== "number") {
      throw new Error(`INVALID_INVENTORY_ROW_${index}: invalid slotIndex`);
    }

    return {
      id: r.id,
      playerId: r.playerId,
      itemId: r.itemId,
      quantity: r.quantity as number | null,
      slotIndex: r.slotIndex as number | null,
    };
  });
}

/**
 * Validate and cast bank storage rows from SQL result
 * Throws on invalid data to prevent silent failures
 */
export function validateBankRows(rows: unknown[]): BankRowData[] {
  return rows.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`INVALID_BANK_ROW_${index}: not an object`);
    }
    const r = row as Record<string, unknown>;

    if (typeof r.id !== "number") {
      throw new Error(`INVALID_BANK_ROW_${index}: invalid id`);
    }
    if (typeof r.playerId !== "string") {
      throw new Error(`INVALID_BANK_ROW_${index}: invalid playerId`);
    }
    if (typeof r.itemId !== "string") {
      throw new Error(`INVALID_BANK_ROW_${index}: invalid itemId`);
    }
    if (typeof r.quantity !== "number") {
      throw new Error(`INVALID_BANK_ROW_${index}: invalid quantity`);
    }
    if (typeof r.slot !== "number") {
      throw new Error(`INVALID_BANK_ROW_${index}: invalid slot`);
    }
    if (typeof r.tabIndex !== "number") {
      throw new Error(`INVALID_BANK_ROW_${index}: invalid tabIndex`);
    }

    return {
      id: r.id,
      playerId: r.playerId,
      itemId: r.itemId,
      quantity: r.quantity,
      slot: r.slot,
      tabIndex: r.tabIndex,
    };
  });
}

/**
 * Validate and cast bank tab rows from SQL result
 */
export function validateBankTabRows(rows: unknown[]): BankTabRowData[] {
  return rows.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`INVALID_BANK_TAB_ROW_${index}: not an object`);
    }
    const r = row as Record<string, unknown>;

    if (typeof r.id !== "number") {
      throw new Error(`INVALID_BANK_TAB_ROW_${index}: invalid id`);
    }
    if (typeof r.playerId !== "string") {
      throw new Error(`INVALID_BANK_TAB_ROW_${index}: invalid playerId`);
    }
    if (typeof r.tabIndex !== "number") {
      throw new Error(`INVALID_BANK_TAB_ROW_${index}: invalid tabIndex`);
    }
    // iconItemId can be null
    if (r.iconItemId !== null && typeof r.iconItemId !== "string") {
      throw new Error(`INVALID_BANK_TAB_ROW_${index}: invalid iconItemId`);
    }

    return {
      id: r.id,
      playerId: r.playerId,
      tabIndex: r.tabIndex,
      iconItemId: r.iconItemId as string | null,
    };
  });
}

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

/**
 * Compact bank slots after an item is deleted.
 *
 * classic MMORPG-style behavior: When an item is fully withdrawn, remaining items
 * shift left to fill the gap. No empty slots in the middle of the bank.
 *
 * NOTE: This compacts within the CURRENT tab only (tab 0 by default for backwards compatibility).
 * Uses two-phase approach to avoid unique constraint violations:
 * 1. Add +1000 offset to slots > deletedSlot
 * 2. Subtract 1001 to get final values (shifted down by 1)
 *
 * @param tx - Database transaction
 * @param playerId - Player whose bank to compact
 * @param deletedSlot - The slot that was just deleted
 * @param tabIndex - Tab to compact (default 0 for backwards compatibility)
 */
export async function compactBankSlots(
  tx: DrizzleTransaction,
  playerId: string,
  deletedSlot: number,
  tabIndex: number = 0,
): Promise<void> {
  // TWO-PHASE SLOT COMPACTION to avoid unique constraint violations.
  // PostgreSQL doesn't guarantee UPDATE order, so if slot 4 tries to become slot 3
  // before slot 3 becomes slot 2, they collide on the same (playerId, tabIndex, slot) key.
  //
  // Solution: First add SLOT_OFFSET_TEMP to move them far away, then subtract SLOT_OFFSET_RECOVER.

  // Add large offset to avoid conflicts during shift
  await tx.execute(
    sql`UPDATE bank_storage
        SET slot = slot + ${SLOT_OFFSET_TEMP}
        WHERE "playerId" = ${playerId}
          AND "tabIndex" = ${tabIndex}
          AND slot > ${deletedSlot}`,
  );

  // Subtract offset + 1 to get final values (shifted down by 1)
  await tx.execute(
    sql`UPDATE bank_storage
        SET slot = slot - ${SLOT_OFFSET_RECOVER}
        WHERE "playerId" = ${playerId}
          AND "tabIndex" = ${tabIndex}
          AND slot > ${SLOT_OFFSET_TEMP}`,
  );
}

// ============================================================================
// STATE SYNC
// ============================================================================

/**
 * Send full bank state including tabs to client
 * Helper function for all bank handlers to send consistent state
 *
 * modern MMORPG-STYLE PLACEHOLDERS:
 * - Placeholders are just bank_storage rows with quantity = 0
 * - No separate placeholders array needed - items with qty=0 ARE placeholders
 * - Client renders qty=0 items with greyed-out style
 */
export async function sendBankStateWithTabs(
  socket: ServerSocket,
  playerId: string,
  db: { drizzle: NodePgDatabase<typeof schema>; pool: pg.Pool },
  responseContext?: { requestId?: string },
): Promise<void> {
  const bankRepo = new BankRepository(db.drizzle, db.pool);
  // modern MMORPG-style: getPlayerBank now includes qty=0 items (placeholders)
  const bankItems = await bankRepo.getPlayerBank(playerId);
  const bankTabs = await bankRepo.getPlayerTabs(playerId);
  const alwaysSetPlaceholder = await bankRepo.getAlwaysSetPlaceholder(playerId);

  sendToSocket(socket, "bankState", {
    playerId,
    items: bankItems, // Includes qty=0 items (placeholders)
    tabs: bankTabs,
    alwaysSetPlaceholder,
    maxSlots: MAX_BANK_SLOTS,
    ...(responseContext?.requestId
      ? { requestId: responseContext.requestId }
      : {}),
  });
}
