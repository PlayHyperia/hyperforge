import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ITEMS } from "@hyperforge/shared";

import * as schema from "../../../database/schema.js";
import type {
  GroundItemPickupCommitRequest,
  InventorySaveItem,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const PLAYER_ID = "pickup-custody-agent";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = `ground-item-pickup:${ATTEMPT_ID}`;
const SOURCE_ID = "ground_item_22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  ITEMS.set("air_rune", {
    id: "air_rune",
    name: "Air rune",
    type: "resource",
    stackable: true,
  } as never);
  ITEMS.set("coins", {
    id: "coins",
    name: "Coins",
    type: "currency",
    stackable: true,
  } as never);
});

afterAll(() => {
  ITEMS.delete("air_rune");
  ITEMS.delete("coins");
});

function fingerprint(
  sourceEntityId = SOURCE_ID,
  itemId = "air_rune",
  quantity = 2,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId: PLAYER_ID,
        sourceEntityId,
        itemId,
        quantity,
      }),
      "utf8",
    )
    .digest("hex");
}

function request(
  overrides: Partial<GroundItemPickupCommitRequest> = {},
): GroundItemPickupCommitRequest {
  const sourceEntityId = overrides.sourceEntityId ?? SOURCE_ID;
  const itemId = overrides.itemId ?? "air_rune";
  const quantity = overrides.quantity ?? 2;
  return {
    operationId: OPERATION_ID,
    playerId: PLAYER_ID,
    requestFingerprint: fingerprint(sourceEntityId, itemId, quantity),
    sourceEntityId,
    itemId,
    quantity,
    ...overrides,
  };
}

type StoredReceipt = {
  playerId: string;
  operationType: string;
  operationState: Record<string, unknown>;
  completed: boolean;
};

function createFixture(
  options: {
    inventory?: InventorySaveItem[];
    coins?: number;
    existing?: StoredReceipt;
    sourceClaimed?: boolean;
    sourceItemId?: string;
    sourceQuantity?: number;
    sourceStackable?: boolean;
    sourceMissing?: boolean;
    sourceStatus?: "active" | "claimed" | "expired";
  } = {},
) {
  const inventory = options.inventory ?? [];
  const insertedInventory: unknown[] = [];
  const insertedOperations: unknown[] = [];
  const characterUpdates: unknown[] = [];
  const sourceUpdates: unknown[] = [];
  let executeCount = 0;

  const directRows = (rows: unknown[]) => ({
    from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
  });
  const limitedRows = (rows: unknown[]) => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
    })),
  });
  const tx = {
    execute: vi.fn(async () => {
      executeCount++;
      if (executeCount === 3) {
        return { rows: [{ databaseNow: 1_788_084_000_000 }] };
      }
      if (executeCount === 4) {
        if (options.sourceMissing) return { rows: [] };
        return {
          rows: [
            {
              source_id: SOURCE_ID,
              status: options.sourceStatus ?? "active",
              item_id: options.sourceItemId ?? "air_rune",
              quantity: options.sourceQuantity ?? 2,
              stackable: options.sourceStackable ?? true,
              position_x: 1.5,
              position_y: 0.2,
              position_z: 1.5,
              tile_x: 1,
              tile_z: 1,
              dropped_by: null,
              created_at: 1_788_083_900_000,
              updated_at: 1_788_083_900_000,
              expires_at: 1_788_084_100_000,
              loot_protection_expires_at: null,
              claimed_by_operation_id: null,
              claimed_by_player_id: null,
              claimed_at: null,
              version: 1,
            },
          ],
        };
      }
      return { rows: [] };
    }),
    select: vi.fn((projection: Record<string, unknown>) => {
      const keys = Object.keys(projection);
      if (keys.includes("coins")) {
        return directRows([{ id: PLAYER_ID, coins: options.coins ?? 100 }]);
      }
      if (keys.includes("operationType")) {
        return directRows(options.existing ? [options.existing] : []);
      }
      if (keys.length === 1 && keys[0] === "id") {
        return limitedRows(options.sourceClaimed ? [{ id: "other" }] : []);
      }
      if (keys.includes("slotIndex")) {
        return directRows(
          inventory.map((item) => ({
            ...item,
            quantity: item.quantity,
            slotIndex: item.slotIndex,
            metadata: item.metadata ? JSON.stringify(item.metadata) : null,
          })),
        );
      }
      throw new Error(`unexpected select projection: ${keys.join(",")}`);
    }),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        if (table === schema.inventory) insertedInventory.push(values);
        if (table === schema.operationsLog) insertedOperations.push(values);
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => ({
        where: vi.fn(async () => {
          if (table === schema.characters) characterUpdates.push(value);
          if (table === schema.groundItemSources) sourceUpdates.push(value);
        }),
      })),
    })),
  };
  const system = new DatabaseSystem({} as never);
  const internals = system as unknown as {
    db: object;
    isDestroying: boolean;
    executeInTransaction: <T>(
      callback: (transaction: typeof tx) => Promise<T>,
      options: unknown,
    ) => Promise<T>;
  };
  internals.db = {};
  internals.isDestroying = false;
  internals.executeInTransaction = vi.fn(async (callback) => callback(tx));
  return {
    system,
    tx,
    insertedInventory,
    insertedOperations,
    characterUpdates,
    sourceUpdates,
  };
}

