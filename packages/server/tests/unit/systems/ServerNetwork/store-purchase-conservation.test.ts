import { EventType, ITEMS } from "@hyperforge/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  handleStoreBuy,
  handleStoreSell,
} from "../../../../src/systems/ServerNetwork/handlers/store";

const transaction = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/database/postgres-transaction", () => ({
  runInPostgresTransaction: transaction,
}));

const previousSword = ITEMS.get("bronze_shortsword");
const previousLogs = ITEMS.get("logs");
beforeAll(() => {
  ITEMS.set("bronze_shortsword", {
    id: "bronze_shortsword",
    name: "Bronze Shortsword",
    type: "weapon",
    stackable: false,
  } as never);
  ITEMS.set("logs", {
    id: "logs",
    name: "Logs",
    type: "resource",
    value: 10,
    stackable: false,
  } as never);
});
afterAll(() => {
  if (previousSword) ITEMS.set("bronze_shortsword", previousSword);
  else ITEMS.delete("bronze_shortsword");
  if (previousLogs) ITEMS.set("logs", previousLogs);
  else ITEMS.delete("logs");
});

describe("secure store transaction conservation", () => {
  beforeEach(() => {
    transaction.mockReset();
  });

  it("deducts coins and inserts the owned item through one locked transaction", async () => {
    const playerId = "conservation-player";
    const packets: Array<{ packet: string; payload: unknown }> = [];
    const insertedValues: unknown[] = [];
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ coins: 100 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const tx = {
      execute,
      insert: vi.fn(() => ({
        values: vi.fn(async (values: unknown) => {
          insertedValues.push(values);
        }),
      })),
    };
    transaction.mockImplementationOnce(async (_pool, operation) =>
      operation(tx),
    );
    const select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: async () => [
            {
              id: 1,
              playerId,
              itemId: "bronze_shortsword",
              quantity: 1,
              slotIndex: 0,
              metadata: null,
            },
          ],
        }),
      }),
    }));
    const queueOperation = vi.fn(async (_id, operation) => operation());
    const inventorySystem = {
      queueOperation,
      lockForTransaction: vi.fn(() => true),
      unlockTransaction: vi.fn(),
      persistInventoryImmediate: vi.fn(async () => {}),
      reloadFromDatabase: vi.fn(async () => {}),
    };
    const storeSystem = {
      getStore: vi.fn(() => ({
        id: "sword_store",
        name: "Sword Store",
        items: [
          {
            id: "bronze_shortsword",
            itemId: "bronze_shortsword",
            price: 10,
            stockQuantity: -1,
          },
        ],
        buyback: true,
        buybackRate: 0.5,
      })),
    };
    const target = {
      id: "sword-store-npc",
      position: { x: 5, y: 0, z: 5 },
    };
    const world = {
      entities: new Map([[target.id, target]]),
      interactionSessionManager: {
        getSession: () => ({
          playerId,
          sessionType: "store",
          targetEntityId: target.id,
          targetStoreId: "sword_store",
          openedAtTick: 0,
        }),
      },
      drizzleDb: { select },
      pgPool: {},
      getSystem: vi.fn((systemName: string) => {
        if (systemName === "duel") return undefined;
        if (systemName === "store") return storeSystem;
        if (systemName === "inventory") return inventorySystem;
        return undefined;
      }),
      emit: vi.fn(),
    };
    const socket = {
      id: "conservation-socket",
      player: {
        id: playerId,
        position: { x: 5, y: 0, z: 5 },
      },
      send: vi.fn((packet: string, payload: unknown) => {
        packets.push({ packet, payload });
      }),
    };

    await handleStoreBuy(
      socket as never,
      {
        storeId: "sword_store",
        itemId: "bronze_shortsword",
        quantity: 1,
      },
      world as never,
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queueOperation).toHaveBeenCalledWith(playerId, expect.any(Function));
    expect(inventorySystem.lockForTransaction).toHaveBeenCalledWith(playerId);
    expect(inventorySystem.persistInventoryImmediate).toHaveBeenCalledWith(
      playerId,
    );
    expect(execute).toHaveBeenCalledTimes(3);
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        playerId,
        itemId: "bronze_shortsword",
        quantity: 1,
        slotIndex: 0,
      }),
    );
    expect(inventorySystem.reloadFromDatabase).toHaveBeenCalledWith(playerId);
    expect(inventorySystem.unlockTransaction).toHaveBeenCalledWith(playerId);
    expect(packets).toContainEqual({
      packet: "inventoryUpdated",
      payload: {
        playerId,
        items: [{ slot: 0, itemId: "bronze_shortsword", quantity: 1 }],
        coins: 90,
      },
    });
    expect(world.emit).toHaveBeenCalledWith(EventType.INVENTORY_UPDATE_COINS, {
      playerId,
      coins: 90,
    });
  });

  it("removes exact owned quantity and credits buyback coins through one locked transaction", async () => {
    const playerId = "sale-conservation-player";
    const packets: Array<{ packet: string; payload: unknown }> = [];
    const deletedIds: number[] = [];
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            playerId,
            itemId: "logs",
            quantity: 2,
            slotIndex: 0,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ coins: 100 }] })
      .mockResolvedValueOnce({ rows: [] });
    const tx = {
      execute,
      delete: vi.fn(() => ({
        where: vi.fn(async (condition: { queryChunks?: unknown[] }) => {
          void condition;
          deletedIds.push(7);
        }),
      })),
      update: vi.fn(),
    };
    transaction.mockImplementationOnce(async (_pool, operation) =>
      operation(tx),
    );
    const select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: async () => [],
        }),
      }),
    }));
    const queueOperation = vi.fn(async (_id, operation) => operation());
    const inventorySystem = {
      queueOperation,
      lockForTransaction: vi.fn(() => true),
      unlockTransaction: vi.fn(),
      persistInventoryImmediate: vi.fn(async () => {}),
      reloadFromDatabase: vi.fn(async () => {}),
    };
    const storeSystem = {
      getStore: vi.fn(() => ({
        id: "general_store",
        name: "General Store",
        items: [],
        buyback: true,
        buybackRate: 0.5,
      })),
    };
    const target = {
      id: "general-store-npc",
      position: { x: 5, y: 0, z: 5 },
    };
    const world = {
      entities: new Map([[target.id, target]]),
      interactionSessionManager: {
        getSession: () => ({
          playerId,
          sessionType: "store",
          targetEntityId: target.id,
          targetStoreId: "general_store",
          openedAtTick: 0,
        }),
      },
      drizzleDb: { select },
      pgPool: {},
      getSystem: vi.fn((systemName: string) => {
        if (systemName === "duel") return undefined;
        if (systemName === "store") return storeSystem;
        if (systemName === "inventory") return inventorySystem;
        return undefined;
      }),
      emit: vi.fn(),
    };
    const socket = {
      id: "sale-conservation-socket",
      player: {
        id: playerId,
        position: { x: 5, y: 0, z: 5 },
      },
      send: vi.fn((packet: string, payload: unknown) => {
        packets.push({ packet, payload });
      }),
    };

    await handleStoreSell(
      socket as never,
      { storeId: "general_store", itemId: "logs", quantity: 2 },
      world as never,
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queueOperation).toHaveBeenCalledWith(playerId, expect.any(Function));
    expect(inventorySystem.lockForTransaction).toHaveBeenCalledWith(playerId);
    expect(inventorySystem.persistInventoryImmediate).toHaveBeenCalledWith(
      playerId,
    );
    expect(execute).toHaveBeenCalledTimes(3);
    expect(deletedIds).toEqual([7]);
    expect(inventorySystem.reloadFromDatabase).toHaveBeenCalledWith(playerId);
    expect(inventorySystem.unlockTransaction).toHaveBeenCalledWith(playerId);
    expect(packets).toContainEqual({
      packet: "inventoryUpdated",
      payload: { playerId, items: [], coins: 110 },
    });
    expect(world.emit).toHaveBeenCalledWith(EventType.INVENTORY_UPDATE_COINS, {
      playerId,
      coins: 110,
    });
  });
});
