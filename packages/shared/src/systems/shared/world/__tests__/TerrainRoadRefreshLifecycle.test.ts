import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import THREE from "../../../../extras/three/three";
import { EventType } from "../../../../types/events";
import type { TerrainTile } from "../../../../types/world/terrain";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainSystem } from "../TerrainSystem";
import { TerrainQuadNode } from "../TerrainQuadTree";
import { TerrainVisualManager } from "../TerrainVisualManager";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import type { GrassWorkerSetup } from "../GrassVisualManager";

type TerrainInternals = {
  terrainTiles: Map<string, TerrainTile>;
  quadTreeVisualManager: TerrainVisualManager | null;
  runtimeIsServer: boolean;
  terrainContainer: THREE.Group;
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  subscribeRoadNetworkEvents(): void;
  generateTile(x: number, z: number, content: boolean): TerrainTile;
  unloadTile(tile: TerrainTile): void;
  refreshRoadInfluence(): Promise<void>;
  buildChunkTerrainProvider(): FullTerrainProvider;
  buildGrassWorkerSetup(): GrassWorkerSetup;
};
type ManagerInternals = {
  addMeshToScene(
    node: TerrainQuadNode,
    key: string,
    result: { geometry: THREE.BufferGeometry; heightData: Float32Array },
  ): void;
};
type Kind = "tiles" | "chunks";
const ownedWorlds = new Set<World>();
afterEach(() => {
  for (const world of ownedWorlds) world.destroy();
  ownedWorlds.clear();
});

/** Actual engine systems and generated terrain, with no renderer or timer mocks. */
async function fixture(kind: Kind) {
  const world = new World();
  ownedWorlds.add(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  const internal = terrain as unknown as TerrainInternals;
  await terrain.init();
  internal.loadWaterBodiesFromManifest();
  internal.loadFlatZonesFromManifest();
  await roads.init();
  await roads.start();
  expect(roads.getRoadInfluenceAt(348, 321)).toBe(1);
  internal.subscribeRoadNetworkEvents();

  const tiles: TerrainTile[] = [];
  const meshes: THREE.Mesh[] = [];
  let manager: TerrainVisualManager | null = null;
  const container = new THREE.Group();
  internal.terrainContainer = container;
  const material = new THREE.MeshStandardNodeMaterial();
  const nodes: TerrainQuadNode[] = [];
  const provider = internal.buildChunkTerrainProvider();
  const profile = terrain.getWorldTerrainProfile();
  const resolution = 16;
  const size = profile.terrainTileSize;
  const pending: Promise<void>[] = [];
  const detachedGeometry: THREE.BufferGeometry[] = [];

  function addChunk(node: TerrainQuadNode, key: string): THREE.Mesh {
    const result = assembleQuadChunkGeometry(
      generateQuadChunkDataSync(
        node.centerX,
        node.centerZ,
        size,
        resolution,
        provider,
      ),
      provider,
      manager!.getQuadTree().config.skirtDrop,
    );
    (manager! as unknown as ManagerInternals).addMeshToScene(node, key, result);
    return manager!.getChunks().get(key)!.mesh;
  }
  if (kind === "tiles") {
    // Exercise the actual client-attribute geometry branch in this CPU test.
    // Keep runtimeIsClient false: no renderer, client systems or network are faked.
    internal.runtimeIsServer = false;
    // Four real tiles precede the on-road fifth tile. The production batch
    // boundary must yield even when those first four have no road segments.
    for (const [x, z] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 3],
    ]) {
      const tile = internal.generateTile(x, z, false);
      tiles.push(tile);
      meshes.push(tile.mesh);
      container.add(tile.mesh);
    }
  } else {
    const setup = internal.buildGrassWorkerSetup();
    manager = new TerrainVisualManager(
      { minSize: size, maxDepth: 1, resolution, rootChunkRadius: 0 },
      provider,
      container,
      material,
      createTerrainWorkerConfig(profile, resolution),
      profile.seed,
      setup.biomeCenters,
      setup.biomes,
    );
    internal.quadTreeVisualManager = manager;
    for (let i = 0; i < 5; i++) {
      const node = new TerrainQuadNode(
        manager.getQuadTree(),
        null,
        null,
        size,
        150 + i * size,
        350,
        manager.getQuadTree().config.maxDepth,
        9200 + i,
      );
      nodes.push(node);
      meshes.push(addChunk(node, `road-lifecycle-${i}`));
    }
    expect(internal.terrainTiles.size).toBe(0);
  }
  for (const mesh of meshes) {
    const attribute = mesh.geometry.getAttribute("roadInfluence");
    expect(attribute).toBeInstanceOf(THREE.BufferAttribute);
    (attribute.array as Float32Array).fill(-1);
  }
  const last = meshes[4];
  const lastGeometry = last.geometry;
  const attribute = lastGeometry.getAttribute(
    "roadInfluence",
  ) as THREE.BufferAttribute;
  const version = attribute.version;
  let disposals = 0;
  lastGeometry.addEventListener("dispose", () => {
    disposals++;
  });
  const begin = () => {
    const refresh = internal.refreshRoadInfluence();
    pending.push(refresh);
    // Async entry executes the first four entries synchronously, then suspends
    // on its real setTimeout. The fifth geometry cannot have been touched yet.
    expect(attribute.version).toBe(version);
    expect(Array.from(attribute.array).every((value) => value === -1)).toBe(
      true,
    );
    return refresh;
  };
  return {
    world,
    terrain,
    internal,
    manager,
    meshes,
    attribute,
    version,
    begin,
    disposals: () => disposals,
    replaceEntry() {
      if (kind === "tiles") {
        internal.unloadTile(tiles[4]);
        const replacement = internal.generateTile(3, 3, false).mesh;
        container.add(replacement);
        return replacement;
      }
      const oldNode = nodes[4];
      const key = oldNode.visualChunkKey!;
      manager!.onNodeDestroyGeometry(oldNode);
      const node = new TerrainQuadNode(
        manager!.getQuadTree(),
        null,
        null,
        size,
        oldNode.centerX,
        oldNode.centerZ,
        oldNode.depth,
        oldNode.id + 100,
      );
      return addChunk(node, key);
    },
    replaceGeometry() {
      last.geometry = lastGeometry.clone();
      lastGeometry.dispose();
      return last;
    },
    detach() {
      last.removeFromParent();
      detachedGeometry.push(lastGeometry);
    },
    async close() {
      terrain.destroy();
      await Promise.all(pending);
      world.destroy();
      ownedWorlds.delete(world);
      for (const geometry of detachedGeometry) geometry.dispose();
      material.dispose();
    },
  };
}

