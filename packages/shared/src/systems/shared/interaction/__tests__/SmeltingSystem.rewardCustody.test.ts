import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processingDataProvider } from "../../../../data/ProcessingDataProvider";
import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import type { AtomicProcessingActionReceipt } from "../../character/InventorySystem";
import { EventBus } from "../../infrastructure/EventBus";
import { SmeltingSystem } from "../SmeltingSystem";

const PLAYER_ID = "durable-smelter";
const BAR_ITEM_ID = "iron_bar";
const RECIPE = {
  barItemId: BAR_ITEM_ID,
  primaryOre: "iron_ore",
  secondaryOre: null,
  coalRequired: 0,
  levelRequired: 15,
  xp: 12.5,
  ticks: 4,
  successRate: 0.5,
};
const STEEL_RECIPE = {
  barItemId: "steel_bar",
  primaryOre: "iron_ore",
  secondaryOre: null,
  coalRequired: 2,
  levelRequired: 30,
  xp: 17.5,
  ticks: 4,
  successRate: 1,
};

function committedReceipt(
  operationId: string,
  success: boolean,
): AtomicProcessingActionReceipt {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    playerId: PLAYER_ID,
    operationId,
    replayed: false,
    skill: "smithing",
    xpAmount: success ? 12.5 : 0,
    inputs: [{ itemId: "iron_ore", quantity: 1 }],
    requiredItems: [],
    consumables: [],
    consumableStates: [],
    outputs: success
      ? [{ itemId: BAR_ITEM_ID, quantity: 1, stackable: false }]
      : [],
    awardedXp: success ? 12.5 : 0,
    operationCommittedXp: success ? 93 : 80.5,
    currentXp: success ? 93 : 80.5,
    currentLevel: 2,
  };
}

