import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processingDataProvider } from "../../../../data/ProcessingDataProvider";
import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import type { AtomicProcessingActionReceipt } from "../../character/InventorySystem";
import { EventBus } from "../../infrastructure/EventBus";
import { CraftingSystem } from "../CraftingSystem";

const PLAYER_ID = "durable-crafter";
const RECIPE = {
  output: "leather_gloves",
  name: "Leather Gloves",
  category: "leather",
  inputs: [{ item: "leather", amount: 1 }],
  tools: ["needle"],
  consumables: [{ item: "thread", uses: 5 }],
  level: 1,
  xp: 13.8,
  ticks: 3,
  station: "none",
};

function committedReceipt(operationId: string): AtomicProcessingActionReceipt {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    playerId: PLAYER_ID,
    operationId,
    replayed: false,
    skill: "crafting",
    xpAmount: 13.8,
    inputs: [{ itemId: "leather", quantity: 1 }],
    requiredItems: [{ itemId: "needle", quantity: 1 }],
    consumables: [{ itemId: "thread", usesPerItem: 5 }],
    consumableStates: [
      {
        itemId: "thread",
        usesPerItem: 5,
        remainingUses: 4,
        consumedQuantity: 0,
      },
    ],
    outputs: [{ itemId: "leather_gloves", quantity: 1, stackable: false }],
    awardedXp: 13.8,
    operationCommittedXp: 13.8,
    currentXp: 13.8,
    currentLevel: 1,
  };
}