describe("real yielding terrain road refresh ownership", () => {
  it.each<Kind>(["tiles", "chunks"])(
    "stops a suspended %s refresh after destroy and rejects new refresh entry",
    async (kind) => {
      const f = await fixture(kind);
      try {
        const older = f.begin();
        f.terrain.destroy();
        expect(f.disposals()).toBeGreaterThan(0);
        await older;
        await f.internal.refreshRoadInfluence();
        expect(f.attribute.version).toBe(f.version);
        expect(
          Array.from(f.attribute.array).every((value) => value === -1),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it.each<Kind>(["tiles", "chunks"])(
    "lets only the latest yielding %s refresh reach the fifth geometry",
    async (kind) => {
      const f = await fixture(kind);
      try {
        const older = f.begin();
        const newer = f.begin();
        await Promise.all([older, newer]);
        expect(f.attribute.version).toBe(f.version + 1);
        expect(
          Array.from(f.attribute.array).every(
            (value) => value >= 0 && value <= 1,
          ),
        ).toBe(true);
        if (kind === "tiles")
          expect(Math.max(...f.attribute.array)).toBeGreaterThan(0);
      } finally {
        await f.close();
      }
    },
  );

  for (const operation of ["replaceEntry", "replaceGeometry"] as const) {
    it.each<Kind>(["tiles", "chunks"])(
      `skips replaced snapshot ownership (${operation}, %s) without writing either old or new geometry`,
      async (kind) => {
        const f = await fixture(kind);
        try {
          const older = f.begin();
          const replacement = f[operation]();
          const replacementAttribute = replacement.geometry.getAttribute(
            "roadInfluence",
          ) as THREE.BufferAttribute;
          const replacementVersion = replacementAttribute.version;
          const replacementValues = Array.from(replacementAttribute.array);
          await older;
          expect(f.disposals()).toBeGreaterThan(0);
          expect(f.attribute.version).toBe(f.version);
          expect(
            Array.from(f.attribute.array).every((value) => value === -1),
          ).toBe(true);
          expect(replacementAttribute.version).toBe(replacementVersion);
          expect(Array.from(replacementAttribute.array)).toEqual(
            replacementValues,
          );
        } finally {
          await f.close();
        }
      },
    );
  }

  it.each<Kind>(["tiles", "chunks"])(
    "does not mutate detached %s geometry still present in its owning map",
    async (kind) => {
      const f = await fixture(kind);
      try {
        const older = f.begin();
        f.detach();
        await older;
        expect(f.attribute.version).toBe(f.version);
        expect(
          Array.from(f.attribute.array).every((value) => value === -1),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it("refreshes five actual quad meshes on ROADS_GENERATED without legacy terrain tiles", async () => {
    const f = await fixture("chunks");
    try {
      f.world.emit(EventType.ROADS_GENERATED, {
        roadCount: (f.world.getSystem("roads") as RoadNetworkSystem).getRoads()
          .length,
        townCount: 0,
        poiCount: 0,
        explorationRoadCount: 0,
      });
      const first = f.meshes[0].geometry.getAttribute(
        "roadInfluence",
      ) as THREE.BufferAttribute;
      expect(first.version).toBeGreaterThan(0);
      expect(f.attribute.version).toBe(f.version);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(f.attribute.version).toBe(f.version + 1);
      expect(
        Array.from(f.attribute.array).every(
          (value) => value >= 0 && value <= 1,
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
});
