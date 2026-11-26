import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DataManager } from "../../../../data/DataManager";
import { EventType } from "../../../../types/events";
import type { AtomicGatheringRewardReceipt } from "../../character/InventorySystem";
import { ResourceSystem } from "../ResourceSystem";

const RESOURCE_ID = "ore_launch_contention";
const AUTONOMY_ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const AUTONOMY_OPERATION_ID = `gathering-reward:${AUTONOMY_ATTEMPT_ID}`;

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

function createFixture(
  commit: (
    playerId: string,
    operationId: string,
    input: {
      resourceId: string;
      depleteAfterCommit: boolean;
      respawnTicks: number;
      skill: "woodcutting" | "mining" | "fishing";
      xpAmount: number;
      rewardItemId: string;
      rewardQuantity: number;
      secondaryItemId?: string | null;
    },
  ) => Promise<AtomicGatheringRewardReceipt>,
  agentCount = 25,
) {
  const commitGatheringRewardAtomic = vi.fn(commit);
  const emit = vi.fn();
  const world = {
    isServer: true,
    currentTick: 0,
    entities: new Map(),
    emit,
    on: vi.fn(),
    off: vi.fn(),
    getPlayer: vi.fn(() => ({ position: { x: 0, y: 0, z: 0 } })),
    getSystem: vi.fn((name: string) =>
      name === "inventory" ? { commitGatheringRewardAtomic } : undefined,
    ),
    $eventBus: {
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      subscribeOnce: vi.fn(() => ({ unsubscribe: vi.fn() })),
      emitEvent: vi.fn(),
      request: vi.fn(),
      respond: vi.fn(),
    },
  };
  const system = new ResourceSystem(world as never);
  const drop = {
    itemId: "copper_ore",
    itemName: "Copper Ore",
    quantity: 1,
    chance: 1,
    xpAmount: 18,
    stackable: false,
  };
  const resource = {
    id: RESOURCE_ID,
    type: "ore",
    name: "Copper Rock",
    position: { x: 1, y: 0, z: 0 },
    skillRequired: "mining",
    isAvailable: true,
    drops: [drop],
  };
  const activeGathering = new Map();
  for (let index = 0; index < agentCount; index++) {
    const playerId = `contention-agent-${String(index).padStart(2, "0")}`;
    activeGathering.set(playerId, {
      playerId,
      resourceId: RESOURCE_ID,
      startTick: 0,
      nextAttemptTick: 1,
      cycleTickInterval: 4,
      attempts: 0,
      successes: 0,
      pendingRewardOperationId: null,
      completionOperationId: null,
      skill: "mining",
      toolItemId: null,
      cachedTuning: {
        levelRequired: 1,
        xpPerLog: 18,
        depleteChance: 1,
        respawnTicks: 10,
      },
      cachedSuccessRate: 1,
      cachedDrops: [drop],
      cachedResourceName: "Copper Rock",
      cachedStartPosition: { x: 0, y: 0, z: 0 },
    });
  }
  const internals = system as unknown as {
    resources: Map<string, typeof resource>;
    activeGathering: typeof activeGathering;
    processRespawns: (tick: number) => void;
    processFishingSpotMovement: (tick: number) => void;
    processResourceTimers: (tick: number) => void;
    usesTimerBasedDepletion: (resourceId: string) => boolean;
    resetGatheringEmote: (playerId: string) => void;
    sendChat: (playerId: string, message: string) => void;
  };
  internals.resources.set(RESOURCE_ID, resource);
  internals.activeGathering = activeGathering;
  internals.processRespawns = vi.fn();
  internals.processFishingSpotMovement = vi.fn();
  internals.processResourceTimers = vi.fn();
  internals.usesTimerBasedDepletion = vi.fn(() => false);
  internals.resetGatheringEmote = vi.fn();
  internals.sendChat = vi.fn();
  return {
    system,
    world,
    resource,
    activeGathering,
    commitGatheringRewardAtomic,
  };
}

