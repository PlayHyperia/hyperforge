import { describe, expect, it, vi } from "vitest";

import { getItem } from "../../../../data/items";
import type {
  FoodConsumptionCommitReceipt,
  FoodConsumptionCommitRequest,
} from "../../../../types/network/database";
import type { StreamingDuelFoodObservationContext } from "../../../../types/game/streaming-duel-action-observation";
import { EventBus } from "../../infrastructure/EventBus";
import { InventorySystem } from "../InventorySystem";

const PLAYER_ID = "food-custody-agent";

function committedInventory(quantity = 1) {
  return quantity > 0
    ? [
        {
          itemId: "lobster",
          quantity,
          slotIndex: 4,
          metadata: null,
        },
      ]
    : [];
}

function createFixture(
  commit: (
    request: FoodConsumptionCommitRequest,
  ) => Promise<FoodConsumptionCommitReceipt>,
) {
  const database = {
    commitFoodConsumptionOperationAsync: vi.fn(commit),
  };
  const inventory = new InventorySystem({
    $eventBus: new EventBus(),
    isServer: true,
    getSystem: (name: string) => (name === "database" ? database : undefined),
  } as never);
  const lobster = getItem("lobster");
  if (!lobster) throw new Error("missing lobster fixture");
  (
    inventory as unknown as {
      playerInventories: Map<
        string,
        {
          playerId: string;
          coins: number;
          items: Array<{
            slot: number;
            itemId: string;
            quantity: number;
            item: typeof lobster;
          }>;
        }
      >;
    }
  ).playerInventories.set(PLAYER_ID, {
    playerId: PLAYER_ID,
    coins: 0,
    items: [{ slot: 4, itemId: "lobster", quantity: 2, item: lobster }],
  });
  return { inventory, database };
}

function quantity(inventory: InventorySystem): number {
  return inventory.getInventory(PLAYER_ID)?.items[0]?.quantity ?? 0;
}

describe("InventorySystem atomic food custody", () => {
  it("keeps the live item locked and unchanged until the pending receipt commits", async () => {
    let release: ((receipt: FoodConsumptionCommitReceipt) => void) | undefined;
    const gate = new Promise<FoodConsumptionCommitReceipt>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture(async () => gate);
    const pending = fixture.inventory.commitFoodConsumptionAtomic(
      PLAYER_ID,
      "food:locked-receipt",
      "lobster",
      12,
    );
    await vi.waitFor(() =>
      expect(
        fixture.database.commitFoodConsumptionOperationAsync,
      ).toHaveBeenCalledOnce(),
    );
    expect(quantity(fixture.inventory)).toBe(2);
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(true);
    await expect(
      fixture.inventory.removeItemDirect(PLAYER_ID, {
        itemId: "lobster",
        quantity: 1,
      }),
    ).resolves.toBe(false);

    const request =
      fixture.database.commitFoodConsumptionOperationAsync.mock.calls[0]![0];
    release?.({
      ...request,
      replayed: false,
      status: "pending",
      healedAmount: 0,
      healthAfter: null,
      committed: committedInventory(1),
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      committed: true,
      liveInventoryApplied: true,
      receipt: { status: "pending", replayed: false },
    });
    expect(quantity(fixture.inventory)).toBe(1);
    expect(fixture.inventory.isLockedForTransaction(PLAYER_ID)).toBe(false);
    expect(request.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("recovers an ambiguous commit response with the exact same identity", async () => {
    let stored: FoodConsumptionCommitReceipt | undefined;
    const fixture = createFixture(async (request) => {
      if (!stored) {
        stored = {
          ...request,
          replayed: false,
          status: "pending",
          healedAmount: 0,
          healthAfter: null,
          committed: committedInventory(1),
        };
        throw new Error("ECONNRESET after COMMIT");
      }
      return { ...stored, replayed: true };
    });
    await expect(
      fixture.inventory.commitFoodConsumptionAtomic(
        PLAYER_ID,
        "food:ambiguous-receipt",
        "lobster",
        12,
      ),
    ).resolves.toMatchObject({
      ok: true,
      receipt: { replayed: true, status: "pending" },
    });
    expect(
      fixture.database.commitFoodConsumptionOperationAsync,
    ).toHaveBeenCalledTimes(2);
    expect(
      fixture.database.commitFoodConsumptionOperationAsync.mock.calls[0]![0],
    ).toEqual(
      fixture.database.commitFoodConsumptionOperationAsync.mock.calls[1]![0],
    );
    expect(quantity(fixture.inventory)).toBe(1);
  });

  it("returns a committed receipt when the live snapshot needs database reload", async () => {
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: false,
      status: "pending",
      healedAmount: 0,
      healthAfter: null,
      committed: [
        {
          itemId: "missing-runtime-definition",
          quantity: 1,
          slotIndex: 4,
          metadata: null,
        },
      ],
    }));
    vi.spyOn(fixture.inventory, "reloadFromDatabase").mockRejectedValueOnce(
      new Error("reload unavailable"),
    );
    await expect(
      fixture.inventory.commitFoodConsumptionAtomic(
        PLAYER_ID,
        "food:reload-receipt",
        "lobster",
        12,
      ),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      liveInventoryApplied: false,
      receipt: { status: "pending" },
    });
    expect(quantity(fixture.inventory)).toBe(2);
  });

  it("does not retry a definitive full-health rejection", async () => {
    const fixture = createFixture(async () => {
      throw new Error("food_consumption_full_health");
    });
    await expect(
      fixture.inventory.commitFoodConsumptionAtomic(
        PLAYER_ID,
        "food:full-health",
        "lobster",
        12,
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: false,
      reason: "full_health",
    });
    expect(
      fixture.database.commitFoodConsumptionOperationAsync,
    ).toHaveBeenCalledOnce();
    expect(quantity(fixture.inventory)).toBe(2);
  });

  it("fingerprints only a strict actor-bound duel observation context", async () => {
    const context = {
      operationId: "00000000-0000-4000-8000-000000000303",
      tick: 6,
      observedAt: 1_800_000_000_006,
      cycleId: "cycle-inventory-food",
      duelId: "duel-inventory-food",
      actorId: PLAYER_ID,
      opponentId: "food-custody-opponent",
      phase: "FIGHTING",
      combatRole: "ranged",
      tacticalMacro: "kite",
    } satisfies StreamingDuelFoodObservationContext;
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: false,
      status: "pending",
      healedAmount: 0,
      healthAfter: null,
      committed: committedInventory(1),
    }));

    await expect(
      fixture.inventory.commitFoodConsumptionAtomic(
        PLAYER_ID,
        "food:public-context",
        "lobster",
        12,
        context,
      ),
    ).resolves.toMatchObject({ ok: true, committed: true });
    expect(
      fixture.database.commitFoodConsumptionOperationAsync.mock.calls[0]?.[0],
    ).toMatchObject({
      publicActionObservation: context,
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const invalidFixture = createFixture(async () => {
      throw new Error("database must not be reached");
    });
    await expect(
      invalidFixture.inventory.commitFoodConsumptionAtomic(
        PLAYER_ID,
        "food:invalid-public-context",
        "lobster",
        12,
        { ...context, actorId: "different-agent" },
      ),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_request" });
    expect(
      invalidFixture.database.commitFoodConsumptionOperationAsync,
    ).not.toHaveBeenCalled();
  });
});
