import crypto from "node:crypto";
import type pg from "pg";
import {
  INPUT_LIMITS,
  getBaseItemId,
  getItem,
  isNotedItemId,
  type World,
} from "@hyperforge/shared";
import { authorizeDuelPreparationBankAccess } from "../systems/StreamingDuelScheduler/preparation.js";
import { validatePhysicalBankAccess } from "../shared/PhysicalBankAccess.js";

export type AgentBankAction = "open" | "deposit" | "withdraw" | "deposit_all";

export type AgentBankFailureReason =
  | "player_unavailable"
  | "bank_target_invalid"
  | "bank_out_of_range"
  | "bank_not_open"
  | "duel_locked"
  | "preparation_not_found"
  | "preparation_not_active"
  | "preparation_expired"
  | "preparation_agent_mismatch"
  | "preparation_agent_ready"
  | "preparation_action_not_allowed"
  | "invalid_operation_id"
  | "operation_id_conflict"
  | "invalid_item"
  | "invalid_quantity"
  | "database_unavailable"
  | "inventory_system_unavailable"
  | "inventory_not_ready"
  | "inventory_lock_failed"
  | "inventory_empty"
  | "nothing_to_deposit"
  | "item_not_owned"
  | "insufficient_inventory_quantity"
  | "item_not_in_bank"
  | "insufficient_bank_quantity"
  | "inventory_full"
  | "bank_full"
  | "quantity_overflow"
  | "commit_ambiguous"
  | "post_commit_sync_failed"
  | "recovery_required"
  | "operation_failed";

export type AgentBankItemView = {
  itemId: string;
  quantity: number;
  slot: number;
  tabIndex: number;
};

/**
 * Exact quantities that an ordinary deposit-all operation must leave carried.
 * The list is private custody input: receipts and public events never expose it.
 */
export type AgentBankRetainedItem = {
  itemId: string;
  quantity: number;
};

/** One exact private component of an all-or-nothing bank withdrawal plan. */
export type AgentBankTransferItem = {
  itemId: string;
  quantity: number;
};

export type AgentBankCommitState =
  "not_applicable" | "not_committed" | "committed" | "unknown";

export type AgentBankActionReceipt = {
  success: boolean;
  operationId: string;
  commitState: AgentBankCommitState;
  /** True when this receipt came from a previously committed operation. */
  replayed: boolean;
  action: AgentBankAction;
  playerId: string | null;
  bankId: string | null;
  itemId: string | null;
  requestedQuantity: number;
  committedQuantity: number;
  inventoryQuantityAfter: number | null;
  bankQuantityAfter: number | null;
  bankItems?: AgentBankItemView[];
  failureReason?: AgentBankFailureReason;
};

type InventoryTransactionSystem = {
  isInventoryReady?: (playerId: string) => boolean;
  queueOperation: (
    playerId: string,
    operation: () => Promise<boolean>,
  ) => Promise<boolean>;
  lockForTransaction: (playerId: string) => boolean;
  unlockTransaction: (playerId: string) => void;
  persistInventoryImmediate: (playerId: string) => Promise<void>;
  reloadFromDatabase: (playerId: string) => Promise<void>;
};

type DatabaseSystemWithPool = {
  getPool?: () => pg.Pool | null;
};

export type AgentBankTransferRequest = {
  world: World;
  playerId: string;
  bankId: string | null;
  action: Exclude<AgentBankAction, "open">;
  itemId?: string;
  quantity?: number;
  /** Stable retry key. Callers must reuse it after an uncertain outcome. */
  operationId?: string;
  /** Exact carried quantities excluded from an ordinary deposit-all transfer. */
  retainedItems?: AgentBankRetainedItem[];
  /**
   * Exact sorted components for one atomic composite withdrawal. This is
   * private custody input and is never copied into public progression events.
   */
  withdrawItems?: AgentBankTransferItem[];
  /** Durable pre-market capability; bypasses only physical bank proximity. */
  preparationId?: string;
};

type AgentBankTransferOutcome = {
  committedQuantity: number;
  inventoryQuantityAfter: number;
  bankQuantityAfter: number | null;
  itemOutcomes?: Array<{
    itemId: string;
    requestedQuantity: number;
    committedQuantity: number;
    inventoryQuantityAfter: number;
    bankQuantityAfter: number;
  }>;
};

class BankOperationError extends Error {
  constructor(readonly reason: AgentBankFailureReason) {
    super(reason);
  }
}

