/**
 * Runecrafting gameplay and authority tests.
 *
 * Durable custody, retry, and disconnect behavior has additional focused
 * coverage in RunecraftingSystem.rewardCustody.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { RunecraftingSystem } from "../RunecraftingSystem";
import { EventBus } from "../../infrastructure/EventBus";
import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import {
  processingDataProvider,
  type RunecraftingManifest,
} from "../../../../data/ProcessingDataProvider";
import type {
  AtomicProcessingActionReceipt,
  InventorySystem,
} from "../../character/InventorySystem";

interface MockInventoryItem {
  id: string;
  itemId: string;
  quantity: number;
  slot: number;
  metadata: null;
}

type ProcessingInput = Parameters<
  InventorySystem["commitProcessingActionAtomic"]
>[2];

interface CommitCall {
  playerId: string;
  operationId: string;
  input: ProcessingInput;
}

function createItem(
  itemId: string,
  quantity = 1,
  slot = -1,
): MockInventoryItem {
  return {
    id: `inv_test_${itemId}_${slot}`,
    itemId,
    quantity,
    slot,
    metadata: null,
  };
}

function successReceipt(
  playerId: string,
  operationId: string,
  input: ProcessingInput,
): AtomicProcessingActionReceipt {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    playerId,
    operationId,
    replayed: false,
    skill: input.skill,
    xpAmount: input.xpAmount,
    inputs: input.inputs,
    requiredItems: input.requiredItems ?? [],
    consumables: input.consumables ?? [],
    consumableStates: [],
    outputs: input.outputs.map((output) => ({
      ...output,
      stackable: true,
    })),
    awardedXp: input.xpAmount,
    operationCommittedXp: input.xpAmount,
    currentXp: input.xpAmount,
    currentLevel: 1,
  };
}

function createMockWorld(
  options: {
    inventory?: MockInventoryItem[];
    skills?: Record<string, { level: number; xp: number }>;
    playerPosition?: { x: number; y: number; z: number };
    altarDistance?: number;
    altarRuneTypes?: Record<string, string>;
    altarEntityType?: string;
    inDuel?: boolean;
  } = {},
) {
  const eventBus = new EventBus();
  const inventory = options.inventory ?? [];
  const commits: CommitCall[] = [];
  const position = options.playerPosition ?? { x: 0, y: 0, z: 0 };
  const altarDistance = options.altarDistance ?? 1;
  const altarRuneTypes = options.altarRuneTypes ?? {
    air_altar: "air",
    mind_altar: "mind",
    water_altar: "water",
    earth_altar: "earth",
    fire_altar: "fire",
    chaos_altar: "chaos",
  };
  const entities = new Map<string, unknown>();
  for (const [altarId, runeType] of Object.entries(altarRuneTypes)) {
    entities.set(altarId, {
      id: altarId,
      entityType: options.altarEntityType ?? "runecrafting_altar",
      runeType,
      isPlayerInRange: (candidate: { x: number; y: number; z: number }) => {
        const dx = candidate.x - altarDistance;
        const dy = candidate.y;
        const dz = candidate.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) <= 2;
      },
    });
  }

  const atomicInventory = {
    commitProcessingActionAtomic: vi.fn(
      async (playerId: string, operationId: string, input: ProcessingInput) => {
        commits.push({ playerId, operationId, input });
        return successReceipt(playerId, operationId, input);
      },
    ),
  };
  const player = { id: "player1", skills: options.skills, position };
  const world = {
    isServer: true,
    currentTick: 100,
    $eventBus: eventBus,
    entities,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    getSystem: vi.fn((name: string) => {
      if (name === "inventory") return atomicInventory;
      if (name === "duel") {
        return { isPlayerInDuel: () => options.inDuel ?? false };
      }
      return undefined;
    }),
    getPlayer: vi.fn((id: string) => (id === "player1" ? player : undefined)),
    getInventory: vi.fn(() => inventory),
    network: { send: vi.fn() },
  };

  return { world, eventBus, commits, atomicInventory };
}

function emitEvent(
  eventBus: EventBus,
  type: EventType | string,
  data: Record<string, unknown>,
) {
  eventBus.emitEvent(type, data, "test");
}

describe("RunecraftingSystem", () => {
  let system: RunecraftingSystem | undefined;
  let eventBus: EventBus;
  let mockWorld: ReturnType<typeof createMockWorld>["world"];
  let commits: CommitCall[];
  const emittedEvents: Array<{ type: string; data: unknown }> = [];

  beforeEach(() => {
    emittedEvents.length = 0;
    const candidatePaths = [
      path.resolve(
        process.cwd(),
        "packages/server/world/assets/manifests/recipes/runecrafting.json",
      ),
      path.resolve(
        process.cwd(),
        "../server/world/assets/manifests/recipes/runecrafting.json",
      ),
      path.resolve(
        __dirname,
        "../../../../../server/world/assets/manifests/recipes/runecrafting.json",
      ),
    ];
    const recipePath = candidatePaths.find((candidate) =>
      fs.existsSync(candidate),
    );
    if (!recipePath) {
      throw new Error("Runecrafting manifest is required for gameplay tests");
    }
    const manifest = JSON.parse(
      fs.readFileSync(recipePath, "utf-8"),
    ) as RunecraftingManifest;
    processingDataProvider.loadRunecraftingRecipes(manifest);
    processingDataProvider.rebuild();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    system?.destroy();
    system = undefined;
  });

  async function setupSystem(
    options: Parameters<typeof createMockWorld>[0] = {},
  ) {
    const mock = createMockWorld(options);
    mockWorld = mock.world;
    eventBus = mock.eventBus;
    commits = mock.commits;

    const originalEmit = eventBus.emitEvent.bind(eventBus);
    eventBus.emitEvent = (type: string, data: unknown, source?: string) => {
      emittedEvents.push({ type, data });
      return originalEmit(type, data, source);
    };

    system = new RunecraftingSystem(mockWorld as unknown as World);
    await system.init();
    return mock;
  }

  function findEmitted(type: string) {
    return emittedEvents.filter((event) => event.type === type);
  }

  async function interact(
    runeType: string,
    altarId = `${runeType}_altar`,
  ): Promise<void> {
    emitEvent(eventBus, EventType.RUNECRAFTING_INTERACT, {
      playerId: "player1",
      altarId,
      runeType,
    });
    await Promise.resolve();
    await Promise.resolve();
    system?.update(0);
  }

  it("commits mixed essence, output, and XP as one exact action", async () => {
    const recipe = processingDataProvider.getRunecraftingRecipe("air");
    expect(recipe).toBeDefined();
    await setupSystem({
      inventory: [
        createItem("rune_essence", 3),
        createItem("bronze_shortsword", 1),
        createItem("pure_essence", 2),
      ],
      skills: { runecrafting: { level: 1, xp: 0 } },
    });

    await interact("air");

    expect(commits).toHaveLength(1);
    expect(commits[0].operationId).toMatch(/^runecrafting-action:/);
    expect(commits[0].input).toEqual({
      skill: "runecrafting",
      xpAmount: 5 * (recipe?.xpPerEssence ?? 0),
      inputs: [
        { itemId: "pure_essence", quantity: 2 },
        { itemId: "rune_essence", quantity: 3 },
      ],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "air_rune", quantity: 5 }],
    });
    expect(findEmitted(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(findEmitted(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(findEmitted(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(findEmitted(EventType.RUNECRAFTING_COMPLETE)[0].data).toMatchObject({
      playerId: "player1",
      runeType: "air",
      runeItemId: "air_rune",
      essenceConsumed: 5,
      runesProduced: 5,
      multiplier: 1,
      xpAwarded: 5 * (recipe?.xpPerEssence ?? 0),
    });
  });

  it("accepts pure essence without requiring basic essence", async () => {
    await setupSystem({
      inventory: [createItem("pure_essence", 10)],
      skills: { runecrafting: { level: 5, xp: 0 } },
    });

    await interact("water");

    expect(commits[0].input.inputs).toEqual([
      { itemId: "pure_essence", quantity: 10 },
    ]);
    expect(commits[0].input.outputs).toEqual([
      { itemId: "water_rune", quantity: 10 },
    ]);
  });

  it("uses only essence types authorized by the recipe", async () => {
    await setupSystem({
      inventory: [createItem("rune_essence", 10)],
      skills: { runecrafting: { level: 99, xp: 0 } },
    });

    await interact("chaos");

    expect(commits).toHaveLength(0);
    expect(findEmitted(EventType.UI_MESSAGE)[0].data).toMatchObject({
      type: "error",
    });
  });

  it("enforces level requirements at the exact boundary", async () => {
    await setupSystem({
      inventory: [createItem("rune_essence", 3)],
      skills: { runecrafting: { level: 8, xp: 0 } },
    });
    await interact("earth");
    expect(commits).toHaveLength(0);

    system?.destroy();
    await setupSystem({
      inventory: [createItem("rune_essence", 3)],
      skills: { runecrafting: { level: 9, xp: 0 } },
    });
    await interact("earth");
    expect(commits).toHaveLength(1);
  });

  it.each([
    [10, 1, 5],
    [11, 2, 10],
    [22, 3, 15],
    [99, 10, 50],
  ])(
    "applies the level %i air-rune multiplier exactly",
    async (level, multiplier, outputQuantity) => {
      await setupSystem({
        inventory: [createItem("rune_essence", 5)],
        skills: { runecrafting: { level, xp: 0 } },
      });

      await interact("air");

      expect(commits[0].input.outputs[0]).toEqual({
        itemId: "air_rune",
        quantity: outputQuantity,
      });
      expect(
        findEmitted(EventType.RUNECRAFTING_COMPLETE)[0].data,
      ).toMatchObject({
        multiplier,
        essenceConsumed: 5,
        runesProduced: outputQuantity,
      });
    },
  );

  it.each([
    { name: "lookalike station type", altarEntityType: "furnace" },
    { name: "active duel state", inDuel: true },
  ])("rejects $name before runecrafting custody", async (options) => {
    await setupSystem({
      inventory: [createItem("rune_essence", 5)],
      skills: { runecrafting: { level: 99, xp: 0 } },
      altarEntityType: options.altarEntityType,
      inDuel: options.inDuel,
    });

    await interact("air");

    expect(commits).toHaveLength(0);
    expect(findEmitted(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(0);
  });

  it("rejects missing essence and an unknown recipe without committing", async () => {
    await setupSystem({
      inventory: [createItem("logs", 5)],
      skills: { runecrafting: { level: 99, xp: 0 } },
      altarRuneTypes: {
        air_altar: "air",
        unknown_altar: "unknown",
      },
    });
    await interact("air");
    await interact("unknown", "unknown_altar");
    expect(commits).toHaveLength(0);
    expect(findEmitted(EventType.UI_MESSAGE)).toHaveLength(2);
  });

  it.each([
    {
      name: "missing altar",
      altarRuneTypes: {},
      altarDistance: 1,
      playerPosition: { x: 0, y: 0, z: 0 },
      altarId: "air_altar",
      runeType: "air",
    },
    {
      name: "mismatched rune type",
      altarRuneTypes: { air_altar: "water" },
      altarDistance: 1,
      playerPosition: { x: 0, y: 0, z: 0 },
      altarId: "air_altar",
      runeType: "air",
    },
    {
      name: "remote altar",
      altarRuneTypes: { air_altar: "air" },
      altarDistance: 50,
      playerPosition: { x: 0, y: 0, z: 0 },
      altarId: "air_altar",
      runeType: "air",
    },
    {
      name: "invalid player position",
      altarRuneTypes: { air_altar: "air" },
      altarDistance: 1,
      playerPosition: { x: Number.NaN, y: 0, z: 0 },
      altarId: "air_altar",
      runeType: "air",
    },
  ])(
    "rejects $name at the shared authority boundary",
    async ({
      altarRuneTypes,
      altarDistance,
      playerPosition,
      altarId,
      runeType,
    }) => {
      await setupSystem({
        inventory: [createItem("rune_essence", 5)],
        skills: { runecrafting: { level: 99, xp: 0 } },
        altarRuneTypes,
        altarDistance,
        playerPosition,
      });

      await interact(runeType, altarId);

      expect(commits).toHaveLength(0);
      expect(findEmitted(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(0);
      expect(findEmitted(EventType.UI_MESSAGE)[0].data).toMatchObject({
        type: "error",
        message: expect.stringContaining("correct altar"),
      });
    },
  );

  it("uses cached skill updates and clears them on disconnect", async () => {
    await setupSystem({ inventory: [createItem("rune_essence", 5)] });
    emitEvent(eventBus, EventType.SKILLS_UPDATED, {
      playerId: "player1",
      skills: { runecrafting: { level: 14, xp: 0 } },
    });
    await interact("fire");
    expect(commits).toHaveLength(1);

    system?.destroy();
    await setupSystem({ inventory: [createItem("rune_essence", 5)] });
    emitEvent(eventBus, EventType.SKILLS_UPDATED, {
      playerId: "player1",
      skills: { runecrafting: { level: 14, xp: 0 } },
    });
    emitEvent(eventBus, EventType.PLAYER_UNREGISTERED, {
      playerId: "player1",
    });
    await interact("fire");
    expect(commits).toHaveLength(0);
  });

  it("fails closed and retries when atomic persistence is unavailable", async () => {
    await setupSystem({
      inventory: [createItem("rune_essence", 5)],
      skills: { runecrafting: { level: 1, xp: 0 } },
    });
    mockWorld.getSystem.mockReturnValue(undefined);

    await interact("air");

    expect(commits).toHaveLength(0);
    expect(system?.getRunecraftingCustodyStats()).toEqual({
      pendingActions: 1,
      inFlight: 0,
      retryWaiting: 1,
      maxRetryCount: 1,
    });
    expect(findEmitted(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(0);
  });

  it("does not register or process interactions on the client", async () => {
    const mock = createMockWorld();
    mock.world.isServer = false;
    const clientSystem = new RunecraftingSystem(mock.world as unknown as World);
    await clientSystem.init();
    emitEvent(mock.eventBus, EventType.RUNECRAFTING_INTERACT, {
      playerId: "player1",
      altarId: "air_altar",
      runeType: "air",
    });
    clientSystem.update(0);
    expect(mock.commits).toHaveLength(0);
    clientSystem.destroy();
  });
});
