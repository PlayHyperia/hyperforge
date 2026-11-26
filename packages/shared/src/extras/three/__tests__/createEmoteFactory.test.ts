import { describe, expect, it } from "vitest";

import { createEmoteFactory } from "../createEmoteFactory";
import * as THREE from "../three";

function createAnimationGlb() {
  const scene = new THREE.Scene();
  const armature = new THREE.Object3D();
  armature.name = "Armature";
  armature.scale.setScalar(0.01);
  armature.rotation.x = Math.PI / 2;
  const hips = new THREE.Object3D();
  hips.name = "mixamorigHips";
  armature.add(hips);
  scene.add(armature);
  scene.updateMatrixWorld(true);

  const clip = new THREE.AnimationClip("motion", 1, [
    new THREE.VectorKeyframeTrack(
      "mixamorigHips.position",
      [0, 1],
      [0, 0, -100, 50, 0, -10],
    ),
    new THREE.QuaternionKeyframeTrack(
      "mixamorigHips.quaternion",
      [0, 1],
      [0, 0, 0, 1, 0.1, 0, 0, 0.994987],
    ),
  ]);
  return { scene, animations: [clip] };
}

describe("createEmoteFactory translation policy", () => {
  it("preserves only source-world vertical hip motion for death", () => {
    const factory = createEmoteFactory(
      createAnimationGlb() as never,
      "asset://emotes/emote-death.glb?l=0",
    );
    const clip = factory.toClip({
      rootToHips: 1,
      version: "1",
      getBoneName: (name) => `Normalized_${name}`,
    });
    const position = clip.tracks.find(
      (track) => track.name === "Normalized_hips.position",
    );

    expect(position).toBeDefined();
    const values = Array.from(position!.values);
    expect(values.slice(0, 4)).toEqual([0, 1, 0, 0]);
    expect(values[4]).toBeCloseTo(0.1, 6);
    expect(values[5]).toBe(0);
  });

  it("strips every position track from ordinary locomotion", () => {
    const factory = createEmoteFactory(
      createAnimationGlb() as never,
      "asset://emotes/emote-walk.glb?s=1.3",
    );
    const clip = factory.toClip({
      rootToHips: 1,
      version: "1",
      getBoneName: (name) => `Normalized_${name}`,
    });

    expect(clip.tracks.some((track) => track.name.endsWith(".position"))).toBe(
      false,
    );
    expect(
      clip.tracks.some((track) => track.name === "Normalized_hips.quaternion"),
    ).toBe(true);
  });
});
