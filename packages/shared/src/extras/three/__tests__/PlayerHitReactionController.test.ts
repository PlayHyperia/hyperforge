import { describe, expect, it } from "vitest";

import {
  PlayerHitReactionController,
  PLAYER_HIT_REACTION_BONES,
} from "../PlayerHitReactionController";
import { PLAYER_HIT_REACTION_DURATION_SECONDS } from "../../../utils/rendering/HitReaction";
import THREE from "../three";

function createRig() {
  const nodes = new Map<string, THREE.Object3D>();
  for (const [index, { bone }] of PLAYER_HIT_REACTION_BONES.entries()) {
    const node = new THREE.Object3D();
    node.quaternion.setFromEuler(
      new THREE.Euler(index * 0.01, -index * 0.015, index * 0.005),
    );
    nodes.set(bone, node);
  }
  const root = new THREE.Object3D();
  root.position.set(3, 2, -4);
  root.quaternion.setFromEuler(new THREE.Euler(0, 0.7, 0));
  return {
    nodes,
    root,
    humanoid: {
      getNormalizedBoneNode: (boneName: string) => nodes.get(boneName) ?? null,
    },
  };
}

describe("PlayerHitReactionController", () => {
  it("layers recoil over the current pose and restores it exactly", () => {
    const { humanoid, nodes, root } = createRig();
    const controller = new PlayerHitReactionController(humanoid);
    const baseRotations = new Map(
      [...nodes].map(([bone, node]) => [bone, node.quaternion.clone()]),
    );
    const rootPosition = root.position.clone();
    const rootRotation = root.quaternion.clone();

    expect(controller.available).toBe(true);
    expect(controller.trigger(1, 1)).toBe(true);
    expect(controller.getDiagnostics()).toMatchObject({
      availableBoneCount: PLAYER_HIT_REACTION_BONES.length,
      triggerCount: 1,
      active: true,
      elapsedSeconds: 0,
      currentWeight: 0,
      lastIntensity: 1,
      lastSide: 1,
    });
    const weight = controller.afterMixerUpdate(
      PLAYER_HIT_REACTION_DURATION_SECONDS * 0.18,
    );

    expect(weight).toBeCloseTo(1, 6);
    expect(controller.getDiagnostics().currentWeight).toBeCloseTo(1, 6);
    expect(
      [...nodes].filter(
        ([bone, node]) =>
          node.quaternion.angleTo(baseRotations.get(bone)!) > 0.001,
      ),
    ).toHaveLength(PLAYER_HIT_REACTION_BONES.length);
    expect(root.position.equals(rootPosition)).toBe(true);
    expect(root.quaternion.angleTo(rootRotation)).toBeLessThan(1e-8);

    controller.beforeMixerUpdate();
    for (const [bone, node] of nodes) {
      expect(node.quaternion.angleTo(baseRotations.get(bone)!)).toBeLessThan(
        1e-7,
      );
    }

    const chest = nodes.get("chest")!;
    const nextMixerPose = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.2, -0.1, 0.04),
    );
    chest.quaternion.copy(nextMixerPose);
    controller.afterMixerUpdate(0.01);
    controller.clear();
    expect(chest.quaternion.angleTo(nextMixerPose)).toBeLessThan(1e-7);
    expect(controller.getDiagnostics()).toMatchObject({
      triggerCount: 1,
      active: false,
      elapsedSeconds: null,
      currentWeight: 0,
      lastIntensity: 0,
    });
  });

  it("mirrors lateral recoil and rejects unusable triggers", () => {
    const leftRig = createRig();
    const rightRig = createRig();
    const left = new PlayerHitReactionController(leftRig.humanoid);
    const right = new PlayerHitReactionController(rightRig.humanoid);
    const peak = PLAYER_HIT_REACTION_DURATION_SECONDS * 0.18;

    expect(left.trigger(1, -1)).toBe(true);
    expect(right.trigger(1, 1)).toBe(true);
    left.afterMixerUpdate(peak);
    right.afterMixerUpdate(peak);

    const leftEuler = new THREE.Euler().setFromQuaternion(
      leftRig.nodes.get("upperChest")!.quaternion,
      "XYZ",
    );
    const rightEuler = new THREE.Euler().setFromQuaternion(
      rightRig.nodes.get("upperChest")!.quaternion,
      "XYZ",
    );
    expect(leftEuler.z).toBeLessThan(rightEuler.z);

    expect(new PlayerHitReactionController(null).trigger()).toBe(false);
    right.clear();
    expect(right.trigger(Number.NaN)).toBe(false);
    expect(right.trigger(0)).toBe(false);
  });

  it("restarts rapid hits from the authored pose without accumulating offsets", () => {
    const { humanoid, nodes } = createRig();
    const controller = new PlayerHitReactionController(humanoid);
    const chest = nodes.get("chest")!;

    expect(controller.trigger(0.8, 1)).toBe(true);
    controller.afterMixerUpdate(PLAYER_HIT_REACTION_DURATION_SECONDS * 0.12);
    controller.beforeMixerUpdate();

    const nextMixerPose = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-0.14, 0.08, -0.03),
    );
    chest.quaternion.copy(nextMixerPose);
    expect(controller.trigger(1.2, -1)).toBe(true);
    const secondWeight = controller.afterMixerUpdate(
      PLAYER_HIT_REACTION_DURATION_SECONDS * 0.18,
    );

    expect(secondWeight).toBeCloseTo(1.2, 6);
    expect(controller.getDiagnostics()).toMatchObject({
      triggerCount: 2,
      active: true,
      lastIntensity: 1.2,
      lastSide: -1,
    });
    expect(chest.quaternion.angleTo(nextMixerPose)).toBeGreaterThan(0.001);

    controller.clear();
    expect(chest.quaternion.angleTo(nextMixerPose)).toBeLessThan(1e-7);
    expect(controller.getDiagnostics()).toMatchObject({
      triggerCount: 2,
      active: false,
      elapsedSeconds: null,
      currentWeight: 0,
    });
  });
});
