import { describe, expect, it } from "vitest";

import {
  evaluateTwoHandPlaybackTelemetry,
  evaluateTwoHandPlaybackRenderTelemetry,
  TWO_HAND_PLAYBACK_DURATION_SECONDS,
  TWO_HAND_PLAYBACK_SAMPLE_RATE_HZ,
  twoHandPlaybackPhaseAt,
} from "./two-hand-candidate-playback-policy";

function passingTelemetry() {
  return {
    deterministicFrameCount:
      Math.round(
        TWO_HAND_PLAYBACK_DURATION_SECONDS * TWO_HAND_PLAYBACK_SAMPLE_RATE_HZ,
      ) + 1,
    nonFiniteSampleCount: 0,
    minimumAvatarBoundsYMetres: 0.12,
    maximumAvatarBoundsYMetres: 0.13,
    minimumWeaponBoundsYMetres: 1.05,
    maximumGripAxisDeviationDegrees: 0.001,
    maximumBoneStepDegrees: 2.5,
    maximumBoneAccelerationDegreesPerFrameSquared: 1.5,
    maximumWeaponStepDegrees: 3.5,
  };
}

describe("two-hand candidate playback policy", () => {
  it("resolves every exact sequence boundary", () => {
    expect(twoHandPlaybackPhaseAt(0).id).toBe("idle-open");
    expect(twoHandPlaybackPhaseAt(1.249).id).toBe("idle-open");
    expect(twoHandPlaybackPhaseAt(1.25).id).toBe("walk");
    expect(twoHandPlaybackPhaseAt(4.75).id).toBe("attack");
    expect(twoHandPlaybackPhaseAt(6.05).id).toBe("idle-recovery");
    expect(twoHandPlaybackPhaseAt(8.5).id).toBe("walk-close");
    expect(() => twoHandPlaybackPhaseAt(Number.NaN)).toThrow();
  });

  it("accepts complete finite grounded and continuous telemetry", () => {
    const result = evaluateTwoHandPlaybackTelemetry(passingTelemetry());
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(9);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it.each([
    ["deterministicFrameCount", 1],
    ["nonFiniteSampleCount", 1],
    ["minimumAvatarBoundsYMetres", -0.021],
    ["maximumAvatarBoundsYMetres", 0.181],
    ["minimumWeaponBoundsYMetres", 0.099],
    ["maximumGripAxisDeviationDegrees", 0.011],
    ["maximumBoneStepDegrees", 15.001],
    ["maximumBoneAccelerationDegreesPerFrameSquared", 6.001],
    ["maximumWeaponStepDegrees", 8.001],
  ] as const)("rejects unsafe %s telemetry", (key, value) => {
    const telemetry = passingTelemetry();
    telemetry[key] = value;
    expect(evaluateTwoHandPlaybackTelemetry(telemetry).passed).toBe(false);
  });
});

describe("two-hand candidate WebGPU render policy", () => {
  const passingRender = () => ({
    frameCount: 510,
    p95FrameIntervalMs: 16.7,
    maximumFrameIntervalMs: 32,
  });

  it("accepts smooth production-speed rendering", () => {
    const result = evaluateTwoHandPlaybackRenderTelemetry(passingRender());
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(3);
  });

  it.each([
    ["frameCount", 424],
    ["p95FrameIntervalMs", 20.001],
    ["maximumFrameIntervalMs", 100.001],
  ] as const)("rejects unsafe rendering %s", (key, value) => {
    const render = passingRender();
    render[key] = value;
    expect(evaluateTwoHandPlaybackRenderTelemetry(render).passed).toBe(false);
  });
});
