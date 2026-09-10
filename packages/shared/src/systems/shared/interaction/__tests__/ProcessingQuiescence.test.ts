import { describe, expect, it, vi } from "vitest";

import {
  acquirePreparationActionFence,
  canPlayerPerformPreparationAction,
  type PreparationActionAuthorityWorld,
} from "../ProcessingStationAuthority";
import {
  isPlayerProcessingQuiescent,
  PROCESSING_QUIESCENCE_SYSTEM_NAMES,
  requestPlayerProcessingQuiescence,
  type PlayerProcessingQuiescenceSystem,
} from "../ProcessingQuiescence";

function createWorld(
  systems: Record<string, unknown> = {},
): PreparationActionAuthorityWorld {
  const player = {
    id: "agent-alpha",
    position: { x: 1, y: 0, z: 1 },
    data: { inStreamingDuel: false },
  };
  return {
    getPlayer: (playerId: string) =>
      playerId === "agent-alpha" ? player : undefined,
    entities: {
      get: (playerId: string) =>
        playerId === "agent-alpha" ? player : undefined,
    },
    getSystem: (name: string) => systems[name],
  } as unknown as PreparationActionAuthorityWorld;
}

function controller(idle: boolean): PlayerProcessingQuiescenceSystem & {
  requestPlayerProcessingQuiescence: ReturnType<typeof vi.fn>;
} {
  return {
    requestPlayerProcessingQuiescence: vi.fn(),
    isPlayerProcessingQuiescent: () => idle,
  };
}

describe("processing quiescence", () => {
  it("keeps independent admission fences closed until every owner releases", () => {
    const world = createWorld();
    const first = acquirePreparationActionFence(world, "agent-alpha");
    const second = acquirePreparationActionFence(world, "agent-alpha");

    expect(canPlayerPerformPreparationAction(world, "agent-alpha")).toBe(false);
    first.release();
    first.release();
    expect(first.isReleased()).toBe(true);
    expect(canPlayerPerformPreparationAction(world, "agent-alpha")).toBe(false);

    second.release();
    expect(canPlayerPerformPreparationAction(world, "agent-alpha")).toBe(true);
  });

  it("requests every loaded family and waits for exact per-player idle truth", () => {
    const systems = Object.fromEntries(
      PROCESSING_QUIESCENCE_SYSTEM_NAMES.map((systemName) => [
        systemName,
        controller(systemName !== "smithing"),
      ]),
    ) as Record<
      (typeof PROCESSING_QUIESCENCE_SYSTEM_NAMES)[number],
      ReturnType<typeof controller>
    >;
    const world = createWorld(systems);

    expect(requestPlayerProcessingQuiescence(world, "agent-alpha")).toEqual({
      ok: true,
    });
    for (const systemName of PROCESSING_QUIESCENCE_SYSTEM_NAMES) {
      expect(
        systems[systemName].requestPlayerProcessingQuiescence,
      ).toHaveBeenCalledOnce();
      expect(
        systems[systemName].requestPlayerProcessingQuiescence,
      ).toHaveBeenCalledWith("agent-alpha");
    }
    expect(isPlayerProcessingQuiescent(world, "agent-alpha")).toBe(false);
    systems.smithing.isPlayerProcessingQuiescent = () => true;
    expect(isPlayerProcessingQuiescent(world, "agent-alpha")).toBe(true);
  });

  it("fails closed on a loaded stale system contract or thrown request", () => {
    const staleWorld = createWorld({ processing: {} });
    expect(
      requestPlayerProcessingQuiescence(staleWorld, "agent-alpha"),
    ).toEqual({
      ok: false,
      reason: "invalid_system_contract",
      systemName: "processing",
    });
    expect(isPlayerProcessingQuiescent(staleWorld, "agent-alpha")).toBe(false);

    const throwing = controller(true);
    throwing.requestPlayerProcessingQuiescence.mockImplementation(() => {
      throw new Error("injected");
    });
    expect(
      requestPlayerProcessingQuiescence(
        createWorld({ runecrafting: throwing }),
        "agent-alpha",
      ),
    ).toEqual({
      ok: false,
      reason: "quiescence_request_failed",
      systemName: "runecrafting",
    });
  });
});
