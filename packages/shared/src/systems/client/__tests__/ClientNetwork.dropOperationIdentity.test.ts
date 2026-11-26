import { describe, expect, it, vi } from "vitest";

import type { World } from "../../../types/index";
import { EventType } from "../../../types/events";
import { ClientNetwork } from "../ClientNetwork";

describe("ClientNetwork ground-drop operation identity", () => {
  it("binds each user intent to one secure identity before network delivery", () => {
    const network = new ClientNetwork({} as World);
    const send = vi.spyOn(network, "send").mockImplementation(() => undefined);

    const operationId = network.dropItem("air_rune", 3, 2);

    expect(operationId).toMatch(
      /^ground-item-drop:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(send).toHaveBeenCalledWith("dropItem", {
      itemId: "air_rune",
      slot: 3,
      quantity: 2,
      operationId,
    });
  });

  it("never reuses an operation identity for a separate user intent", () => {
    const network = new ClientNetwork({} as World);
    vi.spyOn(network, "send").mockImplementation(() => undefined);

    const first = network.dropItem("air_rune", 3, 1);
    const second = network.dropItem("air_rune", 3, 1);

    expect(second).not.toBe(first);
  });

  it("re-emits the exact authoritative receipt for operation-aware clients", () => {
    const emit = vi.fn();
    const network = new ClientNetwork({ emit } as unknown as World);
    const receipt = {
      success: true as const,
      committed: true as const,
      playerId: "drop-agent",
      operationId: "ground-item-drop:11111111-1111-4111-8111-111111111111",
      itemId: "air_rune",
      quantity: 2,
      sourceId: "ground_item_22222222-2222-4222-8222-222222222222",
      position: { x: 4.5, y: 0.1, z: 8.5 },
      replayed: false,
      liveInventoryApplied: true,
      liveCoinsApplied: true,
      presentationReady: true,
    };

    network.onGroundItemDropResult(receipt);

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(EventType.ITEM_DROP_RESULT, receipt);
  });
});