export const createAgentBankFailureReceipt = (
  action: AgentBankAction,
  playerId: string | null,
  bankId: string | null,
  reason: AgentBankFailureReason,
  input?: {
    operationId?: string;
    itemId?: string;
    quantity?: number;
    commitState?: AgentBankCommitState;
    committedQuantity?: number;
    inventoryQuantityAfter?: number | null;
    bankQuantityAfter?: number | null;
  },
): AgentBankActionReceipt => ({
  success: false,
  operationId: input?.operationId ?? crypto.randomUUID(),
  commitState:
    input?.commitState ??
    (action === "open" ? "not_applicable" : "not_committed"),
  replayed: false,
  action,
  playerId,
  bankId,
  itemId: input?.itemId ?? null,
  requestedQuantity: input?.quantity ?? 0,
  committedQuantity: input?.committedQuantity ?? 0,
  inventoryQuantityAfter: input?.inventoryQuantityAfter ?? null,
  bankQuantityAfter: input?.bankQuantityAfter ?? null,
  failureReason: reason,
});

const validatePlayerBankAccess = (
  world: World,
  playerId: string,
): AgentBankFailureReason | null => {
  const player = world.entities.get(playerId);
  if (!player) return "player_unavailable";
  const data = player.data as
    | {
        alive?: boolean;
        health?: number;
        inStreamingDuel?: boolean;
      }
    | undefined;
  if (data?.alive === false || (data?.health ?? 1) <= 0) {
    return "player_unavailable";
  }
  return data?.inStreamingDuel === true ? "duel_locked" : null;
};

const getPool = (world: World): pg.Pool | null => {
  const directPool = (world as { pgPool?: pg.Pool }).pgPool;
  if (directPool) return directPool;
  const database = world.getSystem("database") as DatabaseSystemWithPool | null;
  return database?.getPool?.() ?? null;
};

const parseQuantity = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getBankOperationFingerprint = (
  request: AgentBankTransferRequest,
  quantity: number,
  retainedItems: AgentBankRetainedItem[],
  withdrawItems: AgentBankTransferItem[],
): string =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        playerId: request.playerId,
        bankId: request.bankId,
        action: request.action,
        itemId: request.itemId ?? null,
        quantity,
        preparationId: request.preparationId ?? null,
        retainedItems,
        withdrawItems,
      }),
    )
    .digest("hex");

function normalizeRetainedItems(
  action: AgentBankTransferRequest["action"],
  input: AgentBankRetainedItem[] | undefined,
): AgentBankRetainedItem[] {
  if (action !== "deposit_all") {
    if (input && input.length > 0) {
      throw new BankOperationError("invalid_item");
    }
    return [];
  }
  if (!input || input.length === 0) return [];

  const seen = new Set<string>();
  const normalized: AgentBankRetainedItem[] = [];
  for (const entry of input) {
    const itemId = String(entry?.itemId ?? "").trim();
    const quantity = Number(entry?.quantity);
    if (
      !itemId ||
      !getItem(itemId) ||
      seen.has(itemId) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > INPUT_LIMITS.MAX_QUANTITY
    ) {
      throw new BankOperationError("invalid_item");
    }
    seen.add(itemId);
    normalized.push({ itemId, quantity });
  }
  return normalized.sort((left, right) =>
    left.itemId.localeCompare(right.itemId),
  );
}

function normalizeWithdrawItems(
  request: AgentBankTransferRequest,
): AgentBankTransferItem[] {
  const input = request.withdrawItems;
  if (!input || input.length === 0) return [];
  if (
    request.action !== "withdraw" ||
    request.itemId !== undefined ||
    request.quantity !== undefined ||
    input.length < 2 ||
    input.length > INPUT_LIMITS.MAX_INVENTORY_SLOTS
  ) {
    throw new BankOperationError("invalid_item");
  }

  const seen = new Set<string>();
  let totalQuantity = 0;
  const normalized: AgentBankTransferItem[] = [];
  for (const entry of input) {
    const itemId = String(entry?.itemId ?? "").trim();
    const quantity = Number(entry?.quantity);
    if (
      !itemId ||
      !getItem(itemId) ||
      seen.has(itemId) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > INPUT_LIMITS.MAX_QUANTITY
    ) {
      throw new BankOperationError("invalid_item");
    }
    totalQuantity += quantity;
    if (
      !Number.isSafeInteger(totalQuantity) ||
      totalQuantity > INPUT_LIMITS.MAX_QUANTITY
    ) {
      throw new BankOperationError("quantity_overflow");
    }
    seen.add(itemId);
    normalized.push({ itemId, quantity });
  }
  return normalized.sort((left, right) =>
    left.itemId.localeCompare(right.itemId),
  );
}

export const getDuelPreparationBankId = (preparationId: string): string =>
  `duel-preparation:${preparationId}`;

