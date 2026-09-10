import { randomUUID } from "node:crypto";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import { getDuelPreparationPlanOperationId } from "../../../eliza/duelPreparationPlan.js";
import { DUEL_PREPARATION_BANK_ACTIONS } from "../../StreamingDuelScheduler/preparation.js";
import { DatabaseSystem } from "../index.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;

describeDatabase("duel preparation whole-plan recovery", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  const playerId = "duel-plan-recovery-agent";
  const opponentId = "duel-plan-recovery-opponent";

  beforeAll(async () => {
    databaseName = `hyperia_duel_plan_recovery_${process.pid}_${Date.now().toString(36)}`;
    const adminUrl = new URL(baseDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 2 });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);

    const testUrl = new URL(baseDatabaseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({
      connectionString: testUrl.toString(),
      max: 8,
      connectionTimeoutMillis: 1_000,
      statement_timeout: 3_000,
      query_timeout: 4_000,
    });
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

    const db = drizzle(pool, { schema });
    await db.insert(schema.users).values({
      id: "duel-plan-recovery-account",
      name: "Duel Plan Recovery Account",
      roles: "user",
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    await db.insert(schema.characters).values([
      {
        id: playerId,
        accountId: "duel-plan-recovery-account",
        name: "Duel Plan Recovery Agent",
        isAgent: 1,
        selectedSpell: null,
      },
      {
        id: opponentId,
        accountId: "duel-plan-recovery-account",
        name: "Duel Plan Recovery Opponent",
        isAgent: 1,
        selectedSpell: null,
      },
    ]);
    databaseSystem = new DatabaseSystem({
      drizzleDb: db,
      pgPool: pool,
    } as never);
    await databaseSystem.init();
  }, 30_000);

  afterAll(async () => {
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

  it("repairs only custody-conserving projection drift from the immutable receipt", async () => {
    const preparationId = randomUUID();
    const operationId = getDuelPreparationPlanOperationId(
      preparationId,
      playerId,
    );
    const committed = {
      bank: [],
      inventory: [
        {
          itemId: "bronze_shortsword",
          quantity: 1,
          slotIndex: 0,
          metadata: null,
        },
      ],
      equipment: [
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 90 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ],
      selectedSpell: null,
    };
    const now = Date.now();
    const selectedAt = now - 120_000;
    const expiresAt = now - 1;
    const frozenAt = now - 30_000;
    const db = drizzle(pool, { schema });
    await db.insert(schema.streamingDuelPreparations).values({
      preparationId,
      fencingToken: 1n,
      agent1Id: playerId,
      agent2Id: opponentId,
      allowedBankActions: [...DUEL_PREPARATION_BANK_ACTIONS],
      status: "frozen",
      selectedAt,
      expiresAt,
      agent1ReadyAt: frozenAt,
      agent2ReadyAt: frozenAt,
      frozenAt,
    });
    await db.insert(schema.streamingDuelCompetitiveSnapshots).values({
      preparationId,
      snapshotVersion: 5,
      cycleId: `cycle-${preparationId}`,
      duelId: `duel-${preparationId}`,
      duelKey: "ab".repeat(32),
      snapshotDigest: "cd".repeat(32),
      snapshot: {
        preparationId,
        betCloseTime: now + 60_000,
      },
      frozenAt,
      lifecycleStatus: "frozen",
    });
    await db.insert(schema.inventory).values({
      playerId,
      itemId: "shortbow",
      quantity: 1,
      slotIndex: 0,
    });
    await db.insert(schema.equipment).values([
      {
        playerId,
        slotType: "arrows",
        itemId: "bronze_arrow",
        quantity: 90,
      },
      {
        playerId,
        slotType: "weapon",
        itemId: "bronze_shortsword",
        quantity: 1,
      },
    ]);
    await db.insert(schema.operationsLog).values({
      id: operationId,
      playerId,
      operationType: "duel_preparation_plan",
      operationState: {
        version: 2,
        preparationId,
        requestFingerprint: "immutable-plan-receipt",
        committed,
        recoveryEvidence: { planningSource: "deterministic" },
      },
      completed: true,
      timestamp: now,
      completedAt: now,
    });

    await expect(
      databaseSystem.getDuelPreparationPlanOperationAsync({
        operationId,
        preparationId,
        playerId,
      }),
    ).resolves.toMatchObject({ replayed: true, committed });
    await expect(
      pool.query(
        `SELECT
           (SELECT array_agg("itemId" ORDER BY "slotIndex") FROM inventory WHERE "playerId" = $1) AS inventory,
           (SELECT array_agg("itemId" ORDER BY "slotType") FROM equipment WHERE "playerId" = $1) AS equipment`,
        [playerId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          inventory: ["bronze_shortsword"],
          equipment: ["bronze_arrow", "shortbow"],
        },
      ],
    });

    await pool.query(
      `DELETE FROM inventory WHERE "playerId" = $1 AND "itemId" = 'bronze_shortsword'`,
      [playerId],
    );
    await expect(
      databaseSystem.getDuelPreparationPlanOperationAsync({
        operationId,
        preparationId,
        playerId,
      }),
    ).rejects.toThrow("duel_preparation_plan_recovery_custody_violation");
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM inventory WHERE "playerId" = $1 AND "itemId" = 'bronze_shortsword'`,
        [playerId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
