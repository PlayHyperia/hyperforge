import { createHash, randomUUID } from "node:crypto";

import {
  ITEMS,
  getProcessingFireExtinguishOperationId,
  serializeGroundItemSourceRegistrationFingerprint,
  serializeProcessingFireExtinguishFingerprint,
} from "@hyperforge/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../database/schema.js";
import type {
  GroundItemSourceRegistrationRequest,
  ProcessingFireExtinguishCommitRequest,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const NOW = 1_788_087_600_000;
const PLAYER_ID = "fire-custody-agent";
const FIRE_ID = "fire_11111111-1111-4111-8111-111111111111";
const FIRE_POSITION = { x: 8.5, y: 0.2, z: 9.5 };
const FIRE_EXPIRES_AT = NOW - 1;
const priorAshes = ITEMS.get("ashes");

beforeAll(() => {
  ITEMS.set("ashes", {
    id: "ashes",
    name: "Ashes",
    type: "misc",
    stackable: true,
  } as never);
});

afterAll(() => {
  if (priorAshes) ITEMS.set("ashes", priorAshes);
  else ITEMS.delete("ashes");
});

function ashSource(): GroundItemSourceRegistrationRequest {
  const input: Omit<GroundItemSourceRegistrationRequest, "requestFingerprint"> =
    {
      contributionId: `ground-item-source:${randomUUID()}`,
      preferredSourceId: `ground_item_${randomUUID()}`,
      itemId: "ashes",
      quantity: 1,
      stackable: true,
      position: FIRE_POSITION,
      tile: { x: 8, z: 9 },
      droppedBy: null,
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

function fireRequest(
  source = ashSource(),
): ProcessingFireExtinguishCommitRequest {
  const identity = {
    operationId: getProcessingFireExtinguishOperationId(FIRE_ID),
    fireId: FIRE_ID,
    playerId: PLAYER_ID,
    position: FIRE_POSITION,
    expiresAt: FIRE_EXPIRES_AT,
  };
  return {
    ...identity,
    requestFingerprint: createHash("sha256")
      .update(serializeProcessingFireExtinguishFingerprint(identity), "utf8")
      .digest("hex"),
    source,
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
    dropped_by: null,
    created_at: NOW,
    updated_at: NOW,
    expires_at: NOW + source.lifetimeMs,
    loot_protection_expires_at: null,
    claimed_by_operation_id: null,
    claimed_by_player_id: null,
    claimed_at: null,
    version: 1,
    request_fingerprint: source.requestFingerprint,
    contribution_item_id: source.itemId,
    contribution_quantity: source.quantity,
  };
}

function storedOperation(req: ProcessingFireExtinguishCommitRequest) {
  return {
    playerId: PLAYER_ID,
    operationType: "processing_fire_extinguish",
    completed: true,
    operationState: {
      version: 1,
      requestFingerprint: req.requestFingerprint,
      fireId: req.fireId,
      position: req.position,
      expiresAt: req.expiresAt,
      extinguishedAt: NOW,
      source: req.source,
      sourceId: req.source.preferredSourceId,
    },
  };
}

type FixtureOptions = {
  existingOperation?: ReturnType<typeof storedOperation>;
  replaySource?: GroundItemSourceRegistrationRequest;
  fireExpiresAt?: number;
  fireExtinguishedAt?: number | null;
};

function createFixture(options: FixtureOptions = {}) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const updates: unknown[] = [];
  let executeCount = 0;
  const tx = {
    execute: vi.fn(async () => {
      executeCount++;
      if (executeCount === 2) {
        return {
          rows: [
            {
              fireId: FIRE_ID,
              playerId: PLAYER_ID,
              positionX: FIRE_POSITION.x,
              positionY: FIRE_POSITION.y,
              positionZ: FIRE_POSITION.z,
              expiresAt: options.fireExpiresAt ?? FIRE_EXPIRES_AT,
              extinguishedAt: options.fireExtinguishedAt ?? null,
            },
          ],
        };
      }
      const replayPath = Boolean(options.existingOperation);
      const databaseClockStep = replayPath ? 4 : executeCount === 3 ? 3 : 5;
      if (executeCount === databaseClockStep) {
        return { rows: [{ databaseNow: NOW }] };
      }
      const replayStep = replayPath ? 5 : 6;
      if (options.replaySource && executeCount === replayStep) {
        return { rows: [sourceRow(options.replaySource)] };
      }
      return { rows: [] };
    }),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: vi.fn(async () =>
          table === schema.operationsLog && options.existingOperation
            ? [options.existingOperation]
            : [],
        ),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push({ table, values });
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            updates.push({ table, values });
            return [{ fireId: FIRE_ID }];
          }),
        })),
      })),
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
  return { system, internals, inserts, updates };
}

