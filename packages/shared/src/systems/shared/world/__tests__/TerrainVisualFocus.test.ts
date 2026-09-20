import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import THREE from "../../../../extras/three/three";
import { PlayerEntity } from "../../../../entities/player/PlayerEntity";
import { PlayerLocal } from "../../../../entities/player/PlayerLocal";
import { ClientCameraSystem } from "../../../client/ClientCameraSystem";
import { TerrainSystem } from "../TerrainSystem";
import { TerrainQuadTree } from "../TerrainQuadTree";
import { TerrainVisualManager } from "../TerrainVisualManager";
import { WaterSystem } from "../WaterSystem";
import { WaterVisualManager } from "../WaterVisualManager";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  LEGACY_TERRAIN_PROFILE_FIXTURE,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";
import {
  COMPACT_TERRAIN_CAMERA_MARGIN,
  getCompactSingleRootCoverage,
  prioritizeLocalTerrainCenter,
  resolveTerrainVisualRootRadius,
} from "../TerrainVisualFocus";

const worlds: World[] = [];
beforeAll(async () => {
  await DataManager.getInstance().initialize();
});
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
function world() {
  const value = new World();
  worlds.push(value);
  return value;
}
function translated(dx: number, dz: number): WorldTerrainProfile {
  const p = COMPACT_WORLD_TERRAIN_PROFILE;
  return {
    ...p,
    bounds: {
      minX: p.bounds.minX + dx,
      maxX: p.bounds.maxX + dx,
      minZ: p.bounds.minZ + dz,
      maxZ: p.bounds.maxZ + dz,
    },
    island: {
      ...p.island,
      centerX: p.island.centerX + dx,
      centerZ: p.island.centerZ + dz,
    },
  };
}

