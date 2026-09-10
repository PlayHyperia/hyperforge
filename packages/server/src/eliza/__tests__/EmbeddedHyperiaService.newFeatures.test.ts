import { describe, expect, it, vi } from "vitest";
import {
  ITEMS,
  type StreamingDuelFoodObservationContext,
} from "@hyperforge/shared";
import { EmbeddedHyperiaService } from "../EmbeddedHyperiaService";

type TestEntity = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  config?: {
    mobType?: string;
    resourceId?: string;
    resourceType?: string;
    requiredLevel?: number;
  };
  getProperty?: (name: string) => unknown;
  getInteractionRange?: () => unknown;
  getInteractionFootprint?: () => unknown;
  position?: {
    x: number;
    y: number;
    z: number;
    set: (x: number, y: number, z: number) => void;
  };
};

function createMockWorld(options?: {
  inventorySystem?: Record<string, unknown> | null;
  equipmentSystem?: Record<string, unknown> | null;
  playerSystem?: Record<string, unknown> | null;
  networkSystem?: Record<string, unknown> | null;
  extraEntities?: Array<{
    id: string;
    data: Record<string, unknown>;
    position: [number, number, number];
    config?: {
      mobType?: string;
      resourceId?: string;
      resourceType?: string;
      requiredLevel?: number;
    };
    getProperty?: (name: string) => unknown;
    getInteractionRange?: () => unknown;
    getInteractionFootprint?: () => unknown;
  }>;
}) {
  const entities = new Map<string, TestEntity>();

  for (const ent of options?.extraEntities || []) {
    const pos = {
      x: ent.position[0],
      y: ent.position[1],
      z: ent.position[2],
      set(x: number, y: number, z: number) {
        pos.x = x;
        pos.y = y;
        pos.z = z;
      },
    };
    entities.set(ent.id, {
      id: ent.id,
      type: String(ent.data.type || "object"),
      data: { ...ent.data, position: [...ent.position] },
      position: pos,
      ...(ent.config ? { config: ent.config } : {}),
      ...(ent.getProperty ? { getProperty: ent.getProperty } : {}),
      ...(ent.getInteractionRange
        ? { getInteractionRange: ent.getInteractionRange }
        : {}),
      ...(ent.getInteractionFootprint
        ? { getInteractionFootprint: ent.getInteractionFootprint }
        : {}),
    });
  }

  const emit = vi.fn();
  const world = {
    entities: {
      items: entities,
      get: (id: string) => entities.get(id),
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
        const entity: TestEntity = {
          id,
          type: String(entityData.type ?? "object"),
          data: { ...entityData, position: [...rawPosition] },
          position,
        };
        entities.set(id, entity);
        return entity;
      },
      remove: (id: string) => entities.delete(id),
      values: () => entities.values(),
    },
    on: vi.fn(),
    off: vi.fn(),
    emit,
    getSystem: vi.fn((name: string) => {
      if (name === "inventory") return options?.inventorySystem ?? null;
      if (name === "equipment") return options?.equipmentSystem ?? null;
      if (name === "player") return options?.playerSystem ?? null;
      if (name === "network") return options?.networkSystem ?? null;
      if (name === "database") {
        return {
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
// getInventoryItems
// ==========================================================================
describe("getInventoryItems", () => {
  it("returns items from InventorySystem", async () => {
    const { service } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            {
              slot: 0,
              itemId: "bronze_sword",
              quantity: 1,
              item: {
                id: "bronze_sword",
                name: "Bronze Sword",
                type: "weapon",
              },
            },
            {
              slot: 1,
              itemId: "shrimp",
              quantity: 5,
              item: { id: "shrimp", name: "Shrimp", type: "consumable" },
            },
          ],
        }),
      },
    });

    const items = service.getInventoryItems();
    expect(items).toHaveLength(2);
    expect(items[0].itemId).toBe("bronze_sword");
    expect(items[1].itemId).toBe("shrimp");
    expect(items[1].quantity).toBe(5);
  });

  it("returns empty array when inventory system unavailable", async () => {
    const { service } = await createInitializedService({
      inventorySystem: null,
    });

    expect(service.getInventoryItems()).toEqual([]);
  });

  it("returns empty array when player has no inventory", async () => {
    const { service } = await createInitializedService({
      inventorySystem: { getInventory: () => undefined },
    });

    expect(service.getInventoryItems()).toEqual([]);
  });

  it("returns empty when service is stopped", async () => {
    const { service } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            {
              slot: 0,
              itemId: "sword",
              quantity: 1,
              item: { id: "sword", name: "Sword", type: "weapon" },
            },
          ],
        }),
      },
    });
    await service.stop();
    expect(service.getInventoryItems()).toEqual([]);
  });
});

