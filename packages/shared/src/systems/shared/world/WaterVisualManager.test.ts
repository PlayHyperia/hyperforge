import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { FlatZone } from "../../../types/world/terrain";
import type { ElevatedWaterBody } from "./WaterBodyRegistry";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import THREE from "../../../extras/three/three";
import { TerrainSystem } from "./TerrainSystem";
import { TerrainQuadTree } from "./TerrainQuadTree";
import type { WaterBodyRegistry } from "./WaterBodyRegistry";
import {
  COMPACT_ELEVATED_WATER,
  WaterVisualManager,
} from "./WaterVisualManager";
import { WaterSystem, createQuietPondUniform } from "./WaterSystem";
import NodeFrame from "three/src/nodes/core/NodeFrame.js";
import { LEGACY_TERRAIN_PROFILE_FIXTURE } from "./WorldTerrainProfile";

type TerrainInternals = {
  waterBodyRegistry: WaterBodyRegistry;
  getIslandMask(x: number, z: number): number;
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
};

async function createActualWorld() {
  await DataManager.getInstance().initialize();
  const world = new World();
  const terrain = new TerrainSystem(world);
  const water = new WaterSystem(world);
  const internals = terrain as unknown as TerrainInternals;
  await terrain.init();
  internals.loadWaterBodiesFromManifest();
  internals.loadFlatZonesFromManifest();
  // Real TSL material construction and procedural texture fallback in Node;
  // no renderer or browser network transport is replaced by a test double.
  await water.init();
  const tree = new TerrainQuadTree({
    minSize: terrain.getWorldTerrainProfile().terrainTileSize,
    maxDepth: 4,
  });
  return {
    terrain,
    water,
    internals,
    tree,
    close() {
      water.destroy();
      terrain.destroy();
    },
  };
}

/** Independent brute-force oracle over actual emitted boundary edges. */
function checkPondGeometry(geometry: THREE.BufferGeometry, radius: number) {
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const distances = geometry.getAttribute("shoreDistance");
  const index = geometry.getIndex()!;
  const edges = new Map<string, { a: number; b: number; count: number }>();
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i),
      b = index.getX(i + 1),
      c = index.getX(i + 2);
    expect(
      (positions.getZ(b) - positions.getZ(a)) *
        (positions.getX(c) - positions.getX(a)) -
        (positions.getX(b) - positions.getX(a)) *
          (positions.getZ(c) - positions.getZ(a)),
    ).toBeGreaterThan(0);
    for (const [a, b] of [
      [index.getX(i), index.getX(i + 1)],
      [index.getX(i + 1), index.getX(i + 2)],
      [index.getX(i + 2), index.getX(i)],
    ]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  }
  const boundary = [...edges.values()].filter((edge) => edge.count === 1);
  expect(boundary.length).toBeGreaterThan(0);
  expect([...edges.values()].every((edge) => edge.count <= 2)).toBe(true);
  for (const { a, b } of boundary) {
    expect(distances.getX(a)).toBe(0);
    expect(distances.getX(b)).toBe(0);
  }
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i),
      z = positions.getZ(i);
    expect(x * x + z * z).toBeLessThanOrEqual(radius * radius);
    expect(positions.getY(i)).toBe(0);
    expect([normals.getX(i), normals.getY(i), normals.getZ(i)]).toEqual([
      0, 1, 0,
    ]);
    expect(uv.getX(i)).toBeCloseTo(0.5 + x / (2 * radius), 6);
    expect(uv.getY(i)).toBeCloseTo(0.5 - z / (2 * radius), 6);
    let nearest = Infinity;
    for (const { a, b } of boundary) {
      const ax = positions.getX(a),
        az = positions.getZ(a);
      const dx = positions.getX(b) - ax,
        dz = positions.getZ(b) - az;
      const t = Math.max(
        0,
        Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)),
      );
      nearest = Math.min(nearest, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
    expect(distances.getX(i)).toBeCloseTo(nearest, 5);
  }
  expect(geometry.boundingBox!.isEmpty()).toBe(false);
  expect(Number.isFinite(geometry.boundingSphere!.radius)).toBe(true);
  const receipt = geometry.userData.elevatedWater;
  expect(receipt.id).toBe(COMPACT_ELEVATED_WATER.id);
  expect(receipt.spacing).toBe(0.5);
  expect(receipt.heightQueries).toBeLessThanOrEqual(
    COMPACT_ELEVATED_WATER.maxHeightQueries,
  );
  expect(index.count / 3).toBeLessThanOrEqual(
    COMPACT_ELEVATED_WATER.maxTriangles,
  );
  expect(receipt.shoreSegments).toBe(boundary.length);
  return receipt;
}

