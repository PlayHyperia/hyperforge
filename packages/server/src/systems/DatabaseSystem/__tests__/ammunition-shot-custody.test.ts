import { createHash, randomUUID } from "node:crypto";

import {
  ITEMS,
  ammunitionShotIdentityFromRequest,
  serializeAmmunitionShotFingerprint,
  serializeGroundItemSourceRegistrationFingerprint,
} from "@hyperforge/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../database/schema.js";
import type {
  AmmunitionShotCommitRequest,
  GroundItemSourceRegistrationRequest,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const NOW = 1_788_087_700_000;
const PLAYER_ID = "ammunition-agent";
const ITEM_ID = "bronze_arrow";
const POSITION = { x: 8.5, y: 0.2, z: 9.5 };
const priorArrow = ITEMS.get(ITEM_ID);

beforeAll(() => {
  ITEMS.set(ITEM_ID, {
    id: ITEM_ID,
    name: "Bronze arrow",
    type: "ammunition",
    equipSlot: "arrows",
    stackable: true,
  } as never);
});

afterAll(() => {
  if (priorArrow) ITEMS.set(ITEM_ID, priorArrow);
  else ITEMS.delete(ITEM_ID);
});

function recoveredSource(): GroundItemSourceRegistrationRequest {
  const input: Omit<GroundItemSourceRegistrationRequest, "requestFingerprint"> =
    {
      contributionId: `ground-item-source:${randomUUID()}`,
      preferredSourceId: `ground_item_${randomUUID()}`,
      itemId: ITEM_ID,
      quantity: 1,
      stackable: true,
      position: POSITION,
      tile: { x: 8, z: 9 },
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

function shotRequest(
  source: GroundItemSourceRegistrationRequest | null = recoveredSource(),
  operationId = "ammunition-shot:1234567890abcdefghij",
): AmmunitionShotCommitRequest {
  const request = {
    operationId,
    playerId: PLAYER_ID,
    itemId: ITEM_ID,
    quantity: 1 as const,
    recoveryDisposition: source
      ? ("recovered" as const)
      : ("destroyed" as const),
    source,
  };
  return {
    ...request,
    requestFingerprint: createHash("sha256")
      .update(
        serializeAmmunitionShotFingerprint(
          ammunitionShotIdentityFromRequest(request),
        ),
        "utf8",
      )
      .digest("hex"),
  };
}

function sourceReceipt(
  source: GroundItemSourceRegistrationRequest,
  replayed = false,
) {
  return {
    sourceId: source.preferredSourceId,
    status: "active" as const,
    itemId: source.itemId,
    quantity: source.quantity,
    stackable: source.stackable,
    position: source.position,
    tile: source.tile,
    droppedBy: source.droppedBy,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + source.lifetimeMs,
    lootProtectionExpiresAt: null,
    version: 1,
    contributionId: source.contributionId,
    requestFingerprint: source.requestFingerprint,
    replayed,
  };
}

function storedOperation(request: AmmunitionShotCommitRequest) {
  return {
    playerId: PLAYER_ID,
    operationType: "ammunition_shot",
    completed: true,
    operationState: {
      version: 1,
      requestFingerprint: request.requestFingerprint,
      itemId: ITEM_ID,
      quantity: 1,
      recoveryDisposition: request.recoveryDisposition,
      committed: [
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
        { slotType: "arrows", itemId: ITEM_ID, quantity: 1 },
      ],
      source: request.source,
      sourceId: request.source?.preferredSourceId ?? null,
    },
  };
}

function storedPendingOperation(request: AmmunitionShotCommitRequest) {
  return {
    playerId: PLAYER_ID,
    operationType: "ammunition_shot",
    completed: false,
    operationState: {
      version: 2,
      requestFingerprint: request.requestFingerprint,
      itemId: ITEM_ID,
      quantity: 1,
      recoveryDisposition: request.recoveryDisposition,
      committed: [
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
        { slotType: "arrows", itemId: ITEM_ID, quantity: 1 },
      ],
      committedInventory: [],
      source: request.source,
      sourceId: null,
      status: "pending",
      refundDestination: null,
    },
  };
}

function storedFiredOperation(request: AmmunitionShotCommitRequest) {
  const pending = storedPendingOperation(request);
  return {
    ...pending,
    completed: true,
    operationState: {
      ...pending.operationState,
      sourceId: request.source?.preferredSourceId ?? null,
      status: "fired" as const,
    },
  };
}

function createFixture(
  options: {
    existing?:
      | ReturnType<typeof storedOperation>
      | ReturnType<typeof storedPendingOperation>
      | ReturnType<typeof storedFiredOperation>;
    storedSource?: GroundItemSourceRegistrationRequest;
    sourceReplayed?: boolean;
    equipmentRows?: Array<{
      slotType: string;
      itemId: string;
      quantity: number;
    }>;
  } = {},
) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const deletes: unknown[] = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const equipmentRows = options.equipmentRows ?? [
    { slotType: "weapon", itemId: "shortbow", quantity: 1 },
    { slotType: "arrows", itemId: ITEM_ID, quantity: 2 },
  ];
  const tx = {
    execute: vi.fn(async () => ({ rows: [{ databaseNow: NOW }] })),
    select: vi.fn((selection: unknown) => ({
      from: (table: unknown) => ({
        where: vi.fn(async () => {
          if (table === schema.characters) return [{ id: PLAYER_ID }];
          if (table === schema.operationsLog) {
            return options.existing ? [options.existing] : [];
          }
          if (table === schema.equipment) return equipmentRows;
          if (table === schema.inventory) return [];
          throw new Error(`unexpected select ${String(selection)}`);
        }),
      }),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        deletes.push(table);
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
  };
  const system = new DatabaseSystem({} as never);
  const registerGroundItemSourceAsync = vi.fn(
    async (
      source: GroundItemSourceRegistrationRequest,
      transaction: unknown,
    ) => {
      expect(transaction).toBe(tx);
      const stored = options.storedSource ?? source;
      return sourceReceipt(stored, options.sourceReplayed ?? false);
    },
  );
  const internals = system as unknown as {
    db: object;
    isDestroying: boolean;
    registerGroundItemSourceAsync: typeof registerGroundItemSourceAsync;
    executeInTransaction: <T>(
      callback: (transaction: typeof tx) => Promise<T>,
      transactionOptions: unknown,
    ) => Promise<T>;
  };
  internals.db = {};
  internals.isDestroying = false;
  internals.registerGroundItemSourceAsync = registerGroundItemSourceAsync;
  internals.executeInTransaction = vi.fn(async (callback) => callback(tx));
  return {
    system,
    internals,
    tx,
    inserts,
    deletes,
    updates,
    registerGroundItemSourceAsync,
  };
}

describe("DatabaseSystem ammunition-shot recovery custody", () => {
  it("stages one arrow debit without publishing its candidate recovery source", async () => {
    const request = shotRequest();
    const fixture = createFixture();

    await expect(
      fixture.system.commitAmmunitionShotOperationAsync(request),
    ).resolves.toMatchObject({
      operationId: request.operationId,
      playerId: PLAYER_ID,
      replayed: false,
      itemId: ITEM_ID,
      quantity: 1,
      recoveryDisposition: "recovered",
      status: "pending",
      committed: [
        { slotType: "arrows", itemId: ITEM_ID, quantity: 1 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ],
      sourceRequest: request.source,
      source: null,
    });
    expect(fixture.internals.executeInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
    expect(fixture.registerGroundItemSourceAsync).not.toHaveBeenCalled();
    expect(fixture.deletes).toEqual([schema.equipment]);
    expect(fixture.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: schema.equipment }),
        expect.objectContaining({
          table: schema.operationsLog,
          values: expect.objectContaining({
            id: request.operationId,
            operationType: "ammunition_shot",
            timestamp: NOW,
            completed: false,
            completedAt: null,
          }),
        }),
      ]),
    );
  });

  it("replays only the first recovery source when replacement IDs differ", async () => {
    const original = shotRequest();
    const replacement = shotRequest(recoveredSource(), original.operationId);
    const fixture = createFixture({
      existing: storedOperation(original),
      storedSource: original.source!,
      sourceReplayed: true,
    });

    await expect(
      fixture.system.commitAmmunitionShotOperationAsync(replacement),
    ).resolves.toMatchObject({
      replayed: true,
      sourceRequest: original.source,
      source: {
        sourceId: original.source?.preferredSourceId,
        contributionId: original.source?.contributionId,
        replayed: true,
      },
    });
    expect(fixture.inserts).toEqual([]);
    expect(fixture.deletes).toEqual([]);
  });

  it("co-commits a destroyed result without registering a ground source", async () => {
    const request = shotRequest(null, "ammunition-shot:abcdefghij1234567890");
    const fixture = createFixture();

    await expect(
      fixture.system.commitAmmunitionShotOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: false,
      recoveryDisposition: "destroyed",
      status: "pending",
      sourceRequest: null,
      source: null,
    });
    expect(fixture.registerGroundItemSourceAsync).not.toHaveBeenCalled();
  });

  it("finalizes a staged launch and registers its recovery source exactly once", async () => {
    const request = shotRequest();
    const fixture = createFixture({
      existing: storedPendingOperation(request),
      equipmentRows: [
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
        { slotType: "arrows", itemId: ITEM_ID, quantity: 1 },
      ],
    });

    await expect(
      fixture.system.completeAmmunitionShotOperationAsync({
        operationId: request.operationId,
        playerId: request.playerId,
        requestFingerprint: request.requestFingerprint,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      status: "fired",
      refundDestination: null,
      source: {
        sourceId: request.source?.preferredSourceId,
        replayed: false,
      },
    });
    expect(fixture.registerGroundItemSourceAsync).toHaveBeenCalledOnce();
    expect(fixture.deletes).toEqual([]);
    expect(fixture.updates).toEqual([
      expect.objectContaining({
        table: schema.operationsLog,
        values: expect.objectContaining({
          completed: true,
          completedAt: NOW,
          operationState: expect.objectContaining({
            version: 2,
            status: "fired",
            sourceId: request.source?.preferredSourceId,
          }),
        }),
      }),
    ]);
  });

  it("refunds a staged cancellation to the original equipment slot", async () => {
    const request = shotRequest(null, "ammunition-shot:00112233445566778899");
    const fixture = createFixture({
      existing: storedPendingOperation(request),
      equipmentRows: [
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
        { slotType: "arrows", itemId: ITEM_ID, quantity: 1 },
      ],
    });

    await expect(
      fixture.system.cancelAmmunitionShotOperationAsync({
        operationId: request.operationId,
        playerId: request.playerId,
        requestFingerprint: request.requestFingerprint,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      status: "cancelled",
      refundDestination: "equipment",
      committed: expect.arrayContaining([
        { slotType: "arrows", itemId: ITEM_ID, quantity: 2 },
      ]),
      source: null,
    });
    expect(fixture.registerGroundItemSourceAsync).not.toHaveBeenCalled();
    expect(fixture.deletes).toEqual([schema.equipment]);
    expect(fixture.inserts).toEqual([
      expect.objectContaining({
        table: schema.equipment,
        values: expect.arrayContaining([
          expect.objectContaining({
            slotType: "arrows",
            itemId: ITEM_ID,
            quantity: 2,
          }),
        ]),
      }),
    ]);
    expect(fixture.updates).toEqual([
      expect.objectContaining({
        table: schema.operationsLog,
        values: expect.objectContaining({
          completed: true,
          operationState: expect.objectContaining({
            status: "cancelled",
            refundDestination: "equipment",
          }),
        }),
      }),
    ]);
  });

  it("resolves an already-fired cancellation without refunding its spent arrow", async () => {
    const request = shotRequest();
    const fixture = createFixture({
      existing: storedFiredOperation(request),
      sourceReplayed: true,
      equipmentRows: [
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
        { slotType: "arrows", itemId: ITEM_ID, quantity: 1 },
      ],
    });

    await expect(
      fixture.system.cancelAmmunitionShotOperationAsync({
        operationId: request.operationId,
        playerId: request.playerId,
        requestFingerprint: request.requestFingerprint,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      status: "resolved",
      refundDestination: null,
      committed: expect.arrayContaining([
        { slotType: "arrows", itemId: ITEM_ID, quantity: 1 },
      ]),
      source: {
        sourceId: request.source?.preferredSourceId,
        replayed: true,
      },
    });
    expect(fixture.deletes).toEqual([]);
    expect(fixture.inserts).toEqual([]);
    expect(fixture.updates).toEqual([
      expect.objectContaining({
        table: schema.operationsLog,
        values: expect.objectContaining({
          operationState: expect.objectContaining({
            status: "resolved",
            refundDestination: null,
          }),
        }),
      }),
    ]);
  });

  it("recovers every interrupted staged shot through the idempotent cancel boundary", async () => {
    const first = shotRequest(null, "ammunition-shot:11112222333344445555");
    const second = shotRequest(null, "ammunition-shot:55554444333322221111");
    const rows = [first, second].map((request) => ({
      operationId: request.operationId,
      operationState: storedPendingOperation(request).operationState,
      completed: false,
    }));
    const system = new DatabaseSystem({} as never);
    const cancel = vi.fn(async (request: any) => ({
      operationId: request.operationId,
      playerId: request.playerId,
      requestFingerprint: request.requestFingerprint,
      replayed: false,
      itemId: ITEM_ID,
      quantity: 1 as const,
      recoveryDisposition: "destroyed" as const,
      status: "cancelled" as const,
      committed: [],
      committedInventory: [],
      refundDestination: "equipment" as const,
      sourceRequest: null,
      source: null,
    }));
    const internals = system as unknown as {
      db: {
        select: () => {
          from: () => {
            where: () => { orderBy: () => Promise<typeof rows> };
          };
        };
      };
      isDestroying: boolean;
      cancelAmmunitionShotOperationAsync: typeof cancel;
    };
    internals.db = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: async () => rows }) }),
      }),
    };
    internals.isDestroying = false;
    internals.cancelAmmunitionShotOperationAsync = cancel;

    await expect(
      system.recoverPendingAmmunitionShotOperationsAsync(PLAYER_ID),
    ).resolves.toHaveLength(2);
    expect(cancel.mock.calls.map(([request]) => request)).toEqual([
      {
        operationId: first.operationId,
        playerId: PLAYER_ID,
        requestFingerprint: first.requestFingerprint,
      },
      {
        operationId: second.operationId,
        playerId: PLAYER_ID,
        requestFingerprint: second.requestFingerprint,
      },
    ]);
  });

  it("fails replacement recovery before mutation when a fired shot has no durable impact", async () => {
    const pending = shotRequest(null, "ammunition-shot:11112222333344445555");
    const fired = shotRequest(null, "ammunition-shot:55554444333322221111");
    const rows = [
      {
        operationId: pending.operationId,
        operationState: storedPendingOperation(pending).operationState,
        completed: false,
      },
      {
        operationId: fired.operationId,
        operationState: storedFiredOperation(fired).operationState,
        completed: true,
      },
    ];
    const system = new DatabaseSystem({} as never);
    const cancel = vi.fn();
    const internals = system as unknown as {
      db: {
        select: () => {
          from: () => {
            where: () => { orderBy: () => Promise<typeof rows> };
          };
        };
      };
      isDestroying: boolean;
      cancelAmmunitionShotOperationAsync: typeof cancel;
    };
    internals.db = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: async () => rows }) }),
      }),
    };
    internals.isDestroying = false;
    internals.cancelAmmunitionShotOperationAsync = cancel;

    await expect(
      system.recoverPendingAmmunitionShotOperationsAsync(PLAYER_ID),
    ).rejects.toThrow("ammunition_shot_fired_reconciliation_required");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects malformed recovery policy and operation collisions before debit", async () => {
    const request = shotRequest();
    const malformed = {
      ...request,
      source: { ...request.source!, droppedBy: "someone-else" },
    };
    const malformedFixture = createFixture();
    await expect(
      malformedFixture.system.commitAmmunitionShotOperationAsync(malformed),
    ).rejects.toThrow("ammunition_shot_request_invalid");
    expect(
      malformedFixture.internals.executeInTransaction,
    ).not.toHaveBeenCalled();

    const collision = createFixture({
      existing: {
        ...storedOperation(request),
        operationState: {
          ...storedOperation(request).operationState,
          itemId: "iron_arrow",
        },
      },
    });
    await expect(
      collision.system.commitAmmunitionShotOperationAsync(request),
    ).rejects.toThrow("ammunition_shot_operation_id_conflict");
    expect(collision.deletes).toEqual([]);
  });
});
