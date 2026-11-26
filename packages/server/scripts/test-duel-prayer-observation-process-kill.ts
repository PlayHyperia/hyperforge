import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  type PrayerPersistenceSnapshot,
  type StreamingDuelPrayerObservationContext,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";
import {
  PostgresStreamingDuelActionObservationStore,
  StreamingDuelActionObservationLedger,
  type StreamingDuelActionObservationPool,
} from "../src/systems/StreamingDuelScheduler/public-action-observation-ledger.js";
import type { StreamingDuelActionObservationDraft } from "../src/systems/StreamingDuelScheduler/public-action-observation-buffer.js";

const CHILD_MODE = "--authority-child";
const CHILD_DATABASE_URL = "DUEL_PRAYER_KILL_DATABASE_URL";
const CHILD_CONTEXT = "DUEL_PRAYER_KILL_CONTEXT";
const PLAYER_ID = "duel-prayer-kill-agent";
const OPPONENT_ID = "duel-prayer-kill-opponent";
const EXPECTED = {
  pointUnits: 40_000_000,
  maxPoints: 40,
  activePrayers: [],
} satisfies PrayerPersistenceSnapshot;
const COMMITTED = {
  ...EXPECTED,
  activePrayers: ["hawk_eye"],
} satisfies PrayerPersistenceSnapshot;

type ChildContext = {
  prayerOperationId: string;
  observation: StreamingDuelPrayerObservationContext;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requestFingerprint(
  publicActionObservation: StreamingDuelPrayerObservationContext,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId: PLAYER_ID,
        transition: "toggle",
        expected: EXPECTED,
        committed: COMMITTED,
        publicActionObservation,
      }),
      "utf8",
    )
    .digest("hex");
}

function buildRequest(context: ChildContext) {
  return {
    operationId: context.prayerOperationId,
    playerId: PLAYER_ID,
    transition: "toggle" as const,
    expected: EXPECTED,
    committed: COMMITTED,
    requestFingerprint: requestFingerprint(context.observation),
    publicActionObservation: context.observation,
  };
}

async function runAuthorityChild(): Promise<never> {
  const databaseUrl = process.env[CHILD_DATABASE_URL]?.trim();
  const encodedContext = process.env[CHILD_CONTEXT];
  assert(databaseUrl, "child database URL is required");
  assert(encodedContext, "child context is required");
  const context = JSON.parse(encodedContext) as ChildContext;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const databaseSystem = new DatabaseSystem({
    drizzleDb: drizzle(pool, { schema }),
    pgPool: pool,
  } as never);
  await databaseSystem.init();
  const receipt = await databaseSystem.commitPrayerStateOperationAsync(
    buildRequest(context),
  );
  assert(receipt.replayed === false, "prayer custody unexpectedly replayed");
  assert(
    receipt.committed.activePrayers.includes("hawk_eye"),
    "prayer custody did not activate hawk_eye",
  );

  // Emitted only after the serializable authority transaction returned. No
  // presentation ledger exists in this process before the forced crash.
  await new Promise<void>((resolve) => {
    process.stdout.write("AUTHORITY_COMMITTED_BEFORE_PUBLICATION\n", resolve);
  });
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the authority child");
}

