import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import * as schema from "../src/database/schema.js";
import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import {
  beginAgentAutonomyProgressionAttempt,
  recoverOpenAgentAutonomyProgressionAttempt,
} from "../src/eliza/agentAutonomyProgression.js";
import type { AgentInstance } from "../src/eliza/managers/AgentBehaviorTicker.js";
import {
  getOrdinaryBoneBurialOperationId,
  resolveOrdinaryBoneBurialRecovery,
} from "../src/eliza/ordinaryAgentPrayerTraining.js";
import type { BoneBurialCommitRequest } from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const ATTEMPT_ID = "78da4258-4c7a-4f00-81a6-6165987207d0";
const CHARACTER_ID = "ordinary-prayer-process-kill-agent";
const ACCOUNT_ID = "ordinary-prayer-process-kill-account";
const ITEM_ID = "ordinary_prayer_process_bones";
const XP_AMOUNT = 20;

function makeInstance(): AgentInstance {
  return {
    config: {
      characterId: CHARACTER_ID,
      accountId: ACCOUNT_ID,
      name: "Ordinary Prayer Process Kill Agent",
    },
    goal: { type: "provisioning", description: "Train Prayer" },
    memories: [],
    recentActionLog: [],
    tickCounter: 0,
    pendingLlmResult: undefined,
  } as unknown as AgentInstance;
}

function requestFor(
  attemptId = ATTEMPT_ID,
  overrides: Partial<
    Pick<BoneBurialCommitRequest, "itemId" | "xpAmount" | "levelRequired">
  > = {},
): BoneBurialCommitRequest {
  const operationId = getOrdinaryBoneBurialOperationId(attemptId);
  const itemId = overrides.itemId ?? ITEM_ID;
  const xpAmount = overrides.xpAmount ?? XP_AMOUNT;
  const levelRequired = overrides.levelRequired ?? 1;
  const payload = {
    version: 1,
    playerId: CHARACTER_ID,
    itemId,
    xpAmount,
    levelRequired,
  };
  return {
    operationId,
    playerId: CHARACTER_ID,
    itemId,
    xpAmount,
    levelRequired,
    requestFingerprint: createHash("sha256")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex"),
  };
}

async function createDatabaseSystem(
  connectionString: string,
): Promise<{ system: DatabaseSystem; pool: pg.Pool }> {
  const pool = new pg.Pool({ connectionString, max: 4 });
  const db = drizzle(pool, { schema });
  const system = new DatabaseSystem({} as never);
  (system as unknown as { db: typeof db }).db = db;
  (system as unknown as { pool: pg.Pool }).pool = pool;
  return { system, pool };
}

async function runWriter(connectionString: string): Promise<never> {
  const { system, pool } = await createDatabaseSystem(connectionString);
  const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
    attemptId: ATTEMPT_ID,
    characterId: CHARACTER_ID,
    goalType: "provisioning",
    actionType: "bury",
    decisionSource: "scripted",
    startedAt: 10_000,
  });
  const receipt = await system.commitBoneBurialOperationAsync(
    requestFor(attempt.attemptId),
  );
  if (
    receipt.replayed ||
    receipt.awardedXp !== XP_AMOUNT ||
    receipt.currentXp !== 100 ||
    receipt.currentLevel !== 2 ||
    receipt.committed.reduce(
      (total, item) => total + (item.itemId === ITEM_ID ? item.quantity : 0),
      0,
    ) !== 1
  ) {
    throw new Error(
      `writer burial receipt mismatch: ${JSON.stringify(receipt)}`,
    );
  }
  process.stdout.write("BONE_RECEIPT_AND_PROGRESSION_COMMITTED\n");
  await new Promise<never>(() => {});
}

async function waitForWriterReady(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(
      () => reject(new Error(`prayer writer readiness timeout: ${errors}`)),
      20_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("BONE_RECEIPT_AND_PROGRESSION_COMMITTED")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!output.includes("BONE_RECEIPT_AND_PROGRESSION_COMMITTED")) {
        clearTimeout(timeout);
        reject(
          new Error(
            `prayer writer exited before readiness: ${code ?? signal}: ${errors}`,
          ),
        );
      }
    });
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function expectMutationRejected(
  pool: pg.Pool,
  statement: string,
): Promise<void> {
  try {
    await pool.query(statement);
  } catch (error) {
    if ((error as { code?: string }).code === "55000") return;
    throw error;
  }
  throw new Error(`append-only mutation unexpectedly succeeded: ${statement}`);
}

