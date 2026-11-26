/**
 * Transaction Wrapper
 *
 * Standardized transaction execution with:
 * - Retry logic for database conflicts (serialization, deadlock)
 * - Consistent error handling and user-friendly messages
 * - In-memory sync event emission
 * - Inventory lock/flush/reload pattern for race condition prevention
 *
 * This consolidates ~40-50 lines of retry/error handling that was
 * duplicated across every transaction handler.
 *
 * SECURITY: All database operations MUST go through this wrapper
 * to ensure consistent retry and error handling.
 */

import { EventType } from "@hyperforge/shared";
import {
  runInPostgresTransaction,
  type PostgresTransactionDatabase,
} from "../../../../database/postgres-transaction";

/**
 * InventorySystem interface for transaction locking operations.
 * Defines the contract for inventory system operations used by the transaction wrapper.
 */
interface InventorySystem {
  queueOperation(
    playerId: string,
    operation: () => Promise<boolean>,
  ): Promise<boolean>;
  lockForTransaction(playerId: string): boolean;
  unlockTransaction(playerId: string): void;
  persistInventoryImmediate(playerId: string): Promise<void>;
  reloadFromDatabase(playerId: string): Promise<void>;
}
import type { BaseHandlerContext, TransactionSyncData } from "./types";
import { sendErrorToast } from "./helpers";

// ============================================================================
// ERROR MESSAGES
// ============================================================================

/**
 * Default business error to user message mapping.
 * Handlers can extend with operation-specific messages.
 *
 * Key format: Error message thrown in transaction
 * Value: User-friendly message to display
 */
const DEFAULT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // Player errors
  PLAYER_NOT_FOUND: "Character not found",

  // Inventory errors
  ITEM_NOT_FOUND: "Item not in inventory",
  INSUFFICIENT_QUANTITY: "Not enough items",
  INVENTORY_FULL: "Inventory is full",

  // Bank errors
  ITEM_NOT_IN_BANK: "Item not in bank",
  BANK_FULL: "Bank is full",

  // Store errors
  INSUFFICIENT_COINS: "Not enough coins",
  STORE_NOT_FOUND: "Store not found",
  ITEM_NOT_IN_STORE: "Item not available in this store",
  NOT_ENOUGH_STOCK: "Not enough stock available",

  // Overflow errors
  QUANTITY_OVERFLOW: "Stack limit reached",
  PRICE_OVERFLOW: "Transaction too large",
};

// ============================================================================
// RETRY LOGIC
// ============================================================================

/**
 * Check if error is a retryable database conflict.
 * These are transient errors that may succeed on retry.
 */
function isRetryableConflict(errorMsg: string): boolean {
  return (
    errorMsg.includes("unique constraint") ||
    errorMsg.includes("could not serialize") ||
    errorMsg.includes("deadlock")
  );
}

/**
 * Calculate backoff delay for retry attempt.
 * Uses linear backoff: 10ms, 20ms, 30ms, etc.
 */
function getRetryDelay(attempt: number): number {
  return 10 * (attempt + 1);
}

// ============================================================================
// TRANSACTION CONFIG
// ============================================================================

/**
 * Drizzle transaction type (extracted for readability).
 * This is the type of `tx` passed to transaction callbacks.
 */
export type DrizzleTransaction = PostgresTransactionDatabase;

/**
 * Configuration for secure transaction execution.
 */
export interface TransactionConfig<
  TContext extends BaseHandlerContext,
  TResult,
> {
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;

  /**
   * The transaction logic to execute.
   * Runs within a database transaction with row-level locking.
   *
   * Throw Error with message matching errorMessages key for user-friendly handling:
   * - throw new Error("INSUFFICIENT_COINS") -> "Not enough coins"
   * - throw new Error("INVENTORY_FULL") -> "Inventory is full"
   */
  execute: (tx: DrizzleTransaction, context: TContext) => Promise<TResult>;

  /** Additional error message mappings (merged with defaults) */
  errorMessages?: Record<string, string>;

  /**
   * Optional machine-readable failure signal for authoritative callers.
   * Known business failures are definitely rejected. Infrastructure failures
   * are conservatively unknown because COMMIT may have reached PostgreSQL even
   * when its response did not reach this process.
   */
  onFailure?: (status: "rejected" | "unknown", error: unknown) => void;
}

