import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import {
  GRASS_WORKER_CODE,
  admitGrassWorkerPlacementResult,
  prepareGrassWorkerRequest,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import {
  getGrassPlacementCellBounds,
  type GrassPlacementCell,
} from "../../../../utils/workers/GrassPlacementCell";
import {
  createGrassTerrainSurfaceSnapshot,
  type GrassTerrainSurfaceZone,
} from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
} from "../TerrainQuadChunkGenerator";
import {
  TERRAIN_SHADER_CONSTANTS,
  computeTerrainColorCPU,
  sampleNoiseCPU,
} from "../TerrainShader";
import {
  createCompactTerrainColorOperations,
  type CompactTerrainBankVerge,
} from "../CompactTerrainPalette";
import { createAuthoredTerrainSurfaceOperations } from "../AuthoredTerrainSurface";
import { adjustShorelineHeight } from "../TerrainHeightParams";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import { GRASS_CONFIG, type GrassWorkerSetup } from "../GrassVisualManager";
import { validateWorldTerrainProfile } from "../WorldTerrainProfile";

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

// Existing main/native-worker tolerance for Float32 local-coordinate rounding;
// not a minimum visible colour difference or an art-quality threshold.
const colorParityTolerance = 0.0002;

type TransferReceipt = {
  before: number[];
  after: number[];
  unique: number;
};

