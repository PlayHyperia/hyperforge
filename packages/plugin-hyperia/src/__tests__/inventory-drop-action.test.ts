import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { dropItemAction } from "../actions/inventory";
import type { GroundItemDropResult } from "../types";

function rejection(
  itemId: string,
  quantity: number,
  reason = "insufficient_items",
): GroundItemDropResult {
  return {
    success: false,
    committed: false,
    playerId: "drop-agent",
    operationId: "ground-item-drop:11111111-1111-4111-8111-111111111111",
    itemId,
    quantity,
    reason,
  };
}

function success(itemId: string, quantity: number): GroundItemDropResult {
  return {
    success: true,
    committed: true,
    playerId: "drop-agent",
    operationId: "ground-item-drop:11111111-1111-4111-8111-111111111111",
    itemId,
    quantity,
    sourceId: "ground_item_22222222-2222-4222-8222-222222222222",
    position: { x: 1, y: 0, z: 1 },
    replayed: false,
    liveInventoryApplied: true,
    liveCoinsApplied: true,
    presentationReady: true,
  };
}

function createRuntime(
  executeDropItem: ReturnType<typeof vi.fn>,
  items = [
    {
      id: "air_rune",
      itemId: "air_rune",
      name: "Air rune",
      quantity: 2,
      slot: 3,
    },
  ],
) {
  const service = {
    getPlayerEntity: vi.fn().mockReturnValue({ id: "drop-agent", items }),
    executeDropItem,
  };
  return {
    runtime: { getService: vi.fn().mockReturnValue(service) },
    service,
  };
}

describe("DROP_ITEM authoritative completion", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not report a single item as dropped after an authoritative rejection", async () => {
    const executeDropItem = vi.fn().mockResolvedValue(rejection("air_rune", 1));
    const { runtime } = createRuntime(executeDropItem);
    const callback = vi.fn();

    const result = await dropItemAction.handler?.(
      runtime as never,
      { content: { text: "drop the air rune" } } as never,
      undefined,
      undefined,
      callback,
    );

    expect(result).toMatchObject({ success: false });
    expect(executeDropItem).toHaveBeenCalledWith("air_rune", 1, 3);
    expect(callback).toHaveBeenCalledWith({
      text: "Failed to drop: insufficient_items",
      error: true,
    });
    expect(callback).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "DROP_ITEM" }),
    );
  });

  it("reports drop-all as failed when no authoritative receipt commits", async () => {
    vi.useFakeTimers();
    const executeDropItem = vi
      .fn()
      .mockImplementation((itemId: string, quantity: number) =>
        Promise.resolve(rejection(itemId, quantity)),
      );
    const { runtime } = createRuntime(executeDropItem);
    const callback = vi.fn();
    const pending = dropItemAction.handler?.(
      runtime as never,
      { content: { text: "drop everything" } } as never,
      undefined,
      undefined,
      callback,
    );

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      success: false,
      text: "No items were dropped (1 failed)",
    });
    expect(callback).toHaveBeenCalledWith({
      text: "No items were dropped (1 failed)",
      error: true,
    });
  });

  it("reports partial drop-all custody honestly", async () => {
    vi.useFakeTimers();
    const executeDropItem = vi
      .fn()
      .mockResolvedValueOnce(success("air_rune", 2))
      .mockResolvedValueOnce(rejection("mind_rune", 4));
    const { runtime } = createRuntime(executeDropItem, [
      {
        id: "air_rune",
        itemId: "air_rune",
        name: "Air rune",
        quantity: 2,
        slot: 3,
      },
      {
        id: "mind_rune",
        itemId: "mind_rune",
        name: "Mind rune",
        quantity: 4,
        slot: 4,
      },
    ]);
    const callback = vi.fn();
    const pending = dropItemAction.handler?.(
      runtime as never,
      { content: { text: "drop all items" } } as never,
      undefined,
      undefined,
      callback,
    );

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      success: false,
      text: "Dropped Air rune (1 failed)",
    });
    expect(callback).toHaveBeenCalledWith({
      text: "Dropped Air rune (1 failed)",
      error: true,
    });
  });
});
