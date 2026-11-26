import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../src/database/schema.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";
import type { CombatLoadoutCommitRequest } from "../src/shared/types/index.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const PLAYER_ID = "combat-loadout-chaos-agent";
const BASE_FINGERPRINT = "frozen-cycle:ranged";

const requestFor = (
  operationId: string,
  requestFingerprint = BASE_FINGERPRINT,
): CombatLoadoutCommitRequest => ({
  operationId,
  playerId: PLAYER_ID,
  requestFingerprint,
  expected: {
    inventory: [
      {
        itemId: "shortbow",
        quantity: 1,
        slotIndex: 0,
        metadata: null,
      },
      {
        itemId: "bronze_arrow",
        quantity: 50,
        slotIndex: 1,
        metadata: null,
      },
      { itemId: "lobster", quantity: 4, slotIndex: 2, metadata: null },
      {
        itemId: "green_dhide_body",
        quantity: 1,
        slotIndex: 3,
        metadata: null,
      },
    ],
    equipment: [
      { slotType: "body", itemId: "bronze_platebody", quantity: 1 },
      { slotType: "weapon", itemId: "bronze_longsword", quantity: 1 },
    ],
    selectedSpell: null,
  },
  committed: {
    inventory: [
      {
        itemId: "bronze_longsword",
        quantity: 1,
        slotIndex: 0,
        metadata: null,
      },
      { itemId: "lobster", quantity: 4, slotIndex: 2, metadata: null },
      {
        itemId: "bronze_platebody",
        quantity: 1,
        slotIndex: 3,
        metadata: null,
      },
    ],
    equipment: [
      { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
      { slotType: "body", itemId: "green_dhide_body", quantity: 1 },
      { slotType: "weapon", itemId: "shortbow", quantity: 1 },
    ],
    selectedSpell: null,
  },
});

type WorkerEvent = {
  event: "committed" | "error";
  replayed?: boolean;
  message?: string;
};

async function runWorker(): Promise<void> {
  const connectionString = process.env.COMBAT_LOADOUT_TEST_DATABASE_URL;
  const operationId = process.env.COMBAT_LOADOUT_TEST_OPERATION_ID;
  const requestFingerprint =
    process.env.COMBAT_LOADOUT_TEST_REQUEST_FINGERPRINT ?? BASE_FINGERPRINT;
  const hold = process.argv.includes("--hold");
  if (!connectionString || !operationId) {
    throw new Error("combat loadout worker configuration is incomplete");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const receipt = await databaseSystem.commitCombatLoadoutOperationAsync(
      requestFor(operationId, requestFingerprint),
    );
    process.stdout.write(
      `${JSON.stringify({ event: "committed", replayed: receipt.replayed } satisfies WorkerEvent)}\n`,
    );
    if (hold) {
      await new Promise<never>(() => undefined);
    }
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
  requestFingerprint?: string;
  hold?: boolean;
}): {
  child: ChildProcess;
  event: Promise<WorkerEvent>;
} {
  const args = [scriptPath, "--worker"];
  if (input.hold) args.push("--hold");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      COMBAT_LOADOUT_TEST_DATABASE_URL: input.connectionString,
      COMBAT_LOADOUT_TEST_OPERATION_ID: input.operationId,
      COMBAT_LOADOUT_TEST_REQUEST_FINGERPRINT:
        input.requestFingerprint ?? BASE_FINGERPRINT,
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
      for (const line of stdout.split("\n")) {
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

async function runParent(): Promise<void> {
  const containerName = `hyperia-combat-loadout-chaos-${process.pid}`;
  const databaseUser = "loadout_test";
  const databaseName = "loadout_test";
  const databasePassword = `loadout-${randomUUID()}`;
  const operationId = randomUUID();
  const image =
    process.env.COMBAT_LOADOUT_TEST_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
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
    const portOutput = await docker(["port", containerName, "5432/tcp"]);
    const port = Number(portOutput.trim().split(":").pop());
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
    await pool.query(
      `INSERT INTO characters (id, "selectedSpell") VALUES ($1, NULL)`,
      [PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'shortbow', 1, 0), ($1, 'bronze_arrow', 50, 1),
              ($1, 'lobster', 4, 2), ($1, 'green_dhide_body', 1, 3)`,
      [PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'body', 'bronze_platebody', 1),
              ($1, 'weapon', 'bronze_longsword', 1)`,
      [PLAYER_ID],
    );

    const first = spawnWorker({
      connectionString,
      operationId,
      hold: true,
    });
    const firstEvent = await first.event;
    if (firstEvent.event !== "committed" || firstEvent.replayed !== false) {
      throw new Error(`initial commit failed: ${JSON.stringify(firstEvent)}`);
    }
    first.child.kill("SIGKILL");
    await waitForExit(first.child);

    const replay = spawnWorker({ connectionString, operationId });
    const replayEvent = await replay.event;
    await waitForExit(replay.child);
    if (replayEvent.event !== "committed" || replayEvent.replayed !== true) {
      throw new Error(`durable replay failed: ${JSON.stringify(replayEvent)}`);
    }

    const stale = spawnWorker({
      connectionString,
      operationId: randomUUID(),
    });
    const staleEvent = await stale.event;
    await waitForExit(stale.child);
    if (
      staleEvent.event !== "error" ||
      !staleEvent.message?.includes("combat_loadout_state_conflict")
    ) {
      throw new Error(
        `stale writer was not fenced: ${JSON.stringify(staleEvent)}`,
      );
    }

    const collision = spawnWorker({
      connectionString,
      operationId,
      requestFingerprint: "forged-fingerprint",
    });
    const collisionEvent = await collision.event;
    await waitForExit(collision.child);
    if (
      collisionEvent.event !== "error" ||
      !collisionEvent.message?.includes("combat_loadout_operation_id_conflict")
    ) {
      throw new Error(
        `operation collision was not rejected: ${JSON.stringify(collisionEvent)}`,
      );
    }

    const [inventory, equipment, operations] = await Promise.all([
      pool.query<{
        itemId: string;
        quantity: number;
        slotIndex: number;
      }>(
        `SELECT "itemId", quantity, "slotIndex" FROM inventory
         WHERE "playerId" = $1 ORDER BY "slotIndex"`,
        [PLAYER_ID],
      ),
      pool.query<{ slotType: string; itemId: string; quantity: number }>(
        `SELECT "slotType", "itemId", quantity FROM equipment
         WHERE "playerId" = $1 ORDER BY "slotType"`,
        [PLAYER_ID],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM operations_log WHERE id = $1`,
        [operationId],
      ),
    ]);
    const exactInventory =
      JSON.stringify(inventory.rows) ===
      JSON.stringify([
        { itemId: "bronze_longsword", quantity: 1, slotIndex: 0 },
        { itemId: "lobster", quantity: 4, slotIndex: 2 },
        { itemId: "bronze_platebody", quantity: 1, slotIndex: 3 },
      ]);
    const exactEquipment =
      JSON.stringify(equipment.rows) ===
      JSON.stringify([
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
        { slotType: "body", itemId: "green_dhide_body", quantity: 1 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ]);
    if (
      !exactInventory ||
      !exactEquipment ||
      operations.rows[0]?.count !== "1"
    ) {
      throw new Error("post-kill combat loadout custody was not exact");
    }

    process.stdout.write(
      `${JSON.stringify({
        processKilledAfterCommit: true,
        durableReplayRecovered: true,
        staleWriterFenced: true,
        operationCollisionRejected: true,
        inventoryConserved: exactInventory,
        equipmentConserved: exactEquipment,
        roleArmorConserved: exactInventory && exactEquipment,
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