function committedReceipt(
  playerId: string,
  operationId: string,
): AtomicGatheringRewardReceipt {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    playerId,
    operationId,
    replayed: false,
    resourceId: RESOURCE_ID,
    depleteAfterCommit: true,
    respawnTicks: 10,
    depletedUntil: Date.now() + 10 * 600,
    skill: "mining",
    xpAmount: 18,
    reward: { itemId: "copper_ore", quantity: 1, stackable: false },
    secondaryItemId: null,
    awardedXp: 18,
    operationCommittedXp: 18,
    currentXp: 18,
    currentLevel: 1,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResourceSystem durable reward contention", () => {
  it("uses and clears the bound autonomy attempt for the first reward only", async () => {
    const fixture = createFixture(async (playerId, operationId) =>
      committedReceipt(playerId, operationId),
    );
    const session = fixture.activeGathering.get("contention-agent-00");
    expect(
      fixture.system.bindGatheringCompletionAttempt(
        "contention-agent-00",
        RESOURCE_ID,
        AUTONOMY_ATTEMPT_ID,
      ),
    ).toBe(true);
    expect(session.completionOperationId).toBe(AUTONOMY_OPERATION_ID);
    vi.spyOn(Math, "random").mockReturnValue(0);

    fixture.system.processGatheringTick(1);

    expect(fixture.commitGatheringRewardAtomic).toHaveBeenCalledWith(
      "contention-agent-00",
      AUTONOMY_OPERATION_ID,
      expect.objectContaining({ resourceId: RESOURCE_ID, skill: "mining" }),
    );
    expect(session.completionOperationId).toBeNull();

    await flushPromises();
    fixture.system.processGatheringTick(2);
    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledWith(
      EventType.RESOURCE_GATHERING_COMPLETED,
      expect.objectContaining({
        playerId: "contention-agent-00",
        resourceId: RESOURCE_ID,
        successful: true,
        operationId: AUTONOMY_OPERATION_ID,
      }),
      "resource",
    );
  });

  it("publishes an exact rejection when completion-bound admission fails", () => {
    const fixture = createFixture(async (playerId, operationId) =>
      committedReceipt(playerId, operationId),
    );

    expect(
      fixture.system.requestGathering({
        playerId: "contention-agent-00",
        resourceId: "missing_resource",
        playerPosition: { x: 100, y: 0, z: 100 },
        completionAttemptId: AUTONOMY_ATTEMPT_ID,
      }),
    ).toBe(false);
    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledWith(
      EventType.RESOURCE_GATHERING_COMPLETED,
      {
        playerId: "contention-agent-00",
        resourceId: "missing_resource",
        successful: false,
        skill: "unknown",
        operationId: AUTONOMY_OPERATION_ID,
        failureReason: "resource_missing",
      },
      "resource",
    );
  });

  it("publishes the exact anti-spam reason for a completion-bound rapid retry", () => {
    const fixture = createFixture(async (playerId, operationId) =>
      committedReceipt(playerId, operationId),
    );
    (
      fixture.system as unknown as {
        gatherRateLimits: Map<string, number>;
      }
    ).gatherRateLimits.set("contention-agent-00", Date.now());

    expect(
      fixture.system.requestGathering({
        playerId: "contention-agent-00",
        resourceId: RESOURCE_ID,
        playerPosition: { x: 0, y: 0, z: 0 },
        completionAttemptId: AUTONOMY_ATTEMPT_ID,
      }),
    ).toBe(false);
    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledWith(
      EventType.RESOURCE_GATHERING_COMPLETED,
      {
        playerId: "contention-agent-00",
        resourceId: RESOURCE_ID,
        successful: false,
        skill: "unknown",
        operationId: AUTONOMY_OPERATION_ID,
        failureReason: "rate_limited",
      },
      "resource",
    );
  });

  it("publishes an exact failure when a bound gathering attempt is cancelled before reward", () => {
    const fixture = createFixture(async (playerId, operationId) =>
      committedReceipt(playerId, operationId),
    );
    const session = fixture.activeGathering.get("contention-agent-00");
    session.completionOperationId = AUTONOMY_OPERATION_ID;

    (
      fixture.system as unknown as {
        cancelGatheringForPlayer: (playerId: string, reason: string) => void;
      }
    ).cancelGatheringForPlayer("contention-agent-00", "movement");

    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledWith(
      EventType.RESOURCE_GATHERING_COMPLETED,
      {
        playerId: "contention-agent-00",
        resourceId: RESOURCE_ID,
        successful: false,
        skill: "mining",
        operationId: AUTONOMY_OPERATION_ID,
        failureReason: "movement",
      },
      "resource",
    );
  });

  it("publishes an exact moving-resource reason for a bound gathering attempt", () => {
    const fixture = createFixture(async (playerId, operationId) =>
      committedReceipt(playerId, operationId),
    );
    const session = fixture.activeGathering.get("contention-agent-00");
    session.completionOperationId = AUTONOMY_OPERATION_ID;

    (
      fixture.system as unknown as {
        stopGathering: (
          data: { playerId: string },
          failureReason: string,
        ) => void;
      }
    ).stopGathering({ playerId: "contention-agent-00" }, "resource_moved");

    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledWith(
      EventType.RESOURCE_GATHERING_COMPLETED,
      {
        playerId: "contention-agent-00",
        resourceId: RESOURCE_ID,
        successful: false,
        skill: "mining",
        operationId: AUTONOMY_OPERATION_ID,
        failureReason: "resource_moved",
      },
      "resource",
    );
  });

  it("hydrates a persisted depletion before spawning a server resource", async () => {
    const respawnAt = Date.now() + 6_000;
    const getGatheringResourceStatesAsync = vi.fn(async () => [
      {
        resourceId: RESOURCE_ID,
        operationId: "gathering-reward:durable",
        depletedAt: respawnAt - 6_000,
        respawnAt,
      },
    ]);
    const spawnEntity = vi.fn(async (config: unknown) => ({
      serialize: () => config,
    }));
    const world = {
      isServer: true,
      currentTick: 100,
      entities: new Map(),
      network: { sendHighPriority: vi.fn() },
      getSystem: vi.fn((name: string) => {
        if (name === "database") return { getGatheringResourceStatesAsync };
        if (name === "entity-manager") return { spawnEntity };
        return undefined;
      }),
    };
    const system = new ResourceSystem(world as never);
    const resource = {
      id: RESOURCE_ID,
      type: "ore",
      name: "Copper Rock",
      position: { x: 10.5, y: 0, z: 20.5 },
      skillRequired: "mining",
      levelRequired: 1,
      toolRequired: "pickaxe",
      respawnTime: 6_000,
      isAvailable: true,
      lastDepleted: 0,
      drops: [
        {
          itemId: "copper_ore",
          itemName: "Copper Ore",
          quantity: 1,
          chance: 1,
          xpAmount: 18,
          stackable: false,
        },
      ],
    };
    const internals = system as unknown as {
      createResourceFromSpawnPoint: () => typeof resource;
      registerTerrainResources: (input: {
        spawnPoints: Array<{
          position: { x: number; y: number; z: number };
          type: "ore";
          subType: "copper";
        }>;
      }) => Promise<void>;
      resources: Map<string, typeof resource>;
      respawnAtTick: Map<string, number>;
    };
    internals.createResourceFromSpawnPoint = vi.fn(() => resource);

    await internals.registerTerrainResources({
      spawnPoints: [
        {
          position: resource.position,
          type: "ore",
          subType: "copper",
        },
      ],
    });

    expect(getGatheringResourceStatesAsync).toHaveBeenCalledWith([RESOURCE_ID]);
    expect(spawnEntity).toHaveBeenCalledWith(
      expect.objectContaining({ id: RESOURCE_ID, depleted: true }),
      { suppressBroadcast: true },
    );
    expect(internals.resources.get(RESOURCE_ID)?.isAvailable).toBe(false);
    expect(internals.respawnAtTick.get(RESOURCE_ID)).toBeGreaterThan(100);
  });

  it("freezes a forestry timer while its durable depletion decision is in flight", () => {
    const fixture = createFixture(async (playerId, operationId) =>
      committedReceipt(playerId, operationId),
    );
    const internals = fixture.system as unknown as {
      resourceTimers: Map<
        string,
        {
          currentTicks: number;
          maxTicks: number;
          hasReceivedFirstLog: boolean;
          activeGatherers: Set<string>;
          lastUpdateTick: number;
        }
      >;
      gatheringRewardReservations: Map<string, string>;
      processResourceTimers: (tick: number) => void;
    };
    internals.processResourceTimers = Object.getPrototypeOf(fixture.system)[
      "processResourceTimers"
    ].bind(fixture.system);
    internals.resourceTimers.set(RESOURCE_ID, {
      currentTicks: 1,
      maxTicks: 10,
      hasReceivedFirstLog: true,
      activeGatherers: new Set(["contention-agent-00"]),
      lastUpdateTick: 5,
    });
    internals.gatheringRewardReservations.set(RESOURCE_ID, "reward-in-flight");

    internals.processResourceTimers(10);
    expect(internals.resourceTimers.get(RESOURCE_ID)?.currentTicks).toBe(1);
    expect(internals.resourceTimers.get(RESOURCE_ID)?.lastUpdateTick).toBe(10);

    internals.gatheringRewardReservations.delete(RESOURCE_ID);
    internals.processResourceTimers(11);
    expect(internals.resourceTimers.get(RESOURCE_ID)?.currentTicks).toBe(0);
  });

  it("admits exactly one of 25 simultaneous agents to a depleting node", async () => {
    let resolveCommit:
      ((receipt: AtomicGatheringRewardReceipt) => void) | undefined;
    const gate = new Promise<AtomicGatheringRewardReceipt>((resolve) => {
      resolveCommit = resolve;
    });
    const fixture = createFixture(async () => gate);
    vi.spyOn(Math, "random").mockReturnValue(0);

    fixture.system.processGatheringTick(1);
    expect(fixture.commitGatheringRewardAtomic).toHaveBeenCalledOnce();
    expect(fixture.system.getGatheringCustodyStats()).toEqual(
      expect.objectContaining({
        pendingRewards: 1,
        inFlightRewards: 1,
        resourceReservations: 1,
      }),
    );
    expect(fixture.resource.isAvailable).toBe(true);
    expect(
      fixture.world.$eventBus.emitEvent.mock.calls.filter(
        ([event]) => event === EventType.SKILLS_PROGRESS_COMMITTED,
      ),
    ).toHaveLength(0);

    const [playerId, operationId] =
      fixture.commitGatheringRewardAtomic.mock.calls[0];
    resolveCommit?.(committedReceipt(playerId, operationId));
    await flushPromises();
    fixture.system.processGatheringTick(2);

    expect(fixture.resource.isAvailable).toBe(false);
    expect(fixture.commitGatheringRewardAtomic).toHaveBeenCalledOnce();
    expect(
      fixture.world.$eventBus.emitEvent.mock.calls.filter(
        ([event]) => event === EventType.SKILLS_PROGRESS_COMMITTED,
      ),
    ).toHaveLength(1);
    expect(
      fixture.world.$eventBus.emitEvent.mock.calls.filter(
        ([event]) => event === EventType.RESOURCE_DEPLETED,
      ),
    ).toHaveLength(1);
    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledWith(
      EventType.RESOURCE_GATHERING_COMPLETED,
      {
        playerId,
        resourceId: RESOURCE_ID,
        successful: true,
        skill: "mining",
        operationId,
        rewardItemId: "copper_ore",
        rewardQuantity: 1,
      },
      "resource",
    );
    expect(fixture.activeGathering.size).toBe(0);
    expect(fixture.system.getGatheringCustodyStats()).toEqual(
      expect.objectContaining({
        pendingRewards: 0,
        resourceReservations: 0,
      }),
    );
  });

  it("publishes committed gathering truth even when the source does not deplete", async () => {
    const fixture = createFixture(
      async (playerId, operationId) => ({
        ...committedReceipt(playerId, operationId),
        depleteAfterCommit: false,
        depletedUntil: null,
      }),
      1,
    );
    const session = fixture.activeGathering.get("contention-agent-00");
    session.cachedTuning.depleteChance = 0;
    vi.spyOn(Math, "random").mockReturnValue(0);

    fixture.system.processGatheringTick(1);
    await flushPromises();
    fixture.system.processGatheringTick(2);

    const [playerId, operationId] =
      fixture.commitGatheringRewardAtomic.mock.calls[0];
    expect(fixture.resource.isAvailable).toBe(true);
    expect(
      fixture.world.$eventBus.emitEvent.mock.calls.filter(
        ([event]) => event === EventType.RESOURCE_DEPLETED,
      ),
    ).toHaveLength(0);
    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledWith(
      EventType.RESOURCE_GATHERING_COMPLETED,
      expect.objectContaining({
        playerId,
        operationId,
        resourceId: RESOURCE_ID,
        rewardItemId: "copper_ore",
        rewardQuantity: 1,
      }),
      "resource",
    );
  });

  it("retains and replays the same operation after an ambiguous failure", async () => {
    let calls = 0;
    const fixture = createFixture(async (playerId, operationId) => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          committed: false,
          liveInventoryApplied: false,
          playerId,
          operationId,
          replayed: false,
          skill: "mining",
          xpAmount: 18,
          reward: { itemId: "copper_ore", quantity: 1, stackable: false },
          secondaryItemId: null,
          retryable: true,
          reason: "persistence_ambiguous",
        };
      }
      return { ...committedReceipt(playerId, operationId), replayed: true };
    });
    vi.spyOn(Math, "random").mockReturnValue(0);

    fixture.system.processGatheringTick(1);
    await flushPromises();
    fixture.system.processGatheringTick(2);
    expect(fixture.system.getGatheringCustodyStats()).toEqual(
      expect.objectContaining({
        retryWaitingRewards: 1,
        maxRetryCount: 1,
      }),
    );
    fixture.system.processGatheringTick(3);
    expect(fixture.commitGatheringRewardAtomic).toHaveBeenCalledOnce();
    fixture.system.processGatheringTick(4);
    await flushPromises();
    fixture.system.processGatheringTick(5);

    expect(fixture.commitGatheringRewardAtomic).toHaveBeenCalledTimes(2);
    expect(fixture.commitGatheringRewardAtomic.mock.calls[0][1]).toBe(
      fixture.commitGatheringRewardAtomic.mock.calls[1][1],
    );
    expect(fixture.resource.isAvailable).toBe(false);
    expect(
      fixture.world.$eventBus.emitEvent.mock.calls.filter(
        ([event]) => event === EventType.SKILLS_PROGRESS_COMMITTED,
      ),
    ).toHaveLength(1);
  });

  it("never grants XP or depletion for a definitive full-inventory rejection", async () => {
    const fixture = createFixture(async (playerId, operationId) => ({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      playerId,
      operationId,
      replayed: false,
      skill: "mining",
      xpAmount: 18,
      reward: { itemId: "copper_ore", quantity: 1, stackable: false },
      secondaryItemId: null,
      retryable: false,
      reason: "inventory_full",
    }));
    vi.spyOn(Math, "random").mockReturnValue(0);
    fixture.activeGathering.get("contention-agent-00").completionOperationId =
      AUTONOMY_OPERATION_ID;

    fixture.system.processGatheringTick(1);
    await flushPromises();
    fixture.system.processGatheringTick(2);

    expect(fixture.resource.isAvailable).toBe(true);
    expect(
      fixture.world.$eventBus.emitEvent.mock.calls.filter(
        ([event]) => event === EventType.SKILLS_PROGRESS_COMMITTED,
      ),
    ).toHaveLength(0);
    expect(
      fixture.world.$eventBus.emitEvent.mock.calls.filter(
        ([event]) => event === EventType.RESOURCE_DEPLETED,
      ),
    ).toHaveLength(0);
    expect(fixture.activeGathering.size).toBe(24);
    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledWith(
      EventType.RESOURCE_GATHERING_COMPLETED,
      {
        playerId: "contention-agent-00",
        resourceId: RESOURCE_ID,
        successful: false,
        skill: "mining",
        operationId: AUTONOMY_OPERATION_ID,
        failureReason: "inventory_full",
      },
      "resource",
    );
  });

  it("preserves unresolved reward custody and clears the arrival emote after the session was canceled", () => {
    const fixture = createFixture(
      async (playerId, operationId) =>
        new Promise<AtomicGatheringRewardReceipt>(() => {
          void playerId;
          void operationId;
        }),
      1,
    );
    vi.spyOn(Math, "random").mockReturnValue(0);

    fixture.system.processGatheringTick(1);
    const [playerId] = fixture.commitGatheringRewardAtomic.mock.calls[0];
    const internals = fixture.system as unknown as {
      activeGathering: Map<string, unknown>;
      pendingGatherRewards: Map<string, unknown>;
      cancelGatheringForPlayer: (id: string, reason: string) => void;
      resetGatheringEmote: ReturnType<typeof vi.fn>;
      startGathering: (data: {
        playerId: string;
        resourceId: string;
        playerPosition: { x: number; y: number; z: number };
      }) => void;
    };
    const pending = internals.pendingGatherRewards.get(playerId);

    internals.cancelGatheringForPlayer(playerId, "movement");
    internals.resetGatheringEmote.mockClear();
    fixture.world.$eventBus.emitEvent.mockClear();

    const replacementRequest = {
      playerId,
      resourceId: RESOURCE_ID,
      playerPosition: { x: 0, y: 0, z: 0 },
    };
    internals.startGathering(replacementRequest);
    internals.startGathering(replacementRequest);

    expect(internals.activeGathering.size).toBe(0);
    expect(internals.pendingGatherRewards.get(playerId)).toBe(pending);
    expect(fixture.commitGatheringRewardAtomic).toHaveBeenCalledOnce();
    expect(internals.resetGatheringEmote).toHaveBeenCalledTimes(1);
    expect(internals.resetGatheringEmote).toHaveBeenCalledWith(playerId);
    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledOnce();
    expect(fixture.world.$eventBus.emitEvent).toHaveBeenCalledWith(
      EventType.UI_MESSAGE,
      {
        playerId,
        message:
          "Your previous gathering result is still being reconciled. Please try again in a moment.",
        type: "info",
      },
      "resource",
    );
  });

  it("leaves the live gathering presentation intact while its own reward is unresolved", () => {
    const fixture = createFixture(
      async (playerId, operationId) =>
        new Promise<AtomicGatheringRewardReceipt>(() => {
          void playerId;
          void operationId;
        }),
      1,
    );
    vi.spyOn(Math, "random").mockReturnValue(0);

    fixture.system.processGatheringTick(1);
    const [playerId] = fixture.commitGatheringRewardAtomic.mock.calls[0];
    const internals = fixture.system as unknown as {
      activeGathering: Map<string, unknown>;
      pendingGatherRewards: Map<string, unknown>;
      resetGatheringEmote: ReturnType<typeof vi.fn>;
      startGathering: (data: {
        playerId: string;
        resourceId: string;
        playerPosition: { x: number; y: number; z: number };
      }) => void;
    };
    const session = internals.activeGathering.get(playerId);
    const pending = internals.pendingGatherRewards.get(playerId);
    internals.resetGatheringEmote.mockClear();
    fixture.world.$eventBus.emitEvent.mockClear();

    internals.startGathering({
      playerId,
      resourceId: RESOURCE_ID,
      playerPosition: { x: 0, y: 0, z: 0 },
    });

    expect(internals.activeGathering.get(playerId)).toBe(session);
    expect(internals.pendingGatherRewards.get(playerId)).toBe(pending);
    expect(fixture.commitGatheringRewardAtomic).toHaveBeenCalledOnce();
    expect(internals.resetGatheringEmote).not.toHaveBeenCalled();
    expect(fixture.world.$eventBus.emitEvent).not.toHaveBeenCalled();
  });

  it("honors an already-started durable reward after movement cancels future attempts", async () => {
    let resolveCommit:
      ((receipt: AtomicGatheringRewardReceipt) => void) | undefined;
    const gate = new Promise<AtomicGatheringRewardReceipt>((resolve) => {
      resolveCommit = resolve;
    });
    const fixture = createFixture(async () => gate, 1);
    vi.spyOn(Math, "random").mockReturnValue(0);

    fixture.system.processGatheringTick(1);
    const [playerId, operationId] =
      fixture.commitGatheringRewardAtomic.mock.calls[0];
    (
      fixture.system as unknown as {
        cancelGatheringForPlayer: (id: string, reason: string) => void;
      }
    ).cancelGatheringForPlayer(playerId, "movement");
    expect(fixture.activeGathering.size).toBe(0);

    resolveCommit?.(committedReceipt(playerId, operationId));
    await flushPromises();
    fixture.system.processGatheringTick(2);

    expect(fixture.resource.isAvailable).toBe(false);
    expect(
      fixture.world.$eventBus.emitEvent.mock.calls.filter(
        ([event]) => event === EventType.SKILLS_PROGRESS_COMMITTED,
      ),
    ).toHaveLength(1);
    expect(fixture.commitGatheringRewardAtomic).toHaveBeenCalledOnce();
  });
});
