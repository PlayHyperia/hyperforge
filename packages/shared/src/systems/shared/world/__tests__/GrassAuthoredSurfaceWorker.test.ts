import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import {
  createGrassTerrainSurfaceSnapshot,
  type GrassTerrainSurfaceZone,
} from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { TerrainSystem } from "../TerrainSystem";
import {
  TERRAIN_SHADER_CONSTANTS,
  computeTerrainColorCPU,
} from "../TerrainShader";
import { adjustShorelineHeight } from "../TerrainHeightParams";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import type { GrassWorkerSetup } from "../GrassVisualManager";

type Internals = {
  flatZones: Map<string, GrassTerrainSurfaceZone>;
  arenaFloorZoneIds: Set<string>;
  arenaGradeHeight: number | null;
  buildGrassWorkerSetup(): GrassWorkerSetup;
  loadFlatZonesFromManifest(): void;
  loadWaterBodiesFromManifest(): void;
  getHeightAtComputed(x: number, z: number): number;
};

const attributes = {
  offsets: 3,
  rotScaleHash: 3,
  groundColors: 3,
  grassTints: 4,
  groundNormals: 3,
} as const;

type TransferReceipt = {
  before: number[];
  after: number[];
  unique: number;
};

/** Production worker code; only browser message transport is adapted to Node. */
function actualWorker() {
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    globalThis.self = { postMessage(message, transfers = []) {
      const before = transfers.map(buffer => buffer.byteLength);
      const unique = new Set(transfers).size;
      parentPort.postMessage(message, transfers);
      parentPort.postMessage({ receipt: {
        before, unique, after: transfers.map(buffer => buffer.byteLength)
      } });
    } };
    ${GRASS_WORKER_CODE}
    parentPort.on("message", data => self.onmessage({ data }));
  `,
    { eval: true, env: {} },
  );
  return {
    run(input: GrassWorkerInput): Promise<GrassWorkerOutput> {
      return new Promise((resolve, reject) => {
        let result: GrassWorkerOutput | undefined;
        let receipt: TransferReceipt | undefined;
        const timeout = setTimeout(
          () => finish(new Error("Actual grass worker timed out")),
          10000,
        );
        const onError = (error: Error) => finish(error);
        const onMessage = (message: {
          result?: GrassWorkerOutput;
          error?: string;
          receipt?: TransferReceipt;
        }) => {
          if (message.error) return finish(new Error(message.error));
          if (message.result) result = message.result;
          if (message.receipt) receipt = message.receipt;
          if (!result || !receipt) return;
          try {
            expect(receipt.unique).toBe(result.count ? 5 : 0);
            expect(receipt.before).toHaveLength(result.count ? 5 : 0);
            expect(receipt.before.every((size) => size > 0)).toBe(true);
            expect(receipt.after.every((size) => size === 0)).toBe(true);
            expect(result.terrainProfileIdentity).toBe(
              input.config.TERRAIN_PROFILE_IDENTITY,
            );
            expect(result.chunkKey).toBe(input.chunkKey);
            for (const [name, stride] of Object.entries(attributes)) {
              const array = result[name as keyof typeof attributes];
              expect(array).toBeInstanceOf(Float32Array);
              expect(array).toHaveLength(result.count * stride);
              expect(array.every(Number.isFinite)).toBe(true);
            }
            finish(null);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        };
        function finish(error: Error | null) {
          clearTimeout(timeout);
          worker.off("message", onMessage);
          worker.off("error", onError);
          if (error) reject(error);
          else resolve(result!);
        }
        worker.on("message", onMessage);
        worker.once("error", onError);
        worker.postMessage(input);
      });
    },
    close: () => worker.terminate(),
  };
}

async function withTerrain(
  execute: (
    terrain: TerrainSystem,
    internals: Internals,
    worker: ReturnType<typeof actualWorker>,
  ) => Promise<void>,
) {
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const worker = actualWorker();
  try {
    await terrain.init();
    await execute(terrain, terrain as unknown as Internals, worker);
  } finally {
    await worker.close();
    world.destroy();
  }
}

function request(
  terrain: TerrainSystem,
  internals: Internals,
  centerX: number,
  centerZ: number,
  size: number,
): GrassWorkerInput {
  const setup = internals.buildGrassWorkerSetup();
  return {
    type: "generateGrassInstances",
    chunkKey: `${centerX}_${centerZ}_${size}`,
    centerX,
    centerZ,
    size,
    spacingMul: 1,
    config: setup.terrainConfig,
    seed: setup.seed,
    biomeCenters: setup.biomeCenters,
    biomes: setup.biomes,
    grassSeed: 37,
    clumpSpacing: 0.5,
    scaleMin: 0.8,
    scaleMax: 1.2,
    waterThreshold: setup.terrainConfig.WATER_THRESHOLD,
    // Valid deliberately permissive vegetation policy, not replacement terrain.
    // Keep real shader weights, translated biomes and native random placement.
    grassConfigs: Object.fromEntries(
      Object.entries(setup.grassConfigs).map(([key, config]) => [
        key,
        {
          ...config,
          density: 1,
          maxSlope: 1,
          minGrassWeight: 0,
          patchiness: 0,
        },
      ]),
    ),
    shaderConstants: TERRAIN_SHADER_CONSTANTS,
    roadSegments: [],
    roadBlendWidth: 0,
    tileSize: setup.tileSize,
    terrainSurface: createGrassTerrainSurfaceSnapshot({
      zones: [...internals.flatZones.values()],
      arenaFloorIds: [...internals.arenaFloorZoneIds],
      arenaGradeHeight: internals.arenaGradeHeight,
      waterBodies: terrain.getWaterBodyRegistry().getAllBodies(),
    }),
  };
}

function points(input: GrassWorkerInput, result: GrassWorkerOutput) {
  return Array.from({ length: result.count }, (_, index) => ({
    index,
    x: input.centerX + result.offsets[index * 3],
    y: result.offsets[index * 3 + 1],
    z: input.centerZ + result.offsets[index * 3 + 2],
  }));
}

function assertSurfaceParity(
  input: GrassWorkerInput,
  result: GrassWorkerOutput,
  internals: Internals,
) {
  let graded = 0;
  let sloped = 0;
  const h = (x: number, z: number) => internals.getHeightAtComputed(x, z);
  for (const point of points(input, result)) {
    // Local X/Z and all outputs are Float32. Recomputing at rounded positions
    // admits <=1e-4m error, not a visual/collision-grounding certification.
    expect(Math.abs(point.y - h(point.x, point.z))).toBeLessThan(1e-4);
    const dx = h(point.x + 0.5, point.z) - h(point.x - 0.5, point.z);
    const dz = h(point.x, point.z + 0.5) - h(point.x, point.z - 0.5);
    const inverse = 1 / Math.hypot(dx, 1, dz);
    for (const [axis, expected] of [
      -dx * inverse,
      inverse,
      -dz * inverse,
    ].entries()) {
      expect(
        Math.abs(result.groundNormals[point.index * 3 + axis] - expected),
      ).toBeLessThan(1e-4);
    }
    if (Math.hypot(dx, dz) > 0.01) sloped++;
    if (
      input.terrainSurface.zones.some(
        (zone) => Math.abs(point.y - zone.height) < 0.001,
      )
    )
      graded++;
  }
  return { graded, sloped };
}

function broadGrade(): GrassTerrainSurfaceZone {
  const area = ALL_WORLD_AREAS.preparation_training_grounds;
  const grade = area.flatZones?.find(
    (zone) => zone.id === "preparation_campus_grade",
  );
  if (!grade || grade.height === undefined)
    throw new Error("Missing actual compact campus grade");
  return {
    ...grade,
    height: grade.height,
    centerX: 350,
    centerZ: 400,
    width: 40,
    depth: 40,
    excludeGrass: false,
  };
}

describe("actual authored-surface grass worker", () => {
  it("uses the compact diffuse palette in actual worker and main grass bases without changing placement ecology", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      terrain.registerFlatZone(broadGrade());
      const input = {
        ...request(terrain, internals, 350, 400, 12),
        clumpSpacing: 0.2,
      };
      const result = await worker.run(input);
      expect(result.count).toBeGreaterThan(50);
      let differsFromOldPalette = 0;
      for (const point of points(input, result)) {
        const main = terrain.getTerrainColorAt(point.x, point.z, true);
        const legacy = computeTerrainColorCPU(
          point.x,
          point.z,
          point.y,
          1 - main.ny,
          1,
          0,
        );
        expect(main.grassWeight).toBeCloseTo(legacy.grassWeight, 4);
        for (const [axis, channel] of (["r", "g", "b"] as const).entries()) {
          expect(
            Math.abs(
              result.groundColors[point.index * 3 + axis] - main[channel],
            ),
          ).toBeLessThan(0.0002);
        }
        if (Math.abs(main.g - legacy.g) > 0.03) differsFromOldPalette++;
      }
      expect(differsFromOldPalette).toBeGreaterThan(50);
    });
  });

  it.each([
    {
      label: "explicit raised-grade regression (not the deployed grade)",
      heightOffset: 2,
      minimumRawDifference: 1,
    },
    // The sculpted meadow deliberately meets the functional grade much more
    // closely. A 10cm raw-height discriminator still exceeds the actual Float32
    // parity tolerance by orders of magnitude. A separate explicit raised grade
    // preserves a >1m discriminator without weakening startup profile admission.
    {
      label: "sculpted v2 meadow",
      heightOffset: 0,
      minimumRawDifference: 0.1,
    },
  ])(
    "uses authored campus heights and five deterministic attributes: $label",
    async ({ heightOffset, minimumRawDifference }) => {
      await withTerrain(async (terrain, internals, worker) => {
        internals.loadWaterBodiesFromManifest();
        internals.loadFlatZonesFromManifest();
        const campus = internals.flatZones.get("preparation_campus_grade");
        if (!campus) throw new Error("Missing registered compact campus");
        terrain.registerFlatZone({
          ...campus,
          height: campus.height + heightOffset,
          excludeGrass: false,
        });
        const input = {
          ...request(terrain, internals, 323, 331, 16),
          clumpSpacing: 0.2,
        };
        const result = await worker.run(input);
        expect(result.count).toBeGreaterThan(50);
        const parity = assertSurfaceParity(input, result, internals);
        expect(parity.graded).toBeGreaterThan(50);
        // Locate a real accepted clump where grading materially changes raw
        // terrain, then inspect that small region densely, without changing noise.
        const focus = points(input, result).sort(
          (a, b) =>
            Math.abs(b.y - terrain.getProceduralHeightAt(b.x, b.z)) -
            Math.abs(a.y - terrain.getProceduralHeightAt(a.x, a.z)),
        )[0];
        expect(
          Math.abs(focus.y - terrain.getProceduralHeightAt(focus.x, focus.z)),
        ).toBeGreaterThan(minimumRawDifference);
        const focusedInput = {
          ...request(terrain, internals, focus.x, focus.z, 0.5),
          clumpSpacing: 0.01,
        };
        const focused = await worker.run(focusedInput);
        assertSurfaceParity(focusedInput, focused, internals);
        const differentFromRaw = points(focusedInput, focused).filter(
          (point) =>
            Math.abs(
              point.y - terrain.getProceduralHeightAt(point.x, point.z),
            ) > minimumRawDifference,
        );
        expect(differentFromRaw.length).toBeGreaterThan(50);
        const repeated = await worker.run(input);
        expect(repeated.count).toBe(result.count);
        for (const name of Object.keys(
          attributes,
        ) as (keyof typeof attributes)[])
          expect(repeated[name]).toEqual(result[name]);
      });
    },
  );

  it("allows grass on broad grades but honors independent default pad exclusions and empty outputs", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      const broad = broadGrade();
      terrain.registerFlatZone(broad);
      const firstInput = request(terrain, internals, 350, 400, 12);
      const allowed = await worker.run(firstInput);
      expect(allowed.count).toBeGreaterThan(50);
      const inPad = (point: { x: number; z: number }) =>
        Math.abs(point.x - 350) <= 2.5 && Math.abs(point.z - 400) <= 2.5;
      expect(points(firstInput, allowed).filter(inPad).length).toBeGreaterThan(
        10,
      );
      terrain.registerFlatZone({
        ...broad,
        id: "narrow-station",
        width: 4,
        depth: 4,
        blendRadius: 0.5,
        excludeGrass: undefined,
      });
      const padInput = request(terrain, internals, 350, 400, 12);
      const padded = await worker.run(padInput);
      expect(padded.count).toBeGreaterThan(20);
      expect(points(padInput, padded).filter(inPad)).toEqual([]);
      assertSurfaceParity(padInput, padded, internals);
      terrain.registerFlatZone({
        ...broad,
        id: "full-exclusion",
        excludeGrass: true,
      });
      const empty = await worker.run(request(terrain, internals, 350, 400, 12));
      expect(empty.count).toBe(0);
    });
  });

  it("excludes sparse mask tiles and their radial blends without excluding the bounding rectangle's holes", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      const broad = broadGrade();
      terrain.registerFlatZone(broad);
      const tiles = [
        { x: 347, z: 397 },
        { x: 351, z: 401 },
      ];
      terrain.registerFlatZone({
        id: "sparse-pad",
        centerX: 349.5,
        centerZ: 399.5,
        width: 5,
        depth: 5,
        height: broad.height,
        blendRadius: 0.3,
        tileMask: new Set(tiles.map((tile) => `${tile.x},${tile.z}`)),
        tileMaskTiles: tiles,
        tileMaskBounds: { minX: 347, maxX: 351, minZ: 397, maxZ: 401 },
      });
      const input = request(terrain, internals, 349.5, 399.5, 8);
      const result = await worker.run(input);
      expect(result.count).toBeGreaterThan(50);
      const accepted = points(input, result);
      expect(
        accepted.filter(
          (point) =>
            point.x > 348.5 &&
            point.x < 350.5 &&
            point.z > 398.5 &&
            point.z < 400.5,
        ).length,
      ).toBeGreaterThan(5);
      for (const point of accepted) {
        for (const tile of tiles) {
          const dx = Math.max(tile.x - point.x, 0, point.x - tile.x - 1);
          const dz = Math.max(tile.z - point.z, 0, point.z - tile.z - 1);
          expect(Math.hypot(dx, dz)).toBeGreaterThan(0.3 - 1e-6);
        }
      }
      assertSurfaceParity(input, result, internals);
    });
  });

  it("samples actual elevated pond banks and 0.5m normals without putting grass below local water", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      const area = ALL_WORLD_AREAS.haven_pond;
      const pond = area.flatZones?.find((zone) => zone.radialPond);
      if (!pond || pond.height === undefined || !pond.radialPond)
        throw new Error("Missing actual compact pond profile");
      terrain.registerFlatZone({
        ...broadGrade(),
        centerX: pond.centerX,
        centerZ: pond.centerZ,
      });
      terrain.registerFlatZone({
        ...pond,
        height: pond.height,
        excludeGrass: false,
      });
      const input = request(terrain, internals, pond.centerX, pond.centerZ, 24);
      const result = await worker.run(input);
      expect(result.count).toBeGreaterThan(50);
      const accepted = points(input, result);
      const registry = terrain.getWaterBodyRegistry();
      for (const point of accepted) {
        expect(point.y).toBeGreaterThanOrEqual(
          registry.getWaterSurfaceAt(point.x, point.z) + 0.1 - 1e-4,
        );
      }
      expect(
        accepted.filter(
          (point) =>
            Math.hypot(point.x - pond.centerX, point.z - pond.centerZ) <=
            pond.radialPond!.bedRadius,
        ),
      ).toEqual([]);
      expect(
        accepted.filter((point) => {
          const radius = Math.hypot(
            point.x - pond.centerX,
            point.z - pond.centerZ,
          );
          return (
            radius > pond.radialPond!.bankInnerRadius &&
            radius < pond.radialPond!.bankOuterRadius
          );
        }).length,
      ).toBeGreaterThan(20);
      const parity = assertSurfaceParity(input, result, internals);
      expect(parity.sloped).toBeGreaterThan(10);
      expect(
        accepted.filter(
          (point) =>
            registry.getWaterSurfaceAt(point.x, point.z) >
              input.waterThreshold &&
            point.y > registry.getWaterSurfaceAt(point.x, point.z),
        ).length,
      ).toBeGreaterThan(0);
    });
  });

  it("uses raw coastal grade blending under a controlled valid worker shoreline policy", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      const profile = terrain.getWorldTerrainProfile();
      // Branch regression, NOT a deployed-profile or cross-profile acceptance
      // test. Only MIN_SLOPE changes: raw island heights/biomes stay identical,
      // so the main authored blend remains a valid numerical reference.
      const shoreline = { ...profile.shoreline, MIN_SLOPE: 2 };
      const adjustedAt = (x: number, z: number) => {
        const raw = terrain.getProceduralHeightAt(x, z);
        const d = shoreline.SLOPE_SAMPLE_DISTANCE;
        const slope = Math.max(
          ...[
            [d, 0],
            [-d, 0],
            [0, d],
            [0, -d],
          ].map(
            ([dx, dz]) =>
              Math.abs(terrain.getProceduralHeightAt(x + dx, z + dz) - raw) / d,
          ),
        );
        return adjustShorelineHeight(raw, slope, {
          waterThreshold: profile.water.threshold,
          shorelineLandBand: shoreline.LAND_BAND,
          shorelineUnderwaterBand: shoreline.UNDERWATER_BAND,
          shorelineMinSlope: shoreline.MIN_SLOPE,
          shorelineLandMaxMultiplier: shoreline.LAND_MAX_MULTIPLIER,
          underwaterDepthMultiplier: shoreline.UNDERWATER_DEPTH_MULTIPLIER,
        });
      };
      let coast: { x: number; z: number } | undefined;
      // Search the real compact coastline, not a fabricated noise sampler.
      // Keep the selected grade and its complete stencil inside world bounds.
      for (
        let x = profile.bounds.minX + 55;
        x < profile.bounds.maxX - 55 && !coast;
        x += 2
      ) {
        for (
          let z = profile.bounds.minZ + 55;
          z < profile.bounds.maxZ - 55;
          z += 2
        ) {
          const raw = terrain.getProceduralHeightAt(x, z);
          const adjusted = adjustedAt(x, z);
          if (raw > profile.water.threshold && Math.abs(raw - adjusted) > 0.2) {
            coast = { x, z };
            break;
          }
        }
      }
      if (!coast)
        throw new Error(
          "Actual compact profile has no discriminating above-water shoreline sample",
        );
      const zone: GrassTerrainSurfaceZone = {
        id: "coastal-grade",
        centerX: coast.x - 12,
        centerZ: coast.z,
        width: 4,
        depth: 24,
        height: profile.water.threshold + 8,
        blendRadius: 40,
        excludeGrass: false,
      };
      const beforeGrade = adjustedAt(coast.x, coast.z);
      terrain.registerFlatZone(zone);
      const baseInput = request(terrain, internals, coast.x, coast.z, 2);
      const testProfile = { ...profile, shoreline };
      const input = {
        ...baseInput,
        config: createTerrainWorkerConfig(
          testProfile,
          baseInput.config.TILE_RESOLUTION,
        ),
        clumpSpacing: 0.05,
      };
      expect(input.config.TERRAIN_PROFILE).toEqual(testProfile);
      expect(input.config.TERRAIN_PROFILE_IDENTITY).not.toBe(
        baseInput.config.TERRAIN_PROFILE_IDENTITY,
      );
      const result = await worker.run(input);
      expect(result.count).toBeGreaterThan(20);
      assertSurfaceParity(input, result, internals);
      let distinguishesShoreline = 0;
      for (const point of points(input, result)) {
        const factor =
          (Math.abs(point.x - zone.centerX) - zone.width / 2) /
          zone.blendRadius;
        const weight = factor * factor * (3 - 2 * factor);
        const raw = terrain.getProceduralHeightAt(point.x, point.z);
        const adjusted = adjustedAt(point.x, point.z);
        const expected = zone.height + (raw - zone.height) * weight;
        const incorrectlyDoubleAdjusted =
          zone.height + (adjusted - zone.height) * weight;
        expect(Math.abs(point.y - expected)).toBeLessThan(1e-4);
        if (Math.abs(expected - incorrectlyDoubleAdjusted) > 0.01)
          distinguishesShoreline++;
      }
      expect(distinguishesShoreline).toBeGreaterThan(20);
      expect(
        Math.abs(beforeGrade - terrain.getProceduralHeightAt(coast.x, coast.z)),
      ).toBeGreaterThan(0.2);
    });
  });
});
