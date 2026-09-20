import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import northernHabitat from "../../../../data/compact-pond-northern-habitat-v1.json";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import type { FlatZone } from "../../../../types/world/terrain";
import { TerrainSystem } from "../TerrainSystem";
import { resolveRadialPondTerrainHeight } from "../RadialPondTerrainProfile";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
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

// Historical fixtures remain the original five assets. The additive selected
// habitat is exercised separately; it must not broaden default load ownership.
const models: CompactPondModel[] = ["boulder", "stone", "fern", "bush", "reed"];
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
  it("joins the candidate asymmetric bank with unequal contact groups while retaining exact historical admission and safe rock footprints", async () => {
    await DataManager.getInstance().initialize();
    const areas = DataManager.getInstance().getAllWorldAreas();
    const original = areas.haven_pond.flatZones!.find(
      (zone) => zone.radialPond,
    )!;
    const bank: FlatZone = {
      ...original,
      height: original.height!,
      radialPond: {
        ...original.radialPond!,
        bankSectors: [
          {
            bearing: (-133 * Math.PI) / 180,
            halfWidth: (40 * Math.PI) / 180,
            innerRadius: 6.25,
            innerHeight: 27.84,
          },
          {
            bearing: (-27 * Math.PI) / 180,
            halfWidth: (24 * Math.PI) / 180,
            innerRadius: 6.55,
            innerHeight: 28.08,
          },
        ],
      },
    };
    const candidateAreas = {
      ...areas,
      haven_pond: { ...areas.haven_pond, flatZones: [bank] },
    };
    const profile = validateWorldTerrainProfile({
      ...DataManager.getWorldConfig()!.terrainProfile,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    // Real shared resolver, with a surrounding level bank outside its support.
    const height = (x: number, z: number) =>
      resolveRadialPondTerrainHeight(bank, x, z, () => 28.08) ?? 28.08;
    const rows = createCompactPondDressing(profile, candidateAreas, height);
    const { southernMeadow: _candidate, ...historicalProfile } = profile;
    const legacy = createCompactPondDressing(
      historicalProfile,
      candidateAreas,
      height,
    );
    expect(rows).toHaveLength(32);
    expect(rows.map((p) => [p.id, p.model])).toEqual(
      legacy.map((p) => [p.id, p.model]),
    );
    expect(Object.isFrozen(rows)).toBe(true);
    expect(rows.every(Object.isFrozen)).toBe(true);
    expect(rows).toEqual(
      createCompactPondDressing(profile, candidateAreas, height),
    );
    expect(createCompactPondDressing(profile, areas, height)).toEqual(legacy);
    expect(
      createCompactPondDressing(
        { ...profile, id: "unselected" },
        candidateAreas,
        height,
      ),
    ).toEqual(legacy);
    const pond = areas.haven_pond.waterBodies![0];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        old = legacy[i];
      const radius = COMPACT_POND_MODELS[row.model].radius * row.scale;
      expect(row.z + radius).toBeLessThan(pond.centerZ);
      if (row.model === "boulder" || row.model === "stone") {
        // Test the disk's perimeter as well as the production interior lattice.
        for (let a = 0; a < Math.PI * 2; a += 0.01) {
          const x = row.x + radius * Math.cos(a),
            z = row.z + radius * Math.sin(a);
          expect(Math.hypot(x - pond.centerX, z - pond.centerZ)).toBeLessThan(
            pond.radius,
          );
          expect(height(x, z)).toBeLessThan(pond.surfaceY - 0.04);
        }
      } else {
        expect(
          Math.hypot(row.x - pond.centerX, row.z - pond.centerZ),
        ).toBeLessThan(Math.hypot(old.x - pond.centerX, old.z - pond.centerZ));
        expect(height(row.x, row.z)).toBeGreaterThan(pond.surfaceY);
      }
    }
    // A smaller north link prevents three equally weighted decorated pockets.
    expect(rows[15].scale).toBeLessThan(rows[0].scale);
    expect(rows[15].scale).toBeLessThan(rows[24].scale);
  });

  it("admits the authored northern habitat only for shaped banks, preserving rocks, eastern composition and all southern clearance", async () => {
    await DataManager.getInstance().initialize();
    const areas = DataManager.getInstance().getAllWorldAreas();
    const original = areas.haven_pond.flatZones!.find(
      (zone) => zone.radialPond,
    )!;
    const sectors = [
      {
        bearing: -2.321287905152458,
        halfWidth: 0.6981317007977318,
        innerRadius: 6,
        innerHeight: 27.98,
        outerRadius: 8.2,
        outerHeight: 28.55,
      },
      {
        bearing: -0.47123889803846897,
        halfWidth: 0.41887902047863906,
        innerRadius: 6.55,
        innerHeight: 28.08,
      },
      { bearing: 0.7, halfWidth: 0.55, innerRadius: 6.4, innerHeight: 27.86 },
      {
        bearing: -1.5533430342749532,
        halfWidth: 0.8726646259971648,
        innerRadius: 7.1,
        innerHeight: 27.86,
        outerRadius: 8.7,
        outerHeight: 27.99,
      },
    ];
    const bank: FlatZone = {
      ...original,
      height: original.height!,
      radialPond: { ...original.radialPond!, bankSectors: sectors },
    };
    const withSectors = (
      bankSectors: NonNullable<FlatZone["radialPond"]>["bankSectors"],
    ) => ({
      ...areas,
      haven_pond: {
        ...areas.haven_pond,
        flatZones: [
          { ...bank, radialPond: { ...bank.radialPond!, bankSectors } },
        ],
      },
    });
    const profile = validateWorldTerrainProfile({
      ...DataManager.getWorldConfig()!.terrainProfile,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    const height = (x: number, z: number) =>
      resolveRadialPondTerrainHeight(bank, x, z, () => 28.08) ?? 28.08;
    // Both layouts use the same actual height function: this isolates the
    // composition selector from the separate terrain-shape change.
    const legacySectors = sectors.map(
      ({ bearing, halfWidth, innerRadius, innerHeight }) => ({
        bearing,
        halfWidth,
        innerRadius,
        innerHeight,
      }),
    );
    const legacy = createCompactPondDressing(
      profile,
      withSectors(legacySectors),
      height,
    );
    const rows = createCompactPondDressing(
      profile,
      withSectors(sectors),
      height,
    );
    expect(rows).toHaveLength(40);
    expect(legacy).toHaveLength(32);
    expect(rows).toEqual(
      createCompactPondDressing(profile, withSectors(sectors), height),
    );
    expect(Object.isFrozen(rows)).toBe(true);
    expect(rows.every(Object.isFrozen)).toBe(true);
    expect(rows.filter((row) => row.model === "boulder")).toHaveLength(4);
    expect(rows.filter((row) => row.model === "stone")).toHaveLength(6);
    expect(rows.filter((row) => row.model === "fern")).toHaveLength(8);
    expect(rows.filter((row) => row.model === "bush")).toHaveLength(3);
    expect(rows.filter((row) => row.model === "reed")).toHaveLength(15);
    expect(rows.filter((row) => row.model === "sorrel")).toHaveLength(4);
    expect(new Set(rows.map((row) => row.id)).size).toBe(40);
    const replacements = new Map(
      northernHabitat.replacements.map((row) => [row.index, row]),
    );
    const pond = areas.haven_pond.waterBodies![0];
    rows.forEach((row, index) => {
      const { x, z, ...metadata } = row;
      if (index < 32 && !replacements.has(index)) {
        const { x: oldX, z: oldZ, ...oldMetadata } = legacy[index];
        expect(metadata).toEqual(oldMetadata);
        if (index < 15 || index >= 24) expect(row).toEqual(legacy[index]);
        else {
          // The old multi-knot northward rock relocation is unchanged. New
          // habitat data cannot alter these models, scales, yaw or burial.
          expect(Math.hypot(x - oldX, z - oldZ)).toBeGreaterThan(1);
          const bearing =
            (Math.atan2(z - pond.centerZ, x - pond.centerX) * 180) / Math.PI;
          expect(bearing).toBeGreaterThan(-100);
          expect(bearing).toBeLessThan(-75);
        }
      } else {
        const authored =
          replacements.get(index) ?? northernHabitat.additions[index - 32];
        expect(metadata).toEqual({
          id: `haven_pond_${authored.model}_${index}`,
          model: authored.model,
          scale: authored.scale,
          yaw: (authored.yaw * Math.PI) / 180,
          burial: 0.04,
        });
        expect(["boulder", "stone"]).not.toContain(row.model);
      }
      const radius = COMPACT_POND_MODELS[row.model].radius * row.scale;
      expect(z + radius).toBeLessThan(pond.centerZ);
      if (row.model === "boulder" || row.model === "stone") {
        for (let step = 0; step < 128; step++) {
          const angle = (step * Math.PI) / 64;
          const px = x + radius * Math.cos(angle),
            pz = z + radius * Math.sin(angle);
          expect(Math.hypot(px - pond.centerX, pz - pond.centerZ)).toBeLessThan(
            pond.radius,
          );
          expect(height(px, pz)).toBeLessThan(pond.surfaceY - 0.04);
        }
      } else expect(height(x, z)).toBeGreaterThan(pond.surfaceY);
    });
    // Same owner, existing service placements and unchanged hard instance cap.
    // This is canonical asset/root ownership proof, not a visual or GPU test.
    const service = createCompactServicePlanting(
      DataManager.getWorldConfig()!.compactServicePlanting,
    );
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [
      ...rows,
      ...service,
    ]);
    const selectedModels = [...models, "sorrel" as const];
    const geometries = selectedModels.map(canonicalGeometry);
    const material = new THREE.MeshStandardNodeMaterial();
    const ground = grid(3, 0, 256, 1000);
    try {
      selectedModels.forEach((model, index) =>
        owner.install(model, new THREE.Mesh(geometries[index], material)),
      );
      owner.update(0.25, () => ground.surface);
      expect(owner.getReceipt()).toMatchObject({
        ready: true,
        instances: 64,
        visible: 64,
      });
      expect(owner.group.children).toHaveLength(6);
      expect(
        owner
          .getReceipt()
          .assets.map((asset) => [asset.model, asset.instances]),
      ).toEqual([
        ["boulder", 4],
        ["stone", 6],
        ["fern", 12],
        ["bush", 23],
        ["reed", 15],
        ["sorrel", 4],
      ]);
      expect(
        () =>
          new CompactPondDressingVisuals(new THREE.Group(), [
            ...rows,
            ...service,
            { ...rows[0], id: "over-budget" },
          ]),
      ).toThrow("budget");
      const versions = owner.group.children.map(
        (mesh) => (mesh as THREE.InstancedMesh).instanceMatrix.version,
      );
      owner.update(0.25, () => ground.surface);
      expect(
        owner.group.children.map(
          (mesh) => (mesh as THREE.InstancedMesh).instanceMatrix.version,
        ),
      ).toEqual(versions);
    } finally {
      owner.destroy();
      geometries.forEach((geometry) => geometry.dispose());
      material.dispose();
      ground.geometry.dispose();
    }
    const { southernMeadow: _selected, ...historicalProfile } = profile;
    expect(
      createCompactPondDressing(
        historicalProfile,
        withSectors(sectors),
        height,
      ),
    ).toEqual(
      createCompactPondDressing(
        historicalProfile,
        withSectors(legacySectors),
        height,
      ),
    );
    expect(
      createCompactPondDressing(
        { ...profile, id: "unselected" },
        withSectors(sectors),
        height,
      ),
    ).toEqual(
      createCompactPondDressing(
        { ...profile, id: "unselected" },
        withSectors(legacySectors),
        height,
      ),
    );
  });

  it("composes two unequal shelf islands while preserving every plant model, scale and yaw and leaving the cut face open", async () => {
    // These are the pre-composition asset/scale/yaw budgets, not values read
    // back from the edited authoring data. Placement may change; assets and
    // visual cost may not be silently traded for a fuller-looking shoreline.
    expect(
      northernHabitat.replacements.map(({ index, model, scale, yaw }) => [
        index,
        model,
        scale,
        yaw,
      ]),
    ).toEqual([
      [5, "fern", 1.05, 17],
      [6, "fern", 0.95, 125],
      [7, "fern", 1.1, 240],
      [8, "fern", 0.9, 73],
      [9, "bush", 0.38, 27],
      [10, "reed", 1.15, 27],
      [11, "reed", 1, 121],
      [12, "reed", 1.2, 232],
      [13, "reed", 1.05, 67],
      [14, "reed", 0.95, 178],
      [18, "fern", 0.95, 112],
      [19, "fern", 0.8, 267],
      [20, "bush", 0.4, 211],
      [21, "reed", 1, 300],
      [22, "reed", 1.12, 57],
      [23, "reed", 0.85, 213],
    ]);
    expect(
      northernHabitat.additions.map(({ model, scale, yaw }) => [
        model,
        scale,
        yaw,
      ]),
    ).toEqual([
      ["reed", 1.08, 198],
      ["reed", 1.18, 14],
      ["reed", 1.08, 141],
      ["reed", 0.92, 247],
      ["sorrel", 0.85, 44],
      ["sorrel", 1, 176],
      ["sorrel", 0.92, 291],
      ["sorrel", 0.8, 97],
    ]);
    const authored = [
      ...northernHabitat.replacements,
      ...northernHabitat.additions,
    ];
    const reeds = authored.filter((row) => row.model === "reed");
    expect(reeds).toHaveLength(12);
    const westIsland = reeds.filter((row) => row.bearing === 249);
    const northIsland = reeds.filter((row) => row.bearing === 272);
    expect([westIsland.length, northIsland.length]).toEqual([7, 5]);
    for (const island of [westIsland, northIsland]) {
      // At least one metre of near-to-far layering replaces the picket row;
      // retain an intentionally uneven spacing, not a second concentric band.
      expect(
        Math.max(...island.map((row) => row.bankOffset)) -
          Math.min(...island.map((row) => row.bankOffset)),
      ).toBeGreaterThan(0.95);
      expect(new Set(island.map((row) => row.bankOffset)).size).toBe(
        island.length,
      );
    }

    await DataManager.getInstance().initialize();
    const areas = DataManager.getInstance().getAllWorldAreas();
    const original = areas.haven_pond.flatZones!.find(
      (zone) => zone.radialPond,
    )!;
    const bank: FlatZone = {
      ...original,
      height: original.height!,
      radialPond: {
        ...original.radialPond!,
        bankSectors: [
          {
            bearing: (-133 * Math.PI) / 180,
            halfWidth: (30 * Math.PI) / 180,
            innerRadius: 6.3,
            innerHeight: 27.95,
            outerRadius: 7.6,
            outerHeight: 28.64,
          },
          {
            bearing: (-27 * Math.PI) / 180,
            halfWidth: (24 * Math.PI) / 180,
            innerRadius: 6.55,
            innerHeight: 28.08,
          },
          {
            bearing: 0.7,
            halfWidth: 0.55,
            innerRadius: 6.4,
            innerHeight: 27.86,
          },
          {
            bearing: (-96 * Math.PI) / 180,
            halfWidth: (44 * Math.PI) / 180,
            innerRadius: 6.9,
            innerHeight: 27.86,
            outerRadius: 8.85,
            outerHeight: 28.22,
          },
        ],
      },
    };
    const profile = validateWorldTerrainProfile({
      ...DataManager.getWorldConfig()!.terrainProfile,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    const height = (x: number, z: number) =>
      resolveRadialPondTerrainHeight(bank, x, z, () => 28.08) ?? 28.08;
    const pond = areas.haven_pond.waterBodies![0];
    const rows = createCompactPondDressing(
      profile,
      { ...areas, haven_pond: { ...areas.haven_pond, flatZones: [bank] } },
      height,
    );
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      const radius = COMPACT_POND_MODELS[row.model].radius * row.scale;
      expect(row.z + radius).toBeLessThan(pond.centerZ);
      if (row.model !== "stone" && row.model !== "boulder")
        expect(height(row.x, row.z)).toBeGreaterThan(pond.surfaceY);
    }
    const selectedReeds = rows.filter(
      (row, index) => row.model === "reed" && (index < 24 || index >= 32),
    );
    expect(selectedReeds).toHaveLength(12);
    for (const row of selectedReeds) {
      const angle =
        ((Math.atan2(row.z - pond.centerZ, row.x - pond.centerX) * 180) /
          Math.PI +
          360) %
        360;
      expect(angle).toBeGreaterThan(240);
      expect(angle).toBeLessThan(280);
    }
    // Actual shared radial-height placement only. Parent native fixture owns
    // retained triangles, full roots, PhysX, routes and final visual acceptance.
  });

  it("pins the additive sorrel source, roots and source material ownership without admitting it into historical layouts", () => {
    const bytes = readFileSync(
      new URL(
        "../../../../../../server/world/assets/vegetation/compact-pond-v1/pond_sorrel.glb",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "2f887028b517ad2e6ea3c75665dc4790c59a0ae66ea41ff6185e5b5375777d22",
    );
    expect(northernHabitat.sorrel.sourceSha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(northernHabitat.sorrel).toMatchObject({
      file: "pond_sorrel.glb",
      radius: 0.539,
      triangles: 1629,
      license: "CC0-1.0",
      source: "https://polyhaven.com/a/shrub_sorrel_01",
    });
    const geometry = canonicalGeometry("sorrel");
    const map = new THREE.DataTexture(
      new Uint8Array([120, 150, 70, 255]),
      1,
      1,
    );
    const material = new THREE.MeshStandardNodeMaterial({
      map,
      normalMap: map,
      aoMap: map,
      roughnessMap: map,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    const historical = new CompactPondDressingVisuals(
      new THREE.Group(),
      placements(),
    );
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [
      { ...placements()[2], id: "sorrel", model: "sorrel" },
    ]);
    let borrowedDisposals = 0;
    [geometry, map, material].forEach((resource) =>
      resource.addEventListener("dispose", () => borrowedDisposals++),
    );
    try {
      expect(
        historical.getReceipt().assets.map((asset) => asset.model),
      ).toEqual(models);
      expect(() =>
        historical.install("sorrel", new THREE.Mesh(geometry, material)),
      ).toThrow("no admitted placements");
      expect(historical.group.children).toHaveLength(0);
      owner.install("sorrel", new THREE.Mesh(geometry, material));
      const receipt = owner
        .getReceipt()
        .assets.find((asset) => asset.model === "sorrel")!;
      expect(receipt.support.mode).toBe("root-slice");
      expect(receipt.support.selectedVertices).toBe(129);
      const root = receipt.support.bounds!,
        full = receipt.support.fullGeometryBounds!;
      expect(root.max[1]).toBeLessThanOrEqual(full.min[1] + 0.05);
      expect(root.max[0] - root.min[0]).toBeLessThan(0.3);
      expect(root.max[2] - root.min[2]).toBeLessThan(0.3);
      expect(full.max[0] - full.min[0]).toBeGreaterThan(1);
      const mesh = owner.group.children[0] as THREE.InstancedMesh;
      const cloned = mesh.material as THREE.MeshStandardNodeMaterial;
      expect(mesh.geometry).toBe(geometry);
      expect(cloned).not.toBe(material);
      for (const key of ["map", "normalMap", "aoMap", "roughnessMap"] as const)
        expect(cloned[key]).toBe(map);
      expect(cloned.alphaTest).toBe(0.5);
      expect(cloned.side).toBe(THREE.DoubleSide);
      expect(mesh.castShadow).toBe(false);
      owner.destroy();
      expect(borrowedDisposals).toBe(0);
    } finally {
      historical.destroy();
      owner.destroy();
      geometry.dispose();
      material.dispose();
      map.dispose();
    }
  });

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
        (x, z) => terrain.getResourceGroundHeight(x, z),
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
      expect(combined).toHaveLength(56);
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
          instances: 56,
          visible: 56,
        });
        const bush = owner.group.children[
          models.indexOf("bush")
        ] as THREE.InstancedMesh;
        expect(bush.count).toBe(23);
        expect(
          (owner.group.children[models.indexOf("fern")] as THREE.InstancedMesh)
            .count,
        ).toBe(12);
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
          (x, z) => terrain.getResourceGroundHeight(x, z),
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
            expect(terrain.getResourceGroundHeight(x, z)).toBeLessThan(
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
        expect(palette.colorNode).toHaveProperty("isNode", true);
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
