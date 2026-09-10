import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ProcessingSystem } from "../ProcessingSystem";
import { EventBus } from "../../infrastructure/EventBus";
import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import {
  processingDataProvider,
  type CookingManifest,
  type FiremakingManifest,
} from "../../../../data/ProcessingDataProvider";
import type {
  AtomicProcessingActionReceipt,
  InventorySystem,
} from "../../character/InventorySystem";

type ProcessingInput = Parameters<
  InventorySystem["commitProcessingActionAtomic"]
>[2];

interface InventoryItem {
  id: string;
  itemId: string;
  quantity: number;
  slot: number;
  metadata: null;
}

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

function item(itemId: string, slot: number, quantity = 1): InventoryItem {
  return {
    id: `item_${itemId}_${slot}`,
    itemId,
    quantity,
    slot,
    metadata: null,
  };
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
      stackable: false,
    })),
    ...(call.input.worldEffect
      ? {
          worldEffect: {
            kind: "fire" as const,
            fireId: call.input.worldEffect.fireId,
            position: call.input.worldEffect.position,
            tile: call.input.worldEffect.tile,
            createdAt: Date.now(),
            expiresAt: Date.now() + call.input.worldEffect.durationMs,
          },
        }
      : {}),
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
      stackable: false,
    })),
    retryable,
    reason,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function loadManifest<T>(name: string): T {
  const candidates = [
    path.resolve(
      process.cwd(),
      `packages/server/world/assets/manifests/recipes/${name}.json`,
    ),
    path.resolve(
      process.cwd(),
      `../server/world/assets/manifests/recipes/${name}.json`,
    ),
    path.resolve(
      __dirname,
      `../../../../../server/world/assets/manifests/recipes/${name}.json`,
    ),
  ];
  const manifestPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) throw new Error(`${name} manifest is required for tests`);
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as T;
}

