import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  DUEL_PREPARATION_BANK_ACTIONS,
  PostgresDuelPreparationStore,
} from "../src/systems/StreamingDuelScheduler/preparation.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../src/systems/StreamingDuelScheduler/competitive-tactical-strategy.js";

const { Pool } = pg;
const DATABASE_URL_ENV =
  "DUEL_PREPARATION_UNAVAILABILITY_TEST_DATABASE_URL" as const;
const CHILD_MODE_ENV = "DUEL_PREPARATION_UNAVAILABILITY_CHILD_MODE" as const;
const PREPARATION_ID_ENV =
  "DUEL_PREPARATION_UNAVAILABILITY_PREPARATION_ID" as const;
const AGENT_ID_ENV = "DUEL_PREPARATION_UNAVAILABILITY_AGENT_ID" as const;
const FENCING_TOKEN_ENV =
  "DUEL_PREPARATION_UNAVAILABILITY_FENCING_TOKEN" as const;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

type ChildMode = "report-and-hold" | "replay-report" | "cancel-report";

type ChildResult = {
  mode: Exclude<ChildMode, "report-and-hold">;
  preparationId: string;
  agentId: string;
  reason: string;
  reportedAt: number;
  cancellationStatus?: string;
  cancellationReason?: string | null;
  cancellationVersion?: number;
};

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const planEvidence = (agentId: string) => ({
  primaryStyle: "melee" as const,
  availableStyles: ["melee" as const],
  planningSource: "deterministic" as const,
  planningPolicyVersion: "unavailability-process-kill-v1",
  agentPolicyFingerprint: "ab".repeat(32),
  modelProvider: "process-kill-test",
  model: agentId,
  tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy("melee"),
});

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function runChild(mode: ChildMode): Promise<void> {
  const connectionString = requireEnv(DATABASE_URL_ENV);
  const preparationId = requireEnv(PREPARATION_ID_ENV);
  const agentId = requireEnv(AGENT_ID_ENV);
  const fencingToken = requireEnv(FENCING_TOKEN_ENV);
  const pool = new Pool({ connectionString, max: 2 });
  try {
    const store = new PostgresDuelPreparationStore(pool);
    if (mode === "report-and-hold") {
      const report = await store.reportContestantUnavailable({
        preparationId,
        agentId,
      });
      assert(report, "reporting child did not persist unavailability");
      // The parent observes the committed row directly and kills this process
      // before it can return an acknowledgement to its caller.
      await new Promise<never>(() => undefined);
    }

    const report = await store.reportContestantUnavailable({
      preparationId,
      agentId,
    });
    assert(report, `${mode} did not recover the committed report`);
    const result: ChildResult = {
      mode,
      ...report,
    };
    if (mode === "cancel-report") {
      const cancelled = await store.cancel({
        preparationId,
        fencingToken,
        reason: "agent_preparation_failed",
      });
      assert(cancelled, "scheduler child did not cancel the reported session");
      result.cancellationStatus = cancelled.status;
      result.cancellationReason = cancelled.cancellationReason;
      result.cancellationVersion = cancelled.version;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

function spawnChild(
  mode: ChildMode,
  input: {
    connectionString: string;
    preparationId: string;
    agentId: string;
    fencingToken: string;
  },
): ChildProcess {
  return spawn(process.execPath, [SCRIPT_PATH], {
    env: {
      ...process.env,
      [DATABASE_URL_ENV]: input.connectionString,
      [CHILD_MODE_ENV]: mode,
      [PREPARATION_ID_ENV]: input.preparationId,
      [AGENT_ID_ENV]: input.agentId,
      [FENCING_TOKEN_ENV]: input.fencingToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function collectChild(child: ChildProcess): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert(
    exit.code === 0 && exit.signal === null,
    `child failed: mode=${process.env[CHILD_MODE_ENV] ?? "unknown"} code=${exit.code} signal=${exit.signal} stderr=${stderr.trim()}`,
  );
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert(lines.length === 1, `child emitted unexpected output: ${stdout}`);
  return JSON.parse(lines[0]!) as ChildResult;
}

async function waitForCommittedReport(
  pool: pg.Pool,
  preparationId: string,
  timeoutMs: number,
): Promise<{ reportedAt: number; version: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{
      reportedAt: string;
      version: number;
    }>(
      `SELECT report."reportedAt"::text AS "reportedAt", preparation.version
         FROM streaming_duel_preparation_unavailability_reports AS report
         JOIN streaming_duel_preparations AS preparation
           ON preparation."preparationId" = report."preparationId"
        WHERE report."preparationId" = $1`,
      [preparationId],
    );
    if (result.rows[0]) {
      return {
        reportedAt: Number(result.rows[0].reportedAt),
        version: Number(result.rows[0].version),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for committed unavailability report");
}

async function expectAppendOnlyRejection(
  operation: () => Promise<unknown>,
): Promise<string> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes("append-only"),
      `unexpected mutation error: ${message}`,
    );
    return message;
  }
  throw new Error("append-only mutation unexpectedly succeeded");
}

async function runParent(): Promise<void> {
  const connectionString = requireEnv(DATABASE_URL_ENV);
  const pool = new Pool({ connectionString, max: 5 });
  const runId = randomUUID();
  const preparationId = randomUUID();
  const agent1Id = `unavailable-alpha-${runId}`;
  const agent2Id = `unavailable-beta-${runId}`;
  const agent3Id = `unavailable-outsider-${runId}`;
  const account1Id = `unavailable-account-alpha-${runId}`;
  const account2Id = `unavailable-account-beta-${runId}`;
  const account3Id = `unavailable-account-outsider-${runId}`;
  const fencingToken = "711";
  let killedReporter: ChildProcess | null = null;
  try {
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, 'Unavailable Alpha', '[]', '2026-08-28T00:00:00.000Z'),
              ($2, 'Unavailable Beta', '[]', '2026-08-28T00:00:00.000Z'),
              ($3, 'Unavailable Outsider', '[]', '2026-08-28T00:00:00.000Z')`,
      [account1Id, account2Id, account3Id],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name)
       VALUES ($1, $4, 'Unavailable Alpha'),
              ($2, $5, 'Unavailable Beta'),
              ($3, $6, 'Unavailable Outsider')`,
      [agent1Id, agent2Id, agent3Id, account1Id, account2Id, account3Id],
    );
    await pool.query(
      `INSERT INTO agent_mappings (
         agent_id, account_id, character_id, agent_name,
         streaming_duel_enabled, created_at, updated_at
       ) VALUES
         ($1, $4, $1, 'Unavailable Alpha', true, NOW(), NOW()),
         ($2, $5, $2, 'Unavailable Beta', true, NOW(), NOW()),
         ($3, $6, $3, 'Unavailable Outsider', true, NOW(), NOW())`,
      [agent1Id, agent2Id, agent3Id, account1Id, account2Id, account3Id],
    );

    const store = new PostgresDuelPreparationStore(pool);
    const preparation = await store.create({
      preparationId,
      fencingToken,
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    const hostOwnerId = randomUUID();
    for (const agentId of [agent1Id, agent2Id]) {
      const lease = await store.claimContestantHostLease({
        preparationId,
        agentId,
        ownerId: hostOwnerId,
        leaseDurationMs: 60_000,
      });
      assert(lease, `setup did not claim host lease for ${agentId}`);
    }
    await store.markReady({
      preparationId,
      fencingToken,
      agentId: agent1Id,
      planEvidence: planEvidence(agent1Id),
    });
    const ready = await store.markReady({
      preparationId,
      fencingToken,
      agentId: agent2Id,
      planEvidence: planEvidence(agent2Id),
    });
    assert(
      ready?.status === "ready" && ready.version === 3,
      "setup did not reach ready v3",
    );
    const beforeClock = await pool.query<{ now: string }>(
      `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS now`,
    );

    const childInput = {
      connectionString,
      preparationId,
      agentId: agent1Id,
      fencingToken,
    };
    killedReporter = spawnChild("report-and-hold", childInput);
    let killedStdout = "";
    killedReporter.stdout?.setEncoding("utf8");
    killedReporter.stdout?.on("data", (chunk: string) => {
      killedStdout += chunk;
    });
    const committed = await waitForCommittedReport(pool, preparationId, 10_000);
    assert(committed.version === 4, "report did not fence preparation at v4");
    assert(killedReporter.kill("SIGKILL"), "could not SIGKILL reporting child");
    const killedExit = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      killedReporter!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert(
      killedExit.signal === "SIGKILL" && killedStdout.length === 0,
      "reporting child acknowledged before the forced process loss",
    );
    killedReporter = null;

    const replay = await collectChild(spawnChild("replay-report", childInput));
    assert(
      replay.preparationId === preparationId &&
        replay.agentId === agent1Id &&
        replay.reason === "agent_unavailable" &&
        replay.reportedAt === committed.reportedAt,
      "replacement reporter did not recover the exact committed report",
    );
    assert(
      (await store.reportContestantUnavailable({
        preparationId,
        agentId: agent3Id,
      })) === null,
      "non-contestant report was accepted",
    );
    assert(
      (
        await store.authorizeBankAccess({
          preparationId,
          playerId: agent2Id,
          action: "open",
        })
      ).ok === false,
      "bank access survived the report fence",
    );
    assert(
      (await store.markReady({
        preparationId,
        fencingToken,
        agentId: agent2Id,
        planEvidence: planEvidence(agent2Id),
      })) === null,
      "readiness replay survived the report fence",
    );
    assert(
      (await store.freeze({ preparationId, fencingToken })) === null,
      "preparation froze after unavailability was committed",
    );

    const cancellation = await collectChild(
      spawnChild("cancel-report", childInput),
    );
    assert(
      cancellation.cancellationStatus === "cancelled" &&
        cancellation.cancellationReason === "agent_preparation_failed" &&
        cancellation.cancellationVersion === 5,
      "replacement scheduler did not apply the exact fenced cancellation",
    );
    assert(
      (await store.reportContestantUnavailable({
        preparationId,
        agentId: agent2Id,
      })) === null,
      "a new report was accepted after cancellation",
    );

    const afterClock = await pool.query<{ now: string }>(
      `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS now`,
    );
    const inspection = await pool.query<{
      status: string;
      cancellationReason: string | null;
      version: number;
      reportCount: string;
      snapshotCount: string;
    }>(
      `SELECT preparation.status,
              preparation."cancellationReason",
              preparation.version,
              (SELECT count(*)::text
                 FROM streaming_duel_preparation_unavailability_reports
                WHERE "preparationId" = preparation."preparationId") AS "reportCount",
              (SELECT count(*)::text
                 FROM streaming_duel_competitive_snapshots
                WHERE "preparationId" = preparation."preparationId") AS "snapshotCount"
         FROM streaming_duel_preparations AS preparation
        WHERE preparation."preparationId" = $1`,
      [preparationId],
    );
    const finalState = inspection.rows[0];
    assert(
      finalState?.status === "cancelled" &&
        finalState.cancellationReason === "agent_preparation_failed" &&
        finalState.version === 5 &&
        finalState.reportCount === "1" &&
        finalState.snapshotCount === "0",
      "final preparation/report/snapshot state diverged",
    );
    const transitionResult = await pool.query<{
      eventType: string;
      preparationVersion: number;
    }>(
      `SELECT "eventType", "preparationVersion"
         FROM streaming_duel_transition_events
        WHERE "preparationId" = $1
        ORDER BY "eventSequence" ASC`,
      [preparationId],
    );
    assert(
      JSON.stringify(transitionResult.rows) ===
        JSON.stringify([
          { eventType: "preparation_selected", preparationVersion: 1 },
          { eventType: "contestant_ready", preparationVersion: 2 },
          { eventType: "contestant_ready", preparationVersion: 3 },
          { eventType: "preparation_cancelled", preparationVersion: 5 },
        ]),
      "durable transition history did not preserve the report fence",
    );
    const updateRejection = await expectAppendOnlyRejection(() =>
      pool.query(
        `UPDATE streaming_duel_preparation_unavailability_reports
            SET "reportedAt" = 0
          WHERE "preparationId" = $1`,
        [preparationId],
      ),
    );
    const deleteRejection = await expectAppendOnlyRejection(() =>
      pool.query(
        `DELETE FROM streaming_duel_preparation_unavailability_reports
          WHERE "preparationId" = $1`,
        [preparationId],
      ),
    );
    const truncateRejection = await expectAppendOnlyRejection(() =>
      pool.query(`TRUNCATE streaming_duel_preparation_unavailability_reports`),
    );

    const before = Number(beforeClock.rows[0]?.now);
    const after = Number(afterClock.rows[0]?.now);
    assert(
      Number.isSafeInteger(before) &&
        Number.isSafeInteger(after) &&
        committed.reportedAt >= before &&
        committed.reportedAt <= after,
      "report timestamp was not authored inside the observed database window",
    );

    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        preparationId,
        report: {
          agentId: agent1Id,
          reason: replay.reason,
          reportedAt: replay.reportedAt,
          rowCount: Number(finalState.reportCount),
          databaseTimestampBounded: true,
          appendOnlyUpdateRejected: updateRejection.includes("append-only"),
          appendOnlyDeleteRejected: deleteRejection.includes("append-only"),
          appendOnlyTruncateRejected: truncateRejection.includes("append-only"),
        },
        processRecovery: {
          reporterKilledAfterCommitBeforeAcknowledgement: true,
          reporterSignal: killedExit.signal,
          replacementReplayExact: true,
          replacementSchedulerProcess: true,
        },
        fences: {
          bankAccessRejected: true,
          readinessRejected: true,
          freezeRejected: true,
          competitiveSnapshotCount: Number(finalState.snapshotCount),
        },
        terminal: {
          status: finalState.status,
          cancellationReason: finalState.cancellationReason,
          preparationVersion: finalState.version,
          transitionVersions: transitionResult.rows.map(
            (row) => row.preparationVersion,
          ),
        },
      })}\n`,
    );
  } finally {
    if (killedReporter && !killedReporter.killed) {
      killedReporter.kill("SIGKILL");
    }
    await pool.end();
  }
}

const childMode = process.env[CHILD_MODE_ENV] as ChildMode | undefined;
if (childMode) {
  assert(
    ["report-and-hold", "replay-report", "cancel-report"].includes(childMode),
    `invalid ${CHILD_MODE_ENV}`,
  );
  await runChild(childMode);
} else {
  await runParent();
}
