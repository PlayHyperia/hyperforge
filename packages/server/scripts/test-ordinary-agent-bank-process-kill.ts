import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { EntityOccupancyMap, ITEMS } from "@hyperforge/shared";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import { executeAuthoritativeAgentBankTransfer } from "../src/eliza/AuthoritativeAgentBanking.js";
import {
  beginAgentAutonomyProgressionAttempt,
  recoverOpenAgentAutonomyProgressionAttempt,
} from "../src/eliza/agentAutonomyProgression.js";
import type { AgentInstance } from "../src/eliza/managers/AgentBehaviorTicker.js";
import {
  getOrdinaryBankOperationId,
  getOrdinaryBankStageOperationId,
  resolveOrdinaryBankingRecovery,
} from "../src/eliza/ordinaryAgentBanking.js";
import { AgentBehaviorBridge } from "../src/eliza/managers/AgentBehaviorBridge.js";
import { TileMovementManager } from "../src/systems/ServerNetwork/tile-movement.js";
import {
  initializeItems,
  processAgentTicks,
} from "../src/eliza/worker/AgentBehaviorEngine.js";
import type {
  AgentTickInput,
  AgentTickOutput,
} from "../src/eliza/worker/workerTypes.js";

const ATTEMPT_ID = "6de83f0c-52dd-4496-b234-d679a76152ad";
const WITHDRAW_ATTEMPT_ID = "e2e81860-e084-4a56-a9df-d3bd368593a4";
const COMPOSITE_ATTEMPT_ID = "0fc0bd47-66e2-4c5f-a414-b9f6f0f779a2";
const CHARACTER_ID = "ordinary-bank-process-kill-agent";
const ACCOUNT_ID = "ordinary-bank-process-kill-account";
const TOOL_ID = "ordinary_bank_process_tool";
const RESOURCE_ID = "ordinary_bank_process_resource";
const FOOD_ID = "ordinary_bank_process_food";
const FILLER_ID = "ordinary_bank_process_filler";
const RESOURCE_VARIANT_ID = "ordinary_bank_process_node";
const COMPOSITE_ITEM_A = "ordinary_bank_process_composite_a";
const COMPOSITE_ITEM_B = "ordinary_bank_process_composite_b";

function makeInstance(): AgentInstance {
  return {
    config: {
      characterId: CHARACTER_ID,
      accountId: ACCOUNT_ID,
      name: "Ordinary Bank Process Kill Agent",
    },
    goal: { type: "banking", description: "Bank verified surplus" },
    memories: [],
    recentActionLog: [],
    tickCounter: 0,
    pendingLlmResult: undefined,
  } as unknown as AgentInstance;
}

function registerItems(): void {
  ITEMS.set(TOOL_ID, {
    id: TOOL_ID,
    name: "Process Tool",
    type: "tool",
    stackable: false,
  } as never);
  ITEMS.set(RESOURCE_ID, {
    id: RESOURCE_ID,
    name: "Process Resource",
    type: "resource",
    stackable: true,
  } as never);
  ITEMS.set(FOOD_ID, {
    id: FOOD_ID,
    name: "Process Food",
    type: "consumable",
    healAmount: 40,
    stackable: false,
  } as never);
  ITEMS.set(FILLER_ID, {
    id: FILLER_ID,
    name: "Process Filler",
    type: "resource",
    stackable: false,
  } as never);
  ITEMS.set(COMPOSITE_ITEM_A, {
    id: COMPOSITE_ITEM_A,
    name: "Process Composite A",
    type: "resource",
    stackable: false,
  } as never);
  ITEMS.set(COMPOSITE_ITEM_B, {
    id: COMPOSITE_ITEM_B,
    name: "Process Composite B",
    type: "resource",
    stackable: true,
  } as never);
}

function fullQuestInventoryItems() {
  return [
    { slot: 0, itemId: TOOL_ID, quantity: 1 },
    { slot: 1, itemId: RESOURCE_ID, quantity: 7 },
    { slot: 2, itemId: FOOD_ID, quantity: 1 },
    ...Array.from({ length: 21 }, (_, index) => ({
      slot: index + 3,
      itemId: FILLER_ID,
      quantity: 1,
    })),
  ];
}

