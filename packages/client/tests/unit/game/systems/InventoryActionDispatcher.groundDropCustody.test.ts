import { describe, expect, it, vi } from "vitest";

import {
  dispatchInventoryAction,
  type InventoryActionContext,
} from "../../../../src/game/systems/InventoryActionDispatcher";

const OPERATION_ID = "ground-item-drop:11111111-1111-4111-8111-111111111111";

function createWorld(options?: { dropItem?: false | (() => string) }) {
  const applyOptimisticRemoval = vi.fn();
  const send = vi.fn();
  const dropItem =
    options?.dropItem === false
      ? undefined
      : vi.fn(options?.dropItem ?? (() => OPERATION_ID));
  const world = {
    getPlayer: vi.fn(() => ({ id: "drop-player" })),
    emit: vi.fn(),
    network: { send, dropItem, applyOptimisticRemoval },
    chat: null,
  };
  return {
    world: world as unknown as InventoryActionContext["world"],
    send,
    dropItem,
    applyOptimisticRemoval,
  };
}

describe("InventoryActionDispatcher ground-drop custody", () => {
  it("binds the intent before applying its optimistic projection", () => {
    const fixture = createWorld();

    expect(
      dispatchInventoryAction("drop", {
        world: fixture.world,
        itemId: "air_rune",
        slot: 3,
        quantity: 2,
      }),
    ).toEqual({ success: true, operationId: OPERATION_ID });
    expect(fixture.dropItem).toHaveBeenCalledWith("air_rune", 3, 2);
    expect(fixture.applyOptimisticRemoval).toHaveBeenCalledWith(
      "drop-player",
      3,
      2,
    );
    expect(fixture.applyOptimisticRemoval).toHaveBeenCalledAfter(
      fixture.dropItem!,
    );
  });

  it("fails closed when the authoritative operation surface is absent", () => {
    const fixture = createWorld({ dropItem: false });

    expect(
      dispatchInventoryAction("drop", {
        world: fixture.world,
        itemId: "air_rune",
        slot: 3,
        quantity: 2,
      }),
    ).toEqual({
      success: false,
      message: "Authoritative item dropping is unavailable",
    });
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.applyOptimisticRemoval).not.toHaveBeenCalled();
  });

  it("does not hide an item when secure identity creation fails", () => {
    const fixture = createWorld({
      dropItem: () => {
        throw new Error("secure identity unavailable");
      },
    });

    expect(
      dispatchInventoryAction("drop", {
        world: fixture.world,
        itemId: "air_rune",
        slot: 3,
        quantity: 2,
      }),
    ).toEqual({
      success: false,
      message: "Could not create an authoritative drop operation",
    });
    expect(fixture.applyOptimisticRemoval).not.toHaveBeenCalled();
  });
});
