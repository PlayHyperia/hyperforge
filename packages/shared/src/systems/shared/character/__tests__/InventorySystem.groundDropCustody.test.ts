import { describe, expect, it, vi } from "vitest";

import { getItem } from "../../../../data/items";
import type {
  GroundItemDropCommitReceipt,
  GroundItemDropCommitRequest,
  GroundItemSourceRegistrationRequest,
  InventorySaveItem,
} from "../../../../types/network/database";
import { EventType } from "../../../../types/events";
import { EventBus } from "../../infrastructure/EventBus";
import { InventorySystem } from "../InventorySystem";

const PLAYER_ID = "ground-drop-agent";
const OPERATION_ID = "ground-item-drop:11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "ground_item_22222222-2222-4222-8222-222222222222";
const CONTRIBUTION_ID =
  "ground-item-source:33333333-3333-4333-8333-333333333333";

function inventoryRows(airRunes = 5): InventorySaveItem[] {
  return [
    {
      itemId: "air_rune",
      quantity: airRunes,
      slotIndex: 3,
      metadata: null,
    },
    { itemId: "mind_rune", quantity: 4, slotIndex: 4, metadata: null },
  ].filter((item) => item.quantity > 0);
}

function sourceRequest(
  quantity = 2,
  itemId = "air_rune",
): GroundItemSourceRegistrationRequest {
  return {
    contributionId: CONTRIBUTION_ID,
    preferredSourceId: SOURCE_ID,
    requestFingerprint: "a".repeat(64),
    itemId,
    quantity,
    stackable: true,
    position: { x: 8.5, y: 0.2, z: 9.5 },
    tile: { x: 8, z: 9 },
    droppedBy: PLAYER_ID,
    lifetimeMs: 120_000,
    lootProtectionMs: 0,
    allowMerge: false,
  };
}

function committedReceipt(
  request: GroundItemDropCommitRequest,
  overrides: Partial<GroundItemDropCommitReceipt> = {},
): GroundItemDropCommitReceipt {
  const now = Date.now();
  return {
    operationId: request.operationId,
    playerId: request.playerId,
    requestFingerprint: request.requestFingerprint,
    replayed: false,
    itemId: request.itemId,
    quantity: request.quantity,
    slotIndex: request.slotIndex,
    operationCommittedCoins: null,
    currentCoins: 100,
    committed: inventoryRows(3),
    source: {
      sourceId: request.source.preferredSourceId,
      contributionId: request.source.contributionId,
      requestFingerprint: request.source.requestFingerprint,
      replayed: false,
      status: "active",
      itemId: request.source.itemId,
      quantity: request.source.quantity,
      stackable: request.source.stackable,
      position: request.source.position,
      tile: request.source.tile,
      droppedBy: request.source.droppedBy,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + request.source.lifetimeMs,
      lootProtectionExpiresAt: null,
      version: 1,
    },
    ...overrides,
  };
}

