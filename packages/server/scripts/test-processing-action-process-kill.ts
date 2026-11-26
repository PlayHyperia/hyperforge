import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  EventBus,
  EventType,
  QuestSystem,
  type ProcessingRequestEnvelope,
  type ProcessingSkill,
} from "@hyperforge/shared";

import { QuestRepository } from "../src/database/repositories/QuestRepository.js";
import * as schema from "../src/database/schema.js";
import type { ProcessingActionCommitRequest } from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const PLAYER_ID = "processing-action-chaos-agent";
const PENDING_PLAYER_ID = "processing-request-chaos-agent";
const SMELTING_REQUEST_PLAYER_ID = "smelting-request-chaos-agent";
const TANNING_REQUEST_PLAYER_ID = "tanning-request-chaos-agent";
const EMBEDDED_HOST_PLAYER_ID = "embedded-host-processing-chaos-agent";
const EXTERNAL_HOST_PLAYER_ID = "external-host-processing-chaos-agent";
type RequestInput = Omit<
  ProcessingActionCommitRequest,
  "operationId" | "requestFingerprint"
>;
type WorkerEvent = {
  event:
    | "admitted"
    | "committed"
    | "quest_recovered"
    | "agent_admitted"
    | "agent_ready"
    | "contention_complete"
    | "error";
  host?: "embedded" | "external";
  requestId?: string;
  dispatchCount?: number;
  admission?: "accepted" | "pending" | "committed" | "busy" | "rejected";
  replayed?: boolean;
  currentXp?: number;
  currentLevel?: number;
  currentCoins?: number;
  consumableStates?: Array<{
    itemId: string;
    usesPerItem: number;
    remainingUses: number;
    consumedQuantity: 0 | 1;
  }>;
  worldEffect?: {
    kind: "fire";
    fireId: string;
    position: { x: number; y: number; z: number };
    tile: { x: number; z: number };
    createdAt: number;
    expiresAt: number;
  };
  inventory?: Array<{ itemId: string; quantity: number; slotIndex: number }>;
  questStage?: string | null;
  questProgress?: Record<string, number> | null;
  pendingQuestReceipts?: number;
  message?: string;
  contentionResults?: Array<{
    playerId: string;
    requestId: string;
    skill: ProcessingSkill;
    durationMs: number;
    acknowledged: boolean;
    cleared: boolean;
  }>;
};

type ProcessingContentionCase = {
  playerId: string;
  requestId: string;
  operationId: string;
  skill: ProcessingSkill;
  envelope: ProcessingRequestEnvelope;
  request: RequestInput;
  initialCoins: number;
  expectedCoins: number;
  xpColumn:
    | "firemakingXp"
    | "cookingXp"
    | "smithingXp"
    | "craftingXp"
    | "fletchingXp"
    | "runecraftingXp";
  expectedXp: number;
  initialInventory: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
  }>;
  expectedInventory: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
  }>;
};

const BASE_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "smithing",
  xpAmount: 12.5,
  inputs: [{ itemId: "bronze_bar", quantity: 2 }],
  requiredItems: [{ itemId: "hammer", quantity: 1 }],
  consumables: [],
  outputs: [{ itemId: "bronze_sword", quantity: 1, stackable: false }],
};

const PENDING_INPUT: RequestInput = {
  ...BASE_INPUT,
  playerId: PENDING_PLAYER_ID,
};

const FAILED_SMELT_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "smithing",
  xpAmount: 0,
  inputs: [{ itemId: "iron_ore", quantity: 1 }],
  requiredItems: [],
  consumables: [],
  outputs: [],
};

const CRAFT_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "crafting",
  xpAmount: 13.8,
  inputs: [{ itemId: "leather", quantity: 1 }],
  requiredItems: [{ itemId: "needle", quantity: 1 }],
  consumables: [{ itemId: "thread", usesPerItem: 5 }],
  outputs: [{ itemId: "leather_gloves", quantity: 1, stackable: false }],
};

const FLETCH_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "fletching",
  xpAmount: 19.5,
  inputs: [
    { itemId: "bronze_arrowtips", quantity: 15 },
    { itemId: "headless_arrow", quantity: 15 },
  ],
  requiredItems: [],
  consumables: [],
  outputs: [{ itemId: "bronze_arrow", quantity: 15, stackable: true }],
};

const RUNECRAFT_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "runecrafting",
  xpAmount: 27.5,
  inputs: [
    { itemId: "pure_essence", quantity: 2 },
    { itemId: "rune_essence", quantity: 3 },
  ],
  requiredItems: [],
  consumables: [],
  outputs: [{ itemId: "mind_rune", quantity: 5, stackable: true }],
};

const COOK_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "cooking",
  xpAmount: 30,
  inputs: [{ itemId: "raw_shrimp", quantity: 1 }],
  requiredItems: [],
  consumables: [],
  outputs: [{ itemId: "shrimp", quantity: 1, stackable: false }],
};

const BURNT_COOK_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "cooking",
  xpAmount: 0,
  inputs: [{ itemId: "raw_anchovies", quantity: 1 }],
  requiredItems: [],
  consumables: [],
  outputs: [{ itemId: "burnt_anchovies", quantity: 1, stackable: false }],
};

const FIREMAKE_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "firemaking",
  xpAmount: 40,
  inputs: [{ itemId: "logs", quantity: 1 }],
  requiredItems: [{ itemId: "tinderbox", quantity: 1 }],
  consumables: [],
  outputs: [],
  worldEffect: {
    kind: "fire",
    fireId: "fire_process-kill",
    position: { x: 10.5, y: 0, z: 20.5 },
    tile: { x: 10, z: 20 },
    durationMs: 60_000,
  },
};

function firemakeInput(
  playerId: string,
  fireId: string,
  tile: { x: number; z: number },
): RequestInput {
  return {
    ...FIREMAKE_INPUT,
    playerId,
    worldEffect: {
      kind: "fire",
      fireId,
      position: { x: tile.x + 0.5, y: 0, z: tile.z + 0.5 },
      tile,
      durationMs: 60_000,
    },
  };
}

const TANNING_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "crafting",
  xpAmount: 0,
  inputs: [{ itemId: "cowhide", quantity: 2 }],
  requiredItems: [],
  consumables: [],
  outputs: [{ itemId: "leather", quantity: 2, stackable: false }],
  coinCost: 2,
};

const SMELTING_REQUEST_INPUT: RequestInput = {
  playerId: SMELTING_REQUEST_PLAYER_ID,
  skill: "smithing",
  xpAmount: 7.5,
  inputs: [{ itemId: "iron_ore", quantity: 1 }],
  requiredItems: [],
  consumables: [],
  outputs: [{ itemId: "iron_bar", quantity: 1, stackable: false }],
};

const TANNING_REQUEST_INPUT: RequestInput = {
  playerId: TANNING_REQUEST_PLAYER_ID,
  skill: "crafting",
  xpAmount: 0,
  inputs: [{ itemId: "cowhide", quantity: 1 }],
  requiredItems: [],
  consumables: [],
  outputs: [{ itemId: "leather", quantity: 1, stackable: false }],
  coinCost: 1,
};

function agentHostFletchingInput(playerId: string): RequestInput {
  return {
    playerId,
    skill: "fletching",
    xpAmount: 5,
    inputs: [{ itemId: "logs", quantity: 1 }],
    requiredItems: [],
    consumables: [],
    outputs: [{ itemId: "arrow_shaft", quantity: 15, stackable: true }],
  };
}

const CONTENTION_SKILLS: readonly ProcessingSkill[] = [
  "firemaking",
  "cooking",
  "smelting",
  "smithing",
  "crafting",
  "fletching",
  "runecrafting",
  "tanning",
];

function createProcessingContentionCase(
  index: number,
): ProcessingContentionCase {
  const skill = CONTENTION_SKILLS[index % CONTENTION_SKILLS.length];
  if (!skill) throw new Error("contention skill matrix is incomplete");
  const playerId = `processing-contention-agent-${index}`;
  const requestId = randomUUID();
  const operationId = `processing-request:${skill}:${requestId}`;
  const base = { playerId, requestId, operationId, skill };
  switch (skill) {
    case "firemaking":
      return {
        ...base,
        envelope: {
          skill,
          logsId: "logs",
          logsSlot: 0,
          tinderboxSlot: 1,
        },
        request: {
          playerId,
          skill,
          xpAmount: 40,
          inputs: [{ itemId: "logs", quantity: 1 }],
          requiredItems: [{ itemId: "tinderbox", quantity: 1 }],
          consumables: [],
          outputs: [],
          worldEffect: {
            kind: "fire",
            fireId: `fire_contention_${index}`,
            position: { x: index + 0.5, y: 0, z: 100.5 },
            tile: { x: index, z: 100 },
            durationMs: 60_000,
          },
        },
        initialCoins: 0,
        expectedCoins: 0,
        xpColumn: "firemakingXp",
        expectedXp: 40,
        initialInventory: [
          { itemId: "logs", quantity: 1, slotIndex: 0 },
          { itemId: "tinderbox", quantity: 1, slotIndex: 1 },
        ],
        expectedInventory: [{ itemId: "tinderbox", quantity: 1, slotIndex: 1 }],
      };
    case "cooking":
      return {
        ...base,
        envelope: {
          skill,
          rawFoodId: "raw_shrimp",
          rawFoodSlot: 0,
          sourceId: "range-contention",
          sourceType: "range",
        },
        request: {
          playerId,
          skill,
          xpAmount: 30,
          inputs: [{ itemId: "raw_shrimp", quantity: 1 }],
          requiredItems: [],
          consumables: [],
          outputs: [{ itemId: "shrimp", quantity: 1, stackable: false }],
        },
        initialCoins: 0,
        expectedCoins: 0,
        xpColumn: "cookingXp",
        expectedXp: 30,
        initialInventory: [{ itemId: "raw_shrimp", quantity: 1, slotIndex: 0 }],
        expectedInventory: [{ itemId: "shrimp", quantity: 1, slotIndex: 0 }],
      };
    case "smelting":
      return {
        ...base,
        envelope: {
          skill,
          barItemId: "iron_bar",
          furnaceId: "furnace-contention",
          quantity: 1,
        },
        request: {
          playerId,
          skill: "smithing",
          xpAmount: 7.5,
          inputs: [{ itemId: "iron_ore", quantity: 1 }],
          requiredItems: [],
          consumables: [],
          outputs: [{ itemId: "iron_bar", quantity: 1, stackable: false }],
        },
        initialCoins: 0,
        expectedCoins: 0,
        xpColumn: "smithingXp",
        expectedXp: 7.5,
        initialInventory: [{ itemId: "iron_ore", quantity: 1, slotIndex: 0 }],
        expectedInventory: [{ itemId: "iron_bar", quantity: 1, slotIndex: 0 }],
      };
    case "smithing":
      return {
        ...base,
        envelope: {
          skill,
          recipeId: "bronze_sword",
          anvilId: "anvil-contention",
          quantity: 1,
        },
        request: {
          playerId,
          skill,
          xpAmount: 12.5,
          inputs: [{ itemId: "bronze_bar", quantity: 2 }],
          requiredItems: [{ itemId: "hammer", quantity: 1 }],
          consumables: [],
          outputs: [{ itemId: "bronze_sword", quantity: 1, stackable: false }],
        },
        initialCoins: 0,
        expectedCoins: 0,
        xpColumn: "smithingXp",
        expectedXp: 12.5,
        initialInventory: [
          { itemId: "bronze_bar", quantity: 1, slotIndex: 0 },
          { itemId: "bronze_bar", quantity: 1, slotIndex: 1 },
          { itemId: "hammer", quantity: 1, slotIndex: 2 },
        ],
        expectedInventory: [
          { itemId: "bronze_sword", quantity: 1, slotIndex: 0 },
          { itemId: "hammer", quantity: 1, slotIndex: 2 },
        ],
      };
    case "crafting":
      return {
        ...base,
        envelope: {
          skill,
          recipeId: "leather_gloves",
          stationId: "crafting-station-contention",
          quantity: 1,
        },
        request: {
          playerId,
          skill,
          xpAmount: 13.8,
          inputs: [{ itemId: "leather", quantity: 1 }],
          requiredItems: [{ itemId: "needle", quantity: 1 }],
          consumables: [{ itemId: "thread", usesPerItem: 5 }],
          outputs: [
            { itemId: "leather_gloves", quantity: 1, stackable: false },
          ],
        },
        initialCoins: 0,
        expectedCoins: 0,
        xpColumn: "craftingXp",
        expectedXp: 13.8,
        initialInventory: [
          { itemId: "leather", quantity: 1, slotIndex: 0 },
          { itemId: "needle", quantity: 1, slotIndex: 1 },
          { itemId: "thread", quantity: 1, slotIndex: 2 },
        ],
        expectedInventory: [
          { itemId: "leather_gloves", quantity: 1, slotIndex: 0 },
          { itemId: "needle", quantity: 1, slotIndex: 1 },
          { itemId: "thread", quantity: 1, slotIndex: 2 },
        ],
      };
    case "fletching":
      return {
        ...base,
        envelope: {
          skill,
          recipeId: "arrow_shaft:logs",
          quantity: 1,
        },
        request: agentHostFletchingInput(playerId),
        initialCoins: 0,
        expectedCoins: 0,
        xpColumn: "fletchingXp",
        expectedXp: 5,
        initialInventory: [{ itemId: "logs", quantity: 1, slotIndex: 0 }],
        expectedInventory: [
          { itemId: "arrow_shaft", quantity: 15, slotIndex: 0 },
        ],
      };
    case "runecrafting":
      return {
        ...base,
        envelope: {
          skill,
          altarId: "air-altar-contention",
          runeType: "air",
        },
        request: {
          playerId,
          skill,
          xpAmount: 15,
          inputs: [{ itemId: "rune_essence", quantity: 3 }],
          requiredItems: [],
          consumables: [],
          outputs: [{ itemId: "air_rune", quantity: 3, stackable: true }],
        },
        initialCoins: 0,
        expectedCoins: 0,
        xpColumn: "runecraftingXp",
        expectedXp: 15,
        initialInventory: [
          { itemId: "rune_essence", quantity: 3, slotIndex: 0 },
        ],
        expectedInventory: [{ itemId: "air_rune", quantity: 3, slotIndex: 0 }],
      };
    case "tanning":
      return {
        ...base,
        envelope: {
          skill,
          inputItemId: "cowhide",
          quantity: 1,
          tannerEntityId: "tanner-contention",
          tannerNpcId: "tanner",
        },
        request: {
          playerId,
          skill: "crafting",
          xpAmount: 0,
          inputs: [{ itemId: "cowhide", quantity: 1 }],
          requiredItems: [],
          consumables: [],
          outputs: [{ itemId: "leather", quantity: 1, stackable: false }],
          coinCost: 1,
        },
        initialCoins: 5,
        expectedCoins: 4,
        xpColumn: "craftingXp",
        expectedXp: 0,
        initialInventory: [{ itemId: "cowhide", quantity: 1, slotIndex: 0 }],
        expectedInventory: [{ itemId: "leather", quantity: 1, slotIndex: 0 }],
      };
  }
}

