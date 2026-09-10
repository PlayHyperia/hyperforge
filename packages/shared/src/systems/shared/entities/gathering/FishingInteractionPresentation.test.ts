import { describe, expect, it } from "vitest";

import {
  firstFishingInteractionAttemptTick,
  initialFishingInteractionTransition,
  nextFishingInteractionTransition,
  normalizeFishingInteractionPresentationState,
  resolveFishingInteractionBodyEmote,
  resolveFishingInteractionBodyMotionOffsetSeconds,
} from "./FishingInteractionPresentation";

describe("FishingInteractionPresentation", () => {
  it("normalizes exact active and idle snapshot authority", () => {
    expect(
      normalizeFishingInteractionPresentationState({
        revision: 7,
        interactionId: "fishing:session-7",
        resourceId: "fishing_spot_net_1",
        itemId: "small_fishing_net",
        phase: "deployed",
        outcome: "none",
        attempt: 0,
        serverTick: 42,
        phaseStartedAtServerTimeMs: 24_000,
        targetPosition: { x: 12, y: 0.25, z: -8 },
      }),
    ).toEqual({
      revision: 7,
      interactionId: "fishing:session-7",
      resourceId: "fishing_spot_net_1",
      itemId: "small_fishing_net",
      phase: "deployed",
      outcome: "none",
      attempt: 0,
      serverTick: 42,
      phaseStartedAtServerTimeMs: 24_000,
      targetPosition: { x: 12, y: 0.25, z: -8 },
    });
    expect(
      normalizeFishingInteractionPresentationState({
        revision: 8,
        interactionId: null,
        resourceId: null,
        itemId: null,
        phase: "idle",
        outcome: "none",
        attempt: 0,
        serverTick: 43,
        targetPosition: null,
      }),
    ).not.toBeNull();
  });

  it("rejects mismatched item phases and malformed identity or coordinates", () => {
    const valid = {
      revision: 1,
      interactionId: "fishing:session-1",
      resourceId: "fishing_spot_harpoon_1",
      itemId: "harpoon",
      phase: "striking",
      outcome: "pending",
      attempt: 1,
      serverTick: 10,
      targetPosition: { x: 1, y: 0, z: 2 },
    };
    expect(
      normalizeFishingInteractionPresentationState({
        ...valid,
        phase: "deployed",
      }),
    ).toBeNull();
    expect(
      normalizeFishingInteractionPresentationState({
        ...valid,
        interactionId: " fishing:session-1",
      }),
    ).toBeNull();
    expect(
      normalizeFishingInteractionPresentationState({
        ...valid,
        targetPosition: { x: Number.NaN, y: 0, z: 2 },
      }),
    ).toBeNull();
    expect(
      normalizeFishingInteractionPresentationState({
        ...valid,
        phaseStartedAtServerTimeMs: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });

  it("rejects impossible phase and outcome combinations", () => {
    const valid = {
      revision: 1,
      interactionId: "fishing:session-2",
      resourceId: "fishing_spot_net_2",
      itemId: "small_fishing_net",
      phase: "retrieving",
      outcome: "caught",
      attempt: 2,
      serverTick: 20,
      targetPosition: { x: 4, y: 0.2, z: 8 },
    };
    expect(normalizeFishingInteractionPresentationState(valid)).not.toBeNull();
    expect(
      normalizeFishingInteractionPresentationState({
        ...valid,
        phase: "deployed",
        outcome: "caught",
      }),
    ).toBeNull();
    expect(
      normalizeFishingInteractionPresentationState({
        ...valid,
        itemId: "harpoon",
        phase: "held",
        outcome: "pending",
      }),
    ).toBeNull();
  });

  it("reserves enough authoritative ticks for initial deployment", () => {
    expect(firstFishingInteractionAttemptTick("small_fishing_net", 20)).toBe(
      23,
    );
    expect(firstFishingInteractionAttemptTick("lobster_pot", 20)).toBe(23);
    expect(firstFishingInteractionAttemptTick("harpoon", 20)).toBe(21);
    expect(
      initialFishingInteractionTransition("small_fishing_net", 20),
    ).toEqual({ phase: "held", nextTransitionTick: 21 });
    expect(initialFishingInteractionTransition("harpoon", 20)).toEqual({
      phase: "held",
      nextTransitionTick: null,
    });
  });

  it("selects only the certified phase-specific body action", () => {
    expect(resolveFishingInteractionBodyEmote("harpoon", "held")).toBe("idle");
    expect(resolveFishingInteractionBodyEmote("harpoon", "striking")).toBe(
      "harpoon",
    );
    expect(resolveFishingInteractionBodyEmote("harpoon", "recovering")).toBe(
      "harpoon",
    );
    expect(
      resolveFishingInteractionBodyEmote("small_fishing_net", "held"),
    ).toBe("small_fishing_net");
    expect(
      resolveFishingInteractionBodyEmote("small_fishing_net", "released"),
    ).toBe("small_fishing_net");
    expect(
      resolveFishingInteractionBodyEmote("small_fishing_net", "retrieving"),
    ).toBe("fishing_retrieve");
    expect(resolveFishingInteractionBodyEmote("lobster_pot", "deployed")).toBe(
      "idle",
    );
    expect(
      resolveFishingInteractionBodyEmote("lobster_pot", "retrieving"),
    ).toBe("fishing_retrieve");
  });

  it("seeks late harpoon viewers within the exact server-owned phase segment", () => {
    const base = {
      revision: 3,
      interactionId: "fishing:harpoon-offset",
      resourceId: "fishing_spot_harpoon_offset",
      itemId: "harpoon" as const,
      outcome: "pending" as const,
      attempt: 1,
      serverTick: 30,
      phaseStartedAtServerTimeMs: 18_000,
      targetPosition: { x: 1, y: -0.2, z: 2 },
    };

    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        { ...base, phase: "striking" },
        18.25,
      ),
    ).toBeCloseTo(0.25, 6);
    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        { ...base, phase: "striking" },
        19,
      ),
    ).toBeCloseTo(0.6, 6);
    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        {
          ...base,
          phase: "recovering",
          outcome: "verifying",
        },
        18.25,
      ),
    ).toBeCloseTo(0.85, 6);
    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        {
          ...base,
          phase: "recovering",
          outcome: "verifying",
        },
        19,
      ),
    ).toBeCloseTo(1.2, 6);
    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        { ...base, phase: "striking" },
        null,
      ),
    ).toBe(0);
    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        {
          ...base,
          phase: "recovering",
          outcome: "verifying",
          phaseStartedAtServerTimeMs: undefined,
        },
        18.25,
      ),
    ).toBe(0.6);
    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        {
          ...base,
          itemId: "small_fishing_net",
          phase: "released",
          outcome: "none",
        },
        18.25,
      ),
    ).toBeCloseTo(0.85, 6);
    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        { ...base, itemId: "small_fishing_net", phase: "retrieving" },
        18.75,
      ),
    ).toBeCloseTo(0.75, 6);
    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        { ...base, itemId: "lobster_pot", phase: "retrieving" },
        20,
      ),
    ).toBe(1.2);
    expect(
      resolveFishingInteractionBodyMotionOffsetSeconds(
        {
          ...base,
          itemId: "small_fishing_net",
          phase: "deployed",
          outcome: "none",
        },
        18.25,
      ),
    ).toBeNull();
  });

  it("advances every special tool through a truthful recovery cycle", () => {
    expect(
      nextFishingInteractionTransition(
        "small_fishing_net",
        "retrieving",
        "caught",
        30,
      ),
    ).toEqual({
      phase: "held",
      outcome: "caught",
      nextTransitionTick: 31,
    });
    expect(
      nextFishingInteractionTransition(
        "small_fishing_net",
        "held",
        "caught",
        31,
      ),
    ).toEqual({
      phase: "released",
      outcome: "none",
      nextTransitionTick: 32,
    });
    expect(
      nextFishingInteractionTransition(
        "small_fishing_net",
        "released",
        "none",
        32,
      ),
    ).toEqual({
      phase: "deployed",
      outcome: "none",
      nextTransitionTick: null,
    });
    expect(
      nextFishingInteractionTransition("lobster_pot", "retrieving", "miss", 40),
    ).toEqual({
      phase: "held",
      outcome: "miss",
      nextTransitionTick: 41,
    });
    expect(
      nextFishingInteractionTransition("lobster_pot", "held", "miss", 41),
    ).toEqual({
      phase: "released",
      outcome: "none",
      nextTransitionTick: 42,
    });
    expect(
      nextFishingInteractionTransition("lobster_pot", "released", "none", 42),
    ).toEqual({
      phase: "deployed",
      outcome: "none",
      nextTransitionTick: null,
    });
    expect(
      nextFishingInteractionTransition("harpoon", "striking", "caught", 50),
    ).toEqual({
      phase: "recovering",
      outcome: "caught",
      nextTransitionTick: 51,
    });
    expect(
      nextFishingInteractionTransition("harpoon", "striking", "pending", 50),
    ).toEqual({
      phase: "recovering",
      outcome: "verifying",
      nextTransitionTick: null,
    });
    expect(
      nextFishingInteractionTransition("harpoon", "recovering", "caught", 51),
    ).toEqual({
      phase: "held",
      outcome: "none",
      nextTransitionTick: null,
    });
  });
});
