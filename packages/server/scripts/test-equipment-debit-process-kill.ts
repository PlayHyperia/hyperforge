import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../src/database/schema.js";
import type { EquipmentStackDebitCommitRequest } from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const PLAYER_ID = "equipment-debit-chaos-agent";
const BASE_SLOT = "arrows";
const BASE_ITEM = "bronze_arrow";

function fingerprint(
  slotType = BASE_SLOT,
  itemId = BASE_ITEM,
  quantity = 1,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId: PLAYER_ID,
        slotType,
        itemId,
        quantity,
      }),
    )
    .digest("hex");
}

function requestFor(
  operationId: string,
  slotType = BASE_SLOT,
  itemId = BASE_ITEM,
  quantity = 1,
  requestFingerprint = fingerprint(slotType, itemId, quantity),
): EquipmentStackDebitCommitRequest {
  return {
    operationId,
    playerId: PLAYER_ID,
    requestFingerprint,
    slotType,
    itemId,
    quantity,
  };
}

type WorkerEvent = {
  event: "committed" | "error";
  replayed?: boolean;
  equipment?: Array<{ slotType: string; itemId: string; quantity: number }>;
  message?: string;
};

async function runWorker(): Promise<void> {
  const connectionString = process.env.EQUIPMENT_DEBIT_TEST_DATABASE_URL;
  const operationId = process.env.EQUIPMENT_DEBIT_TEST_OPERATION_ID;
  const slotType = process.env.EQUIPMENT_DEBIT_TEST_SLOT ?? BASE_SLOT;
  const itemId = process.env.EQUIPMENT_DEBIT_TEST_ITEM ?? BASE_ITEM;
  const quantity = Number(process.env.EQUIPMENT_DEBIT_TEST_QUANTITY ?? 1);
  const requestFingerprint = process.env.EQUIPMENT_DEBIT_TEST_FINGERPRINT;
  const hold = process.argv.includes("--hold");
  if (!connectionString || !operationId) {
    throw new Error("equipment debit worker configuration is incomplete");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const receipt =
      await databaseSystem.commitEquipmentStackDebitOperationAsync(
        requestFor(operationId, slotType, itemId, quantity, requestFingerprint),
      );
    process.stdout.write(
      `${JSON.stringify({
        event: "committed",
        replayed: receipt.replayed,
        equipment: receipt.committed,
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

async function docker(args: string[]): Promise<string> {
  const binary = process.env.DOCKER_BIN?.trim() || "docker";
  const result = await execFileAsync(binary, args, {
    maxBuffer: 4 * 1024 * 1024,
  });
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

function spawnWorker(input: {
  connectionString: string;
  operationId: string;
  slotType?: string;
  itemId?: string;
  quantity?: number;
  requestFingerprint?: string;
  hold?: boolean;
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const slotType = input.slotType ?? BASE_SLOT;
  const itemId = input.itemId ?? BASE_ITEM;
  const quantity = input.quantity ?? 1;
  const args = [scriptPath, "--worker"];
  if (input.hold) args.push("--hold");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      EQUIPMENT_DEBIT_TEST_DATABASE_URL: input.connectionString,
      EQUIPMENT_DEBIT_TEST_OPERATION_ID: input.operationId,
      EQUIPMENT_DEBIT_TEST_SLOT: slotType,
      EQUIPMENT_DEBIT_TEST_ITEM: itemId,
      EQUIPMENT_DEBIT_TEST_QUANTITY: String(quantity),
      EQUIPMENT_DEBIT_TEST_FINGERPRINT:
        input.requestFingerprint ?? fingerprint(slotType, itemId, quantity),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("worker pipes were not created");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`worker timed out: ${stderr}`)),
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
          if (parsed.event === "committed" || parsed.event === "error") {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          // Build/runtime diagnostics may share stdout; wait for the JSON event.
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
      () => reject(new Error("worker did not exit")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function arrowQuantity(event: WorkerEvent): number {
  return (
    event.equipment?.find((item) => item.slotType === BASE_SLOT)?.quantity ?? 0
  );
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-equipment-debit-chaos-${process.pid}`;
  const databaseUser = "equipment_debit_test";
  const databaseName = "equipment_debit_test";
  const databasePassword = `equipment-${randomUUID()}`;
  const originalOperationId = randomUUID();
  const image =
    process.env.EQUIPMENT_DEBIT_TEST_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(`Docker is required for equipment debit chaos: ${error}`);
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
        "selectedSpell" text
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
      CREATE TABLE equipment (
        id serial PRIMARY KEY,
        "playerId" text NOT NULL,
        "slotType" text NOT NULL,
        "itemId" text,
        quantity integer DEFAULT 1,
        UNIQUE ("playerId", "slotType")
      );
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
    await pool.query(`INSERT INTO characters (id) VALUES ($1)`, [PLAYER_ID]);
    await pool.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'weapon', 'shortbow', 1),
              ($1, 'arrows', 'bronze_arrow', 3)`,
      [PLAYER_ID],
    );

    const initial = spawnWorker({
      connectionString,
      operationId: originalOperationId,
      hold: true,
    });
    const initialEvent = await initial.event;
    if (
      initialEvent.event !== "committed" ||
      initialEvent.replayed !== false ||
      arrowQuantity(initialEvent) !== 2
    ) {
      throw new Error(`initial debit failed: ${JSON.stringify(initialEvent)}`);
    }
    initial.child.kill("SIGKILL");
    await waitForExit(initial.child);

    const replay = spawnWorker({
      connectionString,
      operationId: originalOperationId,
    });
    const replayEvent = await replay.event;
    await waitForExit(replay.child);
    if (
      replayEvent.event !== "committed" ||
      replayEvent.replayed !== true ||
      arrowQuantity(replayEvent) !== 2
    ) {
      throw new Error(`durable replay failed: ${JSON.stringify(replayEvent)}`);
    }

    const insufficient = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      quantity: 999,
    });
    const insufficientEvent = await insufficient.event;
    await waitForExit(insufficient.child);
    if (
      insufficientEvent.event !== "error" ||
      !insufficientEvent.message?.includes(
        "equipment_stack_debit_insufficient_items",
      )
    ) {
      throw new Error(
        `insufficient debit was not rejected: ${JSON.stringify(insufficientEvent)}`,
      );
    }

    const collision = spawnWorker({
      connectionString,
      operationId: originalOperationId,
      quantity: 2,
    });
    const collisionEvent = await collision.event;
    await waitForExit(collision.child);
    if (
      collisionEvent.event !== "error" ||
      !collisionEvent.message?.includes(
        "equipment_stack_debit_operation_id_conflict",
      )
    ) {
      throw new Error(
        `operation collision was not rejected: ${JSON.stringify(collisionEvent)}`,
      );
    }

    const laterOperationId = randomUUID();
    const later = spawnWorker({
      connectionString,
      operationId: laterOperationId,
    });
    const laterEvent = await later.event;
    await waitForExit(later.child);
    if (
      laterEvent.event !== "committed" ||
      laterEvent.replayed !== false ||
      arrowQuantity(laterEvent) !== 1
    ) {
      throw new Error(`later debit failed: ${JSON.stringify(laterEvent)}`);
    }

    const oldReplay = spawnWorker({
      connectionString,
      operationId: originalOperationId,
    });
    const oldReplayEvent = await oldReplay.event;
    await waitForExit(oldReplay.child);
    if (
      oldReplayEvent.event !== "committed" ||
      oldReplayEvent.replayed !== true ||
      arrowQuantity(oldReplayEvent) !== 1
    ) {
      throw new Error(
        `old replay returned stale custody: ${JSON.stringify(oldReplayEvent)}`,
      );
    }

    const finalOperationId = randomUUID();
    const final = spawnWorker({
      connectionString,
      operationId: finalOperationId,
    });
    const finalEvent = await final.event;
    await waitForExit(final.child);
    if (
      finalEvent.event !== "committed" ||
      finalEvent.replayed !== false ||
      arrowQuantity(finalEvent) !== 0
    ) {
      throw new Error(
        `final-stack debit failed: ${JSON.stringify(finalEvent)}`,
      );
    }

    const [equipment, operations] = await Promise.all([
      pool.query<{ slotType: string; itemId: string; quantity: number }>(
        `SELECT "slotType", "itemId", quantity FROM equipment
         WHERE "playerId" = $1 ORDER BY "slotType"`,
        [PLAYER_ID],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM operations_log
         WHERE "playerId" = $1 AND "operationType" = 'equipment_stack_debit'`,
        [PLAYER_ID],
      ),
    ]);
    const exactEquipment =
      JSON.stringify(equipment.rows) ===
      JSON.stringify([{ slotType: "weapon", itemId: "shortbow", quantity: 1 }]);
    if (!exactEquipment || operations.rows[0]?.count !== "3") {
      throw new Error("post-kill equipment debit custody was not exact");
    }

    process.stdout.write(
      `${JSON.stringify({
        processKilledAfterCommit: true,
        durableReplayRecovered: true,
        insufficientDebitLeftNoCharge: true,
        operationCollisionRejected: true,
        oldReplayDidNotRollbackNewerState: true,
        finalStackRemoved: true,
        equipmentCustodyExact: exactEquipment,
        receiptCount: Number(operations.rows[0]?.count ?? 0),
      })}\n`,
    );
  } finally {
    await pool?.end().catch(() => undefined);
    if (containerStarted) {
      await docker(["rm", "-f", containerName]).catch(() => undefined);
    }
  }
}

if (process.argv.includes("--worker")) {
  await runWorker();
} else {
  await runParent();
}
