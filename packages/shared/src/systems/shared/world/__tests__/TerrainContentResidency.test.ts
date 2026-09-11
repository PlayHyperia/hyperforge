import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { PlayerEntity } from "../../../../entities/player/PlayerEntity";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { EventType } from "../../../../types/events";
import type { Resource } from "../../../../types/core/core";
import type {
  TerrainResourceSpawnBatch,
  TerrainTile,
} from "../../../../types/world/terrain";
import {
  TERRAIN_WORKER_CODE,
  type TerrainWorkerOutput,
} from "../../../../utils/workers/TerrainWorker";
import { EntityManager } from "../../entities/EntityManager";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import type { GrassWorkerSetup } from "../GrassVisualManager";

// Actual CPU engine classes and native worker execution; no renderer, socket,
// persistence replacement or fabricated GPU. Only the server role is selected.
class CpuServerWorld extends World {
  override get isServer(): boolean {
    return true;
  }
}
type TerrainInternals = {
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  worldToTerrainTileIndex(x: number): number;
  generateTile(x: number, z: number, content: boolean): TerrainTile;
  createTileGeometry(x: number, z: number): THREE.PlaneGeometry;
  createTileFromGeometryWithResources(
    x: number,
    z: number,
    geometry: THREE.PlaneGeometry,
    content: boolean,
  ): TerrainTile;
  bakeWalkabilityFlags(x: number, z: number): void;
  unloadTile(tile: TerrainTile): void;
  promoteTileContent(tile: TerrainTile): boolean;
  enqueueTileForGeneration(x: number, z: number, content: boolean): void;
  processTileGenerationQueue(): void;
  updatePlayerBasedTerrain(): void;
  prunePendingTileQueue(
    needed: ReadonlySet<string>,
    content?: ReadonlySet<string>,
  ): void;
  buildGrassWorkerSetup(): GrassWorkerSetup;
  acceptTerrainWorkerResult(
    result: TerrainWorkerOutput,
    generation: object | undefined,
  ): void;
  pendingContentPromotions: Map<string, TerrainTile>;
  pendingTileGenerations: Map<string, object>;
  pendingTileContent: Map<string, boolean>;
  pendingTileKeys: string[];
  pendingWorkerResults: Map<string, TerrainWorkerOutput>;
  pendingWorkerTileKeys: Set<string>;
  workerFallbackTileKeys: Set<string>;
  runtimeIsClient: boolean;
  maxTilesPerFrame: number;
  generationBudgetMsPerFrame: number;
};
type ResourceInternals = {
  initializeWorldAreaResources(): Promise<void>;
  terrainResourceTails: Map<string, Promise<void>>;
  resources: Map<string, Resource>;
  respawnAtTick: Map<string, number>;
};
const worlds: World[] = [];
beforeAll(async () => {
  await DataManager.getInstance().initialize();
});
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
async function fixture() {
  const world = new CpuServerWorld();
  worlds.push(world);
  const manager = world.register(
    "entity-manager",
    EntityManager,
  ) as EntityManager;
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  const resources = world.register(
    "resource",
    ResourceSystem,
  ) as ResourceSystem;
  const internal = terrain as unknown as TerrainInternals;
  const resourceInternal = resources as unknown as ResourceInternals;
  await terrain.init();
  internal.loadWaterBodiesFromManifest();
  internal.loadFlatZonesFromManifest();
  await roads.init();
  await roads.start();
  await resources.init();
  const batches: TerrainResourceSpawnBatch[] = [];
  world.on(
    EventType.RESOURCE_SPAWN_POINTS_REGISTERED,
    (batch: TerrainResourceSpawnBatch) => batches.push(batch),
  );
  const settle = async () => {
    await Promise.all([...resourceInternal.terrainResourceTails.values()]);
  };
  const addPlayer = (x: number, z: number) => {
    const player = new PlayerEntity(world, {
      id: "residency-player",
      name: "Residency player",
      type: "player",
      position: [x, terrain.getResourceGroundHeight(x, z), z],
      quaternion: [0, 0, 0, 1],
    });
    world.entities.set(player.id, player);
    return player;
  };
  return {
    world,
    manager,
    terrain,
    internal,
    resources,
    resourceInternal,
    batches,
    settle,
    addPlayer,
  };
}
const proceduralIds = [
  "tree_335_266",
  "tree_311_295",
  "tree_377_288",
  "tree_289_508",
  "tree_281_518",
  "tree_281_513",
  "tree_503_432",
  "tree_502_419",
].sort();
const authoredIds = [
  "tree_367_311",
  "tree_373_313",
  "tree_379_311",
  "tree_379_304",
  "tree_375_299",
].sort();

