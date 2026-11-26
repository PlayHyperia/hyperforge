import { describe, expect, it } from "vitest";

import {
  getPlayerHitReactionEnvelope,
  getPlayerHitReactionIntensity,
  getPlayerHitReactionSide,
  PLAYER_HIT_REACTION_DURATION_SECONDS,
} from "../HitReaction";

describe("player hit-reaction policy", () => {
  it("uses a bounded fast-impact and smooth-release envelope", () => {
    const duration = PLAYER_HIT_REACTION_DURATION_SECONDS;
    const samples = Array.from({ length: 101 }, (_, index) =>
      getPlayerHitReactionEnvelope((duration * index) / 100),
    );

    expect(samples[0]).toBe(0);
    expect(samples[18]).toBeCloseTo(1, 6);
    expect(samples[50]).toBeGreaterThan(samples[80]);
    expect(samples[100]).toBe(0);
    expect(samples.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(getPlayerHitReactionEnvelope(-1)).toBe(0);
    expect(getPlayerHitReactionEnvelope(Number.NaN)).toBe(0);
    expect(getPlayerHitReactionEnvelope(0.1, 0)).toBe(0);
  });

  it("ignores misses and caps ordinary or critical damage intensity", () => {
    expect(getPlayerHitReactionIntensity(0)).toBe(0);
    expect(getPlayerHitReactionIntensity(-1)).toBe(0);
    expect(getPlayerHitReactionIntensity(Number.NaN)).toBe(0);
    expect(getPlayerHitReactionIntensity(1)).toBeGreaterThan(0.55);
    expect(getPlayerHitReactionIntensity(10, true)).toBeGreaterThan(
      getPlayerHitReactionIntensity(10, false),
    );
    expect(getPlayerHitReactionIntensity(10_000, true)).toBe(1.15);
  });

  it("derives deterministic non-zero lateral variation from combat identity", () => {
    const first = getPlayerHitReactionSide("attacker-a", "target-b");
    expect(first === -1 || first === 1).toBe(true);
    expect(getPlayerHitReactionSide("attacker-a", "target-b")).toBe(first);
    expect(
      new Set(
        Array.from({ length: 32 }, (_, index) =>
          getPlayerHitReactionSide(`attacker-${index}`, "target-b"),
        ),
      ),
    ).toEqual(new Set([-1, 1]));
  });
});