describe("resource movement", () => {
  it("routes authored resources to a legal interaction boundary", async () => {
    const requestServerMove = vi.fn(() => true);
    const target: [number, number, number] = [-9.5, 10, -12.5];
    const { service } = await createInitializedService({
      networkSystem: { requestServerMove },
      extraEntities: [
        {
          id: "fishing-spot-runtime",
          data: {
            type: "resource",
            resourceId: "fishing_spot_net",
            resourceType: "fishing_spot",
          },
          config: {
            resourceId: "fishing_spot_net",
            resourceType: "fishing_spot",
            requiredLevel: 1,
          },
          position: target,
          getInteractionRange: () => 2,
          getInteractionFootprint: () => ({ width: 1, depth: 1 }),
        },
      ],
    });

    await expect(service.executeMove(target, true)).resolves.toBe(true);
    expect(requestServerMove).toHaveBeenCalledWith("agent-1", target, {
      runMode: true,
      interactionArrival: {
        interactionRange: 2,
        footprintWidth: 1,
        footprintDepth: 1,
      },
    });
  });
});

// ==========================================================================
// getEquippedItems
// ==========================================================================
describe("getEquippedItems", () => {
  it("returns equipped items from EquipmentSystem", async () => {
    const { service } = await createInitializedService({
      equipmentSystem: {
        getPlayerEquipment: () => ({
          weapon: { itemId: "bronze_sword" },
          shield: { itemId: null },
          helmet: { itemId: "bronze_helm" },
          body: { itemId: null },
          legs: { itemId: null },
          boots: { itemId: null },
          gloves: { itemId: null },
          cape: { itemId: null },
          amulet: { itemId: null },
          ring: { itemId: null },
          arrows: { itemId: null },
        }),
      },
    });

    const equipped = service.getEquippedItems();
    expect(equipped.weapon).toBe("bronze_sword");
    expect(equipped.helmet).toBe("bronze_helm");
    expect(equipped.shield).toBeNull();
    expect(equipped.body).toBeNull();
  });

  it("returns empty when equipment system unavailable", async () => {
    const { service } = await createInitializedService({
      equipmentSystem: null,
    });

    expect(service.getEquippedItems()).toEqual({});
  });

  it("returns empty when player has no equipment", async () => {
    const { service } = await createInitializedService({
      equipmentSystem: { getPlayerEquipment: () => undefined },
    });

    expect(service.getEquippedItems()).toEqual({});
  });
});

describe("getNearbyEntities combat equipment", () => {
  it("exposes the live weapon from the player entity Item shape", async () => {
    const { service, entities } = await createInitializedService({
      equipmentSystem: {
        getPlayerEquipment: (playerId: string) =>
          playerId === "opponent-1"
            ? { weapon: { itemId: "staff_of_air" } }
            : {},
      },
      extraEntities: [
        {
          id: "opponent-1",
          data: {
            type: "player",
            name: "Opponent",
            health: 10,
            maxHealth: 10,
            equipment: {
              weapon: { id: "shortbow", name: "Shortbow", type: "weapon" },
            },
          },
          position: [2, 10, 0],
        },
      ],
    });
    const self = entities.get("agent-1");
    if (!self?.position) throw new Error("initialized agent missing");
    self.position.x = 0;
    self.position.y = 10;
    self.position.z = 0;
    self.data.position = [0, 10, 0];
    service.invalidateNearbyEntityCache();

    expect(
      service.getNearbyEntities().find((entity) => entity.id === "opponent-1")
        ?.equippedWeapon,
    ).toBe("staff_of_air");
  });

  it("exposes exact runtime mob identity without a display-name fallback", async () => {
    const { service, entities } = await createInitializedService({
      extraEntities: [
        {
          id: "runtime-goblin",
          data: { type: "mob", name: "Misleading Cow", health: 5 },
          config: { mobType: "goblin" },
          position: [2, 10, 0],
        },
        {
          id: "name-only-goblin",
          data: { type: "mob", name: "Goblin", health: 5 },
          position: [3, 10, 0],
        },
      ],
    });
    const self = entities.get("agent-1");
    if (!self?.position) throw new Error("initialized agent missing");
    self.position.x = 0;
    self.position.y = 10;
    self.position.z = 0;
    self.data.position = [0, 10, 0];
    service.invalidateNearbyEntityCache();

    const nearby = service.getNearbyEntities();
    expect(
      nearby.find((entity) => entity.id === "runtime-goblin")?.mobType,
    ).toBe("goblin");
    expect(
      nearby.find((entity) => entity.id === "name-only-goblin")?.mobType,
    ).toBeUndefined();
  });

  it("exposes the authored resource identity from runtime entity config", async () => {
    const { service, entities } = await createInitializedService({
      extraEntities: [
        {
          id: "ore-copper-runtime",
          data: { type: "resource", name: "Copper Rock", health: 100 },
          config: {
            resourceId: "ore_copper",
            resourceType: "mining_rock",
            requiredLevel: 1,
          },
          position: [2, 10, 0],
        },
      ],
    });
    const self = entities.get("agent-1");
    if (!self?.position) throw new Error("initialized agent missing");
    self.position.x = 0;
    self.position.y = 10;
    self.position.z = 0;
    self.data.position = [0, 10, 0];
    service.invalidateNearbyEntityCache();

    expect(
      service
        .getNearbyEntities()
        .find((entity) => entity.id === "ore-copper-runtime"),
    ).toMatchObject({
      type: "resource",
      resourceId: "ore_copper",
      resourceType: "mining_rock",
      requiredLevel: 1,
    });

    const resource = entities.get("ore-copper-runtime");
    if (!resource?.position) throw new Error("runtime resource missing");
    resource.position.x = 12;
    resource.data.position = [12, 10, 0];
    service.invalidateNearbyEntityCache();

    expect(
      service
        .getNearbyEntities()
        .find((entity) => entity.id === "ore-copper-runtime")?.distance,
    ).toBe(12);
  });
});

