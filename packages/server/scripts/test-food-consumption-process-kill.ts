import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { ITEMS } from "@hyperforge/shared";
import pg from "pg";

import * as schema from "../src/database/schema.js";
import type { FoodConsumptionCommitRequest } from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const PLAYER_ID = "food-process-kill-agent";

function fingerprint(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId: PLAYER_ID,
        itemId: "lobster",
        healAmount: 12,
      }),
      "utf8",
    )
    .digest("hex");
}

function requestFor(operationId: string): FoodConsumptionCommitRequest {
  return {
    operationId,
    playerId: PLAYER_ID,
    requestFingerprint: fingerprint(),
    itemId: "lobster",
    healAmount: 12,
  };
}

type WorkerEvent = {
  event: "staged" | "database_unavailable" | "recovered" | "replayed" | "error";
  status?: "pending" | "completed";
  replayed?: boolean;
  healedAmount?: number;
  healthAfter?: number | null;
  recoveredCount?: number;
  message?: string;
};

function registerFood(): void {
  ITEMS.set("lobster", {
    id: "lobster",
    name: "Lobster",
    type: "food",
    value: 120,
    stackable: false,
    healAmount: 12,
  } as never);
}

function isDatabaseUnavailableError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    cause?: unknown;
    message?: unknown;
  };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (
    [
      "57P01",
      "57P02",
      "57P03",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
    ].includes(code)
  ) {
    return true;
  }
  const message =
    typeof candidate?.message === "string" ? candidate.message : String(error);
  if (
    /connection terminated|connection timeout|connect timeout|timeout exceeded|server closed the connection|the database system is (starting up|shutting down)/i.test(
      message,
    )
  ) {
    return true;
  }
  return candidate?.cause ? isDatabaseUnavailableError(candidate.cause) : false;
}

