import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../../types/events";
import type { World } from "../../../../types";
import {
  clearProcessingInteractionPresentation,
  publishProcessingInteractionPresentation,
} from "../ProcessingInteractionPresentation";

function fixture() {
  const player = {
    data: {} as Record<string, unknown>,
    markNetworkDirty: vi.fn(),
  };
  const station = { position: { x: 4, y: 1, z: -3 } };
  const entities = new Map<string, unknown>([
    ["agent", player],
    ["station", station],
  ]);
  const world = {
    entities: { get: (id: string) => entities.get(id) },
    getPlayer: (id: string) => (id === "agent" ? player : undefined),
    emit: vi.fn(),
  } as unknown as World;
  return { world, player, entities };
}

describe("ProcessingInteractionPresentation", () => {
  it("persists monotonic public state and resolves exact entity geometry", () => {
    const { world, player } = fixture();
    const state = publishProcessingInteractionPresentation(world, {
      playerId: "agent",
      skill: "smelting",
      targetEntityId: "station",
    });

    expect(state).toMatchObject({
      revision: 1,
      skill: "smelting",
      phase: "working",
      targetPosition: { x: 4, y: 1, z: -3 },
    });
    expect(player.data.processingInteractionPresentation).toEqual(state);
    expect(player.markNetworkDirty).toHaveBeenCalledOnce();
    expect(world.emit).toHaveBeenCalledWith(
      EventType.PROCESSING_INTERACTION_PRESENTATION,
      { playerId: "agent", ...state },
    );

    const idle = clearProcessingInteractionPresentation(
      world,
      "agent",
      "smelting",
    );
    expect(idle).toEqual({
      revision: 2,
      skill: null,
      phase: "idle",
      phaseStartedAtServerTimeMs: null,
      targetPosition: null,
    });
  });

  it("does not let a stale family clear newer work", () => {
    const { world, player } = fixture();
    publishProcessingInteractionPresentation(world, {
      playerId: "agent",
      skill: "cooking",
      targetPosition: { x: 1, y: 0, z: 1 },
    });
    expect(
      clearProcessingInteractionPresentation(world, "agent", "smithing"),
    ).toBeNull();
    expect(player.data.processingInteractionPresentation).toMatchObject({
      skill: "cooking",
      phase: "working",
    });
  });

  it("publishes terminal cleanup after the player leaves the entity index", () => {
    const { world, entities } = fixture();
    publishProcessingInteractionPresentation(world, {
      playerId: "agent",
      skill: "tanning",
      targetEntityId: "station",
    });
    entities.delete("agent");
    const idle = clearProcessingInteractionPresentation(
      world,
      "agent",
      "tanning",
    );
    if (!idle) throw new Error("terminal presentation was not published");
    expect(idle).toMatchObject({ revision: 2, phase: "idle" });
    expect(world.emit).toHaveBeenLastCalledWith(
      EventType.PROCESSING_INTERACTION_PRESENTATION,
      { playerId: "agent", ...idle },
    );
  });
});