async function waitForChild(
  databaseUrl: string,
  context: ChildContext,
): Promise<{ stdout: string; stderr: string; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, CHILD_MODE], {
      env: {
        ...process.env,
        [CHILD_DATABASE_URL]: databaseUrl,
        [CHILD_CONTEXT]: JSON.stringify(context),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("authority child did not terminate within 30 seconds"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(
          new Error(
            `authority child exited ${code}: ${stderr || stdout || "no output"}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, signal });
    });
  });
}

async function runParent(): Promise<void> {
  const baseDatabaseUrl =
    process.env.DUEL_PRAYER_OBSERVATION_TEST_DATABASE_URL?.trim() ?? "";
  assert(
    baseDatabaseUrl,
    "DUEL_PRAYER_OBSERVATION_TEST_DATABASE_URL is required",
  );

  const databaseName = `hyperia_duel_prayer_kill_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const adminPool = new pg.Pool({
    connectionString: adminUrl.toString(),
    max: 2,
  });
  const testUrl = new URL(baseDatabaseUrl);
  testUrl.pathname = `/${databaseName}`;
  let pool: pg.Pool | null = null;
  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
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
          "../src/database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    const db = drizzle(pool, { schema });
    await db.insert(schema.users).values({
      id: "duel-prayer-kill-account",
      name: "Duel Prayer Kill Account",
      roles: "user",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    await db.insert(schema.characters).values({
      id: PLAYER_ID,
      accountId: "duel-prayer-kill-account",
      name: "Duel Prayer Kill Agent",
      isAgent: 1,
      prayerLevel: 40,
      prayerPoints: 40,
      prayerPointUnits: EXPECTED.pointUnits,
      prayerMaxPoints: EXPECTED.maxPoints,
      activePrayers: EXPECTED.activePrayers,
    });

    const context: ChildContext = {
      prayerOperationId: `prayer:${randomUUID()}`,
      observation: {
        operationId: randomUUID(),
        tick: 13,
        observedAt: Date.now(),
        cycleId: "cycle-prayer-process-kill",
        duelId: "duel-prayer-process-kill",
        actorId: PLAYER_ID,
        opponentId: OPPONENT_ID,
        phase: "FIGHTING",
        combatRole: "ranged",
        tacticalMacro: "kite",
        prayer: "hawk_eye",
      },
    };
    const childResult = await waitForChild(testUrl.toString(), context);
    assert(
      childResult.stdout.includes("AUTHORITY_COMMITTED_BEFORE_PUBLICATION"),
      `authority commit marker missing: ${childResult.stderr}`,
    );
    assert(
      childResult.signal === "SIGKILL",
      `authority child was not killed at the requested boundary (${String(childResult.signal)})`,
    );

    const authorityRows = await pool.query<{
      activePrayers: string[];
      completed: boolean;
      observationRows: number;
    }>(
      `SELECT
         (SELECT "activePrayers" FROM characters WHERE id = $1) AS "activePrayers",
         (SELECT completed FROM operations_log WHERE id = $2) AS completed,
         (SELECT count(*) FROM streaming_duel_action_observations
           WHERE "operationId" = $3)::int AS "observationRows"`,
      [PLAYER_ID, context.prayerOperationId, context.observation.operationId],
    );
    assert(
      JSON.stringify(authorityRows.rows[0]?.activePrayers) ===
        JSON.stringify(["hawk_eye"]),
      "durable prayer state is not exact",
    );
    assert(
      authorityRows.rows[0]?.completed === true,
      "receipt is not completed",
    );
    assert(
      authorityRows.rows[0]?.observationRows === 1,
      "atomic public observation is not exact-once",
    );

    const replacementDatabase = new DatabaseSystem({
      drizzleDb: db,
      pgPool: pool,
    } as never);
    await replacementDatabase.init();
    const replay = await replacementDatabase.commitPrayerStateOperationAsync(
      buildRequest(context),
    );
    assert(replay.replayed, "replacement authority did not replay receipt");

    const store = new PostgresStreamingDuelActionObservationStore(
      pool as unknown as StreamingDuelActionObservationPool,
    );
    const ledger = new StreamingDuelActionObservationLedger(store, {
      retryDelay: async () => {},
    });
    ledger.activateCycle(context.observation.cycleId);
    await ledger.waitForIdle();
    const recovered = ledger.getSnapshot(context.observation.cycleId);
    assert(
      recovered.length === 1,
      "replacement ledger did not hydrate one row",
    );
    assert(recovered[0]?.action === "prayer", "recovered action is not prayer");
    assert(recovered[0]?.value === "hawk_eye", "recovered prayer is not exact");

    const draft = {
      tick: context.observation.tick,
      cycleId: context.observation.cycleId,
      duelId: context.observation.duelId,
      actorId: context.observation.actorId,
      opponentId: context.observation.opponentId,
      phase: context.observation.phase,
      combatRole: context.observation.combatRole,
      tacticalMacro: context.observation.tacticalMacro,
      action: "prayer",
      outcome: "committed",
      value: context.observation.prayer,
      amount: null,
    } satisfies StreamingDuelActionObservationDraft;
    assert(
      ledger.record(draft, {
        operationId: context.observation.operationId,
        observedAt: context.observation.observedAt,
      }),
      "delayed controller callback was rejected",
    );
    await ledger.waitForIdle();
    const replayRows = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM streaming_duel_action_observations
       WHERE "operationId" = $1`,
      [context.observation.operationId],
    );
    assert(
      replayRows.rows[0]?.count === 1,
      "delayed callback duplicated the row",
    );
    assert(
      ledger.getHealth().persistenceErrors === 0,
      `replacement ledger unhealthy: ${ledger.getHealth().lastError}`,
    );

    console.log(
      JSON.stringify({
        status: "passed",
        boundary: "prayer_authority_commit_before_publication_process_kill",
        signal: childResult.signal,
        activePrayers: authorityRows.rows[0].activePrayers,
        operationCompleted: authorityRows.rows[0].completed,
        observationRows: replayRows.rows[0].count,
        recoveredSequence: recovered[0]?.sequence,
        recoveredPrayer: recovered[0]?.value,
        authorityReplayed: replay.replayed,
        ledgerHealth: ledger.getHealth(),
      }),
    );
  } finally {
    await pool?.end();
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  }
}

if (process.argv[2] === CHILD_MODE) {
  await runAuthorityChild();
} else {
  await runParent();
}
