import { describe, expect, it } from "vitest";
import THREE, { MeshStandardNodeMaterial } from "../../../extras/three/three";
import { modelCache } from "../ModelCache";

type ModelCacheInternals = {
  setupMaterials: (scene: THREE.Object3D) => void;
};

describe("ModelCache geometry setup", () => {
  it("converts one source material once across static LOD meshes", () => {
    const geometry = new THREE.BoxGeometry();
    const map = new THREE.DataTexture(
      new Uint8Array([128, 128, 128, 255]),
      1,
      1,
    );
    const original = new THREE.MeshStandardMaterial({ map, roughness: 0.92 });
    const scene = new THREE.Group();
    for (let i = 0; i < 9; i++) scene.add(new THREE.Mesh(geometry, original));
    (modelCache as unknown as ModelCacheInternals).setupMaterials(scene);
    const materials = scene.children.map(
      (child) =>
        (child as THREE.Mesh).material as THREE.MeshStandardNodeMaterial,
    );
    expect(new Set(materials).size).toBe(1);
    expect(materials[0]).not.toBe(original);
    expect(materials[0].map).toBe(map);
    expect(materials[0].roughness).toBe(0.92);
    geometry.dispose();
    original.dispose();
    materials[0].dispose();
    map.dispose();
  });

  it("keeps different effective vertex-color variants separate without converting each twice", () => {
    const plain = new THREE.BoxGeometry();
    const colored = plain.clone();
    colored.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        new Float32Array(colored.getAttribute("position").count * 3).fill(1),
        3,
      ),
    );
    const original = new THREE.MeshStandardMaterial();
    const scene = new THREE.Group();
    for (const geometry of [plain, colored, plain, colored])
      scene.add(new THREE.Mesh(geometry, original));
    (modelCache as unknown as ModelCacheInternals).setupMaterials(scene);
    const materials = scene.children.map(
      (child) =>
        (child as THREE.Mesh).material as THREE.MeshStandardNodeMaterial,
    );
    expect(materials[0]).toBe(materials[2]);
    expect(materials[1]).toBe(materials[3]);
    expect(materials[0]).not.toBe(materials[1]);
    expect(materials[0].vertexColors).toBe(false);
    expect(materials[1].vertexColors).toBe(true);
    expect(original.vertexColors).toBe(false);
    plain.dispose();
    colored.dispose();
    original.dispose();
    for (const material of new Set(materials)) material.dispose();
  });

  it("computes normals before converting meshes to lit WebGPU materials", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3),
    );

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ vertexColors: true }),
    );
    const scene = new THREE.Scene();
    scene.add(mesh);

    (modelCache as unknown as ModelCacheInternals).setupMaterials(scene);

    expect(mesh.geometry.attributes.normal).toBeDefined();
    expect(mesh.material).toBeInstanceOf(MeshStandardNodeMaterial);
  });
});