export async function openAuthoritativeAgentBank(input: {
  world: World;
  playerId: string | null;
  bankId: string;
  preparationId?: string;
}): Promise<AgentBankActionReceipt> {
  const operationId = crypto.randomUUID();
  if (!input.playerId) {
    return createAgentBankFailureReceipt(
      "open",
      null,
      input.bankId,
      "player_unavailable",
      {
        operationId,
      },
    );
  }
  const playerAccessFailure = validatePlayerBankAccess(
    input.world,
    input.playerId,
  );
  if (playerAccessFailure) {
    return createAgentBankFailureReceipt(
      "open",
      input.playerId,
      input.bankId,
      playerAccessFailure,
      { operationId },
    );
  }
  if (input.preparationId) {
    if (input.bankId !== getDuelPreparationBankId(input.preparationId)) {
      return createAgentBankFailureReceipt(
        "open",
        input.playerId,
        input.bankId,
        "bank_target_invalid",
        { operationId },
      );
    }
  } else if (input.bankId.startsWith("duel-preparation:")) {
    return createAgentBankFailureReceipt(
      "open",
      input.playerId,
      input.bankId,
      "bank_target_invalid",
      { operationId },
    );
  } else {
    const accessFailure = validatePhysicalBankAccess(
      input.world,
      input.playerId,
      input.bankId,
    );
    if (accessFailure) {
      return createAgentBankFailureReceipt(
        "open",
        input.playerId,
        input.bankId,
        accessFailure,
        { operationId },
      );
    }
  }
  const pool = getPool(input.world);
  if (!pool) {
    return createAgentBankFailureReceipt(
      "open",
      input.playerId,
      input.bankId,
      "database_unavailable",
      { operationId },
    );
  }

  try {
    if (input.preparationId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const preparationAccess = await authorizeDuelPreparationBankAccess(
          client,
          {
            preparationId: input.preparationId,
            playerId: input.playerId,
            action: "open",
            lockForTransaction: true,
          },
        );
        if (!preparationAccess.ok) {
          await client.query("ROLLBACK");
          return createAgentBankFailureReceipt(
            "open",
            input.playerId,
            input.bankId,
            preparationAccess.reason,
            { operationId },
          );
        }
        const playerAccessAfterLock = validatePlayerBankAccess(
          input.world,
          input.playerId,
        );
        if (playerAccessAfterLock) {
          await client.query("ROLLBACK");
          return createAgentBankFailureReceipt(
            "open",
            input.playerId,
            input.bankId,
            playerAccessAfterLock,
            { operationId },
          );
        }
        const result = await client.query<{
          itemId: string;
          quantity: number | string;
          slot: number | string;
          tabIndex: number | string;
        }>(
          `SELECT "itemId", quantity, slot, "tabIndex"
           FROM bank_storage
           WHERE "playerId" = $1
           ORDER BY "tabIndex", slot`,
          [input.playerId],
        );
        await client.query(
          `INSERT INTO streaming_duel_bank_open_events
             ("operationId", "preparationId", "playerId", "bankId")
           VALUES ($1, $2, $3, $4)`,
          [operationId, input.preparationId, input.playerId, input.bankId],
        );
        await client.query("COMMIT");
        return {
          success: true,
          operationId,
          commitState: "not_applicable",
          replayed: false,
          action: "open",
          playerId: input.playerId,
          bankId: input.bankId,
          itemId: null,
          requestedQuantity: 0,
          committedQuantity: 0,
          inventoryQuantityAfter: null,
          bankQuantityAfter: null,
          bankItems: result.rows.map((row) => ({
            itemId: row.itemId,
            quantity: parseQuantity(row.quantity),
            slot: parseQuantity(row.slot),
            tabIndex: parseQuantity(row.tabIndex),
          })),
        };
      } catch {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original preparation-bank failure.
        }
        return createAgentBankFailureReceipt(
          "open",
          input.playerId,
          input.bankId,
          "operation_failed",
          { operationId },
        );
      } finally {
        client.release();
      }
    }
    const result = await pool.query<{
      itemId: string;
      quantity: number | string;
      slot: number | string;
      tabIndex: number | string;
    }>(
      `SELECT "itemId", quantity, slot, "tabIndex"
       FROM bank_storage
       WHERE "playerId" = $1
       ORDER BY "tabIndex", slot`,
      [input.playerId],
    );
    return {
      success: true,
      operationId,
      commitState: "not_applicable",
      replayed: false,
      action: "open",
      playerId: input.playerId,
      bankId: input.bankId,
      itemId: null,
      requestedQuantity: 0,
      committedQuantity: 0,
      inventoryQuantityAfter: null,
      bankQuantityAfter: null,
      bankItems: result.rows.map((row) => ({
        itemId: row.itemId,
        quantity: parseQuantity(row.quantity),
        slot: parseQuantity(row.slot),
        tabIndex: parseQuantity(row.tabIndex),
      })),
    };
  } catch {
    return createAgentBankFailureReceipt(
      "open",
      input.playerId,
      input.bankId,
      "operation_failed",
      { operationId },
    );
  }
}

