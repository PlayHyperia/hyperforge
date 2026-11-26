import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ITEMS } from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const PLAYER_ID = "safe-death-process-kill-agent";

type WorkerInput =
  | {
      phase: "capture";
      request: {
        operationId: string;
        playerId: string;
        deathTimestamp: number;
        position: { x: number; y: number; z: number };
        killedBy: string;
      };
    }
  | {
      phase: "kept";
      playerId: string;
      deathOperationId: string;
    }
  | {
      phase: "grave";
      request: {
        operationId: string;
        playerId: string;
        deathOperationId: string;
        gravestoneId: string;
        items?: Array<{ itemId: string; quantity: number }>;
      };
    };

type WorkerEvent = {
  event: "committed" | "error";
  phase?: WorkerInput["phase"];
  replayed?: boolean;
  dropped?: Array<{ itemId: string; quantity: number }>;
  kept?: Array<{ itemId: string; quantity: number }>;
  returned?: Array<{ itemId: string; quantity: number }>;
  transferred?: Array<{ itemId: string; quantity: number }>;
  remaining?: Array<{ itemId: string; quantity: number }>;
  message?: string;
};

function registerItems(): void {
  ITEMS.set("shrimp", {
    id: "shrimp",
    name: "Shrimp",
    type: "food",
    value: 3,
    stackable: false,
  } as never);
  ITEMS.set("bronze_shortsword", {
    id: "bronze_shortsword",
    name: "Bronze Shortsword",
    type: "weapon",
    value: 100,
    stackable: false,
  } as never);
}

