import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { createObjectAxisRegionGeometry } from "./object-axis-region";

describe("object-axis region geometry", () => {
  it("keeps only triangles inside the authored source-axis interval", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [-1, 0.1, 0, 1, 0.1, 0, 0, 0.2, 0, -1, 0.8, 0, 1, 0.8, 0, 0, 0.9, 0],
        3,
      ),
    );
    const content = new THREE.Group();
    content.position.set(2, 3, 4);
    content.rotation.set(0.2, -0.4, 0.7);
    content.scale.setScalar(1.8);
    content.add(new THREE.Mesh(geometry));
    const region = createObjectAxisRegionGeometry(
      content,
      new THREE.Vector3(0, 1, 0),
      0,
      0.4,
    );
    expect(region.sourceMeshCount).toBe(1);
    expect(region.triangleCount).toBe(1);
    expect(region.geometry.getAttribute("position").count).toBe(3);
    region.geometry.dispose();
    geometry.dispose();
  });

  it("rejects an empty or reversed axis authority", () => {
    const content = new THREE.Group();
    expect(() =>
      createObjectAxisRegionGeometry(content, new THREE.Vector3(), 0, 1),
    ).toThrow(/authority is invalid/u);
    expect(() =>
      createObjectAxisRegionGeometry(content, new THREE.Vector3(0, 1, 0), 1, 0),
    ).toThrow(/authority is invalid/u);
  });
});
