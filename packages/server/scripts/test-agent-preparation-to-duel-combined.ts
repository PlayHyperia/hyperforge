import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMBAT_CONSTANTS, COMBAT_SPELLS, ITEMS } from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import fishingManifest from "../world/assets/manifests/gathering/fishing.json";
import foodManifest from "../world/assets/manifests/items/food.json";
import miscManifest from "../world/assets/manifests/items/misc.json";
import resourcesManifest from "../world/assets/manifests/items/resources.json";
import toolsManifest from "../world/assets/manifests/items/tools.json";
import cookingManifest from "../world/assets/manifests/recipes/cooking.json";
import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import { executeAuthoritativeAgentBankTransfer } from "../src/eliza/AuthoritativeAgentBanking.js";
import { buildAgentAutonomyCheckpointDraft } from "../src/eliza/agentAutonomyCheckpoint.js";
import {
  beginAgentAutonomyProgressionAttempt,
  finalizeAgentAutonomyProgressionAttempt,
} from "../src/eliza/agentAutonomyProgression.js";
import type { AgentInstance } from "../src/eliza/managers/AgentBehaviorTicker.js";
import { getDuelPreparationAttackSupplyTarget } from "../src/eliza/duelPreparationPlan.js";
import { getOrdinaryBankOperationId } from "../src/eliza/ordinaryAgentBanking.js";
import type {
  GatheringRewardCommitRequest,
  ProcessingActionCommitRequest,
} from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";
import { StreamingDuelScheduler } from "../src/systems/StreamingDuelScheduler/index.js";
import {
  AGENT_DUEL_COMBINED_MULTI_STYLE,
  AGENT_IDS,
  docker,
  driveAuthoritativeCombatToNaturalTerminal,
  installAuthoritativeCombatRuntime,
  openPersistedCycle,
  schedulerInternals,
  seedAgents,
  startWorkerRuntime,
  stopWorkerRuntime,
  waitFor,
  waitForPostgres,
  type AuthoritativeCombatRuntime,
  type WorkerRuntime,
} from "./test-agent-duel-cycle-process-kill.js";
import {
  AGENT_DUEL_COMBAT_ROLE,
  AGENT_DUEL_MULTI_STYLE_BANK_ITEMS,
  AGENT_DUEL_ROLE_FIXTURE,
  AGENT_DUEL_ROLE_FIXTURES,
  readAgentDuel3dE2eMultiStyle,
} from "./agent-duel-role-fixtures.js";

const scriptPath = fileURLToPath(import.meta.url);
const liveWorldScriptPath = path.resolve(
  import.meta.dirname,
  "test-processing-quiescence-live-world.mjs",
);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const combinedEvidenceDirectory = path.join(
  repositoryRoot,
  "artifacts/duel-launch-agent-preparation-combined",
);
const combinedScenario = AGENT_DUEL_COMBINED_MULTI_STYLE
  ? "multi-style"
  : AGENT_DUEL_COMBAT_ROLE;
const combinedReportPath = path.join(
  combinedEvidenceDirectory,
  `${combinedScenario}-combined-report.json`,
);
const RAW_FOOD_ID = "raw_shrimp";
const COOKED_FOOD_ID = "shrimp";
const LEGACY_FIXTURE_FOOD_ID = "lobster";
const FOOD_PER_AGENT = 4;
const BANK_ID = "combined-preparation-bank";

type ManifestItem = {
  id: string;
  type: string;
  stackable: boolean;
  [key: string]: unknown;
};

type FishingSpot = {
  id: string;
  depleteChance: number;
  respawnTicks: number;
  harvestYield: Array<{
    itemId: string;
    quantity: number;
    xpAmount: number;
    levelRequired: number;
    stackable: boolean;
  }>;
};

type CookingRecipe = {
  raw: string;
  cooked: string;
  level: number;
  xp: number;
  ticks: number;
};

type PreworkAgentEvidence = {
  agentId: string;
  fishingXp: number;
  fishingLevel: number;
  cookingXp: number;
  cookingLevel: number;
  bankedFood: number;
  inventoryFood: number;
  progressionStarts: number;
  progressionTerminals: number;
};

type PreworkEvent = {
  event:
    | "prework_committed"
    | "ordinary_preparation_progress"
    | "ordinary_preparation_committed"
    | "error";
  agents?: PreworkAgentEvidence[];
  gatheringOperations?: number;
  processingOperations?: number;
  ordinaryBankOperations?: number;
  message?: string;
  status?: string;
  report?: string;
  workspacePath?: string;
  preparationAgentId?: string;
  summary?: Record<string, unknown>;
  stage?: string;
  elapsedMs?: number;
};

type PreworkProgress = {
  stage: string;
  elapsedMs: number;
};

const REQUIRED_PREPARATION_PROGRESS_STAGES = [
  "workspace_created",
  "manifests_ready",
  "framework_loaded",
  "world_ready",
  "preparation_started",
  "preparation_completed",
] as const;
const PREPARATION_WORKER_TOTAL_TIMEOUT_MS = 360_000;

type LiveWorldPreparationReport = {
  status: string;
  runtime?: {
    mode?: string;
    preparationAgentId?: string;
    databaseMode?: string;
    workspacePath?: string;
  };
  preparationVerticalSlice?: {
    status?: string;
    playerId?: string;
    exactFinalCustodyAndXp?: boolean;
    quiescent?: boolean;
    workerBridge?: { checkpoints?: Array<{ attemptedActionType?: string }> };
    movement?: {
      diagonalStep?: boolean;
      rangeApproachActions?: number;
      rangeApproachRejections?: number;
      finalPosition?: { x?: number; y?: number; z?: number };
      persistedPosition?: { x?: number; y?: number; z?: number };
      readyStaging?: {
        slot?: number;
        pairSeparation?: number;
        targetTile?: { x?: number; z?: number };
        finalTile?: { x?: number; z?: number };
      } | null;
    };
    gathering?: {
      durableReceipts?: number;
      initialApproachActions?: number;
      initialApproachMoveActions?: number;
      initialApproachRejections?: number;
      initialGatherCheckpointIndex?: number | null;
    };
    cooking?: {
      actions?: number;
      successfulOutputs?: number;
      burntOutputs?: number;
      forcedBurnObserved?: boolean;
      forcedRecoveryResourceMoveCancellationAttempted?: boolean;
      forcedRecoveryResourceMoveCancellationObserved?: boolean;
      recoveryDecisions?: number;
      recoveryDecisionBudget?: number;
      recoveryGatherActions?: number;
      recoveryGatherFailureReasons?: string[];
      cookedHealing?: number;
      requiredHealing?: number;
    };
    processing?: { durableReceipts?: number };
    forging?: {
      status?: string;
      questId?: string;
      forgedWeaponId?: string;
      gatheringReceipts?: number;
      processingReceipts?: number;
      actionCounts?: Record<string, number>;
      persisted?: {
        status?: string;
        bronze_shortsword?: number;
        bronze_hatchet?: number;
        bronze_pickaxe?: number;
        hammer?: number;
        copper_ore?: number;
        tin_ore?: number;
        bronze_bar?: number;
        unresolved_gathering_receipts?: number;
        unresolved_processing_receipts?: number;
      };
    };
    presentation?: {
      rotationPackets?: number;
      processingRejections?: number;
    };
  };
};

type ManifestTruth = {
  rawFood: ManifestItem;
  cookedFood: ManifestItem;
  burntFood: ManifestItem;
  fishingTool: ManifestItem;
  fishingSpot: FishingSpot;
  fishingYield: FishingSpot["harvestYield"][number];
  cookingRecipe: CookingRecipe;
};

function loadManifestTruth(): ManifestTruth {
  const rawFood = (resourcesManifest as ManifestItem[]).find(
    (item) => item.id === RAW_FOOD_ID,
  );
  const cookedFood = (foodManifest as ManifestItem[]).find(
    (item) => item.id === COOKED_FOOD_ID,
  );
  const burntFood = (miscManifest as ManifestItem[]).find(
    (item) => item.id === "burnt_shrimp",
  );
  const fishingTool = (toolsManifest as ManifestItem[]).find(
    (item) => item.id === "small_fishing_net",
  );
  const fishingSpot = (fishingManifest.spots as FishingSpot[]).find(
    (spot) => spot.id === "fishing_spot_net",
  );
  const fishingYield = fishingSpot?.harvestYield.find(
    (entry) => entry.itemId === RAW_FOOD_ID,
  );
  const cookingRecipe = (cookingManifest.recipes as CookingRecipe[]).find(
    (recipe) => recipe.raw === RAW_FOOD_ID && recipe.cooked === COOKED_FOOD_ID,
  );
  if (
    !rawFood ||
    rawFood.stackable !== false ||
    !cookedFood ||
    cookedFood.stackable !== false ||
    !burntFood ||
    burntFood.stackable !== false ||
    !fishingTool ||
    !fishingSpot ||
    !fishingYield ||
    fishingYield.quantity !== 1 ||
    fishingSpot.depleteChance !== 0 ||
    !cookingRecipe
  ) {
    throw new Error("combined preparation manifest truth is incomplete");
  }
  return {
    rawFood,
    cookedFood,
    burntFood,
    fishingTool,
    fishingSpot,
    fishingYield,
    cookingRecipe,
  };
}