describe("normal compact terrain focus (real CPU owners, not walking/native proof)", () => {
  it("admits the entire current authored island plus a conservative normal-camera margin", () => {
    const profile = DataManager.getWorldTerrainProfile();
    const proof = getCompactSingleRootCoverage(profile, 100, 4)!;
    expect(proof).not.toBeNull();
    expect(proof.rootBounds).toEqual({
      minX: -800,
      maxX: 800,
      minZ: -800,
      maxZ: 800,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.rootBounds)).toBe(true);
    const camera = new ClientCameraSystem(world());
    expect(COMPACT_TERRAIN_CAMERA_MARGIN).toBe(20);
    expect(
      camera["settings"].maxDistance + camera["settings"].shoulderOffsetMax,
    ).toBeLessThan(COMPACT_TERRAIN_CAMERA_MARGIN);
    const extent =
      profile.island.radius * (1 + profile.island.maxCoastVariation) +
      profile.island.deepOceanBuffer;
    expect(extent).toBeCloseTo(199.8, 10);
    expect(profile.island.centerZ + extent).toBeLessThanOrEqual(
      profile.bounds.maxZ,
    );
    expect(resolveTerrainVisualRootRadius(profile, 100, 4, false)).toBe(0);
  });

  it.each([
    [0, 0],
    [1600, 1600],
    [-1600, -1600],
    [1600, -1600],
  ])(
    "retains one real root for all authored envelope corners and camera orbits at translation %s,%s",
    (dx, dz) => {
      const profile = translated(dx, dz),
        proof = getCompactSingleRootCoverage(profile, 100, 4)!;
      expect(proof).not.toBeNull();
      const tree = new TerrainQuadTree({
        minSize: 100,
        maxDepth: 4,
        splitRatio: 0,
        rootChunkRadius: resolveTerrainVisualRootRadius(profile, 100, 4, false),
      });
      const { bounds } = profile;
      let firstId: number | undefined;
      for (const x of [
        bounds.minX,
        (bounds.minX + bounds.maxX) / 2,
        bounds.maxX,
      ]) {
        for (const z of [
          bounds.minZ,
          (bounds.minZ + bounds.maxZ) / 2,
          bounds.maxZ,
        ]) {
          tree.update(x, z);
          const roots = tree.getFinalNodes();
          expect(roots).toHaveLength(1);
          firstId ??= roots[0].id;
          expect(roots[0].id).toBe(firstId);
          for (let i = 0; i < 16; i++) {
            const a = (i * Math.PI) / 8;
            const cameraX = x + Math.cos(a) * COMPACT_TERRAIN_CAMERA_MARGIN;
            const cameraZ = z + Math.sin(a) * COMPACT_TERRAIN_CAMERA_MARGIN;
            expect(cameraX).toBeGreaterThan(roots[0].boundingBox.xMin);
            expect(cameraX).toBeLessThan(roots[0].boundingBox.xMax);
            expect(cameraZ).toBeGreaterThan(roots[0].boundingBox.zMin);
            expect(cameraZ).toBeLessThan(roots[0].boundingBox.zMax);
          }
        }
      }
      // No focus clamp or movement restriction: the actual tree can leave this root.
      tree.update(proof.centerX + proof.rootSize, proof.centerZ);
      expect(tree.getFinalNodes()).toHaveLength(1);
      expect(tree.getFinalNodes()[0].id).not.toBe(firstId);
    },
  );

  it("preserves radius1 for large, wide and root-straddling normal profiles", () => {
    for (const profile of [
      LEGACY_TERRAIN_PROFILE_FIXTURE,
      translated(400, 0),
      translated(0, -1000),
      {
        ...COMPACT_WORLD_TERRAIN_PROFILE,
        bounds: { minX: -800, maxX: 800, minZ: -800, maxZ: 800 },
      },
    ]) {
      expect(getCompactSingleRootCoverage(profile, 100, 4)).toBeNull();
      const radius = resolveTerrainVisualRootRadius(profile, 100, 4, false);
      expect(radius).toBe(1);
      const tree = new TerrainQuadTree({
        minSize: 100,
        maxDepth: 4,
        splitRatio: 0,
        rootChunkRadius: radius,
      });
      tree.update(profile.island.centerX, profile.island.centerZ);
      expect(tree.getFinalNodes()).toHaveLength(9);
      // This slice does not alter the existing explicit broadcast policy.
      expect(resolveTerrainVisualRootRadius(profile, 100, 4, true)).toBe(0);
    }
  });

  it("rejects camera-margin equality, missing island containment and invalid topology", () => {
    const p = COMPACT_WORLD_TERRAIN_PROFILE;
    for (const profile of [
      { ...p, bounds: { ...p.bounds, maxX: 780 } },
      { ...p, bounds: { ...p.bounds, minX: -780 } },
      { ...p, island: { ...p.island, radius: 700 } },
      { ...p, island: { ...p.island, maxCoastVariation: Number.NaN } },
      { ...p, bounds: { ...p.bounds, minX: Number.NEGATIVE_INFINITY } },
    ])
      expect(getCompactSingleRootCoverage(profile, 100, 4)).toBeNull();
    for (const [minSize, depth] of [
      [0, 4],
      [-1, 4],
      [100, -1],
      [100, 4.5],
      [100, 21],
      [Number.NaN, 4],
    ])
      expect(resolveTerrainVisualRootRadius(p, minSize, depth, false)).toBe(1);
  });

  it("uses the real local owner before remotely inserted players without losing their content centers", () => {
    const w = world(),
      terrain = w.register("terrain", TerrainSystem) as TerrainSystem;
    // Select the client branch for this CPU-only lifecycle test; no socket or browser impersonation.
    terrain["runtimeIsClient"] = true;
    const remote = new PlayerEntity(w, {
      id: "remote-first",
      type: "player",
      position: [2000, 30, 2000],
    });
    const other = new PlayerEntity(w, {
      id: "remote-second",
      type: "player",
      position: [10, 30, 10],
    });
    const local = new PlayerLocal(
      w,
      { id: "local", position: [350, 30, 400] },
      true,
    );
    w.entities.set(remote.id, remote);
    w.entities.set(other.id, other);
    w.entities.set(local.id, local);
    w.entities.player = w.entities.getPlayer(local.id)!;
    expect(w.getPlayers().map((p) => p.id)).toEqual([
      remote.id,
      other.id,
      local.id,
    ]);
    expect(w.getPlayer()).toBe(local);
    const centers = terrain["getTerrainCenters"]();
    expect(centers.map((c) => c.id)).toEqual([local.id, remote.id, other.id]);
    expect(centers[0].position).toBe(local.node.position);
    expect(centers[1].position).toBe(remote.node.position);
    expect(w.getPlayers().map((p) => p.id)).toEqual([
      remote.id,
      other.id,
      local.id,
    ]);
    local.node.position.set(500, 30, 590);
    expect(terrain["getTerrainCenters"]()[0].position).toBe(
      local.node.position,
    );
    // On a server, existing order/filter behavior is unchanged even if a local slot exists.
    terrain["runtimeIsClient"] = false;
    expect(terrain["getTerrainCenters"]().map((c) => c.id)).toEqual([
      remote.id,
      other.id,
      local.id,
    ]);
  });

  it("handles local arrival before the players-map entry, duplicate identity and invalid local position", () => {
    const remote = { id: "remote", position: new THREE.Vector3(1, 2, 3) };
    const local = { id: "local", position: new THREE.Vector3(4, 5, 6) };
    const centers = [remote];
    prioritizeLocalTerrainCenter(centers, local);
    prioritizeLocalTerrainCenter(centers, local);
    expect(centers).toEqual([local, remote]);
    const original = [...centers];
    prioritizeLocalTerrainCenter(centers, null);
    prioritizeLocalTerrainCenter(centers, {
      id: "invalid",
      position: new THREE.Vector3(Number.NaN, 0, 0),
    });
    expect(centers).toEqual(original);
  });

  it("activates only supported single-root conforming ownership with unchanged normal terrain resolution", async () => {
    const w = world(),
      terrain = w.register("terrain", TerrainSystem) as TerrainSystem;
    await terrain.init();
    const profile = terrain.getWorldTerrainProfile(),
      setup = terrain["buildGrassWorkerSetup"]();
    const water = new WaterSystem(w);
    await water.init();
    const material = new THREE.MeshBasicMaterial();
    const make = (radius: number) => {
      const visual = new TerrainVisualManager(
        {
          minSize: terrain["CONFIG"].QUADTREE_MIN_SIZE,
          maxDepth: terrain["CONFIG"].QUADTREE_MAX_DEPTH,
          resolution: terrain["CONFIG"].QUADTREE_RESOLUTION,
          rootChunkRadius: radius,
        },
        terrain["buildChunkTerrainProvider"](),
        new THREE.Group(),
        material,
        setup.terrainConfig,
        setup.seed,
        setup.biomeCenters,
        setup.biomes,
      );
      const owner = new WaterVisualManager(
        new THREE.Group(),
        water,
        (x, z) => terrain.getHeightAt(x, z),
        (x, z) => terrain["getIslandMask"](x, z),
        profile.water.threshold,
        [],
        profile,
        visual,
      );
      return { visual, owner };
    };
    const radius = resolveTerrainVisualRootRadius(
      profile,
      terrain["CONFIG"].QUADTREE_MIN_SIZE,
      terrain["CONFIG"].QUADTREE_MAX_DEPTH,
      false,
    );
    const compact = make(radius),
      multi = make(1);
    try {
      expect(compact.visual.getQuadTree().config.resolution).toBe(64);
      expect(compact.owner.getConformingReadiness()).toMatchObject({
        required: true,
        ready: false,
      });
      expect(multi.owner.getConformingReadiness()).toMatchObject({
        required: false,
      });
      const source = readFileSync(
        new URL("../TerrainSystem.ts", import.meta.url),
        "utf8",
      );
      expect(source).toMatch(
        /rootChunkRadius: resolveTerrainVisualRootRadius\(\s*this\.getWorldTerrainProfile\(\),\s*this\.CONFIG\.QUADTREE_MIN_SIZE,\s*this\.CONFIG\.QUADTREE_MAX_DEPTH,\s*isStreamingViewport,?\s*\)/,
      );
    } finally {
      compact.owner.destroy();
      multi.owner.destroy();
      compact.visual.dispose();
      multi.visual.dispose();
      material.dispose();
      water.destroy();
    }
  });
});
