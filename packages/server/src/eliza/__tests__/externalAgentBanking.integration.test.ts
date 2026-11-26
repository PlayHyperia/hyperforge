import { randomUUID } from "node:crypto";

import { ITEMS, type World } from "@hyperforge/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeAuthoritativeAgentBankTransfer } from "../AuthoritativeAgentBanking.js";
import {
  acknowledgeExternalAgentBankOperation,
  claimExternalAgentBankOperation,
  executeExternalAgentBankOperation,
  recoverExternalAgentBankOperation,
} from "../externalAgentBanking.js";

const connectionString =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = connectionString ? describe.sequential : describe.skip;

describeDatabase("external-agent durable banking PostgreSQL contract", () => {
  const pool = new pg.Pool({ connectionString, max: 6 });
  const runId = randomUUID();
  const accountId = `external-bank-account-${runId}`;
  const playerId = `external-bank-player-${runId}`;
  const bankId = `external-bank-${runId}`;
  const itemId = `external_bank_item_${runId.replaceAll("-", "")}`;
  let world: World;
  let inventoryLocked = false;

  beforeAll(async () => {
    ITEMS.set(itemId, {
      id: itemId,
      name: "External Bank Integration Item",
      type: "resource",
      stackable: true,
      description: "Integration custody item",
      examine: "Integration custody item.",
      tradeable: false,
      rarity: "common",
      modelPath: null,
      iconPath: "",
    } as never);
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, 'External Bank Account', 'user', '2026-08-10T00:00:00.000Z')`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent")
       VALUES ($1, $2, 'External Bank Agent', 1)`,
      [playerId, accountId],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, $2, 5, 0)`,
      [playerId, itemId],
    );

    const entities = new Map<string, unknown>([
      [
        playerId,
        {
          id: playerId,
          position: [10, 0, 10],
          data: { position: [10, 0, 10], inStreamingDuel: false },
        },
      ],
      [
        bankId,
        {
          id: bankId,
          entityType: "bank",
          position: [11, 0, 11],
          data: { entityType: "bank", position: [11, 0, 11] },
        },
      ],
    ]);
    const inventory = {
      isInventoryReady: () => true,
      queueOperation: async (_id: string, operation: () => Promise<boolean>) =>
        operation(),
      lockForTransaction: () => {
        if (inventoryLocked) return false;
        inventoryLocked = true;
        return true;
      },
      unlockTransaction: () => {
        inventoryLocked = false;
      },
      persistInventoryImmediate: async () => {},
      reloadFromDatabase: async () => {},
    };
    world = {
      pgPool: pool,
      entities: { get: (id: string) => entities.get(id) },
      getSystem: (name: string) => {
        if (name === "inventory") return inventory;
        if (name === "duel") return { isPlayerInDuel: () => false };
        return null;
      },
    } as unknown as World;
  });

  afterAll(async () => {
    ITEMS.delete(itemId);
    await pool.end();
  });

  it("recovers a committed mutation from the immutable receipt when the caller dies before settling its waiter", async () => {
    const envelope = {
      action: "deposit_all" as const,
      bankId,
      itemId: null,
      quantity: 0,
      retainedItems: [{ itemId, quantity: 2 }],
    };
    const claim = await claimExternalAgentBankOperation(
      world,
      playerId,
      envelope,
    );
    expect(claim.kind).toBe("claimed");

    // This is the precise after-COMMIT/before-response process-loss boundary:
    // custody and its immutable receipt commit, but no waiter settlement runs.
    const committed = await executeAuthoritativeAgentBankTransfer({
      world,
      playerId,
      bankId,
      action: "deposit_all",
      retainedItems: envelope.retainedItems,
      operationId: claim.waiter.operationId,
    });
    expect(committed).toMatchObject({
      success: true,
      commitState: "committed",
      committedQuantity: 3,
      replayed: false,
    });

    const pendingHead = await pool.query<{
      operationState: { status: string };
      completed: boolean;
    }>(`SELECT "operationState", completed FROM operations_log WHERE id = $1`, [
      `external-agent-bank-waiter:${playerId}`,
    ]);
    expect(pendingHead.rows[0]).toMatchObject({
      completed: false,
      operationState: { status: "pending" },
    });

    const recovered = await recoverExternalAgentBankOperation(world, playerId);
    expect(recovered).toMatchObject({
      operationId: claim.waiter.operationId,
      status: "committed",
      receipt: {
        success: true,
        commitState: "committed",
        committedQuantity: 3,
        replayed: true,
      },
    });
    const repeatedRecovery = await recoverExternalAgentBankOperation(
      world,
      playerId,
    );
    expect(repeatedRecovery).toEqual(recovered);

    const competing = await claimExternalAgentBankOperation(world, playerId, {
      action: "withdraw",
      bankId,
      itemId,
      quantity: 1,
      retainedItems: [],
    });
    expect(competing).toMatchObject({
      kind: "recovery_required",
      waiter: { operationId: claim.waiter.operationId },
    });

    await expect(
      acknowledgeExternalAgentBankOperation(
        world,
        playerId,
        claim.waiter.operationId,
      ),
    ).resolves.toBe(true);
    await expect(
      acknowledgeExternalAgentBankOperation(
        world,
        playerId,
        claim.waiter.operationId,
      ),
    ).resolves.toBe(true);
    await expect(
      recoverExternalAgentBankOperation(world, playerId),
    ).resolves.toBeNull();

    const custody = await pool.query<{
      inventory: string;
      bank: string;
      receipts: string;
    }>(
      `SELECT
         (SELECT COALESCE(SUM(quantity), 0)::text FROM inventory
           WHERE "playerId" = $1 AND "itemId" = $2) AS inventory,
         (SELECT COALESCE(SUM(quantity), 0)::text FROM bank_storage
           WHERE "playerId" = $1 AND "itemId" = $2) AS bank,
         (SELECT COUNT(*)::text FROM agent_bank_operations
           WHERE "playerId" = $1 AND "operationId" = $3) AS receipts`,
      [playerId, itemId, claim.waiter.operationId],
    );
    expect(custody.rows[0]).toEqual({
      inventory: "2",
      bank: "3",
      receipts: "1",
    });
  });

  it("keeps a deterministic rejection recoverable until explicit acknowledgement", async () => {
    const receipt = await executeExternalAgentBankOperation(world, playerId, {
      action: "withdraw",
      bankId,
      itemId,
      quantity: 99,
      retainedItems: [],
    });
    expect(receipt).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "insufficient_bank_quantity",
    });
    const recovered = await recoverExternalAgentBankOperation(world, playerId);
    expect(recovered).toMatchObject({
      operationId: receipt.operationId,
      status: "rejected",
      receipt: {
        failureReason: "insufficient_bank_quantity",
      },
    });
    await expect(
      acknowledgeExternalAgentBankOperation(
        world,
        playerId,
        receipt.operationId,
      ),
    ).resolves.toBe(true);
  });
});
