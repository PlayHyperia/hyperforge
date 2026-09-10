import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  ITEMS,
  type StreamingDuelFoodObservationContext,
} from "@hyperforge/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import { DatabaseSystem } from "../index.js";
import {
  PostgresStreamingDuelActionObservationStore,
  StreamingDuelActionObservationLedger,
  type StreamingDuelActionObservationPool,
} from "../../StreamingDuelScheduler/public-action-observation-ledger.js";
import type { StreamingDuelActionObservationDraft } from "../../StreamingDuelScheduler/public-action-observation-buffer.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;

function fingerprint(
  playerId: string,
  itemId: string,
  healAmount: number,
  publicActionObservation?: StreamingDuelFoodObservationContext,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        itemId,
        healAmount,
        ...(publicActionObservation ? { publicActionObservation } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

describeDatabase("food consumption custody and restart recovery", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  const playerId = "food-custody-agent";
  const priorLobster = ITEMS.get("lobster");

  beforeAll(async () => {
    ITEMS.set("lobster", {
      id: "lobster",
      name: "Lobster",
      type: "food",
      value: 120,
      stackable: false,
      healAmount: 12,
    } as never);
    databaseName = `hyperia_food_${process.pid}_${Date.now().toString(36)}`;
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
      statement_timeout: 2_000,
      query_timeout: 3_000,
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
      id: "food-custody-account",
      name: "Food Custody Account",
      roles: "user",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    await db.insert(schema.characters).values({
      id: playerId,
      accountId: "food-custody-account",
      name: "Food Custody Agent",
      isAgent: 1,
      health: 30,
      maxHealth: 60,
      constitutionLevel: 60,
    });
    await db.insert(schema.inventory).values([
      { playerId, itemId: "lobster", quantity: 1, slotIndex: 4 },
      { playerId, itemId: "lobster", quantity: 1, slotIndex: 5 },
    ]);
    databaseSystem = new DatabaseSystem({
      drizzleDb: db,
      pgPool: pool,
    } as never);
    await databaseSystem.init();
  }, 30_000);

  afterAll(async () => {
    if (priorLobster) ITEMS.set("lobster", priorLobster);
    else ITEMS.delete("lobster");
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

  it("preserves pending damage, replays once, and recovers a killed process before hydration", async () => {
    const firstOperationId = `food:${randomUUID()}`;
    const firstPublicObservation = {
      operationId: randomUUID(),
      tick: 4,
      observedAt: 1_800_000_000_004,
      cycleId: "cycle-food-atomic",
      duelId: "duel-food-atomic",
      actorId: playerId,
      opponentId: "food-custody-opponent",
      phase: "FIGHTING",
      combatRole: "ranged",
      tacticalMacro: "kite",
    } satisfies StreamingDuelFoodObservationContext;
    const first = {
      operationId: firstOperationId,
      playerId,
      itemId: "lobster",
      healAmount: 12,
      requestFingerprint: fingerprint(
        playerId,
        "lobster",
        12,
        firstPublicObservation,
      ),
      publicActionObservation: firstPublicObservation,
    };
    await expect(
      databaseSystem.commitFoodConsumptionOperationAsync(first),
    ).resolves.toMatchObject({
      replayed: false,
      status: "pending",
      committed: [{ itemId: "lobster", quantity: 1, slotIndex: 5 }],
    });
    await expect(
      pool.query(
        `SELECT c.health, o.completed
         FROM characters c JOIN operations_log o ON o."playerId" = c.id
         WHERE c.id = $1 AND o.id = $2`,
        [playerId, firstOperationId],
      ),
    ).resolves.toMatchObject({ rows: [{ health: 30, completed: false }] });

    // This damage snapshot is invoked while the food effect is pending. The
    // completion API flushes it ahead of the ordered +12 transition.
    databaseSystem.savePlayer(playerId, { health: 20, maxHealth: 60 });
    await expect(
      databaseSystem.completeFoodConsumptionOperationAsync(first),
    ).resolves.toMatchObject({
      replayed: false,
      status: "completed",
      healedAmount: 12,
      healthAfter: 32,
    });
    await expect(
      pool.query(`SELECT health FROM characters WHERE id = $1`, [playerId]),
    ).resolves.toMatchObject({ rows: [{ health: 32 }] });

    // Model a process death after the authority transaction committed but
    // before the controller could publish. A replacement ledger must hydrate
    // the exact observation, and its delayed callback must remain idempotent.
    const observationStore = new PostgresStreamingDuelActionObservationStore(
      pool as unknown as StreamingDuelActionObservationPool,
    );
    const replacementLedger = new StreamingDuelActionObservationLedger(
      observationStore,
      { retryDelay: async () => {} },
    );
    replacementLedger.activateCycle(firstPublicObservation.cycleId);
    await replacementLedger.waitForIdle();
    expect(
      replacementLedger.getSnapshot(firstPublicObservation.cycleId),
    ).toEqual([
      expect.objectContaining({
        sequence: 1,
        action: "food",
        outcome: "committed",
        amount: 12,
        actorId: playerId,
      }),
    ]);
    const firstDraft = {
      tick: firstPublicObservation.tick,
      cycleId: firstPublicObservation.cycleId,
      duelId: firstPublicObservation.duelId,
      actorId: firstPublicObservation.actorId,
      opponentId: firstPublicObservation.opponentId,
      phase: firstPublicObservation.phase,
      combatRole: firstPublicObservation.combatRole,
      tacticalMacro: firstPublicObservation.tacticalMacro,
      action: "food",
      outcome: "committed",
      value: "consume",
      amount: 12,
    } satisfies StreamingDuelActionObservationDraft;
    expect(
      replacementLedger.record(firstDraft, {
        operationId: firstPublicObservation.operationId,
        observedAt: firstPublicObservation.observedAt,
      }),
    ).toBe(true);
    await replacementLedger.waitForIdle();
    expect(
      replacementLedger.getSnapshot(firstPublicObservation.cycleId),
    ).toHaveLength(1);

    await expect(
      databaseSystem.commitFoodConsumptionOperationAsync(first),
    ).resolves.toMatchObject({ replayed: true, status: "completed" });
    await expect(
      databaseSystem.completeFoodConsumptionOperationAsync(first),
    ).resolves.toMatchObject({
      replayed: true,
      healedAmount: 12,
      healthAfter: 32,
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT health FROM characters WHERE id = $1) AS health,
           (SELECT count(*)::int FROM inventory WHERE "playerId" = $1) AS inventory_rows,
           (SELECT count(*)::int FROM operations_log WHERE id = $2) AS receipt_rows`,
        [playerId, firstOperationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ health: 32, inventory_rows: 1, receipt_rows: 1 }],
    });

    await pool.query(`UPDATE characters SET health = 25 WHERE id = $1`, [
      playerId,
    ]);
    const interruptedPublicObservation = {
      ...firstPublicObservation,
      operationId: randomUUID(),
      tick: 7,
      observedAt: 1_800_000_000_007,
    } satisfies StreamingDuelFoodObservationContext;
    const interruptedOperation = {
      playerId,
      itemId: "lobster",
      healAmount: 12,
      operationId: `food:${randomUUID()}`,
      requestFingerprint: fingerprint(
        playerId,
        "lobster",
        12,
        interruptedPublicObservation,
      ),
      publicActionObservation: interruptedPublicObservation,
    };
    await expect(
      databaseSystem.commitFoodConsumptionOperationAsync(interruptedOperation),
    ).resolves.toMatchObject({ status: "pending", replayed: false });

    // A fresh DatabaseSystem over the same store models process replacement.
    // Recovery completes the pending +12 before PlayerSystem may load health.
    const db = drizzle(pool, { schema });
    const replacement = new DatabaseSystem({
      drizzleDb: db,
      pgPool: pool,
    } as never);
    await replacement.init();
    await expect(
      replacement.recoverPendingFoodConsumptionOperationsAsync(playerId),
    ).resolves.toEqual([
      expect.objectContaining({
        operationId: interruptedOperation.operationId,
        status: "completed",
        healedAmount: 12,
        healthAfter: 37,
      }),
    ]);
    await expect(
      replacement.recoverPendingFoodConsumptionOperationsAsync(playerId),
    ).resolves.toEqual([]);
    await expect(
      pool.query(
        `SELECT
           (SELECT health FROM characters WHERE id = $1) AS health,
           (SELECT count(*)::int FROM inventory WHERE "playerId" = $1) AS inventory_rows,
           (SELECT count(*)::int FROM operations_log WHERE "playerId" = $1 AND "operationType" = 'food_consumption') AS receipt_rows,
           (SELECT count(*)::int FROM operations_log WHERE "playerId" = $1 AND "operationType" = 'food_consumption' AND completed = false) AS pending_rows,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "cycleId" = 'cycle-food-atomic') AS observation_rows`,
        [playerId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          health: 37,
          inventory_rows: 0,
          receipt_rows: 2,
          pending_rows: 0,
          observation_rows: 2,
        },
      ],
    });

    // Database admission is independently fail-closed at full health and does
    // not spend the item or create an operation receipt.
    await pool.query(`UPDATE characters SET health = 60 WHERE id = $1`, [
      playerId,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'lobster', 1, 4)`,
      [playerId],
    );
    const rejectedAtFull = {
      operationId: `food:${randomUUID()}`,
      playerId,
      itemId: "lobster",
      healAmount: 12,
      requestFingerprint: fingerprint(playerId, "lobster", 12),
    };
    await expect(
      replacement.commitFoodConsumptionOperationAsync(rejectedAtFull),
    ).rejects.toThrow("food_consumption_full_health");
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM inventory WHERE "playerId" = $1) AS inventory_rows,
           (SELECT count(*)::int FROM operations_log WHERE id = $2) AS receipt_rows`,
        [playerId, rejectedAtFull.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ inventory_rows: 1, receipt_rows: 0 }],
    });

    // If lethal damage becomes durable after staging, completion consumes the
    // already-spent item but marks a terminal zero-heal effect exactly once.
    await pool.query(`UPDATE characters SET health = 10 WHERE id = $1`, [
      playerId,
    ]);
    const lethalPublicObservation = {
      ...firstPublicObservation,
      operationId: randomUUID(),
      tick: 9,
      observedAt: 1_800_000_000_009,
    } satisfies StreamingDuelFoodObservationContext;
    const lethalOperation = {
      operationId: `food:${randomUUID()}`,
      playerId,
      itemId: "lobster",
      healAmount: 12,
      requestFingerprint: fingerprint(
        playerId,
        "lobster",
        12,
        lethalPublicObservation,
      ),
      publicActionObservation: lethalPublicObservation,
    };
    await expect(
      replacement.commitFoodConsumptionOperationAsync(lethalOperation),
    ).resolves.toMatchObject({ status: "pending" });
    replacement.savePlayer(playerId, { health: 0, maxHealth: 60 });
    await expect(
      replacement.completeFoodConsumptionOperationAsync(lethalOperation),
    ).resolves.toMatchObject({
      status: "completed",
      healedAmount: 0,
      healthAfter: 0,
      completionReason: "player_not_alive",
    });
    await expect(
      replacement.completeFoodConsumptionOperationAsync(lethalOperation),
    ).resolves.toMatchObject({
      replayed: true,
      healedAmount: 0,
      healthAfter: 0,
      completionReason: "player_not_alive",
    });
    await expect(
      pool.query(
        `SELECT sequence, observation
         FROM streaming_duel_action_observations
         WHERE "operationId" = $1`,
        [lethalPublicObservation.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          sequence: 3,
          observation: expect.objectContaining({
            action: "food",
            outcome: "committed",
            amount: 0,
          }),
        },
      ],
    });
  });
});