describe("WaterVisualManager explicit compact water ownership", () => {
  it("updates quiet-pond foam per object, never per frame or shared lake state", () => {
    const control = createQuietPondUniform();
    const frame = new NodeFrame();
    const pond = new THREE.Mesh(),
      lake = new THREE.Mesh();
    pond.userData.compactQuietPond = true;
    expect(control.getUpdateType()).toBe("object");
    for (const [object, expected] of [
      [pond, 1],
      [lake, 0],
      [pond, 1],
      [lake, 0],
    ] as const) {
      frame.object = object;
      frame.updateNode(control);
      expect(control.value).toBe(expected);
    }
  });
  it("uses one ocean material across dry-centered coastal and ocean-centered leaves", async () => {
    const { terrain, water, internals, tree, close } =
      await createActualWorld();
    const container = new THREE.Group();
    const profile = terrain.getWorldTerrainProfile();
    const manager = new WaterVisualManager(
      container,
      water,
      (x, z) => terrain["getHeightAtComputed"](x, z),
      (x, z) => internals.getIslandMask(x, z),
      profile.water.threshold,
      [],
      profile,
    );
    try {
      const coastal = tree.createNode(
        null,
        null,
        profile.terrainTileSize,
        450,
        350,
        4,
      );
      const ocean = tree.createNode(
        null,
        null,
        profile.terrainTileSize,
        550,
        350,
        4,
      );
      // This is the actual ambiguous coastal leaf, not a constant mask fixture.
      expect(
        internals.getIslandMask(coastal.centerX, coastal.centerZ),
      ).toBeGreaterThan(0.3);
      expect(
        terrain["getHeightAtComputed"](coastal.centerX, coastal.centerZ),
      ).toBeGreaterThan(profile.water.threshold);
      expect(
        internals.getIslandMask(ocean.centerX, ocean.centerZ),
      ).toBeLessThan(0.3);
      manager.onNodeNeedsGeometry(coastal);
      manager.onNodeNeedsGeometry(ocean);
      manager.onNodeNeedsGeometry(coastal);
      expect(container.children).toHaveLength(2);
      expect(water.waterMeshCount).toBe(2);
      for (const child of container.children) {
        const mesh = child as THREE.Mesh<THREE.PlaneGeometry>;
        expect(mesh.material).toBe(water.getMaterial("ocean"));
        expect(mesh.userData.waterType).toBe("ocean");
        expect(mesh.position.y).toBe(profile.water.threshold);
        expect(mesh.geometry.parameters).toEqual({
          width: profile.terrainTileSize,
          height: profile.terrainTileSize,
          widthSegments: 16,
          heightSegments: 16,
        });
        expect(mesh.geometry.getAttribute("position").count).toBe(17 * 17);
        expect(
          Array.from(mesh.geometry.getAttribute("shoreDistance").array).every(
            (value) => value === 50,
          ),
        ).toBe(true);
      }
      const dry = tree.createNode(
        null,
        null,
        profile.terrainTileSize,
        350,
        350,
        4,
      );
      manager.onNodeNeedsGeometry(dry);
      expect(container.children).toHaveLength(2);
      const coastalMesh = container.children[0] as THREE.Mesh;
      let disposed = 0;
      coastalMesh.geometry.addEventListener("dispose", () => disposed++);
      manager.onNodeDestroyGeometry(coastal);
      manager.onNodeDestroyGeometry(coastal);
      expect(disposed).toBe(1);
      expect(water.waterMeshCount).toBe(1);
    } finally {
      manager.destroy();
      expect(water.waterMeshCount).toBe(0);
      close();
    }
  });

  it("keeps all admitted compact freshwater basins quiet without allocating another material", async () => {
    const { terrain, water, internals, close } = await createActualWorld();
    const authored = internals.waterBodyRegistry.getAllBodies()[0];
    const managers: WaterVisualManager[] = [];
    try {
      for (const [radius, profile, expected] of [
        [7.5, undefined, false],
        [12, terrain.getWorldTerrainProfile(), true],
        [12.01, terrain.getWorldTerrainProfile(), true],
      ] as const) {
        const container = new THREE.Group();
        managers.push(
          new WaterVisualManager(
            container,
            water,
            (x, z) => terrain["getHeightAtComputed"](x, z),
            (x, z) => internals.getIslandMask(x, z),
            terrain.getWorldTerrainProfile().water.threshold,
            [{ ...authored, radius, radiusSq: radius * radius }],
            profile,
          ),
        );
        expect(container.children).toHaveLength(1);
        const mesh = container.children[0] as THREE.Mesh;
        expect(mesh.userData.compactQuietPond).toBe(expected);
        expect(mesh.material).toBe(water.getMaterial("lake"));
        if (!profile) {
          expect(mesh.geometry).toBeInstanceOf(THREE.CircleGeometry);
          expect(
            (mesh.geometry as THREE.CircleGeometry).parameters.radius,
          ).toBe(radius);
        }
      }
    } finally {
      for (const manager of managers) manager.destroy();
      close();
    }
  });

  it.each([undefined, LEGACY_TERRAIN_PROFILE_FIXTURE])(
    "preserves center-mask classification for a noncompact or unprofiled caller (%s)",
    async (profile) => {
      const { terrain, water, internals, tree, close } =
        await createActualWorld();
      const container = new THREE.Group();
      const manager = new WaterVisualManager(
        container,
        water,
        (x, z) => terrain["getHeightAtComputed"](x, z),
        (x, z) => internals.getIslandMask(x, z),
        terrain.getWorldTerrainProfile().water.threshold,
        [],
        profile,
      );
      try {
        // Same real samples isolate the preserved classification branch; this
        // does not select the historical fixture as a playable runtime world.
        manager.onNodeNeedsGeometry(
          tree.createNode(null, null, 100, 450, 350, 4),
        );
        manager.onNodeNeedsGeometry(
          tree.createNode(null, null, 100, 550, 350, 4),
        );
        expect(container.children).toHaveLength(2);
        const [coastal, ocean] = container.children as THREE.Mesh[];
        expect(coastal.material).toBe(water.getMaterial("lake"));
        expect(coastal.userData.waterType).toBe("lake");
        expect(ocean.material).toBe(water.getMaterial("ocean"));
      } finally {
        manager.destroy();
        close();
      }
    },
  );

  it("keeps the actual canonical basin, real lake material and height through ocean churn", async () => {
    const { terrain, water, internals, tree, close } =
      await createActualWorld();
    const parent = new THREE.Group();
    const container = new THREE.Group();
    parent.add(container);
    const bodies = internals.waterBodyRegistry.getAllBodies();
    const authored = Object.values(ALL_WORLD_AREAS).flatMap(
      (area) => area.waterBodies ?? [],
    );
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies).toHaveLength(authored.length);
    const profile = terrain.getWorldTerrainProfile();
    const manager = new WaterVisualManager(
      container,
      water,
      (x, z) => terrain["getHeightAtComputed"](x, z),
      (x, z) => internals.getIslandMask(x, z),
      profile.water.threshold,
      bodies,
      profile,
    );
    let disposed = 0;
    let materialDisposals = 0;
    water
      .getMaterial("lake")!
      .addEventListener("dispose", () => materialDisposals++);
    try {
      const meshes = [...container.children] as THREE.Mesh[];
      for (const body of authored) {
        const mesh = meshes.find(
          (row) => row.userData.waterBodyId === body.id,
        )!;
        expect(mesh).toBeDefined();
        expect(mesh.material).toBe(water.getMaterial("lake"));
        expect(mesh.position.toArray()).toEqual([
          body.centerX,
          body.surfaceY,
          body.centerZ,
        ]);
        expect(mesh.geometry).not.toBeInstanceOf(THREE.CircleGeometry);
        const receipt = checkPondGeometry(mesh.geometry, body.radius);
        console.info("canonical-pond-water", JSON.stringify(receipt));
        expect(mesh.layers.mask).toBe(2);
        expect(mesh.userData).toMatchObject({
          waterType: "lake",
          elevated: true,
          walkable: false,
          compactQuietPond: true,
        });
        const positions = mesh.geometry.getAttribute("position");
        const shores = mesh.geometry.getAttribute("shoreDistance");
        expect(shores.count).toBe(positions.count);
        expect(Array.from(shores.array).some((value) => value > 0)).toBe(true);
        expect(Math.max(...Array.from(shores.array))).toBeLessThan(body.radius);
        mesh.geometry.addEventListener("dispose", () => disposed++);
      }
      const coast = tree.createNode(
        null,
        null,
        profile.terrainTileSize,
        450,
        350,
        4,
      );
      manager.onNodeNeedsGeometry(coast);
      expect(water.waterMeshCount).toBe(bodies.length + 1);
      manager.onNodeDestroyGeometry(coast);
      expect(container.children).toEqual(meshes);
      expect(disposed).toBe(0);
      manager.destroy();
      manager.destroy();
      expect(disposed).toBe(bodies.length);
      expect(materialDisposals).toBe(0);
      expect(water.waterMeshCount).toBe(0);
      expect(container.children).toHaveLength(0);
      expect(container.parent).toBeNull();
    } finally {
      manager.destroy();
      close();
    }
    expect(materialDisposals).toBe(1);
  });

  it.each([40, 27.8])(
    "retains an actual authored dry island and disconnected pool at dry height %s, including exact contour grid vertices/edges",
    async (dryHeight) => {
      const { terrain, water, internals, close } = await createActualWorld();
      const container = new THREE.Group();
      const centerX = 350,
        centerZ = 350,
        radius = 10;
      // Real terrain grades: a wet tile-mask ring, a dry island, and a separate
      // eastern pool split by a dry strip. No terrain sampler is replaced.
      terrain.registerFlatZone({
        id: "water-test-dry-frame",
        centerX,
        centerZ,
        width: 24,
        depth: 24,
        height: dryHeight,
        blendRadius: 0,
      });
      const tiles: { x: number; z: number }[] = [];
      for (let z = -5; z < 5; z++)
        for (let x = -5; x < 5; x++) {
          if ((x >= -1 && x < 1 && z >= -1 && z < 1) || x === 2) continue;
          tiles.push({ x: centerX + x, z: centerZ + z });
        }
      terrain.registerFlatZone({
        id: "water-test-concave-basin",
        centerX,
        centerZ,
        width: 100,
        depth: 100,
        height: 26,
        blendRadius: 0,
        tileMask: new Set(tiles.map(({ x, z }) => `${x},${z}`)),
        tileMaskTiles: tiles,
        tileMaskBounds: {
          minX: centerX - 5,
          maxX: centerX + 4,
          minZ: centerZ - 5,
          maxZ: centerZ + 4,
        },
      });
      let queries = 0;
      const manager = new WaterVisualManager(
        container,
        water,
        (x, z) => {
          queries++;
          return terrain.getResourceGroundHeight(x, z);
        },
        (x, z) => internals.getIslandMask(x, z),
        terrain.getWorldTerrainProfile().water.threshold,
        [
          {
            id: "water-test-components",
            sourceType: "explicit",
            centerX,
            centerZ,
            radius,
            radiusSq: radius * radius,
            surfaceY: 27.8,
          },
        ],
        terrain.getWorldTerrainProfile(),
      );
      try {
        const mesh = container.children[0] as THREE.Mesh;
        checkPondGeometry(mesh.geometry, radius);
        mesh.updateMatrixWorld(true);
        const ray = new THREE.Raycaster();
        ray.layers.set(1);
        const hits = (x: number, z: number) => {
          ray.set(
            new THREE.Vector3(centerX + x, 50, centerZ + z),
            new THREE.Vector3(0, -1, 0),
          );
          return ray.intersectObject(mesh).length;
        };
        for (const [x, z] of [
          [0.25, 0.25],
          [2.25, 0],
          [6, 0],
        ]) {
          expect(
            terrain.getResourceGroundHeight(centerX + x, centerZ + z),
          ).toBe(dryHeight);
          expect(hits(x, z)).toBe(0);
        }
        for (const [x, z] of [
          [-3.25, 0.25],
          [3.75, 0.25],
        ]) {
          expect(
            terrain.getResourceGroundHeight(centerX + x, centerZ + z),
          ).toBe(26);
          expect(hits(x, z)).toBeGreaterThan(0);
        }
        const positions = mesh.geometry.getAttribute("position"),
          distances = mesh.geometry.getAttribute("shoreDistance");
        const besideIsland = Array.from(
          { length: positions.count },
          (_, i) => i,
        ).find((i) => positions.getX(i) === -1.5 && positions.getZ(i) === 0)!;
        expect(besideIsland).toBeDefined();
        expect(distances.getX(besideIsland)).toBeLessThanOrEqual(0.5);
        if (dryHeight === 27.8) {
          // x=2.5 is the actual sampled contour, not the strip's interior:
          // ray/triangle boundary hits there are legitimate zero-width contact.
          const edgeVertex = Array.from(
            { length: positions.count },
            (_, i) => i,
          ).find((i) => positions.getX(i) === 2.5 && positions.getZ(i) === 0)!;
          expect(edgeVertex).toBeDefined();
          expect(distances.getX(edgeVertex)).toBe(0);
          expect(hits(2.5, 0)).toBeGreaterThan(0);
          // Every crossing reuses an exact dry lattice endpoint, not a second
          // coincident interpolation vertex. Boundary edges include flat shelves.
          const unique = new Set<string>();
          for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i),
              z = positions.getZ(i);
            expect(Number.isInteger(x * 2) && Number.isInteger(z * 2)).toBe(
              true,
            );
            unique.add(`${x},${z}`);
          }
          expect(unique.size).toBe(positions.count);
        }
        const initialQueries = queries;
        manager.update();
        manager.update();
        expect(queries).toBe(initialQueries);
        expect(water.waterMeshCount).toBe(1);
      } finally {
        manager.destroy();
        close();
      }
    },
  );

  it("uses the fixed half-metre lattice at the maximum admitted radius with real canonical ground", async () => {
    const { terrain, water, internals, close } = await createActualWorld();
    const container = new THREE.Group();
    const centerX = 410,
      centerZ = 415;
    terrain.registerFlatZone({
      id: "water-test-large-dry-frame",
      centerX,
      centerZ,
      width: 80,
      depth: 80,
      height: 40,
      blendRadius: 0,
    });
    terrain.registerFlatZone({
      id: "water-test-large-basin",
      centerX,
      centerZ,
      width: 68,
      depth: 68,
      height: 26.6,
      blendRadius: 2,
      radialPond: {
        bedRadius: 20,
        bankInnerRadius: 27,
        bankOuterRadius: 30,
        bankHeight: 28.08,
        shorelineAmplitude: 0.9,
      },
    });
    const manager = new WaterVisualManager(
      container,
      water,
      (x, z) => terrain.getResourceGroundHeight(x, z),
      (x, z) => internals.getIslandMask(x, z),
      terrain.getWorldTerrainProfile().water.threshold,
      [
        {
          id: "water-test-large",
          sourceType: "explicit",
          centerX,
          centerZ,
          radius: 32,
          radiusSq: 1024,
          surfaceY: 27.8,
        },
      ],
      terrain.getWorldTerrainProfile(),
    );
    try {
      const mesh = container.children[0] as THREE.Mesh;
      // Full independent edge-distance oracle is covered on the smaller cases;
      // this is a real authored-capacity fixture, not a promoted world basin.
      const receipt = mesh.geometry.userData.elevatedWater;
      expect(receipt.spacing).toBe(0.5);
      expect(receipt.heightQueries).toBeLessThanOrEqual(16_641);
      expect(receipt.heightQueries).toBeGreaterThan(13_000);
      expect(receipt.triangles).toBeLessThanOrEqual(65_536);
      expect(receipt.vertices).toBeGreaterThan(5_000);
      expect(mesh.userData.compactQuietPond).toBe(true);
      expect(container.children).toHaveLength(1);
      expect(mesh.material).toBe(water.getMaterial("lake"));
      console.info("large-canonical-pond-water", JSON.stringify(receipt));
    } finally {
      manager.destroy();
      close();
    }
  });

  it("uses the separate canonical sampler only for elevated compact geometry, preserving ocean sampling", async () => {
    const { terrain, water, internals, tree, close } =
      await createActualWorld();
    const container = new THREE.Group();
    let oceanQueries = 0,
      basinQueries = 0;
    const profile = terrain.getWorldTerrainProfile();
    const manager = new WaterVisualManager(
      container,
      water,
      (x, z) => {
        oceanQueries++;
        return terrain.getHeightAt(x, z);
      },
      (x, z) => internals.getIslandMask(x, z),
      profile.water.threshold,
      internals.waterBodyRegistry.getAllBodies(),
      profile,
      undefined,
      (x, z) => {
        basinQueries++;
        return terrain.getResourceGroundHeight(x, z);
      },
    );
    try {
      expect(oceanQueries).toBe(0);
      expect(basinQueries).toBeGreaterThan(0);
      const initialBasinQueries = basinQueries;
      manager.onNodeNeedsGeometry(
        tree.createNode(null, null, profile.terrainTileSize, 450, 350, 4),
      );
      expect(oceanQueries).toBeGreaterThan(0);
      expect(basinQueries).toBe(initialBasinQueries);
    } finally {
      manager.destroy();
      close();
    }
  });

  it("measures the explicit candidate basin through actual canonical terrain without promoting its manifest", async () => {
    const candidatePath =
      process.env.HYPERIA_WATER_BASIN_CANDIDATE ??
      new URL(
        "./__fixtures__/inland-pond-basin-candidate.json",
        import.meta.url,
      );
    const candidateSource = readFileSync(candidatePath, "utf8");
    const candidateSha256 = createHash("sha256")
      .update(candidateSource)
      .digest("hex");
    const candidate = JSON.parse(candidateSource) as {
      flatZone: FlatZone;
      waterBody: Omit<ElevatedWaterBody, "radiusSq" | "sourceType">;
    };
    const { terrain, water, internals, close } = await createActualWorld();
    const container = new THREE.Group();
    let manager: WaterVisualManager | undefined;
    try {
      terrain.unregisterFlatZone("haven_pond_floor");
      terrain.registerFlatZone(candidate.flatZone);
      const body: ElevatedWaterBody = {
        ...candidate.waterBody,
        sourceType: "explicit",
        radiusSq: candidate.waterBody.radius ** 2,
      };
      manager = new WaterVisualManager(
        container,
        water,
        (x, z) => terrain.getResourceGroundHeight(x, z),
        (x, z) => internals.getIslandMask(x, z),
        terrain.getWorldTerrainProfile().water.threshold,
        [body],
        terrain.getWorldTerrainProfile(),
      );
      const mesh = container.children[0] as THREE.Mesh;
      const receipt = checkPondGeometry(mesh.geometry, body.radius);
      expect(mesh.userData.compactQuietPond).toBe(true);
      expect(water.waterMeshCount).toBe(1);
      console.info(
        "explicit-candidate-pond-water",
        JSON.stringify({
          ...receipt,
          candidateSha256,
          candidateSourceUnchanged:
            readFileSync(candidatePath, "utf8") === candidateSource,
          centerX: body.centerX,
          centerZ: body.centerZ,
          surfaceY: body.surfaceY,
        }),
      );
      expect(readFileSync(candidatePath, "utf8")).toBe(candidateSource);
    } finally {
      manager?.destroy();
      close();
    }
  });

  it.each([
    "second-radius",
    "wet-envelope",
    "all-dry",
    "nonfinite-body",
    "scene-event",
  ])(
    "atomically rolls back only owned elevated meshes on %s failure",
    async (failure) => {
      const { terrain, water, internals, close } = await createActualWorld();
      const parent = new THREE.Group(),
        container = new THREE.Group(),
        existing = new THREE.Group();
      parent.add(container);
      container.add(existing);
      const body = internals.waterBodyRegistry.getAllBodies()[0];
      const disposed: number[] = [];
      let materialDisposals = 0;
      water
        .getMaterial("lake")!
        .addEventListener("dispose", () => materialDisposals++);
      container.addEventListener("childadded", (event) => {
        const mesh = event.child as THREE.Mesh;
        const index = disposed.length;
        disposed.push(0);
        mesh.geometry.addEventListener("dispose", () => disposed[index]++);
        if (failure === "scene-event")
          throw new Error("actual-scene-event-rejection");
      });
      const invalid =
        failure === "wet-envelope"
          ? { ...body, id: "rejected", radius: 1, radiusSq: 1 }
          : failure === "all-dry"
            ? { ...body, id: "rejected", surfaceY: -100 }
            : failure === "nonfinite-body"
              ? { ...body, id: "rejected", surfaceY: NaN }
              : {
                  ...body,
                  id: "rejected",
                  radius: 32.01,
                  radiusSq: 32.01 ** 2,
                };
      try {
        expect(
          () =>
            new WaterVisualManager(
              container,
              water,
              (x, z) => terrain.getResourceGroundHeight(x, z),
              (x, z) => internals.getIslandMask(x, z),
              terrain.getWorldTerrainProfile().water.threshold,
              [body, invalid],
              terrain.getWorldTerrainProfile(),
            ),
        ).toThrow(
          failure === "scene-event"
            ? "actual-scene-event-rejection"
            : failure === "wet-envelope"
              ? "coverage envelope"
              : failure === "all-dry"
                ? "sampled wet basin"
                : "finite radius",
        );
        expect(disposed).toEqual([1]);
        expect(container.children).toEqual([existing]);
        expect(container.parent).toBe(parent);
        expect(water.waterMeshCount).toBe(0);
        expect(materialDisposals).toBe(0);
      } finally {
        close();
      }
    },
  );

  it("rejects a conflicting profile ocean threshold before allocating or registering meshes", async () => {
    const { terrain, water, internals, close } = await createActualWorld();
    const container = new THREE.Group();
    const profile = terrain.getWorldTerrainProfile();
    try {
      expect(
        () =>
          new WaterVisualManager(
            container,
            water,
            (x, z) => terrain["getHeightAtComputed"](x, z),
            (x, z) => internals.getIslandMask(x, z),
            profile.water.threshold + 1,
            internals.waterBodyRegistry.getAllBodies(),
            profile,
          ),
      ).toThrow("Water visual threshold differs from terrain profile");
      expect(container.children).toHaveLength(0);
      expect(water.waterMeshCount).toBe(0);
    } finally {
      close();
    }
  });
});
