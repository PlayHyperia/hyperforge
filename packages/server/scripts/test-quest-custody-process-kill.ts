import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { ITEMS, ItemType, type Item } from "@hyperforge/shared";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import type {
  QuestCompletionCommitRequest,
  QuestStartCommitRequest,
} from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const PLAYER_ID = "quest-custody-process-kill-agent";
const ACCOUNT_ID = "quest-custody-process-kill-account";
const QUEST_ID = "quest_custody_process_kill";
const STARTED_AT = 1_788_144_400_000;
const INITIAL_STAGE = "gather_supplies";
const FINAL_STAGE = "return_to_mentor";
const FINAL_PROGRESS = { done: 1 };
const ITEM_FIXTURES: Item[] = [
  {
    id: "bronze_shortsword",
    name: "Bronze Shortsword",
    type: ItemType.WEAPON,
    stackable: false,
    description: "Quest custody process-kill fixture",
    examine: "Quest custody process-kill fixture",
    tradeable: true,
    rarity: "common" as Item["rarity"],
    modelPath: null,
    iconPath: "",
  },
  {
    id: "xp_lamp_100",
    name: "XP Lamp (100)",
    type: ItemType.CONSUMABLE,
    stackable: false,
    description: "Quest custody process-kill fixture",
    examine: "Quest custody process-kill fixture",
    tradeable: false,
    rarity: "rare" as Item["rarity"],
    modelPath: null,
    iconPath: "",
  },
];

