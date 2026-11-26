import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getItem, ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types/game/item-types";
import type {
  BoneBurialCommitReceipt,
  BoneBurialCommitRequest,
  InventorySaveItem,
} from "../../../../types/network/database";
import { EventBus } from "../../infrastructure/EventBus";
import { InventorySystem } from "../InventorySystem";

const PLAYER_ID = "atomic-prayer-agent";
const OPERATION_ID = "92da6285-2348-5bab-8dad-57bc151ef355";
const BONES: Item = {
  id: "atomic_prayer_bones",
  name: "Prayer Bones",
  type: "resource",
  stackable: true,
  maxStackSize: 10_000,
  prayerXp: 15,
  buryLevelRequired: 1,
  description: "Atomic prayer fixture",
  examine: "Atomic prayer fixture",
  tradeable: false,
  rarity: "common",
  modelPath: null,
  iconPath: "",
};
let priorItem: Item | undefined;

beforeAll(() => {
  priorItem = ITEMS.get(BONES.id);
  ITEMS.set(BONES.id, BONES);
});

afterAll(() => {
  if (priorItem) ITEMS.set(BONES.id, priorItem);
  else ITEMS.delete(BONES.id);
});

function rows(quantity: number): InventorySaveItem[] {
  return quantity > 0
    ? [
        {
          itemId: BONES.id,
          quantity,
          slotIndex: 0,
          metadata: null,
        },
      ]
    : [];
}

function createFixture(
  commit: (
    request: BoneBurialCommitRequest,
  ) => Promise<BoneBurialCommitReceipt>,
) {
  const database = { commitBoneBurialOperationAsync: vi.fn(commit) };
  const world = {
    $eventBus: new EventBus(),
    isServer: true,
    entities: new Map(),
    getSystem: (name: string) => (name === "database" ? database : undefined),
  };
  const inventory = new InventorySystem(world as never);
  const item = getItem(BONES.id)!;
  (
    inventory as unknown as {
      playerInventories: Map<string, unknown>;
    }
  ).playerInventories.set(PLAYER_ID, {
    playerId: PLAYER_ID,
    items: [{ slot: 0, itemId: BONES.id, quantity: 2, item }],
    coins: 0,
  });
  return { inventory, database };
}

function quantity(inventory: InventorySystem): number {
  return (
    inventory
      .getInventory(PLAYER_ID)
      ?.items.filter((entry) => entry.itemId === BONES.id)
      .reduce((total, entry) => total + entry.quantity, 0) ?? 0
  );
}

describe("InventorySystem atomic bone burial", () => {
  it("exposes no custody change before the combined item and XP receipt", async () => {
    let release: ((receipt: BoneBurialCommitReceipt) => void) | undefined;
    const gate = new Promise<BoneBurialCommitReceipt>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture(async () => gate);
    const pending = fixture.inventory.commitBoneBurialAtomic(
      PLAYER_ID,
      OPERATION_ID,
      BONES.id,
      15,
      1,
    );
    await vi.waitFor(() =>
      expect(
        fixture.database.commitBoneBurialOperationAsync,
      ).toHaveBeenCalledOnce(),
    );
    expect(quantity(fixture.inventory)).toBe(2);
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(true);

    const request =
      fixture.database.commitBoneBurialOperationAsync.mock.calls[0][0];
    expect(request.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    release?.({
      ...request,
      replayed: false,
      awardedXp: 15,
      operationCommittedXp: 15,
      currentXp: 15,
      currentLevel: 1,
      committed: rows(1),
    });

    await expect(pending).resolves.toMatchObject({
      ok: true,
      committed: true,
      liveInventoryApplied: true,
      awardedXp: 15,
    });
    expect(quantity(fixture.inventory)).toBe(1);
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(false);
  });

  it("retries an ambiguous commit with exactly the same identity", async () => {
    let stored: BoneBurialCommitReceipt | null = null;
    const fixture = createFixture(async (request) => {
      if (!stored) {
        stored = {
          ...request,
          replayed: false,
          awardedXp: 15,
          operationCommittedXp: 15,
          currentXp: 15,
          currentLevel: 1,
          committed: rows(1),
        };
        throw new Error("ECONNRESET after COMMIT");
      }
      return { ...stored, replayed: true };
    });

    await expect(
      fixture.inventory.commitBoneBurialAtomic(
        PLAYER_ID,
        OPERATION_ID,
        BONES.id,
        15,
        1,
      ),
    ).resolves.toMatchObject({ ok: true, replayed: true });
    expect(
      fixture.database.commitBoneBurialOperationAsync,
    ).toHaveBeenCalledTimes(2);
    expect(
      fixture.database.commitBoneBurialOperationAsync.mock.calls[0][0],
    ).toEqual(fixture.database.commitBoneBurialOperationAsync.mock.calls[1][0]);
    expect(quantity(fixture.inventory)).toBe(1);
  });

  it("treats missing custody as definitive and leaves live inventory unchanged", async () => {
    const fixture = createFixture(async () => {
      throw new Error("bone_burial_insufficient_items");
    });
    await expect(
      fixture.inventory.commitBoneBurialAtomic(
        PLAYER_ID,
        OPERATION_ID,
        BONES.id,
        15,
        1,
      ),
    ).resolves.toMatchObject({
      ok: false,
      retryable: false,
      reason: "item_missing",
    });
    expect(
      fixture.database.commitBoneBurialOperationAsync,
    ).toHaveBeenCalledOnce();
    expect(quantity(fixture.inventory)).toBe(2);
  });
});
