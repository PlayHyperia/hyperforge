import { createHash, randomUUID } from "node:crypto";

import {
  ITEMS,
  serializeGroundItemDropCommitFingerprint,
  serializeGroundItemSourceRegistrationFingerprint,
} from "@hyperforge/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../database/schema.js";
import type {
  GroundItemDropCommitRequest,
  GroundItemSourceRegistrationRequest,
  InventorySaveItem,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const NOW = 1_788_087_600_000;
const PLAYER_ID = "ground-drop-custody-agent";

const priorAirRune = ITEMS.get("air_rune");
const priorMindRune = ITEMS.get("mind_rune");
const priorCoins = ITEMS.get("coins");

beforeAll(() => {
  ITEMS.set("air_rune", {
    id: "air_rune",
    name: "Air rune",
    type: "resource",
    stackable: true,
  } as never);
  ITEMS.set("mind_rune", {
    id: "mind_rune",
    name: "Mind rune",
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
  if (priorAirRune) ITEMS.set("air_rune", priorAirRune);
  else ITEMS.delete("air_rune");
  if (priorMindRune) ITEMS.set("mind_rune", priorMindRune);
  else ITEMS.delete("mind_rune");
  if (priorCoins) ITEMS.set("coins", priorCoins);
  else ITEMS.delete("coins");
});

function sourceRequest(
  itemId: string,
  quantity: number,
): GroundItemSourceRegistrationRequest {
  const input: Omit<GroundItemSourceRegistrationRequest, "requestFingerprint"> =
    {
      contributionId: `ground-item-source:${randomUUID()}`,
      preferredSourceId: `ground_item_${randomUUID()}`,
      itemId,
      quantity,
      stackable: ITEMS.get(itemId)?.stackable === true,
      position: { x: 12.5, y: 0.2, z: 15.5 },
      tile: { x: 12, z: 15 },
      droppedBy: PLAYER_ID,
      lifetimeMs: 120_000,
      lootProtectionMs: 0,
      allowMerge: false,
    };
  return {
    ...input,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemSourceRegistrationFingerprint(input), "utf8")
      .digest("hex"),
  };
}

function request(
  itemId = "air_rune",
  quantity = 2,
  slotIndex: number | null = 3,
): GroundItemDropCommitRequest {
  const input: Omit<GroundItemDropCommitRequest, "requestFingerprint"> = {
    operationId: `ground-item-drop:${randomUUID()}`,
    playerId: PLAYER_ID,
    itemId,
    quantity,
    slotIndex,
    source: sourceRequest(itemId, quantity),
  };
  return {
    ...input,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemDropCommitFingerprint(input), "utf8")
      .digest("hex"),
  };
}

function sourceRow(req: GroundItemDropCommitRequest): Record<string, unknown> {
  return {
    source_id: req.source.preferredSourceId,
    status: "active",
    item_id: req.itemId,
    quantity: req.quantity,
    stackable: true,
    position_x: req.source.position.x,
    position_y: req.source.position.y,
    position_z: req.source.position.z,
    tile_x: req.source.tile.x,
    tile_z: req.source.tile.z,
    dropped_by: PLAYER_ID,
    created_at: NOW,
    updated_at: NOW,
    expires_at: NOW + req.source.lifetimeMs,
    loot_protection_expires_at: null,
    claimed_by_operation_id: null,
    claimed_by_player_id: null,
    claimed_at: null,
    version: 1,
    request_fingerprint: req.source.requestFingerprint,
    contribution_item_id: req.itemId,
    contribution_quantity: req.quantity,
  };
}

type FixtureOptions = {
  request: GroundItemDropCommitRequest;
  coins?: number;
  inventory?: InventorySaveItem[];
  existingOperation?: Record<string, unknown>;
  replaySource?: boolean;
};

function createFixture(options: FixtureOptions) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const deletes: unknown[] = [];
  let executeCount = 0;
  const inventory = options.inventory ?? [
    { itemId: "air_rune", quantity: 5, slotIndex: 3, metadata: null },
    { itemId: "mind_rune", quantity: 4, slotIndex: 4, metadata: null },
  ];
  const tx = {
    execute: vi.fn(async () => {
      executeCount++;
      if (executeCount === 4) return { rows: [{ databaseNow: NOW }] };
      if (executeCount === 5 && options.replaySource) {
        return { rows: [sourceRow(options.request)] };
      }
      return { rows: [] };
    }),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: vi.fn(async () => {
          if (table === schema.characters) {
            return [{ id: PLAYER_ID, coins: options.coins ?? 100 }];
          }
          if (table === schema.operationsLog) {
            return options.existingOperation ? [options.existingOperation] : [];
          }
          if (table === schema.inventory) return inventory;
          return [];
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push({ table, values });
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(async () => {
          updates.push({ table, values });
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        deletes.push(table);
      }),
    })),
  };
  const system = new DatabaseSystem({} as never);
  const internals = system as unknown as {
    db: object;
    isDestroying: boolean;
    executeInTransaction: <T>(
      callback: (transaction: typeof tx) => Promise<T>,
      transactionOptions: unknown,
    ) => Promise<T>;
  };
  internals.db = {};
  internals.isDestroying = false;
  internals.executeInTransaction = vi.fn(async (callback) => callback(tx));
  return { system, internals, tx, inserts, updates, deletes };
}

