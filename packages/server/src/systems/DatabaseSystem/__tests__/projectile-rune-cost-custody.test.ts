import { createHash } from "node:crypto";

import { ITEMS } from "@hyperforge/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../database/schema.js";
import type {
  InventoryDebitRequirement,
  ProjectileRuneCostCommitRequest,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const PLAYER_ID = "projectile-rune-agent";
const NOW = 1_788_087_700_000;
const priorAir = ITEMS.get("air_rune");
const priorMind = ITEMS.get("mind_rune");

beforeAll(() => {
  for (const itemId of ["air_rune", "mind_rune"]) {
    ITEMS.set(itemId, {
      id: itemId,
      name: itemId,
      type: "misc",
      stackable: true,
    } as never);
  }
});

afterAll(() => {
  if (priorAir) ITEMS.set("air_rune", priorAir);
  else ITEMS.delete("air_rune");
  if (priorMind) ITEMS.set("mind_rune", priorMind);
  else ITEMS.delete("mind_rune");
});

function fingerprint(requirements: InventoryDebitRequirement[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, playerId: PLAYER_ID, requirements }))
    .digest("hex");
}

function request(
  operationId = "spell-runes:1234567890abcdefghij",
): ProjectileRuneCostCommitRequest {
  const requirements = [
    { itemId: "air_rune", quantity: 2 },
    { itemId: "mind_rune", quantity: 1 },
  ];
  return {
    operationId,
    playerId: PLAYER_ID,
    requestFingerprint: fingerprint(requirements),
    requirements,
  };
}

function pendingOperation(input: ProjectileRuneCostCommitRequest) {
  return {
    playerId: PLAYER_ID,
    operationType: "projectile_rune_cost",
    completed: false,
    operationState: {
      version: 1,
      requestFingerprint: input.requestFingerprint,
      requirements: input.requirements,
      committed: [
        { itemId: "air_rune", quantity: 8, slotIndex: 0, metadata: null },
        { itemId: "mind_rune", quantity: 4, slotIndex: 1, metadata: null },
      ],
      status: "pending",
      refundDestination: null,
    },
  };
}

function firedOperation(input: ProjectileRuneCostCommitRequest) {
  const pending = pendingOperation(input);
  return {
    ...pending,
    completed: true,
    operationState: {
      ...pending.operationState,
      status: "fired" as const,
    },
  };
}

