import path from "node:path";

import { ITEMS } from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import { handleStoreBuy, handleStoreSell } from "../handlers/store.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;
const PLAYER_ID = "agent-store-receipt-player";
const ACCOUNT_ID = "agent-store-receipt-account";
const BUY_ITEM_ID = "agent_store_receipt_tool";
const SELL_ITEM_ID = "agent_store_receipt_resource";
const STORE_ID = "agent_store_receipt_shop";
const TARGET_ID = "agent-store-receipt-shopkeeper";

const waitForRateLimit = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 70));

describeDatabase("agent store operation PostgreSQL receipts", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let world: Record<string, unknown>;
  let socket: Record<string, unknown>;

  beforeAll(async () => {
    databaseName = `hyperia_store_receipt_${process.pid}_${Date.now().toString(36)}`;
    const adminUrl = new URL(baseDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 2 });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);

    const testUrl = new URL(baseDatabaseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 8 });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          import.meta.dirname,
          "../../../database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values({
      id: ACCOUNT_ID,
      name: "Agent Store Receipt Account",
      roles: "user",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    await db.insert(schema.characters).values({
      id: PLAYER_ID,
      accountId: ACCOUNT_ID,
      name: "Agent Store Receipt Player",
      isAgent: 1,
      coins: 100,
    });
    await db.insert(schema.inventory).values({
      playerId: PLAYER_ID,
      itemId: SELL_ITEM_ID,
      quantity: 2,
      slotIndex: 0,
      metadata: null,
    });

    ITEMS.set(BUY_ITEM_ID, {
      id: BUY_ITEM_ID,
      name: "Receipt Tool",
      type: "tool",
      stackable: false,
      value: 10,
    } as never);
    ITEMS.set(SELL_ITEM_ID, {
      id: SELL_ITEM_ID,
      name: "Receipt Resource",
      type: "resource",
      stackable: true,
      value: 10,
    } as never);

    const inventorySystem = {
      queueOperation: async (
        _playerId: string,
        operation: () => Promise<boolean>,
      ) => operation(),
      lockForTransaction: () => true,
      unlockTransaction: () => undefined,
      persistInventoryImmediate: async () => undefined,
      reloadFromDatabase: async () => undefined,
    };
    const store = {
      id: STORE_ID,
      name: "Receipt Shop",
      items: [
        {
          id: BUY_ITEM_ID,
          itemId: BUY_ITEM_ID,
          price: 10,
          stockQuantity: -1,
        },
      ],
      buyback: true,
      buybackRate: 0.5,
    };
    const target = {
      id: TARGET_ID,
      position: { x: 1, y: 0, z: 1 },
    };
    world = {
      entities: new Map([[TARGET_ID, target]]),
      interactionSessionManager: {
        getSession: () => ({
          playerId: PLAYER_ID,
          sessionType: "store",
          targetEntityId: TARGET_ID,
          targetStoreId: STORE_ID,
          openedAtTick: 0,
        }),
      },
      drizzleDb: db,
      pgPool: pool,
      getSystem: (name: string) => {
        if (name === "inventory") return inventorySystem;
        if (name === "store") return { getStore: () => store };
        return undefined;
      },
      emit: vi.fn(),
    };
    socket = {
      id: "agent-store-receipt-socket",
      player: {
        id: PLAYER_ID,
        position: { x: 1, y: 0, z: 1 },
      },
      send: vi.fn(),
    };
  }, 30_000);

  afterAll(async () => {
    ITEMS.delete(BUY_ITEM_ID);
    ITEMS.delete(SELL_ITEM_ID);
    await pool?.end();
    if (adminPool && databaseName) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
  }, 30_000);

  it("replays committed buys and sells without duplicating custody or coins", async () => {
    const buyOperationId = "581e3cb9-61de-4cb4-a5bb-c0a29b6378c2";
    const buyRequest = {
      storeId: STORE_ID,
      itemId: BUY_ITEM_ID,
      quantity: 1,
      operationId: buyOperationId,
    };
    await expect(
      handleStoreBuy(socket as never, buyRequest, world as never),
    ).resolves.toEqual({
      status: "committed",
      operationId: buyOperationId,
      replayed: false,
    });

    await waitForRateLimit();
    await expect(
      handleStoreBuy(socket as never, buyRequest, world as never),
    ).resolves.toEqual({
      status: "committed",
      operationId: buyOperationId,
      replayed: true,
    });

    await waitForRateLimit();
    await expect(
      handleStoreBuy(
        socket as never,
        { ...buyRequest, quantity: 2 },
        world as never,
      ),
    ).resolves.toMatchObject({ status: "rejected", replayed: false });

    const afterBuy = await pool.query<{
      coins: number;
      item_quantity: string;
      receipt_count: string;
    }>(
      `SELECT coins,
         (SELECT COALESCE(sum(quantity), 0)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $2) AS item_quantity,
         (SELECT count(*)::text FROM agent_store_operations
          WHERE operation_id = $3) AS receipt_count
       FROM characters WHERE id = $1`,
      [PLAYER_ID, BUY_ITEM_ID, buyOperationId],
    );
    expect(afterBuy.rows[0]).toEqual({
      coins: 90,
      item_quantity: "1",
      receipt_count: "1",
    });

    const sellOperationId = "63f108fd-ae50-46f6-84e0-b558c87fd492";
    const sellRequest = {
      storeId: STORE_ID,
      itemId: SELL_ITEM_ID,
      quantity: 1,
      operationId: sellOperationId,
    };
    await waitForRateLimit();
    await expect(
      handleStoreSell(socket as never, sellRequest, world as never),
    ).resolves.toEqual({
      status: "committed",
      operationId: sellOperationId,
      replayed: false,
    });
    await waitForRateLimit();
    await expect(
      handleStoreSell(socket as never, sellRequest, world as never),
    ).resolves.toEqual({
      status: "committed",
      operationId: sellOperationId,
      replayed: true,
    });

    const afterSell = await pool.query<{
      coins: number;
      item_quantity: string;
      receipt_count: string;
    }>(
      `SELECT coins,
         (SELECT COALESCE(sum(quantity), 0)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $2) AS item_quantity,
         (SELECT count(*)::text FROM agent_store_operations
          WHERE operation_id = $3) AS receipt_count
       FROM characters WHERE id = $1`,
      [PLAYER_ID, SELL_ITEM_ID, sellOperationId],
    );
    expect(afterSell.rows[0]).toEqual({
      coins: 95,
      item_quantity: "1",
      receipt_count: "1",
    });

    await expect(
      pool.query(
        `UPDATE agent_store_operations SET total_value = 0
         WHERE operation_id = $1`,
        [buyOperationId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`DELETE FROM agent_store_operations WHERE operation_id = $1`, [
        sellOperationId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it("returns only a narrow insufficient-coin reason without committing custody", async () => {
    const operationId = "96526f4a-709d-4560-9cc6-f55892309a1d";
    await pool.query(`UPDATE characters SET coins = 0 WHERE id = $1`, [
      PLAYER_ID,
    ]);
    await waitForRateLimit();

    await expect(
      handleStoreBuy(
        socket as never,
        {
          storeId: STORE_ID,
          itemId: BUY_ITEM_ID,
          quantity: 1,
          operationId,
        },
        world as never,
      ),
    ).resolves.toEqual({
      status: "rejected",
      operationId,
      replayed: false,
      reason: "insufficient_coins",
    });

    const state = await pool.query<{
      coins: number;
      receipt_count: string;
    }>(
      `SELECT coins,
         (SELECT count(*)::text FROM agent_store_operations
          WHERE operation_id = $2) AS receipt_count
       FROM characters WHERE id = $1`,
      [PLAYER_ID, operationId],
    );
    expect(state.rows[0]).toEqual({ coins: 0, receipt_count: "0" });
  });
});