describe("ProcessingSystem authoritative reward custody", () => {
  let system: ProcessingSystem | undefined;
  let eventBus: EventBus;
  let world: {
    isServer: boolean;
    isClient: boolean;
    currentTick: number;
    $eventBus: EventBus;
    entities: Map<string, unknown>;
    collision: {
      hasFlags: ReturnType<typeof vi.fn>;
      isWalkable: ReturnType<typeof vi.fn>;
    };
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    getSystem: ReturnType<typeof vi.fn>;
    getPlayer: ReturnType<typeof vi.fn>;
    getInventory: ReturnType<typeof vi.fn>;
    network: { send: ReturnType<typeof vi.fn> };
    stage: {
      scene: {
        add: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
      };
    };
  };
  let calls: CommitCall[];
  let inventories: Map<string, InventoryItem[]>;
  let players: Map<
    string,
    {
      id: string;
      position: { x: number; y: number; z: number };
      node: { position: { x: number; y: number; z: number } };
      data: { inStreamingDuel: boolean };
      skills: Record<string, { level: number; xp: number }>;
    }
  >;
  let duelActive: boolean;
  let commitImplementation: (
    playerId: string,
    operationId: string,
    input: ProcessingInput,
  ) => Promise<AtomicProcessingActionReceipt>;
  const emitted: Array<{ type: string; data: unknown }> = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    processingDataProvider.loadCookingRecipes(
      loadManifest<CookingManifest>("cooking"),
    );
    processingDataProvider.loadFiremakingRecipes(
      loadManifest<FiremakingManifest>("firemaking"),
    );
    processingDataProvider.rebuild();

    emitted.length = 0;
    calls = [];
    duelActive = false;
    inventories = new Map([
      [
        "player1",
        [item("raw_shrimp", 0), item("logs", 1), item("tinderbox", 2)],
      ],
      ["player2", [item("logs", 0), item("tinderbox", 1)]],
    ]);
    players = new Map([
      [
        "player1",
        {
          id: "player1",
          position: { x: 0, y: 0, z: 0 },
          node: { position: { x: 0, y: 0, z: 0 } },
          data: { inStreamingDuel: false },
          skills: {
            cooking: { level: 99, xp: 0 },
            firemaking: { level: 99, xp: 0 },
          },
        },
      ],
      [
        "player2",
        {
          id: "player2",
          position: { x: 0, y: 0, z: 0 },
          node: { position: { x: 0, y: 0, z: 0 } },
          data: { inStreamingDuel: false },
          skills: {
            cooking: { level: 99, xp: 0 },
            firemaking: { level: 99, xp: 0 },
          },
        },
      ],
    ]);
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
      isClient: false,
      currentTick: 100,
      $eventBus: eventBus,
      entities: new Map([
        [
          "range1",
          {
            id: "range1",
            entityType: "range",
            position: { x: 1, y: 0, z: 0 },
            canInteract: (
              _playerId: string,
              position: { x: number; y: number; z: number },
            ) =>
              Math.max(
                Math.abs(Math.floor(position.x) - 1),
                Math.abs(Math.floor(position.z)),
              ) <= 1,
          },
        ],
      ]),
      collision: {
        hasFlags: vi.fn(() => false),
        isWalkable: vi.fn(() => true),
      },
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      getSystem: vi.fn((name: string) => {
        if (name === "inventory") return atomicInventory;
        if (name === "duel") {
          return { isPlayerInDuel: () => duelActive };
        }
        return undefined;
      }),
      getPlayer: vi.fn((id: string) => players.get(id)),
      getInventory: vi.fn((id: string) => inventories.get(id) ?? []),
      network: { send: vi.fn() },
      stage: { scene: { add: vi.fn(), remove: vi.fn() } },
    };
    commitImplementation = async (playerId, operationId, input) =>
      successReceipt({ playerId, operationId, input });
    system = new ProcessingSystem(world as unknown as World);
    await system.init();
  });

  afterEach(() => {
    system?.destroy();
    system = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function emit(type: EventType, data: Record<string, unknown>): void {
    eventBus.emitEvent(type, data, "test");
  }

  function findEvents(type: string) {
    return emitted.filter((event) => event.type === type);
  }

  function applyInventoryMutation(call: CommitCall): void {
    const inventory = inventories.get(call.playerId) ?? [];
    for (const input of call.input.inputs) {
      const existing = inventory.find((entry) => entry.itemId === input.itemId);
      if (!existing) continue;
      existing.quantity -= input.quantity;
      if (existing.quantity <= 0) {
        inventory.splice(inventory.indexOf(existing), 1);
      }
    }
    for (const output of call.input.outputs) {
      inventory.push(
        item(output.itemId, inventory.length + 10, output.quantity),
      );
    }
  }

  it("immediately rejects correlated invalid cooking and firemaking requests", () => {
    const cookingRequestId = "2742400e-c8e3-41fb-bfd6-82de6653f0bd";
    const firemakingRequestId = "f8785665-1cca-4cca-a0f0-7d6fbe91a6d8";

    cookOnRange("player1", 99, cookingRequestId);
    lightFire("player1", 2, 2, firemakingRequestId);

    expect(findEvents(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId: cookingRequestId,
          skill: "cooking",
          reason: "invalid_request",
          retryable: false,
        },
      }),
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId: firemakingRequestId,
          skill: "firemaking",
          reason: "invalid_request",
          retryable: false,
        },
      }),
    ]);
  });

  it("rejects cooking and firemaking while the player is in any duel authority state", () => {
    const cookingRequestId = "d9e8228a-66f1-453d-94d0-56932a949b40";
    const firemakingRequestId = "16730864-a3c7-45ae-b847-bde1ea2f59a3";

    duelActive = true;
    cookOnRange("player1", 0, cookingRequestId);
    duelActive = false;
    players.get("player1")!.data.inStreamingDuel = true;
    lightFire("player1", 1, 2, firemakingRequestId);

    expect(calls).toHaveLength(0);
    expect(findEvents(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          requestId: cookingRequestId,
          skill: "cooking",
          reason: "not_authorized",
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          requestId: firemakingRequestId,
          skill: "firemaking",
          reason: "not_authorized",
        }),
      }),
    ]);
  });

  function cookOnRange(
    playerId = "player1",
    fishSlot = 0,
    requestId?: string,
  ): void {
    emit(EventType.PROCESSING_COOKING_REQUEST, {
      playerId,
      fishSlot,
      rangeId: "range1",
      sourceType: "range",
      requestId,
    });
  }

  function lightFire(
    playerId = "player1",
    logsSlot = 1,
    tinderboxSlot = 2,
    requestId?: string,
  ): void {
    emit(EventType.PROCESSING_FIREMAKING_REQUEST, {
      playerId,
      logsId: "logs",
      logsSlot,
      tinderboxSlot,
      requestId,
    });
  }

  it("publishes no cooking result, XP, or legacy inventory event before commit", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;

    const requestId = "4749882d-9f6c-4c23-b73d-6ee187798c9d";
    cookOnRange("player1", 0, requestId);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({
      playerId: "player1",
      skill: "cooking",
      phase: "working",
      targetPosition: { x: 1, y: 0, z: 0 },
    });
    expect(findEvents(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "cooking",
          phase: "accepted",
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(2_399);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toHaveLength(1);
    expect(calls[0].operationId).toBe(
      `processing-request:cooking:${requestId}`,
    );
    expect(calls[0].input).toEqual({
      skill: "cooking",
      xpAmount: 30,
      inputs: [{ itemId: "raw_shrimp", quantity: 1 }],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "shrimp", quantity: 1 }],
    });
    expect(findEvents(EventType.COOKING_COMPLETED)).toHaveLength(0);
    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    expect(findEvents(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(findEvents(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);

    applyInventoryMutation(calls[0]);
    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    expect(findEvents(EventType.COOKING_COMPLETED)).toHaveLength(0);
    system?.update(0);

    expect(findEvents(EventType.COOKING_COMPLETED)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId }) }),
    ]);
    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(system?.getProcessingCustodyStats().pendingCommits).toBe(0);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: "player1", skill: null, phase: "idle" });
  });

  it("keeps a late committed cook but does not resurrect cooking presentation after movement", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    cookOnRange();
    await vi.advanceTimersByTimeAsync(2_400);
    expect(calls).toHaveLength(1);

    players.get("player1")!.position.x = 10;
    players.get("player1")!.node.position.x = 10;
    emit(EventType.MOVEMENT_CLICK_TO_MOVE, {
      playerId: "player1",
      targetPosition: { x: 10, y: 0, z: 0 },
    });
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ skill: null, phase: "idle" });
    const successMessagesBefore = findEvents(EventType.UI_MESSAGE).filter(
      (event) => (event.data as { type?: string }).type === "success",
    ).length;
    applyInventoryMutation(calls[0]);
    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.COOKING_COMPLETED)).toHaveLength(1);
    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(
      findEvents(EventType.UI_MESSAGE).filter(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toHaveLength(successMessagesBefore);
    expect(findEvents(EventType.PLAYER_SET_EMOTE).at(-1)).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ playerId: "player1", emote: "idle" }),
      }),
    );
  });

  it("drains one in-flight cook after quiescence and never starts another batch", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    cookOnRange();
    await vi.advanceTimersByTimeAsync(2_400);
    expect(calls).toHaveLength(1);
    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(false);

    const presentationBoundary = findEvents(
      EventType.PROCESSING_INTERACTION_PRESENTATION,
    ).length;
    system?.requestPlayerProcessingQuiescence("player1");
    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(false);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: "player1", skill: null, phase: "idle" });

    applyInventoryMutation(calls[0]);
    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    system?.update(0);
    await vi.advanceTimersByTimeAsync(24_000);
    system?.update(0);

    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(findEvents(EventType.COOKING_COMPLETED)).toHaveLength(1);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION)
        .slice(presentationBoundary)
        .some(
          (event) => (event.data as { phase?: string }).phase === "working",
        ),
    ).toBe(false);
  });

  it("rolls a burnt outcome once and retries the identical action", async () => {
    players.get("player1")!.skills.cooking.level = 1;
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const retry = deferred<AtomicProcessingActionReceipt>();
    let attempt = 0;
    commitImplementation = async () => {
      attempt++;
      if (attempt === 1) throw new Error("ambiguous database response");
      return retry.promise;
    };

    const requestId = "be103496-2715-4478-bc99-d8cc12c408cc";
    cookOnRange("player1", 0, requestId);
    await vi.advanceTimersByTimeAsync(2_400);
    await flushPromises();

    expect(calls).toHaveLength(1);
    expect(calls[0].input.xpAmount).toBe(0);
    expect(calls[0].input.outputs).toEqual([
      { itemId: "burnt_shrimp", quantity: 1 },
    ]);
    expect(findEvents(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "cooking",
          phase: "reconciling",
        },
      }),
    );
    expect(system?.getProcessingCustodyStats().retryWaiting).toBe(1);
    world.currentTick = 101;
    system?.update(0);
    expect(calls).toHaveLength(1);
    world.currentTick = 102;
    system?.update(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].operationId).toBe(calls[0].operationId);
    expect(calls[1].input).toEqual(calls[0].input);
    expect(random).toHaveBeenCalledTimes(1);

    world.currentTick = 112;
    system?.update(0);
    expect(findEvents(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "cooking",
          phase: "working",
        },
      }),
    );

    applyInventoryMutation(calls[1]);
    retry.resolve(successReceipt(calls[1], { replayed: true }));
    await flushPromises();
    system?.update(0);
    system?.update(0);
    expect(findEvents(EventType.COOKING_COMPLETED)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ wasBurnt: true, xpGained: 0 }),
      }),
    ]);
    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
  });

  it("uses the range-specific stop-burn level", async () => {
    players.get("player1")!.skills.cooking.level = 33;
    vi.spyOn(Math, "random").mockReturnValue(0);
    cookOnRange();
    await vi.advanceTimersByTimeAsync(2_400);
    await flushPromises();
    expect(calls[0].input.outputs).toEqual([{ itemId: "shrimp", quantity: 1 }]);
  });

  it("continues an authorized cooking batch only after each committed receipt", async () => {
    inventories.set("player1", [item("raw_shrimp", 0, 2)]);
    commitImplementation = async () => {
      const call = calls.at(-1)!;
      applyInventoryMutation(call);
      return successReceipt(call);
    };

    cookOnRange();
    await vi.advanceTimersByTimeAsync(2_400);
    await flushPromises();
    expect(calls).toHaveLength(1);
    system?.update(0);
    expect(system?.getProcessingCustodyStats()).toMatchObject({
      activeActions: 1,
      pendingCommits: 0,
    });

    await vi.advanceTimersByTimeAsync(2_400);
    await flushPromises();
    expect(calls).toHaveLength(2);
    system?.update(0);
    expect(findEvents(EventType.COOKING_COMPLETED)).toHaveLength(2);
    expect(system?.isPlayerProcessing("player1")).toBe(false);
  });

  it("commits exactly one item for a correlated cooking request", async () => {
    inventories.set("player1", [item("raw_shrimp", 0, 2)]);
    commitImplementation = async () => {
      const call = calls.at(-1)!;
      applyInventoryMutation(call);
      return successReceipt(call);
    };

    const requestId = "5be29c3c-5e8a-4436-b41f-fd31755c1b86";
    cookOnRange("player1", 0, requestId);
    await vi.advanceTimersByTimeAsync(2_400);
    await flushPromises();
    system?.update(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].operationId).toBe(
      `processing-request:cooking:${requestId}`,
    );
    expect(findEvents(EventType.COOKING_COMPLETED)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId }) }),
    ]);
    expect(inventories.get("player1")).toHaveLength(2);
    expect(inventories.get("player1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "raw_shrimp", quantity: 1 }),
        expect.objectContaining({ itemId: "shrimp", quantity: 1 }),
      ]),
    );
    expect(system?.isPlayerProcessing("player1")).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    await flushPromises();
    system?.update(0);
    expect(calls).toHaveLength(1);
    expect(findEvents(EventType.COOKING_COMPLETED)).toHaveLength(1);
  });

  it("rejects forged, remote, and malformed range interactions centrally", () => {
    players.get("player1")!.position.x = 100;
    players.get("player1")!.node.position.x = 100;
    cookOnRange();
    emit(EventType.PROCESSING_COOKING_REQUEST, {
      playerId: "player1",
      fishSlot: 0,
      rangeId: "missing-range",
      sourceType: "range",
    });
    world.entities.set("fake-range", {
      entityType: "range",
      position: { x: Number.NaN, y: 0, z: 0 },
      canInteract: () => true,
    });
    emit(EventType.PROCESSING_COOKING_REQUEST, {
      playerId: "player1",
      fishSlot: 0,
      rangeId: "fake-range",
      sourceType: "range",
    });

    expect(calls).toHaveLength(0);
    expect(system?.isPlayerProcessing("player1")).toBe(false);
  });

  it("authorizes a cardinal tile center beside an integer-anchored range", () => {
    players.get("player1")!.position = { x: 2.5, y: 0, z: 0.5 };
    players.get("player1")!.node.position = { x: 2.5, y: 0, z: 0.5 };

    cookOnRange("player1", 0, "e528671d-6d7a-48a5-a351-b490f82893bf");

    expect(system?.isPlayerProcessing("player1")).toBe(true);
    expect(findEvents(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          playerId: "player1",
          skill: "cooking",
          phase: "accepted",
        }),
      }),
    );
  });

  it("revalidates cooking distance at completion", async () => {
    cookOnRange();
    players.get("player1")!.position.x = 20;
    players.get("player1")!.node.position.x = 20;
    await vi.advanceTimersByTimeAsync(2_400);

    expect(calls).toHaveLength(0);
    expect(findEvents(EventType.COOKING_COMPLETED)).toHaveLength(0);
    expect(system?.isPlayerProcessing("player1")).toBe(false);
  });

  it("atomically commits logs and XP before exposing a fire", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    const requestId = "094beb0f-a591-4134-aab7-eb343b4d4cc3";
    lightFire("player1", 1, 2, requestId);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({
      playerId: "player1",
      skill: "firemaking",
      phase: "working",
      targetPosition: { x: 0, y: 0, z: 0 },
    });
    expect(findEvents(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "firemaking",
          phase: "accepted",
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(2_399);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toHaveLength(1);
    expect(calls[0].operationId).toBe(
      `processing-request:firemaking:${requestId}`,
    );
    expect(calls[0].input).toEqual(
      expect.objectContaining({
        skill: "firemaking",
        xpAmount: 40,
        inputs: [{ itemId: "logs", quantity: 1 }],
        requiredItems: [{ itemId: "tinderbox", quantity: 1 }],
        consumables: [],
        outputs: [],
        worldEffect: expect.objectContaining({
          kind: "fire",
          fireId: `fire_${requestId}`,
          position: { x: 0, y: 0, z: 0 },
          tile: { x: 0, z: 0 },
        }),
      }),
    );
    expect(calls[0].input.worldEffect?.durationMs).toBeGreaterThanOrEqual(
      60_000,
    );
    expect(calls[0].input.worldEffect?.durationMs).toBeLessThanOrEqual(118_800);
    expect(findEvents(EventType.FIRE_CREATED)).toHaveLength(0);
    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    expect(findEvents(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(system?.getProcessingCustodyStats().reservedFireTiles).toBe(1);

    applyInventoryMutation(calls[0]);
    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.FIRE_CREATED)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId }) }),
    ]);
    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(system?.getProcessingCustodyStats().reservedFireTiles).toBe(0);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: "player1", skill: null, phase: "idle" });
  });

  it("uses the level-bound firemaking roll and retries at the authored four-tick cadence", async () => {
    players.get("player1")!.skills.firemaking.level = 1;
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0)
      .mockReturnValue(0);

    lightFire();
    await vi.advanceTimersByTimeAsync(2_400);
    expect(calls).toHaveLength(0);
    expect(system?.isPlayerProcessing("player1")).toBe(true);

    await vi.advanceTimersByTimeAsync(2_399);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toHaveLength(1);
    expect(calls[0].input.skill).toBe("firemaking");
  });

  it("allows cooking on an exact active fire only from an adjacent tile", async () => {
    commitImplementation = async () => {
      const call = calls.at(-1)!;
      applyInventoryMutation(call);
      return successReceipt(call);
    };
    lightFire();
    await vi.advanceTimersByTimeAsync(2_400);
    await flushPromises();
    system?.update(0);
    const fire = findEvents(EventType.FIRE_CREATED)[0]?.data as
      { fireId: string } | undefined;
    expect(fire?.fireId).toBeTruthy();

    inventories.get("player1")!.push(item("raw_shrimp", 5));
    players.get("player1")!.position.x = 1;
    players.get("player1")!.node.position.x = 1;
    emit(EventType.PROCESSING_COOKING_REQUEST, {
      playerId: "player1",
      fishSlot: 5,
      fireId: fire!.fireId,
      sourceType: "fire",
    });
    await vi.advanceTimersByTimeAsync(2_400);
    await flushPromises();
    system?.update(0);

    expect(calls.at(-1)?.input.skill).toBe("cooking");
    expect(findEvents(EventType.COOKING_COMPLETED)).toHaveLength(1);
  });

  it("reserves a fire tile against a concurrent player", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    lightFire();
    lightFire("player2", 0, 1);
    await vi.advanceTimersByTimeAsync(2_400);

    expect(calls).toHaveLength(1);
    expect(calls[0].playerId).toBe("player1");
    expect(system?.isPlayerProcessing("player2")).toBe(false);
    expect(findEvents(EventType.UI_MESSAGE)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          playerId: "player2",
          message: expect.stringContaining("cannot light"),
        }),
      }),
    );
  });

  it("releases a fire reservation when movement cancels lighting", () => {
    lightFire();
    players.get("player1")!.position.x = 2;
    players.get("player1")!.node.position.x = 2;
    system?.update(0);

    expect(system?.getProcessingCustodyStats().reservedFireTiles).toBe(0);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ skill: null, phase: "idle" });
    lightFire("player2", 0, 1);
    expect(system?.isPlayerProcessing("player2")).toBe(true);
  });

  it("reconciles one committed fire after disconnect without stale UI or movement", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    lightFire();
    await vi.advanceTimersByTimeAsync(2_400);
    applyInventoryMutation(calls[0]);
    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    emit(EventType.PLAYER_UNREGISTERED, { playerId: "player1" });
    const successMessagesBefore = findEvents(EventType.UI_MESSAGE).filter(
      (event) => (event.data as { type?: string }).type === "success",
    ).length;

    system?.update(0);
    system?.update(0);

    expect(findEvents(EventType.FIRE_CREATED)).toHaveLength(1);
    expect(findEvents(EventType.FIREMAKING_MOVE_REQUEST)).toHaveLength(0);
    expect(
      findEvents(EventType.UI_MESSAGE).filter(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toHaveLength(successMessagesBefore);
    expect(system?.getProcessingCustodyStats().pendingCommits).toBe(0);
  });

  it("keeps a late committed fire but does not move or revive lighting presentation after movement", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    lightFire();
    await vi.advanceTimersByTimeAsync(2_400);
    expect(calls).toHaveLength(1);

    players.get("player1")!.position.x = 10;
    players.get("player1")!.node.position.x = 10;
    emit(EventType.MOVEMENT_CLICK_TO_MOVE, {
      playerId: "player1",
      targetPosition: { x: 10, y: 0, z: 0 },
    });
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ skill: null, phase: "idle" });
    const successMessagesBefore = findEvents(EventType.UI_MESSAGE).filter(
      (event) => (event.data as { type?: string }).type === "success",
    ).length;
    applyInventoryMutation(calls[0]);
    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.FIRE_CREATED)).toHaveLength(1);
    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(1);
    expect(findEvents(EventType.FIREMAKING_MOVE_REQUEST)).toHaveLength(0);
    expect(
      findEvents(EventType.UI_MESSAGE).filter(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toHaveLength(successMessagesBefore);
    expect(findEvents(EventType.PLAYER_SET_EMOTE).at(-1)).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ playerId: "player1", emote: "idle" }),
      }),
    );
  });

  it("drains one in-flight fire after quiescence without movement or presentation revival", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    lightFire();
    await vi.advanceTimersByTimeAsync(2_400);
    expect(calls).toHaveLength(1);
    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(false);

    const presentationBoundary = findEvents(
      EventType.PROCESSING_INTERACTION_PRESENTATION,
    ).length;
    system?.requestPlayerProcessingQuiescence("player1");
    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(false);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: "player1", skill: null, phase: "idle" });

    applyInventoryMutation(calls[0]);
    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    system?.update(0);
    await vi.advanceTimersByTimeAsync(24_000);
    system?.update(0);

    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(findEvents(EventType.FIRE_CREATED)).toHaveLength(1);
    expect(findEvents(EventType.FIREMAKING_MOVE_REQUEST)).toHaveLength(0);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION)
        .slice(presentationBoundary)
        .some(
          (event) => (event.data as { phase?: string }).phase === "working",
        ),
    ).toBe(false);
  });

  it("rehydrates a committed fire without replaying rewards and preserves it on shutdown", async () => {
    system?.destroy();
    const now = Date.now();
    vi.setSystemTime(now + 60 * 60 * 1_000);
    const commitExtinguish = vi.fn();
    const getActiveProcessingFiresAsync = vi.fn(async () => [
      {
        kind: "fire" as const,
        fireId: "fire_recovered-1",
        playerId: "player1",
        position: { x: 4.5, y: 0, z: 7.5 },
        tile: { x: 4, z: 7 },
        createdAt: now - 1_000,
        expiresAt: now + 60_000,
        databaseObservedAt: now,
      },
    ]);
    world.getSystem.mockImplementation((name: string) =>
      name === "database"
        ? {
            getActiveProcessingFiresAsync,
            commitProcessingFireExtinguishOperationAsync: commitExtinguish,
          }
        : undefined,
    );
    emitted.length = 0;
    system = new ProcessingSystem(world as unknown as World);
    await system.init();
    expect(getActiveProcessingFiresAsync).not.toHaveBeenCalled();
    await system.start();

    expect(system.getActiveFirePayloads()).toEqual([
      {
        fireId: "fire_recovered-1",
        playerId: "player1",
        position: { x: 4.5, y: 0, z: 7.5 },
        createdAt: now - 1_000,
        expiresAt: now + 60_000,
      },
    ]);
    expect(findEvents(EventType.FIRE_CREATED)).toHaveLength(0);
    expect(findEvents(EventType.SKILLS_PROGRESS_COMMITTED)).toHaveLength(0);
    expect(findEvents(EventType.FIREMAKING_MOVE_REQUEST)).toHaveLength(0);

    system.destroy();
    system = undefined;
    expect(commitExtinguish).not.toHaveBeenCalled();
  });

  it("atomically expires a recovered fire with its ash source", async () => {
    system?.destroy();
    const now = Date.now();
    const sourceRequest = {
      contributionId: "ground-item-source:11111111-1111-4111-8111-111111111111",
      preferredSourceId: "ground_item_22222222-2222-4222-8222-222222222222",
      requestFingerprint: "a".repeat(64),
      itemId: "ashes",
      quantity: 1,
      stackable: true,
      position: { x: 4.5, y: 0, z: 7.5 },
      tile: { x: 4, z: 7 },
      droppedBy: null,
      lifetimeMs: 120_000,
      lootProtectionMs: 0,
      allowMerge: false,
    };
    const sourceReceipt = {
      sourceId: sourceRequest.preferredSourceId,
      status: "active" as const,
      itemId: sourceRequest.itemId,
      quantity: sourceRequest.quantity,
      stackable: sourceRequest.stackable,
      position: sourceRequest.position,
      tile: sourceRequest.tile,
      droppedBy: sourceRequest.droppedBy,
      createdAt: now + 60_000,
      updatedAt: now + 60_000,
      expiresAt: now + 180_000,
      lootProtectionExpiresAt: null,
      version: 1,
      contributionId: sourceRequest.contributionId,
      requestFingerprint: sourceRequest.requestFingerprint,
      replayed: false,
    };
    const commitExtinguish = vi.fn(
      async (request: Record<string, unknown>) => ({
        operationId: request.operationId as string,
        fireId: "fire_recovered-expiry",
        playerId: "player1",
        requestFingerprint: request.requestFingerprint as string,
        replayed: false,
        position: { x: 4.5, y: 0, z: 7.5 },
        expiresAt: now + 60_000,
        extinguishedAt: now + 60_000,
        sourceRequest,
        source: sourceReceipt,
      }),
    );
    const prepareSource = vi.fn(async () => sourceRequest);
    const exposeSource = vi.fn(async () => true);
    world.getSystem.mockImplementation((name: string) => {
      if (name === "database") {
        return {
          getActiveProcessingFiresAsync: vi.fn(async () => [
            {
              kind: "fire" as const,
              fireId: "fire_recovered-expiry",
              playerId: "player1",
              position: { x: 4.5, y: 0, z: 7.5 },
              tile: { x: 4, z: 7 },
              createdAt: now,
              expiresAt: now + 60_000,
            },
          ]),
          commitProcessingFireExtinguishOperationAsync: commitExtinguish,
        };
      }
      if (name === "ground-items") {
        return {
          prepareDurableSourceRegistration: prepareSource,
          exposeCommittedDurableSource: exposeSource,
        };
      }
      return undefined;
    });
    emitted.length = 0;
    system = new ProcessingSystem(world as unknown as World);
    await system.init();
    await system.start();

    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(exposeSource).toHaveBeenCalledTimes(1));

    expect(commitExtinguish).toHaveBeenCalledTimes(1);
    expect(commitExtinguish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "processing-fire-extinguish:fire_recovered-expiry",
        fireId: "fire_recovered-expiry",
        playerId: "player1",
        position: { x: 4.5, y: 0, z: 7.5 },
        expiresAt: now + 60_000,
        source: sourceRequest,
      }),
    );
    expect(prepareSource).toHaveBeenCalledTimes(1);
    expect(exposeSource).toHaveBeenCalledWith(sourceReceipt);
    expect(findEvents(EventType.FIRE_EXTINGUISHED)).toHaveLength(1);
    expect(system.getActiveFirePayloads()).toEqual([]);
  });

  it("retains and retries a runtime fire expiry after the bounded response-loss window", async () => {
    system?.destroy();
    const now = Date.now();
    vi.setSystemTime(now);
    const position = { x: 6.5, y: 0, z: 5.5 };
    const sourceRequest = {
      contributionId: "ground-item-source:55555555-5555-4555-8555-555555555555",
      preferredSourceId: "ground_item_66666666-6666-4666-8666-666666666666",
      requestFingerprint: "c".repeat(64),
      itemId: "ashes",
      quantity: 1,
      stackable: true,
      position,
      tile: { x: 6, z: 5 },
      droppedBy: null,
      lifetimeMs: 120_000,
      lootProtectionMs: 0,
      allowMerge: false,
    };
    const expiresAt = now + 100;
    const commitExtinguish = vi.fn(async (request: Record<string, unknown>) => {
      if (commitExtinguish.mock.calls.length <= 8) {
        throw new Error("connection reset after commit attempt");
      }
      const databaseNow = Math.max(Date.now(), expiresAt);
      return {
        operationId: request.operationId as string,
        fireId: "fire_runtime-retry",
        playerId: "player1",
        requestFingerprint: request.requestFingerprint as string,
        replayed: true,
        position,
        expiresAt,
        extinguishedAt: databaseNow,
        sourceRequest,
        source: {
          sourceId: sourceRequest.preferredSourceId,
          status: "active" as const,
          itemId: "ashes",
          quantity: 1,
          stackable: true,
          position,
          tile: sourceRequest.tile,
          droppedBy: null,
          createdAt: databaseNow,
          updatedAt: databaseNow,
          expiresAt: databaseNow + 120_000,
          lootProtectionExpiresAt: null,
          version: 1,
          contributionId: sourceRequest.contributionId,
          requestFingerprint: sourceRequest.requestFingerprint,
          replayed: true,
        },
      };
    });
    const exposeSource = vi.fn(async () => true);
    world.getSystem.mockImplementation((name: string) => {
      if (name === "database") {
        return {
          getActiveProcessingFiresAsync: vi.fn(async () => [
            {
              kind: "fire" as const,
              fireId: "fire_runtime-retry",
              playerId: "player1",
              position,
              tile: sourceRequest.tile,
              createdAt: now,
              expiresAt,
              databaseObservedAt: now,
            },
          ]),
          commitProcessingFireExtinguishOperationAsync: commitExtinguish,
        };
      }
      if (name === "ground-items") {
        return {
          prepareDurableSourceRegistration: vi.fn(async () => sourceRequest),
          exposeCommittedDurableSource: exposeSource,
        };
      }
      return undefined;
    });
    emitted.length = 0;
    system = new ProcessingSystem(world as unknown as World);
    await system.init();
    await system.start();

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(commitExtinguish).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(18_000);
    await vi.waitFor(() => expect(commitExtinguish).toHaveBeenCalledTimes(8));

    expect(system.getProcessingCustodyStats()).toMatchObject({
      pendingFireExpiries: 1,
      fireExpiryInFlight: 0,
      fireExpiryRetryWaiting: 1,
      fireExpiryBlocked: 0,
      maxFireExpiryRetryCount: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    system.update(0);
    vi.useRealTimers();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await vi.waitFor(() => expect(exposeSource).toHaveBeenCalledTimes(1));

    expect(commitExtinguish).toHaveBeenCalledTimes(9);
    expect(system.getProcessingCustodyStats()).toMatchObject({
      pendingFireExpiries: 0,
      fireExpiryInFlight: 0,
      fireExpiryRetryWaiting: 0,
      fireExpiryBlocked: 0,
    });

    commitExtinguish.mockRejectedValueOnce(
      new Error("processing_fire_extinguish_operation_id_conflict"),
    );
    const expiryInternals = system as unknown as {
      launchFireExpirySettlement: (effect: {
        kind: "fire";
        fireId: string;
        playerId: string;
        position: typeof position;
        tile: { x: number; z: number };
        createdAt: number;
        expiresAt: number;
      }) => void;
    };
    expiryInternals.launchFireExpirySettlement({
      kind: "fire",
      fireId: "fire_runtime-conflict",
      playerId: "player1",
      position,
      tile: sourceRequest.tile,
      createdAt: now,
      expiresAt,
    });
    await vi.waitFor(() => expect(commitExtinguish).toHaveBeenCalledTimes(10));
    await vi.waitFor(() =>
      expect(system!.getProcessingCustodyStats()).toMatchObject({
        pendingFireExpiries: 1,
        fireExpiryInFlight: 0,
        fireExpiryRetryWaiting: 0,
        fireExpiryBlocked: 1,
      }),
    );
    system.update(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(commitExtinguish).toHaveBeenCalledTimes(10);
  });

  it("settles an already-expired persisted fire during startup recovery", async () => {
    system?.destroy();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 60 * 1_000);
    const sourceRequest = {
      contributionId: "ground-item-source:33333333-3333-4333-8333-333333333333",
      preferredSourceId: "ground_item_44444444-4444-4444-8444-444444444444",
      requestFingerprint: "b".repeat(64),
      itemId: "ashes",
      quantity: 1,
      stackable: true,
      position: { x: 8.5, y: 0, z: 9.5 },
      tile: { x: 8, z: 9 },
      droppedBy: null,
      lifetimeMs: 120_000,
      lootProtectionMs: 0,
      allowMerge: false,
    };
    const sourceReceipt = {
      sourceId: sourceRequest.preferredSourceId,
      status: "active" as const,
      itemId: "ashes",
      quantity: 1,
      stackable: true,
      position: sourceRequest.position,
      tile: sourceRequest.tile,
      droppedBy: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 120_000,
      lootProtectionExpiresAt: null,
      version: 1,
      contributionId: sourceRequest.contributionId,
      requestFingerprint: sourceRequest.requestFingerprint,
      replayed: false,
    };
    const commitExtinguish = vi.fn(
      async (request: Record<string, unknown>) => ({
        operationId: request.operationId as string,
        fireId: "fire_due-at-restart",
        playerId: "player1",
        requestFingerprint: request.requestFingerprint as string,
        replayed: false,
        position: sourceRequest.position,
        expiresAt: now - 1,
        extinguishedAt: now,
        sourceRequest,
        source: sourceReceipt,
      }),
    );
    const exposeSource = vi.fn(async () => true);
    world.getSystem.mockImplementation((name: string) => {
      if (name === "database") {
        return {
          getActiveProcessingFiresAsync: vi.fn(async () => [
            {
              kind: "fire" as const,
              fireId: "fire_due-at-restart",
              playerId: "player1",
              position: sourceRequest.position,
              tile: sourceRequest.tile,
              createdAt: now - 60_001,
              expiresAt: now - 1,
              databaseObservedAt: now,
            },
          ]),
          commitProcessingFireExtinguishOperationAsync: commitExtinguish,
        };
      }
      if (name === "ground-items") {
        return {
          prepareDurableSourceRegistration: vi.fn(async () => sourceRequest),
          exposeCommittedDurableSource: exposeSource,
        };
      }
      return undefined;
    });
    emitted.length = 0;
    system = new ProcessingSystem(world as unknown as World);
    await system.init();
    await system.start();
    await flushPromises();

    expect(commitExtinguish).toHaveBeenCalledTimes(1);
    expect(exposeSource).toHaveBeenCalledWith(sourceReceipt);
    expect(system.getActiveFirePayloads()).toEqual([]);
    expect(findEvents(EventType.FIRE_EXTINGUISHED)).toHaveLength(1);
  });

  it("fails startup closed when an overdue fire lacks atomic ash authority", async () => {
    system?.destroy();
    const now = Date.now();
    world.getSystem.mockImplementation((name: string) => {
      if (name === "database") {
        return {
          getActiveProcessingFiresAsync: vi.fn(async () => [
            {
              kind: "fire" as const,
              fireId: "fire_due-without-atomic-authority",
              playerId: "player1",
              position: { x: 8.5, y: 0, z: 9.5 },
              tile: { x: 8, z: 9 },
              createdAt: now - 60_001,
              expiresAt: now - 1,
              databaseObservedAt: now,
            },
          ]),
        };
      }
      if (name === "ground-items") return {};
      return undefined;
    });
    emitted.length = 0;
    system = new ProcessingSystem(world as unknown as World);
    await system.init();

    await expect(system.start()).rejects.toThrow(
      "processing_fire_extinguish_database_authority_incomplete",
    );
    expect(findEvents(EventType.FIRE_EXTINGUISHED)).toHaveLength(1);
    expect(system.getActiveFirePayloads()).toEqual([]);
  });

  it("releases custody on a definitive firemaking rejection", async () => {
    const requestId = "a98a972e-28bb-4472-a023-556d872478af";
    commitImplementation = async (playerId, operationId, input) =>
      failureReceipt(
        { playerId, operationId, input },
        "insufficient_items",
        false,
      );
    lightFire("player1", 1, 2, requestId);
    await vi.advanceTimersByTimeAsync(2_400);
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.FIRE_CREATED)).toHaveLength(0);
    expect(findEvents(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "firemaking",
          reason: "resources_unavailable",
          retryable: false,
        },
      }),
    ]);
    expect(system?.getProcessingCustodyStats()).toMatchObject({
      pendingCommits: 0,
      reservedFireTiles: 0,
    });
  });

  it("rejects blocked fire tiles and exact-slot spoofing", () => {
    world.collision.hasFlags.mockReturnValue(true);
    lightFire();
    world.collision.hasFlags.mockReturnValue(false);
    emit(EventType.PROCESSING_FIREMAKING_REQUEST, {
      playerId: "player1",
      logsId: "oak_logs",
      logsSlot: 1,
      tinderboxSlot: 2,
    });
    emit(EventType.PROCESSING_FIREMAKING_REQUEST, {
      playerId: "player1",
      logsId: "logs",
      logsSlot: 2,
      tinderboxSlot: 1,
    });

    expect(system?.isPlayerProcessing("player1")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("ignores authoritative processing requests on clients", () => {
    world.isServer = false;
    world.isClient = true;
    cookOnRange();
    lightFire();
    expect(system?.isPlayerProcessing("player1")).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
