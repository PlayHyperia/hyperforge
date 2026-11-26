import { afterEach, describe, expect, it, vi } from "vitest";

import { dataManager } from "../../../../data/DataManager";
import { EventType } from "../../../../types/events";
import { EventBus } from "../../infrastructure/EventBus";
import { EquipmentSystem } from "../EquipmentSystem";

describe("EquipmentSystem atomic arrow debit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createFixture(
    commitImplementation?: (request: any) => Promise<any>,
    shotCommitImplementation?: (request: any) => Promise<any>,
  ) {
    const eventBus = new EventBus();
    const definitions = new Map<string, any>([
      [
        "shortbow",
        {
          id: "shortbow",
          name: "Shortbow",
          type: "weapon",
          attackType: "ranged",
          weaponType: "BOW",
          equipSlot: "2h",
          stackable: false,
        },
      ],
      [
        "bronze_arrow",
        {
          id: "bronze_arrow",
          name: "Bronze Arrow",
          type: "ammunition",
          equipSlot: "arrows",
          stackable: true,
        },
      ],
    ]);
    vi.spyOn(dataManager, "getItem").mockImplementation(
      (itemId: string) => definitions.get(itemId) ?? null,
    );

    let locked = false;
    let operationTail = Promise.resolve();
    const inventory = {
      lockForTransaction: vi.fn(() => {
        if (locked) return false;
        locked = true;
        return true;
      }),
      unlockTransaction: vi.fn(() => {
        locked = false;
      }),
      isInventoryReady: vi.fn(() => true),
      applyCommittedInventorySnapshot: vi.fn(() => true),
      reloadFromDatabase: vi.fn(async () => undefined),
      queueOperation: vi.fn(
        (playerId: string, operation: () => Promise<boolean>) => {
          void playerId;
          const queued = operationTail.then(operation);
          operationTail = queued.then(
            () => undefined,
            () => undefined,
          );
          return queued;
        },
      ),
    };
    const commit = vi.fn(
      commitImplementation ??
        (async (request: any) => ({
          operationId: request.operationId,
          playerId: request.playerId,
          requestFingerprint: request.requestFingerprint,
          replayed: false,
          slotType: request.slotType,
          itemId: request.itemId,
          quantity: request.quantity,
          committed: [
            { slotType: "weapon", itemId: "shortbow", quantity: 1 },
            { slotType: "arrows", itemId: "bronze_arrow", quantity: 1 },
          ],
        })),
    );
    const preparedSource = {
      contributionId: "ground-item-source:11111111-1111-4111-8111-111111111111",
      preferredSourceId: "ground_item_22222222-2222-4222-8222-222222222222",
      requestFingerprint: "a".repeat(64),
      itemId: "bronze_arrow",
      quantity: 1,
      stackable: true,
      position: { x: 0.5, y: 0, z: 3.5 },
      tile: { x: 0, z: 3 },
      droppedBy: "agent-a",
      lifetimeMs: 120_000,
      lootProtectionMs: 0,
      allowMerge: false,
    };
    const sourceReceipt = {
      sourceId: preparedSource.preferredSourceId,
      status: "active" as const,
      itemId: preparedSource.itemId,
      quantity: 1,
      stackable: true,
      position: preparedSource.position,
      tile: preparedSource.tile,
      droppedBy: preparedSource.droppedBy,
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 121_000,
      lootProtectionExpiresAt: null,
      version: 1,
      contributionId: preparedSource.contributionId,
      requestFingerprint: preparedSource.requestFingerprint,
      replayed: false,
    };
    const commitShot = vi.fn(
      shotCommitImplementation ??
        (async (request: any) => ({
          operationId: request.operationId,
          playerId: request.playerId,
          requestFingerprint: request.requestFingerprint,
          replayed: false,
          itemId: request.itemId,
          quantity: 1,
          recoveryDisposition: request.recoveryDisposition,
          status: "pending",
          committed: [
            { slotType: "weapon", itemId: "shortbow", quantity: 1 },
            { slotType: "arrows", itemId: "bronze_arrow", quantity: 1 },
          ],
          committedInventory: [],
          refundDestination: null,
          sourceRequest: request.source,
          source: null,
        })),
    );
    const settleShot = (status: "fired" | "cancelled", settlement: any) => {
      const staged = commitShot.mock.calls.at(-1)?.[0];
      return {
        operationId: settlement.operationId,
        playerId: settlement.playerId,
        requestFingerprint: settlement.requestFingerprint,
        replayed: false,
        itemId: staged.itemId,
        quantity: 1,
        recoveryDisposition: staged.recoveryDisposition,
        status,
        committed: [
          { slotType: "weapon", itemId: "shortbow", quantity: 1 },
          {
            slotType: "arrows",
            itemId: "bronze_arrow",
            quantity: status === "cancelled" ? 2 : 1,
          },
        ],
        committedInventory: [],
        refundDestination: status === "cancelled" ? "equipment" : null,
        sourceRequest: staged.source,
        source:
          status === "fired" && staged.source
            ? {
                ...sourceReceipt,
                sourceId: staged.source.preferredSourceId,
                position: staged.source.position,
                tile: staged.source.tile,
                contributionId: staged.source.contributionId,
                requestFingerprint: staged.source.requestFingerprint,
              }
            : null,
      };
    };
    const completeShot = vi.fn(async (request: any) =>
      settleShot("fired", request),
    );
    const cancelShot = vi.fn(async (request: any) =>
      settleShot("cancelled", request),
    );
    const groundItems = {
      prepareDurableSourceRegistration: vi.fn(async () => preparedSource),
      exposeCommittedDurableSource: vi.fn(async () => true),
    };
    const database = {
      savePlayerEquipmentAsync: vi.fn(async () => undefined),
      getPlayerEquipmentAsync: vi.fn(async () => [
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 1 },
      ]),
      commitEquipmentStackDebitOperationAsync: commit,
      commitAmmunitionShotOperationAsync: commitShot,
      completeAmmunitionShotOperationAsync: completeShot,
      cancelAmmunitionShotOperationAsync: cancelShot,
    };
    const player = { id: "agent-a", data: {} };
    const world = {
      $eventBus: eventBus,
      isServer: true,
      entities: new Map([[player.id, player]]),
      network: { send: vi.fn() },
      getPlayer: (playerId: string) =>
        playerId === player.id ? player : undefined,
      getSystem: (name: string) => {
        if (name === "database") return database;
        if (name === "inventory") return inventory;
        if (name === "ground-items") return groundItems;
        return undefined;
      },
    };

    return {
      eventBus,
      world,
      database,
      inventory,
      commit,
      commitShot,
      completeShot,
      cancelShot,
      groundItems,
      preparedSource,
      sourceReceipt,
      definitions,
    };
  }

  async function initialize(fixture: ReturnType<typeof createFixture>) {
    const equipment = new EquipmentSystem(fixture.world as never);
    await equipment.init();
    fixture.eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );
    const state = equipment.getPlayerEquipment("agent-a");
    if (!state) throw new Error("equipment not initialized");
    state.weapon.itemId = "shortbow";
    state.weapon.item = fixture.definitions.get("shortbow");
    state.weapon.quantity = 1;
    state.arrows.itemId = "bronze_arrow";
    state.arrows.item = fixture.definitions.get("bronze_arrow");
    state.arrows.quantity = 2;
    return equipment;
  }

  it("does not mutate live equipment before the durable receipt", async () => {
    let releaseCommit: ((receipt: any) => void) | undefined;
    const commitGate = new Promise<any>((resolve) => {
      releaseCommit = resolve;
    });
    const fixture = createFixture(async (request) => {
      const committed = await commitGate;
      return {
        operationId: request.operationId,
        playerId: request.playerId,
        requestFingerprint: request.requestFingerprint,
        replayed: false,
        slotType: request.slotType,
        itemId: request.itemId,
        quantity: request.quantity,
        committed,
      };
    });
    const equipment = await initialize(fixture);

    const pending = equipment.consumeArrowAtomic(
      "agent-a",
      "arrow-operation-1",
      "bronze_arrow",
    );
    await vi.waitFor(() => expect(fixture.commit).toHaveBeenCalledOnce());

    expect(equipment.getArrowCount("agent-a")).toBe(2);
    await expect(
      equipment.consumeArrowAtomic(
        "agent-a",
        "arrow-operation-2",
        "bronze_arrow",
      ),
    ).resolves.toMatchObject({ ok: false, reason: "inventory_busy" });

    releaseCommit?.([
      { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      { slotType: "arrows", itemId: "bronze_arrow", quantity: 1 },
    ]);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
    });
    expect(equipment.getArrowCount("agent-a")).toBe(1);
    expect(fixture.commit.mock.calls[0]?.[0]).toMatchObject({
      operationId: "arrow-operation-1",
      playerId: "agent-a",
      slotType: "arrows",
      itemId: "bronze_arrow",
      quantity: 1,
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fixture.inventory.unlockTransaction).toHaveBeenCalledOnce();
  });

  it("co-commits one projectile debit and recovered-arrow source without presenting it early", async () => {
    const fixture = createFixture();
    const equipment = await initialize(fixture);

    await expect(
      equipment.consumeArrowForProjectileAtomic(
        "agent-a",
        "ammunition-shot:1234567890abcdefghij",
        "bronze_arrow",
        "recovered",
        { x: 0.5, y: 0, z: 3.5 },
      ),
    ).resolves.toMatchObject({
      ok: true,
      recoveryDisposition: "recovered",
      status: "pending",
      recoverySource: null,
    });
    expect(fixture.commitShot).toHaveBeenCalledOnce();
    expect(fixture.commitShot.mock.calls[0]?.[0]).toMatchObject({
      operationId: "ammunition-shot:1234567890abcdefghij",
      playerId: "agent-a",
      itemId: "bronze_arrow",
      quantity: 1,
      recoveryDisposition: "recovered",
      source: fixture.preparedSource,
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      fixture.groundItems.exposeCommittedDurableSource,
    ).not.toHaveBeenCalled();
    expect(equipment.getArrowCount("agent-a")).toBe(1);
  });

  it("co-commits an explicit destroyed-arrow result without creating a source", async () => {
    const fixture = createFixture();
    const equipment = await initialize(fixture);

    await expect(
      equipment.consumeArrowForProjectileAtomic(
        "agent-a",
        "ammunition-shot:abcdefghij1234567890",
        "bronze_arrow",
        "destroyed",
        null,
      ),
    ).resolves.toMatchObject({
      ok: true,
      recoveryDisposition: "destroyed",
      recoverySource: null,
    });
    expect(
      fixture.groundItems.prepareDurableSourceRegistration,
    ).not.toHaveBeenCalled();
    expect(fixture.commitShot.mock.calls[0]?.[0]).toMatchObject({
      recoveryDisposition: "destroyed",
      source: null,
    });
  });

  it("finalizes a staged launch and exposes only its terminal recovery receipt", async () => {
    const fixture = createFixture();
    const equipment = await initialize(fixture);
    const staged = await equipment.consumeArrowForProjectileAtomic(
      "agent-a",
      "ammunition-shot:11223344556677889900",
      "bronze_arrow",
      "recovered",
      { x: 0.5, y: 0, z: 3.5 },
    );
    expect(staged).toMatchObject({
      ok: true,
      status: "pending",
      recoverySource: null,
    });
    if (!staged.ok) throw new Error("expected staged receipt");

    await expect(
      equipment.completeArrowProjectileAtomic({
        operationId: staged.operationId,
        playerId: staged.playerId,
        requestFingerprint: staged.requestFingerprint,
        itemId: staged.arrowId,
        recoveryDisposition: staged.recoveryDisposition,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "fired",
      recoverySource: fixture.sourceReceipt,
    });
    expect(equipment.getArrowCount("agent-a")).toBe(1);
    expect(fixture.completeShot).toHaveBeenCalledOnce();
  });

  it("waits behind another inventory custody operation before finalizing a projectile", async () => {
    const fixture = createFixture();
    const equipment = await initialize(fixture);
    const staged = await equipment.consumeArrowForProjectileAtomic(
      "agent-a",
      "ammunition-shot:44556677889900112233",
      "bronze_arrow",
      "destroyed",
      null,
    );
    if (!staged.ok) throw new Error("expected staged receipt");

    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerOwnsLock = false;
    const queuedBlocker = fixture.inventory.queueOperation(
      "agent-a",
      async () => {
        if (!fixture.inventory.lockForTransaction("agent-a")) return false;
        blockerOwnsLock = true;
        try {
          await blocker;
          return true;
        } finally {
          fixture.inventory.unlockTransaction("agent-a");
        }
      },
    );
    await vi.waitFor(() => expect(blockerOwnsLock).toBe(true));

    const settlement = equipment.completeArrowProjectileAtomic({
      operationId: staged.operationId,
      playerId: staged.playerId,
      requestFingerprint: staged.requestFingerprint,
      itemId: staged.arrowId,
      recoveryDisposition: staged.recoveryDisposition,
    });
    await Promise.resolve();
    expect(fixture.completeShot).not.toHaveBeenCalled();

    releaseBlocker();
    await expect(queuedBlocker).resolves.toBe(true);
    await expect(settlement).resolves.toMatchObject({
      ok: true,
      status: "fired",
    });
    expect(fixture.completeShot).toHaveBeenCalledOnce();
  });

  it("refunds a staged pre-launch cancellation to authoritative equipment", async () => {
    const fixture = createFixture();
    const equipment = await initialize(fixture);
    const staged = await equipment.consumeArrowForProjectileAtomic(
      "agent-a",
      "ammunition-shot:00112233445566778899",
      "bronze_arrow",
      "destroyed",
      null,
    );
    if (!staged.ok) throw new Error("expected staged receipt");
    expect(equipment.getArrowCount("agent-a")).toBe(1);

    await expect(
      equipment.cancelArrowProjectileAtomic({
        operationId: staged.operationId,
        playerId: staged.playerId,
        requestFingerprint: staged.requestFingerprint,
        itemId: staged.arrowId,
        recoveryDisposition: staged.recoveryDisposition,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "cancelled",
      recoverySource: null,
    });
    expect(equipment.getArrowCount("agent-a")).toBe(2);
    expect(fixture.cancelShot).toHaveBeenCalledOnce();
  });

  it("accepts a resolved fired cancellation without restoring the spent arrow", async () => {
    const fixture = createFixture();
    const equipment = await initialize(fixture);
    const staged = await equipment.consumeArrowForProjectileAtomic(
      "agent-a",
      "ammunition-shot:22334455667788990011",
      "bronze_arrow",
      "recovered",
      { x: 0.5, y: 0, z: 3.5 },
    );
    if (!staged.ok) throw new Error("expected staged receipt");
    fixture.cancelShot.mockImplementationOnce(async (request: any) => ({
      operationId: request.operationId,
      playerId: request.playerId,
      requestFingerprint: request.requestFingerprint,
      replayed: false,
      itemId: staged.arrowId,
      quantity: 1,
      recoveryDisposition: staged.recoveryDisposition,
      status: "resolved",
      committed: [
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 1 },
      ],
      committedInventory: [],
      refundDestination: null,
      sourceRequest: fixture.preparedSource,
      source: fixture.sourceReceipt,
    }));

    await expect(
      equipment.cancelArrowProjectileAtomic({
        operationId: staged.operationId,
        playerId: staged.playerId,
        requestFingerprint: staged.requestFingerprint,
        itemId: staged.arrowId,
        recoveryDisposition: staged.recoveryDisposition,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "resolved",
      recoverySource: fixture.sourceReceipt,
    });
    expect(equipment.getArrowCount("agent-a")).toBe(1);
  });

  it("keeps a committed projectile terminal durable without recreating unloaded projections", async () => {
    const fixture = createFixture();
    const equipment = await initialize(fixture);
    const staged = await equipment.consumeArrowForProjectileAtomic(
      "agent-a",
      "ammunition-shot:33445566778899001122",
      "bronze_arrow",
      "destroyed",
      null,
    );
    if (!staged.ok) throw new Error("expected staged receipt");

    let releaseSettlement!: () => void;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const committedCancellation = fixture.cancelShot.getMockImplementation()!;
    fixture.cancelShot.mockImplementationOnce(async (request: any) => {
      await settlementGate;
      return committedCancellation(request);
    });
    fixture.inventory.applyCommittedInventorySnapshot.mockClear();
    fixture.inventory.reloadFromDatabase.mockClear();

    const settlement = equipment.cancelArrowProjectileAtomic({
      operationId: staged.operationId,
      playerId: staged.playerId,
      requestFingerprint: staged.requestFingerprint,
      itemId: staged.arrowId,
      recoveryDisposition: staged.recoveryDisposition,
    });
    await vi.waitFor(() => expect(fixture.cancelShot).toHaveBeenCalledOnce());

    await equipment.destroyAsync();
    expect(equipment.getPlayerEquipment("agent-a")).toBeUndefined();
    releaseSettlement();

    await expect(settlement).resolves.toMatchObject({
      ok: true,
      status: "cancelled",
    });
    expect(
      fixture.inventory.applyCommittedInventorySnapshot,
    ).not.toHaveBeenCalled();
    expect(fixture.inventory.reloadFromDatabase).not.toHaveBeenCalled();
    expect(equipment.getPlayerEquipment("agent-a")).toBeUndefined();
  });

  it("forces a recovered projectile into a private non-merging source before hit", async () => {
    const fixture = createFixture();
    fixture.preparedSource.allowMerge = true;
    const originalFingerprint = fixture.preparedSource.requestFingerprint;
    const equipment = await initialize(fixture);

    await expect(
      equipment.consumeArrowForProjectileAtomic(
        "agent-a",
        "ammunition-shot:0987654321jihgfedcba",
        "bronze_arrow",
        "recovered",
        { x: 0.5, y: 0, z: 3.5 },
      ),
    ).resolves.toMatchObject({ ok: true });
    const committedSource = fixture.commitShot.mock.calls[0]?.[0].source;
    expect(committedSource).toMatchObject({
      allowMerge: false,
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(committedSource.requestFingerprint).not.toBe(originalFingerprint);
    expect(
      fixture.groundItems.exposeCommittedDurableSource,
    ).not.toHaveBeenCalled();
  });

  it("retries an ambiguous response with the exact operation identity", async () => {
    let calls = 0;
    const fixture = createFixture(async (request) => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset after commit");
      return {
        operationId: request.operationId,
        playerId: request.playerId,
        requestFingerprint: request.requestFingerprint,
        replayed: true,
        slotType: request.slotType,
        itemId: request.itemId,
        quantity: request.quantity,
        committed: [
          { slotType: "weapon", itemId: "shortbow", quantity: 1 },
          { slotType: "arrows", itemId: "bronze_arrow", quantity: 1 },
        ],
      };
    });
    const equipment = await initialize(fixture);

    await expect(
      equipment.consumeArrowAtomic(
        "agent-a",
        "arrow-operation-replay",
        "bronze_arrow",
      ),
    ).resolves.toMatchObject({ ok: true, replayed: true });
    expect(fixture.commit).toHaveBeenCalledTimes(2);
    expect(fixture.commit.mock.calls[1]?.[0]).toEqual(
      fixture.commit.mock.calls[0]?.[0],
    );
    expect(equipment.getArrowCount("agent-a")).toBe(1);
  });

  it("leaves live equipment unchanged after a deterministic rejection", async () => {
    const fixture = createFixture(async () => {
      throw new Error("equipment_stack_debit_insufficient_items");
    });
    const equipment = await initialize(fixture);

    await expect(
      equipment.consumeArrowAtomic(
        "agent-a",
        "arrow-operation-insufficient",
        "bronze_arrow",
      ),
    ).resolves.toMatchObject({ ok: false, reason: "insufficient_items" });
    expect(fixture.commit).toHaveBeenCalledOnce();
    expect(equipment.getArrowCount("agent-a")).toBe(2);
    expect(fixture.inventory.unlockTransaction).toHaveBeenCalledOnce();
  });

  it("clears the arrow slot when the committed debit consumes the final arrow", async () => {
    const fixture = createFixture(async (request) => ({
      operationId: request.operationId,
      playerId: request.playerId,
      requestFingerprint: request.requestFingerprint,
      replayed: false,
      slotType: request.slotType,
      itemId: request.itemId,
      quantity: request.quantity,
      committed: [{ slotType: "weapon", itemId: "shortbow", quantity: 1 }],
    }));
    const equipment = await initialize(fixture);
    equipment.getPlayerEquipment("agent-a")!.arrows.quantity = 1;

    await expect(
      equipment.consumeArrowAtomic(
        "agent-a",
        "arrow-operation-final",
        "bronze_arrow",
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(equipment.getArrowCount("agent-a")).toBe(0);
    expect(equipment.getPlayerEquipment("agent-a")?.arrows.itemId).toBeNull();
  });
});