function retryableReceipt(operationId: string): AtomicProcessingActionReceipt {
  return {
    ok: false,
    committed: false,
    liveInventoryApplied: false,
    playerId: PLAYER_ID,
    operationId,
    replayed: false,
    skill: "crafting",
    xpAmount: 13.8,
    inputs: [{ itemId: "leather", quantity: 1 }],
    requiredItems: [{ itemId: "needle", quantity: 1 }],
    consumables: [{ itemId: "thread", usesPerItem: 5 }],
    consumableStates: [],
    outputs: [{ itemId: "leather_gloves", quantity: 1, stackable: false }],
    retryable: true,
    reason: "persistence_ambiguous",
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CraftingSystem durable reward custody", () => {
  let system: CraftingSystem;
  let eventBus: EventBus;
  let world: {
    isServer: boolean;
    currentTick: number;
    $eventBus: EventBus;
    entities: Map<string, unknown>;
    getInventory: ReturnType<typeof vi.fn>;
    getPlayer: ReturnType<typeof vi.fn>;
    getSystem: ReturnType<typeof vi.fn>;
  };
  let commitProcessingActionAtomic: ReturnType<typeof vi.fn>;
  const emitted: Array<{ type: string; data: unknown }> = [];

  beforeEach(async () => {
    emitted.length = 0;
    vi.spyOn(processingDataProvider, "getCraftingRecipe").mockImplementation(
      (recipeId) => (recipeId === RECIPE.output ? RECIPE : null),
    );
    eventBus = new EventBus();
    const originalEmit = eventBus.emitEvent.bind(eventBus);
    vi.spyOn(eventBus, "emitEvent").mockImplementation((type, data, source) => {
      emitted.push({ type: String(type), data });
      return originalEmit(type, data, source);
    });
    commitProcessingActionAtomic = vi.fn();
    world = {
      isServer: true,
      currentTick: 100,
      $eventBus: eventBus,
      entities: new Map(),
      getInventory: vi.fn(() => [
        { itemId: "needle", quantity: 1, slot: 0 },
        { itemId: "thread", quantity: 1, slot: 1 },
        { itemId: "leather", quantity: 2, slot: 2 },
      ]),
      getPlayer: vi.fn(() => ({
        position: { x: 1, y: 0, z: 1 },
        data: {},
        skills: { crafting: { level: 1, xp: 0 } },
      })),
      getSystem: vi.fn((name: string) =>
        name === "inventory" ? { commitProcessingActionAtomic } : undefined,
      ),
    };
    system = new CraftingSystem(world as unknown as World);
    await system.init();
  });

  afterEach(() => {
    system.destroy();
    vi.restoreAllMocks();
  });

  function emit(type: EventType, data: Record<string, unknown>): void {
    eventBus.emitEvent(type, data, "test");
  }

  function events(type: EventType): Array<{ type: string; data: unknown }> {
    return emitted.filter((event) => event.type === type);
  }

  function startAndReachCompletionTick(quantity = 1, requestId?: string): void {
    emit(EventType.PROCESSING_CRAFTING_REQUEST, {
      playerId: PLAYER_ID,
      recipeId: RECIPE.output,
      quantity,
      requestId,
    });
    world.currentTick = 103;
    system.update(0.6);
  }

  it("immediately rejects a correlated invalid crafting request", () => {
    const requestId = "5b346aa6-5e4a-487f-ad13-7e8d46873e75";
    emit(EventType.PROCESSING_CRAFTING_REQUEST, {
      playerId: PLAYER_ID,
      recipeId: "not_a_recipe",
      quantity: 1,
      requestId,
    });

    expect(events(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          requestId,
          skill: "crafting",
          reason: "invalid_request",
          retryable: false,
        },
      }),
    ]);
  });

  it("correlates a definitive durable crafting rejection", async () => {
    const requestId = "db4dc6d1-2724-4d18-b987-82032a084462";
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) => ({
        ...retryableReceipt(operationId),
        retryable: false,
        reason: "insufficient_items" as const,
      }),
    );
    startAndReachCompletionTick(1, requestId);

    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({
      playerId: PLAYER_ID,
      skill: "crafting",
      phase: "working",
      targetPosition: null,
    });
    expect(events(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          requestId,
          skill: "crafting",
          phase: "accepted",
        },
      }),
    );
    await flushPromises();
    world.currentTick++;
    system.update(0.6);

    expect(events(EventType.PROCESSING_REQUEST_REJECTED)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          requestId,
          skill: "crafting",
          reason: "resources_unavailable",
          retryable: false,
        }),
      }),
    );
  });

  it("exposes no material, thread use, product, XP, animation, or success before commit", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    const requestId = "8a633611-20d8-4814-bdde-c57980b3120b";
    startAndReachCompletionTick(1, requestId);

    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(commitProcessingActionAtomic.mock.calls[0][1]).toBe(
      `processing-request:crafting:${requestId}`,
    );
    expect(commitProcessingActionAtomic.mock.calls[0][2]).toEqual({
      skill: "crafting",
      xpAmount: 13.8,
      inputs: [{ itemId: "leather", quantity: 1 }],
      requiredItems: [{ itemId: "needle", quantity: 1 }],
      consumables: [{ itemId: "thread", usesPerItem: 5 }],
      outputs: [{ itemId: "leather_gloves", quantity: 1 }],
    });
    expect(events(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(events(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    expect(events(EventType.ANIMATION_PLAY)).toHaveLength(0);
    expect(
      events(EventType.UI_MESSAGE).some(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toBe(false);

    const operationId = commitProcessingActionAtomic.mock.calls[0][1];
    release?.(committedReceipt(operationId));
    await flushPromises();
    world.currentTick = 104;
    system.update(0.6);

    expect(events(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(events(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          operationId,
          replayed: false,
          skill: "crafting",
          xpAmount: 13.8,
          awardedXp: 13.8,
          operationCommittedXp: 13.8,
          currentXp: 13.8,
          currentLevel: 1,
        },
      }),
    ]);
    expect(events(EventType.ANIMATION_PLAY)).toHaveLength(1);
    expect(events(EventType.CRAFTING_COMPLETE)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId }) }),
    ]);
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: PLAYER_ID, skill: null, phase: "idle" });
    expect(system.getCraftingCustodyStats()).toEqual({
      activeSessions: 0,
      pendingActions: 0,
      inFlight: 0,
      retryWaiting: 0,
      maxRetryCount: 0,
    });
  });

  it("retains the exact action and one thread-use identity across retry", async () => {
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) =>
        commitProcessingActionAtomic.mock.calls.length === 1
          ? retryableReceipt(operationId)
          : committedReceipt(operationId),
    );
    startAndReachCompletionTick();
    await flushPromises();
    world.currentTick = 104;
    system.update(0.6);
    world.currentTick = 106;
    system.update(0.6);
    await flushPromises();
    world.currentTick = 107;
    system.update(0.6);

    expect(commitProcessingActionAtomic).toHaveBeenCalledTimes(2);
    expect(commitProcessingActionAtomic.mock.calls[0]).toEqual(
      commitProcessingActionAtomic.mock.calls[1],
    );
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
  });

  it("reconciles one committed craft after disconnect and stops future work", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    startAndReachCompletionTick(2);
    const operationId = commitProcessingActionAtomic.mock.calls[0][1];
    emit(EventType.PLAYER_UNREGISTERED, { playerId: PLAYER_ID });
    release?.(committedReceipt(operationId));
    await flushPromises();
    world.currentTick = 104;
    system.update(0.6);

    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(events(EventType.CRAFTING_COMPLETE)).toHaveLength(1);
    world.currentTick = 200;
    system.update(0.6);
    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(system.getCraftingCustodyStats()).toEqual({
      activeSessions: 0,
      pendingActions: 0,
      inFlight: 0,
      retryWaiting: 0,
      maxRetryCount: 0,
    });
  });

  it("keeps a late committed craft but does not resurrect workshop presentation after movement", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    startAndReachCompletionTick(2);
    const operationId = commitProcessingActionAtomic.mock.calls[0][1];

    emit(EventType.MOVEMENT_CLICK_TO_MOVE, {
      playerId: PLAYER_ID,
      targetPosition: { x: 10, y: 0, z: 10 },
    });
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ skill: null, phase: "idle" });
    release?.(committedReceipt(operationId));
    await flushPromises();
    world.currentTick = 104;
    system.update(0.6);

    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(events(EventType.CRAFTING_COMPLETE)).toHaveLength(1);
    expect(events(EventType.ANIMATION_PLAY)).toHaveLength(0);
    expect(
      events(EventType.UI_MESSAGE).some(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toBe(false);
    world.currentTick = 200;
    system.update(0.6);
    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
  });

  it("drains exactly one in-flight craft after quiescence with no later batch or presentation", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    startAndReachCompletionTick(2);
    const operationId = commitProcessingActionAtomic.mock.calls[0][1];
    expect(system.isPlayerProcessingQuiescent(PLAYER_ID)).toBe(false);

    const presentationBoundary = events(
      EventType.PROCESSING_INTERACTION_PRESENTATION,
    ).length;
    system.requestPlayerProcessingQuiescence(PLAYER_ID);
    expect(system.isPlayerProcessingQuiescent(PLAYER_ID)).toBe(false);
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: PLAYER_ID, skill: null, phase: "idle" });

    release?.(committedReceipt(operationId));
    await flushPromises();
    world.currentTick = 104;
    system.update(0.6);
    world.currentTick = 200;
    system.update(0.6);

    expect(system.isPlayerProcessingQuiescent(PLAYER_ID)).toBe(true);
    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(events(EventType.CRAFTING_COMPLETE)).toHaveLength(1);
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION)
        .slice(presentationBoundary)
        .some(
          (event) => (event.data as { phase?: string }).phase === "working",
        ),
    ).toBe(false);
  });
});
