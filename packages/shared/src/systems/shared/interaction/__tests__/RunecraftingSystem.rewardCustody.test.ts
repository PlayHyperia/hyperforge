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

type ProcessingInput = Parameters<
  InventorySystem["commitProcessingActionAtomic"]
>[2];

interface CommitCall {
  playerId: string;
  operationId: string;
  input: ProcessingInput;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function successReceipt(
  call: CommitCall,
  overrides: Partial<Extract<AtomicProcessingActionReceipt, { ok: true }>> = {},
): AtomicProcessingActionReceipt {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    playerId: call.playerId,
    operationId: call.operationId,
    replayed: false,
    skill: call.input.skill,
    xpAmount: call.input.xpAmount,
    inputs: call.input.inputs,
    requiredItems: call.input.requiredItems ?? [],
    consumables: call.input.consumables ?? [],
    consumableStates: [],
    outputs: call.input.outputs.map((output) => ({
      ...output,
      stackable: true,
    })),
    awardedXp: call.input.xpAmount,
    operationCommittedXp: call.input.xpAmount,
    currentXp: call.input.xpAmount,
    currentLevel: 1,
    ...overrides,
  };
}

function failureReceipt(
  call: CommitCall,
  reason: "inventory_busy" | "insufficient_items",
  retryable: boolean,
): AtomicProcessingActionReceipt {
  return {
    ok: false,
    committed: false,
    liveInventoryApplied: false,
    playerId: call.playerId,
    operationId: call.operationId,
    replayed: false,
    skill: call.input.skill,
    xpAmount: call.input.xpAmount,
    inputs: call.input.inputs,
    requiredItems: call.input.requiredItems ?? [],
    consumables: call.input.consumables ?? [],
    consumableStates: [],
    outputs: call.input.outputs.map((output) => ({
      ...output,
      stackable: true,
    })),
    retryable,
    reason,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RunecraftingSystem durable reward custody", () => {
  let system: RunecraftingSystem | undefined;
  let eventBus: EventBus;
  let world: {
    isServer: boolean;
    currentTick: number;
    $eventBus: EventBus;
    entities: Map<string, unknown>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    getSystem: ReturnType<typeof vi.fn>;
    getPlayer: ReturnType<typeof vi.fn>;
    getInventory: ReturnType<typeof vi.fn>;
    network: { send: ReturnType<typeof vi.fn> };
  };
  let calls: CommitCall[];
  let commitImplementation: (
    playerId: string,
    operationId: string,
    input: ProcessingInput,
  ) => Promise<AtomicProcessingActionReceipt>;
  const emitted: Array<{ type: string; data: unknown }> = [];

  beforeEach(async () => {
    const recipePath = [
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
    ].find((candidate) => fs.existsSync(candidate));
    if (!recipePath) {
      throw new Error("Runecrafting manifest is required for custody tests");
    }
    processingDataProvider.loadRunecraftingRecipes(
      JSON.parse(fs.readFileSync(recipePath, "utf-8")) as RunecraftingManifest,
    );
    processingDataProvider.rebuild();

    emitted.length = 0;
    calls = [];
    eventBus = new EventBus();
    const originalEmit = eventBus.emitEvent.bind(eventBus);
    eventBus.emitEvent = (type: string, data: unknown, source?: string) => {
      emitted.push({ type, data });
      return originalEmit(type, data, source);
    };
    const atomicInventory = {
      commitProcessingActionAtomic: vi.fn(
        (playerId: string, operationId: string, input: ProcessingInput) => {
          calls.push({ playerId, operationId, input });
          return commitImplementation(playerId, operationId, input);
        },
      ),
    };
    world = {
      isServer: true,
      currentTick: 100,
      $eventBus: eventBus,
      entities: new Map([
        [
          "air_altar",
          {
            id: "air_altar",
            entityType: "runecrafting_altar",
            runeType: "air",
            position: { x: 1, y: 0, z: 0 },
            isPlayerInRange: () => true,
          },
        ],
      ]),
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      getSystem: vi.fn((name: string) =>
        name === "inventory" ? atomicInventory : undefined,
      ),
      getPlayer: vi.fn(() => ({
        id: "player1",
        position: { x: 0, y: 0, z: 0 },
        skills: { runecrafting: { level: 1, xp: 0 } },
      })),
      getInventory: vi.fn(() => [
        {
          id: "pure",
          itemId: "pure_essence",
          quantity: 2,
          slot: 0,
          metadata: null,
        },
        {
          id: "basic",
          itemId: "rune_essence",
          quantity: 3,
          slot: 1,
          metadata: null,
        },
      ]),
      network: { send: vi.fn() },
    };
    commitImplementation = async (playerId, operationId, input) =>
      successReceipt({ playerId, operationId, input });
    system = new RunecraftingSystem(world as unknown as World);
    await system.init();
  });

  afterEach(() => {
    system?.destroy();
    system = undefined;
    vi.restoreAllMocks();
  });

  function emitInteraction(requestId?: string): void {
    eventBus.emitEvent(
      EventType.RUNECRAFTING_INTERACT,
      {
        playerId: "player1",
        altarId: "air_altar",
        runeType: "air",
        requestId,
      },
      "test",
    );
  }

  function findEvents(type: string) {
    return emitted.filter((event) => event.type === type);
  }

  it("immediately rejects a correlated unauthorized runecrafting request", () => {
    const requestId = "ee7135d1-1d42-4c6d-b239-64f601f1ee7a";
    world.entities.delete("air_altar");
    emitInteraction(requestId);

    expect(findEvents(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "runecrafting",
          reason: "not_authorized",
          retryable: false,
        },
      }),
    ]);
  });

  it("emits no success, XP, or completion signal before durable commit", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;

    const requestId = "71777afa-363e-40a9-ad43-392482698c52";
    emitInteraction(requestId);

    expect(findEvents(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "runecrafting",
          phase: "accepted",
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({
      playerId: "player1",
      skill: "runecrafting",
      phase: "working",
      targetPosition: { x: 1, y: 0, z: 0 },
    });
    expect(calls[0].operationId).toBe(
      `processing-request:runecrafting:${requestId}`,
    );
    expect(calls[0].input).toMatchObject({
      skill: "runecrafting",
      inputs: [
        { itemId: "pure_essence", quantity: 2 },
        { itemId: "rune_essence", quantity: 3 },
      ],
      outputs: [{ itemId: "air_rune", quantity: 5 }],
    });
    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(0);
    expect(
      findEvents(EventType.UI_MESSAGE).filter(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toHaveLength(0);

    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(0);
    system?.update(0);

    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId }) }),
    ]);
    expect(system?.getRunecraftingCustodyStats().pendingActions).toBe(0);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: "player1", skill: null, phase: "idle" });
  });

  it("retries an ambiguous rejection with the same operation and payload", async () => {
    const retry = deferred<AtomicProcessingActionReceipt>();
    let attempt = 0;
    commitImplementation = async (playerId, operationId, input) => {
      attempt++;
      if (attempt === 1) throw new Error("temporary database failure");
      return retry.promise;
    };

    emitInteraction();
    await flushPromises();

    expect(system?.getRunecraftingCustodyStats()).toEqual({
      pendingActions: 1,
      inFlight: 0,
      retryWaiting: 1,
      maxRetryCount: 1,
    });
    world.currentTick = 101;
    system?.update(0);
    expect(calls).toHaveLength(1);
    world.currentTick = 102;
    system?.update(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].operationId).toBe(calls[0].operationId);
    expect(calls[1].input).toEqual(calls[0].input);

    retry.resolve(successReceipt(calls[1], { replayed: true }));
    await flushPromises();
    system?.update(0);
    system?.update(0);
    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("retries a retryable receipt and rejects a duplicate while pending", async () => {
    const first = deferred<AtomicProcessingActionReceipt>();
    const second = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () =>
      calls.length === 1 ? first.promise : second.promise;

    emitInteraction();
    emitInteraction();
    expect(calls).toHaveLength(1);
    expect(findEvents(EventType.UI_MESSAGE)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "info",
          message: expect.stringContaining("still being verified"),
        }),
      }),
    );

    first.resolve(failureReceipt(calls[0], "inventory_busy", true));
    await flushPromises();
    system?.update(0);
    world.currentTick = 102;
    system?.update(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].operationId).toBe(calls[0].operationId);

    second.resolve(successReceipt(calls[1]));
    await flushPromises();
    system?.update(0);
    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(1);
  });

  it("does not emit reward signals for a definitive failed debit", async () => {
    const requestId = "339e9d54-fc9b-488e-a29f-87dfb27d40fa";
    commitImplementation = async (playerId, operationId, input) => {
      const call = { playerId, operationId, input };
      return failureReceipt(call, "insufficient_items", false);
    };

    emitInteraction(requestId);
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(0);
    expect(findEvents(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "runecrafting",
          reason: "resources_unavailable",
          retryable: false,
        },
      }),
    ]);
    expect(findEvents(EventType.UI_MESSAGE)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "warning",
          message: expect.stringContaining("required essence"),
        }),
      }),
    );
    expect(system?.getRunecraftingCustodyStats().pendingActions).toBe(0);
  });

  it("reconciles one committed result after disconnect without stale UI", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    emitInteraction();
    eventBus.emitEvent(
      EventType.PLAYER_UNREGISTERED,
      { playerId: "player1" },
      "test",
    );

    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(1);
    expect(
      findEvents(EventType.UI_MESSAGE).filter((event) => {
        const type = (event.data as { type?: string }).type;
        return type === "success" || type === "warning";
      }),
    ).toHaveLength(0);
    expect(system?.getRunecraftingCustodyStats().pendingActions).toBe(0);
  });

  it("keeps a late committed result but does not revive altar presentation after movement", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    emitInteraction();
    eventBus.emitEvent(
      EventType.MOVEMENT_CLICK_TO_MOVE,
      { playerId: "player1", targetPosition: { x: 10, y: 0, z: 10 } },
      "test",
    );
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ skill: null, phase: "idle" });

    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(1);
    expect(
      findEvents(EventType.UI_MESSAGE).filter(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toHaveLength(0);
    expect(system?.getRunecraftingCustodyStats().pendingActions).toBe(0);
  });

  it("warns after a durable commit whose live inventory needs resync", async () => {
    commitImplementation = async (playerId, operationId, input) =>
      successReceipt(
        { playerId, operationId, input },
        { liveInventoryApplied: false },
      );

    emitInteraction();
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(1);
    expect(findEvents(EventType.UI_MESSAGE)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "warning",
          message: expect.stringContaining("safely recorded"),
        }),
      }),
    );
  });

  it("drains exactly one in-flight rune craft after quiescence with no presentation revival", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    emitInteraction();
    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(false);

    const presentationBoundary = findEvents(
      EventType.PROCESSING_INTERACTION_PRESENTATION,
    ).length;
    system?.requestPlayerProcessingQuiescence("player1");
    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(false);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: "player1", skill: null, phase: "idle" });

    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    system?.update(0);
    world.currentTick = 200;
    system?.update(0);

    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(findEvents(EventType.RUNECRAFTING_COMPLETE)).toHaveLength(1);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION)
        .slice(presentationBoundary)
        .some(
          (event) => (event.data as { phase?: string }).phase === "working",
        ),
    ).toBe(false);
  });
});
