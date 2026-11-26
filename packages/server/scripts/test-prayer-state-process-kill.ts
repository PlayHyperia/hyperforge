import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../src/database/schema.js";
import type {
  PrayerPersistenceSnapshot,
  PrayerStateCommitRequest,
} from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const PLAYER_ID = "prayer-state-chaos-agent";

function fingerprint(
  transition: PrayerStateCommitRequest["transition"],
  expected: PrayerPersistenceSnapshot,
  committed: PrayerPersistenceSnapshot,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId: PLAYER_ID,
        transition,
        expected,
        committed,
      }),
    )
    .digest("hex");
}

function requestFor(input: {
  operationId: string;
  transition: PrayerStateCommitRequest["transition"];
  expected: PrayerPersistenceSnapshot;
  committed: PrayerPersistenceSnapshot;
  requestFingerprint?: string;
}): PrayerStateCommitRequest {
  return {
    operationId: input.operationId,
    playerId: PLAYER_ID,
    transition: input.transition,
    expected: input.expected,
    committed: input.committed,
    requestFingerprint:
      input.requestFingerprint ??
      fingerprint(input.transition, input.expected, input.committed),
  };
}

type WorkerEvent = {
  event: "committed" | "error";
  replayed?: boolean;
  committed?: PrayerPersistenceSnapshot;
  message?: string;
};