export async function executeAuthoritativeAgentBankTransfer(
  request: AgentBankTransferRequest,
): Promise<AgentBankActionReceipt> {
  const operationId = request.operationId ?? crypto.randomUUID();
  let retainedItems: AgentBankRetainedItem[];
  let withdrawItems: AgentBankTransferItem[];
  try {
    retainedItems = normalizeRetainedItems(
      request.action,
      request.retainedItems,
    );
    withdrawItems = normalizeWithdrawItems(request);
  } catch (error) {
    return createAgentBankFailureReceipt(
      request.action,
      request.playerId,
      request.bankId,
      error instanceof BankOperationError ? error.reason : "invalid_item",
      {
        operationId,
        itemId: request.itemId,
        quantity: request.quantity ?? 0,
      },
    );
  }
  const quantity =
    request.action === "deposit_all"
      ? 0
      : withdrawItems.length > 0
        ? withdrawItems.reduce((total, item) => total + item.quantity, 0)
        : (request.quantity ?? 0);
  const baseReceiptInput = {
    operationId,
    itemId: request.itemId,
    quantity,
  };
  if (!UUID_PATTERN.test(operationId)) {
    return createAgentBankFailureReceipt(
      request.action,
      request.playerId,
      request.bankId,
      "invalid_operation_id",
      { itemId: request.itemId, quantity },
    );
  }
  if (request.action !== "deposit_all" && withdrawItems.length === 0) {
    if (!request.itemId || !getItem(request.itemId)) {
      return createAgentBankFailureReceipt(
        request.action,
        request.playerId,
        request.bankId,
        "invalid_item",
        baseReceiptInput,
      );
    }
    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > INPUT_LIMITS.MAX_QUANTITY
    ) {
      return createAgentBankFailureReceipt(
        request.action,
        request.playerId,
        request.bankId,
        "invalid_quantity",
        baseReceiptInput,
      );
    }
  }
  if (!request.bankId) {
    return createAgentBankFailureReceipt(
      request.action,
      request.playerId,
      null,
      "bank_not_open",
      baseReceiptInput,
    );
  }
  if (
    request.preparationId &&
    request.bankId !== getDuelPreparationBankId(request.preparationId)
  ) {
    return createAgentBankFailureReceipt(
      request.action,
      request.playerId,
      request.bankId,
      "bank_target_invalid",
      baseReceiptInput,
    );
  }
  if (
    !request.preparationId &&
    request.bankId.startsWith("duel-preparation:")
  ) {
    return createAgentBankFailureReceipt(
      request.action,
      request.playerId,
      request.bankId,
      "bank_target_invalid",
      baseReceiptInput,
    );
  }

  const pool = getPool(request.world);
  if (!pool) {
    return createAgentBankFailureReceipt(
      request.action,
      request.playerId,
      request.bankId,
      "database_unavailable",
      baseReceiptInput,
    );
  }
  const inventory = request.world.getSystem(
    "inventory",
  ) as unknown as InventoryTransactionSystem | null;
  if (!inventory?.queueOperation) {
    return createAgentBankFailureReceipt(
      request.action,
      request.playerId,
      request.bankId,
      "inventory_system_unavailable",
      baseReceiptInput,
    );
  }
  let receipt: AgentBankActionReceipt | null = null;
  let queued = false;
  try {
    queued = await inventory.queueOperation(request.playerId, async () => {
      if (!inventory.lockForTransaction(request.playerId)) {
        receipt = createAgentBankFailureReceipt(
          request.action,
          request.playerId,
          request.bankId,
          "inventory_lock_failed",
          baseReceiptInput,
        );
        return false;
      }

      let client: pg.PoolClient | null = null;
      let commitAttempted = false;
      let committed = false;
      let outcome: AgentBankTransferOutcome | null = null;
      let replayed = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        // Serialize this player's bank across server processes, including when
        // no bank row exists yet and therefore no row-level lock is possible.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
          [operationId],
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [request.playerId],
        );
        const requestFingerprint = getBankOperationFingerprint(
          request,
          quantity,
          retainedItems,
          withdrawItems,
        );
        const priorResult = await client.query<{
          preparationId: string | null;
          requestFingerprint: string;
          committedQuantity: number | string;
          inventoryQuantityAfter: number | string | null;
          bankQuantityAfter: number | string | null;
        }>(
          `SELECT "preparationId", "requestFingerprint", "committedQuantity",
                  "inventoryQuantityAfter", "bankQuantityAfter"
           FROM agent_bank_operations
           WHERE "operationId" = $1 FOR UPDATE`,
          [operationId],
        );
        const prior = priorResult.rows[0];
        if (prior) {
          if (
            prior.preparationId !== (request.preparationId ?? null) ||
            prior.requestFingerprint !== requestFingerprint
          ) {
            throw new BankOperationError("operation_id_conflict");
          }
          outcome = {
            committedQuantity: parseQuantity(prior.committedQuantity),
            inventoryQuantityAfter: parseQuantity(prior.inventoryQuantityAfter),
            bankQuantityAfter:
              prior.bankQuantityAfter === null
                ? null
                : parseQuantity(prior.bankQuantityAfter),
          };
          replayed = true;
        } else {
          // Only a new custody mutation reaches this branch. Exact committed
          // replay above is read-only: never flush possibly stale memory over
          // its durable post-state. New work alone proves inventory readiness,
          // persists it, and then revalidates live authority at mutation time.
          if (
            inventory.isInventoryReady &&
            !inventory.isInventoryReady(request.playerId)
          ) {
            throw new BankOperationError("inventory_not_ready");
          }
          await inventory.persistInventoryImmediate(request.playerId);
          const playerAccessFailure = validatePlayerBankAccess(
            request.world,
            request.playerId,
          );
          if (playerAccessFailure) {
            throw new BankOperationError(playerAccessFailure);
          }
          if (request.preparationId) {
            const preparationAccess = await authorizeDuelPreparationBankAccess(
              client,
              {
                preparationId: request.preparationId,
                playerId: request.playerId,
                action: request.action,
                lockForTransaction: true,
              },
            );
            if (!preparationAccess.ok) {
              throw new BankOperationError(preparationAccess.reason);
            }
            const playerAccessAfterPreparationLock = validatePlayerBankAccess(
              request.world,
              request.playerId,
            );
            if (playerAccessAfterPreparationLock) {
              throw new BankOperationError(playerAccessAfterPreparationLock);
            }
          } else {
            const accessFailure = validatePhysicalBankAccess(
              request.world,
              request.playerId,
              request.bankId!,
            );
            if (accessFailure) {
              throw new BankOperationError(accessFailure);
            }
          }
          outcome =
            request.action === "deposit"
              ? await depositOwnedItem(
                  client,
                  request.playerId,
                  request.itemId!,
                  quantity,
                )
              : request.action === "withdraw"
                ? withdrawItems.length > 0
                  ? await withdrawOwnedItems(
                      client,
                      request.playerId,
                      withdrawItems,
                    )
                  : await withdrawOwnedItem(
                      client,
                      request.playerId,
                      request.itemId!,
                      quantity,
                    )
                : await depositAllOwnedItems(
                    client,
                    request.playerId,
                    retainedItems,
                  );
          await client.query(
            `INSERT INTO agent_bank_operations
               ("operationId", "playerId", action, "bankId", "preparationId", "itemId",
                "requestedQuantity", "committedQuantity",
                "inventoryQuantityAfter", "bankQuantityAfter",
                "requestFingerprint", "itemCount")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              operationId,
              request.playerId,
              request.action,
              request.bankId,
              request.preparationId ?? null,
              request.itemId ?? null,
              request.action === "deposit_all"
                ? outcome.committedQuantity
                : quantity,
              outcome.committedQuantity,
              outcome.inventoryQuantityAfter,
              outcome.bankQuantityAfter,
              requestFingerprint,
              outcome.itemOutcomes?.length ??
                (request.action === "deposit_all" ? 0 : 1),
            ],
          );
          for (const itemOutcome of outcome.itemOutcomes ?? []) {
            await client.query(
              `INSERT INTO agent_bank_operation_items
                 ("operationId", "itemId", "requestedQuantity",
                  "committedQuantity", "inventoryQuantityAfter",
                  "bankQuantityAfter")
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                operationId,
                itemOutcome.itemId,
                itemOutcome.requestedQuantity,
                itemOutcome.committedQuantity,
                itemOutcome.inventoryQuantityAfter,
                itemOutcome.bankQuantityAfter,
              ],
            );
          }
        }
        commitAttempted = true;
        await client.query("COMMIT");
        committed = true;
        receipt = {
          success: true,
          operationId,
          commitState: "committed",
          replayed,
          action: request.action,
          playerId: request.playerId,
          bankId: request.bankId,
          itemId: request.itemId ?? null,
          requestedQuantity:
            request.action === "deposit_all"
              ? outcome.committedQuantity
              : quantity,
          committedQuantity: outcome.committedQuantity,
          inventoryQuantityAfter: outcome.inventoryQuantityAfter,
          bankQuantityAfter: outcome.bankQuantityAfter,
        };
      } catch (error) {
        if (client && !commitAttempted) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The receipt still reports the original deterministic rejection.
          }
        }
        receipt = createAgentBankFailureReceipt(
          request.action,
          request.playerId,
          request.bankId,
          commitAttempted
            ? "commit_ambiguous"
            : error instanceof BankOperationError
              ? error.reason
              : "operation_failed",
          {
            ...baseReceiptInput,
            commitState: commitAttempted ? "unknown" : "not_committed",
          },
        );
      } finally {
        // A failed COMMIT has an unknowable server-side outcome and may leave
        // the socket or transaction unusable. Never return that client to the
        // pool; a retry reconciles through the immutable operation receipt.
        client?.release(commitAttempted && !committed);
        try {
          await inventory.reloadFromDatabase(request.playerId);
        } catch {
          if (committed && outcome) {
            receipt = createAgentBankFailureReceipt(
              request.action,
              request.playerId,
              request.bankId,
              "post_commit_sync_failed",
              {
                ...baseReceiptInput,
                commitState: "committed",
                committedQuantity: outcome.committedQuantity,
                inventoryQuantityAfter: outcome.inventoryQuantityAfter,
                bankQuantityAfter: outcome.bankQuantityAfter,
              },
            );
          }
        } finally {
          inventory.unlockTransaction(request.playerId);
        }
      }
      return receipt?.success === true;
    });
  } catch {
    receipt = createAgentBankFailureReceipt(
      request.action,
      request.playerId,
      request.bankId,
      "operation_failed",
      baseReceiptInput,
    );
  }

  return (
    receipt ??
    createAgentBankFailureReceipt(
      request.action,
      request.playerId,
      request.bankId,
      queued ? "operation_failed" : "inventory_lock_failed",
      baseReceiptInput,
    )
  );
}

