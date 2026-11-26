import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processingDataProvider } from "../../../../data/ProcessingDataProvider";
import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import type { AtomicProcessingActionReceipt } from "../../character/InventorySystem";
import { EventBus } from "../../infrastructure/EventBus";
import { SmithingSystem } from "../SmithingSystem";

const PLAYER_ID = "durable-smith";
const RECIPE = {
  itemId: "bronze_shortsword",
  name: "Bronze Shortsword",
  barType: "bronze_bar",
  barsRequired: 1,
  levelRequired: 1,
  xp: 12.5,
  category: "shortsword" as const,
  ticks: 4,
  outputQuantity: 1,
};

function successReceipt(operationId: string): AtomicProcessingActionReceipt {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    playerId: PLAYER_ID,
    operationId,
    replayed: false,
    skill: "smithing",
    xpAmount: 12.5,
    inputs: [{ itemId: "bronze_bar", quantity: 1 }],
    requiredItems: [{ itemId: "hammer", quantity: 1 }],
    consumables: [],
    consumableStates: [],
    outputs: [
      {
        itemId: "bronze_shortsword",
        quantity: 1,
        stackable: false,
      },
    ],
    awardedXp: 12.5,
    operationCommittedXp: 12.5,
    currentXp: 12.5,
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
    skill: "smithing",
    xpAmount: 12.5,
    inputs: [{ itemId: "bronze_bar", quantity: 1 }],
    requiredItems: [{ itemId: "hammer", quantity: 1 }],
    consumables: [],
    consumableStates: [],
    outputs: [
      {
        itemId: "bronze_shortsword",
        quantity: 1,
        stackable: false,
      },
    ],
    retryable: true,
    reason: "persistence_ambiguous",
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SmithingSystem durable reward custody", () => {
  let system: SmithingSystem;
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
    vi.spyOn(processingDataProvider, "getSmithingRecipe").mockImplementation(
      (recipeId) => (recipeId === RECIPE.itemId ? RECIPE : null),
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
        { itemId: "hammer", quantity: 1, slot: 0 },
        { itemId: "bronze_bar", quantity: 1, slot: 1 },
      ]),
      getPlayer: vi.fn(() => ({
        position: { x: 1, y: 0, z: 1 },
        data: {},
        skills: { smithing: { level: 1, xp: 0 } },
      })),
      getSystem: vi.fn((name: string) =>
        name === "inventory" ? { commitProcessingActionAtomic } : undefined,
      ),
    };
    world.entities.set("launch_anvil", {
      entityType: "anvil",
      position: { x: 2, y: 0, z: 1 },
      canInteract: vi.fn(() => true),
    });
    system = new SmithingSystem(world as unknown as World);
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

  function startAndReachCompletionTick(requestId?: string): void {
    emit(EventType.SMITHING_INTERACT, {
      playerId: PLAYER_ID,
      anvilId: "launch_anvil",
    });
    emit(EventType.PROCESSING_SMITHING_REQUEST, {
      playerId: PLAYER_ID,
      recipeId: RECIPE.itemId,
      anvilId: "launch_anvil",
      quantity: 1,
      requestId,
    });
    world.currentTick = 104;
    system.update(0.6);
  }

  it("immediately rejects a correlated invalid smithing request", () => {
    const requestId = "3df49f6c-e2d8-423a-87a1-02c8fb6b9fa8";
    emit(EventType.SMITHING_INTERACT, {
      playerId: PLAYER_ID,
      anvilId: "launch_anvil",
    });
    emit(EventType.PROCESSING_SMITHING_REQUEST, {
      playerId: PLAYER_ID,
      recipeId: "not_a_recipe",
      anvilId: "launch_anvil",
      quantity: 1,
      requestId,
    });

    expect(events(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          requestId,
          skill: "smithing",
          reason: "invalid_request",
          retryable: false,
        },
      }),
    ]);
  });

  it("correlates a definitive durable smithing rejection", async () => {
    const requestId = "4c973ba8-8bec-49e9-a481-66b4a7f1d6a1";
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) => ({
        ...retryableReceipt(operationId),
        retryable: false,
        reason: "insufficient_items" as const,
      }),
    );
    startAndReachCompletionTick(requestId);

    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({
      playerId: PLAYER_ID,
      skill: "smithing",
      phase: "working",
      targetPosition: { x: 2, y: 0, z: 1 },
    });
    expect(events(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          requestId,
          skill: "smithing",
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
          skill: "smithing",
          reason: "resources_unavailable",
          retryable: false,
        }),
      }),
    );
  });

  it("emits no product, XP, or success before the durable receipt", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    const requestId = "1ca8669e-4717-4582-8981-b8572929597d";
    startAndReachCompletionTick(requestId);

    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(commitProcessingActionAtomic.mock.calls[0][1]).toBe(
      `processing-request:smithing:${requestId}`,
    );
    expect(events(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(events(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    expect(
      events(EventType.UI_MESSAGE).some(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toBe(false);

    const operationId = commitProcessingActionAtomic.mock.calls[0][1];
    release?.(successReceipt(operationId));
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);

    expect(events(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(events(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          operationId,
          replayed: false,
          skill: "smithing",
          xpAmount: 12.5,
          awardedXp: 12.5,
          operationCommittedXp: 12.5,
          currentXp: 12.5,
          currentLevel: 1,
        },
      }),
    ]);
    expect(events(EventType.SMITHING_COMPLETE)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId }) }),
    ]);
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: PLAYER_ID, skill: null, phase: "idle" });
    expect(system.getSmithingCustodyStats()).toEqual({
      activeSessions: 0,
      pendingActions: 0,
      inFlight: 0,
      retryWaiting: 0,
      maxRetryCount: 0,
    });
  });

  it("retains the exact operation identity across bounded retry delay", async () => {
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) =>
        commitProcessingActionAtomic.mock.calls.length === 1
          ? retryableReceipt(operationId)
          : successReceipt(operationId),
    );
    startAndReachCompletionTick();
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);

    world.currentTick = 107;
    system.update(0.6);
    await flushPromises();
    world.currentTick = 108;
    system.update(0.6);

    expect(commitProcessingActionAtomic).toHaveBeenCalledTimes(2);
    expect(commitProcessingActionAtomic.mock.calls[0][1]).toBe(
      commitProcessingActionAtomic.mock.calls[1][1],
    );
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
  });

  it("reconciles a committed item once after disconnect cancels future work", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    startAndReachCompletionTick();
    const operationId = commitProcessingActionAtomic.mock.calls[0][1];
    emit(EventType.PLAYER_UNREGISTERED, { playerId: PLAYER_ID });
    release?.(successReceipt(operationId));
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);

    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(events(EventType.SMITHING_COMPLETE)).toHaveLength(1);
    world.currentTick = 200;
    system.update(0.6);
    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
  });

  it("keeps a late committed item but does not resurrect anvil presentation after movement", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    startAndReachCompletionTick();
    const operationId = commitProcessingActionAtomic.mock.calls[0][1];

    emit(EventType.MOVEMENT_CLICK_TO_MOVE, {
      playerId: PLAYER_ID,
      targetPosition: { x: 10, y: 0, z: 10 },
    });
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ skill: null, phase: "idle" });
    release?.(successReceipt(operationId));
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);

    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(events(EventType.SMITHING_COMPLETE)).toHaveLength(1);
    expect(events(EventType.ANIMATION_PLAY)).toHaveLength(0);
    expect(
      events(EventType.UI_MESSAGE).some(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toBe(false);
  });

  it("drains exactly one in-flight smith after quiescence with no later batch or presentation", async () => {
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    startAndReachCompletionTick();
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

    release?.(successReceipt(operationId));
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);
    world.currentTick = 200;
    system.update(0.6);

    expect(system.isPlayerProcessingQuiescent(PLAYER_ID)).toBe(true);
    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(events(EventType.SMITHING_COMPLETE)).toHaveLength(1);
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION)
        .slice(presentationBoundary)
        .some(
          (event) => (event.data as { phase?: string }).phase === "working",
        ),
    ).toBe(false);
  });
});
