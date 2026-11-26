import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { nearestMeshSurfaceDistance } from "./nearest-mesh-surface-distance";

describe("nearestMeshSurfaceDistance", () => {
  it("measures a sparse shaft surface instead of the nearest end vertex", () => {
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 2, 8, 1, false),
    );
    const root = new THREE.Group();
    root.position.set(0.4, 0.2, -0.3);
    root.rotation.set(0.3, -0.5, 0.8);
    root.add(shaft);
    root.updateMatrixWorld(true);

    const point = shaft.localToWorld(new THREE.Vector3(0.04, 0, 0));
    expect(nearestMeshSurfaceDistance(root, point)).toBeCloseTo(0.015, 4);
  });

  it("supports indexed and non-indexed triangle geometry", () => {
    const indexed = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    expect(
      nearestMeshSurfaceDistance(indexed, new THREE.Vector3(0, 0, 1.4)),
    ).toBeCloseTo(0.4, 6);

    const nonIndexed = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2).toNonIndexed(),
    );
    expect(
      nearestMeshSurfaceDistance(nonIndexed, new THREE.Vector3(0, 0, 1.4)),
    ).toBeCloseTo(0.4, 6);
  });

  it("falls back to vertices for non-triangle geometry", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0], 3),
    );
    const points = new THREE.Points(geometry);
    expect(
      nearestMeshSurfaceDistance(points, new THREE.Vector3(0.25, 0, 0)),
    ).toBeCloseTo(0.25, 6);
  });
});
