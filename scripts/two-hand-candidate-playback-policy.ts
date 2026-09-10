export const TWO_HAND_PLAYBACK_DURATION_SECONDS = 8.5;
export const TWO_HAND_PLAYBACK_SAMPLE_RATE_HZ = 60;

export const TWO_HAND_PLAYBACK_PHASES = Object.freeze([
  { id: "idle-open", name: "Controlled guard", startsAtSeconds: 0 },
  { id: "walk", name: "Guarded walk", startsAtSeconds: 1.25 },
  { id: "run", name: "Guarded run", startsAtSeconds: 2.75 },
  { id: "idle-before-strike", name: "Set guard", startsAtSeconds: 4 },
  { id: "attack", name: "Planted cut", startsAtSeconds: 4.75 },
  { id: "idle-recovery", name: "Return to guard", startsAtSeconds: 6.05 },
  { id: "walk-close", name: "Guarded exit", startsAtSeconds: 7.2 },
] as const);

export type TwoHandPlaybackPhase = (typeof TWO_HAND_PLAYBACK_PHASES)[number];

export interface TwoHandPlaybackTelemetry {
  deterministicFrameCount: number;
  nonFiniteSampleCount: number;
  minimumAvatarBoundsYMetres: number;
  maximumAvatarBoundsYMetres: number;
  minimumWeaponBoundsYMetres: number;
  maximumGripAxisDeviationDegrees: number;
  maximumBoneStepDegrees: number;
  maximumBoneAccelerationDegreesPerFrameSquared: number;
  maximumWeaponStepDegrees: number;
}

export interface TwoHandPlaybackRenderTelemetry {
  frameCount: number;
  p95FrameIntervalMs: number;
  maximumFrameIntervalMs: number;
}

export const TWO_HAND_PLAYBACK_THRESHOLDS = Object.freeze({
  minimumAvatarBoundsYMetres: -0.02,
  maximumAvatarBoundsYMetres: 0.18,
  minimumWeaponBoundsYMetres: 0.1,
  maximumGripAxisDeviationDegrees: 0.01,
  maximumBoneStepDegrees: 15,
  maximumBoneAccelerationDegreesPerFrameSquared: 6,
  maximumWeaponStepDegrees: 8,
});

export const TWO_HAND_PLAYBACK_RENDER_THRESHOLDS = Object.freeze({
  minimumFramesPerSecond: 50,
  maximumP95FrameIntervalMs: 20,
  maximumFrameIntervalMs: 100,
});

export function twoHandPlaybackPhaseAt(
  elapsedSeconds: number,
): TwoHandPlaybackPhase {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    throw new Error("Playback time must be finite and non-negative");
  }
  let selected: TwoHandPlaybackPhase = TWO_HAND_PLAYBACK_PHASES[0];
  for (const phase of TWO_HAND_PLAYBACK_PHASES) {
    if (elapsedSeconds < phase.startsAtSeconds) break;
    selected = phase;
  }
  return selected;
}

