import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import THREE from "../../../../extras/three/three";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  QUAD_CHUNK_WORKER_CODE,
  type QuadChunkWorkerInput,
  type QuadChunkWorkerOutput,
} from "../../../../utils/workers/QuadChunkWorker";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainSystem } from "../TerrainSystem";
import { TerrainVisualManager } from "../TerrainVisualManager";
import type { TerrainDetailRegion, TerrainQuadNode } from "../TerrainQuadTree";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import { validateWorldTerrainProfile } from "../WorldTerrainProfile";

// Actual systems, emitted worker source and Three resources. CPU ownership and
// scheduling checks do not certify native WebGPU compilation or frame quality.
const cleanups = new Set<() => void>();
afterEach(() => {
  for (const close of cleanups) close();
  cleanups.clear();
});

async function fixture(
  resolution = 128,
  startRoads = true,
  wireframe = false,
  options: {
    selectedPond?: boolean;
    fineDetailRegions?: readonly TerrainDetailRegion[];
  } = {},
) {
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  const scene = new THREE.Scene(),
    container = new THREE.Group();
  const material = new THREE.MeshStandardNodeMaterial();
  scene.add(container);
  let manager: TerrainVisualManager | undefined;
  cleanups.add(() => {
    manager?.dispose();
    world.destroy();
    material.dispose();
  });
  if (options.selectedPond) {
    // Select an admitted instance profile before init, not a replacement
    // provider or a mutation of the live DataManager/manifests.
    terrain["activeTerrainProfile"] = validateWorldTerrainProfile({
      ...DataManager.getWorldTerrainProfile(),
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
  }
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  await roads.init();
  if (startRoads) await roads.start();
  const profile = terrain.getWorldTerrainProfile();
  const provider = terrain["buildChunkTerrainProvider"]();
  const worker = terrain["buildGrassWorkerSetup"]();
  const config = createTerrainWorkerConfig(profile, resolution);
  manager = new TerrainVisualManager(
    {
      minSize: 100,
      maxDepth: 1,
      resolution,
      rootChunkRadius: 0,
      fineDetailRegions: options.selectedPond
        ? createCompactPreparationDetailRegions(profile, ALL_WORLD_AREAS, 64)
        : options.fineDetailRegions,
    },
    provider,
    container,
    material,
    config,
    profile.seed,
    worker.biomeCenters,
    worker.biomes,
    wireframe,
    true,
    false,
    1,
    1,
  );
  // The real Node CPU host lacks browser Worker; use the production fallback.
  expect(manager["useWorkers"]).toBe(false);
  manager["playerX"] = 350;
  manager["playerZ"] = 400;
  const current = manager;
  const addNode = (x = 350, z = 400) => {
    const tree = current.getQuadTree();
    const node = tree.createNode(null, null, 100, x, z, tree.config.maxDepth);
    current.onNodeNeedsGeometry(node);
    return node;
  };
  const workerInput = (node: TerrainQuadNode): QuadChunkWorkerInput => ({
    type: "generateQuadChunk",
    centerX: node.centerX,
    centerZ: node.centerZ,
    size: node.size,
    resolution: node.resolution,
    config,
    seed: profile.seed,
    biomeCenters: worker.biomeCenters,
    biomes: worker.biomes,
  });
  return {
    world,
    terrain,
    roads,
    scene,
    container,
    material,
    manager,
    addNode,
    workerInput,
  };
}

async function emittedWorker(
  input: QuadChunkWorkerInput,
): Promise<QuadChunkWorkerOutput> {
  const worker = new Worker(
    "const { parentPort } = require('node:worker_threads');" +
      "globalThis.self = { postMessage: (value, transfer) => parentPort.postMessage(value, transfer) };" +
      QUAD_CHUNK_WORKER_CODE +
      ";parentPort.on('message', data => self.onmessage({ data }));",
    { eval: true, env: {} },
  );
  try {
    return await new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error("Terrain worker exited " + code));
      });
      worker.once(
        "message",
        (message: { result?: QuadChunkWorkerOutput; error?: string }) => {
          if (message.result) resolve(message.result);
          else
            reject(
              new Error(message.error ?? "Terrain worker returned no result"),
            );
        },
      );
      worker.postMessage(input);
    });
  } finally {
    await worker.terminate();
  }
}

