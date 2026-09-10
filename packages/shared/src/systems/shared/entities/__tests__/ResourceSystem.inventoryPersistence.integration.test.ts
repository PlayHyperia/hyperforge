import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { getItem, ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types/game/item-types";
import type {
  GatheringRewardCommitReceipt,
  GatheringRewardCommitRequest,
  InventorySaveItem,
} from "../../../../types/network/database";
import { EventType } from "../../../../types/events";
import { InventorySystem } from "../../character/InventorySystem";
import { EventBus } from "../../infrastructure/EventBus";
import { ResourceSystem } from "../ResourceSystem";

const PLAYER_ID = "resource-inventory-recovery-agent";
const RESOURCE_ID = "tree_persistence_recovery";
const TEST_LOGS: Item = {
  id: "logs",
  name: "Logs",
  type: "resource",
  stackable: false,
  maxStackSize: 100,
  description: "Gathering persistence integration fixture",
  examine: "Gathering persistence integration fixture",
  tradeable: false,
  rarity: "common",
  modelPath: null,
  iconPath: "",
};
let priorLogs: Item | undefined;

beforeAll(() => {
  priorLogs = ITEMS.get(TEST_LOGS.id);
  ITEMS.set(TEST_LOGS.id, TEST_LOGS);
});

afterAll(() => {
  if (priorLogs) ITEMS.set(TEST_LOGS.id, priorLogs);
  else ITEMS.delete(TEST_LOGS.id);
});

type PendingReward = {
  operationId: string;
  state: "in_flight" | "settled" | "retry_wait";
  retryCount: number;
  retryAtTick: number;
};

type GatheringSession = {
  playerId: string;
  resourceId: string;
  startTick: number;
  nextAttemptTick: number;
  cycleTickInterval: number;
  attempts: number;
  successes: number;
  pendingRewardOperationId: string | null;
  skill: string;
  toolItemId: string | null;
  cachedTuning: {
    levelRequired: number;
    xpPerLog: number;
    depleteChance: number;
    respawnTicks: number;
  };
  cachedSuccessRate: number;
  cachedDrops: Array<{
    itemId: string;
    itemName: string;
    quantity: number;
    chance: number;
    xpAmount: number;
    stackable: boolean;
  }>;
  cachedResourceName: string;
  cachedStartPosition: { x: number; y: number; z: number };
};

function committedInventory(): InventorySaveItem[] {
  return [
    {
      itemId: "logs",
      quantity: 1,
      slotIndex: 0,
      metadata: null,
    },
  ];
}

function committedReceipt(
  request: GatheringRewardCommitRequest,
): GatheringRewardCommitReceipt {
  return {
    ...request,
    replayed: true,
    depletedUntil: null,
    awardedXp: request.xpAmount,
    operationCommittedXp: request.xpAmount,
    currentXp: request.xpAmount,
    currentLevel: 1,
    committed: committedInventory(),
  };
}

function createFixture(
  commit: (
    request: GatheringRewardCommitRequest,
  ) => Promise<GatheringRewardCommitReceipt>,
) {
  const eventBus = new EventBus();
  const database = { commitGatheringRewardOperationAsync: vi.fn(commit) };
  const player = {
    id: PLAYER_ID,
    position: { x: 0, y: 0, z: 0 },
    emote: "chopping",
    data: {
      e: "chopping",
      gatheringToolPresentation: {
        revision: 1,
        itemId: "bronze_hatchet" as string | null,
      },
    },
    markNetworkDirty: vi.fn(),
  };
  let inventory: InventorySystem;
  const world = {
    isServer: true,
    currentTick: 0,
    entities: new Map(),
    $eventBus: eventBus,
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getPlayer: vi.fn((id: string) => (id === PLAYER_ID ? player : undefined)),
    getSystem: vi.fn((name: string) => {
      if (name === "database") return database;
      if (name === "inventory") return inventory;
      return undefined;
    }),
    network: { send: vi.fn() },
    chat: { add: vi.fn() },
  };
  inventory = new InventorySystem(world as never);
  const logData = getItem("logs");
  if (!logData) throw new Error("missing logs fixture");
  (
    inventory as unknown as {
      playerInventories: Map<
        string,
        {
          playerId: string;
          items: Array<{
            slot: number;
            itemId: string;
            quantity: number;
            item: Item;
          }>;
          coins: number;
        }
      >;
    }
  ).playerInventories.set(PLAYER_ID, {
    playerId: PLAYER_ID,
    items: [],
    coins: 0,
  });

  const resourceSystem = new ResourceSystem(world as never);
  const resource = {
    id: RESOURCE_ID,
    type: "tree",
    name: "Persistence Tree",
    position: { x: 1, y: 0, z: 0 },
    skillRequired: "woodcutting",
    levelRequired: 1,
    toolRequired: "hatchet",
    respawnTime: 0,
    isAvailable: true,
    lastDepleted: 0,
    drops: [
      {
        itemId: "logs",
        itemName: "Logs",
        quantity: 1,
        chance: 1,
        xpAmount: 25,
        stackable: false,
      },
    ],
  };
  const session: GatheringSession = {
    playerId: PLAYER_ID,
    resourceId: RESOURCE_ID,
    startTick: 0,
    nextAttemptTick: 1,
    cycleTickInterval: 4,
    attempts: 0,
    successes: 0,
    pendingRewardOperationId: null,
    skill: "woodcutting",
    toolItemId: "bronze_hatchet",
    cachedTuning: {
      levelRequired: 1,
      xpPerLog: 25,
      depleteChance: 0,
      respawnTicks: 80,
    },
    cachedSuccessRate: 1,
    cachedDrops: resource.drops,
    cachedResourceName: resource.name,
    cachedStartPosition: { ...player.position },
  };
  const internals = resourceSystem as unknown as {
    resources: Map<string, typeof resource>;
    activeGathering: Map<string, GatheringSession>;
    pendingGatherRewards: Map<string, PendingReward>;
    processRespawns: (tick: number) => void;
    processFishingSpotMovement: (tick: number) => void;
    processResourceTimers: (tick: number) => void;
    usesTimerBasedDepletion: (resourceId: string) => boolean;
  };
  internals.resources.set(RESOURCE_ID, resource);
  internals.activeGathering.set(PLAYER_ID, session);
  internals.processRespawns = vi.fn();
  internals.processFishingSpotMovement = vi.fn();
  internals.processResourceTimers = vi.fn();
  internals.usesTimerBasedDepletion = vi.fn(() => false);

  return {
    database,
    eventBus,
    inventory,
    internals,
    player,
    resourceSystem,
    session,
  };
}

async function waitFor(
  condition: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResourceSystem and InventorySystem persistence recovery", () => {
  it("retains one operation and presentation through a lost database response", async () => {
    let calls = 0;
    const fixture = createFixture(async (request) => {
      calls++;
      if (calls <= 2) throw new Error("ECONNRESET after uncertain commit");
      return committedReceipt(request);
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const xpEvents: unknown[] = [];
    fixture.eventBus.subscribe(EventType.SKILLS_PROGRESS_COMMITTED, (event) => {
      xpEvents.push(event.data);
    });

    fixture.resourceSystem.processGatheringTick(1);
    await waitFor(
      () =>
        fixture.database.commitGatheringRewardOperationAsync.mock.calls
          .length === 2 &&
        fixture.internals.pendingGatherRewards.get(PLAYER_ID)?.state ===
          "settled",
      "initial ambiguous reward did not settle",
    );
    const originalPending =
      fixture.internals.pendingGatherRewards.get(PLAYER_ID);
    expect(originalPending?.operationId).toMatch(/^gathering-reward:/);
    expect(fixture.session.pendingRewardOperationId).toBe(
      originalPending?.operationId,
    );

    fixture.resourceSystem.processGatheringTick(2);
    expect(fixture.internals.pendingGatherRewards.get(PLAYER_ID)).toMatchObject(
      {
        operationId: originalPending?.operationId,
        state: "retry_wait",
        retryCount: 1,
        retryAtTick: 4,
      },
    );
    expect(fixture.player.emote).toBe("chopping");
    expect(fixture.player.data.gatheringToolPresentation).toEqual({
      revision: 1,
      itemId: "bronze_hatchet",
    });

    fixture.resourceSystem.processGatheringTick(4);
    await waitFor(
      () =>
        fixture.internals.pendingGatherRewards.get(PLAYER_ID)?.state ===
        "settled",
      "retried reward did not settle",
    );
    fixture.resourceSystem.processGatheringTick(5);

    const requests =
      fixture.database.commitGatheringRewardOperationAsync.mock.calls.map(
        ([request]) => request,
      );
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toEqual(requests[0]);
    expect(requests[0]?.operationId).toBe(originalPending?.operationId);
    expect(fixture.internals.pendingGatherRewards.size).toBe(0);
    expect(fixture.session.pendingRewardOperationId).toBeNull();
    expect(fixture.session.successes).toBe(1);
    expect(fixture.session.nextAttemptTick).toBe(9);
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([
      expect.objectContaining({ itemId: "logs", quantity: 1, slot: 0 }),
    ]);
    expect(xpEvents).toEqual([
      {
        playerId: PLAYER_ID,
        operationId: originalPending?.operationId,
        replayed: true,
        skill: "woodcutting",
        xpAmount: 25,
        awardedXp: 25,
        operationCommittedXp: 25,
        currentXp: 25,
        currentLevel: 1,
      },
    ]);
    expect(fixture.player.emote).toBe("chopping");
    expect(fixture.player.data.gatheringToolPresentation).toEqual({
      revision: 1,
      itemId: "bronze_hatchet",
    });

    fixture.resourceSystem.destroy();
    fixture.inventory.destroy();
  });

  it("commits an in-flight reward after movement without resurrecting the canceled presentation", async () => {
    let releaseCommit:
      ((receipt: GatheringRewardCommitReceipt) => void) | undefined;
    let request: GatheringRewardCommitRequest | undefined;
    const gate = new Promise<GatheringRewardCommitReceipt>((resolve) => {
      releaseCommit = resolve;
    });
    const fixture = createFixture(async (nextRequest) => {
      request = nextRequest;
      return gate;
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    await fixture.resourceSystem.init();

    fixture.resourceSystem.processGatheringTick(1);
    await waitFor(
      () => request !== undefined,
      "gathering reward commit did not start",
    );
    fixture.eventBus.emitEvent(EventType.MOVEMENT_CLICK_TO_MOVE, {
      playerId: PLAYER_ID,
      targetPosition: { x: 2, y: 0, z: 0 },
    });

    expect(fixture.internals.activeGathering.size).toBe(0);
    expect(fixture.internals.pendingGatherRewards.size).toBe(1);
    expect(fixture.player.emote).toBe("idle");
    expect(fixture.player.data.gatheringToolPresentation).toEqual({
      revision: 2,
      itemId: null,
    });

    releaseCommit?.(committedReceipt(request!));
    await waitFor(
      () =>
        fixture.internals.pendingGatherRewards.get(PLAYER_ID)?.state ===
        "settled",
      "canceled session reward did not settle",
    );
    fixture.resourceSystem.processGatheringTick(2);

    expect(fixture.internals.pendingGatherRewards.size).toBe(0);
    expect(fixture.internals.activeGathering.size).toBe(0);
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([
      expect.objectContaining({ itemId: "logs", quantity: 1, slot: 0 }),
    ]);
    expect(fixture.player.emote).toBe("idle");
    expect(fixture.player.data.gatheringToolPresentation).toEqual({
      revision: 2,
      itemId: null,
    });

    fixture.resourceSystem.destroy();
    fixture.inventory.destroy();
  });
});