async function runWorker(): Promise<void> {
  const connectionString = process.env.SAFE_DEATH_WORKER_DATABASE_URL;
  const inputJson = process.env.SAFE_DEATH_WORKER_INPUT;
  const hold = process.argv.includes("--hold");
  if (!connectionString || !inputJson) {
    throw new Error("safe death worker configuration is incomplete");
  }
  registerItems();
  const input = JSON.parse(inputJson) as WorkerInput;
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const receipt =
      input.phase === "capture"
        ? await databaseSystem.commitSafeAreaDeathOperationAsync(input.request)
        : input.phase === "kept"
          ? await databaseSystem.commitSafeAreaDeathKeptReturnAsync({
              playerId: input.playerId,
              deathOperationId: input.deathOperationId,
            })
          : await databaseSystem.commitSafeAreaDeathGravestoneLootAsync(
              input.request,
            );
    process.stdout.write(
      `${JSON.stringify({
        event: "committed",
        phase: input.phase,
        replayed: receipt.replayed,
        ...(input.phase === "capture"
          ? { dropped: receipt.dropped, kept: receipt.kept }
          : input.phase === "kept"
            ? { returned: receipt.returned }
            : {
                transferred: receipt.transferred,
                remaining: receipt.remaining,
              }),
      } satisfies WorkerEvent)}\n`,
    );
    if (hold) await new Promise<never>(() => undefined);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        event: "error",
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerEvent)}\n`,
    );
  } finally {
    if (!hold) await pool.end();
  }
}

function spawnWorker(input: {
  connectionString: string;
  payload: WorkerInput;
  hold?: boolean;
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const args = [scriptPath, "--worker"];
  if (input.hold) args.push("--hold");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      SAFE_DEATH_WORKER_DATABASE_URL: input.connectionString,
      SAFE_DEATH_WORKER_INPUT: JSON.stringify(input.payload),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("safe death worker pipes were not created");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`safe death worker timed out: ${stderr}`)),
      20_000,
    );
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (parsed.event === "committed" || parsed.event === "error") {
            clearTimeout(timeout);
            resolve(parsed);
            return;
          }
        } catch {
          // Wait for a complete JSON line.
        }
      }
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") return;
      clearTimeout(timeout);
      reject(
        new Error(
          `safe death worker exited ${code ?? signal}: ${stderr || stdout}`,
        ),
      );
    });
  });
  return { child, event };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("safe death worker did not exit")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function commitThenKill(
  connectionString: string,
  payload: WorkerInput,
): Promise<WorkerEvent> {
  const worker = spawnWorker({ connectionString, payload, hold: true });
  const event = await worker.event;
  if (event.event !== "committed") {
    throw new Error(`worker commit failed: ${JSON.stringify(event)}`);
  }
  worker.child.kill("SIGKILL");
  await waitForExit(worker.child);
  return event;
}

async function runReplacement(
  connectionString: string,
  payload: WorkerInput,
): Promise<WorkerEvent> {
  const worker = spawnWorker({ connectionString, payload });
  const event = await worker.event;
  await waitForExit(worker.child);
  return event;
}

async function runParent(): Promise<void> {
  const baseDatabaseUrl =
    process.env.SAFE_DEATH_TEST_DATABASE_URL?.trim() ?? "";
  if (!baseDatabaseUrl) {
    throw new Error("SAFE_DEATH_TEST_DATABASE_URL is required");
  }
  const databaseName = `hyperia_safe_death_kill_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 2 });
  let pool: pg.Pool | null = null;
  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(baseDatabaseUrl);
    testUrl.pathname = `/${databaseName}`;
    const connectionString = testUrl.toString();
    pool = new Pool({ connectionString, max: 4 });
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
    const custodyMigration = await readFile(
      new URL(
        "../src/database/migrations/0082_add_atomic_safe_death_custody.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (let run = 0; run < 2; run++) {
      for (const statement of custodyMigration.split(
        "--> statement-breakpoint",
      )) {
        if (statement.trim()) await pool.query(statement);
      }
    }
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ('safe-death-process-kill-account', 'Safe Death Process Kill', 'user', '2026-08-11T00:00:00.000Z')`,
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent")
       VALUES ($1, 'safe-death-process-kill-account', 'Safe Death Process Kill Agent', 1)`,
      [PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'shrimp', 1, 0), ($1, 'shrimp', 1, 1),
              ($1, 'shrimp', 1, 2), ($1, 'shrimp', 1, 3)`,
      [PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'weapon', 'bronze_shortsword', 1)`,
      [PLAYER_ID],
    );

    const deathOperationId = randomUUID();
    const capture: WorkerInput = {
      phase: "capture",
      request: {
        operationId: deathOperationId,
        playerId: PLAYER_ID,
        deathTimestamp: 1_786_395_600_000,
        position: { x: -8.5, y: 28.2, z: -16 },
        killedBy: "wolf",
      },
    };
    const captured = await commitThenKill(connectionString, capture);
    const captureReplay = await runReplacement(connectionString, capture);
    if (
      captured.replayed !== false ||
      captureReplay.event !== "committed" ||
      captureReplay.replayed !== true
    ) {
      throw new Error("capture was not replayable after process kill");
    }

    const kept: WorkerInput = {
      phase: "kept",
      playerId: PLAYER_ID,
      deathOperationId,
    };
    const keptCommitted = await commitThenKill(connectionString, kept);
    const keptReplay = await runReplacement(connectionString, kept);
    if (
      keptCommitted.replayed !== false ||
      keptReplay.event !== "committed" ||
      keptReplay.replayed !== true
    ) {
      throw new Error("kept return was not replayable after process kill");
    }

    const gravestoneId = `gravestone_${PLAYER_ID}_exact`;
    await pool.query(
      `UPDATE player_deaths SET "gravestoneId" = $2 WHERE "playerId" = $1`,
      [PLAYER_ID, gravestoneId],
    );
    const firstLootOperationId = randomUUID();
    const firstLoot: WorkerInput = {
      phase: "grave",
      request: {
        operationId: firstLootOperationId,
        playerId: PLAYER_ID,
        deathOperationId,
        gravestoneId,
        items: [{ itemId: "shrimp", quantity: 1 }],
      },
    };
    const looted = await commitThenKill(connectionString, firstLoot);
    const lootReplay = await runReplacement(connectionString, firstLoot);
    if (
      looted.replayed !== false ||
      lootReplay.event !== "committed" ||
      lootReplay.replayed !== true
    ) {
      throw new Error(
        "gravestone transfer was not replayable after process kill",
      );
    }

    const finalLoot = await runReplacement(connectionString, {
      phase: "grave",
      request: {
        operationId: randomUUID(),
        playerId: PLAYER_ID,
        deathOperationId,
        gravestoneId,
      },
    });
    if (
      finalLoot.event !== "committed" ||
      finalLoot.replayed !== false ||
      finalLoot.remaining?.length !== 0
    ) {
      throw new Error(`final loot failed: ${JSON.stringify(finalLoot)}`);
    }

    const terminal = await pool.query<{
      itemId: string;
      quantity: number;
    }>(
      `SELECT "itemId", sum(quantity)::int AS quantity
       FROM inventory WHERE "playerId" = $1
       GROUP BY "itemId" ORDER BY "itemId"`,
      [PLAYER_ID],
    );
    const exactInventory =
      JSON.stringify(terminal.rows) ===
      JSON.stringify([
        { itemId: "bronze_shortsword", quantity: 1 },
        { itemId: "shrimp", quantity: 4 },
      ]);
    const counts = await pool.query<{
      inventory_quantity: string;
      equipment_quantity: string;
      death_count: string;
      operation_count: string;
    }>(
      `SELECT
         (SELECT coalesce(sum(quantity), 0)::text FROM inventory WHERE "playerId" = $1) AS inventory_quantity,
         (SELECT coalesce(sum(quantity), 0)::text FROM equipment WHERE "playerId" = $1) AS equipment_quantity,
         (SELECT count(*)::text FROM player_deaths WHERE "playerId" = $1) AS death_count,
         (SELECT count(*)::text FROM operations_log WHERE "playerId" = $1) AS operation_count`,
      [PLAYER_ID],
    );
    const exactCounts = counts.rows[0];
    if (
      !exactInventory ||
      exactCounts?.inventory_quantity !== "5" ||
      exactCounts.equipment_quantity !== "0" ||
      exactCounts.death_count !== "0" ||
      exactCounts.operation_count !== "4"
    ) {
      throw new Error("post-kill safe death custody was not exactly conserved");
    }

    process.stdout.write(
      `${JSON.stringify({
        captureProcessKilledAfterCommit: true,
        captureReplayRecovered: true,
        keptReturnProcessKilledAfterCommit: true,
        keptReturnReplayRecovered: true,
        gravestoneProcessKilledAfterCommit: true,
        gravestoneReplayRecovered: true,
        migrationIdempotent: true,
        exactInventoryConserved: exactInventory,
        finalInventoryQuantity: Number(exactCounts.inventory_quantity),
        finalEquipmentQuantity: Number(exactCounts.equipment_quantity),
        activeDeathLocks: Number(exactCounts.death_count),
        semanticReceiptCount: Number(exactCounts.operation_count),
      })}\n`,
    );
  } finally {
    await pool?.end().catch(() => undefined);
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  }
}

if (process.argv.includes("--worker")) {
  await runWorker();
} else {
  await runParent();
}