async function depositOwnedItem(
  client: pg.PoolClient,
  playerId: string,
  inventoryItemId: string,
  quantity: number,
): Promise<AgentBankTransferOutcome> {
  const bankItemId = isNotedItemId(inventoryItemId)
    ? getBaseItemId(inventoryItemId)
    : inventoryItemId;
  const inventoryResult = await client.query<{
    id: number;
    quantity: number | null;
  }>(
    `SELECT id, quantity FROM inventory
     WHERE "playerId" = $1 AND "itemId" = $2
     ORDER BY "slotIndex" FOR UPDATE`,
    [playerId, inventoryItemId],
  );
  if (inventoryResult.rows.length === 0) {
    throw new BankOperationError("item_not_owned");
  }
  const inventoryBefore = inventoryResult.rows.reduce(
    (sum, row) => sum + (row.quantity ?? 1),
    0,
  );
  if (inventoryBefore < quantity) {
    throw new BankOperationError("insufficient_inventory_quantity");
  }

  const bankResult = await client.query<{
    id: number;
    quantity: number | string | null;
  }>(
    `SELECT id, quantity FROM bank_storage
     WHERE "playerId" = $1 AND "itemId" = $2 FOR UPDATE`,
    [playerId, bankItemId],
  );
  const bankBefore = parseQuantity(bankResult.rows[0]?.quantity);
  if (bankBefore + quantity > INPUT_LIMITS.MAX_QUANTITY) {
    throw new BankOperationError("quantity_overflow");
  }
  if (bankResult.rows.length === 0) {
    const countResult = await client.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM bank_storage
       WHERE "playerId" = $1`,
      [playerId],
    );
    if (
      parseQuantity(countResult.rows[0]?.count) >= INPUT_LIMITS.MAX_BANK_SLOTS
    ) {
      throw new BankOperationError("bank_full");
    }
  }

  let remaining = quantity;
  for (const row of inventoryResult.rows) {
    if (remaining <= 0) break;
    const rowQuantity = row.quantity ?? 1;
    if (rowQuantity <= remaining) {
      await client.query(`DELETE FROM inventory WHERE id = $1`, [row.id]);
      remaining -= rowQuantity;
    } else {
      await client.query(`UPDATE inventory SET quantity = $1 WHERE id = $2`, [
        rowQuantity - remaining,
        row.id,
      ]);
      remaining = 0;
    }
  }

  if (bankResult.rows.length > 0) {
    await client.query(
      `UPDATE bank_storage SET quantity = quantity + $1 WHERE id = $2`,
      [quantity, bankResult.rows[0].id],
    );
  } else {
    const slotResult = await client.query<{ slot: number | string }>(
      `SELECT slot FROM bank_storage
       WHERE "playerId" = $1 AND "tabIndex" = 0
       ORDER BY slot FOR UPDATE`,
      [playerId],
    );
    const used = new Set(slotResult.rows.map((row) => parseQuantity(row.slot)));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    await client.query(
      `INSERT INTO bank_storage ("playerId", "itemId", quantity, slot, "tabIndex")
       VALUES ($1, $2, $3, $4, 0)`,
      [playerId, bankItemId, quantity, slot],
    );
  }
  return {
    committedQuantity: quantity,
    inventoryQuantityAfter: inventoryBefore - quantity,
    bankQuantityAfter: bankBefore + quantity,
  };
}

async function withdrawOwnedItem(
  client: pg.PoolClient,
  playerId: string,
  itemId: string,
  quantity: number,
): Promise<AgentBankTransferOutcome> {
  const item = getItem(itemId);
  if (!item) throw new BankOperationError("invalid_item");
  const inventoryResult = await client.query<{
    id: number;
    itemId: string;
    quantity: number | null;
    slotIndex: number | null;
  }>(
    `SELECT id, "itemId", quantity, "slotIndex" FROM inventory
     WHERE "playerId" = $1 FOR UPDATE`,
    [playerId],
  );
  const inventoryBefore = inventoryResult.rows
    .filter((row) => row.itemId === itemId)
    .reduce((sum, row) => sum + (row.quantity ?? 1), 0);
  const usedSlots = new Set(
    inventoryResult.rows
      .map((row) => row.slotIndex)
      .filter((slot): slot is number => slot !== null && slot >= 0),
  );
  const freeSlots = Array.from(
    { length: INPUT_LIMITS.MAX_INVENTORY_SLOTS },
    (_, slot) => slot,
  ).filter((slot) => !usedSlots.has(slot));
  const existingStack = item.stackable
    ? inventoryResult.rows.find((row) => row.itemId === itemId)
    : undefined;
  if (
    item.stackable &&
    inventoryBefore + quantity > INPUT_LIMITS.MAX_QUANTITY
  ) {
    throw new BankOperationError("quantity_overflow");
  }
  if (
    item.stackable
      ? !existingStack && freeSlots.length < 1
      : freeSlots.length < quantity
  ) {
    throw new BankOperationError("inventory_full");
  }

  const bankResult = await client.query<{
    id: number;
    quantity: number | string | null;
    slot: number | string;
    tabIndex: number | string;
  }>(
    `SELECT id, quantity, slot, "tabIndex" FROM bank_storage
     WHERE "playerId" = $1 AND "itemId" = $2 FOR UPDATE`,
    [playerId, itemId],
  );
  if (bankResult.rows.length === 0) {
    throw new BankOperationError("item_not_in_bank");
  }
  const bankRow = bankResult.rows[0];
  const bankBefore = parseQuantity(bankRow.quantity);
  if (bankBefore < quantity) {
    throw new BankOperationError("insufficient_bank_quantity");
  }
  const bankAfter = bankBefore - quantity;
  if (bankAfter > 0) {
    await client.query(`UPDATE bank_storage SET quantity = $1 WHERE id = $2`, [
      bankAfter,
      bankRow.id,
    ]);
  } else {
    await client.query(`DELETE FROM bank_storage WHERE id = $1`, [bankRow.id]);
    await client.query(
      `UPDATE bank_storage SET slot = slot + 1000
       WHERE "playerId" = $1 AND "tabIndex" = $2 AND slot > $3`,
      [playerId, parseQuantity(bankRow.tabIndex), parseQuantity(bankRow.slot)],
    );
    await client.query(
      `UPDATE bank_storage SET slot = slot - 1001
       WHERE "playerId" = $1 AND "tabIndex" = $2 AND slot > 1000`,
      [playerId, parseQuantity(bankRow.tabIndex)],
    );
  }

  if (item.stackable) {
    if (existingStack) {
      await client.query(
        `UPDATE inventory SET quantity = quantity + $1 WHERE id = $2`,
        [quantity, existingStack.id],
      );
    } else {
      await client.query(
        `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex", metadata)
         VALUES ($1, $2, $3, $4, NULL)`,
        [playerId, itemId, quantity, freeSlots[0]],
      );
    }
  } else {
    for (let index = 0; index < quantity; index += 1) {
      await client.query(
        `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex", metadata)
         VALUES ($1, $2, 1, $3, NULL)`,
        [playerId, itemId, freeSlots[index]],
      );
    }
  }
  return {
    committedQuantity: quantity,
    inventoryQuantityAfter: inventoryBefore + quantity,
    bankQuantityAfter: bankAfter,
  };
}

/**
 * Withdraw every component inside one database transaction. The normalized
 * item order is stable, which keeps row-lock acquisition deterministic across
 * competing server processes. Any later rejection rolls back every earlier
 * component before a receipt can exist.
 */
async function withdrawOwnedItems(
  client: pg.PoolClient,
  playerId: string,
  items: AgentBankTransferItem[],
): Promise<AgentBankTransferOutcome> {
  const itemOutcomes: NonNullable<AgentBankTransferOutcome["itemOutcomes"]> =
    [];
  let committedQuantity = 0;
  let inventoryQuantityAfter = 0;
  for (const item of items) {
    const outcome = await withdrawOwnedItem(
      client,
      playerId,
      item.itemId,
      item.quantity,
    );
    committedQuantity += outcome.committedQuantity;
    inventoryQuantityAfter += outcome.inventoryQuantityAfter;
    if (
      committedQuantity > INPUT_LIMITS.MAX_QUANTITY ||
      inventoryQuantityAfter > INPUT_LIMITS.MAX_QUANTITY
    ) {
      throw new BankOperationError("quantity_overflow");
    }
    itemOutcomes.push({
      itemId: item.itemId,
      requestedQuantity: item.quantity,
      committedQuantity: outcome.committedQuantity,
      inventoryQuantityAfter: outcome.inventoryQuantityAfter,
      bankQuantityAfter: outcome.bankQuantityAfter ?? 0,
    });
  }
  return {
    committedQuantity,
    inventoryQuantityAfter,
    bankQuantityAfter: null,
    itemOutcomes,
  };
}

async function depositAllOwnedItems(
  client: pg.PoolClient,
  playerId: string,
  retainedItems: AgentBankRetainedItem[],
): Promise<AgentBankTransferOutcome> {
  const inventoryResult = await client.query<{
    id: number;
    itemId: string;
    quantity: number | null;
  }>(
    `SELECT id, "itemId", quantity FROM inventory
     WHERE "playerId" = $1 ORDER BY "slotIndex" FOR UPDATE`,
    [playerId],
  );
  if (inventoryResult.rows.length === 0) {
    throw new BankOperationError("inventory_empty");
  }
  const retainRemaining = new Map(
    retainedItems.map((entry) => [entry.itemId, entry.quantity]),
  );
  const rowPlans: Array<{
    id: number;
    originalQuantity: number;
    retainedQuantity: number;
  }> = [];
  const groups = new Map<string, number>();
  let committedQuantity = 0;
  let inventoryQuantityAfter = 0;
  for (const row of inventoryResult.rows) {
    const bankItemId = isNotedItemId(row.itemId)
      ? getBaseItemId(row.itemId)
      : row.itemId;
    if (!getItem(row.itemId) || !getItem(bankItemId)) {
      throw new BankOperationError("invalid_item");
    }
    const quantity = row.quantity ?? 1;
    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > INPUT_LIMITS.MAX_QUANTITY
    ) {
      throw new BankOperationError("invalid_quantity");
    }
    const requestedRetention = retainRemaining.get(row.itemId) ?? 0;
    const retainedQuantity = Math.min(quantity, requestedRetention);
    if (retainedQuantity > 0) {
      retainRemaining.set(row.itemId, requestedRetention - retainedQuantity);
    }
    const depositedQuantity = quantity - retainedQuantity;
    if (depositedQuantity > 0) {
      const groupedQuantity = (groups.get(bankItemId) ?? 0) + depositedQuantity;
      if (groupedQuantity > INPUT_LIMITS.MAX_QUANTITY) {
        throw new BankOperationError("quantity_overflow");
      }
      groups.set(bankItemId, groupedQuantity);
      committedQuantity += depositedQuantity;
      if (committedQuantity > INPUT_LIMITS.MAX_QUANTITY) {
        throw new BankOperationError("quantity_overflow");
      }
    }
    inventoryQuantityAfter += retainedQuantity;
    rowPlans.push({
      id: row.id,
      originalQuantity: quantity,
      retainedQuantity,
    });
  }
  if (committedQuantity === 0) {
    throw new BankOperationError("nothing_to_deposit");
  }
  const bankResult = await client.query<{
    id: number;
    itemId: string;
    quantity: number | string | null;
    slot: number | string;
    tabIndex: number | string;
  }>(
    `SELECT id, "itemId", quantity, slot, "tabIndex" FROM bank_storage
     WHERE "playerId" = $1 FOR UPDATE`,
    [playerId],
  );
  const bankByItem = new Map(bankResult.rows.map((row) => [row.itemId, row]));
  const additions = [...groups.keys()].filter(
    (itemId) => !bankByItem.has(itemId),
  );
  if (bankResult.rows.length + additions.length > INPUT_LIMITS.MAX_BANK_SLOTS) {
    throw new BankOperationError("bank_full");
  }
  for (const [itemId, quantity] of groups) {
    const existing = bankByItem.get(itemId);
    const before = parseQuantity(existing?.quantity);
    if (before + quantity > INPUT_LIMITS.MAX_QUANTITY) {
      throw new BankOperationError("quantity_overflow");
    }
  }

  const usedSlots = new Set(
    bankResult.rows
      .filter((row) => parseQuantity(row.tabIndex) === 0)
      .map((row) => parseQuantity(row.slot)),
  );
  let nextSlot = 0;
  for (const [itemId, quantity] of groups) {
    const existing = bankByItem.get(itemId);
    if (existing) {
      await client.query(
        `UPDATE bank_storage SET quantity = quantity + $1 WHERE id = $2`,
        [quantity, existing.id],
      );
      continue;
    }
    while (usedSlots.has(nextSlot)) nextSlot += 1;
    usedSlots.add(nextSlot);
    await client.query(
      `INSERT INTO bank_storage ("playerId", "itemId", quantity, slot, "tabIndex")
       VALUES ($1, $2, $3, $4, 0)`,
      [playerId, itemId, quantity, nextSlot],
    );
  }
  for (const plan of rowPlans) {
    if (plan.retainedQuantity === plan.originalQuantity) continue;
    if (plan.retainedQuantity === 0) {
      await client.query(`DELETE FROM inventory WHERE id = $1`, [plan.id]);
    } else {
      await client.query(`UPDATE inventory SET quantity = $1 WHERE id = $2`, [
        plan.retainedQuantity,
        plan.id,
      ]);
    }
  }
  return {
    committedQuantity,
    inventoryQuantityAfter,
    bankQuantityAfter: null,
  };
}