function slice(manager: TerrainVisualManager) {
  const before = manager.getStats().preparationSlices;
  manager["processPreparation"]();
  const stats = manager.getStats();
  expect(stats.preparationSlices).toBe(before + 1);
  expect(stats.reservedRawBytes).toBeGreaterThanOrEqual(0);
  expect(stats.reservedRawBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  return stats;
}
function drain(manager: TerrainVisualManager, complete: () => boolean) {
  for (let i = 0; i < 2000 && !complete(); i++) slice(manager);
  expect(complete()).toBe(true);
}

describe("TerrainVisualManager actual cooperative preparation", () => {
  it("bounds admitted raw reservations and queues bootstrap without preparing geometry", async () => {
    const f = await fixture();
    const nodes = Array.from({ length: 40 }, (_, i) =>
      f.addNode(350 + i * 10, 400),
    );
    const requests = nodes.map((node) => f.manager["admitRequest"](node));
    expect(requests.filter(Boolean)).toHaveLength(16);
    expect(f.manager.getStats().preparationRequests).toBe(16);
    expect(f.manager.getStats().reservedRawBytes).toBeLessThan(
      16 * 1024 * 1024,
    );
    expect(f.manager.getStats().preparationSlices).toBe(0);
    expect(f.container.children).toHaveLength(0);
    const first = requests[0]!;
    f.manager.onNodeDestroyGeometry(nodes[0]);
    expect(first.reservedBytes).toBe(0);
    expect(f.manager["admitRequest"](nodes[16])).not.toBeNull();
    expect(f.manager.getStats().preparationRequests).toBe(16);
    f.manager["syncBootstrapNearbyChunks"]();
    expect(f.manager.getStats().preparationSlices).toBe(0);
    expect(f.manager.getStats().preparationActive).toBe(false);
    expect(f.container.children).toHaveLength(0);
    expect(f.manager.getStats().reservedRawBytes).toBeLessThan(
      16 * 1024 * 1024,
    );
  });

  it("keeps actual worker and sync drafts private under one slice budget until every critical leaf is installed", async () => {
    const f = await fixture();
    const workerNode = f.addNode(),
      syncNode = f.addNode(450, 400),
      far = f.addNode(1400, 1400);
    const request = f.manager["admitRequest"](workerNode)!;
    const raw = await emittedWorker(f.workerInput(workerNode));
    f.manager["acceptWorkerResult"](request, raw);
    expect(f.container.children).toHaveLength(0);
    expect(f.manager.getRetainedSurface(workerNode)).toBeNull();
    expect(f.manager.getStreamingReadiness(200)).toEqual({
      ready: false,
      criticalRadius: 200,
      requiredChunks: 2,
      readyChunks: 0,
      pendingChunks: 2,
    });
    let partialSlices = 0;
    drain(f.manager, () => {
      const ready = f.manager.getStreamingReadiness(200);
      for (const node of [workerNode, syncNode, far]) {
        if (node.visualChunkKey === null)
          expect(f.manager.getRetainedSurface(node)).toBeNull();
        else {
          const chunk = f.manager.getChunks().get(node.visualChunkKey)!;
          expect(chunk.surface.matchesGeometry(chunk.mesh.geometry)).toBe(true);
          expect(chunk.mesh.parent).toBe(f.container);
          expect(f.manager.getRetainedSurface(node)).toBe(chunk.surface);
        }
      }
      expect(f.container.children.length).toBe(f.manager.getChunks().size);
      if (!ready.ready) partialSlices++;
      return ready.ready;
    });
    expect(partialSlices).toBeGreaterThan(1);
    expect(f.manager.getStreamingReadiness(200).readyChunks).toBe(2);
    expect(far.visualChunkKey).toBeNull();
    const stats = f.manager.getStats();
    expect(stats.preparationSlices).toBeGreaterThan(1);
    expect(stats.maxPreparationStepMs).toBeGreaterThan(0);
    expect(stats.maxPreparationMs).toBeGreaterThanOrEqual(
      stats.maxPreparationStepMs,
    );
    process.stdout.write(
      "[Terrain preparation CPU] " + JSON.stringify(stats) + "\n",
    );
  });

  it.each(["grade", "road", "biome", "resolution", "skirt"] as const)(
    "cancels %s changes between real slices before stale publication",
    async (kind) => {
      const f = await fixture(),
        node = f.addNode();
      slice(f.manager);
      expect(f.manager.getStats().preparationActive).toBe(true);
      expect(f.container.children).toHaveLength(0);
      const old = f.manager["requests"].get(node)!;
      const previousCenterHeight = f.terrain.getResourceGroundHeight(350, 400);
      let restore = () => {};
      if (kind === "grade") {
        const floor = [...f.terrain["arenaFloorZoneIds"]]
          .map((id) => f.terrain["flatZones"].get(id)!)
          .find(
            (zone) =>
              Math.abs(zone.centerX - 350) < zone.width / 2 &&
              Math.abs(zone.centerZ - 400) < zone.depth / 2,
          )!;
        // Remove an actual owned floor through its lifecycle API. Protected
        // floor registration is not a generic arbitrary-height override.
        f.terrain.unregisterFlatZone(floor.id);
      } else if (kind === "road") f.roads["buildTileCache"]();
      else if (kind === "biome") {
        const center = f.terrain["biomeSystem"].getBiomeCenters()[0],
          x = center.x;
        center.x++;
        restore = () => {
          center.x = x;
        };
      } else if (kind === "resolution")
        f.manager.getQuadTree().config.resolution = 96;
      else f.manager.getQuadTree().config.skirtDrop++;
      try {
        slice(f.manager);
        expect(old.state).toBe("cancelled");
        expect(old.reservedBytes).toBe(0);
        expect(old.result).toBeNull();
        expect(f.manager.getStats().cancelledPreparations).toBeGreaterThan(0);
        expect(f.container.children).toHaveLength(0);
        expect(f.manager.getRetainedSurface(node)).toBeNull();
        if (kind === "biome") {
          expect(f.manager["requests"].has(node)).toBe(false);
          const changed = f.terrain["buildGrassWorkerSetup"]();
          f.manager.updateBiomeData(changed.biomeCenters, changed.biomes);
        }
        drain(f.manager, () => node.visualChunkKey !== null);
        expect(f.manager.getStreamingReadiness(200).ready).toBe(true);
        expect(f.manager.getRetainedSurface(node)).not.toBeNull();
        if (kind === "grade") {
          expect(f.terrain.getResourceGroundHeight(350, 400)).not.toBe(
            previousCenterHeight,
          );
          const chunk = f.manager.getChunks().get(node.visualChunkKey!)!;
          const p = chunk.mesh.geometry.getAttribute("position");
          for (let i = 0; i < node.resolution ** 2; i++)
            if (Math.abs(p.getX(i)) < 4 && Math.abs(p.getZ(i)) < 4)
              expect(p.getY(i)).toBe(
                Math.fround(
                  f.terrain.getResourceGroundHeight(
                    node.centerX + p.getX(i),
                    node.centerZ + p.getZ(i),
                  ),
                ),
              );
        }
      } finally {
        restore();
      }
    },
  );

  it("owns biome update copies and retires installed geometry before rebuilding", async () => {
    const f = await fixture(64),
      node = f.addNode();
    drain(f.manager, () => node.visualChunkKey !== null);
    const chunk = f.manager.getChunks().get(node.visualChunkKey!)!;
    const region = f.manager.captureRetainedSurfaceRegion({
      minX: 310,
      maxX: 390,
      minZ: 360,
      maxZ: 440,
    });
    let disposals = 0;
    chunk.mesh.geometry.addEventListener("dispose", () => {
      disposals++;
    });
    const data = f.terrain["buildGrassWorkerSetup"]();
    f.manager.updateBiomeData(data.biomeCenters, data.biomes);
    expect(disposals).toBe(1);
    expect(region.isCurrent()).toBe(false);
    expect(node.visualChunkKey).toBeNull();
    expect(f.container.children).toHaveLength(0);
    data.biomeCenters[0].x = -99999;
    const name = Object.keys(data.biomes)[0];
    data.biomes[name].color.r = -99;
    expect(f.manager["workerBiomeCenters"][0].x).not.toBe(-99999);
    expect(f.manager["workerBiomes"][name].color.r).not.toBe(-99);
    f.manager.onNodeNeedsGeometry(node);
    drain(f.manager, () => node.visualChunkKey !== null);
    expect(f.manager.getRetainedSurface(node)).not.toBe(chunk.surface);
    expect(disposals).toBe(1);
  });

  it("ignores a late actual worker result without deleting its replacement", async () => {
    const f = await fixture(64),
      node = f.addNode();
    const old = f.manager["admitRequest"](node)!;
    const raw = await emittedWorker(f.workerInput(node));
    f.manager.invalidateRegion(300, 350, 400, 450);
    const replacement = f.manager["admitRequest"](node)!;
    expect(replacement).not.toBe(old);
    const reserved = f.manager.getStats().reservedRawBytes;
    f.manager["acceptWorkerResult"](old, raw);
    expect(f.manager["requests"].get(node)).toBe(replacement);
    expect(replacement.result).toBeNull();
    expect(f.manager.getStats().reservedRawBytes).toBe(reserved);
    expect(f.container.children).toHaveLength(0);
    drain(f.manager, () => node.visualChunkKey !== null);
    expect(f.manager.getStats().reservedRawBytes).toBe(0);
  });

  it("disposes active preparation without publishing or reviving its drafts", async () => {
    const f = await fixture(),
      node = f.addNode();
    slice(f.manager);
    expect(f.manager.getStats().preparationActive).toBe(true);
    const request = f.manager["requests"].get(node)!;
    f.manager.dispose();
    expect(request.state).toBe("cancelled");
    expect(request.reservedBytes).toBe(0);
    expect(f.manager.getStats().reservedRawBytes).toBe(0);
    expect(f.manager.getStats().preparationActive).toBe(false);
    expect(f.container.children).toHaveLength(0);
    expect(f.container.parent).toBeNull();
    expect(f.manager.getRetainedSurface(node)).toBeNull();
    f.manager.update(350, 400);
    expect(f.manager.getChunks().size).toBe(0);
    f.manager.dispose();
  });

  it.each(["dispose", "invalidate", "throw"] as const)(
    "rolls back actual Three childadded reentrancy (%s) exactly once",
    async (action) => {
      const f = await fixture(64, true, true),
        node = f.addNode();
      let geometryDisposals = 0,
        materialDisposals = 0,
        calls = 0;
      const listener = (event: { child: THREE.Object3D }) => {
        calls++;
        const mesh = event.child as THREE.Mesh;
        mesh.geometry.addEventListener("dispose", () => {
          geometryDisposals++;
        });
        (mesh.material as THREE.Material).addEventListener("dispose", () => {
          materialDisposals++;
        });
        // One-shot lifecycle action: a retry may validly publish afterwards.
        f.container.removeEventListener("childadded", listener);
        if (action === "dispose") f.manager.dispose();
        else if (action === "invalidate")
          f.manager.invalidateRegion(300, 350, 400, 450);
        else throw new Error("child publication rejected");
      };
      f.container.addEventListener("childadded", listener);
      for (let i = 0; i < 2000 && calls === 0; i++) slice(f.manager);
      expect(calls).toBe(1);
      expect(geometryDisposals).toBe(1);
      expect(materialDisposals).toBe(1);
      expect(node.visualChunkKey).toBeNull();
      expect(f.container.children).toHaveLength(0);
      expect(f.manager.getChunks().size).toBe(0);
      expect(f.manager.getRetainedSurface(node)).toBeNull();
      expect(f.manager["failedAttempts"].get(node.id) ?? 0).toBe(
        action === "throw" ? 1 : 0,
      );
    },
  );

  it.each(["dispose", "throw"] as const)(
    "retires ownership before real childremoved reentrancy (%s)",
    async (action) => {
      const f = await fixture(64, true, true),
        node = f.addNode();
      drain(f.manager, () => node.visualChunkKey !== null);
      const chunk = f.manager.getChunks().get(node.visualChunkKey!)!;
      let geometryDisposals = 0,
        materialDisposals = 0,
        calls = 0;
      chunk.mesh.geometry.addEventListener("dispose", () => {
        geometryDisposals++;
      });
      (chunk.mesh.material as THREE.Material).addEventListener(
        "dispose",
        () => {
          materialDisposals++;
        },
      );
      const listener = () => {
        calls++;
        f.container.removeEventListener("childremoved", listener);
        expect(f.manager.getChunks().size).toBe(0);
        expect(node.visualChunkKey).toBeNull();
        expect(f.manager.getRetainedSurface(node)).toBeNull();
        if (action === "dispose") f.manager.dispose();
        else throw new Error("child removal rejected");
      };
      f.container.addEventListener("childremoved", listener);
      expect(() =>
        f.manager.invalidateRegion(300, 350, 400, 450),
      ).not.toThrow();
      expect(calls).toBe(1);
      expect(geometryDisposals).toBe(1);
      expect(materialDisposals).toBe(1);
      expect(f.container.children).toHaveLength(0);
      expect(f.manager.getChunks().size).toBe(0);
      expect(node.visualChunkKey).toBeNull();
      f.manager.dispose();
      expect(geometryDisposals).toBe(1);
      expect(materialDisposals).toBe(1);
    },
  );

  it.each([false, true])(
    "cooperatively prepares and retires representative layout (callback failure=%s)",
    async (fail) => {
      const f = await fixture(128, false);
      let timerRan = false,
        calls = 0,
        disposals = 0;
      const timer = setTimeout(() => {
        timerRan = true;
      }, 0);
      const compile = f.manager.precompileRepresentativeChunk(
        350,
        400,
        async (object) => {
          calls++;
          expect(timerRan).toBe(true);
          expect(object).toBeInstanceOf(THREE.Mesh);
          const mesh = object as THREE.Mesh;
          expect(mesh.material).toBe(f.material);
          expect(mesh.position.toArray()).toEqual([350, 0, 400]);
          expect(mesh.receiveShadow).toBe(true);
          expect(mesh.castShadow).toBe(false);
          expect(mesh.geometry.index!.array).toBeInstanceOf(Uint32Array);
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
          mesh.geometry.addEventListener("dispose", () => {
            disposals++;
          });
          expect(f.container.children).toHaveLength(0);
          expect(f.manager.getChunks().size).toBe(0);
          if (fail) throw new Error("representative compilation rejected");
        },
      );
      try {
        if (fail)
          await expect(compile).rejects.toThrow(
            "representative compilation rejected",
          );
        else await compile;
        expect(calls).toBe(1);
        expect(disposals).toBe(1);
        expect(f.manager.getChunks().size).toBe(0);
      } finally {
        clearTimeout(timer);
      }
    },
  );

  it("rejects representative preparation when its owner retires between yields", async () => {
    const f = await fixture();
    let calls = 0;
    const timer = setTimeout(() => f.manager.dispose(), 0);
    try {
      await expect(
        f.manager.precompileRepresentativeChunk(350, 400, async () => {
          calls++;
        }),
      ).rejects.toThrow(/disposed|changed/);
      expect(calls).toBe(0);
      expect(f.container.children).toHaveLength(0);
      expect(f.manager.getChunks().size).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  });

  it.each([false, true])(
    "precompiles actual candidate pond at a preparation focus with streaming base16 (callback failure=%s)",
    async (fail) => {
      const live = DataManager.getWorldTerrainProfile();
      const f = await fixture(16, false, false, { selectedPond: true });
      const tree = f.manager.getQuadTree();
      // A finite preparation/follow target is not snapped to the quadtree.
      // This 100 m representative rectangle intersects the real Haven pond.
      const x = 350,
        z = 340;
      const node = tree.createNode(null, null, 100, x, z, tree.config.maxDepth);
      expect(node.resolution).toBe(128);
      expect(tree.config.resolution).toBe(16);
      expect(
        f.terrain["buildChunkTerrainProvider"]().surfaceRefinementAnnuli,
      ).toEqual([
        { centerX: 343, centerZ: 302, innerRadius: 4.1, outerRadius: 7.9 },
      ]);
      let calls = 0,
        disposals = 0;
      const rejection = new Error("candidate pond compilation rejected");
      const compile = f.manager.precompileRepresentativeChunk(
        x,
        z,
        async (object) => {
          calls++;
          const mesh = object as THREE.Mesh;
          expect(mesh.position.toArray()).toEqual([x, 0, z]);
          expect(mesh.geometry.userData.terrainCellTopology.resolution).toBe(
            node.resolution,
          );
          expect(mesh.geometry.getAttribute("position").count).toBeGreaterThan(
            128 * 128,
          );
          expect(mesh.geometry.index!.array).toBeInstanceOf(Uint32Array);
          mesh.geometry.addEventListener("dispose", () => {
            disposals++;
          });
          expect(f.container.children).toHaveLength(0);
          expect(f.manager.getChunks().size).toBe(0);
          if (fail) throw rejection;
        },
      );
      if (fail) await expect(compile).rejects.toBe(rejection);
      else await compile;
      expect(calls).toBe(1);
      expect(disposals).toBe(1);
      expect(tree.config.resolution).toBe(16);
      expect(f.manager.getChunks().size).toBe(0);
      expect(DataManager.getWorldTerrainProfile()).toEqual(live);
    },
  );

  it.each([
    { name: "no regions", regions: [], expected: 16 },
    {
      name: "touching x edge",
      regions: [{ minX: 50, maxX: 60, minZ: -1, maxZ: 1, resolution: 128 }],
      expected: 16,
    },
    {
      name: "touching z edge",
      regions: [{ minX: -1, maxX: 1, minZ: 50, maxZ: 60, resolution: 128 }],
      expected: 16,
    },
    {
      name: "x overlap outside z",
      regions: [{ minX: -1, maxX: 1, minZ: 51, maxZ: 60, resolution: 128 }],
      expected: 16,
    },
    {
      name: "positive sliver",
      regions: [{ minX: 49.99, maxX: 60, minZ: -1, maxZ: 1, resolution: 64 }],
      expected: 64,
    },
    {
      name: "highest overlapping detail",
      regions: [
        { minX: -1, maxX: 1, minZ: -1, maxZ: 1, resolution: 128 },
        { minX: -2, maxX: 2, minZ: -2, maxZ: 2, resolution: 64 },
      ],
      expected: 128,
    },
  ])(
    "matches actual leaf detail without changing base density: $name",
    async ({ regions, expected }) => {
      const f = await fixture(16, false, false, { fineDetailRegions: regions });
      const tree = f.manager.getQuadTree();
      const node = tree.createNode(null, null, 100, 0, 0, tree.config.maxDepth);
      expect(node.resolution).toBe(expected);
      let calls = 0;
      await f.manager.precompileRepresentativeChunk(0, 0, async (object) => {
        calls++;
        const geometry = (object as THREE.Mesh).geometry;
        // Away from all authored grades: exactly the original grid plus skirts.
        expect(geometry.getAttribute("position").count).toBe(
          expected ** 2 + 4 * expected,
        );
        expect(geometry.userData.terrainCellTopology).toBeUndefined();
      });
      expect(calls).toBe(1);
      expect(tree.config.resolution).toBe(16);
      expect(f.container.children).toHaveLength(0);
      expect(f.manager.getChunks().size).toBe(0);
    },
  );

  it.each(["dispose", "detail replacement"] as const)(
    "cancels actual pond precompile before publication on %s between slices",
    async (action) => {
      const f = await fixture(16, false, false, { selectedPond: true });
      const tree = f.manager.getQuadTree();
      let calls = 0,
        interrupted = false;
      const timer = setTimeout(() => {
        interrupted = true;
        if (action === "dispose") f.manager.dispose();
        else
          tree.config.fineDetailRegions = Object.freeze([
            ...tree.config.fineDetailRegions!,
          ]);
      }, 0);
      try {
        await expect(
          f.manager.precompileRepresentativeChunk(350, 340, async () => {
            calls++;
          }),
        ).rejects.toThrow(/disposed|changed/);
        expect(interrupted).toBe(true);
        expect(calls).toBe(0);
        expect(f.container.children).toHaveLength(0);
        expect(f.manager.getChunks().size).toBe(0);
      } finally {
        clearTimeout(timer);
      }
    },
  );
});
