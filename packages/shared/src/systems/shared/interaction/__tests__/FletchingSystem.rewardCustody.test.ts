import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processingDataProvider } from "../../../../data/ProcessingDataProvider";
import type { FletchingRecipeData } from "../../../../data/ProcessingDataProvider";
import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import type { AtomicProcessingActionReceipt } from "../../character/InventorySystem";
import { EventBus } from "../../infrastructure/EventBus";
import { FletchingSystem } from "../FletchingSystem";

const PLAYER_ID = "durable-fletcher";
const SHAFT_RECIPE: FletchingRecipeData = {
  recipeId: "arrow_shaft:logs",
  output: "arrow_shaft",
  name: "Arrow Shaft",
  category: "arrow_shafts",
  inputs: [{ item: "logs", amount: 1 }],
  tools: ["knife"],
  level: 1,
  xp: 5,
  ticks: 3,
  outputQuantity: 15,
};
const ARROW_RECIPE: FletchingRecipeData = {
  recipeId: "bronze_arrow:bronze_arrowtips",
  output: "bronze_arrow",
  name: "Bronze Arrow",
  category: "arrows",
  inputs: [
    { item: "bronze_arrowtips", amount: 15 },
    { item: "headless_arrow", amount: 15 },
  ],
  tools: [],
  level: 1,
  xp: 19.5,
  ticks: 1,
  outputQuantity: 15,
};

