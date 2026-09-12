import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  COMPACT_POND_ROOT_SUPPORT,
  createCompactPondDressing,
  type CompactPondModel,
  type CompactPondPlacement,
} from "../CompactPondDressing";
import { CompactPondDressingVisuals } from "../CompactPondDressingVisuals";
import { createCompactServicePlanting } from "../CompactServiceCourt";
import { RetainedTerrainSurface } from "../TerrainGridSurface";

const models = Object.keys(COMPACT_POND_MODELS) as CompactPondModel[];
function canonicalGeometry(model: CompactPondModel) {
  const bytes = readFileSync(
    new URL(
      "../../../../../../server/world/assets/vegetation/compact-pond-v1/" +
        COMPACT_POND_MODELS[model].file,
      import.meta.url,
    ),
  );
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(4)).toBe(2);
  const length = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString()) as {
    nodes: {
      mesh: number;
      matrix?: number[];
      scale?: number[];
      translation?: number[];
      rotation?: number[];
    }[];
    meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    accessors: {
      bufferView: number;
      byteOffset?: number;
      componentType: number;
      count: number;
      type: string;
    }[];
    bufferViews: { buffer: number; byteOffset?: number; byteStride?: number }[];
  };
  // These exact canonical exports have one identity-transformed mesh. Refuse
  // to treat a future different hierarchy as if raw accessor data were world data.
  expect(gltf.nodes).toHaveLength(1);
  expect(gltf.nodes[0].mesh).toBe(0);
  for (const key of ["matrix", "scale", "translation", "rotation"] as const)
    expect(gltf.nodes[0][key]).toBeUndefined();
  expect(gltf.meshes).toHaveLength(1);
  expect(gltf.meshes[0].primitives).toHaveLength(1);
  const accessor =
      gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION],
    view = gltf.bufferViews[accessor.bufferView];
  expect(accessor.componentType).toBe(5126);
  expect(accessor.type).toBe("VEC3");
  expect(view.buffer).toBe(0);
  const start =
      28 + length + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
    stride = view.byteStride ?? 12;
  const positions = new Float32Array(accessor.count * 3);
  for (let i = 0; i < accessor.count; i++)
    for (let axis = 0; axis < 3; axis++)
      positions[i * 3 + axis] = bytes.readFloatLE(
        start + i * stride + axis * 4,
      );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}
