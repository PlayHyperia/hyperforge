import {
  STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
  type StreamingDuelActionObservation,
} from "@hyperforge/shared";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import {
  PostgresStreamingDuelActionObservationStore,
  type StreamingDuelActionObservationPool,
} from "../public-action-observation-ledger.js";
import type { UnsequencedStreamingDuelActionObservation } from "../public-action-observation-buffer.js";

const databaseUrl =
  process.env.DUEL_ACTION_OBSERVATION_TEST_DATABASE_URL ??
  process.env.DUEL_PREPARATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const migrationsFolder = fileURLToPath(
  new URL("../../../database/migrations/", import.meta.url),
);

function observation(
  tick: number,
  overrides: Partial<UnsequencedStreamingDuelActionObservation> = {},
): UnsequencedStreamingDuelActionObservation {
  return {
    tick,
    observedAt: 1_800_000_000_000 + tick,
    cycleId: "cycle-postgres-ledger",
    duelId: "duel-postgres-ledger",
    actorId: tick % 2 === 0 ? "agent-b" : "agent-a",
    opponentId: tick % 2 === 0 ? "agent-a" : "agent-b",
    phase: "FIGHTING",
    combatRole: "ranged",
    tacticalMacro: "kite",
    action: "movement",
    outcome: "accepted",
    value: "reposition",
    amount: null,
    ...overrides,
  } as UnsequencedStreamingDuelActionObservation;
}

describeWithDatabase("PostgresStreamingDuelActionObservationStore", () => {
  let pool: pg.Pool;
  let store: PostgresStreamingDuelActionObservationStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder,
      });
    } finally {
      migrationClient.release();
    }
    store = new PostgresStreamingDuelActionObservationStore(
      pool as unknown as StreamingDuelActionObservationPool,
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("commits exact idempotent sequence and replays it after pool restart", async () => {
    const firstOperation = "00000000-0000-4000-8000-000000000001";
    const first = await store.append(firstOperation, observation(1));
    expect(first.sequence).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);
    await expect(store.append(firstOperation, observation(1))).resolves.toEqual(
      first,
    );

    const concurrent = await Promise.all([
      store.append("00000000-0000-4000-8000-000000000002", observation(2)),
      store.append("00000000-0000-4000-8000-000000000003", observation(3)),
    ]);
    expect(concurrent.map(({ sequence }) => sequence).sort()).toEqual([2, 3]);

    await pool.end();
    pool = new pg.Pool({ connectionString: databaseUrl });
    store = new PostgresStreamingDuelActionObservationStore(
      pool as unknown as StreamingDuelActionObservationPool,
    );
    const replayed = await store.loadTail("cycle-postgres-ledger");
    expect(replayed.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(replayed.every(Object.isFrozen)).toBe(true);
    expect(
      replayed.every(
        (entry) =>
          !("reasoning" in entry) &&
          !("coordinates" in entry) &&
          !("wallet" in entry) &&
          !("bank" in entry),
      ),
    ).toBe(true);
  }, 120_000);

  it("shares its head-row allocator with an in-flight atomic authority transaction", async () => {
    const cycleId = "cycle-cross-authority-ledger";
    const duelId = "duel-cross-authority-ledger";
    const first = await store.append(
      "00000000-0000-4000-8000-000000000011",
      observation(11, { cycleId, duelId }),
    );
    expect(first.sequence).toBe(1);

    const authorityClient = await pool.connect();
    let authorityCommitted = false;
    try {
      await authorityClient.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const allocated = await authorityClient.query<{ nextSequence: number }>(
        `INSERT INTO streaming_duel_action_observation_heads (
           "cycleId", "lastSequence"
         ) VALUES ($1, 1)
         ON CONFLICT ("cycleId") DO UPDATE
           SET "lastSequence" =
             streaming_duel_action_observation_heads."lastSequence" + 1
         RETURNING "lastSequence" AS "nextSequence"`,
        [cycleId],
      );
      expect(allocated.rows[0]?.nextSequence).toBe(2);

      const authorityObservation = {
        ...observation(12, { cycleId, duelId }),
        schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
        sequence: 2,
      } satisfies StreamingDuelActionObservation;
      await authorityClient.query(
        `INSERT INTO streaming_duel_action_observations (
           "operationId", "cycleId", "duelId", sequence, "observedAt",
           "actorId", "opponentId", action, observation
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          "00000000-0000-4000-8000-000000000012",
          cycleId,
          duelId,
          authorityObservation.sequence,
          authorityObservation.observedAt,
          authorityObservation.actorId,
          authorityObservation.opponentId,
          authorityObservation.action,
          JSON.stringify(authorityObservation),
        ],
      );

      const presentationAppend = store.append(
        "00000000-0000-4000-8000-000000000013",
        observation(13, { cycleId, duelId }),
      );
      let observedHeadLock = false;
      const lockDeadline = Date.now() + 5_000;
      while (Date.now() < lockDeadline) {
        const waiting = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND "wait_event_type" = 'Lock'
              AND query LIKE '%streaming_duel_action_observation_heads%'`,
        );
        if (waiting.rows[0]?.count !== "0") {
          observedHeadLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedHeadLock).toBe(true);

      await authorityClient.query("COMMIT");
      authorityCommitted = true;
      await expect(presentationAppend).resolves.toMatchObject({ sequence: 3 });

      const persisted = await store.loadTail(cycleId);
      expect(persisted.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    } finally {
      if (!authorityCommitted) {
        await authorityClient.query("ROLLBACK").catch(() => undefined);
      }
      authorityClient.release();
    }
  }, 120_000);

  it("rejects operation collision, private keys, mutation, and truncation", async () => {
    await expect(
      store.append("00000000-0000-4000-8000-000000000001", observation(99)),
    ).rejects.toThrow("operation collision");

    const privateObservation = {
      ...observation(4),
      schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
      sequence: 4,
      reasoning: "private",
    };
    await expect(
      pool.query(
        `INSERT INTO streaming_duel_action_observations (
             "operationId", "cycleId", "duelId", sequence, "observedAt",
             "actorId", "opponentId", action, observation
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          "00000000-0000-4000-8000-000000000004",
          privateObservation.cycleId,
          privateObservation.duelId,
          privateObservation.sequence,
          privateObservation.observedAt,
          privateObservation.actorId,
          privateObservation.opponentId,
          privateObservation.action,
          JSON.stringify(privateObservation),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `UPDATE streaming_duel_action_observations
           SET action = 'damage'
           WHERE "cycleId" = 'cycle-postgres-ledger'`,
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`TRUNCATE streaming_duel_action_observations`),
    ).rejects.toMatchObject({ code: "55000" });

    const rows = await pool.query<{
      observation: StreamingDuelActionObservation;
    }>(
      `SELECT observation
         FROM streaming_duel_action_observations
         WHERE "cycleId" = 'cycle-postgres-ledger'
         ORDER BY sequence`,
    );
    expect(rows.rows).toHaveLength(3);
  }, 120_000);
});
