import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  type CombatLoadoutPersistenceSnapshot,
  type StreamingDuelRoleSwitchObservationContext,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import {
  PostgresStreamingDuelActionObservationStore,
  StreamingDuelActionObservationLedger,
  type StreamingDuelActionObservationPool,
} from "../../StreamingDuelScheduler/public-action-observation-ledger.js";
import type { StreamingDuelActionObservationDraft } from "../../StreamingDuelScheduler/public-action-observation-buffer.js";
import { DatabaseSystem } from "../index.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;

function fingerprint(
  playerId: string,
  targetRole: string,
  observation: StreamingDuelRoleSwitchObservationContext,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        cycleId: observation.cycleId,
        playerId,
        frozenFingerprint: "integration-frozen-loadout",
        targetRole,
        loadout: {
          role: targetRole,
          weaponId: "shortbow",
          arrowsId: "bronze_arrow",
          shieldId: null,
          spellId: null,
        },
        publicActionObservation: observation,
      }),
      "utf8",
    )
    .digest("hex");
}

describeDatabase("combat loadout custody and atomic public observation", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  const playerId = "loadout-observation-agent";

  beforeAll(async () => {
    databaseName = `hyperia_loadout_${process.pid}_${Date.now().toString(36)}`;
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
      id: "loadout-observation-account",
      name: "Loadout Observation Account",
      roles: "user",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    await db.insert(schema.characters).values({
      id: playerId,
      accountId: "loadout-observation-account",
      name: "Loadout Observation Agent",
      isAgent: 1,
      selectedSpell: null,
    });
    await db.insert(schema.inventory).values([
      { playerId, itemId: "shortbow", quantity: 1, slotIndex: 0 },
      { playerId, itemId: "bronze_arrow", quantity: 50, slotIndex: 1 },
    ]);
    await db.insert(schema.equipment).values({
      playerId,
      slotType: "weapon",
      itemId: "bronze_longsword",
      quantity: 1,
    });
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

  it("co-commits, recovers, and verifies one exact frozen-role observation", async () => {
    const expected = {
      inventory: [
        {
          itemId: "shortbow",
          quantity: 1,
          slotIndex: 0,
          metadata: null,
        },
        {
          itemId: "bronze_arrow",
          quantity: 50,
          slotIndex: 1,
          metadata: null,
        },
      ],
      equipment: [
        {
          slotType: "weapon",
          itemId: "bronze_longsword",
          quantity: 1,
        },
      ],
      selectedSpell: null,
    } satisfies CombatLoadoutPersistenceSnapshot;
    const committed = {
      inventory: [
        {
          itemId: "bronze_longsword",
          quantity: 1,
          slotIndex: 0,
          metadata: null,
        },
      ],
      equipment: [
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
      ],
      selectedSpell: null,
    } satisfies CombatLoadoutPersistenceSnapshot;
    const observation = {
      operationId: randomUUID(),
      tick: 8,
      observedAt: 1_800_000_000_208,
      cycleId: "cycle-loadout-atomic",
      duelId: "duel-loadout-atomic",
      actorId: playerId,
      opponentId: "loadout-observation-opponent",
      phase: "FIGHTING",
      combatRole: "melee",
      tacticalMacro: "pressure",
      targetRole: "ranged",
    } satisfies StreamingDuelRoleSwitchObservationContext;
    const request = {
      operationId: `combat-loadout:${observation.cycleId}:${playerId}:1`,
      playerId,
      expected,
      committed,
      publicActionObservation: observation,
      requestFingerprint: fingerprint(playerId, "ranged", observation),
    };

    await expect(
      databaseSystem.commitCombatLoadoutOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: false,
      committed: {
        inventory: [{ itemId: "bronze_longsword", quantity: 1 }],
        equipment: expect.arrayContaining([
          { slotType: "weapon", itemId: "shortbow", quantity: 1 },
          { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
        ]),
      },
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT array_agg("itemId" ORDER BY "slotIndex") FROM inventory WHERE "playerId" = $1) AS inventory,
           (SELECT array_agg("itemId" ORDER BY "slotType") FROM equipment WHERE "playerId" = $1) AS equipment,
           (SELECT count(*)::int FROM operations_log WHERE id = $2 AND completed = true) AS receipt_rows,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $3) AS observation_rows`,
        [playerId, request.operationId, observation.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          inventory: ["bronze_longsword"],
          equipment: ["bronze_arrow", "shortbow"],
          receipt_rows: 1,
          observation_rows: 1,
        },
      ],
    });

    const store = new PostgresStreamingDuelActionObservationStore(
      pool as unknown as StreamingDuelActionObservationPool,
    );
    const replacementLedger = new StreamingDuelActionObservationLedger(store, {
      retryDelay: async () => {},
    });
    replacementLedger.activateCycle(observation.cycleId);
    await replacementLedger.waitForIdle();
    expect(replacementLedger.getSnapshot(observation.cycleId)).toEqual([
      expect.objectContaining({
        sequence: 1,
        action: "role_switch",
        outcome: "committed",
        value: "ranged",
        actorId: playerId,
      }),
    ]);

    const delayedDraft = {
      tick: observation.tick,
      cycleId: observation.cycleId,
      duelId: observation.duelId,
      actorId: observation.actorId,
      opponentId: observation.opponentId,
      phase: observation.phase,
      combatRole: observation.combatRole,
      tacticalMacro: observation.tacticalMacro,
      action: "role_switch",
      outcome: "committed",
      value: observation.targetRole,
      amount: null,
    } satisfies StreamingDuelActionObservationDraft;
    expect(
      replacementLedger.record(delayedDraft, {
        operationId: observation.operationId,
        observedAt: observation.observedAt,
      }),
    ).toBe(true);
    await replacementLedger.waitForIdle();
    expect(replacementLedger.getSnapshot(observation.cycleId)).toHaveLength(1);
    expect(replacementLedger.getHealth()).toMatchObject({
      pending: 0,
      persistenceErrors: 0,
      lastError: null,
    });

    await expect(
      databaseSystem.commitCombatLoadoutOperationAsync(request),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM streaming_duel_action_observations WHERE "operationId" = $1`,
        [observation.operationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const invalidObservation = {
      ...observation,
      operationId: randomUUID(),
      actorId: "wrong-player",
    } satisfies StreamingDuelRoleSwitchObservationContext;
    const invalidRequest = {
      ...request,
      operationId: `${request.operationId}:invalid`,
      publicActionObservation: invalidObservation,
      requestFingerprint: fingerprint(playerId, "ranged", invalidObservation),
    };
    await expect(
      databaseSystem.commitCombatLoadoutOperationAsync(invalidRequest),
    ).rejects.toThrow("combat_loadout_request_invalid");
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM operations_log WHERE id = $1`,
        [invalidRequest.operationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const missingObservation = {
      ...observation,
      operationId: randomUUID(),
      tick: 9,
      observedAt: observation.observedAt + 1,
    } satisfies StreamingDuelRoleSwitchObservationContext;
    const missingRequest = {
      ...request,
      operationId: `${request.operationId}:missing`,
      publicActionObservation: missingObservation,
      requestFingerprint: fingerprint(playerId, "ranged", missingObservation),
    };
    await pool.query(
      `INSERT INTO operations_log (
         id, "playerId", "operationType", "operationState", completed,
         timestamp, "completedAt"
       ) VALUES ($1, $2, 'combat_loadout_switch', $3::jsonb, true, $4, $4)`,
      [
        missingRequest.operationId,
        playerId,
        JSON.stringify({
          version: 1,
          requestFingerprint: missingRequest.requestFingerprint,
          committed,
          publicActionObservation: missingObservation,
        }),
        Date.now(),
      ],
    );
    await expect(
      databaseSystem.commitCombatLoadoutOperationAsync(missingRequest),
    ).rejects.toThrow("streaming_duel_public_observation_conflict");
  });
});
