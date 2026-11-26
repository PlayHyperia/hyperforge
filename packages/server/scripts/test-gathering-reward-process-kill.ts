import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { EventBus, EventType, QuestSystem } from "@hyperforge/shared";

import { QuestRepository } from "../src/database/repositories/QuestRepository.js";
import * as schema from "../src/database/schema.js";
import type { GatheringRewardCommitRequest } from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const PLAYER_ID = "gathering-reward-chaos-agent";

type RequestInput = Omit<
  GatheringRewardCommitRequest,
  "operationId" | "requestFingerprint"
>;

const BASE_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  resourceId: "fishing_spot_chaos_1_1",
  depleteAfterCommit: true,
  respawnTicks: 300,
  skill: "fishing",
  xpAmount: 17.5,
  reward: { itemId: "raw_shrimp", quantity: 1, stackable: false },
  secondaryItemId: "fishing_bait",
};

function fingerprint(input: RequestInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 2, ...input }), "utf8")
    .digest("hex");
}

function requestFor(
  operationId: string,
  input: RequestInput = BASE_INPUT,
  requestFingerprint = fingerprint(input),
): GatheringRewardCommitRequest {
  return { operationId, requestFingerprint, ...input };
}

type WorkerEvent = {
  event: "committed" | "quest-recovered" | "error";
  replayed?: boolean;
  operationCommittedXp?: number;
  currentXp?: number;
  currentLevel?: number;
  depletedUntil?: number | null;
  activeResourceState?: boolean;
  inventory?: Array<{ itemId: string; quantity: number; slotIndex: number }>;
  questStage?: string | null;
  questProgress?: Record<string, number> | null;
  pendingQuestReceipts?: number;
  message?: string;
};

async function runQuestRecoveryWorker(): Promise<void> {
  const connectionString = process.env.GATHERING_REWARD_TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("quest recovery worker configuration is incomplete");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const questRepository = new QuestRepository(db, pool);
    const eventBus = new EventBus();
    const world = {
      isServer: true,
      $eventBus: eventBus,
      getSystem: (name: string) =>
        name === "database"
          ? { getQuestRepository: () => questRepository }
          : undefined,
    } as never;
    const questSystem = new QuestSystem(world);
    await questSystem.init();
    eventBus.emitEvent(EventType.PLAYER_REGISTERED, { playerId: PLAYER_ID });
    await eventBus.waitForPendingHandlers(10_000);
    const progress = await questRepository.getQuestProgress(
      PLAYER_ID,
      "fresh_catch",
    );
    const pending =
      await questRepository.getPendingGatheringProgressReceipts(PLAYER_ID);
    questSystem.destroy();
    process.stdout.write(
      `${JSON.stringify({
        event: "quest-recovered",
        questStage: progress?.currentStage ?? null,
        questProgress: progress?.stageProgress ?? null,
        pendingQuestReceipts: pending.length,
      } satisfies WorkerEvent)}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        event: "error",
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerEvent)}\n`,
    );
  } finally {
    await pool.end();
  }
}

