import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types/game/item-types";
import { PlayerMigration } from "../../../../types/core/core";
import { EventType } from "../../../../types/events";
import { EventBus } from "../../infrastructure/EventBus";
import { PlayerSystem } from "../PlayerSystem";

const ITEM_ID = "atomic_player_prayer_bones";
const OPERATION_ID = "cb764dfd-2b53-5f0d-8dd6-01cabce2d0db";
const ITEM: Item = {
  id: ITEM_ID,
  name: "Player Prayer Bones",
  type: "resource",
  stackable: true,
  maxStackSize: 10_000,
  prayerXp: 15,
  buryLevelRequired: 1,
  description: "Atomic player prayer fixture",
  examine: "Atomic player prayer fixture",
  tradeable: false,
  rarity: "common",
  modelPath: null,
  iconPath: "",
};
let priorItem: Item | undefined;

beforeAll(() => {
  priorItem = ITEMS.get(ITEM_ID);
  ITEMS.set(ITEM_ID, ITEM);
});

afterAll(() => {
  if (priorItem) ITEMS.set(ITEM_ID, priorItem);
  else ITEMS.delete(ITEM_ID);
});

function committedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    playerId: "agent-a",
    operationId: OPERATION_ID,
    replayed: false,
    itemId: ITEM_ID,
    xpAmount: 15,
    levelRequired: 1,
    awardedXp: 15,
    operationCommittedXp: 15,
    currentXp: 15,
    currentLevel: 1,
    ...overrides,
  };
}

function createFixture(
  commitImplementation = vi.fn(async () => committedReceipt()),
  reloadImplementation = vi.fn(async () => ({
    ready: true,
    persistenceHealthy: true,
    pointUnits: 1_000_000,
    points: 1,
    maxPoints: 1,
    activePrayers: [],
  })),
) {
  const eventBus = new EventBus();
  const inventory = { commitBoneBurialAtomic: commitImplementation };
  const skills = { reconcileCommittedPrayerProgression: vi.fn(() => true) };
  const prayer = { reloadPrayerState: reloadImplementation };
  const world = {
    isServer: true,
    currentTick: 100,
    $eventBus: eventBus,
    entities: new Map(),
    getSystem: vi.fn((name: string) =>
      name === "inventory"
        ? inventory
        : name === "skills"
          ? skills
          : name === "prayer"
            ? prayer
            : undefined,
    ),
  };
  const system = new PlayerSystem(world as never);
  const player = PlayerMigration.createNewPlayer(
    "agent-a",
    "agent-a",
    "Agent A",
  );
  player.health.current = 20;
  player.health.max = 20;
  player.alive = true;
  (system as unknown as { players: Map<string, typeof player> }).players.set(
    player.id,
    player,
  );
  return { world, system, inventory, skills, prayer };
}

describe("PlayerSystem atomic bone burial", () => {
  it("does not expose XP, custody, cooldown, or success before commit", async () => {
    let release:
      ((receipt: ReturnType<typeof committedReceipt>) => void) | null = null;
    const commit = vi.fn(
      async () =>
        new Promise<ReturnType<typeof committedReceipt>>((resolve) => {
          release = resolve;
        }),
    );
    const fixture = createFixture(commit);
    const emitEvent = vi.spyOn(fixture.world.$eventBus, "emitEvent");
    const pending = fixture.system.buryBoneAtomic(
      "agent-a",
      ITEM_ID,
      OPERATION_ID,
    );
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(
      fixture.skills.reconcileCommittedPrayerProgression,
    ).not.toHaveBeenCalled();
    expect(fixture.prayer.reloadPrayerState).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalledWith(
      EventType.UI_MESSAGE,
      expect.anything(),
      expect.anything(),
    );

    release?.(committedReceipt());
    await expect(pending).resolves.toMatchObject({
      ok: true,
      committed: true,
      liveStateApplied: true,
      awardedXp: 15,
    });
    expect(
      fixture.skills.reconcileCommittedPrayerProgression,
    ).toHaveBeenCalledWith("agent-a", 15, 1, 15, false);
    expect(fixture.prayer.reloadPrayerState).toHaveBeenCalledWith("agent-a");
    expect(emitEvent).not.toHaveBeenCalledWith(
      EventType.SKILLS_XP_GAINED,
      expect.anything(),
      expect.anything(),
    );
    expect(emitEvent).not.toHaveBeenCalledWith(
      EventType.INVENTORY_REMOVE_ITEM,
      expect.anything(),
      expect.anything(),
    );
  });

  it("holds a committed action open until every live view converges", async () => {
    const commit = vi
      .fn()
      .mockResolvedValueOnce(committedReceipt({ liveInventoryApplied: false }))
      .mockResolvedValueOnce(committedReceipt({ replayed: true }));
    const fixture = createFixture(commit);

    await expect(
      fixture.system.buryBoneAtomic("agent-a", ITEM_ID, OPERATION_ID),
    ).resolves.toMatchObject({
      ok: false,
      committed: true,
      retryable: true,
      reason: "live_state_apply_failed",
    });
    expect(
      fixture.skills.reconcileCommittedPrayerProgression,
    ).not.toHaveBeenCalled();

    await expect(
      fixture.system.buryBoneAtomic("agent-a", ITEM_ID, OPERATION_ID),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      replayed: true,
      liveStateApplied: true,
    });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0]).toEqual(commit.mock.calls[1]);
  });

  it("allows an exact receipt replay through cooldown without duplicating presentation", async () => {
    const commit = vi
      .fn()
      .mockResolvedValueOnce(committedReceipt())
      .mockResolvedValueOnce(committedReceipt({ replayed: true }));
    const fixture = createFixture(commit);
    const emitEvent = vi.spyOn(fixture.world.$eventBus, "emitEvent");

    await expect(
      fixture.system.buryBoneAtomic("agent-a", ITEM_ID, OPERATION_ID),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(
      fixture.system.buryBoneAtomic("agent-a", ITEM_ID, OPERATION_ID),
    ).resolves.toMatchObject({ ok: true, replayed: true });
    const successMessages = emitEvent.mock.calls.filter(
      ([event, payload]) =>
        event === EventType.UI_MESSAGE &&
        (payload as { message?: string }).message === "You bury the bones.",
    );
    expect(successMessages).toHaveLength(1);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("never starts cooldown after a definitive custody rejection", async () => {
    const commit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        committed: false,
        liveInventoryApplied: false,
        playerId: "agent-a",
        operationId: OPERATION_ID,
        replayed: false,
        itemId: ITEM_ID,
        xpAmount: 15,
        levelRequired: 1,
        retryable: false,
        reason: "item_missing",
      })
      .mockResolvedValueOnce(committedReceipt());
    const fixture = createFixture(commit);
    await expect(
      fixture.system.buryBoneAtomic("agent-a", ITEM_ID, OPERATION_ID),
    ).resolves.toMatchObject({ ok: false, reason: "item_missing" });
    await expect(
      fixture.system.buryBoneAtomic(
        "agent-a",
        ITEM_ID,
        "f68f34d1-ca57-577a-b148-69711051eb78",
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(commit).toHaveBeenCalledTimes(2);
  });
});
