import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { TanningSystem } from "../TanningSystem";
import { EventBus } from "../../infrastructure/EventBus";
import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import {
  processingDataProvider,
  type TanningManifest,
} from "../../../../data/ProcessingDataProvider";
import type {
  AtomicProcessingActionReceipt,
  InventorySystem,
} from "../../character/InventorySystem";
import { acquirePreparationActionFence } from "../ProcessingStationAuthority";

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
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    coinCost: call.input.coinCost,
    currentCoins: 98,
    awardedXp: 0,
    operationCommittedXp: 0,
    currentXp: 0,
    currentLevel: 1,
    ...overrides,
  };
}

function failureReceipt(
  call: CommitCall,
  reason: "inventory_busy" | "insufficient_coins" | "insufficient_items",
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
    coinCost: call.input.coinCost,
    retryable,
    reason,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TanningSystem atomic item and money-pouch custody", () => {
  let system: TanningSystem | undefined;
  let eventBus: EventBus;
  let currentCoins: number;
  let inventoryItems: Array<Record<string, unknown>>;
  let calls: CommitCall[];
  let emitted: Array<{ type: string; data: unknown }>;
  let commitImplementation: (
    playerId: string,
    operationId: string,
    input: ProcessingInput,
  ) => Promise<AtomicProcessingActionReceipt>;
  let world: {
    isServer: boolean;
    currentTick: number;
    $eventBus: EventBus;
    entities: Map<string, unknown>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    getSystem: ReturnType<typeof vi.fn>;
    getPlayer: ReturnType<typeof vi.fn>;
    getInventory: ReturnType<typeof vi.fn>;
    network: { send: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    const manifestPath = [
      path.resolve(
        process.cwd(),
        "packages/server/world/assets/manifests/recipes/tanning.json",
      ),
      path.resolve(
        process.cwd(),
        "../server/world/assets/manifests/recipes/tanning.json",
      ),
      path.resolve(
        __dirname,
        "../../../../../server/world/assets/manifests/recipes/tanning.json",
      ),
    ].find((candidate) => fs.existsSync(candidate));
    if (!manifestPath) throw new Error("Tanning manifest is required");
    processingDataProvider.loadTanningRecipes(
      JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as TanningManifest,
    );
    processingDataProvider.rebuild();

    currentCoins = 100;
    inventoryItems = [
      {
        id: "hide-1",
        itemId: "cowhide",
        quantity: 2,
        slot: 0,
        metadata: null,
      },
    ];
    calls = [];
    emitted = [];
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
    const coinPouch = {
      isPlayerInitialized: vi.fn(() => true),
      getCoins: vi.fn(() => currentCoins),
    };
    world = {
      isServer: true,
      currentTick: 100,
      $eventBus: eventBus,
      entities: new Map([
        [
          "player1",
          { id: "player1", position: { x: 0, y: 0, z: 0 }, data: {} },
        ],
        [
          "tanner-live",
          {
            id: "tanner-live",
            position: { x: 1, y: 0, z: 1 },
            config: {
              npcType: "tanner",
              npcId: "tanner",
              interactionDistance: 3,
            },
          },
        ],
      ]),
      on: vi.fn(),
      off: vi.fn(),
      getSystem: vi.fn((name: string) => {
        if (name === "inventory") return atomicInventory;
        if (name === "coin-pouch") return coinPouch;
        return undefined;
      }),
      getPlayer: vi.fn((id: string) => world.entities.get(id)),
      getInventory: vi.fn(() => inventoryItems),
      network: { send: vi.fn() },
    };
    commitImplementation = async (playerId, operationId, input) =>
      successReceipt({ playerId, operationId, input });
    system = new TanningSystem(world as unknown as World);
    await system.init();
  });

  afterEach(() => {
    system?.destroy();
    system = undefined;
    vi.restoreAllMocks();
  });

  function openSession(
    overrides: Partial<{
      playerId: string;
      npcId: string;
      npcEntityId: string;
    }> = {},
  ): void {
    eventBus.emitEvent(
      EventType.TANNING_INTERACT,
      {
        playerId: "player1",
        npcId: "tanner",
        npcEntityId: "tanner-live",
        ...overrides,
      },
      "test",
    );
  }

  function request(quantity = 2, requestId?: string): void {
    eventBus.emitEvent(
      EventType.TANNING_REQUEST,
      { playerId: "player1", inputItemId: "cowhide", quantity, requestId },
      "test",
    );
  }

  function findEvents(type: string) {
    return emitted.filter((event) => event.type === type);
  }

  it("emits no output, coin, success, or completion signal before commit", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    openSession();
    const requestId = "ab7f35ed-47bd-409e-bcbe-fba3837ad5fc";
    request(2, requestId);

    expect(findEvents(EventType.PROCESSING_REQUEST_PROGRESS)).toContainEqual(
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "tanning",
          phase: "accepted",
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({
      playerId: "player1",
      skill: "tanning",
      phase: "working",
      targetPosition: { x: 1, y: 0, z: 1 },
    });
    expect(calls[0].operationId).toBe(
      `processing-request:tanning:${requestId}`,
    );
    expect(calls[0].input).toEqual({
      skill: "crafting",
      xpAmount: 0,
      inputs: [{ itemId: "cowhide", quantity: 2 }],
      outputs: [{ itemId: "leather", quantity: 2 }],
      coinCost: 2,
    });
    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(0);
    expect(findEvents(EventType.INVENTORY_REMOVE_COINS)).toHaveLength(0);
    expect(findEvents(EventType.INVENTORY_ITEM_REMOVED)).toHaveLength(0);
    expect(findEvents(EventType.INVENTORY_ITEM_ADDED)).toHaveLength(0);
    expect(
      findEvents(EventType.UI_MESSAGE).filter(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toHaveLength(0);

    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(0);
    system?.update(0);
    expect(findEvents(EventType.TANNING_COMPLETE)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId }) }),
    ]);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION).at(-1)?.data,
    ).toMatchObject({ playerId: "player1", skill: null, phase: "idle" });
  });

  it("requires the exact live Tanner identity and physical range", () => {
    openSession({ npcEntityId: "missing" });
    openSession({ npcId: "forged" });
    const tanner = world.entities.get("tanner-live") as {
      position: Position;
    };
    tanner.position.x = 20;
    openSession();

    expect(findEvents(EventType.TANNING_INTERFACE_OPEN)).toHaveLength(0);
    request();
    expect(calls).toHaveLength(0);
  });

  it("cannot reopen Tanner authority while pre-market admission is fenced", () => {
    const fence = acquirePreparationActionFence(
      world as unknown as World,
      "player1",
    );

    openSession();
    request();
    expect(findEvents(EventType.TANNING_INTERFACE_OPEN)).toHaveLength(0);
    expect(calls).toHaveLength(0);

    fence.release();
    openSession();
    expect(findEvents(EventType.TANNING_INTERFACE_OPEN)).toHaveLength(1);
  });

  it("rejects direct requests without an established Tanner session", () => {
    const requestId = "30d3a705-c9a4-407d-be3a-f9e9409cce28";
    request(2, requestId);
    expect(calls).toHaveLength(0);
    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(0);
    expect(findEvents(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "tanning",
          reason: "not_authorized",
          retryable: false,
        },
      }),
    ]);
  });

  it("caps the atomic quantity by hides and authoritative pouch affordability", () => {
    currentCoins = 1;
    openSession();
    request(10_000);
    expect(calls[0].input).toMatchObject({
      inputs: [{ itemId: "cowhide", quantity: 1 }],
      outputs: [{ itemId: "leather", quantity: 1 }],
      coinCost: 1,
    });
  });

  it("retries ambiguity with the identical operation and payload", async () => {
    let attempt = 0;
    commitImplementation = async (playerId, operationId, input) => {
      attempt++;
      if (attempt === 1) throw new Error("temporary persistence failure");
      return successReceipt(
        { playerId, operationId, input },
        { replayed: true },
      );
    };
    openSession();
    request();
    await flushPromises();
    world.currentTick = 102;
    system?.update(0);
    await flushPromises();
    world.currentTick = 103;
    system?.update(0);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(1);
  });

  it("replays a committed-but-not-live receipt before exposing completion", async () => {
    let attempt = 0;
    commitImplementation = async (playerId, operationId, input) => {
      attempt++;
      return successReceipt(
        { playerId, operationId, input },
        attempt === 1
          ? { liveInventoryApplied: false }
          : { replayed: true, liveInventoryApplied: true },
      );
    };
    openSession();
    request();
    await flushPromises();
    system?.update(0);
    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(0);

    world.currentTick = 102;
    system?.update(0);
    await flushPromises();
    world.currentTick = 103;
    system?.update(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(1);
  });

  it("exposes no completion on definitive insufficient coin or hide custody", async () => {
    const requestId = "bc043113-6684-4437-b0a7-38d531f21791";
    commitImplementation = async (playerId, operationId, input) =>
      failureReceipt(
        { playerId, operationId, input },
        "insufficient_coins",
        false,
      );
    openSession();
    request(2, requestId);
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(0);
    expect(findEvents(EventType.PROCESSING_REQUEST_REJECTED)).toEqual([
      expect.objectContaining({
        data: {
          playerId: "player1",
          requestId,
          skill: "tanning",
          reason: "resources_unavailable",
          retryable: false,
        },
      }),
    ]);
    expect(findEvents(EventType.UI_MESSAGE)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "warning",
          message: expect.stringContaining("enough coins"),
        }),
      }),
    );
  });

  it("invalidates the physical session on movement", () => {
    openSession();
    eventBus.emitEvent(
      EventType.MOVEMENT_CLICK_TO_MOVE,
      { playerId: "player1", targetPosition: { x: 2, y: 0, z: 2 } },
      "test",
    );
    request();
    expect(calls).toHaveLength(0);
  });

  it("reconciles one committed action after disconnect without stale UI", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    openSession();
    request();
    eventBus.emitEvent(
      EventType.PLAYER_UNREGISTERED,
      { playerId: "player1" },
      "test",
    );
    held.resolve(successReceipt(calls[0]));
    await flushPromises();
    system?.update(0);

    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(0);
    expect(
      findEvents(EventType.UI_MESSAGE).filter(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toHaveLength(0);
    expect(system?.getTanningCustodyStats().pendingActions).toBe(0);
  });

  it("keeps a late committed action but does not revive Tanner presentation after movement", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    openSession();
    request();
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

    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(1);
    expect(
      findEvents(EventType.UI_MESSAGE).filter(
        (event) => (event.data as { type?: string }).type === "success",
      ),
    ).toHaveLength(0);
    expect(system?.getTanningCustodyStats().pendingActions).toBe(0);
  });

  it("drains exactly one in-flight tan after quiescence and keeps Tanner closed", async () => {
    const held = deferred<AtomicProcessingActionReceipt>();
    commitImplementation = () => held.promise;
    openSession();
    request();
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
    request();

    expect(system?.isPlayerProcessingQuiescent("player1")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(findEvents(EventType.TANNING_COMPLETE)).toHaveLength(1);
    expect(
      findEvents(EventType.PROCESSING_INTERACTION_PRESENTATION)
        .slice(presentationBoundary)
        .some(
          (event) => (event.data as { phase?: string }).phase === "working",
        ),
    ).toBe(false);
  });
});

interface Position {
  x: number;
  y: number;
  z: number;
}