function grid(
  height: number | ((x: number, z: number) => number),
  centerX = 0,
  resolution = 2,
  size = 20,
) {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [],
    indices: number[] = [];
  for (let z = 0; z < resolution; z++)
    for (let x = 0; x < resolution; x++) {
      const px = Math.fround(-size / 2 + (x * size) / (resolution - 1)),
        pz = Math.fround(-size / 2 + (z * size) / (resolution - 1));
      positions.push(
        px,
        typeof height === "number" ? height : height(px + centerX, pz),
        pz,
      );
      if (x < resolution - 1 && z < resolution - 1) {
        const a = z * resolution + x;
        indices.push(
          a,
          a + resolution,
          a + 1,
          a + 1,
          a + resolution,
          a + resolution + 1,
        );
      }
    }
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  return {
    geometry,
    surface: new RetainedTerrainSurface(
      1,
      "fixture",
      centerX,
      0,
      size,
      resolution,
      geometry,
    ),
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
  it("derives canonical fern/bush/reed lower central support without mistaking their low drooping leaves for roots", () => {
    const owner = new CompactPondDressingVisuals(
      new THREE.Group(),
      placements(),
    );
    const material = new THREE.MeshStandardNodeMaterial(),
      geometries = models.map(canonicalGeometry);
    try {
      models.forEach((model, index) =>
        owner.install(model, new THREE.Mesh(geometries[index], material)),
      );
      const assets = owner.getReceipt().assets;
      for (const asset of assets) {
        const root = ["fern", "bush", "reed"].includes(asset.model);
        expect(asset.support.mode).toBe(root ? "root-slice" : "full-footprint");
        const box = asset.support.bounds!,
          full = asset.support.fullGeometryBounds!;
        if (!root) {
          expect(box).toEqual(full);
          continue;
        }
        expect(asset.support.rootSlice).toEqual(COMPACT_POND_ROOT_SUPPORT);
        expect(asset.support.selectedVertices).toBe(
          ({ fern: 31, bush: 6, reed: 184 } as Record<string, number>)[
            asset.model
          ],
        );
        expect(box.max[0] - box.min[0]).toBeLessThan(0.2);
        expect(box.max[2] - box.min[2]).toBeLessThan(0.36);
        expect(box.max[1]).toBeLessThanOrEqual(full.min[1] + 0.05);
        expect(
          (box.max[0] - box.min[0]) * (box.max[2] - box.min[2]),
        ).toBeLessThan(
          (full.max[0] - full.min[0]) * (full.max[2] - full.min[2]) * 0.1,
        );
        const positions =
          geometries[models.indexOf(asset.model)].getAttribute("position");
        let expectedCount = 0;
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i),
            y = positions.getY(i),
            z = positions.getZ(i);
          if (y <= full.min[1] + 0.05 && Math.hypot(x, z) <= 0.18) {
            expectedCount++;
            expect(x).toBeGreaterThanOrEqual(box.min[0]);
            expect(x).toBeLessThanOrEqual(box.max[0]);
            expect(z).toBeGreaterThanOrEqual(box.min[2]);
            expect(z).toBeLessThanOrEqual(box.max[2]);
          }
        }
        expect(expectedCount).toBe(asset.support.selectedVertices);
      }
    } finally {
      owner.destroy();
      for (const geometry of geometries) geometry.dispose();
      material.dispose();
    }
  });

  it("keeps roots on their actual slope while the crown overhangs lower terrain, retaining full culling bounds", () => {
    const p = { ...placements()[2], x: 0, z: 0, yaw: 0, scale: 1.05 };
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [p]);
    const material = new THREE.MeshStandardNodeMaterial();
    const root = new THREE.BoxGeometry(0.08, 0.04, 0.08).translate(
      0.02,
      0.02,
      0.01,
    );
    const crown = new THREE.BoxGeometry(0.9, 0.2, 0.9).translate(0, 0.4, 0);
    const source = new THREE.Group();
    source.add(new THREE.Mesh(root, material), new THREE.Mesh(crown, material));
    const ground = grid((x, z) => 3 + x * 0.5 + z * 0.25, 0, 9, 2);
    try {
      owner.install("fern", source);
      owner.update(0.25, () => ground.surface);
      const receipt = owner
          .getReceipt()
          .assets.find((asset) => asset.model === "fern")!,
        box = receipt.support.bounds!;
      const mesh = owner.group.children[0] as THREE.InstancedMesh,
        matrix = new THREE.Matrix4();
      mesh.getMatrixAt(0, matrix);
      const expected =
        3 +
        box.min[0] * p.scale * 0.5 +
        box.min[2] * p.scale * 0.25 -
        p.burial -
        box.min[1] * p.scale;
      expect(matrix.elements[13]).toBeCloseTo(expected, 6);
      const crownMinimum = 3 - 0.45 * p.scale * 0.75 - p.burial;
      expect(matrix.elements[13] - crownMinimum).toBeGreaterThan(0.3);
      const crownMesh = owner.group.children[1] as THREE.InstancedMesh;
      expect(
        crownMesh.boundingBox!.max.x - crownMesh.boundingBox!.min.x,
      ).toBeCloseTo(0.9 * p.scale, 5);
      expect(crownMesh.boundingBox!.max.y).toBeGreaterThan(3.4);
    } finally {
      owner.destroy();
      root.dispose();
      crown.dispose();
      ground.geometry.dispose();
      material.dispose();
    }
  });

  it("rejects unsupported hanging crowns instead of inventing a plant root footprint", () => {
    const owner = new CompactPondDressingVisuals(
      new THREE.Group(),
      placements(),
    );
    const geometry = new THREE.BoxGeometry(0.1, 0.1, 0.1).translate(
      0.5,
      0.2,
      0,
    );
    const material = new THREE.MeshStandardNodeMaterial();
    try {
      expect(() =>
        owner.install("fern", new THREE.Mesh(geometry, material)),
      ).toThrow("root-slice");
      expect(owner.group.children).toHaveLength(0);
    } finally {
      owner.destroy();
      geometry.dispose();
      material.dispose();
    }
  });
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
      // Genuine canonical geometry in one owner: court planting must not add
      // model loads, material clones or draw batches beside the original pond.
      const combined = [
        ...result,
        ...createCompactServicePlanting(
          DataManager.getWorldConfig()!.compactServicePlanting,
        ),
      ];
      expect(combined).toHaveLength(52);
      const owner = new CompactPondDressingVisuals(new THREE.Group(), combined);
      const geometries = models.map(canonicalGeometry);
      const texture = new THREE.DataTexture(
        new Uint8Array([110, 150, 80, 255]),
        1,
        1,
      );
      const material = new THREE.MeshStandardNodeMaterial({
        map: texture,
        alphaTest: 0.5,
      });
      const ground = grid(3, 0, 256, 1000);
      let borrowedDisposals = 0;
      for (const borrowed of [...geometries, material, texture])
        borrowed.addEventListener("dispose", () => borrowedDisposals++);
      try {
        models.forEach((model, i) =>
          owner.install(model, new THREE.Mesh(geometries[i], material)),
        );
        owner.update(0.25, () => ground.surface);
        expect(owner.group.children).toHaveLength(5);
        expect(owner.getReceipt()).toMatchObject({
          ready: true,
          instances: 52,
          visible: 52,
        });
        const bush = owner.group.children[
          models.indexOf("bush")
        ] as THREE.InstancedMesh;
        expect(bush.count).toBe(23);
        expect(bush.geometry).toBe(geometries[models.indexOf("bush")]);
        expect((bush.material as THREE.MeshStandardNodeMaterial).map).toBe(
          texture,
        );
        expect(bush.instanceMatrix.array.byteLength).toBe(23 * 64);
        const versions = owner.group.children.map(
          (o) => (o as THREE.InstancedMesh).instanceMatrix.version,
        );
        for (let i = 0; i < 40; i++) owner.update(0.25, () => ground.surface);
        expect(
          owner.group.children.map(
            (o) => (o as THREE.InstancedMesh).instanceMatrix.version,
          ),
        ).toEqual(versions);
        expect(
          owner.getReceipt().assets.every((a) => a.paletteMaterials === 1),
        ).toBe(true);
        owner.destroy();
        owner.destroy();
        expect(borrowedDisposals).toBe(0);
      } finally {
        owner.destroy();
        for (const geometry of geometries) geometry.dispose();
        ground.geometry.dispose();
        material.dispose();
        texture.dispose();
      }
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).toEqual(
        createCompactPondDressing(
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          areas,
          (x, z) => terrain.getHeightAtComputed(x, z),
        ),
      );
      expect(
        Object.fromEntries(
          models.map((model) => [
            model,
            result.filter((p) => p.model === model).length,
          ]),
        ),
      ).toEqual({ boulder: 4, stone: 6, fern: 8, bush: 3, reed: 11 });
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
      normalMap: texture,
      roughnessMap: texture,
      metalnessMap: texture,
      aoMap: texture,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    let borrowedDisposals = 0,
      instanceDisposals = 0,
      paletteDisposals = 0;
    const paletteMaterials = new Set<THREE.MeshStandardNodeMaterial>();
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
      for (const palette of (Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]) as THREE.MeshStandardNodeMaterial[]) {
        expect(palette).not.toBe(material);
        expect(palette).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
        expect(palette.colorNode?.isNode).toBe(true);
        expect(palette.map).toBe(texture);
        expect(palette.normalMap).toBe(texture);
        expect(palette.roughnessMap).toBe(texture);
        expect(palette.metalnessMap).toBe(texture);
        expect(palette.aoMap).toBe(texture);
        expect(palette.alphaTest).toBe(0.5);
        expect(palette.side).toBe(THREE.DoubleSide);
        if (!paletteMaterials.has(palette))
          palette.addEventListener("dispose", () => paletteDisposals++);
        paletteMaterials.add(palette);
      }
      expect(mesh.count).toBe(0);
    }
    expect(paletteMaterials.size).toBe(5);
    expect(material.colorNode).toBeNull();
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
      expect(paletteDisposals).toBe(5);
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

  it("grounds the entire conservative footprint at the exact triangle minimum, including an interior low grid vertex", () => {
    const placement = { ...placements()[0], x: 0, z: 0, yaw: 0 };
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [
      placement,
    ]);
    const geometry = new THREE.BoxGeometry(1, 0.2, 1).translate(0, 0.1, 0);
    const material = new THREE.MeshStandardNodeMaterial();
    const surface = grid(
      (x, z) =>
        Math.abs(x - 0.25) < 0.01 && Math.abs(z - 0.25) < 0.01 ? 1 : 3,
      0,
      9,
      2,
    );
    try {
      owner.install("boulder", new THREE.Mesh(geometry, material));
      owner.update(0.25, () => surface.surface);
      const mesh = owner.group.children[0] as THREE.InstancedMesh,
        actual = new THREE.Matrix4();
      expect(mesh.count).toBe(1);
      mesh.getMatrixAt(0, actual);
      expect(actual.elements[13]).toBeCloseTo(0.96, 6);
      const sample = { height: 0, nx: 0, ny: 1, nz: 0, faceIndex: 0 };
      expect(surface.surface.sample(0, 0, sample)).toBe(true);
      expect(sample.height).toBe(3); // Pivot-only anchoring would float by 2 m.
      for (let x = -0.5; x <= 0.5; x += 0.025)
        for (let z = -0.5; z <= 0.5; z += 0.025) {
          expect(surface.surface.sample(x, z, sample)).toBe(true);
          expect(actual.elements[13]).toBeLessThanOrEqual(
            sample.height - placement.burial + 1e-6,
          );
        }
      const receipt = owner
        .getReceipt()
        .assets.find((a) => a.model === "boulder")!;
      expect(receipt.sampleQueries).toBeGreaterThan(10);
      expect(receipt.sampleQueries).toBeLessThanOrEqual(4096);
      const version = mesh.instanceMatrix.version;
      owner.update(0.25, () => surface.surface);
      expect(mesh.instanceMatrix.version).toBe(version);
    } finally {
      owner.destroy();
      surface.geometry.dispose();
      geometry.dispose();
      material.dispose();
    }
  });

  it("tracks neighbor surface revisions across a footprint and hides the instance if any footprint surface disappears", () => {
    const placement = { ...placements()[0], x: 0, z: 0, yaw: 0 };
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [
      placement,
    ]);
    const geometry = new THREE.BoxGeometry(1, 0.2, 1).translate(0, 0.1, 0),
      material = new THREE.MeshStandardNodeMaterial();
    const left = grid(4, -10),
      right = grid(4, 10),
      lowerRight = grid(2, 10);
    try {
      owner.install("boulder", new THREE.Mesh(geometry, material));
      const mesh = owner.group.children[0] as THREE.InstancedMesh,
        actual = new THREE.Matrix4();
      owner.update(0.25, (x) => (x <= 0 ? left.surface : right.surface));
      mesh.getMatrixAt(0, actual);
      expect(actual.elements[13]).toBeCloseTo(3.96, 6);
      owner.update(0.25, (x) => (x <= 0 ? left.surface : lowerRight.surface));
      mesh.getMatrixAt(0, actual);
      expect(actual.elements[13]).toBeCloseTo(1.96, 6);
      owner.update(0.25, (x) => (x <= 0 ? left.surface : null));
      expect(mesh.count).toBe(0);
      owner.update(0.25, (x) => (x <= 0 ? left.surface : right.surface));
      expect(mesh.count).toBe(1);
    } finally {
      owner.destroy();
      left.geometry.dispose();
      right.geometry.dispose();
      lowerRight.geometry.dispose();
      geometry.dispose();
      material.dispose();
    }
  });

  it("bounds complete 32-instance footprint installs on the highest admitted terrain resolution without new textures or repeated uploads", () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({
      ...placements()[0],
      id: `budget_${i}`,
      x: 0,
      z: 0,
      scale: 1.25,
      yaw: Math.PI / 4,
    }));
    const owner = new CompactPondDressingVisuals(new THREE.Group(), rows);
    const geometry = new THREE.SphereGeometry(0.88, 16, 12)
        .scale(1, 0.7, 1)
        .translate(0, 0.616, 0),
      material = new THREE.MeshStandardNodeMaterial();
    const ground = grid((x, z) => 5 + x * 0.2 + z * 0.1, 0, 256, 100);
    try {
      owner.install("boulder", new THREE.Mesh(geometry, material));
      let lookups = 0;
      owner.update(0.25, () => {
        lookups++;
        return ground.surface;
      });
      const receipt = owner
        .getReceipt()
        .assets.find((a) => a.model === "boulder")!;
      expect(receipt.visible).toBe(32);
      expect(lookups).toBe(32 * 9);
      expect(receipt.sampleQueries).toBeLessThan(32 * 1024);
      expect(receipt.paletteMaterials).toBe(1);
      const mesh = owner.group.children[0] as THREE.InstancedMesh,
        version = mesh.instanceMatrix.version;
      for (let i = 0; i < 40; i++) owner.update(0.25, () => ground.surface);
      expect(mesh.instanceMatrix.version).toBe(version);
      expect(owner.group.children).toHaveLength(1);
    } finally {
      owner.destroy();
      ground.geometry.dispose();
      geometry.dispose();
      material.dispose();
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
