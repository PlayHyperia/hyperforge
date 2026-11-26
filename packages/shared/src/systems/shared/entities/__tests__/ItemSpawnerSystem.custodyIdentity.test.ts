import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types/core/core";
import { EventBus } from "../../infrastructure/EventBus";
import { ItemSpawnerSystem } from "../ItemSpawnerSystem";

const ITEM_ID = "spawner_custody_identity_test_item";

describe("ItemSpawnerSystem custody identity", () => {
  beforeEach(() => {
    ITEMS.set(ITEM_ID, {
      id: ITEM_ID,
      name: "Spawner custody identity test item",
      description: "test",
      type: "resource",
      stackable: false,
      tradeable: true,
    } as Item);
  });

  afterEach(() => {
    ITEMS.delete(ITEM_ID);
  });

  function createFixture() {
    const spawnedConfigs: Array<Record<string, unknown>> = [];
    const entityManager = {
      spawnEntity: vi.fn(async (config: Record<string, unknown>) => {
        spawnedConfigs.push(config);
        return { id: String(config.id) };
      }),
    };
    let nextSource = 0;
    const groundItems = {
      spawnGroundItem: vi.fn(async () => `ground_item_durable_${++nextSource}`),
      spawnGroundItems: vi.fn(async () => ["ground_item_durable_batch"]),
    };
    const world = {
      $eventBus: new EventBus(),
      isServer: true,
      entities: new Map(),
      getSystem: (name: string) => {
        if (name === "entity-manager") return entityManager;
        if (name === "ground-items") return groundItems;
        if (name === "terrain") return { getHeightAt: () => 0 };
        return undefined;
      },
    };
    const system = new ItemSpawnerSystem(world as never);
    return { system, spawnedConfigs, entityManager, groundItems };
  }

  it("routes every claimable occurrence through durable ground custody", async () => {
    const fixture = createFixture();
    await fixture.system.init();

    const first = await fixture.system.spawnItem(
      ITEM_ID,
      { x: 5_000, y: 0, z: 5_000 },
      0,
      2,
    );
    const second = await fixture.system.spawnItem(
      ITEM_ID,
      { x: 5_000, y: 0, z: 5_000 },
      0,
      1,
    );

    expect(first).toBe("ground_item_durable_1");
    expect(second).toBe("ground_item_durable_2");
    expect(fixture.groundItems.spawnGroundItem).toHaveBeenNthCalledWith(
      1,
      ITEM_ID,
      2,
      { x: 5_000, y: 0, z: 5_000 },
      expect.objectContaining({ despawnTime: expect.any(Number) }),
    );
    expect(fixture.entityManager.spawnEntity).not.toHaveBeenCalled();
  });

  it("keeps store merchandise display-only without a fake custody identity", async () => {
    const fixture = createFixture();
    await fixture.system.init();
    const item = ITEMS.get(ITEM_ID)!;
    await (
      fixture.system as unknown as {
        spawnDisplayItemFromData: (
          itemData: Item,
          position: { x: number; y: number; z: number },
          spawnType: string,
          location: string,
          index: number,
        ) => Promise<string>;
      }
    ).spawnDisplayItemFromData(
      item,
      { x: 5_000, y: 0, z: 5_000 },
      "shop",
      "Test Store",
      0,
    );
    const config = fixture.spawnedConfigs[0]!;
    const properties = config.properties as Record<string, unknown>;

    expect(config).toMatchObject({
      interactable: false,
      interactionType: null,
    });
    expect(properties).toMatchObject({ custodyPolicy: "display_only" });
    expect(properties).not.toHaveProperty("custodySourceId");
    expect(fixture.groundItems.spawnGroundItem).not.toHaveBeenCalled();
  });

  it("routes legacy loot events through one durable batch boundary", async () => {
    const fixture = createFixture();
    await fixture.system.init();

    await (
      fixture.system as unknown as {
        spawnLootItems: (data: {
          position: { x: number; y: number; z: number };
          lootTable: string[];
        }) => Promise<void>;
      }
    ).spawnLootItems({
      position: { x: 5_000, y: 0, z: 5_000 },
      lootTable: [ITEM_ID, "unknown-item"],
    });

    expect(fixture.groundItems.spawnGroundItems).toHaveBeenCalledWith(
      [expect.objectContaining({ itemId: ITEM_ID, quantity: 1 })],
      { x: 5_000, y: 0, z: 5_000 },
      expect.objectContaining({ scatter: false }),
      true,
    );
    expect(fixture.entityManager.spawnEntity).not.toHaveBeenCalled();
  });

  it("rejects empty single and batch custody receipts", async () => {
    const fixture = createFixture();
    await fixture.system.init();
    fixture.groundItems.spawnGroundItem.mockResolvedValueOnce("");
    fixture.groundItems.spawnGroundItems.mockResolvedValueOnce([]);

    await expect(
      fixture.system.spawnItem(ITEM_ID, { x: 5_000, y: 0, z: 5_000 }, 0, 1),
    ).rejects.toThrow("item_spawner_ground_custody_rejected");
    await expect(
      (
        fixture.system as unknown as {
          spawnLootItems: (data: {
            position: { x: number; y: number; z: number };
            lootTable: string[];
          }) => Promise<void>;
        }
      ).spawnLootItems({
        position: { x: 5_000, y: 0, z: 5_000 },
        lootTable: [ITEM_ID],
      }),
    ).rejects.toThrow("item_spawner_ground_custody_batch_incomplete");
  });
});
