import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getItem, ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types/game/item-types";
import type {
  GatheringRewardCommitReceipt,
  GatheringRewardCommitRequest,
  InventorySaveItem,
} from "../../../../types/network/database";
import { EventBus } from "../../infrastructure/EventBus";
import { InventorySystem } from "../InventorySystem";

const PLAYER_ID = "atomic-gather-agent";
const TEST_ITEMS: Item[] = [
  {
    id: "fishing_bait",
    name: "Fishing Bait",
    type: "resource",
    stackable: true,
    maxStackSize: 10_000,
    description: "Atomic gathering fixture bait",
    examine: "Atomic gathering fixture bait",
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
    maxStackSize: 100,
    description: "Atomic gathering fixture logs",
    examine: "Atomic gathering fixture logs",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  },
  {
    id: "copper_ore",
    name: "Copper Ore",
    type: "resource",
    stackable: false,
    maxStackSize: 100,
    description: "Atomic gathering fixture ore",
    examine: "Atomic gathering fixture ore",
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

function inventoryRows(bait = 5, logs = 0): InventorySaveItem[] {
  const rows: InventorySaveItem[] = [
    {
      itemId: "fishing_bait",
      quantity: bait,
      slotIndex: 0,
      metadata: null,
    },
  ];
  for (let index = 0; index < logs; index++) {
    rows.push({
      itemId: "logs",
      quantity: 1,
      slotIndex: index + 1,
      metadata: null,
    });
  }
  return rows.filter((row) => row.quantity > 0);
}

function createFixture(
  commit: (
    request: GatheringRewardCommitRequest,
  ) => Promise<GatheringRewardCommitReceipt>,
) {
  const database = { commitGatheringRewardOperationAsync: vi.fn(commit) };
  const eventBus = new EventBus();
  const world = {
    $eventBus: eventBus,
    isServer: true,
    entities: new Map(),
    getSystem: (name: string) => (name === "database" ? database : undefined),
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
      throw new Error("atomic gathering commit did not start");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

describe("InventorySystem atomic gathering reward", () => {
  it("exposes no item or secondary debit before item and XP commit together", async () => {
    let releaseCommit:
      ((receipt: GatheringRewardCommitReceipt) => void) | undefined;
    const gate = new Promise<GatheringRewardCommitReceipt>((resolve) => {
      releaseCommit = resolve;
    });
    const fixture = createFixture(async () => gate);

    const pending = fixture.inventory.commitGatheringRewardAtomic(
      PLAYER_ID,
      "gathering-1",
      {
        resourceId: "tree_atomic_1",
        depleteAfterCommit: false,
        respawnTicks: 80,
        skill: "woodcutting",
        xpAmount: 25,
        rewardItemId: "logs",
        rewardQuantity: 1,
        secondaryItemId: "fishing_bait",
      },
    );
    await waitForCommitStart(
      () =>
        fixture.database.commitGatheringRewardOperationAsync.mock.calls
          .length === 1,
    );
    expect(
      fixture.database.commitGatheringRewardOperationAsync,
    ).toHaveBeenCalledOnce();
    expect(quantities(fixture.inventory)).toEqual({ fishing_bait: 5 });
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(true);

    const request =
      fixture.database.commitGatheringRewardOperationAsync.mock.calls[0][0];
    expect(request.reward).toEqual({
      itemId: "logs",
      quantity: 1,
      stackable: false,
    });
    expect(request.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    releaseCommit?.({
      ...request,
      replayed: false,
      depletedUntil: null,
      awardedXp: 25,
      operationCommittedXp: 25,
      currentXp: 25,
      currentLevel: 1,
      committed: inventoryRows(4, 1),
    });

    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        committed: true,
        awardedXp: 25,
        liveInventoryApplied: true,
      }),
    );
    expect(quantities(fixture.inventory)).toEqual({
      fishing_bait: 4,
      logs: 1,
    });
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(false);
  });

  it("replays an ambiguous commit with exactly the same identity", async () => {
    let stored: GatheringRewardCommitReceipt | undefined;
    const fixture = createFixture(async (request) => {
      if (!stored) {
        stored = {
          ...request,
          replayed: false,
          depletedUntil: null,
          awardedXp: 10,
          operationCommittedXp: 10,
          currentXp: 10,
          currentLevel: 1,
          committed: inventoryRows(5, 1),
        };
        throw new Error("ECONNRESET after COMMIT");
      }
      return { ...stored, replayed: true };
    });

    await expect(
      fixture.inventory.commitGatheringRewardAtomic(PLAYER_ID, "gathering-2", {
        resourceId: "tree_atomic_2",
        depleteAfterCommit: false,
        respawnTicks: 80,
        skill: "woodcutting",
        xpAmount: 10,
        rewardItemId: "logs",
        rewardQuantity: 1,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true, replayed: true }));
    expect(
      fixture.database.commitGatheringRewardOperationAsync,
    ).toHaveBeenCalledTimes(2);
    expect(
      fixture.database.commitGatheringRewardOperationAsync.mock.calls[0][0],
    ).toEqual(
      fixture.database.commitGatheringRewardOperationAsync.mock.calls[1][0],
    );
    expect(quantities(fixture.inventory)).toEqual({
      fishing_bait: 5,
      logs: 1,
    });
  });

  it("classifies full inventory as definitive and never mutates live state", async () => {
    const fixture = createFixture(async () => {
      throw new Error("gathering_reward_inventory_full");
    });
    await expect(
      fixture.inventory.commitGatheringRewardAtomic(PLAYER_ID, "gathering-3", {
        resourceId: "ore_atomic_3",
        depleteAfterCommit: true,
        respawnTicks: 10,
        skill: "mining",
        xpAmount: 18,
        rewardItemId: "copper_ore",
        rewardQuantity: 1,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        retryable: false,
        reason: "inventory_full",
      }),
    );
    expect(
      fixture.database.commitGatheringRewardOperationAsync,
    ).toHaveBeenCalledOnce();
    expect(quantities(fixture.inventory)).toEqual({ fishing_bait: 5 });
  });

  it("treats a cross-authority depleted node as a definitive rejection", async () => {
    const fixture = createFixture(async () => {
      throw new Error("gathering_reward_resource_unavailable");
    });
    await expect(
      fixture.inventory.commitGatheringRewardAtomic(PLAYER_ID, "gathering-4", {
        resourceId: "ore_atomic_4",
        depleteAfterCommit: true,
        respawnTicks: 10,
        skill: "mining",
        xpAmount: 18,
        rewardItemId: "copper_ore",
        rewardQuantity: 1,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        retryable: false,
        reason: "resource_unavailable",
      }),
    );
    expect(
      fixture.database.commitGatheringRewardOperationAsync,
    ).toHaveBeenCalledOnce();
    expect(quantities(fixture.inventory)).toEqual({ fishing_bait: 5 });
  });

  it("rejects a receipt whose level does not match its exact durable XP", async () => {
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: false,
      depletedUntil: null,
      awardedXp: 25,
      operationCommittedXp: 25,
      currentXp: 25,
      currentLevel: 99,
      committed: inventoryRows(5, 1),
    }));

    await expect(
      fixture.inventory.commitGatheringRewardAtomic(PLAYER_ID, "gathering-5", {
        resourceId: "tree_atomic_5",
        depleteAfterCommit: false,
        respawnTicks: 80,
        skill: "woodcutting",
        xpAmount: 25,
        rewardItemId: "logs",
        rewardQuantity: 1,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        retryable: true,
        reason: "persistence_ambiguous",
      }),
    );
    expect(quantities(fixture.inventory)).toEqual({ fishing_bait: 5 });
  });
});