function committedReceipt(
  operationId: string,
  recipe: FletchingRecipeData = SHAFT_RECIPE,
): AtomicProcessingActionReceipt {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    playerId: PLAYER_ID,
    operationId,
    replayed: false,
    skill: "fletching",
    xpAmount: recipe.xp,
    inputs: recipe.inputs.map((input) => ({
      itemId: input.item,
      quantity: input.amount,
    })),
    requiredItems: recipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
    consumables: [],
    consumableStates: [],
    outputs: [
      {
        itemId: recipe.output,
        quantity: recipe.outputQuantity,
        stackable: true,
      },
    ],
    awardedXp: recipe.xp,
    operationCommittedXp: recipe.xp,
    currentXp: recipe.xp,
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
    skill: "fletching",
    xpAmount: SHAFT_RECIPE.xp,
    inputs: [{ itemId: "logs", quantity: 1 }],
    requiredItems: [{ itemId: "knife", quantity: 1 }],
    consumables: [],
    consumableStates: [],
    outputs: [{ itemId: "arrow_shaft", quantity: 15, stackable: true }],
    retryable: true,
    reason: "persistence_ambiguous",
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("FletchingSystem durable reward custody", () => {
  let system: FletchingSystem;
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
    vi.spyOn(processingDataProvider, "getFletchingRecipe").mockImplementation(
      (recipeId) =>
        recipeId === SHAFT_RECIPE.recipeId
          ? SHAFT_RECIPE
          : recipeId === ARROW_RECIPE.recipeId
            ? ARROW_RECIPE
            : null,
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
        { itemId: "knife", quantity: 1, slot: 0 },
        { itemId: "logs", quantity: 2, slot: 1 },
        { itemId: "bronze_arrowtips", quantity: 15, slot: 2 },
        { itemId: "headless_arrow", quantity: 15, slot: 3 },
      ]),
      getPlayer: vi.fn(() => ({
        id: PLAYER_ID,
        position: { x: 0, y: 0, z: 0 },
        data: { inStreamingDuel: false },
        skills: { fletching: { level: 99, xp: 0 } },
      })),
      getSystem: vi.fn((name: string) => {
        if (name === "inventory") return { commitProcessingActionAtomic };
        if (name === "duel") return { isPlayerInDuel: () => false };
        return undefined;
      }),
    };
    system = new FletchingSystem(world as unknown as World);
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

  function startAndReachCompletion(
    recipe: FletchingRecipeData = SHAFT_RECIPE,
    quantity = 1,
    requestId?: string,
  ): void {
    emit(EventType.PROCESSING_FLETCHING_REQUEST, {
      playerId: PLAYER_ID,
      recipeId: recipe.recipeId,
      quantity,
      requestId,
    });
    world.currentTick = 100 + recipe.ticks;
    system.update(0.6);
  }

  it("immediately rejects a correlated invalid fletching request", () => {
    const requestId = "6909d401-4684-421d-9a61-c0c4f13c764f";
    emit(EventType.PROCESSING_FLETCHING_REQUEST, {
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
          skill: "fletching",
          reason: "invalid_request",
          retryable: false,
        },
      }),
    ]);
  });

  it("correlates a definitive durable fletching rejection", async () => {
    const requestId = "a8149f73-141d-4207-aee4-2f17e9092598";
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) => ({
        ...retryableReceipt(operationId),
        retryable: false,
        reason: "insufficient_items" as const,
      }),
    );
    startAndReachCompletion(SHAFT_RECIPE, 1, requestId);

    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({
      playerId: PLAYER_ID,
      skill: "fletching",
      phase: "working",
      targetPosition: null,
    });
    expect(events(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          requestId,
          skill: "fletching",
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
          skill: "fletching",
          reason: "resources_unavailable",
          retryable: false,
        }),
      }),
    );
  });

  it("exposes no input, multi-output, XP, animation, or success before commit", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    const requestId = "5d55ba9d-6abf-4ccd-b4af-53a57404b1a1";
    startAndReachCompletion(SHAFT_RECIPE, 1, requestId);

    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(commitProcessingActionAtomic.mock.calls[0][1]).toBe(
      `processing-request:fletching:${requestId}`,
    );
    expect(commitProcessingActionAtomic.mock.calls[0][2]).toEqual({
      skill: "fletching",
      xpAmount: 5,
      inputs: [{ itemId: "logs", quantity: 1 }],
      requiredItems: [{ itemId: "knife", quantity: 1 }],
      consumables: [],
      outputs: [{ itemId: "arrow_shaft", quantity: 15 }],
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
    world.currentTick++;
    system.update(0.6);

    expect(events(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(events(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          operationId,
          replayed: false,
          skill: "fletching",
          xpAmount: 5,
          awardedXp: 5,
          operationCommittedXp: 5,
          currentXp: 5,
          currentLevel: 1,
        },
      }),
    ]);
    expect(events(EventType.ANIMATION_PLAY)).toHaveLength(1);
    expect(events(EventType.FLETCHING_COMPLETE)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId }) }),
    ]);
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: PLAYER_ID, skill: null, phase: "idle" });
  });

  it("commits both arrow inputs, fifteen outputs, and fractional XP together", async () => {
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) =>
        committedReceipt(operationId, ARROW_RECIPE),
    );
    startAndReachCompletion(ARROW_RECIPE);

    expect(commitProcessingActionAtomic.mock.calls[0][2]).toEqual({
      skill: "fletching",
      xpAmount: 19.5,
      inputs: [
        { itemId: "bronze_arrowtips", quantity: 15 },
        { itemId: "headless_arrow", quantity: 15 },
      ],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "bronze_arrow", quantity: 15 }],
    });
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    await flushPromises();
    world.currentTick++;
    system.update(0.6);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          xpAmount: 19.5,
          awardedXp: 19.5,
          operationCommittedXp: 19.5,
          currentXp: 19.5,
          currentLevel: 1,
        }),
      }),
    ]);
  });

  it("retains the exact multi-output action identity across retry", async () => {
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) =>
        commitProcessingActionAtomic.mock.calls.length === 1
          ? retryableReceipt(operationId)
          : committedReceipt(operationId),
    );
    startAndReachCompletion();
    await flushPromises();
    world.currentTick++;
    system.update(0.6);
    world.currentTick += 2;
    system.update(0.6);
    await flushPromises();
    world.currentTick++;
    system.update(0.6);

    expect(commitProcessingActionAtomic).toHaveBeenCalledTimes(2);
    expect(commitProcessingActionAtomic.mock.calls[0]).toEqual(
      commitProcessingActionAtomic.mock.calls[1],
    );
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
  });

  it("reconciles one committed fletch after disconnect and stops future work", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    startAndReachCompletion(SHAFT_RECIPE, 2);
    const operationId = commitProcessingActionAtomic.mock.calls[0][1];
    emit(EventType.PLAYER_UNREGISTERED, { playerId: PLAYER_ID });
    release?.(committedReceipt(operationId));
    await flushPromises();
    world.currentTick++;
    system.update(0.6);

    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(events(EventType.FLETCHING_COMPLETE)).toHaveLength(1);
    world.currentTick = 200;
    system.update(0.6);
    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(system.getFletchingCustodyStats()).toEqual({
      activeSessions: 0,
      pendingActions: 0,
      inFlight: 0,
      retryWaiting: 0,
      maxRetryCount: 0,
    });
  });

  it("keeps a late committed fletch but does not resurrect work presentation after movement", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    startAndReachCompletion(SHAFT_RECIPE, 2);
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
    world.currentTick++;
    system.update(0.6);

    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(events(EventType.FLETCHING_COMPLETE)).toHaveLength(1);
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

  it("bounds a non-finite internal quantity to one action", async () => {
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) =>
        committedReceipt(operationId),
    );
    startAndReachCompletion(SHAFT_RECIPE, Number.NaN);
    await flushPromises();
    world.currentTick++;
    system.update(0.6);
    world.currentTick = 200;
    system.update(0.6);

    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(events(EventType.FLETCHING_COMPLETE)).toHaveLength(1);
    expect(system.isPlayerFletching(PLAYER_ID)).toBe(false);
  });

  it("drains exactly one in-flight fletch after quiescence with no later batch or presentation", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    startAndReachCompletion(SHAFT_RECIPE, 2);
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
    world.currentTick++;
    system.update(0.6);
    world.currentTick = 200;
    system.update(0.6);

    expect(system.isPlayerProcessingQuiescent(PLAYER_ID)).toBe(true);
    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(events(EventType.FLETCHING_COMPLETE)).toHaveLength(1);
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION)
        .slice(presentationBoundary)
        .some(
          (event) => (event.data as { phase?: string }).phase === "working",
        ),
    ).toBe(false);
  });
});
