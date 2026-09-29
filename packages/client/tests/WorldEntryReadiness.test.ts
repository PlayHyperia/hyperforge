import { describe, expect, it } from "vitest";
import { World } from "../../shared/src/core/World";
import { TerrainSystem } from "../../shared/src/systems/shared/world/TerrainSystem";
import {
  readWorldEntryReadiness,
  WorldEntryPresentationGate,
  type WorldEntryReadiness,
} from "../src/game/WorldEntryReadiness";

// Explicit state inputs exercise the actual production CPU gate. They do not
// substitute for a browser, world initializer, renderer, network or terrain.
function ready(): WorldEntryReadiness {
  return {
    owner: {},
    connection: {},
    targetId: "selected-character",
    ownershipReady: true,
    ready: true,
    playerReady: true,
    physReady: true,
    terrainReady: true,
    blockedChunks: 0,
    selecting: false,
    recovering: false,
  };
}

describe("world entry presentation ownership", () => {
  it("requires both independently revalidated presentation delays", () => {
    const gate = new WorldEntryPresentationGate(),
      state = ready();
    expect(gate.advance(state, 100)).toBe("settling");
    expect(gate.nextDelay(100)).toBe(250);
    expect(gate.advance(state, 399)).toBe("settling");
    expect(gate.nextDelay(399)).toBe(1);
    expect(gate.advance(state, 400)).toBe("fading");
    expect(gate.nextDelay(400)).toBe(220);
    expect(gate.advance(state, 619)).toBe("fading");
    expect(gate.advance(state, 620)).toBe("committed");
  });

  it("does not count an unsampled delayed fade as already completed", () => {
    const gate = new WorldEntryPresentationGate(),
      state = ready();
    gate.advance(state, 0);
    expect(gate.advance(state, 1_000_000)).toBe("fading");
    expect(gate.advance(state, 1_000_219)).toBe("fading");
    expect(gate.advance(state, 1_000_220)).toBe("committed");
  });

  it("never bypasses an absent initialization/ownership receipt because time has passed", () => {
    const gate = new WorldEntryPresentationGate(),
      state = ready();
    const pending = { ...state, ownershipReady: false, ready: false };
    for (const now of [0, 19_999, 20_000, 3_600_000])
      expect(gate.advance(pending, now)).toBe("loading");
    expect(gate.advance(state, 3_600_001)).toBe("settling");
  });

  it.each([null, "owner", "connection"] as const)(
    "fails closed with missing ownership %s even if ready is incorrectly true",
    (missing) => {
      const state = ready();
      if (missing === null) state.ownershipReady = false;
      else state[missing] = null;
      const gate = new WorldEntryPresentationGate();
      for (const now of [0, 300, 520, 20_000])
        expect(gate.advance(state, now)).toBe("loading");
    },
  );

  it.each([299, 519])("revokes a readiness loss at %ims", (now) => {
    const gate = new WorldEntryPresentationGate(),
      state = ready();
    gate.advance(state, 0);
    if (now > 300) gate.advance(state, 300);
    expect(
      gate.advance({ ...state, ready: false, terrainReady: false }, now),
    ).toBe("loading");
    expect(gate.advance(state, now + 1)).toBe("settling");
    expect(gate.advance(state, now + 300)).toBe("settling");
    expect(gate.advance(state, now + 301)).toBe("fading");
    expect(gate.advance(state, now + 521)).toBe("committed");
  });

  it.each(
    (["owner", "connection", "targetId"] as const).flatMap((identity) =>
      [299, 519].map((now) => ({ identity, now })),
    ),
  )(
    "restarts both delays when $identity changes at $now",
    ({ identity, now }) => {
      const gate = new WorldEntryPresentationGate(),
        state = ready();
      gate.advance(state, 0);
      if (now > 300) gate.advance(state, 300);
      const replacement = {
        ...state,
        [identity]: identity === "targetId" ? "next-character" : {},
      };
      expect(gate.advance(replacement, now)).toBe("settling");
      expect(gate.advance(replacement, now + 299)).toBe("settling");
      expect(gate.advance(replacement, now + 300)).toBe("fading");
      expect(gate.advance(replacement, now + 520)).toBe("committed");
    },
  );

  it("rejects old-owner completion at the new owner's fade boundary", () => {
    const gate = new WorldEntryPresentationGate(),
      old = ready();
    const current = { ...old, owner: {} };
    gate.advance(old, 0);
    gate.advance(old, 300);
    expect(gate.advance(current, 519)).toBe("settling");
    expect(gate.advance(old, 520)).toBe("settling");
    expect(gate.advance(current, 521)).toBe("settling");
  });

  it("keeps genuine blocking inputs closed but admits ready refinement inputs", () => {
    const gate = new WorldEntryPresentationGate(),
      state = ready();
    expect(
      gate.advance(
        { ...state, blockedChunks: 1, terrainReady: false, ready: false },
        0,
      ),
    ).toBe("loading");
    expect(
      gate.advance({ ...state, terrainReady: false, ready: false }, 20_000),
    ).toBe("loading");
    expect(gate.advance(state, 20_001)).toBe("settling");
    expect(gate.advance(state, 20_301)).toBe("fading");
    expect(gate.advance(state, 20_521)).toBe("committed");
    // No stale worker diagnostic is a substitute for the current effective gate.
    expect(
      gate.advance({ ...state, terrainReady: false, ready: false }, 20_600),
    ).toBe("committed");
  });

  it.each([
    "selection",
    "entry recovery",
    "disconnection",
    "initialization revoked",
  ])("revokes a committed presentation when %s loses ownership", (reason) => {
    const gate = new WorldEntryPresentationGate(),
      state = ready();
    gate.advance(state, 0);
    gate.advance(state, 300);
    gate.advance(state, 520);
    const lost = { ...state, ownershipReady: false, ready: false };
    if (reason === "selection") lost.selecting = true;
    if (reason === "entry recovery") lost.recovering = true;
    if (reason === "disconnection") lost.connection = null;
    expect(gate.advance(lost, 521)).toBe("loading");
  });

  it("resets ownership explicitly without restarting monotonic time", () => {
    const gate = new WorldEntryPresentationGate(),
      state = ready();
    gate.advance(state, 100);
    gate.reset();
    expect(gate.phase).toBe("loading");
    expect(gate.advance(state, 101)).toBe("settling");
    expect(gate.advance(state, 400)).toBe("settling");
  });

  it("permanently disposes pending presentation and ignores late advancement", () => {
    const gate = new WorldEntryPresentationGate(),
      state = ready();
    gate.advance(state, 0);
    gate.advance(state, 300);
    gate.dispose();
    for (const now of [520, 20_000, 3_600_000])
      expect(gate.advance(state, now)).toBe("loading");
    gate.reset();
    expect(gate.advance(state, 3_600_001)).toBe("loading");
    gate.dispose();
    expect(gate.phase).toBe("loading");
  });

  it.each([NaN, Infinity, -Infinity, 99])(
    "resets before rejecting invalid time %s",
    (now) => {
      const gate = new WorldEntryPresentationGate(),
        state = ready();
      gate.advance(state, 100);
      expect(() => gate.advance(state, now)).toThrow("finite monotonic time");
      expect(gate.phase).toBe("loading");
      expect(gate.advance(state, 101)).toBe("settling");
    },
  );
});

describe("world entry reader with actual uninitialized production systems", () => {
  it.each([false, true])(
    "cannot present an actual uninitialized or disposed World even if completion input is %s",
    async (initializationComplete) => {
      const world = new World();
      world.register("terrain", TerrainSystem);
      try {
        for (const spectator of [false, true]) {
          const state = readWorldEntryReadiness(world, {
            initializationComplete,
            spectator,
            spectatorTargetId: "not-spawned",
            selectedCharacterId: "not-spawned",
            selecting: false,
            interrupted: false,
            kicked: false,
          });
          expect(state).toMatchObject({
            owner: null,
            connection: null,
            ownershipReady: false,
            ready: false,
            playerReady: false,
            physReady: false,
            terrainReady: false,
            blockedChunks: 0,
            selecting: false,
            recovering: false,
          });
        }
      } finally {
        await world.destroy();
      }
      expect(
        readWorldEntryReadiness(world, {
          initializationComplete,
          spectator: false,
          spectatorTargetId: null,
          selectedCharacterId: null,
          selecting: false,
          interrupted: false,
          kicked: false,
        }).ready,
      ).toBe(false);
    },
  );
});
