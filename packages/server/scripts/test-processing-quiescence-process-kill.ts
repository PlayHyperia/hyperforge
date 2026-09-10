import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import { StreamingDuelScheduler } from "../src/systems/StreamingDuelScheduler/index.js";
import {
  AGENT_IDS,
  docker,
  schedulerInternals,
  seedAgents,
  startWorkerRuntime,
  stopWorkerRuntime,
  waitFor,
  waitForPostgres,
  type WorkerRuntime,
} from "./test-agent-duel-cycle-process-kill.js";

const scriptPath = fileURLToPath(import.meta.url);
const OPERATION_ID = "processing-action:pre-market-quiescence-chaos:v1";
const OPERATION_INPUT = Object.freeze({
  skill: "cooking" as const,
  xpAmount: 1,
  inputs: [{ itemId: "lobster", quantity: 1 }],
  requiredItems: [],
  consumables: [],
  outputs: [{ itemId: "bronze_arrow", quantity: 1 }],
  coinCost: 0,
});

type WorkerEvent = {
  event: "committed_blocked" | "replacement_frozen" | "error";
  operationId?: string;
  preparationId?: string;
  cycleId?: string;
  snapshotDigest?: string;
  requestCount?: number;
  replayed?: boolean;
  snapshotEquippedBronzeArrows?: number;
  bankedBronzeArrows?: number;
  totalBronzeArrows?: number;
  message?: string;
};

class DurableReceiptBarrier {
  private pending = true;
  readonly requests: string[] = [];

  requestPlayerProcessingQuiescence(playerId: string): void {
    this.requests.push(playerId);
  }

  isPlayerProcessingQuiescent(_playerId: string): boolean {
    return !this.pending;
  }

  settle(): void {
    this.pending = false;
  }

  hasRequestedBothContestants(): boolean {
    return AGENT_IDS.every((agentId) => this.requests.includes(agentId));
  }
}