function fullInventoryQuestState() {
  return [
    {
      questId: "full-inventory-gather",
      name: "Full inventory gather",
      status: "in_progress" as const,
      currentStage: "gather",
      stageDescription: "Gather another resource",
      stageProgress: {},
      stageType: "gather",
      stageTarget: RESOURCE_ID,
      stageCount: 1,
      startNpc: "miner",
    },
  ];
}

function proveFullQuestInventoryRoutesThroughBank(): {
  travelling: AgentTickOutput;
  arrived: AgentTickOutput;
} {
  initializeItems(
    [TOOL_ID, RESOURCE_ID, FOOD_ID, FILLER_ID].map((itemId) => [
      itemId,
      ITEMS.get(itemId)!,
    ]),
    {
      stores: [],
      gathering: [
        {
          resourceId: RESOURCE_VARIANT_ID,
          harvestSkill: "mining",
          toolRequired: TOOL_ID,
          levelRequired: 1,
          outputItemIds: [RESOURCE_ID],
        },
      ],
      firemaking: [],
      crafting: [],
      tanning: [],
      fletching: [],
      runecrafting: [],
    },
  );
  const inventoryItems = fullQuestInventoryItems();
  const input = {
    characterId: CHARACTER_ID,
    combatSpecialization: "melee",
    behaviorEpoch: 0,
    playerId: CHARACTER_ID,
    name: "Ordinary Bank Process Kill Agent",
    gameState: {
      playerId: CHARACTER_ID,
      position: [0.5, 0, 0.5],
      health: 40,
      maxHealth: 40,
      alive: true,
      skills: { mining: { level: 1, xp: 0 } },
      inventory: [],
      equipment: {},
      nearbyEntities: [
        {
          id: "blocked-resource",
          name: "Blocked resource",
          type: "resource",
          resourceId: RESOURCE_VARIANT_ID,
          resourceType: "mining_rock",
          position: [2, 0, 0],
          distance: 2,
        },
      ],
      inCombat: false,
      currentTarget: null,
      selectedSpell: null,
      activePrayers: [],
    },
    inventoryItems,
    equippedItems: { weapon: TOOL_ID },
    questState: fullInventoryQuestState(),
    availableQuests: [],
    storeRetryAfter: 0,
    coinRecoveryAuthorized: false,
    attackObservationRetryAfter: 0,
    bankStageRetryAfter: 0,
    questEntryAcquisitionQuestId: null,
    ordinaryProcessingAcquisitionAuthorized: false,
    survivalFoodAcquisitionAuthorized: false,
    ordinaryProcessingRetrySuppressions: [],
    agentState: {
      goal: null,
      questsAccepted: [],
      currentTargetId: null,
      lastAteAt: 0,
      dropCooldownUntil: 0,
      lastGatherTargetId: null,
      lastGatherQueuedAt: 0,
      pendingChatReaction: null,
      lastCombatChatAt: 0,
    },
    npcPositions: [],
    otherAgentTargets: [],
    resourceSystemAvailable: true,
    spawnAnchors: [{ position: [0, 0, 0], name: "spawn" }],
    worldResources: [],
    worldMobs: [],
    stationPositions: [
      {
        entityId: "bank-1",
        name: "Process bank",
        stationType: "bank",
        position: [12, 0, 8],
        interactionRange: 2,
      },
    ],
    storePositions: [],
  } satisfies AgentTickInput;
  const travellingResult = processAgentTicks([input])[0];
  const travelling = travellingResult?.action;
  if (
    travelling?.type !== "move" ||
    travelling.runMode !== true ||
    travelling.target[0] !== 11.5 ||
    travelling.target[2] !== 8.5 ||
    travelling.target[0] === input.gameState.position[0] ||
    travelling.target[2] === input.gameState.position[2]
  ) {
    throw new Error(
      `full quest inventory did not route diagonally to bank: ${JSON.stringify(travelling)}`,
    );
  }
  input.gameState.position = [11.5, 0, 8.5];
  const arrivedResult = processAgentTicks([input])[0];
  const arrived = arrivedResult?.action;
  if (arrived?.type !== "bankDepositAll" || arrived.bankId !== "bank-1") {
    throw new Error(
      `full quest inventory did not select bank deposit: ${JSON.stringify(arrived)}`,
    );
  }
  return { travelling: travellingResult!, arrived: arrivedResult! };
}

