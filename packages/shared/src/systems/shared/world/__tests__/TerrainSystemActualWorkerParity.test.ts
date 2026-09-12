import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import {
  QUAD_CHUNK_WORKER_CODE,
  type QuadChunkWorkerOutput,
} from "../../../../utils/workers/QuadChunkWorker";
import { TerrainSystem } from "../TerrainSystem";
import type { GrassWorkerSetup } from "../GrassVisualManager";
import type { FlatZone } from "../../../../types/world/terrain";
import {
  assembleQuadChunkGeometry,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";

type TerrainInternals = {
  flatZones: Map<string, FlatZone>;
  flatZonesByTile: Map<string, FlatZone[]>;
  arenaFloorZoneIds: Set<string>;
  initializeTerrainGenerator(): void;
  buildGrassWorkerSetup(): GrassWorkerSetup;
  buildChunkTerrainProvider(): FullTerrainProvider;
  loadFlatZonesFromManifest(): void;
  getHeightAtComputed(x: number, z: number): number;
  getFlatZoneHeight(x: number, z: number): number | null;
};

/** Executes production inline worker JS; only the browser message transport is adapted. */
function createActualWorker() {
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
    ${QUAD_CHUNK_WORKER_CODE}
    parentPort.on("message", data => self.onmessage({ data }));
  `,
    { eval: true, env: {} },
  );
  return {
    run(input: unknown): Promise<QuadChunkWorkerOutput> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => finish(new Error("Actual quad worker timeout")),
          5000,
        );
        const onError = (error: Error) => finish(error);
        const onMessage = (message: {
          result?: QuadChunkWorkerOutput;
          error?: string;
        }) =>
          finish(
            message.error ? new Error(message.error) : null,
            message.result,
          );
        function finish(error: Error | null, result?: QuadChunkWorkerOutput) {
          clearTimeout(timeout);
          worker.off("error", onError);
          worker.off("message", onMessage);
          if (error) reject(error);
          else resolve(result!);
        }
        worker.once("error", onError);
        worker.once("message", onMessage);
        worker.postMessage(input);
      });
    },
    close: () => worker.terminate(),
  };
}

describe("actual compact TerrainSystem biome/shore/worker integration", () => {
  it("replaces a moved same-ID zone without stale coordinates or duplicate index references", () => {
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    const original: FlatZone = {
      id: "replacement-grade",
      centerX: 175,
      centerZ: 225,
      width: 8,
      depth: 10,
      height: 22,
      blendRadius: 2,
    };
    terrain.registerFlatZone(original);
    const originalTiles = [...internals.flatZonesByTile.keys()];
    const moved = { ...original, centerX: 425, centerZ: 475, height: 31 };
    terrain.registerFlatZone(moved);
    terrain.registerFlatZone({ ...moved });
    expect(internals.flatZones.size).toBe(1);
    expect(
      internals.getFlatZoneHeight(original.centerX, original.centerZ),
    ).toBeNull();
    expect(
      terrain.getFlatZoneAt(original.centerX, original.centerZ),
    ).toBeNull();
    expect(internals.getFlatZoneHeight(moved.centerX, moved.centerZ)).toBe(
      moved.height,
    );
    for (const key of originalTiles)
      expect(
        internals.flatZonesByTile
          .get(key)
          ?.some((zone) => zone.id === moved.id) ?? false,
      ).toBe(false);
    for (const zones of internals.flatZonesByTile.values()) {
      expect(zones).toHaveLength(1);
      expect(zones[0]).toBe(internals.flatZones.get(moved.id));
      expect(zones[0]).toMatchObject(moved);
    }
  });

  it.each([
    [149.5, 249.5],
    [150.5, 250.5],
    [249.5, 349.5],
    [250.5, 350.5],
  ])("finds a narrow zone beside a centered tile boundary at %s,%s", (x, z) => {
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    const zone: FlatZone = {
      id: "boundary-grade",
      centerX: x,
      centerZ: z,
      width: 0.2,
      depth: 0.2,
      height: 24,
      blendRadius: 0,
    };
    terrain.registerFlatZone(zone);
    expect(terrain.getFlatZoneAt(x, z)).toBe(zone);
    expect(terrain.getFlatZoneAt(x + 0.11, z)).toBeNull();
    expect(terrain.getFlatZoneAt(x, z + 0.11)).toBeNull();
    terrain.unregisterFlatZone(zone.id);
    expect(terrain.getFlatZoneAt(x, z)).toBeNull();
    expect(internals.flatZonesByTile.size).toBe(0);
  });

  it("repeatedly loads the actual 19-zone manifest without duplicates or losing any of the three arena overlays", () => {
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    let indexedReferenceCount: number | null = null;
    for (let pass = 0; pass < 3; pass++) {
      internals.loadFlatZonesFromManifest();
      expect(internals.flatZones.size).toBe(19);
      expect(
        internals.flatZones.get("central_haven_lodge_grass_clearance"),
      ).toMatchObject({ excludeGrass: true, width: 10, depth: 12.06 });
      expect(internals.arenaFloorZoneIds.size).toBe(3);
      let references = 0;
      for (const zones of internals.flatZonesByTile.values()) {
        references += zones.length;
        expect(new Set(zones.map((zone) => zone.id)).size).toBe(zones.length);
        for (const zone of zones)
          expect(zone).toBe(internals.flatZones.get(zone.id));
      }
      if (indexedReferenceCount !== null)
        expect(references).toBe(indexedReferenceCount);
      indexedReferenceCount = references;
      for (const id of internals.arenaFloorZoneIds) {
        const floor = internals.flatZones.get(id)!;
        expect(
          internals.getFlatZoneHeight(floor.centerX, floor.centerZ),
          `${id} center after pass ${pass}`,
        ).toBe(floor.height);
        for (const dx of [-1, 1])
          for (const dz of [-1, 1]) {
            expect(
              internals.getFlatZoneHeight(
                floor.centerX + dx * (floor.width / 2 - 0.05),
                floor.centerZ + dz * (floor.depth / 2 - 0.05),
              ),
              `${id} corner after pass ${pass}`,
            ).toBe(floor.height);
          }
      }
    }
  });

  it("removes every centered spatial-index entry when an actual arena floor is unregistered", () => {
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    internals.loadFlatZonesFromManifest();
    const ids = [...internals.arenaFloorZoneIds];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(internals.flatZones.has(id)).toBe(true);
      terrain.unregisterFlatZone(id);
      expect(internals.arenaFloorZoneIds.has(id)).toBe(false);
      expect(internals.flatZones.has(id)).toBe(false);
      const ghosts = [...internals.flatZonesByTile]
        .filter(([, zones]) => zones.some((zone) => zone.id === id))
        .map(([key]) => key);
      expect(
        ghosts,
        `unregistered ${id} remains in centered terrain tiles`,
      ).toEqual([]);
    }
  });

  it("matches the real sculpted compact landform before grading, then assembles actual authored campus/pond/floor heights", async () => {
    expect(DataManager.getInstance().isReady()).toBe(true);
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    const setup = internals.buildGrassWorkerSetup();
    const provider = internals.buildChunkTerrainProvider();
    const profile = terrain.getWorldTerrainProfile();
    const resolution = setup.terrainConfig.TILE_RESOLUTION;
    const size = setup.tileSize;
    const samples: QuadChunkWorkerOutput[] = [];
    const worker = createActualWorker();
    let shoreCount = 0;
    let temperateBiomeCount = 0;
    let rawMaximumError = 0;
    let rawWorst = "";
    try {
      // Actual production resolution, eight regions spanning coast, authored
      // relief, preparation campus, arena platforms and pond. Mixed-biome
      // numeric coverage remains in TerrainProfileWorkerParity.test.ts.
      for (const [centerX, centerZ] of [
        [200, 250],
        [300, 350],
        [400, 350],
        [300, 450],
        [400, 450],
        [500, 550],
        [500, 400],
        [350, 550],
      ]) {
        const output = await worker.run({
          type: "generateQuadChunk",
          centerX,
          centerZ,
          size,
          resolution,
          config: setup.terrainConfig,
          seed: setup.seed,
          biomeCenters: setup.biomeCenters,
          biomes: setup.biomes,
        });
        samples.push(output);
        expect(output.terrainProfileIdentity).toBe(
          provider.terrainProfileIdentity,
        );
        for (let iz = 0; iz < resolution; iz++)
          for (let ix = 0; ix < resolution; ix++) {
            const x = centerX - size / 2 + (ix * size) / (resolution - 1);
            const z = centerZ - size / 2 + (iz * size) / (resolution - 1);
            const expected = Math.fround(internals.getHeightAtComputed(x, z));
            const actual = output.heightData[iz * resolution + ix];
            const error = Math.abs(actual - expected);
            if (error > rawMaximumError) {
              rawMaximumError = error;
              rawWorst = `at ${x},${z}: worker ${actual}, CPU ${expected}`;
            }
            const base = terrain.getProceduralHeightAt(x, z);
            if (
              base >
                profile.water.threshold - profile.shoreline.UNDERWATER_BAND &&
              base < profile.water.threshold + profile.shoreline.LAND_BAND
            )
              shoreCount++;
            if (terrain.computeBiomeWeightsByPosition(x, z).forest === 1)
              temperateBiomeCount++;
          }
      }
      expect(shoreCount).toBeGreaterThan(100);
      expect(temperateBiomeCount).toBe(
        resolution * resolution * samples.length,
      );
      expect(rawMaximumError, rawWorst).toBe(0);

      internals.loadFlatZonesFromManifest();
      let gradedVertices = 0;
      let finalMaximumError = 0;
      let finalWorst = "";
      for (const output of samples) {
        const original = output.heightData.slice();
        const assembled = assembleQuadChunkGeometry(output, provider, 3);
        try {
          const position = assembled.geometry.getAttribute("position");
          for (let iz = 0; iz < resolution; iz++)
            for (let ix = 0; ix < resolution; ix++) {
              const index = iz * resolution + ix;
              const x =
                output.centerX - size / 2 + (ix * size) / (resolution - 1);
              const z =
                output.centerZ - size / 2 + (iz * size) / (resolution - 1);
              if (internals.getFlatZoneHeight(x, z) !== null) gradedVertices++;
              const expected = Math.fround(internals.getHeightAtComputed(x, z));
              const error = Math.abs(assembled.heightData[index] - expected);
              if (error > finalMaximumError) {
                finalMaximumError = error;
                finalWorst = `at ${x},${z}: mesh ${assembled.heightData[index]}, CPU ${expected}`;
              }
              expect(position.getY(index)).toBe(assembled.heightData[index]);
            }
          expect(output.heightData).toEqual(original);
        } finally {
          assembled.geometry.dispose();
        }
      }
      expect(gradedVertices).toBeGreaterThan(1000);
      expect(finalMaximumError, finalWorst).toBe(0);
    } finally {
      await worker.close();
    }
  }, 20000);
});