function fixture(
  existing?:
    ReturnType<typeof pendingOperation> | ReturnType<typeof firedOperation>,
) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const deletes: unknown[] = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const inventoryRows = existing
    ? [
        { itemId: "air_rune", quantity: 8, slotIndex: 0, metadata: null },
        { itemId: "mind_rune", quantity: 4, slotIndex: 1, metadata: null },
      ]
    : [
        { itemId: "air_rune", quantity: 10, slotIndex: 0, metadata: null },
        { itemId: "mind_rune", quantity: 5, slotIndex: 1, metadata: null },
      ];
  const tx = {
    execute: vi.fn(async () => ({ rows: [{ databaseNow: NOW }] })),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: vi.fn(async () => {
          if (table === schema.characters) return [{ id: PLAYER_ID }];
          if (table === schema.operationsLog) return existing ? [existing] : [];
          if (table === schema.inventory) return inventoryRows;
          if (table === schema.bankStorage) return [];
          throw new Error("unexpected table");
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
  return { system, internals, inserts, deletes, updates };
}

describe("DatabaseSystem projectile rune cost custody", () => {
  it("stages the complete multi-rune debit as one pending operation", async () => {
    const input = request();
    const test = fixture();
    await expect(
      test.system.commitProjectileRuneCostOperationAsync(input),
    ).resolves.toMatchObject({
      replayed: false,
      status: "pending",
      refundDestination: null,
      requirements: input.requirements,
      committed: [
        { itemId: "air_rune", quantity: 8 },
        { itemId: "mind_rune", quantity: 4 },
      ],
    });
    expect(test.deletes).toEqual([schema.inventory]);
    expect(test.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: schema.inventory }),
        expect.objectContaining({
          table: schema.operationsLog,
          values: expect.objectContaining({
            operationType: "projectile_rune_cost",
            completed: false,
            completedAt: null,
          }),
        }),
      ]),
    );
  });

  it("finalizes an admitted projectile without another inventory mutation", async () => {
    const input = request();
    const test = fixture(pendingOperation(input));
    await expect(
      test.system.completeProjectileRuneCostOperationAsync({
        operationId: input.operationId,
        playerId: input.playerId,
        requestFingerprint: input.requestFingerprint,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      status: "fired",
      refundDestination: null,
    });
    expect(test.deletes).toEqual([]);
    expect(test.updates).toEqual([
      expect.objectContaining({
        table: schema.operationsLog,
        values: expect.objectContaining({
          completed: true,
          operationState: expect.objectContaining({ status: "fired" }),
        }),
      }),
    ]);
  });

  it("refunds every staged rune when launch admission is cancelled", async () => {
    const input = request("spell-runes:abcdefghij1234567890");
    const test = fixture(pendingOperation(input));
    await expect(
      test.system.cancelProjectileRuneCostOperationAsync({
        operationId: input.operationId,
        playerId: input.playerId,
        requestFingerprint: input.requestFingerprint,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      status: "cancelled",
      refundDestination: "inventory",
      committed: [
        { itemId: "air_rune", quantity: 10 },
        { itemId: "mind_rune", quantity: 5 },
      ],
    });
    expect(test.deletes).toEqual([schema.inventory]);
    expect(test.updates).toEqual([
      expect.objectContaining({
        table: schema.operationsLog,
        values: expect.objectContaining({
          completed: true,
          operationState: expect.objectContaining({
            status: "cancelled",
            refundDestination: "inventory",
          }),
        }),
      }),
    ]);
  });

  it("resolves an already-fired cancellation without refunding spent runes", async () => {
    const input = request("spell-runes:11223344556677889900");
    const test = fixture(firedOperation(input));
    await expect(
      test.system.cancelProjectileRuneCostOperationAsync({
        operationId: input.operationId,
        playerId: input.playerId,
        requestFingerprint: input.requestFingerprint,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      status: "resolved",
      refundDestination: null,
      committed: [
        { itemId: "air_rune", quantity: 8 },
        { itemId: "mind_rune", quantity: 4 },
      ],
    });
    expect(test.deletes).toEqual([]);
    expect(test.inserts).toEqual([]);
    expect(test.updates).toEqual([
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

  it("rejects non-rune refund identities before any transaction", async () => {
    const input = request();
    input.requirements = [{ itemId: "shortbow", quantity: 1 }];
    input.requestFingerprint = fingerprint(input.requirements);
    const test = fixture();
    await expect(
      test.system.commitProjectileRuneCostOperationAsync(input),
    ).rejects.toThrow("projectile_rune_cost_request_invalid");
    expect(test.internals.executeInTransaction).not.toHaveBeenCalled();
  });

  it("recovers interrupted costs through the exact cancellation identity", async () => {
    const input = request("spell-runes:99998888777766665555");
    const row = {
      operationId: input.operationId,
      operationState: pendingOperation(input).operationState,
      completed: false,
    };
    const system = new DatabaseSystem({} as never);
    const cancel = vi.fn(async (settlement: any) => ({
      ...settlement,
      replayed: false,
      requirements: input.requirements,
      status: "cancelled" as const,
      committed: [],
      refundDestination: "inventory" as const,
    }));
    const internals = system as unknown as {
      db: {
        select: () => {
          from: () => {
            where: () => { orderBy: () => Promise<Array<typeof row>> };
          };
        };
      };
      isDestroying: boolean;
      cancelProjectileRuneCostOperationAsync: typeof cancel;
    };
    internals.db = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: async () => [row] }) }),
      }),
    };
    internals.isDestroying = false;
    internals.cancelProjectileRuneCostOperationAsync = cancel;

    await expect(
      system.recoverPendingProjectileRuneCostOperationsAsync(PLAYER_ID),
    ).resolves.toHaveLength(1);
    expect(cancel).toHaveBeenCalledWith({
      operationId: input.operationId,
      playerId: PLAYER_ID,
      requestFingerprint: input.requestFingerprint,
    });
  });

  it("fails replacement recovery before mutation when fired runes have no durable impact", async () => {
    const pending = request("spell-runes:99998888777766665555");
    const fired = request("spell-runes:55556666777788889999");
    const rows = [
      {
        operationId: pending.operationId,
        operationState: pendingOperation(pending).operationState,
        completed: false,
      },
      {
        operationId: fired.operationId,
        operationState: firedOperation(fired).operationState,
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
      cancelProjectileRuneCostOperationAsync: typeof cancel;
    };
    internals.db = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: async () => rows }) }),
      }),
    };
    internals.isDestroying = false;
    internals.cancelProjectileRuneCostOperationAsync = cancel;

    await expect(
      system.recoverPendingProjectileRuneCostOperationsAsync(PLAYER_ID),
    ).rejects.toThrow("projectile_rune_cost_fired_reconciliation_required");
    expect(cancel).not.toHaveBeenCalled();
  });
});
