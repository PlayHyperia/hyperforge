import { describe, expect, it, vi } from "vitest";

import THREE from "../../../../extras/three/three";
import type { GrassWorkerOutput } from "../../../../utils/workers/GrassWorker";
import type { TerrainQuadNode } from "../TerrainQuadTree";
import {
  GrassVisualManager,
  STREAMING_GRASS_VISUAL_PROFILE,
} from "../GrassVisualManager";

function workerOutput(key: string, count = 1): GrassWorkerOutput {
  return {
    type: "grassInstanceResult",
    chunkKey: key,
    offsets: new Float32Array(count * 3),
    rotScaleHash: new Float32Array(count * 3),
    groundColors: new Float32Array(count * 3),
    grassTints: new Float32Array(count * 4),
    groundNormals: new Float32Array(count * 3),
    count,
  };
}

describe("GrassVisualManager streaming pacing", () => {
  it("uses only the far-detail grass tier within the bounded broadcast horizon", () => {
    expect(STREAMING_GRASS_VISUAL_PROFILE).toEqual({
      clumpSpacingMultiplier: 4,
      minimumLodLevel: 2,
      maxRenderDistance: 140,
      maxChunksPerFrame: 1,
    });
  });

  it("uploads only the configured number of settled worker chunks per frame", () => {
    const createChunkMeshFromWorkerData = vi.fn();
    const nodes = [1, 2, 3].map(
      (id) => ({ id, isFinal: true }) as TerrainQuadNode,
    );
    const manager = Object.create(
      GrassVisualManager.prototype,
    ) as GrassVisualManager & {
      maxChunksPerFrame: number;
      settledWorkerResults: Array<{
        node: TerrainQuadNode;
        key: string;
        data: GrassWorkerOutput;
        lodLevel: number;
        isLodSwap: boolean;
      }>;
      workerInflight: Set<string>;
      chunks: Map<string, unknown>;
      completedNodes: Map<string, TerrainQuadNode>;
      destroyed: boolean;
      createChunkMeshFromWorkerData: typeof createChunkMeshFromWorkerData;
      processSettledWorkerResults(): number;
    };
    Object.assign(manager, {
      maxChunksPerFrame: 1,
      settledWorkerResults: nodes.map((node, index) => ({
        node,
        key: `gq_${index}`,
        data: workerOutput(`gq_${index}`),
        lodLevel: 1,
        isLodSwap: false,
      })),
      workerInflight: new Set(["gq_0", "gq_1", "gq_2"]),
      chunks: new Map(),
      completedNodes: new Map(),
      destroyed: false,
      createChunkMeshFromWorkerData,
    });

    expect(manager.processSettledWorkerResults()).toBe(1);
    expect(createChunkMeshFromWorkerData).toHaveBeenCalledOnce();
    expect(manager.settledWorkerResults).toHaveLength(2);
    expect(manager.workerInflight.has("gq_0")).toBe(false);
    expect(manager.workerInflight.has("gq_1")).toBe(true);
    expect(manager.completedNodes.has("gq_0")).toBe(true);
  });

  it("discards cancelled settled results without spending the upload budget", () => {
    const createChunkMeshFromWorkerData = vi.fn();
    const manager = Object.create(
      GrassVisualManager.prototype,
    ) as GrassVisualManager & {
      maxChunksPerFrame: number;
      settledWorkerResults: Array<{
        node: TerrainQuadNode;
        key: string;
        data: GrassWorkerOutput;
        lodLevel: number;
        isLodSwap: boolean;
      }>;
      workerInflight: Set<string>;
      chunks: Map<string, unknown>;
      completedNodes: Map<string, TerrainQuadNode>;
      destroyed: boolean;
      createChunkMeshFromWorkerData: typeof createChunkMeshFromWorkerData;
      processSettledWorkerResults(): number;
    };
    Object.assign(manager, {
      maxChunksPerFrame: 1,
      settledWorkerResults: [
        {
          node: { isFinal: false } as TerrainQuadNode,
          key: "cancelled",
          data: workerOutput("cancelled"),
          lodLevel: 1,
          isLodSwap: false,
        },
        {
          node: { isFinal: true } as TerrainQuadNode,
          key: "active",
          data: workerOutput("active"),
          lodLevel: 1,
          isLodSwap: false,
        },
      ],
      workerInflight: new Set(["cancelled", "active"]),
      chunks: new Map(),
      completedNodes: new Map(),
      destroyed: false,
      createChunkMeshFromWorkerData,
    });

    expect(manager.processSettledWorkerResults()).toBe(1);
    expect(createChunkMeshFromWorkerData).toHaveBeenCalledOnce();
    expect(createChunkMeshFromWorkerData).toHaveBeenCalledWith(
      expect.objectContaining({ isFinal: true }),
      expect.objectContaining({ chunkKey: "active" }),
      1,
    );
    expect(manager.settledWorkerResults).toHaveLength(0);
  });

  it("treats completed empty grass chunks as stable scene coverage", () => {
    const near = {
      id: 1,
      centerX: 0,
      centerZ: 0,
      isFinal: true,
      isMaxDepth: true,
    } as TerrainQuadNode;
    const far = {
      id: 2,
      centerX: 500,
      centerZ: 0,
      isFinal: true,
      isMaxDepth: true,
    } as TerrainQuadNode;
    const manager = Object.create(
      GrassVisualManager.prototype,
    ) as GrassVisualManager & {
      playerX: number;
      playerZ: number;
      maxRenderDistance: number;
      completedNodes: Map<string, TerrainQuadNode>;
      chunkKey(node: TerrainQuadNode): string;
    };
    Object.assign(manager, {
      playerX: 0,
      playerZ: 0,
      maxRenderDistance: 350,
      completedNodes: new Map(),
    });
    const key = manager.chunkKey(near);

    expect(manager.getStreamingReadiness([near, far], 250)).toEqual({
      ready: false,
      criticalRadius: 250,
      requiredChunks: 1,
      readyChunks: 0,
      pendingChunks: 1,
    });
    manager.completedNodes.set(key, near);
    expect(manager.getStreamingReadiness([near, far], 250).ready).toBe(true);
  });

  it("precompiles the instanced grass layout and always disposes the sample", async () => {
    const manager = Object.create(
      GrassVisualManager.prototype,
    ) as GrassVisualManager & {
      minimumLodLevel: number;
      lodGeometries: THREE.BufferGeometry[];
      material: THREE.Material;
    };
    const material = new THREE.MeshBasicMaterial();
    Object.assign(manager, {
      minimumLodLevel: 0,
      lodGeometries: [new THREE.PlaneGeometry(1, 1)],
      material,
    });

    let sampleGeometry: THREE.BufferGeometry | undefined;
    await expect(
      manager.precompileRepresentativeChunk(async (object) => {
        const mesh = object as THREE.InstancedMesh;
        sampleGeometry = mesh.geometry;
        vi.spyOn(sampleGeometry, "dispose");
        expect(mesh.material).toBe(material);
        expect(mesh.count).toBe(1);
        expect(Object.keys(mesh.geometry.attributes)).toEqual(
          expect.arrayContaining([
            "instanceOffset",
            "instanceRotScaleHash",
            "instanceGroundColor",
            "instanceGrassTint",
            "instanceGroundNormal",
          ]),
        );
        throw new Error("compile failed");
      }),
    ).rejects.toThrow("compile failed");
    expect(sampleGeometry?.dispose).toHaveBeenCalledOnce();
  });

  it("honors a minimum LOD tier for the fixed streaming camera", () => {
    const manager = Object.create(
      GrassVisualManager.prototype,
    ) as GrassVisualManager & {
      playerX: number;
      playerZ: number;
      minimumLodLevel: number;
      getLodLevel(node: TerrainQuadNode): number;
    };
    Object.assign(manager, {
      playerX: 0,
      playerZ: 0,
      minimumLodLevel: 1,
    });

    expect(
      manager.getLodLevel({ centerX: 0, centerZ: 0 } as TerrainQuadNode),
    ).toBe(1);
    expect(
      manager.getLodLevel({ centerX: 250, centerZ: 0 } as TerrainQuadNode),
    ).toBe(2);
  });
});
