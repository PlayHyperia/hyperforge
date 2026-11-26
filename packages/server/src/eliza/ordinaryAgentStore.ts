import { eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { getStoreById } from "@hyperforge/shared";

import type { Database } from "../database/client.js";
import { agentStoreOperations } from "../database/schema.js";
import type { StoreTransactionResult } from "../systems/ServerNetwork/handlers/store.js";
import type { AgentAutonomyActionResult } from "./agentAutonomyCheckpoint.js";
import type { AgentAutonomyProgressionAttempt } from "./agentAutonomyProgression.js";
import type { AgentInstance } from "./managers/AgentBehaviorTicker.js";

const ORDINARY_STORE_BUY_OPERATION_NAMESPACE =
  "c0f26536-8bbd-43d6-a0f6-7cdf4e2c3ad1";
const INITIAL_RECONCILIATION_DELAY_MS = 25;
const MAX_RECONCILIATION_DELAY_MS = 1_000;
const ORDINARY_COIN_RECOVERY_AUTHORIZATION_MS = 300_000;

export interface OrdinaryStoreExecutionResult {
  settled: boolean;
  applied: boolean;
  receipt: StoreTransactionResult | null;
  operationId: string;
  reconciliationAttempts: number;
}

export function recordOrdinaryStoreBuyOutcome(
  instance: AgentInstance,
  result: OrdinaryStoreExecutionResult,
  purchase: { storeId: string; itemId: string; quantity: number },
  now = Date.now(),
): void {
  instance.storeRetryAfter = result.applied ? 0 : now + 30_000;
  instance.coinRecovery =
    !result.applied &&
    result.settled &&
    result.receipt?.status === "rejected" &&
    result.receipt.reason === "insufficient_coins"
      ? {
          storeId: purchase.storeId,
          itemId: purchase.itemId,
          quantity: purchase.quantity,
          expiresAt: now + ORDINARY_COIN_RECOVERY_AUTHORIZATION_MS,
        }
      : null;
}

/**
 * Export one boolean authorization only while the exact failed purchase is
 * still needed and its retry backoff is active. Item identity, quantities,
 * balances, and deficits remain main-process-only.
 */
export function hasOrdinaryCoinRecoveryAuthorization(
  instance: AgentInstance,
  now = Date.now(),
  owned?: {
    inventoryItems: ReturnType<AgentInstance["service"]["getInventoryItems"]>;
    equippedItems: ReturnType<AgentInstance["service"]["getEquippedItems"]>;
  },
  privateAuthority?: {
    coinBalance: number | null;
    unitPrice: number | null;
  },
): boolean {
  const recovery = instance.coinRecovery;
  if (!recovery) return false;
  if (recovery.expiresAt <= now) {
    instance.coinRecovery = null;
    return false;
  }

  const inventoryItems =
    owned?.inventoryItems ?? instance.service.getInventoryItems();
  const equippedItems =
    owned?.equippedItems ?? instance.service.getEquippedItems();
  const carriedQuantity = inventoryItems
    .filter(({ itemId }) => itemId === recovery.itemId)
    .reduce((total, item) => total + item.quantity, 0);
  const equippedQuantity = Object.values(equippedItems).filter(
    (itemId) => itemId === recovery.itemId,
  ).length;
  if (carriedQuantity + equippedQuantity >= recovery.quantity) {
    instance.coinRecovery = null;
    return false;
  }

  const service = instance.service as typeof instance.service & {
    getPrivateCoinBalance?: () => number | null;
  };
  const coinBalance = privateAuthority
    ? privateAuthority.coinBalance
    : (service.getPrivateCoinBalance?.() ?? null);
  const unitPrice = privateAuthority
    ? privateAuthority.unitPrice
    : (getStoreById(recovery.storeId)?.items.find(
        (item) => item.itemId === recovery.itemId,
      )?.price ?? null);
  if (
    !Number.isSafeInteger(unitPrice) ||
    Number(unitPrice) < 0 ||
    !Number.isSafeInteger(recovery.quantity) ||
    recovery.quantity <= 0
  ) {
    instance.coinRecovery = null;
    return false;
  }
  const requiredCoins = Number(unitPrice) * recovery.quantity;
  if (!Number.isSafeInteger(requiredCoins) || requiredCoins < 0) {
    instance.coinRecovery = null;
    return false;
  }
  if (!Number.isSafeInteger(coinBalance) || Number(coinBalance) < 0) {
    return false;
  }
  if (Number(coinBalance) >= requiredCoins) {
    instance.coinRecovery = null;
    instance.storeRetryAfter = 0;
    return false;
  }

  return instance.storeRetryAfter > now;
}

export function getOrdinaryStoreBuyOperationId(attemptId: string): string {
  return uuidv5(
    `ordinary-store-buy:v1:${attemptId}`,
    ORDINARY_STORE_BUY_OPERATION_NAMESPACE,
  );
}

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

/**
 * Reconcile one autonomous purchase before allowing any later action. A lost
 * COMMIT response is retried with the same operation ID; process shutdown
 * leaves the autonomy head open for receipt-based startup reconciliation.
 */
export async function executeOrdinaryStoreBuy(
  instance: AgentInstance,
  storeId: string,
  itemId: string,
  quantity: number,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<OrdinaryStoreExecutionResult> {
  const operationId = getOrdinaryStoreBuyOperationId(attempt.attemptId);
  let reconciliationAttempts = 0;
  let delayMs = INITIAL_RECONCILIATION_DELAY_MS;
  let lastReceipt: StoreTransactionResult | null = null;

  while (instance.state === "running") {
    try {
      lastReceipt = await instance.service.executeAuthoritativeStoreBuy(
        storeId,
        itemId,
        quantity,
        operationId,
      );
    } catch {
      lastReceipt = null;
    }
    reconciliationAttempts += 1;

    if (lastReceipt?.status === "committed") {
      return {
        settled: true,
        applied: true,
        receipt: lastReceipt,
        operationId,
        reconciliationAttempts,
      };
    }
    if (lastReceipt?.status === "rejected") {
      return {
        settled: true,
        applied: false,
        receipt: lastReceipt,
        operationId,
        reconciliationAttempts,
      };
    }

    await wait(delayMs);
    delayMs = Math.min(delayMs * 2, MAX_RECONCILIATION_DELAY_MS);
  }

  return {
    settled: false,
    applied: false,
    receipt: lastReceipt,
    operationId,
    reconciliationAttempts,
  };
}

/** Resolve a process-killed ordinary purchase from its immutable receipt. */
export async function resolveOrdinaryStoreRecovery(
  db: Database,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<AgentAutonomyActionResult | null> {
  if (attempt.actionType !== "storeBuy") return null;
  const operationId = getOrdinaryStoreBuyOperationId(attempt.attemptId);
  const rows = await db
    .select({
      playerId: agentStoreOperations.playerId,
      action: agentStoreOperations.action,
      requestedQuantity: agentStoreOperations.requestedQuantity,
      unitPrice: agentStoreOperations.unitPrice,
      totalValue: agentStoreOperations.totalValue,
      coinBalanceAfter: agentStoreOperations.coinBalanceAfter,
      inventoryQuantityAfter: agentStoreOperations.inventoryQuantityAfter,
    })
    .from(agentStoreOperations)
    .where(eq(agentStoreOperations.operationId, operationId))
    .limit(1);
  const receipt = rows[0];
  if (!receipt) return null;
  if (
    receipt.playerId !== attempt.characterId ||
    receipt.action !== "buy" ||
    receipt.requestedQuantity <= 0 ||
    receipt.unitPrice < 0 ||
    receipt.totalValue !== receipt.unitPrice * receipt.requestedQuantity ||
    receipt.coinBalanceAfter < 0 ||
    receipt.inventoryQuantityAfter <= 0
  ) {
    throw new Error("ordinary_store_recovery_receipt_identity_mismatch");
  }
  return {
    attemptedActionType: "storeBuy",
    appliedActionType: "storeBuy",
    outcome: "completed",
  };
}