async function runWriter(
  connectionString: string,
  mode: "deposit" | "withdraw" | "composite",
): Promise<never> {
  registerItems();
  const plannedRoute =
    mode === "deposit" ? proveFullQuestInventoryRoutesThroughBank() : null;
  const pool = new pg.Pool({ connectionString, max: 4 });
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
        [CHARACTER_ID],
      );
    },
  };
  const startsAtBank = mode !== "deposit";
  const initialPosition: [number, number, number] = startsAtBank
    ? [11.5, 0, 8.5]
    : [0.5, 0, 0.5];
  const playerData: Record<string, unknown> = {
    position: initialPosition,
    quaternion: [0, 0, 0, 1],
    inStreamingDuel: false,
    isEmbeddedAgent: true,
  };
  const playerPosition = {
    x: initialPosition[0],
    y: initialPosition[1],
    z: initialPosition[2],
    set(x: number, y: number, z: number): void {
      this.x = x;
      this.y = y;
      this.z = z;
      playerData.position = [x, y, z];
    },
  };
  const entities = new Map<string, unknown>([
    [
      CHARACTER_ID,
      {
        id: CHARACTER_ID,
        position: playerPosition,
        data: playerData,
        node: { quaternion: { copy: () => undefined } },
      },
    ],
    ["bank-1", { position: { x: 12, y: 0, z: 8 }, data: { type: "bank" } }],
  ]);
  const blockedTiles = new Set(["1,1", "2,2", "3,3"]);
  const world = {
    pgPool: pool,
    entities,
    entityOccupancy: new EntityOccupancyMap(),
    collision: {
      hasFlags: (x: number, z: number) => blockedTiles.has(`${x},${z}`),
      isBlocked: (_fromX: number, _fromZ: number, toX: number, toZ: number) =>
        blockedTiles.has(`${toX},${toZ}`),
    },
    emit: () => undefined,
    faceDirectionManager: { markPlayerMoved: () => undefined },
    getSystem: (name: string) =>
      name === "inventory" ? inventorySystem : null,
  };

  if (mode === "deposit") {
    if (!plannedRoute) throw new Error("planned bank route missing");
    if (plannedRoute.travelling.action.type !== "move") {
      throw new Error("planned bank movement missing");
    }
    const movementSamples: Array<{ x: number; z: number }> = [
      { x: playerPosition.x, z: playerPosition.z },
    ];
    const movement = new TileMovementManager(world as never, () => undefined);
    movement.syncPlayerPosition(CHARACTER_ID, playerPosition);
    movement.movePlayerToward(
      CHARACTER_ID,
      {
        x: plannedRoute.travelling.action.target[0],
        y: plannedRoute.travelling.action.target[1],
        z: plannedRoute.travelling.action.target[2],
      },
      plannedRoute.travelling.action.runMode,
      0,
    );
    for (let tick = 1; tick <= 32; tick += 1) {
      movement.onTick(tick);
      movementSamples.push({ x: playerPosition.x, z: playerPosition.z });
      const current = movement.getCurrentTile(CHARACTER_ID);
      if (current?.x === 11 && current.z === 8) break;
    }
    const finalTile = movement.getCurrentTile(CHARACTER_ID);
    const usedDiagonalStep = movementSamples.some((sample, index) => {
      if (index === 0) return false;
      const previous = movementSamples[index - 1]!;
      return sample.x !== previous.x && sample.z !== previous.z;
    });
    const enteredBlockedTile = movementSamples.some((sample) =>
      blockedTiles.has(`${Math.floor(sample.x)},${Math.floor(sample.z)}`),
    );
    if (
      finalTile?.x !== 11 ||
      finalTile.z !== 8 ||
      playerPosition.x !== 11.5 ||
      playerPosition.z !== 8.5 ||
      !usedDiagonalStep ||
      enteredBlockedTile
    ) {
      throw new Error(
        `production tile movement did not reach the bank diagonally: ${JSON.stringify({ finalTile, playerPosition, movementSamples })}`,
      );
    }
    const inventory = fullQuestInventoryItems();
    const instance = {
      ...makeInstance(),
      config: {
        characterId: CHARACTER_ID,
        accountId: ACCOUNT_ID,
        name: "Ordinary Bank Process Kill Agent",
        scriptedRole: "gatherer",
        enableLlm: false,
      },
      service: {
        getGameState: () => ({
          playerId: CHARACTER_ID,
          position: [11.5, 0, 8.5],
          health: 40,
          maxHealth: 40,
          alive: true,
          skills: { mining: { level: 1, xp: 0 } },
          inventory,
          equipment: {},
          nearbyEntities: [],
          inCombat: false,
          currentTarget: null,
          selectedSpell: null,
          activePrayers: [],
        }),
        getQuestState: () => fullInventoryQuestState(),
        getAvailableQuests: () => [],
        executeBankDepositAll: (
          operationId: string,
          retainedItems: Array<{ itemId: string; quantity: number }>,
          bankId: string,
        ) =>
          executeAuthoritativeAgentBankTransfer({
            world: world as never,
            playerId: CHARACTER_ID,
            bankId,
            action: "deposit_all",
            operationId,
            retainedItems,
          }),
      },
      state: "running",
      ordinaryProcessingAcquisition: null,
      navigationTarget: null,
      pendingLlmResult: undefined,
      llmCallInFlight: false,
      behaviorEpoch: 0,
      questsAccepted: new Set<string>(),
      currentTargetId: null,
      lastCombatChatAt: 0,
      pendingChatReaction: null,
      ordinaryProcessingRetries: [],
      operatorCommandAt: 0,
      questCompleteFailures: new Map<string, number>(),
    } as unknown as AgentInstance;
    const bridge = new AgentBehaviorBridge(
      world as never,
      (characterId) => (characterId === CHARACTER_ID ? instance : undefined),
      () => [CHARACTER_ID],
      async (_current, result, attempt) => {
        if (
          result.outcome !== "completed" ||
          result.appliedActionType !== "bankDepositAll" ||
          attempt?.attemptId !== ATTEMPT_ID
        ) {
          throw new Error(
            `bridge deposit result mismatch: ${JSON.stringify({ result, attempt })}`,
          );
        }
        process.stdout.write(
          "WORKER_BRIDGE_BANK_RECEIPT_AND_CUSTODY_COMMITTED\n",
        );
        await new Promise<never>(() => {});
      },
      (_current, actionType, decisionSource) =>
        beginAgentAutonomyProgressionAttempt(pool, {
          attemptId: ATTEMPT_ID,
          characterId: CHARACTER_ID,
          goalType: null,
          actionType,
          decisionSource,
          startedAt: 10_000,
        }),
    );
    await (
      bridge as unknown as {
        applyTickResult(result: AgentTickOutput): Promise<void>;
      }
    ).applyTickResult(plannedRoute.arrived);
    throw new Error(
      "bridge deposit unexpectedly completed its held checkpoint",
    );
  }

  const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
    attemptId: mode === "withdraw" ? WITHDRAW_ATTEMPT_ID : COMPOSITE_ATTEMPT_ID,
    characterId: CHARACTER_ID,
    goalType: "banking",
    actionType: "bankWithdraw",
    decisionSource: "scripted",
    startedAt: mode === "withdraw" ? 11_000 : 12_000,
  });
  const receipt =
    mode === "withdraw"
      ? await executeAuthoritativeAgentBankTransfer({
          world: world as never,
          playerId: CHARACTER_ID,
          bankId: "bank-1",
          action: "withdraw",
          itemId: RESOURCE_ID,
          quantity: 5,
          operationId: getOrdinaryBankStageOperationId(attempt.attemptId),
        })
      : await executeAuthoritativeAgentBankTransfer({
          world: world as never,
          playerId: CHARACTER_ID,
          bankId: "bank-1",
          action: "withdraw",
          withdrawItems: [
            { itemId: COMPOSITE_ITEM_B, quantity: 3 },
            { itemId: COMPOSITE_ITEM_A, quantity: 2 },
          ],
          operationId: getOrdinaryBankStageOperationId(attempt.attemptId),
        });
  const valid =
    mode === "withdraw"
      ? receipt.success &&
        receipt.committedQuantity === 5 &&
        receipt.inventoryQuantityAfter === 6 &&
        receipt.bankQuantityAfter === 1
      : receipt.success &&
        receipt.itemId === null &&
        receipt.committedQuantity === 5 &&
        receipt.inventoryQuantityAfter === 5 &&
        receipt.bankQuantityAfter === null;
  if (!valid) {
    throw new Error(
      `writer ${mode} receipt mismatch: ${JSON.stringify(receipt)}`,
    );
  }
  process.stdout.write(
    mode === "withdraw"
      ? "BANK_WITHDRAWAL_RECEIPT_AND_CUSTODY_COMMITTED\n"
      : "BANK_COMPOSITE_RECEIPT_AND_CUSTODY_COMMITTED\n",
  );
  await new Promise<never>(() => {});
}

