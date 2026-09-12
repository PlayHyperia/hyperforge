import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { RetainedGridFixture } from "./terrain-grid.fixture";
import THREE from "../../../../extras/three/three";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import { BiomeType } from "../TerrainBiomeTypes";
import {
  GrassVisualManager,
  type GrassWorkerSetup,
} from "../GrassVisualManager";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import { TerrainQuadNode, TerrainQuadTree } from "../TerrainQuadTree";
import { TERRAIN_SHADER_CONSTANTS } from "../TerrainShader";
import { TerrainVisualManager } from "../TerrainVisualManager";
import { GrassBladeGroundingJob } from "../GrassBladeGrounding";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import {
  COMPACT_WORLD_TERRAIN_PROFILE as compact,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

const changed = validateWorldTerrainProfile({
  ...compact,
  seed: compact.seed + 1,
});
const identity = worldTerrainProfileIdentity(compact);

/** Analytic input field, with unchanged production generators/geometry/managers. */
class ProfileTerrain implements FullTerrainProvider {
  readonly terrainProfileIdentity: string;
  readonly TILE_SIZE: number;
  readonly MAX_HEIGHT: number;
  readonly WATER_LEVEL_NORMALIZED: number;
  readonly SHORELINE_THRESHOLD: number;
  readonly SHORELINE_STRENGTH: number;
  heightSamples = 0;
  gradingSamples = 0;
  roadSamples = 0;

  constructor(profile: WorldTerrainProfile) {
    const config = createTerrainWorkerConfig(profile, 4);
    this.terrainProfileIdentity = config.TERRAIN_PROFILE_IDENTITY;
    this.TILE_SIZE = config.TILE_SIZE;
    this.MAX_HEIGHT = config.MAX_HEIGHT;
    this.WATER_LEVEL_NORMALIZED = config.WATER_LEVEL_NORMALIZED;
    this.SHORELINE_THRESHOLD = config.SHORELINE_THRESHOLD;
    this.SHORELINE_STRENGTH = config.SHORELINE_STRENGTH;
  }
  getHeightAtComputed(x: number, z: number): number {
    this.heightSamples++;
    return 22 + x * 0.01 + z * 0.02;
  }
  getFlatZoneHeight(): number | null {
    this.gradingSamples++;
    return null;
  }
  calculateRoadInfluenceAtVertex(): number {
    this.roadSamples++;
    return 0;
  }
  computeBiomeWeightsAtPosition() {
    return { biomeWeightMap: new Map([[BiomeType.Forest, 1]]), totalWeight: 1 };
  }
  computeBiomeWeightsByPosition() {
    return { [BiomeType.Forest]: 1 };
  }
  getBiomeId(): number {
    return 1;
  }
  getBiomeColor() {
    return { r: 0.2, g: 0.4, b: 0.1 };
  }
}

function terrainManager(
  provider: ProfileTerrain,
  container: THREE.Group,
  material: THREE.Material,
  config = createTerrainWorkerConfig(compact, 4),
) {
  return new TerrainVisualManager(
    { minSize: 16, maxDepth: 1, resolution: 4, rootChunkRadius: 0 },
    provider,
    container,
    material,
    config,
    compact.seed,
    [],
    {},
  );
}

function leaf(tree: TerrainQuadTree, id = 7001) {
  return new TerrainQuadNode(
    tree,
    null,
    null,
    16,
    350,
    400,
    tree.config.maxDepth,
    id,
  );
}

function grassSetup(profile: WorldTerrainProfile): GrassWorkerSetup {
  const settings = {
    density: 100,
    maxSlope: 1,
    minGrassWeight: 0,
    heightScale: 1,
    patchiness: -1,
    patchScale: 0.1,
    tintR: 0,
    tintG: 0,
    tintB: 0,
    tintStrength: 0,
  };
  return {
    terrainConfig: createTerrainWorkerConfig(profile, 4),
    seed: profile.seed,
    biomeCenters: [{ x: 350, z: 400, type: BiomeType.Forest, influence: 1000 }],
    biomes: {
      forest: { heightModifier: 1, color: { r: 0.2, g: 0.4, b: 0.1 } },
    },
    grassConfigs: { forest: settings, tundra: settings, canyon: settings },
    tileSize: profile.terrainTileSize,
    getRoadSegmentsForRegion: () => [],
    getTerrainSurfaceForRegion: () => ({
      schemaVersion: 1,
      zones: [],
      arenaFloorIds: [],
      arenaGradeHeight: null,
      waterBodies: [],
    }),
  };
}

const retainedFixtures: RetainedGridFixture[] = [];
afterEach(() => {
  for (const fixture of retainedFixtures.splice(0)) fixture.dispose();
});

function grassManager(
  container: THREE.Group,
  setup: GrassWorkerSetup | undefined = grassSetup(compact),
  terrainIdentity = identity,
  waterThreshold = compact.water.threshold,
) {
  const grid = new RetainedGridFixture(terrainIdentity, () => 25);
  retainedFixtures.push(grid);
  return new GrassVisualManager(
    terrainIdentity,
    container,
    grid.get,
    () => 25,
    waterThreshold,
    () => 0,
    () => false,
    () => ({
      r: 0.2,
      g: 0.4,
      b: 0.1,
      grassWeight: 1,
      grassPlacement: 1,
      grassHeightScale: 1,
      tintR: 0,
      tintG: 0,
      tintB: 0,
      tintStrength: 0,
      nx: 0,
      ny: 1,
      nz: 0,
    }),
    setup,
  );
}

/** Real worker source and transferred buffers; only the message transport is adapted to Node. */
async function grassData(
  profile: WorldTerrainProfile,
  key: string,
  empty = false,
): Promise<GrassWorkerOutput> {
  const setup = grassSetup(profile);
  const input: GrassWorkerInput = {
    type: "generateGrassInstances",
    chunkKey: key,
    centerX: 350,
    centerZ: 400,
    size: 16,
    spacingMul: 1,
    config: setup.terrainConfig,
    seed: profile.seed,
    biomeCenters: setup.biomeCenters,
    biomes: setup.biomes,
    grassSeed: 7,
    clumpSpacing: 1,
    scaleMin: 1,
    scaleMax: 1,
    waterThreshold: profile.water.threshold,
    grassConfigs: setup.grassConfigs,
    shaderConstants: TERRAIN_SHADER_CONSTANTS,
    roadSegments: [],
    roadBlendWidth: 0,
    tileSize: profile.terrainTileSize,
    terrainSurface: {
      schemaVersion: 1,
      zones: empty
        ? [
            {
              id: "excluded-test-pad",
              centerX: 350,
              centerZ: 400,
              width: 100,
              depth: 100,
              height: 30,
              blendRadius: 0,
            },
          ]
        : [],
      arenaFloorIds: [],
      arenaGradeHeight: null,
      waterBodies: [],
    },
  };
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
    ${GRASS_WORKER_CODE}
    parentPort.on("message", data => self.onmessage({ data }));
  `,
    { eval: true, env: {} },
  );
  try {
    return await new Promise<GrassWorkerOutput>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Actual grass worker timed out")),
        5000,
      );
      const onError = (error: Error) => finish(error);
      const onMessage = (message: {
        result?: GrassWorkerOutput;
        error?: string;
      }) => {
        if (message.error || !message.result)
          finish(new Error(message.error ?? "Missing grass result"));
        else finish(null, message.result);
      };
      function finish(error: Error | null, result?: GrassWorkerOutput) {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        if (error) reject(error);
        else resolve(result!);
      }
      worker.once("message", onMessage);
      worker.once("error", onError);
      worker.postMessage(input);
    });
  } finally {
    await worker.terminate();
  }
}

describe("terrain visual profile admission with real geometry and workers", () => {
  it("tags sync output and rejects a different profile before querying or assembling the target terrain", () => {
    const target = new ProfileTerrain(compact);
    const stale = generateQuadChunkDataSync(
      350,
      400,
      16,
      4,
      new ProfileTerrain(changed),
    );
    expect(stale.terrainProfileIdentity).toBe(
      worldTerrainProfileIdentity(changed),
    );
    expect(() => assembleQuadChunkGeometry(stale, target, 3)).toThrow(
      /profile identity mismatch/,
    );
    expect([
      target.heightSamples,
      target.gradingSamples,
      target.roadSamples,
    ]).toEqual([0, 0, 0]);
    const current = generateQuadChunkDataSync(350, 400, 16, 4, target);
    expect(current.terrainProfileIdentity).toBe(identity);
    const result = assembleQuadChunkGeometry(current, target, 3);
    try {
      expect(result.geometry.getAttribute("position").count).toBe(32);
      expect(result.heightData).toBe(current.heightData);
    } finally {
      result.geometry.dispose();
    }
  });

  it("rejects missing identity before any sync height sampling", () => {
    const target = new ProfileTerrain(compact);
    Object.assign(target, { terrainProfileIdentity: "" });
    expect(() => generateQuadChunkDataSync(350, 400, 16, 4, target)).toThrow(
      /identity is required/,
    );
    expect(target.heightSamples).toBe(0);
  });

  it("rejects contradictory terrain constructor contracts without touching borrowed scene/material ownership", () => {
    const container = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    let disposed = false;
    material.addEventListener("dispose", () => {
      disposed = true;
    });
    try {
      expect(() =>
        terrainManager(new ProfileTerrain(changed), container, material),
      ).toThrow(/provider\/worker profile identity mismatch/);
      const config = createTerrainWorkerConfig(compact, 4);
      expect(() =>
        terrainManager(new ProfileTerrain(compact), container, material, {
          ...config,
          TERRAIN_PROFILE_IDENTITY: worldTerrainProfileIdentity(changed),
        }),
      ).toThrow(/identity or seed mismatch/);
      expect(() =>
        terrainManager(new ProfileTerrain(compact), container, material, {
          ...config,
          MAX_HEIGHT: config.MAX_HEIGHT + 1,
        }),
      ).toThrow(/derived config mismatch/);
      const invalidProvider = new ProfileTerrain(compact);
      Object.assign(invalidProvider, {
        TILE_SIZE: invalidProvider.TILE_SIZE + 1,
      });
      expect(() =>
        terrainManager(invalidProvider, container, material),
      ).toThrow(/provider\/worker derived config mismatch/);
      expect(container.children).toHaveLength(0);
      expect(disposed).toBe(false);
    } finally {
      material.dispose();
    }
  });

  it("never attaches stale terrain output and retains normal success/disposal for current output", () => {
    const container = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    const provider = new ProfileTerrain(compact);
    const manager = terrainManager(provider, container, material);
    const node = leaf(manager.getQuadTree());
    let geometryDisposed = false;
    try {
      const stale = generateQuadChunkDataSync(
        350,
        400,
        16,
        4,
        new ProfileTerrain(changed),
      );
      manager["assembleAndAddChunk"](node, stale);
      expect(manager.getChunks().size).toBe(0);
      expect(container.children).toHaveLength(0);
      expect(node.visualChunkKey).toBeNull();
      const current = generateQuadChunkDataSync(350, 400, 16, 4, provider);
      manager["assembleAndAddChunk"](node, current);
      expect(manager.getChunks().size).toBe(1);
      const mesh = [...manager.getChunks().values()][0].mesh;
      expect(mesh.parent).toBe(container);
      mesh.geometry.addEventListener("dispose", () => {
        geometryDisposed = true;
      });
    } finally {
      manager.dispose();
      material.dispose();
    }
    expect(geometryDisposed).toBe(true);
    expect(container.children).toHaveLength(0);
  });

  it("validates grass setup identity and derived values before allocating render resources", () => {
    const container = new THREE.Group();
    expect(() => grassManager(container, grassSetup(changed))).toThrow(
      /provider\/worker profile identity mismatch/,
    );
    expect(() => grassManager(container, grassSetup(compact), "")).toThrow(
      /identity is required/,
    );
    expect(() =>
      grassManager(
        container,
        grassSetup(compact),
        identity,
        compact.water.threshold + 1,
      ),
    ).toThrow(/derived config mismatch/);
    expect(() =>
      grassManager(container, { ...grassSetup(compact), tileSize: 1 }),
    ).toThrow(/derived config mismatch/);
    const wrongConfig = grassSetup(compact);
    wrongConfig.terrainConfig = {
      ...wrongConfig.terrainConfig,
      TERRAIN_PROFILE_IDENTITY: worldTerrainProfileIdentity(changed),
    };
    expect(() => grassManager(container, wrongConfig)).toThrow(
      /identity or seed mismatch/,
    );
    expect(container.children).toHaveLength(0);
  });

  it("does not count a stale actual empty worker output as ready coverage", async () => {
    const container = new THREE.Group();
    const manager = grassManager(container);
    const tree = new TerrainQuadTree({
      minSize: 16,
      maxDepth: 1,
      resolution: 4,
    });
    const node = leaf(tree);
    const key = manager["chunkKey"](node);
    try {
      manager.setPlayerPosition(350, 400);
      manager.onNodeNeedsGeometry(node);
      const stale = await grassData(changed, key, true);
      expect(stale.count).toBe(0);
      manager["settledWorkerResults"].push({
        ticket: manager["createWorkerTicket"](node, key, 0, false),
        data: stale,
      });
      expect(manager["processSettledWorkerResults"]()).toBe(0);
      expect(manager["workerInflight"].has(key)).toBe(false);
      expect(manager.getStreamingReadiness([node], 50).ready).toBe(false);
      expect(container.children).toHaveLength(0);
      const current = await grassData(compact, key, true);
      expect(current.count).toBe(0);
      manager["settledWorkerResults"].push({
        ticket: manager["createWorkerTicket"](node, key, 0, false),
        data: current,
      });
      expect(manager["processSettledWorkerResults"]()).toBe(0);
      expect(manager.getStreamingReadiness([node], 50).ready).toBe(true);
    } finally {
      manager.destroy();
      tree.dispose();
    }
  });

  it("keeps a valid grass LOD mesh alive when stale actual worker output arrives", async () => {
    const container = new THREE.Group();
    const manager = grassManager(container);
    const tree = new TerrainQuadTree({
      minSize: 16,
      maxDepth: 1,
      resolution: 4,
    });
    const node = leaf(tree);
    manager.setPlayerPosition(350, 400);
    manager.onNodeNeedsGeometry(node);
    const key = manager["chunkKey"](node);
    let geometryDisposed = false;
    try {
      const current = await grassData(compact, key);
      expect(current.count).toBeGreaterThan(0);
      manager["settledWorkerResults"].push({
        ticket: manager["createWorkerTicket"](node, key, 0, false),
        data: current,
      });
      expect(manager["processSettledWorkerResults"]()).toBe(1);
      const mesh = container.children[0] as THREE.InstancedMesh;
      expect(mesh.count).toBe(current.count);
      mesh.geometry.addEventListener("dispose", () => {
        geometryDisposed = true;
      });
      const stale = await grassData(changed, key);
      manager["settledWorkerResults"].push({
        ticket: manager["createWorkerTicket"](node, key, 1, true),
        data: stale,
      });
      expect(manager["processSettledWorkerResults"]()).toBe(0);
      expect(container.children).toEqual([mesh]);
      expect(geometryDisposed).toBe(false);
      expect(() =>
        manager["createChunkMeshFromWorkerData"](node, stale, 1, {
          schemaVersion: 1,
          surfaceRevision: "not-admitted",
          computedHeights: new Float32Array(stale.count),
          ecologicalNormals: new Float32Array(stale.count * 3),
        }),
      ).toThrow(/result profile identity mismatch/);
    } finally {
      manager.destroy();
      tree.dispose();
    }
    expect(geometryDisposed).toBe(true);
    expect(container.children).toHaveLength(0);
  });

  it("exposes only the actual retained terrain revision and retires invalidated or mutated geometry", () => {
    const container = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    const manager = terrainManager(
      new ProfileTerrain(compact),
      container,
      material,
    );
    const node = leaf(manager.getQuadTree());
    try {
      expect(manager.getRetainedSurface(node)).toBeNull();
      manager["generateChunkSync"](node);
      const first = manager.getRetainedSurface(node)!;
      expect(first).not.toBeNull();
      expect(first.revision).toBe(
        (container.children[0] as THREE.Mesh).geometry.uuid,
      );
      expect(first.nodeId).toBe(node.id);
      manager.invalidateRegion(349, 399, 351, 401);
      expect(manager.getRetainedSurface(node)).toBeNull();
      manager["generateChunkSync"](node);
      const second = manager.getRetainedSurface(node)!;
      expect(second.revision).not.toBe(first.revision);
      (container.children[0] as THREE.Mesh).geometry.getAttribute(
        "position",
      ).needsUpdate = true;
      expect(manager.getRetainedSurface(node)).toBeNull();
      manager.invalidateRegion(349, 399, 351, 401);
      manager["generateChunkSync"](node);
      const geometry = (container.children[0] as THREE.Mesh).geometry;
      expect(manager.getRetainedSurface(node)).not.toBeNull();
      geometry.setIndex(geometry.getIndex()!.clone());
      expect(manager.getRetainedSurface(node)).toBeNull();
    } finally {
      manager.dispose();
      material.dispose();
    }
  });

  it("withholds child grass contact while a retained ancestor still overlaps the child", () => {
    const container = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    const manager = terrainManager(
      new ProfileTerrain(compact),
      container,
      material,
    );
    const tree = manager.getQuadTree();
    const parent = tree.createNode(null, null, 32, 350, 400, 0);
    try {
      manager["generateChunkSync"](parent);
      parent.split();
      const children = [...parent.children.values()];
      manager["generateChunkSync"](children[0]);
      expect(manager.getRetainedSurface(children[0])).toBeNull();
      for (const child of children.slice(1))
        manager["generateChunkSync"](child);
      expect(parent.visualChunkKey).toBeNull();
      expect(manager.getRetainedSurface(children[0])).not.toBeNull();
    } finally {
      manager.dispose();
      material.dispose();
    }
  });

  it("captures exact closed region boundaries and is unaffected by unrelated terrain churn", () => {
    const material = new THREE.MeshBasicMaterial();
    const manager = terrainManager(
      new ProfileTerrain(compact),
      new THREE.Group(),
      material,
    );
    const tree = manager.getQuadTree();
    const own = tree.createNode(null, null, 16, 350, 400, 1);
    const east = tree.createNode(null, null, 16, 366, 400, 1);
    const distant = tree.createNode(null, null, 16, 500, 400, 1);
    try {
      for (const node of [own, east, distant])
        manager["generateChunkSync"](node);
      const bounds = { minX: 350, maxX: 358, minZ: 400, maxZ: 400 };
      const region = manager.captureRetainedSurfaceRegion(bounds);
      expect(region.surfaces).toEqual([
        manager.getRetainedSurface(own),
        manager.getRetainedSurface(east),
      ]);
      expect(Object.isFrozen(region)).toBe(true);
      expect(Object.isFrozen(region.bounds)).toBe(true);
      expect(Object.isFrozen(region.surfaces)).toBe(true);
      bounds.maxX = 1000;
      expect(region.bounds.maxX).toBe(358);
      expect(region.isCurrent()).toBe(true);
      manager.invalidateRegion(499, 399, 501, 401);
      expect(region.isCurrent()).toBe(true);
      manager["generateChunkSync"](distant);
      expect(region.isCurrent()).toBe(true);
      manager.invalidateRegion(365, 399, 367, 401);
      expect(region.isCurrent()).toBe(false);
      expect(manager.getRetainedSurface(own)).toBe(region.surfaces[0]);
      manager["generateChunkSync"](east);
      expect(region.isCurrent()).toBe(false);
      expect(
        manager.captureRetainedSurfaceRegion(region.bounds).isCurrent(),
      ).toBe(true);
    } finally {
      manager.dispose();
      material.dispose();
    }
  });

  it("invalidates waiting region owners when a previously missing neighbor arrives", () => {
    const material = new THREE.MeshBasicMaterial();
    const manager = terrainManager(
      new ProfileTerrain(compact),
      new THREE.Group(),
      material,
    );
    const tree = manager.getQuadTree();
    const own = tree.createNode(null, null, 16, 350, 400, 1);
    const east = tree.createNode(null, null, 16, 366, 400, 1);
    const bounds = { minX: 342, maxX: 359, minZ: 392, maxZ: 408 };
    try {
      const empty = manager.captureRetainedSurfaceRegion(bounds);
      expect(empty.surfaces).toEqual([]);
      expect(empty.isCurrent()).toBe(true);
      manager["generateChunkSync"](own);
      expect(empty.isCurrent()).toBe(false);
      const incomplete = manager.captureRetainedSurfaceRegion(bounds);
      expect(incomplete.surfaces).toHaveLength(1);
      const first = incomplete.surfaces[0];
      expect(incomplete.isCurrent()).toBe(true);
      manager["generateChunkSync"](east);
      expect(incomplete.isCurrent()).toBe(false);
      expect(manager.getRetainedSurface(own)).toBe(first);
      const complete = manager.captureRetainedSurfaceRegion(bounds);
      expect(complete.surfaces).toHaveLength(2);
      expect(complete.isCurrent()).toBe(true);
      manager.dispose();
      expect(complete.isCurrent()).toBe(false);
      expect(() => manager.captureRetainedSurfaceRegion(bounds)).toThrow(
        /disposed/,
      );
    } finally {
      manager.dispose();
      material.dispose();
    }
  });

  it.each([
    "position replacement",
    "position update",
    "index replacement",
    "index update",
  ])(
    "invalidates complete region ownership on real neighboring %s",
    (change) => {
      const material = new THREE.MeshBasicMaterial();
      const manager = terrainManager(
        new ProfileTerrain(compact),
        new THREE.Group(),
        material,
      );
      const tree = manager.getQuadTree();
      const own = tree.createNode(null, null, 16, 350, 400, 1);
      const east = tree.createNode(null, null, 16, 366, 400, 1);
      try {
        for (const node of [own, east]) manager["generateChunkSync"](node);
        const region = manager.captureRetainedSurfaceRegion({
          minX: 350,
          maxX: 359,
          minZ: 400,
          maxZ: 400,
        });
        const geometry = manager.getChunks().get(east.visualChunkKey!)!.mesh
          .geometry;
        if (change === "position replacement")
          geometry.setAttribute(
            "position",
            geometry.getAttribute("position").clone(),
          );
        else if (change === "position update")
          geometry.getAttribute("position").needsUpdate = true;
        else if (change === "index replacement")
          geometry.setIndex(geometry.getIndex()!.clone());
        else geometry.getIndex()!.needsUpdate = true;
        expect(region.isCurrent()).toBe(false);
        expect(manager.getRetainedSurface(own)).toBe(region.surfaces[0]);
      } finally {
        manager.dispose();
        material.dispose();
      }
    },
  );

  it("leases coarse final neighbors but withholds split descendants until the retained parent is removed", () => {
    const material = new THREE.MeshBasicMaterial();
    const manager = terrainManager(
      new ProfileTerrain(compact),
      new THREE.Group(),
      material,
    );
    const tree = manager.getQuadTree();
    tree.setListener(manager);
    const parent = tree.createNode(null, null, 32, 350, 400, 0);
    const bounds = { minX: 334, maxX: 366, minZ: 384, maxZ: 416 };
    try {
      manager["generateChunkSync"](parent);
      const coarse = manager.captureRetainedSurfaceRegion(bounds);
      expect(coarse.surfaces).toEqual([manager.getRetainedSurface(parent)]);
      parent.split();
      expect(coarse.isCurrent()).toBe(false);
      const transition = manager.captureRetainedSurfaceRegion(bounds);
      expect(transition.surfaces).toEqual([]);
      const children = [...parent.children.values()];
      manager["generateChunkSync"](children[0]);
      expect(transition.isCurrent()).toBe(true);
      for (const child of children.slice(1))
        manager["generateChunkSync"](child);
      expect(parent.visualChunkKey).toBeNull();
      expect(transition.isCurrent()).toBe(false);
      const fine = manager.captureRetainedSurfaceRegion(bounds);
      expect(fine.surfaces).toHaveLength(4);
      expect(fine.surfaces.map((surface) => surface.size)).toEqual([
        16, 16, 16, 16,
      ]);
      expect(fine.isCurrent()).toBe(true);
    } finally {
      manager.dispose();
      material.dispose();
    }
  });

  it("never revives a region after observing a detached mesh and does not own borrowed GPU resources", () => {
    const material = new THREE.MeshBasicMaterial();
    const container = new THREE.Group();
    const manager = terrainManager(
      new ProfileTerrain(compact),
      container,
      material,
    );
    const node = leaf(manager.getQuadTree());
    let disposals = 0;
    try {
      manager["generateChunkSync"](node);
      const mesh = manager.getChunks().get(node.visualChunkKey!)!.mesh;
      mesh.geometry.addEventListener("dispose", () => disposals++);
      const region = manager.captureRetainedSurfaceRegion({
        minX: 350,
        maxX: 350,
        minZ: 400,
        maxZ: 400,
      });
      expect(region.isCurrent()).toBe(true);
      mesh.removeFromParent();
      expect(region.isCurrent()).toBe(false);
      container.add(mesh);
      expect(region.isCurrent()).toBe(false);
      expect(disposals).toBe(0);
      manager.dispose();
      expect(disposals).toBe(1);
    } finally {
      manager.dispose();
      material.dispose();
    }
    expect(disposals).toBe(1);
  });

  it("gives a real grounding job a complete region owner across missing support, arrival and replacement", () => {
    const material = new THREE.MeshBasicMaterial();
    const manager = terrainManager(
      new ProfileTerrain(compact),
      new THREE.Group(),
      material,
    );
    const grass = grassManager(new THREE.Group());
    const tree = manager.getQuadTree();
    const own = tree.createNode(null, null, 16, 350, 400, 1);
    const east = tree.createNode(null, null, 16, 366, 400, 1);
    const bounds = { minX: 349, maxX: 360, minZ: 398, maxZ: 402 };
    try {
      manager["generateChunkSync"](own);
      const surface = manager.getRetainedSurface(own)!;
      const data = projectGrassAnchors(
        {
          count: 1,
          offsets: new Float32Array([7.99, 32, 0]),
          rotScaleHash: new Float32Array([0, 1, 0.5]),
          groundColors: new Float32Array([0.2, 0.4, 0.1]),
          grassTints: new Float32Array([0, 0, 0, 0]),
          groundNormals: new Float32Array([0, 1, 0]),
        },
        surface,
        () => 16,
        () => false,
      );
      const missing = manager.captureRetainedSurfaceRegion(bounds);
      const request = {
        data,
        ownSurface: surface,
        surfaces: missing.surfaces,
        geometry: grass["lodGeometries"][1],
        lod: 1 as const,
        terrainSurface: grassSetup(compact).getTerrainSurfaceForRegion(
          349,
          398,
          360,
          402,
        ),
        roadSegments: [],
        oceanLevel: 16,
        wind: { x: 0.1, z: 0.055 },
      };
      const waiting = new GrassBladeGroundingJob(request, missing.isCurrent);
      while (waiting.state.status === "running") waiting.advance(64);
      expect(waiting.state.status).toBe("waiting_support");
      const previousOperations = waiting.operations;
      for (let frame = 0; frame < 10; frame++) waiting.advance(64);
      expect(waiting.operations).toBe(previousOperations);
      manager["generateChunkSync"](east);
      expect(missing.isCurrent()).toBe(false);
      const complete = manager.captureRetainedSurfaceRegion(bounds);
      const fresh = new GrassBladeGroundingJob(
        { ...request, surfaces: complete.surfaces },
        complete.isCurrent,
      );
      while (fresh.state.status === "running") fresh.advance(64);
      expect(fresh.state.status).toBe("ready");
      if (fresh.state.status !== "ready")
        throw new Error("Expected real neighbor coverage");
      expect(fresh.state.result.data.count).toBe(1);
      expect(
        fresh.state.result.dependencies.map(
          ({ surface: dependency }) => dependency,
        ),
      ).toContain(manager.getRetainedSurface(east));
      expect(complete.isCurrent()).toBe(true);
      const inProgress = new GrassBladeGroundingJob(
        { ...request, surfaces: complete.surfaces },
        complete.isCurrent,
      );
      inProgress.advance(4);
      manager.invalidateRegion(365, 399, 367, 401);
      expect(inProgress.advance(4)).toEqual({
        status: "cancelled",
        reason: "invalidated",
      });
      expect(complete.isCurrent()).toBe(false);
      // A cached completed job does not grant permission to publish stale data.
      expect(fresh.state.status).toBe("ready");
      expect(manager.getRetainedSurface(own)).toBe(surface);
    } finally {
      grass.destroy();
      manager.dispose();
      material.dispose();
    }
  });

  it("rejects invalid or over-capacity regions explicitly instead of silently omitting owners", () => {
    const material = new THREE.MeshBasicMaterial();
    const manager = terrainManager(
      new ProfileTerrain(compact),
      new THREE.Group(),
      material,
    );
    const tree = manager.getQuadTree();
    const bounds = { minX: 350, maxX: 359, minZ: 400, maxZ: 400 };
    try {
      for (const x of [350, 366])
        manager["generateChunkSync"](
          tree.createNode(null, null, 16, x, 400, 1),
        );
      expect(() => manager.captureRetainedSurfaceRegion(bounds, 1)).toThrow(
        /capacity/,
      );
      expect(
        manager.captureRetainedSurfaceRegion(bounds, 2).surfaces,
      ).toHaveLength(2);
      for (const capacity of [0, -1, 1.5, 257, NaN, Infinity])
        expect(() =>
          manager.captureRetainedSurfaceRegion(bounds, capacity),
        ).toThrow(/Invalid/);
      for (const key of ["minX", "maxX", "minZ", "maxZ"])
        expect(() =>
          manager.captureRetainedSurfaceRegion({ ...bounds, [key]: NaN }),
        ).toThrow(/Invalid/);
      expect(() =>
        manager.captureRetainedSurfaceRegion({ ...bounds, minX: 360 }),
      ).toThrow(/Invalid/);
      expect(() =>
        manager.captureRetainedSurfaceRegion({ ...bounds, minZ: 401 }),
      ).toThrow(/Invalid/);
      expect(manager.getChunks().size).toBe(2);
    } finally {
      manager.dispose();
      material.dispose();
    }
  });

  it("rejects an invalid retained grid before attaching any terrain mesh or marking its node ready", () => {
    const container = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    const provider = new ProfileTerrain(compact);
    const manager = terrainManager(provider, container, material);
    const node = leaf(manager.getQuadTree());
    try {
      const data = generateQuadChunkDataSync(
        node.centerX,
        node.centerZ,
        node.size,
        node.resolution,
        provider,
      );
      data.heightData[0] = NaN;
      manager["assembleAndAddChunk"](node, data);
      expect(container.children).toHaveLength(0);
      expect(manager.getChunks().size).toBe(0);
      expect(node.visualChunkKey).toBeNull();
      expect(node.ready).toBe(false);
      expect(manager.getRetainedSurface(node)).toBeNull();
    } finally {
      manager.dispose();
      material.dispose();
    }
  });
});
