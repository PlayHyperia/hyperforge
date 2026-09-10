import { describe, expect, it, vi } from "vitest";

import THREE from "../../../../extras/three/three";
import type { TerrainQuadNode } from "../TerrainQuadTree";
import type { VisualManagerTerrainProvider } from "../TerrainVisualManager";
import { TerrainVisualManager } from "../TerrainVisualManager";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";

type FakeNode = Pick<
  TerrainQuadNode,
  "id" | "centerX" | "centerZ" | "isFinal" | "visualChunkKey"
>;

function node(id: number): FakeNode {
  return {
    id,
    centerX: id * 10,
    centerZ: 0,
    isFinal: true,
    visualChunkKey: null,
  };
}

describe("TerrainVisualManager startup pacing", () => {
  it("requires every terrain leaf intersecting the critical stream radius", () => {
    const readyNode = {
      visualChunkKey: "ready",
      boundingBox: { xMin: -50, xMax: 50, zMin: -50, zMax: 50 },
    } as TerrainQuadNode;
    const pendingNode = {
      visualChunkKey: null,
      boundingBox: { xMin: 50, xMax: 150, zMin: -50, zMax: 50 },
    } as TerrainQuadNode;
    const farNode = {
      visualChunkKey: null,
      boundingBox: { xMin: 1_000, xMax: 1_100, zMin: 1_000, zMax: 1_100 },
    } as TerrainQuadNode;
    const manager = Object.create(
      TerrainVisualManager.prototype,
    ) as TerrainVisualManager & {
      playerX: number;
      playerZ: number;
      chunks: Map<string, unknown>;
      quadTree: { getFinalNodes(): TerrainQuadNode[] };
    };
    Object.assign(manager, {
      playerX: 0,
      playerZ: 0,
      chunks: new Map([["ready", {}]]),
      quadTree: { getFinalNodes: () => [readyNode, pendingNode, farNode] },
    });

    expect(manager.getStreamingReadiness(200)).toEqual({
      ready: false,
      criticalRadius: 200,
      requiredChunks: 2,
      readyChunks: 1,
      pendingChunks: 1,
    });
    pendingNode.visualChunkKey = "pending";
    manager.chunks.set("pending", {});
    expect(manager.getStreamingReadiness(200).ready).toBe(true);
  });

  it("precompiles the production quad-chunk layout and disposes its sample", async () => {
    const provider: VisualManagerTerrainProvider = {
      terrainProfileIdentity: worldTerrainProfileIdentity(
        COMPACT_WORLD_TERRAIN_PROFILE,
      ),
      calculateRoadInfluenceAtVertex: () => 0,
      getFlatZoneHeight: () => null,
      getHeightAtComputed: (x, z) => (x + z) * 0.01,
      computeBiomeWeightsAtPosition: () => ({
        biomeWeightMap: new Map([["grassland", 1]]),
        totalWeight: 1,
      }),
      computeBiomeWeightsByPosition: () => ({ grassland: 1 }),
      getBiomeId: () => 0,
      getBiomeColor: () => ({ r: 0.2, g: 0.6, b: 0.1 }),
      TILE_SIZE: 100,
      WATER_LEVEL_NORMALIZED: 0.2,
      SHORELINE_THRESHOLD: 0.1,
      SHORELINE_STRENGTH: 1,
      MAX_HEIGHT: 100,
    };
    const material = new THREE.MeshBasicMaterial();
    const manager = Object.create(
      TerrainVisualManager.prototype,
    ) as TerrainVisualManager & {
      provider: VisualManagerTerrainProvider;
      material: THREE.Material;
      debugWireframe: boolean;
      receiveShadow: boolean;
      castShadow: boolean;
      quadTree: {
        config: { minSize: number; resolution: number; skirtDrop: number };
      };
    };
    Object.assign(manager, {
      provider,
      material,
      debugWireframe: false,
      receiveShadow: true,
      castShadow: false,
      quadTree: {
        config: { minSize: 100, resolution: 4, skirtDrop: 15 },
      },
    });

    let sampleGeometry: THREE.BufferGeometry | undefined;
    const precompile = vi.fn(async (object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh;
      sampleGeometry = mesh.geometry;
      expect(mesh.material).toBe(material);
      expect(mesh.position.toArray()).toEqual([50, 0, -25]);
      expect(mesh.receiveShadow).toBe(true);
      expect(mesh.castShadow).toBe(false);
      expect(mesh.geometry.index?.array).toBeInstanceOf(Uint32Array);
      expect(Object.keys(mesh.geometry.attributes).sort()).toEqual([
        "biomeCanyonWeight",
        "biomeForestWeight",
        "biomeId",
        "color",
        "normal",
        "position",
        "riverProximity",
        "roadInfluence",
      ]);
      vi.spyOn(mesh.geometry, "dispose");
    });

    await manager.precompileRepresentativeChunk(50, -25, precompile);

    expect(precompile).toHaveBeenCalledOnce();
    expect(sampleGeometry?.dispose).toHaveBeenCalledOnce();
  });

  it("disposes the representative chunk when compilation fails", async () => {
    const manager = Object.create(
      TerrainVisualManager.prototype,
    ) as TerrainVisualManager & {
      provider: VisualManagerTerrainProvider;
      material: THREE.Material;
      debugWireframe: boolean;
      receiveShadow: boolean;
      castShadow: boolean;
      quadTree: {
        config: { minSize: number; resolution: number; skirtDrop: number };
      };
    };
    const provider = {
      terrainProfileIdentity: worldTerrainProfileIdentity(
        COMPACT_WORLD_TERRAIN_PROFILE,
      ),
      calculateRoadInfluenceAtVertex: () => 0,
      getFlatZoneHeight: () => null,
      getHeightAtComputed: () => 0,
      computeBiomeWeightsAtPosition: () => ({
        biomeWeightMap: new Map([["grassland", 1]]),
        totalWeight: 1,
      }),
      computeBiomeWeightsByPosition: () => ({ grassland: 1 }),
      getBiomeId: () => 0,
      getBiomeColor: () => ({ r: 0.2, g: 0.6, b: 0.1 }),
      TILE_SIZE: 100,
      WATER_LEVEL_NORMALIZED: 0.2,
      SHORELINE_THRESHOLD: 0.1,
      SHORELINE_STRENGTH: 1,
      MAX_HEIGHT: 100,
    } satisfies VisualManagerTerrainProvider;
    Object.assign(manager, {
      provider,
      material: new THREE.MeshBasicMaterial(),
      debugWireframe: false,
      receiveShadow: false,
      castShadow: false,
      quadTree: {
        config: { minSize: 100, resolution: 4, skirtDrop: 15 },
      },
    });

    let sampleGeometry: THREE.BufferGeometry | undefined;
    await expect(
      manager.precompileRepresentativeChunk(0, 0, async (object) => {
        sampleGeometry = (object as THREE.Mesh).geometry;
        vi.spyOn(sampleGeometry, "dispose");
        throw new Error("compile failed");
      }),
    ).rejects.toThrow("compile failed");
    expect(sampleGeometry?.dispose).toHaveBeenCalledOnce();
  });

  it("assembles only the configured number of settled worker chunks per frame", () => {
    const assembleAndAddChunk = vi.fn();
    const manager = Object.create(
      TerrainVisualManager.prototype,
    ) as TerrainVisualManager & {
      playerX: number;
      playerZ: number;
      maxAssembliesPerFrame: number;
      settledResults: Array<{
        nodeId: number;
        node: FakeNode;
        result: object;
        error: null;
      }>;
      cancelledNodeIds: Set<number>;
      assembleAndAddChunk: typeof assembleAndAddChunk;
      processSettledResults(): void;
    };
    manager.playerX = 0;
    manager.playerZ = 0;
    manager.maxAssembliesPerFrame = 2;
    manager.cancelledNodeIds = new Set();
    manager.assembleAndAddChunk = assembleAndAddChunk;
    manager.settledResults = Array.from({ length: 20 }, (_, index) => ({
      nodeId: index + 1,
      node: node(index + 1),
      result: {},
      error: null,
    }));

    manager.processSettledResults();

    expect(assembleAndAddChunk).toHaveBeenCalledTimes(2);
    expect(manager.settledResults).toHaveLength(18);
  });

  it("generates only the configured number of sync fallback chunks per frame", () => {
    const generateChunkSync = vi.fn();
    const manager = Object.create(
      TerrainVisualManager.prototype,
    ) as TerrainVisualManager & {
      playerX: number;
      playerZ: number;
      maxSyncChunksPerFrame: number;
      syncQueue: FakeNode[];
      generateChunkSync: typeof generateChunkSync;
      processSyncQueue(): void;
    };
    manager.playerX = 0;
    manager.playerZ = 0;
    manager.maxSyncChunksPerFrame = 1;
    manager.generateChunkSync = generateChunkSync;
    manager.syncQueue = Array.from({ length: 20 }, (_, index) =>
      node(index + 1),
    );

    manager.processSyncQueue();

    expect(generateChunkSync).toHaveBeenCalledOnce();
    expect(manager.syncQueue).toHaveLength(19);
  });

  it("waits for workers before activating bounded synchronous bootstrap", () => {
    const syncBootstrapNearbyChunks = vi.fn();
    const manager = Object.create(
      TerrainVisualManager.prototype,
    ) as TerrainVisualManager & {
      playerX: number;
      playerZ: number;
      framesSinceInit: number;
      syncBootstrapped: boolean;
      chunks: Map<string, unknown>;
      pendingNodeIds: Set<number>;
      quadTree: { update(): boolean };
      syncBootstrapNearbyChunks: typeof syncBootstrapNearbyChunks;
      processSettledResults(): void;
      processSyncQueue(): void;
    };
    manager.playerX = 0;
    manager.playerZ = 0;
    manager.framesSinceInit = 119;
    manager.syncBootstrapped = false;
    manager.chunks = new Map();
    manager.pendingNodeIds = new Set([1]);
    manager.quadTree = { update: () => false };
    manager.syncBootstrapNearbyChunks = syncBootstrapNearbyChunks;
    manager.processSettledResults = vi.fn();
    manager.processSyncQueue = vi.fn();

    manager.update(0, 0);
    expect(syncBootstrapNearbyChunks).not.toHaveBeenCalled();

    manager.update(0, 0);
    expect(syncBootstrapNearbyChunks).toHaveBeenCalledOnce();
  });

  it("queues bootstrap candidates instead of synchronously generating all of them", () => {
    const generateChunkSync = vi.fn();
    const nodes = Array.from({ length: 40 }, (_, index) => node(index + 1));
    const manager = Object.create(
      TerrainVisualManager.prototype,
    ) as TerrainVisualManager & {
      playerX: number;
      playerZ: number;
      syncBootstrapped: boolean;
      syncQueue: FakeNode[];
      pendingNodeIds: Set<number>;
      cancelledNodeIds: Set<number>;
      quadTree: { getFinalNodes(): FakeNode[] };
      generateChunkSync: typeof generateChunkSync;
      syncBootstrapNearbyChunks(): void;
    };
    manager.playerX = 0;
    manager.playerZ = 0;
    manager.syncBootstrapped = false;
    manager.syncQueue = [];
    manager.pendingNodeIds = new Set(nodes.map((entry) => entry.id));
    manager.cancelledNodeIds = new Set();
    manager.quadTree = { getFinalNodes: () => nodes };
    manager.generateChunkSync = generateChunkSync;

    manager.syncBootstrapNearbyChunks();

    expect(generateChunkSync).not.toHaveBeenCalled();
    expect(manager.syncQueue).toHaveLength(30);
    expect(manager.cancelledNodeIds).toHaveLength(30);
    expect(manager.pendingNodeIds).toHaveLength(40);
  });
});
