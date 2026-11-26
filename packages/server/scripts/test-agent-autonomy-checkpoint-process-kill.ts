import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../src/database/schema.js";
import { closeDatabase, initializeDatabase } from "../src/database/client.js";
import {
  hydrateAgentFromAutonomyCheckpoint,
  loadAgentAutonomyCheckpoint,
  saveAgentAutonomyCheckpoint,
} from "../src/eliza/agentAutonomyCheckpoint.js";
import type { AgentInstance } from "../src/eliza/managers/AgentBehaviorTicker.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const CHARACTER_ID = "autonomy-checkpoint-chaos-agent";
const LEGACY_CHARACTER_ID = "autonomy-checkpoint-legacy-agent";
const MALFORMED_LEGACY_CHARACTER_ID =
  "autonomy-checkpoint-malformed-legacy-agent";

type WorkerEvent = {
  event: "saved" | "recovered" | "error";
  revision?: number;
  pendingActionCleared?: boolean;
  requiresFreshDecision?: boolean;
  goal?: string | null;
  planStep?: number | null;
  memoryCount?: number;
  lastAttemptedActionType?: string | null;
  lastActionOutcome?: string | null;
  lastAppliedActionType?: string | null;
  lastAttemptedAt?: number | null;
  message?: string;
};

function emit(event: WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runSaveWorker(): Promise<void> {
  const connectionString = process.env.AUTONOMY_CHECKPOINT_DATABASE_URL;
  if (!connectionString) {
    throw new Error("autonomy checkpoint worker database is missing");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const appliedAt = Date.now();
    await saveAgentAutonomyCheckpoint(db, {
      characterId: CHARACTER_ID,
      goal: { type: "combat", description: "Train and prepare safely" },
      plan: {
        steps: [
          "Find a legal nearby target",
          "Reassess health and supplies",
          "Bank valuable resources",
        ],
        currentStep: 1,
        createdAt: Date.now() - 1_000,
        goal: "Train and prepare safely",
      },
      memories: ["The nearby field has reliable training targets"],
      recentActionLog: [
        {
          tick: 41,
          action: "gather",
          result: "The authoritative request returned",
        },
      ],
      tickCounter: 42,
      lastAttemptedActionType: "gather",
      lastActionOutcome: "dispatched",
      lastAppliedActionType: "gather",
      lastAttemptedAt: appliedAt,
    });
    const checkpoint = await saveAgentAutonomyCheckpoint(db, {
      characterId: CHARACTER_ID,
      goal: { type: "smelting", description: "Reassess missing materials" },
      plan: {
        steps: [
          "Inspect authoritative inventory",
          "Gather any missing ore",
          "Retry only after live reassessment",
        ],
        currentStep: 0,
        createdAt: appliedAt,
        goal: "Reassess missing materials",
      },
      memories: ["The previous gather request entered the server pipeline"],
      recentActionLog: [
        {
          tick: 42,
          action: "smelt",
          result: "The authoritative subsystem rejected the attempt",
        },
      ],
      tickCounter: 43,
      lastAttemptedActionType: "smelt",
      lastActionOutcome: "rejected",
      lastAppliedActionType: null,
      // Deliberately simulate a regressed wall clock. Persistence must clamp
      // this to the prior durable timestamp rather than rejecting the context.
      lastAttemptedAt: appliedAt - 1,
    });
    emit({
      event: "saved",
      revision: checkpoint.revision,
      lastAttemptedAt: checkpoint.lastAttemptedAt,
    });
    await new Promise<never>(() => undefined);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function runRecoveryWorker(): Promise<void> {
  const connectionString = process.env.AUTONOMY_CHECKPOINT_DATABASE_URL;
  if (!connectionString) {
    throw new Error("autonomy checkpoint worker database is missing");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const checkpoint = await loadAgentAutonomyCheckpoint(db, CHARACTER_ID);
    if (!checkpoint) {
      throw new Error("replacement process did not find the checkpoint");
    }
    const instance = {
      config: { characterId: CHARACTER_ID },
      goal: null,
      pendingLlmResult: {
        action: { type: "attack", targetId: "stale-pre-kill-target" },
      },
    } as unknown as AgentInstance;
    hydrateAgentFromAutonomyCheckpoint(instance, checkpoint);
    emit({
      event: "recovered",
      revision: checkpoint.revision,
      pendingActionCleared: instance.pendingLlmResult === undefined,
      requiresFreshDecision: instance.autonomyRecoveryPending === true,
      goal: instance.goal?.description ?? null,
      planStep: instance.llmPlan?.currentStep ?? null,
      memoryCount: instance.memories?.length ?? 0,
      lastAttemptedActionType: checkpoint.lastAttemptedActionType,
      lastActionOutcome: checkpoint.lastActionOutcome,
      lastAppliedActionType: checkpoint.lastAppliedActionType,
      lastAttemptedAt: checkpoint.lastAttemptedAt,
    });
  } finally {
    await pool.end();
  }
}

async function docker(args: string[]): Promise<string> {
  const result = await execFileAsync(
    process.env.DOCKER_BIN?.trim() || "docker",
    args,
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return result.stdout.trim();
}

async function waitForPostgres(connectionString: string): Promise<pg.Pool> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString, max: 2 });
    try {
      await pool.query("SELECT 1");
      return pool;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(
    `temporary PostgreSQL did not become ready: ${String(lastError)}`,
  );
}

async function rejectsCheckConstraint(
  pool: pg.Pool,
  query: string,
  values: unknown[],
): Promise<boolean> {
  try {
    await pool.query(query, values);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23514"
    );
  }
}

function spawnWorker(
  mode: "save" | "recover",
  connectionString: string,
): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const child = spawn(process.execPath, [scriptPath, `--${mode}`], {
    env: {
      ...process.env,
      AUTONOMY_CHECKPOINT_DATABASE_URL: connectionString,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("autonomy checkpoint worker pipes were not created");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () =>
        reject(new Error(`autonomy checkpoint worker timed out: ${stderr}`)),
      20_000,
    );
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (["saved", "recovered", "error"].includes(parsed.event)) {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          // Runtime diagnostics may share stdout.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") return;
      clearTimeout(timer);
      reject(new Error(`worker exited ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, event };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("autonomy checkpoint worker did not exit")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-autonomy-checkpoint-${process.pid}`;
  const databaseUser = "autonomy_checkpoint_test";
  const databaseName = "autonomy_checkpoint_test";
  const databasePassword = `checkpoint-${randomUUID()}`;
  const image =
    process.env.AUTONOMY_CHECKPOINT_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  const workers: ChildProcess[] = [];
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-e",
      `POSTGRES_USER=${databaseUser}`,
      "-e",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      image,
    ]);
    containerStarted = true;
    const port = Number(
      (await docker(["port", containerName, "5432/tcp"])).split(":").pop(),
    );
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new Error("could not resolve temporary PostgreSQL port");
    }
    const connectionString = `postgresql://${databaseUser}:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/${databaseName}`;
    const readinessPool = await waitForPostgres(connectionString);
    await readinessPool.end();
    const initialized = await initializeDatabase(connectionString);
    pool = initialized.pool;
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, $2, $3, $4)`,
      [
        "autonomy-checkpoint-account",
        "Checkpoint Account",
        "agent",
        new Date().toISOString(),
      ],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name)
       VALUES
         ($1, $2, $3),
         ($4, $2, $5),
         ($6, $2, $7)`,
      [
        CHARACTER_ID,
        "autonomy-checkpoint-account",
        "Checkpoint Agent",
        LEGACY_CHARACTER_ID,
        "Legacy Checkpoint Agent",
        MALFORMED_LEGACY_CHARACTER_ID,
        "Malformed Legacy Checkpoint Agent",
      ],
    );

    // Reconstruct the v1 table shape inside this disposable database, seed one
    // valid and one malformed legacy advisory row, then exercise migration 0071
    // itself. This proves provenance is explicit and missing evidence is never
    // invented by the backfill.
    await pool.query(`
      ALTER TABLE agent_autonomy_checkpoints
        DROP CONSTRAINT IF EXISTS agent_autonomy_checkpoints_schema_version_check,
        DROP CONSTRAINT IF EXISTS agent_autonomy_checkpoints_timestamps_check,
        DROP CONSTRAINT IF EXISTS agent_autonomy_checkpoints_attempt_action_type_check,
        DROP CONSTRAINT IF EXISTS agent_autonomy_checkpoints_action_outcome_check,
        DROP CONSTRAINT IF EXISTS agent_autonomy_checkpoints_attempt_bundle_check,
        DROP CONSTRAINT IF EXISTS agent_autonomy_checkpoints_action_truth_check;
      ALTER TABLE agent_autonomy_checkpoints
        ALTER COLUMN schema_version SET DEFAULT 1,
        DROP COLUMN last_attempted_action_type,
        DROP COLUMN last_action_outcome,
        DROP COLUMN last_attempted_at;
      ALTER TABLE agent_autonomy_checkpoints
        ADD CONSTRAINT agent_autonomy_checkpoints_schema_version_check
          CHECK (schema_version = 1),
        ADD CONSTRAINT agent_autonomy_checkpoints_timestamps_check
          CHECK (
            updated_at >= 0
            AND (last_applied_at IS NULL OR (
              last_applied_at >= 0 AND last_applied_at <= updated_at
            ))
          );
      INSERT INTO agent_autonomy_checkpoints (
        character_id,
        schema_version,
        revision,
        goal,
        plan,
        memories,
        recent_action_log,
        tick_counter,
        last_applied_action_type,
        last_applied_at,
        requires_reassessment,
        updated_at
      ) VALUES
        (
          '${LEGACY_CHARACTER_ID}', 1, 3, NULL, NULL, '[]'::jsonb, '[]'::jsonb,
          7, 'gather', 1000, true, 1000
        ),
        (
          '${MALFORMED_LEGACY_CHARACTER_ID}', 1, 1, NULL, NULL, '[]'::jsonb,
          '[]'::jsonb, 0, 'smelt', NULL, true, 1001
        );
    `);
    const actionOutcomeMigration = await readFile(
      new URL(
        "../src/database/migrations/0071_add_agent_autonomy_action_outcomes.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(actionOutcomeMigration);
    const legacyRows = await pool.query<{
      character_id: string;
      schema_version: number;
      last_applied_action_type: string | null;
      last_applied_at: string | null;
      last_attempted_action_type: string | null;
      last_action_outcome: string | null;
      last_attempted_at: string | null;
    }>(
      `SELECT
         character_id,
         schema_version,
         last_applied_action_type,
         last_applied_at,
         last_attempted_action_type,
         last_action_outcome,
         last_attempted_at
       FROM agent_autonomy_checkpoints
       WHERE character_id IN ($1, $2)
       ORDER BY character_id`,
      [LEGACY_CHARACTER_ID, MALFORMED_LEGACY_CHARACTER_ID],
    );
    const legacy = legacyRows.rows.find(
      (row) => row.character_id === LEGACY_CHARACTER_ID,
    );
    const malformed = legacyRows.rows.find(
      (row) => row.character_id === MALFORMED_LEGACY_CHARACTER_ID,
    );
    if (
      legacy?.schema_version !== 2 ||
      legacy.last_applied_action_type !== "gather" ||
      legacy.last_applied_at !== "1000" ||
      legacy.last_attempted_action_type !== "gather" ||
      legacy.last_action_outcome !== "legacy_unknown" ||
      legacy.last_attempted_at !== "1000" ||
      malformed?.schema_version !== 2 ||
      malformed.last_applied_action_type !== null ||
      malformed.last_applied_at !== null ||
      malformed.last_attempted_action_type !== null ||
      malformed.last_action_outcome !== null ||
      malformed.last_attempted_at !== null
    ) {
      throw new Error(
        `legacy outcome migration was not provenance-safe: ${JSON.stringify(legacyRows.rows)}`,
      );
    }

    // The runtime checkpoint writer is schema v3. The legacy assertions above
    // intentionally stop at v2 so they can inspect migration 0071 directly;
    // advance the disposable database through the immediately following
    // checkpoint-version migration before exercising the current writer.
    const progressionMigration = await readFile(
      new URL(
        "../src/database/migrations/0072_add_agent_autonomy_progression_events.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(progressionMigration);

    const writer = spawnWorker("save", connectionString);
    workers.push(writer.child);
    const saved = await writer.event;
    if (saved.event !== "saved" || saved.revision !== 2) {
      throw new Error(`checkpoint write failed: ${JSON.stringify(saved)}`);
    }
    writer.child.kill("SIGKILL");
    await waitForExit(writer.child);

    const replacement = spawnWorker("recover", connectionString);
    workers.push(replacement.child);
    const recovered = await replacement.event;
    await waitForExit(replacement.child);
    if (
      recovered.event !== "recovered" ||
      recovered.revision !== 2 ||
      recovered.pendingActionCleared !== true ||
      recovered.requiresFreshDecision !== true ||
      recovered.goal !== "Reassess missing materials" ||
      recovered.planStep !== 0 ||
      recovered.memoryCount !== 1 ||
      recovered.lastAttemptedActionType !== "smelt" ||
      recovered.lastActionOutcome !== "rejected" ||
      recovered.lastAppliedActionType !== "gather" ||
      recovered.lastAttemptedAt !== saved.lastAttemptedAt
    ) {
      throw new Error(
        `replacement process recovered unsafe context: ${JSON.stringify(recovered)}`,
      );
    }

    await pool.query(actionOutcomeMigration);
    await pool.query(progressionMigration);
    const reapplied = await pool.query<{
      revision: string;
      last_applied_action_type: string | null;
      last_attempted_action_type: string | null;
      last_action_outcome: string | null;
    }>(
      `SELECT
         revision,
         last_applied_action_type,
         last_attempted_action_type,
         last_action_outcome
       FROM agent_autonomy_checkpoints
       WHERE character_id = $1`,
      [CHARACTER_ID],
    );
    if (
      reapplied.rows[0]?.revision !== "2" ||
      reapplied.rows[0].last_applied_action_type !== "gather" ||
      reapplied.rows[0].last_attempted_action_type !== "smelt" ||
      reapplied.rows[0].last_action_outcome !== "rejected"
    ) {
      throw new Error(
        `migration reapply changed action truth: ${JSON.stringify(reapplied.rows)}`,
      );
    }

    const falseCompletedOutcomeRejected = await rejectsCheckConstraint(
      pool,
      `UPDATE agent_autonomy_checkpoints
       SET
         last_action_outcome = 'completed',
         last_applied_action_type = NULL,
         last_applied_at = NULL
       WHERE character_id = $1`,
      [CHARACTER_ID],
    );
    const unknownOutcomeRejected = await rejectsCheckConstraint(
      pool,
      `UPDATE agent_autonomy_checkpoints
       SET last_action_outcome = 'pretended_success'
       WHERE character_id = $1`,
      [CHARACTER_ID],
    );
    const incompleteAttemptRejected = await rejectsCheckConstraint(
      pool,
      `UPDATE agent_autonomy_checkpoints
       SET last_attempted_at = NULL
       WHERE character_id = $1`,
      [CHARACTER_ID],
    );
    if (
      !falseCompletedOutcomeRejected ||
      !unknownOutcomeRejected ||
      !incompleteAttemptRejected
    ) {
      throw new Error("database accepted contradictory action outcome truth");
    }

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'agent_autonomy_checkpoints'`,
    );
    const columnNames = new Set(columns.rows.map((row) => row.column_name));
    for (const forbidden of ["pending_action", "action_payload", "target_id"]) {
      if (columnNames.has(forbidden)) {
        throw new Error(`replayable checkpoint column exists: ${forbidden}`);
      }
    }

    let falseRecoveryFlagRejected = false;
    try {
      await pool.query(
        `UPDATE agent_autonomy_checkpoints
         SET requires_reassessment = false
         WHERE character_id = $1`,
        [CHARACTER_ID],
      );
    } catch (error) {
      falseRecoveryFlagRejected =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514";
    }
    if (!falseRecoveryFlagRejected) {
      throw new Error("database accepted a replayable recovery flag");
    }

    process.stdout.write(
      `${JSON.stringify({
        writerProcessKilledAfterCommit: true,
        replacementRecoveredExactContext: true,
        pendingActionCleared: true,
        freshDecisionRequired: true,
        replayableColumnsAbsent: true,
        databaseEnforcesReassessment: true,
        legacyOutcomeMarkedUnknown: true,
        malformedLegacyEvidenceNotInvented: true,
        regressedWallClockClampedMonotonically: true,
        populatedMigrationReapplyPreservedTruth: true,
        databaseRejectedFalseCompletedOutcome: true,
        databaseRejectedUnknownOutcome: true,
        databaseRejectedIncompleteAttempt: true,
        rejectedAttemptDidNotOverwriteLastAppliedAction: true,
        recoveredAttemptedActionType: recovered.lastAttemptedActionType,
        recoveredActionOutcome: recovered.lastActionOutcome,
        recoveredLastAppliedActionType: recovered.lastAppliedActionType,
        recoveredRevision: recovered.revision,
      })}\n`,
    );
  } finally {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
    }
    await closeDatabase().catch(() => undefined);
    if (containerStarted) {
      await docker(["stop", "--time", "1", containerName]).catch(
        () => undefined,
      );
    }
  }
}

try {
  if (process.argv.includes("--save")) await runSaveWorker();
  else if (process.argv.includes("--recover")) await runRecoveryWorker();
  else await runParent();
} catch (error) {
  if (process.argv.some((argument) => argument.startsWith("--"))) {
    emit({
      event: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  throw error;
}