async function runWorker(): Promise<void> {
  const connectionString = process.env.PRAYER_STATE_TEST_DATABASE_URL;
  const requestJson = process.env.PRAYER_STATE_TEST_REQUEST;
  const hold = process.argv.includes("--hold");
  if (!connectionString || !requestJson) {
    throw new Error("prayer state worker configuration is incomplete");
  }
  const request = JSON.parse(requestJson) as PrayerStateCommitRequest;
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const receipt =
      await databaseSystem.commitPrayerStateOperationAsync(request);
    process.stdout.write(
      `${JSON.stringify({
        event: "committed",
        replayed: receipt.replayed,
        committed: receipt.committed,
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
  request: PrayerStateCommitRequest;
  hold?: boolean;
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const args = [scriptPath, "--worker"];
  if (input.hold) args.push("--hold");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      PRAYER_STATE_TEST_DATABASE_URL: input.connectionString,
      PRAYER_STATE_TEST_REQUEST: JSON.stringify(input.request),
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
          // Build diagnostics may share stdout; wait for the structured event.
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

async function runOne(
  connectionString: string,
  request: PrayerStateCommitRequest,
): Promise<WorkerEvent> {
  const worker = spawnWorker({ connectionString, request });
  const event = await worker.event;
  await waitForExit(worker.child);
  return event;
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-prayer-state-chaos-${process.pid}`;
  const databaseUser = "prayer_state_test";
  const databaseName = "prayer_state_test";
  const databasePassword = `prayer-${randomUUID()}`;
  const image =
    process.env.PRAYER_STATE_TEST_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(`Docker is required for prayer custody chaos: ${error}`);
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
        "prayerPoints" integer NOT NULL DEFAULT 1,
        "prayerPointUnits" integer NOT NULL DEFAULT 1000000,
        "prayerMaxPoints" integer NOT NULL DEFAULT 1,
        "activePrayers" jsonb NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE operations_log (
        id text PRIMARY KEY,
        "playerId" text NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        "operationType" text NOT NULL,
        "operationState" jsonb NOT NULL,
        completed boolean DEFAULT false,
        timestamp bigint NOT NULL,
        "completedAt" bigint
      );
    `);
    await pool.query(
      `INSERT INTO characters (
        id, "prayerPoints", "prayerPointUnits", "prayerMaxPoints", "activePrayers"
      ) VALUES ($1, 5, 5000000, 5, '[]'::jsonb)`,
      [PLAYER_ID],
    );

    const initialExpected = {
      pointUnits: 5_000_000,
      maxPoints: 5,
      activePrayers: [],
    };
    const toggled = {
      ...initialExpected,
      activePrayers: ["battle_focus"],
    };
    const initialRequest = requestFor({
      operationId: randomUUID(),
      transition: "toggle",
      expected: initialExpected,
      committed: toggled,
    });
    const initial = spawnWorker({
      connectionString,
      request: initialRequest,
      hold: true,
    });
    const initialEvent = await initial.event;
    if (initialEvent.event !== "committed" || initialEvent.replayed !== false) {
      throw new Error(
        `initial prayer transition failed: ${JSON.stringify(initialEvent)}`,
      );
    }
    initial.child.kill("SIGKILL");
    await waitForExit(initial.child);

    const replayEvent = await runOne(connectionString, initialRequest);
    if (replayEvent.event !== "committed" || replayEvent.replayed !== true) {
      throw new Error(
        `durable prayer replay failed: ${JSON.stringify(replayEvent)}`,
      );
    }

    const collisionRequest = requestFor({
      operationId: initialRequest.operationId,
      transition: "toggle",
      expected: toggled,
      committed: { ...toggled, activePrayers: [] },
    });
    const collision = await runOne(connectionString, collisionRequest);
    if (
      collision.event !== "error" ||
      !collision.message?.includes("prayer_state_operation_id_conflict")
    ) {
      throw new Error(
        `prayer operation collision escaped: ${JSON.stringify(collision)}`,
      );
    }

    const afterDrain = {
      ...toggled,
      pointUnits: 4_000_000,
    };
    const drainRequest = requestFor({
      operationId: randomUUID(),
      transition: "drain",
      expected: toggled,
      committed: afterDrain,
    });
    const drain = await runOne(connectionString, drainRequest);
    if (drain.event !== "committed" || drain.replayed !== false) {
      throw new Error(`later prayer drain failed: ${JSON.stringify(drain)}`);
    }

    const oldReplay = await runOne(connectionString, initialRequest);
    if (
      oldReplay.event !== "committed" ||
      oldReplay.committed?.pointUnits !== 4_000_000 ||
      oldReplay.committed.activePrayers[0] !== "battle_focus"
    ) {
      throw new Error(
        `old prayer replay rolled state back: ${JSON.stringify(oldReplay)}`,
      );
    }

    const staleRequest = requestFor({
      operationId: randomUUID(),
      transition: "deactivate_all",
      expected: toggled,
      committed: { ...toggled, activePrayers: [] },
    });
    const stale = await runOne(connectionString, staleRequest);
    if (
      stale.event !== "error" ||
      !stale.message?.includes("prayer_state_conflict")
    ) {
      throw new Error(
        `stale prayer CAS was accepted: ${JSON.stringify(stale)}`,
      );
    }

    const depleted = {
      pointUnits: 0,
      maxPoints: 5,
      activePrayers: [],
    };
    const depletion = await runOne(
      connectionString,
      requestFor({
        operationId: randomUUID(),
        transition: "drain",
        expected: afterDrain,
        committed: depleted,
      }),
    );
    if (
      depletion.event !== "committed" ||
      JSON.stringify(depletion.committed) !== JSON.stringify(depleted)
    ) {
      throw new Error(
        `prayer depletion was not atomic: ${JSON.stringify(depletion)}`,
      );
    }

    const [character, operations] = await Promise.all([
      pool.query<{
        prayerPoints: number;
        prayerPointUnits: number;
        prayerMaxPoints: number;
        activePrayers: string[];
      }>(
        `SELECT
          "prayerPoints", "prayerPointUnits", "prayerMaxPoints", "activePrayers"
         FROM characters WHERE id = $1`,
        [PLAYER_ID],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM operations_log
         WHERE "playerId" = $1
           AND "operationType" = 'prayer_state_transition'`,
        [PLAYER_ID],
      ),
    ]);
    const exactState = character.rows[0];
    if (
      exactState?.prayerPoints !== 0 ||
      exactState.prayerPointUnits !== 0 ||
      exactState.prayerMaxPoints !== 5 ||
      exactState.activePrayers.length !== 0 ||
      operations.rows[0]?.count !== "3"
    ) {
      throw new Error("post-kill prayer custody was not exact");
    }

    process.stdout.write(
      `${JSON.stringify({
        processKilledAfterCommit: true,
        durableReplayRecovered: true,
        operationCollisionRejected: true,
        staleCompareAndSwapRejected: true,
        oldReplayDidNotRollbackNewerState: true,
        depletionAndDeactivationAtomic: true,
        fixedPointCustodyExact: true,
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

if (process.argv.includes("--worker")) await runWorker();
else await runParent();
