import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { BIOMES } from "../../../../data/world-structure";
import { isPositionInsideDuelArenaZone } from "../../../../data/duel-manifest";
import { EventType } from "../../../../types/events";
import {
  centeredTerrainTileIndex,
  type ResourceNode,
  type TerrainResourceSpawnBatch,
  type TerrainTile,
} from "../../../../types/world/terrain";
import { snapToTileCenter } from "../../movement/TileSystem";
import {
  generateCenteredTrees,
  generateTrees,
  validateTreeAnchor,
  type TreeGenerationSource,
} from "../BiomeResourceGenerator";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainSystem } from "../TerrainSystem";
import { getTreeConfigForBiome } from "../TerrainBiomeTypes";
import type { GrassWorkerSetup } from "../GrassVisualManager";
import {
  TERRAIN_WORKER_CODE,
  type TerrainWorkerOutput,
} from "../../../../utils/workers/TerrainWorker";

type Internals = {
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  subscribeRoadNetworkEvents(): void;
  createTreeGenerationSource(x: number, z: number): TreeGenerationSource;
  getBiomeAt(x: number, z: number): string;
  getBiomeAtWorldPosition(x: number, z: number): string;
  createTileRng(x: number, z: number, salt: string): () => number;
  generateTile(x: number, z: number, content: boolean): TerrainTile;
  generateTreesForTile(tile: TerrainTile): void;
  buildGrassWorkerSetup(): GrassWorkerSetup;
  createTileGeometryFromWorkerData(
    data: TerrainWorkerOutput,
  ): THREE.PlaneGeometry;
  createTileFromGeometryWithResources(
    x: number,
    z: number,
    geometry: THREE.PlaneGeometry,
    content: boolean,
  ): TerrainTile;
  runtimeIsServer: boolean;
};
const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});

async function fixture() {
  expect(DataManager.getInstance().isReady()).toBe(true);
  const world = new World();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  const internal = terrain as unknown as Internals;
  await terrain.init();
  internal.loadWaterBodiesFromManifest();
  internal.loadFlatZonesFromManifest();
  internal.subscribeRoadNetworkEvents();
  await roads.init();
  await roads.start();
  const size = terrain.tileSize;
  const source = (x: number, z: number) =>
    internal.createTreeGenerationSource(x, z);
  // Former generateTreesForTile input construction, independently retained from
  // TerrainSystem SHA91bcd604e2b2d711bb4ea9d7587ca25992a2535005807af100f0411e591b126d.
  // This does not call the new source factory: old tile biome/config, seeded key,
  // height cache sampler and per-position biome override are all explicit.
  const legacySource = (x: number, z: number): TreeGenerationSource => {
    const biome = internal.getBiomeAt(x, z);
    return {
      config: BIOMES[biome].trees ?? getTreeConfigForBiome(biome),
      context: {
        tileX: x,
        tileZ: z,
        tileKey: `${x}_${z}`,
        tileSize: size,
        waterThreshold: terrain.getWorldTerrainProfile().water.threshold,
        getHeightAt: terrain.getHeightAt.bind(terrain),
        getWaterSurfaceAt: (wx, wz) =>
          terrain.getWaterBodyRegistry().getWaterSurfaceAt(wx, wz),
        isOnRoad: roads.isOnRoad.bind(roads),
        createRng: (salt) => internal.createTileRng(x, z, salt),
        getDominantBiome: (wx, wz) => internal.getBiomeAtWorldPosition(wx, wz),
      },
    };
  };
  return { world, terrain, roads, internal, size, source, legacySource };
}

function legacyRecord(node: ResourceNode, x: number, z: number, size: number) {
  const position = snapToTileCenter({
    x: x * size + node.position.x,
    y: node.position.y,
    z: z * size + node.position.z,
  });
  return {
    candidateId: node.id,
    resourceId: `tree_${position.x.toFixed(0)}_${position.z.toFixed(0)}`,
    subType: node.subType,
    scale: node.scale,
    rotation: node.rotation,
    x: position.x,
    z: position.z,
  };
}

