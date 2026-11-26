import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import type { GrassWorkerOutput } from "../../../../utils/workers/GrassWorker";
import { TerrainQuadTree } from "../TerrainQuadTree";
import {
  GrassVisualManager,
  STREAMING_GRASS_VISUAL_PROFILE,
} from "../GrassVisualManager";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";
import { RetainedGridFixture } from "./terrain-grid.fixture";

function fixture(water = 16, minimumLodLevel = 0) {
  const identity = worldTerrainProfileIdentity(COMPACT_WORLD_TERRAIN_PROFILE);
  const grids = new RetainedGridFixture(identity, () => 28);
  const container = new THREE.Group();
  const manager = new GrassVisualManager(
    identity,
    container,
    grids.get,
    () => 28,
    16,
    () => 0,
    () => false,
    () => ({
      r: 0.2,
      g: 0.4,
      b: 0.1,
      grassWeight: 1,
      grassPlacement: 1,
      grassHeightScale: 1,
      nx: 0,
      ny: 1,
      nz: 0,
      tintR: 0,
      tintG: 0,
      tintB: 0,
      tintStrength: 0,
    }),
    undefined,
    { maxChunksPerFrame: 1, minimumLodLevel },
    undefined,
    () => water,
  );
  const tree = new TerrainQuadTree({ minSize: 8, maxDepth: 1, resolution: 4 });
  const nodes = [0, 1, 2].map((i) =>
    tree.createNode(null, null, 8, 350 + i * 8, 320, 1),
  );
  manager.setPlayerPosition(350, 320);
  for (const node of nodes) manager.onNodeNeedsGeometry(node);
  const queue = (index: number) => {
    const node = nodes[index];
    const key = manager["chunkKey"](node);
    const ticket = manager["createWorkerTicket"](node, key, 1, false);
    const output: GrassWorkerOutput = {
      type: "grassInstanceResult",
      terrainProfileIdentity: identity,
      chunkKey: key,
      count: 1,
      offsets: new Float32Array([0, 28, 0]),
      rotScaleHash: new Float32Array([0, 1, 0.5]),
      groundColors: new Float32Array([0.2, 0.4, 0.1]),
      grassTints: new Float32Array([0, 0, 0, 0]),
      groundNormals: new Float32Array([0, 1, 0]),
    };
    manager["settleWorkerResult"](ticket, output);
    return { ticket, output, key };
  };
  return {
    manager,
    container,
    nodes,
    queue,
    grids,
    close() {
      manager.destroy();
      tree.dispose();
      grids.dispose();
    },
  };
}

describe("GrassVisualManager streaming pacing with real managers and meshes", () => {
  it("keeps the bounded broadcast profile", () => {
    expect(STREAMING_GRASS_VISUAL_PROFILE).toEqual({
      id: "fixed-arena-v1",
      clumpSpacingMultiplier: 4,
      minimumLodLevel: 2,
      maxRenderDistance: 140,
      maxChunksPerFrame: 1,
    });
  });
  it("uploads only one of three settled chunks per frame", () => {
    const f = fixture();
    try {
      const queued = [0, 1, 2].map(f.queue);
      expect(f.manager["processSettledWorkerResults"]()).toBe(1);
      expect(f.container.children).toHaveLength(1);
      expect(f.manager["settledWorkerResults"]).toHaveLength(2);
      expect(f.manager["workerInflight"].has(queued[0].key)).toBe(false);
      expect(f.manager["workerInflight"].has(queued[1].key)).toBe(true);
      expect(f.manager.getStreamingReadiness(f.nodes).readyChunks).toBe(1);
    } finally {
      f.close();
    }
  });
  it("discards cancelled results without consuming a valid upload slot", () => {
    const f = fixture();
    try {
      f.queue(0);
      f.queue(1);
      f.manager.onNodeDestroyGeometry(f.nodes[0]);
      expect(f.manager["processSettledWorkerResults"]()).toBe(1);
      expect(f.container.children).toHaveLength(1);
      expect(f.manager["chunks"].has(f.manager["chunkKey"](f.nodes[1]))).toBe(
        true,
      );
    } finally {
      f.close();
    }
  });
  it("budgets nonempty projection even when elevated water removes every anchor", () => {
    const f = fixture(29);
    try {
      [0, 1, 2].forEach(f.queue);
      expect(f.manager["processSettledWorkerResults"]()).toBe(1);
      expect(f.container.children).toHaveLength(0);
      expect(f.manager["settledWorkerResults"]).toHaveLength(2);
      expect(f.manager.getStreamingReadiness(f.nodes).readyChunks).toBe(1);
    } finally {
      f.close();
    }
  });
  it("retires rendered and completed ownership when a live leaf leaves the horizon", () => {
    const f = fixture();
    try {
      f.queue(0);
      f.manager["processSettledWorkerResults"]();
      const geometry = (f.container.children[0] as THREE.Mesh).geometry;
      let disposed = 0;
      geometry.addEventListener("dispose", () => disposed++);
      f.manager.update(1000, 1000);
      expect(f.container.children).toHaveLength(0);
      expect(disposed).toBe(1);
      expect(f.manager["completedNodes"].size).toBe(0);
      expect(f.manager["completedSurfaces"].size).toBe(0);
    } finally {
      f.close();
    }
  });
  it("honors minimum geometry tier without disabling distance tiers", () => {
    const f = fixture(16, 1);
    try {
      expect(f.manager["getLodLevel"](f.nodes[0])).toBe(1);
      f.manager.setPlayerPosition(100, 320);
      expect(f.manager["getLodLevel"](f.nodes[0])).toBe(2);
    } finally {
      f.close();
    }
  });
});
