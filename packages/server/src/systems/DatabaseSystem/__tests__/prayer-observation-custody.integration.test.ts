import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  type PrayerPersistenceSnapshot,
  type StreamingDuelPrayerObservationContext,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import { runPrayerReceiptCompaction } from "../../../database/prayer-receipt-compaction.js";
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
  expected: PrayerPersistenceSnapshot,
  committed: PrayerPersistenceSnapshot,
  publicActionObservation?: StreamingDuelPrayerObservationContext,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        transition: "toggle",
        expected,
        committed,
        ...(publicActionObservation ? { publicActionObservation } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

describeDatabase("prayer custody and atomic public observation", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  const playerId = "prayer-observation-agent";

  beforeAll(async () => {
    databaseName = `hyperia_prayer_${process.pid}_${Date.now().toString(36)}`;
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
      id: "prayer-observation-account",
      name: "Prayer Observation Account",
      roles: "user",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    await db.insert(schema.characters).values({
      id: playerId,
      accountId: "prayer-observation-account",
      name: "Prayer Observation Agent",
      isAgent: 1,
      prayerLevel: 40,
      prayerPoints: 40,
      prayerPointUnits: 40_000_000,
      prayerMaxPoints: 40,
      activePrayers: [],
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

  it("co-commits, recovers, and verifies one exact prayer observation", async () => {
    const expected = {
      pointUnits: 40_000_000,
      maxPoints: 40,
      activePrayers: [],
    } satisfies PrayerPersistenceSnapshot;
    const committed = {
      ...expected,
      activePrayers: ["hawk_eye"],
    } satisfies PrayerPersistenceSnapshot;
    const observation = {
      operationId: randomUUID(),
      tick: 5,
      observedAt: 1_800_000_000_105,
      cycleId: "cycle-prayer-atomic",
      duelId: "duel-prayer-atomic",
      actorId: playerId,
      opponentId: "prayer-observation-opponent",
      phase: "FIGHTING",
      combatRole: "ranged",
      tacticalMacro: "kite",
      prayer: "hawk_eye",
    } satisfies StreamingDuelPrayerObservationContext;
    const request = {
      operationId: `prayer:${randomUUID()}`,
      playerId,
      transition: "toggle" as const,
      expected,
      committed,
      publicActionObservation: observation,
      requestFingerprint: fingerprint(
        playerId,
        expected,
        committed,
        observation,
      ),
    };

    await expect(
      databaseSystem.commitPrayerStateOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: false,
      committed: { activePrayers: ["hawk_eye"] },
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT "activePrayers" FROM characters WHERE id = $1) AS prayers,
           (SELECT count(*)::int FROM operations_log WHERE id = $2 AND completed = true) AS receipt_rows,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $3) AS observation_rows`,
        [playerId, request.operationId, observation.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          prayers: ["hawk_eye"],
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
        action: "prayer",
        outcome: "committed",
        value: "hawk_eye",
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
      action: "prayer",
      outcome: "committed",
      value: observation.prayer,
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
      databaseSystem.commitPrayerStateOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: true,
      committed: { activePrayers: ["hawk_eye"] },
    });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count
         FROM streaming_duel_action_observations
         WHERE "operationId" = $1`,
        [observation.operationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const compactionNow = Date.now() + 5_000;
    await expect(
      runPrayerReceiptCompaction(pool, {
        mode: "execute",
        cutoffBeforeMs: compactionNow - 1,
        batchLimit: 10,
        statementTimeoutMs: 2_000,
        retentionApprovalId: "integration-approved-retention",
        nowMs: compactionNow,
        compactionBatchId: "85e01c37-e0bd-4a2a-9af6-760956c02aad",
      }),
    ).resolves.toMatchObject({
      eligibleCount: 1,
      selectedCount: 1,
      compactedCount: 1,
      semanticIdentityRetained: true,
      publicObservationsRetained: true,
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM operations_log WHERE id = $1) AS wal_rows,
           (SELECT count(*)::int FROM compacted_prayer_state_receipts WHERE operation_id = $1) AS compact_rows,
           (SELECT public_observation_operation_id FROM compacted_prayer_state_receipts WHERE operation_id = $1) AS observation_id,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $2) AS observation_rows`,
        [request.operationId, observation.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          wal_rows: 0,
          compact_rows: 1,
          observation_id: observation.operationId,
          observation_rows: 1,
        },
      ],
    });
    await expect(
      databaseSystem.commitPrayerStateOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: true,
      committed: { activePrayers: ["hawk_eye"] },
    });

    const conflictingExpected = committed;
    const conflictingCommitted = expected;
    await expect(
      databaseSystem.commitPrayerStateOperationAsync({
        operationId: request.operationId,
        playerId,
        transition: "toggle",
        expected: conflictingExpected,
        committed: conflictingCommitted,
        requestFingerprint: fingerprint(
          playerId,
          conflictingExpected,
          conflictingCommitted,
        ),
      }),
    ).rejects.toThrow("prayer_state_operation_id_conflict");
    await expect(
      pool.query(
        `INSERT INTO operations_log (
           id, "playerId", "operationType", "operationState", completed,
           timestamp, "completedAt"
         ) VALUES ($1, $2, 'unrelated_operation', '{}'::jsonb, true, $3, $3)`,
        [request.operationId, playerId, Date.now()],
      ),
    ).rejects.toThrow(/compacted prayer receipt/u);
    await expect(
      pool.query(
        `DELETE FROM compacted_prayer_state_receipts WHERE operation_id = $1`,
        [request.operationId],
      ),
    ).rejects.toThrow(/append-only/u);

    const invalidObservation = {
      ...observation,
      operationId: randomUUID(),
      actorId: "wrong-player",
    } satisfies StreamingDuelPrayerObservationContext;
    const invalidRequest = {
      ...request,
      operationId: `prayer:${randomUUID()}`,
      publicActionObservation: invalidObservation,
      requestFingerprint: fingerprint(
        playerId,
        expected,
        committed,
        invalidObservation,
      ),
    };
    await expect(
      databaseSystem.commitPrayerStateOperationAsync(invalidRequest),
    ).rejects.toThrow("prayer_state_request_invalid");
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM operations_log WHERE id = $1`,
        [invalidRequest.operationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    // Model a corrupt/legacy completed receipt whose required observation is
    // absent. The observation table itself is append-only, so the fixture is
    // built directly in the operations log. Replay must expose the invariant
    // violation, never synthesize public history after custody already ended.
    const missingObservation = {
      ...observation,
      operationId: randomUUID(),
      tick: 6,
      observedAt: observation.observedAt + 1,
    } satisfies StreamingDuelPrayerObservationContext;
    const missingRequest = {
      ...request,
      operationId: `prayer:${randomUUID()}`,
      publicActionObservation: missingObservation,
      requestFingerprint: fingerprint(
        playerId,
        expected,
        committed,
        missingObservation,
      ),
    };
    await pool.query(
      `INSERT INTO operations_log (
         id, "playerId", "operationType", "operationState", completed,
         timestamp, "completedAt"
       ) VALUES ($1, $2, 'prayer_state_transition', $3::jsonb, true, $4, $4)`,
      [
        missingRequest.operationId,
        playerId,
        JSON.stringify({
          version: 1,
          requestFingerprint: missingRequest.requestFingerprint,
          transition: missingRequest.transition,
          expected,
          committed,
          publicActionObservation: missingObservation,
        }),
        Date.now(),
      ],
    );
    await expect(
      databaseSystem.commitPrayerStateOperationAsync(missingRequest),
    ).rejects.toThrow("streaming_duel_public_observation_conflict");
  });
});
