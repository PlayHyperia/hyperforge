import crypto from "node:crypto";
import type pg from "pg";
import { INPUT_LIMITS, getItem, type World } from "@hyperforge/shared";

import {
  createAgentBankFailureReceipt,
  executeAuthoritativeAgentBankTransfer,
  type AgentBankActionReceipt,
  type AgentBankFailureReason,
  type AgentBankRetainedItem,
} from "./AuthoritativeAgentBanking.js";

const EXTERNAL_BANK_WAITER_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ExternalAgentBankEnvelope = {
  action: "deposit" | "withdraw" | "deposit_all";
  bankId: string;
  itemId: string | null;
  quantity: number;
  retainedItems: AgentBankRetainedItem[];
};

export type ExternalAgentBankWaiter = {
  version: 1;
  operationId: string;
  envelope: ExternalAgentBankEnvelope;
  status: "pending" | "committed" | "rejected";
  receipt: AgentBankActionReceipt | null;
  acceptedAt: number;
  terminalAt: number | null;
  acknowledgedAt: number | null;
};

export type ExternalAgentBankClaim =
  | { kind: "claimed"; waiter: ExternalAgentBankWaiter }
  | { kind: "recovery_required"; waiter: ExternalAgentBankWaiter };

type DatabaseSystemWithPool = {
  getPool?: () => pg.Pool | null;
};

function getPool(world: World): pg.Pool | null {
  const directPool = (world as { pgPool?: pg.Pool }).pgPool;
  if (directPool) return directPool;
  const database = world.getSystem("database") as DatabaseSystemWithPool | null;
  return database?.getPool?.() ?? null;
}