function emit(event: WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function clearSchedulerTick(scheduler: StreamingDuelScheduler): void {
  const internal = schedulerInternals(scheduler);
  if (!internal.tickInterval) return;
  clearInterval(internal.tickInterval);
  internal.tickInterval = null;
}

async function driveReadyPreparationToBarrier(
  runtime: WorkerRuntime,
  scheduler: StreamingDuelScheduler,
  barrier: DurableReceiptBarrier,
): Promise<{ preparationId: string }> {
  const internal = schedulerInternals(scheduler);
  await waitFor(
    () => scheduler.getOperationalMetrics().current.availableAgents === 2,
    "two persisted quiescence contestants",
  );
  try {
    await waitFor(async () => {
      const ready = await runtime.pool.query<{ preparationId: string }>(
        `SELECT "preparationId"
           FROM streaming_duel_preparations
          WHERE status = 'ready'
            AND "agent1PlanEvidence" IS NOT NULL
            AND "agent2PlanEvidence" IS NOT NULL
          ORDER BY "selectedAt" DESC
          LIMIT 1`,
      );
      if (ready.rows[0]?.preparationId) return true;
      if (!internal.preparationIdleCheckInFlight) {
        void internal.advancePrivatePreparationGate(Date.now());
      }
      return false;
    }, "durable preparation readiness before processing barrier");
  } catch (error) {
    const preparations = await runtime.pool.query<{
      preparationId: string;
      status: string;
      cancellationReason: string | null;
      agent1Ready: boolean;
      agent2Ready: boolean;
    }>(
      `SELECT "preparationId", status, "cancellationReason",
              ("agent1PlanEvidence" IS NOT NULL) AS "agent1Ready",
              ("agent2PlanEvidence" IS NOT NULL) AS "agent2Ready"
         FROM streaming_duel_preparations
        ORDER BY "selectedAt" DESC
        LIMIT 5`,
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify({ preparations: preparations.rows, metrics: scheduler.getOperationalMetrics().current, gateInFlight: internal.preparationIdleCheckInFlight })}`,
    );
  }

  await waitFor(() => {
    if (barrier.hasRequestedBothContestants()) return true;
    if (!internal.preparationIdleCheckInFlight) {
      void internal.advancePrivatePreparationGate(Date.now());
    }
    return false;
  }, "selected-pair processing quiescence request");

  const ready = await runtime.pool.query<{ preparationId: string }>(
    `SELECT "preparationId"
       FROM streaming_duel_preparations
      WHERE status = 'ready'
      ORDER BY "selectedAt" DESC
      LIMIT 1`,
  );
  const preparationId = ready.rows[0]?.preparationId;
  if (!preparationId) {
    throw new Error("processing barrier lost its ready preparation");
  }
  if (scheduler.getCurrentCycle() !== null) {
    throw new Error("processing barrier published a cycle before settlement");
  }
  return { preparationId };
}

async function runCommitWorker(): Promise<void> {
  const connectionString = process.env.PROCESSING_QUIESCENCE_CHAOS_DATABASE_URL;
  if (!connectionString) {
    throw new Error("processing quiescence commit worker URL is missing");
  }
  const runtime = await startWorkerRuntime(connectionString);
  const barrier = new DurableReceiptBarrier();
  runtime.systems.set("processing", barrier);
  const scheduler = new StreamingDuelScheduler(runtime.world, {
    fencingToken: "1",
  });
  scheduler.init();
  clearSchedulerTick(scheduler);
  const { preparationId } = await driveReadyPreparationToBarrier(
    runtime,
    scheduler,
    barrier,
  );

  const receipt = await runtime.inventorySystem.commitProcessingActionAtomic(
    AGENT_IDS[0],
    OPERATION_ID,
    OPERATION_INPUT,
  );
  if (!receipt.ok || !receipt.committed) {
    throw new Error(
      `processing action did not commit before kill: ${JSON.stringify(receipt)}`,
    );
  }
  const snapshotCount = await runtime.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM streaming_duel_competitive_snapshots`,
  );
  if (snapshotCount.rows[0]?.count !== "0") {
    throw new Error(
      `market snapshot appeared while receipt remained unsettled: ${JSON.stringify(snapshotCount.rows)}`,
    );
  }

  emit({
    event: "committed_blocked",
    operationId: OPERATION_ID,
    preparationId,
    requestCount: barrier.requests.length,
    replayed: receipt.replayed,
  });
  await new Promise<never>(() => undefined);
}

async function runReplacementWorker(): Promise<void> {
  const connectionString = process.env.PROCESSING_QUIESCENCE_CHAOS_DATABASE_URL;
  if (!connectionString) {
    throw new Error("processing quiescence replacement worker URL is missing");
  }
  const runtime = await startWorkerRuntime(connectionString);
  const barrier = new DurableReceiptBarrier();
  runtime.systems.set("processing", barrier);
  const scheduler = new StreamingDuelScheduler(runtime.world, {
    fencingToken: "2",
  });
  let evidence: WorkerEvent | null = null;
  try {
    scheduler.init();
    clearSchedulerTick(scheduler);
    const { preparationId } = await driveReadyPreparationToBarrier(
      runtime,
      scheduler,
      barrier,
    );

    const receipt = await runtime.inventorySystem.commitProcessingActionAtomic(
      AGENT_IDS[0],
      OPERATION_ID,
      OPERATION_INPUT,
    );
    if (!receipt.ok || !receipt.committed || !receipt.replayed) {
      throw new Error(
        `replacement did not replay exact processing receipt: ${JSON.stringify(receipt)}`,
      );
    }
    barrier.settle();
    await waitFor(
      () => scheduler.getCurrentCycle()?.phase === "ANNOUNCEMENT",
      "replacement competitive freeze after processing replay",
    );
    const cycle = scheduler.getCurrentCycle();
    if (
      !cycle?.competitiveSnapshot?.persisted ||
      !cycle.competitiveSnapshotDigest ||
      cycle.competitiveSnapshot.preparationId !== preparationId
    ) {
      throw new Error("replacement did not freeze the exact ready preparation");
    }
    const alpha = cycle.competitiveSnapshot.contestants.find(
      (contestant) => contestant.agentId === AGENT_IDS[0],
    );
    const snapshotInventoryBronzeArrows =
      alpha?.inventory
        .filter((item) => item.itemId === "bronze_arrow")
        .reduce((total, item) => total + item.quantity, 0) ?? 0;
    const snapshotEquippedBronzeArrows =
      alpha?.equipment.find((item) => item.slot === "arrows")?.quantity ?? 0;
    const custody = await runtime.pool.query<{
      custody: string;
      itemId: string;
      quantity: number;
    }>(
      `SELECT 'inventory'::text AS custody, "itemId", quantity
         FROM inventory WHERE "playerId" = $1
       UNION ALL
       SELECT 'equipment'::text AS custody, "itemId", quantity
         FROM equipment WHERE "playerId" = $1
       UNION ALL
       SELECT 'bank'::text AS custody, "itemId", quantity
         FROM bank_storage WHERE "playerId" = $1
       ORDER BY custody, "itemId", quantity`,
      [AGENT_IDS[0]],
    );
    const bankedBronzeArrows = custody.rows
      .filter((row) => row.custody === "bank" && row.itemId === "bronze_arrow")
      .reduce((total, row) => total + row.quantity, 0);
    const totalBronzeArrows = custody.rows
      .filter((row) => row.itemId === "bronze_arrow")
      .reduce((total, row) => total + row.quantity, 0);
    if (
      snapshotInventoryBronzeArrows !== 0 ||
      snapshotEquippedBronzeArrows !== 50 ||
      bankedBronzeArrows !== 51 ||
      totalBronzeArrows !== 101
    ) {
      throw new Error(
        `replacement snapshot/custody omitted the committed processing result: ${JSON.stringify({ snapshotInventoryBronzeArrows, snapshotEquippedBronzeArrows, bankedBronzeArrows, totalBronzeArrows, snapshotInventory: alpha?.inventory, snapshotEquipment: alpha?.equipment, custody: custody.rows })}`,
      );
    }
    evidence = {
      event: "replacement_frozen",
      operationId: OPERATION_ID,
      preparationId,
      cycleId: cycle.cycleId,
      snapshotDigest: cycle.competitiveSnapshotDigest,
      requestCount: barrier.requests.length,
      replayed: receipt.replayed,
      snapshotEquippedBronzeArrows,
      bankedBronzeArrows,
      totalBronzeArrows,
    };
  } finally {
    scheduler.destroy("scheduler_shutdown");
    await scheduler.waitForShutdownCleanup().catch(() => undefined);
    await stopWorkerRuntime(runtime);
  }
  if (!evidence) throw new Error("replacement evidence was not created");
  emit(evidence);
}

function spawnWorker(
  mode: "commit" | "replacement",
  connectionString: string,
): { child: ChildProcess; event: Promise<WorkerEvent>; stderr: string[] } {
  const child = spawn(process.execPath, [scriptPath, `--${mode}`], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      STREAMING_DUEL_ENABLED: "true",
      STREAMING_DUEL_PREPARATION_MS: "60000",
      STREAMING_PERSIST_STATS: "false",
      STREAMING_AGENT_SKIP_DB_LOAD: "false",
      STREAMING_DUEL_COMBAT_AI_ENABLED: "true",
      EMBEDDED_AGENT_DUEL_PREPARATION_LLM: "false",
      STREAMING_ANNOUNCEMENT_MS: "15000",
      STREAMING_COUNTDOWN_TICKS: "1",
      STREAMING_FIGHTING_MS: "5000",
      PROCESSING_QUIESCENCE_CHAOS_DATABASE_URL: connectionString,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("processing quiescence worker pipes were not created");
  }
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `processing quiescence worker timed out: ${stderr.join("")}`,
          ),
        ),
      90_000,
    );
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (
            parsed.event === "committed_blocked" ||
            parsed.event === "replacement_frozen"
          ) {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
          if (parsed.event === "error") {
            clearTimeout(timer);
            reject(
              new Error(
                `${parsed.message ?? "worker failed"}${stderr.length > 0 ? `; stderr=${stderr.join("")}` : ""}`,
              ),
            );
            return;
          }
        } catch {
          // Runtime diagnostics share stdout; only explicit JSON events count.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (signal === "SIGKILL") return;
      if (code === 0) return;
      clearTimeout(timer);
      reject(
        new Error(
          `processing quiescence worker exited ${code ?? signal}: ${stderr.join("")}`,
        ),
      );
    });
  });
  return { child, event, stderr };
}

