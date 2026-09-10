import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { prayerStateFingerprint } from "../src/database/prayer-operation-receipt";
import { runPrayerReceiptCompaction } from "../src/database/prayer-receipt-compaction";
import * as schema from "../src/database/schema";
import { DatabaseSystem } from "../src/systems/DatabaseSystem";

const { Pool } = pg;

const playerId = "prayer-compaction-integration-player";
const drainOperationId = "prayer:receipt-compaction-drain";
const toggleOperationId = "prayer:receipt-compaction-toggle";
const observationOperationId = "749ead4d-e660-44b9-9687-e46ce6c13eb3";
const compactionBatchId = "65d07357-8685-4306-b2cb-2a2f06619c28";

async function applyMigration(pool: pg.Pool): Promise<void> {
  const migration = await readFile(
    new URL(
      "../src/database/migrations/0094_add_compacted_prayer_state_receipts.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const statement of migration.split(
    /\s*-->\s*statement-breakpoint\s*/u,
  )) {
    if (statement.trim()) await pool.query(statement);
  }
}

async function assertRejectedSqlState(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === expectedCode
    );
  });
}

async function run(): Promise<void> {
  const connectionString = process.env.PRAYER_RECEIPT_TEST_DATABASE_URL?.trim();
  assert(connectionString, "PRAYER_RECEIPT_TEST_DATABASE_URL is required");
  const pool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
  });
  try {
    await pool.query(`
      CREATE TABLE characters (
        id text PRIMARY KEY NOT NULL,
        "prayerPoints" integer,
        "prayerPointUnits" integer,
        "prayerMaxPoints" integer,
        "activePrayers" jsonb
      );
      CREATE TABLE operations_log (
        id text PRIMARY KEY NOT NULL,
        "playerId" text NOT NULL,
        "operationType" text NOT NULL,
        "operationState" jsonb NOT NULL,
        completed boolean DEFAULT false,
        timestamp bigint NOT NULL,
        "completedAt" bigint
      );
      CREATE TABLE streaming_duel_action_observations (
        "operationId" text PRIMARY KEY NOT NULL,
        observation jsonb NOT NULL
      );
    `);
    await applyMigration(pool);

    const drainExpected = {
      pointUnits: 20_000_000,
      maxPoints: 20,
      activePrayers: ["hawk_eye"],
    };
    const drainCommitted = {
      ...drainExpected,
      pointUnits: 19_900_000,
    };
    const drainState = {
      version: 1,
      requestFingerprint: prayerStateFingerprint(
        playerId,
        "drain",
        drainExpected,
        drainCommitted,
      ),
      transition: "drain",
      expected: drainExpected,
      committed: drainCommitted,
    };

    const toggleExpected = {
      pointUnits: 20_000_000,
      maxPoints: 20,
      activePrayers: [] as string[],
    };
    const toggleCommitted = {
      ...toggleExpected,
      activePrayers: ["hawk_eye"],
    };
    const publicContext = {
      operationId: observationOperationId,
      tick: 20,
      observedAt: 2_000,
      cycleId: "cycle-prayer-receipt-compaction",
      duelId: "duel-prayer-receipt-compaction",
      actorId: playerId,
      opponentId: "prayer-compaction-opponent",
      phase: "FIGHTING" as const,
      combatRole: "ranged" as const,
      tacticalMacro: "kite" as const,
      prayer: "hawk_eye" as const,
    };
    const toggleState = {
      version: 1,
      requestFingerprint: prayerStateFingerprint(
        playerId,
        "toggle",
        toggleExpected,
        toggleCommitted,
        publicContext,
      ),
      transition: "toggle",
      expected: toggleExpected,
      committed: toggleCommitted,
      publicActionObservation: publicContext,
    };
    const publicObservation = {
      schemaVersion: 1,
      sequence: 1,
      tick: publicContext.tick,
      observedAt: publicContext.observedAt,
      cycleId: publicContext.cycleId,
      duelId: publicContext.duelId,
      actorId: publicContext.actorId,
      opponentId: publicContext.opponentId,
      phase: publicContext.phase,
      combatRole: publicContext.combatRole,
      tacticalMacro: publicContext.tacticalMacro,
      action: "prayer",
      outcome: "committed",
      value: publicContext.prayer,
      amount: null,
    };

    await pool.query(
      `INSERT INTO operations_log (
         id, "playerId", "operationType", "operationState", completed,
         timestamp, "completedAt"
       ) VALUES
         ($1, $2, 'prayer_state_transition', $3::jsonb, true, 1000, 1000),
         ($4, $2, 'prayer_state_transition', $5::jsonb, true, 2000, 2000)`,
      [
        drainOperationId,
        playerId,
        JSON.stringify(drainState),
        toggleOperationId,
        JSON.stringify(toggleState),
      ],
    );
    await pool.query(
      `INSERT INTO streaming_duel_action_observations (
         "operationId", observation
       ) VALUES ($1, $2::jsonb)`,
      [observationOperationId, JSON.stringify(publicObservation)],
    );
    await pool.query(
      `INSERT INTO characters (
         id, "prayerPoints", "prayerPointUnits", "prayerMaxPoints",
         "activePrayers"
       ) VALUES ($1, 20, 19900000, 20, '["hawk_eye"]'::jsonb)`,
      [playerId],
    );

    const audit = await runPrayerReceiptCompaction(pool, {
      mode: "audit",
      cutoffBeforeMs: 3_000,
      batchLimit: 10,
      statementTimeoutMs: 2_000,
      nowMs: 4_000,
      compactionBatchId,
    });
    assert.equal(audit.eligibleCount, 2);
    assert.equal(audit.selectedCount, 2);
    assert.equal(audit.compactedCount, 0);

    const executed = await runPrayerReceiptCompaction(pool, {
      mode: "execute",
      cutoffBeforeMs: 3_000,
      batchLimit: 10,
      statementTimeoutMs: 2_000,
      retentionApprovalId: "integration-approved-retention",
      nowMs: 4_000,
      compactionBatchId,
    });
    assert.equal(executed.compactedCount, 2);
    const retained = await pool.query<{
      wal_count: number;
      compact_count: number;
      observation_count: number;
      public_observation_operation_id: string | null;
    }>(`SELECT
      (SELECT count(*)::int FROM operations_log) AS wal_count,
      (SELECT count(*)::int FROM compacted_prayer_state_receipts) AS compact_count,
      (SELECT count(*)::int FROM streaming_duel_action_observations) AS observation_count,
      (SELECT public_observation_operation_id
         FROM compacted_prayer_state_receipts
        WHERE operation_id = '${toggleOperationId}') AS public_observation_operation_id`);
    assert.deepEqual(retained.rows[0], {
      wal_count: 0,
      compact_count: 2,
      observation_count: 1,
      public_observation_operation_id: observationOperationId,
    });

    const databaseSystem = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await databaseSystem.init();
    const compactReplay = await databaseSystem.commitPrayerStateOperationAsync({
      operationId: toggleOperationId,
      playerId,
      requestFingerprint: toggleState.requestFingerprint,
      transition: "toggle",
      expected: toggleExpected,
      committed: toggleCommitted,
      publicActionObservation: publicContext,
    });
    assert.equal(compactReplay.replayed, true);
    assert.deepEqual(compactReplay.committed, {
      pointUnits: 19_900_000,
      maxPoints: 20,
      activePrayers: ["hawk_eye"],
    });
    const conflictingExpected = toggleCommitted;
    const conflictingCommitted = toggleExpected;
    await assert.rejects(
      databaseSystem.commitPrayerStateOperationAsync({
        operationId: toggleOperationId,
        playerId,
        requestFingerprint: prayerStateFingerprint(
          playerId,
          "toggle",
          conflictingExpected,
          conflictingCommitted,
        ),
        transition: "toggle",
        expected: conflictingExpected,
        committed: conflictingCommitted,
      }),
      /prayer_state_operation_id_conflict/u,
    );

    const emptyReplay = await runPrayerReceiptCompaction(pool, {
      mode: "execute",
      cutoffBeforeMs: 3_000,
      batchLimit: 10,
      statementTimeoutMs: 2_000,
      retentionApprovalId: "integration-approved-retention",
      nowMs: 4_001,
      compactionBatchId: "10b77655-8dac-436c-af63-b1eaac2a264a",
    });
    assert.equal(emptyReplay.eligibleCount, 0);
    assert.equal(emptyReplay.compactedCount, 0);

    await assertRejectedSqlState(
      pool.query(
        `INSERT INTO operations_log (
           id, "playerId", "operationType", "operationState", completed,
           timestamp, "completedAt"
         ) VALUES ($1, $2, 'unrelated_operation', '{}'::jsonb, true, 5000, 5000)`,
        [drainOperationId, playerId],
      ),
      "23505",
    );
    await assertRejectedSqlState(
      pool.query(
        `UPDATE compacted_prayer_state_receipts
            SET transition = 'restore'
          WHERE operation_id = $1`,
        [drainOperationId],
      ),
      "55000",
    );
    await assertRejectedSqlState(
      pool.query(
        `DELETE FROM compacted_prayer_state_receipts
          WHERE operation_id = $1`,
        [drainOperationId],
      ),
      "55000",
    );
    await assertRejectedSqlState(
      pool.query(`TRUNCATE compacted_prayer_state_receipts`),
      "55000",
    );

    const malformedOperationId = "prayer:malformed-compaction-receipt";
    await pool.query(
      `INSERT INTO operations_log (
         id, "playerId", "operationType", "operationState", completed,
         timestamp, "completedAt"
       ) VALUES ($1, $2, 'prayer_state_transition', $3::jsonb, true, 2500, 2500)`,
      [
        malformedOperationId,
        playerId,
        JSON.stringify({ ...drainState, requestFingerprint: "0".repeat(64) }),
      ],
    );
    await assert.rejects(
      runPrayerReceiptCompaction(pool, {
        mode: "execute",
        cutoffBeforeMs: 3_000,
        batchLimit: 10,
        statementTimeoutMs: 2_000,
        retentionApprovalId: "integration-approved-retention",
        nowMs: 4_002,
        compactionBatchId: "f22cf204-1c40-483a-8d77-76da12c6ec44",
      }),
      /prayer_receipt_compaction_state_invalid/u,
    );
    const rollbackTruth = await pool.query<{
      wal_count: number;
      compact_count: number;
    }>(
      `SELECT
      (SELECT count(*)::int FROM operations_log WHERE id = $1) AS wal_count,
      (SELECT count(*)::int FROM compacted_prayer_state_receipts WHERE operation_id = $1) AS compact_count`,
      [malformedOperationId],
    );
    assert.deepEqual(rollbackTruth.rows[0], {
      wal_count: 1,
      compact_count: 0,
    });

    console.log(
      JSON.stringify({
        ok: true,
        migration: "0094_add_compacted_prayer_state_receipts",
        audited: audit.selectedCount,
        compacted: executed.compactedCount,
        permanentIdentities: retained.rows[0]?.compact_count,
        publicObservations: retained.rows[0]?.observation_count,
        exactObservationIdentity: true,
        exactDatabaseSystemReplay: true,
        semanticCollisionRejected: true,
        replayIdReuseRejected: true,
        appendOnlyMutationRejected: true,
        malformedBatchRolledBack: true,
      }),
    );
  } finally {
    await pool.end();
  }
}

await run();
