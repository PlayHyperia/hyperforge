import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  EventBus,
  EventType,
  ITEMS,
  QuestSystem,
  generateKillToken,
  serializeGroundItemMobLootCommitFingerprint,
  serializeGroundItemSourceRegistrationFingerprint,
  type StreamingDuelDamageObservationContext,
  type World,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import {
  QuestRepository,
  type QuestKillProgressReceiptRow,
} from "../src/database/repositories/QuestRepository.js";
import * as schema from "../src/database/schema.js";
import type {
  DuelDamageCommitRequest,
  GroundItemMobLootCommitRequest,
  GroundItemSourceRegistrationRequest,
  QuestCompletionCommitRequest,
} from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const MOB_PLAYER_ID = "ground-duel-chaos-mob-agent";
const MOB_ACCOUNT_ID = "ground-duel-chaos-mob-account";
const QUEST_ID = "goblin_slayer";
const QUEST_KILL_STAGE = "kill_goblins";
const QUEST_STARTED_AT = 1_788_148_000_000;
const MOB_OPERATION_ID =
  "ground-item-mob-loot:11111111-1111-4111-8111-111111111111";
const MOB_SOURCE_ID = "ground_item_22222222-2222-4222-8222-222222222222";
const MOB_CONTRIBUTION_ID =
  "ground-item-source:33333333-3333-4333-8333-333333333333";
const MOB_ID = "ground-duel-chaos-mob";
const MOB_TYPE = "goblin";
const MOB_DEATH_AT = 1_788_148_000_500;
const MOB_POSITION = { x: 60.5, y: 0.2, z: 60.5 };
const MOB_ATTACK_STYLE = "aggressive";
const MOB_DAMAGE = 20;
const KILL_SECRET = "ground-duel-chaos-kill-secret-32-bytes-minimum";
const DAMAGE_ATTACKER_ID = "ground-duel-chaos-damage-attacker";
const DAMAGE_TARGET_ID = "ground-duel-chaos-damage-target";
const DAMAGE_ATTACKER_ACCOUNT_ID = "ground-duel-chaos-attacker-account";
const DAMAGE_TARGET_ACCOUNT_ID = "ground-duel-chaos-target-account";
const DAMAGE_OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const PROJECTILE_OPERATION_ID = "spell-runes:1234567890abcdefghij";
const PROJECTILE_FINGERPRINT = "ab".repeat(32);
const ownedChildren = new Set<ChildProcess>();