async function waitForExit(
  child: ChildProcess,
  stderr: readonly string[] = [],
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `processing quiescence worker did not exit: ${stderr.join("")}`,
          ),
        ),
      15_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-processing-quiescence-chaos-${process.pid}`;
  const databaseUser = "processing_quiescence_test";
  const databaseName = "processing_quiescence_test";
  const databasePassword = `processing-quiescence-${randomUUID()}`;
  const image =
    process.env.PROCESSING_QUIESCENCE_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  const workers: ChildProcess[] = [];
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(
        `Docker is required for processing quiescence chaos: ${String(error)}`,
      );
    });
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
    const portOutput = await docker(["port", containerName, "5432/tcp"]);
    const port = Number(portOutput.split(":").pop());
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new Error(
        "could not resolve processing quiescence PostgreSQL port",
      );
    }
    const connectionString = `postgresql://${databaseUser}:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/${databaseName}`;
    pool = await waitForPostgres(connectionString);
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
    await seedAgents(drizzle(pool, { schema }));

    const commitWorker = spawnWorker("commit", connectionString);
    workers.push(commitWorker.child);
    const committed = await commitWorker.event;
    if (
      committed.event !== "committed_blocked" ||
      committed.operationId !== OPERATION_ID ||
      !committed.preparationId ||
      committed.requestCount !== 2
    ) {
      throw new Error(
        `commit worker evidence is invalid: ${JSON.stringify(committed)}`,
      );
    }
    const beforeKill = await pool.query<{
      operationCount: string;
      snapshotCount: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM operations_log
           WHERE id = $1 AND "operationType" = 'processing_action' AND completed = true)
           AS "operationCount",
         (SELECT count(*)::text FROM streaming_duel_competitive_snapshots)
           AS "snapshotCount"`,
      [OPERATION_ID],
    );
    if (
      beforeKill.rows[0]?.operationCount !== "1" ||
      beforeKill.rows[0]?.snapshotCount !== "0"
    ) {
      throw new Error(
        `durable receipt/market boundary drifted before kill: ${JSON.stringify(beforeKill.rows)}`,
      );
    }
    if (!commitWorker.child.kill("SIGKILL")) {
      throw new Error("failed to kill processing quiescence authority");
    }
    await waitForExit(commitWorker.child, commitWorker.stderr);
    if (commitWorker.child.signalCode !== "SIGKILL") {
      throw new Error(
        `processing quiescence authority exited without SIGKILL: ${commitWorker.child.signalCode}`,
      );
    }

    const afterKill = await pool.query<{
      operationCount: string;
      snapshotCount: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM operations_log
           WHERE id = $1 AND "operationType" = 'processing_action' AND completed = true)
           AS "operationCount",
         (SELECT count(*)::text FROM streaming_duel_competitive_snapshots)
           AS "snapshotCount"`,
      [OPERATION_ID],
    );
    if (
      afterKill.rows[0]?.operationCount !== "1" ||
      afterKill.rows[0]?.snapshotCount !== "0"
    ) {
      throw new Error(
        `kill changed durable receipt or opened a market: ${JSON.stringify(afterKill.rows)}`,
      );
    }

    const replacementWorker = spawnWorker("replacement", connectionString);
    workers.push(replacementWorker.child);
    const replacement = await replacementWorker.event;
    const preparationStates = await pool.query<{
      preparationId: string;
      status: string;
      cancellationReason: string | null;
    }>(
      `SELECT "preparationId", status, "cancellationReason"
         FROM streaming_duel_preparations
        WHERE "preparationId" = ANY($1::text[])
        ORDER BY "selectedAt"`,
      [[committed.preparationId, replacement.preparationId]],
    );
    const originalPreparation = preparationStates.rows.find(
      (row) => row.preparationId === committed.preparationId,
    );
    const replacementPreparation = preparationStates.rows.find(
      (row) => row.preparationId === replacement.preparationId,
    );
    if (
      replacement.event !== "replacement_frozen" ||
      replacement.operationId !== OPERATION_ID ||
      replacement.preparationId === committed.preparationId ||
      !replacement.cycleId ||
      !replacement.snapshotDigest ||
      replacement.requestCount !== 2 ||
      replacement.replayed !== true ||
      replacement.snapshotEquippedBronzeArrows !== 50 ||
      replacement.bankedBronzeArrows !== 51 ||
      replacement.totalBronzeArrows !== 101 ||
      originalPreparation?.status !== "cancelled" ||
      !originalPreparation.cancellationReason ||
      replacementPreparation?.status !== "frozen"
    ) {
      throw new Error(
        `replacement evidence is invalid: ${JSON.stringify({ committed, replacement, preparationStates: preparationStates.rows })}`,
      );
    }
    await waitForExit(replacementWorker.child, replacementWorker.stderr);

    const finalState = await pool.query<{
      operationCount: string;
      snapshotCount: string;
      digest: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM operations_log
           WHERE id = $1 AND "operationType" = 'processing_action' AND completed = true)
           AS "operationCount",
         (SELECT count(*)::text FROM streaming_duel_competitive_snapshots
           WHERE "cycleId" = $2) AS "snapshotCount",
         (SELECT "snapshotDigest" FROM streaming_duel_competitive_snapshots
           WHERE "cycleId" = $2 LIMIT 1) AS digest`,
      [OPERATION_ID, replacement.cycleId],
    );
    if (
      finalState.rows[0]?.operationCount !== "1" ||
      finalState.rows[0]?.snapshotCount !== "1" ||
      finalState.rows[0]?.digest !== replacement.snapshotDigest
    ) {
      throw new Error(
        `final receipt/snapshot identity drifted: ${JSON.stringify(finalState.rows)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        commitWorkerPid: commitWorker.child.pid,
        replacementWorkerPid: replacementWorker.child.pid,
        authorityKilled: true,
        operationId: OPERATION_ID,
        stalePreparationId: committed.preparationId,
        cycleId: replacement.cycleId,
        snapshotDigest: replacement.snapshotDigest,
        receiptCommittedBeforeKill: true,
        snapshotCountBeforeKill: 0,
        receiptSurvivedKill: true,
        replacementReplayedReceipt: true,
        replacementRefencedBothContestants: true,
        stalePreparationCancelled: true,
        stalePreparationCancellationReason:
          originalPreparation.cancellationReason,
        replacementPreparationId: replacement.preparationId,
        snapshotOpenedOnlyAfterQuiescence: true,
        snapshotEquippedBronzeArrows: replacement.snapshotEquippedBronzeArrows,
        bankedBronzeArrows: replacement.bankedBronzeArrows,
        totalBronzeArrows: replacement.totalBronzeArrows,
        duplicateReceipt: false,
        duplicateSnapshot: false,
      })}\n`,
    );
  } finally {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
    }
    if (pool) await pool.end().catch(() => undefined);
    if (containerStarted) {
      await docker(["stop", "--time", "1", containerName]).catch(
        () => undefined,
      );
    }
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(scriptPath);

if (isDirectExecution) {
  try {
    if (process.argv.includes("--commit")) {
      await runCommitWorker();
    } else if (process.argv.includes("--replacement")) {
      await runReplacementWorker();
      process.exit(0);
    } else {
      await runParent();
    }
  } catch (error) {
    if (process.argv.some((argument) => argument.startsWith("--"))) {
      emit({
        event: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
