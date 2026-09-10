import { describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import THREE from "../../../extras/three/three";
import { TerrainSystem } from "./TerrainSystem";
import { TerrainQuadTree } from "./TerrainQuadTree";
import type { WaterBodyRegistry } from "./WaterBodyRegistry";
import { WaterVisualManager } from "./WaterVisualManager";
import { WaterSystem } from "./WaterSystem";
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

describe("WaterVisualManager explicit compact water ownership", () => {
  it("uses one ocean material across dry-centered coastal and ocean-centered leaves", async () => {
    const { terrain, water, internals, tree, close } =
      await createActualWorld();
    const container = new THREE.Group();
    const profile = terrain.getWorldTerrainProfile();
    const manager = new WaterVisualManager(
      container,
      water,
      (x, z) => terrain.getHeightAtComputed(x, z),
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
        terrain.getHeightAtComputed(coastal.centerX, coastal.centerZ),
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

  it.each([undefined, LEGACY_TERRAIN_PROFILE_FIXTURE])(
    "preserves center-mask classification for a noncompact or unprofiled caller (%s)",
    async (profile) => {
      const { terrain, water, internals, tree, close } =
        await createActualWorld();
      const container = new THREE.Group();
      const manager = new WaterVisualManager(
        container,
        water,
        (x, z) => terrain.getHeightAtComputed(x, z),
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

  it("keeps the real authored pond lake material, exact circle and height through ocean churn", async () => {
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
      (x, z) => terrain.getHeightAtComputed(x, z),
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
      const meshes = [
        ...container.children,
      ] as THREE.Mesh<THREE.CircleGeometry>[];
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
        expect(mesh.geometry.parameters.radius).toBe(body.radius);
        expect(mesh.geometry.parameters.segments).toBe(
          Math.max(32, Math.min(96, Math.ceil(body.radius * 6))),
        );
        expect(mesh.layers.mask).toBe(2);
        expect(mesh.userData).toMatchObject({
          waterType: "lake",
          elevated: true,
          walkable: false,
        });
        const positions = mesh.geometry.getAttribute("position");
        const shores = mesh.geometry.getAttribute("shoreDistance");
        expect(shores.count).toBe(positions.count);
        expect(shores.getX(0)).toBe(body.radius);
        for (let index = 1; index < positions.count; index++) {
          expect(
            Math.hypot(positions.getX(index), positions.getZ(index)),
          ).toBeCloseTo(body.radius, 5);
          expect(positions.getY(index)).toBeCloseTo(0, 10);
          expect(shores.getX(index)).toBeCloseTo(0, 5);
        }
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
            (x, z) => terrain.getHeightAtComputed(x, z),
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
