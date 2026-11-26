import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ITEMS,
  serializeGroundItemSourceRegistrationFingerprint,
} from "@hyperforge/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../database/schema.js";
import type { GroundItemSourceRegistrationRequest } from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const NOW = 1_788_087_600_000;
const SOURCE_ID = "ground_item_00000000-0000-4000-8000-000000000001";

beforeAll(() => {
  ITEMS.set("air_rune", {
    id: "air_rune",
    name: "Air rune",
    type: "resource",
    stackable: true,
  } as never);
});

afterAll(() => {
  ITEMS.delete("air_rune");
});

function request(
  overrides: Partial<GroundItemSourceRegistrationRequest> = {},
): GroundItemSourceRegistrationRequest {
  const input: Omit<GroundItemSourceRegistrationRequest, "requestFingerprint"> =
    {
      contributionId: `ground-item-source:${randomUUID()}`,
      preferredSourceId: SOURCE_ID,
      itemId: "air_rune",
      quantity: 2,
      stackable: true,
      position: { x: 1.5, y: 0.2, z: 1.5 },
      tile: { x: 1, z: 1 },
      droppedBy: null,
      lifetimeMs: 120_000,
      lootProtectionMs: 0,
      allowMerge: false,
      ...overrides,
    };
  return {
    ...input,
    requestFingerprint:
      overrides.requestFingerprint ??
      createHash("sha256")
        .update(serializeGroundItemSourceRegistrationFingerprint(input), "utf8")
        .digest("hex"),
  };
}

function sourceRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source_id: SOURCE_ID,
    status: "active",
    item_id: "air_rune",
    quantity: 2,
    stackable: true,
    position_x: 1.5,
    position_y: 0.2,
    position_z: 1.5,
    tile_x: 1,
    tile_z: 1,
    dropped_by: null,
    created_at: NOW - 1_000,
    updated_at: NOW - 1_000,
    expires_at: NOW + 119_000,
    loot_protection_expires_at: null,
    claimed_by_operation_id: null,
    claimed_by_player_id: null,
    claimed_at: null,
    version: 1,
    ...overrides,
  };
}

function createFixture(options: {
  replayRow?: Record<string, unknown>;
  mergeRow?: Record<string, unknown>;
  batchMerge?: boolean;
}) {
  let executeCount = 0;
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const tx = {
    execute: vi.fn(async () => {
      executeCount++;
      if (executeCount === 2 || (options.batchMerge && executeCount === 5)) {
        return { rows: [{ databaseNow: NOW }] };
      }
      if (executeCount === 3) {
        return { rows: options.replayRow ? [options.replayRow] : [] };
      }
      if (options.batchMerge && executeCount === 6) return { rows: [] };
      if (options.batchMerge && executeCount === 7) {
        return { rows: [sourceRow()] };
      }
      if (executeCount === 4) {
        return { rows: options.mergeRow ? [options.mergeRow] : [] };
      }
      return { rows: [] };
    }),
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
  return { system, tx, inserts, updates, internals };
}

describe("DatabaseSystem durable ground-source registry", () => {
  it("ships source, contribution, lifecycle-trigger, and hydration indexes", () => {
    const migration = readFileSync(
      new URL(
        "../../../database/migrations/0097_add_durable_ground_item_sources.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "ground_item_sources"',
    );
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "ground_item_source_contributions"',
    );
    expect(migration).toContain("validate_ground_item_source_update");
    expect(migration).toContain("ground item source history is append-only");
    expect(migration).toContain("idx_ground_item_sources_active_expiry");
  });

  it("commits a new source and immutable contribution in one transaction", async () => {
    const fixture = createFixture({});
    const req = request();

    await expect(
      fixture.system.registerGroundItemSourceAsync(req),
    ).resolves.toMatchObject({
      sourceId: SOURCE_ID,
      contributionId: req.contributionId,
      requestFingerprint: req.requestFingerprint,
      replayed: false,
      status: "active",
      itemId: "air_rune",
      quantity: 2,
      version: 1,
    });
    expect(fixture.inserts).toEqual([
      expect.objectContaining({ table: schema.groundItemSources }),
      expect.objectContaining({
        table: schema.groundItemSourceContributions,
        values: expect.objectContaining({
          contributionId: req.contributionId,
          sourceId: SOURCE_ID,
          quantity: 2,
        }),
      }),
    ]);
    expect(fixture.updates).toEqual([]);
  });

  it("replays an exact contribution without mutating or inserting again", async () => {
    const req = request();
    const fixture = createFixture({
      replayRow: {
        ...sourceRow({ quantity: 5, version: 2 }),
        request_fingerprint: req.requestFingerprint,
        contribution_item_id: "air_rune",
        contribution_quantity: 2,
      },
    });

    await expect(
      fixture.system.registerGroundItemSourceAsync(req),
    ).resolves.toMatchObject({
      replayed: true,
      sourceId: SOURCE_ID,
      quantity: 5,
      version: 2,
    });
    expect(fixture.inserts).toEqual([]);
    expect(fixture.updates).toEqual([]);
  });

  it("merges a new stack contribution exactly once under the source row lock", async () => {
    const req = request({ allowMerge: true, quantity: 3 });
    const fixture = createFixture({ mergeRow: sourceRow() });

    await expect(
      fixture.system.registerGroundItemSourceAsync(req),
    ).resolves.toMatchObject({
      replayed: false,
      sourceId: SOURCE_ID,
      quantity: 5,
      version: 2,
    });
    expect(fixture.updates).toEqual([
      expect.objectContaining({
        table: schema.groundItemSources,
        values: expect.objectContaining({ quantity: 5, version: 2 }),
      }),
    ]);
    expect(fixture.inserts).toEqual([
      expect.objectContaining({
        table: schema.groundItemSourceContributions,
        values: expect.objectContaining({
          contributionId: req.contributionId,
          quantity: 3,
        }),
      }),
    ]);
  });

  it("commits a multi-item batch through one serializable transaction", async () => {
    const fixture = createFixture({ batchMerge: true });
    const first = request();
    const second = request({
      contributionId: `ground-item-source:${randomUUID()}`,
      preferredSourceId: `ground_item_${randomUUID()}`,
      quantity: 3,
      allowMerge: true,
    });

    await expect(
      fixture.system.registerGroundItemSourcesAsync([first, second]),
    ).resolves.toEqual([
      expect.objectContaining({
        sourceId: SOURCE_ID,
        quantity: 2,
        replayed: false,
      }),
      expect.objectContaining({
        sourceId: SOURCE_ID,
        quantity: 5,
        replayed: false,
      }),
    ]);
    expect(fixture.internals.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(
      fixture.inserts.filter(
        (entry) => entry.table === schema.groundItemSourceContributions,
      ),
    ).toHaveLength(2);
    expect(fixture.updates).toEqual([
      expect.objectContaining({
        table: schema.groundItemSources,
        values: expect.objectContaining({ quantity: 5 }),
      }),
    ]);
  });

  it("rejects a forged fingerprint before opening a transaction", async () => {
    const fixture = createFixture({});
    await expect(
      fixture.system.registerGroundItemSourceAsync(
        request({ requestFingerprint: "a".repeat(64) }),
      ),
    ).rejects.toThrow("ground_item_source_request_invalid");
    expect(fixture.tx.execute).not.toHaveBeenCalled();
  });
});