describe("DatabaseSystem fire-expiry ash custody", () => {
  it("returns overdue unextinguished fires with the sampled database clock", async () => {
    const where = vi.fn(async () => [
      {
        fireId: FIRE_ID,
        playerId: PLAYER_ID,
        positionX: FIRE_POSITION.x,
        positionY: FIRE_POSITION.y,
        positionZ: FIRE_POSITION.z,
        tileX: 8,
        tileZ: 9,
        createdAt: FIRE_EXPIRES_AT - 60_000,
        expiresAt: FIRE_EXPIRES_AT,
        databaseObservedAt: NOW,
      },
    ]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    };
    const system = new DatabaseSystem({} as never);
    const internals = system as unknown as {
      db: typeof db;
      isDestroying: boolean;
    };
    internals.db = db;
    internals.isDestroying = false;

    await expect(system.getActiveProcessingFiresAsync()).resolves.toEqual([
      {
        kind: "fire",
        fireId: FIRE_ID,
        playerId: PLAYER_ID,
        position: FIRE_POSITION,
        tile: { x: 8, z: 9 },
        createdAt: FIRE_EXPIRES_AT - 60_000,
        expiresAt: FIRE_EXPIRES_AT,
        databaseObservedAt: NOW,
      },
    ]);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("co-commits the due-fire transition, ash source, and receipt", async () => {
    const req = fireRequest();
    const fixture = createFixture();

    await expect(
      fixture.system.commitProcessingFireExtinguishOperationAsync(req),
    ).resolves.toMatchObject({
      operationId: req.operationId,
      fireId: FIRE_ID,
      playerId: PLAYER_ID,
      replayed: false,
      expiresAt: FIRE_EXPIRES_AT,
      extinguishedAt: NOW,
      sourceRequest: req.source,
      source: { sourceId: req.source.preferredSourceId, replayed: false },
    });
    expect(fixture.internals.executeInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
    expect(fixture.updates).toEqual([
      expect.objectContaining({
        table: schema.processingActiveFires,
        values: { extinguishedAt: NOW },
      }),
    ]);
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
            operationType: "processing_fire_extinguish",
            timestamp: NOW,
            completedAt: NOW,
          }),
        }),
      ]),
    );
  });

  it("replays the first ash source even when a replacement prepares new IDs", async () => {
    const original = fireRequest();
    const replacement = fireRequest();
    const fixture = createFixture({
      existingOperation: storedOperation(original),
      replaySource: original.source,
      fireExtinguishedAt: NOW,
    });

    await expect(
      fixture.system.commitProcessingFireExtinguishOperationAsync(replacement),
    ).resolves.toMatchObject({
      replayed: true,
      sourceRequest: original.source,
      source: {
        sourceId: original.source.preferredSourceId,
        contributionId: original.source.contributionId,
        replayed: true,
      },
    });
    expect(fixture.inserts).toEqual([]);
    expect(fixture.updates).toEqual([]);
  });

  it("rejects an early expiry and a source contribution owned elsewhere", async () => {
    const early = fireRequest();
    early.expiresAt = NOW + 1;
    const earlyIdentity = { ...early };
    delete (earlyIdentity as Partial<ProcessingFireExtinguishCommitRequest>)
      .requestFingerprint;
    delete (earlyIdentity as Partial<ProcessingFireExtinguishCommitRequest>)
      .source;
    early.requestFingerprint = createHash("sha256")
      .update(
        serializeProcessingFireExtinguishFingerprint(
          earlyIdentity as Omit<
            ProcessingFireExtinguishCommitRequest,
            "requestFingerprint" | "source"
          >,
        ),
        "utf8",
      )
      .digest("hex");
    const earlyFixture = createFixture({ fireExpiresAt: early.expiresAt });
    await expect(
      earlyFixture.system.commitProcessingFireExtinguishOperationAsync(early),
    ).rejects.toThrow("processing_fire_extinguish_not_due");

    const preexisting = fireRequest();
    const sourceFixture = createFixture({ replaySource: preexisting.source });
    await expect(
      sourceFixture.system.commitProcessingFireExtinguishOperationAsync(
        preexisting,
      ),
    ).rejects.toThrow("processing_fire_extinguish_source_preexisting");
    expect(sourceFixture.updates).toEqual([]);
  });

  it("rejects operation-state collisions and malformed ash policy", async () => {
    const req = fireRequest();
    const collision = createFixture({
      existingOperation: {
        ...storedOperation(req),
        operationState: {
          ...storedOperation(req).operationState,
          expiresAt: req.expiresAt - 1,
        },
      },
      fireExtinguishedAt: NOW,
    });
    await expect(
      collision.system.commitProcessingFireExtinguishOperationAsync(req),
    ).rejects.toThrow("processing_fire_extinguish_operation_id_conflict");

    const malformed = fireRequest();
    malformed.source = { ...malformed.source, quantity: 2 };
    const malformedFixture = createFixture();
    await expect(
      malformedFixture.system.commitProcessingFireExtinguishOperationAsync(
        malformed,
      ),
    ).rejects.toThrow("processing_fire_extinguish_request_invalid");
    expect(
      malformedFixture.internals.executeInTransaction,
    ).not.toHaveBeenCalled();
  });
});