function errorChainContains(error: unknown, expected: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (String(current).includes(expected)) return true;
    if (typeof current !== "object") return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function runParent(): Promise<void> {
  const baseUrl =
    process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      "Set AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL for the prayer process-kill proof",
    );
  }

  const databaseName = `hyperia_prayer_kill_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const adminPool = new pg.Pool({
    connectionString: adminUrl.toString(),
    max: 2,
  });
  let pool: pg.Pool | null = null;
  let replayPool: pg.Pool | null = null;
  let child: ReturnType<typeof spawn> | null = null;

  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(baseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 12 });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../src/database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, 'Ordinary Prayer Kill Account', 'user', '2026-08-10T00:00:00.000Z')`,
      [ACCOUNT_ID],
    );
    await pool.query(
      `INSERT INTO characters (
         id, "accountId", name, "isAgent", "prayerXp", "prayerLevel",
         "prayerPoints", "prayerPointUnits", "prayerMaxPoints"
       ) VALUES ($1, $2, 'Ordinary Prayer Kill Agent', 1, 80, 1, 1, 1000000, 1)`,
      [CHARACTER_ID, ACCOUNT_ID],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, $2, 2, 0)`,
      [CHARACTER_ID, ITEM_ID],
    );

    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--writer", testUrl.toString()],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForWriterReady(child);
    if (!child.kill("SIGKILL")) throw new Error("failed to kill prayer writer");
    await waitForExit(child);

    const replacements = await Promise.all(
      Array.from({ length: 5 }, () =>
        recoverOpenAgentAutonomyProgressionAttempt(
          pool!,
          makeInstance(),
          10_500,
          resolveOrdinaryBoneBurialRecovery,
        ),
      ),
    );
    const recovered = replacements.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    if (recovered.length !== 1) {
      throw new Error(
        `expected one prayer recovery winner, got ${recovered.length}`,
      );
    }
    if (
      recovered[0].checkpoint.lastActionOutcome !== "completed" ||
      recovered[0].checkpoint.lastAppliedActionType !== "bury" ||
      recovered[0].checkpoint.requiresReassessment !== true
    ) {
      throw new Error(
        "prayer recovery checkpoint did not preserve exact truth",
      );
    }

    const replaySystem = await createDatabaseSystem(testUrl.toString());
    replayPool = replaySystem.pool;
    const replay =
      await replaySystem.system.commitBoneBurialOperationAsync(requestFor());
    if (
      !replay.replayed ||
      replay.currentXp !== 100 ||
      replay.currentLevel !== 2
    ) {
      throw new Error(
        `durable burial replay mismatch: ${JSON.stringify(replay)}`,
      );
    }

    let collisionRejected = false;
    try {
      await replaySystem.system.commitBoneBurialOperationAsync(
        requestFor(ATTEMPT_ID, { xpAmount: XP_AMOUNT + 1 }),
      );
    } catch (error) {
      collisionRejected = errorChainContains(
        error,
        "bone_burial_operation_id_conflict",
      );
    }
    if (!collisionRejected) {
      throw new Error("changed burial payload reused one operation identity");
    }

    const rollbackAttemptId = "76fb8600-ac11-49da-93bd-343a4a3f706b";
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_bone_receipt_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced bone receipt failure';
      END;
      $$;
      CREATE TRIGGER aaa_fail_test_bone_receipt_insert
      BEFORE INSERT ON bone_burial_operations
      FOR EACH ROW EXECUTE FUNCTION fail_test_bone_receipt_insert();
    `);
    let rollbackRejected = false;
    try {
      await replaySystem.system.commitBoneBurialOperationAsync(
        requestFor(rollbackAttemptId),
      );
    } catch (error) {
      rollbackRejected = errorChainContains(
        error,
        "forced bone receipt failure",
      );
    } finally {
      await pool.query(
        `DROP TRIGGER aaa_fail_test_bone_receipt_insert ON bone_burial_operations`,
      );
      await pool.query(`DROP FUNCTION fail_test_bone_receipt_insert()`);
    }
    if (!rollbackRejected) {
      throw new Error("forced receipt failure was not surfaced");
    }
    const rollbackProof = await pool.query<{
      receipt_count: string;
      carried_bones: string;
      prayer_xp: number;
    }>(
      `SELECT
         (SELECT count(*)::text FROM bone_burial_operations
          WHERE operation_id = $2) AS receipt_count,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $3), '0') AS carried_bones,
         "prayerXp" AS prayer_xp
       FROM characters WHERE id = $1`,
      [
        CHARACTER_ID,
        getOrdinaryBoneBurialOperationId(rollbackAttemptId),
        ITEM_ID,
      ],
    );
    if (
      rollbackProof.rows[0]?.receipt_count !== "0" ||
      rollbackProof.rows[0]?.carried_bones !== "1" ||
      rollbackProof.rows[0]?.prayer_xp !== 100
    ) {
      throw new Error(
        `bone rollback proof mismatch: ${JSON.stringify(rollbackProof.rows[0])}`,
      );
    }
    const proof = await pool.query<{
      receipt_count: string;
      carried_bones: string;
      prayer_xp: number;
      prayer_level: number;
      prayer_points: number;
      prayer_point_units: number;
      prayer_max_points: number;
      terminal_source: string;
      terminal_outcome: string;
      applied_action: string;
      open_attempt_id: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM bone_burial_operations
          WHERE operation_id = $2) AS receipt_count,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $3), '0') AS carried_bones,
         "prayerXp" AS prayer_xp,
         "prayerLevel" AS prayer_level,
         "prayerPoints" AS prayer_points,
         "prayerPointUnits" AS prayer_point_units,
         "prayerMaxPoints" AS prayer_max_points,
         (SELECT event_source FROM agent_autonomy_progression_events
          WHERE attempt_id = $4 AND event_type = 'attempt_terminal') AS terminal_source,
         (SELECT action_outcome FROM agent_autonomy_progression_events
          WHERE attempt_id = $4 AND event_type = 'attempt_terminal') AS terminal_outcome,
         (SELECT applied_action_type FROM agent_autonomy_progression_events
          WHERE attempt_id = $4 AND event_type = 'attempt_terminal') AS applied_action,
         (SELECT open_attempt_id FROM agent_autonomy_progression_heads
          WHERE character_id = $1) AS open_attempt_id
       FROM characters WHERE id = $1`,
      [
        CHARACTER_ID,
        getOrdinaryBoneBurialOperationId(ATTEMPT_ID),
        ITEM_ID,
        ATTEMPT_ID,
      ],
    );
    const row = proof.rows[0];
    if (
      row.receipt_count !== "1" ||
      row.carried_bones !== "1" ||
      row.prayer_xp !== 100 ||
      row.prayer_level !== 2 ||
      row.prayer_points !== 2 ||
      row.prayer_point_units !== 2_000_000 ||
      row.prayer_max_points !== 2 ||
      row.terminal_source !== "restart_reconciliation" ||
      row.terminal_outcome !== "completed" ||
      row.applied_action !== "bury" ||
      row.open_attempt_id !== null
    ) {
      throw new Error(
        `prayer process-kill proof mismatch: ${JSON.stringify(row)}`,
      );
    }

    await expectMutationRejected(
      pool,
      `UPDATE bone_burial_operations SET awarded_xp = 0 WHERE operation_id = '${getOrdinaryBoneBurialOperationId(ATTEMPT_ID)}'`,
    );
    await expectMutationRejected(
      pool,
      `DELETE FROM bone_burial_operations WHERE operation_id = '${getOrdinaryBoneBurialOperationId(ATTEMPT_ID)}'`,
    );
    await expectMutationRejected(pool, "TRUNCATE bone_burial_operations");

    process.stdout.write(
      `${JSON.stringify({
        writerKilledAfterBoneCommit: true,
        startCommittedBeforeCustody: true,
        exactReceiptRecoveredAfterRestart: true,
        oneOfFiveReplacementWorkersRecovered: true,
        exactReplayDidNotConsumeAgain: replay.replayed,
        changedPayloadCollisionRejected: collisionRejected,
        receiptFailureRolledBackCustodyAndXp: rollbackRejected,
        carriedBoneQuantity: Number(row.carried_bones),
        prayerXp: row.prayer_xp,
        prayerLevel: row.prayer_level,
        prayerPointUnits: row.prayer_point_units,
        terminalSource: row.terminal_source,
        terminalOutcome: row.terminal_outcome,
        receiptAppendOnly: true,
      })}\n`,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await replayPool?.end();
    await pool?.end();
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  }
}

if (process.argv[2] === "--writer") {
  const connectionString = process.argv[3];
  if (!connectionString) throw new Error("writer connection string missing");
  await runWriter(connectionString);
} else {
  await runParent();
}
