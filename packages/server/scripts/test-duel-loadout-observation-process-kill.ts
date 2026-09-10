import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  type CombatLoadoutPersistenceSnapshot,
  type StreamingDuelRoleSwitchObservationContext,
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
const CHILD_DATABASE_URL = "DUEL_LOADOUT_KILL_DATABASE_URL";
const CHILD_CONTEXT = "DUEL_LOADOUT_KILL_CONTEXT";
const PLAYER_ID = "duel-loadout-kill-agent";
const OPPONENT_ID = "duel-loadout-kill-opponent";
const EXPECTED = {
  inventory: [
    { itemId: "shortbow", quantity: 1, slotIndex: 0, metadata: null },
    { itemId: "bronze_arrow", quantity: 50, slotIndex: 1, metadata: null },
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
const COMMITTED = {
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

type ChildContext = {
  loadoutOperationId: string;
  observation: StreamingDuelRoleSwitchObservationContext;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requestFingerprint(
  publicActionObservation: StreamingDuelRoleSwitchObservationContext,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        cycleId: publicActionObservation.cycleId,
        playerId: PLAYER_ID,
        frozenFingerprint: "process-kill-frozen-loadout",
        targetRole: "ranged",
        loadout: {
          role: "ranged",
          weaponId: "shortbow",
          arrowsId: "bronze_arrow",
          shieldId: null,
          spellId: null,
        },
        publicActionObservation,
      }),
      "utf8",
    )
    .digest("hex");
}

function buildRequest(context: ChildContext) {
  return {
    operationId: context.loadoutOperationId,
    playerId: PLAYER_ID,
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
  const receipt = await databaseSystem.commitCombatLoadoutOperationAsync(
    buildRequest(context),
  );
  assert(receipt.replayed === false, "loadout custody unexpectedly replayed");
  assert(
    receipt.committed.equipment.some(
      (row) => row.slotType === "weapon" && row.itemId === "shortbow",
    ),
    "loadout custody did not equip the shortbow",
  );

  // Emitted only after inventory, equipment, selected spell, receipt, and the
  // public role row have returned from one serializable transaction.
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
    process.env.DUEL_LOADOUT_OBSERVATION_TEST_DATABASE_URL?.trim() ?? "";
  assert(
    baseDatabaseUrl,
    "DUEL_LOADOUT_OBSERVATION_TEST_DATABASE_URL is required",
  );

  const databaseName = `hyperia_duel_loadout_kill_${process.pid}_${Date.now().toString(36)}`;
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
      id: "duel-loadout-kill-account",
      name: "Duel Loadout Kill Account",
      roles: "user",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    await db.insert(schema.characters).values({
      id: PLAYER_ID,
      accountId: "duel-loadout-kill-account",
      name: "Duel Loadout Kill Agent",
      isAgent: 1,
      selectedSpell: null,
    });
    await db
      .insert(schema.inventory)
      .values(
        EXPECTED.inventory.map((row) => ({ playerId: PLAYER_ID, ...row })),
      );
    await db
      .insert(schema.equipment)
      .values(
        EXPECTED.equipment.map((row) => ({ playerId: PLAYER_ID, ...row })),
      );

    const context: ChildContext = {
      loadoutOperationId: `combat-loadout:cycle-loadout-process-kill:${PLAYER_ID}:1`,
      observation: {
        operationId: randomUUID(),
        tick: 17,
        observedAt: Date.now(),
        cycleId: "cycle-loadout-process-kill",
        duelId: "duel-loadout-process-kill",
        actorId: PLAYER_ID,
        opponentId: OPPONENT_ID,
        phase: "FIGHTING",
        combatRole: "melee",
        tacticalMacro: "pressure",
        targetRole: "ranged",
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
      inventory: string[];
      equipment: string[];
      completed: boolean;
      observationRows: number;
    }>(
      `SELECT
         (SELECT array_agg("itemId" ORDER BY "slotIndex") FROM inventory WHERE "playerId" = $1) AS inventory,
         (SELECT array_agg("itemId" ORDER BY "slotType") FROM equipment WHERE "playerId" = $1) AS equipment,
         (SELECT completed FROM operations_log WHERE id = $2) AS completed,
         (SELECT count(*) FROM streaming_duel_action_observations
           WHERE "operationId" = $3)::int AS "observationRows"`,
      [PLAYER_ID, context.loadoutOperationId, context.observation.operationId],
    );
    assert(
      JSON.stringify(authorityRows.rows[0]?.inventory) ===
        JSON.stringify(["bronze_longsword"]),
      "durable inventory is not exact",
    );
    assert(
      JSON.stringify(authorityRows.rows[0]?.equipment) ===
        JSON.stringify(["bronze_arrow", "shortbow"]),
      "durable equipment is not exact",
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
    const replay = await replacementDatabase.commitCombatLoadoutOperationAsync(
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
    assert(
      recovered[0]?.action === "role_switch",
      "recovered action is not role_switch",
    );
    assert(recovered[0]?.value === "ranged", "recovered role is not exact");

    const draft = {
      tick: context.observation.tick,
      cycleId: context.observation.cycleId,
      duelId: context.observation.duelId,
      actorId: context.observation.actorId,
      opponentId: context.observation.opponentId,
      phase: context.observation.phase,
      combatRole: context.observation.combatRole,
      tacticalMacro: context.observation.tacticalMacro,
      action: "role_switch",
      outcome: "committed",
      value: context.observation.targetRole,
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
        boundary: "loadout_authority_commit_before_publication_process_kill",
        signal: childResult.signal,
        inventory: authorityRows.rows[0].inventory,
        equipment: authorityRows.rows[0].equipment,
        operationCompleted: authorityRows.rows[0].completed,
        observationRows: replayRows.rows[0].count,
        recoveredSequence: recovered[0]?.sequence,
        recoveredRole: recovered[0]?.value,
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