/** Real generated worker JS, native Promise and transferred Float32 output. */
function workerJob(setup: GrassWorkerSetup, tileX: number, tileZ: number) {
  const worker = new Worker(
    `
    const {parentPort}=require("node:worker_threads");
    globalThis.self={postMessage:(value,transfers)=>parentPort.postMessage(value,transfers)};
    ${TERRAIN_WORKER_CODE}
    parentPort.on("message",data=>self.onmessage({data}));
  `,
    { eval: true, env: {} },
  );
  const result = new Promise<TerrainWorkerOutput>((resolve, reject) => {
    worker.once("error", reject);
    worker.once(
      "message",
      (message: { result: TerrainWorkerOutput; error?: string }) => {
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      },
    );
    worker.postMessage({
      type: "generateHeightmap",
      tileX,
      tileZ,
      config: setup.terrainConfig,
      seed: setup.seed,
      biomeCenters: setup.biomeCenters,
      biomes: setup.biomes,
    });
  });
  return { result, close: () => worker.terminate() };
}

describe("actual terrain content residency", () => {
  it("starts the real lobby core with all13 admitted trees, retaining terrain-only preload and no repeated spawn", async () => {
    const f = await fixture();
    await f.terrain.start();
    await f.settle();
    await f.resourceInternal.initializeWorldAreaResources();
    await f.settle();
    expect(f.internal.worldToTerrainTileIndex(385)).toBe(4);
    expect(f.internal.worldToTerrainTileIndex(374)).toBe(4);
    const tiles = [...f.terrain.getTiles().values()];
    expect(tiles).toHaveLength(25);
    expect(tiles.filter((t) => t.contentGenerated)).toHaveLength(9);
    expect(tiles.filter((t) => !t.contentGenerated)).toHaveLength(16);
    for (const tile of tiles)
      expect(tile.contentGenerated).toBe(
        tile.x >= 3 && tile.x <= 5 && tile.z >= 3 && tile.z <= 5,
      );
    const trees = () =>
      f.resources
        .getAllResources()
        .filter((r) => r.type === "tree")
        .map((r) => r.id)
        .sort();
    expect(trees()).toEqual([...proceduralIds, ...authoredIds].sort());
    const entities = trees().map((id) => f.manager.getEntity(id));
    for (const entity of entities)
      expect(entity).toBeInstanceOf(ResourceEntity);
    const count = f.batches.length;
    f.internal.updatePlayerBasedTerrain();
    f.internal.processTileGenerationQueue();
    await f.settle();
    expect(f.batches).toHaveLength(count);
    expect(f.internal.pendingContentPromotions.size).toBe(0);
    expect(trees().map((id) => f.manager.getEntity(id))).toEqual(entities);
    // Before correction the actual startup core2..4 produced only3 procedural
    // plus5 authored. This is a declared8→13 live population change, not free rendering.
    expect(proceduralIds).toHaveLength(8);
  });

  it("uses centered half-open ownership in actual movement demand at positive and negative seams", async () => {
    const f = await fixture();
    const player = f.addPlayer(0, 0);
    for (const [coordinate, expected] of [
      [-150.001, -2],
      [-150, -1],
      [-50.001, -1],
      [-50, 0],
      [49.999, 0],
      [50, 1],
      [149.999, 1],
      [150, 2],
    ]) {
      player.node.position.set(coordinate, 0, coordinate);
      f.internal.updatePlayerBasedTerrain();
      expect(f.internal.worldToTerrainTileIndex(coordinate)).toBe(expected);
      const core = f.terrain
        .getChunkSimulationStatus()
        .playerChunks.get(player.id)!;
      expect(core.size).toBe(9);
      expect([...core].sort()).toEqual(
        Array.from({ length: 3 }, (_, dx) =>
          Array.from(
            { length: 3 },
            (_, dz) => `${expected + dx - 1}_${expected + dz - 1}`,
          ),
        )
          .flat()
          .sort(),
      );
      expect(f.internal.pendingTileContent.get(`${expected}_${expected}`)).toBe(
        true,
      );
      expect(
        f.internal.pendingTileContent.get(`${expected + 2}_${expected}`),
      ).toBe(false);
    }
  });

  it("promotes only the entered core once under the count budget, preserving tile and depleted resource identity", async () => {
    const f = await fixture();
    const player = f.addPlayer(300, 300);
    const tile = f.internal.generateTile(3, 5, false);
    const other = f.internal.generateTile(5, 4, false);
    const refs = [
      tile.mesh,
      tile.mesh.geometry,
      tile.mesh.material,
      tile.collision,
      tile.collider,
      tile.heightData,
    ];
    f.internal.updatePlayerBasedTerrain();
    expect(f.internal.pendingContentPromotions.size).toBe(0);
    player.node.position.set(400, 0, 400);
    f.internal.updatePlayerBasedTerrain();
    expect(f.internal.pendingContentPromotions.size).toBe(2);
    f.internal.maxTilesPerFrame = 1;
    f.internal.generationBudgetMsPerFrame = 1000;
    f.internal.processTileGenerationQueue();
    expect([tile, other].filter((t) => t.contentGenerated)).toHaveLength(1);
    expect(f.internal.pendingContentPromotions.size).toBe(1);
    f.internal.processTileGenerationQueue();
    await f.settle();
    expect(tile.contentGenerated).toBe(true);
    expect(other.contentGenerated).toBe(true);
    expect([
      tile.mesh,
      tile.mesh.geometry,
      tile.mesh.material,
      tile.collision,
      tile.collider,
      tile.heightData,
    ]).toEqual(refs);
    expect(
      f.resources
        .getAllResources()
        .filter((r) => r.type === "tree")
        .map((r) => r.id)
        .sort(),
    ).toEqual(
      [
        "tree_289_508",
        "tree_281_518",
        "tree_281_513",
        "tree_503_432",
        "tree_502_419",
      ].sort(),
    );
    const id = "tree_289_508";
    const resource = f.resourceInternal.resources.get(id)!;
    const entity = f.manager.getEntity(id) as ResourceEntity;
    resource.isAvailable = false;
    resource.lastDepleted = Date.now();
    f.resourceInternal.respawnAtTick.set(id, 1234);
    entity.updateFromNetwork({ depleted: true });
    const nodes = tile.resources;
    const count = f.batches.length;
    for (let i = 0; i < 3; i++) {
      f.internal.enqueueTileForGeneration(3, 5, true);
      expect(f.internal.generateTile(3, 5, true)).toBe(tile);
      expect(f.internal.promoteTileContent(tile)).toBe(false);
    }
    await f.settle();
    expect(f.batches).toHaveLength(count);
    expect(tile.resources).toBe(nodes);
    expect(f.resourceInternal.resources.get(id)).toBe(resource);
    expect(resource.isAvailable).toBe(false);
    expect(f.resourceInternal.respawnAtTick.get(id)).toBe(1234);
    expect(f.manager.getEntity(id)).toBe(entity);
    expect(entity.config.depleted).toBe(true);
  });

  it("retires queued promotions on leaving the core, unload/reload and destroy; empty content emits only once", async () => {
    const f = await fixture();
    const old = f.internal.generateTile(3, 5, false);
    f.internal.enqueueTileForGeneration(3, 5, true);
    f.internal.prunePendingTileQueue(new Set([old.key]), new Set());
    f.internal.processTileGenerationQueue();
    expect(old.contentGenerated).toBe(false);
    f.internal.enqueueTileForGeneration(3, 5, true);
    f.internal.unloadTile(old);
    const next = f.internal.generateTile(3, 5, false);
    expect(next).not.toBe(old);
    expect(f.internal.promoteTileContent(old)).toBe(false);
    f.internal.unloadTile(old);
    expect(f.terrain.getTiles().get(next.key)).toBe(next);
    f.internal.processTileGenerationQueue();
    expect(next.contentGenerated).toBe(false);
    const empty = f.internal.generateTile(0, 0, false);
    f.internal.generateTile(0, 0, true); // direct existing-tile request also stays bounded
    expect(empty.contentGenerated).toBe(false);
    f.internal.processTileGenerationQueue();
    expect(f.batches).toEqual([
      { owner: { tileX: 0, tileZ: 0 }, spawnPoints: [] },
    ]);
    expect(empty.contentGenerated).toBe(true);
    expect(f.internal.promoteTileContent(empty)).toBe(false);
    f.internal.enqueueTileForGeneration(3, 5, true);
    f.terrain.destroy();
    f.internal.processTileGenerationQueue();
    expect(f.internal.promoteTileContent(next)).toBe(false);
    expect(f.internal.pendingContentPromotions.size).toBe(0);
    expect(f.batches).toHaveLength(1);
    await f.settle();
  });

  it("cannot publish a resource batch after a real synchronous tile listener unloads its owner", async () => {
    const f = await fixture();
    const tile = f.internal.generateTile(3, 5, false);
    f.world.on(
      EventType.TERRAIN_TILE_GENERATED,
      (data: { tileX: number; tileZ: number; contentGenerated?: boolean }) => {
        if (data.tileX === 3 && data.tileZ === 5 && data.contentGenerated)
          f.internal.unloadTile(tile);
      },
    );
    f.internal.enqueueTileForGeneration(3, 5, true);
    f.internal.processTileGenerationQueue();
    await f.settle();
    expect(f.batches).toHaveLength(0);
    expect(f.terrain.getTiles().has(tile.key)).toBe(false);
    expect(f.resources.getAllResources()).toHaveLength(0);
  });

  for (const assembly of ["sync", "worker"] as const) {
    for (const retire of ["unload", "destroy"] as const) {
      it(`${assembly} fresh assembly stops height/collision writes after a listener's ${retire}`, async () => {
        const f = await fixture();
        let bakeCalls = 0;
        const originalBake = f.internal.bakeWalkabilityFlags;
        // Count calls while retaining the actual numerical/collision operation.
        f.internal.bakeWalkabilityFlags = function (x, z) {
          bakeCalls++;
          return originalBake.call(this, x, z);
        };
        f.world.on(
          EventType.TERRAIN_TILE_GENERATED,
          (data: { tileX: number; tileZ: number }) => {
            if (data.tileX !== 3 || data.tileZ !== 5) return;
            const owner = f.terrain.getTiles().get("3_5")!;
            if (retire === "unload") f.internal.unloadTile(owner);
            else f.terrain.destroy();
          },
        );
        const tile =
          assembly === "sync"
            ? f.internal.generateTile(3, 5, true)
            : f.internal.createTileFromGeometryWithResources(
                3,
                5,
                f.internal.createTileGeometry(3, 5),
                true,
              );
        await f.settle();
        expect(tile.heightData).toEqual([]);
        expect(bakeCalls).toBe(0);
        expect(f.batches).toHaveLength(0);
        expect(f.terrain.getTiles().has("3_5")).toBe(false);
        expect(f.resources.getAllResources()).toHaveLength(0);
      });
    }
  }

  it("upgrades an actual in-flight worker geometry job without duplicate work or losing final intent", async () => {
    const f = await fixture();
    f.internal.runtimeIsClient = true; // queue scheduler only; never initialize a browser/GPU
    f.internal.enqueueTileForGeneration(3, 5, false);
    const generation = f.internal.pendingTileGenerations.get("3_5");
    const job = workerJob(f.internal.buildGrassWorkerSetup(), 3, 5);
    try {
      f.internal.enqueueTileForGeneration(3, 5, true);
      expect(f.internal.pendingTileKeys).toEqual(["3_5"]);
      f.internal.processTileGenerationQueue();
      expect(f.terrain.getTiles().size).toBe(0);
      const output = await job.result;
      expect(output.heightData).toBeInstanceOf(Float32Array);
      f.internal.acceptTerrainWorkerResult(output, generation);
      f.internal.runtimeIsClient = false; // actual server content path, no visual substitute
      f.internal.processTileGenerationQueue();
      await f.settle();
      expect(f.terrain.getTiles().get("3_5")?.contentGenerated).toBe(true);
      expect(f.batches).toHaveLength(1);
      expect(f.batches[0].spawnPoints).toHaveLength(3);
      expect(f.internal.pendingTileGenerations.size).toBe(0);
      f.internal.acceptTerrainWorkerResult(output, generation);
      expect(f.internal.pendingWorkerResults.size).toBe(0);
    } finally {
      await job.close();
    }
  });

  it("rejects old native worker completion after cancellation and same-key requeue, while permitting the current job", async () => {
    const f = await fixture();
    f.internal.runtimeIsClient = true;
    f.internal.enqueueTileForGeneration(3, 5, true);
    const oldGeneration = f.internal.pendingTileGenerations.get("3_5");
    const oldJob = workerJob(f.internal.buildGrassWorkerSetup(), 3, 5);
    let nextJob: ReturnType<typeof workerJob> | undefined;
    try {
      f.internal.prunePendingTileQueue(new Set());
      f.internal.enqueueTileForGeneration(3, 5, false);
      const nextGeneration = f.internal.pendingTileGenerations.get("3_5");
      expect(nextGeneration).not.toBe(oldGeneration);
      nextJob = workerJob(f.internal.buildGrassWorkerSetup(), 3, 5);
      f.internal.acceptTerrainWorkerResult(await oldJob.result, oldGeneration);
      expect(f.internal.pendingWorkerResults.size).toBe(0);
      expect(f.internal.pendingWorkerTileKeys.has("3_5")).toBe(true);
      const output = await nextJob.result;
      f.internal.acceptTerrainWorkerResult(output, nextGeneration);
      f.internal.runtimeIsClient = false;
      f.internal.processTileGenerationQueue();
      expect(f.terrain.getTiles().get("3_5")?.contentGenerated).toBe(false);
      expect(f.batches).toHaveLength(0);
      f.terrain.destroy();
      f.internal.acceptTerrainWorkerResult(output, nextGeneration);
      expect(f.internal.pendingWorkerResults.size).toBe(0);
    } finally {
      await oldJob.close();
      await nextJob?.close();
    }
  });

  it("demotes in-flight content intent when the tile remains in the preload ring, then promotes the same geometry on re-entry", async () => {
    const f = await fixture();
    f.internal.runtimeIsClient = true;
    f.internal.enqueueTileForGeneration(3, 5, true);
    const generation = f.internal.pendingTileGenerations.get("3_5");
    const job = workerJob(f.internal.buildGrassWorkerSetup(), 3, 5);
    try {
      f.internal.prunePendingTileQueue(new Set(["3_5"]), new Set());
      expect(f.internal.pendingTileContent.get("3_5")).toBe(false);
      f.internal.acceptTerrainWorkerResult(await job.result, generation);
      f.internal.runtimeIsClient = false;
      f.internal.processTileGenerationQueue();
      const tile = f.terrain.getTiles().get("3_5")!;
      const geometry = tile.mesh.geometry;
      expect(tile.contentGenerated).toBe(false);
      expect(f.batches).toHaveLength(0);
      f.internal.enqueueTileForGeneration(3, 5, true);
      f.internal.processTileGenerationQueue();
      await f.settle();
      expect(tile.contentGenerated).toBe(true);
      expect(tile.mesh.geometry).toBe(geometry);
      expect(f.batches).toHaveLength(1);
    } finally {
      await job.close();
    }
  });

  it("does not let an old native worker-unavailable Promise clear a newer same-key request", async () => {
    const f = await fixture();
    // Actual production server-runtime worker availability returns false. Its
    // native async fallback still must respect cancellation/requeue ownership.
    f.internal.runtimeIsClient = true;
    f.internal.enqueueTileForGeneration(3, 5, false);
    const pending = f.terrain.precomputeTilesWithWorker([
      { tileX: 3, tileZ: 5 },
    ]);
    f.internal.prunePendingTileQueue(new Set());
    f.internal.enqueueTileForGeneration(3, 5, true);
    await pending;
    expect(f.internal.pendingWorkerTileKeys.has("3_5")).toBe(true);
    expect(f.internal.workerFallbackTileKeys.has("3_5")).toBe(false);
    expect(f.internal.pendingTileContent.get("3_5")).toBe(true);
  });
});
