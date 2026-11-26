/**
 * Core Bank Handlers
 *
 * Primary bank operations:
 * - handleBankOpen: Open bank interface
 * - handleBankDeposit: Deposit items from inventory
 * - handleBankWithdraw: Withdraw items to inventory
 * - handleBankDepositAll: Deposit all inventory items
 * - handleBankClose: Close bank interface
 */

import {
  type World,
  EventType,
  SessionType,
  getNotedItem,
  canBeNoted,
  isNotedItemId,
  getBaseItemId,
  getItem,
} from "@hyperforge/shared";
import type { ServerSocket } from "../../../../shared/types";
import { BankRepository } from "../../../../database/repositories/BankRepository";
import * as schema from "../../../../database/schema";
import { validatePhysicalBankAccess } from "../../../../shared/PhysicalBankAccess";
import { eq, sql } from "drizzle-orm";

import { isValidItemId, isValidQuantity, wouldOverflow } from "../../services";

import {
  validateTransactionRequest,
  executeSecureTransaction,
  executeInventoryTransaction,
  sendToSocket,
  sendErrorToast,
  getPlayerId,
  getDatabase,
  getSessionManager,
} from "../common";

import {
  rateLimiter,
  isValidGameItem,
  compactBankSlots,
  sendBankStateWithTabs,
  MAX_INVENTORY_SLOTS,
  MAX_BANK_SLOTS,
} from "./utils";

// Import coin handler for bank withdraw redirect (coins go to money pouch, modern MMORPG-style)
import { handleBankWithdrawCoins } from "./coins";

