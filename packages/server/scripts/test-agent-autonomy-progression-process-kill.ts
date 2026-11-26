import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import {
  buildAgentAutonomyCheckpointDraft,
  type AgentAutonomyActionResult,
} from "../src/eliza/agentAutonomyCheckpoint.js";
import {
  beginAgentAutonomyProgressionAttempt,
  finalizeAgentAutonomyProgressionAttempt,
  recoverOpenAgentAutonomyProgressionAttempt,
} from "../src/eliza/agentAutonomyProgression.js";
import type { AgentInstance } from "../src/eliza/managers/AgentBehaviorTicker.js";

const CRASH_ATTEMPT_ID = "77777777-7777-4777-8777-777777777777";
const CHARACTER_ID = "progression-process-kill-agent";

function makeInstance(): AgentInstance {
  return {
    config: {
      characterId: CHARACTER_ID,
      accountId: "progression-process-kill-account",
      name: "Progression Process Kill Agent",
    },
    goal: { type: "gathering", description: "Gather verified resources" },
    llmPlan: {
      steps: ["Gather one resource", "Reassess"],
      currentStep: 0,
      createdAt: 1,
      goal: "Gather verified resources",
    },
    memories: [],
    recentActionLog: [],
    tickCounter: 0,
    pendingLlmResult: undefined,
  } as unknown as AgentInstance;
}

async function runWriter(connectionString: string): Promise<never> {
  const pool = new pg.Pool({ connectionString, max: 2 });
  await beginAgentAutonomyProgressionAttempt(pool, {
    attemptId: CRASH_ATTEMPT_ID,
    characterId: CHARACTER_ID,
    goalType: "gathering",
    actionType: "gather",
    decisionSource: "llm",
    startedAt: 10_000,
  });
  // This marker simulates an authoritative external dispatch that committed
  // after the started edge but before the terminal/checkpoint transaction.
  await pool.query(
    `INSERT INTO progression_test_action_markers (attempt_id) VALUES ($1)`,
    [CRASH_ATTEMPT_ID],
  );
  process.stdout.write("ACTION_DISPATCHED_AND_START_COMMITTED\n");
  await new Promise<never>(() => {});
}