function retryableReceipt(
  operationId: string,
  success: boolean,
): AtomicProcessingActionReceipt {
  return {
    ok: false,
    committed: false,
    liveInventoryApplied: false,
    playerId: PLAYER_ID,
    operationId,
    replayed: false,
    skill: "smithing",
    xpAmount: success ? 12.5 : 0,
    inputs: [{ itemId: "iron_ore", quantity: 1 }],
    requiredItems: [],
    consumables: [],
    consumableStates: [],
    outputs: success
      ? [{ itemId: BAR_ITEM_ID, quantity: 1, stackable: false }]
      : [],
    retryable: true,
    reason: "persistence_ambiguous",
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SmeltingSystem durable outcome custody", () => {
  let system: SmeltingSystem;
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
    vi.spyOn(processingDataProvider, "getSmeltingData").mockImplementation(
      (barItemId) =>
        barItemId === BAR_ITEM_ID
          ? RECIPE
          : barItemId === STEEL_RECIPE.barItemId
            ? STEEL_RECIPE
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
      getInventory: vi.fn(() => [{ itemId: "iron_ore", quantity: 2, slot: 0 }]),
      getPlayer: vi.fn(() => ({
        position: { x: 1, y: 0, z: 1 },
        data: {},
        skills: { smithing: { level: 15, xp: 80.5 } },
      })),
      getSystem: vi.fn((name: string) =>
        name === "inventory" ? { commitProcessingActionAtomic } : undefined,
      ),
    };
    world.entities.set("launch_furnace", {
      entityType: "furnace",
      position: { x: 2, y: 0, z: 1 },
      canInteract: vi.fn(() => true),
    });
    system = new SmeltingSystem(world as unknown as World);
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

  function startAndReachCompletionTick(
    quantity = 1,
    barItemId = BAR_ITEM_ID,
    smithingLevel = 15,
    requestId?: string,
  ): void {
    emit(EventType.SMELTING_INTERACT, {
      playerId: PLAYER_ID,
      furnaceId: "launch_furnace",
    });
    emit(EventType.SKILLS_UPDATED, {
      playerId: PLAYER_ID,
      skills: { smithing: { level: smithingLevel, xp: 80.5 } },
    });
    emit(EventType.PROCESSING_SMELTING_REQUEST, {
      playerId: PLAYER_ID,
      barItemId,
      furnaceId: "launch_furnace",
      quantity,
      requestId,
    });
    world.currentTick = 104;
    system.update(0.6);
  }

  it("immediately rejects a correlated invalid smelting request", () => {
    const requestId = "72649b60-fe9b-448d-986a-d874954475f8";
    emit(EventType.SMELTING_INTERACT, {
      playerId: PLAYER_ID,
      furnaceId: "launch_furnace",
    });
    emit(EventType.PROCESSING_SMELTING_REQUEST, {
      playerId: PLAYER_ID,
      barItemId: "not_a_bar",
      furnaceId: "launch_furnace",
      quantity: 1,
      requestId,
    });

    expect(events(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          requestId,
          skill: "smelting",
          reason: "invalid_request",
          retryable: false,
        },
      }),
    ]);
  });

  it("correlates a definitive durable smelting rejection", async () => {
    const requestId = "c51a8fc2-4d8e-49e3-9807-83fe194db436";
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) => ({
        ...retryableReceipt(operationId, true),
        retryable: false,
        reason: "insufficient_items" as const,
      }),
    );
    startAndReachCompletionTick(1, BAR_ITEM_ID, 15, requestId);

    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({
      playerId: PLAYER_ID,
      skill: "smelting",
      phase: "working",
      targetPosition: { x: 2, y: 0, z: 1 },
    });
    expect(events(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: PLAYER_ID,
          requestId,
          skill: "smelting",
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
          skill: "smelting",
          reason: "resources_unavailable",
          retryable: false,
        }),
      }),
    );
  });

  it("exposes no successful bar, XP, animation, or result before commit", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    let release: ((receipt: AtomicProcessingActionReceipt) => void) | undefined;
    commitProcessingActionAtomic.mockImplementation(
      (_playerId: string, operationId: string) =>
        new Promise<AtomicProcessingActionReceipt>((resolve) => {
          release = (receipt) => resolve({ ...receipt, operationId });
        }),
    );
    const requestId = "910108c3-e8f7-4fc3-9e1b-6c2aa0db3835";
    startAndReachCompletionTick(1, BAR_ITEM_ID, 15, requestId);

    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(commitProcessingActionAtomic.mock.calls[0][1]).toBe(
      `processing-request:smelting:${requestId}`,
    );
    expect(commitProcessingActionAtomic.mock.calls[0][2]).toEqual({
      skill: "smithing",
      xpAmount: 12.5,
      inputs: [{ itemId: "iron_ore", quantity: 1 }],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: BAR_ITEM_ID, quantity: 1 }],
    });
    expect(events(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(events(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    expect(events(EventType.ANIMATION_PLAY)).toHaveLength(0);
    expect(events(EventType.SMELTING_SUCCESS)).toHaveLength(0);

    const operationId = commitProcessingActionAtomic.mock.calls[0][1];
    release?.(committedReceipt(operationId, true));
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);

    expect(events(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(events(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(events(EventType.SMELTING_SUCCESS)).toHaveLength(1);
    expect(events(EventType.SMELTING_COMPLETE)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId }) }),
    ]);
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: PLAYER_ID, skill: null, phase: "idle" });
  });

  it("submits every distinct ore and coal requirement in one action", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    commitProcessingActionAtomic.mockImplementation(
      () => new Promise<AtomicProcessingActionReceipt>(() => undefined),
    );
    startAndReachCompletionTick(1, STEEL_RECIPE.barItemId, 30);

    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(commitProcessingActionAtomic.mock.calls[0][2]).toEqual({
      skill: "smithing",
      xpAmount: 17.5,
      inputs: [
        { itemId: "iron_ore", quantity: 1 },
        { itemId: "coal", quantity: 2 },
      ],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "steel_bar", quantity: 1 }],
    });
  });

  it("commits a failed roll as an input-only zero-XP outcome", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) =>
        committedReceipt(operationId, false),
    );
    startAndReachCompletionTick();
    await flushPromises();

    expect(commitProcessingActionAtomic.mock.calls[0][2]).toEqual({
      skill: "smithing",
      xpAmount: 0,
      inputs: [{ itemId: "iron_ore", quantity: 1 }],
      requiredItems: [],
      consumables: [],
      outputs: [],
    });
    expect(events(EventType.SMELTING_FAILURE)).toHaveLength(0);
    world.currentTick = 105;
    system.update(0.6);

    expect(events(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(events(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    expect(events(EventType.SMELTING_FAILURE)).toHaveLength(1);
    expect(events(EventType.SMELTING_COMPLETE)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ totalSmelted: 0, totalFailed: 1 }),
      }),
    ]);
  });

  it("retains the exact failed outcome and operation identity across retry", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
    commitProcessingActionAtomic.mockImplementation(
      async (_playerId: string, operationId: string) =>
        commitProcessingActionAtomic.mock.calls.length === 1
          ? retryableReceipt(operationId, false)
          : committedReceipt(operationId, false),
    );
    startAndReachCompletionTick();
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);
    world.currentTick = 107;
    system.update(0.6);
    await flushPromises();
    world.currentTick = 108;
    system.update(0.6);

    expect(commitProcessingActionAtomic).toHaveBeenCalledTimes(2);
    expect(commitProcessingActionAtomic.mock.calls[0]).toEqual(
      commitProcessingActionAtomic.mock.calls[1],
    );
    expect(random).toHaveBeenCalledOnce();
    expect(events(EventType.SMELTING_FAILURE)).toHaveLength(1);
  });

  it("reconciles one committed result after disconnect and stops future smelts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
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
    release?.(committedReceipt(operationId, true));
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);

    expect(events(EventType.SMELTING_SUCCESS)).toHaveLength(1);
    expect(events(EventType.SMELTING_COMPLETE)).toHaveLength(1);
    world.currentTick = 200;
    system.update(0.6);
    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(system.getSmeltingCustodyStats()).toEqual({
      activeSessions: 0,
      pendingActions: 0,
      inFlight: 0,
      retryWaiting: 0,
      maxRetryCount: 0,
    });
  });

  it("keeps a late committed result but does not resurrect station presentation after movement", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
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
    release?.(committedReceipt(operationId, true));
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);

    expect(events(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(events(EventType.SMELTING_SUCCESS)).toHaveLength(1);
    expect(events(EventType.SMELTING_COMPLETE)).toHaveLength(1);
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

  it("drains exactly one in-flight smelt after quiescence with no later batch or presentation", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
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

    release?.(committedReceipt(operationId, true));
    await flushPromises();
    world.currentTick = 105;
    system.update(0.6);
    world.currentTick = 200;
    system.update(0.6);

    expect(system.isPlayerProcessingQuiescent(PLAYER_ID)).toBe(true);
    expect(commitProcessingActionAtomic).toHaveBeenCalledOnce();
    expect(events(EventType.SMELTING_COMPLETE)).toHaveLength(1);
    expect(
      events(EventType.PROCESSING_INTERACTION_PRESENTATION)
        .slice(presentationBoundary)
        .some(
          (event) => (event.data as { phase?: string }).phase === "working",
        ),
    ).toBe(false);
  });
});
