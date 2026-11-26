import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { EventType } from "@hyperforge/shared";
import { EventBridge } from "../event-bridge";
import { PacketPriority } from "../BandwidthBudget";

class MockWorld extends EventEmitter {
  readonly currentTick = 100;
  readonly entities = {
    get: vi.fn(),
  };

  getSystem = vi.fn();
}

const createBroadcast = () => ({
  sendToAll: vi.fn(),
  sendToNearby: vi.fn(),
  sendToPlayer: vi.fn(),
  sendToPlayerAndSpectators: vi.fn(),
  sendToSpectators: vi.fn(),
});

describe("EventBridge", () => {
  it("broadcasts committed Prayer XP without a duplicate generic save", () => {
    const world = new MockWorld();
    const savePlayer = vi.fn();
    world.getSystem.mockImplementation((name: string) =>
      name === "database" ? { savePlayer } : null,
    );
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    world.emit(EventType.XP_DROP_BROADCAST, {
      playerId: "agent-1",
      skill: "prayer",
      amount: 5,
      newXp: 5,
      newLevel: 1,
      position: { x: 4, y: 0, z: 8 },
    });

    expect(broadcast.sendToPlayerAndSpectators).toHaveBeenCalledWith(
      "agent-1",
      "xpDrop",
      {
        skill: "prayer",
        xpGained: 5,
        newXp: 5,
        newLevel: 1,
        position: { x: 4, y: 0, z: 8 },
      },
    );
    expect(savePlayer).not.toHaveBeenCalled();
  });

  it("continues to persist ordinary XP drops through the generic skill path", () => {
    const world = new MockWorld();
    const savePlayer = vi.fn();
    world.getSystem.mockImplementation((name: string) =>
      name === "database" ? { savePlayer } : null,
    );
    const bridge = new EventBridge(world as never, createBroadcast() as never);
    bridge.setupEventListeners();

    world.emit(EventType.XP_DROP_BROADCAST, {
      playerId: "agent-1",
      skill: "attack",
      amount: 4,
      newXp: 17.8,
      newLevel: 2,
      position: { x: 4, y: 0, z: 8 },
    });

    expect(savePlayer).toHaveBeenCalledOnce();
    expect(savePlayer).toHaveBeenCalledWith("agent-1", {
      attackLevel: 2,
      attackXp: 18,
    });
  });

  it("removes tracked listeners on destroy", () => {
    const world = new MockWorld();
    const bridge = new EventBridge(world as never, createBroadcast() as never);

    bridge.setupEventListeners();

    expect(world.listenerCount(EventType.COMBAT_ENDED)).toBeGreaterThan(0);
    expect(world.listenerCount(EventType.COOKING_COMPLETED)).toBeGreaterThan(0);
    expect(world.listenerCount(EventType.SMELTING_COMPLETE)).toBeGreaterThan(0);
    expect(world.listenerCount(EventType.SMITHING_COMPLETE)).toBeGreaterThan(0);
    expect(world.listenerCount(EventType.CRAFTING_COMPLETE)).toBeGreaterThan(0);
    expect(world.listenerCount(EventType.FLETCHING_COMPLETE)).toBeGreaterThan(
      0,
    );
    expect(world.listenerCount(EventType.TANNING_COMPLETE)).toBeGreaterThan(0);
    expect(
      world.listenerCount(EventType.RUNECRAFTING_COMPLETE),
    ).toBeGreaterThan(0);
    expect(
      world.listenerCount(EventType.PROCESSING_REQUEST_REJECTED),
    ).toBeGreaterThan(0);
    expect(
      world.listenerCount(EventType.PROCESSING_REQUEST_PROGRESS),
    ).toBeGreaterThan(0);

    bridge.destroy();

    expect(world.listenerCount(EventType.COMBAT_ENDED)).toBe(0);
    expect(world.listenerCount(EventType.COOKING_COMPLETED)).toBe(0);
    expect(world.listenerCount(EventType.SMELTING_COMPLETE)).toBe(0);
    expect(world.listenerCount(EventType.SMITHING_COMPLETE)).toBe(0);
    expect(world.listenerCount(EventType.CRAFTING_COMPLETE)).toBe(0);
    expect(world.listenerCount(EventType.FLETCHING_COMPLETE)).toBe(0);
    expect(world.listenerCount(EventType.TANNING_COMPLETE)).toBe(0);
    expect(world.listenerCount(EventType.RUNECRAFTING_COMPLETE)).toBe(0);
    expect(world.listenerCount(EventType.PROCESSING_REQUEST_REJECTED)).toBe(0);
    expect(world.listenerCount(EventType.PROCESSING_REQUEST_PROGRESS)).toBe(0);
  });

  it("forwards correlated processing progress only to its player", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();
    const requestId = "914982d4-bc9e-42e9-a643-ac4ff54fb167";

    world.emit(EventType.PROCESSING_REQUEST_PROGRESS, {
      playerId: "agent-1",
      requestId,
      skill: "crafting",
      phase: "reconciling",
    });

    expect(broadcast.sendToPlayer).toHaveBeenCalledWith(
      "agent-1",
      "processingProgress",
      {
        requestId,
        skill: "crafting",
        phase: "reconciling",
      },
    );
    expect(broadcast.sendToAll).not.toHaveBeenCalledWith(
      "processingProgress",
      expect.anything(),
    );
  });

  it("forwards a correlated processing rejection only to its player", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();
    const requestId = "ab193c1e-eccf-435c-83ab-dcf461b98c18";

    world.emit(EventType.PROCESSING_REQUEST_REJECTED, {
      playerId: "agent-1",
      requestId,
      skill: "smithing",
      reason: "resources_unavailable",
      retryable: false,
    });

    expect(broadcast.sendToPlayer).toHaveBeenCalledWith(
      "agent-1",
      "processingRejected",
      {
        requestId,
        skill: "smithing",
        reason: "resources_unavailable",
        retryable: false,
      },
    );
    expect(broadcast.sendToAll).not.toHaveBeenCalledWith(
      "processingRejected",
      expect.anything(),
    );
  });

  it("forwards an authoritative ground-drop receipt only to its player", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();
    const receipt = {
      success: true as const,
      committed: true as const,
      playerId: "agent-1",
      operationId: "ground-item-drop:11111111-1111-4111-8111-111111111111",
      itemId: "air_rune",
      quantity: 2,
      sourceId: "ground_item_22222222-2222-4222-8222-222222222222",
      position: { x: 4.5, y: 0.1, z: 8.5 },
      replayed: false,
      liveInventoryApplied: true,
      liveCoinsApplied: true,
      presentationReady: true,
    };

    world.emit(EventType.ITEM_DROP_RESULT, receipt);

    expect(broadcast.sendToPlayer).toHaveBeenCalledOnce();
    expect(broadcast.sendToPlayer).toHaveBeenCalledWith(
      "agent-1",
      "groundItemDropResult",
      receipt,
    );
    expect(broadcast.sendToAll).not.toHaveBeenCalled();
    expect(broadcast.sendToPlayerAndSpectators).not.toHaveBeenCalled();
  });

  it("forwards authoritative runecrafting completion only to its player", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    world.emit(EventType.RUNECRAFTING_COMPLETE, {
      playerId: "agent-1",
      runeType: "air",
      runeItemId: "air_rune",
      essenceConsumed: 4,
      runesProduced: 4,
      multiplier: 1,
      xpAwarded: 20,
      requestId: "6c1eb66e-86d4-45bf-b488-148c06ce19ee",
    });

    expect(broadcast.sendToPlayer).toHaveBeenCalledWith(
      "agent-1",
      "runecraftingComplete",
      {
        runeType: "air",
        runeItemId: "air_rune",
        essenceConsumed: 4,
        runesProduced: 4,
        multiplier: 1,
        xpAwarded: 20,
        requestId: "6c1eb66e-86d4-45bf-b488-148c06ce19ee",
      },
    );
    expect(broadcast.sendToAll).not.toHaveBeenCalledWith(
      "runecraftingComplete",
      expect.anything(),
    );
  });

  it("preserves request correlation on every processing completion packet", () => {
    const requestId = "1b06cc78-e236-4c62-9d3e-960ace069f66";
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    world.emit(EventType.COOKING_COMPLETED, {
      playerId: "agent-1",
      rawItemId: "raw_shrimp",
      resultItemId: "shrimp",
      wasBurnt: false,
      xpGained: 10,
      requestId,
    });
    world.emit(EventType.SMELTING_COMPLETE, {
      playerId: "agent-1",
      barItemId: "bronze_bar",
      totalSmelted: 1,
      totalFailed: 0,
      totalXp: 6,
      requestId,
    });
    world.emit(EventType.SMITHING_COMPLETE, {
      playerId: "agent-1",
      recipeId: "bronze_dagger",
      outputItemId: "bronze_dagger",
      totalSmithed: 1,
      totalXp: 12,
      requestId,
    });
    world.emit(EventType.CRAFTING_COMPLETE, {
      playerId: "agent-1",
      recipeId: "leather_gloves",
      outputItemId: "leather_gloves",
      totalCrafted: 1,
      totalXp: 14,
      requestId,
    });
    world.emit(EventType.FLETCHING_COMPLETE, {
      playerId: "agent-1",
      recipeId: "arrow_shaft:logs",
      outputItemId: "arrow_shaft",
      totalCrafted: 1,
      totalXp: 5,
      requestId,
    });
    world.emit(EventType.TANNING_COMPLETE, {
      playerId: "agent-1",
      inputItemId: "cowhide",
      outputItemId: "leather",
      totalTanned: 1,
      totalCost: 1,
      requestId,
    });
    world.emit(EventType.RUNECRAFTING_COMPLETE, {
      playerId: "agent-1",
      runeType: "air",
      runeItemId: "air_rune",
      essenceConsumed: 1,
      runesProduced: 1,
      multiplier: 1,
      xpAwarded: 5,
      requestId,
    });
    world.emit(EventType.FIRE_CREATED, {
      playerId: "agent-1",
      fireId: "fire-1",
      position: { x: 3, y: 0, z: 4 },
      createdAt: 1_000,
      expiresAt: 61_000,
      serverObservedAt: 1_000,
      requestId,
    });

    for (const packet of [
      "cookingComplete",
      "smeltingComplete",
      "smithingComplete",
      "craftingComplete",
      "fletchingComplete",
      "tanningComplete",
      "runecraftingComplete",
    ]) {
      expect(broadcast.sendToPlayer).toHaveBeenCalledWith(
        "agent-1",
        packet,
        expect.objectContaining({ requestId }),
      );
    }
    expect(broadcast.sendToNearby).toHaveBeenCalledWith(
      "fireCreated",
      expect.objectContaining({ requestId }),
      3,
      4,
    );
  });

  it("routes resource lifecycle events through nearby interest management when position is available", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);

    bridge.setupEventListeners();

    const spawnedPayload = {
      id: "tree-1",
      type: "tree_oak",
      position: { x: 42, y: 0, z: 84 },
    };

    world.emit(EventType.RESOURCE_SPAWNED, spawnedPayload);

    expect(broadcast.sendToNearby).toHaveBeenCalledWith(
      "resourceSpawned",
      spawnedPayload,
      42,
      84,
    );
    expect(broadcast.sendToAll).not.toHaveBeenCalledWith(
      "resourceSpawned",
      spawnedPayload,
    );
  });

  it("falls back to full broadcast when a resource event has no position", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);

    bridge.setupEventListeners();

    const depletedPayload = {
      resourceId: "tree-1",
    };

    world.emit(EventType.RESOURCE_DEPLETED, depletedPayload);

    expect(broadcast.sendToAll).toHaveBeenCalledWith(
      "resourceDepleted",
      depletedPayload,
    );
    expect(broadcast.sendToNearby).not.toHaveBeenCalled();
  });

  it("delivers gathering-tool transitions to nearby players and stream spectators", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    world.entities.get.mockReturnValue({
      position: { x: 42, y: 0, z: 84 },
    });
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    const show = {
      playerId: "agent-1",
      itemId: "bronze_pickaxe",
      slot: "weapon",
      revision: 17,
    };
    const hide = { playerId: "agent-1", slot: "weapon", revision: 18 };
    world.emit(EventType.GATHERING_TOOL_SHOW, show);
    world.emit(EventType.GATHERING_TOOL_HIDE, hide);

    expect(broadcast.sendToNearby).toHaveBeenNthCalledWith(
      1,
      "gatheringToolShow",
      show,
      42,
      84,
    );
    expect(broadcast.sendToNearby).toHaveBeenNthCalledWith(
      2,
      "gatheringToolHide",
      hide,
      42,
      84,
    );
    expect(broadcast.sendToPlayer).not.toHaveBeenCalled();
    expect(broadcast.sendToSpectators).not.toHaveBeenCalled();
  });

  it("preserves gathering-tool cleanup for the owner and stream after spatial removal", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    world.entities.get.mockReturnValue(undefined);
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    const hide = { playerId: "agent-1", slot: "weapon", revision: 18 };
    world.emit(EventType.GATHERING_TOOL_HIDE, hide);

    expect(broadcast.sendToPlayer).toHaveBeenCalledWith(
      "agent-1",
      "gatheringToolHide",
      hide,
    );
    expect(broadcast.sendToSpectators).toHaveBeenCalledWith(
      "gatheringToolHide",
      hide,
    );
    expect(broadcast.sendToNearby).not.toHaveBeenCalled();
  });

  it("delivers exact fishing interaction phases to nearby viewers", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    world.entities.get.mockReturnValue({
      position: { x: 42, y: 0, z: 84 },
    });
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();
    const state = {
      playerId: "agent-1",
      revision: 19,
      interactionId: "fishing:session-19",
      resourceId: "fishing_spot_cage_1",
      itemId: "lobster_pot" as const,
      phase: "deployed" as const,
      outcome: "none" as const,
      attempt: 2,
      serverTick: 88,
      targetPosition: { x: 44, y: 0.2, z: 84 },
    };

    world.emit(EventType.FISHING_INTERACTION_PRESENTATION, state);

    expect(broadcast.sendToNearby).toHaveBeenCalledWith(
      "fishingInteractionPresentation",
      state,
      42,
      84,
    );
  });

  it("preserves fishing cleanup for the owner and stream after spatial removal", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    world.entities.get.mockReturnValue(undefined);
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();
    const state = {
      playerId: "agent-1",
      revision: 20,
      interactionId: null,
      resourceId: null,
      itemId: null,
      phase: "idle" as const,
      outcome: "none" as const,
      attempt: 0,
      serverTick: 89,
      targetPosition: null,
    };

    world.emit(EventType.FISHING_INTERACTION_PRESENTATION, state);

    expect(broadcast.sendToPlayer).toHaveBeenCalledWith(
      "agent-1",
      "fishingInteractionPresentation",
      state,
    );
    expect(broadcast.sendToSpectators).toHaveBeenCalledWith(
      "fishingInteractionPresentation",
      state,
    );
    expect(broadcast.sendToNearby).not.toHaveBeenCalled();
  });

  it("delivers processing presentation nearby and preserves terminal cleanup after removal", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    world.entities.get.mockReturnValue({ position: { x: 8, y: 0, z: 9 } });
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();
    const working = {
      playerId: "agent-1",
      revision: 1,
      skill: "smithing" as const,
      phase: "working" as const,
      phaseStartedAtServerTimeMs: 2000,
      targetPosition: { x: 9, y: 0, z: 9 },
    };
    world.emit(EventType.PROCESSING_INTERACTION_PRESENTATION, working);
    expect(broadcast.sendToNearby).toHaveBeenCalledWith(
      "processingInteractionPresentation",
      working,
      8,
      9,
    );

    world.entities.get.mockReturnValue(undefined);
    const idle = {
      playerId: "agent-1",
      revision: 2,
      skill: null,
      phase: "idle" as const,
      phaseStartedAtServerTimeMs: null,
      targetPosition: null,
    };
    world.emit(EventType.PROCESSING_INTERACTION_PRESENTATION, idle);
    expect(broadcast.sendToPlayer).toHaveBeenCalledWith(
      "agent-1",
      "processingInteractionPresentation",
      idle,
    );
    expect(broadcast.sendToSpectators).toHaveBeenCalledWith(
      "processingInteractionPresentation",
      idle,
    );
  });

  it("forwards authoritative projectile impact at the target position", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    world.entities.get.mockReturnValue({
      position: { x: 12, y: 3, z: 18 },
    });
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    world.emit(EventType.COMBAT_PROJECTILE_HIT, {
      projectileId: "projectile-42",
      attackerId: "ranger",
      targetId: "mage",
      damage: 7,
      projectileType: "arrow",
    });

    expect(broadcast.sendToNearby).toHaveBeenCalledWith(
      "projectileHit",
      {
        projectileId: "projectile-42",
        attackerId: "ranger",
        targetId: "mage",
        damage: 7,
        projectileType: "arrow",
        position: { x: 12, y: 3, z: 18 },
        tick: 100,
        networkEventId: expect.any(String),
      },
      12,
      18,
      undefined,
      PacketPriority.CRITICAL,
    );
  });

  it("forwards exact projectile cancellation at the surviving combat anchor", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    world.entities.get.mockReturnValue({
      position: { x: 12, y: 3, z: 18 },
    });
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    world.emit(EventType.COMBAT_PROJECTILE_CANCELLED, {
      projectileId: "projectile-43",
      attackerId: "ranger",
      targetId: "mage",
      projectileType: "arrow",
      reason: "entity_died",
    });

    expect(broadcast.sendToNearby).toHaveBeenCalledWith(
      "projectileCancelled",
      {
        projectileId: "projectile-43",
        attackerId: "ranger",
        targetId: "mage",
        projectileType: "arrow",
        reason: "entity_died",
        tick: 100,
        networkEventId: expect.any(String),
      },
      12,
      18,
      undefined,
      PacketPriority.CRITICAL,
    );
  });

  it("gives each projectile launch a unique network identity without collapsing same-tick attacks", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();
    const launch = {
      attackerId: "ranger",
      targetId: "mage",
      projectileType: "arrow",
      sourcePosition: { x: 1, y: 2, z: 3 },
      targetPosition: { x: 9, y: 2, z: 3 },
    };

    world.emit(EventType.COMBAT_PROJECTILE_LAUNCHED, launch);
    world.emit(EventType.COMBAT_PROJECTILE_LAUNCHED, launch);

    const payloads = broadcast.sendToNearby.mock.calls.map((call) => call[1]);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ ...launch, tick: 100 });
    expect(payloads[1]).toMatchObject({ ...launch, tick: 100 });
    expect(payloads[0].networkEventId).toEqual(expect.any(String));
    expect(payloads[1].networkEventId).toEqual(expect.any(String));
    expect(payloads[0].networkEventId).not.toBe(payloads[1].networkEventId);
    expect(broadcast.sendToNearby.mock.calls).toEqual([
      [
        "projectileLaunched",
        expect.any(Object),
        1,
        3,
        undefined,
        PacketPriority.CRITICAL,
      ],
      [
        "projectileLaunched",
        expect.any(Object),
        1,
        3,
        undefined,
        PacketPriority.CRITICAL,
      ],
    ]);
  });

  it("replays an exact missing projectile range with its paired damage", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    world.entities.get.mockReturnValue({
      position: { x: 12, y: 3, z: 18 },
    });
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();
    const launch = {
      projectileId: "projectile-1",
      attackerId: "ranger",
      targetId: "mage",
      projectileType: "arrow",
      sourcePosition: { x: 1, y: 2, z: 3 },
      targetPosition: { x: 12, y: 3, z: 18 },
    };

    world.emit(EventType.COMBAT_PROJECTILE_LAUNCHED, launch);
    world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      projectileId: "projectile-1",
      attackerId: "ranger",
      targetId: "mage",
      damage: 7,
      attackType: "ranged",
      targetType: "player",
      position: { x: 12, y: 3, z: 18 },
    });
    world.emit(EventType.COMBAT_PROJECTILE_HIT, {
      projectileId: "projectile-1",
      attackerId: "ranger",
      targetId: "mage",
      damage: 7,
      projectileType: "arrow",
      position: { x: 12, y: 3, z: 18 },
    });

    const launchPacket = broadcast.sendToNearby.mock.calls.find(
      ([name]) => name === "projectileLaunched",
    )?.[1] as { networkEventId: string };
    const [sourceId] = launchPacket.networkEventId.split(":");
    const replay = bridge.getProjectileEventReplay({
      sourceId,
      fromSequence: 1,
      toSequence: 2,
    });

    expect(replay.complete).toBe(true);
    expect(replay.events.map((event) => [event.sequence, event.name])).toEqual([
      [1, "projectileLaunched"],
      [2, "combatDamageDealt"],
      [2, "projectileHit"],
    ]);
    expect(replay.events[1].data).toMatchObject({
      projectileId: "projectile-1",
      damage: 7,
      tick: 100,
    });
    expect(replay.events[2].data).toMatchObject({
      projectileId: "projectile-1",
      networkEventId: `${sourceId}:2`,
    });
  });

  it("fails closed for a foreign or oversized projectile replay range", () => {
    const bridge = new EventBridge(
      new MockWorld() as never,
      createBroadcast() as never,
    );

    expect(
      bridge.getProjectileEventReplay({
        sourceId: "foreign-source",
        fromSequence: 1,
        toSequence: 1,
      }),
    ).toMatchObject({ complete: false, events: [] });
    expect(
      bridge.getProjectileEventReplay({
        sourceId: "foreign-source",
        fromSequence: 1,
        toSequence: 65,
      }),
    ).toMatchObject({ complete: false, events: [] });
  });

  it("keeps distinct same-tick projectile damage while deduplicating one identity", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();
    const baseDamage = {
      attackerId: "fighter-a",
      targetId: "fighter-b",
      damage: 7,
      attackType: "ranged" as const,
      targetType: "player" as const,
      position: { x: 4, y: 1, z: 8 },
    };

    world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      ...baseDamage,
      projectileId: "projectile-a",
    });
    world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      ...baseDamage,
      projectileId: "projectile-b",
    });
    world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      ...baseDamage,
      projectileId: "projectile-a",
    });

    expect(broadcast.sendToNearby).toHaveBeenCalledTimes(2);
    expect(
      broadcast.sendToNearby.mock.calls.map((call) => call[1].projectileId),
    ).toEqual(["projectile-a", "projectile-b"]);
    expect(
      broadcast.sendToNearby.mock.calls.every(
        (call) => call[5] === PacketPriority.CRITICAL,
      ),
    ).toBe(true);
  });

  it("preserves authoritative attack style and critical-hit identity for client feedback", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      projectileId: "projectile-42",
      attackerId: "fighter-a",
      targetId: "fighter-b",
      damage: 9,
      attackType: "magic",
      targetType: "player",
      isCritical: true,
      position: { x: 4, y: 1, z: 8 },
      publicActionObservation: {
        operationId: "00000000-0000-4000-8000-000000000701",
      },
      competitiveTerminal: {
        outcome: "win",
        winnerId: "fighter-a",
        loserId: "fighter-b",
        winReason: "kill",
        terminalAt: 1_800_000_000_000,
        seed: "1",
        replayHash: "ab".repeat(32),
      },
    });

    expect(broadcast.sendToNearby).toHaveBeenCalledWith(
      "combatDamageDealt",
      {
        projectileId: "projectile-42",
        attackerId: "fighter-a",
        targetId: "fighter-b",
        damage: 9,
        attackType: "magic",
        targetType: "player",
        isCritical: true,
        position: { x: 4, y: 1, z: 8 },
        tick: 100,
      },
      4,
      8,
      undefined,
      PacketPriority.CRITICAL,
    );
  });

  it("delivers authoritative combat facing and clearing to the fighter and anonymous stream spectators", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    world.emit(EventType.COMBAT_FACE_TARGET, {
      playerId: "mage",
      targetId: "ranger",
    });
    world.emit(EventType.COMBAT_CLEAR_FACE_TARGET, {
      playerId: "mage",
    });

    expect(broadcast.sendToPlayer).toHaveBeenNthCalledWith(
      1,
      "mage",
      "combatFaceTarget",
      { playerId: "mage", targetId: "ranger" },
      PacketPriority.CRITICAL,
    );
    expect(broadcast.sendToSpectators).toHaveBeenNthCalledWith(
      1,
      "combatFaceTarget",
      { playerId: "mage", targetId: "ranger" },
      PacketPriority.CRITICAL,
    );
    expect(broadcast.sendToPlayer).toHaveBeenNthCalledWith(
      2,
      "mage",
      "combatClearFaceTarget",
      { playerId: "mage" },
      PacketPriority.CRITICAL,
    );
    expect(broadcast.sendToSpectators).toHaveBeenNthCalledWith(
      2,
      "combatClearFaceTarget",
      { playerId: "mage" },
      PacketPriority.CRITICAL,
    );
    expect(broadcast.sendToPlayerAndSpectators).not.toHaveBeenCalled();
  });

  it("delivers combat cleanup to the attacker and anonymous stream spectators", () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    world.emit(EventType.COMBAT_ENDED, {
      attackerId: "mage",
      targetId: "ranger",
    });

    expect(broadcast.sendToPlayer).toHaveBeenCalledWith(
      "mage",
      "combatEnded",
      {
        attackerId: "mage",
        targetId: "ranger",
      },
      PacketPriority.CRITICAL,
    );
    expect(broadcast.sendToSpectators).toHaveBeenCalledWith(
      "combatEnded",
      {
        attackerId: "mage",
        targetId: "ranger",
      },
      PacketPriority.CRITICAL,
    );
    expect(broadcast.sendToPlayerAndSpectators).not.toHaveBeenCalled();
  });

  it("delivers terminal contact before the remote death pose", async () => {
    const world = new MockWorld();
    const broadcast = createBroadcast();
    const deliveryOrder: string[] = [];
    world.entities.get.mockReturnValue({
      position: { x: 12, y: 3, z: 18 },
    });
    broadcast.sendToNearby.mockImplementation((name: string) => {
      deliveryOrder.push(name);
    });
    broadcast.sendToAll.mockImplementation((name: string) => {
      deliveryOrder.push(name);
    });
    const bridge = new EventBridge(world as never, broadcast as never);
    bridge.setupEventListeners();

    world.emit(EventType.PLAYER_SET_DEAD, {
      playerId: "mage",
      isDead: true,
      deathPosition: { x: 12, y: 3, z: 18 },
    });
    world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: "ranger",
      targetId: "mage",
      damage: 7,
      targetType: "player",
      position: { x: 12, y: 3, z: 18 },
    });
    world.emit(EventType.COMBAT_PROJECTILE_HIT, {
      attackerId: "ranger",
      targetId: "mage",
      damage: 7,
      projectileType: "arrow",
      position: { x: 12, y: 3, z: 18 },
    });

    expect(deliveryOrder).toEqual(["combatDamageDealt", "projectileHit"]);

    await Promise.resolve();

    expect(deliveryOrder).toEqual([
      "combatDamageDealt",
      "projectileHit",
      "playerSetDead",
      "entityModified",
    ]);
    expect(broadcast.sendToAll).toHaveBeenNthCalledWith(
      1,
      "playerSetDead",
      expect.objectContaining({ playerId: "mage", isDead: true }),
      undefined,
      PacketPriority.CRITICAL,
    );
    expect(broadcast.sendToAll).toHaveBeenNthCalledWith(
      2,
      "entityModified",
      { id: "mage", changes: { e: "death" } },
      undefined,
      PacketPriority.CRITICAL,
    );
  });
});
