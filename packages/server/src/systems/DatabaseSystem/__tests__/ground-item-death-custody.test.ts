import { createHash, randomUUID } from "node:crypto";

import {
  ITEMS,
  serializeGroundItemDeathCommitFingerprint,
  serializeGroundItemSourceRegistrationFingerprint,
} from "@hyperforge/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../database/schema.js";
import type {
  GroundItemDeathCommitRequest,
  GroundItemSourceRegistrationRequest,
  InventorySaveItem,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const NOW = 1_788_087_600_000;
const PLAYER_ID = "ground-death-custody-agent";
const priorAirRune = ITEMS.get("air_rune");
const priorMindRune = ITEMS.get("mind_rune");

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
});

afterAll(() => {
  if (priorAirRune) ITEMS.set("air_rune", priorAirRune);
  else ITEMS.delete("air_rune");
  if (priorMindRune) ITEMS.set("mind_rune", priorMindRune);
  else ITEMS.delete("mind_rune");
});

function sourceRequest(
  itemId: string,
  quantity: number,
  x: number,
): GroundItemSourceRegistrationRequest {
  const input: Omit<GroundItemSourceRegistrationRequest, "requestFingerprint"> =
    {
      contributionId: `ground-item-source:${randomUUID()}`,
      preferredSourceId: `ground_item_${randomUUID()}`,
      itemId,
      quantity,
      stackable: true,
      position: { x: x + 0.5, y: 0.2, z: 15.5 },
      tile: { x, z: 15 },
      droppedBy: PLAYER_ID,
      lifetimeMs: 120_000,
      lootProtectionMs: 60_000,
      allowMerge: false,
    };
  return {
    ...input,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemSourceRegistrationFingerprint(input), "utf8")
      .digest("hex"),
  };
}

function request(): GroundItemDeathCommitRequest {
  const input: Omit<GroundItemDeathCommitRequest, "requestFingerprint"> = {
    operationId: `ground-item-death:${randomUUID()}`,
    playerId: PLAYER_ID,
    deathTimestamp: NOW - 1_000,
    position: { x: 12.5, y: 0.2, z: 15.5 },
    killedBy: "combat_agent",
    zoneType: "wilderness",
    sources: [
      sourceRequest("air_rune", 5, 12),
      sourceRequest("mind_rune", 2, 13),
    ],
  };
  return {
    ...input,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemDeathCommitFingerprint(input), "utf8")
      .digest("hex"),
  };
}

function sourceRow(
  source: GroundItemSourceRegistrationRequest,
): Record<string, unknown> {
  return {
    source_id: source.preferredSourceId,
    status: "active",
    item_id: source.itemId,
    quantity: source.quantity,
    stackable: source.stackable,
    position_x: source.position.x,
    position_y: source.position.y,
    position_z: source.position.z,
    tile_x: source.tile.x,
    tile_z: source.tile.z,
    dropped_by: PLAYER_ID,
    created_at: NOW,
    updated_at: NOW,
    expires_at: NOW + source.lifetimeMs,
    loot_protection_expires_at: NOW + source.lootProtectionMs,
    claimed_by_operation_id: null,
    claimed_by_player_id: null,
    claimed_at: null,
    version: 1,
    request_fingerprint: source.requestFingerprint,
    contribution_item_id: source.itemId,
    contribution_quantity: source.quantity,
  };
}

type FixtureOptions = {
  request: GroundItemDeathCommitRequest;
  inventory?: InventorySaveItem[];
  equipment?: Array<{ itemId: string; quantity: number }>;
  existingOperation?: Record<string, unknown>;
  replaySources?: boolean;
};

function createFixture(options: FixtureOptions) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const deletes: unknown[] = [];
  let executeCount = 0;
  let sourceIndex = 0;
  const inventory = options.inventory ?? [
    { itemId: "air_rune", quantity: 5, slotIndex: 3, metadata: null },
  ];
  const equipment = options.equipment ?? [{ itemId: "mind_rune", quantity: 2 }];
  const tx = {
    execute: vi.fn(async () => {
      executeCount++;
      const sourceStep = executeCount - 2;
      if (sourceStep > 0 && sourceStep % 3 === 2) {
        return { rows: [{ databaseNow: NOW }] };
      }
      if (options.replaySources && sourceStep > 0 && sourceStep % 3 === 0) {
        return { rows: [sourceRow(options.request.sources[sourceIndex++]!)] };
      }
      return { rows: [] };
    }),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: vi.fn(async () => {
          if (table === schema.characters) return [{ id: PLAYER_ID }];
          if (table === schema.operationsLog) {
            return options.existingOperation ? [options.existingOperation] : [];
          }
          if (table === schema.playerDeaths) return [];
          if (table === schema.inventory) return inventory;
          if (table === schema.equipment) return equipment;
          return [];
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push({ table, values });
      }),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        deletes.push(table);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
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
  return { system, internals, tx, inserts, deletes };
}

