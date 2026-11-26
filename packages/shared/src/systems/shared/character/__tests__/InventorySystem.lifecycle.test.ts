import { describe, expect, it } from "vitest";

import { EventType } from "../../../../types/events";
import { EventBus } from "../../infrastructure/EventBus";
import { InventorySystem } from "../InventorySystem";

describe("InventorySystem player lifecycle", () => {
  it("does not replace existing custody when player registration is repeated", async () => {
    const eventBus = new EventBus();
    const world = {
      $eventBus: eventBus,
      isServer: false,
      entities: new Map(),
      getSystem: () => null,
    };
    const inventory = new InventorySystem(world as never);
    await inventory.init();

    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-repeat-registration" },
      "test",
    );
    const internal = inventory as unknown as {
      playerInventories: Map<
        string,
        {
          items: Array<{
            slot: number;
            itemId: string;
            quantity: number;
            item: { id: string };
          }>;
        }
      >;
    };
    internal.playerInventories.get("agent-repeat-registration")!.items.push({
      slot: 0,
      itemId: "persisted_test_item",
      quantity: 1,
      item: { id: "persisted_test_item" },
    });

    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-repeat-registration" },
      "test",
    );

    expect(
      internal.playerInventories.get("agent-repeat-registration")?.items,
    ).toEqual([
      expect.objectContaining({
        slot: 0,
        itemId: "persisted_test_item",
        quantity: 1,
      }),
    ]);
  });
});
