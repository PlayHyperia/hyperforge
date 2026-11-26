import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processingDataProvider } from "../../../../data/ProcessingDataProvider";
import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import { EventBus } from "../../infrastructure/EventBus";
import { CraftingSystem } from "../CraftingSystem";
import { SmeltingSystem } from "../SmeltingSystem";
import { SmithingSystem } from "../SmithingSystem";

const PLAYER_ID = "station-agent";
const SMITHING_RECIPE = {
  itemId: "bronze_dagger",
  name: "Bronze Dagger",
  barType: "bronze_bar",
  barsRequired: 1,
  levelRequired: 1,
  xp: 12.5,
  category: "dagger" as const,
  ticks: 4,
  outputQuantity: 1,
};
const SMELTING_RECIPE = {
  barItemId: "bronze_bar",
  primaryOre: "copper_ore",
  secondaryOre: "tin_ore",
  coalRequired: 0,
  levelRequired: 1,
  xp: 6.2,
  ticks: 4,
  successRate: 1,
};
const JEWELRY_RECIPE = {
  output: "gold_ring",
  name: "Gold Ring",
  category: "jewelry" as const,
  inputs: [{ item: "gold_bar", amount: 1 }],
  tools: ["ring_mould"],
  consumables: [],
  level: 5,
  xp: 15,
  ticks: 3,
  station: "furnace" as const,
};

function createWorld() {
  const eventBus = new EventBus();
  const entities = new Map<string, unknown>();
  const commitProcessingActionAtomic = vi.fn(
    () => new Promise(() => undefined),
  );
  const duel = { isPlayerInDuel: vi.fn(() => false) };
  const player = {
    id: PLAYER_ID,
    position: { x: 10, y: 0, z: 10 },
    data: {},
    skills: {
      smithing: { level: 99, xp: 0 },
      crafting: { level: 99, xp: 0 },
    },
  };
  const world = {
    isServer: true,
    currentTick: 100,
    $eventBus: eventBus,
    entities,
    getPlayer: vi.fn(() => player),
    getInventory: vi.fn(() => [
      { itemId: "hammer", quantity: 1, slot: 0 },
      { itemId: "bronze_bar", quantity: 2, slot: 1 },
      { itemId: "copper_ore", quantity: 2, slot: 2 },
      { itemId: "tin_ore", quantity: 2, slot: 3 },
      { itemId: "gold_bar", quantity: 1, slot: 4 },
      { itemId: "ring_mould", quantity: 1, slot: 5 },
    ]),
    getSystem: vi.fn((name: string) => {
      if (name === "inventory") return { commitProcessingActionAtomic };
      if (name === "duel") return duel;
      return undefined;
    }),
  };
  return {
    world,
    eventBus,
    entities,
    player,
    duel,
    commitProcessingActionAtomic,
  };
}

function emit(
  eventBus: EventBus,
  type: EventType,
  data: Record<string, unknown>,
): void {
  eventBus.emitEvent(type, data, "test");
}

