import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { TerrainSystem } from "../TerrainSystem";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
} from "../WorldTerrainProfile";
import {
  COMPACT_POND_MODELS,
  createCompactPondDressing,
  type CompactPondModel,
  type CompactPondPlacement,
} from "../CompactPondDressing";
import { CompactPondDressingVisuals } from "../CompactPondDressingVisuals";
import { RetainedTerrainSurface } from "../TerrainGridSurface";

const models = Object.keys(COMPACT_POND_MODELS) as CompactPondModel[];
function grid(height: number) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-10, height, -10, 10, height, -10, -10, height, 10, 10, height, 10],
      3,
    ),
  );
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  return {
    geometry,
    surface: new RetainedTerrainSurface(1, "fixture", 0, 0, 20, 2, geometry),
  };
}
function placements(): readonly CompactPondPlacement[] {
  return models.map((model, i) => ({
    id: model,
    model,
    x: i,
    z: 0,
    scale: 1,
    yaw: Math.PI / 2,
    burial: 0.04,
  }));
}

describe("bounded pond dressing", () => {
  it("places the complete authored kit around actual admitted terrain, with rocks in existing water and the south approach open", async () => {
    await DataManager.getInstance().initialize();
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    try {
      await terrain.init();
      (
        terrain as unknown as { loadFlatZonesFromManifest(): void }
      ).loadFlatZonesFromManifest();
      const areas = DataManager.getInstance().getAllWorldAreas();
      const result = createCompactPondDressing(
        SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        areas,
        (x, z) => terrain.getHeightAtComputed(x, z),
      );
      expect(result).toHaveLength(32);
      expect(Object.isFrozen(result)).toBe(true);
      const pond = areas.haven_pond.waterBodies![0];
      for (const p of result) {
        const radius = COMPACT_POND_MODELS[p.model].radius * p.scale;
        expect(p.z + radius).toBeLessThan(pond.centerZ);
        if (p.model === "boulder" || p.model === "stone") {
          for (let angle = 0; angle < Math.PI * 2; angle += 0.03) {
            const x = p.x + Math.cos(angle) * radius,
              z = p.z + Math.sin(angle) * radius;
            expect(Math.hypot(x - pond.centerX, z - pond.centerZ)).toBeLessThan(
              pond.radius,
            );
            expect(terrain.getHeightAtComputed(x, z)).toBeLessThan(
              pond.surfaceY - 0.04,
            );
          }
        }
      }
      expect(
        createCompactPondDressing(COMPACT_WORLD_TERRAIN_PROFILE, {}, () => 0),
      ).toEqual([]);
      expect(() =>
        createCompactPondDressing(
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          areas,
          () => 999,
        ),
      ).toThrow("underwater");
      expect(() =>
        createCompactPondDressing(
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          {},
          () => 0,
        ),
      ).toThrow("Haven pond");
    } finally {
      terrain.destroy();
    }
  });

  it("preserves every real mesh/material group, texture and transform; grounds against exact triangles and releases only owned instances", () => {
    const parent = new THREE.Group();
    const owner = new CompactPondDressingVisuals(parent, placements());
    const texture = new THREE.DataTexture(
      new Uint8Array([100, 120, 140, 255]),
      1,
      1,
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshStandardNodeMaterial({
      map: texture,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    let borrowedDisposals = 0,
      instanceDisposals = 0;
    for (const resource of [texture, material, geometry])
      resource.addEventListener("dispose", () => borrowedDisposals++);
    const source = new THREE.Group();
    source.position.set(0.1, 0.1, 0.1);
    const first = new THREE.Mesh(geometry, [
      material,
      material,
      material,
      material,
      material,
      material,
    ]);
    const second = new THREE.Mesh(geometry, material);
    second.position.set(0.1, 0, 0);
    source.add(first, second);
    const originalMaps = [material.map, material.alphaTest, material.side];
    for (const model of models) owner.install(model, source);
    expect(owner.group.children).toHaveLength(10);
    for (const child of owner.group.children) {
      const mesh = child as THREE.InstancedMesh;
      mesh.addEventListener("dispose", () => instanceDisposals++);
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.material).toBe(
        mesh.name.endsWith("_0") ? first.material : material,
      );
      expect(mesh.count).toBe(0);
    }
    const a = grid(3),
      b = grid(7);
    try {
      owner.update(0.25, () => a.surface);
      expect(owner.getReceipt()).toMatchObject({
        ready: true,
        visible: 5,
        instances: 5,
      });
      const actual = new THREE.Matrix4(),
        expected = new THREE.Matrix4();
      const placement = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 2.96, 0),
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          Math.PI / 2,
        ),
        new THREE.Vector3(1, 1, 1),
      );
      (owner.group.children[1] as THREE.InstancedMesh).getMatrixAt(0, actual);
      expected.multiplyMatrices(placement, second.matrixWorld);
      actual.elements.forEach((value, i) =>
        expect(value).toBeCloseTo(expected.elements[i], 6),
      );
      const version = (owner.group.children[0] as THREE.InstancedMesh)
        .instanceMatrix.version;
      owner.update(0.25, () => a.surface);
      expect(
        (owner.group.children[0] as THREE.InstancedMesh).instanceMatrix.version,
      ).toBe(version);
      owner.update(0.25, () => null);
      expect(owner.getReceipt()).toMatchObject({ ready: false, visible: 0 });
      owner.update(0.25, () => b.surface);
      (owner.group.children[0] as THREE.InstancedMesh).getMatrixAt(0, actual);
      expect(actual.elements[13]).toBeCloseTo(7.06);
      expect([material.map, material.alphaTest, material.side]).toEqual(
        originalMaps,
      );
      owner.destroy();
      owner.destroy();
      expect(instanceDisposals).toBe(10);
      expect(borrowedDisposals).toBe(0);
      expect(parent.children).toHaveLength(0);
      owner.install("boulder", source); // A late loader result cannot resurrect the owner.
      owner.update(0.25, () => a.surface);
      expect(parent.children).toHaveLength(0);
      expect(owner.getReceipt().ready).toBe(false);
    } finally {
      owner.destroy();
      a.geometry.dispose();
      b.geometry.dispose();
      texture.dispose();
      material.dispose();
      geometry.dispose();
    }
  });

  it("rejects malformed/out-of-envelope assets before attaching any partial model", () => {
    const owner = new CompactPondDressingVisuals(
      new THREE.Group(),
      placements(),
    );
    const geometry = new THREE.BoxGeometry(4, 4, 4),
      material = new THREE.MeshStandardNodeMaterial();
    try {
      expect(() =>
        owner.install("boulder", new THREE.Mesh(geometry, material)),
      ).toThrow("bounds");
      expect(owner.group.children).toHaveLength(0);
      expect(
        () =>
          new CompactPondDressingVisuals(new THREE.Group(), [
            ...placements(),
            ...placements(),
          ]),
      ).toThrow("identities");
    } finally {
      owner.destroy();
      geometry.dispose();
      material.dispose();
    }
  });
});