async function waitForWriterReady(
  child: ReturnType<typeof spawn>,
  marker: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(
      () => reject(new Error(`bank writer readiness timeout: ${errors}`)),
      20_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!output.includes(marker)) {
        clearTimeout(timeout);
        reject(
          new Error(
            `bank writer exited before readiness: ${code ?? signal}: ${errors}`,
          ),
        );
      }
    });
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function runParent(): Promise<void> {
  const baseUrl =
    process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      "Set AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL for the bank process-kill proof",
    );
  }

  const databaseName = `hyperia_bank_kill_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const adminPool = new pg.Pool({
    connectionString: adminUrl.toString(),
    max: 2,
  });
  let pool: pg.Pool | null = null;
  let child: ReturnType<typeof spawn> | null = null;

  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(baseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 12 });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../src/database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, 'Ordinary Bank Kill Account', 'user', '2026-08-10T00:00:00.000Z')`,
      [ACCOUNT_ID],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent")
       VALUES ($1, $2, 'Ordinary Bank Kill Agent', 1)`,
      [CHARACTER_ID, ACCOUNT_ID],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES
         ($1, $2, 1, 0),
         ($1, $3, 7, 1),
         ($1, $4, 1, 2)`,
      [CHARACTER_ID, TOOL_ID, RESOURCE_ID, FOOD_ID],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       SELECT $1, $2, 1, slot_index
       FROM generate_series(3, 23) AS slot_index`,
      [CHARACTER_ID, FILLER_ID],
    );

    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--writer", testUrl.toString()],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForWriterReady(
      child,
      "WORKER_BRIDGE_BANK_RECEIPT_AND_CUSTODY_COMMITTED",
    );
    if (!child.kill("SIGKILL")) throw new Error("failed to kill bank writer");
    await waitForExit(child);

    const replacements = await Promise.all(
      Array.from({ length: 5 }, () =>
        recoverOpenAgentAutonomyProgressionAttempt(
          pool!,
          makeInstance(),
          10_500,
          resolveOrdinaryBankingRecovery,
        ),
      ),
    );
    const recovered = replacements.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    if (recovered.length !== 1) {
      throw new Error(
        `expected one bank recovery winner, got ${recovered.length}`,
      );
    }
    if (
      recovered[0].checkpoint.lastActionOutcome !== "completed" ||
      recovered[0].checkpoint.lastAppliedActionType !== "bankDepositAll" ||
      recovered[0].checkpoint.requiresReassessment !== true
    ) {
      throw new Error("bank recovery checkpoint did not preserve exact truth");
    }

    const proof = await pool.query<{
      receipt_count: string;
      carried_tool: string;
      carried_resource: string;
      carried_food: string;
      carried_filler: string;
      banked_resource: string;
      banked_filler: string;
      terminal_source: string;
      terminal_outcome: string;
      applied_action: string;
      open_attempt_id: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM agent_bank_operations
          WHERE "operationId" = $2) AS receipt_count,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $3), '0') AS carried_tool,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $4), '0') AS carried_resource,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $5), '0') AS carried_food,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $6), '0') AS carried_filler,
         COALESCE((SELECT sum(quantity)::text FROM bank_storage
          WHERE "playerId" = $1 AND "itemId" = $4), '0') AS banked_resource,
         COALESCE((SELECT sum(quantity)::text FROM bank_storage
          WHERE "playerId" = $1 AND "itemId" = $6), '0') AS banked_filler,
         (SELECT event_source FROM agent_autonomy_progression_events
          WHERE attempt_id = $7 AND event_type = 'attempt_terminal') AS terminal_source,
         (SELECT action_outcome FROM agent_autonomy_progression_events
          WHERE attempt_id = $7 AND event_type = 'attempt_terminal') AS terminal_outcome,
         (SELECT applied_action_type FROM agent_autonomy_progression_events
          WHERE attempt_id = $7 AND event_type = 'attempt_terminal') AS applied_action,
         (SELECT open_attempt_id FROM agent_autonomy_progression_heads
          WHERE character_id = $1) AS open_attempt_id`,
      [
        CHARACTER_ID,
        getOrdinaryBankOperationId(ATTEMPT_ID),
        TOOL_ID,
        RESOURCE_ID,
        FOOD_ID,
        FILLER_ID,
        ATTEMPT_ID,
      ],
    );
    const row = proof.rows[0];
    if (
      row.receipt_count !== "1" ||
      row.carried_tool !== "1" ||
      row.carried_resource !== "1" ||
      row.carried_food !== "1" ||
      row.carried_filler !== "0" ||
      row.banked_resource !== "6" ||
      row.banked_filler !== "21" ||
      row.terminal_source !== "restart_reconciliation" ||
      row.terminal_outcome !== "completed" ||
      row.applied_action !== "bankDepositAll" ||
      row.open_attempt_id !== null
    ) {
      throw new Error(
        `bank process-kill proof mismatch: ${JSON.stringify(row)}`,
      );
    }

    child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--writer",
        testUrl.toString(),
        "withdraw",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForWriterReady(
      child,
      "BANK_WITHDRAWAL_RECEIPT_AND_CUSTODY_COMMITTED",
    );
    if (!child.kill("SIGKILL")) {
      throw new Error("failed to kill bank withdrawal writer");
    }
    await waitForExit(child);

    const withdrawalReplacements = await Promise.all(
      Array.from({ length: 5 }, () =>
        recoverOpenAgentAutonomyProgressionAttempt(
          pool!,
          makeInstance(),
          11_500,
          resolveOrdinaryBankingRecovery,
        ),
      ),
    );
    const withdrawalRecovered = withdrawalReplacements.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    if (
      withdrawalRecovered.length !== 1 ||
      withdrawalRecovered[0].checkpoint.lastActionOutcome !== "completed" ||
      withdrawalRecovered[0].checkpoint.lastAppliedActionType !== "bankWithdraw"
    ) {
      throw new Error(
        `bank withdrawal recovery mismatch: ${JSON.stringify(withdrawalRecovered)}`,
      );
    }

    const withdrawalProof = await pool.query<{
      receipt_count: string;
      carried_resource: string;
      banked_resource: string;
      terminal_source: string;
      terminal_outcome: string;
      applied_action: string;
      open_attempt_id: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM agent_bank_operations
          WHERE "operationId" = $2) AS receipt_count,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $3), '0') AS carried_resource,
         COALESCE((SELECT sum(quantity)::text FROM bank_storage
          WHERE "playerId" = $1 AND "itemId" = $3), '0') AS banked_resource,
         (SELECT event_source FROM agent_autonomy_progression_events
          WHERE attempt_id = $4 AND event_type = 'attempt_terminal') AS terminal_source,
         (SELECT action_outcome FROM agent_autonomy_progression_events
          WHERE attempt_id = $4 AND event_type = 'attempt_terminal') AS terminal_outcome,
         (SELECT applied_action_type FROM agent_autonomy_progression_events
          WHERE attempt_id = $4 AND event_type = 'attempt_terminal') AS applied_action,
         (SELECT open_attempt_id FROM agent_autonomy_progression_heads
          WHERE character_id = $1) AS open_attempt_id`,
      [
        CHARACTER_ID,
        getOrdinaryBankStageOperationId(WITHDRAW_ATTEMPT_ID),
        RESOURCE_ID,
        WITHDRAW_ATTEMPT_ID,
      ],
    );
    const withdrawalRow = withdrawalProof.rows[0];
    if (
      withdrawalRow.receipt_count !== "1" ||
      withdrawalRow.carried_resource !== "6" ||
      withdrawalRow.banked_resource !== "1" ||
      withdrawalRow.terminal_source !== "restart_reconciliation" ||
      withdrawalRow.terminal_outcome !== "completed" ||
      withdrawalRow.applied_action !== "bankWithdraw" ||
      withdrawalRow.open_attempt_id !== null
    ) {
      throw new Error(
        `bank withdrawal process-kill proof mismatch: ${JSON.stringify(withdrawalRow)}`,
      );
    }

    await pool.query(
      `INSERT INTO bank_storage
         ("playerId", "itemId", quantity, slot, "tabIndex")
       VALUES
         ($1, $2, 4,
          (SELECT COALESCE(max(slot), -1) + 1 FROM bank_storage
           WHERE "playerId" = $1 AND "tabIndex" = 0), 0),
         ($1, $3, 8,
          (SELECT COALESCE(max(slot), -1) + 2 FROM bank_storage
           WHERE "playerId" = $1 AND "tabIndex" = 0), 0)`,
      [CHARACTER_ID, COMPOSITE_ITEM_A, COMPOSITE_ITEM_B],
    );
    child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--writer",
        testUrl.toString(),
        "composite",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForWriterReady(
      child,
      "BANK_COMPOSITE_RECEIPT_AND_CUSTODY_COMMITTED",
    );
    if (!child.kill("SIGKILL")) {
      throw new Error("failed to kill composite bank writer");
    }
    await waitForExit(child);

    const compositeReplacements = await Promise.all(
      Array.from({ length: 5 }, () =>
        recoverOpenAgentAutonomyProgressionAttempt(
          pool!,
          makeInstance(),
          12_500,
          resolveOrdinaryBankingRecovery,
        ),
      ),
    );
    const compositeRecovered = compositeReplacements.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    if (
      compositeRecovered.length !== 1 ||
      compositeRecovered[0].checkpoint.lastActionOutcome !== "completed" ||
      compositeRecovered[0].checkpoint.lastAppliedActionType !== "bankWithdraw"
    ) {
      throw new Error(
        `composite bank recovery mismatch: ${JSON.stringify(compositeRecovered)}`,
      );
    }

    const compositeProof = await pool.query<{
      receipt_count: string;
      component_count: string;
      requested_total: string;
      committed_total: string;
      carried_a: string;
      carried_b: string;
      banked_a: string;
      banked_b: string;
      terminal_source: string;
      terminal_outcome: string;
      open_attempt_id: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM agent_bank_operations
          WHERE "operationId" = $2) AS receipt_count,
         (SELECT count(*)::text FROM agent_bank_operation_items
          WHERE "operationId" = $2) AS component_count,
         (SELECT sum("requestedQuantity")::text
          FROM agent_bank_operation_items
          WHERE "operationId" = $2) AS requested_total,
         (SELECT sum("committedQuantity")::text
          FROM agent_bank_operation_items
          WHERE "operationId" = $2) AS committed_total,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $3), '0') AS carried_a,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $4), '0') AS carried_b,
         COALESCE((SELECT sum(quantity)::text FROM bank_storage
          WHERE "playerId" = $1 AND "itemId" = $3), '0') AS banked_a,
         COALESCE((SELECT sum(quantity)::text FROM bank_storage
          WHERE "playerId" = $1 AND "itemId" = $4), '0') AS banked_b,
         (SELECT event_source FROM agent_autonomy_progression_events
          WHERE attempt_id = $5 AND event_type = 'attempt_terminal') AS terminal_source,
         (SELECT action_outcome FROM agent_autonomy_progression_events
          WHERE attempt_id = $5 AND event_type = 'attempt_terminal') AS terminal_outcome,
         (SELECT open_attempt_id FROM agent_autonomy_progression_heads
          WHERE character_id = $1) AS open_attempt_id`,
      [
        CHARACTER_ID,
        getOrdinaryBankStageOperationId(COMPOSITE_ATTEMPT_ID),
        COMPOSITE_ITEM_A,
        COMPOSITE_ITEM_B,
        COMPOSITE_ATTEMPT_ID,
      ],
    );
    const compositeRow = compositeProof.rows[0];
    if (
      compositeRow.receipt_count !== "1" ||
      compositeRow.component_count !== "2" ||
      compositeRow.requested_total !== "5" ||
      compositeRow.committed_total !== "5" ||
      compositeRow.carried_a !== "2" ||
      compositeRow.carried_b !== "3" ||
      compositeRow.banked_a !== "2" ||
      compositeRow.banked_b !== "5" ||
      compositeRow.terminal_source !== "restart_reconciliation" ||
      compositeRow.terminal_outcome !== "completed" ||
      compositeRow.open_attempt_id !== null
    ) {
      throw new Error(
        `composite bank process-kill proof mismatch: ${JSON.stringify(compositeRow)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        writerKilledAfterBankCommit: true,
        plannerQuestInventoryRoutedDiagonally: true,
        productionTileMovementReachedBankDiagonally: true,
        productionTileMovementAvoidedBlockedTiles: true,
        workerResultAppliedByProductionBridge: true,
        bridgeSelectedRealBankDeposit: true,
        plannerSnapshotMatchedCommittedCustody: true,
        activeQuestTargetRetainedByProductionPolicy: true,
        startCommittedBeforeCustody: true,
        exactReceiptRecoveredAfterRestart: true,
        oneOfFiveReplacementWorkersRecovered: true,
        committedActionNotReplayed: row.receipt_count === "1",
        retainedToolQuantity: Number(row.carried_tool),
        retainedFoodQuantity: Number(row.carried_food),
        bankedSurplusQuantity: Number(row.banked_resource),
        bankedFillerQuantity: Number(row.banked_filler),
        withdrawalWriterKilledAfterCommit: true,
        exactWithdrawalReceiptRecoveredAfterRestart: true,
        oneOfFiveWithdrawalReplacementWorkersRecovered: true,
        withdrawalCommittedActionNotReplayed:
          withdrawalRow.receipt_count === "1",
        stagedResourceQuantity: Number(withdrawalRow.carried_resource),
        bankedResourceRemaining: Number(withdrawalRow.banked_resource),
        terminalSource: row.terminal_source,
        terminalOutcome: row.terminal_outcome,
        withdrawalTerminalSource: withdrawalRow.terminal_source,
        withdrawalTerminalOutcome: withdrawalRow.terminal_outcome,
        compositeWriterKilledAfterCommit: true,
        exactCompositeReceiptRecoveredAfterRestart: true,
        oneOfFiveCompositeReplacementWorkersRecovered: true,
        compositeCommittedActionNotReplayed: compositeRow.receipt_count === "1",
        compositeComponentCount: Number(compositeRow.component_count),
        compositeRequestedTotal: Number(compositeRow.requested_total),
        compositeCommittedTotal: Number(compositeRow.committed_total),
        compositeCarriedA: Number(compositeRow.carried_a),
        compositeCarriedB: Number(compositeRow.carried_b),
        compositeBankedA: Number(compositeRow.banked_a),
        compositeBankedB: Number(compositeRow.banked_b),
        compositeTerminalSource: compositeRow.terminal_source,
        compositeTerminalOutcome: compositeRow.terminal_outcome,
      })}\n`,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await pool?.end();
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  }
}

if (process.argv[2] === "--writer") {
  const connectionString = process.argv[3];
  if (!connectionString) throw new Error("writer connection string missing");
  await runWriter(
    connectionString,
    process.argv[4] === "withdraw"
      ? "withdraw"
      : process.argv[4] === "composite"
        ? "composite"
        : "deposit",
  );
} else {
  await runParent();
}