async function runWorker(): Promise<void> {
  const connectionString = process.env.GATHERING_REWARD_TEST_DATABASE_URL;
  const operationId = process.env.GATHERING_REWARD_TEST_OPERATION_ID;
  const requestJson = process.env.GATHERING_REWARD_TEST_REQUEST;
  const requestFingerprint = process.env.GATHERING_REWARD_TEST_FINGERPRINT;
  const hold = process.argv.includes("--hold");
  if (!connectionString || !operationId || !requestJson) {
    throw new Error("gathering reward worker configuration is incomplete");
  }
  const input = JSON.parse(requestJson) as RequestInput;
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const receipt = await databaseSystem.commitGatheringRewardOperationAsync(
      requestFor(operationId, input, requestFingerprint),
    );
    const activeResourceStates =
      await databaseSystem.getGatheringResourceStatesAsync([input.resourceId]);
    process.stdout.write(
      `${JSON.stringify({
        event: "committed",
        replayed: receipt.replayed,
        operationCommittedXp: receipt.operationCommittedXp,
        currentXp: receipt.currentXp,
        currentLevel: receipt.currentLevel,
        depletedUntil: receipt.depletedUntil,
        activeResourceState: activeResourceStates.some(
          (state) =>
            state.resourceId === input.resourceId &&
            state.operationId === operationId &&
            state.respawnAt === receipt.depletedUntil,
        ),
        inventory: receipt.committed.map((item) => ({
          itemId: item.itemId,
          quantity: item.quantity,
          slotIndex: item.slotIndex,
        })),
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
  request?: RequestInput;
  requestFingerprint?: string;
  hold?: boolean;
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const request = input.request ?? BASE_INPUT;
  const args = [scriptPath, "--worker"];
  if (input.hold) args.push("--hold");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      GATHERING_REWARD_TEST_DATABASE_URL: input.connectionString,
      GATHERING_REWARD_TEST_OPERATION_ID: input.operationId,
      GATHERING_REWARD_TEST_REQUEST: JSON.stringify(request),
      GATHERING_REWARD_TEST_FINGERPRINT:
        input.requestFingerprint ?? fingerprint(request),
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
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (parsed.event === "committed" || parsed.event === "error") {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          // Build/runtime diagnostics may share stdout; wait for JSON.
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

function spawnQuestRecovery(connectionString: string): {
  child: ChildProcess;
  event: Promise<WorkerEvent>;
} {
  const child = spawn(process.execPath, [scriptPath, "--quest-recovery"], {
    env: {
      ...process.env,
      GATHERING_REWARD_TEST_DATABASE_URL: connectionString,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("quest recovery worker pipes were not created");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`quest recovery worker timed out: ${stderr}`)),
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
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (parsed.event === "quest-recovered" || parsed.event === "error") {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          // Build/runtime diagnostics may share stdout; wait for JSON.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) return;
      clearTimeout(timer);
      reject(
        new Error(`quest recovery worker exited ${code ?? signal}: ${stderr}`),
      );
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
  const containerName = `hyperia-gathering-reward-chaos-${process.pid}`;
  const databaseUser = "gathering_reward_test";
  const databaseName = "gathering_reward_test";
  const databasePassword = `gathering-${randomUUID()}`;
  const originalOperationId = `gathering-reward:${randomUUID()}`;
  const image =
    process.env.GATHERING_REWARD_TEST_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(
        `Docker is required for gathering reward chaos: ${error}`,
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
        "questPoints" integer DEFAULT 0,
        "woodcuttingXp" integer DEFAULT 0,
        "woodcuttingLevel" integer DEFAULT 1,
        "miningXp" integer DEFAULT 0,
        "miningLevel" integer DEFAULT 1,
        "fishingXp" integer DEFAULT 0,
        "fishingLevel" integer DEFAULT 1
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
      CREATE TABLE quest_progress (
        id serial PRIMARY KEY,
        "playerId" text NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        "questId" text NOT NULL,
        status text DEFAULT 'not_started' NOT NULL,
        "currentStage" text,
        "stageProgress" jsonb DEFAULT '{}'::jsonb,
        "startedAt" bigint,
        "completedAt" bigint,
        UNIQUE ("playerId", "questId")
      );
      CREATE TABLE quest_audit_log (
        id serial PRIMARY KEY,
        "playerId" text NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        "questId" text NOT NULL,
        action text NOT NULL,
        "questPointsAwarded" integer DEFAULT 0,
        "stageId" text,
        "stageProgress" jsonb DEFAULT '{}'::jsonb,
        timestamp bigint NOT NULL,
        metadata jsonb DEFAULT '{}'::jsonb
      );
    `);
    await pool.query(
      `INSERT INTO characters (id, "fishingXp", "fishingLevel")
       VALUES ($1, 80, 1)`,
      [PLAYER_ID],
    );
    const migration = await readFile(
      new URL(
        "../src/database/migrations/0062_preserve_fractional_gathering_xp.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
    const resourceStateMigration = await readFile(
      new URL(
        "../src/database/migrations/0079_add_durable_gathering_resource_states.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of resourceStateMigration.split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) await pool.query(statement);
    }
    const questProgressMigration = await readFile(
      new URL(
        "../src/database/migrations/0080_add_durable_quest_gathering_progress.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (let run = 0; run < 2; run++) {
      for (const statement of questProgressMigration.split(
        "--> statement-breakpoint",
      )) {
        if (statement.trim()) await pool.query(statement);
      }
    }
    await pool.query(`UPDATE characters SET "fishingXp" = 80.5 WHERE id = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'fishing_bait', 2, 0), ($1, 'logs', 1, 2)`,
      [PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO quest_progress
         ("playerId", "questId", status, "currentStage", "stageProgress", "startedAt")
       VALUES ($1, 'fresh_catch', 'in_progress', 'catch_shrimp', '{}'::jsonb, $2)`,
      [PLAYER_ID, 1_786_388_400_000],
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
      initialEvent.activeResourceState !== true ||
      !initialEvent.depletedUntil ||
      initialEvent.currentXp !== 98 ||
      initialEvent.currentLevel !== 2
    ) {
      throw new Error(`initial reward failed: ${JSON.stringify(initialEvent)}`);
    }
    initial.child.kill("SIGKILL");
    await waitForExit(initial.child);

    const questRecovery = spawnQuestRecovery(connectionString);
    const questRecoveryEvent = await questRecovery.event;
    await waitForExit(questRecovery.child);
    if (
      questRecoveryEvent.event !== "quest-recovered" ||
      questRecoveryEvent.questStage !== "catch_shrimp" ||
      questRecoveryEvent.questProgress?.raw_shrimp !== 1 ||
      questRecoveryEvent.pendingQuestReceipts !== 0
    ) {
      throw new Error(
        `durable quest recovery failed: ${JSON.stringify(questRecoveryEvent)}`,
      );
    }

    const replay = spawnWorker({
      connectionString,
      operationId: originalOperationId,
    });
    const replayEvent = await replay.event;
    await waitForExit(replay.child);
    if (
      replayEvent.event !== "committed" ||
      replayEvent.replayed !== true ||
      replayEvent.activeResourceState !== true ||
      replayEvent.depletedUntil !== initialEvent.depletedUntil ||
      replayEvent.currentXp !== 98
    ) {
      throw new Error(`durable replay failed: ${JSON.stringify(replayEvent)}`);
    }

    const collisionInput: RequestInput = {
      ...BASE_INPUT,
      reward: { itemId: "raw_anchovies", quantity: 1, stackable: false },
    };
    const collision = spawnWorker({
      connectionString,
      operationId: originalOperationId,
      request: collisionInput,
    });
    const collisionEvent = await collision.event;
    await waitForExit(collision.child);
    if (
      collisionEvent.event !== "error" ||
      !collisionEvent.message?.includes(
        "gathering_reward_operation_id_conflict",
      )
    ) {
      throw new Error(
        `operation collision was not rejected: ${JSON.stringify(collisionEvent)}`,
      );
    }

    const laterOperationId = `gathering-reward:${randomUUID()}`;
    const laterInput: RequestInput = {
      ...BASE_INPUT,
      resourceId: "fishing_spot_chaos_2_2",
    };
    const later = spawnWorker({
      connectionString,
      operationId: laterOperationId,
      request: laterInput,
    });
    const laterEvent = await later.event;
    await waitForExit(later.child);
    if (
      laterEvent.event !== "committed" ||
      laterEvent.replayed !== false ||
      laterEvent.currentXp !== 115.5
    ) {
      throw new Error(`later reward failed: ${JSON.stringify(laterEvent)}`);
    }

    const missingSecondary = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      request: {
        ...BASE_INPUT,
        resourceId: "fishing_spot_chaos_3_3",
      },
    });
    const missingSecondaryEvent = await missingSecondary.event;
    await waitForExit(missingSecondary.child);
    if (
      missingSecondaryEvent.event !== "error" ||
      !missingSecondaryEvent.message?.includes(
        "gathering_reward_secondary_missing",
      )
    ) {
      throw new Error(
        `secondary rollback failed: ${JSON.stringify(missingSecondaryEvent)}`,
      );
    }

    const oldReplay = spawnWorker({
      connectionString,
      operationId: originalOperationId,
    });
    const oldReplayEvent = await oldReplay.event;
    await waitForExit(oldReplay.child);
    if (
      oldReplayEvent.event !== "committed" ||
      oldReplayEvent.currentXp !== 115.5 ||
      oldReplayEvent.inventory?.filter((item) => item.itemId === "raw_shrimp")
        .length !== 2
    ) {
      throw new Error(
        `old replay returned stale custody: ${JSON.stringify(oldReplayEvent)}`,
      );
    }

    const [inventory, character, operations, resourceStates, questState] =
      await Promise.all([
        pool.query<{ itemId: string; quantity: number; slotIndex: number }>(
          `SELECT "itemId", quantity, "slotIndex" FROM inventory
         WHERE "playerId" = $1 ORDER BY "slotIndex"`,
          [PLAYER_ID],
        ),
        pool.query<{ xp: number; level: number }>(
          `SELECT "fishingXp" AS xp, "fishingLevel" AS level
         FROM characters WHERE id = $1`,
          [PLAYER_ID],
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM operations_log
         WHERE "playerId" = $1 AND "operationType" = 'gathering_reward'`,
          [PLAYER_ID],
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM gathering_resource_states
         WHERE respawn_at > $1`,
          [Date.now()],
        ),
        pool.query<{
          progress: Record<string, number>;
          original_resolution: string;
          pending_count: string;
          audit_count: string;
        }>(
          `SELECT qp."stageProgress" AS progress,
             (SELECT resolution FROM quest_gathering_progress_receipts
              WHERE operation_id = $2 AND quest_id = 'fresh_catch') AS original_resolution,
             (SELECT count(*)::text FROM quest_gathering_progress_receipts
              WHERE player_id = $1 AND resolved_at IS NULL) AS pending_count,
             (SELECT count(*)::text FROM quest_audit_log
              WHERE "playerId" = $1 AND "questId" = 'fresh_catch'
                AND action = 'progressed') AS audit_count
           FROM quest_progress qp
           WHERE qp."playerId" = $1 AND qp."questId" = 'fresh_catch'`,
          [PLAYER_ID, originalOperationId],
        ),
      ]);
    const exactInventory =
      JSON.stringify(inventory.rows) ===
      JSON.stringify([
        { itemId: "raw_shrimp", quantity: 1, slotIndex: 0 },
        { itemId: "raw_shrimp", quantity: 1, slotIndex: 1 },
        { itemId: "logs", quantity: 1, slotIndex: 2 },
      ]);
    const exactSkill =
      character.rows[0]?.xp === 115.5 && character.rows[0]?.level === 2;
    const exactQuestRecovery =
      questState.rows[0]?.progress.raw_shrimp === 1 &&
      questState.rows[0]?.original_resolution === "applied" &&
      questState.rows[0]?.pending_count === "1" &&
      questState.rows[0]?.audit_count === "1";
    if (
      !exactInventory ||
      !exactSkill ||
      !exactQuestRecovery ||
      operations.rows[0]?.count !== "2" ||
      resourceStates.rows[0]?.count !== "2"
    ) {
      throw new Error("post-kill gathering custody was not exact");
    }

    process.stdout.write(
      `${JSON.stringify({
        processKilledAfterCommit: true,
        fractionalXpMigrationApplied: true,
        questProgressMigrationIdempotent: true,
        durableReplayRecovered: true,
        durableResourceDeadlineRecovered: true,
        durableQuestProgressRecoveredByReplacementProcess: exactQuestRecovery,
        questProgressAppliedExactlyOnce: true,
        replacementProcessHydratedDepletion: true,
        itemSecondaryAndXpAtomic: true,
        missingSecondaryRolledBackEverything: true,
        operationCollisionRejected: true,
        oldReplayDidNotRollbackNewerState: true,
        inventoryConserved: exactInventory,
        skillConserved: exactSkill,
        receiptCount: Number(operations.rows[0]?.count ?? 0),
        activeResourceStateCount: Number(resourceStates.rows[0]?.count ?? 0),
      })}\n`,
    );
  } finally {
    await pool?.end().catch(() => undefined);
    if (containerStarted) {
      await docker(["rm", "-f", containerName]).catch(() => undefined);
    }
  }
}

if (process.argv.includes("--quest-recovery")) {
  await runQuestRecoveryWorker();
} else if (process.argv.includes("--worker")) {
  await runWorker();
} else {
  await runParent();
}