export function evaluateTwoHandPlaybackTelemetry(
  telemetry: TwoHandPlaybackTelemetry,
) {
  const expectedFrameCount =
    Math.round(
      TWO_HAND_PLAYBACK_DURATION_SECONDS * TWO_HAND_PLAYBACK_SAMPLE_RATE_HZ,
    ) + 1;
  const checks = [
    {
      id: "deterministic-frame-count",
      passed: telemetry.deterministicFrameCount === expectedFrameCount,
      actual: telemetry.deterministicFrameCount,
      expected: expectedFrameCount,
    },
    {
      id: "finite-samples",
      passed: telemetry.nonFiniteSampleCount === 0,
      actual: telemetry.nonFiniteSampleCount,
      expected: 0,
    },
    {
      id: "avatar-floor-penetration",
      passed:
        telemetry.minimumAvatarBoundsYMetres >=
        TWO_HAND_PLAYBACK_THRESHOLDS.minimumAvatarBoundsYMetres,
      actual: telemetry.minimumAvatarBoundsYMetres,
      minimum: TWO_HAND_PLAYBACK_THRESHOLDS.minimumAvatarBoundsYMetres,
    },
    {
      id: "avatar-floating",
      passed:
        telemetry.maximumAvatarBoundsYMetres <=
        TWO_HAND_PLAYBACK_THRESHOLDS.maximumAvatarBoundsYMetres,
      actual: telemetry.maximumAvatarBoundsYMetres,
      maximum: TWO_HAND_PLAYBACK_THRESHOLDS.maximumAvatarBoundsYMetres,
    },
    {
      id: "weapon-floor-clearance",
      passed:
        telemetry.minimumWeaponBoundsYMetres >=
        TWO_HAND_PLAYBACK_THRESHOLDS.minimumWeaponBoundsYMetres,
      actual: telemetry.minimumWeaponBoundsYMetres,
      minimum: TWO_HAND_PLAYBACK_THRESHOLDS.minimumWeaponBoundsYMetres,
    },
    {
      id: "two-hand-axis-alignment",
      passed:
        telemetry.maximumGripAxisDeviationDegrees <=
        TWO_HAND_PLAYBACK_THRESHOLDS.maximumGripAxisDeviationDegrees,
      actual: telemetry.maximumGripAxisDeviationDegrees,
      maximum: TWO_HAND_PLAYBACK_THRESHOLDS.maximumGripAxisDeviationDegrees,
    },
    {
      id: "avatar-frame-velocity-envelope",
      passed:
        telemetry.maximumBoneStepDegrees <=
        TWO_HAND_PLAYBACK_THRESHOLDS.maximumBoneStepDegrees,
      actual: telemetry.maximumBoneStepDegrees,
      maximum: TWO_HAND_PLAYBACK_THRESHOLDS.maximumBoneStepDegrees,
    },
    {
      id: "avatar-frame-acceleration-continuity",
      passed:
        telemetry.maximumBoneAccelerationDegreesPerFrameSquared <=
        TWO_HAND_PLAYBACK_THRESHOLDS.maximumBoneAccelerationDegreesPerFrameSquared,
      actual: telemetry.maximumBoneAccelerationDegreesPerFrameSquared,
      maximum:
        TWO_HAND_PLAYBACK_THRESHOLDS.maximumBoneAccelerationDegreesPerFrameSquared,
    },
    {
      id: "weapon-frame-continuity",
      passed:
        telemetry.maximumWeaponStepDegrees <=
        TWO_HAND_PLAYBACK_THRESHOLDS.maximumWeaponStepDegrees,
      actual: telemetry.maximumWeaponStepDegrees,
      maximum: TWO_HAND_PLAYBACK_THRESHOLDS.maximumWeaponStepDegrees,
    },
  ];
  return {
    thresholds: { ...TWO_HAND_PLAYBACK_THRESHOLDS },
    expectedFrameCount,
    checks,
    passed: checks.every((check) => check.passed),
  };
}

export function evaluateTwoHandPlaybackRenderTelemetry(
  telemetry: TwoHandPlaybackRenderTelemetry,
) {
  const minimumFrameCount = Math.floor(
    TWO_HAND_PLAYBACK_DURATION_SECONDS *
      TWO_HAND_PLAYBACK_RENDER_THRESHOLDS.minimumFramesPerSecond,
  );
  const checks = [
    {
      id: "render-frame-rate",
      passed:
        Number.isSafeInteger(telemetry.frameCount) &&
        telemetry.frameCount >= minimumFrameCount,
      actual: telemetry.frameCount,
      minimum: minimumFrameCount,
    },
    {
      id: "render-p95-frame-interval",
      passed:
        Number.isFinite(telemetry.p95FrameIntervalMs) &&
        telemetry.p95FrameIntervalMs <=
          TWO_HAND_PLAYBACK_RENDER_THRESHOLDS.maximumP95FrameIntervalMs,
      actual: telemetry.p95FrameIntervalMs,
      maximum: TWO_HAND_PLAYBACK_RENDER_THRESHOLDS.maximumP95FrameIntervalMs,
    },
    {
      id: "render-maximum-frame-interval",
      passed:
        Number.isFinite(telemetry.maximumFrameIntervalMs) &&
        telemetry.maximumFrameIntervalMs <=
          TWO_HAND_PLAYBACK_RENDER_THRESHOLDS.maximumFrameIntervalMs,
      actual: telemetry.maximumFrameIntervalMs,
      maximum: TWO_HAND_PLAYBACK_RENDER_THRESHOLDS.maximumFrameIntervalMs,
    },
  ];
  return {
    thresholds: { ...TWO_HAND_PLAYBACK_RENDER_THRESHOLDS },
    minimumFrameCount,
    checks,
    passed: checks.every((check) => check.passed),
  };
}