const UNAFFORDABLE_TANNING_INPUT: RequestInput = {
  playerId: PLAYER_ID,
  skill: "crafting",
  xpAmount: 0,
  inputs: [{ itemId: "cowhide", quantity: 1 }],
  requiredItems: [],
  consumables: [],
  outputs: [{ itemId: "leather", quantity: 1, stackable: false }],
  coinCost: 99,
};

function fingerprint(input: RequestInput): string {
  const payload: Record<string, unknown> = {
    version: 1,
    playerId: input.playerId,
    skill: input.skill,
    xpAmount: input.xpAmount,
    inputs: input.inputs,
    outputs: input.outputs,
  };
  if (input.requiredItems.length > 0) {
    payload.requiredItems = input.requiredItems;
  }
  if (input.consumables.length > 0) payload.consumables = input.consumables;
  if ((input.coinCost ?? 0) > 0) payload.coinCost = input.coinCost;
  if (input.worldEffect) payload.worldEffect = input.worldEffect;
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function requestFor(
  operationId: string,
  input: RequestInput,
): ProcessingActionCommitRequest {
  return {
    operationId,
    requestFingerprint: fingerprint(input),
    ...input,
  };
}

async function runQuestRecoveryWorker(): Promise<void> {
  const connectionString = process.env.PROCESSING_ACTION_TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("processing quest recovery configuration is incomplete");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const repository = new QuestRepository(db, pool);
    const questAuthority = {
      getAllPlayerQuests: repository.getAllPlayerQuests.bind(repository),
      getQuestPoints: repository.getQuestPoints.bind(repository),
      getPendingProcessingProgressReceipts:
        repository.getPendingProcessingProgressReceipts.bind(repository),
      applyProcessingProgressReceipt:
        repository.applyProcessingProgressReceipt.bind(repository),
      retireProcessingProgressReceipt:
        repository.retireProcessingProgressReceipt.bind(repository),
      ignoreProcessingProgressReceipt:
        repository.ignoreProcessingProgressReceipt.bind(repository),
    };
    const eventBus = new EventBus();
    const world = {
      isServer: true,
      $eventBus: eventBus,
      getSystem: (name: string) =>
        name === "database"
          ? { getQuestRepository: () => questAuthority }
          : undefined,
    } as never;
    const questSystem = new QuestSystem(world);
    await questSystem.init();
    eventBus.emitEvent(EventType.PLAYER_REGISTERED, { playerId: PLAYER_ID });
    await eventBus.waitForPendingHandlers(10_000);
    const progress = await repository.getQuestProgress(
      PLAYER_ID,
      "fresh_catch",
    );
    const pending =
      await repository.getPendingProcessingProgressReceipts(PLAYER_ID);
    questSystem.destroy();
    writeWorkerEvent({
      event: "quest_recovered",
      questStage: progress?.currentStage ?? null,
      questProgress: progress?.stageProgress ?? null,
      pendingQuestReceipts: pending.length,
    });
  } catch (error) {
    writeWorkerEvent({
      event: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await pool.end();
  }
}

async function runWorker(): Promise<void> {
  const connectionString = process.env.PROCESSING_ACTION_TEST_DATABASE_URL;
  const operationId = process.env.PROCESSING_ACTION_TEST_OPERATION_ID;
  const inputJson = process.env.PROCESSING_ACTION_TEST_REQUEST;
  const hold = process.argv.includes("--hold");
  if (!connectionString || !operationId || !inputJson) {
    throw new Error("processing action worker configuration is incomplete");
  }
  const input = JSON.parse(inputJson) as RequestInput;
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const receipt = await databaseSystem.commitProcessingActionOperationAsync(
      requestFor(operationId, input),
    );
    process.stdout.write(
      `${JSON.stringify({
        event: "committed",
        replayed: receipt.replayed,
        currentXp: receipt.currentXp,
        currentLevel: receipt.currentLevel,
        currentCoins: receipt.currentCoins,
        consumableStates: receipt.consumableStates,
        worldEffect: receipt.worldEffect,
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

async function runAdmissionWorker(): Promise<void> {
  const connectionString = process.env.PROCESSING_ACTION_TEST_DATABASE_URL;
  const operationId = process.env.PROCESSING_ACTION_TEST_OPERATION_ID;
  const inputJson = process.env.PROCESSING_ACTION_TEST_REQUEST;
  const hold = process.argv.includes("--hold");
  if (!connectionString || !operationId || !inputJson) {
    throw new Error("processing admission worker configuration is incomplete");
  }
  const input = JSON.parse(inputJson) as RequestInput;
  const requestId = operationId.slice(operationId.lastIndexOf(":") + 1);
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const admission = await databaseSystem.beginProcessingRequestAsync(
      input.playerId,
      operationId,
      requestId,
      input.skill,
      {
        skill: "smithing",
        recipeId: "bronze_sword",
        anvilId: "anvil-chaos",
        quantity: 1,
      },
    );
    process.stdout.write(
      `${JSON.stringify({ event: "admitted", admission } satisfies WorkerEvent)}\n`,
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

function writeWorkerEvent(event: WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function createEmbeddedAgentHostWorld(
  playerId: string,
  database: object,
  onFletchingRequest: (data: unknown) => void,
) {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const entities = new Map<string, unknown>([
    [
      playerId,
      {
        id: playerId,
        position: { x: 0, y: 0, z: 0 },
        data: { type: "player", position: [0, 0, 0] },
      },
    ],
  ]);
  return {
    entities: {
      get: (id: string) => entities.get(id),
      values: () => entities.values(),
      remove: (id: string) => entities.delete(id),
    },
    getSystem: (name: string) => (name === "database" ? database : undefined),
    emit: (event: string, data: unknown) => {
      if (event === EventType.PROCESSING_FLETCHING_REQUEST) {
        onFletchingRequest(data);
      }
      for (const listener of listeners.get(event) ?? []) listener(data);
    },
    on: (event: string, listener: (data: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    off: (event: string, listener: (data: unknown) => void) => {
      listeners.get(event)?.delete(listener);
    },
    isServer: true,
    network: null,
  };
}

async function runEmbeddedAgentHostWorker(): Promise<void> {
  const connectionString = process.env.PROCESSING_ACTION_TEST_DATABASE_URL;
  const playerId = process.env.PROCESSING_ACTION_TEST_PLAYER_ID;
  const recovering = process.argv.includes("--recover");
  if (!connectionString || !playerId) {
    throw new Error("embedded agent host configuration is incomplete");
  }
  const { EmbeddedHyperiaService } =
    await import("../src/eliza/EmbeddedHyperiaService.ts");
  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });
  const databaseSystem = new DatabaseSystem({} as never);
  (databaseSystem as unknown as { db: typeof db }).db = db;
  (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
  let dispatchCount = 0;
  let recoveredRequestId: string | null = null;

  const serviceDatabase = recovering
    ? databaseSystem
    : {
        getRecoverableProcessingRequestAsync:
          databaseSystem.getRecoverableProcessingRequestAsync.bind(
            databaseSystem,
          ),
        acknowledgeProcessingRequestAsync:
          databaseSystem.acknowledgeProcessingRequestAsync.bind(databaseSystem),
        getProcessingActionCommitStatusAsync:
          databaseSystem.getProcessingActionCommitStatusAsync.bind(
            databaseSystem,
          ),
        beginProcessingRequestAsync: async (
          ...args: Parameters<DatabaseSystem["beginProcessingRequestAsync"]>
        ) => {
          const admission = await databaseSystem.beginProcessingRequestAsync(
            ...args,
          );
          if (admission !== "accepted") {
            throw new Error(`embedded initial admission was ${admission}`);
          }
          writeWorkerEvent({
            event: "agent_admitted",
            host: "embedded",
            requestId: args[2],
            dispatchCount,
          });
          return await new Promise<never>(() => undefined);
        },
      };

  let world: ReturnType<typeof createEmbeddedAgentHostWorld>;
  world = createEmbeddedAgentHostWorld(playerId, serviceDatabase, (raw) => {
    dispatchCount += 1;
    if (!recovering) return;
    const requestId = (raw as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== "string") {
      writeWorkerEvent({
        event: "error",
        message: "embedded recovery emitted no request identity",
      });
      process.exit(1);
    }
    recoveredRequestId = requestId;
    void databaseSystem
      .commitProcessingActionOperationAsync(
        requestFor(
          `processing-request:fletching:${requestId}`,
          agentHostFletchingInput(playerId),
        ),
      )
      .then(() => {
        world.emit(EventType.FLETCHING_COMPLETE, {
          playerId,
          recipeId: "arrow_shaft",
          outputItemId: "arrow_shaft",
          totalCrafted: 15,
          totalXp: 5,
          requestId,
        });
      })
      .catch((error) => {
        writeWorkerEvent({
          event: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
  });
  const service = new EmbeddedHyperiaService(
    world as never,
    playerId,
    `account-${playerId}`,
    "Processing Recovery Agent",
  );

  try {
    await service.initialize();
    if (!recovering) {
      void service.executeFletch("arrow_shaft", 1);
      setInterval(() => undefined, 60_000).unref();
      await new Promise<never>(() => undefined);
    }
    if (!recoveredRequestId || dispatchCount !== 1) {
      throw new Error("embedded host did not recover exactly one dispatch");
    }
    writeWorkerEvent({
      event: "agent_ready",
      host: "embedded",
      requestId: recoveredRequestId,
      dispatchCount,
    });
    await service.stop();
  } catch (error) {
    writeWorkerEvent({
      event: "error",
      host: "embedded",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function runExternalAgentHostWorker(): Promise<void> {
  const connectionString = process.env.PROCESSING_ACTION_TEST_DATABASE_URL;
  const playerId = process.env.PROCESSING_ACTION_TEST_PLAYER_ID;
  const recovering = process.argv.includes("--recover");
  if (!connectionString || !playerId) {
    throw new Error("external agent host configuration is incomplete");
  }
  const { HyperiaService } =
    await import("../../plugin-hyperia/src/services/HyperiaService.ts");
  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });
  const databaseSystem = new DatabaseSystem({} as never);
  (databaseSystem as unknown as { db: typeof db }).db = db;
  (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
  const service = new HyperiaService({
    agentId: playerId,
    getSetting: () => null,
  } as never);
  const internals = service as unknown as {
    characterId: string;
    connectionState: { connected: boolean };
    gameState: { playerEntity: { id: string } | null };
    processingRecoveryReady: boolean;
    ensureProcessingRecovery: () => Promise<boolean>;
    sendCommand: (command: string, data: unknown) => void;
    updateGameStateFromPacket: (
      packetName: string,
      data: Record<string, unknown>,
    ) => void;
    ws: {
      __wsId: string;
      removeAllListeners: () => void;
      close: () => void;
    };
  };
  internals.characterId = playerId;
  internals.connectionState.connected = true;
  internals.gameState.playerEntity = { id: playerId };
  internals.processingRecoveryReady = !recovering;
  internals.ws = {
    __wsId: "processing-recovery-chaos",
    removeAllListeners: () => undefined,
    close: () => undefined,
  };
  let dispatchCount = 0;
  let recoveredRequestId: string | null = null;

  const fail = (error: unknown): void => {
    writeWorkerEvent({
      event: "error",
      host: "external",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  };
  const handleCommand = async (
    command: string,
    raw: unknown,
  ): Promise<void> => {
    const data = raw as Record<string, unknown>;
    if (command === "processingRequestRecovery") {
      const action = data.action;
      const queryId = data.queryId;
      if (typeof queryId !== "string") {
        throw new Error("external recovery query identity missing");
      }
      if (action === "query") {
        const request =
          await databaseSystem.getRecoverableProcessingRequestAsync(playerId);
        internals.updateGameStateFromPacket("processingRequestRecovery", {
          action: "state",
          queryId,
          available: true,
          request,
        });
        return;
      }
      if (action === "ack" && typeof data.requestId === "string") {
        const acknowledged =
          await databaseSystem.acknowledgeProcessingRequestAsync(
            playerId,
            data.requestId,
          );
        internals.updateGameStateFromPacket("processingRequestRecovery", {
          action: "acknowledged",
          queryId,
          requestId: data.requestId,
          acknowledged,
        });
        return;
      }
      throw new Error("external recovery action invalid");
    }
    if (command !== "processingFletching") return;
    dispatchCount += 1;
    const requestId = data.requestId;
    if (typeof requestId !== "string") {
      throw new Error("external fletching request identity missing");
    }
    const operationId = `processing-request:fletching:${requestId}`;
    const admission = await databaseSystem.beginProcessingRequestAsync(
      playerId,
      operationId,
      requestId,
      "fletching",
      {
        skill: "fletching",
        recipeId: "arrow_shaft:logs",
        quantity: 1,
      },
    );
    if (!recovering) {
      if (admission !== "accepted") {
        throw new Error(`external initial admission was ${admission}`);
      }
      writeWorkerEvent({
        event: "agent_admitted",
        host: "external",
        requestId,
        dispatchCount,
      });
      return;
    }
    recoveredRequestId = requestId;
    if (admission === "committed") {
      internals.updateGameStateFromPacket("processingProgress", {
        requestId,
        skill: "fletching",
        phase: "committed",
      });
      return;
    }
    if (admission !== "accepted") {
      throw new Error(`external recovery admission was ${admission}`);
    }
    await databaseSystem.commitProcessingActionOperationAsync(
      requestFor(operationId, agentHostFletchingInput(playerId)),
    );
    internals.updateGameStateFromPacket("fletchingComplete", {
      recipeId: "arrow_shaft:logs",
      outputItemId: "arrow_shaft",
      totalCrafted: 15,
      totalXp: 5,
      requestId,
    });
  };
  internals.sendCommand = (command, data) => {
    void handleCommand(command, data).catch(fail);
  };

  try {
    if (!recovering) {
      void service.executeFletching("arrow_shaft:logs", 1);
      setInterval(() => undefined, 60_000).unref();
      await new Promise<never>(() => undefined);
    }
    const ready = await internals.ensureProcessingRecovery();
    if (!ready || !recoveredRequestId || dispatchCount !== 1) {
      throw new Error("external host did not recover exactly one dispatch");
    }
    writeWorkerEvent({
      event: "agent_ready",
      host: "external",
      requestId: recoveredRequestId,
      dispatchCount,
    });
    await service.stop();
  } catch (error) {
    writeWorkerEvent({
      event: "error",
      host: "external",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function runProcessingContentionWorker(): Promise<void> {
  const connectionString = process.env.PROCESSING_ACTION_TEST_DATABASE_URL;
  const casesJson = process.env.PROCESSING_ACTION_TEST_CONTENTION_CASES;
  if (!connectionString || !casesJson) {
    throw new Error("processing contention worker configuration is incomplete");
  }
  const cases = JSON.parse(casesJson) as ProcessingContentionCase[];
  if (cases.length === 0 || cases.length > 8) {
    throw new Error("processing contention worker case count is invalid");
  }
  const pool = new Pool({ connectionString, max: cases.length });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const contentionResults = await Promise.all(
      cases.map(async (testCase) => {
        try {
          if (
            testCase.request.playerId !== testCase.playerId ||
            testCase.operationId !==
              `processing-request:${testCase.skill}:${testCase.requestId}`
          ) {
            throw new Error("processing contention case identity is invalid");
          }
          const startedAt = performance.now();
          const admission = await databaseSystem.beginProcessingRequestAsync(
            testCase.playerId,
            testCase.operationId,
            testCase.requestId,
            testCase.skill,
            testCase.envelope,
          );
          if (admission !== "accepted") {
            throw new Error(`contention admission was ${admission}`);
          }
          const receipt =
            await databaseSystem.commitProcessingActionOperationAsync(
              requestFor(testCase.operationId, testCase.request),
            );
          const acknowledged =
            await databaseSystem.acknowledgeProcessingRequestAsync(
              testCase.playerId,
              testCase.requestId,
            );
          const cleared =
            (await databaseSystem.getRecoverableProcessingRequestAsync(
              testCase.playerId,
            )) === null;
          if (receipt.replayed || !acknowledged || !cleared) {
            throw new Error("contention receipt was not exact");
          }
          return {
            playerId: testCase.playerId,
            requestId: testCase.requestId,
            skill: testCase.skill,
            durationMs: Math.max(0, performance.now() - startedAt),
            acknowledged,
            cleared,
          };
        } catch (error) {
          throw new Error(
            `${testCase.playerId}/${testCase.skill}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    writeWorkerEvent({ event: "contention_complete", contentionResults });
  } catch (error) {
    writeWorkerEvent({
      event: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await pool.end();
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
  throw new Error(`temporary PostgreSQL was not ready: ${String(lastError)}`);
}

function spawnWorker(input: {
  connectionString: string;
  operationId: string;
  request?: RequestInput;
  hold?: boolean;
  admissionOnly?: boolean;
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const request = input.request ?? BASE_INPUT;
  const args = [
    scriptPath,
    input.admissionOnly ? "--admission-worker" : "--worker",
  ];
  if (input.hold) args.push("--hold");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      PROCESSING_ACTION_TEST_DATABASE_URL: input.connectionString,
      PROCESSING_ACTION_TEST_OPERATION_ID: input.operationId,
      PROCESSING_ACTION_TEST_REQUEST: JSON.stringify(request),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) throw new Error("worker pipes missing");
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
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (
            parsed.event === "admitted" ||
            parsed.event === "committed" ||
            parsed.event === "error"
          ) {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          // Runtime diagnostics can share stdout; wait for the JSON receipt.
        }
      }
    });
    child.once("error", reject);
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
      PROCESSING_ACTION_TEST_DATABASE_URL: connectionString,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("processing quest recovery worker pipes missing");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`processing quest recovery timed out: ${stderr}`)),
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
          if (parsed.event === "quest_recovered" || parsed.event === "error") {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          // Runtime diagnostics can share stdout; wait for the JSON result.
        }
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return;
      clearTimeout(timer);
      reject(
        new Error(
          `processing quest recovery exited ${code ?? signal}: ${stderr}`,
        ),
      );
    });
  });
  return { child, event };
}