async function waitForWriterReady(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("progression writer readiness timeout")),
      15_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("ACTION_DISPATCHED_AND_START_COMMITTED")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!output.includes("ACTION_DISPATCHED_AND_START_COMMITTED")) {
        clearTimeout(timeout);
        reject(
          new Error(
            `progression writer exited before readiness: ${code ?? signal}`,
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

async function runParent(): Promise<void> {
  const baseUrl =
    process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      "Set AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL for the process-kill proof",
    );
  }

  const databaseName = `hyperia_progression_kill_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const adminPool = new pg.Pool({
    connectionString: adminUrl.toString(),
    max: 2,
  });
  let pool: pg.Pool | null = null;
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
       VALUES ('progression-process-kill-account', 'Progression Kill Account', 'user', '2026-08-09T00:00:00.000Z')`,
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent")
       VALUES ($1, 'progression-process-kill-account', 'Progression Kill Agent', 1)`,
      [CHARACTER_ID],
    );
    await pool.query(
      `CREATE TABLE progression_test_action_markers (
         attempt_id text PRIMARY KEY,
         committed_at timestamptz DEFAULT now() NOT NULL
       )`,
    );

    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--writer", testUrl.toString()],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForWriterReady(child);
    const killed = child.kill("SIGKILL");
    if (!killed) throw new Error("failed to kill progression writer");
    await waitForExit(child);

    const replacements = await Promise.all(
      Array.from({ length: 5 }, () =>
        recoverOpenAgentAutonomyProgressionAttempt(
          pool!,
          makeInstance(),
          10_500,
        ),
      ),
    );
    const recovered = replacements.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    if (recovered.length !== 1) {
      throw new Error(`expected one recovery winner, got ${recovered.length}`);
    }
    if (
      recovered[0].checkpoint.lastActionOutcome !== "unknown_after_restart" ||
      recovered[0].checkpoint.lastAppliedActionType !== null ||
      recovered[0].checkpoint.requiresReassessment !== true
    ) {
      throw new Error("replacement checkpoint did not preserve uncertainty");
    }

    const nextAttempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "88888888-8888-4888-8888-888888888888",
      characterId: CHARACTER_ID,
      goalType: "gathering",
      actionType: "gather",
      decisionSource: "scripted",
      startedAt: 11_000,
    });
    const nextResult: AgentAutonomyActionResult = {
      attemptedActionType: "gather",
      appliedActionType: "gather",
      outcome: "dispatched",
    };
    const replacementInstance = makeInstance();
    const nextCheckpoint = await finalizeAgentAutonomyProgressionAttempt(
      pool,
      nextAttempt,
      buildAgentAutonomyCheckpointDraft(
        replacementInstance,
        nextResult,
        11_100,
      ),
    );

    const proof = await pool.query<{
      marker_count: string;
      start_count: string;
      terminal_count: string;
      recovery_count: string;
      open_attempt_id: string | null;
      checkpoint_outcome: string;
      checkpoint_revision: string;
      lifecycle_event_count: string;
      lifecycle_trace: string;
      lifecycle_state: string;
      lifecycle_goal_type: string;
      lifecycle_revision: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM progression_test_action_markers) AS marker_count,
         (SELECT count(*)::text FROM agent_autonomy_progression_events
          WHERE event_type = 'attempt_started') AS start_count,
         (SELECT count(*)::text FROM agent_autonomy_progression_events
          WHERE event_type = 'attempt_terminal') AS terminal_count,
         (SELECT count(*)::text FROM agent_autonomy_progression_events
          WHERE event_source = 'restart_recovery'
            AND action_outcome = 'unknown_after_restart') AS recovery_count,
         (SELECT open_attempt_id FROM agent_autonomy_progression_heads
          WHERE character_id = $1) AS open_attempt_id,
         (SELECT last_action_outcome FROM agent_autonomy_checkpoints
          WHERE character_id = $1) AS checkpoint_outcome,
         (SELECT revision::text FROM agent_autonomy_checkpoints
          WHERE character_id = $1) AS checkpoint_revision,
         (SELECT count(*)::text FROM agent_autonomy_lifecycle_events
          WHERE character_id = $1) AS lifecycle_event_count,
         (SELECT string_agg(
            event_type || ':' || lifecycle_state || ':' ||
            COALESCE(action_outcome, 'none'), ',' ORDER BY event_sequence
          ) FROM agent_autonomy_lifecycle_events
          WHERE character_id = $1) AS lifecycle_trace,
         (SELECT current_state FROM agent_autonomy_lifecycle_heads
          WHERE character_id = $1) AS lifecycle_state,
         (SELECT current_goal_type FROM agent_autonomy_lifecycle_heads
          WHERE character_id = $1) AS lifecycle_goal_type,
         (SELECT head_revision::text FROM agent_autonomy_lifecycle_heads
          WHERE character_id = $1) AS lifecycle_revision`,
      [CHARACTER_ID],
    );
    const row = proof.rows[0];
    if (
      row.marker_count !== "1" ||
      row.start_count !== "2" ||
      row.terminal_count !== "2" ||
      row.recovery_count !== "1" ||
      row.open_attempt_id !== null ||
      row.checkpoint_outcome !== "dispatched" ||
      row.checkpoint_revision !== String(nextCheckpoint.revision) ||
      row.lifecycle_event_count !== "4" ||
      row.lifecycle_trace !==
        "goal_selected:goal_selection:none,state_entered:gathering:none,reassessment_required:reassessment:unknown_after_restart,state_entered:gathering:none" ||
      row.lifecycle_state !== "gathering" ||
      row.lifecycle_goal_type !== "gathering" ||
      row.lifecycle_revision !== "4" ||
      nextCheckpoint.revision !== 2
    ) {
      throw new Error(`process-kill proof mismatch: ${JSON.stringify(row)}`);
    }

    process.stdout.write(
      `${JSON.stringify({
        writerKilledAfterExternalDispatch: true,
        startCommittedBeforeDispatch: true,
        oneOfFiveReplacementWorkersRecovered: true,
        unresolvedOutcomeRecorded: "unknown_after_restart",
        unknownActionNotReplayed: row.marker_count === "1",
        freshDecisionRequired: true,
        nextAttemptCompletedAfterRecovery: true,
        pairedStarts: Number(row.start_count),
        pairedTerminals: Number(row.terminal_count),
        finalCheckpointRevision: nextCheckpoint.revision,
        lifecycleStartSurvivedProcessKill: true,
        lifecycleReassessmentRecordedOnce: true,
        lifecycleTrace: row.lifecycle_trace,
        finalLifecycleState: row.lifecycle_state,
        finalLifecycleRevision: Number(row.lifecycle_revision),
      })}\n`,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
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
