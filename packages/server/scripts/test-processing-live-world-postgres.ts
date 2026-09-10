#!/usr/bin/env bun

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pg from "pg";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const LIVE_WORLD_SCRIPT = path.join(
  SCRIPT_DIR,
  "test-processing-quiescence-live-world.mjs",
);
const REPORT_PATH = path.join(
  REPO_ROOT,
  "artifacts/duel-launch-processing-quiescence/live-world-postgres-report.json",
);
const CONTAINER_NAME = `hyperia-processing-live-world-${process.pid}`;

async function buildCurrentRuntimeArtifacts(): Promise<void> {
  for (const workspace of ["packages/shared", "packages/server"]) {
    await execFileAsync(
      process.execPath,
      ["run", "--cwd", path.join(REPO_ROOT, workspace), "build"],
      {
        cwd: REPO_ROOT,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
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
  throw new Error(`temporary PostgreSQL was not ready: ${String(lastError)}`);
}

async function runLiveWorld(
  connectionString: string,
  onSpawn: (child: ChildProcess | null) => void,
): Promise<void> {
  const liveWorldChild = spawn(process.execPath, [LIVE_WORLD_SCRIPT], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      SKIP_VALIDATION: "true",
      SKIP_MIGRATIONS: "false",
      DATA_OPTIONAL_MANIFEST_WARNINGS: "false",
      DISABLE_BOTS: "true",
      DISABLE_ACTIVITY_LOGGER: "true",
      TERRAIN_SERVER_MESH_COLLISION_ENABLED: "false",
      PROCESSING_LIVE_WORLD_DATABASE_URL: connectionString,
      PROCESSING_QUIESCENCE_REPORT: REPORT_PATH,
    },
    stdio: "inherit",
  });
  onSpawn(liveWorldChild);
  try {
    await new Promise<void>((resolve, reject) => {
      liveWorldChild.once("error", reject);
      liveWorldChild.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `production live-world PostgreSQL child exited ${code ?? signal}`,
          ),
        );
      });
    });
  } finally {
    onSpawn(null);
  }
}

