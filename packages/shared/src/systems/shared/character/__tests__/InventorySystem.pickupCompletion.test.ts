import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../../infrastructure/EventBus";
import { InventorySystem } from "../InventorySystem";

const PLAYER_ID = "pickup-completion-agent";
const ENTITY_ID = "ground-air-rune";

function createFixture(
  savePlayerInventoryAsync: () => Promise<void>,
  removeGroundItem: () => boolean = () => true,
  commitGroundItemPickupOperationAsync?: (
    request: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>,
  custodySourceId?: string,
  custodyPolicy: string | null = "durable_ground",
) {
  const itemEntity = {
    getProperty: (key: string) => {
      if (key === "itemId") return "air_rune";
      if (key === "quantity") return 2;
      if (key === "custodySourceId") return custodySourceId;
      if (key === "custodyPolicy") return custodyPolicy;
      return undefined;
    },
  };
  const database = {
    savePlayerInventoryAsync: vi.fn(savePlayerInventoryAsync),
    ...(commitGroundItemPickupOperationAsync
      ? {
          commitGroundItemPickupOperationAsync: vi.fn(
            commitGroundItemPickupOperationAsync,
          ),
        }
      : {}),
  };
  const entityManager = { getEntity: vi.fn(() => itemEntity) };
  const groundItems = {
    tryAcquirePickupLock: vi.fn(() => true),
    releasePickupLock: vi.fn(),
    removeGroundItem: vi.fn(removeGroundItem),
  };
  const player = { data: {}, position: { x: 0, y: 0, z: 0 } };
  const entities = new Map<string, unknown>([[PLAYER_ID, player]]);
  const world = {
    $eventBus: new EventBus(),
    isServer: true,
    currentTick: 10,
    entities,
    getPlayer: (id: string) => entities.get(id),
    getSystem: (name: string) => {
      if (name === "database") return database;
      if (name === "entity-manager") return entityManager;
      if (name === "ground-items") return groundItems;
      return undefined;
    },
  };
  const inventory = new InventorySystem(world as never);
  (
    inventory as unknown as {
      initializeInventory(data: { id: string }): void;
    }
  ).initializeInventory({ id: PLAYER_ID });
  return { inventory, database, groundItems };
}

describe("InventorySystem ground-item completion", () => {
  const operationId = "ground-item-pickup:11111111-1111-4111-8111-111111111111";
  const committedReceipt = (request: Record<string, unknown>) => ({
    ...request,
    replayed: false,
    stackable: true,
    operationCommittedCoins: null,
    currentCoins: 100,
    committed: [
      { itemId: "air_rune", quantity: 2, slotIndex: 0, metadata: null },
    ],
  });

  it("does not remove source custody before destination persistence completes", async () => {
    let releasePersistence: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const fixture = createFixture(async () => persistence);

    const pending = fixture.inventory.pickupGroundItem({
      playerId: PLAYER_ID,
      entityId: ENTITY_ID,
    });

    await vi.waitFor(() => {
      expect(fixture.database.savePlayerInventoryAsync).toHaveBeenCalledOnce();
    });
    expect(fixture.groundItems.removeGroundItem).not.toHaveBeenCalled();

    releasePersistence?.();
    await expect(pending).resolves.toBe(true);
    expect(fixture.groundItems.removeGroundItem).toHaveBeenCalledWith(
      ENTITY_ID,
    );
    expect(fixture.groundItems.releasePickupLock).toHaveBeenCalledWith(
      ENTITY_ID,
      PLAYER_ID,
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([
      expect.objectContaining({ itemId: "air_rune", quantity: 2 }),
    ]);
  });

  it("keeps the source and restores live destination state on persistence failure", async () => {
    const fixture = createFixture(async () => {
      throw new Error("database unavailable");
    });

    await expect(
      fixture.inventory.pickupGroundItem({
        playerId: PLAYER_ID,
        entityId: ENTITY_ID,
      }),
    ).rejects.toThrow("database unavailable");
    expect(fixture.groundItems.removeGroundItem).not.toHaveBeenCalled();
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([]);
  });

  it("persists rollback when authoritative source removal is rejected", async () => {
    const fixture = createFixture(
      async () => {},
      () => false,
    );

    await expect(
      fixture.inventory.pickupGroundItem({
        playerId: PLAYER_ID,
        entityId: ENTITY_ID,
      }),
    ).resolves.toBe(false);
    expect(fixture.database.savePlayerInventoryAsync).toHaveBeenCalledTimes(2);
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([]);
  });

  it("binds autonomous pickup to one atomic receipt before source cleanup", async () => {
    let releaseCommit: (() => void) | undefined;
    const heldCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const fixture = createFixture(
      async () => {},
      () => true,
      async (request) => {
        await heldCommit;
        return committedReceipt(request);
      },
    );

    const pending = fixture.inventory.pickupGroundItem({
      playerId: PLAYER_ID,
      entityId: ENTITY_ID,
      operationId,
    });
    await vi.waitFor(() => {
      expect(
        fixture.database.commitGroundItemPickupOperationAsync,
      ).toHaveBeenCalledOnce();
    });
    expect(fixture.database.savePlayerInventoryAsync).not.toHaveBeenCalled();
    expect(fixture.groundItems.removeGroundItem).not.toHaveBeenCalled();

    releaseCommit?.();
    await expect(pending).resolves.toBe(true);
    expect(fixture.groundItems.removeGroundItem).toHaveBeenCalledWith(
      ENTITY_ID,
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([
      expect.objectContaining({ itemId: "air_rune", quantity: 2, slot: 0 }),
    ]);
  });

  it("retries an ambiguous commit with the exact same request identity", async () => {
    const requests: Record<string, unknown>[] = [];
    const fixture = createFixture(
      async () => {},
      () => true,
      async (request) => {
        requests.push(request);
        if (requests.length === 1) throw new Error("connection reset");
        return { ...committedReceipt(request), replayed: true };
      },
    );

    await expect(
      fixture.inventory.pickupGroundItem({
        playerId: PLAYER_ID,
        entityId: ENTITY_ID,
        operationId,
      }),
    ).resolves.toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(fixture.groundItems.removeGroundItem).toHaveBeenCalledOnce();
  });

  it("removes a stale source presentation after another authority claimed it", async () => {
    const fixture = createFixture(
      async () => {},
      () => true,
      async () => {
        throw new Error("ground_item_pickup_source_claimed");
      },
    );

    await expect(
      fixture.inventory.pickupGroundItem({
        playerId: PLAYER_ID,
        entityId: ENTITY_ID,
        operationId,
      }),
    ).resolves.toBe(false);
    expect(
      fixture.database.commitGroundItemPickupOperationAsync,
    ).toHaveBeenCalledOnce();
    expect(fixture.groundItems.removeGroundItem).toHaveBeenCalledWith(
      ENTITY_ID,
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([]);
  });

  it("preserves committed truth when only source presentation cleanup fails", async () => {
    const fixture = createFixture(
      async () => {},
      () => false,
      async (request) => committedReceipt(request),
    );

    await expect(
      fixture.inventory.pickupGroundItem({
        playerId: PLAYER_ID,
        entityId: ENTITY_ID,
        operationId,
      }),
    ).resolves.toBe(true);
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([
      expect.objectContaining({ itemId: "air_rune", quantity: 2 }),
    ]);
  });

  it("replays an exact receipt even when current capacity would reject a new pickup", async () => {
    const fixture = createFixture(
      async () => {},
      () => true,
      async (request) => ({ ...committedReceipt(request), replayed: true }),
    );
    vi.spyOn(fixture.inventory, "canAddItem").mockReturnValue(false);

    await expect(
      fixture.inventory.pickupGroundItem({
        playerId: PLAYER_ID,
        entityId: ENTITY_ID,
        operationId,
      }),
    ).resolves.toBe(true);
    expect(
      fixture.database.commitGroundItemPickupOperationAsync,
    ).toHaveBeenCalledOnce();
  });

  it("claims the immutable source occurrence instead of a reusable presentation ID", async () => {
    const custodySourceId = "ground_item_22222222-2222-4222-8222-222222222222";
    const requests: Record<string, unknown>[] = [];
    const fixture = createFixture(
      async () => {},
      () => true,
      async (request) => {
        requests.push(request);
        return committedReceipt(request);
      },
      custodySourceId,
    );

    await expect(
      fixture.inventory.pickupGroundItem({
        playerId: PLAYER_ID,
        entityId: ENTITY_ID,
        operationId,
      }),
    ).resolves.toBe(true);
    expect(requests[0]?.sourceEntityId).toBe(custodySourceId);
    expect(fixture.groundItems.removeGroundItem).toHaveBeenCalledWith(
      ENTITY_ID,
    );
  });

  it.each(["display_only", "diagnostic_only", "unknown", null])(
    "rejects non-durable custody policy %s before any pickup authority is consulted",
    async (custodyPolicy) => {
      const fixture = createFixture(
        async () => {},
        () => true,
        async (request) => committedReceipt(request),
        undefined,
        custodyPolicy,
      );

      await expect(
        fixture.inventory.pickupGroundItem({
          playerId: PLAYER_ID,
          entityId: ENTITY_ID,
          operationId,
        }),
      ).resolves.toBe(false);
      expect(
        fixture.database.commitGroundItemPickupOperationAsync,
      ).not.toHaveBeenCalled();
      expect(fixture.groundItems.tryAcquirePickupLock).not.toHaveBeenCalled();
      expect(fixture.groundItems.removeGroundItem).not.toHaveBeenCalled();
    },
  );
});