function registerItems(): void {
  for (const item of ITEM_FIXTURES) ITEMS.set(item.id, item);
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function startRequest(): QuestStartCommitRequest {
  const identity = {
    version: 1,
    playerId: PLAYER_ID,
    questId: QUEST_ID,
    questStartedAt: STARTED_AT,
  };
  const items = [
    { itemId: "bronze_shortsword", quantity: 1, stackable: false },
  ];
  return {
    operationId: `quest-start:${sha256(identity)}`,
    playerId: PLAYER_ID,
    requestFingerprint: sha256({
      ...identity,
      initialStage: INITIAL_STAGE,
      items,
    }),
    questId: QUEST_ID,
    questStartedAt: STARTED_AT,
    initialStage: INITIAL_STAGE,
    items,
  };
}

function completionRequest(): QuestCompletionCommitRequest {
  const identity = {
    version: 1,
    playerId: PLAYER_ID,
    questId: QUEST_ID,
    questStartedAt: STARTED_AT,
  };
  const items = [{ itemId: "xp_lamp_100", quantity: 1, stackable: false }];
  const xp = [{ skill: "attack" as const, xpAmount: 500 }];
  return {
    operationId: `quest-completion:${sha256(identity)}`,
    playerId: PLAYER_ID,
    requestFingerprint: sha256({
      ...identity,
      expectedStage: FINAL_STAGE,
      expectedProgress: FINAL_PROGRESS,
      questPoints: 1,
      items,
      xp,
    }),
    questId: QUEST_ID,
    questStartedAt: STARTED_AT,
    expectedStage: FINAL_STAGE,
    expectedProgress: FINAL_PROGRESS,
    questPoints: 1,
    items,
    xp,
  };
}

type WorkerMode = "start" | "completion";
type WorkerEvent = {
  event: "committed" | "error";
  mode: WorkerMode;
  replayed?: boolean;
  operationId?: string;
  currentQuestPoints?: number;
  committed?: Array<{ itemId: string; quantity: number; slotIndex: number }>;
  message?: string;
};

async function runWorker(): Promise<void> {
  const connectionString = process.env.QUEST_CUSTODY_TEST_DATABASE_URL;
  const mode = process.env.QUEST_CUSTODY_TEST_MODE as WorkerMode | undefined;
  const hold = process.argv.includes("--hold");
  if (!connectionString || (mode !== "start" && mode !== "completion")) {
    throw new Error("quest custody worker configuration is incomplete");
  }
  registerItems();
  const pool = new Pool({ connectionString, max: 2 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const receipt =
      mode === "start"
        ? await databaseSystem.commitQuestStartOperationAsync(startRequest())
        : await databaseSystem.commitQuestCompletionOperationAsync(
            completionRequest(),
          );
    process.stdout.write(
      `${JSON.stringify({
        event: "committed",
        mode,
        replayed: receipt.replayed,
        operationId: receipt.operationId,
        ...(mode === "completion"
          ? {
              currentQuestPoints: (
                receipt as Awaited<
                  ReturnType<
                    DatabaseSystem["commitQuestCompletionOperationAsync"]
                  >
                >
              ).currentQuestPoints,
            }
          : {}),
        committed: receipt.committed.map((item) => ({
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
        mode,
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
    const pool = new Pool({ connectionString, max: 6 });
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
  mode: WorkerMode;
  hold?: boolean;
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const args = [scriptPath, "--worker"];
  if (input.hold) args.push("--hold");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      QUEST_CUSTODY_TEST_DATABASE_URL: input.connectionString,
      QUEST_CUSTODY_TEST_MODE: input.mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("quest custody worker pipes were not created");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`quest custody worker timed out: ${stderr}`)),
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
          // Runtime diagnostics may share stdout; wait for the JSON event.
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
      reject(
        new Error(
          `quest custody worker exited ${String(code ?? signal)}: ${stderr}`,
        ),
      );
    });
  });
  return { child, event };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("quest custody worker did not exit")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertCommitted(
  event: WorkerEvent,
  mode: WorkerMode,
  replayed: boolean,
): void {
  if (
    event.event !== "committed" ||
    event.mode !== mode ||
    event.replayed !== replayed
  ) {
    throw new Error(
      `${mode} worker did not return the expected receipt: ${JSON.stringify(event)}`,
    );
  }
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-quest-custody-chaos-${process.pid}`;
  const databaseUser = "quest_custody_test";
  const databaseName = "quest_custody_test";
  const databasePassword = `quest-${randomUUID()}`;
  const image =
    process.env.QUEST_CUSTODY_TEST_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  let child: ChildProcess | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(`Docker is required for quest custody chaos: ${error}`);
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
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          path.dirname(scriptPath),
          "../src/database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt") VALUES ($1, $2, 'user', '2026-08-31T00:00:00.000Z')`,
      [ACCOUNT_ID, "Quest Custody Process Kill"],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent") VALUES ($1, $2, $3, 1)`,
      [PLAYER_ID, ACCOUNT_ID, "Quest Custody Agent"],
    );

    const start = spawnWorker({ connectionString, mode: "start", hold: true });
    child = start.child;
    assertCommitted(await start.event, "start", false);
    if (!child.kill("SIGKILL")) {
      throw new Error("failed to SIGKILL committed quest-start worker");
    }
    await waitForExit(child);
    if (child.signalCode !== "SIGKILL") {
      throw new Error("quest-start worker did not exit from SIGKILL");
    }
    child = null;

    const afterStart = await pool.query<{
      status: string;
      currentStage: string;
      startedAt: string;
      starterCount: string;
    }>(
      `SELECT q.status, q."currentStage", q."startedAt",
              (SELECT COUNT(*) FROM inventory i WHERE i."playerId" = q."playerId" AND i."itemId" = 'bronze_shortsword') AS "starterCount"
         FROM quest_progress q
        WHERE q."playerId" = $1 AND q."questId" = $2`,
      [PLAYER_ID, QUEST_ID],
    );
    if (
      afterStart.rows.length !== 1 ||
      afterStart.rows[0].status !== "in_progress" ||
      afterStart.rows[0].currentStage !== INITIAL_STAGE ||
      Number(afterStart.rows[0].startedAt) !== STARTED_AT ||
      Number(afterStart.rows[0].starterCount) !== 1
    ) {
      throw new Error(
        `quest start did not survive SIGKILL: ${JSON.stringify(afterStart.rows)}`,
      );
    }

    const startReplay = spawnWorker({ connectionString, mode: "start" });
    assertCommitted(await startReplay.event, "start", true);
    await waitForExit(startReplay.child);

    await pool.query(
      `UPDATE quest_progress SET "currentStage" = $3, "stageProgress" = $4::jsonb WHERE "playerId" = $1 AND "questId" = $2`,
      [PLAYER_ID, QUEST_ID, FINAL_STAGE, JSON.stringify(FINAL_PROGRESS)],
    );
    const completion = spawnWorker({
      connectionString,
      mode: "completion",
      hold: true,
    });
    child = completion.child;
    assertCommitted(await completion.event, "completion", false);
    if (!child.kill("SIGKILL")) {
      throw new Error("failed to SIGKILL committed quest-completion worker");
    }
    await waitForExit(child);
    if (child.signalCode !== "SIGKILL") {
      throw new Error("quest-completion worker did not exit from SIGKILL");
    }
    child = null;

    const completionReplay = spawnWorker({
      connectionString,
      mode: "completion",
    });
    const completionReplayEvent = await completionReplay.event;
    assertCommitted(completionReplayEvent, "completion", true);
    if (completionReplayEvent.currentQuestPoints !== 1) {
      throw new Error(
        `completion replay returned wrong points: ${JSON.stringify(completionReplayEvent)}`,
      );
    }
    await waitForExit(completionReplay.child);

    const forwardStartReplay = spawnWorker({
      connectionString,
      mode: "start",
    });
    assertCommitted(await forwardStartReplay.event, "start", true);
    await waitForExit(forwardStartReplay.child);

    const final = await pool.query<{
      questPoints: string;
      attackXp: string;
      attackLevel: string;
      status: string;
      completedAt: string;
      starterCount: string;
      lampCount: string;
      startAuditCount: string;
      completionAuditCount: string;
      startOperationCount: string;
      completionOperationCount: string;
    }>(
      `SELECT c."questPoints", c."attackXp", c."attackLevel",
              q.status, q."completedAt",
              (SELECT COUNT(*) FROM inventory i WHERE i."playerId" = c.id AND i."itemId" = 'bronze_shortsword') AS "starterCount",
              (SELECT COUNT(*) FROM inventory i WHERE i."playerId" = c.id AND i."itemId" = 'xp_lamp_100') AS "lampCount",
              (SELECT COUNT(*) FROM quest_audit_log a WHERE a."playerId" = c.id AND a."questId" = $2 AND a.action = 'started') AS "startAuditCount",
              (SELECT COUNT(*) FROM quest_audit_log a WHERE a."playerId" = c.id AND a."questId" = $2 AND a.action = 'completed') AS "completionAuditCount",
              (SELECT COUNT(*) FROM operations_log o WHERE o."playerId" = c.id AND o."operationType" = 'quest_start') AS "startOperationCount",
              (SELECT COUNT(*) FROM operations_log o WHERE o."playerId" = c.id AND o."operationType" = 'quest_completion') AS "completionOperationCount"
         FROM characters c
         JOIN quest_progress q ON q."playerId" = c.id AND q."questId" = $2
        WHERE c.id = $1`,
      [PLAYER_ID, QUEST_ID],
    );
    const row = final.rows[0];
    if (
      final.rows.length !== 1 ||
      Number(row.questPoints) !== 1 ||
      Number(row.attackXp) !== 500 ||
      Number(row.attackLevel) !== 5 ||
      row.status !== "completed" ||
      !Number.isSafeInteger(Number(row.completedAt)) ||
      Number(row.completedAt) <= 0 ||
      Number(row.starterCount) !== 1 ||
      Number(row.lampCount) !== 1 ||
      Number(row.startAuditCount) !== 1 ||
      Number(row.completionAuditCount) !== 1 ||
      Number(row.startOperationCount) !== 1 ||
      Number(row.completionOperationCount) !== 1
    ) {
      throw new Error(
        `quest custody process-kill proof mismatch: ${JSON.stringify(final.rows)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        startSignal: "SIGKILL",
        completionSignal: "SIGKILL",
        startReplay: true,
        completionReplay: true,
        forwardStartReplay: true,
        questPoints: 1,
        attackXp: 500,
        starterItems: 1,
        completionItems: 1,
      })}\n`,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child).catch(() => undefined);
    }
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
