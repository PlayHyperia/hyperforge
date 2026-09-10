import { describe, expect, it } from "vitest";

import {
  normalizeProcessingInteractionPresentationState,
  resolveProcessingInteractionBodyEmote,
} from "./processing-interaction-presentation";

const working = {
  revision: 2,
  skill: "smithing",
  phase: "working",
  phaseStartedAtServerTimeMs: 1234,
  targetPosition: { x: 1, y: 2, z: 3 },
} as const;

describe("processing interaction presentation contract", () => {
  it("accepts exact working and idle state", () => {
    expect(normalizeProcessingInteractionPresentationState(working)).toEqual(
      working,
    );
    expect(
      normalizeProcessingInteractionPresentationState({
        revision: 3,
        skill: null,
        phase: "idle",
        phaseStartedAtServerTimeMs: null,
        targetPosition: null,
      }),
    ).toMatchObject({ revision: 3, phase: "idle" });
  });

  it("rejects extra private fields, contradictions, and unsafe geometry", () => {
    expect(
      normalizeProcessingInteractionPresentationState({
        ...working,
        recipeId: "private-recipe",
      }),
    ).toBeNull();
    expect(
      normalizeProcessingInteractionPresentationState({
        ...working,
        phase: "idle",
      }),
    ).toBeNull();
    expect(
      normalizeProcessingInteractionPresentationState({
        ...working,
        targetPosition: { x: Infinity, y: 0, z: 0 },
      }),
    ).toBeNull();
  });

  it("only certifies body motions that exist in the reviewed build", () => {
    expect(resolveProcessingInteractionBodyEmote("firemaking")).toBe("squat");
    expect(resolveProcessingInteractionBodyEmote("cooking")).toBe("squat");
    expect(resolveProcessingInteractionBodyEmote("smithing")).toBeNull();
    expect(resolveProcessingInteractionBodyEmote("crafting")).toBeNull();
  });
});
