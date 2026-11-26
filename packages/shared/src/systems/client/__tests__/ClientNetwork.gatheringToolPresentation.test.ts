import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../types/events";
import type { World } from "../../../types/index";
import { ClientNetwork } from "../ClientNetwork";

describe("ClientNetwork gathering-tool presentation authority", () => {
  it("preserves server transition revisions through the client event boundary", () => {
    const emit = vi.fn();
    const network = new ClientNetwork({ emit } as unknown as World);

    network.onGatheringToolShow({
      playerId: "agent-1",
      itemId: "small_fishing_net",
      slot: "weapon",
      revision: 41,
    });
    network.onGatheringToolHide({
      playerId: "agent-1",
      slot: "weapon",
      revision: 42,
    });

    expect(emit).toHaveBeenNthCalledWith(1, EventType.GATHERING_TOOL_SHOW, {
      playerId: "agent-1",
      itemId: "small_fishing_net",
      slot: "weapon",
      revision: 41,
    });
    expect(emit).toHaveBeenNthCalledWith(2, EventType.GATHERING_TOOL_HIDE, {
      playerId: "agent-1",
      slot: "weapon",
      revision: 42,
    });
  });

  it("forwards exact fishing phase authority without rewriting it", () => {
    const emit = vi.fn();
    const network = new ClientNetwork({ emit } as unknown as World);
    const state = {
      playerId: "agent-1",
      revision: 43,
      interactionId: "fishing:session-43",
      resourceId: "fishing_spot_net_1",
      itemId: "small_fishing_net",
      phase: "deployed",
      outcome: "none",
      attempt: 2,
      serverTick: 510,
      targetPosition: { x: 14, y: 0.25, z: -3 },
    } as const;

    network.onFishingInteractionPresentation(state);

    expect(emit).toHaveBeenCalledWith(
      EventType.FISHING_INTERACTION_PRESENTATION,
      state,
    );
  });

  it("strictly forwards processing state and rejects privacy-expanded packets", () => {
    const emit = vi.fn();
    const entity = { position: { x: 0, y: 0, z: 0 } };
    const world = {
      emit,
      entities: { get: () => entity },
    } as unknown as World;
    const network = new ClientNetwork(world);
    const setRotation = vi.spyOn(network.tileInterpolator, "setCombatRotation");
    const state = {
      playerId: "agent-1",
      revision: 44,
      skill: "smithing",
      phase: "working",
      phaseStartedAtServerTimeMs: 12_000,
      targetPosition: { x: 4, y: 0, z: -2 },
    } as const;

    network.onProcessingInteractionPresentation(state);
    network.onProcessingInteractionPresentation({
      ...state,
      revision: 45,
      recipeId: "must-not-cross-boundary",
    } as never);

    expect(setRotation).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      EventType.PROCESSING_INTERACTION_PRESENTATION,
      state,
    );
  });
});
