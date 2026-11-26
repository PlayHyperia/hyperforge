import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ITEMS } from "@hyperforge/shared";
import {
  executeAuthoritativeAgentBankTransfer,
  getDuelPreparationBankId,
  openAuthoritativeAgentBank,
} from "../AuthoritativeAgentBanking";

type InventoryRow = {
  id: number;
  itemId: string;
  quantity: number;
  slotIndex: number;
};
type BankRow = {
  id: number;
  itemId: string;
  quantity: number;
  slot: number;
  tabIndex: number;
};
type BankOperationRow = {
  operationId: string;
  preparationId: string | null;
  requestFingerprint: string;
  committedQuantity: number;
  inventoryQuantityAfter: number;
  bankQuantityAfter: number | null;
  itemCount: number;
};
type BankOperationItemRow = {
  operationId: string;
  itemId: string;
  requestedQuantity: number;
  committedQuantity: number;
  inventoryQuantityAfter: number;
  bankQuantityAfter: number;
};
type BankOpenAuditRow = {
  operationId: string;
  preparationId: string;
  playerId: string;
  bankId: string;
};

function createBankHarness(input?: {
  inventory?: InventoryRow[];
  bank?: BankRow[];
  bankPosition?: [number, number, number];
  commitFails?: boolean;
  connectFails?: boolean;
  reloadFails?: boolean;
  onPreparationAccess?: () => void;
  preparation?: {
    preparationId: string;
    status?: "preparing" | "ready" | "frozen" | "cancelled" | "expired";
    agent1Id?: string;
    agent2Id?: string;
    agent1ReadyAt?: number | null;
    agent2ReadyAt?: number | null;
    expiresAt?: number;
    hostLeaseActive?: boolean;
    allowedBankActions?: Array<"open" | "deposit" | "withdraw" | "deposit_all">;
  };
}) {
  const inventoryRows = (input?.inventory ?? []).map((row) => ({ ...row }));
  const bankRows = (input?.bank ?? []).map((row) => ({ ...row }));
  const bankOperationRows: BankOperationRow[] = [];
  const bankOperationItemRows: BankOperationItemRow[] = [];
  const bankOpenAuditRows: BankOpenAuditRow[] = [];
  let commitFailuresRemaining = input?.commitFails ? 1 : 0;
  let nextId = 100;
  let transactionSnapshot: {
    inventory: InventoryRow[];
    bank: BankRow[];
    operations: BankOperationRow[];
    operationItems: BankOperationItemRow[];
    openAudits: BankOpenAuditRow[];
    nextId: number;
  } | null = null;
  const query = vi.fn(async (sqlInput: string, params: unknown[] = []) => {
    const sql = String(sqlInput).replace(/\s+/g, " ").trim();
    if (sql === "BEGIN") {
      transactionSnapshot = {
        inventory: inventoryRows.map((row) => ({ ...row })),
        bank: bankRows.map((row) => ({ ...row })),
        operations: bankOperationRows.map((row) => ({ ...row })),
        operationItems: bankOperationItemRows.map((row) => ({ ...row })),
        openAudits: bankOpenAuditRows.map((row) => ({ ...row })),
        nextId,
      };
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      if (transactionSnapshot) {
        inventoryRows.splice(
          0,
          inventoryRows.length,
          ...transactionSnapshot.inventory,
        );
        bankRows.splice(0, bankRows.length, ...transactionSnapshot.bank);
        bankOperationRows.splice(
          0,
          bankOperationRows.length,
          ...transactionSnapshot.operations,
        );
        bankOperationItemRows.splice(
          0,
          bankOperationItemRows.length,
          ...transactionSnapshot.operationItems,
        );
        bankOpenAuditRows.splice(
          0,
          bankOpenAuditRows.length,
          ...transactionSnapshot.openAudits,
        );
        nextId = transactionSnapshot.nextId;
      }
      transactionSnapshot = null;
      return { rows: [] };
    }
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
    if (sql === "COMMIT") {
      transactionSnapshot = null;
      if (commitFailuresRemaining > 0) {
        commitFailuresRemaining -= 1;
        throw new Error("connection lost during commit");
      }
      return { rows: [] };
    }
    if (
      sql.includes('clock.now_ms AS "databaseNow"') &&
      sql.includes("FROM streaming_duel_preparations")
    ) {
      input?.onPreparationAccess?.();
      const preparation = input?.preparation;
      if (!preparation || preparation.preparationId !== params[0]) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            preparationId: preparation.preparationId,
            fencingToken: "1",
            agent1Id: preparation.agent1Id ?? "agent-1",
            agent2Id: preparation.agent2Id ?? "agent-2",
            allowedBankActions: preparation.allowedBankActions ?? [
              "open",
              "deposit",
              "withdraw",
              "deposit_all",
            ],
            status: preparation.status ?? "preparing",
            selectedAt: Date.now() - 1_000,
            expiresAt: preparation.expiresAt ?? Date.now() + 60_000,
            agent1ReadyAt: preparation.agent1ReadyAt ?? null,
            agent2ReadyAt: preparation.agent2ReadyAt ?? null,
            frozenAt: null,
            cancelledAt: null,
            cancellationReason: null,
            version: 1,
            databaseNow: Date.now(),
            contestantUnavailable: false,
            contestantHostLeaseActive: preparation.hostLeaseActive ?? true,
          },
        ],
      };
    }
    if (
      sql.startsWith(
        'SELECT "preparationId", "requestFingerprint", "committedQuantity", "inventoryQuantityAfter", "bankQuantityAfter"',
      )
    ) {
      return {
        rows: bankOperationRows
          .filter((row) => row.operationId === params[0])
          .map((row) => ({ ...row })),
      };
    }
    if (sql.startsWith("INSERT INTO agent_bank_operations")) {
      bankOperationRows.push({
        operationId: String(params[0]),
        preparationId: params[4] === null ? null : String(params[4]),
        committedQuantity: Number(params[7]),
        inventoryQuantityAfter: Number(params[8]),
        bankQuantityAfter: params[9] === null ? null : Number(params[9]),
        requestFingerprint: String(params[10]),
        itemCount: Number(params[11]),
      });
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO agent_bank_operation_items")) {
      bankOperationItemRows.push({
        operationId: String(params[0]),
        itemId: String(params[1]),
        requestedQuantity: Number(params[2]),
        committedQuantity: Number(params[3]),
        inventoryQuantityAfter: Number(params[4]),
        bankQuantityAfter: Number(params[5]),
      });
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO streaming_duel_bank_open_events")) {
      bankOpenAuditRows.push({
        operationId: String(params[0]),
        preparationId: String(params[1]),
        playerId: String(params[2]),
        bankId: String(params[3]),
      });
      return { rows: [] };
    }
    if (
      sql.includes('SELECT "itemId", quantity, slot, "tabIndex"') &&
      sql.includes("FROM bank_storage")
    ) {
      return { rows: bankRows.map((row) => ({ ...row })) };
    }
    if (
      sql.startsWith("SELECT id, quantity FROM inventory") &&
      sql.includes('AND "itemId" = $2')
    ) {
      return {
        rows: inventoryRows
          .filter((row) => row.itemId === params[1])
          .map((row) => ({ id: row.id, quantity: row.quantity })),
      };
    }
    if (
      sql.startsWith("SELECT id, quantity FROM bank_storage") &&
      sql.includes('AND "itemId" = $2')
    ) {
      return {
        rows: bankRows
          .filter((row) => row.itemId === params[1])
          .map((row) => ({ id: row.id, quantity: row.quantity })),
      };
    }
    if (sql.startsWith("SELECT COUNT(*)::int AS count FROM bank_storage")) {
      return { rows: [{ count: bankRows.length }] };
    }
    if (
      sql.startsWith("SELECT slot FROM bank_storage") &&
      sql.includes('"tabIndex" = 0')
    ) {
      return {
        rows: bankRows
          .filter((row) => row.tabIndex === 0)
          .map((row) => ({ slot: row.slot })),
      };
    }
    if (sql.startsWith("DELETE FROM inventory WHERE id = $1")) {
      const index = inventoryRows.findIndex((row) => row.id === params[0]);
      if (index >= 0) inventoryRows.splice(index, 1);
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM inventory WHERE "playerId" = $1')) {
      inventoryRows.length = 0;
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE inventory SET quantity = $1 WHERE id = $2")) {
      const row = inventoryRows.find((entry) => entry.id === params[1]);
      if (row) row.quantity = Number(params[0]);
      return { rows: [] };
    }
    if (
      sql.startsWith(
        "UPDATE bank_storage SET quantity = quantity + $1 WHERE id = $2",
      )
    ) {
      const row = bankRows.find((entry) => entry.id === params[1]);
      if (row) row.quantity += Number(params[0]);
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO bank_storage")) {
      bankRows.push({
        id: nextId++,
        itemId: String(params[1]),
        quantity: Number(params[2]),
        slot: Number(params[3]),
        tabIndex: 0,
      });
      return { rows: [] };
    }
    if (
      sql.startsWith(
        'SELECT id, "itemId", quantity, "slotIndex" FROM inventory',
      )
    ) {
      return { rows: inventoryRows.map((row) => ({ ...row })) };
    }
    if (sql.startsWith('SELECT id, "itemId", quantity FROM inventory')) {
      return { rows: inventoryRows.map((row) => ({ ...row })) };
    }
    if (
      sql.startsWith('SELECT id, quantity, slot, "tabIndex" FROM bank_storage')
    ) {
      return {
        rows: bankRows
          .filter((row) => row.itemId === params[1])
          .map((row) => ({ ...row })),
      };
    }
    if (
      sql.startsWith(
        'SELECT id, "itemId", quantity, slot, "tabIndex" FROM bank_storage',
      )
    ) {
      return { rows: bankRows.map((row) => ({ ...row })) };
    }
    if (sql.startsWith("UPDATE bank_storage SET quantity = $1 WHERE id = $2")) {
      const row = bankRows.find((entry) => entry.id === params[1]);
      if (row) row.quantity = Number(params[0]);
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM bank_storage WHERE id = $1")) {
      const index = bankRows.findIndex((row) => row.id === params[0]);
      if (index >= 0) bankRows.splice(index, 1);
      return { rows: [] };
    }
    if (sql.includes("SET slot = slot + 1000")) {
      for (const row of bankRows) {
        if (row.tabIndex === params[1] && row.slot > Number(params[2])) {
          row.slot += 1000;
        }
      }
      return { rows: [] };
    }
    if (sql.includes("SET slot = slot - 1001")) {
      for (const row of bankRows) {
        if (row.tabIndex === params[1] && row.slot > 1000) row.slot -= 1001;
      }
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE inventory SET quantity = quantity + $1")) {
      const row = inventoryRows.find((entry) => entry.id === params[1]);
      if (row) row.quantity += Number(params[0]);
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO inventory")) {
      inventoryRows.push({
        id: nextId++,
        itemId: String(params[1]),
        quantity: sql.includes("VALUES ($1, $2, 1, $3") ? 1 : Number(params[2]),
        slotIndex: Number(
          sql.includes("VALUES ($1, $2, 1, $3") ? params[2] : params[3],
        ),
      });
      return { rows: [] };
    }
    throw new Error(`Unhandled SQL in test: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = {
    connect: vi.fn(async () => {
      if (input?.connectFails) throw new Error("database unavailable");
      return client;
    }),
    query,
  };
  const inventorySystem = {
    isInventoryReady: vi.fn(() => true),
    queueOperation: vi.fn(
      async (_playerId: string, operation: () => Promise<boolean>) =>
        operation(),
    ),
    lockForTransaction: vi.fn(() => true),
    unlockTransaction: vi.fn(),
    persistInventoryImmediate: vi.fn(async () => {}),
    reloadFromDatabase: vi.fn(async () => {
      if (input?.reloadFails) throw new Error("reload failed");
    }),
  };
  const entities = new Map([
    [
      "agent-1",
      { position: { x: 0, y: 0, z: 0 }, data: { inStreamingDuel: false } },
    ],
    [
      "bank-1",
      {
        position: {
          x: input?.bankPosition?.[0] ?? 1,
          y: input?.bankPosition?.[1] ?? 0,
          z: input?.bankPosition?.[2] ?? 1,
        },
        data: { type: "bank", name: "Preparation Bank" },
      },
    ],
  ]);
  const world = {
    pgPool: pool,
    entities: { get: (id: string) => entities.get(id) },
    getSystem: (name: string) =>
      name === "inventory" ? inventorySystem : null,
  };
  return {
    world,
    entities,
    inventoryRows,
    bankRows,
    bankOperationRows,
    bankOperationItemRows,
    bankOpenAuditRows,
    inventorySystem,
    pool,
    client,
  };
}

describe("authoritative embedded-agent banking", () => {
  const itemIds = ["bank_test_stack", "bank_test_item"];
  const previousItems = new Map<string, unknown>();

  beforeEach(() => {
    for (const itemId of itemIds) previousItems.set(itemId, ITEMS.get(itemId));
    ITEMS.set("bank_test_stack", {
      id: "bank_test_stack",
      name: "Bank Test Stack",
      type: "resource",
      stackable: true,
    } as never);
    ITEMS.set("bank_test_item", {
      id: "bank_test_item",
      name: "Bank Test Item",
      type: "resource",
      stackable: false,
    } as never);
  });

  afterEach(() => {
    for (const itemId of itemIds) {
      const previous = previousItems.get(itemId);
      if (previous) ITEMS.set(itemId, previous as never);
      else ITEMS.delete(itemId);
    }
    previousItems.clear();
  });

  it("opens only a nearby authoritative bank and returns its durable state", async () => {
    const harness = createBankHarness({
      bank: [
        { id: 1, itemId: "bank_test_item", quantity: 4, slot: 0, tabIndex: 0 },
      ],
    });

    const receipt = await openAuthoritativeAgentBank({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
    });

    expect(receipt).toMatchObject({
      success: true,
      commitState: "not_applicable",
      action: "open",
      playerId: "agent-1",
      bankId: "bank-1",
      bankItems: [
        { itemId: "bank_test_item", quantity: 4, slot: 0, tabIndex: 0 },
      ],
    });
    expect(receipt.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects remote physical access before touching storage", async () => {
    const harness = createBankHarness({ bankPosition: [10, 0, 10] });
    const receipt = await openAuthoritativeAgentBank({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
    });

    expect(receipt).toMatchObject({
      success: false,
      failureReason: "bank_out_of_range",
    });
    expect(harness.pool.query).not.toHaveBeenCalled();
  });

  it("rejects a nearby display-name lookalike before touching storage", async () => {
    const harness = createBankHarness();
    harness.entities.set("decorative-bank-sign", {
      position: { x: 1, y: 0, z: 0 },
      data: { type: "decoration", name: "Bank" },
    });

    const receipt = await openAuthoritativeAgentBank({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "decorative-bank-sign",
    });

    expect(receipt).toMatchObject({
      success: false,
      failureReason: "bank_target_invalid",
    });
    expect(harness.pool.query).not.toHaveBeenCalled();
  });

  it("opens a contestant-owned bank remotely only through an active preparation", async () => {
    const preparationId = "9a01ad8d-ad1e-46c5-93c0-42fac40e48d8";
    const harness = createBankHarness({
      bankPosition: [500, 0, 500],
      preparation: { preparationId },
      bank: [
        { id: 1, itemId: "bank_test_item", quantity: 3, slot: 0, tabIndex: 0 },
      ],
    });
    const receipt = await openAuthoritativeAgentBank({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
    });

    expect(receipt).toMatchObject({
      success: true,
      bankId: getDuelPreparationBankId(preparationId),
      bankItems: [expect.objectContaining({ quantity: 3 })],
    });
    expect(harness.bankOpenAuditRows).toEqual([
      {
        operationId: receipt.operationId,
        preparationId,
        playerId: "agent-1",
        bankId: getDuelPreparationBankId(preparationId),
      },
    ]);
    expect(harness.client.query).toHaveBeenCalledWith("BEGIN");
    expect(harness.client.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR SHARE OF preparation"),
      [preparationId, "agent-1"],
    );
    expect(harness.client.query).toHaveBeenCalledWith("COMMIT");
    expect(harness.client.release).toHaveBeenCalledWith();
  });

  it("rejects a virtual preparation bank when no preparation capability is supplied", async () => {
    const harness = createBankHarness();
    const receipt = await openAuthoritativeAgentBank({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId("6997b3ea-a485-4982-87e6-0dc18a091962"),
    });

    expect(receipt).toMatchObject({
      success: false,
      failureReason: "bank_target_invalid",
    });
    expect(harness.pool.query).not.toHaveBeenCalled();
  });

  it("rejects a virtual preparation transfer when no preparation capability is supplied", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId("3ce87d94-a55c-44cc-bd67-4791ecdd2842"),
      action: "deposit",
      itemId: "bank_test_item",
      quantity: 1,
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "bank_target_invalid",
    });
    expect(harness.pool.connect).not.toHaveBeenCalled();
    expect(harness.inventoryRows).toHaveLength(1);
  });

  it("rejects preparation bank access for a non-contestant", async () => {
    const preparationId = "357c3e67-a645-4ee2-b9e8-977f957f3ea0";
    const harness = createBankHarness({
      preparation: {
        preparationId,
        agent1Id: "different-agent-1",
        agent2Id: "different-agent-2",
      },
    });
    const receipt = await openAuthoritativeAgentBank({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
    });

    expect(receipt).toMatchObject({
      success: false,
      failureReason: "preparation_agent_mismatch",
    });
    expect(harness.bankOpenAuditRows).toEqual([]);
    expect(harness.client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(harness.client.release).toHaveBeenCalledWith();
  });

  it("never permits preparation banking while the contestant is in a live duel", async () => {
    const preparationId = "41b8b8db-e7e6-4928-83c7-ac8500548f7e";
    const harness = createBankHarness({
      preparation: { preparationId },
    });
    const player = harness.entities.get("agent-1") as {
      data: { inStreamingDuel: boolean };
    };
    player.data.inStreamingDuel = true;
    const receipt = await openAuthoritativeAgentBank({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
    });

    expect(receipt).toMatchObject({
      success: false,
      failureReason: "duel_locked",
    });
    expect(harness.pool.query).not.toHaveBeenCalled();
  });

  it("rejects preparation bank open for a dead contestant without writing an audit event", async () => {
    const preparationId = "388c98e4-1e53-4f7f-9d6f-55143831e31f";
    const harness = createBankHarness({ preparation: { preparationId } });
    const player = harness.entities.get("agent-1") as {
      data: { health?: number; alive?: boolean };
    };
    player.data.health = 0;
    player.data.alive = false;

    const receipt = await openAuthoritativeAgentBank({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
    });

    expect(receipt).toMatchObject({
      success: false,
      failureReason: "player_unavailable",
    });
    expect(harness.bankOpenAuditRows).toEqual([]);
    expect(harness.pool.connect).not.toHaveBeenCalled();
  });

  it("rechecks contestant life after locking preparation authority before bank open", async () => {
    const preparationId = "483509cf-8ef3-43c7-9628-7487cd4a88dd";
    let markContestantDead = () => {};
    const harness = createBankHarness({
      preparation: { preparationId },
      onPreparationAccess: () => markContestantDead(),
    });
    const player = harness.entities.get("agent-1") as {
      data: { health?: number; alive?: boolean };
    };
    player.data.health = 10;
    player.data.alive = true;
    markContestantDead = () => {
      player.data.health = 0;
      player.data.alive = false;
    };

    const receipt = await openAuthoritativeAgentBank({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
    });

    expect(receipt).toMatchObject({
      success: false,
      failureReason: "player_unavailable",
    });
    expect(harness.client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(harness.bankOpenAuditRows).toEqual([]);
  });

  it("rechecks contestant life after locking preparation authority before mutation", async () => {
    const preparationId = "db7f441a-bbbf-4dd2-8a99-9db7d71e80c9";
    let markContestantDead = () => {};
    const harness = createBankHarness({
      preparation: { preparationId },
      onPreparationAccess: () => markContestantDead(),
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
    });
    const player = harness.entities.get("agent-1") as {
      data: { health?: number; alive?: boolean };
    };
    player.data.health = 10;
    player.data.alive = true;
    markContestantDead = () => {
      player.data.health = 0;
      player.data.alive = false;
    };

    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
      action: "deposit",
      itemId: "bank_test_item",
      quantity: 1,
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "player_unavailable",
    });
    expect(harness.inventoryRows).toEqual([
      { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
    ]);
    expect(harness.bankOperationRows).toEqual([]);
  });

  it("deposits exactly the owned quantity and returns committed post-state", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
        { id: 2, itemId: "bank_test_item", quantity: 1, slotIndex: 1 },
      ],
      bank: [
        { id: 3, itemId: "bank_test_item", quantity: 5, slot: 0, tabIndex: 0 },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit",
      itemId: "bank_test_item",
      quantity: 2,
    });

    expect(receipt).toMatchObject({
      success: true,
      commitState: "committed",
      replayed: false,
      action: "deposit",
      requestedQuantity: 2,
      committedQuantity: 2,
      inventoryQuantityAfter: 0,
      bankQuantityAfter: 7,
    });
    expect(harness.inventoryRows).toEqual([]);
    expect(harness.bankRows[0]?.quantity).toBe(7);
    expect(
      harness.inventorySystem.persistInventoryImmediate,
    ).toHaveBeenCalledOnce();
    expect(harness.inventorySystem.reloadFromDatabase).toHaveBeenCalledOnce();
    expect(harness.inventorySystem.unlockTransaction).toHaveBeenCalledOnce();
    expect(harness.client.release).toHaveBeenCalledWith(false);
  });

  it("commits a remote transfer while the contestant's preparation remains mutable", async () => {
    const preparationId = "b28e8640-bc4c-4255-bc83-047186575b26";
    const harness = createBankHarness({
      bankPosition: [500, 0, 500],
      preparation: { preparationId },
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
      action: "deposit",
      itemId: "bank_test_item",
      quantity: 1,
    });

    expect(receipt).toMatchObject({
      success: true,
      commitState: "committed",
      committedQuantity: 1,
    });
    expect(harness.inventoryRows).toEqual([]);
    expect(harness.bankRows[0]?.quantity).toBe(1);
    expect(harness.bankOperationRows).toEqual([
      expect.objectContaining({ preparationId }),
    ]);
  });

  it("rejects remote preparation-bank access when the contestant host lease is absent", async () => {
    const preparationId = "d07b37e8-a46d-4d09-b11b-08ae4325e0dc";
    const harness = createBankHarness({
      bankPosition: [500, 0, 500],
      preparation: { preparationId, hostLeaseActive: false },
      bank: [
        { id: 1, itemId: "bank_test_item", quantity: 3, slot: 0, tabIndex: 0 },
      ],
    });

    await expect(
      openAuthoritativeAgentBank({
        world: harness.world as never,
        playerId: "agent-1",
        bankId: getDuelPreparationBankId(preparationId),
        preparationId,
      }),
    ).resolves.toMatchObject({
      success: false,
      failureReason: "preparation_not_active",
    });
    expect(harness.bankOpenAuditRows).toEqual([]);
  });

  it("enforces the durable preparation operation allowlist", async () => {
    const preparationId = "2752ec20-dd79-4032-9a48-f87945204d42";
    const harness = createBankHarness({
      preparation: {
        preparationId,
        allowedBankActions: ["open"],
      },
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
      action: "deposit",
      itemId: "bank_test_item",
      quantity: 1,
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "preparation_action_not_allowed",
    });
    expect(harness.inventoryRows).toHaveLength(1);
    expect(harness.bankRows).toEqual([]);
  });

  it("rejects every transfer after that contestant confirms readiness", async () => {
    const preparationId = "9a642cc2-bfc2-4bed-b312-f1ef9f2c914c";
    const harness = createBankHarness({
      preparation: {
        preparationId,
        agent1ReadyAt: Date.now() - 1,
      },
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
      action: "deposit",
      itemId: "bank_test_item",
      quantity: 1,
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "preparation_agent_ready",
    });
    expect(harness.inventoryRows).toHaveLength(1);
    expect(harness.bankRows).toEqual([]);
    expect(harness.bankOperationRows).toEqual([]);
  });

  it("rejects an overdraw without mutating inventory or bank", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit",
      itemId: "bank_test_item",
      quantity: 2,
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "insufficient_inventory_quantity",
      committedQuantity: 0,
    });
    expect(harness.inventoryRows).toHaveLength(1);
    expect(harness.bankRows).toEqual([]);
  });

  it("withdraws into an existing stack even when every inventory slot is occupied", async () => {
    const inventory = Array.from({ length: 28 }, (_, slotIndex) => ({
      id: slotIndex + 1,
      itemId: slotIndex === 0 ? "bank_test_stack" : `filler_${slotIndex}`,
      quantity: slotIndex === 0 ? 3 : 1,
      slotIndex,
    }));
    const harness = createBankHarness({
      inventory,
      bank: [
        {
          id: 50,
          itemId: "bank_test_stack",
          quantity: 10,
          slot: 0,
          tabIndex: 0,
        },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "withdraw",
      itemId: "bank_test_stack",
      quantity: 5,
    });

    expect(receipt).toMatchObject({
      success: true,
      committedQuantity: 5,
      inventoryQuantityAfter: 8,
      bankQuantityAfter: 5,
    });
    expect(harness.inventoryRows[0]?.quantity).toBe(8);
    expect(harness.bankRows[0]?.quantity).toBe(5);
  });

  it("rejects a non-stackable withdrawal when capacity is insufficient", async () => {
    const inventory = Array.from({ length: 27 }, (_, slotIndex) => ({
      id: slotIndex + 1,
      itemId: `filler_${slotIndex}`,
      quantity: 1,
      slotIndex,
    }));
    const harness = createBankHarness({
      inventory,
      bank: [
        { id: 50, itemId: "bank_test_item", quantity: 2, slot: 0, tabIndex: 0 },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "withdraw",
      itemId: "bank_test_item",
      quantity: 2,
    });

    expect(receipt).toMatchObject({
      success: false,
      failureReason: "inventory_full",
    });
    expect(harness.inventoryRows).toHaveLength(27);
    expect(harness.bankRows[0]?.quantity).toBe(2);
  });

  it("reports an ambiguous commit without claiming success", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
      commitFails: true,
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit",
      itemId: "bank_test_item",
      quantity: 1,
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "unknown",
      failureReason: "commit_ambiguous",
      committedQuantity: 0,
    });
    expect(harness.inventorySystem.reloadFromDatabase).toHaveBeenCalledOnce();
    expect(harness.inventorySystem.unlockTransaction).toHaveBeenCalledOnce();
    expect(harness.client.release).toHaveBeenCalledWith(true);
  });

  it("resolves an ambiguous commit by replaying the same durable operation ID", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
      commitFails: true,
    });
    const operationId = "095859cb-42be-4ad0-8868-6f84600d8701";
    const request = {
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit" as const,
      itemId: "bank_test_item",
      quantity: 1,
      operationId,
    };

    const ambiguous = await executeAuthoritativeAgentBankTransfer(request);
    const reconciled = await executeAuthoritativeAgentBankTransfer(request);

    expect(ambiguous).toMatchObject({
      success: false,
      commitState: "unknown",
      failureReason: "commit_ambiguous",
    });
    expect(reconciled).toMatchObject({
      success: true,
      commitState: "committed",
      replayed: true,
      committedQuantity: 1,
      inventoryQuantityAfter: 0,
      bankQuantityAfter: 1,
    });
    expect(harness.inventoryRows).toEqual([]);
    expect(harness.bankRows[0]?.quantity).toBe(1);
    expect(harness.bankOperationRows).toHaveLength(1);
  });

  it("replays a committed operation ID without moving items twice", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 2, slotIndex: 0 },
      ],
    });
    const operationId = "14af1070-b1b5-46cd-886e-53624c9577c5";
    const request = {
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit" as const,
      itemId: "bank_test_item",
      quantity: 1,
      operationId,
    };

    const first = await executeAuthoritativeAgentBankTransfer(request);
    harness.inventorySystem.isInventoryReady.mockReturnValue(false);
    const replay = await executeAuthoritativeAgentBankTransfer(request);

    expect(first).toMatchObject({
      success: true,
      commitState: "committed",
      replayed: false,
      committedQuantity: 1,
    });
    expect(replay).toMatchObject({
      success: true,
      commitState: "committed",
      replayed: true,
      committedQuantity: 1,
      inventoryQuantityAfter: 1,
      bankQuantityAfter: 1,
    });
    expect(harness.inventoryRows).toEqual([
      expect.objectContaining({ quantity: 1 }),
    ]);
    expect(harness.bankRows).toEqual([
      expect.objectContaining({ quantity: 1 }),
    ]);
    expect(harness.bankOperationRows).toHaveLength(1);
    expect(
      harness.inventorySystem.persistInventoryImmediate,
    ).toHaveBeenCalledOnce();
    expect(harness.inventorySystem.reloadFromDatabase).toHaveBeenCalledTimes(2);
  });

  it("reconciles an exact committed preparation transfer after readiness freezes", async () => {
    const preparationId = "a2e94c29-3567-4570-96d1-f44efb5c2867";
    const preparation = {
      preparationId,
      agent1ReadyAt: null as number | null,
    };
    const harness = createBankHarness({
      preparation,
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
    });
    const request = {
      world: harness.world as never,
      playerId: "agent-1",
      bankId: getDuelPreparationBankId(preparationId),
      preparationId,
      action: "deposit" as const,
      itemId: "bank_test_item",
      quantity: 1,
      operationId: "84bc9372-32a6-4b4d-9dd1-a1c11d3c0495",
    };

    const first = await executeAuthoritativeAgentBankTransfer(request);
    preparation.agent1ReadyAt = Date.now();
    const replay = await executeAuthoritativeAgentBankTransfer(request);

    expect(first).toMatchObject({
      success: true,
      commitState: "committed",
      replayed: false,
    });
    expect(replay).toMatchObject({
      success: true,
      commitState: "committed",
      replayed: true,
      committedQuantity: 1,
      inventoryQuantityAfter: 0,
      bankQuantityAfter: 1,
    });
    expect(harness.inventoryRows).toEqual([]);
    expect(harness.bankRows).toEqual([
      expect.objectContaining({ itemId: "bank_test_item", quantity: 1 }),
    ]);
    expect(harness.bankOperationRows).toHaveLength(1);
  });

  it("rejects reuse of an operation ID for a different transfer", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 2, slotIndex: 0 },
      ],
    });
    const operationId = "23f4fc11-1721-4f15-945f-1890e46d18b2";
    const common = {
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit" as const,
      itemId: "bank_test_item",
      operationId,
    };

    await executeAuthoritativeAgentBankTransfer({ ...common, quantity: 1 });
    const conflict = await executeAuthoritativeAgentBankTransfer({
      ...common,
      quantity: 2,
    });

    expect(conflict).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "operation_id_conflict",
    });
    expect(harness.inventoryRows[0]?.quantity).toBe(1);
    expect(harness.bankRows[0]?.quantity).toBe(1);
    expect(harness.bankOperationRows).toHaveLength(1);
  });

  it("commits and replays an exact composite withdrawal as one receipt", async () => {
    const harness = createBankHarness({
      bank: [
        { id: 1, itemId: "bank_test_item", quantity: 4, slot: 0, tabIndex: 0 },
        {
          id: 2,
          itemId: "bank_test_stack",
          quantity: 10,
          slot: 1,
          tabIndex: 0,
        },
      ],
    });
    const operationId = "a229f13f-856d-4856-a089-ecfa25b10692";
    const request = {
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "withdraw" as const,
      withdrawItems: [
        { itemId: "bank_test_stack", quantity: 3 },
        { itemId: "bank_test_item", quantity: 2 },
      ],
      operationId,
    };

    const committed = await executeAuthoritativeAgentBankTransfer(request);
    const replayed = await executeAuthoritativeAgentBankTransfer({
      ...request,
      withdrawItems: [...request.withdrawItems].reverse(),
    });

    expect(committed).toMatchObject({
      success: true,
      replayed: false,
      action: "withdraw",
      itemId: null,
      requestedQuantity: 5,
      committedQuantity: 5,
      inventoryQuantityAfter: 5,
      bankQuantityAfter: null,
    });
    expect(replayed).toMatchObject({
      success: true,
      replayed: true,
      committedQuantity: 5,
    });
    expect(harness.bankOperationRows).toEqual([
      expect.objectContaining({ operationId, itemCount: 2 }),
    ]);
    expect(harness.bankOperationItemRows).toEqual([
      expect.objectContaining({
        itemId: "bank_test_item",
        committedQuantity: 2,
        bankQuantityAfter: 2,
      }),
      expect.objectContaining({
        itemId: "bank_test_stack",
        committedQuantity: 3,
        bankQuantityAfter: 7,
      }),
    ]);
    expect(harness.inventoryRows).toHaveLength(3);
    expect(harness.bankRows).toEqual([
      expect.objectContaining({ itemId: "bank_test_item", quantity: 2 }),
      expect.objectContaining({ itemId: "bank_test_stack", quantity: 7 }),
    ]);
  });

  it("rolls back every composite component when a later item is unavailable", async () => {
    const originalBank = [
      { id: 1, itemId: "bank_test_item", quantity: 2, slot: 0, tabIndex: 0 },
      { id: 2, itemId: "bank_test_stack", quantity: 1, slot: 1, tabIndex: 0 },
    ];
    const harness = createBankHarness({ bank: originalBank });

    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "withdraw",
      withdrawItems: [
        { itemId: "bank_test_item", quantity: 2 },
        { itemId: "bank_test_stack", quantity: 2 },
      ],
      operationId: "e4964378-c308-4f5b-b05f-3edaa4c0bdc2",
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "insufficient_bank_quantity",
    });
    expect(harness.inventoryRows).toEqual([]);
    expect(harness.bankRows).toEqual(originalBank);
    expect(harness.bankOperationRows).toEqual([]);
    expect(harness.bankOperationItemRows).toEqual([]);
  });

  it("binds a composite operation ID to its exact normalized component plan", async () => {
    const harness = createBankHarness({
      bank: [
        { id: 1, itemId: "bank_test_item", quantity: 4, slot: 0, tabIndex: 0 },
        { id: 2, itemId: "bank_test_stack", quantity: 8, slot: 1, tabIndex: 0 },
      ],
    });
    const operationId = "6c1b05b5-e52b-48ba-8bf4-9c157c0fe93d";
    const common = {
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "withdraw" as const,
      operationId,
    };
    await executeAuthoritativeAgentBankTransfer({
      ...common,
      withdrawItems: [
        { itemId: "bank_test_item", quantity: 1 },
        { itemId: "bank_test_stack", quantity: 2 },
      ],
    });
    const conflict = await executeAuthoritativeAgentBankTransfer({
      ...common,
      withdrawItems: [
        { itemId: "bank_test_item", quantity: 1 },
        { itemId: "bank_test_stack", quantity: 3 },
      ],
    });

    expect(conflict).toMatchObject({
      success: false,
      failureReason: "operation_id_conflict",
    });
    expect(harness.bankOperationRows).toHaveLength(1);
    expect(harness.bankOperationItemRows).toHaveLength(2);
  });

  it("rejects an invalid retry key before acquiring a database connection", async () => {
    const harness = createBankHarness();
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit_all",
      operationId: "not-a-valid-operation-id",
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "invalid_operation_id",
    });
    expect(harness.pool.connect).not.toHaveBeenCalled();
  });

  it("deposits all owned items in one committed transaction", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
        { id: 2, itemId: "bank_test_stack", quantity: 7, slotIndex: 1 },
      ],
      bank: [
        {
          id: 3,
          itemId: "bank_test_stack",
          quantity: 2,
          slot: 0,
          tabIndex: 0,
        },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit_all",
    });

    expect(receipt).toMatchObject({
      success: true,
      action: "deposit_all",
      requestedQuantity: 8,
      committedQuantity: 8,
      inventoryQuantityAfter: 0,
    });
    expect(harness.inventoryRows).toEqual([]);
    expect(harness.bankRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "bank_test_stack", quantity: 9 }),
        expect.objectContaining({ itemId: "bank_test_item", quantity: 1 }),
      ]),
    );
  });

  it("atomically deposits only surplus while preserving exact carried quantities and slots", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
        { id: 2, itemId: "bank_test_item", quantity: 1, slotIndex: 1 },
        { id: 3, itemId: "bank_test_stack", quantity: 9, slotIndex: 2 },
      ],
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit_all",
      retainedItems: [
        { itemId: "bank_test_item", quantity: 1 },
        { itemId: "bank_test_stack", quantity: 3 },
      ],
    });

    expect(receipt).toMatchObject({
      success: true,
      requestedQuantity: 7,
      committedQuantity: 7,
      inventoryQuantityAfter: 4,
    });
    expect(harness.inventoryRows).toEqual([
      { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      { id: 3, itemId: "bank_test_stack", quantity: 3, slotIndex: 2 },
    ]);
    expect(harness.bankRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "bank_test_item", quantity: 1 }),
        expect.objectContaining({ itemId: "bank_test_stack", quantity: 6 }),
      ]),
    );
  });

  it("binds the private retained manifest to the stable operation fingerprint", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_stack", quantity: 9, slotIndex: 0 },
      ],
    });
    const operationId = "95e265ea-c0d0-4e07-aad2-5de861ce1edf";
    const first = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit_all",
      operationId,
      retainedItems: [{ itemId: "bank_test_stack", quantity: 3 }],
    });
    const conflict = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit_all",
      operationId,
      retainedItems: [{ itemId: "bank_test_stack", quantity: 2 }],
    });

    expect(first).toMatchObject({ success: true, committedQuantity: 6 });
    expect(conflict).toMatchObject({
      success: false,
      failureReason: "operation_id_conflict",
    });
    expect(harness.inventoryRows[0]?.quantity).toBe(3);
    expect(harness.bankOperationRows).toHaveLength(1);
  });

  it("revalidates physical access for new work but reconciles an exact committed replay after movement and duel entry", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
    });
    const operationId = "b2ba2455-a3c5-48ca-8f8e-00a8398ef186";
    const request = {
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit_all" as const,
      operationId,
    };
    const first = await executeAuthoritativeAgentBankTransfer(request);
    const player = harness.entities.get("agent-1") as {
      position: { x: number; y: number; z: number };
      data: { inStreamingDuel: boolean };
    };
    player.position.x = 50;
    player.position.z = 50;
    player.data.inStreamingDuel = true;
    const replay = await executeAuthoritativeAgentBankTransfer(request);
    const fresh = await executeAuthoritativeAgentBankTransfer({
      ...request,
      operationId: "685d9244-5f0f-43df-b23e-f66e6e38cb73",
    });

    expect(first).toMatchObject({ success: true, replayed: false });
    expect(replay).toMatchObject({ success: true, replayed: true });
    expect(fresh).toMatchObject({
      success: false,
      failureReason: "duel_locked",
    });
    expect(harness.bankOperationRows).toHaveLength(1);
  });

  it("rejects genuinely new custody while inventory is unready without persisting it", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
    });
    harness.inventorySystem.isInventoryReady.mockReturnValue(false);

    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit_all",
      operationId: "8af540b7-ad20-4f1d-b698-56bb7f800c03",
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "inventory_not_ready",
    });
    expect(
      harness.inventorySystem.persistInventoryImmediate,
    ).not.toHaveBeenCalled();
    expect(harness.inventoryRows).toHaveLength(1);
    expect(harness.bankRows).toEqual([]);
    expect(harness.bankOperationRows).toEqual([]);
  });

  it("releases the inventory lock when database acquisition fails", async () => {
    const harness = createBankHarness({ connectFails: true });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit_all",
    });

    expect(receipt).toMatchObject({
      success: false,
      failureReason: "operation_failed",
    });
    expect(harness.inventorySystem.reloadFromDatabase).toHaveBeenCalledOnce();
    expect(harness.inventorySystem.unlockTransaction).toHaveBeenCalledOnce();
  });

  it("does not claim readiness when post-commit inventory reload fails", async () => {
    const harness = createBankHarness({
      inventory: [
        { id: 1, itemId: "bank_test_item", quantity: 1, slotIndex: 0 },
      ],
      reloadFails: true,
    });
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: harness.world as never,
      playerId: "agent-1",
      bankId: "bank-1",
      action: "deposit",
      itemId: "bank_test_item",
      quantity: 1,
    });

    expect(receipt).toMatchObject({
      success: false,
      commitState: "committed",
      failureReason: "post_commit_sync_failed",
      committedQuantity: 1,
      inventoryQuantityAfter: 0,
      bankQuantityAfter: 1,
    });
    expect(harness.inventorySystem.unlockTransaction).toHaveBeenCalledOnce();
  });
});
