import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
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

function grassManager(
  container: THREE.Group,
  setup: GrassWorkerSetup | undefined = grassSetup(compact),
  terrainIdentity = identity,
  waterThreshold = compact.water.threshold,
) {
  return new GrassVisualManager(
    terrainIdentity,
    container,
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
        manager["createChunkMeshFromWorkerData"](node, stale, 1),
      ).toThrow(/result profile identity mismatch/);
    } finally {
      manager.destroy();
      tree.dispose();
    }
    expect(geometryDisposed).toBe(true);
    expect(container.children).toHaveLength(0);
  });
});