function createFixture(options: {
  commit: (
    request: GroundItemDropCommitRequest,
  ) => Promise<GroundItemDropCommitReceipt>;
  expose?: (receipt: GroundItemDropCommitReceipt["source"]) => Promise<boolean>;
  prepare?: () => Promise<GroundItemSourceRegistrationRequest | null>;
  playerAvailable?: boolean;
}) {
  const database = {
    commitGroundItemDropOperationAsync: vi.fn(options.commit),
  };
  const groundItems = {
    prepareDurableSourceRegistration: vi.fn(
      options.prepare ?? (async () => sourceRequest()),
    ),
    exposeCommittedDurableSource: vi.fn(options.expose ?? (async () => true)),
  };
  const coinPouch = {
    applyCommittedBalance: vi.fn(() => true),
    isPlayerInitialized: vi.fn(() => true),
    getCoins: vi.fn(() => 100),
  };
  const player = {
    data: {},
    node: { position: { x: 8.4, y: 0.2, z: 9.4 } },
  };
  const entities = new Map<string, unknown>([[PLAYER_ID, player]]);
  const eventBus = new EventBus();
  const world = {
    $eventBus: eventBus,
    isServer: true,
    currentTick: 10,
    entities,
    emit: vi.fn(),
    getPlayer: (id: string) =>
      options.playerAvailable === false ? undefined : entities.get(id),
    getSystem: (name: string) => {
      if (name === "database") return database;
      if (name === "ground-items") return groundItems;
      if (name === "coin-pouch") return coinPouch;
      if (name === "duel") return { isPlayerInDuel: () => false };
      return undefined;
    },
  };
  const inventory = new InventorySystem(world as never);
  const items = inventoryRows().map((row) => {
    const item = getItem(row.itemId);
    if (!item) throw new Error(`missing test item ${row.itemId}`);
    return {
      slot: row.slotIndex,
      itemId: row.itemId,
      quantity: row.quantity,
      item,
    };
  });
  (
    inventory as unknown as {
      playerInventories: Map<
        string,
        { playerId: string; items: typeof items; coins: number }
      >;
      initializedInventories: Set<string>;
    }
  ).playerInventories.set(PLAYER_ID, {
    playerId: PLAYER_ID,
    items,
    coins: 0,
  });
  (
    inventory as unknown as { initializedInventories: Set<string> }
  ).initializedInventories.add(PLAYER_ID);
  return { inventory, database, groundItems, coinPouch, eventBus, world };
}

function quantity(inventory: InventorySystem, itemId = "air_rune"): number {
  return (
    inventory
      .getInventory(PLAYER_ID)
      ?.items.find((item) => item.itemId === itemId)?.quantity ?? 0
  );
}