function spawnAgentHost(input: {
  connectionString: string;
  playerId: string;
  host: "embedded" | "external";
  recovering: boolean;
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const args = [
    scriptPath,
    input.host === "embedded"
      ? "--embedded-agent-host"
      : "--external-agent-host",
    input.recovering ? "--recover" : "--initial",
  ];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      PROCESSING_ACTION_TEST_DATABASE_URL: input.connectionString,
      PROCESSING_ACTION_TEST_PLAYER_ID: input.playerId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error(`${input.host} agent host pipes missing`);
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finishResolve = (value: WorkerEvent): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () =>
        finishReject(
          new Error(`${input.host} agent host timed out: ${stderr || stdout}`),
        ),
      30_000,
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
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (parsed.event === "error") {
            finishReject(
              new Error(
                `${input.host} agent host failed: ${parsed.message ?? line}`,
              ),
            );
            return;
          }
          const expectedEvent = input.recovering
            ? "agent_ready"
            : "agent_admitted";
          if (parsed.event === expectedEvent && parsed.host === input.host) {
            finishResolve(parsed);
            return;
          }
        } catch {
          // Runtime diagnostics can share stdout; wait for the JSON host event.
        }
      }
    });
    child.once("error", (error) =>
      finishReject(error instanceof Error ? error : new Error(String(error))),
    );
    child.once("exit", (code, signal) => {
      if (settled || signal === "SIGKILL") return;
      finishReject(
        new Error(
          `${input.host} agent host exited ${code ?? signal}: ${stderr || stdout}`,
        ),
      );
    });
  });
  return { child, event };
}