describe("actual compact centred resource tree placement", () => {
  it("keeps the seeded identity/species/transform census while assigning every safe anchor one centred owner", async () => {
    const { terrain, source, legacySource, size } = await fixture();
    const profile = terrain.getWorldTerrainProfile();
    const minX = centeredTerrainTileIndex(profile.bounds.minX, size);
    const maxX = centeredTerrainTileIndex(profile.bounds.maxX - 1e-6, size);
    const minZ = centeredTerrainTileIndex(profile.bounds.minZ, size);
    const maxZ = centeredTerrainTileIndex(profile.bounds.maxZ - 1e-6, size);
    const baseline = new Map<string, ReturnType<typeof legacyRecord>>();
    const baselineRejected = new Map<string, string>();
    let baselineCandidates = 0;
    let maximumAnchorHeightCorrection = 0;
    for (let x = minX - 1; x <= maxX; x++) {
      for (let z = minZ - 1; z <= maxZ; z++) {
        const input = source(x, z);
        const legacy = legacySource(x, z);
        for (const node of generateTrees(legacy.context, legacy.config)) {
          const record = legacyRecord(node, x, z, size);
          const tx = centeredTerrainTileIndex(record.x, size);
          const tz = centeredTerrainTileIndex(record.z, size);
          if (tx < minX || tx > maxX || tz < minZ || tz > maxZ) continue;
          baselineCandidates++;
          const admission = validateTreeAnchor(
            input,
            record.x,
            record.z,
            isPositionInsideDuelArenaZone,
          );
          maximumAnchorHeightCorrection = Math.max(
            maximumAnchorHeightCorrection,
            Math.abs(admission.position.y - node.position.y),
          );
          if (admission.rejection)
            baselineRejected.set(node.id, admission.rejection);
          else {
            expect(baseline.has(record.resourceId)).toBe(false);
            baseline.set(record.resourceId, record);
          }
        }
      }
    }
    const owners = [];
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) owners.push({ tileX: x, tileZ: z });
    }
    function census(order: typeof owners) {
      const records = new Map<string, ReturnType<typeof legacyRecord>>();
      const rejected = new Map<string, string>();
      let maximumOwnerCount = 0;
      for (const owner of order) {
        const requestedSources: Array<[number, number]> = [];
        const batch = generateCenteredTrees(
          owner,
          size,
          (x, z) => {
            requestedSources.push([x, z]);
            return source(x, z);
          },
          isPositionInsideDuelArenaZone,
        );
        expect(requestedSources).toEqual([
          [owner.tileX - 1, owner.tileZ - 1],
          [owner.tileX - 1, owner.tileZ],
          [owner.tileX, owner.tileZ - 1],
          [owner.tileX, owner.tileZ],
        ]);
        expect(batch.sourceCellsGenerated).toBe(4);
        // Actual unchanged forest budget is three candidates/source cell.
        expect(batch.sourceCandidates).toBeLessThanOrEqual(12);
        expect(batch.ownedCandidates).toBe(
          batch.resources.length + batch.rejected.length,
        );
        maximumOwnerCount = Math.max(maximumOwnerCount, batch.resources.length);
        for (const node of batch.resources) {
          const record = legacyRecord(node, owner.tileX, owner.tileZ, size);
          expect(centeredTerrainTileIndex(record.x, size)).toBe(owner.tileX);
          expect(centeredTerrainTileIndex(record.z, size)).toBe(owner.tileZ);
          expect(node.position.y).toBe(
            terrain.getResourceGroundHeight(record.x, record.z),
          );
          expect(node.position.x).toBeGreaterThanOrEqual(-size / 2);
          expect(node.position.x).toBeLessThan(size / 2);
          expect(node.position.z).toBeGreaterThanOrEqual(-size / 2);
          expect(node.position.z).toBeLessThan(size / 2);
          expect(records.has(record.resourceId)).toBe(false);
          records.set(record.resourceId, record);
        }
        for (const item of batch.rejected) {
          expect(rejected.has(item.id)).toBe(false);
          rejected.set(item.id, item.reason);
        }
      }
      return { records, rejected, maximumOwnerCount };
    }
    const forward = census(owners);
    const reverse = census([...owners].reverse());
    // Actual admitted compact manifest census, not render-batch/tree-mesh count.
    expect(baseline.size).toBe(8);
    expect(forward.records).toEqual(baseline);
    expect(reverse.records).toEqual(baseline);
    expect(forward.rejected).toEqual(baselineRejected);
    expect(reverse.rejected).toEqual(baselineRejected);
    expect(forward.records.size + forward.rejected.size).toBe(
      baselineCandidates,
    );
    const species: Record<string, number> = {};
    for (const record of forward.records.values()) {
      species[record.subType ?? "normal"] =
        (species[record.subType ?? "normal"] ?? 0) + 1;
    }
    console.info(
      "[CenteredTreePlacement census]",
      JSON.stringify({
        profile: profile.id,
        sourceCellsPerOwner: 4,
        owners: owners.length,
        baselineCandidates,
        retained: forward.records.size,
        rejected: [...forward.rejected],
        species,
        maximumOwnerCount: forward.maximumOwnerCount,
        maximumAnchorHeightCorrection,
        identities: [...forward.records.values()],
      }),
    );
  });

  it("publishes the same owned candidates through actual transferred worker geometry and synchronous tile assembly", async () => {
    const sync = await fixture();
    const assembled = await fixture();
    const setup = assembled.internal.buildGrassWorkerSetup();
    // Select a genuinely populated admitted tile; the arena-centre tile is empty.
    const profile = sync.terrain.getWorldTerrainProfile();
    const owners = [];
    for (
      let x = centeredTerrainTileIndex(profile.bounds.minX, sync.size);
      x <= centeredTerrainTileIndex(profile.bounds.maxX - 1e-6, sync.size);
      x++
    ) {
      for (
        let z = centeredTerrainTileIndex(profile.bounds.minZ, sync.size);
        z <= centeredTerrainTileIndex(profile.bounds.maxZ - 1e-6, sync.size);
        z++
      )
        owners.push({ tileX: x, tileZ: z });
    }
    const owner = owners.find(
      (candidate) =>
        generateCenteredTrees(
          candidate,
          sync.size,
          sync.source,
          isPositionInsideDuelArenaZone,
        ).resources.length > 0,
    );
    if (!owner)
      throw new Error("Actual compact terrain has no populated resource owner");
    const worker = new Worker(
      `
      const { parentPort } = require("node:worker_threads");
      globalThis.self = { postMessage: (value, transfers) => parentPort.postMessage(value, transfers) };
      ${TERRAIN_WORKER_CODE}
      parentPort.on("message", data => self.onmessage({ data }));
    `,
      { eval: true, env: {} },
    );
    try {
      const data = await new Promise<TerrainWorkerOutput>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Actual resource terrain worker timed out")),
          5000,
        );
        worker.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.once(
          "message",
          (message: { result: TerrainWorkerOutput; error?: string }) => {
            clearTimeout(timer);
            if (message.error) reject(new Error(message.error));
            else resolve(message.result);
          },
        );
        worker.postMessage({
          type: "generateHeightmap",
          tileX: owner.tileX,
          tileZ: owner.tileZ,
          config: setup.terrainConfig,
          seed: setup.seed,
          biomeCenters: setup.biomeCenters,
          biomes: setup.biomes,
        });
      });
      expect(data.heightData).toBeInstanceOf(Float32Array);
      expect(data.heightData.length).toBe(
        setup.terrainConfig.TILE_RESOLUTION ** 2,
      );
      const syncBatches: TerrainResourceSpawnBatch[] = [];
      const workerBatches: TerrainResourceSpawnBatch[] = [];
      sync.world.on(
        EventType.RESOURCE_SPAWN_POINTS_REGISTERED,
        (batch: TerrainResourceSpawnBatch) => syncBatches.push(batch),
      );
      assembled.world.on(
        EventType.RESOURCE_SPAWN_POINTS_REGISTERED,
        (batch: TerrainResourceSpawnBatch) => workerBatches.push(batch),
      );
      sync.internal.runtimeIsServer = true;
      assembled.internal.runtimeIsServer = true;
      const syncTile = sync.internal.generateTile(
        owner.tileX,
        owner.tileZ,
        true,
      );
      const geometry =
        assembled.internal.createTileGeometryFromWorkerData(data);
      const workerTile = assembled.internal.createTileFromGeometryWithResources(
        owner.tileX,
        owner.tileZ,
        geometry,
        true,
      );
      expect(workerTile.resources).toEqual(syncTile.resources);
      expect(workerBatches).toEqual(syncBatches);
      expect(workerBatches).toHaveLength(1);
      expect(workerBatches[0].owner).toEqual(owner);
      expect(workerBatches[0].spawnPoints.length).toBeGreaterThan(0);
    } finally {
      await worker.terminate();
    }
  });

  it("grounds final snapped anchors on actual slopes and rejects actual roads, elevated water and arena floors", async () => {
    const { terrain, source, roads } = await fixture();
    const input = source(3, 3);
    expect(roads.isOnRoad(348.5, 321.5)).toBe(true);
    expect(validateTreeAnchor(input, 348.05, 321.02).rejection).toBe("road");
    const pond = validateTreeAnchor(input, 343.12, 302.19);
    expect(pond.rejection).toBe("water");
    expect(pond.position.y).toBe(terrain.getResourceGroundHeight(343.5, 302.5));
    expect(
      validateTreeAnchor(input, 350.12, 406.19, isPositionInsideDuelArenaZone)
        .rejection,
    ).toBe("excluded");
    const hillside = validateTreeAnchor(input, 280.04, 400.03);
    expect(hillside.rejection).toBeNull();
    expect(hillside.position).toEqual({
      x: 280.5,
      y: terrain.getResourceGroundHeight(280.5, 400.5),
      z: 400.5,
    });
    expect(
      Math.abs(
        hillside.position.y - terrain.getResourceGroundHeight(280.04, 400.03),
      ),
    ).toBeGreaterThan(0.001);
    // Strict but valid tree slope policy on the same real terrain, no sampler stubs.
    expect(
      validateTreeAnchor(
        { ...input, config: { ...input.config, maxSlope: 0.001 } },
        280.04,
        400.03,
      ).rejection,
    ).toBe("slope");
    expect(validateTreeAnchor(input, NaN, 400).rejection).toBe("non_finite");
    // Count real sampler calls, without substituting its returned values.
    let heightQueries = 0;
    const counted = {
      ...input,
      context: {
        ...input.context,
        getHeightAt: (x: number, z: number) => {
          heightQueries++;
          return input.context.getHeightAt(x, z);
        },
      },
    };
    expect(validateTreeAnchor(counted, 280.04, 400.03)).toEqual(hillside);
    expect(heightQueries).toBe(5); // centre plus four one-metre slope samples
  });

  it("keeps source candidates independent of resident height caches and emits empty full-content owner batches", async () => {
    const { world, terrain, internal, source, size } = await fixture();
    const before = generateCenteredTrees(
      { tileX: 3, tileZ: 3 },
      size,
      source,
      isPositionInsideDuelArenaZone,
    );
    expect(before.resources.length).toBeGreaterThan(0);
    const batches: TerrainResourceSpawnBatch[] = [];
    world.on(
      EventType.RESOURCE_SPAWN_POINTS_REGISTERED,
      (batch: TerrainResourceSpawnBatch) => batches.push(batch),
    );
    // Actual tile construction, but do not start physics, workers or a renderer.
    internal.generateTile(3, 3, false);
    internal.generateTile(3, 2, false);
    expect(batches).toHaveLength(0);
    expect(
      generateCenteredTrees(
        { tileX: 3, tileZ: 3 },
        size,
        source,
        isPositionInsideDuelArenaZone,
      ),
    ).toEqual(before);
    // Drive the real server-content branch without installing a fake network.
    internal.runtimeIsServer = true;
    internal.generateTile(0, 0, true);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({
      owner: { tileX: 0, tileZ: 0 },
      spawnPoints: [],
    });
    expect(terrain.getTiles().get("0_0")?.contentGenerated).toBe(true);
  });

  it("uses the centred contract at positive/negative half-tile seams", () => {
    for (const [coordinate, expected] of [
      [-150.5, -2],
      [-150, -1],
      [-50.5, -1],
      [-50, 0],
      [49.5, 0],
      [50, 1],
      [149.5, 1],
      [150, 2],
    ])
      expect(centeredTerrainTileIndex(coordinate, 100)).toBe(expected);
  });
});
