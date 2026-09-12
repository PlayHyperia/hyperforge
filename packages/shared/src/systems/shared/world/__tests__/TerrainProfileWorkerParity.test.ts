import { Worker } from "node:worker_threads";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { NoiseGenerator } from "../../../../utils/NoiseGenerator";
import {
  TERRAIN_WORKER_CODE,
  type TerrainWorkerOutput,
} from "../../../../utils/workers/TerrainWorker";
import {
  QUAD_CHUNK_WORKER_CODE,
  type QuadChunkWorkerOutput,
} from "../../../../utils/workers/QuadChunkWorker";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import {
  assertTerrainWorkerRequest,
  assertTerrainWorkerResult,
  buildCreateBiomeNoiseSetsJS,
  buildNoiseGeneratorJS,
  createTerrainWorkerConfig,
} from "../../../../utils/workers/TerrainWorkerShared";
import {
  BIOME_CONFIGS,
  adjustShorelineHeight,
  buildGetBaseHeightAtJS,
  computeBaseHeight,
  computeIslandMask,
} from "../TerrainHeightParams";
import { BiomeType, buildBiomeConstantsJS } from "../TerrainBiomeTypes";
import { TERRAIN_SHADER_CONSTANTS } from "../TerrainShader";
import {
  COMPACT_WORLD_TERRAIN_PROFILE as compact,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as sculpted,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE as previousSculpt,
  SCULPTED_COMPACT_V2_PROFILE_FIXTURE as rectangularSculpt,
  SCULPTED_COMPACT_V3_PROFILE_FIXTURE as roundedSculpt,
  SCULPTED_COMPACT_V4_PROFILE_FIXTURE as terracedSculpt,
  LEGACY_TERRAIN_PROFILE_FIXTURE as legacy,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

function cpu(profile: WorldTerrainProfile, weights: Record<string, number>) {
  const noise = new NoiseGenerator(profile.seed);
  const sets = Object.fromEntries(
    Object.entries(BIOME_CONFIGS).map(([key, config]) => {
      const seed = profile.seed + config.seedOffset;
      return [
        key,
        {
          main: new NoiseGenerator(seed),
          variation: new NoiseGenerator(seed + 4),
          erosion: new NoiseGenerator(seed + 1),
        },
      ];
    }),
  );
  const base = (x: number, z: number) =>
    computeBaseHeight(x, z, noise, sets, weights, profile);
  const final = (x: number, z: number) => {
    const h = base(x, z);
    const s = profile.shoreline;
    const d = s.SLOPE_SAMPLE_DISTANCE;
    const slope = Math.max(
      ...[
        [0, d],
        [0, -d],
        [d, 0],
        [-d, 0],
      ].map(([dx, dz]) => Math.abs(base(x + dx, z + dz) - h) / d),
    );
    return adjustShorelineHeight(h, slope, {
      waterThreshold: profile.water.threshold,
      shorelineLandBand: s.LAND_BAND,
      shorelineUnderwaterBand: s.UNDERWATER_BAND,
      shorelineMinSlope: s.MIN_SLOPE,
      shorelineLandMaxMultiplier: s.LAND_MAX_MULTIPLIER,
      underwaterDepthMultiplier: s.UNDERWATER_DEPTH_MULTIPLIER,
    });
  };
  return {
    base,
    final,
    mask: (x: number, z: number) => computeIslandMask(x, z, noise, profile),
  };
}

/** Real worker thread, with only the browser↔Node message-transport adapter. */
function actualWorker(source: string) {
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
    ${source}
    parentPort.on("message", data => self.onmessage({ data }));
  `,
    { eval: true, env: {} },
  );
  return {
    execute<T>(input: unknown): Promise<T> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => finish(new Error("Actual terrain worker timed out")),
          5000,
        );
        const onError = (error: Error) => finish(error);
        const onMessage = (message: { result?: T; error?: string }) =>
          finish(
            message.error ? new Error(message.error) : null,
            message.result,
          );
        function finish(error: Error | null, result?: T) {
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

function request(profile: WorldTerrainProfile, biome = BiomeType.Forest) {
  return {
    config: createTerrainWorkerConfig(profile, 16),
    seed: profile.seed,
    biomeCenters: [
      {
        x: profile.island.centerX,
        z: profile.island.centerZ,
        type: biome,
        influence: 1000,
      },
    ],
    biomes: {
      [biome]: { heightModifier: 1, color: { r: 0.2, g: 0.4, b: 0.1 } },
    },
  };
}

describe("actual compact terrain height pipeline", () => {
  it("matches the real generated base-height/mask code for every biome, blends, seeds and coast samples", () => {
    const generated = runInNewContext(`
      ${buildNoiseGeneratorJS()}
      ${buildBiomeConstantsJS()}
      (function(config) {
        var noise = new NoiseGenerator(config.TERRAIN_PROFILE.seed);
        ${buildGetBaseHeightAtJS()}
        ${buildCreateBiomeNoiseSetsJS()}
        var biomeNoiseSets = createBiomeNoiseSets(config.TERRAIN_PROFILE.seed);
        return { base: getBaseHeightAt, mask: getIslandMask };
      })
    `) as (config: ReturnType<typeof createTerrainWorkerConfig>) => {
      base(x: number, z: number, weights: Record<string, number>): number;
      mask(x: number, z: number): number;
    };
    const weights = [
      { forest: 1 },
      { tundra: 1 },
      { canyon: 1 },
      { forest: 0.2, tundra: 0.3, canyon: 0.5 },
    ];
    const profiles = [
      legacy,
      previousSculpt,
      rectangularSculpt,
      roundedSculpt,
      terracedSculpt,
      ...[0, 41, 0xffffffff].map((seed) =>
        validateWorldTerrainProfile({ ...sculpted, seed }),
      ),
      ...[0, 41, 0xffffffff].map((seed) =>
        validateWorldTerrainProfile({ ...compact, seed }),
      ),
    ];
    for (const profile of profiles) {
      // Historical numeric fixture exercises only the pure sampler. The runtime
      // config factory and actual workers deliberately reject the old world.
      const js = generated({
        ...createTerrainWorkerConfig(compact, 16),
        TERRAIN_PROFILE: profile,
      });
      for (const weight of weights) {
        const reference = cpu(profile, weight);
        for (let angle = 0; angle < 16; angle++) {
          const theta = (angle * Math.PI) / 8;
          for (const sampleRadius of [
            0, 100, 125.1, 140, 155, 165, 174.9, 199.9, 210,
          ]) {
            const radius = (sampleRadius * profile.island.radius) / 165;
            const x = profile.island.centerX + Math.cos(theta) * radius;
            const z = profile.island.centerZ + Math.sin(theta) * radius;
            expect(js.base(x, z, weight)).toBeCloseTo(reference.base(x, z), 11);
            expect(js.mask(x, z)).toBe(reference.mask(x, z));
            if (profile.kind === "compact-candidate" && radius >= 199.9)
              expect(reference.mask(x, z)).toBe(0);
          }
        }
      }
    }
  });

  it("transfers CPU-identical Float32 heights and normals from actual tile and quad workers across profile changes", async () => {
    const tile = actualWorker(TERRAIN_WORKER_CODE);
    const quad = actualWorker(QUAD_CHUNK_WORKER_CODE);
    let shoreSamples = 0;
    try {
      const profiles = [
        previousSculpt,
        rectangularSculpt,
        roundedSculpt,
        terracedSculpt,
        ...[0, 41, 0xffffffff].map((seed) =>
          validateWorldTerrainProfile({ ...sculpted, seed }),
        ),
        ...[0, 41, 0xffffffff].map((seed) =>
          validateWorldTerrainProfile({ ...compact, seed }),
        ),
        validateWorldTerrainProfile({
          ...compact,
          id: "translated-height-water-test",
          seed: 7,
          bounds: { minX: 250, maxX: 650, minZ: 300, maxZ: 700 },
          island: {
            ...compact.island,
            centerX: 450,
            centerZ: 500,
            beachProfilePower: 2,
          },
          height: {
            ...compact.height,
            maxHeightParameter: 55,
            baseOffset: 24,
            terrainScale: 28,
            featureScale: 0.9,
          },
          water: { threshold: 17, oceanFloorHeight: 3 },
          shoreline: {
            ...compact.shoreline,
            MIN_SLOPE: 0.4,
            LAND_BAND: 4,
            UNDERWATER_BAND: 2,
            SLOPE_SAMPLE_DISTANCE: 0.75,
          },
        }),
      ];
      for (const profile of profiles) {
        const tileZ = profile.island.centerZ / 100;
        for (const biome of Object.values(BiomeType)) {
          const input = request(profile, biome);
          const reference = cpu(profile, { [biome]: 1 });
          const firstTileX = Math.floor(profile.island.centerX / 100);
          for (const tileX of [
            firstTileX - 1,
            firstTileX,
            firstTileX + 1,
            firstTileX + 2,
          ]) {
            const tileResult = await tile.execute<TerrainWorkerOutput>({
              ...input,
              type: "generateHeightmap",
              tileX,
              tileZ,
            });
            const quadResult = await quad.execute<QuadChunkWorkerOutput>({
              ...input,
              type: "generateQuadChunk",
              centerX: tileX * 100,
              centerZ: tileZ * 100,
              size: 100,
              resolution: 16,
            });
            expect(tileResult.terrainProfileIdentity).toBe(
              worldTerrainProfileIdentity(profile),
            );
            expect(quadResult.terrainProfileIdentity).toBe(
              tileResult.terrainProfileIdentity,
            );
            expect(quadResult.heightData).toEqual(tileResult.heightData);
            expect(quadResult.normalData).toEqual(tileResult.normalData);
            for (let iz = 0; iz < 16; iz++)
              for (let ix = 0; ix < 16; ix++) {
                const x = tileX * 100 - 50 + (ix * 100) / 15;
                const z = tileZ * 100 - 50 + (iz * 100) / 15;
                const base = reference.base(x, z);
                if (Math.abs(base - profile.water.threshold) < 3)
                  shoreSamples++;
                expect(tileResult.heightData[iz * 16 + ix]).toBe(
                  Math.fround(reference.final(x, z)),
                );
              }
          }
        }
      }
      expect(shoreSamples).toBeGreaterThan(20);
    } finally {
      await Promise.all([tile.close(), quad.close()]);
    }
  }, 20000);

  it("transfers the new western ridge and southeast bay through both real workers", async () => {
    const tile = actualWorker(TERRAIN_WORKER_CODE),
      quad = actualWorker(QUAD_CHUNK_WORKER_CODE);
    let changedSamples = 0,
      seabedSamples = 0;
    try {
      for (const seed of [0, 41]) {
        const profile = validateWorldTerrainProfile({ ...sculpted, seed });
        const reference = cpu(profile, { forest: 1 });
        const old = cpu(
          validateWorldTerrainProfile({ ...previousSculpt, seed }),
          { forest: 1 },
        );
        for (const [tileX, tileZ] of [
          [2, 4],
          [3, 4],
          [4, 5],
          [5, 5],
        ]) {
          const input = request(profile);
          const a = await tile.execute<TerrainWorkerOutput>({
            ...input,
            type: "generateHeightmap",
            tileX,
            tileZ,
          });
          const b = await quad.execute<QuadChunkWorkerOutput>({
            ...input,
            type: "generateQuadChunk",
            centerX: tileX * 100,
            centerZ: tileZ * 100,
            size: 100,
            resolution: 16,
          });
          expect(a.terrainProfileIdentity).toBe(
            worldTerrainProfileIdentity(profile),
          );
          expect(b.terrainProfileIdentity).toBe(a.terrainProfileIdentity);
          expect(b.heightData).toEqual(a.heightData);
          expect(b.normalData).toEqual(a.normalData);
          for (let z = 0; z < 16; z++)
            for (let x = 0; x < 16; x++) {
              const wx = tileX * 100 - 50 + (x * 100) / 15,
                wz = tileZ * 100 - 50 + (z * 100) / 15;
              expect(a.heightData[z * 16 + x]).toBe(
                Math.fround(reference.final(wx, wz)),
              );
              if (Math.abs(reference.final(wx, wz) - old.final(wx, wz)) > 2)
                changedSamples++;
              if (a.heightData[z * 16 + x] === profile.water.oceanFloorHeight)
                seabedSamples++;
            }
        }
      }
      expect(changedSamples).toBeGreaterThan(100);
      expect(seabedSamples).toBeGreaterThan(100);
    } finally {
      await Promise.all([tile.close(), quad.close()]);
    }
  });

  it("uses the same profile in actual grass placement, including identity on empty outputs", async () => {
    const worker = actualWorker(GRASS_WORKER_CODE);
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
    const input: GrassWorkerInput = {
      ...request(compact),
      type: "generateGrassInstances",
      chunkKey: "compact-grass",
      centerX: 350,
      centerZ: 400,
      size: 16,
      spacingMul: 1,
      grassSeed: 7,
      clumpSpacing: 1,
      scaleMin: 1,
      scaleMax: 1,
      waterThreshold: compact.water.threshold,
      grassConfigs: { tundra: settings, forest: settings, canyon: settings },
      shaderConstants: TERRAIN_SHADER_CONSTANTS,
      roadSegments: [],
      roadBlendWidth: 0,
      tileSize: 100,
      terrainSurface: {
        schemaVersion: 1,
        zones: [],
        arenaFloorIds: [],
        arenaGradeHeight: null,
        waterBodies: [],
      },
    };
    try {
      const result = await worker.execute<GrassWorkerOutput>(input);
      expect(result.terrainProfileIdentity).toBe(
        worldTerrainProfileIdentity(compact),
      );
      expect(result.count).toBeGreaterThan(0);
      const reference = cpu(compact, { forest: 1 });
      // Offsets are transferred Float32: their X/Z rounding bounds the recomputed Y error.
      for (let i = 0; i < result.count; i++)
        expect(result.offsets[i * 3 + 1]).toBeCloseTo(
          reference.final(
            350 + result.offsets[i * 3],
            400 + result.offsets[i * 3 + 2],
          ),
          4,
        );
      const empty = await worker.execute<GrassWorkerOutput>({
        ...input,
        terrainSurface: {
          ...input.terrainSurface,
          zones: [
            {
              id: "excluded-test-pad",
              centerX: 350,
              centerZ: 400,
              width: 100,
              depth: 100,
              height: 30,
              blendRadius: 0,
            },
          ],
        },
      });
      expect(empty.count).toBe(0);
      expect(empty.terrainProfileIdentity).toBe(result.terrainProfileIdentity);
      const bay = await worker.execute<GrassWorkerOutput>({
        ...input,
        ...request(sculpted),
        chunkKey: "sculpt-v2-bay",
        centerX: 430,
        centerZ: 480,
        size: 32,
      });
      expect(bay.terrainProfileIdentity).toBe(
        worldTerrainProfileIdentity(sculpted),
      );
      expect(bay.count).toBeGreaterThan(0);
      const bayHeight = cpu(sculpted, { forest: 1 });
      for (let i = 0; i < bay.count; i++) {
        const expected = bayHeight.final(
          430 + bay.offsets[i * 3],
          480 + bay.offsets[i * 3 + 2],
        );
        expect(bay.offsets[i * 3 + 1]).toBeCloseTo(expected, 4);
        expect(expected).toBeGreaterThan(sculpted.water.threshold);
      }
    } finally {
      await worker.close();
    }
  });

  it("rejects malformed profiles, conflicting seeds/configs and mismatched result identities without fallback", async () => {
    const config = createTerrainWorkerConfig(compact, 16);
    expect(() => createTerrainWorkerConfig(legacy, 16)).toThrow(
      /not a runtime world/,
    );
    expect(() => assertTerrainWorkerRequest(config, 1)).toThrow(/mismatch/);
    expect(() =>
      assertTerrainWorkerRequest({ ...config, WATER_THRESHOLD: 17 }, 0),
    ).toThrow(/mismatch/);
    expect(() =>
      assertTerrainWorkerResult({ terrainProfileIdentity: "old" }, config),
    ).toThrow(/mismatch/);
    for (const [source, type] of [
      [TERRAIN_WORKER_CODE, "generateHeightmap"],
      [QUAD_CHUNK_WORKER_CODE, "generateQuadChunk"],
      [GRASS_WORKER_CODE, "generateGrassInstances"],
    ]) {
      const worker = actualWorker(source);
      try {
        for (const change of [
          { seed: 1 },
          { config: { ...config, TERRAIN_PROFILE_IDENTITY: "old" } },
          { config: { ...config, MAX_HEIGHT: 30 } },
          {
            config: {
              ...config,
              TERRAIN_PROFILE: legacy,
              TERRAIN_PROFILE_IDENTITY: worldTerrainProfileIdentity(legacy),
            },
          },
          {
            config: {
              ...config,
              TERRAIN_PROFILE: {
                ...compact,
                island: { ...compact.island, radius: -1 },
              },
            },
          },
          ...[
            {
              ...sculpted,
              landform: { ...sculpted.landform, ridgeWestWidth: 0 },
            },
            {
              ...sculpted,
              landform: { ...sculpted.landform, westHeadlandHalfWidth: 1e-12 },
            },
            { ...sculpted, landform: { ...sculpted.landform, unexpected: 1 } },
            { ...sculpted, bay: undefined },
            { ...sculpted, island: null },
            { ...sculpted, bay: { ...sculpted.bay, innerHalfWidth: NaN } },
            { ...sculpted, bay: { ...sculpted.bay, unexpected: 1 } },
            { ...sculpted, bay: { ...sculpted.bay, innerHalfWidth: 0 } },
            { ...sculpted, bay: { ...sculpted.bay, centerlineBend: 30 } },
            { ...sculpted, bay: { ...sculpted.bay, leftBankScale: 0 } },
            { ...sculpted, bay: { ...sculpted.bay, rightBankScale: 2 } },
            { ...sculpted, terrace: undefined },
            { ...roundedSculpt, terrace: sculpted.terrace },
            ...[
              { startZ: -66 },
              { endZ: 76 },
              { startZ: 61 },
              { endFade: 0 },
              { westFoot: -27 },
              { westFoot: -20 },
              { crestStart: -25 },
              { crestEnd: -5 },
              { crestHeight: NaN },
              { crestHeight: 25 },
              { shelfHeight: 20 },
              { scarpRun: 1e-12 },
              { scarpRun: 17 },
              { shelfWidth: 0 },
              { apronWidth: Infinity },
              { eastPreservationStart: -200 },
              { eastPreservationEnd: -75 },
              { eastPreservationEnd: 0 },
              { unexpected: 1 },
            ].map((patch) => ({
              ...sculpted,
              terrace: { ...sculpted.terrace, ...patch },
            })),
            { ...sculpted, id: roundedSculpt.id },
            { ...roundedSculpt, id: sculpted.id },
            { ...sculpted, id: rectangularSculpt.id },
            { ...rectangularSculpt, id: sculpted.id },
          ].map((profile) => ({
            config: {
              ...createTerrainWorkerConfig(sculpted, 16),
              TERRAIN_PROFILE: profile,
              // Match the malformed payload so numerical/schema guards, not
              // an unrelated stale identity, must reject it in every worker.
              TERRAIN_PROFILE_IDENTITY:
                "hyperia-world-terrain-profile-v1\n" + JSON.stringify(profile),
            },
          })),
          {
            config: {
              ...createTerrainWorkerConfig(sculpted, 16),
              TERRAIN_PROFILE: {
                ...sculpted,
                landform: { ...sculpted.landform, ridgeBend: 31 },
              },
            },
          },
        ])
          await expect(
            worker.execute({ ...request(compact), type, ...change }),
          ).rejects.toThrow(/profile\/config/);
      } finally {
        await worker.close();
      }
    }
  });
});