describe("InventorySystem durable ground-drop custody", () => {
  it("does not debit or expose presentation before the atomic commit resolves", async () => {
    let release: ((receipt: GroundItemDropCommitReceipt) => void) | undefined;
    const gate = new Promise<GroundItemDropCommitReceipt>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({ commit: async () => gate });

    const pending = fixture.inventory.dropOwnedItemAtomic(
      PLAYER_ID,
      OPERATION_ID,
      "air_rune",
      2,
      3,
    );
    await vi.waitFor(() => {
      expect(
        fixture.database.commitGroundItemDropOperationAsync,
      ).toHaveBeenCalledOnce();
    });
    expect(quantity(fixture.inventory)).toBe(5);
    expect(
      fixture.groundItems.exposeCommittedDurableSource,
    ).not.toHaveBeenCalled();
    const request =
      fixture.database.commitGroundItemDropOperationAsync.mock.calls[0]![0];
    expect(request).toMatchObject({
      operationId: OPERATION_ID,
      playerId: PLAYER_ID,
      itemId: "air_rune",
      quantity: 2,
      slotIndex: 3,
      source: {
        contributionId: CONTRIBUTION_ID,
        preferredSourceId: SOURCE_ID,
        droppedBy: PLAYER_ID,
        lootProtectionMs: 0,
      },
    });
    expect(request.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);

    release?.(committedReceipt(request));
    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        committed: true,
        liveInventoryApplied: true,
        presentationReady: true,
      }),
    );
    expect(quantity(fixture.inventory)).toBe(3);
    expect(
      fixture.groundItems.exposeCommittedDurableSource,
    ).toHaveBeenCalledOnce();
  });

  it("retries response loss with the byte-equivalent frozen request", async () => {
    const requests: GroundItemDropCommitRequest[] = [];
    const fixture = createFixture({
      commit: async (request) => {
        requests.push(request);
        if (requests.length === 1) throw new Error("ECONNRESET after COMMIT");
        return committedReceipt(request, { replayed: true });
      },
    });

    await expect(
      fixture.inventory.dropOwnedItemAtomic(
        PLAYER_ID,
        OPERATION_ID,
        "air_rune",
        2,
        3,
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: true, committed: true }));
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(quantity(fixture.inventory)).toBe(3);
    expect(
      fixture.groundItems.exposeCommittedDurableSource,
    ).toHaveBeenCalledOnce();
  });

  it("keeps live custody and presentation untouched on definitive rejection", async () => {
    const fixture = createFixture({
      commit: async () => {
        throw new Error("ground_item_drop_insufficient_items");
      },
    });

    await expect(
      fixture.inventory.dropOwnedItemAtomic(
        PLAYER_ID,
        OPERATION_ID,
        "air_rune",
        6,
        3,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        committed: false,
        reason: "insufficient_items",
      }),
    );
    expect(quantity(fixture.inventory)).toBe(5);
    expect(
      fixture.groundItems.exposeCommittedDurableSource,
    ).not.toHaveBeenCalled();
  });

  it("binds the exact requested slot and rejects an item mismatch without mutation", async () => {
    const fixture = createFixture({
      commit: async () => {
        throw new Error("ground_item_drop_slot_mismatch");
      },
    });

    await expect(
      fixture.inventory.dropOwnedItemAtomic(
        PLAYER_ID,
        OPERATION_ID,
        "air_rune",
        1,
        4,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        committed: false,
        reason: "invalid_request",
      }),
    );
    expect(quantity(fixture.inventory)).toBe(5);
    expect(
      fixture.groundItems.exposeCommittedDurableSource,
    ).not.toHaveBeenCalled();
  });

  it("retains committed truth when presentation must hydrate later", async () => {
    const fixture = createFixture({
      commit: async (request) => committedReceipt(request),
      expose: async () => false,
    });

    await expect(
      fixture.inventory.dropOwnedItemAtomic(
        PLAYER_ID,
        OPERATION_ID,
        "air_rune",
        2,
        3,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        committed: true,
        liveInventoryApplied: true,
        presentationReady: false,
      }),
    );
    expect(quantity(fixture.inventory)).toBe(3);
  });

  it("does not downgrade a commit when both live apply and reload throw", async () => {
    const fixture = createFixture({
      commit: async (request) => committedReceipt(request),
    });
    vi.spyOn(
      fixture.inventory,
      "applyCommittedInventorySnapshot",
    ).mockImplementation(() => {
      throw new Error("live apply unavailable");
    });
    vi.spyOn(fixture.inventory, "reloadFromDatabase").mockRejectedValue(
      new Error("reload unavailable"),
    );

    await expect(
      fixture.inventory.dropOwnedItemAtomic(
        PLAYER_ID,
        OPERATION_ID,
        "air_rune",
        2,
        3,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        committed: true,
        liveInventoryApplied: false,
        presentationReady: true,
      }),
    );
    expect(
      fixture.groundItems.exposeCommittedDurableSource,
    ).toHaveBeenCalledOnce();
  });

  it("preserves a committed coin drop when live coin convergence throws", async () => {
    const fixture = createFixture({
      prepare: async () => sourceRequest(25, "coins"),
      commit: async (request) =>
        committedReceipt(request, {
          operationCommittedCoins: 75,
          currentCoins: 75,
          committed: inventoryRows(),
        }),
    });
    fixture.coinPouch.applyCommittedBalance.mockImplementation(() => {
      throw new Error("coin projection unavailable");
    });

    await expect(
      fixture.inventory.dropOwnedItemAtomic(
        PLAYER_ID,
        OPERATION_ID,
        "coins",
        25,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        committed: true,
        liveInventoryApplied: true,
        liveCoinsApplied: false,
        presentationReady: true,
      }),
    );
    expect(fixture.coinPouch.applyCommittedBalance).toHaveBeenCalledWith(
      PLAYER_ID,
      75,
    );
  });

  it("fails before source preparation when the player position is unavailable", async () => {
    const fixture = createFixture({
      commit: async (request) => committedReceipt(request),
      playerAvailable: false,
    });

    await expect(
      fixture.inventory.dropOwnedItemAtomic(
        PLAYER_ID,
        OPERATION_ID,
        "air_rune",
        2,
        3,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        committed: false,
        reason: "player_unavailable",
      }),
    );
    expect(
      fixture.groundItems.prepareDurableSourceRegistration,
    ).not.toHaveBeenCalled();
    expect(
      fixture.database.commitGroundItemDropOperationAsync,
    ).not.toHaveBeenCalled();
    expect(quantity(fixture.inventory)).toBe(5);
  });

  it("emits no success acknowledgement before commit and then emits the exact receipt", async () => {
    let release: ((receipt: GroundItemDropCommitReceipt) => void) | undefined;
    let request: GroundItemDropCommitRequest | undefined;
    const gate = new Promise<GroundItemDropCommitReceipt>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({
      commit: async (value) => {
        request = value;
        return gate;
      },
    });
    const results: unknown[] = [];
    fixture.eventBus.subscribe(EventType.ITEM_DROP_RESULT, (event) => {
      results.push(event.data);
    });

    const pending = (
      fixture.inventory as unknown as {
        dropItem: (data: {
          playerId: string;
          itemId: string;
          quantity: number;
          slot: number;
          operationId: string;
        }) => Promise<void>;
      }
    ).dropItem({
      playerId: PLAYER_ID,
      itemId: "air_rune",
      quantity: 2,
      slot: 3,
      operationId: OPERATION_ID,
    });
    await vi.waitFor(() => expect(request).toBeDefined());
    expect(results).toEqual([]);
    expect(fixture.world.emit).not.toHaveBeenCalled();

    release?.(committedReceipt(request!));
    await pending;
    expect(results).toEqual([
      expect.objectContaining({
        success: true,
        committed: true,
        playerId: PLAYER_ID,
        operationId: OPERATION_ID,
        itemId: "air_rune",
        quantity: 2,
        sourceId: SOURCE_ID,
        position: { x: 8.5, y: 0.2, z: 9.5 },
        replayed: false,
        liveInventoryApplied: true,
        liveCoinsApplied: true,
        presentationReady: true,
      }),
    ]);
    expect(fixture.world.emit).toHaveBeenCalledWith(EventType.ITEM_DROPPED, {
      playerId: PLAYER_ID,
      operationId: OPERATION_ID,
      itemId: "air_rune",
      quantity: 2,
      sourceId: SOURCE_ID,
      position: { x: 8.5, y: 0.2, z: 9.5 },
    });
  });

  it("emits a correlated definitive rejection without presentation", async () => {
    const fixture = createFixture({
      commit: async () => {
        throw new Error("ground_item_drop_insufficient_items");
      },
    });
    const results: unknown[] = [];
    const inventoryUpdates: unknown[] = [];
    fixture.eventBus.subscribe(EventType.INVENTORY_UPDATED, (event) => {
      inventoryUpdates.push(event.data);
    });
    fixture.eventBus.subscribe(EventType.ITEM_DROP_RESULT, (event) => {
      results.push(event.data);
    });

    await (
      fixture.inventory as unknown as {
        dropItem: (data: {
          playerId: string;
          itemId: string;
          quantity: number;
          slot: number;
          operationId: string;
        }) => Promise<void>;
      }
    ).dropItem({
      playerId: PLAYER_ID,
      itemId: "air_rune",
      quantity: 6,
      slot: 3,
      operationId: OPERATION_ID,
    });

    expect(results).toEqual([
      {
        success: false,
        committed: false,
        playerId: PLAYER_ID,
        operationId: OPERATION_ID,
        itemId: "air_rune",
        quantity: 6,
        reason: "insufficient_items",
      },
    ]);
    expect(fixture.world.emit).not.toHaveBeenCalled();
    expect(quantity(fixture.inventory)).toBe(5);
    expect(inventoryUpdates).toEqual([
      expect.objectContaining({
        playerId: PLAYER_ID,
        items: expect.arrayContaining([
          expect.objectContaining({
            slot: 3,
            itemId: "air_rune",
            quantity: 5,
          }),
        ]),
      }),
    ]);
  });
});