function installSignalCleanup(getChild: () => ChildProcess | null): () => void {
  let cleaning = false;
  const cleanup = async (signal: NodeJS.Signals) => {
    if (cleaning) return;
    cleaning = true;
    getChild()?.kill("SIGTERM");
    await docker(["rm", "-f", CONTAINER_NAME]).catch(() => undefined);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = () => void cleanup("SIGINT");
  const onSigterm = () => void cleanup("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

async function main(): Promise<void> {
  const databaseUser = "processing_live_world";
  const databaseName = "processing_live_world";
  const databasePassword = `processing-${randomUUID()}`;
  let containerStarted = false;
  let verificationPool: pg.Pool | null = null;
  let child: ChildProcess | null = null;
  const removeSignalCleanup = installSignalCleanup(() => child);
  let summary: Record<string, unknown> | null = null;
  try {
    await buildCurrentRuntimeArtifacts();
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(
        `Docker is required for the live-world PostgreSQL gate: ${error}`,
      );
    });
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      CONTAINER_NAME,
      "-e",
      `POSTGRES_USER=${databaseUser}`,
      "-e",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      process.env.PROCESSING_LIVE_WORLD_POSTGRES_IMAGE?.trim() ||
        "postgres:16-alpine",
    ]);
    containerStarted = true;
    const port = Number(
      (await docker(["port", CONTAINER_NAME, "5432/tcp"])).split(":").pop(),
    );
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new Error("temporary PostgreSQL port was invalid");
    }
    const connectionString = `postgres://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
    verificationPool = await waitForPostgres(connectionString);
    await runLiveWorld(connectionString, (running) => {
      child = running;
    });

    const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
    if (
      report?.status !== "passed" ||
      report?.runtime?.databaseMode !== "real_postgresql" ||
      report?.preparationVerticalSlice?.status !== "passed" ||
      report?.preparationVerticalSlice?.workerBridge?.checkpoints?.[0]
        ?.attemptedActionType !== "bankWithdraw" ||
      report?.preparationVerticalSlice?.workerBridge?.checkpoints?.[1]
        ?.attemptedActionType !== "gather" ||
      report?.preparationVerticalSlice?.gathering?.durableReceipts < 4 ||
      report?.preparationVerticalSlice?.cooking?.actions < 4 ||
      report?.preparationVerticalSlice?.cooking?.forcedBurnObserved !== true ||
      report?.preparationVerticalSlice?.cooking?.recoveryGatherActions < 1 ||
      report?.preparationVerticalSlice?.cooking?.cookedHealing <
        report?.preparationVerticalSlice?.cooking?.requiredHealing ||
      report?.preparationVerticalSlice?.presentation?.processingRejections !==
        0 ||
      report?.preparationVerticalSlice?.quiescent !== true ||
      report?.populationStation?.population !== 25 ||
      report?.populationStation?.processing?.completions !== 25 ||
      report?.populationStation?.processing?.rejections !== 0 ||
      report?.populationStation?.processing?.persistence?.mode !==
        "postgresql" ||
      report?.populationStation?.processing?.persistence
        ?.completedOperationReceipts !== 25 ||
      report?.populationStation?.movement?.maximumDepartureRequests > 5 ||
      report?.populationStation?.performance?.worldTicks?.total?.samples < 20 ||
      report?.populationStation?.performance?.worldTicks?.total?.max > 50
    ) {
      throw new Error("live-world PostgreSQL report failed its exact contract");
    }

    const persisted = await verificationPool.query<{
      characters: number;
      cooked_items: number;
      raw_items: number;
      completed_receipts: number;
      pending_receipts: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM characters
          WHERE id LIKE 'launch-station-agent-%') AS characters,
        (SELECT count(*)::int FROM inventory
          WHERE "playerId" LIKE 'launch-station-agent-%'
            AND "itemId" = 'shrimp' AND quantity = 1) AS cooked_items,
        (SELECT count(*)::int FROM inventory
          WHERE "playerId" LIKE 'launch-station-agent-%'
            AND "itemId" = 'raw_shrimp') AS raw_items,
        (SELECT count(*)::int FROM operations_log
          WHERE "playerId" LIKE 'launch-station-agent-%'
            AND "operationType" = 'processing_action'
            AND completed = true) AS completed_receipts,
        (SELECT count(*)::int FROM operations_log
          WHERE "playerId" LIKE 'launch-station-agent-%'
            AND completed = false) AS pending_receipts
    `);
    const row = persisted.rows[0];
    if (
      Number(row?.characters) !== 25 ||
      Number(row?.cooked_items) !== 25 ||
      Number(row?.raw_items) !== 0 ||
      Number(row?.completed_receipts) !== 25 ||
      Number(row?.pending_receipts) !== 0
    ) {
      throw new Error(
        `post-world PostgreSQL verification drifted: ${JSON.stringify(row)}`,
      );
    }
    summary = {
      report: REPORT_PATH,
      databaseMode: report.runtime.databaseMode,
      preparationVerticalSlice: report.preparationVerticalSlice.status,
      preparationBridgeActions:
        report.preparationVerticalSlice.workerBridge.checkpoints.map(
          (checkpoint: { attemptedActionType: string }) =>
            checkpoint.attemptedActionType,
        ),
      preparationGatheringReceipts:
        report.preparationVerticalSlice.gathering.durableReceipts,
      preparationCookingActions:
        report.preparationVerticalSlice.cooking.actions,
      preparationExactFinalCustodyAndXp:
        report.preparationVerticalSlice.exactFinalCustodyAndXp,
      preparationQuiescent: report.preparationVerticalSlice.quiescent,
      population: report.populationStation.population,
      maximumAgentsInRange:
        report.populationStation.movement.maximumAgentsInRange,
      latestArrivalTick: report.populationStation.movement.latestArrivalTick,
      latestDepartureTick:
        report.populationStation.movement.latestDepartureTick,
      completions: report.populationStation.processing.completions,
      rejections: report.populationStation.processing.rejections,
      completedOperationReceipts: Number(row.completed_receipts),
      pendingOperationReceipts: Number(row.pending_receipts),
      exactPostWorldCustody: true,
      worldTickSamples:
        report.populationStation.performance.worldTicks.total.samples,
      worldTickP95Ms: report.populationStation.performance.worldTicks.total.p95,
      worldTickMaxMs: report.populationStation.performance.worldTicks.total.max,
    };
  } finally {
    removeSignalCleanup();
    child?.kill("SIGTERM");
    await verificationPool?.end().catch(() => undefined);
    if (containerStarted) {
      await docker(["rm", "-f", CONTAINER_NAME]);
    }
  }

  console.log(
    JSON.stringify({
      status: "passed",
      ...summary,
      temporaryContainersRemoved: true,
    }),
  );
}

await main();
