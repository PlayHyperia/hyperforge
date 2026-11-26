import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types/game/item-types";
import type {
  QuestStartCommitReceipt,
  QuestStartCommitRequest,
} from "../../../../types/network/database";
import { EventBus } from "../../infrastructure/EventBus";
import { InventorySystem } from "../InventorySystem";

const PLAYER_ID = "atomic-quest-start-agent";
const QUEST_ID = "atomic_start_quest";
const STARTED_AT = 1_788_140_800_000;
const SWORD: Item = {
  id: "quest_start_sword",
  name: "Quest Start Sword",
  type: "weapon",
  stackable: false,
  description: "Atomic quest-start fixture",
  examine: "Atomic quest-start fixture",
  tradeable: false,
  rarity: "common",
  modelPath: null,
  iconPath: "",
};
const THREAD: Item = {
  id: "quest_start_thread",
  name: "Quest Start Thread",
  type: "resource",
  stackable: true,
  description: "Atomic quest-start fixture",
  examine: "Atomic quest-start fixture",
  tradeable: false,
  rarity: "common",
  modelPath: null,
  iconPath: "",
};
const priorItems = new Map<string, Item | undefined>();

beforeAll(() => {
  for (const item of [SWORD, THREAD]) {
    priorItems.set(item.id, ITEMS.get(item.id));
    ITEMS.set(item.id, item);
  }
});

afterAll(() => {
  for (const item of [SWORD, THREAD]) {
    const prior = priorItems.get(item.id);
    if (prior) ITEMS.set(item.id, prior);
    else ITEMS.delete(item.id);
  }
});

function receiptFor(
  request: QuestStartCommitRequest,
  overrides: Partial<QuestStartCommitReceipt> = {},
): QuestStartCommitReceipt {
  return {
    ...request,
    replayed: false,
    committed: [
      {
        itemId: SWORD.id,
        quantity: 1,
        slotIndex: 0,
        metadata: null,
      },
      {
        itemId: THREAD.id,
        quantity: 5,
        slotIndex: 1,
        metadata: null,
      },
    ],
    ...overrides,
  };
}

function createFixture(
  commit: (
    request: QuestStartCommitRequest,
  ) => Promise<QuestStartCommitReceipt>,
) {
  const database = { commitQuestStartOperationAsync: vi.fn(commit) };
  const eventBus = new EventBus();
  const world = {
    $eventBus: eventBus,
    isServer: true,
    entities: new Map(),
    getSystem: (name: string) => (name === "database" ? database : undefined),
  };
  const inventory = new InventorySystem(world as never);
  (
    inventory as unknown as {
      playerInventories: Map<
        string,
        {
          playerId: string;
          items: Array<{
            slot: number;
            itemId: string;
            quantity: number;
            item: Item;
          }>;
          coins: number;
        }
      >;
    }
  ).playerInventories.set(PLAYER_ID, {
    playerId: PLAYER_ID,
    items: [],
    coins: 0,
  });
  return { inventory, database };
}

function startInput() {
  return {
    questStartedAt: STARTED_AT,
    initialStage: "gather_supplies",
    items: [
      { itemId: THREAD.id, quantity: 5 },
      { itemId: SWORD.id, quantity: 1 },
    ],
  };
}

describe("InventorySystem atomic quest start", () => {
  it("exposes neither progress-adjacent inventory nor an unlocked mutation window before commit", async () => {
    let release: ((receipt: QuestStartCommitReceipt) => void) | undefined;
    const gate = new Promise<QuestStartCommitReceipt>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture(async () => gate);

    const pending = fixture.inventory.commitQuestStartAtomic(
      PLAYER_ID,
      QUEST_ID,
      startInput(),
    );
    await vi.waitFor(() =>
      expect(
        fixture.database.commitQuestStartOperationAsync,
      ).toHaveBeenCalledOnce(),
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([]);
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(true);

    const request =
      fixture.database.commitQuestStartOperationAsync.mock.calls[0][0];
    expect(request.operationId).toMatch(/^quest-start:[a-f0-9]{64}$/);
    expect(request.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(request.items).toEqual([
      { itemId: SWORD.id, quantity: 1, stackable: false },
      { itemId: THREAD.id, quantity: 5, stackable: true },
    ]);
    release?.(receiptFor(request));

    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        committed: true,
        liveInventoryApplied: true,
      }),
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toMatchObject([
      { slot: 0, itemId: SWORD.id, quantity: 1 },
      { slot: 1, itemId: THREAD.id, quantity: 5 },
    ]);
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(false);
  });

  it("replays response loss with byte-identical start identity and starter custody", async () => {
    let stored: QuestStartCommitReceipt | undefined;
    const fixture = createFixture(async (request) => {
      if (!stored) {
        stored = receiptFor(request);
        throw new Error("ECONNRESET after COMMIT");
      }
      return { ...stored, replayed: true };
    });

    await expect(
      fixture.inventory.commitQuestStartAtomic(
        PLAYER_ID,
        QUEST_ID,
        startInput(),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        receipt: expect.objectContaining({ replayed: true }),
      }),
    );
    expect(
      fixture.database.commitQuestStartOperationAsync,
    ).toHaveBeenCalledTimes(2);
    expect(
      fixture.database.commitQuestStartOperationAsync.mock.calls[0][0],
    ).toEqual(fixture.database.commitQuestStartOperationAsync.mock.calls[1][0]);
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toHaveLength(2);
  });

  it("treats capacity rejection as definitive and leaves live inventory untouched", async () => {
    const fixture = createFixture(async () => {
      throw new Error("quest_start_inventory_full");
    });
    await expect(
      fixture.inventory.commitQuestStartAtomic(
        PLAYER_ID,
        QUEST_ID,
        startInput(),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        committed: false,
        retryable: false,
        reason: "inventory_full",
      }),
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([]);
  });

  it("rejects a contradictory durable identity without applying inventory", async () => {
    const fixture = createFixture(async (request) =>
      receiptFor(request, { initialStage: "forged_stage" }),
    );
    await expect(
      fixture.inventory.commitQuestStartAtomic(
        PLAYER_ID,
        QUEST_ID,
        startInput(),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        committed: "unknown",
        reason: "persistence_ambiguous",
      }),
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([]);
  });
});
