/**
 * CraftingSystem Unit Tests
 *
 * Tests for the crafting system covering:
 * - Recipe filtering (handleCraftingInteract)
 * - Crafting lifecycle (start, complete, schedule next)
 * - Material/tool/consumable validation
 * - Movement and combat cancellation
 * - Concurrent crafting prevention
 * - Tick-based update loop
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CraftingSystem } from "../CraftingSystem";
import { EventBus } from "../../infrastructure/EventBus";
import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import { processingDataProvider } from "../../../../data/ProcessingDataProvider";
import type { AtomicProcessingActionReceipt } from "../../character/InventorySystem";

// ─── Helpers ──────────────────────────────────────────────────────────

interface MockInventoryItem {
  id: string;
  itemId: string;
  quantity: number;
  slot: number;
  metadata: null;
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

function createMockWorld(
  options: {
    inventory?: MockInventoryItem[];
    skills?: Record<string, { level: number; xp: number }>;
    currentTick?: number;
  } = {},
) {
  const eventBus = new EventBus();
  const inventory = options.inventory || [];
  const commitProcessingActionAtomic = vi.fn(
    async (
      playerId: string,
      operationId: string,
      input: {
        skill: "crafting";
        xpAmount: number;
        inputs: Array<{ itemId: string; quantity: number }>;
        requiredItems: Array<{ itemId: string; quantity: number }>;
        consumables: Array<{ itemId: string; usesPerItem: number }>;
        outputs: Array<{ itemId: string; quantity: number }>;
      },
    ): Promise<AtomicProcessingActionReceipt> => ({
      ok: true,
      committed: true,
      liveInventoryApplied: true,
      playerId,
      operationId,
      replayed: false,
      skill: "crafting",
      xpAmount: input.xpAmount,
      inputs: input.inputs,
      requiredItems: input.requiredItems,
      consumables: input.consumables,
      consumableStates: input.consumables.map((consumable) => ({
        ...consumable,
        remainingUses: consumable.usesPerItem - 1,
        consumedQuantity: 0,
      })),
      outputs: input.outputs.map((output) => ({
        ...output,
        stackable: false,
      })),
      awardedXp: input.xpAmount,
      operationCommittedXp: input.xpAmount,
      currentXp: input.xpAmount,
      currentLevel: 1,
    }),
  );

  const world = {
    isServer: true,
    currentTick: options.currentTick ?? 100,
    $eventBus: eventBus,
    entities: new Map(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    getSystem: vi.fn((name: string) =>
      name === "inventory" ? { commitProcessingActionAtomic } : undefined,
    ),
    getPlayer: vi.fn((id: string) => ({
      id,
      position: { x: 1, y: 0, z: 1 },
      data: {},
      skills: options.skills,
    })),
    getInventory: vi.fn(() => inventory),
    network: { send: vi.fn() },
  };

  return { world, eventBus, commitProcessingActionAtomic };
}

function emitEvent(
  eventBus: EventBus,
  type: EventType | string,
  data: Record<string, unknown>,
) {
  eventBus.emitEvent(type, data, "test");
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("CraftingSystem", () => {
  let system: CraftingSystem;
  let eventBus: EventBus;
  let mockWorld: ReturnType<typeof createMockWorld>["world"];
  let commitProcessingActionAtomic: ReturnType<typeof vi.fn>;

  // Track emitted events
  const emittedEvents: Array<{ type: string; data: unknown }> = [];

  beforeEach(async () => {
    emittedEvents.length = 0;
    processingDataProvider.initialize();
  });

  afterEach(() => {
    if (system) {
      system.destroy();
    }
  });

  /**
   * Initialize system with given options and capture all emitted events.
   */
  async function setupSystem(
    options: Parameters<typeof createMockWorld>[0] = {},
  ) {
    const mock = createMockWorld(options);
    mockWorld = mock.world;
    eventBus = mock.eventBus;
    commitProcessingActionAtomic = mock.commitProcessingActionAtomic;
    system = new CraftingSystem(mockWorld as unknown as World);
    await system.init();

    // Capture all events emitted by the system
    const originalEmit = eventBus.emitEvent.bind(eventBus);
    vi.spyOn(eventBus, "emitEvent").mockImplementation((type, data, source) => {
      emittedEvents.push({ type: type as string, data });
      return originalEmit(type, data, source);
    });
  }

  function findEmitted(type: string) {
    return emittedEvents.filter((e) => e.type === type);
  }

  // ─── handleCraftingInteract ───────────────────────────────────────

  describe("handleCraftingInteract", () => {
    it("emits CRAFTING_INTERFACE_OPEN with available recipes", async () => {
      const hasData =
        processingDataProvider.getCraftingRecipesByStation("none").length > 0;
      if (!hasData) return; // Skip if manifests not loaded

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 5),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.CRAFTING_INTERACT, {
        playerId: "player1",
        triggerType: "needle",
      });

      const opens = findEmitted(EventType.CRAFTING_INTERFACE_OPEN);
      expect(opens.length).toBe(1);
      const payload = opens[0].data as { availableRecipes: unknown[] };
      expect(payload.availableRecipes.length).toBeGreaterThan(0);
    });

    it("filters recipes by inputItemId", async () => {
      const hasData =
        processingDataProvider.getCraftingRecipesByStation("none").length > 0;
      if (!hasData) return;

      await setupSystem({
        inventory: [createItem("chisel", 1), createItem("uncut_sapphire", 1)],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.CRAFTING_INTERACT, {
        playerId: "player1",
        triggerType: "chisel",
        inputItemId: "uncut_sapphire",
      });

      const opens = findEmitted(EventType.CRAFTING_INTERFACE_OPEN);
      expect(opens.length).toBe(1);
      const payload = opens[0].data as {
        availableRecipes: Array<{ output: string }>;
      };
      // Should only return the sapphire recipe
      expect(payload.availableRecipes.length).toBe(1);
      expect(payload.availableRecipes[0].output).toBe("sapphire");
    });

    it("rejects interaction when already crafting", async () => {
      await setupSystem({
        inventory: [
          createItem("leather", 5),
          createItem("needle", 1),
          createItem("thread", 1),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      // Start crafting first
      const recipe =
        processingDataProvider.getCraftingRecipesByStation("none")[0];
      if (!recipe) return;

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: recipe.output,
        quantity: 5,
      });

      // Now try to interact — should get "already crafting" message
      emitEvent(eventBus, EventType.CRAFTING_INTERACT, {
        playerId: "player1",
        triggerType: "needle",
      });

      const messages = findEmitted(EventType.UI_MESSAGE);
      const alreadyCrafting = messages.find(
        (m) =>
          (m.data as { message: string }).message ===
          "You are already crafting.",
      );
      expect(alreadyCrafting).toBeDefined();
    });

    it("shows error when no recipes match inputItemId", async () => {
      await setupSystem({
        inventory: [createItem("chisel", 1)],
        skills: { crafting: { level: 1, xp: 0 } },
      });

      emitEvent(eventBus, EventType.CRAFTING_INTERACT, {
        playerId: "player1",
        triggerType: "chisel",
        inputItemId: "nonexistent_material_xyz",
      });

      const messages = findEmitted(EventType.UI_MESSAGE);
      const noRecipes = messages.find((m) =>
        (m.data as { message: string }).message.includes("no crafting recipes"),
      );
      expect(noRecipes).toBeDefined();
    });
  });

  // ─── startCrafting ────────────────────────────────────────────────

  describe("startCrafting", () => {
    it("starts a crafting session for valid recipe", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 5),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 3,
      });

      expect(system.isPlayerCrafting("player1")).toBe(true);
      const starts = findEmitted(EventType.CRAFTING_START);
      expect(starts.length).toBe(1);
    });

    it("rejects crafting with insufficient level", async () => {
      const recipes =
        processingDataProvider.getCraftingRecipesByStation("none");
      const highLevelRecipe = recipes.find((r) => r.level > 50);
      if (!highLevelRecipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          ...highLevelRecipe.inputs.map((i) => createItem(i.item, i.amount)),
        ],
        skills: { crafting: { level: 1, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: highLevelRecipe.output,
        quantity: 1,
      });

      expect(system.isPlayerCrafting("player1")).toBe(false);
      const messages = findEmitted(EventType.UI_MESSAGE);
      const levelMsg = messages.find((m) =>
        (m.data as { message: string }).message.includes("level"),
      );
      expect(levelMsg).toBeDefined();
    });

    it("rejects crafting without required materials", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("needle", 1), createItem("thread", 1)],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 1,
      });

      expect(system.isPlayerCrafting("player1")).toBe(false);
    });

    it("rejects crafting for invalid recipe", async () => {
      await setupSystem({
        inventory: [createItem("leather", 5)],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "nonexistent_item_xyz",
        quantity: 1,
      });

      expect(system.isPlayerCrafting("player1")).toBe(false);
    });

    it("prevents concurrent crafting sessions", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 10),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      // Start first session
      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 5,
      });

      // Try to start second session
      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 3,
      });

      // Only one CRAFTING_START should fire
      const starts = findEmitted(EventType.CRAFTING_START);
      expect(starts.length).toBe(1);
    });

    it("normalizes a non-finite internal quantity to one action", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 5),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: Number.NaN,
      });
      mockWorld.currentTick = 100 + recipe.ticks;
      system.update(0);
      await flushPromises();
      mockWorld.currentTick++;
      system.update(0);

      expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
      expect(findEmitted(EventType.CRAFTING_COMPLETE)).toHaveLength(1);
      expect(system.isPlayerCrafting("player1")).toBe(false);
    });
  });

  // ─── completeCraft + update loop ──────────────────────────────────

  describe("completeCraft via update", () => {
    it("completes a craft when tick reaches completionTick", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 5),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 1,
      });

      expect(system.isPlayerCrafting("player1")).toBe(true);

      // Advance tick past completion
      mockWorld.currentTick = 100 + recipe.ticks;
      system.update(0);
      await flushPromises();
      mockWorld.currentTick++;
      system.update(0);

      // Durable custody owns inventory mutation; only committed XP/result events
      // are emitted by CraftingSystem.
      const itemsAdded = findEmitted(EventType.INVENTORY_ITEM_ADDED);
      expect(itemsAdded.length).toBe(0);
      expect(findEmitted(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
      const xpGained = findEmitted(EventType.SKILLS_PROGRESS_COMMITTED);
      expect(xpGained.length).toBe(1);
      expect((xpGained[0].data as { awardedXp: number }).awardedXp).toBe(
        recipe.xp,
      );

      // For quantity 1, session should complete
      const completes = findEmitted(EventType.CRAFTING_COMPLETE);
      expect(completes.length).toBe(1);
    });

    it("uses a unique durable operation identity for each craft", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("sapphire");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("chisel", 1), createItem("uncut_sapphire", 5)],
        skills: { crafting: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "sapphire",
        quantity: 3,
      });

      // Complete 3 durable crafts
      for (let i = 0; i < 3; i++) {
        mockWorld.currentTick += recipe.ticks;
        system.update(0);
        await flushPromises();
        mockWorld.currentTick++;
        system.update(0);
      }

      const ids = commitProcessingActionAtomic.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^crafting-action:/);
      }
    });
  });

  // ─── Movement cancellation ────────────────────────────────────────

  describe("movement cancellation", () => {
    it("cancels crafting when player moves", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 5),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 5,
      });

      expect(system.isPlayerCrafting("player1")).toBe(true);

      // Player clicks to move
      emitEvent(eventBus, EventType.MOVEMENT_CLICK_TO_MOVE, {
        playerId: "player1",
        targetPosition: { x: 10, y: 0, z: 10 },
      });

      expect(system.isPlayerCrafting("player1")).toBe(false);
      const completes = findEmitted(EventType.CRAFTING_COMPLETE);
      expect(completes.length).toBe(1);
    });

    it("does not cancel other players when one moves", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 10),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      // Start crafting for player1
      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 5,
      });

      // Player2 moves (player2 is not crafting)
      emitEvent(eventBus, EventType.MOVEMENT_CLICK_TO_MOVE, {
        playerId: "player2",
        targetPosition: { x: 10, y: 0, z: 10 },
      });

      // Player1 should still be crafting
      expect(system.isPlayerCrafting("player1")).toBe(true);
    });
  });

  // ─── Combat cancellation ──────────────────────────────────────────

  describe("combat cancellation", () => {
    it("cancels crafting when player enters combat as attacker", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 5),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 5,
      });

      expect(system.isPlayerCrafting("player1")).toBe(true);

      emitEvent(eventBus, EventType.COMBAT_STARTED, {
        attackerId: "player1",
        targetId: "mob1",
      });

      expect(system.isPlayerCrafting("player1")).toBe(false);
    });

    it("cancels crafting when player is attacked (target)", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 5),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 5,
      });

      emitEvent(eventBus, EventType.COMBAT_STARTED, {
        attackerId: "mob1",
        targetId: "player1",
      });

      expect(system.isPlayerCrafting("player1")).toBe(false);
    });
  });

  // ─── Player disconnect cleanup ────────────────────────────────────

  describe("player disconnect", () => {
    it("cleans up session on player unregister", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 5),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 5,
      });

      expect(system.isPlayerCrafting("player1")).toBe(true);

      emitEvent(eventBus, EventType.PLAYER_UNREGISTERED, {
        playerId: "player1",
      });

      expect(system.isPlayerCrafting("player1")).toBe(false);
    });
  });

  // ─── Client-side no-op ────────────────────────────────────────────

  describe("client-side", () => {
    it("does not register event handlers on client", async () => {
      const mock = createMockWorld();
      mock.world.isServer = false;
      const clientSystem = new CraftingSystem(mock.world as unknown as World);
      await clientSystem.init();

      // System should not crash and isPlayerCrafting should return false
      expect(clientSystem.isPlayerCrafting("anyone")).toBe(false);
      clientSystem.destroy();
    });
  });

  // ─── Update loop ──────────────────────────────────────────────────

  describe("update", () => {
    it("processes only once per tick", async () => {
      const recipe = processingDataProvider.getCraftingRecipe("leather_gloves");
      if (!recipe) return;

      await setupSystem({
        inventory: [
          createItem("needle", 1),
          createItem("thread", 1),
          createItem("leather", 5),
        ],
        skills: { crafting: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: "player1",
        recipeId: "leather_gloves",
        quantity: 1,
      });

      // Advance tick to completion
      mockWorld.currentTick = 100 + recipe.ticks;

      // Call update multiple times for same tick
      system.update(0);
      system.update(0);
      system.update(0);

      // Should only process once
      expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
      expect(findEmitted(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    });

    it("does nothing on client", async () => {
      const mock = createMockWorld({ currentTick: 100 });
      mock.world.isServer = false;
      const clientSystem = new CraftingSystem(mock.world as unknown as World);
      await clientSystem.init();

      // Should not throw
      clientSystem.update(0);
      clientSystem.destroy();
    });
  });
});
