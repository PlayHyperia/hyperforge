/**
 * Tests for EmbeddedHyperiaService firemaking and gather features:
 * - executeFiremake with proper slot resolution and event emission
 * - executeAttack dead target guard
 * - executeGather PendingGatherManager integration
 * - Dead mob filtering in getNearbyEntities
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, processingDataProvider } from "@hyperforge/shared";
import { EmbeddedHyperiaService } from "../EmbeddedHyperiaService";
import { loadWorldProfileTestFixture } from "./worldProfileTestFixture";

beforeEach(loadWorldProfileTestFixture);

function createMockWorld(options?: {
  inventorySystem?: Record<string, unknown> | null;
  equipmentSystem?: Record<string, unknown> | null;
  networkSystem?: Record<string, unknown> | null;
  processingSystem?: Record<string, unknown> | null;
}) {
  const entities = new Map();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emit = vi.fn((event: string, data: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(data);
    if (event === EventType.PROCESSING_FIREMAKING_REQUEST) {
      const request = data as { playerId: string; requestId?: string };
      const completion = {
        fireId: `fire-${request.playerId}`,
        playerId: request.playerId,
        position: { x: 0, y: 10, z: 0 },
        createdAt: 1_000,
        expiresAt: 61_000,
        requestId: request.requestId,
      };
      for (const listener of listeners.get(EventType.FIRE_CREATED) ?? []) {
        listener(completion);
      }
    }
  });
  const world = {
    entities: {
      items: entities,
      get: (id: string) => entities.get(id),
      values: () => entities.values(),
      add: (entityData: Record<string, unknown>) => {
        const id = String(entityData.id);
        const rawPosition = Array.isArray(entityData.position)
          ? (entityData.position as [number, number, number])
          : [0, 0, 0];
        const position = {
          x: rawPosition[0],
          y: rawPosition[1],
          z: rawPosition[2],
          set(x: number, y: number, z: number) {
            position.x = x;
            position.y = y;
            position.z = z;
          },
        };
        const entity = {
          id,
          type: String(entityData.type ?? "object"),
          data: { ...entityData, position: [...rawPosition] },
          position,
          node: { position },
        };
        entities.set(id, entity);
        return entity;
      },
      remove: (id: string) => entities.delete(id),
    },
    on: vi.fn((event: string, listener: (data: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    }),
    off: vi.fn((event: string, listener: (data: unknown) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emit,
    isServer: true,
    getSystem: vi.fn((name: string) => {
      if (name === "inventory") return options?.inventorySystem ?? null;
      if (name === "equipment") return options?.equipmentSystem ?? null;
      if (name === "network") return options?.networkSystem ?? null;
      if (name === "processing") {
        return (
          options?.processingSystem ?? { canPlayerLightFireHere: () => true }
        );
      }
      if (name === "database") {
        return {
          acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
          beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
          getProcessingActionCommitStatusAsync: vi
            .fn()
            .mockResolvedValue("committed"),
          getCharactersAsync: async () => [
            { id: "agent-1", name: "TestAgent", avatar: null, wallet: null },
          ],
          getPlayerAsync: async () => null,
        };
      }
      if (name === "terrain") return { getHeightAt: () => 10 };
      return null;
    }),
    settings: { avatar: { url: "asset://avatars/test.vrm" } },
  };

  return { world, entities, emit };
}

async function createInitializedService(
  worldOptions?: Parameters<typeof createMockWorld>[0],
) {
  const ctx = createMockWorld(worldOptions);
  const service = new EmbeddedHyperiaService(
    ctx.world as never,
    "agent-1",
    "acct-1",
    "TestAgent",
  );
  await service.initialize();
  return { service, ...ctx };
}

// ==========================================================================
// executeFiremake
// ==========================================================================
describe("executeFiremake", () => {
  beforeEach(() => {
    vi.spyOn(processingDataProvider, "getBurnableLogIds").mockReturnValue(
      new Set(["logs", "oak_logs", "willow_logs"]),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits PROCESSING_FIREMAKING_REQUEST with correct slots", async () => {
    const { service, emit } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            {
              slot: 2,
              itemId: "tinderbox",
              quantity: 1,
              item: { id: "tinderbox", name: "Tinderbox", type: "tool" },
            },
            {
              slot: 5,
              itemId: "logs",
              quantity: 1,
              item: { id: "logs", name: "Logs", type: "resource" },
            },
          ],
        }),
      },
    });

    const result = await service.executeFiremake("logs");

    expect(result).toBe(true);
    const fireCall = emit.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("firemaking"),
    );
    expect(fireCall).toBeDefined();
    expect(fireCall![1]).toMatchObject({
      playerId: "agent-1",
      logsId: "logs",
      logsSlot: 5,
      tinderboxSlot: 2,
      requestId: expect.any(String),
    });
  });

  it("returns false when no tinderbox in inventory", async () => {
    const { service } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            {
              slot: 0,
              itemId: "logs",
              quantity: 1,
              item: { id: "logs", name: "Logs", type: "resource" },
            },
          ],
        }),
      },
    });

    const result = await service.executeFiremake();
    expect(result).toBe(false);
  });

  it("returns false when no logs in inventory", async () => {
    const { service } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            {
              slot: 0,
              itemId: "tinderbox",
              quantity: 1,
              item: { id: "tinderbox", name: "Tinderbox", type: "tool" },
            },
          ],
        }),
      },
    });

    const result = await service.executeFiremake();
    expect(result).toBe(false);
  });

  it("returns false when the authoritative processing system rejects the tile", async () => {
    const { service, emit } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            { slot: 0, itemId: "tinderbox", quantity: 1 },
            { slot: 1, itemId: "logs", quantity: 1 },
          ],
        }),
      },
      processingSystem: { canPlayerLightFireHere: () => false },
    });

    await expect(service.executeFiremake()).resolves.toBe(false);
    expect(emit).not.toHaveBeenCalledWith(
      expect.stringContaining("firemaking"),
      expect.anything(),
    );
  });

  it("finds oak_logs when specified", async () => {
    const { service, emit } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            {
              slot: 0,
              itemId: "tinderbox",
              quantity: 1,
              item: { id: "tinderbox", name: "Tinderbox", type: "tool" },
            },
            {
              slot: 1,
              itemId: "logs",
              quantity: 1,
              item: { id: "logs", name: "Logs", type: "resource" },
            },
            {
              slot: 2,
              itemId: "oak_logs",
              quantity: 1,
              item: { id: "oak_logs", name: "Oak Logs", type: "resource" },
            },
          ],
        }),
      },
    });

    await service.executeFiremake("oak_logs");

    const fireCall = emit.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("firemaking"),
    );
    expect(fireCall![1]).toMatchObject({
      logsId: "oak_logs",
      logsSlot: 2,
    });
  });

  it("auto-selects first available logs when no preference", async () => {
    const { service, emit } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            {
              slot: 0,
              itemId: "tinderbox",
              quantity: 1,
              item: { id: "tinderbox", name: "Tinderbox", type: "tool" },
            },
            {
              slot: 3,
              itemId: "willow_logs",
              quantity: 1,
              item: {
                id: "willow_logs",
                name: "Willow Logs",
                type: "resource",
              },
            },
          ],
        }),
      },
    });

    await service.executeFiremake();

    const fireCall = emit.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("firemaking"),
    );
    expect(fireCall![1]).toMatchObject({
      logsId: "willow_logs",
      logsSlot: 3,
    });
  });

  it("selects a burnable log authored by the loaded recipe manifest", async () => {
    vi.mocked(processingDataProvider.getBurnableLogIds).mockReturnValue(
      new Set(["manifest_logs"]),
    );
    const { service, emit } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            { slot: 0, itemId: "tinderbox", quantity: 1 },
            { slot: 1, itemId: "logs", quantity: 1 },
            { slot: 2, itemId: "manifest_logs", quantity: 1 },
          ],
        }),
      },
    });

    await expect(service.executeFiremake()).resolves.toBe(true);

    const fireCall = emit.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("firemaking"),
    );
    expect(fireCall![1]).toMatchObject({
      logsId: "manifest_logs",
      logsSlot: 2,
    });
  });

  it("rejects a carried item that is not in the loaded firemaking manifest", async () => {
    vi.mocked(processingDataProvider.getBurnableLogIds).mockReturnValue(
      new Set(["logs"]),
    );
    const { service, emit } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            { slot: 0, itemId: "tinderbox", quantity: 1 },
            { slot: 1, itemId: "display_logs", quantity: 1 },
          ],
        }),
      },
    });

    await expect(service.executeFiremake("display_logs")).resolves.toBe(false);
    expect(emit).not.toHaveBeenCalledWith(
      expect.stringContaining("firemaking"),
      expect.anything(),
    );
  });

  it("returns false when service is not active", async () => {
    const { service } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            {
              slot: 0,
              itemId: "tinderbox",
              quantity: 1,
              item: { id: "tinderbox", name: "Tinderbox", type: "tool" },
            },
            {
              slot: 1,
              itemId: "logs",
              quantity: 1,
              item: { id: "logs", name: "Logs", type: "resource" },
            },
          ],
        }),
      },
    });
    await service.stop();
    const result = await service.executeFiremake();
    expect(result).toBe(false);
  });
});

// ==========================================================================
// executeAttack — dead target guard
// ==========================================================================
describe("executeAttack dead target guard", () => {
  it("reports only an authoritative server attack acceptance as dispatched", async () => {
    const requestServerAttack = vi.fn(() => true);
    const { service, entities } = await createInitializedService({
      networkSystem: { requestServerAttack },
    });
    entities.set("goblin-1", {
      id: "goblin-1",
      type: "mob",
      data: { type: "mob", health: 10 },
      node: { position: { x: 5, y: 0, z: 5 } },
      isDead: () => false,
      isAlive: () => true,
    });

    await expect(service.executeAttack("goblin-1")).resolves.toBe(true);
    expect(requestServerAttack).toHaveBeenCalledWith(
      "agent-1",
      "goblin-1",
      "mob",
    );
  });

  it("propagates an authoritative server attack rejection", async () => {
    const requestServerAttack = vi.fn(() => false);
    const { service, entities } = await createInitializedService({
      networkSystem: { requestServerAttack },
    });
    entities.set("goblin-1", {
      id: "goblin-1",
      type: "mob",
      data: { type: "mob", health: 10 },
      node: { position: { x: 5, y: 0, z: 5 } },
      isDead: () => false,
      isAlive: () => true,
    });

    await expect(service.executeAttack("goblin-1")).resolves.toBe(false);
  });

  it("does not attack dead target (isDead returns true)", async () => {
    const { service, entities, emit } = await createInitializedService();

    const deadMob = {
      id: "goblin-1",
      type: "mob",
      data: { type: "mob", health: 0 },
      node: { position: { x: 5, y: 0, z: 5 } },
      isDead: () => true,
      isAlive: () => false,
    };
    entities.set("goblin-1", deadMob);

    await expect(service.executeAttack("goblin-1")).resolves.toBe(false);

    const attackCall = emit.mock.calls.find(
      (call: unknown[]) =>
        String(call[0]).includes("attack") ||
        String(call[0]).includes("combat"),
    );
    expect(attackCall).toBeUndefined();
  });

  it("does not attack nonexistent target", async () => {
    const { service, emit } = await createInitializedService();

    await expect(service.executeAttack("nonexistent-mob")).resolves.toBe(false);

    const attackCall = emit.mock.calls.find(
      (call: unknown[]) =>
        String(call[0]).includes("attack") ||
        String(call[0]).includes("combat"),
    );
    expect(attackCall).toBeUndefined();
  });
});

// ==========================================================================
// executeGather — PendingGatherManager integration
// ==========================================================================
describe("executeGather", () => {
  const attemptId = "11111111-1111-4111-8111-111111111111";

  it("uses PendingGatherManager when available", async () => {
    const queueFn = vi.fn(() => true);
    const { service } = await createInitializedService({
      networkSystem: {
        pendingGatherManager: {
          queuePendingGather: queueFn,
        },
        tickSystem: {
          getCurrentTick: () => 42,
        },
      },
    });

    await expect(service.executeGather("tree_23_-10")).resolves.toBe(true);

    expect(queueFn).toHaveBeenCalledWith("agent-1", "tree_23_-10", 42, true);
  });

  it("fails closed when PendingGatherManager is unavailable", async () => {
    const { service, emit } = await createInitializedService();

    await expect(service.executeGather("tree_23_-10")).resolves.toBe(false);

    const gatherCall = emit.mock.calls.find(
      (call: unknown[]) =>
        String(call[0]).includes("resource") &&
        String(call[0]).includes("gather"),
    );
    expect(gatherCall).toBeUndefined();
  });

  it("fails closed when PendingGatherManager lacks tick authority", async () => {
    const queueFn = vi.fn(() => true);
    const { service, emit } = await createInitializedService({
      networkSystem: {
        pendingGatherManager: { queuePendingGather: queueFn },
      },
    });

    await expect(service.executeGather("tree_23_-10")).resolves.toBe(false);
    expect(queueFn).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(
      expect.stringContaining("resource"),
      expect.anything(),
    );
  });

  it("returns false when PendingGatherManager rejects the request", async () => {
    const queueFn = vi.fn(() => false);
    const { service } = await createInitializedService({
      networkSystem: {
        pendingGatherManager: { queuePendingGather: queueFn },
        tickSystem: { getCurrentTick: () => 42 },
      },
    });

    await expect(service.executeGather("depleted-tree")).resolves.toBe(false);
  });

  it("completes an autonomous gather only from its exact first committed reward", async () => {
    const queueFn = vi.fn(() => true);
    const { service, emit } = await createInitializedService({
      networkSystem: {
        pendingGatherManager: { queuePendingGather: queueFn },
        tickSystem: { getCurrentTick: () => 42 },
      },
    });

    let settled = false;
    const completion = service
      .executeGather("tree_23_-10", attemptId)
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(queueFn).toHaveBeenCalledWith(
      "agent-1",
      "tree_23_-10",
      42,
      true,
      attemptId,
    );

    emit(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: "agent-1",
      resourceId: "tree_23_-10",
      successful: true,
      skill: "woodcutting",
      operationId: "gathering-reward:22222222-2222-4222-8222-222222222222",
      rewardItemId: "logs",
      rewardQuantity: 1,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: "agent-1",
      resourceId: "tree_23_-10",
      successful: true,
      skill: "woodcutting",
      operationId: `gathering-reward:${attemptId}`,
      rewardItemId: "logs",
      rewardQuantity: 1,
    });

    await expect(completion).resolves.toBe(true);
    expect(service.getLastGatherFailureReason()).toBeNull();
  });

  it("propagates the exact first-reward rejection for an autonomous gather", async () => {
    const { service, emit } = await createInitializedService({
      networkSystem: {
        pendingGatherManager: { queuePendingGather: vi.fn(() => true) },
        tickSystem: { getCurrentTick: () => 42 },
      },
    });

    const completion = service.executeGather("tree_23_-10", attemptId);
    emit(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: "agent-1",
      resourceId: "tree_23_-10",
      successful: false,
      skill: "woodcutting",
      operationId: `gathering-reward:${attemptId}`,
      failureReason: "rate_limited",
    });

    await expect(completion).resolves.toBe(false);
    expect(service.getLastGatherFailureReason()).toBe("rate_limited");
  });

  it("cancels an unresolved first-reward wait when the embedded service stops", async () => {
    const { service } = await createInitializedService({
      networkSystem: {
        pendingGatherManager: { queuePendingGather: vi.fn(() => true) },
        tickSystem: { getCurrentTick: () => 42 },
      },
    });

    const completion = service.executeGather("tree_23_-10", attemptId);
    await Promise.resolve();
    await service.stop();

    await expect(completion).resolves.toBe(false);
  });

  it("rejects a concurrent autonomous gather without replacing the live waiter", async () => {
    const queueFn = vi.fn(() => true);
    const { service, emit } = await createInitializedService({
      networkSystem: {
        pendingGatherManager: { queuePendingGather: queueFn },
        tickSystem: { getCurrentTick: () => 42 },
      },
    });
    const first = service.executeGather("tree_23_-10", attemptId);

    await expect(
      service.executeGather(
        "tree_23_-10",
        "22222222-2222-4222-8222-222222222222",
      ),
    ).resolves.toBe(false);
    expect(queueFn).toHaveBeenCalledTimes(1);

    emit(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: "agent-1",
      resourceId: "tree_23_-10",
      successful: false,
      skill: "woodcutting",
      operationId: `gathering-reward:${attemptId}`,
    });
    await expect(first).resolves.toBe(false);
  });
});

describe("executeMove", () => {
  it("does not bypass an authoritative network rejection with direct movement", async () => {
    const requestServerMove = vi.fn(() => false);
    const { service, world } = await createInitializedService({
      networkSystem: { requestServerMove },
    });
    const player = world.entities.get("agent-1") as {
      data: { position: [number, number, number] };
    };
    const before = [...player.data.position];

    await expect(service.executeMove([12, 10, 12], true)).resolves.toBe(false);

    expect(requestServerMove).toHaveBeenCalledWith("agent-1", [12, 10, 12], {
      runMode: true,
    });
    expect(player.data.position).toEqual(before);
  });

  it("refuses to mutate position when movement authority is unavailable", async () => {
    const { service, world, emit } = await createInitializedService();
    const player = world.entities.get("agent-1") as {
      data: { position: [number, number, number] };
    };
    const before = [...player.data.position];

    await expect(service.executeMove([12, 10, 12], false)).resolves.toBe(false);
    expect(player.data.position).toEqual(before);
    expect(emit).not.toHaveBeenCalledWith(
      EventType.ENTITY_MODIFIED,
      expect.anything(),
    );
  });

  it("passes the exact live workstation footprint to authoritative pathing", async () => {
    const requestServerMove = vi.fn(() => true);
    const { service, entities } = await createInitializedService({
      networkSystem: { requestServerMove },
    });
    entities.set("furnace-live", {
      id: "furnace-live",
      entityType: "furnace",
      position: { x: 20.5, y: 0, z: 20.5 },
      data: { type: "furnace", position: [20.5, 0, 20.5] },
      getInteractionRange: () => 2,
      getInteractionFootprint: () => ({ width: 2, depth: 2 }),
    });

    await expect(service.executeMove([20.5, 0, 20.5], true)).resolves.toBe(
      true,
    );
    expect(requestServerMove).toHaveBeenCalledWith("agent-1", [20.5, 0, 20.5], {
      runMode: true,
      interactionArrival: {
        interactionRange: 2,
        footprintWidth: 2,
        footprintDepth: 2,
      },
    });
  });
});

describe("executePickup", () => {
  const attemptId = "11111111-1111-4111-8111-111111111111";

  it("rejects a stale ground-item target without requesting authoritative pickup", async () => {
    const requestServerPickup = vi.fn(async () => true);
    const { service, emit } = await createInitializedService({
      networkSystem: { requestServerPickup },
    });

    await expect(
      service.executePickup("missing-item", attemptId),
    ).resolves.toBe(false);
    expect(requestServerPickup).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(
      EventType.ITEM_PICKUP,
      expect.anything(),
    );
  });

  it("reports only an authoritative pickup completion", async () => {
    const requestServerPickup = vi.fn(async () => true);
    const { service, entities, emit } = await createInitializedService({
      networkSystem: { requestServerPickup },
    });
    entities.set("ground-item-1", {
      id: "ground-item-1",
      type: "item",
      data: { type: "item" },
    });

    await expect(
      service.executePickup("ground-item-1", attemptId),
    ).resolves.toBe(true);
    expect(requestServerPickup).toHaveBeenCalledWith(
      "agent-1",
      "ground-item-1",
      `ground-item-pickup:${attemptId}`,
    );
    expect(emit).not.toHaveBeenCalledWith(
      EventType.ITEM_PICKUP,
      expect.anything(),
    );
  });

  it("propagates authoritative pickup rejection and fails closed without it", async () => {
    const requestServerPickup = vi.fn(async () => false);
    const rejected = await createInitializedService({
      networkSystem: { requestServerPickup },
    });
    rejected.entities.set("ground-item-1", {
      id: "ground-item-1",
      type: "item",
      data: { type: "item" },
    });
    await expect(
      rejected.service.executePickup("ground-item-1", attemptId),
    ).resolves.toBe(false);

    const unavailable = await createInitializedService();
    unavailable.entities.set("ground-item-1", {
      id: "ground-item-1",
      type: "item",
      data: { type: "item" },
    });
    await expect(
      unavailable.service.executePickup("ground-item-1", attemptId),
    ).resolves.toBe(false);
  });

  it("rejects a malformed autonomy identity before authoritative pickup", async () => {
    const requestServerPickup = vi.fn(async () => true);
    const { service, entities } = await createInitializedService({
      networkSystem: { requestServerPickup },
    });
    entities.set("ground-item-1", {
      id: "ground-item-1",
      type: "item",
      data: { type: "item" },
    });

    await expect(
      service.executePickup("ground-item-1", "not-an-attempt"),
    ).resolves.toBe(false);
    expect(requestServerPickup).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// Entity categorization
// ==========================================================================
describe("entity categorization logic", () => {
  function categorizeEntity(
    data: Record<string, unknown>,
  ): "player" | "mob" | "npc" | "item" | "resource" | "object" {
    if (data.type === "player") return "player";
    if (data.mobType || data.type === "mob") return "mob";
    if (data.npcType || data.type === "npc") return "npc";
    if (data.itemId || data.type === "item" || data.isItem) return "item";
    if (data.resourceType || data.type === "resource") return "resource";
    const typeStr = String(data.type || "").toLowerCase();
    if (
      typeStr === "tree" ||
      typeStr === "rock" ||
      typeStr === "ore" ||
      typeStr === "fishing_spot" ||
      typeStr === "herb_patch"
    ) {
      return "resource";
    }
    return "object";
  }

  it("categorizes trees as resource", () => {
    expect(categorizeEntity({ type: "tree" })).toBe("resource");
  });

  it("categorizes rocks as resource", () => {
    expect(categorizeEntity({ type: "rock" })).toBe("resource");
  });

  it("categorizes fishing_spot as resource", () => {
    expect(categorizeEntity({ type: "fishing_spot" })).toBe("resource");
  });

  it("categorizes by resourceType field", () => {
    expect(categorizeEntity({ resourceType: "tree", type: "resource" })).toBe(
      "resource",
    );
  });

  it("categorizes entities with type=resource", () => {
    expect(categorizeEntity({ type: "resource" })).toBe("resource");
  });

  it("categorizes mobs correctly", () => {
    expect(categorizeEntity({ type: "mob", mobType: "goblin" })).toBe("mob");
  });

  it("categorizes npcs correctly", () => {
    expect(categorizeEntity({ type: "npc", npcType: "shopkeeper" })).toBe(
      "npc",
    );
  });

  it("categorizes items correctly", () => {
    expect(categorizeEntity({ type: "item", itemId: "sword" })).toBe("item");
  });

  it("categorizes players correctly", () => {
    expect(categorizeEntity({ type: "player" })).toBe("player");
  });

  it("categorizes unknown entities as object", () => {
    expect(categorizeEntity({ type: "building" })).toBe("object");
  });

  it("categorizes herb_patch as resource", () => {
    expect(categorizeEntity({ type: "herb_patch" })).toBe("resource");
  });
});