describe("DatabaseSystem ground-item drop custody", () => {
  it("co-commits an exact-slot debit, durable source, contribution, and receipt", async () => {
    const req = request();
    const fixture = createFixture({ request: req });

    await expect(
      fixture.system.commitGroundItemDropOperationAsync(req),
    ).resolves.toMatchObject({
      operationId: req.operationId,
      replayed: false,
      itemId: "air_rune",
      quantity: 2,
      slotIndex: 3,
      operationCommittedCoins: null,
      currentCoins: 100,
      committed: [
        { itemId: "air_rune", quantity: 3, slotIndex: 3, metadata: null },
        { itemId: "mind_rune", quantity: 4, slotIndex: 4, metadata: null },
      ],
      source: {
        sourceId: req.source.preferredSourceId,
        contributionId: req.source.contributionId,
        replayed: false,
      },
    });
    expect(fixture.internals.executeInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "serializable" },
    );
    expect(fixture.deletes).toEqual([schema.inventory]);
    expect(fixture.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: schema.groundItemSources }),
        expect.objectContaining({
          table: schema.groundItemSourceContributions,
          values: expect.objectContaining({
            contributionId: req.source.contributionId,
            itemId: "air_rune",
            quantity: 2,
          }),
        }),
        expect.objectContaining({
          table: schema.inventory,
          values: expect.arrayContaining([
            expect.objectContaining({
              playerId: PLAYER_ID,
              itemId: "air_rune",
              quantity: 3,
              slotIndex: 3,
            }),
          ]),
        }),
        expect.objectContaining({
          table: schema.operationsLog,
          values: expect.objectContaining({
            id: req.operationId,
            playerId: PLAYER_ID,
            operationType: "ground_item_drop",
            completed: true,
          }),
        }),
      ]),
    );
  });

  it("returns current custody on exact replay without a second debit or insert", async () => {
    const req = request();
    const fixture = createFixture({
      request: req,
      coins: 125,
      inventory: [
        { itemId: "mind_rune", quantity: 7, slotIndex: 8, metadata: null },
      ],
      replaySource: true,
      existingOperation: {
        playerId: PLAYER_ID,
        operationType: "ground_item_drop",
        completed: true,
        operationState: {
          version: 1,
          requestFingerprint: req.requestFingerprint,
          itemId: req.itemId,
          quantity: req.quantity,
          slotIndex: req.slotIndex,
          sourceContributionId: req.source.contributionId,
          sourceRequestFingerprint: req.source.requestFingerprint,
          sourceId: req.source.preferredSourceId,
          operationCommittedCoins: null,
        },
      },
    });

    await expect(
      fixture.system.commitGroundItemDropOperationAsync(req),
    ).resolves.toMatchObject({
      replayed: true,
      currentCoins: 125,
      committed: [
        { itemId: "mind_rune", quantity: 7, slotIndex: 8, metadata: null },
      ],
      source: { replayed: true },
    });
    expect(fixture.inserts).toEqual([]);
    expect(fixture.updates).toEqual([]);
    expect(fixture.deletes).toEqual([]);
  });

  it("rejects a wrong slot before creating any source or changing custody", async () => {
    const req = request("air_rune", 1, 4);
    const fixture = createFixture({ request: req });

    await expect(
      fixture.system.commitGroundItemDropOperationAsync(req),
    ).rejects.toThrow("ground_item_drop_slot_mismatch");
    expect(fixture.inserts).toEqual([]);
    expect(fixture.updates).toEqual([]);
    expect(fixture.deletes).toEqual([]);
    expect(fixture.tx.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects an operation collision before consulting source authority", async () => {
    const req = request();
    const fixture = createFixture({
      request: req,
      existingOperation: {
        playerId: PLAYER_ID,
        operationType: "ground_item_drop",
        completed: true,
        operationState: {
          version: 1,
          requestFingerprint: "f".repeat(64),
          itemId: req.itemId,
          quantity: req.quantity,
          slotIndex: req.slotIndex,
          sourceContributionId: req.source.contributionId,
          sourceRequestFingerprint: req.source.requestFingerprint,
          sourceId: req.source.preferredSourceId,
          operationCommittedCoins: null,
        },
      },
    });

    await expect(
      fixture.system.commitGroundItemDropOperationAsync(req),
    ).rejects.toThrow("ground_item_drop_operation_id_conflict");
    expect(fixture.tx.execute).toHaveBeenCalledTimes(2);
    expect(fixture.inserts).toEqual([]);
    expect(fixture.deletes).toEqual([]);
  });

  it("cannot bind a new debit operation to a preexisting source contribution", async () => {
    const req = request();
    const fixture = createFixture({ request: req, replaySource: true });

    await expect(
      fixture.system.commitGroundItemDropOperationAsync(req),
    ).rejects.toThrow("ground_item_drop_source_preexisting");
    expect(fixture.inserts).toEqual([]);
    expect(fixture.updates).toEqual([]);
    expect(fixture.deletes).toEqual([]);
  });

  it("co-commits a coin debit without rewriting item inventory", async () => {
    const req = request("coins", 25, null);
    const fixture = createFixture({ request: req, coins: 100 });

    await expect(
      fixture.system.commitGroundItemDropOperationAsync(req),
    ).resolves.toMatchObject({
      replayed: false,
      operationCommittedCoins: 75,
      currentCoins: 75,
      committed: [
        { itemId: "air_rune", quantity: 5, slotIndex: 3, metadata: null },
        { itemId: "mind_rune", quantity: 4, slotIndex: 4, metadata: null },
      ],
    });
    expect(fixture.deletes).toEqual([]);
    expect(fixture.updates).toEqual([
      expect.objectContaining({
        table: schema.characters,
        values: { coins: 75 },
      }),
    ]);
    expect(
      fixture.inserts.some((entry) => entry.table === schema.operationsLog),
    ).toBe(true);
  });
});