/** Production worker code; only browser message transport is adapted to Node. */
function actualWorker(source = GRASS_WORKER_CODE) {
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
    ${source}
    parentPort.on("message", data => self.onmessage({ data }));
  `,
    { eval: true, env: {} },
  );
  return {
    run(input: GrassWorkerInput): Promise<GrassWorkerOutput> {
      return new Promise((resolve, reject) => {
        let result: GrassWorkerOutput | undefined;
        let receipt: TransferReceipt | undefined;
        let reportedError: Error | undefined;
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
          if (message.error) reportedError = new Error(message.error);
          if (message.result) result = message.result;
          if (message.receipt) receipt = message.receipt;
          // Error messages also have a real transport receipt. Drain that
          // message before reusing this worker for the next independent job.
          if (reportedError && receipt) return finish(reportedError);
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

/** Retain the changed generation statements from pre-cell commit a1b40b288
 * (GrassWorker.ts SHA256 71dae8d208c6fa8087aa0b91a5238830b25bb9c001df6ab28b448277bef74b2e).
 * Both real workers use the same current terrain/color functions; this control
 * proves omission preserves the old sampling/RNG/output behavior, not that all
 * historical terrain dependencies or native GPU results are unchanged. */
function preCellSamplingWorker() {
  let source = GRASS_WORKER_CODE;
  const replacements = [
    [
      "  var placementDomain = placementCellOperations.resolveDomain(input);\n",
      "",
    ],
    [
      `  if (placementDomain.placementDistribution && grassEligibility !== "compact-pbr-v1")
    throw new Error("Grass placement distribution requires compact grass eligibility");\n`,
      "",
    ],
    [
      "  var maxCount = placementDomain.maxCount;",
      "  var maxCount = Math.ceil((size * size) / (spacing * spacing));",
    ],
    [
      "((placementDomain.centerX * 374761393 + placementDomain.centerZ * 668265263) | 0)",
      "((centerX * 374761393 + centerZ * 668265263) | 0)",
    ],
    ["  var placementPosition = { x: 0, z: 0, leafX: 0, leafZ: 0 };\n", ""],
    [
      `    var lx, lz, wx, wz;
    if (placementDomain.placementDistribution) {
      placementCellOperations.samplePosition(placementDomain, i, rng(), rng(), placementPosition);
      lx = placementPosition.leafX;
      lz = placementPosition.leafZ;
      wx = centerX + lx;
      wz = centerZ + lz;
    } else {
      lx = (rng() - 0.5) * placementDomain.size;
      lz = (rng() - 0.5) * placementDomain.size;
      wx = centerX + lx;
      wz = centerZ + lz;
      if (placementDomain.placementCell) {
        wx = placementDomain.centerX + lx;
        wz = placementDomain.centerZ + lz;
        // Grounding and GPU placement retain the real terrain leaf's local frame.
        lx = wx - centerX;
        lz = wz - centerZ;
      }
    }
    var clumpRng = rng();\n`,
      `    var lx = (rng() - 0.5) * size;
    var lz = (rng() - 0.5) * size;
    var clumpRng = rng();

    var wx = centerX + lx;
    var wz = centerZ + lz;\n`,
    ],
  ];
  for (const [current, previous] of replacements) {
    expect(source.split(current)).toHaveLength(2);
    source = source.replace(current, previous);
  }
  for (const echo of [
    "...(placementDomain.placementCell ? { placementCell: placementCellOperations.validateCell(placementDomain.placementCell) } : {}),",
    "...(placementDomain.placementDistribution ? { placementDistribution: placementDomain.placementDistribution } : {}),",
    "...(placementDomain.placementCoverage ? { placementCoverage: placementDomain.placementCoverage } : {}),",
  ]) {
    expect(source.split(echo)).toHaveLength(3);
    source = source.replaceAll(echo, "");
  }
  return actualWorker(source);
}

/** Reconstruct the cell-uniform position statements that preceded stratification.
 * The retained terrain, ecology, RNG, and output transport stay real/current;
 * only explicit opt-in positions differ from this independently kept control. */
function preStratifiedCellSamplingWorker() {
  let source = GRASS_WORKER_CODE;
  const current = `    var lx, lz, wx, wz;
    if (placementDomain.placementDistribution) {
      placementCellOperations.samplePosition(placementDomain, i, rng(), rng(), placementPosition);
      lx = placementPosition.leafX;
      lz = placementPosition.leafZ;
      wx = centerX + lx;
      wz = centerZ + lz;
    } else {
      lx = (rng() - 0.5) * placementDomain.size;
      lz = (rng() - 0.5) * placementDomain.size;
      wx = centerX + lx;
      wz = centerZ + lz;
      if (placementDomain.placementCell) {
        wx = placementDomain.centerX + lx;
        wz = placementDomain.centerZ + lz;
        // Grounding and GPU placement retain the real terrain leaf's local frame.
        lx = wx - centerX;
        lz = wz - centerZ;
      }
    }
    var clumpRng = rng();\n`;
  const previous = `    var lx = (rng() - 0.5) * placementDomain.size;
    var lz = (rng() - 0.5) * placementDomain.size;
    var clumpRng = rng();

    var wx = centerX + lx;
    var wz = centerZ + lz;
    if (placementDomain.placementCell) {
      wx = placementDomain.centerX + lx;
      wz = placementDomain.centerZ + lz;
      // Grounding and GPU placement retain the real terrain leaf's local frame.
      lx = wx - centerX;
      lz = wz - centerZ;
    }\n`;
  expect(source.split(current)).toHaveLength(2);
  source = source.replace(current, previous);
  return actualWorker(source);
}

/** Identical current geometry, noise, RGB and original accepted-clump RNG.
 * Remove only the new coastal rejection, never its terrain/profile input. */
function beforeCoastalFilteringWorker() {
  const filter = `    if (!grassEstablishment && coastalGroundCover > 0) {
      var coastalPlacement = Math.max(0, rawGP * (1 - coastalGroundCover) - roadInf);
      if (coastalPlacement <= 0 || clumpRng > coastalPlacement) continue;
    }`;
  expect(GRASS_WORKER_CODE.split(filter)).toHaveLength(2);
  return actualWorker(GRASS_WORKER_CODE.replace(filter, ""));
}

/** Exact executed native16 source, not a recreated palette or worker mock.
 * Copied byte-for-byte from the southern-meadow-native16 executed source;
 * its report.json pins the 31,462 bytes and SHA-256 asserted below. The .txt
 * suffix keeps this frozen historical input outside production compilation.
 * Keep the fixture unchanged, including its historical type-only imports.
 * Transpile
 * and extract the self-contained factory in a disposable real worker, just as
 * the existing terrain-snapshot minification regression does. All other
 * generation, ecology, RNG, terrain and message-transport code stays current. */
async function extractMinifiedPaletteFactory(source: string): Promise<string> {
  const compiled = transformSync(source, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
    keepNames: true,
    minify: true,
  }).code;
  const extractor = new Worker(
    `const { parentPort } = require("node:worker_threads");
     const module = { exports: {} }; const exports = module.exports;
     ${compiled}
     parentPort.postMessage(module.exports.createCompactTerrainColorOperations.toString());`,
    { eval: true, env: {} },
  );
  let factory: string;
  try {
    factory = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Palette extraction timed out")),
        5000,
      );
      extractor.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      extractor.once("message", (value: unknown) => {
        clearTimeout(timeout);
        if (typeof value !== "string" || !value.startsWith("function"))
          reject(new Error("Invalid extracted palette factory"));
        else resolve(value);
      });
    });
  } finally {
    await extractor.terminate();
  }
  return factory;
}

async function native16PaletteWorker() {
  const path = new URL(
    "./fixtures/Native16CompactTerrainPalette.ts.txt",
    import.meta.url,
  );
  const source = readFileSync(path);
  expect(statSync(path).size).toBe(31462);
  expect(source.byteLength).toBe(31462);
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "ee3eedaa0f7cda6712f376025e080327b6055b5666c3e90897b47ebb92233afe",
  );
  const factory = await extractMinifiedPaletteFactory(source.toString("utf8"));
  const current = `var compactTerrainColorOperations = (${createCompactTerrainColorOperations.toString()})();`;
  expect(GRASS_WORKER_CODE.split(current)).toHaveLength(2);
  const archived = `var compactTerrainColorOperations = (${factory})();`;
  let code = GRASS_WORKER_CODE.replace(current, archived);
  expect(code.replace(archived, current)).toBe(GRASS_WORKER_CODE);
  // The archived palette predates service-ground capture. Its comparison is
  // expressly no-service: reject new inputs, rather than silently dropping
  // them or replacing the historical palette with current implementations.
  const serviceCapture =
    'var pondServiceGround = compactTerrainColorOperations.captureGroundVerge(input, "pondServiceGround");';
  expect(code.split(serviceCapture)).toHaveLength(2);
  code = code.replace(
    serviceCapture,
    `var pondServiceGround;
  if ("pondServiceGround" in input) throw new Error("Archived palette excludes pond service ground");`,
  );
  return actualWorker(code);
}

async function withTerrain(
  execute: (
    terrain: TerrainSystem,
    internals: Internals,
    worker: ReturnType<typeof actualWorker>,
  ) => Promise<void>,
  pondContactFixture = false,
) {
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const worker = actualWorker();
  try {
    if (pondContactFixture)
      terrain["activeTerrainProfile"] = validateWorldTerrainProfile({
        ...terrain.getWorldTerrainProfile(),
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
    await terrain.init();
    await execute(terrain, terrain as unknown as Internals, worker);
  } finally {
    await worker.close();
    world.destroy();
  }
}

/** Explicit review52 bank fixture, installed through the actual zone owner.
 * Historical/default tests keep their unchanged circular manifest. */
function installPondContactBank(terrain: TerrainSystem, internals: Internals) {
  const original = internals.flatZones.get("haven_pond_floor");
  if (!original?.radialPond) throw new Error("Missing actual Haven pond zone");
  terrain.registerFlatZone({
    ...original,
    radialPond: {
      ...original.radialPond,
      bankSectors: [
        {
          bearing: -2.321287905152458,
          halfWidth: 0.6981317007977318,
          innerRadius: 6,
          innerHeight: 27.98,
          outerRadius: 8.2,
          outerHeight: 28.55,
        },
        {
          bearing: -0.47123889803846897,
          halfWidth: 0.41887902047863906,
          innerRadius: 6.55,
          innerHeight: 28.08,
        },
        { bearing: 0.7, halfWidth: 0.55, innerRadius: 6.4, innerHeight: 27.86 },
        {
          bearing: -1.5533430342749532,
          halfWidth: 0.8726646259971648,
          innerRadius: 7.1,
          innerHeight: 27.86,
          outerRadius: 8.7,
          outerHeight: 27.99,
        },
      ],
    },
  });
}

/** Authored composition fixture on the same real registered geometry for both
 * sides of each comparison. This is not the deployed Review68 art manifest. */
function installPondCompositionBank(
  terrain: TerrainSystem,
  internals: Internals,
) {
  installPondContactBank(terrain, internals);
  const original = internals.flatZones.get("haven_pond_floor");
  if (!original?.radialPond) throw new Error("Missing actual Haven pond zone");
  terrain.registerFlatZone({
    ...original,
    radialPond: {
      ...original.radialPond,
      bankComposition: {
        schemaVersion: 1,
        sectors: [
          { sectorIndex: 0, surface: "sedge-shelf" },
          { sectorIndex: 1, surface: "cutbank" },
          { sectorIndex: 3, surface: "dry-turf" },
        ],
      },
    },
  });
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

/** The current production setup, not the permissive historical colour fixture.
 * Cell coordinates select a real sampling domain inside its original leaf. */
function coverageRequest(
  terrain: TerrainSystem,
  internals: Internals,
  indexX: number,
  indexZ: number,
): GrassWorkerInput {
  const setup = internals.buildGrassWorkerSetup();
  const cell: GrassPlacementCell = {
    schemaVersion: 1,
    size: 25,
    indexX,
    indexZ,
  };
  const bounds = getGrassPlacementCellBounds(cell);
  return {
    ...request(
      terrain,
      internals,
      Math.floor(indexX / 4) * 100 + 50,
      Math.floor(indexZ / 4) * 100 + 50,
      100,
    ),
    chunkKey: `gcell_v1_${indexX}_${indexZ}`,
    placementCell: cell,
    placementDistribution: "fine-cell-stratified-v1",
    grassEligibility: "compact-pbr-v1",
    clumpSpacing: GRASS_CONFIG.CLUMP_SPACING,
    grassSeed: GRASS_CONFIG.SEED,
    scaleMin: GRASS_CONFIG.SCALE_MIN,
    scaleMax: GRASS_CONFIG.SCALE_MAX,
    grassConfigs: setup.grassConfigs,
    ...(setup.compactGrassColorGrade
      ? { compactGrassColorGrade: setup.compactGrassColorGrade }
      : {}),
    compactPlantingLobes: setup.compactPlantingLobes,
    roadSegments: setup.getRoadSegmentsForRegion(
      bounds.minX,
      bounds.minZ,
      bounds.maxX,
      bounds.maxZ,
    ),
    roadBlendWidth: 0.5,
    terrainSurface: setup.getTerrainSurfaceForRegion(
      bounds.minX - 0.5,
      bounds.minZ - 0.5,
      bounds.maxX + 0.5,
      bounds.maxZ + 0.5,
    ),
  };
}

function assertExactInstanceBytes(a: GrassWorkerOutput, b: GrassWorkerOutput) {
  expect(a.count).toBe(b.count);
  for (const key of Object.keys(attributes) as (keyof typeof attributes)[]) {
    const left = a[key],
      right = b[key];
    expect(
      Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
        Buffer.from(right.buffer, right.byteOffset, right.byteLength),
      ),
      key,
    ).toBe(true);
  }
}

describe("actual authored-surface grass worker", () => {
  const serviceGroundFixture = (): CompactTerrainBankVerge => ({
    minX: 379,
    maxX: 392,
    minZ: 432,
    maxZ: 445,
    feather: 0.75,
    wearStart: 0.1,
    wearEnd: 0.8,
    minimumScale: 1,
    heightScale: 1,
    wornHeightScale: 0.35,
    tipBrightness: 1,
    grassTint: [1, 1, 1],
    wear: [
      {
        startX: 383.5,
        startZ: 437.5,
        endX: 384,
        endZ: 438,
        coreRadius: 0.9,
        outerRadius: 2.6,
        strength: 0.92,
      },
      {
        startX: 384,
        startZ: 438,
        endX: 386,
        endZ: 440,
        coreRadius: 0.7,
        outerRadius: 2.2,
        strength: 0.86,
      },
      {
        startX: 384,
        startZ: 438,
        endX: 384.5,
        endZ: 435,
        coreRadius: 0.7,
        outerRadius: 2.1,
        strength: 0.78,
      },
    ],
  });

  it("keeps pond service ground placement roots, RNG and scales exact while actual worker colors match the shared palette", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const service = serviceGroundFixture();
      const colors = createCompactTerrainColorOperations();
      const field = colors.macroField(
        terrain.getWorldTerrainProfile(),
        undefined,
        undefined,
        undefined,
        service,
      );
      let changedColors = 0,
        checkedColors = 0;
      for (const [x, z, size, spacingMul] of [
        [384, 438, 12, 1],
        [384, 438, 12, 2],
        [350, 320, 12, 1],
        [430, 470, 6, 1],
      ]) {
        const base: GrassWorkerInput = {
          ...request(terrain, internals, x, z, size),
          grassEligibility: "compact-pbr-v1",
          compactGrassColorGrade: "fine-meadow-green-v1",
          spacingMul,
        };
        const selected = prepareGrassWorkerRequest({
          ...base,
          pondServiceGround: service,
        });
        const before = await worker.run(prepareGrassWorkerRequest(base));
        const after = await worker.run(selected);
        const repeat = await worker.run(selected);
        expect(after.count).toBe(before.count);
        expect(after.grassEligibility).toBe(before.grassEligibility);
        expect(after.terrainProfileIdentity).toBe(
          before.terrainProfileIdentity,
        );
        for (const name of [
          "offsets",
          "rotScaleHash",
          "grassTints",
          "groundNormals",
        ] as const) {
          expect(
            Buffer.from(
              after[name].buffer,
              after[name].byteOffset,
              after[name].byteLength,
            ).equals(
              Buffer.from(
                before[name].buffer,
                before[name].byteOffset,
                before[name].byteLength,
              ),
            ),
            name,
          ).toBe(true);
        }
        assertExactInstanceBytes(after, repeat);
        expect(after.pondServiceGround).toEqual(selected.pondServiceGround);
        expect(after.pondServiceGround).not.toBe(selected.pondServiceGround);
        expect(
          admitGrassWorkerPlacementResult(after, selected).pondServiceGround,
        ).toEqual(service);
        if (x !== 384) assertExactInstanceBytes(after, before);
        else expect(after.count).toBeGreaterThan(0);
        assertSurfaceParity(selected, after, internals);
        for (const point of points(selected, after)) {
          const main = terrain.getTerrainColorAt(point.x, point.z, true);
          const expected = colors.sample({
            grassColorGrade: selected.compactGrassColorGrade,
            noiseValue: sampleNoiseCPU(
              point.x,
              point.z,
              TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
            ),
            meadowNoise: sampleNoiseCPU(
              point.x,
              point.z,
              colors.getComposition().meadowNoiseScale,
            ),
            distortNoise: sampleNoiseCPU(
              point.x,
              point.z,
              TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
            ),
            slope: 1 - main.ny,
            roadInfluence: 0,
            surface: {
              x: point.x,
              z: point.z,
              height: internals.getHeightAtComputed(point.x, point.z),
              pond:
                selected.terrainSurface.waterBodies.find(
                  (body) => body.id === "haven_pond_water",
                ) ?? null,
              macroField: field,
            },
          });
          for (const [axis, channel] of (["r", "g", "b"] as const).entries())
            expect(
              Math.abs(
                after.groundColors[point.index * 3 + axis] - expected[channel],
              ),
            ).toBeLessThan(colorParityTolerance);
          if (
            [0, 1, 2].some(
              (channel) =>
                after.groundColors[point.index * 3 + channel] !==
                before.groundColors[point.index * 3 + channel],
            )
          )
            changedColors++;
          checkedColors++;
        }
      }
      expect(checkedColors).toBeGreaterThan(0);
      expect(changedColors).toBeGreaterThan(0);
    }, true);
  });

  it("captures pond service ground across real placement transport including empty results and rejects malformed or stale markers", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const input: GrassWorkerInput = {
        ...request(terrain, internals, 384, 438, 8),
        grassEligibility: "compact-pbr-v1",
        compactGrassColorGrade: "fine-meadow-green-v1",
      };
      const source: GrassWorkerInput = {
        ...input,
        pondServiceGround: serviceGroundFixture(),
      };
      const queued = prepareGrassWorkerRequest(source);
      expect(queued.pondServiceGround).not.toBe(source.pondServiceGround);
      expect(queued.pondServiceGround!.wear).not.toBe(
        source.pondServiceGround!.wear,
      );
      expect(Object.isFrozen(queued.pondServiceGround)).toBe(true);
      expect(Object.isFrozen(queued.pondServiceGround!.wear)).toBe(true);
      expect(Object.isFrozen(queued.pondServiceGround!.wear[0])).toBe(true);
      expect(Object.isFrozen(queued.pondServiceGround!.grassTint)).toBe(true);
      Reflect.set(source.pondServiceGround!.wear[0], "strength", 0);
      Reflect.set(source.pondServiceGround!, "wornHeightScale", 1);
      const active = await worker.run(queued);
      expect(active.count).toBeGreaterThan(0);
      expect(active.pondServiceGround).toEqual(serviceGroundFixture());
      const emptyInput: GrassWorkerInput = {
        ...queued,
        grassConfigs: Object.fromEntries(
          Object.entries(queued.grassConfigs).map(([key, value]) => [
            key,
            { ...value, density: 0 },
          ]),
        ),
      };
      const empty = await worker.run(emptyInput);
      expect(empty.count).toBe(0);
      expect(empty.pondServiceGround).toEqual(queued.pondServiceGround);
      for (const [result, requestInput] of [
        [active, queued],
        [empty, emptyInput],
      ] as const) {
        const admitted = admitGrassWorkerPlacementResult(result, requestInput);
        expect(admitted.pondServiceGround).not.toBe(result.pondServiceGround);
        expect(Object.isFrozen(admitted.pondServiceGround)).toBe(true);
        for (const name of Object.keys(
          attributes,
        ) as (keyof typeof attributes)[])
          expect(admitted[name]).toBe(result[name]);
        const original = structuredClone(result.pondServiceGround);
        Reflect.set(result.pondServiceGround!.wear[0], "strength", 0);
        expect(admitted.pondServiceGround).toEqual(original);
        result.pondServiceGround = original;
        const missing = { ...result };
        delete missing.pondServiceGround;
        expect(() =>
          admitGrassWorkerPlacementResult(missing, requestInput),
        ).toThrow(/service ground mismatch/i);
        expect(() => admitGrassWorkerPlacementResult(result, input)).toThrow(
          /service ground mismatch/i,
        );
        expect(() =>
          admitGrassWorkerPlacementResult(
            {
              ...result,
              pondServiceGround: {
                ...result.pondServiceGround!,
                wornHeightScale: 0.5,
              },
            },
            requestInput,
          ),
        ).toThrow(/service ground mismatch/i);
      }
      for (const descriptor of [
        { ...serviceGroundFixture(), minimumScale: 0.5 },
        { ...serviceGroundFixture(), heightScale: 0.65 },
        {
          ...serviceGroundFixture(),
          wear: serviceGroundFixture().wear.slice(0, 2),
        },
        { ...serviceGroundFixture(), maxX: 450 },
        { ...serviceGroundFixture(), tipBrightness: 1.1 },
      ]) {
        const malformed = { ...input, pondServiceGround: descriptor };
        expect(() => prepareGrassWorkerRequest(malformed)).toThrow(
          /bank-verge descriptor/i,
        );
        await expect(worker.run(malformed)).rejects.toThrow(
          /bank-verge descriptor/i,
        );
        expect(() =>
          admitGrassWorkerPlacementResult(
            { ...active, pondServiceGround: descriptor },
            queued,
          ),
        ).toThrow(/bank-verge descriptor/i);
      }
      let getterCalls = 0;
      const accessor = { ...input };
      Object.defineProperty(accessor, "pondServiceGround", {
        enumerable: true,
        get() {
          getterCalls++;
          return serviceGroundFixture();
        },
      });
      expect(() => prepareGrassWorkerRequest(accessor)).toThrow(
        /bank-verge descriptor/i,
      );
      const getterResult = { ...active };
      Object.defineProperty(getterResult, "pondServiceGround", {
        enumerable: true,
        get() {
          getterCalls++;
          return serviceGroundFixture();
        },
      });
      expect(() =>
        admitGrassWorkerPlacementResult(getterResult, queued),
      ).toThrow(/bank-verge descriptor/i);
      const inherited = { ...input };
      Object.setPrototypeOf(inherited, {
        pondServiceGround: serviceGroundFixture(),
      });
      expect(() => prepareGrassWorkerRequest(inherited)).toThrow(
        /bank-verge descriptor/i,
      );
      for (const [field, marker] of [
        ["placementCoverage", "halved-v1"],
        ["compactPondBlend", "shore-contact-v1"],
        ["compactCoastBlend", "distribution-v1"],
      ] as const) {
        const inheritedMarker = { ...active };
        Object.setPrototypeOf(inheritedMarker, { [field]: marker });
        expect(() =>
          admitGrassWorkerPlacementResult(inheritedMarker, queued),
        ).toThrow();
        const accessorMarker = { ...active };
        Object.defineProperty(accessorMarker, field, {
          enumerable: true,
          get() {
            getterCalls++;
            return marker;
          },
        });
        expect(() =>
          admitGrassWorkerPlacementResult(accessorMarker, queued),
        ).toThrow();
      }
      expect(getterCalls).toBe(0);
      const ungraded = { ...queued };
      delete ungraded.compactGrassColorGrade;
      expect(() => prepareGrassWorkerRequest(ungraded)).toThrow(
        /graded compact meadow/i,
      );
      await expect(worker.run(ungraded)).rejects.toThrow(
        /graded compact meadow/i,
      );
      assertExactInstanceBytes(await worker.run(queued), active);
    }, true);
  });

  it("executes pond service ground through the freshly minified keepNames palette in an isolated real placement worker", async () => {
    const source = readFileSync(
      new URL("../CompactTerrainPalette.ts", import.meta.url),
      "utf8",
    );
    const factory = await extractMinifiedPaletteFactory(source);
    const current = `var compactTerrainColorOperations = (${createCompactTerrainColorOperations.toString()})();`;
    expect(GRASS_WORKER_CODE.split(current)).toHaveLength(2);
    // Only the exact production factory serialization changes. No naming-helper
    // shim, imported JSON, VM global or synthetic output repairs the child.
    const worker = actualWorker(
      GRASS_WORKER_CODE.replace(
        current,
        `var compactTerrainColorOperations = (${factory})();`,
      ),
    );
    try {
      await withTerrain(async (terrain, internals, reference) => {
        internals.loadWaterBodiesFromManifest();
        internals.loadFlatZonesFromManifest();
        const input: GrassWorkerInput = {
          ...request(terrain, internals, 384, 438, 6),
          grassEligibility: "compact-pbr-v1",
          compactGrassColorGrade: "fine-meadow-green-v1",
        };
        const selected = prepareGrassWorkerRequest({
          ...input,
          pondServiceGround: serviceGroundFixture(),
        });
        const expected = await reference.run(selected);
        expect(expected.count).toBeGreaterThan(0);
        const actual = await worker.run(selected);
        assertExactInstanceBytes(actual, expected);
        expect(actual.pondServiceGround).toEqual(selected.pondServiceGround);
        expect(
          admitGrassWorkerPlacementResult(actual, selected).pondServiceGround,
        ).toEqual(selected.pondServiceGround);
        const ordinary = await worker.run(input);
        assertExactInstanceBytes(ordinary, await reference.run(input));
        expect(ordinary).not.toHaveProperty("pondServiceGround");
        const malformed = {
          ...selected,
          pondServiceGround: {
            ...selected.pondServiceGround!,
            heightScale: 0.5,
          },
        };
        await expect(worker.run(malformed)).rejects.toThrow(
          /bank-verge descriptor/i,
        );
        assertExactInstanceBytes(await worker.run(selected), expected);
      }, true);
    } finally {
      await worker.close();
    }
  });

  it("keeps native16 placement, seeded poses and retained grounding exact while candidate worn turf changes only RGB", async () => {
    const previous = await native16PaletteWorker();
    const current = actualWorker();
    const receipts: Array<{
      coastalMeadow: boolean;
      cell: string;
      lod: number;
      count: number;
      projected: number;
      changedColors: number;
    }> = [];
    const equalNonColor = (a: GrassWorkerOutput, b: GrassWorkerOutput) => {
      expect(a.count).toBe(b.count);
      for (const name of [
        "offsets",
        "rotScaleHash",
        "grassTints",
        "groundNormals",
      ] as const) {
        const left = a[name],
          right = b[name];
        expect(
          Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
            Buffer.from(right.buffer, right.byteOffset, right.byteLength),
          ),
          name,
        ).toBe(true);
      }
      for (const name of [
        "terrainProfileIdentity",
        "grassEligibility",
        "chunkKey",
        "compactGrassColorGrade",
        "placementCell",
        "placementDistribution",
        "placementCoverage",
      ] as const)
        expect(a[name]).toEqual(b[name]);
    };
    try {
      for (const coastalMeadow of [false, true]) {
        const world = new World();
        const terrain = world.register(
          "terrain",
          TerrainSystem,
        ) as TerrainSystem;
        const roads = world.register(
          "roads",
          RoadNetworkSystem,
        ) as RoadNetworkSystem;
        const geometries: ReturnType<
          typeof assembleQuadChunkGeometry
        >["geometry"][] = [];
        const surfaces = new Map<string, RetainedTerrainSurface>();
        try {
          const live = terrain.getWorldTerrainProfile();
          expect(live.southernMeadow).toBeUndefined();
          // Existing admitted candidate profile selection, before real init;
          // no replacement height, color, ecology or road callbacks. This is
          // CPU factory isolation, not replay of the native camera/population.
          terrain["activeTerrainProfile"] = validateWorldTerrainProfile({
            ...live,
            ...(coastalMeadow
              ? {
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
                }
              : {}),
          });
          await terrain.init();
          const internals = terrain as unknown as Internals;
          internals.loadWaterBodiesFromManifest();
          internals.loadFlatZonesFromManifest();
          terrain["subscribeRoadNetworkEvents"]();
          await roads.init();
          await roads.start();
          const provider = terrain["buildChunkTerrainProvider"]();
          for (const [indexX, indexZ] of [
            [12, 11],
            [14, 13],
            [16, 14],
            [18, 18],
          ]) {
            const base = coverageRequest(terrain, internals, indexX, indexZ);
            const key = `${base.centerX},${base.centerZ}`;
            let surface = surfaces.get(key);
            if (!surface) {
              const { geometry } = assembleQuadChunkGeometry(
                generateQuadChunkDataSync(
                  base.centerX,
                  base.centerZ,
                  100,
                  128,
                  provider,
                ),
                provider,
                terrain["CONFIG"].QUADTREE_SKIRT_DROP,
              );
              geometries.push(geometry);
              surface = new RetainedTerrainSurface(
                surfaces.size + 1,
                provider.terrainProfileIdentity,
                base.centerX,
                base.centerZ,
                100,
                128,
                geometry,
              );
              surfaces.set(key, surface);
            }
            for (const lod of [0, 1]) {
              const queued = prepareGrassWorkerRequest({
                ...base,
                spacingMul: GRASS_CONFIG.LOD_TIERS[lod].spacingMul,
              });
              const requestBefore = structuredClone(queued);
              const before = await previous.run(queued);
              const after = await current.run(queued);
              expect(queued).toEqual(requestBefore);
              expect(before.count).toBeGreaterThan(0);
              expect(admitGrassWorkerPlacementResult(before, queued)).toEqual(
                before,
              );
              expect(admitGrassWorkerPlacementResult(after, queued)).toEqual(
                after,
              );
              equalNonColor(before, after);
              assertSurfaceParity(queued, after, internals);
              let changedColors = 0;
              for (let i = 0; i < after.groundColors.length; i++)
                if (after.groundColors[i] !== before.groundColors[i])
                  changedColors++;
              if (!coastalMeadow) assertExactInstanceBytes(before, after);
              const a = projectGrassAnchors(
                before,
                surface,
                (x, z) =>
                  terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
                (x, z) => terrain["isGrassExcludedAt"](x, z),
              );
              const b = projectGrassAnchors(
                after,
                surface,
                (x, z) =>
                  terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
                (x, z) => terrain["isGrassExcludedAt"](x, z),
              );
              equalNonColor(a, b);
              expect(a.grounding).toEqual(b.grounding);
              if (!coastalMeadow) assertExactInstanceBytes(a, b);
              receipts.push({
                coastalMeadow,
                cell: `${indexX},${indexZ}`,
                lod,
                count: after.count,
                projected: b.count,
                changedColors,
              });
            }
          }
        } finally {
          geometries.forEach((geometry) => geometry.dispose());
          world.destroy();
        }
      }
      expect(receipts).toHaveLength(16);
      expect(
        receipts
          .filter((r) => !r.coastalMeadow)
          .every((r) => r.changedColors === 0),
      ).toBe(true);
      for (const lod of [0, 1])
        expect(
          receipts
            .filter((r) => r.coastalMeadow && r.lod === lod)
            .reduce((sum, r) => sum + r.changedColors, 0),
        ).toBeGreaterThan(0);
      console.info("native16 palette-only worker comparison", {
        scope:
          "Real worker and retained-anchor CPU proof only; no native LOD lifecycle, blade/GPU or performance acceptance.",
        receipts,
      });
    } finally {
      await previous.close();
      await current.close();
    }
  }, 30000);

  it("runs the explicit sixty-centimetre cell through the real worker without changing the other fifteen cells", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const baselines = new Map<
        string,
        { input: GrassWorkerInput; result: GrassWorkerOutput }
      >();
      for (let z = 8; z < 12; z++)
        for (let x = 12; x < 16; x++) {
          const input = coverageRequest(terrain, internals, x, z);
          const result = await worker.run(input);
          expect(
            Object.prototype.hasOwnProperty.call(result, "placementCoverage"),
          ).toBe(false);
          baselines.set(input.chunkKey, { input, result });
        }
      const baseline = baselines.get("gcell_v1_12_11")!;
      const source: GrassWorkerInput = {
        ...baseline.input,
        clumpSpacing: 0.6,
        placementCoverage: "sixty-centimetre-cell-v1",
      };
      const queued = prepareGrassWorkerRequest(source);
      Reflect.set(source, "placementCoverage", "changed-after-queue");
      Reflect.set(source.placementCell!, "indexX", 13);
      expect(queued.placementCoverage).toBe("sixty-centimetre-cell-v1");
      expect(queued.placementCell?.indexX).toBe(12);
      const selected = await worker.run(queued);
      expect(selected.count).toBeGreaterThan(0);
      expect(selected.count).toBeLessThanOrEqual(1737);
      expect(selected.offsets).not.toEqual(baseline.result.offsets);
      expect(selected.placementCoverage).toBe("sixty-centimetre-cell-v1");
      expect(admitGrassWorkerPlacementResult(selected, queued)).toEqual(
        selected,
      );
      assertSurfaceParity(queued, selected, internals);
      // The marker is authority, not a second density formula: the same real
      // .6m input without it has the exact same five numeric arrays.
      const { placementCoverage: _coverage, ...unmarked } = queued;
      assertExactInstanceBytes(selected, await worker.run(unmarked));
      let unchangedCells = 0;
      for (const [key, before] of baselines) {
        if (key === queued.chunkKey) continue;
        const after = await worker.run(before.input);
        expect(Object.keys(after)).toEqual(Object.keys(before.result));
        assertExactInstanceBytes(after, before.result);
        unchangedCells++;
      }
      expect(unchangedCells).toBe(15);
      process.stdout.write(
        "SIXTY_CENTIMETRE_CELL_WORKER " +
          JSON.stringify({
            cell: queued.placementCell,
            baselineCandidates: 1276,
            trialCandidates: 1737,
            baselineClumps: baseline.result.count,
            trialClumps: selected.count,
            unchangedCells,
            scope:
              "Actual emitted worker only; not retained grounding, native coverage or performance acceptance.",
          }) +
          "\n",
      );
    });
  });

  it("rejects malformed coverage at queue and emitted-worker boundaries and rejects missing or wrong echoes even when empty", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const selected: GrassWorkerInput = {
        ...coverageRequest(terrain, internals, 12, 11),
        clumpSpacing: 0.6,
        placementCoverage: "sixty-centimetre-cell-v1",
      };
      const queued = prepareGrassWorkerRequest(selected);
      const active = await worker.run(queued);
      expect(active.count).toBeGreaterThan(0);
      // Actual offshore terrain produces an empty result with unchanged water
      // and vegetation rules, rather than substituting an empty worker response.
      const emptyInput: GrassWorkerInput = {
        ...coverageRequest(terrain, internals, 18, 25),
        clumpSpacing: 0.6,
        placementCoverage: "sixty-centimetre-cell-v1",
      };
      const empty = await worker.run(emptyInput);
      expect(empty.count).toBe(0);
      expect(empty.placementCoverage).toBe("sixty-centimetre-cell-v1");
      expect(admitGrassWorkerPlacementResult(empty, emptyInput)).toEqual(empty);
      for (const change of [
        { placementCoverage: undefined },
        { placementCoverage: null },
        { placementCoverage: false },
        { placementCoverage: "sixty-centimetre-cell-v2" },
        { placementCoverage: "half-metre-cell-v1" },
        { placementCell: undefined },
        { placementDistribution: undefined },
        { clumpSpacing: 0.7 },
        { clumpSpacing: 0.5 },
        { clumpSpacing: 0.3, spacingMul: 2 },
        { spacingMul: 5 },
        { grassEligibility: "legacy-biome-v1" },
      ]) {
        const bad = { ...queued, ...change } as GrassWorkerInput;
        expect(() => prepareGrassWorkerRequest(bad)).toThrow();
        await expect(worker.run(bad)).rejects.toThrow();
      }
      let getterReads = 0;
      for (const [result, input] of [
        [active, queued],
        [empty, emptyInput],
      ] as const) {
        const { placementCoverage: _coverage, ...missing } = result;
        const { placementCoverage: _inputCoverage, ...unselected } = input;
        expect(() => admitGrassWorkerPlacementResult(missing, input)).toThrow(
          /coverage/i,
        );
        expect(() =>
          admitGrassWorkerPlacementResult(result, unselected),
        ).toThrow(/coverage/i);
        for (const value of [
          undefined,
          null,
          false,
          "sixty-centimetre-cell-v2",
          "half-metre-cell-v1",
        ])
          expect(() =>
            admitGrassWorkerPlacementResult(
              { ...result, placementCoverage: value } as GrassWorkerOutput,
              input,
            ),
          ).toThrow(/coverage/i);
        for (const bad of [
          Object.assign(
            Object.create({ placementCoverage: "sixty-centimetre-cell-v1" }),
            missing,
          ),
          Object.defineProperty({ ...missing }, "placementCoverage", {
            value: "sixty-centimetre-cell-v1",
          }),
          Object.defineProperty({ ...missing }, "placementCoverage", {
            enumerable: true,
            get() {
              getterReads++;
              return "sixty-centimetre-cell-v1";
            },
          }),
        ])
          expect(() => admitGrassWorkerPlacementResult(bad, input)).toThrow(
            /coverage/i,
          );
      }
      expect(getterReads).toBe(0);
    });
  });

  it("filters candidate coastal grass without rephasing surviving roots in real uniform and stratified workers", async () => {
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    let worker: ReturnType<typeof actualWorker> | undefined;
    let previous: ReturnType<typeof actualWorker> | undefined;
    const ops = createCompactTerrainColorOperations();
    try {
      previous = beforeCoastalFilteringWorker();
      worker = actualWorker();
      const live = terrain.getWorldTerrainProfile();
      const profile = validateWorldTerrainProfile({
        ...live,
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
        coastalApron: {
          ...live.coastalApron!,
          lowland: { ...live.coastalApron!.lowland!, westHoldX: 440 },
        },
      });
      // The real instance selects its admitted profile before init, as in the
      // existing compact worker fixtures; no sampler or gameplay method is replaced.
      terrain["activeTerrainProfile"] = profile;
      await terrain.init();
      const internals = terrain as unknown as Internals;
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const base = request(terrain, internals, 450, 450, 100);
      const field = ops.macroField(profile)!;
      expect(field.coastalMeadow).toBe(true);
      expect(ops.macroField(live)).not.toHaveProperty("coastalMeadow");
      const keyAt = (result: GrassWorkerOutput, index: number) =>
        Array.from(result.offsets.subarray(index * 3, index * 3 + 3)).join(",");
      const coverageAt = (point: { x: number; y: number; z: number }) =>
        ops.coastalGroundCover({
          height: internals.getHeightAtComputed(point.x, point.z),
          noiseValue: sampleNoiseCPU(
            point.x,
            point.z,
            TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
          ),
          distortNoise: sampleNoiseCPU(
            point.x,
            point.z,
            TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
          ),
          field,
        });
      const receipts: Array<{
        cell: string;
        distribution: string;
        grassEligibility: string;
        grassSeed: number;
        before: number;
        after: number;
        removed: number;
        fullSoil: number;
        transition: number;
        outside: number;
      }> = [];
      let fullSoilFocus: { x: number; y: number; z: number } | undefined;
      const cases: Array<{
        grassSeed: number;
        distribution: GrassWorkerInput["placementDistribution"];
        grassEligibility: "compact-pbr-v1" | "legacy-biome-v1";
        indexX: number;
        indexZ: number;
      }> = [];
      for (const grassSeed of [37, 991]) {
        for (const distribution of [
          undefined,
          "fine-cell-stratified-v1",
        ] as const) {
          for (const [indexX, indexZ] of [
            [17, 18],
            [18, 18],
            [18, 19],
          ]) {
            cases.push({
              grassSeed,
              distribution,
              grassEligibility: "compact-pbr-v1",
              indexX,
              indexZ,
            });
          }
        }
      }
      cases.push({
        grassSeed: 37,
        distribution: undefined,
        grassEligibility: "legacy-biome-v1",
        indexX: 18,
        indexZ: 19,
      });
      for (const {
        grassSeed,
        distribution,
        grassEligibility,
        indexX,
        indexZ,
      } of cases) {
        const input: GrassWorkerInput = {
          ...base,
          grassSeed,
          grassEligibility,
          ...(grassEligibility === "compact-pbr-v1"
            ? { compactGrassColorGrade: "fine-meadow-green-v1" as const }
            : {}),
          clumpSpacing: 0.7,
          placementCell: { schemaVersion: 1, size: 25, indexX, indexZ },
          ...(distribution ? { placementDistribution: distribution } : {}),
        };
        const queued = prepareGrassWorkerRequest(input);
        const before = await previous.run(queued);
        const after = await worker.run(queued);
        expect(before.count).toBeGreaterThan(0);
        expect(admitGrassWorkerPlacementResult(after, queued)).toEqual(after);
        expect(after.count).toBeLessThanOrEqual(before.count);
        const indices = new Map(
          Array.from({ length: before.count }, (_, i) => [keyAt(before, i), i]),
        );
        expect(indices.size).toBe(before.count);
        const retained = new Set<string>();
        for (let i = 0; i < after.count; i++) {
          const key = keyAt(after, i),
            original = indices.get(key);
          expect(original).toBeDefined();
          if (original === undefined)
            throw new Error("Coastal filter introduced a new root");
          retained.add(key);
          for (const [name, stride] of Object.entries(attributes)) {
            const attribute = name as keyof typeof attributes;
            expect(
              after[attribute].subarray(i * stride, (i + 1) * stride),
            ).toEqual(
              before[attribute].subarray(
                original * stride,
                (original + 1) * stride,
              ),
            );
          }
        }
        expect(retained.size).toBe(after.count);
        let removed = 0,
          fullSoil = 0,
          transition = 0,
          outside = 0;
        for (const point of points(input, before)) {
          const coverage = coverageAt(point),
            kept = retained.has(keyAt(before, point.index));
          expect(coverage).toBeGreaterThanOrEqual(0);
          expect(coverage).toBeLessThanOrEqual(1);
          if (!kept) {
            removed++;
            expect(coverage).toBeGreaterThan(0);
          }
          if (coverage === 0) {
            outside++;
            expect(kept).toBe(true);
          } else if (coverage === 1) {
            fullSoil++;
            expect(kept).toBe(false);
            if (
              point.y > profile.water.threshold + 0.15 &&
              point.y < profile.water.threshold + 0.45
            )
              fullSoilFocus ??= point;
          } else transition++;
        }
        expect(removed).toBe(before.count - after.count);
        if (grassEligibility === "legacy-biome-v1")
          expect(removed).toBeGreaterThan(0);
        assertSurfaceParity(input, after, internals);
        for (const point of points(input, after)) {
          expect(coverageAt(point)).toBeLessThan(1);
          const main = terrain.getTerrainColorAt(point.x, point.z, true);
          const expected = ops.sample({
            grassColorGrade: input.compactGrassColorGrade,
            noiseValue: sampleNoiseCPU(
              point.x,
              point.z,
              TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
            ),
            meadowNoise: sampleNoiseCPU(
              point.x,
              point.z,
              ops.getComposition().meadowNoiseScale,
            ),
            distortNoise: sampleNoiseCPU(
              point.x,
              point.z,
              TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
            ),
            slope: 1 - main.ny,
            roadInfluence: 0,
            surface: {
              x: point.x,
              z: point.z,
              height: internals.getHeightAtComputed(point.x, point.z),
              pond:
                input.terrainSurface.waterBodies.find(
                  (body) => body.id === "haven_pond_water",
                ) ?? null,
              macroField: field,
            },
          });
          for (const [axis, channel] of (["r", "g", "b"] as const).entries())
            expect(
              Math.abs(
                after.groundColors[point.index * 3 + axis] - expected[channel],
              ),
            ).toBeLessThan(colorParityTolerance);
        }
        receipts.push({
          cell: `${indexX},${indexZ}`,
          distribution: distribution ?? "uniform",
          grassEligibility,
          grassSeed,
          before: before.count,
          after: after.count,
          removed,
          fullSoil,
          transition,
          outside,
        });
      }
      for (const field of [
        "removed",
        "fullSoil",
        "transition",
        "outside",
      ] as const)
        expect(
          receipts.reduce((sum, receipt) => sum + receipt[field], 0),
        ).toBeGreaterThan(0);
      expect(fullSoilFocus).toBeDefined();
      if (!fullSoilFocus)
        throw new Error("Actual coast did not expose the full mineral strip");
      const bareInput: GrassWorkerInput = {
        ...request(terrain, internals, fullSoilFocus.x, fullSoilFocus.z, 0.05),
        clumpSpacing: 0.005,
        grassEligibility: "compact-pbr-v1",
      };
      const bareBefore = await previous.run(bareInput);
      expect(bareBefore.count).toBeGreaterThan(0);
      for (const point of points(bareInput, bareBefore))
        expect(coverageAt(point)).toBe(1);
      const bareAfter = await worker.run(bareInput);
      expect(bareAfter.count).toBe(0);
      expect(admitGrassWorkerPlacementResult(bareAfter, bareInput)).toEqual(
        bareAfter,
      );
      // Omitted marker remains exact under a separate identical-profile pair.
      // No comparison ever attributes differences between terrain profiles to filtering.
      const omitted: GrassWorkerInput = {
        ...base,
        config: createTerrainWorkerConfig(live, base.config.TILE_RESOLUTION),
        grassEligibility: "compact-pbr-v1",
        clumpSpacing: 0.7,
        placementCell: { schemaVersion: 1, size: 25, indexX: 18, indexZ: 19 },
      };
      const omittedBefore = await previous.run(omitted),
        omittedAfter = await worker.run(omitted);
      expect(omittedAfter).toEqual(omittedBefore);
      process.stdout.write(
        `Coastal emitted-worker filtering (CPU, not native approval): ${JSON.stringify({ receipts, bareBefore: bareBefore.count, bareAfter: bareAfter.count, defaultCount: omittedAfter.count })}\n`,
      );
    } finally {
      await Promise.all([worker?.close(), previous?.close()]);
      world.destroy();
    }
  }, 30000);

  it("requires and echoes explicit stratified distribution at queue, emitted-worker, and result boundaries including empty outputs", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const input: GrassWorkerInput = {
        ...request(terrain, internals, 350, 350, 100),
        placementCell: {
          schemaVersion: 1,
          size: 25,
          indexX: 15,
          indexZ: 14,
        },
        grassEligibility: "compact-pbr-v1",
        clumpSpacing: 0.7,
      };
      const ordinary = await worker.run(input);
      expect(ordinary.count).toBeGreaterThan(0);
      expect(
        Object.prototype.hasOwnProperty.call(input, "placementDistribution"),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(ordinary, "placementDistribution"),
      ).toBe(false);
      const selected: GrassWorkerInput = {
        ...input,
        placementDistribution: "fine-cell-stratified-v1",
      };
      const queued = prepareGrassWorkerRequest(selected);
      expect(queued).not.toBe(selected);
      expect(queued.placementCell).not.toBe(selected.placementCell);
      expect(Object.isFrozen(queued.placementCell)).toBe(true);
      Reflect.set(selected, "placementDistribution", "changed-after-queue");
      expect(queued.placementDistribution).toBe("fine-cell-stratified-v1");
      const active = await worker.run(queued);
      expect(active.count).toBeGreaterThan(0);
      expect(active.count).toBeLessThanOrEqual(1276);
      expect(active.placementDistribution).toBe("fine-cell-stratified-v1");
      expect(active.placementCell).toEqual(queued.placementCell);
      expect(active.placementCell).not.toBe(queued.placementCell);
      // Selection must reach real sampling, not merely label legacy positions.
      // This inequality is not a quality, density, or improved-coverage oracle.
      expect(active.offsets).not.toEqual(ordinary.offsets);
      assertSurfaceParity(queued, active, internals);
      const admitted = admitGrassWorkerPlacementResult(active, queued);
      expect(admitted).toEqual(active);
      expect(admitted.placementCell).not.toBe(active.placementCell);
      expect(Object.isFrozen(admitted.placementCell)).toBe(true);
      for (const value of [
        undefined,
        null,
        false,
        "",
        "fine-cell-stratified-v2",
      ]) {
        const malformed = { ...input, placementDistribution: value };
        expect(() =>
          prepareGrassWorkerRequest(malformed as GrassWorkerInput),
        ).toThrow(/placement distribution/i);
        await expect(worker.run(malformed as GrassWorkerInput)).rejects.toThrow(
          /placement distribution/i,
        );
        expect(() =>
          admitGrassWorkerPlacementResult(
            { ...active, placementDistribution: value } as GrassWorkerOutput,
            queued,
          ),
        ).toThrow(/placement distribution/i);
      }
      const { placementCell: _cell, ...withoutCell } = queued;
      for (const invalidScope of [
        withoutCell,
        { ...queued, grassEligibility: undefined },
        { ...queued, grassEligibility: "legacy-biome-v1" as const },
      ]) {
        expect(() => prepareGrassWorkerRequest(invalidScope)).toThrow(
          /placement distribution/i,
        );
        await expect(worker.run(invalidScope)).rejects.toThrow(
          /placement distribution/i,
        );
      }
      const emptyInput = {
        ...queued,
        grassConfigs: Object.fromEntries(
          Object.entries(queued.grassConfigs).map(([key, config]) => [
            key,
            { ...config, density: 0 },
          ]),
        ),
      };
      const empty = await worker.run(emptyInput);
      expect(empty.count).toBe(0);
      expect(empty.placementDistribution).toBe("fine-cell-stratified-v1");
      expect(admitGrassWorkerPlacementResult(empty, emptyInput)).toEqual(empty);
      for (const result of [active, empty]) {
        const missing = { ...result };
        delete missing.placementDistribution;
        expect(() => admitGrassWorkerPlacementResult(missing, queued)).toThrow(
          /placement distribution/i,
        );
        expect(() => admitGrassWorkerPlacementResult(result, input)).toThrow(
          /placement distribution/i,
        );
      }
      expect(() =>
        admitGrassWorkerPlacementResult(
          { ...ordinary, placementDistribution: undefined },
          input,
        ),
      ).toThrow(/placement distribution/i);
    });
  });

  it("captures composition-v1 from complete snapshot owners and rejects stale modes across real worker transport", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      installPondCompositionBank(terrain, internals);
      const input: GrassWorkerInput = {
        ...request(terrain, internals, 350, 350, 100),
        grassEligibility: "compact-pbr-v1",
        placementCell: { schemaVersion: 1, size: 25, indexX: 13, indexZ: 12 },
        placementDistribution: "fine-cell-stratified-v1",
        clumpSpacing: 0.7,
      };
      const baseline = await worker.run(input);
      const selected: GrassWorkerInput = {
        ...input,
        compactPondBlend: "composition-v1",
      };
      const queued = prepareGrassWorkerRequest(selected);
      const sourceZone = selected.terrainSurface.zones.find(
        (zone) => zone.id === "haven_pond_floor",
      );
      const capturedZone = queued.terrainSurface.zones.find(
        (zone) => zone.id === "haven_pond_floor",
      );
      expect(capturedZone).not.toBe(sourceZone);
      expect(capturedZone?.radialPond?.bankComposition).not.toBe(
        sourceZone?.radialPond?.bankComposition,
      );
      expect(Object.isFrozen(capturedZone?.radialPond?.bankComposition)).toBe(
        true,
      );
      expect(
        Object.isFrozen(capturedZone?.radialPond?.bankComposition?.sectors),
      ).toBe(true);
      Reflect.set(selected, "compactPondBlend", "mutated-after-queue");
      expect(queued.compactPondBlend).toBe("composition-v1");
      const active = await worker.run(queued);
      expect(active.count).toBeGreaterThan(0);
      expect(active.compactPondBlend).toBe("composition-v1");
      expect(admitGrassWorkerPlacementResult(active, queued)).toEqual(active);
      const emptyInput: GrassWorkerInput = {
        ...queued,
        grassConfigs: Object.fromEntries(
          Object.entries(queued.grassConfigs).map(([key, value]) => [
            key,
            { ...value, density: 0 },
          ]),
        ),
      };
      const empty = await worker.run(emptyInput);
      expect(empty.count).toBe(0);
      expect(empty.compactPondBlend).toBe("composition-v1");
      expect(admitGrassWorkerPlacementResult(empty, emptyInput)).toEqual(empty);
      for (const result of [active, empty]) {
        const missing = { ...result };
        delete missing.compactPondBlend;
        expect(() => admitGrassWorkerPlacementResult(missing, queued)).toThrow(
          /pond distribution/i,
        );
        expect(() => admitGrassWorkerPlacementResult(result, input)).toThrow(
          /pond distribution/i,
        );
        expect(() =>
          admitGrassWorkerPlacementResult(
            { ...result, compactPondBlend: "shore-contact-v1" },
            queued,
          ),
        ).toThrow(/pond distribution/i);
      }
      let getterCalls = 0;
      for (const descriptor of [
        {
          enumerable: true,
          get() {
            getterCalls++;
            return "composition-v1";
          },
        },
        { enumerable: false, value: "composition-v1" },
      ]) {
        const badInput = { ...input };
        Object.defineProperty(badInput, "compactPondBlend", descriptor);
        expect(() => prepareGrassWorkerRequest(badInput)).toThrow(
          /pond distribution/i,
        );
      }
      const inherited = { ...input };
      Object.setPrototypeOf(inherited, { compactPondBlend: "composition-v1" });
      expect(() => prepareGrassWorkerRequest(inherited)).toThrow(
        /pond distribution/i,
      );
      expect(getterCalls).toBe(0);
      assertExactInstanceBytes(await worker.run(input), baseline);
    }, true);
  });

  it("fails closed for incomplete or mismatched composition snapshots, even for distant requests", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      installPondCompositionBank(terrain, internals);
      const input: GrassWorkerInput = {
        ...request(terrain, internals, 450, 450, 100),
        grassEligibility: "compact-pbr-v1",
        compactPondBlend: "composition-v1",
      };
      const surface = input.terrainSurface;
      const withoutZone = surface.zones.filter(
        (zone) => zone.id !== "haven_pond_floor",
      );
      const withoutPond = surface.waterBodies.filter(
        (body) => body.id !== "haven_pond_water",
      );
      const withoutComposition = surface.zones.map((zone) => {
        if (zone.id !== "haven_pond_floor" || !zone.radialPond) return zone;
        const { bankComposition: _composition, ...radialPond } =
          zone.radialPond;
        return { ...zone, radialPond };
      });
      for (const terrainSurface of [
        { ...surface, zones: withoutZone },
        { ...surface, waterBodies: withoutPond },
        { ...surface, zones: withoutZone, waterBodies: withoutPond },
        { ...surface, zones: withoutComposition },
        {
          ...surface,
          waterBodies: surface.waterBodies.map((body) =>
            body.id === "haven_pond_water"
              ? { ...body, centerX: body.centerX + 1 }
              : body,
          ),
        },
      ]) {
        const malformed = { ...input, terrainSurface };
        expect(() => prepareGrassWorkerRequest(malformed)).toThrow(
          /pond|composition/i,
        );
        await expect(worker.run(malformed)).rejects.toThrow(
          /pond|composition/i,
        );
      }
      // With complete actual owners retained, a genuinely distant mask is
      // neutral. Ownership is not guessed from missing regional records.
      const { compactPondBlend: _mode, ...ordinary } = input;
      assertExactInstanceBytes(
        await worker.run(prepareGrassWorkerRequest(input)),
        await worker.run(ordinary),
      );
      const legacy = { ...input, grassEligibility: "legacy-biome-v1" as const };
      expect(() => prepareGrassWorkerRequest(legacy)).toThrow(
        /pond distribution/i,
      );
      await expect(worker.run(legacy)).rejects.toThrow(/pond distribution/i);
    }, true);
  });

  it("authored emergence establishes deterministic new roots without rephasing existing roots or remote domains", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      installPondCompositionBank(terrain, internals);
      let added = 0,
        retained = 0;
      const rows: {
        cell: number[];
        density: number;
        before: number;
        after: number;
        added: number;
      }[] = [];
      for (const density of [0.37, 0.83])
        for (const [indexX, indexZ] of [
          [13, 11],
          [13, 12],
          [14, 11],
          [17, 17],
        ]) {
          const base = request(
            terrain,
            internals,
            Math.floor(indexX / 4) * 100 + 50,
            Math.floor(indexZ / 4) * 100 + 50,
            100,
          );
          const input: GrassWorkerInput = {
            ...base,
            compactPondBlend: "composition-v1",
            grassEligibility: "compact-pbr-v1",
            placementCell: { schemaVersion: 1, size: 25, indexX, indexZ },
            placementDistribution: "fine-cell-stratified-v1",
            clumpSpacing: 0.7,
            grassConfigs: Object.fromEntries(
              Object.entries(base.grassConfigs).map(([key, value]) => [
                key,
                { ...value, density },
              ]),
            ),
          };
          const candidate = structuredClone(input);
          const zone = candidate.terrainSurface.zones.find(
            (zone) => zone.id === "haven_pond_floor",
          )!;
          for (const row of zone.radialPond!.bankComposition!.sectors)
            Object.assign(row, {
              groundCover:
                row.surface === "cutbank"
                  ? { emergenceHeight: 0.15, fullHeight: 0.3 }
                  : row.surface === "sedge-shelf"
                    ? { emergenceHeight: 0.04, fullHeight: 0.12 }
                    : { emergenceHeight: 0.06, fullHeight: 0.16 },
            });
          const before = await worker.run(prepareGrassWorkerRequest(input));
          const after = await worker.run(prepareGrassWorkerRequest(candidate));
          const repeat = await worker.run(prepareGrassWorkerRequest(candidate));
          assertExactInstanceBytes(after, repeat);
          const keyAt = (data: GrassWorkerOutput, i: number) =>
            `${data.offsets[i * 3]},${data.offsets[i * 3 + 2]}`;
          const original = new Map(
            Array.from({ length: before.count }, (_, i) => [
              keyAt(before, i),
              i,
            ]),
          );
          let newInCell = 0,
            lastPrior = -1;
          for (let i = 0; i < after.count; i++) {
            const prior = original.get(keyAt(after, i));
            if (prior === undefined) {
              added++;
              newInCell++;
            } else {
              expect(prior).toBeGreaterThan(lastPrior);
              lastPrior = prior;
              retained++;
              for (const name of [
                "offsets",
                "rotScaleHash",
                "grassTints",
                "groundNormals",
              ] as const) {
                const stride = attributes[name];
                expect(
                  after[name].subarray(i * stride, (i + 1) * stride),
                ).toEqual(
                  before[name].subarray(prior * stride, (prior + 1) * stride),
                );
              }
            }
          }
          assertSurfaceParity(candidate, after, internals);
          if (indexX === 17) assertExactInstanceBytes(after, before);
          rows.push({
            cell: [indexX, indexZ],
            density,
            before: before.count,
            after: after.count,
            added: newInCell,
          });
        }
      expect(added).toBeGreaterThan(0);
      expect(retained).toBeGreaterThan(0);
      console.info(
        "Review73 actual worker new-root fork, fractional density, same geometry/attempts, unchanged water gate",
        JSON.stringify(rows),
      );
    }, true);
  });
  it("composition-v1 only thins the same terrain's historical seeded roots at fractional densities", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      installPondCompositionBank(terrain, internals);
      let retained = 0,
        removed = 0,
        changedColors = 0;
      for (const density of [0.37, 0.83]) {
        for (const [indexX, indexZ] of [
          [13, 11],
          [13, 12],
          [14, 11],
          [17, 17],
        ]) {
          const base = request(
            terrain,
            internals,
            Math.floor(indexX / 4) * 100 + 50,
            Math.floor(indexZ / 4) * 100 + 50,
            100,
          );
          const input: GrassWorkerInput = {
            ...base,
            grassEligibility: "compact-pbr-v1",
            placementCell: { schemaVersion: 1, size: 25, indexX, indexZ },
            placementDistribution: "fine-cell-stratified-v1",
            clumpSpacing: 0.7,
            grassConfigs: Object.fromEntries(
              Object.entries(base.grassConfigs).map(([key, value]) => [
                key,
                { ...value, density },
              ]),
            ),
          };
          const before = await worker.run(input);
          const after = await worker.run(
            prepareGrassWorkerRequest({
              ...input,
              compactPondBlend: "composition-v1",
            }),
          );
          const keyAt = (data: GrassWorkerOutput, i: number) =>
            `${data.offsets[i * 3]},${data.offsets[i * 3 + 2]}`;
          const original = new Map(
            Array.from({ length: before.count }, (_, i) => [
              keyAt(before, i),
              i,
            ]),
          );
          let previous = -1;
          for (let i = 0; i < after.count; i++) {
            const prior = original.get(keyAt(after, i));
            if (prior === undefined)
              throw new Error("Composition added a grass root");
            expect(prior).toBeGreaterThan(previous);
            previous = prior;
            for (const name of [
              "offsets",
              "rotScaleHash",
              "grassTints",
              "groundNormals",
            ] as const) {
              const stride = attributes[name];
              expect(
                after[name].subarray(i * stride, (i + 1) * stride),
              ).toEqual(
                before[name].subarray(prior * stride, (prior + 1) * stride),
              );
            }
            if (
              [0, 1, 2].some(
                (channel) =>
                  after.groundColors[i * 3 + channel] !==
                  before.groundColors[prior * 3 + channel],
              )
            )
              changedColors++;
            retained++;
          }
          removed += before.count - after.count;
          assertSurfaceParity(input, after, internals);
          if (indexX === 17) assertExactInstanceBytes(after, before);
        }
      }
      expect(retained).toBeGreaterThan(0);
      expect(removed).toBeGreaterThan(0);
      expect(changedColors).toBeGreaterThan(0);
      console.info(
        "Review68 same-terrain seeded composition subset",
        JSON.stringify({ retained, removed, changedColors }),
      );
    }, true);
  });

  it("captures pond distribution across real worker transport and rejects stale or malformed identities", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      installPondContactBank(terrain, internals);
      const input: GrassWorkerInput = {
        ...request(terrain, internals, 350, 350, 100),
        grassEligibility: "compact-pbr-v1",
        placementCell: { schemaVersion: 1, size: 25, indexX: 13, indexZ: 12 },
        placementDistribution: "fine-cell-stratified-v1",
        clumpSpacing: 0.7,
      };
      const baseline = await worker.run(input);
      expect(baseline.count).toBeGreaterThan(0);
      expect(baseline).not.toHaveProperty("compactPondBlend");
      const selected: GrassWorkerInput = {
        ...input,
        compactPondBlend: "shore-contact-v1",
      };
      const queued = prepareGrassWorkerRequest(selected);
      Reflect.set(selected, "compactPondBlend", "mutated-after-queue");
      expect(queued.compactPondBlend).toBe("shore-contact-v1");
      const active = await worker.run(queued);
      expect(active.compactPondBlend).toBe("shore-contact-v1");
      expect(admitGrassWorkerPlacementResult(active, queued)).toEqual(active);
      const emptyInput: GrassWorkerInput = {
        ...queued,
        grassConfigs: Object.fromEntries(
          Object.entries(queued.grassConfigs).map(([key, value]) => [
            key,
            { ...value, density: 0 },
          ]),
        ),
      };
      const empty = await worker.run(emptyInput);
      expect(empty.count).toBe(0);
      expect(empty.compactPondBlend).toBe("shore-contact-v1");
      expect(admitGrassWorkerPlacementResult(empty, emptyInput)).toEqual(empty);
      for (const result of [active, empty]) {
        const missing = { ...result };
        delete missing.compactPondBlend;
        expect(() => admitGrassWorkerPlacementResult(missing, queued)).toThrow(
          /pond distribution/i,
        );
        expect(() => admitGrassWorkerPlacementResult(result, input)).toThrow(
          /pond distribution/i,
        );
      }
      for (const value of [
        undefined,
        null,
        false,
        "",
        "relief-v1",
        "relief-contact-v1",
        "shore-contact-v2",
      ]) {
        const badInput = { ...input };
        Reflect.set(badInput, "compactPondBlend", value);
        expect(() => prepareGrassWorkerRequest(badInput)).toThrow(
          /pond distribution/i,
        );
        await expect(worker.run(badInput)).rejects.toThrow(
          /pond distribution/i,
        );
        const badResult = { ...active };
        Reflect.set(badResult, "compactPondBlend", value);
        expect(() =>
          admitGrassWorkerPlacementResult(badResult, queued),
        ).toThrow(/pond distribution/i);
      }
      let getterCalls = 0;
      for (const descriptor of [
        {
          enumerable: true,
          get() {
            getterCalls++;
            return "shore-contact-v1";
          },
        },
        { enumerable: false, value: "shore-contact-v1" },
      ]) {
        const badInput = { ...input };
        Object.defineProperty(badInput, "compactPondBlend", descriptor);
        expect(() => prepareGrassWorkerRequest(badInput)).toThrow(
          /pond distribution/i,
        );
        const badResult = { ...baseline };
        Object.defineProperty(badResult, "compactPondBlend", descriptor);
        expect(() => admitGrassWorkerPlacementResult(badResult, input)).toThrow(
          /pond distribution/i,
        );
      }
      const inherited = { ...input };
      Object.setPrototypeOf(inherited, {
        compactPondBlend: "shore-contact-v1",
      });
      expect(() => prepareGrassWorkerRequest(inherited)).toThrow(
        /pond distribution/i,
      );
      const inheritedResult = { ...baseline };
      Object.setPrototypeOf(inheritedResult, {
        compactPondBlend: "shore-contact-v1",
      });
      expect(() =>
        admitGrassWorkerPlacementResult(inheritedResult, input),
      ).toThrow(/pond distribution/i);
      expect(getterCalls).toBe(0);
      const legacy: GrassWorkerInput = {
        ...queued,
        grassEligibility: "legacy-biome-v1",
      };
      delete legacy.placementDistribution;
      expect(() => prepareGrassWorkerRequest(legacy)).toThrow(
        /pond distribution/i,
      );
      await expect(worker.run(legacy)).rejects.toThrow(/pond distribution/i);
      assertExactInstanceBytes(await worker.run(input), baseline);
    }, true);
  });

  it("only thins original pond roots at fractional density and leaves remote regional requests byte-identical", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      installPondContactBank(terrain, internals);
      const base = request(terrain, internals, 350, 350, 100);
      let retained = 0,
        removed = 0,
        changedColors = 0,
        changedScales = 0;
      for (const density of [0.37, 0.83]) {
        for (const [indexX, indexZ] of [
          [13, 11],
          [13, 12],
          [14, 12],
        ]) {
          const input: GrassWorkerInput = {
            ...request(terrain, internals, 350, indexZ < 12 ? 250 : 350, 100),
            grassEligibility: "compact-pbr-v1",
            placementCell: { schemaVersion: 1, size: 25, indexX, indexZ },
            placementDistribution: "fine-cell-stratified-v1",
            clumpSpacing: 0.7,
            grassConfigs: Object.fromEntries(
              Object.entries(base.grassConfigs).map(([key, value]) => [
                key,
                { ...value, density },
              ]),
            ),
          };
          const before = await worker.run(input);
          const after = await worker.run({
            ...input,
            compactPondBlend: "shore-contact-v1",
          });
          const keyAt = (data: GrassWorkerOutput, i: number) =>
            `${data.offsets[i * 3]},${data.offsets[i * 3 + 2]}`;
          const original = new Map(
            Array.from({ length: before.count }, (_, i) => [
              keyAt(before, i),
              i,
            ]),
          );
          let previous = -1;
          for (let i = 0; i < after.count; i++) {
            const prior = original.get(keyAt(after, i));
            if (prior === undefined)
              throw new Error("Pond distribution added a root");
            expect(prior).toBeGreaterThan(previous);
            previous = prior;
            for (const name of [
              "offsets",
              "grassTints",
              "groundNormals",
            ] as const) {
              const stride = attributes[name];
              expect(
                after[name].subarray(i * stride, (i + 1) * stride),
              ).toEqual(
                before[name].subarray(prior * stride, (prior + 1) * stride),
              );
            }
            // Rotation/hash retain exact seeded bits. Only the admitted
            // post-acceptance scale may shrink; the Float32 ratio bound allows
            // rounding of both stored operands, not a placement tolerance.
            expect(after.rotScaleHash[i * 3]).toBe(
              before.rotScaleHash[prior * 3],
            );
            expect(after.rotScaleHash[i * 3 + 2]).toBe(
              before.rotScaleHash[prior * 3 + 2],
            );
            const scaleRatio =
              after.rotScaleHash[i * 3 + 1] /
              before.rotScaleHash[prior * 3 + 1];
            expect(scaleRatio).toBeGreaterThanOrEqual(0.55 - 4 * 2 ** -23);
            expect(scaleRatio).toBeLessThanOrEqual(1 + 4 * 2 ** -23);
            if (
              after.rotScaleHash[i * 3 + 1] !==
              before.rotScaleHash[prior * 3 + 1]
            )
              changedScales++;
            if (
              [0, 1, 2].some(
                (channel) =>
                  after.groundColors[i * 3 + channel] !==
                  before.groundColors[prior * 3 + channel],
              )
            )
              changedColors++;
            retained++;
          }
          removed += before.count - after.count;
        }
      }
      // A remote regional snapshot intentionally has no Haven water body.
      // Pond selection is global; admission must not invent a regional pond.
      const remote: GrassWorkerInput = {
        ...request(terrain, internals, 450, 450, 100),
        grassEligibility: "compact-pbr-v1",
        placementCell: { schemaVersion: 1, size: 25, indexX: 17, indexZ: 17 },
        placementDistribution: "fine-cell-stratified-v1",
        clumpSpacing: 0.7,
      };
      remote.terrainSurface = { ...remote.terrainSurface, waterBodies: [] };
      const remoteSelected = prepareGrassWorkerRequest({
        ...remote,
        compactPondBlend: "shore-contact-v1",
      });
      assertExactInstanceBytes(
        await worker.run(remoteSelected),
        await worker.run(remote),
      );
      expect(retained).toBeGreaterThan(0);
      expect(changedColors).toBeGreaterThan(0);
      expect(changedScales).toBeGreaterThan(0);
      console.info(
        "Review62 actual-worker pond seeded subset and admitted scale",
        JSON.stringify({ retained, removed, changedColors, changedScales }),
      );
    }, true);
  });

  it("executes pond-only thinning on an explicit low dry-bank owner fixture, not a deployed pond capture", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      const pond = terrain
        .getWaterBodyRegistry()
        .getAllBodies()
        .find((body) => body.id === "haven_pond_water");
      if (!pond) throw new Error("Missing actual pond water owner");
      const x = pond.centerX + 9,
        z = pond.centerZ;
      const noise = sampleNoiseCPU(
        x,
        z,
        TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
      );
      const noiseHeight =
        (noise - 0.5) *
        2 *
        createCompactTerrainColorOperations().getComposition()
          .pondBankNoiseHeight;
      // A real registered dry depression outside the circular water footprint
      // deliberately covers the lower transfer half that the live .1m water
      // clearance mostly excludes. No replacement height/color/worker methods.
      terrain.registerFlatZone({
        id: "pond-support-lower-half-fixture",
        centerX: x,
        centerZ: z,
        width: 4,
        depth: 4,
        height: pond.surfaceY + noiseHeight + 0.04,
        blendRadius: 0,
        excludeGrass: false,
      });
      const input: GrassWorkerInput = {
        ...request(terrain, internals, x, z, 1),
        grassEligibility: "compact-pbr-v1",
        clumpSpacing: 0.08,
      };
      const before = await worker.run(input);
      const after = await worker.run({
        ...input,
        compactPondBlend: "shore-contact-v1",
      });
      expect(before.count).toBeGreaterThan(0);
      expect(after.count).toBe(0);
      for (const point of points(input, before)) {
        expect(
          Math.hypot(point.x - pond.centerX, point.z - pond.centerZ),
        ).toBeGreaterThan(pond.radius);
        expect(point.y).toBeGreaterThan(
          terrain.getWaterBodyRegistry().getWaterSurfaceAt(point.x, point.z) +
            0.1,
        );
      }
      console.info(
        "Review61 explicit lower-half fixture removal, not live pond",
        JSON.stringify({ before: before.count, after: after.count }),
      );
    }, true);
  });

  it("captures and strictly echoes coastal distribution across real worker transport, including empty results", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const base = request(terrain, internals, 450, 450, 100);
      const profile = validateWorldTerrainProfile({
        ...base.config.TERRAIN_PROFILE,
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
      const input: GrassWorkerInput = {
        ...base,
        config: createTerrainWorkerConfig(profile, base.config.TILE_RESOLUTION),
        grassEligibility: "compact-pbr-v1",
        placementCell: { schemaVersion: 1, size: 25, indexX: 18, indexZ: 18 },
        placementDistribution: "fine-cell-stratified-v1",
        clumpSpacing: 0.7,
      };
      const ordinary = await worker.run(input);
      expect(ordinary.count).toBeGreaterThan(0);
      expect(ordinary).not.toHaveProperty("compactCoastBlend");
      const selected: GrassWorkerInput = {
        ...input,
        compactCoastBlend: "distribution-v1",
      };
      const queued = prepareGrassWorkerRequest(selected);
      Reflect.set(selected, "compactCoastBlend", "changed-after-queue");
      expect(queued.compactCoastBlend).toBe("distribution-v1");
      const active = await worker.run(queued);
      expect(active.compactCoastBlend).toBe("distribution-v1");
      expect(admitGrassWorkerPlacementResult(active, queued)).toEqual(active);
      // Fractional biome density must not rephase later roots. Include both
      // the affected coast and untouched inland in the actual seeded worker,
      // rather than proving the subset only with the permissive density=1.
      const ops = createCompactTerrainColorOperations();
      const field = ops.macroField(profile, "distribution-v1");
      let fractionalRetained = 0;
      let fractionalOutside = 0;
      for (const density of [0.37, 0.83]) {
        for (const [indexX, indexZ] of [
          [17, 19],
          [17, 17],
        ]) {
          const fractional: GrassWorkerInput = {
            ...input,
            placementCell: { schemaVersion: 1, size: 25, indexX, indexZ },
            grassConfigs: Object.fromEntries(
              Object.entries(input.grassConfigs).map(([key, config]) => [
                key,
                { ...config, density },
              ]),
            ),
          };
          const before = await worker.run(fractional);
          const after = await worker.run({
            ...fractional,
            compactCoastBlend: "distribution-v1",
          });
          const keyAt = (data: GrassWorkerOutput, i: number) =>
            `${data.offsets[i * 3]},${data.offsets[i * 3 + 2]}`;
          const original = new Map(
            Array.from({ length: before.count }, (_, i) => [
              keyAt(before, i),
              i,
            ]),
          );
          const remaining = new Map(
            Array.from({ length: after.count }, (_, i) => [keyAt(after, i), i]),
          );
          let last = -1;
          for (let i = 0; i < after.count; i++) {
            const prior = original.get(keyAt(after, i));
            if (prior === undefined)
              throw new Error("Distribution added a fractional-density root");
            expect(prior).toBeGreaterThan(last);
            last = prior;
            for (const name of [
              "offsets",
              "rotScaleHash",
              "grassTints",
              "groundNormals",
            ] as const) {
              const stride = attributes[name];
              expect(
                after[name].subarray(i * stride, (i + 1) * stride),
              ).toEqual(
                before[name].subarray(prior * stride, (prior + 1) * stride),
              );
            }
            fractionalRetained++;
          }
          for (const point of points(fractional, before)) {
            // The selected domain follows the broader sea-relative coastal
            // coverage, not the narrow existing bare-shore grass exclusion.
            // With zero cliff and ridge inputs its nonzero soil coefficient
            // makes soil=0 an exact witness of zero coastal coverage.
            const cover = ops.coastWeights({
              x: point.x,
              z: point.z,
              height: point.y,
              noiseValue: sampleNoiseCPU(
                point.x,
                point.z,
                TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
              ),
              distortNoise: sampleNoiseCPU(
                point.x,
                point.z,
                TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
              ),
              slope: 0,
              westRock: 0,
              field,
            }).soil;
            if (cover !== 0) continue;
            const kept = remaining.get(keyAt(before, point.index));
            expect(kept).toBeDefined();
            if (kept === undefined)
              throw new Error("Distribution removed an outside-domain root");
            expect(after.groundColors.subarray(kept * 3, kept * 3 + 3)).toEqual(
              before.groundColors.subarray(
                point.index * 3,
                point.index * 3 + 3,
              ),
            );
            fractionalOutside++;
          }
        }
      }
      expect(fractionalRetained).toBeGreaterThan(0);
      expect(fractionalOutside).toBeGreaterThan(0);
      console.info(
        "Review55 nonunit-density seeded witnesses",
        JSON.stringify({ fractionalRetained, fractionalOutside }),
      );
      for (const value of [
        undefined,
        null,
        false,
        "",
        "detail-v1",
        "distribution-v2",
      ]) {
        const malformed = {
          ...input,
          compactCoastBlend: value,
        } as GrassWorkerInput;
        expect(() => prepareGrassWorkerRequest(malformed)).toThrow(
          /coastal distribution/i,
        );
        await expect(worker.run(malformed)).rejects.toThrow(
          /coastal distribution/i,
        );
        expect(() =>
          admitGrassWorkerPlacementResult(
            { ...active, compactCoastBlend: value } as GrassWorkerOutput,
            queued,
          ),
        ).toThrow(/coastal distribution/i);
      }
      let getterCalls = 0;
      for (const descriptor of [
        {
          enumerable: true,
          get() {
            getterCalls++;
            return "distribution-v1";
          },
        },
        { enumerable: false, value: "distribution-v1" },
      ]) {
        const malformed = { ...input };
        Object.defineProperty(malformed, "compactCoastBlend", descriptor);
        expect(() => prepareGrassWorkerRequest(malformed)).toThrow(
          /coastal distribution/i,
        );
        const result = { ...ordinary };
        Object.defineProperty(result, "compactCoastBlend", descriptor);
        expect(() => admitGrassWorkerPlacementResult(result, input)).toThrow(
          /coastal distribution/i,
        );
      }
      const inherited = { ...input };
      Object.setPrototypeOf(inherited, {
        compactCoastBlend: "distribution-v1",
      });
      expect(() => prepareGrassWorkerRequest(inherited)).toThrow(
        /coastal distribution/i,
      );
      expect(getterCalls).toBe(0);
      const { southernMeadow: _meadow, ...noMeadowProfile } = profile;
      for (const invalid of [
        {
          ...queued,
          grassEligibility: "legacy-biome-v1" as const,
          placementDistribution: undefined,
        },
        {
          ...queued,
          config: createTerrainWorkerConfig(
            validateWorldTerrainProfile({
              ...noMeadowProfile,
            }),
            base.config.TILE_RESOLUTION,
          ),
        },
      ]) {
        if (invalid.grassEligibility === "legacy-biome-v1")
          delete invalid.placementDistribution;
        expect(() => prepareGrassWorkerRequest(invalid)).toThrow(
          /coast(?:al)? distribution/i,
        );
        await expect(worker.run(invalid)).rejects.toThrow(
          /coast(?:al)? distribution/i,
        );
      }
      const emptyInput: GrassWorkerInput = {
        ...queued,
        grassConfigs: Object.fromEntries(
          Object.entries(queued.grassConfigs).map(([key, config]) => [
            key,
            { ...config, density: 0 },
          ]),
        ),
      };
      const empty = await worker.run(emptyInput);
      expect(empty.count).toBe(0);
      expect(empty.compactCoastBlend).toBe("distribution-v1");
      expect(admitGrassWorkerPlacementResult(empty, emptyInput)).toEqual(empty);
      for (const result of [active, empty]) {
        const missing = { ...result };
        delete missing.compactCoastBlend;
        expect(() => admitGrassWorkerPlacementResult(missing, queued)).toThrow(
          /coastal distribution/i,
        );
        expect(() => admitGrassWorkerPlacementResult(result, input)).toThrow(
          /coastal distribution/i,
        );
      }
      assertExactInstanceBytes(await worker.run(input), ordinary);
    });
  });

  it("admits and echoes the grass color grade without changing actual placement or legacy wire fields", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const input: GrassWorkerInput = {
        ...request(terrain, internals, 350, 350, 100),
        placementCell: {
          schemaVersion: 1,
          size: 25,
          indexX: 15,
          indexZ: 14,
        },
        grassEligibility: "compact-pbr-v1",
        clumpSpacing: 0.7,
      };
      const ungraded = await worker.run(input);
      expect(ungraded.count).toBeGreaterThan(0);
      expect(
        Object.prototype.hasOwnProperty.call(
          ungraded,
          "compactGrassColorGrade",
        ),
      ).toBe(false);
      const gradedInput: GrassWorkerInput = {
        ...input,
        compactGrassColorGrade: "fine-meadow-green-v1",
      };
      const queued = prepareGrassWorkerRequest(gradedInput);
      Reflect.set(gradedInput, "compactGrassColorGrade", "invalid-after-queue");
      const graded = await worker.run(queued);
      expect(graded.compactGrassColorGrade).toBe("fine-meadow-green-v1");
      expect(graded.count).toBe(ungraded.count);
      for (const name of [
        "offsets",
        "rotScaleHash",
        "grassTints",
        "groundNormals",
      ] as const)
        expect(graded[name]).toEqual(ungraded[name]);
      expect(graded.groundColors).not.toEqual(ungraded.groundColors);
      expect(admitGrassWorkerPlacementResult(graded, queued)).toEqual(graded);
      for (const value of [null, false, "unknown", "fine-meadow-green-v2"]) {
        const malformed = { ...input, compactGrassColorGrade: value };
        expect(() =>
          prepareGrassWorkerRequest(malformed as GrassWorkerInput),
        ).toThrow(/grass.*grade/i);
        await expect(worker.run(malformed as GrassWorkerInput)).rejects.toThrow(
          /grass.*grade/i,
        );
        expect(() =>
          admitGrassWorkerPlacementResult(
            { ...graded, compactGrassColorGrade: value } as GrassWorkerOutput,
            queued,
          ),
        ).toThrow(/grass.*grade/i);
      }
      const missing = { ...graded };
      delete missing.compactGrassColorGrade;
      expect(() => admitGrassWorkerPlacementResult(missing, queued)).toThrow(
        /grass.*grade/i,
      );
      expect(() => admitGrassWorkerPlacementResult(graded, input)).toThrow(
        /grass.*grade/i,
      );
      expect(() =>
        admitGrassWorkerPlacementResult(
          { ...ungraded, compactGrassColorGrade: undefined },
          input,
        ),
      ).toThrow(/grass.*grade/i);
      for (const eligibility of [undefined, "legacy-biome-v1"] as const) {
        const noncompact = { ...queued, grassEligibility: eligibility };
        expect(() => prepareGrassWorkerRequest(noncompact)).toThrow(
          /grade requires compact/i,
        );
        await expect(worker.run(noncompact)).rejects.toThrow(
          /grade requires compact/i,
        );
      }
      const empty = await worker.run({
        ...queued,
        grassConfigs: Object.fromEntries(
          Object.entries(queued.grassConfigs).map(([key, config]) => [
            key,
            { ...config, density: 0 },
          ]),
        ),
      });
      expect(empty.count).toBe(0);
      expect(empty.compactGrassColorGrade).toBe("fine-meadow-green-v1");
      expect(admitGrassWorkerPlacementResult(empty, queued)).toEqual(empty);
    });
  });

  it("keeps all five legacy arrays byte-exact against the real pre-cell sampling statements", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const previous = preCellSamplingWorker();
      try {
        for (const [x, z] of [
          [350, 350],
          [280, 340],
          [350, 450],
        ]) {
          const input = {
            ...request(terrain, internals, x, z, 8),
            clumpSpacing: 0.7,
          };
          const before = await previous.run(input);
          const after = await worker.run(input);
          expect(after.count).toBe(before.count);
          expect(
            Object.prototype.hasOwnProperty.call(
              after,
              "placementDistribution",
            ),
          ).toBe(false);
          expect(Object.keys(after)).toEqual(Object.keys(before));
          for (const key of Object.keys(
            attributes,
          ) as (keyof typeof attributes)[])
            expect(
              new Uint8Array(
                after[key].buffer,
                after[key].byteOffset,
                after[key].byteLength,
              ),
            ).toEqual(
              new Uint8Array(
                before[key].buffer,
                before[key].byteOffset,
                before[key].byteLength,
              ),
            );
        }
      } finally {
        await previous.close();
      }
    });
  });

  it("samples all sixteen grass cells in the real terrain leaf frame, with identical LOD0/1 placement and actual terrain parity", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const setup = internals.buildGrassWorkerSetup();
      const base = request(terrain, internals, 350, 350, 100);
      const seen = new Set<string>();
      let total = 0;
      const previous = preStratifiedCellSamplingWorker();
      try {
        for (let x = 12; x < 16; x++)
          for (let z = 12; z < 16; z++) {
            const cell: GrassPlacementCell = {
              schemaVersion: 1,
              size: 25,
              indexX: x,
              indexZ: z,
            };
            const bounds = getGrassPlacementCellBounds(cell);
            const input: GrassWorkerInput = {
              ...base,
              placementCell: cell,
              chunkKey: `cell_${x}_${z}_lod0`,
              clumpSpacing: 0.7,
              grassEligibility: "compact-pbr-v1",
              compactPlantingLobes: setup.compactPlantingLobes,
              grassConfigs: setup.grassConfigs,
              roadBlendWidth: 0.5,
              roadSegments: setup.getRoadSegmentsForRegion(
                bounds.minX,
                bounds.minZ,
                bounds.maxX,
                bounds.maxZ,
              ),
              terrainSurface: setup.getTerrainSurfaceForRegion(
                bounds.minX - 0.5,
                bounds.minZ - 0.5,
                bounds.maxX + 0.5,
                bounds.maxZ + 0.5,
              ),
            };
            const near = await worker.run(input);
            const unchanged = await previous.run(input);
            expect(near.count).toBe(unchanged.count);
            expect(Object.keys(near)).toEqual(Object.keys(unchanged));
            for (const key of Object.keys(
              attributes,
            ) as (keyof typeof attributes)[])
              expect(
                new Uint8Array(
                  near[key].buffer,
                  near[key].byteOffset,
                  near[key].byteLength,
                ),
              ).toEqual(
                new Uint8Array(
                  unchanged[key].buffer,
                  unchanged[key].byteOffset,
                  unchanged[key].byteLength,
                ),
              );
            const middle = await worker.run({
              ...input,
              chunkKey: `cell_${x}_${z}_lod1`,
              spacingMul: 1,
            });
            expect(near.placementCell).toEqual(cell);
            expect(near.placementCell).not.toBe(cell);
            expect(
              Object.prototype.hasOwnProperty.call(
                near,
                "placementDistribution",
              ),
            ).toBe(false);
            expect(
              Object.prototype.hasOwnProperty.call(
                middle,
                "placementDistribution",
              ),
            ).toBe(false);
            expect(near.count).toBeLessThanOrEqual(1276);
            expect(near.count).toBe(middle.count);
            for (const key of Object.keys(
              attributes,
            ) as (keyof typeof attributes)[])
              expect(near[key]).toEqual(middle[key]);
            assertSurfaceParity(input, near, internals);
            for (const point of points(input, near)) {
              expect(point.x).toBeGreaterThanOrEqual(bounds.minX);
              expect(point.x).toBeLessThanOrEqual(bounds.maxX);
              expect(point.z).toBeGreaterThanOrEqual(bounds.minZ);
              expect(point.z).toBeLessThanOrEqual(bounds.maxZ);
              const key = `${point.x},${point.z}`;
              expect(seen.has(key)).toBe(false);
              seen.add(key);
            }
            total += near.count;
          }
        expect(total).toBeGreaterThan(1000);
        expect(seen.size).toBe(total);
      } finally {
        await previous.close();
      }
    });
  }, 30000);

  it("detaches actual queue and result cells and rejects corrupted emitted requests or echoed domains", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const mutable = {
        schemaVersion: 1 as const,
        size: 25 as const,
        indexX: 14,
        indexZ: 14,
      };
      const input = {
        ...request(terrain, internals, 350, 350, 100),
        clumpSpacing: 0.7,
        placementCell: mutable,
      };
      const queued = prepareGrassWorkerRequest(input);
      expect(queued.placementCell).not.toBe(mutable);
      expect(Object.isFrozen(queued.placementCell)).toBe(true);
      expect(queued.terrainSurface).not.toBe(input.terrainSurface);
      expect(queued.terrainSurface.zones[0]).not.toBe(
        input.terrainSurface.zones[0],
      );
      mutable.indexX = 15;
      expect(queued.placementCell?.indexX).toBe(14);
      const result = await worker.run(queued);
      const admitted = admitGrassWorkerPlacementResult(result, queued);
      expect(admitted.placementCell).toEqual(queued.placementCell);
      expect(admitted.placementCell).not.toBe(result.placementCell);
      expect(admitted.placementCell).not.toBe(queued.placementCell);
      expect(Object.isFrozen(admitted.placementCell)).toBe(true);
      for (const bad of [
        { ...queued, placementCell: { ...queued.placementCell!, indexX: 16 } },
        {
          ...queued,
          placementCell: { ...queued.placementCell!, indexX: Infinity },
        },
        { ...queued, placementCell: { ...queued.placementCell!, extra: true } },
        { ...queued, clumpSpacing: 0.1 },
      ]) {
        expect(() => prepareGrassWorkerRequest(bad)).toThrow(
          "Invalid grass placement cell",
        );
        await expect(worker.run(bad)).rejects.toThrow(
          "Invalid grass placement cell",
        );
      }
      expect(() =>
        admitGrassWorkerPlacementResult(
          {
            ...result,
            placementCell: { ...queued.placementCell!, indexX: 15 },
          },
          queued,
        ),
      ).toThrow("placement cell mismatch");
      const { placementCell: _cell, ...missing } = result;
      expect(() => admitGrassWorkerPlacementResult(missing, queued)).toThrow(
        "Invalid grass placement cell",
      );
      expect(() =>
        admitGrassWorkerPlacementResult(result, {
          ...queued,
          placementCell: undefined,
        }),
      ).toThrow("Unexpected grass worker placement cell");
      const legacy = await worker.run({
        ...request(terrain, internals, 350, 350, 4),
        clumpSpacing: 0.7,
      });
      expect(
        Object.prototype.hasOwnProperty.call(legacy, "placementCell"),
      ).toBe(false);
    });
  });

  it("matches ridge macro colours in actual main/worker grass without changing height, normal or ecology", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const ops = createCompactTerrainColorOperations();
      const macroField = ops.macroField(terrain.getWorldTerrainProfile());
      expect(macroField).not.toBeNull();
      let activeMacroSamples = 0;
      let omittedFieldError = 0;
      for (const [x, z] of [
        [225, 410],
        [260, 410],
        [280, 410],
      ]) {
        const input = {
          ...request(terrain, internals, x, z, 6),
          clumpSpacing: 0.2,
        };
        const result = await worker.run(input);
        expect(result.count).toBeGreaterThan(50);
        assertSurfaceParity(input, result, internals);
        for (const point of points(input, result)) {
          const main = terrain.getTerrainColorAt(point.x, point.z, true);
          const noiseValue = sampleNoiseCPU(
            point.x,
            point.z,
            TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
          );
          const distortNoise = sampleNoiseCPU(
            point.x,
            point.z,
            TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
          );
          const paletteInput = {
            noiseValue,
            meadowNoise: sampleNoiseCPU(point.x, point.z, 0.006),
            distortNoise,
            slope: 1 - main.ny,
            roadInfluence: 0,
            surface: {
              x: point.x,
              z: point.z,
              height: internals.getHeightAtComputed(point.x, point.z),
              pond:
                input.terrainSurface.waterBodies.find(
                  (body) => body.id === "haven_pond_water",
                ) ?? null,
              macroField,
            },
          };
          const expected = ops.sample(paletteInput);
          const withoutMacro = ops.sample({
            ...paletteInput,
            surface: { ...paletteInput.surface, macroField: null },
          });
          if (
            ops.macroWeights(point.x, point.z, noiseValue, macroField).dry > 0
          )
            activeMacroSamples++;
          const ecology = computeTerrainColorCPU(
            point.x,
            point.z,
            point.y,
            1 - main.ny,
            1,
            0,
          );
          // Compact forest classification is unchanged. Visible RGB is not
          // allowed to feed back into the legacy ecology/acceptance weight.
          expect(main.grassWeight).toBeCloseTo(ecology.grassWeight, 4);
          for (const [axis, channel] of (["r", "g", "b"] as const).entries()) {
            expect(main[channel]).toBeCloseTo(expected[channel], 12);
            expect(
              Math.abs(
                result.groundColors[point.index * 3 + axis] - expected[channel],
              ),
            ).toBeLessThan(colorParityTolerance);
            omittedFieldError = Math.max(
              omittedFieldError,
              Math.abs(expected[channel] - withoutMacro[channel]),
            );
          }
        }
      }
      expect(activeMacroSamples).toBeGreaterThan(100);
      // Omitting the field must fail the unchanged numerical parity check,
      // without demanding the old palette's exaggerated red amplitude.
      expect(omittedFieldError).toBeGreaterThan(2 * colorParityTolerance);
    });
  });

  it("keeps actual pond-bank worker colours aligned with main and includes the exterior soil halo", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
      const setup = internals.buildGrassWorkerSetup();
      const halo = setup.getTerrainSurfaceForRegion(
        pond.centerX + pond.radius + 1,
        pond.centerZ - 0.1,
        pond.centerX + pond.radius + 1.2,
        pond.centerZ + 0.1,
      );
      expect(halo.waterBodies.some((b) => b.id === pond.id)).toBe(true);
      const far = setup.getTerrainSurfaceForRegion(
        pond.centerX + pond.radius + 4,
        pond.centerZ - 0.1,
        pond.centerX + pond.radius + 4.2,
        pond.centerZ + 0.1,
      );
      expect(far.waterBodies.some((b) => b.id === pond.id)).toBe(false);
      const input = {
        ...request(terrain, internals, pond.centerX, pond.centerZ, 22),
        clumpSpacing: 0.2,
      };
      const result = await worker.run(input);
      expect(result.count).toBeGreaterThan(50);
      const ops = createCompactTerrainColorOperations();
      let dryShoulderSamples = 0;
      for (const p of points(input, result)) {
        const main = terrain.getTerrainColorAt(p.x, p.z, true);
        const height = terrain["getHeightAtComputed"](p.x, p.z);
        for (const [axis, channel] of (["r", "g", "b"] as const).entries())
          expect(
            Math.abs(result.groundColors[p.index * 3 + axis] - main[channel]),
          ).toBeLessThan(0.0002);
        if (height >= pond.surfaceY + 0.28) {
          const weights = ops.pondWeights({
            x: p.x,
            z: p.z,
            height,
            pond,
            noiseValue: sampleNoiseCPU(
              p.x,
              p.z,
              TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
            ),
          });
          expect(weights.soil).toBeCloseTo(0, 12);
          expect(weights.wetness).toBe(0);
          dryShoulderSamples++;
        }
      }
      // The actual grass worker rejects the water footprint. Its surviving
      // dry bank must no longer be forced into the broad soil ring in probe16.
      expect(dryShoulderSamples).toBeGreaterThan(50);
    });
  });
  it("uses the compact diffuse palette in actual worker and main grass bases without changing placement ecology", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      terrain.registerFlatZone(broadGrade());
      const input = {
        ...request(terrain, internals, 350, 400, 12),
        clumpSpacing: 0.2,
      };
      const result = await worker.run(input);
      expect(result.count).toBeGreaterThan(50);
      const ops = createCompactTerrainColorOperations();
      const macroField = ops.macroField(terrain.getWorldTerrainProfile());
      expect(macroField).not.toBeNull();
      let legacyPaletteError = 0;
      for (const point of points(input, result)) {
        const main = terrain.getTerrainColorAt(point.x, point.z, true);
        // CompactTerrainMaterial.test independently reconstructs these palette
        // means from the actual packed diffuse texels. Here qualify the actual
        // main/worker integration against that current palette, not a minimum
        // distance from an unrelated legacy green channel.
        const expected = ops.sample({
          meadowNoise: sampleNoiseCPU(point.x, point.z, 0.006),
          noiseValue: sampleNoiseCPU(
            point.x,
            point.z,
            TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
          ),
          distortNoise: sampleNoiseCPU(
            point.x,
            point.z,
            TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
          ),
          slope: 1 - main.ny,
          roadInfluence: 0,
          surface: {
            x: point.x,
            z: point.z,
            height: internals.getHeightAtComputed(point.x, point.z),
            pond:
              input.terrainSurface.waterBodies.find(
                (body) => body.id === "haven_pond_water",
              ) ?? null,
            macroField,
          },
        });
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
          expect(main[channel]).toBeCloseTo(expected[channel], 12);
          expect(
            Math.abs(
              result.groundColors[point.index * 3 + axis] - expected[channel],
            ),
          ).toBeLessThan(colorParityTolerance);
          legacyPaletteError = Math.max(
            legacyPaletteError,
            Math.abs(expected[channel] - legacy[channel]),
          );
        }
      }
      // A fallback to legacy RGB cannot pass the same Float32 parity tolerance.
      expect(legacyPaletteError).toBeGreaterThan(2 * colorParityTolerance);
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

  it("releases grass-only grading shoulders through the actual worker while preserving detached requests and surface parity", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      const grade = { ...broadGrade(), excludeGrass: true };
      terrain.registerFlatZone(grade);
      const oldInput = request(terrain, internals, 350, 400, 12);
      const oldResult = await worker.run(oldInput);
      expect(oldResult.count).toBe(0);
      const bounds = { minX: 348, maxX: 352, minZ: 398, maxZ: 402 };
      const bounded = { ...grade, grassExclusionBounds: bounds };
      terrain.registerFlatZone(bounded);
      const input = request(terrain, internals, 350, 400, 12);
      const queued = prepareGrassWorkerRequest(input);
      const captured = queued.terrainSurface.zones.find(
        (zone) => zone.id === grade.id,
      )!;
      expect(captured.grassExclusionBounds).toEqual(bounds);
      expect(captured.grassExclusionBounds).not.toBe(bounds);
      const before = structuredClone(queued);
      input.terrainSurface.zones.find(
        (zone) => zone.id === grade.id,
      )!.grassExclusionBounds!.minX -= 0.5;
      expect(queued).toEqual(before);
      const result = await worker.run(queued);
      expect(result.count).toBeGreaterThan(20);
      for (const point of points(queued, result)) {
        expect(
          point.x < bounds.minX ||
            point.x > bounds.maxX ||
            point.z < bounds.minZ ||
            point.z > bounds.maxZ,
        ).toBe(true);
        expect(Math.abs(point.x - grade.centerX)).toBeLessThan(grade.width / 2);
        expect(Math.abs(point.z - grade.centerZ)).toBeLessThan(grade.depth / 2);
      }
      assertSurfaceParity(queued, result, internals);
      const repeat = await worker.run(queued);
      expect(repeat.count).toBe(result.count);
      for (const key of Object.keys(attributes) as (keyof typeof attributes)[])
        expect(repeat[key]).toEqual(result[key]);
      // The old request remains old even after same-ID production registration.
      expect(
        oldInput.terrainSurface.zones.find((zone) => zone.id === grade.id),
      ).not.toHaveProperty("grassExclusionBounds");
      expect((await worker.run(oldInput)).count).toBe(0);
      for (const invalid of [
        undefined,
        null,
        { ...bounds, minX: NaN },
        { ...bounds, maxX: 999 },
      ]) {
        const malformed = structuredClone(queued);
        Object.defineProperty(
          malformed.terrainSurface.zones.find((zone) => zone.id === grade.id)!,
          "grassExclusionBounds",
          { value: invalid, enumerable: true },
        );
        expect(() => prepareGrassWorkerRequest(malformed)).toThrow(
          /grassExclusionBounds/,
        );
        await expect(worker.run(malformed)).rejects.toThrow(
          /grassExclusionBounds/,
        );
      }
      terrain.registerFlatZone({
        id: "independent-shoulder-pad",
        centerX: 345,
        centerZ: 400,
        width: 1,
        depth: 4,
        height: grade.height,
        blendRadius: 0.5,
      });
      const paddedInput = request(terrain, internals, 350, 400, 12);
      const padded = await worker.run(paddedInput);
      expect(padded.count).toBeGreaterThan(0);
      expect(
        points(paddedInput, padded).filter(
          (point) =>
            Math.abs(point.x - 345) <= 1 && Math.abs(point.z - 400) <= 2.5,
        ),
      ).toEqual([]);
      assertSurfaceParity(paddedInput, padded, internals);
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

  it("keeps explicit asymmetric pond candidate worker heights, normals, colour and local water eligibility aligned", async () => {
    await withTerrain(async (terrain, internals, worker) => {
      internals.loadWaterBodiesFromManifest();
      internals.loadFlatZonesFromManifest();
      const area = ALL_WORLD_AREAS.haven_pond;
      const manifestPond = area.flatZones?.find((zone) => zone.radialPond);
      if (!manifestPond?.radialPond || manifestPond.height === undefined)
        throw new Error("Missing actual loaded pond profile");
      const original = internals.flatZones.get(manifestPond.id);
      if (!original?.radialPond)
        throw new Error("Missing registered original pond profile");
      const bankSectors = [
        {
          bearing: (-133 * Math.PI) / 180,
          halfWidth: (40 * Math.PI) / 180,
          innerRadius: 6.25,
          innerHeight: 27.84,
        },
        {
          bearing: (-27 * Math.PI) / 180,
          halfWidth: (24 * Math.PI) / 180,
          innerRadius: 6.55,
          innerHeight: 28.08,
        },
      ];
      // Local candidate only: the loaded/frozen world manifest stays unchanged.
      expect(manifestPond.radialPond.bankSectors).toBeUndefined();
      const protectedQueries = [
        [340.5, 307], // Actual southern fishing resource approach.
        [original.centerX, original.centerZ],
        [original.centerX - 10, original.centerZ],
        [original.centerX + 10, original.centerZ],
        [original.centerX, original.centerZ + 8],
      ].flatMap(([x, z]) =>
        [
          [0, 0],
          [-0.5, 0],
          [0.5, 0],
          [0, -0.5],
          [0, 0.5],
        ].map(([dx, dz]) => ({ x: x + dx, z: z + dz })),
      );
      const protectedHeights = protectedQueries.map(({ x, z }) =>
        internals.getHeightAtComputed(x, z),
      );
      terrain.registerFlatZone({
        ...original,
        radialPond: { ...original.radialPond, bankSectors },
      });
      expect(
        protectedQueries.map(({ x, z }) => internals.getHeightAtComputed(x, z)),
      ).toEqual(protectedHeights);
      const input: GrassWorkerInput = {
        ...request(terrain, internals, original.centerX, original.centerZ, 22),
        grassEligibility: "compact-pbr-v1",
        clumpSpacing: 0.35,
      };
      expect(
        input.terrainSurface.zones.find((zone) => zone.id === original.id)
          ?.radialPond?.bankSectors,
      ).toEqual(bankSectors);
      const result = await worker.run(input);
      expect(result.count).toBeGreaterThan(50);
      const legacyZones = input.terrainSurface.zones.map((zone) =>
        zone.id === original.id
          ? {
              ...zone,
              radialPond: { ...zone.radialPond!, bankSectors: undefined },
            }
          : zone,
      );
      const surface = createAuthoredTerrainSurfaceOperations();
      const registry = terrain.getWaterBodyRegistry();
      const changedSectorSamples = [0, 0];
      for (const point of points(input, result)) {
        expect(point.y).toBeGreaterThanOrEqual(
          registry.getWaterSurfaceAt(point.x, point.z) + 0.1 - 1e-4,
        );
        const main = terrain.getTerrainColorAt(
          point.x,
          point.z,
          true,
          "compact-pbr-v1",
        );
        expect(main.grassWeight).toBeGreaterThan(0);
        for (const [axis, channel] of (["r", "g", "b"] as const).entries())
          expect(
            Math.abs(
              result.groundColors[point.index * 3 + axis] - main[channel],
            ),
          ).toBeLessThan(colorParityTolerance);
        const dx = point.x - original.centerX;
        const dz = point.z - original.centerZ;
        if (Math.hypot(dx, dz) >= 8.8) continue;
        const oldHeight = surface.resolveHeight(
          legacyZones,
          point.x,
          point.z,
          () => terrain.getProceduralHeightAt(point.x, point.z),
          internals.arenaFloorZoneIds,
          internals.arenaGradeHeight,
        );
        if (oldHeight === null || Math.abs(point.y - oldHeight) < 0.002)
          continue;
        const angle = Math.atan2(dz, dx);
        bankSectors.forEach((sector, index) => {
          const delta = Math.atan2(
            Math.sin(angle - sector.bearing),
            Math.cos(angle - sector.bearing),
          );
          if (Math.abs(delta) < sector.halfWidth) changedSectorSamples[index]++;
        });
      }
      expect(changedSectorSamples[0]).toBeGreaterThan(0);
      expect(changedSectorSamples[1]).toBeGreaterThan(0);
      expect(
        assertSurfaceParity(input, result, internals).sloped,
      ).toBeGreaterThan(10);
      expect(manifestPond.radialPond.bankSectors).toBeUndefined();
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