describe("processing workstation authorization", () => {
  beforeEach(() => {
    vi.spyOn(processingDataProvider, "getSmithingRecipe").mockImplementation(
      (id) => (id === SMITHING_RECIPE.itemId ? SMITHING_RECIPE : null),
    );
    vi.spyOn(processingDataProvider, "getSmeltingData").mockImplementation(
      (id) => (id === SMELTING_RECIPE.barItemId ? SMELTING_RECIPE : null),
    );
    vi.spyOn(processingDataProvider, "getCraftingRecipe").mockImplementation(
      (id) => (id === JEWELRY_RECIPE.output ? JEWELRY_RECIPE : null),
    );
    vi.spyOn(
      processingDataProvider,
      "getCraftingRecipesByStation",
    ).mockImplementation((station) =>
      station === "furnace" ? [JEWELRY_RECIPE] : [],
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires an exact live anvil interaction before Smithing", async () => {
    const { world, eventBus, entities } = createWorld();
    const system = new SmithingSystem(world as unknown as World);
    await system.init();
    try {
      emit(eventBus, EventType.PROCESSING_SMITHING_REQUEST, {
        playerId: PLAYER_ID,
        recipeId: SMITHING_RECIPE.itemId,
        anvilId: "anvil-live",
        quantity: 1,
      });
      expect(system.isPlayerSmithing(PLAYER_ID)).toBe(false);

      entities.set("display-spoof", {
        entityType: "decoration",
        name: "Anvil",
        canInteract: () => true,
      });
      emit(eventBus, EventType.SMITHING_INTERACT, {
        playerId: PLAYER_ID,
        anvilId: "display-spoof",
      });
      expect(system.canPlayerUseActiveAnvil(PLAYER_ID)).toBe(false);

      entities.set("anvil-live", {
        entityType: "anvil",
        canInteract: () => true,
      });
      emit(eventBus, EventType.SMITHING_INTERACT, {
        playerId: PLAYER_ID,
        anvilId: "anvil-live",
      });
      emit(eventBus, EventType.PROCESSING_SMITHING_REQUEST, {
        playerId: PLAYER_ID,
        recipeId: SMITHING_RECIPE.itemId,
        anvilId: "anvil-live",
        quantity: 1,
      });
      expect(system.isPlayerSmithing(PLAYER_ID)).toBe(true);
    } finally {
      system.destroy();
    }
  });

  it("isolates 25 simultaneous Smithing sessions at one shared anvil", async () => {
    const eventBus = new EventBus();
    const playerIds = Array.from(
      { length: 25 },
      (_, index) => `station-agent-${index}`,
    );
    const players = new Map(
      playerIds.map((playerId) => [
        playerId,
        {
          id: playerId,
          position: { x: 10, y: 0, z: 10 },
          data: {},
          skills: { smithing: { level: 99, xp: 0 } },
        },
      ]),
    );
    const entities = new Map<string, unknown>([
      [
        "anvil-shared",
        {
          entityType: "anvil",
          canInteract: () => true,
        },
      ],
    ]);
    const world = {
      isServer: true,
      currentTick: 100,
      $eventBus: eventBus,
      entities,
      getPlayer: (playerId: string) => players.get(playerId),
      getInventory: () => [
        { itemId: "hammer", quantity: 1, slot: 0 },
        { itemId: "bronze_bar", quantity: 1, slot: 1 },
      ],
      getSystem: (name: string) => {
        if (name === "inventory") {
          return {
            commitProcessingActionAtomic: () => new Promise(() => undefined),
          };
        }
        if (name === "duel") return { isPlayerInDuel: () => false };
        return undefined;
      },
    };
    const system = new SmithingSystem(world as unknown as World);
    await system.init();
    try {
      for (const playerId of playerIds) {
        emit(eventBus, EventType.SMITHING_INTERACT, {
          playerId,
          anvilId: "anvil-shared",
        });
        emit(eventBus, EventType.PROCESSING_SMITHING_REQUEST, {
          playerId,
          recipeId: SMITHING_RECIPE.itemId,
          anvilId: "anvil-shared",
          quantity: 1,
        });
      }

      expect(system.getSmithingCustodyStats()).toMatchObject({
        activeSessions: 25,
        pendingActions: 0,
      });
      expect(
        playerIds.every(
          (playerId) =>
            system.isPlayerSmithing(playerId) &&
            system.canPlayerUseActiveAnvil(playerId),
        ),
      ).toBe(true);

      emit(eventBus, EventType.MOVEMENT_CLICK_TO_MOVE, {
        playerId: playerIds[0],
        targetPosition: { x: 20, y: 0, z: 20 },
      });
      emit(eventBus, EventType.COMBAT_STARTED, {
        attackerId: playerIds[1],
        targetId: playerIds[2],
      });
      emit(eventBus, EventType.PLAYER_UNREGISTERED, {
        playerId: playerIds[3],
      });

      expect(system.getSmithingCustodyStats()).toMatchObject({
        activeSessions: 21,
        pendingActions: 0,
      });
      expect(
        playerIds.slice(0, 4).some((id) => system.isPlayerSmithing(id)),
      ).toBe(false);
      expect(
        playerIds.slice(4).every((id) => system.isPlayerSmithing(id)),
      ).toBe(true);
    } finally {
      system.destroy();
    }
  });

  it("invalidates the anvil session on movement and denies duel-state use", async () => {
    const { world, eventBus, entities, duel } = createWorld();
    entities.set("anvil-live", {
      entityType: "anvil",
      canInteract: () => true,
    });
    const system = new SmithingSystem(world as unknown as World);
    await system.init();
    try {
      emit(eventBus, EventType.SMITHING_INTERACT, {
        playerId: PLAYER_ID,
        anvilId: "anvil-live",
      });
      expect(system.canPlayerUseActiveAnvil(PLAYER_ID)).toBe(true);

      emit(eventBus, EventType.MOVEMENT_CLICK_TO_MOVE, {
        playerId: PLAYER_ID,
        targetPosition: { x: 11, y: 0, z: 10 },
      });
      expect(system.canPlayerUseActiveAnvil(PLAYER_ID)).toBe(false);

      duel.isPlayerInDuel.mockReturnValue(true);
      emit(eventBus, EventType.SMITHING_INTERACT, {
        playerId: PLAYER_ID,
        anvilId: "anvil-live",
      });
      expect(system.canPlayerUseActiveAnvil(PLAYER_ID)).toBe(false);
    } finally {
      system.destroy();
    }
  });

  it("revalidates the exact furnace before a Smelting commit", async () => {
    const { world, eventBus, entities, commitProcessingActionAtomic } =
      createWorld();
    let inRange = true;
    entities.set("furnace-live", {
      entityType: "furnace",
      canInteract: () => inRange,
    });
    const system = new SmeltingSystem(world as unknown as World);
    await system.init();
    try {
      emit(eventBus, EventType.SMELTING_INTERACT, {
        playerId: PLAYER_ID,
        furnaceId: "furnace-live",
      });
      emit(eventBus, EventType.PROCESSING_SMELTING_REQUEST, {
        playerId: PLAYER_ID,
        barItemId: SMELTING_RECIPE.barItemId,
        furnaceId: "furnace-live",
        quantity: 1,
      });
      expect(system.isPlayerSmelting(PLAYER_ID)).toBe(true);

      inRange = false;
      world.currentTick = 104;
      system.update(0.6);
      expect(commitProcessingActionAtomic).not.toHaveBeenCalled();
      expect(system.isPlayerSmelting(PLAYER_ID)).toBe(false);
    } finally {
      system.destroy();
    }
  });

  it("does not authorize a remote or wrong-type furnace for Smelting", async () => {
    const { world, eventBus, entities } = createWorld();
    entities.set("wrong-type", {
      entityType: "range",
      canInteract: () => true,
    });
    entities.set("remote-furnace", {
      entityType: "furnace",
      canInteract: () => false,
    });
    const system = new SmeltingSystem(world as unknown as World);
    await system.init();
    try {
      for (const furnaceId of ["wrong-type", "remote-furnace"]) {
        emit(eventBus, EventType.SMELTING_INTERACT, {
          playerId: PLAYER_ID,
          furnaceId,
        });
        emit(eventBus, EventType.PROCESSING_SMELTING_REQUEST, {
          playerId: PLAYER_ID,
          barItemId: SMELTING_RECIPE.barItemId,
          furnaceId,
          quantity: 1,
        });
        expect(system.isPlayerSmelting(PLAYER_ID)).toBe(false);
      }
    } finally {
      system.destroy();
    }
  });

  it("requires a bound furnace session for furnace-only Crafting", async () => {
    const { world, eventBus, entities } = createWorld();
    entities.set("furnace-live", {
      entityType: "furnace",
      canInteract: () => true,
    });
    const system = new CraftingSystem(world as unknown as World);
    await system.init();
    try {
      emit(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: PLAYER_ID,
        recipeId: JEWELRY_RECIPE.output,
        quantity: 1,
      });
      expect(system.isPlayerCrafting(PLAYER_ID)).toBe(false);

      emit(eventBus, EventType.CRAFTING_INTERACT, {
        playerId: PLAYER_ID,
        triggerType: "furnace",
        stationId: "furnace-live",
      });
      emit(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: PLAYER_ID,
        recipeId: JEWELRY_RECIPE.output,
        quantity: 1,
      });
      expect(system.isPlayerCrafting(PLAYER_ID)).toBe(true);
    } finally {
      system.destroy();
    }
  });

  it("revalidates the crafting furnace at completion", async () => {
    const { world, eventBus, entities, commitProcessingActionAtomic } =
      createWorld();
    let inRange = true;
    entities.set("furnace-live", {
      entityType: "furnace",
      canInteract: () => inRange,
    });
    const system = new CraftingSystem(world as unknown as World);
    await system.init();
    try {
      emit(eventBus, EventType.CRAFTING_INTERACT, {
        playerId: PLAYER_ID,
        triggerType: "furnace",
        stationId: "furnace-live",
      });
      emit(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: PLAYER_ID,
        recipeId: JEWELRY_RECIPE.output,
        quantity: 1,
      });

      inRange = false;
      world.currentTick = 103;
      system.update(0.6);
      expect(commitProcessingActionAtomic).not.toHaveBeenCalled();
      expect(system.isPlayerCrafting(PLAYER_ID)).toBe(false);
    } finally {
      system.destroy();
    }
  });
});