function waiterId(playerId: string): string {
  return `external-agent-bank-waiter:${playerId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeRetainedItems(
  value: unknown,
): AgentBankRetainedItem[] | null {
  if (
    !Array.isArray(value) ||
    value.length > INPUT_LIMITS.MAX_INVENTORY_SLOTS
  ) {
    return null;
  }
  const seen = new Set<string>();
  const retainedItems: AgentBankRetainedItem[] = [];
  for (const raw of value) {
    if (
      !isPlainObject(raw) ||
      !hasOnlyKeys(raw, new Set(["itemId", "quantity"]))
    ) {
      return null;
    }
    const itemId = typeof raw.itemId === "string" ? raw.itemId : "";
    const quantity = Number(raw.quantity);
    if (
      !itemId ||
      itemId.trim() !== itemId ||
      !getItem(itemId) ||
      seen.has(itemId) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > INPUT_LIMITS.MAX_QUANTITY
    ) {
      return null;
    }
    seen.add(itemId);
    retainedItems.push({ itemId, quantity });
  }
  return retainedItems.sort((left, right) =>
    left.itemId.localeCompare(right.itemId),
  );
}

export function normalizeExternalAgentBankEnvelope(
  value: unknown,
): ExternalAgentBankEnvelope | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(
      value,
      new Set(["action", "bankId", "itemId", "quantity", "retainedItems"]),
    )
  ) {
    return null;
  }
  const action = value.action;
  const bankId = typeof value.bankId === "string" ? value.bankId : "";
  const itemId = value.itemId === null ? null : value.itemId;
  const quantity = Number(value.quantity);
  const retainedItems = normalizeRetainedItems(value.retainedItems);
  if (
    (action !== "deposit" &&
      action !== "withdraw" &&
      action !== "deposit_all") ||
    !bankId ||
    bankId.length > 256 ||
    bankId.trim() !== bankId ||
    /\s/.test(bankId) ||
    retainedItems === null
  ) {
    return null;
  }
  if (action === "deposit_all") {
    return itemId === null && quantity === 0
      ? { action, bankId, itemId, quantity, retainedItems }
      : null;
  }
  if (
    retainedItems.length > 0 ||
    typeof itemId !== "string" ||
    !itemId ||
    itemId.trim() !== itemId ||
    !getItem(itemId) ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > INPUT_LIMITS.MAX_QUANTITY
  ) {
    return null;
  }
  return { action, bankId, itemId, quantity, retainedItems };
}

function normalizeReceipt(
  value: unknown,
  playerId: string,
  operationId: string,
  envelope: ExternalAgentBankEnvelope,
): AgentBankActionReceipt | null {
  if (!isPlainObject(value)) return null;
  const success = value.success === true;
  const commitState = value.commitState;
  const action = value.action;
  const failureReason = value.failureReason;
  const requestedQuantity = Number(value.requestedQuantity);
  const committedQuantity = Number(value.committedQuantity);
  const inventoryQuantityAfter =
    value.inventoryQuantityAfter === null
      ? null
      : Number(value.inventoryQuantityAfter);
  const bankQuantityAfter =
    value.bankQuantityAfter === null ? null : Number(value.bankQuantityAfter);
  if (
    value.operationId !== operationId ||
    value.playerId !== playerId ||
    value.bankId !== envelope.bankId ||
    action !== envelope.action ||
    value.itemId !== envelope.itemId ||
    (commitState !== "not_committed" && commitState !== "committed") ||
    typeof value.replayed !== "boolean" ||
    !Number.isSafeInteger(requestedQuantity) ||
    requestedQuantity < 0 ||
    !Number.isSafeInteger(committedQuantity) ||
    committedQuantity < 0 ||
    (inventoryQuantityAfter !== null &&
      (!Number.isSafeInteger(inventoryQuantityAfter) ||
        inventoryQuantityAfter < 0)) ||
    (bankQuantityAfter !== null &&
      (!Number.isSafeInteger(bankQuantityAfter) || bankQuantityAfter < 0)) ||
    (envelope.action !== "deposit_all" &&
      requestedQuantity !== envelope.quantity) ||
    (success &&
      (commitState !== "committed" ||
        requestedQuantity <= 0 ||
        committedQuantity !== requestedQuantity ||
        inventoryQuantityAfter === null)) ||
    (!success &&
      (typeof failureReason !== "string" ||
        (commitState === "not_committed" && committedQuantity !== 0)))
  ) {
    return null;
  }
  return value as unknown as AgentBankActionReceipt;
}

function normalizeWaiter(
  value: unknown,
  playerId: string,
  completed: boolean,
): ExternalAgentBankWaiter | null {
  if (!isPlainObject(value)) return null;
  const envelope = normalizeExternalAgentBankEnvelope(value.envelope);
  const operationId =
    typeof value.operationId === "string" ? value.operationId : "";
  const acceptedAt = Number(value.acceptedAt);
  const terminalAt =
    value.terminalAt === null ? null : Number(value.terminalAt);
  const acknowledgedAt =
    value.acknowledgedAt === null ? null : Number(value.acknowledgedAt);
  if (
    value.version !== EXTERNAL_BANK_WAITER_VERSION ||
    !UUID_PATTERN.test(operationId) ||
    !envelope ||
    (value.status !== "pending" &&
      value.status !== "committed" &&
      value.status !== "rejected") ||
    !Number.isSafeInteger(acceptedAt) ||
    acceptedAt <= 0 ||
    (value.status === "pending" && terminalAt !== null) ||
    (value.status !== "pending" &&
      (!Number.isSafeInteger(terminalAt) || terminalAt! < acceptedAt)) ||
    (acknowledgedAt !== null &&
      (!Number.isSafeInteger(acknowledgedAt) ||
        terminalAt === null ||
        acknowledgedAt < terminalAt)) ||
    (completed && acknowledgedAt === null) ||
    (!completed && acknowledgedAt !== null)
  ) {
    return null;
  }
  const receipt =
    value.receipt === null
      ? null
      : normalizeReceipt(value.receipt, playerId, operationId, envelope);
  if (
    (value.status === "pending" && receipt !== null) ||
    (value.status !== "pending" && receipt === null) ||
    (value.status === "committed" &&
      !(receipt?.success || receipt?.commitState === "committed")) ||
    (value.status === "rejected" &&
      (receipt?.success || receipt?.commitState !== "not_committed"))
  ) {
    return null;
  }
  return {
    version: 1,
    operationId,
    envelope,
    status: value.status,
    receipt,
    acceptedAt,
    terminalAt,
    acknowledgedAt,
  };
}

function envelopesEqual(
  left: ExternalAgentBankEnvelope,
  right: ExternalAgentBankEnvelope,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function databaseNow(client: pg.PoolClient): Promise<number> {
  const result = await client.query<{ now: number | string }>(
    `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT AS now`,
  );
  return Number(result.rows[0]?.now);
}

async function lockCharacter(
  client: pg.PoolClient,
  playerId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT id FROM characters WHERE id = $1 FOR UPDATE`,
    [playerId],
  );
  if (result.rowCount !== 1) throw new Error("external_bank_player_missing");
}