function registerItems(): void {
  ITEMS.set("air_rune", {
    id: "air_rune",
    name: "Air rune",
    type: "resource",
    stackable: true,
  } as never);
  ITEMS.set("xp_lamp_100", {
    id: "xp_lamp_100",
    name: "XP Lamp (100)",
    type: "consumable",
    stackable: false,
  } as never);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mobSourceRequest(): GroundItemSourceRegistrationRequest {
  const input: Omit<GroundItemSourceRegistrationRequest, "requestFingerprint"> =
    {
      contributionId: MOB_CONTRIBUTION_ID,
      preferredSourceId: MOB_SOURCE_ID,
      itemId: "air_rune",
      quantity: 4,
      stackable: true,
      position: MOB_POSITION,
      tile: { x: 60, z: 60 },
      droppedBy: MOB_PLAYER_ID,
      lifetimeMs: 120_000,
      lootProtectionMs: 60_000,
      allowMerge: false,
    };
  return {
    ...input,
    requestFingerprint: sha256(
      serializeGroundItemSourceRegistrationFingerprint(input),
    ),
  };
}

async function mobRequest(): Promise<GroundItemMobLootCommitRequest> {
  const identity = {
    operationId: MOB_OPERATION_ID,
    killedBy: MOB_PLAYER_ID,
    mobId: MOB_ID,
    mobType: MOB_TYPE,
    deathTimestamp: MOB_DEATH_AT,
    position: MOB_POSITION,
    killToken: await generateKillToken(
      MOB_ID,
      MOB_PLAYER_ID,
      MOB_DEATH_AT,
      MOB_OPERATION_ID,
      MOB_ATTACK_STYLE,
      MOB_DAMAGE,
    ),
    attackStyle: MOB_ATTACK_STYLE,
    damageDealt: MOB_DAMAGE,
  };
  return {
    ...identity,
    requestFingerprint: sha256(
      serializeGroundItemMobLootCommitFingerprint(identity),
    ),
    sources: [mobSourceRequest()],
  };
}

const damageObservation: StreamingDuelDamageObservationContext = {
  operationId: DAMAGE_OPERATION_ID,
  tick: 31,
  observedAt: 1_788_148_001_000,
  cycleId: "ground-duel-chaos-cycle",
  duelId: "ground-duel-chaos-duel",
  actorId: DAMAGE_ATTACKER_ID,
  opponentId: DAMAGE_TARGET_ID,
  phase: "FIGHTING",
  combatRole: "mage",
  tacticalMacro: "kite",
  requestedDamage: 7,
};

function damageRequest(): DuelDamageCommitRequest {
  const projectileCost = {
    operationType: "projectile_rune_cost" as const,
    operationId: PROJECTILE_OPERATION_ID,
    playerId: DAMAGE_ATTACKER_ID,
    requestFingerprint: PROJECTILE_FINGERPRINT,
  };
  const fingerprintIdentity = {
    version: 2,
    attackerId: DAMAGE_ATTACKER_ID,
    targetPlayerId: DAMAGE_TARGET_ID,
    requestedDamage: damageObservation.requestedDamage,
    attackStyle: "magic",
    publicActionObservation: damageObservation,
    projectileCost,
  };
  return {
    attackerId: fingerprintIdentity.attackerId,
    targetPlayerId: fingerprintIdentity.targetPlayerId,
    requestedDamage: fingerprintIdentity.requestedDamage,
    attackStyle: fingerprintIdentity.attackStyle,
    publicActionObservation: fingerprintIdentity.publicActionObservation,
    projectileCost: fingerprintIdentity.projectileCost,
    operationId: DAMAGE_OPERATION_ID,
    requestFingerprint: sha256(JSON.stringify(fingerprintIdentity)),
  };
}

function questCompletionRequest(): QuestCompletionCommitRequest {
  const identity = {
    version: 1,
    playerId: MOB_PLAYER_ID,
    questId: QUEST_ID,
    questStartedAt: QUEST_STARTED_AT,
  };
  const items = [{ itemId: "xp_lamp_100", quantity: 1, stackable: false }];
  const xp: QuestCompletionCommitRequest["xp"] = [];
  return {
    operationId: `quest-completion:${sha256(JSON.stringify(identity))}`,
    playerId: MOB_PLAYER_ID,
    requestFingerprint: sha256(
      JSON.stringify({
        ...identity,
        expectedStage: QUEST_KILL_STAGE,
        expectedProgress: { kills: 15 },
        questPoints: 1,
        items,
        xp,
      }),
    ),
    questId: QUEST_ID,
    questStartedAt: QUEST_STARTED_AT,
    expectedStage: QUEST_KILL_STAGE,
    expectedProgress: { kills: 15 },
    questPoints: 1,
    items,
    xp,
  };
}

type WorkerMode =
  | "mob"
  | "quest"
  | "quest-system"
  | "quest-completion"
  | "quest-system-completed"
  | "damage";
type WorkerEvent = {
  event: "committed" | "error";
  mode: WorkerMode;
  operationId?: string;
  replayed?: boolean;
  sourceCount?: number;
  combatProgressCount?: number;
  appliedDamage?: number;
  healthAfter?: number;
  questStatus?: "applied" | "replayed" | "retired" | "stale";
  questStage?: string;
  questKills?: number;
  questLifecycleStatus?: string;
  questReceiptResolution?: string;
  pendingKillReceipts?: number;
  questProgressAudits?: number;
  currentQuestPoints?: number;
  completionItemCount?: number;
  message?: string;
};

async function loadQuestKillReceipt(
  pool: pg.Pool,
): Promise<QuestKillProgressReceiptRow> {
  const result = await pool.query<{
    operationId: string;
    playerId: string;
    questId: string;
    questStartedAt: string;
    capturedStage: string;
    mobId: string;
    mobType: string;
    quantity: number;
    createdAt: string;
  }>(
    `SELECT
       operation_id AS "operationId",
       player_id AS "playerId",
       quest_id AS "questId",
       quest_started_at::text AS "questStartedAt",
       captured_stage AS "capturedStage",
       mob_id AS "mobId",
       mob_type AS "mobType",
       quantity,
       created_at::text AS "createdAt"
     FROM quest_kill_progress_receipts
     WHERE operation_id = $1 AND player_id = $2 AND quest_id = $3`,
    [MOB_OPERATION_ID, MOB_PLAYER_ID, QUEST_ID],
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error("exact captured quest-kill receipt is unavailable");
  }
  return {
    ...row,
    questStartedAt: Number(row.questStartedAt),
    createdAt: Number(row.createdAt),
  };
}

async function runWorker(): Promise<void> {
  const connectionString = process.env.GROUND_DUEL_CHAOS_DATABASE_URL;
  const mode = process.env.GROUND_DUEL_CHAOS_MODE as WorkerMode | undefined;
  const hold = process.argv.includes("--hold");
  if (
    !connectionString ||
    (mode !== "mob" &&
      mode !== "quest" &&
      mode !== "quest-system" &&
      mode !== "quest-completion" &&
      mode !== "quest-system-completed" &&
      mode !== "damage")
  ) {
    throw new Error(
      "ground/duel progression worker configuration is incomplete",
    );
  }
  registerItems();
  const pool = new Pool({ connectionString, max: 4 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    let event: WorkerEvent;
    if (mode === "mob") {
      const receipt =
        await databaseSystem.commitGroundItemMobLootOperationAsync(
          await mobRequest(),
        );
      event = {
        event: "committed",
        mode,
        operationId: receipt.operationId,
        replayed: receipt.replayed,
        sourceCount: receipt.sources.length,
        combatProgressCount: receipt.combatProgress.length,
      };
    } else if (mode === "damage") {
      const receipt =
        await databaseSystem.commitDuelDamageOperationAsync(damageRequest());
      event = {
        event: "committed",
        mode,
        operationId: receipt.operationId,
        replayed: receipt.replayed,
        appliedDamage: receipt.appliedDamage,
        healthAfter: receipt.healthAfter,
      };
    } else if (mode === "quest") {
      const questRepository = new QuestRepository(db, pool);
      const receipt = await loadQuestKillReceipt(pool);
      const result = await questRepository.applyKillProgressReceipt({
        ...receipt,
        expectedCurrentStage: receipt.capturedStage,
        expectedProgress: { kills: 14 },
        resultingStage: receipt.capturedStage,
        resultingProgress: { kills: 15 },
      });
      event = {
        event: "committed",
        mode,
        operationId: receipt.operationId,
        questStatus: result.status,
        questStage: "currentStage" in result ? result.currentStage : undefined,
        questKills:
          "stageProgress" in result ? result.stageProgress.kills : undefined,
      };
    } else if (mode === "quest-completion") {
      const receipt = await databaseSystem.commitQuestCompletionOperationAsync(
        questCompletionRequest(),
      );
      event = {
        event: "committed",
        mode,
        operationId: receipt.operationId,
        replayed: receipt.replayed,
        currentQuestPoints: receipt.currentQuestPoints,
        completionItemCount: receipt.committed.filter(
          (item) => item.itemId === "xp_lamp_100" && item.quantity === 1,
        ).length,
      };
    } else {
      const questRepository = new QuestRepository(db, pool);
      const eventBus = new EventBus();
      const world = {
        isServer: true,
        $eventBus: eventBus,
        getSystem: (name: string) =>
          name === "database"
            ? { getQuestRepository: () => questRepository }
            : undefined,
      } as unknown as World;
      const questSystem = new QuestSystem(world);
      await questSystem.init();
      eventBus.emitEvent(EventType.PLAYER_REGISTERED, {
        playerId: MOB_PLAYER_ID,
      });
      await eventBus.waitForPendingHandlers();
      const progress = questSystem
        .getActiveQuests(MOB_PLAYER_ID)
        .find((candidate) => candidate.questId === QUEST_ID);
      const receiptState = await pool.query<{
        resolution: string;
        auditCount: number;
      }>(
        `SELECT
           receipt.resolution,
           (SELECT count(*)::int FROM quest_audit_log
             WHERE "playerId" = $1 AND "questId" = $2
               AND action = 'progressed'
               AND metadata->>'operationId' = $3) AS "auditCount"
         FROM quest_kill_progress_receipts AS receipt
         WHERE receipt.operation_id = $3 AND receipt.player_id = $1
           AND receipt.quest_id = $2`,
        [MOB_PLAYER_ID, QUEST_ID, MOB_OPERATION_ID],
      );
      const pending =
        await questRepository.getPendingKillProgressReceipts(MOB_PLAYER_ID);
      event = {
        event: "committed",
        mode,
        operationId: MOB_OPERATION_ID,
        questStage: progress?.currentStage,
        questKills: progress?.stageProgress.kills,
        questLifecycleStatus: questSystem.getQuestStatus(
          MOB_PLAYER_ID,
          QUEST_ID,
        ),
        questReceiptResolution: receiptState.rows[0]?.resolution,
        pendingKillReceipts: pending.length,
        questProgressAudits: receiptState.rows[0]?.auditCount,
      };
      if (!hold) questSystem.destroy();
    }
    process.stdout.write(`${JSON.stringify(event)}\n`);
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
    const pool = new Pool({ connectionString, max: 8 });
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
      GROUND_DUEL_CHAOS_DATABASE_URL: input.connectionString,
      GROUND_DUEL_CHAOS_MODE: input.mode,
      KILL_TOKEN_SECRET: KILL_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownedChildren.add(child);
  child.once("exit", () => ownedChildren.delete(child));
  if (!child.stdout || !child.stderr) {
    throw new Error("ground/duel progression worker pipes were not created");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`ground/duel worker timed out: ${stderr}`)),
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
          `ground/duel worker exited ${String(code ?? signal)}: ${stderr}`,
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
      () => reject(new Error("ground/duel worker did not exit")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertOperationCommitted(
  event: WorkerEvent,
  mode: "mob" | "damage",
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

async function commitKillReplay(
  connectionString: string,
  mode: "mob" | "damage",
): Promise<void> {
  const initial = spawnWorker({ connectionString, mode, hold: true });
  const initialEvent = await initial.event;
  assertOperationCommitted(initialEvent, mode, false);
  if (mode === "mob") {
    if (
      initialEvent.sourceCount !== 1 ||
      initialEvent.combatProgressCount !== 2
    ) {
      throw new Error(
        `mob receipt shape mismatch: ${JSON.stringify(initialEvent)}`,
      );
    }
  } else if (
    initialEvent.appliedDamage !== 7 ||
    initialEvent.healthAfter !== 18
  ) {
    throw new Error(
      `damage receipt shape mismatch: ${JSON.stringify(initialEvent)}`,
    );
  }
  if (!initial.child.kill("SIGKILL")) {
    throw new Error(`failed to SIGKILL committed ${mode} worker`);
  }
  await waitForExit(initial.child);
  if (initial.child.signalCode !== "SIGKILL") {
    throw new Error(`${mode} worker did not exit from SIGKILL`);
  }

  const replacement = spawnWorker({ connectionString, mode });
  const replay = await replacement.event;
  assertOperationCommitted(replay, mode, true);
  await waitForExit(replacement.child);
}

function assertQuestCommitted(
  event: WorkerEvent,
  status: "applied" | "replayed",
): void {
  if (
    event.event !== "committed" ||
    event.mode !== "quest" ||
    event.operationId !== MOB_OPERATION_ID ||
    event.questStatus !== status ||
    event.questStage !== QUEST_KILL_STAGE ||
    event.questKills !== 15
  ) {
    throw new Error(
      `quest worker did not return the expected ${status} result: ${JSON.stringify(event)}`,
    );
  }
}

function assertQuestSystemState(event: WorkerEvent): void {
  if (
    event.event !== "committed" ||
    event.mode !== "quest-system" ||
    event.operationId !== MOB_OPERATION_ID ||
    event.questStage !== QUEST_KILL_STAGE ||
    event.questKills !== 15 ||
    event.questLifecycleStatus !== "ready_to_complete" ||
    event.questReceiptResolution !== "applied" ||
    event.pendingKillReceipts !== 0 ||
    event.questProgressAudits !== 1
  ) {
    throw new Error(
      `quest system did not expose exact durable threshold state: ${JSON.stringify(event)}`,
    );
  }
}

async function applyQuestKillReplay(connectionString: string): Promise<void> {
  const initial = spawnWorker({
    connectionString,
    mode: "quest-system",
    hold: true,
  });
  assertQuestSystemState(await initial.event);
  if (!initial.child.kill("SIGKILL")) {
    throw new Error("failed to SIGKILL applied quest-system worker");
  }
  await waitForExit(initial.child);
  if (initial.child.signalCode !== "SIGKILL") {
    throw new Error("quest-system worker did not exit from SIGKILL");
  }

  const exactReplay = spawnWorker({ connectionString, mode: "quest" });
  assertQuestCommitted(await exactReplay.event, "replayed");
  await waitForExit(exactReplay.child);

  const replacementSystem = spawnWorker({
    connectionString,
    mode: "quest-system",
  });
  assertQuestSystemState(await replacementSystem.event);
  await waitForExit(replacementSystem.child);
}

function assertQuestCompletion(event: WorkerEvent, replayed: boolean): void {
  if (
    event.event !== "committed" ||
    event.mode !== "quest-completion" ||
    event.replayed !== replayed ||
    !event.operationId?.startsWith("quest-completion:") ||
    event.currentQuestPoints !== 1 ||
    event.completionItemCount !== 1
  ) {
    throw new Error(
      `quest completion worker did not return exact custody: ${JSON.stringify(event)}`,
    );
  }
}

function assertCompletedQuestSystemState(event: WorkerEvent): void {
  if (
    event.event !== "committed" ||
    event.mode !== "quest-system-completed" ||
    event.operationId !== MOB_OPERATION_ID ||
    event.questStage !== undefined ||
    event.questKills !== undefined ||
    event.questLifecycleStatus !== "completed" ||
    event.questReceiptResolution !== "applied" ||
    event.pendingKillReceipts !== 0 ||
    event.questProgressAudits !== 1
  ) {
    throw new Error(
      `replacement quest system did not recover completion: ${JSON.stringify(event)}`,
    );
  }
}

async function completeQuestReplay(connectionString: string): Promise<void> {
  const initial = spawnWorker({
    connectionString,
    mode: "quest-completion",
    hold: true,
  });
  assertQuestCompletion(await initial.event, false);
  if (!initial.child.kill("SIGKILL")) {
    throw new Error("failed to SIGKILL committed quest-completion worker");
  }
  await waitForExit(initial.child);
  if (initial.child.signalCode !== "SIGKILL") {
    throw new Error("quest-completion worker did not exit from SIGKILL");
  }

  const exactReplay = spawnWorker({
    connectionString,
    mode: "quest-completion",
  });
  assertQuestCompletion(await exactReplay.event, true);
  await waitForExit(exactReplay.child);

  const replacementSystem = spawnWorker({
    connectionString,
    mode: "quest-system-completed",
  });
  assertCompletedQuestSystemState(await replacementSystem.event);
  await waitForExit(replacementSystem.child);
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-ground-duel-chaos-${process.pid}`;
  const databaseUser = "ground_duel_test";
  const databaseName = "ground_duel_test";
  const databasePassword = `ground-duel-${randomUUID()}`;
  const image =
    process.env.GROUND_DUEL_CHAOS_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(`Docker is required for ground/duel chaos: ${error}`);
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
      `INSERT INTO users (id, name, roles, "createdAt") VALUES
         ($1, 'Mob Chaos Account', 'user', '2026-08-31T00:00:00.000Z'),
         ($2, 'Damage Attacker Account', 'user', '2026-08-31T00:00:00.000Z'),
         ($3, 'Damage Target Account', 'user', '2026-08-31T00:00:00.000Z')`,
      [MOB_ACCOUNT_ID, DAMAGE_ATTACKER_ACCOUNT_ID, DAMAGE_TARGET_ACCOUNT_ID],
    );
    await pool.query(
      `INSERT INTO characters
         (id, "accountId", name, "isAgent", health, "maxHealth") VALUES
         ($1, $2, 'Mob Chaos Agent', 1, 30, 30),
         ($3, $4, 'Damage Chaos Attacker', 1, 30, 30),
         ($5, $6, 'Damage Chaos Target', 1, 25, 25)`,
      [
        MOB_PLAYER_ID,
        MOB_ACCOUNT_ID,
        DAMAGE_ATTACKER_ID,
        DAMAGE_ATTACKER_ACCOUNT_ID,
        DAMAGE_TARGET_ID,
        DAMAGE_TARGET_ACCOUNT_ID,
      ],
    );
    await pool.query(
      `INSERT INTO quest_progress
         ("playerId", "questId", status, "currentStage", "stageProgress", "startedAt")
       VALUES ($1, $2, 'in_progress', $3, '{"kills":14}'::jsonb, $4)`,
      [MOB_PLAYER_ID, QUEST_ID, QUEST_KILL_STAGE, QUEST_STARTED_AT],
    );
    await pool.query(
      `INSERT INTO operations_log
         (id, "playerId", "operationType", "operationState", completed, timestamp, "completedAt")
       VALUES ($1, $2, 'projectile_rune_cost', $3::jsonb, true, $4, $4)`,
      [
        PROJECTILE_OPERATION_ID,
        DAMAGE_ATTACKER_ID,
        JSON.stringify({
          version: 1,
          requestFingerprint: PROJECTILE_FINGERPRINT,
          requirements: [
            { itemId: "air_rune", quantity: 1 },
            { itemId: "mind_rune", quantity: 1 },
          ],
          committed: [],
          status: "fired",
          refundDestination: null,
        }),
        1_788_148_000_750,
      ],
    );

    await commitKillReplay(connectionString, "mob");
    await applyQuestKillReplay(connectionString);
    await completeQuestReplay(connectionString);
    await commitKillReplay(connectionString, "damage");

    const final = await pool.query<{
      strengthXp: string;
      constitutionXp: string;
      mobOperationCount: string;
      sourceCount: string;
      killReceiptCount: string;
      killReceiptResolution: string;
      questKills: string;
      questProgressAuditCount: string;
      questStatus: string;
      questPoints: string;
      questCompletionItemCount: string;
      questCompletionAuditCount: string;
      questCompletionOperationCount: string;
      targetHealth: string;
      damageOperationCount: string;
      observationCount: string;
      projectileStatus: string;
      projectileDamageOperationId: string;
    }>(
      `SELECT
         (SELECT "strengthXp" FROM characters WHERE id = $1) AS "strengthXp",
         (SELECT "constitutionXp" FROM characters WHERE id = $1) AS "constitutionXp",
         (SELECT count(*)::text FROM operations_log WHERE id = $2) AS "mobOperationCount",
         (SELECT count(*)::text FROM ground_item_sources WHERE source_id = $3) AS "sourceCount",
         (SELECT count(*)::text FROM quest_kill_progress_receipts
           WHERE operation_id = $2 AND player_id = $1 AND quest_id = $4) AS "killReceiptCount",
         (SELECT resolution FROM quest_kill_progress_receipts
           WHERE operation_id = $2 AND player_id = $1 AND quest_id = $4) AS "killReceiptResolution",
         (SELECT "stageProgress"->>'kills' FROM quest_progress
           WHERE "playerId" = $1 AND "questId" = $4) AS "questKills",
         (SELECT count(*)::text FROM quest_audit_log
           WHERE "playerId" = $1 AND "questId" = $4 AND action = 'progressed'
             AND metadata->>'operationId' = $2) AS "questProgressAuditCount",
         (SELECT status FROM quest_progress
           WHERE "playerId" = $1 AND "questId" = $4) AS "questStatus",
         (SELECT "questPoints"::text FROM characters WHERE id = $1) AS "questPoints",
         (SELECT count(*)::text FROM inventory
           WHERE "playerId" = $1 AND "itemId" = 'xp_lamp_100') AS "questCompletionItemCount",
         (SELECT count(*)::text FROM quest_audit_log
           WHERE "playerId" = $1 AND "questId" = $4 AND action = 'completed') AS "questCompletionAuditCount",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = $1 AND "operationType" = 'quest_completion') AS "questCompletionOperationCount",
         (SELECT health::text FROM characters WHERE id = $5) AS "targetHealth",
         (SELECT count(*)::text FROM operations_log WHERE id = $6) AS "damageOperationCount",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "operationId" = $6) AS "observationCount",
         (SELECT "operationState"->>'status' FROM operations_log WHERE id = $7) AS "projectileStatus",
         (SELECT "operationState"->>'damageOperationId' FROM operations_log WHERE id = $7) AS "projectileDamageOperationId"`,
      [
        MOB_PLAYER_ID,
        MOB_OPERATION_ID,
        MOB_SOURCE_ID,
        QUEST_ID,
        DAMAGE_TARGET_ID,
        DAMAGE_OPERATION_ID,
        PROJECTILE_OPERATION_ID,
      ],
    );
    const row = final.rows[0];
    if (
      !row ||
      Number(row.strengthXp) !== 80 ||
      Number(row.constitutionXp) !== 1_180 ||
      Number(row.mobOperationCount) !== 1 ||
      Number(row.sourceCount) !== 1 ||
      Number(row.killReceiptCount) !== 1 ||
      row.killReceiptResolution !== "applied" ||
      Number(row.questKills) !== 15 ||
      Number(row.questProgressAuditCount) !== 1 ||
      row.questStatus !== "completed" ||
      Number(row.questPoints) !== 1 ||
      Number(row.questCompletionItemCount) !== 1 ||
      Number(row.questCompletionAuditCount) !== 1 ||
      Number(row.questCompletionOperationCount) !== 1 ||
      Number(row.targetHealth) !== 18 ||
      Number(row.damageOperationCount) !== 1 ||
      Number(row.observationCount) !== 1 ||
      row.projectileStatus !== "resolved" ||
      row.projectileDamageOperationId !== DAMAGE_OPERATION_ID
    ) {
      throw new Error(
        `ground/duel process-kill proof mismatch: ${JSON.stringify(final.rows)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mobSignal: "SIGKILL",
        damageSignal: "SIGKILL",
        questSignal: "SIGKILL",
        questCompletionSignal: "SIGKILL",
        mobReplay: true,
        questReplay: true,
        questSystemRecovery: true,
        questCompletionReplay: true,
        questCompletionRecovery: true,
        damageReplay: true,
        mobSources: 1,
        questKillReceipts: 1,
        questKills: 15,
        questProgressAudits: 1,
        questPoints: 1,
        questCompletionItems: 1,
        strengthXp: 80,
        constitutionXp: 1_180,
        targetHealth: 18,
        damageObservations: 1,
        projectileStatus: "resolved",
      })}\n`,
    );
  } finally {
    for (const child of ownedChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
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
