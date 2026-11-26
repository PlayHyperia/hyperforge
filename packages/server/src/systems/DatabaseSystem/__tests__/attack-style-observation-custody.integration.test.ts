import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  ITEMS,
  type StreamingDuelStyleObservationContext,
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
import weaponsManifest from "../../../../world/assets/manifests/items/weapons.json";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;

function fingerprint(
  playerId: string,
  requestedStyle: string,
  publicActionObservation?: StreamingDuelStyleObservationContext,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        requestedStyle,
        ...(publicActionObservation ? { publicActionObservation } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

describeDatabase("attack-style custody and atomic public observation", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  const playerId = "style-observation-agent";
  let previousShortbow: unknown;

  beforeAll(async () => {
    previousShortbow = ITEMS.get("shortbow");
    const shortbow = weaponsManifest.find((item) => item.id === "shortbow");
    if (!shortbow) throw new Error("shortbow fixture missing");
    ITEMS.set("shortbow", shortbow as never);
    databaseName = `hyperia_style_${process.pid}_${Date.now().toString(36)}`;
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
      id: "style-observation-account",
      name: "Style Observation Account",
      roles: "user",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    await db.insert(schema.characters).values({
      id: playerId,
      accountId: "style-observation-account",
      name: "Style Observation Agent",
      isAgent: 1,
      attackStyle: "accurate",
    });
    await db.insert(schema.equipment).values({
      playerId,
      slotType: "weapon",
      itemId: "shortbow",
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
    if (previousShortbow) ITEMS.set("shortbow", previousShortbow as never);
    else ITEMS.delete("shortbow");
  }, 30_000);

  it("co-commits, recovers, and fail-closes one exact accepted style", async () => {
    const observation = {
      operationId: randomUUID(),
      tick: 9,
      observedAt: 1_800_000_000_309,
      cycleId: "cycle-style-atomic",
      duelId: "duel-style-atomic",
      actorId: playerId,
      opponentId: "style-observation-opponent",
      phase: "FIGHTING",
      combatRole: "ranged",
      tacticalMacro: "kite",
      style: "rapid",
    } satisfies StreamingDuelStyleObservationContext;
    const request = {
      operationId: observation.operationId,
      playerId,
      requestedStyle: "rapid",
      publicActionObservation: observation,
      requestFingerprint: fingerprint(playerId, "rapid", observation),
    };

    await expect(
      databaseSystem.commitAttackStyleOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: false,
      operationCommittedStyle: "rapid",
      currentStyle: "rapid",
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT "attackStyle" FROM characters WHERE id = $1) AS style,
           (SELECT count(*)::int FROM operations_log WHERE id = $2 AND completed = true) AS receipt_rows,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $2) AS observation_rows`,
        [playerId, request.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ style: "rapid", receipt_rows: 1, observation_rows: 1 }],
    });

    const replacementDatabase = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await replacementDatabase.init();
    await expect(
      replacementDatabase.commitAttackStyleOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: true,
      operationCommittedStyle: "rapid",
      currentStyle: "rapid",
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
        action: "style",
        outcome: "accepted",
        value: "rapid",
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
      action: "style",
      outcome: "accepted",
      value: observation.style,
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

    const invalidOperationId = randomUUID();
    const invalidRequest = {
      operationId: invalidOperationId,
      playerId,
      requestedStyle: "aggressive",
      requestFingerprint: fingerprint(playerId, "aggressive"),
    };
    await expect(
      databaseSystem.commitAttackStyleOperationAsync(invalidRequest),
    ).rejects.toThrow("attack_style_weapon_rejected");
    await expect(
      pool.query(
        `SELECT
           (SELECT "attackStyle" FROM characters WHERE id = $1) AS style,
           (SELECT count(*)::int FROM operations_log WHERE id = $2) AS receipt_rows`,
        [playerId, invalidOperationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ style: "rapid", receipt_rows: 0 }],
    });

    const newerObservation = {
      ...observation,
      operationId: randomUUID(),
      tick: 10,
      observedAt: observation.observedAt + 1,
      tacticalMacro: "defensive_reset",
      style: "longrange",
    } satisfies StreamingDuelStyleObservationContext;
    const newerRequest = {
      operationId: newerObservation.operationId,
      playerId,
      requestedStyle: "longrange",
      publicActionObservation: newerObservation,
      requestFingerprint: fingerprint(playerId, "longrange", newerObservation),
    };
    await expect(
      databaseSystem.commitAttackStyleOperationAsync(newerRequest),
    ).resolves.toMatchObject({ currentStyle: "longrange" });
    await expect(
      pool.query(
        `SELECT action,
                observation->>'outcome' AS outcome,
                observation->>'value' AS value
           FROM streaming_duel_action_observations
          WHERE "operationId" = $1`,
        [newerObservation.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ action: "style", outcome: "accepted", value: "longrange" }],
    });
    await expect(
      databaseSystem.commitAttackStyleOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: true,
      operationCommittedStyle: "rapid",
      currentStyle: "longrange",
    });
    await expect(
      pool.query(
        `SELECT "attackStyle" AS style FROM characters WHERE id = $1`,
        [playerId],
      ),
    ).resolves.toMatchObject({ rows: [{ style: "longrange" }] });

    const missingObservation = {
      ...observation,
      operationId: randomUUID(),
      tick: 11,
      observedAt: observation.observedAt + 2,
    } satisfies StreamingDuelStyleObservationContext;
    const missingRequest = {
      operationId: missingObservation.operationId,
      playerId,
      requestedStyle: "rapid",
      publicActionObservation: missingObservation,
      requestFingerprint: fingerprint(playerId, "rapid", missingObservation),
    };
    await pool.query(
      `INSERT INTO operations_log (
         id, "playerId", "operationType", "operationState", completed,
         timestamp, "completedAt"
       ) VALUES ($1, $2, 'attack_style_change', $3::jsonb, true, $4, $4)`,
      [
        missingRequest.operationId,
        playerId,
        JSON.stringify({
          version: 1,
          requestFingerprint: missingRequest.requestFingerprint,
          requestedStyle: "rapid",
          publicActionObservation: missingObservation,
        }),
        Date.now(),
      ],
    );
    await expect(
      databaseSystem.commitAttackStyleOperationAsync(missingRequest),
    ).rejects.toThrow("streaming_duel_public_observation_conflict");
  });
});