function spawnContentionWorker(input: {
  connectionString: string;
  cases: ProcessingContentionCase[];
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const child = spawn(process.execPath, [scriptPath, "--contention-worker"], {
    env: {
      ...process.env,
      PROCESSING_ACTION_TEST_DATABASE_URL: input.connectionString,
      PROCESSING_ACTION_TEST_CONTENTION_CASES: JSON.stringify(input.cases),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("processing contention worker pipes missing");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: WorkerEvent): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(new Error(`processing contention worker timed out: ${stderr}`)),
      60_000,
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
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (parsed.event === "error") {
            finish(
              new Error(
                `processing contention worker failed: ${parsed.message ?? line}`,
              ),
            );
            return;
          }
          if (parsed.event === "contention_complete") {
            finish(null, parsed);
            return;
          }
        } catch {
          // Runtime diagnostics can share stdout; wait for the JSON result.
        }
      }
    });
    child.once("error", (error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
    child.once("exit", (code, signal) => {
      if (settled) return;
      finish(
        new Error(
          `processing contention worker exited ${code ?? signal}: ${stderr || stdout}`,
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
  const containerName = `hyperia-processing-action-chaos-${process.pid}`;
  const user = "processing_action_test";
  const database = "processing_action_test";
  const password = `processing-${randomUUID()}`;
  const correlatedRequestId = randomUUID();
  const originalOperationId = `processing-request:smithing:${correlatedRequestId}`;
  const pendingRequestId = randomUUID();
  const pendingOperationId = `processing-request:smithing:${pendingRequestId}`;
  const smeltingRequestId = randomUUID();
  const smeltingRequestOperationId = `processing-request:smelting:${smeltingRequestId}`;
  const tanningRequestId = randomUUID();
  const tanningRequestOperationId = `processing-request:tanning:${tanningRequestId}`;
  const failedSmeltOperationId = randomUUID();
  const craftingOperationIds = Array.from({ length: 5 }, () => randomUUID());
  const fletchingOperationId = randomUUID();
  const runecraftingOperationId = randomUUID();
  const cookingOperationId = randomUUID();
  const burntCookingOperationId = randomUUID();
  const firemakingOperationId = randomUUID();
  const tanningOperationId = randomUUID();
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(`Docker is required for processing chaos: ${error}`);
    });
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-e",
      `POSTGRES_USER=${user}`,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_DB=${database}`,
      "-p",
      "127.0.0.1::5432",
      process.env.PROCESSING_ACTION_TEST_POSTGRES_IMAGE?.trim() ||
        "postgres:16-alpine",
    ]);
    containerStarted = true;
    const port = Number(
      (await docker(["port", containerName, "5432/tcp"])).split(":").pop(),
    );
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new Error("temporary PostgreSQL port was invalid");
    }
    const connectionString = `postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
    pool = await waitForPostgres(connectionString);
    await pool.query(`
      CREATE TABLE characters (
        id text PRIMARY KEY,
        coins integer DEFAULT 0,
        "questPoints" integer DEFAULT 0,
        "firemakingXp" integer DEFAULT 0, "firemakingLevel" integer DEFAULT 1,
        "cookingXp" integer DEFAULT 0, "cookingLevel" integer DEFAULT 1,
        "smithingXp" integer DEFAULT 0, "smithingLevel" integer DEFAULT 1,
        "craftingXp" integer DEFAULT 0, "craftingLevel" integer DEFAULT 1,
        "fletchingXp" integer DEFAULT 0, "fletchingLevel" integer DEFAULT 1,
        "runecraftingXp" integer DEFAULT 0, "runecraftingLevel" integer DEFAULT 1
      );
      CREATE TABLE inventory (
        id serial PRIMARY KEY, "playerId" text NOT NULL, "itemId" text NOT NULL,
        quantity integer DEFAULT 1, "slotIndex" integer DEFAULT -1, metadata text
      );
      CREATE UNIQUE INDEX inventory_player_slot_unique
        ON inventory ("playerId", "slotIndex") WHERE "slotIndex" >= 0;
      CREATE TABLE operations_log (
        id text PRIMARY KEY, "playerId" text NOT NULL, "operationType" text NOT NULL,
        "operationState" jsonb NOT NULL, completed boolean DEFAULT false,
        timestamp bigint NOT NULL, "completedAt" bigint
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
    const migration = await readFile(
      new URL(
        "../src/database/migrations/0063_preserve_fractional_processing_xp.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
    await pool.query(
      `INSERT INTO characters (id, coins, "smithingXp", "smithingLevel") VALUES ($1, 100, 80.5, 1)`,
      [PLAYER_ID],
    );
    const consumableMigration = await readFile(
      new URL(
        "../src/database/migrations/0064_persist_processing_consumable_uses.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of consumableMigration.split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) await pool.query(statement);
    }
    const activeFireMigration = await readFile(
      new URL(
        "../src/database/migrations/0065_persist_active_processing_fires.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of activeFireMigration.split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) await pool.query(statement);
    }
    const questProgressMigration = await readFile(
      new URL(
        "../src/database/migrations/0081_add_durable_quest_processing_progress.sql",
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
    const migratedConsumableState = await pool.query<{ uses: unknown }>(
      `SELECT "processingConsumableUses" AS uses FROM characters WHERE id = $1`,
      [PLAYER_ID],
    );
    const consumableStateMigrationApplied =
      JSON.stringify(migratedConsumableState.rows[0]?.uses) === "{}";
    if (!consumableStateMigrationApplied) {
      throw new Error(
        "consumable-use migration did not backfill existing state",
      );
    }
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex") VALUES
       ($1, 'bronze_bar', 1, 0), ($1, 'bronze_bar', 1, 1),
       ($1, 'hammer', 1, 2), ($1, 'bronze_bar', 1, 3),
       ($1, 'bronze_bar', 1, 4), ($1, 'iron_ore', 1, 5),
       ($1, 'leather', 1, 6), ($1, 'leather', 1, 7),
       ($1, 'leather', 1, 8), ($1, 'leather', 1, 9),
       ($1, 'leather', 1, 10), ($1, 'needle', 1, 11),
       ($1, 'thread', 1, 12),
       ($1, 'bronze_arrowtips', 15, 13),
       ($1, 'headless_arrow', 15, 14),
       ($1, 'pure_essence', 2, 15),
       ($1, 'rune_essence', 3, 16),
       ($1, 'raw_shrimp', 1, 17),
       ($1, 'raw_anchovies', 1, 18),
       ($1, 'logs', 1, 19),
       ($1, 'tinderbox', 1, 20),
       ($1, 'cowhide', 1, 21),
       ($1, 'cowhide', 1, 22),
       ($1, 'cowhide', 1, 23)`,
      [PLAYER_ID],
    );
    await pool.query(`INSERT INTO characters (id, coins) VALUES ($1, 25)`, [
      PENDING_PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex") VALUES
       ($1, 'bronze_bar', 1, 0), ($1, 'bronze_bar', 1, 1),
       ($1, 'hammer', 1, 2)`,
      [PENDING_PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO characters (id, coins) VALUES ($1, 0), ($2, 5)`,
      [SMELTING_REQUEST_PLAYER_ID, TANNING_REQUEST_PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex") VALUES
       ($1, 'iron_ore', 1, 0), ($2, 'cowhide', 1, 0)`,
      [SMELTING_REQUEST_PLAYER_ID, TANNING_REQUEST_PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO characters (id, coins) VALUES ($1, 0), ($2, 0)`,
      [EMBEDDED_HOST_PLAYER_ID, EXTERNAL_HOST_PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex") VALUES
       ($1, 'logs', 1, 0), ($2, 'logs', 1, 0)`,
      [EMBEDDED_HOST_PLAYER_ID, EXTERNAL_HOST_PLAYER_ID],
    );
    const contentionCases = Array.from({ length: 25 }, (_, index) =>
      createProcessingContentionCase(index),
    );
    for (const testCase of contentionCases) {
      await pool.query(`INSERT INTO characters (id, coins) VALUES ($1, $2)`, [
        testCase.playerId,
        testCase.initialCoins,
      ]);
      for (const item of testCase.initialInventory) {
        await pool.query(
          `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
           VALUES ($1, $2, $3, $4)`,
          [testCase.playerId, item.itemId, item.quantity, item.slotIndex],
        );
      }
    }

    const initial = spawnWorker({
      connectionString,
      operationId: originalOperationId,
      hold: true,
    });
    const initialEvent = await initial.event;
    if (
      initialEvent.event !== "committed" ||
      initialEvent.replayed !== false ||
      initialEvent.currentXp !== 93 ||
      initialEvent.currentLevel !== 2
    ) {
      throw new Error(
        `initial processing failed: ${JSON.stringify(initialEvent)}`,
      );
    }
    initial.child.kill("SIGKILL");
    await waitForExit(initial.child);

    const restartedDb = drizzle(pool, { schema });
    const restartedDatabaseSystem = new DatabaseSystem({} as never);
    (restartedDatabaseSystem as unknown as { db: typeof restartedDb }).db =
      restartedDb;
    (restartedDatabaseSystem as unknown as { pool: pg.Pool }).pool = pool;

    let embeddedAgentHostRecoveredAfterKill = false;
    let externalAgentHostRecoveredAfterKill = false;
    for (const hostCase of [
      {
        host: "embedded" as const,
        playerId: EMBEDDED_HOST_PLAYER_ID,
        recipeId: "arrow_shaft",
        initialDispatchCount: 0,
      },
      {
        host: "external" as const,
        playerId: EXTERNAL_HOST_PLAYER_ID,
        recipeId: "arrow_shaft:logs",
        initialDispatchCount: 1,
      },
    ]) {
      const initialHost = spawnAgentHost({
        connectionString,
        playerId: hostCase.playerId,
        host: hostCase.host,
        recovering: false,
      });
      const admitted = await initialHost.event;
      if (
        admitted.event !== "agent_admitted" ||
        admitted.host !== hostCase.host ||
        typeof admitted.requestId !== "string" ||
        admitted.dispatchCount !== hostCase.initialDispatchCount
      ) {
        throw new Error(
          `${hostCase.host} agent host admission was not exact: ${JSON.stringify(admitted)}`,
        );
      }
      initialHost.child.kill("SIGKILL");
      await waitForExit(initialHost.child);
      if (initialHost.child.signalCode !== "SIGKILL") {
        throw new Error(
          `${hostCase.host} agent host was not killed by SIGKILL`,
        );
      }

      const interrupted =
        await restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
          hostCase.playerId,
        );
      if (
        interrupted?.requestId !== admitted.requestId ||
        interrupted.status !== "interrupted" ||
        interrupted.skill !== "fletching" ||
        interrupted.envelope.skill !== "fletching" ||
        interrupted.envelope.recipeId !== hostCase.recipeId ||
        interrupted.envelope.quantity !== 1
      ) {
        throw new Error(
          `${hostCase.host} agent host waiter did not survive SIGKILL`,
        );
      }

      const replacementHost = spawnAgentHost({
        connectionString,
        playerId: hostCase.playerId,
        host: hostCase.host,
        recovering: true,
      });
      const ready = await replacementHost.event;
      await waitForExit(replacementHost.child);
      if (
        replacementHost.child.exitCode !== 0 ||
        ready.event !== "agent_ready" ||
        ready.host !== hostCase.host ||
        ready.requestId !== admitted.requestId ||
        ready.dispatchCount !== 1
      ) {
        throw new Error(
          `${hostCase.host} replacement did not recover exactly: ${JSON.stringify(ready)}`,
        );
      }

      const operationId = `processing-request:fletching:${admitted.requestId}`;
      const [status, cleared, characterState, inventoryState, receiptState] =
        await Promise.all([
          restartedDatabaseSystem.getProcessingActionCommitStatusAsync(
            hostCase.playerId,
            operationId,
          ),
          restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
            hostCase.playerId,
          ),
          pool.query<{ fletchingXp: number; fletchingLevel: number }>(
            `SELECT "fletchingXp", "fletchingLevel" FROM characters WHERE id = $1`,
            [hostCase.playerId],
          ),
          pool.query<{
            itemId: string;
            quantity: number;
            slotIndex: number;
          }>(
            `SELECT "itemId", quantity, "slotIndex" FROM inventory
             WHERE "playerId" = $1 ORDER BY "slotIndex", "itemId"`,
            [hostCase.playerId],
          ),
          pool.query<{
            actionCount: string;
            waiterCompleted: boolean;
            waiterState: { acknowledgedAt?: unknown } | null;
          }>(
            `SELECT
               COUNT(*) FILTER (WHERE "operationType" = 'processing_action')::text AS "actionCount",
               BOOL_OR(completed) FILTER (WHERE "operationType" = 'processing_waiter') AS "waiterCompleted",
               (ARRAY_AGG("operationState") FILTER (WHERE "operationType" = 'processing_waiter'))[1] AS "waiterState"
             FROM operations_log WHERE "playerId" = $1`,
            [hostCase.playerId],
          ),
        ]);
      const duplicateAcknowledgement =
        await restartedDatabaseSystem.acknowledgeProcessingRequestAsync(
          hostCase.playerId,
          admitted.requestId,
        );
      if (
        status !== "committed" ||
        cleared !== null ||
        characterState.rows[0]?.fletchingXp !== 5 ||
        characterState.rows[0]?.fletchingLevel !== 1 ||
        JSON.stringify(inventoryState.rows) !==
          JSON.stringify([
            { itemId: "arrow_shaft", quantity: 15, slotIndex: 0 },
          ]) ||
        receiptState.rows[0]?.actionCount !== "1" ||
        receiptState.rows[0]?.waiterCompleted !== true ||
        typeof receiptState.rows[0]?.waiterState?.acknowledgedAt !== "number" ||
        !duplicateAcknowledgement ||
        (await restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
          hostCase.playerId,
        )) !== null
      ) {
        throw new Error(
          `${hostCase.host} agent host recovery did not conserve custody exactly`,
        );
      }
      if (hostCase.host === "embedded") {
        embeddedAgentHostRecoveredAfterKill = true;
      } else {
        externalAgentHostRecoveredAfterKill = true;
      }
    }

    const contentionGroups = Array.from(
      { length: 5 },
      () => [] as ProcessingContentionCase[],
    );
    for (const [index, testCase] of contentionCases.entries()) {
      contentionGroups[index % contentionGroups.length]?.push(testCase);
    }
    const contentionWorkers = contentionGroups.map((cases) =>
      spawnContentionWorker({ connectionString, cases }),
    );
    const contentionEvents = await Promise.all(
      contentionWorkers.map((worker) => worker.event),
    );
    await Promise.all(
      contentionWorkers.map(async (worker) => {
        await waitForExit(worker.child);
        if (worker.child.exitCode !== 0) {
          throw new Error("processing contention worker did not exit cleanly");
        }
      }),
    );
    const contentionResults = contentionEvents.flatMap(
      (event) => event.contentionResults ?? [],
    );
    const resultByPlayer = new Map(
      contentionResults.map((result) => [result.playerId, result]),
    );
    if (
      contentionResults.length !== contentionCases.length ||
      resultByPlayer.size !== contentionCases.length
    ) {
      throw new Error("processing contention results were incomplete");
    }
    const contentionDurations = contentionResults
      .map((result) => result.durationMs)
      .sort((left, right) => left - right);
    const contentionP95Ms =
      contentionDurations[
        Math.min(
          contentionDurations.length - 1,
          Math.ceil(contentionDurations.length * 0.95) - 1,
        )
      ] ?? Number.POSITIVE_INFINITY;
    const contentionMaxMs =
      contentionDurations[contentionDurations.length - 1] ??
      Number.POSITIVE_INFINITY;
    if (contentionMaxMs > 5_000) {
      throw new Error(
        `processing contention exceeded the 5s local custody bound: ${contentionMaxMs.toFixed(1)}ms`,
      );
    }

    await Promise.all(
      contentionCases.map(async (testCase) => {
        const result = resultByPlayer.get(testCase.playerId);
        if (
          result?.requestId !== testCase.requestId ||
          result.skill !== testCase.skill ||
          !result.acknowledged ||
          !result.cleared
        ) {
          throw new Error(
            `${testCase.playerId} contention worker result was not exact`,
          );
        }
        const [characterState, inventoryState, receiptState, recovery] =
          await Promise.all([
            pool.query<{
              coins: number;
              firemakingXp: number;
              cookingXp: number;
              smithingXp: number;
              craftingXp: number;
              fletchingXp: number;
              runecraftingXp: number;
              consumableUses: unknown;
            }>(
              `SELECT coins, "firemakingXp", "cookingXp", "smithingXp",
                      "craftingXp", "fletchingXp", "runecraftingXp",
                      "processingConsumableUses" AS "consumableUses"
               FROM characters WHERE id = $1`,
              [testCase.playerId],
            ),
            pool.query<{
              itemId: string;
              quantity: number;
              slotIndex: number;
            }>(
              `SELECT "itemId", quantity, "slotIndex" FROM inventory
               WHERE "playerId" = $1 ORDER BY "slotIndex", "itemId"`,
              [testCase.playerId],
            ),
            pool.query<{
              actionCount: string;
              waiterCount: string;
              waiterCompleted: boolean;
              waiterState: { acknowledgedAt?: unknown } | null;
            }>(
              `SELECT
                 COUNT(*) FILTER (WHERE "operationType" = 'processing_action')::text AS "actionCount",
                 COUNT(*) FILTER (WHERE "operationType" = 'processing_waiter')::text AS "waiterCount",
                 BOOL_OR(completed) FILTER (WHERE "operationType" = 'processing_waiter') AS "waiterCompleted",
                 (ARRAY_AGG("operationState") FILTER (WHERE "operationType" = 'processing_waiter'))[1] AS "waiterState"
               FROM operations_log WHERE "playerId" = $1`,
              [testCase.playerId],
            ),
            restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
              testCase.playerId,
            ),
          ]);
        const character = characterState.rows[0];
        if (
          !character ||
          character.coins !== testCase.expectedCoins ||
          character[testCase.xpColumn] !== testCase.expectedXp ||
          JSON.stringify(inventoryState.rows) !==
            JSON.stringify(testCase.expectedInventory) ||
          receiptState.rows[0]?.actionCount !== "1" ||
          receiptState.rows[0]?.waiterCount !== "1" ||
          receiptState.rows[0]?.waiterCompleted !== true ||
          typeof receiptState.rows[0]?.waiterState?.acknowledgedAt !==
            "number" ||
          recovery !== null ||
          (testCase.skill === "crafting" &&
            JSON.stringify(character.consumableUses) !==
              JSON.stringify({
                thread: {
                  usesPerItem: 5,
                  remainingUses: 4,
                },
              }))
        ) {
          throw new Error(
            `${testCase.playerId} contention custody leaked or duplicated`,
          );
        }
      }),
    );
    const contentionFireCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM processing_active_fires
       WHERE player_id LIKE 'processing-contention-agent-%'
         AND extinguished_at IS NULL`,
    );
    const expectedContentionFires = contentionCases.filter(
      (testCase) => testCase.skill === "firemaking",
    ).length;
    if (
      contentionFireCount.rows[0]?.count !== String(expectedContentionFires)
    ) {
      throw new Error("processing contention fire effects were not isolated");
    }

    const smeltingAdmission =
      await restartedDatabaseSystem.beginProcessingRequestAsync(
        SMELTING_REQUEST_PLAYER_ID,
        smeltingRequestOperationId,
        smeltingRequestId,
        "smelting",
        {
          skill: "smelting",
          barItemId: "iron_bar",
          furnaceId: "furnace-chaos",
          quantity: 1,
        },
      );
    const smeltingReceipt =
      await restartedDatabaseSystem.commitProcessingActionOperationAsync(
        requestFor(smeltingRequestOperationId, SMELTING_REQUEST_INPUT),
      );
    const smeltingStatus =
      await restartedDatabaseSystem.getProcessingActionCommitStatusAsync(
        SMELTING_REQUEST_PLAYER_ID,
        smeltingRequestOperationId,
      );
    if (
      smeltingAdmission !== "accepted" ||
      smeltingReceipt.replayed ||
      smeltingStatus !== "committed" ||
      smeltingReceipt.skill !== "smithing" ||
      smeltingReceipt.currentXp !== 7.5 ||
      smeltingReceipt.committed.some((item) => item.itemId === "iron_ore") ||
      smeltingReceipt.committed.find((item) => item.itemId === "iron_bar")
        ?.quantity !== 1
    ) {
      throw new Error(
        "smelting request did not map to smithing custody exactly",
      );
    }
    const smeltingRecovery =
      await restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
        SMELTING_REQUEST_PLAYER_ID,
      );
    const smeltingAcknowledged =
      await restartedDatabaseSystem.acknowledgeProcessingRequestAsync(
        SMELTING_REQUEST_PLAYER_ID,
        smeltingRequestId,
      );
    if (
      smeltingRecovery?.status !== "committed" ||
      smeltingRecovery.skill !== "smelting" ||
      smeltingRecovery.envelope.skill !== "smelting" ||
      !smeltingAcknowledged ||
      (await restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
        SMELTING_REQUEST_PLAYER_ID,
      )) !== null
    ) {
      throw new Error("smelting waiter did not acknowledge exactly once");
    }

    const tanningAdmission =
      await restartedDatabaseSystem.beginProcessingRequestAsync(
        TANNING_REQUEST_PLAYER_ID,
        tanningRequestOperationId,
        tanningRequestId,
        "tanning",
        {
          skill: "tanning",
          inputItemId: "cowhide",
          quantity: 1,
          tannerEntityId: "tanner-chaos",
          tannerNpcId: "tanner",
        },
      );
    const tanningReceipt =
      await restartedDatabaseSystem.commitProcessingActionOperationAsync(
        requestFor(tanningRequestOperationId, TANNING_REQUEST_INPUT),
      );
    const tanningStatus =
      await restartedDatabaseSystem.getProcessingActionCommitStatusAsync(
        TANNING_REQUEST_PLAYER_ID,
        tanningRequestOperationId,
      );
    if (
      tanningAdmission !== "accepted" ||
      tanningReceipt.replayed ||
      tanningStatus !== "committed" ||
      tanningReceipt.skill !== "crafting" ||
      tanningReceipt.currentCoins !== 4 ||
      tanningReceipt.committed.some((item) => item.itemId === "cowhide") ||
      tanningReceipt.committed.find((item) => item.itemId === "leather")
        ?.quantity !== 1
    ) {
      throw new Error(
        "tanning request did not map to crafting custody exactly",
      );
    }
    const tanningRecovery =
      await restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
        TANNING_REQUEST_PLAYER_ID,
      );
    const tanningAcknowledged =
      await restartedDatabaseSystem.acknowledgeProcessingRequestAsync(
        TANNING_REQUEST_PLAYER_ID,
        tanningRequestId,
      );
    if (
      tanningRecovery?.status !== "committed" ||
      tanningRecovery.skill !== "tanning" ||
      tanningRecovery.envelope.skill !== "tanning" ||
      !tanningAcknowledged ||
      (await restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
        TANNING_REQUEST_PLAYER_ID,
      )) !== null
    ) {
      throw new Error("tanning waiter did not acknowledge exactly once");
    }

    const abandonedAdmission = spawnWorker({
      connectionString,
      operationId: pendingOperationId,
      request: PENDING_INPUT,
      admissionOnly: true,
      hold: true,
    });
    const abandonedAdmissionEvent = await abandonedAdmission.event;
    if (
      abandonedAdmissionEvent.event !== "admitted" ||
      abandonedAdmissionEvent.admission !== "accepted"
    ) {
      throw new Error(
        `pre-commit admission failed: ${JSON.stringify(abandonedAdmissionEvent)}`,
      );
    }
    abandonedAdmission.child.kill("SIGKILL");
    await waitForExit(abandonedAdmission.child);

    const interruptedStatus =
      await restartedDatabaseSystem.getProcessingActionCommitStatusAsync(
        PENDING_PLAYER_ID,
        pendingOperationId,
      );
    const interruptedRecovery =
      await restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
        PENDING_PLAYER_ID,
      );
    const resumedAdmission =
      await restartedDatabaseSystem.beginProcessingRequestAsync(
        PENDING_PLAYER_ID,
        pendingOperationId,
        pendingRequestId,
        "smithing",
        {
          skill: "smithing",
          recipeId: "bronze_sword",
          anvilId: "anvil-chaos",
          quantity: 1,
        },
      );
    const duplicateAdmission =
      await restartedDatabaseSystem.beginProcessingRequestAsync(
        PENDING_PLAYER_ID,
        pendingOperationId,
        pendingRequestId,
        "smithing",
        {
          skill: "smithing",
          recipeId: "bronze_sword",
          anvilId: "anvil-chaos",
          quantity: 1,
        },
      );
    const competingRequestId = randomUUID();
    const competingAdmission =
      await restartedDatabaseSystem.beginProcessingRequestAsync(
        PENDING_PLAYER_ID,
        `processing-request:crafting:${competingRequestId}`,
        competingRequestId,
        "crafting",
        {
          skill: "crafting",
          recipeId: "leather_gloves",
          quantity: 1,
        },
      );
    if (
      interruptedStatus !== "interrupted" ||
      interruptedRecovery?.status !== "interrupted" ||
      interruptedRecovery.requestId !== pendingRequestId ||
      interruptedRecovery.skill !== "smithing" ||
      interruptedRecovery.envelope.skill !== "smithing" ||
      resumedAdmission !== "accepted" ||
      duplicateAdmission !== "pending" ||
      competingAdmission !== "busy"
    ) {
      throw new Error("pre-commit request ownership was not exact after kill");
    }

    const resumedReceipt =
      await restartedDatabaseSystem.commitProcessingActionOperationAsync(
        requestFor(pendingOperationId, PENDING_INPUT),
      );
    const resumedStatus =
      await restartedDatabaseSystem.getProcessingActionCommitStatusAsync(
        PENDING_PLAYER_ID,
        pendingOperationId,
      );
    const committedRecovery =
      await restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
        PENDING_PLAYER_ID,
      );
    const resumedAcknowledged =
      await restartedDatabaseSystem.acknowledgeProcessingRequestAsync(
        PENDING_PLAYER_ID,
        pendingRequestId,
      );
    const recoveryCleared =
      await restartedDatabaseSystem.getRecoverableProcessingRequestAsync(
        PENDING_PLAYER_ID,
      );
    if (
      resumedReceipt.replayed ||
      resumedStatus !== "committed" ||
      committedRecovery?.status !== "committed" ||
      !resumedAcknowledged ||
      recoveryCleared !== null
    ) {
      throw new Error("resumed pre-commit request did not commit exactly once");
    }

    const staleRequestId = randomUUID();
    const staleOperationId = `processing-request:crafting:${staleRequestId}`;
    const staleAuthority = new DatabaseSystem({} as never);
    (staleAuthority as unknown as { db: typeof restartedDb }).db = restartedDb;
    (staleAuthority as unknown as { pool: pg.Pool }).pool = pool;
    const replacementAuthority = new DatabaseSystem({} as never);
    (replacementAuthority as unknown as { db: typeof restartedDb }).db =
      restartedDb;
    (replacementAuthority as unknown as { pool: pg.Pool }).pool = pool;
    const staleAccepted = await staleAuthority.beginProcessingRequestAsync(
      PENDING_PLAYER_ID,
      staleOperationId,
      staleRequestId,
      "crafting",
      {
        skill: "crafting",
        recipeId: "leather_gloves",
        quantity: 1,
      },
    );
    const replacementAccepted =
      await replacementAuthority.beginProcessingRequestAsync(
        PENDING_PLAYER_ID,
        staleOperationId,
        staleRequestId,
        "crafting",
        {
          skill: "crafting",
          recipeId: "leather_gloves",
          quantity: 1,
        },
      );
    const [staleHeartbeat, staleRejection] = await Promise.all([
      staleAuthority.heartbeatProcessingRequestAsync(
        PENDING_PLAYER_ID,
        staleOperationId,
        staleRequestId,
        "crafting",
      ),
      staleAuthority.rejectProcessingRequestAsync(
        PENDING_PLAYER_ID,
        staleOperationId,
        staleRequestId,
        "crafting",
        "interrupted",
        true,
      ),
    ]);
    const replacementStillPending =
      await replacementAuthority.getProcessingActionCommitStatusAsync(
        PENDING_PLAYER_ID,
        staleOperationId,
      );
    const replacementRejected =
      await replacementAuthority.rejectProcessingRequestAsync(
        PENDING_PLAYER_ID,
        staleOperationId,
        staleRequestId,
        "crafting",
        "resources_unavailable",
        false,
      );
    const terminalRejection =
      await replacementAuthority.getProcessingActionCommitStatusAsync(
        PENDING_PLAYER_ID,
        staleOperationId,
      );
    const rejectedRecovery =
      await replacementAuthority.getRecoverableProcessingRequestAsync(
        PENDING_PLAYER_ID,
      );
    const rejectionAcknowledged =
      await replacementAuthority.acknowledgeProcessingRequestAsync(
        PENDING_PLAYER_ID,
        staleRequestId,
      );
    const rejectionRecoveryCleared =
      await replacementAuthority.getRecoverableProcessingRequestAsync(
        PENDING_PLAYER_ID,
      );
    if (
      staleAccepted !== "accepted" ||
      replacementAccepted !== "accepted" ||
      staleHeartbeat !== false ||
      staleRejection !== false ||
      replacementStillPending !== "pending" ||
      replacementRejected !== true ||
      terminalRejection !== "rejected" ||
      rejectedRecovery?.status !== "rejected" ||
      !rejectionAcknowledged ||
      rejectionRecoveryCleared !== null
    ) {
      throw new Error("stale processing authority overwrote replacement truth");
    }
    const committedStatus =
      await restartedDatabaseSystem.getProcessingActionCommitStatusAsync(
        PLAYER_ID,
        originalOperationId,
      );
    const foreignStatus =
      await restartedDatabaseSystem.getProcessingActionCommitStatusAsync(
        "other-player",
        originalOperationId,
      );
    const missingStatus =
      await restartedDatabaseSystem.getProcessingActionCommitStatusAsync(
        PLAYER_ID,
        `processing-request:smithing:${randomUUID()}`,
      );
    if (
      committedStatus !== "committed" ||
      foreignStatus !== "not_found" ||
      missingStatus !== "not_found"
    ) {
      throw new Error("durable processing request status was not exact");
    }

    const replay = spawnWorker({
      connectionString,
      operationId: originalOperationId,
    });
    const replayEvent = await replay.event;
    await waitForExit(replay.child);
    if (
      replayEvent.event !== "committed" ||
      !replayEvent.replayed ||
      replayEvent.currentXp !== 93
    ) {
      throw new Error(`durable replay failed: ${JSON.stringify(replayEvent)}`);
    }

    const collision = spawnWorker({
      connectionString,
      operationId: originalOperationId,
      request: {
        ...BASE_INPUT,
        outputs: [{ itemId: "bronze_dagger", quantity: 1, stackable: false }],
      },
    });
    const collisionEvent = await collision.event;
    await waitForExit(collision.child);
    if (
      collisionEvent.event !== "error" ||
      !collisionEvent.message?.includes(
        "processing_action_operation_id_conflict",
      )
    ) {
      throw new Error(
        `collision was not rejected: ${JSON.stringify(collisionEvent)}`,
      );
    }

    const later = spawnWorker({ connectionString, operationId: randomUUID() });
    const laterEvent = await later.event;
    await waitForExit(later.child);
    if (laterEvent.event !== "committed" || laterEvent.currentXp !== 105.5) {
      throw new Error(`later processing failed: ${JSON.stringify(laterEvent)}`);
    }

    const missing = spawnWorker({
      connectionString,
      operationId: randomUUID(),
    });
    const missingEvent = await missing.event;
    await waitForExit(missing.child);
    if (
      missingEvent.event !== "error" ||
      !missingEvent.message?.includes("processing_action_insufficient_items")
    ) {
      throw new Error(
        `missing-input rollback failed: ${JSON.stringify(missingEvent)}`,
      );
    }

    const failedSmelt = spawnWorker({
      connectionString,
      operationId: failedSmeltOperationId,
      request: FAILED_SMELT_INPUT,
      hold: true,
    });
    const failedSmeltEvent = await failedSmelt.event;
    if (
      failedSmeltEvent.event !== "committed" ||
      failedSmeltEvent.replayed !== false ||
      failedSmeltEvent.currentXp !== 105.5 ||
      failedSmeltEvent.inventory?.some((item) => item.itemId === "iron_ore")
    ) {
      throw new Error(
        `failed-smelt debit was not atomic: ${JSON.stringify(failedSmeltEvent)}`,
      );
    }
    failedSmelt.child.kill("SIGKILL");
    await waitForExit(failedSmelt.child);

    const failedSmeltReplay = spawnWorker({
      connectionString,
      operationId: failedSmeltOperationId,
      request: FAILED_SMELT_INPUT,
    });
    const failedSmeltReplayEvent = await failedSmeltReplay.event;
    await waitForExit(failedSmeltReplay.child);
    if (
      failedSmeltReplayEvent.event !== "committed" ||
      failedSmeltReplayEvent.replayed !== true ||
      failedSmeltReplayEvent.currentXp !== 105.5 ||
      failedSmeltReplayEvent.inventory?.some(
        (item) => item.itemId === "iron_ore",
      )
    ) {
      throw new Error(
        `failed-smelt replay was not exact: ${JSON.stringify(failedSmeltReplayEvent)}`,
      );
    }

    for (let index = 0; index < craftingOperationIds.length; index++) {
      const operationId = craftingOperationIds[index];
      const isFinalUse = index === craftingOperationIds.length - 1;
      const craft = spawnWorker({
        connectionString,
        operationId,
        request: CRAFT_INPUT,
        hold: isFinalUse,
      });
      const craftEvent = await craft.event;
      if (!isFinalUse) await waitForExit(craft.child);
      const expectedRemainingUses = 4 - index;
      const expectedXp = 13.8 * (index + 1);
      const expectedConsumableState = {
        itemId: "thread",
        usesPerItem: 5,
        remainingUses: Math.max(0, expectedRemainingUses),
        consumedQuantity: isFinalUse ? (1 as const) : (0 as const),
      };
      if (
        craftEvent.event !== "committed" ||
        craftEvent.replayed !== false ||
        Math.abs((craftEvent.currentXp ?? Number.NaN) - expectedXp) > 1e-9 ||
        JSON.stringify(craftEvent.consumableStates) !==
          JSON.stringify([expectedConsumableState])
      ) {
        throw new Error(
          `crafting use ${index + 1} was not atomic: ${JSON.stringify(craftEvent)}`,
        );
      }
      const [storedState, threadBalance] = await Promise.all([
        pool.query<{ uses: unknown }>(
          `SELECT "processingConsumableUses" AS uses FROM characters WHERE id = $1`,
          [PLAYER_ID],
        ),
        pool.query<{ quantity: string }>(
          `SELECT COALESCE(SUM(quantity), 0)::text AS quantity FROM inventory
           WHERE "playerId" = $1 AND "itemId" = 'thread'`,
          [PLAYER_ID],
        ),
      ]);
      const expectedStoredState = isFinalUse
        ? {}
        : {
            thread: {
              usesPerItem: 5,
              remainingUses: expectedRemainingUses,
            },
          };
      if (
        JSON.stringify(storedState.rows[0]?.uses) !==
          JSON.stringify(expectedStoredState) ||
        Number(threadBalance.rows[0]?.quantity) !== (isFinalUse ? 0 : 1)
      ) {
        throw new Error(
          `crafting use ${index + 1} did not persist exact thread custody`,
        );
      }
      if (isFinalUse) {
        craft.child.kill("SIGKILL");
        await waitForExit(craft.child);
      }
    }

    const finalCraftReplay = spawnWorker({
      connectionString,
      operationId: craftingOperationIds[4],
      request: CRAFT_INPUT,
    });
    const finalCraftReplayEvent = await finalCraftReplay.event;
    await waitForExit(finalCraftReplay.child);
    if (
      finalCraftReplayEvent.event !== "committed" ||
      finalCraftReplayEvent.replayed !== true ||
      Math.abs((finalCraftReplayEvent.currentXp ?? Number.NaN) - 69) > 1e-9 ||
      JSON.stringify(finalCraftReplayEvent.consumableStates) !==
        JSON.stringify([
          {
            itemId: "thread",
            usesPerItem: 5,
            remainingUses: 0,
            consumedQuantity: 1,
          },
        ])
    ) {
      throw new Error(
        `final crafting use replay was not exact: ${JSON.stringify(finalCraftReplayEvent)}`,
      );
    }

    const missingConsumable = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      request: CRAFT_INPUT,
    });
    const missingConsumableEvent = await missingConsumable.event;
    await waitForExit(missingConsumable.child);
    if (
      missingConsumableEvent.event !== "error" ||
      !missingConsumableEvent.message?.includes(
        "processing_action_insufficient_items",
      )
    ) {
      throw new Error(
        `missing-consumable rollback failed: ${JSON.stringify(missingConsumableEvent)}`,
      );
    }

    const fletch = spawnWorker({
      connectionString,
      operationId: fletchingOperationId,
      request: FLETCH_INPUT,
      hold: true,
    });
    const fletchEvent = await fletch.event;
    if (
      fletchEvent.event !== "committed" ||
      fletchEvent.replayed !== false ||
      fletchEvent.currentXp !== 19.5 ||
      fletchEvent.inventory?.find((item) => item.itemId === "bronze_arrow")
        ?.quantity !== 15 ||
      fletchEvent.inventory?.some(
        (item) =>
          item.itemId === "bronze_arrowtips" ||
          item.itemId === "headless_arrow",
      )
    ) {
      throw new Error(
        `multi-output fletching was not atomic: ${JSON.stringify(fletchEvent)}`,
      );
    }
    fletch.child.kill("SIGKILL");
    await waitForExit(fletch.child);

    const fletchReplay = spawnWorker({
      connectionString,
      operationId: fletchingOperationId,
      request: FLETCH_INPUT,
    });
    const fletchReplayEvent = await fletchReplay.event;
    await waitForExit(fletchReplay.child);
    if (
      fletchReplayEvent.event !== "committed" ||
      fletchReplayEvent.replayed !== true ||
      fletchReplayEvent.currentXp !== 19.5 ||
      fletchReplayEvent.inventory?.filter(
        (item) => item.itemId === "bronze_arrow",
      ).length !== 1 ||
      fletchReplayEvent.inventory?.find(
        (item) => item.itemId === "bronze_arrow",
      )?.quantity !== 15
    ) {
      throw new Error(
        `multi-output fletching replay was not exact: ${JSON.stringify(fletchReplayEvent)}`,
      );
    }

    const runecraft = spawnWorker({
      connectionString,
      operationId: runecraftingOperationId,
      request: RUNECRAFT_INPUT,
      hold: true,
    });
    const runecraftEvent = await runecraft.event;
    if (
      runecraftEvent.event !== "committed" ||
      runecraftEvent.replayed !== false ||
      runecraftEvent.currentXp !== 27.5 ||
      runecraftEvent.inventory?.find((item) => item.itemId === "mind_rune")
        ?.quantity !== 5 ||
      runecraftEvent.inventory?.some(
        (item) =>
          item.itemId === "pure_essence" || item.itemId === "rune_essence",
      )
    ) {
      throw new Error(
        `mixed-essence runecrafting was not atomic: ${JSON.stringify(runecraftEvent)}`,
      );
    }
    runecraft.child.kill("SIGKILL");
    await waitForExit(runecraft.child);

    const runecraftReplay = spawnWorker({
      connectionString,
      operationId: runecraftingOperationId,
      request: RUNECRAFT_INPUT,
    });
    const runecraftReplayEvent = await runecraftReplay.event;
    await waitForExit(runecraftReplay.child);
    if (
      runecraftReplayEvent.event !== "committed" ||
      runecraftReplayEvent.replayed !== true ||
      runecraftReplayEvent.currentXp !== 27.5 ||
      runecraftReplayEvent.inventory?.filter(
        (item) => item.itemId === "mind_rune",
      ).length !== 1 ||
      runecraftReplayEvent.inventory?.find(
        (item) => item.itemId === "mind_rune",
      )?.quantity !== 5
    ) {
      throw new Error(
        `mixed-essence runecrafting replay was not exact: ${JSON.stringify(runecraftReplayEvent)}`,
      );
    }

    const missingRunecraftingInputs = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      request: RUNECRAFT_INPUT,
    });
    const missingRunecraftingInputsEvent =
      await missingRunecraftingInputs.event;
    await waitForExit(missingRunecraftingInputs.child);
    if (
      missingRunecraftingInputsEvent.event !== "error" ||
      !missingRunecraftingInputsEvent.message?.includes(
        "processing_action_insufficient_items",
      )
    ) {
      throw new Error(
        `missing runecrafting inputs did not roll back: ${JSON.stringify(missingRunecraftingInputsEvent)}`,
      );
    }

    await pool.query(
      `INSERT INTO quest_progress
         ("playerId", "questId", status, "currentStage", "stageProgress", "startedAt")
       VALUES ($1, 'fresh_catch', 'in_progress', 'cook_shrimp',
               '{"shrimp":5}'::jsonb, $2)`,
      [PLAYER_ID, 1_786_392_000_000],
    );

    const cook = spawnWorker({
      connectionString,
      operationId: cookingOperationId,
      request: COOK_INPUT,
      hold: true,
    });
    const cookEvent = await cook.event;
    if (
      cookEvent.event !== "committed" ||
      cookEvent.replayed !== false ||
      cookEvent.currentXp !== 30 ||
      cookEvent.inventory?.filter((item) => item.itemId === "shrimp").length !==
        1 ||
      cookEvent.inventory?.some((item) => item.itemId === "raw_shrimp")
    ) {
      throw new Error(
        `successful cooking was not atomic: ${JSON.stringify(cookEvent)}`,
      );
    }
    cook.child.kill("SIGKILL");
    await waitForExit(cook.child);

    const questRecovery = spawnQuestRecovery(connectionString);
    const questRecoveryEvent = await questRecovery.event;
    await waitForExit(questRecovery.child);
    const durableProcessingQuestRecoveredAfterKill =
      questRecoveryEvent.event === "quest_recovered" &&
      questRecoveryEvent.questStage === "cook_shrimp" &&
      questRecoveryEvent.questProgress?.shrimp === 6 &&
      questRecoveryEvent.pendingQuestReceipts === 0;
    if (!durableProcessingQuestRecoveredAfterKill) {
      throw new Error(
        `committed processing quest edge did not survive process kill: ${JSON.stringify(questRecoveryEvent)}`,
      );
    }
    const questRepository = new QuestRepository(restartedDb, pool);
    await questRepository.completeQuest(PLAYER_ID, "fresh_catch");

    const cookReplay = spawnWorker({
      connectionString,
      operationId: cookingOperationId,
      request: COOK_INPUT,
    });
    const cookReplayEvent = await cookReplay.event;
    await waitForExit(cookReplay.child);
    if (
      cookReplayEvent.event !== "committed" ||
      cookReplayEvent.replayed !== true ||
      cookReplayEvent.currentXp !== 30 ||
      cookReplayEvent.inventory?.filter((item) => item.itemId === "shrimp")
        .length !== 1
    ) {
      throw new Error(
        `successful cooking replay was not exact: ${JSON.stringify(cookReplayEvent)}`,
      );
    }

    const burntCook = spawnWorker({
      connectionString,
      operationId: burntCookingOperationId,
      request: BURNT_COOK_INPUT,
      hold: true,
    });
    const burntCookEvent = await burntCook.event;
    if (
      burntCookEvent.event !== "committed" ||
      burntCookEvent.replayed !== false ||
      burntCookEvent.currentXp !== 30 ||
      burntCookEvent.inventory?.filter(
        (item) => item.itemId === "burnt_anchovies",
      ).length !== 1 ||
      burntCookEvent.inventory?.some((item) => item.itemId === "raw_anchovies")
    ) {
      throw new Error(
        `burnt cooking outcome was not atomic: ${JSON.stringify(burntCookEvent)}`,
      );
    }
    burntCook.child.kill("SIGKILL");
    await waitForExit(burntCook.child);

    const burntCookReplay = spawnWorker({
      connectionString,
      operationId: burntCookingOperationId,
      request: BURNT_COOK_INPUT,
    });
    const burntCookReplayEvent = await burntCookReplay.event;
    await waitForExit(burntCookReplay.child);
    if (
      burntCookReplayEvent.event !== "committed" ||
      burntCookReplayEvent.replayed !== true ||
      burntCookReplayEvent.currentXp !== 30 ||
      burntCookReplayEvent.inventory?.filter(
        (item) => item.itemId === "burnt_anchovies",
      ).length !== 1
    ) {
      throw new Error(
        `burnt cooking replay was not exact: ${JSON.stringify(burntCookReplayEvent)}`,
      );
    }

    const firemake = spawnWorker({
      connectionString,
      operationId: firemakingOperationId,
      request: FIREMAKE_INPUT,
      hold: true,
    });
    const firemakeEvent = await firemake.event;
    if (
      firemakeEvent.event !== "committed" ||
      firemakeEvent.replayed !== false ||
      firemakeEvent.currentXp !== 40 ||
      firemakeEvent.worldEffect?.fireId !== "fire_process-kill" ||
      firemakeEvent.worldEffect.expiresAt -
        firemakeEvent.worldEffect.createdAt !==
        60_000 ||
      firemakeEvent.inventory?.some((item) => item.itemId === "logs") ||
      firemakeEvent.inventory?.filter((item) => item.itemId === "tinderbox")
        .length !== 1
    ) {
      throw new Error(
        `firemaking debit and XP were not atomic: ${JSON.stringify(firemakeEvent)}`,
      );
    }
    firemake.child.kill("SIGKILL");
    await waitForExit(firemake.child);

    const recoveredFires =
      await restartedDatabaseSystem.getActiveProcessingFiresAsync();
    const recoveredFire = recoveredFires.find(
      (fire) => fire.fireId === "fire_process-kill",
    );
    if (
      !recoveredFire ||
      recoveredFire.playerId !== PLAYER_ID ||
      recoveredFire.tile.x !== 10 ||
      recoveredFire.tile.z !== 20 ||
      recoveredFire.expiresAt - recoveredFire.createdAt !== 60_000
    ) {
      throw new Error(
        `committed fire did not survive process kill: ${JSON.stringify(recoveredFires)}`,
      );
    }

    const firemakeReplay = spawnWorker({
      connectionString,
      operationId: firemakingOperationId,
      request: FIREMAKE_INPUT,
    });
    const firemakeReplayEvent = await firemakeReplay.event;
    await waitForExit(firemakeReplay.child);
    if (
      firemakeReplayEvent.event !== "committed" ||
      firemakeReplayEvent.replayed !== true ||
      firemakeReplayEvent.currentXp !== 40 ||
      firemakeReplayEvent.worldEffect?.fireId !== "fire_process-kill" ||
      firemakeReplayEvent.inventory?.some((item) => item.itemId === "logs") ||
      firemakeReplayEvent.inventory?.filter(
        (item) => item.itemId === "tinderbox",
      ).length !== 1
    ) {
      throw new Error(
        `firemaking replay was not exact: ${JSON.stringify(firemakeReplayEvent)}`,
      );
    }

    await pool.query(
      `INSERT INTO characters (id) VALUES ('fire-contender-a'), ('fire-contender-b')`,
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex") VALUES
       ('fire-contender-a', 'logs', 1, 0),
       ('fire-contender-a', 'tinderbox', 1, 1),
       ('fire-contender-b', 'logs', 1, 0),
       ('fire-contender-b', 'tinderbox', 1, 1)`,
    );
    const contenderA = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      request: firemakeInput("fire-contender-a", "fire_contender-a", {
        x: 30,
        z: 31,
      }),
    });
    const contenderB = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      request: firemakeInput("fire-contender-b", "fire_contender-b", {
        x: 30,
        z: 31,
      }),
    });
    const [contenderAEvent, contenderBEvent] = await Promise.all([
      contenderA.event,
      contenderB.event,
    ]);
    await Promise.all([
      waitForExit(contenderA.child),
      waitForExit(contenderB.child),
    ]);
    const contenderEvents = [contenderAEvent, contenderBEvent];
    if (
      contenderEvents.filter((event) => event.event === "committed").length !==
        1 ||
      contenderEvents.filter(
        (event) =>
          event.event === "error" &&
          event.message?.includes("processing_action_fire_tile_occupied"),
      ).length !== 1
    ) {
      throw new Error(
        `concurrent fire tile arbitration was not exact: ${JSON.stringify(contenderEvents)}`,
      );
    }
    const contenderFires = (
      await restartedDatabaseSystem.getActiveProcessingFiresAsync()
    ).filter((fire) => fire.tile.x === 30 && fire.tile.z === 31);
    if (contenderFires.length !== 1) {
      throw new Error(
        "concurrent fire tile created more than one active effect",
      );
    }

    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex") VALUES
       ($1, 'logs', 1, 24), ($1, 'logs', 1, 25), ($1, 'logs', 1, 26)`,
      [PLAYER_ID],
    );
    for (const [index, tileX] of [11, 12].entries()) {
      const extra = spawnWorker({
        connectionString,
        operationId: randomUUID(),
        request: firemakeInput(PLAYER_ID, `fire_capacity-${index + 1}`, {
          x: tileX,
          z: 20,
        }),
      });
      const event = await extra.event;
      await waitForExit(extra.child);
      if (event.event !== "committed") {
        throw new Error(`fire capacity setup failed: ${JSON.stringify(event)}`);
      }
    }
    const overCapacity = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      request: firemakeInput(PLAYER_ID, "fire_capacity-rejected", {
        x: 13,
        z: 20,
      }),
    });
    const overCapacityEvent = await overCapacity.event;
    await waitForExit(overCapacity.child);
    if (
      overCapacityEvent.event !== "error" ||
      !overCapacityEvent.message?.includes(
        "processing_action_fire_capacity_reached",
      )
    ) {
      throw new Error(
        `per-player fire capacity was not enforced: ${JSON.stringify(overCapacityEvent)}`,
      );
    }
    const mainActiveFires = (
      await restartedDatabaseSystem.getActiveProcessingFiresAsync()
    ).filter((fire) => fire.playerId === PLAYER_ID);
    if (mainActiveFires.length !== 3) {
      throw new Error(
        `per-player active fire count drifted: ${JSON.stringify(mainActiveFires)}`,
      );
    }
    const firstExtinguish =
      await restartedDatabaseSystem.markProcessingFireExtinguishedAsync(
        "fire_process-kill",
      );
    const repeatedExtinguish =
      await restartedDatabaseSystem.markProcessingFireExtinguishedAsync(
        "fire_process-kill",
      );
    if (!firstExtinguish || repeatedExtinguish) {
      throw new Error("fire extinguish transition was not idempotent");
    }

    const tanning = spawnWorker({
      connectionString,
      operationId: tanningOperationId,
      request: TANNING_INPUT,
      hold: true,
    });
    const tanningEvent = await tanning.event;
    if (
      tanningEvent.event !== "committed" ||
      tanningEvent.replayed !== false ||
      tanningEvent.currentCoins !== 98 ||
      tanningEvent.inventory?.filter((item) => item.itemId === "leather")
        .length !== 2 ||
      tanningEvent.inventory?.filter((item) => item.itemId === "cowhide")
        .length !== 1
    ) {
      throw new Error(
        `tanning hide, output, and coin debit were not atomic: ${JSON.stringify(tanningEvent)}`,
      );
    }
    tanning.child.kill("SIGKILL");
    await waitForExit(tanning.child);

    const tanningReplay = spawnWorker({
      connectionString,
      operationId: tanningOperationId,
      request: TANNING_INPUT,
    });
    const tanningReplayEvent = await tanningReplay.event;
    await waitForExit(tanningReplay.child);
    if (
      tanningReplayEvent.event !== "committed" ||
      tanningReplayEvent.replayed !== true ||
      tanningReplayEvent.currentCoins !== 98 ||
      tanningReplayEvent.inventory?.filter((item) => item.itemId === "leather")
        .length !== 2 ||
      tanningReplayEvent.inventory?.filter((item) => item.itemId === "cowhide")
        .length !== 1
    ) {
      throw new Error(
        `tanning replay was not exact: ${JSON.stringify(tanningReplayEvent)}`,
      );
    }

    const unaffordableTanning = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      request: UNAFFORDABLE_TANNING_INPUT,
    });
    const unaffordableTanningEvent = await unaffordableTanning.event;
    await waitForExit(unaffordableTanning.child);
    if (
      unaffordableTanningEvent.event !== "error" ||
      !unaffordableTanningEvent.message?.includes(
        "processing_action_insufficient_coins",
      )
    ) {
      throw new Error(
        `unaffordable tanning did not roll back: ${JSON.stringify(unaffordableTanningEvent)}`,
      );
    }

    const missingCookingInput = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      request: COOK_INPUT,
    });
    const missingCookingInputEvent = await missingCookingInput.event;
    await waitForExit(missingCookingInput.child);
    if (
      missingCookingInputEvent.event !== "error" ||
      !missingCookingInputEvent.message?.includes(
        "processing_action_insufficient_items",
      )
    ) {
      throw new Error(
        `missing cooking input did not roll back: ${JSON.stringify(missingCookingInputEvent)}`,
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
      oldReplayEvent.currentXp !== 105.5 ||
      oldReplayEvent.inventory?.filter((item) => item.itemId === "bronze_sword")
        .length !== 2
    ) {
      throw new Error(
        `old replay returned stale custody: ${JSON.stringify(oldReplayEvent)}`,
      );
    }

    const [inventory, character, operations, questState] = await Promise.all([
      pool.query<{ itemId: string; quantity: number; slotIndex: number }>(
        `SELECT "itemId", quantity, "slotIndex" FROM inventory
         WHERE "playerId" = $1 ORDER BY "slotIndex"`,
        [PLAYER_ID],
      ),
      pool.query<{
        coins: number;
        smithingXp: number;
        smithingLevel: number;
        craftingXp: number;
        craftingLevel: number;
        fletchingXp: number;
        fletchingLevel: number;
        runecraftingXp: number;
        runecraftingLevel: number;
        cookingXp: number;
        cookingLevel: number;
        firemakingXp: number;
        firemakingLevel: number;
        consumableUses: unknown;
      }>(
        `SELECT coins, "smithingXp", "smithingLevel", "craftingXp", "craftingLevel",
                "fletchingXp", "fletchingLevel",
                "runecraftingXp", "runecraftingLevel",
                "cookingXp", "cookingLevel",
                "firemakingXp", "firemakingLevel",
                "processingConsumableUses" AS "consumableUses"
         FROM characters WHERE id = $1`,
        [PLAYER_ID],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM operations_log
         WHERE "playerId" = $1 AND "operationType" = 'processing_action'`,
        [PLAYER_ID],
      ),
      pool.query<{
        status: string;
        progress: Record<string, number>;
        original_resolution: string;
        pending_count: string;
        audit_count: string;
      }>(
        `SELECT qp.status, qp."stageProgress" AS progress,
                (SELECT resolution FROM quest_processing_progress_receipts
                 WHERE operation_id = $2 AND quest_id = 'fresh_catch'
                   AND target_id = 'shrimp') AS original_resolution,
                (SELECT count(*)::text FROM quest_processing_progress_receipts
                 WHERE player_id = $1 AND resolved_at IS NULL) AS pending_count,
                (SELECT count(*)::text FROM quest_audit_log
                 WHERE "playerId" = $1 AND "questId" = 'fresh_catch'
                   AND action = 'progressed') AS audit_count
         FROM quest_progress qp
         WHERE qp."playerId" = $1 AND qp."questId" = 'fresh_catch'`,
        [PLAYER_ID, cookingOperationId],
      ),
    ]);
    const inventoryConserved =
      JSON.stringify(inventory.rows) ===
      JSON.stringify([
        { itemId: "bronze_sword", quantity: 1, slotIndex: 0 },
        { itemId: "bronze_sword", quantity: 1, slotIndex: 1 },
        { itemId: "hammer", quantity: 1, slotIndex: 2 },
        { itemId: "leather_gloves", quantity: 1, slotIndex: 3 },
        { itemId: "leather_gloves", quantity: 1, slotIndex: 4 },
        { itemId: "leather_gloves", quantity: 1, slotIndex: 5 },
        { itemId: "leather_gloves", quantity: 1, slotIndex: 6 },
        { itemId: "leather_gloves", quantity: 1, slotIndex: 7 },
        { itemId: "bronze_arrow", quantity: 15, slotIndex: 8 },
        { itemId: "mind_rune", quantity: 5, slotIndex: 9 },
        { itemId: "shrimp", quantity: 1, slotIndex: 10 },
        { itemId: "needle", quantity: 1, slotIndex: 11 },
        { itemId: "burnt_anchovies", quantity: 1, slotIndex: 12 },
        { itemId: "leather", quantity: 1, slotIndex: 13 },
        { itemId: "leather", quantity: 1, slotIndex: 14 },
        { itemId: "tinderbox", quantity: 1, slotIndex: 20 },
        { itemId: "cowhide", quantity: 1, slotIndex: 23 },
        { itemId: "logs", quantity: 1, slotIndex: 26 },
      ]);
    const skillConserved =
      character.rows[0]?.smithingXp === 105.5 &&
      character.rows[0]?.smithingLevel === 2 &&
      Math.abs((character.rows[0]?.craftingXp ?? Number.NaN) - 69) < 1e-9 &&
      character.rows[0]?.craftingLevel === 1 &&
      character.rows[0]?.fletchingXp === 19.5 &&
      character.rows[0]?.fletchingLevel === 1 &&
      character.rows[0]?.runecraftingXp === 27.5 &&
      character.rows[0]?.runecraftingLevel === 1 &&
      character.rows[0]?.cookingXp === 30 &&
      character.rows[0]?.cookingLevel === 1 &&
      character.rows[0]?.firemakingXp === 120 &&
      character.rows[0]?.firemakingLevel === 2;
    const coinsConserved = character.rows[0]?.coins === 98;
    const consumableStateConserved =
      JSON.stringify(character.rows[0]?.consumableUses) === "{}";
    const questProgressConserved =
      questState.rows[0]?.status === "completed" &&
      questState.rows[0]?.progress.shrimp === 6 &&
      questState.rows[0]?.original_resolution === "applied" &&
      questState.rows[0]?.pending_count === "0" &&
      questState.rows[0]?.audit_count === "1";
    if (
      !inventoryConserved ||
      !skillConserved ||
      !coinsConserved ||
      !consumableStateConserved ||
      !questProgressConserved ||
      operations.rows[0]?.count !== "16"
    ) {
      throw new Error("post-kill processing custody was not exact");
    }
    process.stdout.write(
      `${JSON.stringify({
        processKilledAfterCommit: true,
        deterministicRequestReceiptRecoveredAfterRestart: true,
        embeddedAgentHostRecoveredAfterProcessKill:
          embeddedAgentHostRecoveredAfterKill,
        externalAgentHostRecoveredAfterProcessKill:
          externalAgentHostRecoveredAfterKill,
        twentyFiveAgentProcessingContentionIsolated: true,
        processingContentionP95Ms: Number(contentionP95Ms.toFixed(1)),
        processingContentionMaxMs: Number(contentionMaxMs.toFixed(1)),
        smeltingRequestMappedToSmithingCustody: true,
        tanningRequestMappedToCraftingCustody: true,
        preCommitAdmissionSurvivedProcessKill: true,
        durableWaiterEnvelopeRecoveredAfterProcessKill: true,
        interruptedRequestResumedWithSameIdentity: true,
        exactDuplicateAdmissionDeduplicated: true,
        competingPendingActionRejected: true,
        staleAuthorityCouldNotHeartbeatOrRejectReplacement: true,
        resumedPendingReceiptCommittedExactlyOnce: true,
        terminalWaiterAcknowledgedAndCleared: true,
        terminalPreCommitRejectionPersisted: true,
        receiptStatusPlayerScoped: true,
        fractionalXpMigrationApplied: true,
        questProgressMigrationIdempotent: true,
        durableQuestProgressRecoveredByReplacementProcess:
          durableProcessingQuestRecoveredAfterKill,
        questProgressAppliedExactlyOnce: questProgressConserved,
        consumableStateMigrationApplied,
        durableReplayRecovered: true,
        inputsOutputsAndXpAtomic: true,
        failedSmeltDebitOnlyAtomic: true,
        failedSmeltDurableReplayRecovered: true,
        failedSmeltAwardedNoXp: true,
        partialConsumableUsesDurableAcrossProcesses: true,
        finalConsumableDebitAtomic: true,
        finalConsumableReplayRecovered: true,
        toolPresenceAndCraftOutputAtomic: true,
        missingConsumableRolledBackEverything: true,
        multiInputMultiOutputFletchingAtomic: true,
        fletchingReplayRecovered: true,
        mixedEssenceRunecraftingAtomic: true,
        runecraftingReplayRecovered: true,
        missingRunecraftingInputsRolledBackEverything: true,
        cookingSuccessAtomic: true,
        cookingSuccessReplayRecovered: true,
        cookingBurnOutcomeAtomic: true,
        cookingBurnReplayRecovered: true,
        cookingBurnAwardedNoXp: true,
        firemakingDebitAndXpAtomic: true,
        firemakingReplayRecovered: true,
        committedFireRecoveredAfterProcessKill: true,
        concurrentFireTileArbitrationExact: true,
        perPlayerFireCapacityEnforced: true,
        fireExtinguishIdempotent: true,
        tinderboxPresencePreserved: true,
        tanningItemsAndCoinsAtomic: true,
        tanningReplayRecovered: true,
        unaffordableTanningRolledBackEverything: true,
        missingCookingInputRolledBackEverything: true,
        missingInputsRolledBackEverything: true,
        operationCollisionRejected: true,
        oldReplayDidNotRollbackNewerState: true,
        inventoryConserved,
        skillConserved,
        coinsConserved,
        consumableStateConserved,
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

if (process.argv.includes("--quest-recovery")) {
  await runQuestRecoveryWorker();
} else if (process.argv.includes("--embedded-agent-host")) {
  await runEmbeddedAgentHostWorker();
} else if (process.argv.includes("--external-agent-host")) {
  await runExternalAgentHostWorker();
} else if (process.argv.includes("--contention-worker")) {
  await runProcessingContentionWorker();
} else if (process.argv.includes("--admission-worker")) {
  await runAdmissionWorker();
} else if (process.argv.includes("--worker")) await runWorker();
else await runParent();
