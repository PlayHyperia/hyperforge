import { describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { EventType, type EventMap } from "../../../types/events";
import { ClientNetwork } from "../ClientNetwork";

describe("enter-world rejection through the actual client event bus", () => {
  for (const id of ["rejected-player", null]) {
    for (const [reason, expectedReason] of [
      ["state_unavailable", "state_unavailable"],
      ["already_logged_in", "duplicate_user"],
      ["auth_required", "auth_required"],
      ["future_rejection", "future_rejection"],
      ["", "unknown"],
    ]) {
      it(`${reason || "empty reason"} preserves the UI reason with ${id ?? "no player ID"}`, () => {
        const world = new World();
        const network = world.register(
          "network",
          ClientNetwork,
        ) as ClientNetwork;
        network.id = id;
        const events: EventMap[EventType.UI_KICK][] = [];
        const busEvents: EventMap[EventType.UI_KICK][] = [];
        const listener = (event: EventMap[EventType.UI_KICK]) => {
          events.push(event);
        };
        // Subscribe exactly as CoreUI does, and independently at the real bus.
        world.on(EventType.UI_KICK, listener);
        const subscription = world.$eventBus.subscribe<
          EventMap[EventType.UI_KICK]
        >(EventType.UI_KICK, (event) => {
          busEvents.push(event.data);
        });
        try {
          network.onEnterWorldRejected({ reason, message: "Entry rejected" });
          const expected = [
            { playerId: id ?? "unknown", reason: expectedReason },
          ];
          expect(events).toEqual(expected);
          expect(busEvents).toEqual(expected);
        } finally {
          world.off(EventType.UI_KICK, listener);
          subscription.unsubscribe();
          world.destroy();
        }
      });
    }
  }
});