describe("DatabaseSystem ground-item death custody", () => {
  it("co-commits the death clear, exact sources, lock, and receipt", async () => {
    const req = request();
    const fixture = createFixture({ request: req });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(NOW + 10_000);

    try {
      await expect(
        fixture.system.commitGroundItemDeathOperationAsync(req),
      ).resolves.toMatchObject({
        operationId: req.operationId,
        replayed: false,
        zoneType: "wilderness",
        dropped: [
          { itemId: "air_rune", quantity: 5 },
          { itemId: "mind_rune", quantity: 2 },
        ],
        sources: [
          { contributionId: req.sources[0]!.contributionId, replayed: false },
          { contributionId: req.sources[1]!.contributionId, replayed: false },
        ],
      });
    } finally {
      dateNow.mockRestore();
    }
    expect(fixture.internals.executeInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
    expect(fixture.deletes).toEqual([schema.inventory, schema.equipment]);
    expect(fixture.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: schema.groundItemSources }),
        expect.objectContaining({
          table: schema.groundItemSourceContributions,
        }),
        expect.objectContaining({
          table: schema.operationsLog,
          values: expect.objectContaining({
            id: req.operationId,
            operationType: "ground_item_death",
            completed: true,
            timestamp: NOW,
            completedAt: NOW,
          }),
        }),
        expect.objectContaining({
          table: schema.playerDeaths,
          values: expect.objectContaining({
            playerId: PLAYER_ID,
            deathOperationId: req.operationId,
            zoneType: "wilderness",
          }),
        }),
      ]),
    );
  });

  it("returns the exact receipt on response-loss replay without clearing twice", async () => {
    const req = request();
    const state = {
      version: 1,
      requestFingerprint: req.requestFingerprint,
      deathTimestamp: req.deathTimestamp,
      position: req.position,
      killedBy: req.killedBy,
      zoneType: req.zoneType,
      dropped: [
        { itemId: "air_rune", quantity: 5 },
        { itemId: "mind_rune", quantity: 2 },
      ],
      sourceContributionIds: req.sources.map((source) => source.contributionId),
      sourceRequestFingerprints: req.sources.map(
        (source) => source.requestFingerprint,
      ),
      sourceIds: req.sources.map((source) => source.preferredSourceId),
    };
    const fixture = createFixture({
      request: req,
      replaySources: true,
      existingOperation: {
        playerId: PLAYER_ID,
        operationType: "ground_item_death",
        completed: true,
        operationState: state,
      },
    });

    await expect(
      fixture.system.commitGroundItemDeathOperationAsync(req),
    ).resolves.toMatchObject({
      replayed: true,
      dropped: state.dropped,
      sources: [{ replayed: true }, { replayed: true }],
    });
    expect(fixture.deletes).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  it("rejects a source plan that does not exactly cover persisted custody", async () => {
    const req = request();
    req.sources[0] = sourceRequest("air_rune", 4, 12);
    const input = { ...req };
    delete (input as Partial<GroundItemDeathCommitRequest>).requestFingerprint;
    req.requestFingerprint = createHash("sha256")
      .update(
        serializeGroundItemDeathCommitFingerprint(
          input as Omit<GroundItemDeathCommitRequest, "requestFingerprint">,
        ),
        "utf8",
      )
      .digest("hex");
    const fixture = createFixture({ request: req });

    await expect(
      fixture.system.commitGroundItemDeathOperationAsync(req),
    ).rejects.toThrow("ground_item_death_custody_mismatch");
    expect(fixture.deletes).toEqual([]);
    expect(fixture.inserts).toEqual([]);
    expect(fixture.tx.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects an operation collision before consulting source authority", async () => {
    const req = request();
    const fixture = createFixture({
      request: req,
      existingOperation: {
        playerId: PLAYER_ID,
        operationType: "ground_item_death",
        completed: true,
        operationState: {
          version: 1,
          requestFingerprint: "f".repeat(64),
          deathTimestamp: req.deathTimestamp,
          position: req.position,
          killedBy: req.killedBy,
          zoneType: req.zoneType,
          dropped: [],
          sourceContributionIds: [],
          sourceRequestFingerprints: [],
          sourceIds: [],
        },
      },
    });

    await expect(
      fixture.system.commitGroundItemDeathOperationAsync(req),
    ).rejects.toThrow("ground_item_death_operation_id_conflict");
    expect(fixture.tx.execute).toHaveBeenCalledTimes(2);
    expect(fixture.inserts).toEqual([]);
    expect(fixture.deletes).toEqual([]);
  });

  it("cannot bind a new death operation to preexisting source contributions", async () => {
    const req = request();
    const fixture = createFixture({ request: req, replaySources: true });

    await expect(
      fixture.system.commitGroundItemDeathOperationAsync(req),
    ).rejects.toThrow("ground_item_death_source_preexisting");
    expect(fixture.deletes).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });
});
