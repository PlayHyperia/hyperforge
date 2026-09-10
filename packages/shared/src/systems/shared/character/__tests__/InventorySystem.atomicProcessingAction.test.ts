import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types/game/item-types";
import type {
  InventorySaveItem,
  ProcessingActionCommitReceipt,
  ProcessingActionCommitRequest,
} from "../../../../types/network/database";
import { EventBus } from "../../infrastructure/EventBus";
import { InventorySystem } from "../InventorySystem";

const PLAYER_ID = "atomic-smith-agent";
const TEST_ITEMS: Item[] = [
  {
    id: "bronze_bar",
    name: "Bronze Bar",
    type: "resource",
    stackable: false,
    description: "Processing fixture bar",
    examine: "Processing fixture bar",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "hammer",
    name: "Hammer",
    type: "tool",
    stackable: false,
    description: "Processing fixture hammer",
    examine: "Processing fixture hammer",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "logs",
    name: "Logs",
    type: "resource",
    stackable: false,
    description: "Firemaking fixture logs",
    examine: "Firemaking fixture logs",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "tinderbox",
    name: "Tinderbox",
    type: "tool",
    stackable: false,
    description: "Firemaking fixture tinderbox",
    examine: "Firemaking fixture tinderbox",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "bronze_sword",
    name: "Bronze Sword",
    type: "weapon",
    stackable: false,
    description: "Processing fixture sword",
    examine: "Processing fixture sword",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "cowhide",
    name: "Cowhide",
    type: "resource",
    stackable: false,
    description: "Tanning fixture hide",
    examine: "Tanning fixture hide",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "leather",
    name: "Leather",
    type: "resource",
    stackable: false,
    description: "Crafting fixture leather",
    examine: "Crafting fixture leather",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "needle",
    name: "Needle",
    type: "tool",
    stackable: false,
    description: "Crafting fixture needle",
    examine: "Crafting fixture needle",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "thread",
    name: "Thread",
    type: "tool",
    stackable: true,
    description: "Crafting fixture thread",
    examine: "Crafting fixture thread",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "leather_gloves",
    name: "Leather Gloves",
    type: "resource",
    stackable: false,
    description: "Crafting fixture gloves",
    examine: "Crafting fixture gloves",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "bronze_arrowtips",
    name: "Bronze Arrowtips",
    type: "resource",
    stackable: true,
    description: "Fletching fixture arrowtips",
    examine: "Fletching fixture arrowtips",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "headless_arrow",
    name: "Headless Arrow",
    type: "resource",
    stackable: true,
    description: "Fletching fixture headless arrows",
    examine: "Fletching fixture headless arrows",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "bronze_arrow",
    name: "Bronze Arrow",
    type: "resource",
    stackable: true,
    description: "Fletching fixture arrows",
    examine: "Fletching fixture arrows",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "pure_essence",
    name: "Pure Essence",
    type: "resource",
    stackable: true,
    description: "Runecrafting fixture essence",
    examine: "Runecrafting fixture essence",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "rune_essence",
    name: "Rune Essence",
    type: "resource",
    stackable: true,
    description: "Runecrafting fixture essence",
    examine: "Runecrafting fixture essence",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "mind_rune",
    name: "Mind Rune",
    type: "resource",
    stackable: true,
    description: "Runecrafting fixture rune",
    examine: "Runecrafting fixture rune",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
];
const priorItems = new Map<string, Item | undefined>();

beforeAll(() => {
  for (const item of TEST_ITEMS) {
    priorItems.set(item.id, ITEMS.get(item.id));
    ITEMS.set(item.id, item);
  }
});

afterAll(() => {
  for (const item of TEST_ITEMS) {
    const prior = priorItems.get(item.id);
    if (prior) ITEMS.set(item.id, prior);
    else ITEMS.delete(item.id);
  }
});

function initialRows(): InventorySaveItem[] {
  return [
    { itemId: "bronze_bar", quantity: 1, slotIndex: 0, metadata: null },
    { itemId: "bronze_bar", quantity: 1, slotIndex: 1, metadata: null },
    { itemId: "hammer", quantity: 1, slotIndex: 2, metadata: null },
  ];
}

function committedRows(): InventorySaveItem[] {
  return [
    { itemId: "bronze_sword", quantity: 1, slotIndex: 0, metadata: null },
    { itemId: "hammer", quantity: 1, slotIndex: 2, metadata: null },
  ];
}

function committedFailedSmeltRows(): InventorySaveItem[] {
  return [
    { itemId: "bronze_bar", quantity: 1, slotIndex: 1, metadata: null },
    { itemId: "hammer", quantity: 1, slotIndex: 2, metadata: null },
  ];
}

function createFixture(
  commit: (
    request: ProcessingActionCommitRequest,
  ) => Promise<ProcessingActionCommitReceipt>,
  rows: InventorySaveItem[] = initialRows(),
  coinPouch?: {
    applyCommittedBalance: (playerId: string, coins: number) => boolean;
    isPlayerInitialized: (playerId: string) => boolean;
    getCoins: (playerId: string) => number;
  },
) {
  const database = { commitProcessingActionOperationAsync: vi.fn(commit) };
  const world = {
    $eventBus: new EventBus(),
    isServer: true,
    entities: new Map(),
    getSystem: (name: string) =>
      name === "database"
        ? database
        : name === "coin-pouch"
          ? coinPouch
          : undefined,
  };
  const inventory = new InventorySystem(world as never);
  const items = rows.map((row) => ({
    slot: row.slotIndex,
    itemId: row.itemId,
    quantity: row.quantity,
    item: ITEMS.get(row.itemId)!,
  }));
  (
    inventory as unknown as {
      playerInventories: Map<
        string,
        { playerId: string; items: typeof items; coins: number }
      >;
    }
  ).playerInventories.set(PLAYER_ID, {
    playerId: PLAYER_ID,
    items,
    coins: 0,
  });
  return { inventory, database };
}

function quantities(inventory: InventorySystem): Record<string, number> {
  const totals = new Map<string, number>();
  for (const item of inventory.getInventory(PLAYER_ID)?.items ?? []) {
    totals.set(item.itemId, (totals.get(item.itemId) ?? 0) + item.quantity);
  }
  return Object.fromEntries(totals);
}

async function waitForCommitStart(isStarted: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!isStarted()) {
    if (Date.now() >= deadline) {
      throw new Error("atomic processing commit did not start");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

const action = {
  skill: "smithing" as const,
  xpAmount: 12.5,
  inputs: [{ itemId: "bronze_bar", quantity: 2 }],
  outputs: [{ itemId: "bronze_sword", quantity: 1 }],
};

describe("InventorySystem atomic processing action", () => {
  it("binds an authoritative fire request and committed lifetime into the receipt", async () => {
    const fireRows: InventorySaveItem[] = [
      { itemId: "logs", quantity: 1, slotIndex: 0, metadata: null },
      { itemId: "tinderbox", quantity: 1, slotIndex: 1, metadata: null },
    ];
    const createdAt = 1_786_271_400_000;
    const fixture = createFixture(
      async (request) => ({
        ...request,
        replayed: false,
        consumableStates: [],
        worldEffect: {
          kind: "fire",
          fireId: request.worldEffect!.fireId,
          position: request.worldEffect!.position,
          tile: request.worldEffect!.tile,
          createdAt,
          expiresAt: createdAt + request.worldEffect!.durationMs,
        },
        awardedXp: 40,
        operationCommittedXp: 40,
        currentXp: 40,
        currentLevel: 1,
        committed: [
          {
            itemId: "tinderbox",
            quantity: 1,
            slotIndex: 1,
            metadata: null,
          },
        ],
      }),
      fireRows,
    );

    const receipt = await fixture.inventory.commitProcessingActionAtomic(
      PLAYER_ID,
      "firemaking-atomic-1",
      {
        skill: "firemaking",
        xpAmount: 40,
        inputs: [{ itemId: "logs", quantity: 1 }],
        requiredItems: [{ itemId: "tinderbox", quantity: 1 }],
        outputs: [],
        worldEffect: {
          kind: "fire",
          fireId: "fire_atomic-1",
          position: { x: 4.5, y: 0, z: -2.5 },
          tile: { x: 4, z: -3 },
          durationMs: 60_000,
        },
      },
    );

    expect(receipt).toEqual(
      expect.objectContaining({
        ok: true,
        worldEffect: {
          kind: "fire",
          fireId: "fire_atomic-1",
          position: { x: 4.5, y: 0, z: -2.5 },
          tile: { x: 4, z: -3 },
          createdAt,
          expiresAt: createdAt + 60_000,
        },
      }),
    );
    expect(
      fixture.database.commitProcessingActionOperationAsync.mock.calls[0][0]
        .requestFingerprint,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(quantities(fixture.inventory)).toEqual({ tinderbox: 1 });
  });

  it("rejects a fire effect whose tile does not match its world position", async () => {
    const fixture = createFixture(vi.fn(), [
      { itemId: "logs", quantity: 1, slotIndex: 0, metadata: null },
      { itemId: "tinderbox", quantity: 1, slotIndex: 1, metadata: null },
    ]);
    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "firemaking-invalid-tile",
        {
          skill: "firemaking",
          xpAmount: 40,
          inputs: [{ itemId: "logs", quantity: 1 }],
          requiredItems: [{ itemId: "tinderbox", quantity: 1 }],
          outputs: [],
          worldEffect: {
            kind: "fire",
            fireId: "fire_invalid-tile",
            position: { x: 4.5, y: 0, z: -2.5 },
            tile: { x: 5, z: -3 },
            durationMs: 60_000,
          },
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, reason: "invalid_request" }),
    );
    expect(
      fixture.database.commitProcessingActionOperationAsync,
    ).not.toHaveBeenCalled();
  });

  it("exposes no material, product, or fractional-XP result before commit", async () => {
    let releaseCommit:
      ((receipt: ProcessingActionCommitReceipt) => void) | undefined;
    const gate = new Promise<ProcessingActionCommitReceipt>((resolve) => {
      releaseCommit = resolve;
    });
    const fixture = createFixture(async () => gate);
    const pending = fixture.inventory.commitProcessingActionAtomic(
      PLAYER_ID,
      "smith-1",
      action,
    );
    await waitForCommitStart(
      () =>
        fixture.database.commitProcessingActionOperationAsync.mock.calls
          .length === 1,
    );
    expect(quantities(fixture.inventory)).toEqual({
      bronze_bar: 2,
      hammer: 1,
    });
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(true);

    const request =
      fixture.database.commitProcessingActionOperationAsync.mock.calls[0][0];
    expect(request.outputs).toEqual([
      { itemId: "bronze_sword", quantity: 1, stackable: false },
    ]);
    expect(request.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    releaseCommit?.({
      ...request,
      replayed: false,
      consumableStates: [],
      awardedXp: 12.5,
      operationCommittedXp: 12.5,
      currentXp: 12.5,
      currentLevel: 1,
      committed: committedRows(),
    });

    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        committed: true,
        awardedXp: 12.5,
        liveInventoryApplied: true,
      }),
    );
    expect(quantities(fixture.inventory)).toEqual({
      bronze_sword: 1,
      hammer: 1,
    });
  });

  it("replays an ambiguous commit with exactly the same semantic identity", async () => {
    let stored: ProcessingActionCommitReceipt | undefined;
    const fixture = createFixture(async (request) => {
      if (!stored) {
        stored = {
          ...request,
          replayed: false,
          consumableStates: [],
          awardedXp: 12.5,
          operationCommittedXp: 12.5,
          currentXp: 12.5,
          currentLevel: 1,
          committed: committedRows(),
        };
        throw new Error("ECONNRESET after COMMIT");
      }
      return { ...stored, replayed: true };
    });

    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "smith-2",
        action,
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: true, replayed: true }));
    expect(
      fixture.database.commitProcessingActionOperationAsync,
    ).toHaveBeenCalledTimes(2);
    expect(
      fixture.database.commitProcessingActionOperationAsync.mock.calls[0][0],
    ).toEqual(
      fixture.database.commitProcessingActionOperationAsync.mock.calls[1][0],
    );
  });

  it("treats insufficient inputs as definitive and leaves live state untouched", async () => {
    const fixture = createFixture(async () => {
      throw new Error("processing_action_insufficient_items");
    });
    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "smith-3",
        action,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        retryable: false,
        reason: "insufficient_items",
      }),
    );
    expect(quantities(fixture.inventory)).toEqual({
      bronze_bar: 2,
      hammer: 1,
    });
  });

  it("commits an input-only zero-XP failed recipe outcome exactly once", async () => {
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: false,
      consumableStates: [],
      awardedXp: 0,
      operationCommittedXp: 80.5,
      currentXp: 80.5,
      currentLevel: 1,
      committed: committedFailedSmeltRows(),
    }));
    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "smelt-failure-1",
        {
          skill: "smithing",
          xpAmount: 0,
          inputs: [{ itemId: "bronze_bar", quantity: 1 }],
          outputs: [],
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        awardedXp: 0,
        outputs: [],
        liveInventoryApplied: true,
      }),
    );
    const request =
      fixture.database.commitProcessingActionOperationAsync.mock.calls[0][0];
    expect(request.xpAmount).toBe(0);
    expect(request.outputs).toEqual([]);
    expect(request.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(quantities(fixture.inventory)).toEqual({
      bronze_bar: 1,
      hammer: 1,
    });
  });

  it("rejects a receipt whose level does not match its exact durable XP", async () => {
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: false,
      consumableStates: [],
      awardedXp: 12.5,
      operationCommittedXp: 12.5,
      currentXp: 12.5,
      currentLevel: 99,
      committed: committedRows(),
    }));

    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "processing-level-mismatch-1",
        {
          skill: "smithing",
          xpAmount: 12.5,
          inputs: [{ itemId: "bronze_bar", quantity: 1 }],
          requiredItems: [{ itemId: "hammer", quantity: 1 }],
          outputs: [{ itemId: "bronze_shortsword", quantity: 1 }],
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        retryable: true,
        reason: "persistence_ambiguous",
      }),
    );
    expect(quantities(fixture.inventory)).toEqual({
      bronze_bar: 2,
      hammer: 1,
    });
  });

  it("validates and exposes a durable partial consumable-use receipt", async () => {
    const craftRows: InventorySaveItem[] = [
      { itemId: "leather", quantity: 1, slotIndex: 0, metadata: null },
      { itemId: "needle", quantity: 1, slotIndex: 1, metadata: null },
      { itemId: "thread", quantity: 1, slotIndex: 2, metadata: null },
    ];
    const committedCraftRows: InventorySaveItem[] = [
      {
        itemId: "leather_gloves",
        quantity: 1,
        slotIndex: 0,
        metadata: null,
      },
      { itemId: "needle", quantity: 1, slotIndex: 1, metadata: null },
      { itemId: "thread", quantity: 1, slotIndex: 2, metadata: null },
    ];
    const fixture = createFixture(
      async (request) => ({
        ...request,
        replayed: false,
        consumableStates: [
          {
            itemId: "thread",
            usesPerItem: 5,
            remainingUses: 4,
            consumedQuantity: 0,
          },
        ],
        awardedXp: 13.8,
        operationCommittedXp: 13.8,
        currentXp: 13.8,
        currentLevel: 1,
        committed: committedCraftRows,
      }),
      craftRows,
    );

    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "craft-thread-use-1",
        {
          skill: "crafting",
          xpAmount: 13.8,
          inputs: [{ itemId: "leather", quantity: 1 }],
          requiredItems: [{ itemId: "needle", quantity: 1 }],
          consumables: [{ itemId: "thread", usesPerItem: 5 }],
          outputs: [{ itemId: "leather_gloves", quantity: 1 }],
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        consumableStates: [
          {
            itemId: "thread",
            usesPerItem: 5,
            remainingUses: 4,
            consumedQuantity: 0,
          },
        ],
      }),
    );
    expect(quantities(fixture.inventory)).toEqual({
      leather_gloves: 1,
      needle: 1,
      thread: 1,
    });
  });

  it("rejects an impossible consumable state without changing live inventory", async () => {
    const craftRows: InventorySaveItem[] = [
      { itemId: "leather", quantity: 1, slotIndex: 0, metadata: null },
      { itemId: "needle", quantity: 1, slotIndex: 1, metadata: null },
      { itemId: "thread", quantity: 1, slotIndex: 2, metadata: null },
    ];
    const fixture = createFixture(
      async (request) => ({
        ...request,
        replayed: false,
        consumableStates: [
          {
            itemId: "thread",
            usesPerItem: 5,
            remainingUses: 0,
            consumedQuantity: 0,
          },
        ],
        awardedXp: 13.8,
        operationCommittedXp: 13.8,
        currentXp: 13.8,
        currentLevel: 1,
        committed: [],
      }),
      craftRows,
    );

    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "craft-invalid-thread-state",
        {
          skill: "crafting",
          xpAmount: 13.8,
          inputs: [{ itemId: "leather", quantity: 1 }],
          requiredItems: [{ itemId: "needle", quantity: 1 }],
          consumables: [{ itemId: "thread", usesPerItem: 5 }],
          outputs: [{ itemId: "leather_gloves", quantity: 1 }],
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        reason: "persistence_ambiguous",
        retryable: true,
      }),
    );
    expect(quantities(fixture.inventory)).toEqual({
      leather: 1,
      needle: 1,
      thread: 1,
    });
  });

  it("applies an authoritative fifteen-item fletching output atomically", async () => {
    const fletchingRows: InventorySaveItem[] = [
      {
        itemId: "bronze_arrowtips",
        quantity: 15,
        slotIndex: 0,
        metadata: null,
      },
      {
        itemId: "headless_arrow",
        quantity: 15,
        slotIndex: 1,
        metadata: null,
      },
    ];
    const fixture = createFixture(
      async (request) => ({
        ...request,
        replayed: false,
        consumableStates: [],
        awardedXp: 19.5,
        operationCommittedXp: 19.5,
        currentXp: 19.5,
        currentLevel: 1,
        committed: [
          {
            itemId: "bronze_arrow",
            quantity: 15,
            slotIndex: 0,
            metadata: null,
          },
        ],
      }),
      fletchingRows,
    );

    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "fletch-arrows-1",
        {
          skill: "fletching",
          xpAmount: 19.5,
          inputs: [
            { itemId: "bronze_arrowtips", quantity: 15 },
            { itemId: "headless_arrow", quantity: 15 },
          ],
          outputs: [{ itemId: "bronze_arrow", quantity: 15 }],
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        outputs: [{ itemId: "bronze_arrow", quantity: 15, stackable: true }],
        awardedXp: 19.5,
      }),
    );
    const request =
      fixture.database.commitProcessingActionOperationAsync.mock.calls[0][0];
    expect(request.outputs).toEqual([
      { itemId: "bronze_arrow", quantity: 15, stackable: true },
    ]);
    expect(quantities(fixture.inventory)).toEqual({ bronze_arrow: 15 });
  });

  it("applies mixed essence, stacked runes, and fractional runecrafting XP atomically", async () => {
    const essenceRows: InventorySaveItem[] = [
      {
        itemId: "pure_essence",
        quantity: 2,
        slotIndex: 0,
        metadata: null,
      },
      {
        itemId: "rune_essence",
        quantity: 3,
        slotIndex: 1,
        metadata: null,
      },
    ];
    const fixture = createFixture(
      async (request) => ({
        ...request,
        replayed: false,
        consumableStates: [],
        awardedXp: 27.5,
        operationCommittedXp: 27.5,
        currentXp: 27.5,
        currentLevel: 1,
        committed: [
          {
            itemId: "mind_rune",
            quantity: 5,
            slotIndex: 0,
            metadata: null,
          },
        ],
      }),
      essenceRows,
    );

    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "runecraft-mind-1",
        {
          skill: "runecrafting",
          xpAmount: 27.5,
          inputs: [
            { itemId: "pure_essence", quantity: 2 },
            { itemId: "rune_essence", quantity: 3 },
          ],
          outputs: [{ itemId: "mind_rune", quantity: 5 }],
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        outputs: [{ itemId: "mind_rune", quantity: 5, stackable: true }],
        awardedXp: 27.5,
      }),
    );
    const request =
      fixture.database.commitProcessingActionOperationAsync.mock.calls[0][0];
    expect(request.inputs).toEqual([
      { itemId: "pure_essence", quantity: 2 },
      { itemId: "rune_essence", quantity: 3 },
    ]);
    expect(request.outputs).toEqual([
      { itemId: "mind_rune", quantity: 5, stackable: true },
    ]);
    expect(quantities(fixture.inventory)).toEqual({ mind_rune: 5 });
  });

  it("couples an authoritative money-pouch debit to the item transform", async () => {
    const applyCommittedBalance = vi.fn(() => true);
    const fixture = createFixture(
      async (request) => ({
        ...request,
        replayed: false,
        consumableStates: [],
        currentCoins: 98,
        awardedXp: 0,
        operationCommittedXp: 0,
        currentXp: 0,
        currentLevel: 1,
        committed: [
          {
            itemId: "leather",
            quantity: 1,
            slotIndex: 0,
            metadata: null,
          },
          {
            itemId: "leather",
            quantity: 1,
            slotIndex: 1,
            metadata: null,
          },
        ],
      }),
      [
        { itemId: "cowhide", quantity: 1, slotIndex: 0, metadata: null },
        { itemId: "cowhide", quantity: 1, slotIndex: 1, metadata: null },
      ],
      {
        applyCommittedBalance,
        isPlayerInitialized: () => true,
        getCoins: () => 98,
      },
    );

    await expect(
      fixture.inventory.commitProcessingActionAtomic(
        PLAYER_ID,
        "tan-cowhide-1",
        {
          skill: "crafting",
          xpAmount: 0,
          inputs: [{ itemId: "cowhide", quantity: 2 }],
          outputs: [{ itemId: "leather", quantity: 2 }],
          coinCost: 2,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        coinCost: 2,
        currentCoins: 98,
        liveInventoryApplied: true,
      }),
    );

    const request =
      fixture.database.commitProcessingActionOperationAsync.mock.calls[0][0];
    expect(request.coinCost).toBe(2);
    expect(request.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(applyCommittedBalance).toHaveBeenCalledWith(PLAYER_ID, 98);
    expect(quantities(fixture.inventory)).toEqual({ leather: 2 });
  });
});