const BANK_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getBankRequestId(value: unknown): string | undefined {
  return typeof value === "string" && BANK_REQUEST_ID_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * Handle bank open request
 *
 * Loads player's bank from database and sends state to client.
 * InteractionSessionManager automatically tracks the session with targetEntityId.
 */
export async function handleBankOpen(
  socket: ServerSocket,
  data: { bankId: string; requestId?: string },
  world: World,
): Promise<void> {
  const playerId = getPlayerId(socket);
  if (!playerId) {
    console.warn("[BankHandler] No player on socket for bankOpen");
    return;
  }

  // Block bank access during duels
  const duelSystemBank = world.getSystem("duel") as
    { isPlayerInDuel?: (id: string) => boolean } | undefined;
  if (duelSystemBank?.isPlayerInDuel?.(playerId)) {
    sendToSocket(socket, "showToast", {
      message: "You can't use a bank during a duel.",
      type: "error",
    });
    return;
  }

  // Validate bankId before processing
  if (
    typeof data.bankId !== "string" ||
    !data.bankId ||
    data.bankId.trim() !== data.bankId
  ) {
    console.warn(
      `[BankHandler] bankOpen called with undefined bankId for player ${playerId}`,
    );
    sendToSocket(socket, "showToast", {
      message: "Invalid bank",
      type: "error",
    });
    return;
  }

  const accessFailure = validatePhysicalBankAccess(
    world,
    playerId,
    data.bankId,
  );
  if (accessFailure) {
    sendToSocket(socket, "showToast", {
      message:
        accessFailure === "bank_out_of_range"
          ? "You need to be closer to the bank."
          : accessFailure === "duel_locked"
            ? "You can't use a bank during a duel."
            : "Invalid bank",
      type: "error",
    });
    return;
  }

  const db = getDatabase(world);
  if (!db) {
    console.error("[BankHandler] No database available");
    return;
  }

  try {
    const bankRepo = new BankRepository(db.drizzle, db.pool);
    // modern MMORPG-style: items includes qty=0 rows (placeholders)
    const items = await bankRepo.getPlayerBank(playerId);
    const tabs = await bankRepo.getPlayerTabs(playerId);
    const alwaysSetPlaceholder =
      await bankRepo.getAlwaysSetPlaceholder(playerId);

    // InteractionSessionManager now tracks targetEntityId as single source of truth

    // Send bank state to client (include isOpen and bankId for initial open)
    // modern MMORPG-style: no separate placeholders array - items with qty=0 ARE placeholders
    sendToSocket(socket, "bankState", {
      playerId,
      bankId: data.bankId,
      items, // Includes qty=0 items (placeholders)
      tabs,
      alwaysSetPlaceholder,
      maxSlots: MAX_BANK_SLOTS,
      isOpen: true,
      ...(getBankRequestId(data.requestId)
        ? { requestId: data.requestId }
        : {}),
    });

    // Emit event for InteractionSessionManager to track the session
    // InteractionSessionManager listens to this and creates session with targetEntityId = bankEntityId
    world.emit(EventType.BANK_OPEN, {
      playerId,
      bankId: data.bankId,
      bankEntityId: data.bankId, // For banks, bankId IS the entity ID
    });
  } catch (error) {
    console.error("[BankHandler] Error opening bank:", error);
    sendToSocket(socket, "showToast", {
      message: "Failed to open bank",
      type: "error",
    });
  }
}

/**
 * Handle bank deposit request
 *
 * SECURITY MEASURES (using common utilities):
 * - validateTransactionRequest: player, rate limit, distance, db
 * - Input validation (itemId, quantity)
 * - executeSecureTransaction: atomic transaction with row-level locking and retry
 * - emitInventorySyncEvents: in-memory cache sync
 *
 * INVENTORY MODEL (Non-stacking):
 * - Each inventory row represents ONE item (quantity = 1 typically)
 * - Multiple rows can have same itemId (e.g., 3 swords = 3 rows)
 *
 * BANK MODEL (Stacking):
 * - One row per itemId (all swords in one slot)
 * - quantity field tracks total count
 *
 * BANK NOTE SYSTEM:
 * - Depositing a noted item (e.g., "logs_noted") auto-converts to base item ("logs")
 * - Bank always stores base items, never notes
 */
export async function handleBankDeposit(
  socket: ServerSocket,
  data: {
    itemId: string;
    quantity: number;
    slot?: number;
    targetTabIndex?: number;
    requestId?: string;
  },
  world: World,
): Promise<void> {
  // NOTE: Coins are handled as regular stackable inventory items here.
  // This allows physical coins in inventory to be deposited to bank.
  // For depositing from money pouch, use bankDepositCoins packet instead.

  // Step 1: Common validation (player, rate limit, distance, db)
  const baseResult = validateTransactionRequest(
    socket,
    world,
    SessionType.BANK,
    rateLimiter,
  );

  if (!baseResult.success) {
    return; // Error already sent to client
  }

  const ctx = baseResult.context;

  // Step 2: Bank-specific input validation
  if (!isValidItemId(data.itemId)) {
    sendErrorToast(socket, "Invalid item");
    return;
  }

  // Validate item exists in game database (security: prevent depositing removed/invalid items)
  if (!isValidGameItem(data.itemId)) {
    console.warn(
      `[BankHandler] SECURITY: Player ${ctx.playerId} attempted to deposit unknown item: ${data.itemId}`,
    );
    sendErrorToast(socket, "This item does not exist");
    return;
  }

  if (!isValidQuantity(data.quantity)) {
    sendErrorToast(socket, "Invalid quantity");
    return;
  }

  // Block depositing staked items during duels
  if (data.slot !== undefined) {
    const duelSystemDeposit = world.getSystem("duel") as
      { getStakedSlots?: (id: string) => Set<number> } | undefined;
    const stakedSlotsDeposit = duelSystemDeposit?.getStakedSlots?.(
      ctx.playerId,
    );
    if (stakedSlotsDeposit?.has(data.slot)) {
      sendErrorToast(socket, "That item is staked in a duel.");
      return;
    }
  }

  // BANK NOTE SYSTEM: Auto-unnote deposited notes
  // Inventory uses the actual itemId (could be noted)
  // Bank stores the base item (auto-convert notes)
  const inventoryItemId = data.itemId;
  const bankItemId = isNotedItemId(data.itemId)
    ? getBaseItemId(data.itemId)
    : data.itemId;

  // Step 3: Execute transaction with inventory lock (prevents race conditions)
  const result = await executeInventoryTransaction(ctx, async () => {
    return executeSecureTransaction(ctx, {
      execute: async (tx) => {
        // Lock inventory rows for this item (use inventory item ID - could be noted)
        const inventoryItems = await tx.execute(
          sql`SELECT * FROM inventory
              WHERE "playerId" = ${ctx.playerId} AND "itemId" = ${inventoryItemId}
              ORDER BY "slotIndex"
              FOR UPDATE`,
        );

        const invRows = inventoryItems.rows as Array<{
          id: number;
          playerId: string;
          itemId: string;
          quantity: number | null;
          slotIndex: number | null;
        }>;

        if (invRows.length === 0) {
          throw new Error("ITEM_NOT_FOUND");
        }

        // Calculate total available quantity
        let totalAvailable = 0;
        for (const item of invRows) {
          totalAvailable += item.quantity ?? 1;
        }

        if (totalAvailable < data.quantity) {
          throw new Error("INSUFFICIENT_QUANTITY");
        }

        // Check bank item and verify no overflow (use bank item ID - always base item)
        const bankItems = await tx.execute(
          sql`SELECT * FROM bank_storage
              WHERE "playerId" = ${ctx.playerId} AND "itemId" = ${bankItemId}
              FOR UPDATE`,
        );

        const bankRows = bankItems.rows as Array<{
          id: number;
          quantity: number | null;
          slot: number | null;
        }>;

        if (bankRows.length > 0) {
          const currentBankQty = bankRows[0].quantity ?? 0;
          if (wouldOverflow(currentBankQty, data.quantity)) {
            throw new Error("QUANTITY_OVERFLOW");
          }
        }

        // Remove items from inventory
        const removedSlots: Array<{
          slot: number;
          quantity: number;
          itemId: string;
        }> = [];
        let remaining = data.quantity;

        for (const item of invRows) {
          if (remaining <= 0) break;

          const itemQty = item.quantity ?? 1;
          const itemSlot = item.slotIndex ?? -1;

          if (itemQty <= remaining) {
            await tx
              .delete(schema.inventory)
              .where(eq(schema.inventory.id, item.id));
            removedSlots.push({
              slot: itemSlot,
              quantity: itemQty,
              itemId: inventoryItemId,
            });
            remaining -= itemQty;
          } else {
            await tx
              .update(schema.inventory)
              .set({ quantity: itemQty - remaining })
              .where(eq(schema.inventory.id, item.id));
            removedSlots.push({
              slot: itemSlot,
              quantity: remaining,
              itemId: inventoryItemId,
            });
            remaining = 0;
          }
        }

        // Add to bank (stacking)
        // modern MMORPG-STYLE: If item exists (even with qty=0 placeholder), add to that slot
        if (bankRows.length > 0) {
          // Works for both normal items and qty=0 placeholders
          // qty=0 + newQty = newQty (placeholder becomes real item)
          await tx.execute(
            sql`UPDATE bank_storage
                SET quantity = quantity + ${data.quantity}
                WHERE id = ${bankRows[0].id}`,
          );
        } else {
          // No existing item - find next available bank slot IN TARGET TAB
          // modern MMORPG-style: New items go to the currently viewed tab
          const targetTab = data.targetTabIndex ?? 0;

          // Get items in the target tab to find next available slot
          const tabItems = await tx.execute(
            sql`SELECT slot FROM bank_storage
                WHERE "playerId" = ${ctx.playerId} AND "tabIndex" = ${targetTab}
                FOR UPDATE`,
          );

          const usedSlots = new Set(
            (tabItems.rows as Array<{ slot: number }>).map((i) => i.slot),
          );
          let nextSlot = 0;
          while (usedSlots.has(nextSlot) && nextSlot < MAX_BANK_SLOTS) {
            nextSlot++;
          }

          if (nextSlot >= MAX_BANK_SLOTS) {
            throw new Error("BANK_FULL");
          }

          // BANK NOTE SYSTEM: Always store base item (bankItemId), never notes
          await tx.insert(schema.bankStorage).values({
            playerId: ctx.playerId,
            itemId: bankItemId,
            quantity: data.quantity,
            slot: nextSlot,
            tabIndex: targetTab,
          });
        }

        return { removedSlots };
      },
    });
  });

  if (!result) return; // Error already handled

  // Step 4: Send updated bank state to client (with tabs for consistency)
  // NOTE: Inventory update is handled by reloadFromDatabase() which emits INVENTORY_UPDATED
  await sendBankStateWithTabs(socket, ctx.playerId, ctx.db, {
    requestId: getBankRequestId(data.requestId),
  });

  // NOTE: emitInventorySyncEvents removed - reloadFromDatabase() handles in-memory sync
}

/**
 * Handle bank withdraw request
 *
 * SECURITY MEASURES (using common utilities):
 * - validateTransactionRequest: player, rate limit, distance, db
 * - Input validation (itemId, quantity)
 * - executeSecureTransaction: atomic transaction with row-level locking and retry
 * - emitInventorySyncEvents: in-memory cache sync
 *
 * WITHDRAW FLOW:
 * - asNote=false (default): Each item gets its own inventory slot (qty=1)
 * - asNote=true: All items stack in one slot as noted variant
 *
 * BANK NOTE SYSTEM:
 * - When asNote=true and item is noteable, gives "{itemId}_noted" variant
 * - Noted items are stackable, so 1000 logs_noted = 1 inventory slot
 * - Only tradeable, non-stackable items can be noted
 */
export async function handleBankWithdraw(
  socket: ServerSocket,
  data: {
    itemId: string;
    quantity: number;
    asNote?: boolean;
    requestId?: string;
  },
  world: World,
): Promise<void> {
  // SPECIAL CASE: Coins should go to money pouch (CoinPouchSystem), not inventory
  // This handles clicking on coins in the bank grid
  if (data.itemId === "coins") {
    return handleBankWithdrawCoins(socket, { amount: data.quantity }, world);
  }

  // Step 1: Common validation (player, rate limit, distance, db)
  const baseResult = validateTransactionRequest(
    socket,
    world,
    SessionType.BANK,
    rateLimiter,
  );

  if (!baseResult.success) {
    return; // Error already sent to client
  }

  const ctx = baseResult.context;

  // Step 2: Bank-specific input validation
  if (!isValidItemId(data.itemId)) {
    sendErrorToast(socket, "Invalid item");
    return;
  }

  // Validate item exists in game database
  if (!isValidGameItem(data.itemId)) {
    console.warn(
      `[BankHandler] SECURITY: Player ${ctx.playerId} attempted to withdraw unknown item: ${data.itemId}`,
    );
    sendErrorToast(socket, "This item no longer exists");
    return;
  }

  if (!isValidQuantity(data.quantity)) {
    sendErrorToast(socket, "Invalid quantity");
    return;
  }

  // BANK NOTE SYSTEM: Determine if withdrawing as note
  const wantAsNote = data.asNote === true;
  const itemIsNoteable = canBeNoted(data.itemId);
  const withdrawAsNote = wantAsNote && itemIsNoteable;

  // If user requested note but item can't be noted, warn but continue with base item
  if (wantAsNote && !itemIsNoteable) {
    console.log(
      `[BankHandler] Note requested for non-noteable item ${data.itemId}, withdrawing as base item`,
    );
  }

  // Check if base item is stackable (like fishing bait, arrows, runes)
  const itemData = getItem(data.itemId);
  const isBaseStackable = itemData?.stackable === true;

  // Limit single withdrawal to max inventory size for non-stackable items only
  // Stackable items (notes or base stackable) all fit in 1 slot, so no limit needed
  const withdrawQty =
    withdrawAsNote || isBaseStackable
      ? data.quantity // Stackable items have no slot limit
      : Math.min(data.quantity, MAX_INVENTORY_SLOTS);

  // Step 3: Execute transaction with inventory lock (prevents race conditions)
  // The executeInventoryTransaction wrapper handles:
  // - Lock acquisition (blocks pickups, auto-save)
  // - Flush pending in-memory changes to DB
  // - Execute the transaction
  // - Reload from DB (in-memory now matches DB exactly)
  // - Unlock (in finally block)
  const result = await executeInventoryTransaction(ctx, async () => {
    return executeSecureTransaction(ctx, {
      execute: async (tx) => {
        // Lock and get current inventory to find used slots
        const inventoryResult = await tx.execute(
          sql`SELECT * FROM inventory
              WHERE "playerId" = ${ctx.playerId}
              FOR UPDATE`,
        );

        const inventoryItems = inventoryResult.rows as Array<{
          id: number;
          slotIndex: number | null;
        }>;

        // Calculate free slots
        const usedSlots = new Set<number>();
        for (const item of inventoryItems) {
          if (item.slotIndex !== null && item.slotIndex >= 0) {
            usedSlots.add(item.slotIndex);
          }
        }

        const freeSlots: number[] = [];
        for (let i = 0; i < MAX_INVENTORY_SLOTS; i++) {
          if (!usedSlots.has(i)) {
            freeSlots.push(i);
          }
        }

        // STACKING RULES (isBaseStackable already calculated above):
        // - Notes: 1 slot (always stackable)
        // - Stackable base items: 1 slot (stacks like notes)
        // - Non-stackable items: 1 slot per item
        const slotsNeeded = withdrawAsNote || isBaseStackable ? 1 : withdrawQty;

        if (freeSlots.length === 0) {
          throw new Error("INVENTORY_FULL");
        }

        if (
          freeSlots.length < slotsNeeded &&
          !withdrawAsNote &&
          !isBaseStackable
        ) {
          // For non-stackable base items, limit to available slots
        }

        const actualWithdrawQty =
          withdrawAsNote || isBaseStackable
            ? withdrawQty // Stackable items can withdraw any amount (1 slot)
            : Math.min(withdrawQty, freeSlots.length);

        // Lock and find bank item
        const bankResult = await tx.execute(
          sql`SELECT * FROM bank_storage
              WHERE "playerId" = ${ctx.playerId} AND "itemId" = ${data.itemId}
              FOR UPDATE`,
        );

        const bankRows = bankResult.rows as Array<{
          id: number;
          quantity: number | null;
          slot: number;
          tabIndex: number;
        }>;

        if (bankRows.length === 0) {
          throw new Error("ITEM_NOT_IN_BANK");
        }

        const bankRow = bankRows[0];
        const availableQty = bankRow.quantity ?? 0;
        const deletedSlot = bankRow.slot;
        const tabIndex = bankRow.tabIndex ?? 0;

        if (availableQty === 0) {
          throw new Error("ITEM_NOT_IN_BANK");
        }

        const finalWithdrawQty = Math.min(actualWithdrawQty, availableQty);

        if (finalWithdrawQty === 0) {
          throw new Error("INSUFFICIENT_QUANTITY");
        }

        // Check if alwaysSetPlaceholder is enabled
        const settingResult = await tx.execute(
          sql`SELECT "alwaysSetPlaceholder" FROM characters WHERE id = ${ctx.playerId}`,
        );
        const alwaysSetPlaceholder =
          (
            settingResult.rows[0] as
              { alwaysSetPlaceholder: number } | undefined
          )?.alwaysSetPlaceholder === 1;

        // Remove from bank
        const newBankQty = availableQty - finalWithdrawQty;
        if (newBankQty <= 0) {
          // modern MMORPG-STYLE PLACEHOLDER BEHAVIOR:
          // If alwaysSetPlaceholder is ON, set qty=0 (item stays as placeholder)
          // If alwaysSetPlaceholder is OFF, delete row and compact slots
          if (alwaysSetPlaceholder) {
            // modern MMORPG-style: Keep row with qty=0 as placeholder
            await tx.execute(
              sql`UPDATE bank_storage SET quantity = 0 WHERE id = ${bankRow.id}`,
            );
            // Don't compact - placeholder holds the slot
          } else {
            // Delete row and compact slots to fill the gap
            await tx.execute(
              sql`DELETE FROM bank_storage WHERE id = ${bankRow.id}`,
            );
            await compactBankSlots(tx, ctx.playerId, deletedSlot, tabIndex);
          }
        } else {
          await tx.execute(
            sql`UPDATE bank_storage
                SET quantity = quantity - ${finalWithdrawQty}
                WHERE id = ${bankRow.id}
                AND quantity >= ${finalWithdrawQty}`,
          );
        }

        // BANK NOTE SYSTEM: Different inventory handling for notes vs base items
        // - Notes: Single stackable item (qty=finalWithdrawQty) in one slot
        // - Base items: One item per slot (qty=1 each)
        const addedSlots: Array<{
          slot: number;
          quantity: number;
          itemId: string;
        }> = [];

        if (withdrawAsNote) {
          // NOTED WITHDRAWAL: Single stackable item
          const notedItem = getNotedItem(data.itemId);
          if (!notedItem) {
            // Should never happen if canBeNoted() returned true, but safety check
            throw new Error("ITEM_NOT_NOTEABLE");
          }

          const targetSlot = freeSlots[0];

          // Check if player already has this noted item in inventory (stack with it)
          const existingNoted = await tx.execute(
            sql`SELECT id, quantity, "slotIndex" FROM inventory
                WHERE "playerId" = ${ctx.playerId} AND "itemId" = ${notedItem.id}
                FOR UPDATE`,
          );

          if (existingNoted.rows.length > 0) {
            // Stack with existing noted item
            const existingRow = existingNoted.rows[0] as {
              id: number;
              quantity: number;
              slotIndex: number;
            };
            await tx.execute(
              sql`UPDATE inventory SET quantity = quantity + ${finalWithdrawQty}
                  WHERE id = ${existingRow.id}`,
            );
            addedSlots.push({
              slot: existingRow.slotIndex,
              quantity: finalWithdrawQty,
              itemId: notedItem.id,
            });
          } else {
            // Create new noted item stack
            await tx.insert(schema.inventory).values({
              playerId: ctx.playerId,
              itemId: notedItem.id,
              quantity: finalWithdrawQty,
              slotIndex: targetSlot,
              metadata: null,
            });
            addedSlots.push({
              slot: targetSlot,
              quantity: finalWithdrawQty,
              itemId: notedItem.id,
            });
          }
        } else if (isBaseStackable) {
          // STACKABLE BASE ITEM: Single stack (like fishing bait, arrows, runes)
          // Check for existing stack in inventory
          const existingStack = await tx.execute(
            sql`SELECT id, quantity, "slotIndex" FROM inventory
                WHERE "playerId" = ${ctx.playerId} AND "itemId" = ${data.itemId}
                FOR UPDATE`,
          );

          if (existingStack.rows.length > 0) {
            // Add to existing stack
            const existingRow = existingStack.rows[0] as {
              id: number;
              quantity: number;
              slotIndex: number;
            };
            await tx.execute(
              sql`UPDATE inventory SET quantity = quantity + ${finalWithdrawQty}
                  WHERE id = ${existingRow.id}`,
            );
            addedSlots.push({
              slot: existingRow.slotIndex,
              quantity: finalWithdrawQty,
              itemId: data.itemId,
            });
          } else {
            // Create new stack
            await tx.insert(schema.inventory).values({
              playerId: ctx.playerId,
              itemId: data.itemId,
              quantity: finalWithdrawQty,
              slotIndex: freeSlots[0],
              metadata: null,
            });
            addedSlots.push({
              slot: freeSlots[0],
              quantity: finalWithdrawQty,
              itemId: data.itemId,
            });
          }
        } else {
          // NON-STACKABLE ITEM: One item per slot (qty=1 each)
          // BULK INSERT: Batch all items into single query for performance
          const inventoryItems: Array<{
            playerId: string;
            itemId: string;
            quantity: number;
            slotIndex: number;
            metadata: null;
          }> = [];
          for (let i = 0; i < finalWithdrawQty; i++) {
            const targetSlot = freeSlots[i];
            inventoryItems.push({
              playerId: ctx.playerId,
              itemId: data.itemId,
              quantity: 1,
              slotIndex: targetSlot,
              metadata: null,
            });
            addedSlots.push({
              slot: targetSlot,
              quantity: 1,
              itemId: data.itemId,
            });
          }

          if (inventoryItems.length > 0) {
            await tx.insert(schema.inventory).values(inventoryItems);
          }
        }

        return { addedSlots };
      },
    });
  });

  if (!result) return; // Error already handled

  // Step 4: Send updated bank state to client (with tabs for consistency)
  // NOTE: Inventory update is handled by reloadFromDatabase() which emits INVENTORY_UPDATED
  await sendBankStateWithTabs(socket, ctx.playerId, ctx.db, {
    requestId: getBankRequestId(data.requestId),
  });

  // NOTE: emitInventorySyncEvents removed - reloadFromDatabase() handles in-memory sync
}

/**
 * Handle bank deposit all request
 *
 * SECURITY MEASURES (using common utilities):
 * - validateTransactionRequest: player, rate limit, distance, db
 * - executeSecureTransaction: atomic transaction with row-level locking and retry
 * - emitInventorySyncEvents: in-memory cache sync
 *
 * Deposits ALL items from inventory to bank in a single atomic transaction.
 */
export async function handleBankDepositAll(
  socket: ServerSocket,
  data: { targetTabIndex?: number; requestId?: string },
  world: World,
): Promise<void> {
  // Step 1: Common validation (player, rate limit, distance, db)
  const baseResult = validateTransactionRequest(
    socket,
    world,
    SessionType.BANK,
    rateLimiter,
  );

  if (!baseResult.success) {
    return; // Error already sent to client
  }

  const ctx = baseResult.context;

  // Step 2: Execute transaction with inventory lock (prevents race conditions)
  const result = await executeInventoryTransaction(ctx, async () => {
    return executeSecureTransaction(ctx, {
      errorMessages: {
        INVENTORY_EMPTY: "Inventory is empty",
      },
      execute: async (tx) => {
        // Get ALL inventory items with row lock
        const inventoryResult = await tx.execute(
          sql`SELECT * FROM inventory
              WHERE "playerId" = ${ctx.playerId}
              ORDER BY "slotIndex"
              FOR UPDATE`,
        );

        const invRows = inventoryResult.rows as Array<{
          id: number;
          playerId: string;
          itemId: string;
          quantity: number | null;
          slotIndex: number | null;
        }>;

        if (invRows.length === 0) {
          throw new Error("INVENTORY_EMPTY");
        }

        // BANK NOTE SYSTEM: Group items by BASE itemId (auto-unnote)
        // This ensures noted items get converted to their base form in bank
        const itemGroups = new Map<
          string,
          { total: number; rows: typeof invRows }
        >();
        for (const row of invRows) {
          // Convert noted items to base item ID for bank storage
          const bankItemId = isNotedItemId(row.itemId)
            ? getBaseItemId(row.itemId)
            : row.itemId;
          const existing = itemGroups.get(bankItemId) || { total: 0, rows: [] };
          existing.total += row.quantity ?? 1;
          existing.rows.push(row);
          itemGroups.set(bankItemId, existing);
        }

        // Lock ALL bank items for this player
        const bankResult = await tx.execute(
          sql`SELECT * FROM bank_storage
              WHERE "playerId" = ${ctx.playerId}
              FOR UPDATE`,
        );

        const bankRows = bankResult.rows as Array<{
          id: number;
          itemId: string;
          quantity: number | null;
          slot: number | null;
        }>;

        // Create lookup map for existing bank items
        const bankByItemId = new Map<
          string,
          { id: number; quantity: number; slot: number }
        >();
        const usedBankSlots = new Set<number>();
        for (const row of bankRows) {
          bankByItemId.set(row.itemId, {
            id: row.id,
            quantity: row.quantity ?? 0,
            slot: row.slot ?? 0,
          });
          usedBankSlots.add(row.slot ?? 0);
        }

        // Check for overflow on any item type
        for (const [itemId, group] of itemGroups) {
          const existingBank = bankByItemId.get(itemId);
          if (
            existingBank &&
            wouldOverflow(existingBank.quantity, group.total)
          ) {
            throw new Error("QUANTITY_OVERFLOW");
          }
        }

        // Check bank has enough slots for new item types
        let newItemTypes = 0;
        for (const itemId of itemGroups.keys()) {
          if (!bankByItemId.has(itemId)) {
            newItemTypes++;
          }
        }
        const freeSlots = MAX_BANK_SLOTS - usedBankSlots.size;
        if (newItemTypes > freeSlots) {
          throw new Error("BANK_FULL");
        }

        // Delete ALL inventory items
        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, ctx.playerId));

        // Track removed slots for sync
        const removedSlots: Array<{
          slot: number;
          quantity: number;
          itemId: string;
        }> = [];
        for (const row of invRows) {
          removedSlots.push({
            itemId: row.itemId,
            slot: row.slotIndex ?? -1,
            quantity: row.quantity ?? 1,
          });
        }

        // Update/insert bank items
        // modern MMORPG-style: New items go to the currently viewed tab
        const targetTab = data.targetTabIndex ?? 0;

        // Get slots used in target tab for new item placement
        const targetTabItems = await tx.execute(
          sql`SELECT slot FROM bank_storage
              WHERE "playerId" = ${ctx.playerId} AND "tabIndex" = ${targetTab}`,
        );
        const usedTargetTabSlots = new Set(
          (targetTabItems.rows as Array<{ slot: number }>).map((r) => r.slot),
        );
        let nextFreeSlotInTab = 0;

        // Separate existing items (updates) from new items (inserts) for bulk optimization
        const newBankItems: Array<{
          playerId: string;
          itemId: string;
          quantity: number;
          slot: number;
          tabIndex: number;
        }> = [];

        for (const [itemId, group] of itemGroups) {
          const existingBank = bankByItemId.get(itemId);

          if (existingBank) {
            // Existing item: add to it where it already is (any tab)
            await tx.execute(
              sql`UPDATE bank_storage
                  SET quantity = quantity + ${group.total}
                  WHERE id = ${existingBank.id}`,
            );
          } else {
            // New item: collect for bulk insert
            while (usedTargetTabSlots.has(nextFreeSlotInTab)) {
              nextFreeSlotInTab++;
            }

            newBankItems.push({
              playerId: ctx.playerId,
              itemId,
              quantity: group.total,
              slot: nextFreeSlotInTab,
              tabIndex: targetTab,
            });

            usedTargetTabSlots.add(nextFreeSlotInTab);
            nextFreeSlotInTab++;
          }
        }

        // BULK INSERT: Insert all new items in single query
        if (newBankItems.length > 0) {
          await tx.insert(schema.bankStorage).values(newBankItems);
        }

        return { removedSlots };
      },
    });
  });

  if (!result) return; // Error already handled

  // Step 3: Send updated bank state to client (with tabs for consistency)
  // NOTE: Inventory update is handled by reloadFromDatabase() which emits INVENTORY_UPDATED
  await sendBankStateWithTabs(socket, ctx.playerId, ctx.db, {
    requestId: getBankRequestId(data.requestId),
  });

  // NOTE: emitInventorySyncEvents removed - reloadFromDatabase() handles in-memory sync
}