function installFoodManifests(truth: ManifestTruth): void {
  ITEMS.set(truth.rawFood.id, { ...truth.rawFood } as never);
  ITEMS.set(truth.cookedFood.id, { ...truth.cookedFood } as never);
  ITEMS.set(truth.burntFood.id, { ...truth.burntFood } as never);
  ITEMS.set(truth.fishingTool.id, { ...truth.fishingTool } as never);
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function gatheringRequest(
  attemptId: string,
  agentId: string,
  truth: ManifestTruth,
): GatheringRewardCommitRequest {
  const input = {
    playerId: agentId,
    resourceId: `${truth.fishingSpot.id}:${agentId}`,
    depleteAfterCommit: truth.fishingSpot.depleteChance > 0,
    respawnTicks: truth.fishingSpot.respawnTicks,
    skill: "fishing" as const,
    xpAmount: truth.fishingYield.xpAmount,
    reward: {
      itemId: truth.fishingYield.itemId,
      quantity: truth.fishingYield.quantity,
      stackable: truth.fishingYield.stackable,
    },
    secondaryItemId: null,
  };
  return {
    operationId: `gathering-reward:${attemptId}`,
    requestFingerprint: sha256({ version: 2, ...input }),
    ...input,
  };
}

function cookingRequest(
  attemptId: string,
  agentId: string,
  truth: ManifestTruth,
): ProcessingActionCommitRequest {
  const input = {
    playerId: agentId,
    skill: "cooking" as const,
    xpAmount: truth.cookingRecipe.xp,
    inputs: [{ itemId: truth.cookingRecipe.raw, quantity: 1 }],
    requiredItems: [],
    consumables: [],
    outputs: [
      {
        itemId: truth.cookingRecipe.cooked,
        quantity: 1,
        stackable: truth.cookedFood.stackable,
      },
    ],
  };
  return {
    operationId: `processing-request:cooking:${attemptId}`,
    requestFingerprint: sha256({
      version: 1,
      playerId: input.playerId,
      skill: input.skill,
      xpAmount: input.xpAmount,
      inputs: input.inputs,
      outputs: input.outputs,
    }),
    ...input,
  };
}

function makeInstance(
  agentId: (typeof AGENT_IDS)[number],
  goalType: "gathering" | "cooking" | "banking",
): AgentInstance {
  const descriptions = {
    gathering: "Acquire authored duel food from a public resource",
    cooking: "Process owned raw food into authored duel supplies",
    banking: "Bank owned supplies for later private duel preparation",
  } as const;
  return {
    config: {
      characterId: agentId,
      accountId: `account-${AGENT_IDS.indexOf(agentId) + 1}-${agentId}`,
      name:
        agentId === AGENT_IDS[0]
          ? "Persisted Chaos Alpha"
          : "Persisted Chaos Beta",
    },
    goal: { type: goalType, description: descriptions[goalType] },
    llmPlan: {
      steps: [descriptions[goalType], "Reassess durable custody"],
      currentStep: 0,
      createdAt: Date.now(),
      goal: descriptions[goalType],
    },
    memories: [],
    recentActionLog: [],
    tickCounter: 0,
    pendingLlmResult: undefined,
  } as unknown as AgentInstance;
}

async function finalizeAction(
  pool: pg.Pool,
  instance: AgentInstance,
  attempt: Awaited<ReturnType<typeof beginAgentAutonomyProgressionAttempt>>,
): Promise<void> {
  await finalizeAgentAutonomyProgressionAttempt(
    pool,
    attempt,
    buildAgentAutonomyCheckpointDraft(
      instance,
      {
        attemptedActionType: attempt.actionType,
        appliedActionType: attempt.actionType,
        outcome: "completed",
      },
      Math.max(Date.now(), attempt.startedAt),
    ),
  );
}

function createBankWorld(pool: pg.Pool, agentId: string) {
  const inventorySystem = {
    isInventoryReady: () => true,
    queueOperation: async (
      _playerId: string,
      operation: () => Promise<boolean>,
    ) => operation(),
    lockForTransaction: () => true,
    unlockTransaction: () => undefined,
    persistInventoryImmediate: async () => undefined,
    reloadFromDatabase: async () => {
      await pool.query(
        `SELECT "itemId", quantity FROM inventory WHERE "playerId" = $1`,
        [agentId],
      );
    },
  };
  const entities = new Map<string, unknown>([
    [
      agentId,
      {
        position: { x: 0, y: 0, z: 0 },
        data: { inStreamingDuel: false },
      },
    ],
    [BANK_ID, { position: { x: 1, y: 0, z: 1 }, data: { type: "bank" } }],
  ]);
  return {
    pgPool: pool,
    entities: { get: (id: string) => entities.get(id) },
    getSystem: (name: string) =>
      name === "inventory" ? inventorySystem : null,
  };
}

async function runPreworkWorker(): Promise<never> {
  const connectionString =
    process.env.AGENT_PREPARATION_DUEL_COMBINED_DATABASE_URL;
  if (!connectionString) {
    throw new Error("combined preparation worker database URL is missing");
  }
  const truth = loadManifestTruth();
  installFoodManifests(truth);
  const pool = new pg.Pool({ connectionString, max: 6 });
  const db = drizzle(pool, { schema });
  const databaseSystem = new DatabaseSystem({} as never);
  (databaseSystem as unknown as { db: typeof db }).db = db;
  (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;

  for (const agentId of AGENT_IDS) {
    for (let count = 0; count < FOOD_PER_AGENT; count += 1) {
      const instance = makeInstance(agentId, "gathering");
      const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
        characterId: agentId,
        goalType: "gathering",
        actionType: "gather",
        decisionSource: "scripted",
      });
      const receipt = await databaseSystem.commitGatheringRewardOperationAsync(
        gatheringRequest(attempt.attemptId, agentId, truth),
      );
      if (
        receipt.replayed ||
        receipt.awardedXp !== truth.fishingYield.xpAmount ||
        receipt.reward.itemId !== RAW_FOOD_ID ||
        receipt.reward.quantity !== 1
      ) {
        throw new Error(
          `combined gathering receipt drifted for ${agentId}: ${JSON.stringify(receipt)}`,
        );
      }
      await finalizeAction(pool, instance, attempt);
    }

    for (let count = 0; count < FOOD_PER_AGENT; count += 1) {
      const instance = makeInstance(agentId, "cooking");
      const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
        characterId: agentId,
        goalType: "cooking",
        actionType: "cook",
        decisionSource: "scripted",
      });
      const receipt = await databaseSystem.commitProcessingActionOperationAsync(
        cookingRequest(attempt.attemptId, agentId, truth),
      );
      if (
        receipt.replayed ||
        receipt.awardedXp !== truth.cookingRecipe.xp ||
        receipt.outputs.length !== 1 ||
        receipt.outputs[0]?.itemId !== COOKED_FOOD_ID ||
        receipt.outputs[0]?.quantity !== 1
      ) {
        throw new Error(
          `combined cooking receipt drifted for ${agentId}: ${JSON.stringify(receipt)}`,
        );
      }
      await finalizeAction(pool, instance, attempt);
    }

    const instance = makeInstance(agentId, "banking");
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      characterId: agentId,
      goalType: "banking",
      actionType: "bankDepositAll",
      decisionSource: "scripted",
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: createBankWorld(pool, agentId) as never,
      playerId: agentId,
      bankId: BANK_ID,
      action: "deposit_all",
      operationId: getOrdinaryBankOperationId(attempt.attemptId),
      retainedItems: [],
    });
    if (
      !receipt.success ||
      receipt.replayed ||
      receipt.committedQuantity !== FOOD_PER_AGENT ||
      receipt.inventoryQuantityAfter !== 0
    ) {
      throw new Error(
        `combined bank receipt drifted for ${agentId}: ${JSON.stringify(receipt)}`,
      );
    }
    await finalizeAction(pool, instance, attempt);
  }

  const evidence = await pool.query<{
    agentId: string;
    fishingXp: number;
    fishingLevel: number;
    cookingXp: number;
    cookingLevel: number;
    bankedFood: number;
    inventoryFood: number;
    progressionStarts: string;
    progressionTerminals: string;
  }>(
    `SELECT character.id AS "agentId",
            character."fishingXp" AS "fishingXp",
            character."fishingLevel" AS "fishingLevel",
            character."cookingXp" AS "cookingXp",
            character."cookingLevel" AS "cookingLevel",
            COALESCE((SELECT sum(quantity)::int FROM bank_storage
                       WHERE "playerId" = character.id AND "itemId" = $2), 0)
              AS "bankedFood",
            COALESCE((SELECT sum(quantity)::int FROM inventory
                       WHERE "playerId" = character.id AND "itemId" IN ($1, $2, $3)), 0)
              AS "inventoryFood",
            (SELECT count(*)::text FROM agent_autonomy_progression_events
              WHERE character_id = character.id AND event_type = 'attempt_started')
              AS "progressionStarts",
            (SELECT count(*)::text FROM agent_autonomy_progression_events
              WHERE character_id = character.id AND event_type = 'attempt_terminal')
              AS "progressionTerminals"
       FROM characters character
      WHERE character.id = ANY($4::text[])
      ORDER BY character.id`,
    [RAW_FOOD_ID, COOKED_FOOD_ID, LEGACY_FIXTURE_FOOD_ID, AGENT_IDS],
  );
  const operationCounts = await pool.query<{
    gathering: string;
    processing: string;
    banking: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM operations_log
         WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'gathering_reward')
         AS gathering,
       (SELECT count(*)::text FROM operations_log
         WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'processing_action')
         AS processing,
       (SELECT count(*)::text FROM agent_bank_operations
         WHERE "playerId" = ANY($1::text[]) AND action = 'deposit_all'
           AND "preparationId" IS NULL)
         AS banking`,
    [AGENT_IDS],
  );
  const agents = evidence.rows.map((row) => ({
    ...row,
    progressionStarts: Number(row.progressionStarts),
    progressionTerminals: Number(row.progressionTerminals),
  }));
  if (
    agents.length !== 2 ||
    agents.some(
      (agent) =>
        agent.fishingXp !== truth.fishingYield.xpAmount * FOOD_PER_AGENT ||
        agent.cookingXp !== truth.cookingRecipe.xp * FOOD_PER_AGENT ||
        agent.bankedFood !== FOOD_PER_AGENT ||
        agent.inventoryFood !== 0 ||
        agent.progressionStarts !== FOOD_PER_AGENT * 2 + 1 ||
        agent.progressionTerminals !== FOOD_PER_AGENT * 2 + 1,
    ) ||
    operationCounts.rows[0]?.gathering !== String(FOOD_PER_AGENT * 2) ||
    operationCounts.rows[0]?.processing !== String(FOOD_PER_AGENT * 2) ||
    operationCounts.rows[0]?.banking !== "2"
  ) {
    throw new Error(
      `combined prework evidence drifted: ${JSON.stringify({ agents, operationCounts: operationCounts.rows })}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "prework_committed",
      agents,
      gatheringOperations: Number(operationCounts.rows[0].gathering),
      processingOperations: Number(operationCounts.rows[0].processing),
      ordinaryBankOperations: Number(operationCounts.rows[0].banking),
    } satisfies PreworkEvent)}\n`,
  );
  await new Promise<never>(() => undefined);
}

function spawnPreworkWorker(
  connectionString: string,
  agentId: (typeof AGENT_IDS)[number],
  agentIndex: number,
  reportDirectory = combinedEvidenceDirectory,
  reportNamePrefix = "",
  forgingQuest = false,
): {
  child: ChildProcess;
  event: Promise<PreworkEvent>;
  stderr: string[];
  stdoutTail: string[];
  progress: PreworkProgress[];
  reportPath: string;
  agentId: (typeof AGENT_IDS)[number];
  databaseApplicationName: string;
  readySlot: number;
  forgingQuest: boolean;
} {
  const reportPath = path.join(
    reportDirectory,
    `${reportNamePrefix}${agentId}-live-world.json`,
  );
  const databaseApplicationName = `hyperia-ordinary-preparation-${process.pid}-${agentId}`;
  const workerDatabaseUrl = new URL(connectionString);
  workerDatabaseUrl.searchParams.set(
    "application_name",
    databaseApplicationName,
  );
  const child = spawn(process.execPath, [liveWorldScriptPath], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      SKIP_VALIDATION: "true",
      SKIP_MIGRATIONS: "true",
      DATA_OPTIONAL_MANIFEST_WARNINGS: "false",
      DISABLE_BOTS: "true",
      DISABLE_ACTIVITY_LOGGER: "true",
      TERRAIN_SERVER_MESH_COLLISION_ENABLED: "false",
      PROCESSING_LIVE_WORLD_DATABASE_URL: workerDatabaseUrl.toString(),
      PROCESSING_QUIESCENCE_REPORT: reportPath,
      PROCESSING_LIVE_WORLD_PREPARATION_ONLY: "true",
      PROCESSING_LIVE_WORLD_HOLD_AFTER_PREPARATION: "true",
      PROCESSING_LIVE_WORLD_PREPARATION_AGENT_ID: agentId,
      PROCESSING_LIVE_WORLD_PREPARATION_ACCOUNT_ID: `account-${agentIndex + 1}-${agentId}`,
      PROCESSING_LIVE_WORLD_PREPARATION_AGENT_NAME:
        agentIndex === 0 ? "Persisted Chaos Alpha" : "Persisted Chaos Beta",
      PROCESSING_LIVE_WORLD_PREPARATION_READY_SLOT: String(agentIndex),
      PROCESSING_LIVE_WORLD_FORGING_QUEST: forgingQuest ? "true" : "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("combined preparation worker pipes were not created");
  }
  const stderr: string[] = [];
  const stdoutTail: string[] = [];
  const progress: PreworkProgress[] = [];
  const preparationWorkerTotalTimeoutMs = forgingQuest
    ? 720_000
    : PREPARATION_WORKER_TOTAL_TIMEOUT_MS;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  const event = new Promise<PreworkEvent>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `combined live-world preparation timed out for ${agentId} after ${preparationWorkerTotalTimeoutMs}ms: progress=${JSON.stringify(progress)} stdout=${stdoutTail.join("\n")} stderr=${stderr.join("")}`,
        ),
      );
    }, preparationWorkerTotalTimeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        stdoutTail.push(line);
        if (stdoutTail.length > 40) stdoutTail.shift();
        try {
          const parsed = JSON.parse(line) as PreworkEvent;
          if (parsed.event === "ordinary_preparation_progress") {
            if (
              parsed.preparationAgentId !== agentId ||
              typeof parsed.stage !== "string" ||
              !Number.isSafeInteger(parsed.elapsedMs) ||
              parsed.elapsedMs! < 0
            ) {
              clearTimeout(timer);
              reject(
                new Error(
                  `combined live-world preparation progress drifted for ${agentId}: ${line}`,
                ),
              );
              return;
            }
            progress.push({ stage: parsed.stage, elapsedMs: parsed.elapsedMs });
            continue;
          }
          if (
            parsed.event !== "ordinary_preparation_committed" &&
            parsed.event !== "error"
          ) {
            continue;
          }
          clearTimeout(timer);
          if (parsed.event === "error") {
            reject(
              new Error(
                parsed.message ??
                  `combined live-world preparation failed for ${agentId}`,
              ),
            );
          } else {
            if (
              parsed.status !== "passed" ||
              parsed.preparationAgentId !== agentId ||
              parsed.report !== reportPath ||
              !parsed.workspacePath
            ) {
              reject(
                new Error(
                  `combined live-world event drifted for ${agentId}: ${JSON.stringify(parsed)}`,
                ),
              );
              return;
            }
            resolve(parsed);
          }
          return;
        } catch {
          // Runtime diagnostics share stdout. Only the explicit JSON event counts.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      if (signal === "SIGKILL") return;
      clearTimeout(timer);
      let failureReport: unknown = null;
      try {
        failureReport = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        // The child can fail before its private report is created. The bounded
        // stdout/stderr tail still provides the startup failure in that case.
      }
      reject(
        new Error(
          `combined prework exited ${code ?? signal}: progress=${JSON.stringify(progress)} failureReport=${JSON.stringify(failureReport)} stdout=${stdoutTail.join("\n")} stderr=${stderr.join("")}`,
        ),
      );
    });
  });
  return {
    child,
    event,
    stderr,
    stdoutTail,
    progress,
    reportPath,
    agentId,
    databaseApplicationName,
    readySlot: agentIndex,
    forgingQuest,
  };
}

function assertLivePreparationReport(
  worker: ReturnType<typeof spawnPreworkWorker>,
  event: PreworkEvent | undefined,
  report: LiveWorldPreparationReport,
): void {
  const progressStages = worker.progress.map(({ stage }) => stage);
  if (
    JSON.stringify(progressStages) !==
    JSON.stringify(REQUIRED_PREPARATION_PROGRESS_STAGES)
  ) {
    throw new Error(
      `combined live-world preparation progress was incomplete for ${worker.agentId}: ${JSON.stringify(worker.progress)}`,
    );
  }
  const preparation = report.preparationVerticalSlice;
  const finalPosition = preparation?.movement?.finalPosition;
  const persistedPosition = preparation?.movement?.persistedPosition;
  const settledPositionPersisted = Boolean(
    Number.isFinite(finalPosition?.x) &&
    Number.isFinite(finalPosition?.y) &&
    Number.isFinite(finalPosition?.z) &&
    Number.isFinite(persistedPosition?.x) &&
    Number.isFinite(persistedPosition?.y) &&
    Number.isFinite(persistedPosition?.z) &&
    Math.abs(finalPosition!.x! - persistedPosition!.x!) <= 0.001 &&
    Math.abs(finalPosition!.y! - persistedPosition!.y!) <= 0.001 &&
    Math.abs(finalPosition!.z! - persistedPosition!.z!) <= 0.001,
  );
  if (
    report.status !== "passed" ||
    report.runtime?.mode !== "ordinary_preparation_only" ||
    report.runtime.preparationAgentId !== worker.agentId ||
    report.runtime.databaseMode !== "real_postgresql" ||
    preparation?.status !== "passed" ||
    preparation.playerId !== worker.agentId ||
    preparation.workerBridge?.checkpoints?.[0]?.attemptedActionType !==
      "bankWithdraw" ||
    preparation.gathering?.initialGatherCheckpointIndex == null ||
    preparation.workerBridge.checkpoints[
      preparation.gathering.initialGatherCheckpointIndex
    ]?.attemptedActionType !== "gather" ||
    (preparation.gathering.initialApproachActions ?? 0) < 2 ||
    (preparation.gathering.initialApproachMoveActions ?? 0) < 1 ||
    !Number.isSafeInteger(preparation.gathering.initialApproachRejections) ||
    (preparation.gathering.initialApproachRejections ?? 5) > 4 ||
    preparation.movement?.diagonalStep !== true ||
    preparation.movement?.readyStaging?.slot !== worker.readySlot ||
    !settledPositionPersisted ||
    preparation.movement.readyStaging.pairSeparation == null ||
    preparation.movement.readyStaging.pairSeparation < 2.75 ||
    preparation.movement.readyStaging.pairSeparation > 3.75 ||
    preparation.movement.readyStaging.targetTile?.x !==
      preparation.movement.readyStaging.finalTile?.x ||
    preparation.movement.readyStaging.targetTile?.z !==
      preparation.movement.readyStaging.finalTile?.z ||
    !Number.isSafeInteger(preparation.movement?.rangeApproachRejections) ||
    (preparation.movement?.rangeApproachRejections ?? 5) > 4 ||
    (preparation.presentation?.rotationPackets ?? 0) < 1 ||
    (preparation.gathering?.durableReceipts ?? 0) < FOOD_PER_AGENT ||
    (preparation.cooking?.actions ?? 0) < FOOD_PER_AGENT ||
    preparation.cooking?.forcedBurnObserved !== true ||
    preparation.cooking?.forcedRecoveryResourceMoveCancellationAttempted !==
      true ||
    preparation.cooking.forcedRecoveryResourceMoveCancellationObserved !==
      true ||
    !preparation.cooking.recoveryGatherFailureReasons?.includes(
      "resource_moved",
    ) ||
    !Number.isSafeInteger(preparation.cooking.recoveryDecisions) ||
    !Number.isSafeInteger(preparation.cooking.recoveryDecisionBudget) ||
    preparation.cooking.recoveryDecisions! >
      preparation.cooking.recoveryDecisionBudget! ||
    (preparation.cooking.recoveryGatherActions ?? 0) < 1 ||
    (preparation.cooking.cookedHealing ?? 0) <
      (preparation.cooking.requiredHealing ?? Number.POSITIVE_INFINITY) ||
    (worker.forgingQuest &&
      (preparation.forging?.status !== "passed" ||
        preparation.forging.questId !== "torvins_tools" ||
        preparation.forging.forgedWeaponId !== "bronze_shortsword" ||
        preparation.forging.gatheringReceipts !== 8 ||
        preparation.forging.processingReceipts !== 7 ||
        preparation.forging.persisted?.status !== "completed" ||
        preparation.forging.persisted.bronze_shortsword !== 1 ||
        preparation.forging.persisted.bronze_hatchet !== 1 ||
        preparation.forging.persisted.bronze_pickaxe !== 2 ||
        preparation.forging.persisted.hammer !== 1 ||
        preparation.forging.persisted.copper_ore !== 0 ||
        preparation.forging.persisted.tin_ore !== 0 ||
        preparation.forging.persisted.bronze_bar !== 0 ||
        preparation.forging.persisted.unresolved_gathering_receipts !== 0 ||
        preparation.forging.persisted.unresolved_processing_receipts !== 0)) ||
    (!worker.forgingQuest && preparation.forging?.status !== "skipped") ||
    preparation.presentation?.processingRejections !== 0 ||
    preparation.exactFinalCustodyAndXp !== true ||
    preparation.quiescent !== true ||
    event?.workspacePath !== report.runtime.workspacePath
  ) {
    throw new Error(
      `combined live-world preparation report drifted for ${worker.agentId}: ${JSON.stringify(report)}`,
    );
  }
}

function assertDistinctReadyStaging(
  reports: readonly LiveWorldPreparationReport[],
): void {
  const staging = reports.map(
    (report) => report.preparationVerticalSlice?.movement?.readyStaging,
  );
  const positions = reports.map(
    (report) => report.preparationVerticalSlice?.movement?.finalPosition,
  );
  const first = positions[0];
  const second = positions[1];
  const separation =
    typeof first?.x === "number" &&
    Number.isFinite(first.x) &&
    typeof first.z === "number" &&
    Number.isFinite(first.z) &&
    typeof second?.x === "number" &&
    Number.isFinite(second.x) &&
    typeof second.z === "number" &&
    Number.isFinite(second.z)
      ? Math.hypot(first.x - second.x, first.z - second.z)
      : Number.NaN;
  const targetSeparation = Math.hypot(
    (staging[0]?.targetTile?.x ?? Number.NaN) -
      (staging[1]?.targetTile?.x ?? Number.NaN),
    (staging[0]?.targetTile?.z ?? Number.NaN) -
      (staging[1]?.targetTile?.z ?? Number.NaN),
  );
  const reportedPairSeparation = staging.map((entry) => entry?.pairSeparation);
  if (
    !Number.isFinite(separation) ||
    separation < 2.75 ||
    separation > 3.75 ||
    !Number.isFinite(targetSeparation) ||
    Math.abs(targetSeparation - separation) > 0.001 ||
    reportedPairSeparation.some(
      (entry) =>
        typeof entry !== "number" ||
        !Number.isFinite(entry) ||
        Math.abs(entry - separation) > 0.001,
    )
  ) {
    throw new Error(
      `combined ready staging did not preserve one deterministic readable physical pair: ${JSON.stringify({ staging, positions, separation, targetSeparation, reportedPairSeparation })}`,
    );
  }
}

async function waitForExit(
  child: ChildProcess,
  stderr: readonly string[] = [],
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`combined prework did not exit: ${stderr.join("")}`)),
      15_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function readWorkerDatabaseSessionPids(
  pool: pg.Pool,
  applicationNames: readonly string[],
): Promise<number[]> {
  const result = await pool.query<{ pid: number }>(
    `SELECT pid
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = current_user
        AND application_name = ANY($1::text[])
      ORDER BY pid`,
    [[...applicationNames]],
  );
  return result.rows.map((row) => row.pid);
}

async function waitForWorkerDatabaseSessionsToDrain(
  pool: pg.Pool,
  applicationNames: readonly string[],
): Promise<{ elapsedMs: number; remainingWorkerSessionPids: number[] }> {
  const startedAt = Date.now();
  const deadline = startedAt + 30_000;
  let unexpectedSessionPids: number[] = [];
  while (Date.now() <= deadline) {
    unexpectedSessionPids = await readWorkerDatabaseSessionPids(
      pool,
      applicationNames,
    );
    if (unexpectedSessionPids.length === 0) {
      return {
        elapsedMs: Date.now() - startedAt,
        remainingWorkerSessionPids: [],
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `ordinary preparation worker PostgreSQL sessions did not drain after process loss: ${JSON.stringify(unexpectedSessionPids)}`,
  );
}

async function runExistingDatabasePreparation(): Promise<void> {
  const connectionString =
    process.env.AGENT_PREPARATION_DUEL_EXISTING_DATABASE_URL?.trim() || "";
  const evidencePath = path.resolve(
    process.env.AGENT_PREPARATION_DUEL_EXISTING_EVIDENCE_FILE?.trim() || "",
  );
  if (!connectionString) {
    throw new Error("AGENT_PREPARATION_DUEL_EXISTING_DATABASE_URL is required");
  }
  if (
    !process.env.AGENT_PREPARATION_DUEL_EXISTING_EVIDENCE_FILE?.trim() ||
    !path.isAbsolute(
      process.env.AGENT_PREPARATION_DUEL_EXISTING_EVIDENCE_FILE.trim(),
    )
  ) {
    throw new Error(
      "AGENT_PREPARATION_DUEL_EXISTING_EVIDENCE_FILE must be an absolute path",
    );
  }
  const multiStyle = readAgentDuel3dE2eMultiStyle();
  if (multiStyle && AGENT_DUEL_COMBAT_ROLE !== "ranged") {
    throw new Error(
      "AGENT_DUEL_3D_E2E_MULTI_STYLE requires AGENT_DUEL_CYCLE_CHAOS_ROLE=ranged",
    );
  }
  const expectedBankQuantity = (itemId: string): number =>
    multiStyle
      ? (AGENT_DUEL_MULTI_STYLE_BANK_ITEMS.find(
          (item) => item.itemId === itemId,
        )?.quantity ?? 0)
      : 0;

  const reportDirectory = path.dirname(evidencePath);
  const reportNamePrefix = `${path.basename(evidencePath, path.extname(evidencePath))}-${process.pid}-`;
  await mkdir(reportDirectory, { recursive: true });

  const pool = await waitForPostgres(connectionString);
  const workers: Array<ReturnType<typeof spawnPreworkWorker>> = [];
  let events: PreworkEvent[] = [];
  try {
    const seeded = await pool.query<{
      agentId: string;
      magicLevel: number;
      weaponId: string | null;
      arrowQuantity: number;
      fireRuneQuantity: number;
      mindRuneQuantity: number;
      bankMeleeWeaponQuantity: number;
      bankMageWeaponQuantity: number;
      bankFireRuneQuantity: number;
      bankMindRuneQuantity: number;
      ownedShortbowQuantity: number;
      ownedArrowQuantity: number;
      ownedLongswordQuantity: number;
      ownedShortswordQuantity: number;
      ownedStaffQuantity: number;
      ownedFireRuneQuantity: number;
      ownedMindRuneQuantity: number;
      ownedHatchetQuantity: number;
      ownedPickaxeQuantity: number;
      ownedHammerQuantity: number;
      ownedXpLampQuantity: number;
      preparationFood: number;
      gatheringOperations: string;
      processingOperations: string;
      ordinaryBankOperations: string;
    }>(
      `SELECT character.id AS "agentId",
              character."magicLevel" AS "magicLevel",
              (SELECT equipment."itemId"
                 FROM equipment
                WHERE equipment."playerId" = character.id
                  AND equipment."slotType" = 'weapon') AS "weaponId",
              COALESCE((SELECT sum(equipment.quantity)::int
                          FROM equipment
                         WHERE equipment."playerId" = character.id
                           AND equipment."slotType" = 'arrows'
                           AND equipment."itemId" = 'bronze_arrow'), 0)
                AS "arrowQuantity",
              COALESCE((SELECT sum(inventory.quantity)::int
                          FROM inventory
                         WHERE inventory."playerId" = character.id
                           AND inventory."itemId" = 'fire_rune'), 0)
                AS "fireRuneQuantity",
              COALESCE((SELECT sum(inventory.quantity)::int
                          FROM inventory
                         WHERE inventory."playerId" = character.id
                           AND inventory."itemId" = 'mind_rune'), 0)
                AS "mindRuneQuantity",
              COALESCE((SELECT sum(bank.quantity)::int
                          FROM bank_storage bank
                         WHERE bank."playerId" = character.id
                           AND bank."itemId" = 'bronze_longsword'), 0)
                AS "bankMeleeWeaponQuantity",
              COALESCE((SELECT sum(bank.quantity)::int
                          FROM bank_storage bank
                         WHERE bank."playerId" = character.id
                           AND bank."itemId" = 'staff_of_air'), 0)
                AS "bankMageWeaponQuantity",
              COALESCE((SELECT sum(bank.quantity)::int
                          FROM bank_storage bank
                         WHERE bank."playerId" = character.id
                           AND bank."itemId" = 'fire_rune'), 0)
                AS "bankFireRuneQuantity",
              COALESCE((SELECT sum(bank.quantity)::int
                          FROM bank_storage bank
                         WHERE bank."playerId" = character.id
                           AND bank."itemId" = 'mind_rune'), 0)
                AS "bankMindRuneQuantity",
              COALESCE((SELECT sum(inventory.quantity)::int
                          FROM inventory
                         WHERE inventory."playerId" = character.id
                           AND inventory."itemId" IN (
                             'lobster', 'raw_shrimp', 'shrimp', 'burnt_shrimp'
                           )), 0) AS "preparationFood",
              (SELECT count(*)::text FROM operations_log
                WHERE "playerId" = character.id
                  AND "operationType" = 'gathering_reward')
                AS "gatheringOperations",
              (SELECT count(*)::text FROM operations_log
                WHERE "playerId" = character.id
                  AND "operationType" = 'processing_action')
                AS "processingOperations",
              (SELECT count(*)::text FROM agent_bank_operations
                WHERE "playerId" = character.id
                  AND "preparationId" IS NULL)
                AS "ordinaryBankOperations"
         FROM characters AS character
        WHERE character.id = ANY($1::text[])
        ORDER BY character.id`,
      [[...AGENT_IDS]],
    );
    if (
      seeded.rows.length !== AGENT_IDS.length ||
      seeded.rows.some(
        (row) =>
          row.magicLevel !==
            (multiStyle
              ? AGENT_DUEL_ROLE_FIXTURES.mage.magicLevel
              : AGENT_DUEL_ROLE_FIXTURE.magicLevel) ||
          row.weaponId !== AGENT_DUEL_ROLE_FIXTURE.weaponId ||
          row.arrowQuantity !==
            (AGENT_DUEL_ROLE_FIXTURE.equippedAmmunition?.quantity ?? 0) ||
          row.fireRuneQuantity !==
            (AGENT_DUEL_ROLE_FIXTURE.inventorySupplies.find(
              (supply) => supply.itemId === "fire_rune",
            )?.quantity ?? 0) ||
          row.mindRuneQuantity !==
            (AGENT_DUEL_ROLE_FIXTURE.inventorySupplies.find(
              (supply) => supply.itemId === "mind_rune",
            )?.quantity ?? 0) ||
          row.bankMeleeWeaponQuantity !==
            expectedBankQuantity("bronze_longsword") ||
          row.bankMageWeaponQuantity !== expectedBankQuantity("staff_of_air") ||
          row.bankFireRuneQuantity !== expectedBankQuantity("fire_rune") ||
          row.bankMindRuneQuantity !== expectedBankQuantity("mind_rune") ||
          row.preparationFood !== 0 ||
          row.gatheringOperations !== "0" ||
          row.processingOperations !== "0" ||
          row.ordinaryBankOperations !== "0",
      )
    ) {
      throw new Error(
        `existing-database preparation requires the exact fresh no-food launch fixture: ${JSON.stringify(seeded.rows)}`,
      );
    }

    workers.push(
      ...AGENT_IDS.map((agentId, index) =>
        spawnPreworkWorker(
          connectionString,
          agentId,
          index,
          reportDirectory,
          reportNamePrefix,
          multiStyle,
        ),
      ),
    );
    events = await Promise.all(workers.map((worker) => worker.event));
    const reports = await Promise.all(
      workers.map(async (worker, index) => {
        const bytes = await readFile(worker.reportPath);
        const report = JSON.parse(
          bytes.toString("utf8"),
        ) as LiveWorldPreparationReport;
        assertLivePreparationReport(worker, events[index], report);
        return {
          report,
          path: worker.reportPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }),
    );
    assertDistinctReadyStaging(reports.map(({ report }) => report));

    for (const worker of workers) {
      if (!worker.child.kill("SIGKILL")) {
        throw new Error(
          `failed to kill existing-database preparation worker ${worker.agentId}`,
        );
      }
    }
    await Promise.all(
      workers.map((worker) => waitForExit(worker.child, worker.stderr)),
    );
    if (workers.some((worker) => worker.child.signalCode !== "SIGKILL")) {
      throw new Error(
        `existing-database preparation workers did not all stop at the process-loss boundary: ${JSON.stringify(workers.map((worker) => worker.child.signalCode))}`,
      );
    }
    const databaseSessionDrain = await waitForWorkerDatabaseSessionsToDrain(
      pool,
      workers.map((worker) => worker.databaseApplicationName),
    );

    const custody = await pool.query<{
      agentId: string;
      magicLevel: number;
      equippedWeaponId: string | null;
      equippedArrowQuantity: number;
      bankMeleeWeaponQuantity: number;
      bankMageWeaponQuantity: number;
      bankFireRuneQuantity: number;
      bankMindRuneQuantity: number;
      fishingXp: number;
      fishingLevel: number;
      cookingXp: number;
      cookingLevel: number;
      cookedFood: number;
      rawFood: number;
      burntFood: number;
      toolCount: number;
      gatheringOperations: string;
      processingOperations: string;
      ordinaryBankOperations: string;
      progressionStarts: string;
      progressionTerminals: string;
      openAttemptId: string | null;
    }>(
      `SELECT character.id AS "agentId",
              character."magicLevel" AS "magicLevel",
              (SELECT equipment."itemId" FROM equipment
                WHERE equipment."playerId" = character.id
                  AND equipment."slotType" = 'weapon') AS "equippedWeaponId",
              COALESCE((SELECT sum(equipment.quantity)::int FROM equipment
                         WHERE equipment."playerId" = character.id
                           AND equipment."slotType" = 'arrows'
                           AND equipment."itemId" = 'bronze_arrow'), 0)
                AS "equippedArrowQuantity",
              COALESCE((SELECT sum(bank.quantity)::int FROM bank_storage bank
                         WHERE bank."playerId" = character.id
                           AND bank."itemId" = 'bronze_longsword'), 0)
                AS "bankMeleeWeaponQuantity",
              COALESCE((SELECT sum(bank.quantity)::int FROM bank_storage bank
                         WHERE bank."playerId" = character.id
                           AND bank."itemId" = 'staff_of_air'), 0)
                AS "bankMageWeaponQuantity",
              COALESCE((SELECT sum(bank.quantity)::int FROM bank_storage bank
                         WHERE bank."playerId" = character.id
                           AND bank."itemId" = 'fire_rune'), 0)
                AS "bankFireRuneQuantity",
              COALESCE((SELECT sum(bank.quantity)::int FROM bank_storage bank
                         WHERE bank."playerId" = character.id
                           AND bank."itemId" = 'mind_rune'), 0)
                AS "bankMindRuneQuantity",
              COALESCE(owned.shortbow, 0)::int AS "ownedShortbowQuantity",
              COALESCE(owned.arrows, 0)::int AS "ownedArrowQuantity",
              COALESCE(owned.longsword, 0)::int AS "ownedLongswordQuantity",
              COALESCE(owned.shortsword, 0)::int AS "ownedShortswordQuantity",
              COALESCE(owned.staff, 0)::int AS "ownedStaffQuantity",
              COALESCE(owned.fire_runes, 0)::int AS "ownedFireRuneQuantity",
              COALESCE(owned.mind_runes, 0)::int AS "ownedMindRuneQuantity",
              COALESCE(owned.hatchet, 0)::int AS "ownedHatchetQuantity",
              COALESCE(owned.pickaxe, 0)::int AS "ownedPickaxeQuantity",
              COALESCE(owned.hammer, 0)::int AS "ownedHammerQuantity",
              COALESCE(owned.xp_lamp, 0)::int AS "ownedXpLampQuantity",
              character."fishingXp" AS "fishingXp",
              character."fishingLevel" AS "fishingLevel",
              character."cookingXp" AS "cookingXp",
              character."cookingLevel" AS "cookingLevel",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = 'shrimp'), 0)
                AS "cookedFood",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = 'raw_shrimp'), 0)
                AS "rawFood",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = 'burnt_shrimp'), 0)
              + COALESCE((SELECT sum(quantity)::int FROM bank_storage
                           WHERE "playerId" = character.id AND "itemId" = 'burnt_shrimp'), 0)
                AS "burntFood",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = 'small_fishing_net'), 0)
                AS "toolCount",
              (SELECT count(*)::text FROM operations_log
                WHERE "playerId" = character.id
                  AND "operationType" = 'gathering_reward')
                AS "gatheringOperations",
              (SELECT count(*)::text FROM operations_log
                WHERE "playerId" = character.id
                  AND "operationType" = 'processing_action')
                AS "processingOperations",
              (SELECT count(*)::text FROM agent_bank_operations
                WHERE "playerId" = character.id
                  AND "preparationId" IS NULL)
                AS "ordinaryBankOperations",
              (SELECT count(*)::text FROM agent_autonomy_progression_events
                WHERE character_id = character.id
                  AND event_type = 'attempt_started')
                AS "progressionStarts",
              (SELECT count(*)::text FROM agent_autonomy_progression_events
                WHERE character_id = character.id
                  AND event_type = 'attempt_terminal')
                AS "progressionTerminals",
              head.open_attempt_id AS "openAttemptId"
         FROM characters AS character
         LEFT JOIN agent_autonomy_progression_heads AS head
           ON head.character_id = character.id
         LEFT JOIN LATERAL (
           SELECT sum(quantity) FILTER (WHERE "itemId" = 'shortbow') AS shortbow,
                  sum(quantity) FILTER (WHERE "itemId" = 'bronze_arrow') AS arrows,
                  sum(quantity) FILTER (WHERE "itemId" = 'bronze_longsword') AS longsword,
                  sum(quantity) FILTER (WHERE "itemId" = 'bronze_shortsword') AS shortsword,
                  sum(quantity) FILTER (WHERE "itemId" = 'staff_of_air') AS staff,
                  sum(quantity) FILTER (WHERE "itemId" = 'fire_rune') AS fire_runes,
                  sum(quantity) FILTER (WHERE "itemId" = 'mind_rune') AS mind_runes,
                  sum(quantity) FILTER (WHERE "itemId" = 'bronze_hatchet') AS hatchet,
                  sum(quantity) FILTER (WHERE "itemId" = 'bronze_pickaxe') AS pickaxe,
                  sum(quantity) FILTER (WHERE "itemId" = 'hammer') AS hammer,
                  sum(quantity) FILTER (WHERE "itemId" = 'xp_lamp_100') AS xp_lamp
             FROM (
               SELECT "itemId", quantity FROM inventory
                WHERE "playerId" = character.id
               UNION ALL
               SELECT "itemId", quantity FROM equipment
                WHERE "playerId" = character.id
               UNION ALL
               SELECT "itemId", quantity FROM bank_storage
                WHERE "playerId" = character.id
             ) AS all_owned
         ) AS owned ON true
        WHERE character.id = ANY($1::text[])
        ORDER BY character.id`,
      [[...AGENT_IDS]],
    );
    const reportByAgent = new Map(
      reports.map(({ report }) => [
        report.runtime!.preparationAgentId!,
        report.preparationVerticalSlice!,
      ]),
    );
    if (
      custody.rows.length !== AGENT_IDS.length ||
      custody.rows.some((row) => {
        const preparation = reportByAgent.get(row.agentId);
        const checkpoints = preparation?.workerBridge?.checkpoints;
        const progressionCheckpointCount = checkpoints
          ? checkpoints.filter(
              (checkpoint) => checkpoint.attemptedActionType !== "idle",
            ).length
          : -1;
        const expectedProcessingReceipts =
          preparation?.processing?.durableReceipts;
        const expectedOrdinaryBankOperations =
          1 + (preparation?.forging?.actionCounts?.bankDepositAll ?? 0);
        return (
          row.magicLevel !==
            (multiStyle
              ? AGENT_DUEL_ROLE_FIXTURES.mage.magicLevel
              : AGENT_DUEL_ROLE_FIXTURE.magicLevel) ||
          (!multiStyle &&
            row.equippedWeaponId !== AGENT_DUEL_ROLE_FIXTURE.weaponId) ||
          row.equippedArrowQuantity !==
            (AGENT_DUEL_ROLE_FIXTURE.equippedAmmunition?.quantity ?? 0) ||
          row.bankMeleeWeaponQuantity !==
            expectedBankQuantity("bronze_longsword") ||
          row.bankMageWeaponQuantity !== expectedBankQuantity("staff_of_air") ||
          row.bankFireRuneQuantity !== expectedBankQuantity("fire_rune") ||
          row.bankMindRuneQuantity !== expectedBankQuantity("mind_rune") ||
          row.cookedFood !== preparation?.cooking?.successfulOutputs ||
          row.cookedFood < FOOD_PER_AGENT ||
          row.rawFood < 0 ||
          row.burntFood !== preparation?.cooking?.burntOutputs ||
          row.toolCount !== 1 ||
          row.gatheringOperations !==
            String(preparation?.gathering?.durableReceipts) ||
          row.processingOperations !== String(expectedProcessingReceipts) ||
          row.ownedShortbowQuantity !== 1 ||
          row.ownedArrowQuantity !==
            (AGENT_DUEL_ROLE_FIXTURE.equippedAmmunition?.quantity ?? 0) ||
          row.ownedLongswordQuantity !==
            expectedBankQuantity("bronze_longsword") ||
          row.ownedStaffQuantity !== expectedBankQuantity("staff_of_air") ||
          row.ownedFireRuneQuantity !== expectedBankQuantity("fire_rune") ||
          row.ownedMindRuneQuantity !== expectedBankQuantity("mind_rune") ||
          (multiStyle &&
            (row.ownedShortswordQuantity !== 1 ||
              row.ownedHatchetQuantity !== 1 ||
              row.ownedPickaxeQuantity !== 2 ||
              row.ownedHammerQuantity !== 1 ||
              row.ownedXpLampQuantity !== 1)) ||
          (!multiStyle &&
            (row.ownedShortswordQuantity !== 0 ||
              row.ownedHatchetQuantity !== 0 ||
              row.ownedPickaxeQuantity !== 0 ||
              row.ownedHammerQuantity !== 0 ||
              row.ownedXpLampQuantity !== 0)) ||
          row.ordinaryBankOperations !==
            String(expectedOrdinaryBankOperations) ||
          row.progressionStarts !== String(progressionCheckpointCount) ||
          row.progressionTerminals !== String(progressionCheckpointCount) ||
          row.openAttemptId !== null
        );
      })
    ) {
      throw new Error(
        `existing-database preparation custody did not survive process loss: ${JSON.stringify(custody.rows)}`,
      );
    }

    const evidence = {
      schemaVersion: 3,
      status: "passed",
      generatedAt: new Date().toISOString(),
      multiStyle,
      availableCombatRoles: multiStyle
        ? (["melee", "ranged", "mage"] as const)
        : ([AGENT_DUEL_COMBAT_ROLE] as const),
      samePersistentAgentIds: [...AGENT_IDS],
      agents: custody.rows.map((row) => ({
        agentId: row.agentId,
        magicLevel: row.magicLevel,
        equippedWeaponId: row.equippedWeaponId,
        equippedArrowQuantity: row.equippedArrowQuantity,
        privateMultiStyleCustody: {
          meleeWeapon: row.bankMeleeWeaponQuantity,
          mageWeapon: row.bankMageWeaponQuantity,
          fireRunes: row.bankFireRuneQuantity,
          mindRunes: row.bankMindRuneQuantity,
        },
        ownedForgingAndCombatCustody: {
          shortbow: row.ownedShortbowQuantity,
          bronzeArrows: row.ownedArrowQuantity,
          bronzeLongsword: row.ownedLongswordQuantity,
          bronzeShortsword: row.ownedShortswordQuantity,
          staffOfAir: row.ownedStaffQuantity,
          fireRunes: row.ownedFireRuneQuantity,
          mindRunes: row.ownedMindRuneQuantity,
          bronzeHatchet: row.ownedHatchetQuantity,
          bronzePickaxe: row.ownedPickaxeQuantity,
          hammer: row.ownedHammerQuantity,
          xpLamp100: row.ownedXpLampQuantity,
        },
        fishingXp: row.fishingXp,
        fishingLevel: row.fishingLevel,
        cookingXp: row.cookingXp,
        cookingLevel: row.cookingLevel,
        cookedFood: row.cookedFood,
        rawFood: row.rawFood,
        burntFood: row.burntFood,
        toolCount: row.toolCount,
        gatheringOperations: Number(row.gatheringOperations),
        processingOperations: Number(row.processingOperations),
        ordinaryBankOperations: Number(row.ordinaryBankOperations),
        workerCheckpoints:
          reportByAgent.get(row.agentId)?.workerBridge?.checkpoints?.length ??
          0,
        progressionEligibleCheckpoints:
          reportByAgent
            .get(row.agentId)
            ?.workerBridge?.checkpoints?.filter(
              (checkpoint) => checkpoint.attemptedActionType !== "idle",
            ).length ?? 0,
        progressionStarts: Number(row.progressionStarts),
        progressionTerminals: Number(row.progressionTerminals),
      })),
      totals: {
        gatheringOperations: custody.rows.reduce(
          (total, row) => total + Number(row.gatheringOperations),
          0,
        ),
        processingOperations: custody.rows.reduce(
          (total, row) => total + Number(row.processingOperations),
          0,
        ),
        ordinaryBankOperations: custody.rows.reduce(
          (total, row) => total + Number(row.ordinaryBankOperations),
          0,
        ),
      },
      liveWorldReports: reports.map(
        ({ report, path: reportPath, sha256 }, index) => ({
          agentId: report.runtime!.preparationAgentId!,
          path: reportPath,
          sha256,
          progress: workers[index].progress,
          preparationVerticalSlice: report.preparationVerticalSlice,
        }),
      ),
      processDeathRecoveryCovered: true,
      ordinaryAutonomySelectionCovered: true,
      liveWorldNavigationCovered: true,
      livePreparationPresentationCovered: true,
      realPostgresqlCustodyCovered: true,
      fullTopologySeedContractCovered: true,
      ownedMultiStylePreparationCovered: multiStyle,
      ordinaryForgingQuestCovered: multiStyle,
      workerDatabaseSessionsDrained: true,
      workerDatabaseSessionDrainElapsedMs: databaseSessionDrain.elapsedMs,
      remainingWorkerDatabaseSessionPids:
        databaseSessionDrain.remainingWorkerSessionPids,
      scriptedCustodyBridgeCovered: false,
      externalModelProviderCovered: false,
    } as const;
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify({ event: "existing-database-ordinary-preparation-passed", evidencePath, agents: evidence.agents })}\n`,
    );
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill("SIGKILL");
        await waitForExit(worker.child, worker.stderr).catch(() => undefined);
      }
    }
    for (const event of events) {
      if (event.workspacePath) {
        await rm(event.workspacePath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
    await pool.end();
  }
}

async function runParent(): Promise<void> {
  if (AGENT_DUEL_COMBINED_MULTI_STYLE && AGENT_DUEL_COMBAT_ROLE !== "ranged") {
    throw new Error(
      "the combined multi-style fixture requires AGENT_DUEL_CYCLE_CHAOS_ROLE=ranged",
    );
  }
  const truth = loadManifestTruth();
  const containerName = `hyperia-preparation-duel-combined-${process.pid}`;
  const databaseUser = "preparation_duel_combined";
  const databaseName = "preparation_duel_combined";
  const databasePassword = `combined-${randomUUID()}`;
  const image =
    process.env.AGENT_PREPARATION_DUEL_COMBINED_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  const prework: Array<ReturnType<typeof spawnPreworkWorker>> = [];
  let preworkEvents: PreworkEvent[] = [];
  let runtime: WorkerRuntime | null = null;
  let scheduler: StreamingDuelScheduler | null = null;
  let authoritativeCombat: AuthoritativeCombatRuntime | null = null;

  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(
        `Docker is required for the combined preparation gate: ${error}`,
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
      throw new Error("could not resolve combined PostgreSQL port");
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
    await seedAgents(drizzle(pool, { schema }), {
      multiStyle: AGENT_DUEL_COMBINED_MULTI_STYLE,
    });
    await pool.query(
      `DELETE FROM inventory
        WHERE "playerId" = ANY($1::text[]) AND "itemId" = $2`,
      [AGENT_IDS, LEGACY_FIXTURE_FOOD_ID],
    );

    prework.push(
      ...AGENT_IDS.map((agentId, index) =>
        spawnPreworkWorker(
          connectionString,
          agentId,
          index,
          combinedEvidenceDirectory,
          `${combinedScenario}-`,
        ),
      ),
    );
    preworkEvents = await Promise.all(prework.map((worker) => worker.event));
    const livePreparationReports = await Promise.all(
      prework.map(async (worker, index) => {
        const report = JSON.parse(
          await readFile(worker.reportPath, "utf8"),
        ) as LiveWorldPreparationReport;
        assertLivePreparationReport(worker, preworkEvents[index], report);
        return report;
      }),
    );
    assertDistinctReadyStaging(livePreparationReports);
    for (const worker of prework) {
      if (!worker.child.kill("SIGKILL")) {
        throw new Error(
          `failed to kill live-world preparation worker ${worker.agentId}`,
        );
      }
    }
    await Promise.all(
      prework.map((worker) => waitForExit(worker.child, worker.stderr)),
    );
    for (const [index, worker] of prework.entries()) {
      if (worker.child.signalCode !== "SIGKILL") {
        throw new Error(
          `combined live-world preparation exited without SIGKILL for ${worker.agentId}: ${worker.child.signalCode}`,
        );
      }
      const workspacePath = preworkEvents[index]?.workspacePath;
      if (!workspacePath) {
        throw new Error(
          `combined live-world workspace path missing for ${worker.agentId}`,
        );
      }
      await rm(workspacePath, { recursive: true, force: true });
    }

    const custodyAfterKill = await pool.query<{
      agentId: string;
      fishingXp: number;
      fishingLevel: number;
      cookingXp: number;
      cookingLevel: number;
      bankedFood: number;
      inventoryFood: number;
      rawFood: number;
      burntFood: number;
      toolCount: number;
      gatheringOperations: string;
      processingOperations: string;
      ordinaryBankOperations: string;
      progressionStarts: string;
      progressionTerminals: string;
      openAttemptId: string | null;
    }>(
      `SELECT character.id AS "agentId",
              character."fishingXp" AS "fishingXp",
              character."fishingLevel" AS "fishingLevel",
              character."cookingXp" AS "cookingXp",
              character."cookingLevel" AS "cookingLevel",
              COALESCE((SELECT sum(quantity)::int FROM bank_storage
                         WHERE "playerId" = character.id AND "itemId" = $1), 0)
                AS "bankedFood",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = $1), 0)
                AS "inventoryFood",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = $2), 0)
                AS "rawFood",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = 'burnt_shrimp'), 0)
                AS "burntFood",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = 'small_fishing_net'), 0)
                AS "toolCount",
              (SELECT count(*)::text FROM operations_log
                WHERE "playerId" = character.id AND "operationType" = 'gathering_reward')
                AS "gatheringOperations",
              (SELECT count(*)::text FROM operations_log
                WHERE "playerId" = character.id AND "operationType" = 'processing_action')
                AS "processingOperations",
              (SELECT count(*)::text FROM agent_bank_operations
                WHERE "playerId" = character.id AND action = 'withdraw'
                  AND "preparationId" IS NULL)
                AS "ordinaryBankOperations",
              (SELECT count(*)::text FROM agent_autonomy_progression_events
                WHERE character_id = character.id AND event_type = 'attempt_started')
                AS "progressionStarts",
              (SELECT count(*)::text FROM agent_autonomy_progression_events
                WHERE character_id = character.id AND event_type = 'attempt_terminal')
                AS "progressionTerminals",
              head.open_attempt_id AS "openAttemptId"
         FROM characters character
         LEFT JOIN agent_autonomy_progression_heads head
           ON head.character_id = character.id
        WHERE character.id = ANY($3::text[])
        ORDER BY character.id`,
      [COOKED_FOOD_ID, RAW_FOOD_ID, AGENT_IDS],
    );
    const reportByAgent = new Map(
      livePreparationReports.map((report) => [
        report.runtime!.preparationAgentId!,
        report,
      ]),
    );
    if (
      custodyAfterKill.rows.length !== 2 ||
      custodyAfterKill.rows.some((row) => {
        const preparation = reportByAgent.get(
          row.agentId,
        )?.preparationVerticalSlice;
        const expectedCooked = preparation?.cooking?.successfulOutputs;
        const expectedBurnt = preparation?.cooking?.burntOutputs;
        const expectedGathering = preparation?.gathering?.durableReceipts;
        const expectedProcessing = preparation?.cooking?.actions;
        const expectedProgression =
          preparation?.workerBridge?.checkpoints?.length;
        return (
          !Number.isSafeInteger(expectedCooked) ||
          expectedCooked! < FOOD_PER_AGENT ||
          row.bankedFood !== 0 ||
          row.inventoryFood !== expectedCooked ||
          row.rawFood < 0 ||
          row.burntFood !== expectedBurnt ||
          row.toolCount !== 1 ||
          row.gatheringOperations !== String(expectedGathering) ||
          row.processingOperations !== String(expectedProcessing) ||
          row.ordinaryBankOperations !== "1" ||
          row.progressionStarts !== String(expectedProgression) ||
          row.progressionTerminals !== String(expectedProgression) ||
          row.openAttemptId !== null
        );
      })
    ) {
      throw new Error(
        `combined prework custody did not survive SIGKILL: ${JSON.stringify(custodyAfterKill.rows)}`,
      );
    }
    const preworkEvidence = {
      event: "ordinary_preparation_committed" as const,
      agents: custodyAfterKill.rows.map((row): PreworkAgentEvidence => ({
        agentId: row.agentId,
        fishingXp: row.fishingXp,
        fishingLevel: row.fishingLevel,
        cookingXp: row.cookingXp,
        cookingLevel: row.cookingLevel,
        bankedFood: row.bankedFood,
        inventoryFood: row.inventoryFood,
        progressionStarts: Number(row.progressionStarts),
        progressionTerminals: Number(row.progressionTerminals),
      })),
      gatheringOperations: custodyAfterKill.rows.reduce(
        (total, row) => total + Number(row.gatheringOperations),
        0,
      ),
      processingOperations: custodyAfterKill.rows.reduce(
        (total, row) => total + Number(row.processingOperations),
        0,
      ),
      ordinaryBankOperations: custodyAfterKill.rows.reduce(
        (total, row) => total + Number(row.ordinaryBankOperations),
        0,
      ),
    } satisfies PreworkEvent;

    installFoodManifests(truth);
    runtime = await startWorkerRuntime(connectionString);
    authoritativeCombat = await installAuthoritativeCombatRuntime(runtime);
    scheduler = new StreamingDuelScheduler(runtime.world, {
      fencingToken: "1",
    });
    scheduler.init();
    const internal = schedulerInternals(scheduler);
    const cycle = await openPersistedCycle(runtime, scheduler).catch(
      async (error) => {
        const [characters, equipment, inventory, bank, preparations, plans] =
          await Promise.all([
            pool!.query(
              `SELECT id, "selectedSpell" FROM characters
                WHERE id = ANY($1::text[]) ORDER BY id`,
              [AGENT_IDS],
            ),
            pool!.query(
              `SELECT "playerId", "slotType", "itemId", quantity
                 FROM equipment WHERE "playerId" = ANY($1::text[])
                ORDER BY "playerId", "slotType"`,
              [AGENT_IDS],
            ),
            pool!.query(
              `SELECT "playerId", "slotIndex", "itemId", quantity
                 FROM inventory WHERE "playerId" = ANY($1::text[])
                ORDER BY "playerId", "slotIndex"`,
              [AGENT_IDS],
            ),
            pool!.query(
              `SELECT "playerId", "tabIndex", slot, "itemId", quantity
                 FROM bank_storage WHERE "playerId" = ANY($1::text[])
                ORDER BY "playerId", "tabIndex", slot`,
              [AGENT_IDS],
            ),
            pool!.query(
              `SELECT "preparationId", status, "agent1ReadyAt", "agent2ReadyAt",
                      "agent1PlanEvidence", "agent2PlanEvidence",
                      "cancellationReason"
                 FROM streaming_duel_preparations ORDER BY "selectedAt"`,
            ),
            pool!.query(
              `SELECT id, "playerId", completed, "operationState"
                 FROM operations_log
                WHERE "playerId" = ANY($1::text[])
                  AND "operationType" = 'duel_preparation_plan'
                ORDER BY "playerId", id`,
              [AGENT_IDS],
            ),
          ]);
        throw new Error(
          `combined cycle open failed: ${JSON.stringify({ cause: error instanceof Error ? error.message : String(error), characters: characters.rows, equipment: equipment.rows, inventory: inventory.rows, bank: bank.rows, preparations: preparations.rows, plans: plans.rows })}`,
        );
      },
    );
    const snapshot = cycle.competitiveSnapshot;
    if (
      !snapshot?.persisted ||
      snapshot.diagnostic ||
      !cycle.competitiveSnapshotDigest ||
      !snapshot.preparationId ||
      !cycle.duelId ||
      !cycle.betCloseTime
    ) {
      throw new Error("combined cycle did not freeze competitive evidence");
    }

    const persistedSkills = new Map(
      preworkEvidence.agents.map((agent) => [agent.agentId, agent]),
    );
    const rangedFixture = AGENT_DUEL_ROLE_FIXTURES.ranged;
    const mageFixture = AGENT_DUEL_ROLE_FIXTURES.mage;
    const initialAmmunitionPerAgent =
      (AGENT_DUEL_COMBINED_MULTI_STYLE
        ? rangedFixture.equippedAmmunition
        : AGENT_DUEL_ROLE_FIXTURE.equippedAmmunition
      )?.quantity ?? 0;
    const initialInventorySupplyByItem = new Map(
      (AGENT_DUEL_COMBINED_MULTI_STYLE
        ? mageFixture.inventorySupplies
        : AGENT_DUEL_ROLE_FIXTURE.inventorySupplies
      ).map((supply) => [supply.itemId, supply.quantity]),
    );
    const projectileCostByItem = new Map(
      (AGENT_DUEL_COMBINED_MULTI_STYLE
        ? mageFixture.projectileInventoryCost
        : AGENT_DUEL_ROLE_FIXTURE.projectileInventoryCost
      ).map((cost) => [cost.itemId, cost.quantity]),
    );
    const fullDurationAttackSupplyTargets = {
      ranged: getDuelPreparationAttackSupplyTarget(
        snapshot.timing.maxFightDurationMs,
        Math.max(
          1,
          (ITEMS.get(rangedFixture.weaponId)?.attackSpeed ??
            COMBAT_CONSTANTS.DEFAULTS.ITEM.ATTACK_SPEED) - 1,
        ),
      ),
      mage: getDuelPreparationAttackSupplyTarget(
        snapshot.timing.maxFightDurationMs,
        COMBAT_SPELLS[mageFixture.selectedSpellId!].attackSpeed,
      ),
    } as const;
    const fullDurationAttackSupplyTarget =
      AGENT_DUEL_COMBAT_ROLE === "ranged"
        ? fullDurationAttackSupplyTargets.ranged
        : AGENT_DUEL_COMBAT_ROLE === "mage"
          ? fullDurationAttackSupplyTargets.mage
          : 0;
    const expectedAttackSupplyUnitsPerAgent =
      AGENT_DUEL_COMBAT_ROLE === "ranged"
        ? Math.min(fullDurationAttackSupplyTarget, initialAmmunitionPerAgent)
        : AGENT_DUEL_COMBAT_ROLE === "mage"
          ? AGENT_DUEL_ROLE_FIXTURE.projectileInventoryCost.reduce(
              (casts, cost) =>
                Math.min(
                  casts,
                  Math.floor(
                    (initialInventorySupplyByItem.get(cost.itemId) ?? 0) /
                      cost.quantity,
                  ),
                ),
              fullDurationAttackSupplyTarget,
            )
          : 0;
    const expectedFrozenInventorySupplyByItem = new Map(
      [...initialInventorySupplyByItem.entries()].map(([itemId, quantity]) => {
        const cost = projectileCostByItem.get(itemId);
        return [
          itemId,
          cost === undefined
            ? quantity
            : cost *
              (AGENT_DUEL_COMBINED_MULTI_STYLE
                ? fullDurationAttackSupplyTargets.mage
                : expectedAttackSupplyUnitsPerAgent),
        ] as const;
      }),
    );
    if (
      (AGENT_DUEL_COMBAT_ROLE === "ranged" ||
        AGENT_DUEL_COMBAT_ROLE === "mage") &&
      expectedAttackSupplyUnitsPerAgent <= 0
    ) {
      throw new Error("combined projectile supply target was not positive");
    }
    for (const contestant of snapshot.contestants) {
      const expected = persistedSkills.get(contestant.agentId);
      const fishingLevel = contestant.skillLevels.find(
        (skill) => skill.skill === "fishing",
      )?.level;
      const cookingLevel = contestant.skillLevels.find(
        (skill) => skill.skill === "cooking",
      )?.level;
      const cookedFood = contestant.inventory.filter(
        (item) => item.itemId === COOKED_FOOD_ID,
      );
      const preparationResidue = contestant.inventory.filter(
        (item) =>
          item.itemId === RAW_FOOD_ID ||
          item.itemId === "burnt_shrimp" ||
          item.itemId === "small_fishing_net" ||
          item.itemId === LEGACY_FIXTURE_FOOD_ID,
      );
      const weapon = contestant.equipment.find(
        (item) => item.slot === "weapon",
      );
      const ammunition = contestant.equipment.find(
        (item) => item.slot === "arrows",
      );
      const inventorySupplyDrifted = [...initialInventorySupplyByItem].some(
        ([itemId]) =>
          contestant.inventory
            .filter((item) => item.itemId === itemId)
            .reduce((total, item) => total + item.quantity, 0) !==
          expectedFrozenInventorySupplyByItem.get(itemId),
      );
      const expectedAmmunition = AGENT_DUEL_ROLE_FIXTURE.equippedAmmunition;
      const ownedFrozenQuantity = (itemId: string): number =>
        contestant.equipment
          .filter((item) => item.itemId === itemId)
          .reduce((total, item) => total + item.quantity, 0) +
        contestant.inventory
          .filter((item) => item.itemId === itemId)
          .reduce((total, item) => total + item.quantity, 0);
      const availableMultiStyleRoles = ["melee", "ranged", "mage"] as const;
      const multiStyleSetValid =
        contestant.availableCombatStyles.length ===
          availableMultiStyleRoles.length &&
        availableMultiStyleRoles.every((role) =>
          contestant.availableCombatStyles.includes(role),
        ) &&
        contestant.preparation.availableStyles.length ===
          availableMultiStyleRoles.length &&
        availableMultiStyleRoles.every((role) =>
          contestant.preparation.availableStyles.includes(role),
        );
      const multiStyleLoadoutsValid = availableMultiStyleRoles.every((role) => {
        const fixture = AGENT_DUEL_ROLE_FIXTURES[role];
        const loadout = contestant.combatLoadouts[role];
        return (
          loadout?.role === role &&
          loadout.weaponId === fixture.weaponId &&
          loadout.arrowsId === (fixture.equippedAmmunition?.itemId ?? null) &&
          loadout.spellId === fixture.selectedSpellId
        );
      });
      const initialMultiStyleFixture =
        contestant.initialCombatStyle === "melee" ||
        contestant.initialCombatStyle === "ranged" ||
        contestant.initialCombatStyle === "mage"
          ? AGENT_DUEL_ROLE_FIXTURES[contestant.initialCombatStyle]
          : null;
      const multiStyleFrozenStateValid =
        multiStyleSetValid &&
        multiStyleLoadoutsValid &&
        initialMultiStyleFixture !== null &&
        contestant.preparation.primaryStyle === contestant.initialCombatStyle &&
        weapon?.itemId === initialMultiStyleFixture.weaponId &&
        contestant.selectedSpell ===
          (contestant.initialCombatStyle === "mage" ? "fire_strike" : null) &&
        ammunition?.itemId === "bronze_arrow" &&
        ammunition.quantity === fullDurationAttackSupplyTargets.ranged &&
        ownedFrozenQuantity("bronze_longsword") === 1 &&
        ownedFrozenQuantity("shortbow") === 1 &&
        ownedFrozenQuantity("staff_of_air") === 1;
      if (
        !expected ||
        cookedFood.length !== expected.inventoryFood ||
        cookedFood.some((item) => item.quantity !== 1) ||
        preparationResidue.length !== 0 ||
        (AGENT_DUEL_COMBINED_MULTI_STYLE
          ? !multiStyleFrozenStateValid
          : weapon?.itemId !== AGENT_DUEL_ROLE_FIXTURE.weaponId ||
            (expectedAmmunition === null
              ? ammunition !== undefined
              : ammunition?.itemId !== expectedAmmunition.itemId ||
                ammunition.quantity !== expectedAttackSupplyUnitsPerAgent)) ||
        inventorySupplyDrifted ||
        fishingLevel !== expected.fishingLevel ||
        cookingLevel !== expected.cookingLevel ||
        (!AGENT_DUEL_COMBINED_MULTI_STYLE &&
          (contestant.selectedSpell !==
            AGENT_DUEL_ROLE_FIXTURE.selectedSpellId ||
            contestant.initialCombatStyle !== AGENT_DUEL_COMBAT_ROLE ||
            !contestant.availableCombatStyles.includes(
              AGENT_DUEL_COMBAT_ROLE,
            ))) ||
        contestant.preparation.planningSource !== "deterministic"
      ) {
        throw new Error(
          `combined frozen contestant drifted: ${JSON.stringify(contestant)}`,
        );
      }
    }

    const postFreezeCustody = await pool.query<{
      agentId: string;
      inventoryFood: number;
      inventorySlots: number;
      bankedFood: number;
      inventoryPreparationResidue: number;
      bankedPreparationResidue: number;
    }>(
      `SELECT character.id AS "agentId",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = $1), 0)
                AS "inventoryFood",
              COALESCE((SELECT count(*)::int FROM inventory
                         WHERE "playerId" = character.id AND "itemId" = $1), 0)
                AS "inventorySlots",
              COALESCE((SELECT sum(quantity)::int FROM bank_storage
                         WHERE "playerId" = character.id AND "itemId" = $1), 0)
                AS "bankedFood",
              COALESCE((SELECT sum(quantity)::int FROM inventory
                         WHERE "playerId" = character.id
                           AND "itemId" IN ($2, 'burnt_shrimp', 'small_fishing_net')), 0)
                AS "inventoryPreparationResidue",
              COALESCE((SELECT sum(quantity)::int FROM bank_storage
                         WHERE "playerId" = character.id
                           AND "itemId" IN ($2, 'burnt_shrimp', 'small_fishing_net')), 0)
                AS "bankedPreparationResidue"
         FROM characters character
        WHERE character.id = ANY($3::text[])
        ORDER BY character.id`,
      [COOKED_FOOD_ID, RAW_FOOD_ID, AGENT_IDS],
    );
    if (
      postFreezeCustody.rows.length !== 2 ||
      postFreezeCustody.rows.some((row) => {
        const expectedFood = persistedSkills.get(row.agentId)?.inventoryFood;
        const prework = custodyAfterKill.rows.find(
          (entry) => entry.agentId === row.agentId,
        );
        const expectedResidue = prework
          ? prework.rawFood + prework.burntFood + prework.toolCount
          : null;
        return (
          !Number.isSafeInteger(expectedFood) ||
          !Number.isSafeInteger(expectedResidue) ||
          row.inventoryFood !== expectedFood ||
          row.inventorySlots !== expectedFood ||
          row.bankedFood !== 0 ||
          row.inventoryPreparationResidue !== 0 ||
          row.bankedPreparationResidue !== expectedResidue
        );
      })
    ) {
      throw new Error(
        `combined private preparation did not stage exact food: ${JSON.stringify(postFreezeCustody.rows)}`,
      );
    }

    const {
      authoritativeCombatTicks,
      diagnostics,
      antiCheatDiagnostics,
      projectileDiagnostics,
      resolvedCycle,
    } = await driveAuthoritativeCombatToNaturalTerminal(
      runtime,
      scheduler,
      authoritativeCombat,
      {
        combatTimeoutMs: Number(
          process.env.AGENT_PREPARATION_DUEL_COMBAT_TIMEOUT_MS ?? 300_000,
        ),
      },
    );
    const projectileRole = AGENT_DUEL_COMBAT_ROLE !== "melee";
    if (
      diagnostics.length !== 2 ||
      antiCheatDiagnostics.length !== 2 ||
      antiCheatDiagnostics.some(
        ({ score, violationCount }) => score !== 0 || violationCount !== 0,
      ) ||
      resolvedCycle?.phase !== "RESOLUTION" ||
      !resolvedCycle.winnerId ||
      !resolvedCycle.loserId ||
      resolvedCycle.winReason !== "kill" ||
      resolvedCycle.outcome !== "win" ||
      authoritativeCombatTicks < 5 ||
      (projectileRole
        ? projectileDiagnostics.launched < 2 || projectileDiagnostics.hit < 1
        : projectileDiagnostics.launched !== 0 ||
          projectileDiagnostics.hit !== 0) ||
      projectileDiagnostics.active !== 0 ||
      diagnostics.reduce((total, entry) => total + entry.foodUseAttempts, 0) <
        1 ||
      diagnostics.reduce((total, entry) => total + entry.totalDamageDealt, 0) <
        1 ||
      diagnostics.some(
        (entry) =>
          entry.tickCount < 5 ||
          (AGENT_DUEL_COMBINED_MULTI_STYLE
            ? (entry.combatRole !== "melee" &&
                entry.combatRole !== "ranged" &&
                entry.combatRole !== "mage") ||
              entry.successfulRoleSwitches < 1 ||
              entry.roleSwitchAttempts < entry.successfulRoleSwitches ||
              entry.roleSwitchFailures !== 0
            : entry.combatRole !== AGENT_DUEL_COMBAT_ROLE ||
              entry.successfulRoleSwitches !== 0 ||
              entry.roleSwitchAttempts !== 0 ||
              entry.roleSwitchFailures !== 0) ||
          entry.engagementAccepts !== entry.engagementAttempts ||
          entry.engagementRejects !== 0 ||
          entry.engagementErrors !== 0 ||
          entry.styleChangeAccepts !== entry.styleChangeAttempts ||
          entry.styleChangeRejects !== 0 ||
          entry.styleChangeErrors !== 0 ||
          entry.movementAccepts !== entry.movementRequests ||
          entry.movementRejects !== 0 ||
          entry.movementErrors !== 0 ||
          entry.prayerToggleRejects !== 0,
      )
    ) {
      throw new Error(
        `combined combat diagnostics drifted: ${JSON.stringify({ authoritativeCombatTicks, diagnostics, antiCheatDiagnostics, projectileDiagnostics, resolvedCycle })}`,
      );
    }

    const final = await pool.query<{
      gatheringOperations: string;
      processingOperations: string;
      preparationPlans: string;
      ordinaryBankOperations: string;
      privateBankOpens: string;
      privateBankDeposits: string;
      progressionStarts: string;
      progressionTerminals: string;
      openProgressionHeads: string;
      ammunitionShots: string;
      projectileRuneCosts: string;
      resolvedProjectileRuneCosts: string;
      fireRuneCosts: string;
      mindRuneCosts: string;
      damageOperations: string;
      appliedDamageOperations: string;
      zeroDamageProjectileOperations: string;
      invalidZeroDamageOperations: string;
      foodOperations: string;
      damageObservations: string;
      foodObservations: string;
      committedFoodObservations: string;
      deferredFoodObservations: string;
      rejectedFoodObservations: string;
      errorFoodObservations: string;
      invalidFoodObservations: string;
      roleSwitchOperations: string;
      roleSwitchObservations: string;
      committedRoleSwitchObservations: string;
      deferredRoleSwitchObservations: string;
      rejectedRoleSwitchObservations: string;
      errorRoleSwitchObservations: string;
      invalidRoleSwitchObservations: string;
      terminalTransitions: string;
      inventoryFood: string;
      inventoryAmmunition: string;
      equippedAmmunition: string;
      bankedAmmunition: string;
      inventoryFireRunes: string;
      inventoryMindRunes: string;
      bankedFireRunes: string;
      bankedMindRunes: string;
      meleeWeaponCustody: string;
      rangedWeaponCustody: string;
      mageWeaponCustody: string;
      inventoryPreparationResidue: string;
      bankedFood: string;
      bankedPreparationResidue: string;
      snapshotRows: string;
      lifecycleStatus: string;
      cancellationReason: string | null;
      terminalOutcome: string | null;
      terminalWinnerId: string | null;
      terminalWinReason: string | null;
      terminalSeed: string | null;
      terminalReplayHash: string | null;
      terminalAt: string | null;
      preparationId: string;
      snapshotDigest: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'gathering_reward')
           AS "gatheringOperations",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'processing_action')
           AS "processingOperations",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'duel_preparation_plan')
           AS "preparationPlans",
         (SELECT count(*)::text FROM agent_bank_operations
           WHERE "playerId" = ANY($1::text[]) AND "preparationId" IS NULL)
           AS "ordinaryBankOperations",
         (SELECT count(*)::text FROM streaming_duel_bank_open_events
           WHERE "playerId" = ANY($1::text[])) AS "privateBankOpens",
         (SELECT count(*)::text FROM agent_bank_operations
           WHERE "playerId" = ANY($1::text[]) AND "preparationId" IS NOT NULL
             AND action IN ('deposit', 'deposit_all')) AS "privateBankDeposits",
         (SELECT count(*)::text FROM agent_autonomy_progression_events
           WHERE character_id = ANY($1::text[]) AND event_type = 'attempt_started')
           AS "progressionStarts",
         (SELECT count(*)::text FROM agent_autonomy_progression_events
           WHERE character_id = ANY($1::text[]) AND event_type = 'attempt_terminal')
           AS "progressionTerminals",
         (SELECT count(*)::text FROM agent_autonomy_progression_heads
           WHERE character_id = ANY($1::text[]) AND open_attempt_id IS NOT NULL)
           AS "openProgressionHeads",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'ammunition_shot')
           AS "ammunitionShots",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[])
             AND "operationType" = 'projectile_rune_cost')
           AS "projectileRuneCosts",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[])
             AND "operationType" = 'projectile_rune_cost'
             AND completed = true
             AND "operationState"->>'status' = 'resolved')
           AS "resolvedProjectileRuneCosts",
         (SELECT COALESCE(sum((requirement.value->>'quantity')::int), 0)::text
            FROM operations_log cost
            CROSS JOIN LATERAL jsonb_array_elements(
              cost."operationState"->'requirements'
            ) AS requirement(value)
           WHERE cost."playerId" = ANY($1::text[])
             AND cost."operationType" = 'projectile_rune_cost'
             AND requirement.value->>'itemId' = 'fire_rune')
           AS "fireRuneCosts",
         (SELECT COALESCE(sum((requirement.value->>'quantity')::int), 0)::text
            FROM operations_log cost
            CROSS JOIN LATERAL jsonb_array_elements(
              cost."operationState"->'requirements'
            ) AS requirement(value)
           WHERE cost."playerId" = ANY($1::text[])
             AND cost."operationType" = 'projectile_rune_cost'
             AND requirement.value->>'itemId' = 'mind_rune')
           AS "mindRuneCosts",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'duel_damage')
           AS "damageOperations",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'duel_damage'
             AND ("operationState"->>'appliedDamage')::integer > 0)
           AS "appliedDamageOperations",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'duel_damage'
             AND ("operationState"->>'appliedDamage')::integer = 0
             AND "operationState"->'projectileCost' IS NOT NULL)
           AS "zeroDamageProjectileOperations",
         (SELECT count(*)::text FROM operations_log AS damage
           WHERE damage."playerId" = ANY($1::text[])
             AND damage."operationType" = 'duel_damage'
             AND (damage."operationState"->>'appliedDamage')::integer = 0
             AND (
               damage."operationState"->'projectileCost' IS NULL
               OR (damage."operationState"->>'healthBefore')::integer < 0
               OR (damage."operationState"->>'healthBefore')::integer
                    <> (damage."operationState"->>'healthAfter')::integer
               OR damage."operationState"->'competitiveTerminal'
                    IS DISTINCT FROM 'null'::jsonb
               OR damage."operationState"->'xpDamageAuthority'
                    IS DISTINCT FROM 'null'::jsonb
               OR damage."operationState"->'combatProgress'
                    IS DISTINCT FROM '[]'::jsonb
               OR NOT EXISTS (
                 SELECT 1
                   FROM operations_log AS cost
                  WHERE cost.id =
                        damage."operationState"->'projectileCost'->>'operationId'
                    AND cost."playerId" =
                        damage."operationState"->'projectileCost'->>'playerId'
                    AND cost."operationType" =
                        damage."operationState"->'projectileCost'->>'operationType'
                    AND cost.completed = true
                    AND cost."operationState"->>'status' = 'resolved'
                    AND cost."operationState"->>'damageOperationId' = damage.id
                    AND cost."operationState"->>'requestFingerprint' =
                        damage."operationState"->'projectileCost'->>'requestFingerprint'
               )
             )) AS "invalidZeroDamageOperations",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[]) AND "operationType" = 'food_consumption')
           AS "foodOperations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'damage') AS "damageObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'food') AS "foodObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'food'
             AND observation->>'outcome' = 'committed')
           AS "committedFoodObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'food'
             AND observation->>'outcome' = 'deferred')
           AS "deferredFoodObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'food'
             AND observation->>'outcome' = 'rejected')
           AS "rejectedFoodObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'food'
             AND observation->>'outcome' = 'error')
           AS "errorFoodObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'food'
             AND observation->>'outcome' NOT IN (
               'committed', 'deferred', 'rejected', 'error'
             )) AS "invalidFoodObservations",
         (SELECT count(*)::text FROM operations_log
           WHERE "playerId" = ANY($1::text[])
             AND id LIKE ('combat-loadout:' || $5 || ':%')
             AND completed = true) AS "roleSwitchOperations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'role_switch')
           AS "roleSwitchObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'role_switch'
             AND observation->>'outcome' = 'committed')
           AS "committedRoleSwitchObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'role_switch'
             AND observation->>'outcome' = 'deferred')
           AS "deferredRoleSwitchObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'role_switch'
             AND observation->>'outcome' = 'rejected')
           AS "rejectedRoleSwitchObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'role_switch'
             AND observation->>'outcome' = 'error')
           AS "errorRoleSwitchObservations",
         (SELECT count(*)::text FROM streaming_duel_action_observations
           WHERE "cycleId" = $5 AND action = 'role_switch'
             AND observation->>'outcome' NOT IN (
               'committed', 'deferred', 'rejected', 'error'
             )) AS "invalidRoleSwitchObservations",
         (SELECT count(*)::text FROM streaming_duel_transition_events
           WHERE "cycleId" = $5 AND "eventType" = 'terminal_committed')
           AS "terminalTransitions",
         (SELECT COALESCE(sum(quantity), 0)::text FROM inventory
           WHERE "playerId" = ANY($1::text[]) AND "itemId" = $2)
           AS "inventoryFood",
         (SELECT COALESCE(sum(quantity), 0)::text FROM inventory
           WHERE "playerId" = ANY($1::text[]) AND "itemId" = 'bronze_arrow')
           AS "inventoryAmmunition",
         (SELECT COALESCE(sum(quantity), 0)::text FROM equipment
           WHERE "playerId" = ANY($1::text[]) AND "slotType" = 'arrows'
             AND "itemId" = 'bronze_arrow') AS "equippedAmmunition",
         (SELECT COALESCE(sum(quantity), 0)::text FROM bank_storage
           WHERE "playerId" = ANY($1::text[]) AND "itemId" = 'bronze_arrow')
           AS "bankedAmmunition",
         (SELECT COALESCE(sum(quantity), 0)::text FROM inventory
           WHERE "playerId" = ANY($1::text[]) AND "itemId" = 'fire_rune')
           AS "inventoryFireRunes",
         (SELECT COALESCE(sum(quantity), 0)::text FROM inventory
           WHERE "playerId" = ANY($1::text[]) AND "itemId" = 'mind_rune')
           AS "inventoryMindRunes",
         (SELECT COALESCE(sum(quantity), 0)::text FROM bank_storage
           WHERE "playerId" = ANY($1::text[]) AND "itemId" = 'fire_rune')
           AS "bankedFireRunes",
         (SELECT COALESCE(sum(quantity), 0)::text FROM bank_storage
           WHERE "playerId" = ANY($1::text[]) AND "itemId" = 'mind_rune')
           AS "bankedMindRunes",
         (SELECT COALESCE(sum(quantity), 0)::text
            FROM (
              SELECT "itemId", quantity FROM equipment
               WHERE "playerId" = ANY($1::text[])
              UNION ALL
              SELECT "itemId", quantity FROM inventory
               WHERE "playerId" = ANY($1::text[])
              UNION ALL
              SELECT "itemId", quantity FROM bank_storage
               WHERE "playerId" = ANY($1::text[])
            ) AS custody
           WHERE custody."itemId" = 'bronze_longsword')
           AS "meleeWeaponCustody",
         (SELECT COALESCE(sum(quantity), 0)::text
            FROM (
              SELECT "itemId", quantity FROM equipment
               WHERE "playerId" = ANY($1::text[])
              UNION ALL
              SELECT "itemId", quantity FROM inventory
               WHERE "playerId" = ANY($1::text[])
              UNION ALL
              SELECT "itemId", quantity FROM bank_storage
               WHERE "playerId" = ANY($1::text[])
            ) AS custody
           WHERE custody."itemId" = 'shortbow')
           AS "rangedWeaponCustody",
         (SELECT COALESCE(sum(quantity), 0)::text
            FROM (
              SELECT "itemId", quantity FROM equipment
               WHERE "playerId" = ANY($1::text[])
              UNION ALL
              SELECT "itemId", quantity FROM inventory
               WHERE "playerId" = ANY($1::text[])
              UNION ALL
              SELECT "itemId", quantity FROM bank_storage
               WHERE "playerId" = ANY($1::text[])
            ) AS custody
           WHERE custody."itemId" = 'staff_of_air')
           AS "mageWeaponCustody",
         (SELECT COALESCE(sum(quantity), 0)::text FROM inventory
           WHERE "playerId" = ANY($1::text[])
             AND "itemId" IN ($3, $4, 'burnt_shrimp', 'small_fishing_net'))
           AS "inventoryPreparationResidue",
         (SELECT COALESCE(sum(quantity), 0)::text FROM bank_storage
           WHERE "playerId" = ANY($1::text[]) AND "itemId" = $2)
           AS "bankedFood",
         (SELECT COALESCE(sum(quantity), 0)::text FROM bank_storage
           WHERE "playerId" = ANY($1::text[])
             AND "itemId" IN ($3, 'burnt_shrimp', 'small_fishing_net'))
           AS "bankedPreparationResidue",
         (SELECT count(*)::text FROM streaming_duel_competitive_snapshots
           WHERE "cycleId" = $5) AS "snapshotRows",
         snapshot."lifecycleStatus" AS "lifecycleStatus",
         snapshot."terminalCancellationReason" AS "cancellationReason",
         snapshot."terminalOutcome" AS "terminalOutcome",
         snapshot."terminalWinnerId" AS "terminalWinnerId",
         snapshot."terminalWinReason" AS "terminalWinReason",
         snapshot."terminalSeed" AS "terminalSeed",
         snapshot."terminalReplayHash" AS "terminalReplayHash",
         snapshot."terminalAt"::text AS "terminalAt",
         snapshot."preparationId" AS "preparationId",
         snapshot."snapshotDigest" AS "snapshotDigest"
       FROM streaming_duel_competitive_snapshots snapshot
      WHERE snapshot."cycleId" = $5`,
      [
        AGENT_IDS,
        COOKED_FOOD_ID,
        RAW_FOOD_ID,
        LEGACY_FIXTURE_FOOD_ID,
        cycle.cycleId,
      ],
    );
    const row = final.rows[0];
    const expectedProgressionEdges = String(
      preworkEvidence.agents.reduce(
        (total, agent) => total + agent.progressionStarts,
        0,
      ),
    );
    const expectedFrozenFood = preworkEvidence.agents.reduce(
      (total, agent) => total + agent.inventoryFood,
      0,
    );
    const expectedFrozenAmmunition = snapshot.contestants.reduce(
      (total, contestant) =>
        total +
        (contestant.equipment.find((item) => item.slot === "arrows")
          ?.quantity ?? 0),
      0,
    );
    const expectedFrozenFireRunes = snapshot.contestants.reduce(
      (total, contestant) =>
        total +
        contestant.inventory
          .filter((item) => item.itemId === "fire_rune")
          .reduce((quantity, item) => quantity + item.quantity, 0),
      0,
    );
    const expectedFrozenMindRunes = snapshot.contestants.reduce(
      (total, contestant) =>
        total +
        contestant.inventory
          .filter((item) => item.itemId === "mind_rune")
          .reduce((quantity, item) => quantity + item.quantity, 0),
      0,
    );
    const ammunitionShots = Number(row?.ammunitionShots);
    const projectileRuneCosts = Number(row?.projectileRuneCosts);
    const resolvedProjectileRuneCosts = Number(
      row?.resolvedProjectileRuneCosts,
    );
    const fireRuneCosts = Number(row?.fireRuneCosts);
    const mindRuneCosts = Number(row?.mindRuneCosts);
    const damageOperations = Number(row?.damageOperations);
    const appliedDamageOperations = Number(row?.appliedDamageOperations);
    const zeroDamageProjectileOperations = Number(
      row?.zeroDamageProjectileOperations,
    );
    const invalidZeroDamageOperations = Number(
      row?.invalidZeroDamageOperations,
    );
    const foodOperations = Number(row?.foodOperations);
    const foodDisengageYields = diagnostics.reduce(
      (total, entry) => total + entry.foodDisengageYields,
      0,
    );
    const successfulRoleSwitches = diagnostics.reduce(
      (total, entry) => total + entry.successfulRoleSwitches,
      0,
    );
    const roleSwitchDeferrals = diagnostics.reduce(
      (total, entry) => total + entry.roleSwitchDeferrals,
      0,
    );
    const expectedPreparationResidue = custodyAfterKill.rows.reduce(
      (total, agent) =>
        total + agent.rawFood + agent.burntFood + agent.toolCount,
      0,
    );
    const expectedInitialFireRunes =
      AGENT_IDS.length * (initialInventorySupplyByItem.get("fire_rune") ?? 0);
    const expectedInitialMindRunes =
      AGENT_IDS.length * (initialInventorySupplyByItem.get("mind_rune") ?? 0);
    const expectedInitialAmmunition =
      AGENT_IDS.length * initialAmmunitionPerAgent;
    const expectedFireRunesPerProjectile =
      projectileCostByItem.get("fire_rune") ?? 0;
    const expectedMindRunesPerProjectile =
      projectileCostByItem.get("mind_rune") ?? 0;
    if (
      final.rows.length !== 1 ||
      row?.gatheringOperations !==
        String(preworkEvidence.gatheringOperations) ||
      row.processingOperations !==
        String(preworkEvidence.processingOperations) ||
      row.preparationPlans !== "2" ||
      row.ordinaryBankOperations !==
        String(preworkEvidence.ordinaryBankOperations) ||
      row.privateBankOpens !== "2" ||
      row.privateBankDeposits !== "0" ||
      row.progressionStarts !== expectedProgressionEdges ||
      row.progressionTerminals !== expectedProgressionEdges ||
      row.openProgressionHeads !== "0" ||
      !Number.isSafeInteger(ammunitionShots) ||
      (AGENT_DUEL_COMBINED_MULTI_STYLE
        ? ammunitionShots < 1
        : AGENT_DUEL_COMBAT_ROLE === "ranged"
          ? ammunitionShots < 2
          : ammunitionShots !== 0) ||
      !Number.isSafeInteger(projectileRuneCosts) ||
      (AGENT_DUEL_COMBINED_MULTI_STYLE
        ? projectileRuneCosts < 1
        : AGENT_DUEL_COMBAT_ROLE === "mage"
          ? projectileRuneCosts < 2
          : projectileRuneCosts !== 0) ||
      resolvedProjectileRuneCosts !== projectileRuneCosts ||
      fireRuneCosts !== projectileRuneCosts * expectedFireRunesPerProjectile ||
      mindRuneCosts !== projectileRuneCosts * expectedMindRunesPerProjectile ||
      !Number.isSafeInteger(damageOperations) ||
      damageOperations < 1 ||
      !Number.isSafeInteger(appliedDamageOperations) ||
      appliedDamageOperations < 1 ||
      !Number.isSafeInteger(zeroDamageProjectileOperations) ||
      zeroDamageProjectileOperations < 0 ||
      damageOperations !==
        appliedDamageOperations + zeroDamageProjectileOperations ||
      invalidZeroDamageOperations !== 0 ||
      !Number.isSafeInteger(foodOperations) ||
      foodOperations < 1 ||
      Number(row.damageObservations) !== appliedDamageOperations ||
      row.committedFoodObservations !== row.foodOperations ||
      Number(row.deferredFoodObservations) !== foodDisengageYields ||
      row.rejectedFoodObservations !== "0" ||
      row.errorFoodObservations !== "0" ||
      row.invalidFoodObservations !== "0" ||
      Number(row.foodObservations) !== foodOperations + foodDisengageYields ||
      (AGENT_DUEL_COMBINED_MULTI_STYLE
        ? successfulRoleSwitches < 2 ||
          Number(row.roleSwitchOperations) !== successfulRoleSwitches ||
          Number(row.committedRoleSwitchObservations) !==
            successfulRoleSwitches ||
          Number(row.deferredRoleSwitchObservations) !== roleSwitchDeferrals ||
          Number(row.roleSwitchObservations) !==
            successfulRoleSwitches + roleSwitchDeferrals
        : row.roleSwitchOperations !== "0" ||
          row.roleSwitchObservations !== "0" ||
          successfulRoleSwitches !== 0 ||
          roleSwitchDeferrals !== 0) ||
      row.rejectedRoleSwitchObservations !== "0" ||
      row.errorRoleSwitchObservations !== "0" ||
      row.invalidRoleSwitchObservations !== "0" ||
      row.terminalTransitions !== "1" ||
      row.inventoryFood !== String(expectedFrozenFood - foodOperations) ||
      (AGENT_DUEL_COMBINED_MULTI_STYLE
        ? Number(row.inventoryAmmunition) + Number(row.equippedAmmunition) !==
          expectedFrozenAmmunition - ammunitionShots
        : row.inventoryAmmunition !== "0" ||
          row.equippedAmmunition !==
            String(expectedFrozenAmmunition - ammunitionShots)) ||
      row.bankedAmmunition !==
        String(expectedInitialAmmunition - expectedFrozenAmmunition) ||
      row.inventoryFireRunes !==
        String(expectedFrozenFireRunes - fireRuneCosts) ||
      row.inventoryMindRunes !==
        String(expectedFrozenMindRunes - mindRuneCosts) ||
      row.bankedFireRunes !==
        String(expectedInitialFireRunes - expectedFrozenFireRunes) ||
      row.bankedMindRunes !==
        String(expectedInitialMindRunes - expectedFrozenMindRunes) ||
      (AGENT_DUEL_COMBINED_MULTI_STYLE &&
        (row.meleeWeaponCustody !== String(AGENT_IDS.length) ||
          row.rangedWeaponCustody !== String(AGENT_IDS.length) ||
          row.mageWeaponCustody !== String(AGENT_IDS.length))) ||
      row.inventoryPreparationResidue !== "0" ||
      row.bankedFood !== "0" ||
      row.bankedPreparationResidue !== String(expectedPreparationResidue) ||
      row.snapshotRows !== "1" ||
      row.lifecycleStatus !== "terminal" ||
      row.cancellationReason !== null ||
      row.terminalOutcome !== "win" ||
      row.terminalWinnerId !== resolvedCycle.winnerId ||
      row.terminalWinReason !== "kill" ||
      !row.terminalSeed ||
      !/^(0|[1-9][0-9]{0,19})$/.test(row.terminalSeed) ||
      !row.terminalReplayHash ||
      !/^[0-9a-f]{64}$/.test(row.terminalReplayHash) ||
      !row.terminalAt ||
      row.preparationId !== snapshot.preparationId ||
      row.snapshotDigest !== cycle.competitiveSnapshotDigest
    ) {
      throw new Error(
        `combined final evidence drifted: ${JSON.stringify(row)}`,
      );
    }

    const combinedReport = {
      schemaVersion: 3,
      status: "passed",
      generatedAt: new Date().toISOString(),
      scenario: combinedScenario,
      multiStyle: AGENT_DUEL_COMBINED_MULTI_STYLE,
      manifest: {
        fishingSpotId: truth.fishingSpot.id,
        rawFoodId: RAW_FOOD_ID,
        cookedFoodId: COOKED_FOOD_ID,
        fishingXpPerCatch: truth.fishingYield.xpAmount,
        cookingXpPerAction: truth.cookingRecipe.xp,
        cookingTicks: truth.cookingRecipe.ticks,
      },
      agents: preworkEvidence.agents,
      preworkWorkerPids: prework.map((worker) => worker.child.pid),
      preworkWorkersKilled: prework.every(
        (worker) => worker.child.signalCode === "SIGKILL",
      ),
      preworkSignals: prework.map((worker) => worker.child.signalCode),
      livePreparationReports: prework.map((worker) => worker.reportPath),
      samePersistentAgentIds: [...AGENT_IDS],
      authoredGatheringOperations: Number(row.gatheringOperations),
      authoredProcessingOperations: Number(row.processingOperations),
      ordinaryBankOperations: Number(row.ordinaryBankOperations),
      privatePreparationBankOpens: Number(row.privateBankOpens),
      standalonePrivatePreparationBankDeposits: Number(row.privateBankDeposits),
      atomicPrivatePreparationPlans: Number(row.preparationPlans),
      exactFrozenFoodByAgent: Object.fromEntries(
        preworkEvidence.agents.map((agent) => [
          agent.agentId,
          agent.inventoryFood,
        ]),
      ),
      exactBankedPreparationResidue: expectedPreparationResidue,
      competitiveSnapshotPersisted: true,
      competitiveSnapshotDiagnostic: false,
      competitiveSnapshotDigest: cycle.competitiveSnapshotDigest,
      duelId: cycle.duelId,
      lifecycleStatus: row.lifecycleStatus,
      cancellationReason: row.cancellationReason,
      terminalOutcome: row.terminalOutcome,
      terminalWinnerId: row.terminalWinnerId,
      terminalLoserId: resolvedCycle.loserId,
      terminalWinReason: row.terminalWinReason,
      terminalSeed: row.terminalSeed,
      terminalReplayHash: row.terminalReplayHash,
      terminalAt: Number(row.terminalAt),
      combatRole: AGENT_DUEL_COMBAT_ROLE,
      frozenOpeningCombatRoles: Object.fromEntries(
        snapshot.contestants.map((contestant) => [
          contestant.agentId,
          contestant.initialCombatStyle,
        ]),
      ),
      frozenAvailableCombatStyles: Object.fromEntries(
        snapshot.contestants.map((contestant) => [
          contestant.agentId,
          contestant.availableCombatStyles,
        ]),
      ),
      frozenCombatLoadouts: Object.fromEntries(
        snapshot.contestants.map((contestant) => [
          contestant.agentId,
          contestant.combatLoadouts,
        ]),
      ),
      weaponId: AGENT_DUEL_ROLE_FIXTURE.weaponId,
      selectedSpellId: AGENT_DUEL_ROLE_FIXTURE.selectedSpellId,
      fullDurationAttackSupplyTarget,
      fullDurationAttackSupplyTargets,
      frozenAttackSupplyUnitsPerAgent: expectedAttackSupplyUnitsPerAgent,
      authoritativeCombatTicks,
      authoritativeTickDurationMs: COMBAT_CONSTANTS.TICK_DURATION_MS,
      ammunitionShots,
      inventoryAmmunitionRemaining: Number(row.inventoryAmmunition),
      equippedAmmunitionRemaining: Number(row.equippedAmmunition),
      bankedAmmunition: Number(row.bankedAmmunition),
      projectileRuneCosts,
      projectileRuneInventoryDebits: {
        fireRune: fireRuneCosts,
        mindRune: mindRuneCosts,
      },
      inventorySuppliesRemaining: {
        fireRune: Number(row.inventoryFireRunes),
        mindRune: Number(row.inventoryMindRunes),
      },
      bankedSupplies: {
        fireRune: Number(row.bankedFireRunes),
        mindRune: Number(row.bankedMindRunes),
      },
      damageOperations,
      appliedDamageOperations,
      zeroDamageProjectileOperations,
      damageObservations: Number(row.damageObservations),
      foodOperations,
      foodObservations: Number(row.foodObservations),
      committedFoodObservations: Number(row.committedFoodObservations),
      deferredFoodObservations: Number(row.deferredFoodObservations),
      rejectedFoodObservations: Number(row.rejectedFoodObservations),
      errorFoodObservations: Number(row.errorFoodObservations),
      invalidFoodObservations: Number(row.invalidFoodObservations),
      successfulRoleSwitches,
      roleSwitchDeferrals,
      roleSwitchOperations: Number(row.roleSwitchOperations),
      roleSwitchObservations: Number(row.roleSwitchObservations),
      committedRoleSwitchObservations: Number(
        row.committedRoleSwitchObservations,
      ),
      deferredRoleSwitchObservations: Number(
        row.deferredRoleSwitchObservations,
      ),
      rejectedRoleSwitchObservations: Number(
        row.rejectedRoleSwitchObservations,
      ),
      errorRoleSwitchObservations: Number(row.errorRoleSwitchObservations),
      weaponCustody: {
        melee: Number(row.meleeWeaponCustody),
        ranged: Number(row.rangedWeaponCustody),
        mage: Number(row.mageWeaponCustody),
      },
      inventoryFoodRemaining: Number(row.inventoryFood),
      combatDiagnostics: diagnostics,
      antiCheatDiagnostics,
      projectileDiagnostics,
      processDeathRecoveryCovered: true,
      scriptedCustodyBridgeCovered: false,
      ordinaryAutonomySelectionCovered: true,
      liveWorldNavigationCovered: true,
      livePreparationPresentationCovered: true,
      liveAuthoritativeCombatCovered: true,
      liveProjectileCustodyCovered: projectileRole,
      liveAmmunitionCustodyCovered:
        AGENT_DUEL_COMBINED_MULTI_STYLE || AGENT_DUEL_COMBAT_ROLE === "ranged",
      liveRuneCustodyCovered:
        AGENT_DUEL_COMBINED_MULTI_STYLE || AGENT_DUEL_COMBAT_ROLE === "mage",
      liveOwnedMultiStyleSwitchingCovered: AGENT_DUEL_COMBINED_MULTI_STYLE,
      liveDamageCustodyCovered: true,
      liveFoodConsumptionCovered: true,
      persistedKillTerminalCovered: true,
      externalModelProviderCovered: false,
      publicStreamCovered: false,
      hyperbetSolCovered: false,
      launchDurationSoakCovered: false,
    } as const;
    await mkdir(combinedEvidenceDirectory, { recursive: true });
    await writeFile(
      combinedReportPath,
      `${JSON.stringify(combinedReport, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ...combinedReport, report: combinedReportPath })}\n`,
    );
  } finally {
    if (scheduler) {
      scheduler.destroy("scheduler_shutdown");
      await scheduler.waitForShutdownCleanup().catch(() => undefined);
    }
    authoritativeCombat?.destroy();
    if (runtime) await stopWorkerRuntime(runtime).catch(() => undefined);
    for (const worker of prework) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill("SIGKILL");
        await waitForExit(worker.child, worker.stderr).catch(() => undefined);
      }
    }
    for (const event of preworkEvents) {
      if (event.workspacePath) {
        await rm(event.workspacePath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
    await pool?.end().catch(() => undefined);
    if (containerStarted) {
      await docker(["stop", "--time", "1", containerName]).catch(
        () => undefined,
      );
    }
    ITEMS.delete(RAW_FOOD_ID);
    ITEMS.delete(COOKED_FOOD_ID);
    ITEMS.delete("burnt_shrimp");
    ITEMS.delete("small_fishing_net");
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(scriptPath);

if (isDirectExecution) {
  try {
    if (process.argv.includes("--prework")) {
      await runPreworkWorker();
    } else if (process.argv.includes("--prepare-existing-database")) {
      await runExistingDatabasePreparation();
    } else {
      await runParent();
    }
  } catch (error) {
    if (process.argv.includes("--prework")) {
      process.stdout.write(
        `${JSON.stringify({
          event: "error",
          message: error instanceof Error ? error.message : String(error),
        } satisfies PreworkEvent)}\n`,
      );
    }
    throw error;
  }
}
