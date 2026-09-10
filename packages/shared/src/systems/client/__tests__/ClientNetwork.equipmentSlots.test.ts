import { describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { EQUIPMENT_SLOT_NAMES } from "../../../constants/EquipmentConstants";
import { EventType } from "../../../types/events";
import { ClientNetwork } from "../ClientNetwork";

describe("replicated equipment slot coverage", () => {
  it("emits every canonical slot, including boots/gloves, and clears omitted slots", () => {
    const world = new World();
    const network = new ClientNetwork(world);
    const events: Array<{
      playerId: string;
      slot: string;
      itemId: string | null;
    }> = [];
    const listener = (event: (typeof events)[number]) => events.push(event);
    world.on(EventType.PLAYER_EQUIPMENT_CHANGED, listener);
    try {
      const equipment = {
        weapon: { itemId: "bronze_shortsword" },
        boots: { itemId: "bronze_boots" },
        gloves: { item: { id: "bronze_gloves" } },
      };
      network.onEquipmentUpdated({ playerId: "slot-test-player", equipment });
      expect(network.lastEquipmentByPlayerId["slot-test-player"]).toBe(
        equipment,
      );
      expect(events).toEqual(
        EQUIPMENT_SLOT_NAMES.map((slot) => ({
          playerId: "slot-test-player",
          slot,
          itemId:
            slot === "weapon"
              ? "bronze_shortsword"
              : slot === "boots"
                ? "bronze_boots"
                : slot === "gloves"
                  ? "bronze_gloves"
                  : null,
        })),
      );
      events.length = 0;
      network.onEquipmentUpdated({
        playerId: "slot-test-player",
        equipment: {},
      });
      expect(events).toEqual(
        EQUIPMENT_SLOT_NAMES.map((slot) => ({
          playerId: "slot-test-player",
          slot,
          itemId: null,
        })),
      );
    } finally {
      world.off(EventType.PLAYER_EQUIPMENT_CHANGED, listener);
    }
  });
});