describe("DatabaseSystem ground-item pickup custody", () => {
  it("ships a database-enforced unique source-claim fence", () => {
    const migration = readFileSync(
      new URL(
        "../../../database/migrations/0096_add_ground_item_pickup_source_claim.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uidx_operations_log_ground_item_pickup_source"',
    );
    expect(migration).toContain("\"operationState\"->>'sourceEntityId'");
    expect(migration).toContain(
      'WHERE "operationType" = \'ground_item_pickup\' AND "completed" = true',
    );
  });

  it("credits inventory and writes the immutable source claim together", async () => {
    const fixture = createFixture();

    await expect(
      fixture.system.commitGroundItemPickupOperationAsync(request()),
    ).resolves.toEqual(
      expect.objectContaining({
        operationId: OPERATION_ID,
        playerId: PLAYER_ID,
        replayed: false,
        sourceEntityId: SOURCE_ID,
        itemId: "air_rune",
        quantity: 2,
        operationCommittedCoins: null,
        currentCoins: 100,
        committed: [
          { itemId: "air_rune", quantity: 2, slotIndex: 0, metadata: null },
        ],
      }),
    );
    expect(fixture.insertedInventory).toEqual([
      [
        {
          playerId: PLAYER_ID,
          itemId: "air_rune",
          quantity: 2,
          slotIndex: 0,
          metadata: null,
        },
      ],
    ]);
    expect(fixture.insertedOperations).toEqual([
      expect.objectContaining({
        id: OPERATION_ID,
        playerId: PLAYER_ID,
        operationType: "ground_item_pickup",
        completed: true,
        operationState: expect.objectContaining({
          sourceEntityId: SOURCE_ID,
          itemId: "air_rune",
          quantity: 2,
        }),
      }),
    ]);
    expect(fixture.tx.execute).toHaveBeenCalledTimes(4);
    expect(fixture.sourceUpdates).toEqual([
      expect.objectContaining({
        status: "claimed",
        claimedByOperationId: OPERATION_ID,
        claimedByPlayerId: PLAYER_ID,
      }),
    ]);
  });

  it("replays the receipt with current custody instead of its historical post-state", async () => {
    const req = request();
    const currentInventory = [
      { itemId: "air_rune", quantity: 1, slotIndex: 0, metadata: null },
      { itemId: "logs", quantity: 1, slotIndex: 1, metadata: null },
    ];
    const fixture = createFixture({
      inventory: currentInventory,
      coins: 125,
      existing: {
        playerId: PLAYER_ID,
        operationType: "ground_item_pickup",
        completed: true,
        operationState: {
          version: 1,
          requestFingerprint: req.requestFingerprint,
          sourceEntityId: SOURCE_ID,
          itemId: "air_rune",
          quantity: 2,
          stackable: true,
          operationCommittedCoins: null,
        },
      },
    });

    await expect(
      fixture.system.commitGroundItemPickupOperationAsync(req),
    ).resolves.toEqual(
      expect.objectContaining({
        replayed: true,
        currentCoins: 125,
        committed: currentInventory,
      }),
    );
    expect(fixture.insertedInventory).toEqual([]);
    expect(fixture.insertedOperations).toEqual([]);
  });

  it("rejects a source already claimed by another operation", async () => {
    const fixture = createFixture({ sourceClaimed: true });

    await expect(
      fixture.system.commitGroundItemPickupOperationAsync(request()),
    ).rejects.toThrow("ground_item_pickup_source_claimed");
    expect(fixture.insertedInventory).toEqual([]);
    expect(fixture.insertedOperations).toEqual([]);
  });

  it("rejects an identifier that has no durable active-source record", async () => {
    const fixture = createFixture({ sourceMissing: true });

    await expect(
      fixture.system.commitGroundItemPickupOperationAsync(request()),
    ).rejects.toThrow("ground_item_pickup_source_missing");
    expect(fixture.insertedInventory).toEqual([]);
    expect(fixture.insertedOperations).toEqual([]);
    expect(fixture.sourceUpdates).toEqual([]);
  });

  it("rejects a stale presentation whose quantity no longer matches custody", async () => {
    const fixture = createFixture({ sourceQuantity: 3 });

    await expect(
      fixture.system.commitGroundItemPickupOperationAsync(request()),
    ).rejects.toThrow("ground_item_pickup_source_mismatch");
    expect(fixture.insertedInventory).toEqual([]);
    expect(fixture.insertedOperations).toEqual([]);
    expect(fixture.sourceUpdates).toEqual([]);
  });

  it("credits a coin source through the locked money-pouch row", async () => {
    const fixture = createFixture({
      coins: 100,
      sourceItemId: "coins",
      sourceQuantity: 25,
    });

    await expect(
      fixture.system.commitGroundItemPickupOperationAsync(
        request({
          itemId: "coins",
          quantity: 25,
          requestFingerprint: fingerprint(SOURCE_ID, "coins", 25),
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        itemId: "coins",
        operationCommittedCoins: 125,
        currentCoins: 125,
        committed: [],
      }),
    );
    expect(fixture.characterUpdates).toEqual([{ coins: 125 }]);
    expect(fixture.insertedInventory).toEqual([]);
  });

  it("rejects a forged request fingerprint before opening a transaction", async () => {
    const fixture = createFixture();

    await expect(
      fixture.system.commitGroundItemPickupOperationAsync(
        request({ requestFingerprint: "a".repeat(64) }),
      ),
    ).rejects.toThrow("ground_item_pickup_request_invalid");
    expect(fixture.tx.execute).not.toHaveBeenCalled();
  });
});
