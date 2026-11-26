import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getItem, ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types/game/item-types";
import type {
  InventorySaveItem,
  QuestCompletionCommitReceipt,
  QuestCompletionCommitRequest,
} from "../../../../types/network/database";
import { EventBus } from "../../infrastructure/EventBus";
import { InventorySystem } from "../InventorySystem";

const PLAYER_ID = "atomic-quest-agent";
const QUEST_ID = "atomic_quest";
const STARTED_AT = 1_788_137_200_000;
const XP_LAMP: Item = {
  id: "xp_lamp_100",
  name: "XP Lamp (100)",
  type: "consumable",
  stackable: false,
  description: "Quest completion receipt fixture",
  examine: "Quest completion receipt fixture",
  tradeable: false,
  rarity: "rare",
  modelPath: null,
  iconPath: "",
};
let priorLamp: Item | undefined;

beforeAll(() => {
  priorLamp = ITEMS.get(XP_LAMP.id);
  ITEMS.set(XP_LAMP.id, XP_LAMP);
});

afterAll(() => {
  if (priorLamp) ITEMS.set(XP_LAMP.id, priorLamp);
  else ITEMS.delete(XP_LAMP.id);
});

function initialInventory(): InventorySaveItem[] {
  return [];
}

function committedInventory(): InventorySaveItem[] {
  return [
    {
      itemId: XP_LAMP.id,
      quantity: 1,
      slotIndex: 0,
      metadata: null,
    },
  ];
}

function receiptFor(
  request: QuestCompletionCommitRequest,
  overrides: Partial<QuestCompletionCommitReceipt> = {},
): QuestCompletionCommitReceipt {
  return {
    ...request,
    replayed: false,
    completedAt: 1_788_137_205_000,
    operationCommittedQuestPoints: 1,
    currentQuestPoints: 1,
    progress: [
      {
        skill: "attack",
        xpAmount: 500,
        awardedXp: 500,
        operationCommittedXp: 500,
        currentXp: 500,
        currentLevel: 5,
      },
    ],
    prayer: null,
    committed: committedInventory(),
    ...overrides,
  };
}

function createFixture(
  commit: (
    request: QuestCompletionCommitRequest,
  ) => Promise<QuestCompletionCommitReceipt>,
) {
  const database = { commitQuestCompletionOperationAsync: vi.fn(commit) };
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

function completionInput() {
  return {
    questStartedAt: STARTED_AT,
    expectedStage: "return_to_mentor",
    expectedProgress: { kills: 15 },
    questPoints: 1,
    items: [{ itemId: XP_LAMP.id, quantity: 1 }],
    xp: { attack: 500 },
  };
}

async function waitForCommitStart(isStarted: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!isStarted()) {
    if (Date.now() >= deadline) {
      throw new Error("atomic quest completion did not start");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

describe("InventorySystem atomic quest completion", () => {
  it("exposes no reward before quest, points, item, and XP commit together", async () => {
    let release: ((receipt: QuestCompletionCommitReceipt) => void) | undefined;
    const gate = new Promise<QuestCompletionCommitReceipt>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture(async () => gate);

    const pending = fixture.inventory.commitQuestCompletionAtomic(
      PLAYER_ID,
      QUEST_ID,
      completionInput(),
    );
    await waitForCommitStart(
      () =>
        fixture.database.commitQuestCompletionOperationAsync.mock.calls
          .length === 1,
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toEqual([]);
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(true);

    const request =
      fixture.database.commitQuestCompletionOperationAsync.mock.calls[0][0];
    expect(request.operationId).toMatch(/^quest-completion:[a-f0-9]{64}$/);
    expect(request.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(request.items).toEqual([
      { itemId: XP_LAMP.id, quantity: 1, stackable: false },
    ]);
    expect(request.xp).toEqual([{ skill: "attack", xpAmount: 500 }]);
    release?.(receiptFor(request));

    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        committed: true,
        liveInventoryApplied: true,
      }),
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toMatchObject([
      { slot: 0, itemId: XP_LAMP.id, quantity: 1 },
    ]);
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(false);
  });

  it("replays an ambiguous response with byte-identical identity and rewards", async () => {
    let stored: QuestCompletionCommitReceipt | undefined;
    const fixture = createFixture(async (request) => {
      if (!stored) {
        stored = receiptFor(request);
        throw new Error("ECONNRESET after COMMIT");
      }
      return { ...stored, replayed: true };
    });

    await expect(
      fixture.inventory.commitQuestCompletionAtomic(
        PLAYER_ID,
        QUEST_ID,
        completionInput(),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        receipt: expect.objectContaining({ replayed: true }),
      }),
    );
    expect(
      fixture.database.commitQuestCompletionOperationAsync,
    ).toHaveBeenCalledTimes(2);
    expect(
      fixture.database.commitQuestCompletionOperationAsync.mock.calls[0][0],
    ).toEqual(
      fixture.database.commitQuestCompletionOperationAsync.mock.calls[1][0],
    );
    expect(fixture.inventory.getInventory(PLAYER_ID)?.items).toHaveLength(1);
  });

  it("treats full inventory as definitive and leaves live state untouched", async () => {
    const fixture = createFixture(async () => {
      throw new Error("quest_completion_inventory_full");
    });
    await expect(
      fixture.inventory.commitQuestCompletionAtomic(
        PLAYER_ID,
        QUEST_ID,
        completionInput(),
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

  it("rejects a malformed durable level without applying its inventory", async () => {
    const fixture = createFixture(async (request) =>
      receiptFor(request, {
        progress: [
          {
            skill: "attack",
            xpAmount: 500,
            awardedXp: 500,
            operationCommittedXp: 500,
            currentXp: 500,
            currentLevel: 99,
          },
        ],
      }),
    );
    await expect(
      fixture.inventory.commitQuestCompletionAtomic(
        PLAYER_ID,
        QUEST_ID,
        completionInput(),
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

  it("supports the current production shape with item and points but no direct XP", async () => {
    const fixture = createFixture(async (request) =>
      receiptFor(request, { progress: [], committed: committedInventory() }),
    );
    await expect(
      fixture.inventory.commitQuestCompletionAtomic(PLAYER_ID, QUEST_ID, {
        ...completionInput(),
        xp: {},
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    const request =
      fixture.database.commitQuestCompletionOperationAsync.mock.calls[0][0];
    expect(request.xp).toEqual([]);
    expect(getItem(XP_LAMP.id)?.stackable).toBe(false);
    expect(initialInventory()).toEqual([]);
  });
});
