import { describe, expect, it } from "vitest";
import THREE from "../../../extras/three/three";
import {
  createStorageInstancedMesh,
  INSTANCE_MATRIX_STORAGE_ATTRIBUTE,
} from "../createStorageInstancedMesh";

function bytes(mesh: THREE.InstancedMesh): Uint8Array {
  const array = mesh.instanceMatrix.array;
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

describe("versioned GLB pool matrix storage", () => {
  it("retains all 512 identity matrices, static usage, and explicit dirty versions", () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardNodeMaterial();
    const baseline = new THREE.InstancedMesh(geometry, material, 512);
    const owned = geometry.clone();
    const candidate = createStorageInstancedMesh(owned, material, 512);
    try {
      expect(candidate.instanceMatrix).toBeInstanceOf(
        THREE.StorageInstancedBufferAttribute,
      );
      expect(candidate.instanceMatrix).toBeInstanceOf(
        THREE.InstancedBufferAttribute,
      );
      expect(candidate.instanceMatrix.usage).toBe(THREE.StaticDrawUsage);
      expect(candidate.instanceMatrix.count).toBe(512);
      expect(candidate.instanceMatrix.itemSize).toBe(16);
      expect(candidate.instanceMatrix.array.byteLength).toBe(32768);
      expect(candidate.instanceMatrix.normalized).toBe(false);
      expect(candidate.count).toBe(baseline.count);
      expect(bytes(candidate)).toEqual(bytes(baseline));
      expect(owned.getAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE)).toBe(
        candidate.instanceMatrix,
      );
      expect(geometry.hasAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE)).toBe(
        false,
      );

      const matrices = Array.from({ length: 512 }, (_, index) =>
        new THREE.Matrix4().compose(
          new THREE.Vector3(index * 0.125, index % 7, -index * 0.25),
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0.13, index * 0.01, -0.21),
          ),
          new THREE.Vector3(0.75, 1.25, 2),
        ),
      );
      for (let index = 0; index < matrices.length; index++) {
        candidate.setMatrixAt(index, matrices[index]);
        baseline.setMatrixAt(index, matrices[index]);
      }
      expect(candidate.instanceMatrix.version).toBe(0);
      expect(bytes(candidate)).toEqual(bytes(baseline));
      const actual = new THREE.Matrix4();
      const expected = new THREE.Matrix4();
      for (const index of [0, 1, 255, 511]) {
        candidate.getMatrixAt(index, actual);
        baseline.getMatrixAt(index, expected);
        expect(actual.elements).toEqual(expected.elements);
      }
      candidate.instanceMatrix.needsUpdate = true;
      baseline.instanceMatrix.needsUpdate = true;
      expect(candidate.instanceMatrix.version).toBe(1);
      // Swap-and-pop and a zero transform remain ordinary CPU matrix writes.
      for (const mesh of [candidate, baseline]) {
        mesh.getMatrixAt(511, actual);
        mesh.setMatrixAt(7, actual);
        mesh.setMatrixAt(511, new THREE.Matrix4().makeScale(0, 0, 0));
        mesh.count = 511;
      }
      expect(candidate.instanceMatrix.version).toBe(1);
      expect(bytes(candidate)).toEqual(bytes(baseline));
      candidate.instanceMatrix.needsUpdate = true;
      expect(candidate.instanceMatrix.version).toBe(2);
      expect(() => createStorageInstancedMesh(owned, material, 512)).toThrow(
        "already has an owner",
      );
    } finally {
      owned.dispose();
      geometry.dispose();
      material.dispose();
    }
  });

  it("preserves actual ray hits, bounds and active-count exclusion with nonuniform transforms", () => {
    const geometry = new THREE.BoxGeometry(1, 2, 1);
    const owned = geometry.clone();
    const material = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
    });
    const baseline = new THREE.InstancedMesh(geometry, material, 512);
    const candidate = createStorageInstancedMesh(owned, material, 512);
    try {
      for (const mesh of [baseline, candidate]) {
        for (let index = 0; index < 3; index++) {
          mesh.setMatrixAt(
            index,
            new THREE.Matrix4().compose(
              new THREE.Vector3(index * 4, 3 + index, 2),
              new THREE.Quaternion().setFromAxisAngle(
                THREE.Object3D.DEFAULT_UP,
                index * 0.31,
              ),
              new THREE.Vector3(0.7 + index, 1.3, 1.1),
            ),
          );
        }
        mesh.count = 2;
        mesh.position.set(10, -1, 8);
        mesh.updateMatrixWorld(true);
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
      }
      expect(candidate.boundingBox).toEqual(baseline.boundingBox);
      expect(candidate.boundingSphere).toEqual(baseline.boundingSphere);
      for (let index = 0; index < 3; index++) {
        const ray = new THREE.Raycaster(
          new THREE.Vector3(10 + index * 4, 20, 10),
          new THREE.Vector3(0, -1, 0),
        );
        const summarize = (mesh: THREE.InstancedMesh) =>
          ray.intersectObject(mesh, false).map((hit) => ({
            instanceId: hit.instanceId,
            faceIndex: hit.faceIndex,
            distance: hit.distance,
            point: hit.point.toArray(),
            normal: hit.normal?.toArray(),
          }));
        expect(summarize(candidate)).toEqual(summarize(baseline));
        if (index < 2) expect(summarize(candidate).length).toBeGreaterThan(0);
        else expect(summarize(candidate)).toEqual([]);
      }
    } finally {
      owned.dispose();
      geometry.dispose();
      material.dispose();
    }
  });
});