async function readWaiter(
  client: pg.PoolClient,
  playerId: string,
): Promise<{ waiter: ExternalAgentBankWaiter; completed: boolean } | null> {
  const result = await client.query<{
    playerId: string;
    operationType: string;
    operationState: unknown;
    completed: boolean | null;
  }>(
    `SELECT "playerId", "operationType", "operationState", completed
       FROM operations_log WHERE id = $1 FOR UPDATE`,
    [waiterId(playerId)],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (typeof row.completed !== "boolean") {
    throw new Error("external_bank_waiter_invalid");
  }
  const waiter = normalizeWaiter(row.operationState, playerId, row.completed);
  if (
    row.playerId !== playerId ||
    row.operationType !== "external_agent_bank_waiter" ||
    !waiter
  ) {
    throw new Error("external_bank_waiter_invalid");
  }
  return { waiter, completed: row.completed };
}

async function writeWaiter(
  client: pg.PoolClient,
  playerId: string,
  waiter: ExternalAgentBankWaiter,
  exists: boolean,
): Promise<void> {
  if (exists) {
    await client.query(
      `UPDATE operations_log
          SET "operationState" = $1, completed = false,
              timestamp = $2, "completedAt" = NULL
        WHERE id = $3`,
      [waiter, waiter.acceptedAt, waiterId(playerId)],
    );
    return;
  }
  await client.query(
    `INSERT INTO operations_log
       (id, "playerId", "operationType", "operationState", completed,
        timestamp, "completedAt")
     VALUES ($1, $2, 'external_agent_bank_waiter', $3, false, $4, NULL)`,
    [waiterId(playerId), playerId, waiter, waiter.acceptedAt],
  );
}

export async function claimExternalAgentBankOperation(
  world: World,
  playerId: string,
  envelopeInput: unknown,
): Promise<ExternalAgentBankClaim> {
  const envelope = normalizeExternalAgentBankEnvelope(envelopeInput);
  const pool = getPool(world);
  if (!envelope || !pool) {
    throw new Error(
      !envelope
        ? "external_bank_request_invalid"
        : "external_bank_database_unavailable",
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockCharacter(client, playerId);
    const existing = await readWaiter(client, playerId);
    if (existing && !existing.completed) {
      await client.query("COMMIT");
      return envelopesEqual(existing.waiter.envelope, envelope)
        ? { kind: "claimed", waiter: existing.waiter }
        : { kind: "recovery_required", waiter: existing.waiter };
    }
    const acceptedAt = await databaseNow(client);
    const waiter: ExternalAgentBankWaiter = {
      version: 1,
      operationId: crypto.randomUUID(),
      envelope,
      status: "pending",
      receipt: null,
      acceptedAt,
      terminalAt: null,
      acknowledgedAt: null,
    };
    await writeWaiter(client, playerId, waiter, existing !== null);
    await client.query("COMMIT");
    return { kind: "claimed", waiter };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function receiptFromLedger(
  client: pg.PoolClient,
  playerId: string,
  waiter: ExternalAgentBankWaiter,
): Promise<AgentBankActionReceipt | null> {
  const result = await client.query<{
    playerId: string;
    action: string;
    bankId: string;
    itemId: string | null;
    requestedQuantity: number | string;
    committedQuantity: number | string;
    inventoryQuantityAfter: number | string;
    bankQuantityAfter: number | string | null;
  }>(
    `SELECT "playerId", action, "bankId", "itemId", "requestedQuantity",
            "committedQuantity", "inventoryQuantityAfter", "bankQuantityAfter"
       FROM agent_bank_operations WHERE "operationId" = $1`,
    [waiter.operationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const requestedQuantity = Number(row.requestedQuantity);
  const committedQuantity = Number(row.committedQuantity);
  const inventoryQuantityAfter = Number(row.inventoryQuantityAfter);
  const bankQuantityAfter =
    row.bankQuantityAfter === null ? null : Number(row.bankQuantityAfter);
  if (
    row.playerId !== playerId ||
    row.action !== waiter.envelope.action ||
    row.bankId !== waiter.envelope.bankId ||
    row.itemId !== waiter.envelope.itemId ||
    !Number.isSafeInteger(requestedQuantity) ||
    requestedQuantity <= 0 ||
    !Number.isSafeInteger(committedQuantity) ||
    committedQuantity !== requestedQuantity ||
    !Number.isSafeInteger(inventoryQuantityAfter) ||
    inventoryQuantityAfter < 0 ||
    (bankQuantityAfter !== null &&
      (!Number.isSafeInteger(bankQuantityAfter) || bankQuantityAfter < 0)) ||
    (waiter.envelope.action !== "deposit_all" &&
      requestedQuantity !== waiter.envelope.quantity)
  ) {
    throw new Error("external_bank_receipt_identity_mismatch");
  }
  return {
    success: true,
    operationId: waiter.operationId,
    commitState: "committed",
    replayed: true,
    action: waiter.envelope.action,
    playerId,
    bankId: row.bankId,
    itemId: row.itemId,
    requestedQuantity,
    committedQuantity,
    inventoryQuantityAfter,
    bankQuantityAfter,
  };
}

async function settleWaiter(
  world: World,
  playerId: string,
  operationId: string,
  candidate: AgentBankActionReceipt | null,
): Promise<ExternalAgentBankWaiter> {
  const pool = getPool(world);
  if (!pool) throw new Error("external_bank_database_unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockCharacter(client, playerId);
    const stored = await readWaiter(client, playerId);
    if (
      !stored ||
      stored.completed ||
      stored.waiter.operationId !== operationId
    ) {
      throw new Error("external_bank_waiter_mismatch");
    }
    if (stored.waiter.status !== "pending") {
      await client.query("COMMIT");
      return stored.waiter;
    }
    const ledgerReceipt = await receiptFromLedger(
      client,
      playerId,
      stored.waiter,
    );
    const receipt = ledgerReceipt ?? candidate;
    if (!receipt || receipt.commitState === "unknown") {
      await client.query("COMMIT");
      return stored.waiter;
    }
    const normalized = normalizeReceipt(
      receipt,
      playerId,
      operationId,
      stored.waiter.envelope,
    );
    if (!normalized) throw new Error("external_bank_receipt_invalid");
    const terminalAt = await databaseNow(client);
    const waiter: ExternalAgentBankWaiter = {
      ...stored.waiter,
      status:
        normalized.success || normalized.commitState === "committed"
          ? "committed"
          : "rejected",
      receipt: normalized,
      terminalAt,
    };
    await client.query(
      `UPDATE operations_log
          SET "operationState" = $1, timestamp = $2
        WHERE id = $3`,
      [waiter, terminalAt, waiterId(playerId)],
    );
    await client.query("COMMIT");
    return waiter;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function executeWaiter(
  world: World,
  playerId: string,
  waiter: ExternalAgentBankWaiter,
): Promise<ExternalAgentBankWaiter> {
  if (waiter.status !== "pending") return waiter;
  const envelope = waiter.envelope;
  const receipt = await executeAuthoritativeAgentBankTransfer({
    world,
    playerId,
    bankId: envelope.bankId,
    action: envelope.action,
    ...(envelope.itemId ? { itemId: envelope.itemId } : {}),
    ...(envelope.action === "deposit_all"
      ? { retainedItems: envelope.retainedItems }
      : { quantity: envelope.quantity }),
    operationId: waiter.operationId,
  });
  return settleWaiter(world, playerId, waiter.operationId, receipt);
}

export async function executeExternalAgentBankOperation(
  world: World,
  playerId: string,
  envelopeInput: unknown,
): Promise<AgentBankActionReceipt> {
  const envelope = normalizeExternalAgentBankEnvelope(envelopeInput);
  if (!envelope) throw new Error("external_bank_request_invalid");
  const claim = await claimExternalAgentBankOperation(
    world,
    playerId,
    envelope,
  );
  if (claim.kind === "recovery_required") {
    return createAgentBankFailureReceipt(
      envelope.action,
      playerId,
      envelope.bankId,
      "recovery_required",
      {
        operationId: crypto.randomUUID(),
        itemId: envelope.itemId ?? undefined,
        quantity: envelope.quantity,
      },
    );
  }
  const settled = await executeWaiter(world, playerId, claim.waiter);
  return (
    settled.receipt ??
    createAgentBankFailureReceipt(
      settled.envelope.action,
      playerId,
      settled.envelope.bankId,
      "commit_ambiguous",
      {
        operationId: settled.operationId,
        itemId: settled.envelope.itemId ?? undefined,
        quantity: settled.envelope.quantity,
        commitState: "unknown",
      },
    )
  );
}

export async function recoverExternalAgentBankOperation(
  world: World,
  playerId: string,
): Promise<ExternalAgentBankWaiter | null> {
  const pool = getPool(world);
  if (!pool) throw new Error("external_bank_database_unavailable");
  const client = await pool.connect();
  let waiter: ExternalAgentBankWaiter | null = null;
  try {
    await client.query("BEGIN");
    await lockCharacter(client, playerId);
    const stored = await readWaiter(client, playerId);
    if (!stored || stored.completed) {
      await client.query("COMMIT");
      return null;
    }
    waiter = stored.waiter;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return executeWaiter(world, playerId, waiter!);
}

export async function acknowledgeExternalAgentBankOperation(
  world: World,
  playerId: string,
  operationId: string,
): Promise<boolean> {
  if (!UUID_PATTERN.test(operationId)) return false;
  const pool = getPool(world);
  if (!pool) throw new Error("external_bank_database_unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockCharacter(client, playerId);
    const stored = await readWaiter(client, playerId);
    if (!stored || stored.waiter.operationId !== operationId) {
      await client.query("COMMIT");
      return false;
    }
    if (stored.completed) {
      await client.query("COMMIT");
      return true;
    }
    if (stored.waiter.status === "pending" || !stored.waiter.receipt) {
      await client.query("COMMIT");
      return false;
    }
    const acknowledgedAt = await databaseNow(client);
    await client.query(
      `UPDATE operations_log
          SET "operationState" = $1, completed = true,
              timestamp = $2, "completedAt" = $2
        WHERE id = $3`,
      [
        { ...stored.waiter, acknowledgedAt },
        acknowledgedAt,
        waiterId(playerId),
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createExternalAgentBankUnavailableReceipt(
  envelope: ExternalAgentBankEnvelope | null,
  playerId: string | null,
  reason: AgentBankFailureReason,
): AgentBankActionReceipt {
  return createAgentBankFailureReceipt(
    envelope?.action ?? "deposit_all",
    playerId,
    envelope?.bankId ?? null,
    reason,
    {
      itemId: envelope?.itemId ?? undefined,
      quantity: envelope?.quantity ?? 0,
    },
  );
}