// categorizeEntity is tested indirectly via getNearbyEntities in the
// EmbeddedHyperiaService.questMethods.test.ts and through integration.
// The categorization fix (tree/rock/fishing_spot → "resource") is verified
// by the resource keyword mapping tests in AgentManager.behavior.test.ts.

// ==========================================================================
// executeUse - fixed to use getInventoryItems
// ==========================================================================
describe("executeUse", () => {
  it("awaits and returns the authoritative food receipt", async () => {
    const consumeFoodAtomic = vi.fn(
      async (
        playerId: string,
        itemId: string,
        slot: number,
        operationId: string,
        _publicActionObservation?: StreamingDuelFoodObservationContext,
      ) => ({
        ok: true,
        committed: true,
        consumed: true,
        playerId,
        itemId,
        operationId,
        replayed: false,
        healedAmount: 3,
        newHealth: 10,
      }),
    );
    const { service, emit } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({
          items: [
            {
              slot: 3,
              itemId: "shrimp",
              quantity: 1,
              item: { id: "shrimp", name: "Shrimp", type: "consumable" },
            },
          ],
        }),
      },
      playerSystem: { consumeFoodAtomic },
    });

    const publicActionObservation = {
      operationId: "00000000-0000-4000-8000-000000000301",
      tick: 3,
      observedAt: 1_800_000_000_003,
      cycleId: "cycle-embedded-food",
      duelId: "duel-embedded-food",
      actorId: "agent-1",
      opponentId: "agent-2",
      phase: "FIGHTING",
      combatRole: "ranged",
      tacticalMacro: "kite",
    } satisfies StreamingDuelFoodObservationContext;
    const receipt = await service.executeUse("shrimp", publicActionObservation);

    expect(receipt).toMatchObject({
      ok: true,
      committed: true,
      consumed: true,
      itemId: "shrimp",
      healedAmount: 3,
    });
    expect(consumeFoodAtomic).toHaveBeenCalledWith(
      "agent-1",
      "shrimp",
      3,
      expect.stringMatching(/^food-debit:[0-9a-f-]{36}$/),
      publicActionObservation,
    );
    expect(emit).not.toHaveBeenCalledWith("inventory:use", expect.anything());
  });

  it("returns a rejection when the item is not in inventory", async () => {
    const { service, emit } = await createInitializedService({
      inventorySystem: {
        getInventory: () => ({ items: [] }),
      },
    });

    const receipt = await service.executeUse("nonexistent_item");

    expect(receipt).toMatchObject({
      ok: false,
      committed: false,
      consumed: false,
      reason: "item_not_owned",
    });
    expect(emit).not.toHaveBeenCalledWith("inventory:use", expect.anything());
  });
});

describe("executeBury", () => {
  it("passes an exact attempt-bound identity through without requiring stale live inventory", async () => {
    const itemId = "embedded_atomic_prayer_bones";
    const prior = ITEMS.get(itemId);
    ITEMS.set(itemId, {
      id: itemId,
      name: "Embedded Prayer Bones",
      type: "resource",
      prayerXp: 15,
      buryLevelRequired: 1,
    } as never);
    try {
      const buryBoneAtomic = vi.fn(
        async (
          playerId: string,
          requestedItemId: string,
          operationId: string,
        ) => ({
          ok: true,
          committed: true,
          liveStateApplied: true,
          playerId,
          itemId: requestedItemId,
          operationId,
          replayed: true,
          awardedXp: 15,
          currentXp: 15,
          currentLevel: 1,
          retryable: false,
        }),
      );
      const { service } = await createInitializedService({
        inventorySystem: { getInventory: () => ({ items: [] }) },
        playerSystem: { buryBoneAtomic },
      });
      const operationId = "92da6285-2348-5bab-8dad-57bc151ef355";

      await expect(
        service.executeBury(itemId, operationId),
      ).resolves.toMatchObject({
        ok: true,
        committed: true,
        replayed: true,
      });
      expect(buryBoneAtomic).toHaveBeenCalledWith(
        "agent-1",
        itemId,
        operationId,
      );
    } finally {
      if (prior) ITEMS.set(itemId, prior);
      else ITEMS.delete(itemId);
    }
  });
});