async function runWorker(): Promise<void> {
  const connectionString = process.env.FOOD_TEST_DATABASE_URL;
  const operationId = process.env.FOOD_TEST_OPERATION_ID;
  if (!connectionString || !operationId) {
    throw new Error("food process-kill worker configuration is incomplete");
  }
  registerFood();
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 1_500,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;

    if (process.argv.includes("--stage")) {
      const receipt = await databaseSystem.commitFoodConsumptionOperationAsync(
        requestFor(operationId),
      );
      process.stdout.write(
        `${JSON.stringify({
          event: "staged",
          status: receipt.status,
          replayed: receipt.replayed,
          healedAmount: receipt.healedAmount,
          healthAfter: receipt.healthAfter,
        } satisfies WorkerEvent)}\n`,
      );
      if (process.argv.includes("--hold")) {
        await new Promise<never>(() => undefined);
      }
      return;
    }
    if (process.argv.includes("--recover")) {
      const recovered =
        await databaseSystem.recoverPendingFoodConsumptionOperationsAsync(
          PLAYER_ID,
        );
      const receipt = recovered[0];
      process.stdout.write(
        `${JSON.stringify({
          event: "recovered",
          recoveredCount: recovered.length,
          status: receipt?.status,
          replayed: receipt?.replayed,
          healedAmount: receipt?.healedAmount,
          healthAfter: receipt?.healthAfter,
        } satisfies WorkerEvent)}\n`,
      );
      return;
    }
    if (process.argv.includes("--outage")) {
      await databaseSystem.recoverPendingFoodConsumptionOperationsAsync(
        PLAYER_ID,
      );
      throw new Error("food outage worker unexpectedly reached PostgreSQL");
    }
    const staged = await databaseSystem.commitFoodConsumptionOperationAsync(
      requestFor(operationId),
    );
    const completed =
      await databaseSystem.completeFoodConsumptionOperationAsync(
        requestFor(operationId),
      );
    process.stdout.write(
      `${JSON.stringify({
        event: "replayed",
        status: completed.status,
        replayed: staged.replayed && completed.replayed,
        healedAmount: completed.healedAmount,
        healthAfter: completed.healthAfter,
      } satisfies WorkerEvent)}\n`,
    );
  } catch (error) {
    if (
      process.argv.includes("--outage") &&
      isDatabaseUnavailableError(error)
    ) {
      process.stdout.write(
        `${JSON.stringify({ event: "database_unavailable" } satisfies WorkerEvent)}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        event: "error",
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerEvent)}\n`,
    );
  } finally {
    if (!process.argv.includes("--hold")) await pool.end();
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
  throw new Error(`temporary PostgreSQL did not become ready: ${lastError}`);
}

function spawnWorker(input: {
  connectionString: string;
  operationId: string;
  mode: "stage" | "outage" | "recover" | "replay";
  hold?: boolean;
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const args = [scriptPath, "--worker", `--${input.mode}`];
  if (input.hold) args.push("--hold");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      FOOD_TEST_DATABASE_URL: input.connectionString,
      FOOD_TEST_OPERATION_ID: input.operationId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("food worker pipes were not created");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`food worker timed out: ${stderr}`)),
      20_000,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (parsed.event) {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          // Runtime diagnostics can share stdout; wait for the JSON event.
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
      reject(new Error(`food worker exited ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, event };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("food worker did not exit")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-food-process-kill-${process.pid}`;
  const databaseUser = "food_test";
  const databaseName = "food_test";
  const databasePassword = `food-${randomUUID()}`;
  const operationId = `food:${randomUUID()}`;
  let containerStarted = false;
  let containerPaused = false;
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
      process.env.FOOD_TEST_POSTGRES_IMAGE?.trim() || "postgres:16-alpine",
    ]);
    containerStarted = true;
    const port = Number(
      (await docker(["port", containerName, "5432/tcp"]))
        .trim()
        .split(":")
        .pop(),
    );
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new Error("could not resolve temporary PostgreSQL port");
    }
    const connectionString = `postgres://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
    pool = await waitForPostgres(connectionString);
    await pool.query(`
      CREATE TABLE characters (
        id text PRIMARY KEY,
        health integer DEFAULT 100,
        "maxHealth" integer DEFAULT 100
      );
      CREATE TABLE inventory (
        id serial PRIMARY KEY,
        "playerId" text NOT NULL,
        "itemId" text NOT NULL,
        quantity integer DEFAULT 1,
        "slotIndex" integer DEFAULT -1,
        metadata text
      );
      CREATE UNIQUE INDEX inventory_player_slot_unique
        ON inventory ("playerId", "slotIndex") WHERE "slotIndex" >= 0;
      CREATE TABLE operations_log (
        id text PRIMARY KEY,
        "playerId" text NOT NULL,
        "operationType" text NOT NULL,
        "operationState" jsonb NOT NULL,
        completed boolean DEFAULT false,
        timestamp bigint NOT NULL,
        "completedAt" bigint
      );
    `);
    await pool.query(
      `INSERT INTO characters (id, health, "maxHealth") VALUES ($1, 25, 60)`,
      [PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'lobster', 1, 4), ($1, 'lobster', 1, 5)`,
      [PLAYER_ID],
    );

    const initial = spawnWorker({
      connectionString,
      operationId,
      mode: "stage",
      hold: true,
    });
    const staged = await initial.event;
    if (
      staged.event !== "staged" ||
      staged.status !== "pending" ||
      staged.replayed !== false
    ) {
      throw new Error(`food staging failed: ${JSON.stringify(staged)}`);
    }
    if (!initial.child.kill("SIGKILL")) {
      throw new Error("failed to SIGKILL staged food worker");
    }
    await waitForExit(initial.child);

    const afterKill = await pool.query<{
      health: number;
      inventory_rows: number;
      pending_rows: number;
    }>(
      `SELECT
         (SELECT health FROM characters WHERE id = $1) AS health,
         (SELECT count(*)::int FROM inventory WHERE "playerId" = $1) AS inventory_rows,
         (SELECT count(*)::int FROM operations_log WHERE id = $2 AND completed = false) AS pending_rows`,
      [PLAYER_ID, operationId],
    );
    if (
      afterKill.rows[0]?.health !== 25 ||
      afterKill.rows[0]?.inventory_rows !== 1 ||
      afterKill.rows[0]?.pending_rows !== 1
    ) {
      throw new Error(
        `staged truth did not survive SIGKILL: ${JSON.stringify(afterKill.rows)}`,
      );
    }

    await docker(["pause", containerName]);
    containerPaused = true;
    const pausedState = await docker([
      "inspect",
      "--format",
      "{{.State.Paused}}",
      containerName,
    ]);
    if (pausedState !== "true") {
      throw new Error(`temporary PostgreSQL did not pause: ${pausedState}`);
    }
    const outage = spawnWorker({
      connectionString,
      operationId,
      mode: "outage",
    });
    const unavailable = await outage.event;
    await waitForExit(outage.child);
    if (unavailable.event !== "database_unavailable") {
      throw new Error(
        `food outage did not fail closed: ${JSON.stringify(unavailable)}`,
      );
    }

    await docker(["unpause", containerName]);
    containerPaused = false;
    await pool.end();
    pool = await waitForPostgres(connectionString);
    const afterOutage = await pool.query<{
      health: number;
      inventory_rows: number;
      pending_rows: number;
    }>(
      `SELECT
         (SELECT health FROM characters WHERE id = $1) AS health,
         (SELECT count(*)::int FROM inventory WHERE "playerId" = $1) AS inventory_rows,
         (SELECT count(*)::int FROM operations_log WHERE id = $2 AND completed = false) AS pending_rows`,
      [PLAYER_ID, operationId],
    );
    if (
      afterOutage.rows[0]?.health !== 25 ||
      afterOutage.rows[0]?.inventory_rows !== 1 ||
      afterOutage.rows[0]?.pending_rows !== 1
    ) {
      throw new Error(
        `food outage changed durable truth: ${JSON.stringify(afterOutage.rows)}`,
      );
    }

    const recovery = spawnWorker({
      connectionString,
      operationId,
      mode: "recover",
    });
    const recovered = await recovery.event;
    await waitForExit(recovery.child);
    if (
      recovered.event !== "recovered" ||
      recovered.recoveredCount !== 1 ||
      recovered.status !== "completed" ||
      recovered.healedAmount !== 12 ||
      recovered.healthAfter !== 37
    ) {
      throw new Error(`food recovery failed: ${JSON.stringify(recovered)}`);
    }

    const replay = spawnWorker({
      connectionString,
      operationId,
      mode: "replay",
    });
    const replayed = await replay.event;
    await waitForExit(replay.child);
    if (
      replayed.event !== "replayed" ||
      replayed.replayed !== true ||
      replayed.healedAmount !== 12 ||
      replayed.healthAfter !== 37
    ) {
      throw new Error(`food replay failed: ${JSON.stringify(replayed)}`);
    }

    const final = await pool.query<{
      health: number;
      inventory_rows: number;
      receipt_rows: number;
      pending_rows: number;
    }>(
      `SELECT
         (SELECT health FROM characters WHERE id = $1) AS health,
         (SELECT count(*)::int FROM inventory WHERE "playerId" = $1) AS inventory_rows,
         (SELECT count(*)::int FROM operations_log WHERE id = $2) AS receipt_rows,
         (SELECT count(*)::int FROM operations_log WHERE id = $2 AND completed = false) AS pending_rows`,
      [PLAYER_ID, operationId],
    );
    const row = final.rows[0];
    if (
      row?.health !== 37 ||
      row.inventory_rows !== 1 ||
      row.receipt_rows !== 1 ||
      row.pending_rows !== 0
    ) {
      throw new Error(
        `food final truth mismatch: ${JSON.stringify(final.rows)}`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        signal: "SIGKILL",
        staged,
        afterKill: afterKill.rows[0],
        outage: unavailable,
        afterOutage: afterOutage.rows[0],
        recovered,
        replayed,
        final: row,
      })}\n`,
    );
  } finally {
    await pool?.end().catch(() => undefined);
    if (containerStarted) {
      if (containerPaused) {
        await docker(["unpause", containerName]).catch(() => undefined);
      }
      await docker(["stop", "-t", "1", containerName]).catch(() => undefined);
    }
  }
}

if (process.argv.includes("--worker")) await runWorker();
else await runParent();
