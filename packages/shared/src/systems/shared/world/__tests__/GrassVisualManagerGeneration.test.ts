import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

import THREE from "../../../../extras/three/three";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import { createGrassTerrainSurfaceSnapshot } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  GrassVisualManager,
  STREAMING_GRASS_VISUAL_PROFILE,
  type GrassWorkerSetup,
  type GrassVisualProfile,
} from "../GrassVisualManager";
import { TerrainQuadTree } from "../TerrainQuadTree";
import { RetainedGridFixture } from "./terrain-grid.fixture";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";

const profile = COMPACT_WORLD_TERRAIN_PROFILE;

/** Analytic graded input; the real manager, geometry, worker and callbacks run unchanged. */
function fixture(
  waterSurface?: number,
  visualProfile: GrassVisualProfile = { maxChunksPerFrame: 1 },
) {
  const state = { height: 28, heightSamples: 0 };
  const requestedRegions: number[][] = [];
  const grass = {
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
  const setup: GrassWorkerSetup = {
    terrainConfig: createTerrainWorkerConfig(profile, 4),
    seed: profile.seed,
    biomeCenters: [{ x: 350, z: 320, type: "forest", influence: 1000 }],
    biomes: {
      forest: { heightModifier: 1, color: { r: 0.2, g: 0.4, b: 0.1 } },
    },
    grassConfigs: { forest: grass, tundra: grass, canyon: grass },
    tileSize: profile.terrainTileSize,
    getRoadSegmentsForRegion: () => [],
    getTerrainSurfaceForRegion: (...bounds) => {
      requestedRegions.push(bounds);
      return createGrassTerrainSurfaceSnapshot({
        zones: [
          {
            id: "natural_grade",
            centerX: 350,
            centerZ: 320,
            width: 100,
            depth: 100,
            height: state.height,
            blendRadius: 2,
            excludeGrass: false,
          },
        ],
        arenaFloorIds: [],
        arenaGradeHeight: null,
        waterBodies:
          waterSurface === undefined
            ? []
            : [
                {
                  id: "elevated_pond",
                  centerX: 350,
                  centerZ: 320,
                  radius: 100,
                  surfaceY: waterSurface,
                },
              ],
      });
    },
  };
  const container = new THREE.Group();
  const grids = new RetainedGridFixture(
    worldTerrainProfileIdentity(profile),
    () => state.height,
  );
  const manager = new GrassVisualManager(
    worldTerrainProfileIdentity(profile),
    container,
    grids.get,
    () => {
      state.heightSamples++;
      return state.height;
    },
    profile.water.threshold,
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
    visualProfile,
    undefined,
    waterSurface === undefined ? undefined : () => waterSurface,
  );
  manager.setPlayerPosition(350, 320);
  const tree = new TerrainQuadTree({ minSize: 8, maxDepth: 1, resolution: 4 });
  const node = tree.createNode(null, null, 8, 350, 320, 1);
  manager.onNodeNeedsGeometry(node);
  const key = manager["chunkKey"](node);
  return {
    manager,
    container,
    tree,
    node,
    key,
    state,
    grids,
    requestedRegions,
    close() {
      manager.destroy();
      grids.dispose();
      tree.dispose();
    },
  };
}

/** Browser-to-Node message adapter only, not a worker/renderer mock. */
async function actualWorker(
  input: GrassWorkerInput,
): Promise<GrassWorkerOutput> {
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    globalThis.self = { postMessage: (value, transfers) => parentPort.postMessage(value, transfers) };
    ${GRASS_WORKER_CODE}
    parentPort.on("message", data => self.onmessage({ data }));
  `,
    { eval: true, env: {} },
  );
  try {
    return await new Promise<GrassWorkerOutput>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Grass worker timed out")),
        5000,
      );
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once(
        "message",
        (message: { result?: GrassWorkerOutput; error?: string }) => {
          clearTimeout(timer);
          if (message.error || !message.result)
            reject(new Error(message.error ?? "Missing grass result"));
          else resolve(message.result);
        },
      );
      worker.postMessage(input);
    });
  } finally {
    await worker.terminate();
  }
}

async function populate(f: ReturnType<typeof fixture>, lod = 0) {
  const ticket = f.manager["createWorkerTicket"](f.node, f.key, lod, false);
  const result = await actualWorker(
    f.manager["createWorkerInput"](f.node, f.key, lod),
  );
  expect(result.count).toBeGreaterThan(0);
  f.manager["settleWorkerResult"](ticket, result);
  expect(f.manager["processSettledWorkerResults"]()).toBe(1);
  return f.container.children[0] as THREE.InstancedMesh;
}

/** Actual 100m leaves survive this 140m grass-boundary crossing. */
function horizonFixture(initiallyFar = false, empty = false) {
  const f = fixture(empty ? 29 : undefined, STREAMING_GRASS_VISUAL_PROFILE);
  f.manager.onNodeDestroyGeometry(f.node);
  f.node.destroy();
  f.tree.dispose();
  const tree = new TerrainQuadTree({
    minSize: 100,
    maxDepth: 1,
    resolution: 4,
    rootChunkRadius: 0,
  });
  const notifications = new Map<number, number>();
  tree.setListener({
    onNodeNeedsGeometry(node) {
      notifications.set(node.id, (notifications.get(node.id) ?? 0) + 1);
      f.manager.onNodeNeedsGeometry(node);
    },
    onNodeDestroyGeometry(node) {
      f.manager.onNodeDestroyGeometry(node);
    },
  });
  const initialX = initiallyFar ? 491 : 350;
  f.manager.setPlayerPosition(initialX, 350);
  tree.update(initialX, 350);
  const target = tree
    .getFinalNodes()
    .find((node) => node.centerX === 350 && node.centerZ === 350)!;
  expect(target).toBeDefined();
  expect(target.isMaxDepth).toBe(true);
  expect(target.terrainNeedsUpdate).toBe(false);
  return {
    ...f,
    tree,
    target,
    targetKey: f.manager["chunkKey"](target),
    notifications,
    move(x: number, frames = 1) {
      f.manager.setPlayerPosition(x, 350);
      tree.update(x, 350);
      for (let i = 0; i < frames; i++) f.manager.update(x, 350);
    },
    close() {
      tree.dispose();
      f.close();
    },
  };
}

describe("GrassVisualManager request ownership with real workers and geometry", () => {
  it("generates an initially outside-horizon live leaf on approach without a second terrain notification", () => {
    const f = horizonFixture(true);
    try {
      expect(f.manager["liveNodes"].get(f.targetKey)).toBe(f.target);
      expect(
        f.manager["pendingNodes"].some((entry) => entry.node === f.target),
      ).toBe(false);
      f.move(491, 4);
      expect(f.manager["completedNodes"].has(f.targetKey)).toBe(false);
      f.move(350, 1);
      expect(f.container.children.length).toBeLessThanOrEqual(2);
      f.move(350, 5);
      expect(f.manager["chunks"].get(f.targetKey)?.mesh.count).toBeGreaterThan(
        0,
      );
      expect(f.manager["completedNodes"].get(f.targetKey)).toBe(f.target);
      expect(f.notifications.get(f.target.id)).toBe(1);
      expect(f.target.terrainNeedsUpdate).toBe(false);
    } finally {
      f.close();
    }
  });

  it.each([false, true])(
    "regenerates a pruned live leaf on return without retaining false readiness (empty=%s)",
    (empty) => {
      const f = horizonFixture(false, empty);
      try {
        f.move(350, 5);
        const original = f.manager["chunks"].get(f.targetKey)?.mesh;
        expect(Boolean(original)).toBe(!empty);
        expect(f.manager.getStreamingReadiness([f.target], 140).ready).toBe(
          true,
        );
        f.move(491);
        expect(f.target.isFinal).toBe(true);
        expect(f.tree.getFinalNodes()).toContain(f.target);
        expect(f.manager["chunks"].has(f.targetKey)).toBe(false);
        expect(f.manager["completedNodes"].has(f.targetKey)).toBe(false);
        expect(original?.parent ?? null).toBeNull();
        f.manager.setPlayerPosition(350, 350);
        expect(f.manager.getStreamingReadiness([f.target], 140).ready).toBe(
          false,
        );
        f.move(350, 5);
        expect(f.notifications.get(f.target.id)).toBe(1);
        expect(f.manager.getStreamingReadiness([f.target], 140).ready).toBe(
          true,
        );
        expect(Boolean(f.manager["chunks"].get(f.targetKey))).toBe(!empty);
        const samples = f.state.heightSamples;
        f.move(350, 5);
        expect(f.state.heightSamples).toBe(samples);
        expect(f.manager["pendingNodes"]).toHaveLength(0);
      } finally {
        f.close();
      }
    },
  );

  it("prunes queued work before a sync build and bounds restored builds per frame", () => {
    const f = horizonFixture();
    try {
      expect(
        f.manager["pendingNodes"].some((entry) => entry.node === f.target),
      ).toBe(true);
      f.move(491);
      expect(f.manager["chunks"].has(f.targetKey)).toBe(false);
      expect(
        f.manager["pendingNodes"].some((entry) => entry.node === f.target),
      ).toBe(false);
      expect(f.container.children.length).toBeLessThanOrEqual(1);
      f.move(350);
      expect(f.container.children.length).toBeLessThanOrEqual(2);
    } finally {
      f.close();
    }
  });

  it.each([false, true])(
    "rejects actual far worker output before attachment/readiness (already settled=%s)",
    async (alreadySettled) => {
      const f = horizonFixture();
      try {
        const ticket = f.manager["createWorkerTicket"](
          f.target,
          f.targetKey,
          2,
          false,
        );
        const result = await actualWorker(
          f.manager["createWorkerInput"](f.target, f.targetKey, 2),
        );
        expect(result.count).toBeGreaterThan(0);
        if (alreadySettled) f.manager["settleWorkerResult"](ticket, result);
        f.manager.setPlayerPosition(491, 350);
        if (!alreadySettled) f.manager["settleWorkerResult"](ticket, result);
        expect(f.manager["processSettledWorkerResults"]()).toBe(0);
        expect(f.manager["workerInflight"].has(f.targetKey)).toBe(false);
        expect(f.manager["completedNodes"].has(f.targetKey)).toBe(false);
        expect(f.container.children).toHaveLength(0);
        f.move(350, 5);
        expect(f.manager["chunks"].has(f.targetKey)).toBe(true);
        expect(f.notifications.get(f.target.id)).toBe(1);
      } finally {
        f.close();
      }
    },
  );

  it("removes destroyed leaves and never accumulates retired tree nodes across travel", () => {
    const f = horizonFixture();
    try {
      f.move(350, 5);
      f.target.destroy();
      expect(f.manager["liveNodes"].has(f.targetKey)).toBe(false);
      f.manager.update(350, 350);
      expect(f.manager["completedNodes"].has(f.targetKey)).toBe(false);
      expect(f.manager["chunks"].has(f.targetKey)).toBe(false);
      for (const x of [550, 750, 950, 1150, 350]) {
        f.move(x);
        const livingLeaves = f.tree
          .getFinalNodes()
          .filter((node) => node.isMaxDepth);
        expect([...f.manager["liveNodes"].values()]).toEqual(
          expect.arrayContaining(livingLeaves),
        );
        expect(f.manager["liveNodes"].size).toBe(livingLeaves.length);
        expect(f.manager["pendingNodes"].length).toBeLessThanOrEqual(
          livingLeaves.length,
        );
      }
      f.tree.dispose();
      expect(f.manager["liveNodes"].size).toBe(0);
    } finally {
      f.close();
    }
  });

  it("captures a detached authored surface with the exact normal halo for every LOD input", () => {
    const f = fixture();
    try {
      const first = f.manager["createWorkerInput"](f.node, f.key, 0);
      f.state.height = 30;
      const second = f.manager["createWorkerInput"](f.node, f.key, 2);
      expect(f.requestedRegions).toEqual([
        [345.5, 315.5, 354.5, 324.5],
        [345.5, 315.5, 354.5, 324.5],
      ]);
      expect(first.terrainSurface.zones[0].height).toBe(28);
      expect(second.terrainSurface.zones[0].height).toBe(30);
      expect([first.spacingMul, second.spacingMul]).toEqual([1, 5]);
    } finally {
      f.close();
    }
  });

  it("ignores a late success after pure-inflight invalidation without deleting the newer ticket", async () => {
    const f = fixture();
    try {
      const old = f.manager["createWorkerTicket"](f.node, f.key, 0, false);
      const pending = actualWorker(
        f.manager["createWorkerInput"](f.node, f.key, 0),
      );
      f.manager.invalidateRegion(349, 319, 351, 321);
      expect(f.manager["pendingNodes"].map((entry) => entry.node)).toEqual([
        f.node,
      ]);
      f.state.height = 30;
      const current = f.manager["createWorkerTicket"](f.node, f.key, 0, false);
      f.manager["settleWorkerResult"](old, await pending);
      expect(f.manager["workerInflight"].get(f.key)).toBe(current);
      expect(f.manager["settledWorkerResults"]).toHaveLength(0);
      expect(f.manager.getStreamingReadiness([f.node], 50).ready).toBe(false);
      const result = await actualWorker(
        f.manager["createWorkerInput"](f.node, f.key, 0),
      );
      expect(result.count).toBeGreaterThan(0);
      f.manager["settleWorkerResult"](current, result);
      expect(f.manager["processSettledWorkerResults"]()).toBe(1);
      const mesh = f.container.children[0] as THREE.InstancedMesh;
      expect(mesh.geometry.getAttribute("instanceOffset").getY(0)).toBe(30);
    } finally {
      f.close();
    }
  });

  it("ignores an actual late worker failure after replacement without clearing newer work", async () => {
    const f = fixture();
    try {
      const old = f.manager["createWorkerTicket"](f.node, f.key, 0, false);
      const invalid = f.manager["createWorkerInput"](f.node, f.key, 0);
      Object.assign(invalid.terrainSurface, { schemaVersion: 99 });
      const pending = actualWorker(invalid).catch((error) =>
        f.manager["rejectWorkerResult"](old, error),
      );
      f.manager.invalidateRegion(349, 319, 351, 321);
      const current = f.manager["createWorkerTicket"](f.node, f.key, 1, false);
      await pending;
      expect(f.manager["workerInflight"].get(f.key)).toBe(current);
      expect(f.manager["settledWorkerResults"]).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it.each([false, true])(
    "does not let a stale settled result mutate newer ownership (empty=%s)",
    async (empty) => {
      const f = fixture(empty ? 29 : undefined);
      try {
        const old = f.manager["createWorkerTicket"](f.node, f.key, 0, false);
        const result = await actualWorker(
          f.manager["createWorkerInput"](f.node, f.key, 0),
        );
        expect(result.count === 0).toBe(empty);
        f.manager["settleWorkerResult"](old, result);
        const current = f.manager["createWorkerTicket"](
          f.node,
          f.key,
          0,
          false,
        );
        expect(f.manager["processSettledWorkerResults"]()).toBe(0);
        expect(f.manager["workerInflight"].get(f.key)).toBe(current);
        expect(f.manager.getStreamingReadiness([f.node], 50).ready).toBe(false);
        expect(f.container.children).toHaveLength(0);
      } finally {
        f.close();
      }
    },
  );

  it("invalidates the half-meter normal halo once and retains an unrelated inflight ticket", () => {
    const f = fixture();
    try {
      const ticket = f.manager["createWorkerTicket"](f.node, f.key, 0, false);
      f.manager.invalidateRegion(354.50001, 319, 355, 321);
      expect(f.manager["workerInflight"].get(f.key)).toBe(ticket);
      f.manager.invalidateRegion(354.25, 319, 354.3, 321);
      expect(f.manager["workerInflight"].has(f.key)).toBe(false);
      expect(f.manager["pendingNodes"].map((entry) => entry.node)).toEqual([
        f.node,
      ]);
    } finally {
      f.close();
    }
  });

  it("rebuilds pure inflight empty work without changing terrain-owned visual keys", async () => {
    const f = fixture(29);
    try {
      f.node.visualChunkKey = "terrain-owner-key";
      const ticket = f.manager["createWorkerTicket"](f.node, f.key, 0, false);
      const result = await actualWorker(
        f.manager["createWorkerInput"](f.node, f.key, 0),
      );
      expect(result.count).toBe(0);
      f.manager.rebuildAllChunks();
      expect(f.node.visualChunkKey).toBe("terrain-owner-key");
      expect(f.manager["pendingNodes"].map((entry) => entry.node)).toEqual([
        f.node,
      ]);
      f.manager["settleWorkerResult"](ticket, result);
      expect(f.manager["processSettledWorkerResults"]()).toBe(0);
      expect(f.manager.getStreamingReadiness([f.node], 50).ready).toBe(false);
    } finally {
      f.close();
    }
  });

  it("discards a superseded LOD output without relabeling instances or disposing the visible mesh", async () => {
    const f = fixture();
    try {
      const original = await populate(f);
      let disposed = false;
      original.geometry.addEventListener("dispose", () => {
        disposed = true;
      });
      const ticket = f.manager["createWorkerTicket"](f.node, f.key, 1, true);
      f.manager.setPlayerPosition(350, 580);
      f.manager["pendingLodSwap"].set(f.key, { node: f.node, desiredLod: 2 });
      const result = await actualWorker(
        f.manager["createWorkerInput"](f.node, f.key, 1),
      );
      f.manager["settleWorkerResult"](ticket, result);
      expect(f.manager["processSettledWorkerResults"]()).toBe(0);
      expect(f.container.children).toEqual([original]);
      expect(disposed).toBe(false);
      expect(f.manager["pendingLodSwap"].get(f.key)?.desiredLod).toBe(2);
      const current = f.manager["createWorkerTicket"](f.node, f.key, 2, true);
      const latest = await actualWorker(
        f.manager["createWorkerInput"](f.node, f.key, 2),
      );
      expect(latest.count).toBeGreaterThan(0);
      f.manager["settleWorkerResult"](current, latest);
      expect(f.manager["processSettledWorkerResults"]()).toBe(1);
      expect(f.manager["chunks"].get(f.key)?.lodLevel).toBe(2);
      const mesh = f.container.children[0] as THREE.InstancedMesh;
      expect(mesh.count).toBe(latest.count);
      expect(mesh.geometry.getAttribute("position").count).toBe(
        f.manager["lodGeometries"][2].getAttribute("position").count,
      );
      expect(disposed).toBe(true);
    } finally {
      f.close();
    }
  });

  it("cancels an unfinished LOD swap when the camera returns to the displayed tier", async () => {
    const f = fixture();
    try {
      const original = await populate(f);
      const ticket = f.manager["createWorkerTicket"](f.node, f.key, 1, true);
      f.manager["pendingLodSwap"].set(f.key, { node: f.node, desiredLod: 1 });
      const result = await actualWorker(
        f.manager["createWorkerInput"](f.node, f.key, 1),
      );
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
      camera.position.set(350, 40, 340);
      camera.lookAt(350, 28, 320);
      camera.updateMatrixWorld();
      f.manager["settleWorkerResult"](ticket, result);
      f.manager.update(350, 320, camera);
      expect(f.manager["workerInflight"].has(f.key)).toBe(false);
      expect(f.manager["processSettledWorkerResults"]()).toBe(0);
      expect(f.container.children).toEqual([original]);
    } finally {
      f.close();
    }
  });

  it("cancels node teardown and manager destruction before any late callback can repopulate state", async () => {
    const f = fixture();
    try {
      const old = f.manager["createWorkerTicket"](f.node, f.key, 0, false);
      const result = await actualWorker(
        f.manager["createWorkerInput"](f.node, f.key, 0),
      );
      f.manager["pendingNodes"].push({ node: f.node });
      f.manager.onNodeDestroyGeometry(f.node);
      f.manager["settleWorkerResult"](old, result);
      expect(f.manager["pendingNodes"]).toHaveLength(0);
      expect(f.manager["settledWorkerResults"]).toHaveLength(0);
      const current = f.manager["createWorkerTicket"](f.node, f.key, 0, false);
      f.manager.destroy();
      f.manager["settleWorkerResult"](current, result);
      f.manager["rejectWorkerResult"](current, new Error("late failure"));
      f.manager.rebuildAllChunks();
      f.manager.invalidateRegion(349, 319, 351, 321);
      f.manager.onNodeNeedsGeometry(f.node);
      f.manager.update(350, 320);
      expect(f.manager["workerInflight"].size).toBe(0);
      expect(f.manager["settledWorkerResults"]).toHaveLength(0);
      expect(f.manager["pendingNodes"]).toHaveLength(0);
      expect(f.container.children).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("retains a correct visible mesh on a wrong-key result and never marks the wrong node ready", async () => {
    const f = fixture();
    try {
      const original = await populate(f);
      const ticket = f.manager["createWorkerTicket"](f.node, f.key, 1, true);
      const result = await actualWorker(
        f.manager["createWorkerInput"](f.node, "another-key", 1),
      );
      expect(() => f.manager["settleWorkerResult"](ticket, result)).toThrow(
        "chunk key mismatch",
      );
      expect(f.manager["settledWorkerResults"]).toHaveLength(0);
      expect(f.container.children).toEqual([original]);
    } finally {
      f.close();
    }
  });

  it("applies elevated-water clearance in the actual sync fallback and worker without changing the default ocean", async () => {
    const wet = fixture(29);
    const dry = fixture();
    try {
      expect(wet.manager["generateInstanceData"](wet.node, 1)).toBeNull();
      expect(
        dry.manager["generateInstanceData"](dry.node, 1)?.count,
      ).toBeGreaterThan(0);
      const result = await actualWorker(
        wet.manager["createWorkerInput"](wet.node, wet.key, 0),
      );
      expect(result.count).toBe(0);
    } finally {
      wet.close();
      dry.close();
    }
  });

  it("waits for retained terrain without sampling or marking empty-ready, then installs on arrival", () => {
    const f = fixture();
    try {
      f.grids.available = false;
      for (let i = 0; i < 3; i++) f.manager.update(350, 320);
      expect(f.state.heightSamples).toBe(0);
      expect(f.container.children).toHaveLength(0);
      expect(f.manager.getStreamingReadiness([f.node]).ready).toBe(false);
      f.grids.available = true;
      f.manager.update(350, 320);
      expect(f.container.children).toHaveLength(1);
      expect(f.manager.getStreamingReadiness([f.node]).ready).toBe(true);
    } finally {
      f.close();
    }
  });

  it.each([false, true])(
    "rejects a replaced retained revision with an actual delayed worker (already settled=%s)",
    async (alreadySettled) => {
      const f = fixture();
      try {
        const old = f.manager["createWorkerTicket"](f.node, f.key, 0, false);
        const result = await actualWorker(
          f.manager["createWorkerInput"](f.node, f.key, 0),
        );
        if (alreadySettled) f.manager["settleWorkerResult"](old, result);
        f.state.height = 31;
        if (!alreadySettled) f.manager["settleWorkerResult"](old, result);
        expect(f.manager["processSettledWorkerResults"]()).toBe(0);
        expect(f.container.children).toHaveLength(0);
        expect(f.manager.getStreamingReadiness([f.node]).ready).toBe(false);
        f.manager.update(350, 320);
        const mesh = f.container.children[0] as THREE.InstancedMesh;
        expect(mesh.geometry.getAttribute("instanceOffset").getY(0)).toBe(31);
        expect(mesh.userData.grassGrounding.surfaceRevision).toBe(
          f.grids.get(f.node)!.revision,
        );
        expect(mesh.userData.grassGrounding.surfaceRevision).not.toBe(
          old.surface.revision,
        );
      } finally {
        f.close();
      }
    },
  );

  it("retires installed grass on terrain loss and rebuilds only against the recovered surface", async () => {
    const f = fixture();
    try {
      const old = await populate(f);
      let disposed = 0;
      old.geometry.addEventListener("dispose", () => disposed++);
      f.grids.available = false;
      expect(f.manager.getStreamingReadiness([f.node]).ready).toBe(false);
      f.manager.update(350, 320);
      expect(disposed).toBe(1);
      expect(f.container.children).toHaveLength(0);
      expect(f.manager["completedSurfaces"].size).toBe(0);
      f.grids.available = true;
      f.manager.update(350, 320);
      expect(f.container.children).toHaveLength(1);
      expect(f.container.children[0]).not.toBe(old);
      expect(f.manager.getStreamingReadiness([f.node]).ready).toBe(true);
    } finally {
      f.close();
    }
  });
});