/**
 * Handle bank close request
 *
 * InteractionSessionManager handles session cleanup via BANK_CLOSE event.
 */
export function handleBankClose(
  socket: ServerSocket,
  _data: unknown,
  world: World,
): void {
  const playerId = getPlayerId(socket);
  if (!playerId) return;

  // InteractionSessionManager handles session cleanup automatically
  // Get bankEntityId from session for the event (if needed for logging)
  const sessionManager = getSessionManager(world);
  const session = sessionManager?.getSession(playerId);
  const bankEntityId = session?.targetEntityId;

  // Emit event for InteractionSessionManager to close the session
  world.emit(EventType.BANK_CLOSE, {
    playerId,
    bankId: bankEntityId,
  });
}

/**
 * Handle request for bank state without opening the bank UI.
 *
 * This allows agents to query their bank contents at any time without
 * needing to be near a bank NPC. Reuses sendBankStateWithTabs to send
 * the same bankState packet the client already handles.
 *
 * Uses a concurrency limiter to prevent 19 agents from simultaneously
 * exhausting the DB connection pool when they all refresh at once.
 */
const BANK_QUERY_MAX_CONCURRENT = 5;
let bankQueryActive = 0;
const bankQueryQueue: Array<() => void> = [];

function acquireBankSlot(): Promise<void> {
  if (bankQueryActive < BANK_QUERY_MAX_CONCURRENT) {
    bankQueryActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    bankQueryQueue.push(() => {
      bankQueryActive++;
      resolve();
    });
  });
}

function releaseBankSlot(): void {
  bankQueryActive--;
  const next = bankQueryQueue.shift();
  if (next) next();
}

export async function handleRequestBankState(
  socket: ServerSocket,
  _data: unknown,
  world: World,
): Promise<void> {
  const playerId = getPlayerId(socket);
  if (!playerId) return;

  const db = getDatabase(world);
  if (!db) return;

  await acquireBankSlot();
  try {
    await sendBankStateWithTabs(socket, playerId, db);
  } finally {
    releaseBankSlot();
  }
}
