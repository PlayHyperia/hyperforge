import { describe, expect, it } from "vitest";
import * as THREE from "../three";
import { copyAvatarBoneWorldTransform } from "../createVRMFactory";

describe("VRM world bone transforms", () => {
  it("does not apply the moved avatar scene transform twice", () => {
    const avatarWorld = new THREE.Matrix4().compose(
      new THREE.Vector3(350.5, 24.175, 405.5),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        Math.PI * 0.73,
      ),
      new THREE.Vector3(1, 1, 1),
    );
    const localHead = new THREE.Matrix4().makeTranslation(0, 1.38, 0);
    const boneWorld = avatarWorld.clone().multiply(localHead);
    const copied = copyAvatarBoneWorldTransform(new THREE.Matrix4(), boneWorld);
    const accidentallyDoubled = avatarWorld.clone().multiply(boneWorld);

    expect(copied.elements).toEqual(boneWorld.elements);
    expect(new THREE.Vector3().setFromMatrixPosition(copied).y).toBeCloseTo(
      25.555,
      3,
    );
    expect(new THREE.Vector3().setFromMatrixPosition(copied)).not.toEqual(
      new THREE.Vector3().setFromMatrixPosition(accidentallyDoubled),
    );
  });
});
