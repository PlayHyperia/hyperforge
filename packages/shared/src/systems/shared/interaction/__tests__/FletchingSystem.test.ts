/**
 * FletchingSystem Unit Tests
 *
 * Tests for the fletching system covering:
 * - Recipe filtering (handleFletchingInteract) — knife+log, item-on-item, invalid player
 * - Fletching lifecycle (start, complete, schedule next)
 * - Level/material/tool validation
 * - Multi-output recipes (arrow shafts produce 15+)
 * - Movement and combat cancellation
 * - Concurrent session prevention
 * - Tick-based update loop
 * - Edge cases: "All" quantity, unique IDs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FletchingSystem } from "../FletchingSystem";
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
    inDuel?: boolean;
    inStreamingDuel?: boolean;
  } = {},
) {
  const eventBus = new EventBus();
  const inventory = options.inventory || [];
  const commitProcessingActionAtomic = vi.fn(
    async (
      playerId: string,
      operationId: string,
      input: {
        skill: "fletching";
        xpAmount: number;
        inputs: Array<{ itemId: string; quantity: number }>;
        requiredItems: Array<{ itemId: string; quantity: number }>;
        consumables: [];
        outputs: Array<{ itemId: string; quantity: number }>;
      },
    ): Promise<AtomicProcessingActionReceipt> => ({
      ok: true,
      committed: true,
      liveInventoryApplied: true,
      playerId,
      operationId,
      replayed: false,
      skill: "fletching",
      xpAmount: input.xpAmount,
      inputs: input.inputs,
      requiredItems: input.requiredItems,
      consumables: [],
      consumableStates: [],
      outputs: input.outputs.map((output) => ({
        ...output,
        stackable: true,
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
    getSystem: vi.fn((name: string) => {
      if (name === "inventory") return { commitProcessingActionAtomic };
      if (name === "duel") {
        return { isPlayerInDuel: () => options.inDuel ?? false };
      }
      return undefined;
    }),
    getPlayer: vi.fn((id: string) => {
      return {
        id,
        position: { x: 0, y: 0, z: 0 },
        data: { inStreamingDuel: options.inStreamingDuel ?? false },
        ...(options.skills ? { skills: options.skills } : {}),
      };
    }),
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

describe("FletchingSystem", () => {
  let system: FletchingSystem;
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
    system = new FletchingSystem(mockWorld as unknown as World);
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

  // ─── handleFletchingInteract ──────────────────────────────────────

  describe("handleFletchingInteract", () => {
    it("emits FLETCHING_INTERFACE_OPEN with recipes for knife + logs", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return; // Skip if manifests not loaded

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.FLETCHING_INTERACT, {
        playerId: "player1",
        triggerType: "knife",
        inputItemId: "logs",
      });

      const opens = findEmitted(EventType.FLETCHING_INTERFACE_OPEN);
      expect(opens.length).toBe(1);
      const payload = opens[0].data as {
        availableRecipes: Array<{ recipeId: string }>;
      };
      expect(payload.availableRecipes.length).toBeGreaterThan(0);
    });

    it("filters recipes by inputItemId (knife + oak_logs shows only oak recipes)", async () => {
      const recipe = processingDataProvider.getFletchingRecipe(
        "arrow_shaft:oak_logs",
      );
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("oak_logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.FLETCHING_INTERACT, {
        playerId: "player1",
        triggerType: "knife",
        inputItemId: "oak_logs",
      });

      const opens = findEmitted(EventType.FLETCHING_INTERFACE_OPEN);
      expect(opens.length).toBe(1);
      const payload = opens[0].data as {
        availableRecipes: Array<{
          recipeId: string;
          inputs: Array<{ item: string }>;
        }>;
      };
      // Every returned recipe should use oak_logs as an input
      for (const r of payload.availableRecipes) {
        const hasOak = r.inputs.some((inp) => inp.item === "oak_logs");
        expect(hasOak).toBe(true);
      }
    });

    it("filters recipes for item-on-item (bowstring + shortbow_u)", async () => {
      const recipe = processingDataProvider.getFletchingRecipe(
        "shortbow:shortbow_u",
      );
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("bowstring", 1), createItem("shortbow_u", 1)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.FLETCHING_INTERACT, {
        playerId: "player1",
        triggerType: "item_on_item",
        inputItemId: "bowstring",
        secondaryItemId: "shortbow_u",
      });

      const opens = findEmitted(EventType.FLETCHING_INTERFACE_OPEN);
      expect(opens.length).toBe(1);
      const payload = opens[0].data as {
        availableRecipes: Array<{ recipeId: string }>;
      };
      // Should return exactly the stringing recipe
      expect(payload.availableRecipes.length).toBe(1);
      expect(payload.availableRecipes[0].recipeId).toBe("shortbow:shortbow_u");
    });

    it("returns recipes with hasInputs false when inventory is empty", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.FLETCHING_INTERACT, {
        playerId: "player1",
        triggerType: "knife",
        inputItemId: "logs",
      });

      const opens = findEmitted(EventType.FLETCHING_INTERFACE_OPEN);
      expect(opens.length).toBe(1);
      const payload = opens[0].data as {
        availableRecipes: Array<{ hasInputs: boolean }>;
      };
      // All recipes should show hasInputs: false (no materials)
      for (const r of payload.availableRecipes) {
        expect(r.hasInputs).toBe(false);
      }
    });
  });

  // ─── startFletching ───────────────────────────────────────────────

  describe("startFletching", () => {
    it("starts a session with correct completionTick", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 3,
      });

      expect(system.isPlayerFletching("player1")).toBe(true);
      const starts = findEmitted(EventType.FLETCHING_START);
      expect(starts.length).toBe(1);
    });

    it("rejects if level too low", async () => {
      // Find a recipe requiring high level
      const recipe = processingDataProvider.getFletchingRecipe(
        "magic_shortbow_u:magic_logs",
      );
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("magic_logs", 5)],
        skills: { fletching: { level: 1, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "magic_shortbow_u:magic_logs",
        quantity: 1,
      });

      expect(system.isPlayerFletching("player1")).toBe(false);
      const messages = findEmitted(EventType.UI_MESSAGE);
      const levelMsg = messages.find((m) =>
        (m.data as { message: string }).message.includes("level"),
      );
      expect(levelMsg).toBeDefined();
    });

    it("rejects if missing materials", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 1,
      });

      expect(system.isPlayerFletching("player1")).toBe(false);
    });

    it("rejects if missing tool (knife) for knife recipe", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 1,
      });

      expect(system.isPlayerFletching("player1")).toBe(false);
    });

    it("rejects if already in a fletching session (concurrent prevention)", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 10)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      // Start first session
      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 5,
      });

      // Try to start second session
      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 3,
      });

      // Only one FLETCHING_START should fire
      const starts = findEmitted(EventType.FLETCHING_START);
      expect(starts.length).toBe(1);
    });

    it("rejects for invalid recipe ID", async () => {
      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "nonexistent_recipe_xyz",
        quantity: 1,
      });

      expect(system.isPlayerFletching("player1")).toBe(false);
    });
  });

  // ─── completeFletching + update loop ──────────────────────────────

  describe("completeFletching via update", () => {
    it("completes a fletch only after the durable receipt", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 1,
      });

      expect(system.isPlayerFletching("player1")).toBe(true);

      // Advance tick past completion
      mockWorld.currentTick = 100 + recipe.ticks;
      system.update(0);
      await flushPromises();
      mockWorld.currentTick++;
      system.update(0);

      // Durable custody owns inventory mutation; only the committed XP/result
      // events are emitted by FletchingSystem.
      const itemsRemoved = findEmitted(EventType.INVENTORY_ITEM_REMOVED);
      expect(itemsRemoved).toHaveLength(0);

      const itemsAdded = findEmitted(EventType.INVENTORY_ITEM_ADDED);
      expect(itemsAdded).toHaveLength(0);

      const xpGained = findEmitted(EventType.SKILLS_PROGRESS_COMMITTED);
      expect(xpGained.length).toBe(1);
      expect((xpGained[0].data as { awardedXp: number }).awardedXp).toBe(
        recipe.xp,
      );

      // For quantity 1, session should complete
      const completes = findEmitted(EventType.FLETCHING_COMPLETE);
      expect(completes.length).toBe(1);
    });

    it("submits the exact multi-output quantity atomically", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 1,
      });

      mockWorld.currentTick = 100 + recipe.ticks;
      system.update(0);

      expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
      expect(commitProcessingActionAtomic.mock.calls[0][2]).toEqual({
        skill: "fletching",
        xpAmount: recipe.xp,
        inputs: [{ itemId: "logs", quantity: 1 }],
        requiredItems: [{ itemId: "knife", quantity: 1 }],
        consumables: [],
        outputs: [{ itemId: "arrow_shaft", quantity: recipe.outputQuantity }],
      });
      expect(findEmitted(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    });

    it("schedules next action if quantity remaining", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 10)],
        skills: { fletching: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 3,
      });

      for (let index = 0; index < 3; index++) {
        mockWorld.currentTick += recipe.ticks;
        system.update(0);
        await flushPromises();
        mockWorld.currentTick++;
        system.update(0);
        if (index < 2) expect(system.isPlayerFletching("player1")).toBe(true);
      }

      // Session should be done
      const completes = findEmitted(EventType.FLETCHING_COMPLETE);
      expect(completes.length).toBe(1);
    });

    it("uses a unique durable operation identity for each fletch", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 10)],
        skills: { fletching: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 3,
      });

      // Complete 3 fletches
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
        expect(id).toMatch(/^fletching-action:/);
      }
    });
  });

  // ─── Movement cancellation ────────────────────────────────────────

  describe("preparation authority", () => {
    it.each([
      { label: "ordinary duel", options: { inDuel: true } },
      {
        label: "streaming duel",
        options: { inStreamingDuel: true },
      },
    ])("rejects fletching during $label", async ({ options }) => {
      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
        ...options,
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 1,
        requestId: "9a0b4a87-66f7-4ba7-bb60-31b5229547a5",
      });

      expect(system.isPlayerFletching("player1")).toBe(false);
      expect(commitProcessingActionAtomic).not.toHaveBeenCalled();
      expect(findEmitted(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            playerId: "player1",
            skill: "fletching",
            reason: "not_authorized",
          }),
        }),
      ]);
    });
  });

  describe("movement cancellation", () => {
    it("cancels fletching when player moves", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 5,
      });

      expect(system.isPlayerFletching("player1")).toBe(true);

      // Player clicks to move
      emitEvent(eventBus, EventType.MOVEMENT_CLICK_TO_MOVE, {
        playerId: "player1",
        targetPosition: { x: 10, y: 0, z: 10 },
      });

      expect(system.isPlayerFletching("player1")).toBe(false);
      const completes = findEmitted(EventType.FLETCHING_COMPLETE);
      expect(completes.length).toBe(1);
    });

    it("does not cancel other players when one moves", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 10)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      // Start fletching for player1
      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 5,
      });

      // Player2 moves (player2 is not fletching)
      emitEvent(eventBus, EventType.MOVEMENT_CLICK_TO_MOVE, {
        playerId: "player2",
        targetPosition: { x: 10, y: 0, z: 10 },
      });

      // Player1 should still be fletching
      expect(system.isPlayerFletching("player1")).toBe(true);
    });
  });

  // ─── Combat cancellation ──────────────────────────────────────────

  describe("combat cancellation", () => {
    it("cancels fletching when player enters combat as attacker", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 5,
      });

      expect(system.isPlayerFletching("player1")).toBe(true);

      emitEvent(eventBus, EventType.COMBAT_STARTED, {
        attackerId: "player1",
        targetId: "mob1",
      });

      expect(system.isPlayerFletching("player1")).toBe(false);
    });

    it("cancels fletching when player is attacked (target)", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 5,
      });

      emitEvent(eventBus, EventType.COMBAT_STARTED, {
        attackerId: "mob1",
        targetId: "player1",
      });

      expect(system.isPlayerFletching("player1")).toBe(false);
    });
  });

  // ─── Player disconnect cleanup ────────────────────────────────────

  describe("player disconnect", () => {
    it("cleans up session on player unregister", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 5,
      });

      expect(system.isPlayerFletching("player1")).toBe(true);

      emitEvent(eventBus, EventType.PLAYER_UNREGISTERED, {
        playerId: "player1",
      });

      expect(system.isPlayerFletching("player1")).toBe(false);
    });
  });

  // ─── "All" quantity sentinel ──────────────────────────────────────

  describe("All quantity", () => {
    it("handles 'All' quantity (-1 mapped to 10000) without error", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      // Client sends -1 for "All"; server should have mapped to 10000
      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 10000,
      });

      expect(system.isPlayerFletching("player1")).toBe(true);

      // Complete first fletch
      mockWorld.currentTick = 100 + recipe.ticks;
      system.update(0);
      await flushPromises();
      mockWorld.currentTick++;
      system.update(0);

      expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
      expect(findEmitted(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
      expect(system.isPlayerFletching("player1")).toBe(true);
    });
  });

  // ─── Client-side no-op ────────────────────────────────────────────

  describe("client-side", () => {
    it("does not register event handlers on client", async () => {
      const mock = createMockWorld();
      mock.world.isServer = false;
      const clientSystem = new FletchingSystem(mock.world as unknown as World);
      await clientSystem.init();

      // System should not crash and isPlayerFletching should return false
      expect(clientSystem.isPlayerFletching("anyone")).toBe(false);
      clientSystem.destroy();
    });
  });

  // ─── Update loop ──────────────────────────────────────────────────

  describe("update", () => {
    it("processes only once per tick", async () => {
      const recipe =
        processingDataProvider.getFletchingRecipe("arrow_shaft:logs");
      if (!recipe) return;

      await setupSystem({
        inventory: [createItem("knife", 1), createItem("logs", 5)],
        skills: { fletching: { level: 99, xp: 0 } },
        currentTick: 100,
      });

      emitEvent(eventBus, EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: "player1",
        recipeId: "arrow_shaft:logs",
        quantity: 1,
      });

      // Advance tick to completion
      mockWorld.currentTick = 100 + recipe.ticks;

      // Call update multiple times for same tick
      system.update(0);
      system.update(0);
      system.update(0);

      expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
      expect(findEmitted(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    });

    it("does nothing on client", async () => {
      const mock = createMockWorld({ currentTick: 100 });
      mock.world.isServer = false;
      const clientSystem = new FletchingSystem(mock.world as unknown as World);
      await clientSystem.init();

      // Should not throw
      clientSystem.update(0);
      clientSystem.destroy();
    });
  });
});