// ============================================================================
// MAIN TRANSACTION FUNCTION
// ============================================================================

/**
 * Execute a database transaction with retry logic and error handling.
 *
 * Features:
 * - Automatic retry (up to 3x) for serialization/deadlock conflicts
 * - Linear backoff between retries (10ms, 20ms, 30ms)
 * - Maps business errors to user-friendly toast messages
 * - Logs unexpected errors for debugging
 *
 * Usage:
 * ```typescript
 * const result = await executeSecureTransaction(context, {
 *   execute: async (tx, ctx) => {
 *     // Lock rows with FOR UPDATE
 *     const player = await tx.execute(sql`SELECT ... FOR UPDATE`);
 *
 *     // Validate and throw known errors
 *     if (player.coins < cost) throw new Error("INSUFFICIENT_COINS");
 *
 *     // Perform operations
 *     await tx.execute(sql`UPDATE ...`);
 *
 *     return { addedSlots: [...], newCoinBalance: 100 };
 *   }
 * });
 *
 * if (!result) return; // Error already sent to client
 * // Use result...
 * ```
 *
 * @param context - Handler context with db connection
 * @param config - Transaction configuration
 * @returns Transaction result on success, null on failure
 */
export async function executeSecureTransaction<
  TContext extends BaseHandlerContext,
  TResult,
