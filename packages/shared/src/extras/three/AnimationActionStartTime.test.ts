import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { applyAnimationActionStartTime } from "./AnimationActionStartTime";

function createActionFixture() {
  const root = new THREE.Object3D();
  const clip = new THREE.AnimationClip("seek", 1.2, [
    new THREE.NumberKeyframeTrack(".position[x]", [0, 0.6, 1.2], [0, 6, 12]),
  ]);
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1).play();
  return { action, mixer, root };
}

describe("applyAnimationActionStartTime", () => {
  it("writes an exact non-looping pose and clamps at the final frame", () => {
    const fixture = createActionFixture();
    expect(
      applyAnimationActionStartTime(fixture.action, fixture.mixer, 0.85, false),
    ).toBe(true);
    expect(fixture.action.time).toBeCloseTo(0.85, 8);
    expect(fixture.root.position.x).toBeCloseTo(8.5, 5);

    expect(
      applyAnimationActionStartTime(fixture.action, fixture.mixer, 99, false),
    ).toBe(true);
    expect(fixture.action.time).toBeCloseTo(1.2, 8);
    expect(fixture.root.position.x).toBeCloseTo(12, 5);
  });

  it("wraps looping clips and ignores invalid caller input", () => {
    const fixture = createActionFixture();
    expect(
      applyAnimationActionStartTime(fixture.action, fixture.mixer, 1.45, true),
    ).toBe(true);
    expect(fixture.action.time).toBeCloseTo(0.25, 8);
    expect(fixture.root.position.x).toBeCloseTo(2.5, 5);

    expect(
      applyAnimationActionStartTime(
        fixture.action,
        fixture.mixer,
        Number.NaN,
        true,
      ),
    ).toBe(false);
    expect(fixture.action.time).toBeCloseTo(0.25, 8);
  });
});