>(
  context: TContext,
  config: TransactionConfig<TContext, TResult>,
): Promise<TResult | null> {
  const maxRetries = config.maxRetries ?? 3;
  const errorMessages = { ...DEFAULT_ERROR_MESSAGES, ...config.errorMessages };
  const handlerTag = `[TransactionWrapper:${context.sessionType}]`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Execute transaction
      const result = await runInPostgresTransaction(
        context.db.pool,
        async (tx) => config.execute(tx, context),
      );

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check if this is a known business error
      const userMessage = errorMessages[errorMsg];
      if (userMessage) {
        config.onFailure?.("rejected", error);
        sendErrorToast(context.socket, userMessage);
        return null;
      }

      // Check if this is a retryable database conflict
      if (isRetryableConflict(errorMsg) && attempt < maxRetries - 1) {
        const delay = getRetryDelay(attempt);
        console.log(
          `${handlerTag} Retryable conflict on attempt ${attempt + 1}, waiting ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Unexpected error - log and notify user
      console.error(
        `${handlerTag} Transaction failed (attempt ${attempt + 1}/${maxRetries}):`,
        error,
      );
      config.onFailure?.("unknown", error);
      sendErrorToast(context.socket, "Operation failed - please try again");
      return null;
    }
  }

  // All retries exhausted
  console.error(`${handlerTag} All ${maxRetries} retries failed`);
  config.onFailure?.("unknown", new Error("transaction_retries_exhausted"));
  sendErrorToast(context.socket, "Operation failed - please try again");
  return null;
}

// ============================================================================
// IN-MEMORY SYNC
// ============================================================================

/**
 * Emit inventory sync events after successful transaction.
 * Keeps in-memory InventorySystem consistent with database.
 *
 * CRITICAL: Must be called after every transaction that modifies inventory.
 * Failure to sync causes duplication bugs where in-memory cache diverges
 * from database state.
 *
 * @param context - Handler context with world for event emission
 * @param syncData - Data about what changed in the transaction
 */
export function emitInventorySyncEvents(
  context: BaseHandlerContext,
  syncData: TransactionSyncData,
): void {
  const { world, playerId } = context;

  // Emit added items
  if (syncData.addedSlots) {
    for (const added of syncData.addedSlots) {
      world.emit(EventType.INVENTORY_ITEM_ADDED, {
        playerId,
        item: {
          id: "sync", // Placeholder ID - not used for sync operations
          itemId: added.itemId,
          quantity: added.quantity,
          slot: added.slot,
          metadata: null,
        },
      });
    }
  }

  // Emit removed items
  if (syncData.removedSlots) {
    for (const removed of syncData.removedSlots) {
      world.emit(EventType.INVENTORY_ITEM_REMOVED, {
        playerId,
        itemId: removed.itemId,
        quantity: removed.quantity,
        slot: removed.slot >= 0 ? removed.slot : undefined,
      });
    }
  }

  // Emit coin balance update - use INVENTORY_UPDATE_COINS (command) not INVENTORY_COINS_UPDATED (notification)
  // CoinPouchSystem listens to UPDATE_COINS and will emit COINS_UPDATED to notify client
  if (syncData.newCoinBalance !== undefined) {
    world.emit(EventType.INVENTORY_UPDATE_COINS, {
      playerId,
      coins: syncData.newCoinBalance,
    });
  }
}

// ============================================================================
// INVENTORY TRANSACTION WRAPPER
// ============================================================================

/**
 * Execute an inventory-modifying transaction with proper locking.
 *
 * This wrapper implements the Queue + Lock + Flush + Transaction + Reload pattern
 * to eliminate race conditions while supporting optimistic UI.
 *
 * KEY CHANGE: Instead of REJECTING concurrent requests, we QUEUE them.
 * This enables optimistic UI on client - all clicks are processed, just in order.
 *
 * Sequence:
 * 1. QUEUE - Wait for any prior operations to complete
 * 2. LOCK - Acquire transaction lock (blocks pickups, auto-save)
 * 3. FLUSH - Save pending in-memory changes to DB
 * 4. EXECUTE - Run the transaction (DB is now source of truth)
 * 5. RELOAD - Replace in-memory with DB state
 * 6. UNLOCK - Resume normal operations (in finally block)
 *
 * This ensures:
 * - Zero data loss (pending items flushed before transaction)
 * - No race conditions (lock serializes access)
 * - No divergence (reload ensures in-memory == DB)
 * - ALL requests processed (queue, not reject)
 * - Optimistic UI works (client shows all, server processes all)
 *
 * Usage:
 * ```typescript
 * const result = await executeInventoryTransaction(ctx, async () => {
 *   return executeSecureTransaction(ctx, {
 *     execute: async (tx) => {
 *       // ... DB operations (safe, no races possible)
 *       return { addedSlots: [...] };
 *     }
 *   });
 * });
 *
 * if (!result) return; // Error already sent to client
 * // Use result...
 * ```
 *
 * @param context - Handler context with world for system access
 * @param operation - The transaction operation to execute
 * @returns Operation result on success, null on failure
 */
export async function executeInventoryTransaction<T>(
  context: BaseHandlerContext,
  operation: () => Promise<T | null>,
): Promise<T | null> {
  const inventorySystem = context.world.getSystem("inventory") as
    InventorySystem | undefined;

  if (!inventorySystem) {
    console.error("[InventoryTransaction] InventorySystem not available");
    sendErrorToast(context.socket, "System error - please try again");
    return null;
  }

  // Use the async queue to serialize operations
  // This WAITS instead of rejecting - key for optimistic UI
  let result: T | null = null;

  const success = await inventorySystem.queueOperation(
    context.playerId,
    async () => {
      // Step 1: LOCK - Acquire transaction lock (should always succeed since we're queued)
      const locked = inventorySystem.lockForTransaction(context.playerId);
      if (!locked) {
        // This should never happen since queue serializes, but handle gracefully
        console.error(
          "[InventoryTransaction] Failed to acquire lock after queue",
        );
        sendErrorToast(context.socket, "System busy - please try again");
        return false;
      }

      try {
        // Step 2: FLUSH - Save pending in-memory changes to DB
        // This ensures DB has all items before we query it
        await inventorySystem.persistInventoryImmediate(context.playerId);

        // Step 3: EXECUTE - Run the actual transaction
        result = await operation();

        // Step 4: RELOAD - Replace in-memory with DB state
        // This ensures in-memory matches exactly what the transaction wrote
        await inventorySystem.reloadFromDatabase(context.playerId);

        return result !== null;
      } catch (error) {
        // On error, still try to reload to maintain consistency
        try {
          await inventorySystem.reloadFromDatabase(context.playerId);
        } catch (reloadError) {
          console.error(
            "[InventoryTransaction] Failed to reload after error:",
            reloadError,
          );
        }
        // Log but don't throw - queue expects boolean return
        console.error("[InventoryTransaction] Operation failed:", error);
        return false;
      } finally {
        // Step 5: UNLOCK - Always release lock, even on error
        inventorySystem.unlockTransaction(context.playerId);
      }
    },
  );

  if (!success && result === null) {
    // Operation failed without setting result - generic error already logged
    // Don't send another toast if operation already sent one
  }

  return result;
}
