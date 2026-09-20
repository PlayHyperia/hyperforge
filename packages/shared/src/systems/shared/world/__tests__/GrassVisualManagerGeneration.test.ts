import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";
import { StorageBufferAttribute } from "three/webgpu";
import { INSTANCE_MATRIX_STORAGE_ATTRIBUTE } from "../../../../utils/rendering/createStorageInstancedMesh";

import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { stationDataProvider } from "../../../../data/StationDataProvider";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import {
  createGrassTerrainSurfaceSnapshot,
  GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
} from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  GrassVisualManager,
  GRASS_CONFIG,
  FINE_MEADOW_GRASS_VISUAL_PROFILE,
  FINE_MEADOW_APPEARANCE,
  createClumpGeometry,
  STREAMING_GRASS_VISUAL_PROFILE,
  type GrassWorkerSetup,
  type GrassVisualProfile,
} from "../GrassVisualManager";
import { TerrainQuadTree } from "../TerrainQuadTree";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainVisualManager } from "../TerrainVisualManager";
import { RetainedGridFixture } from "./terrain-grid.fixture";
import {
  createCompactTerrainColorOperations,
  type CompactGrassColorGrade,
} from "../CompactTerrainPalette";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import {
  groundGrassBlades,
  groundGrassBladeSteps,
  GRASS_BLADE_GROUNDING_LIMITS,
  type GrassBladeGroundingReceipt,
  type GrassBladeGroundingRequest,
  type GrassGroundingRoadSegment,
} from "../GrassBladeGrounding";
import {
  projectGrassAnchors,
  remapGrassGroundingSteps,
  type GrassAnchorData,
} from "../GrassTerrainProjection";
import { roadInfluenceOperations } from "../RoadInfluence";
import { getGrassBladeLayout } from "../GrassBladeLayout";
import {
  GRASS_BLADE_VISIBILITY_ATTRIBUTE,
  GRASS_ROOT_STORAGE_ATTRIBUTE,
} from "../GrassGroundingGpu";
import type {
  RetainedTerrainSurface,
  TerrainGridBounds,
} from "../TerrainGridSurface";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { EventType } from "../../../../types/events";
import { sameFaceHash } from "./fixtures/GrassBladeGroundingSameFaceCases";
import { groundGrassBladeSteps as legacyGroundGrassBladeSteps } from "./fixtures/LegacyGrassBladeGroundingReference";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";

const profile = COMPACT_WORLD_TERRAIN_PROFILE;

/** Offline diagnostic only: reuse the actual private numerical helpers, not a
 * different segment-distance algorithm or a second rotation/tilt convention.
 * Exact unique boundaries exclude module initialization and generator work. */
function actualRoadEnvelopeHelpers() {
  const source = readFileSync(
    new URL("../GrassBladeGrounding.ts", import.meta.url),
    "utf8",
  );
  const between = (start: string, end: string) => {
    expect(source.split(start)).toHaveLength(2);
    expect(source.split(end)).toHaveLength(2);
    const begin = source.indexOf(start),
      finish = source.indexOf(end, begin);
    expect(finish).toBeGreaterThan(begin);
    return source.slice(begin, finish);
  };
  const distance = between(
    "function pointBoxDistance(",
    "function* validateGeometry(",
  );
  const transform = between(
    "      const rotation = data.rotScaleHash[k],",
    "      const baseBounds = {",
  );
  const guard = source.match(/^const NUMERIC_GUARD = ([0-9.]+);$/gm);
  expect(guard).toHaveLength(1);
  const emitted = transpileModule(
    distance +
      `
function createTransform(data, ownSurface, position, i) {
  const k = i * 3, x = ownSurface.centerX + data.offsets[k],
    y = data.offsets[k + 1], z = ownSurface.centerZ + data.offsets[k + 2];
  const bankHeightScale = 1; // Explicit historical, ungraded deformation.
${transform}
  return transform;
}
${guard![0]}
`,
    { compilerOptions: { target: ScriptTarget.ES2022 } },
  ).outputText;
  type Point = { x: number; y: number; z: number };
  return new Function(
    emitted +
      "\nreturn {segmentBoxDistance, createTransform, numericGuard: NUMERIC_GUARD};",
  )() as {
    segmentBoxDistance: (
      road: GrassGroundingRoadSegment,
      box: TerrainGridBounds,
    ) => number;
    createTransform: (
      data: GrassAnchorData,
      ownSurface: RetainedTerrainSurface,
      position: ReturnType<THREE.BufferGeometry["getAttribute"]>,
      index: number,
    ) => (vertex: number, fade: number, target: Point) => void;
    numericGuard: number;
  };
}

/** Road-only broad/narrow census; never installs hypothetical geometry. The
 * unmodified core with roads omitted separately applies every other guard. */
function measureRoadEnvelopeGaps(request: GrassBladeGroundingRequest) {
  const helpers = actualRoadEnvelopeHelpers();
  const actual = groundGrassBlades(request);
  const withoutRoads = groundGrassBlades({ ...request, roadSegments: [] });
  if (actual.status !== "ready" || withoutRoads.status !== "ready")
    throw new Error(
      "Road diagnostic needs complete original and road-disabled core results",
    );
  const position = request.geometry.getAttribute("position"),
    uv = request.geometry.getAttribute("uv");
  const layout = getGrassBladeLayout(request.lod, request.geometryLayout);
  const verticesPerBlade = position.count / layout.bladesPerClump;
  expect(Number.isInteger(verticesPerBlade)).toBe(true);
  expect(layout.bladesPerClump).toBe(24);
  const empty = (): TerrainGridBounds => ({
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  });
  const merge = (into: TerrainGridBounds, box: TerrainGridBounds) => {
    into.minX = Math.min(into.minX, box.minX);
    into.maxX = Math.max(into.maxX, box.maxX);
    into.minZ = Math.min(into.minZ, box.minZ);
    into.maxZ = Math.max(into.maxZ, box.maxZ);
  };
  const roads = request.roadSegments.flatMap((road) => {
    const feather = roadInfluenceOperations.getExclusionFeather(
      road.blendWidth ?? 0.5,
      road.maxInfluence ?? 1,
    );
    return feather === null ? [] : [{ road, radius: road.width / 2 + feather }];
  });
  const touches = (box: TerrainGridBounds, road: (typeof roads)[number]) =>
    helpers.segmentBoxDistance(road.road, box) <= road.radius;
  const retained = new Set(actual.sourceIndices),
    otherwiseEligible = new Set(withoutRoads.sourceIndices);
  const retainedBounds = empty(),
    roadOnlyGaps: number[] = [],
    eligibleGaps: number[] = [];
  const boxes: TerrainGridBounds[] = [];
  const survivingBlades: number[] = [],
    additionalClumps: number[] = [];
  const survivorBins = { "1-6": 0, "7-12": 0, "13-18": 0, "19-23": 0, "24": 0 };
  let additionalVisibleBlades = 0;
  let broadHits = 0,
    narrowHits = 0;
  for (let i = 0; i < request.data.count; i++) {
    const transform = helpers.createTransform(
      request.data,
      request.ownSurface,
      position,
      i,
    );
    const whole = empty(),
      blades = Array.from({ length: layout.bladesPerClump }, empty);
    const point = { x: 0, y: 0, z: 0 };
    for (let v = 0; v < position.count; v++) {
      const blade = blades[Math.floor(v / verticesPerBlade)],
        windFactor = uv.getY(v) ** 1.8;
      for (let fade = 0; fade < 2; fade++) {
        transform(v, fade, point);
        blade.minX = Math.min(
          blade.minX,
          point.x - request.wind.x * windFactor - helpers.numericGuard,
        );
        blade.maxX = Math.max(
          blade.maxX,
          point.x + request.wind.x * windFactor + helpers.numericGuard,
        );
        blade.minZ = Math.min(
          blade.minZ,
          point.z - request.wind.z * windFactor - helpers.numericGuard,
        );
        blade.maxZ = Math.max(
          blade.maxZ,
          point.z + request.wind.z * windFactor + helpers.numericGuard,
        );
      }
    }
    for (const blade of blades) merge(whole, blade);
    boxes.push(whole);
    const broadRoads = roads.filter((road) => touches(whole, road));
    const broad = broadRoads.length > 0;
    const narrow = broadRoads.some((road) =>
      blades.some((blade) => touches(blade, road)),
    );
    // Independent all-capsule check, not just one offending road. These are
    // actual geometry blades whose complete fade/wind boxes would survive a
    // hypothetical visibility mask, not requested worker density or pixels.
    const surviving = blades.filter((blade) =>
      roads.every((road) => !touches(blade, road)),
    ).length;
    survivingBlades.push(surviving);
    expect(surviving < layout.bladesPerClump).toBe(narrow);
    if (broad) broadHits++;
    if (narrow) narrowHits++;
    if (retained.has(i)) {
      expect(broad).toBe(false);
      expect(otherwiseEligible.has(i)).toBe(true);
      expect(surviving).toBe(layout.bladesPerClump);
      merge(retainedBounds, whole);
    }
    if (broad && !narrow) {
      expect(retained.has(i)).toBe(false);
      roadOnlyGaps.push(i);
      if (otherwiseEligible.has(i)) eligibleGaps.push(i);
    }
    if (!retained.has(i) && otherwiseEligible.has(i) && surviving > 0) {
      additionalClumps.push(i);
      additionalVisibleBlades += surviving;
      const bin =
        surviving <= 6
          ? "1-6"
          : surviving <= 12
            ? "7-12"
            : surviving <= 18
              ? "13-18"
              : surviving <= 23
                ? "19-23"
                : "24";
      survivorBins[bin]++;
    }
    // With only the road gate removed, actual retention is exactly its
    // intersection with the original broad-box predicate. Pad/base/water and
    // retained-surface guards have not been approximated by this diagnostic.
    expect(retained.has(i)).toBe(otherwiseEligible.has(i) && !broad);
  }
  expect(actual.sweptBounds).not.toBeNull();
  for (const key of ["minX", "maxX", "minZ", "maxZ"] as const)
    expect(retainedBounds[key]).toBe(actual.sweptBounds![key]);
  expect(survivorBins["24"]).toBe(eligibleGaps.length);
  expect(
    Object.values(survivorBins).reduce((sum, count) => sum + count, 0),
  ).toBe(additionalClumps.length);
  const centers = (indices: number[]) =>
    indices
      .map((sourceIndex) => ({
        sourceIndex,
        x: request.ownSurface.centerX + request.data.offsets[sourceIndex * 3],
        z:
          request.ownSurface.centerZ +
          request.data.offsets[sourceIndex * 3 + 2],
        scale: request.data.rotScaleHash[sourceIndex * 3 + 1],
        survivingBlades: survivingBlades[sourceIndex],
        swept: boxes[sourceIndex],
      }))
      .sort(
        (a, b) =>
          Math.hypot(a.x - 348, a.z - 321) - Math.hypot(b.x - 348, b.z - 321),
      )
      .slice(0, 8);
  return {
    actual,
    report: {
      projectedCandidates: request.data.count,
      actualRetained: actual.sourceIndices.length,
      actualRetainedIndicesPrefix: Array.from(
        actual.sourceIndices.slice(0, 12),
      ),
      actualRoadRejections: actual.receipt.rejected.road,
      allBroadRoadHits: broadHits,
      allPerBladeRoadHits: narrowHits,
      roadOnlyFalsePositives: roadOnlyGaps.length,
      otherwiseEligibleWithoutRoads: withoutRoads.sourceIndices.length,
      eligibleRoadOnlyFalsePositives: eligibleGaps.length,
      otherRejectedFalsePositives: roadOnlyGaps.length - eligibleGaps.length,
      roadOnlyCenters: centers(roadOnlyGaps),
      eligibleCenters: centers(eligibleGaps),
      partialVisibility: {
        actualVisibleBlades:
          actual.sourceIndices.length * layout.bladesPerClump,
        additionalEligibleClumps: additionalClumps.length,
        additionalPartialClumps: additionalClumps.length - survivorBins["24"],
        additionalVisibleBlades,
        hypotheticalVisibleBlades:
          actual.sourceIndices.length * layout.bladesPerClump +
          additionalVisibleBlades,
        survivingBladeCountBins: survivorBins,
        nearestAdditionalCenters: centers(additionalClumps),
      },
      scope:
        "Offline hypothetical road predicate only; not installed, not native performance or visual approval",
    },
  };
}

/** Analytic graded input; the real manager, geometry, worker and callbacks run unchanged. */
function fixture(
  waterSurface?: number,
  visualProfile: GrassVisualProfile = { maxChunksPerFrame: 1 },
) {
  const fixtureProfile =
    visualProfile.id === "fine-meadow-v1"
      ? DataManager.getWorldTerrainProfile()
      : profile;
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
    terrainConfig: createTerrainWorkerConfig(fixtureProfile, 4),
    seed: fixtureProfile.seed,
    biomeCenters: [{ x: 350, z: 320, type: "forest", influence: 1000 }],
    biomes: {
      forest: { heightModifier: 1, color: { r: 0.2, g: 0.4, b: 0.1 } },
    },
    grassConfigs: { forest: grass, tundra: grass, canyon: grass },
    tileSize: fixtureProfile.terrainTileSize,
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
    worldTerrainProfileIdentity(fixtureProfile),
    () => state.height,
  );
  const manager = new GrassVisualManager(
    worldTerrainProfileIdentity(fixtureProfile),
    container,
    grids.get,
    () => {
      state.heightSamples++;
      return state.height;
    },
    fixtureProfile.water.threshold,
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
    undefined,
    visualProfile.id === "fine-meadow-v1" ? "fine-meadow-v1" : undefined,
  );
  manager.setPlayerPosition(350, 320);
  const fine = visualProfile.id === "fine-meadow-v1";
  const size = fine ? 100 : 8;
  const tree = new TerrainQuadTree({
    minSize: size,
    maxDepth: 1,
    resolution: 4,
  });
  const node = tree.createNode(null, null, size, 350, fine ? 350 : 320, 1);
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
  source = GRASS_WORKER_CODE,
): Promise<GrassWorkerOutput> {
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    globalThis.self = { postMessage: (value, transfers) => parentPort.postMessage(value, transfers) };
    ${source}
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

// Exact executed native23/candidate29 shoulder recipe, retained through native37.
// Do not inherit today's narrower fades when replaying old semantic hashes,
// same-face work counters, or native23 bank-core worker comparisons. Arrival
// feather arithmetic is pinned too; no historical centerline is reauthored.
const HISTORICAL_MEADOW_SHOULDERS = new Map([
  ["compact-path-pond-bank", { width: 0.65, blendWidth: 1.075 }],
  ["compact-path-bank-lobby", { width: 0.9, blendWidth: 1.15 }],
  ["compact-clearing-bank-apron", { width: 1, blendWidth: 1 }],
  ["compact-clearing-bank-clerk-approach", { width: 0.7, blendWidth: 0.75 }],
  [
    "compact-clearing-bank-shopkeeper-approach",
    { width: 0.65, blendWidth: 0.625 },
  ],
  [
    "compact-wear-bank-lobby-end-arrival",
    { width: 2.2, blendWidth: 0.9 / 2 + 1.15 - 1.1 },
  ],
  [
    "compact-wear-lobby-arena-start-arrival",
    { width: 2.2, blendWidth: 1.4 / 2 + 0.9 - 1.1 },
  ],
  [
    "compact-wear-lobby-arena-end-arrival",
    { width: 2.2, blendWidth: 1.4 / 2 + 0.9 - 1.1 },
  ],
]);

// Both archived station-clearance studies used this exact source geometry.
// Do not inherit a new canopy into their old semantic hashes/work counters.
const HISTORICAL_LINEAR_FINE_GEOMETRY = Object.freeze({
  BLADE_HEIGHT_MIN: 0.38,
  BLADE_HEIGHT_MAX: 0.86,
  BLADE_WIDTH_RATIO: 0.045,
  BLADE_TAPER: 0.85,
  BLADE_TAPER_POWER: 1,
  BLADE_ARC_RATIO: 0.48,
  BLADE_CONTROL_HEIGHT: 0.76,
  BLADE_TIP_HEIGHT: 0.95,
  PROGRESSIVE_ROOTS: true,
});

/** Real admitted terrain/roads and retained geometry; no analytic ground or
 * replacement manager generation methods participate in placement parity. */
async function coastalFixture(
  candidate: boolean,
  center: readonly [number, number] = [450, 450],
  retainEastNeighbour = false,
  visualProfile: GrassVisualProfile = FINE_MEADOW_GRASS_VISUAL_PROFILE,
  pathRecipe: "current" | "candidate29" = "current",
  grassGrade?: CompactGrassColorGrade,
  geometryRecipe: "current-canopy" | "historical-linear" = "current-canopy",
  coastBlend?: "distribution-v1",
  pondBlend?: "shore-contact-v1" | "composition-v1",
) {
  await DataManager.getInstance().initialize();
  const baselineProfile = DataManager.getWorldTerrainProfile();
  const admitted = validateWorldTerrainProfile({
    ...baselineProfile,
    ...(candidate
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
          coastalApron: {
            ...baselineProfile.coastalApron,
            lowland: {
              ...baselineProfile.coastalApron?.lowland,
              westHoldX: 440,
            },
          },
        }
      : {}),
  });
  const bankWorld =
    center[0] === 350 && (center[1] === 350 || center[1] === 250);
  const config = DataManager.getWorldConfig()!;
  const owners = bankWorld
    ? Object.fromEntries(
        ["worldConfig", "worldTerrainProfile", "worldContentIdentity"].map(
          (key) => [key, Object.getOwnPropertyDescriptor(DataManager, key)!],
        ),
      )
    : null;
  if (owners) {
    // Select a separate fixture world BEFORE construction, just like the
    // existing path suite. RoadNetworkSystem and terrain share this owner.
    Object.defineProperty(DataManager, "worldContentIdentity", {
      ...owners.worldContentIdentity,
      value: null,
    });
    DataManager.setWorldConfig({ ...config, terrainProfile: admitted });
  }
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  // Bind the explicit fixture before init, never replace an identified world.
  terrain["activeTerrainProfile"] = admitted;
  // Historical captures are explicitly ungraded. Current graded cases select
  // the restart-owned value before worker/material construction, not afterwards.
  terrain["compactGrassColorGrade"] = grassGrade ?? null;
  terrain["compactCoastBlend"] = coastBlend ?? null;
  terrain["compactPondBlend"] = pondBlend ?? null;
  if (coastBlend || pondBlend) terrain["compactSurfaceBlend"] = "height-v1";
  await terrain.init();
  if (pondBlend !== "composition-v1") {
    terrain["loadWaterBodiesFromManifest"]();
    terrain["loadFlatZonesFromManifest"]();
  }
  if (pondBlend === "shore-contact-v1") {
    // Explicit review52 bank inputs, through the real authoritative owner;
    // unchanged historical fixtures never enter this branch.
    const original = terrain["flatZones"].get("haven_pond_floor");
    if (!original?.radialPond)
      throw new Error("Missing actual Haven pond zone");
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
          {
            bearing: 0.7,
            halfWidth: 0.55,
            innerRadius: 6.4,
            innerHeight: 27.86,
          },
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
  terrain["subscribeRoadNetworkEvents"]();
  await roads.init();
  await roads.start();
  if (bankWorld) expect(roads.getRoads()).toHaveLength(23);
  if (pathRecipe === "candidate29") {
    expect(bankWorld && candidate).toBe(true);
    const stored = roads.getRoads();
    for (const id of HISTORICAL_MEADOW_SHOULDERS.keys())
      expect(stored.filter((road) => road.id === id)).toHaveLength(1);
    stored.splice(
      0,
      stored.length,
      ...stored.map((road) => ({
        ...road,
        ...HISTORICAL_MEADOW_SHOULDERS.get(road.id),
      })),
    );
    roads["buildTileCache"]();
    // Reuse the real generation event so both the terrain fallback and worker
    // setup observe this fixture before any retained surface is generated.
    world.emit(EventType.ROADS_GENERATED, {
      roadCount: stored.length,
      townCount: 0,
      poiCount: 0,
      explorationRoadCount: 0,
    });
  }
  const setup = terrain["buildGrassWorkerSetup"]();
  expect(setup.compactGrassColorGrade).toBe(grassGrade);
  expect(setup.compactCoastBlend).toBe(coastBlend);
  expect(setup.compactPondBlend).toBe(pondBlend);
  expect(
    setup.terrainConfig.TERRAIN_PROFILE.coastalApron?.lowland?.westHoldX,
  ).toBe(candidate ? 440 : 445);
  const material = new THREE.MeshBasicMaterial();
  const visual = new TerrainVisualManager(
    {
      minSize: 100,
      maxDepth: 4,
      resolution: bankWorld ? 64 : 16,
      rootChunkRadius: 0,
      ...(bankWorld
        ? {
            fineDetailRegions: createCompactPreparationDetailRegions(
              admitted,
              ALL_WORLD_AREAS,
              64,
            ),
          }
        : {}),
    },
    terrain["buildChunkTerrainProvider"](),
    new THREE.Group(),
    material,
    setup.terrainConfig,
    setup.seed,
    setup.biomeCenters,
    setup.biomes,
  );
  const node = visual
    .getQuadTree()
    .createNode(null, null, 100, center[0], center[1], 4);
  visual["generateChunkSync"](node);
  if (bankWorld) {
    // Bank cells touch this leaf's north boundary; retain actual neighbouring
    // terrain for swept blade support instead of weakening grounding rules.
    const neighbour = visual
      .getQuadTree()
      .createNode(null, null, 100, center[0], center[1] - 100, 4);
    visual["generateChunkSync"](neighbour);
  }
  if (retainEastNeighbour) {
    // The control cell reaches the east leaf edge. Its swept blades need the
    // same real neighbouring support as the station cells need to the north.
    const neighbour = visual
      .getQuadTree()
      .createNode(null, null, 100, center[0] + 100, center[1], 4);
    visual["generateChunkSync"](neighbour);
  }
  const observed = { coastal: 0, reduced: 0 };
  const manager = new GrassVisualManager(
    setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
    new THREE.Group(),
    (leaf) => visual.getRetainedSurface(leaf),
    (x, z) => terrain["getHeightAtComputed"](x, z),
    setup.terrainConfig.WATER_THRESHOLD,
    (x, z) => terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
    (x, z) => terrain["isGrassExcludedAt"](x, z),
    (x, z, eligibility) => {
      const value = terrain.getTerrainColorAt(x, z, true, eligibility);
      if (value.grassPlacementBeforeCoast !== undefined) {
        observed.coastal++;
        if (value.grassPlacementBeforeCoast > value.grassPlacement)
          observed.reduced++;
      }
      return value;
    },
    setup,
    visualProfile,
    undefined,
    (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
    (bounds) => visual.captureRetainedSurfaceRegion(bounds),
    "fine-meadow-v1",
  );
  if (geometryRecipe === "historical-linear") {
    // Historical-only fixture input, installed before any generation/update.
    // Keep real manager/worker/grounding methods; the current-canopy case below
    // never takes this branch or replaces its constructor-owned geometries.
    expect(manager["chunks"].size).toBe(0);
    expect(manager["groundingJobs"].size).toBe(0);
    let historicalRadius = 0;
    for (let lod = 0; lod < 3; lod++) {
      const layout = getGrassBladeLayout(lod, "fine-linear-sweep-3seg-v1");
      const geometry = createClumpGeometry(
        layout.bladesPerClump,
        layout.bladeSegments,
        HISTORICAL_LINEAR_FINE_GEOMETRY,
      );
      manager["lodGeometries"][lod].dispose();
      manager["lodGeometries"][lod] = geometry;
      if (lod <= 1) {
        const positions = geometry.getAttribute("position");
        for (let vertex = 0; vertex < positions.count; vertex++)
          historicalRadius = Math.max(
            historicalRadius,
            Math.hypot(
              positions.getX(vertex),
              positions.getY(vertex),
              positions.getZ(vertex),
            ),
          );
      }
    }
    // The unchanged extremal tips retain the old full support halo exactly;
    // do not silently widen historical dependency capture to fit new geometry.
    expect(manager["groundingHalo"]).toBe(
      Math.max(
        GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
        historicalRadius * GRASS_BLADE_GROUNDING_LIMITS.maxScale * 1.01 +
          GRASS_CONFIG.WIND_STRENGTH * 0.86 +
          0.01,
      ),
    );
  }
  manager.setPlayerPosition(center[0], center[1]);
  manager["lodFocusX"] = center[0];
  manager["lodFocusZ"] = center[1];
  manager.onNodeNeedsGeometry(node);
  return {
    manager,
    terrain,
    roads,
    observed,
    setup,
    close() {
      manager.destroy();
      visual.dispose();
      material.dispose();
      world.destroy();
      if (owners) {
        Object.defineProperties(DataManager, owners);
        expect(DataManager.getWorldConfig()).toBe(config);
        expect(DataManager.getWorldTerrainProfile()).toBe(baselineProfile);
      }
    },
  };
}

/** The composition owner seals its bank at startup. Install this explicit test
 * manifest before init, then restore the exact shared references on close/error.
 * Historical fixtures never use this branch or acquire different terrain. */
async function compositionFixture(
  coastBlend?: "distribution-v1",
  groundCover = false,
) {
  await DataManager.getInstance().initialize();
  const area = ALL_WORLD_AREAS.haven_pond;
  const originalZones = area.flatZones;
  if (!originalZones) throw new Error("Missing actual pond manifest zones");
  const ownerDescriptors = Object.fromEntries(
    ["worldConfig", "worldTerrainProfile", "worldContentIdentity"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(DataManager, key)!],
    ),
  );
  let replaced = 0;
  area.flatZones = originalZones.map((zone) => {
    if (zone.id !== "haven_pond_floor") return zone;
    if (!zone.radialPond) throw new Error("Missing actual radial pond");
    replaced++;
    return {
      ...zone,
      radialPond: {
        ...zone.radialPond,
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
          {
            bearing: 0.7,
            halfWidth: 0.55,
            innerRadius: 6.4,
            innerHeight: 27.86,
          },
          {
            bearing: -1.5533430342749532,
            halfWidth: 0.8726646259971648,
            innerRadius: 7.1,
            innerHeight: 27.86,
            outerRadius: 8.7,
            outerHeight: 27.99,
          },
        ],
        bankComposition: {
          schemaVersion: 1 as const,
          sectors: [
            {
              sectorIndex: 0,
              surface: "sedge-shelf" as const,
              ...(groundCover
                ? { groundCover: { emergenceHeight: 0.04, fullHeight: 0.12 } }
                : {}),
            },
            {
              sectorIndex: 1,
              surface: "cutbank" as const,
              ...(groundCover
                ? { groundCover: { emergenceHeight: 0.15, fullHeight: 0.3 } }
                : {}),
            },
            {
              sectorIndex: 3,
              surface: "dry-turf" as const,
              ...(groundCover
                ? { groundCover: { emergenceHeight: 0.06, fullHeight: 0.16 } }
                : {}),
            },
          ],
        },
      },
    };
  });
  const restore = () => {
    area.flatZones = originalZones;
    Object.defineProperties(DataManager, ownerDescriptors);
  };
  try {
    expect(replaced).toBe(1);
    const f = await coastalFixture(
      true,
      groundCover ? [350, 250] : [350, 350],
      false,
      FINE_MEADOW_GRASS_VISUAL_PROFILE,
      "current",
      "fine-meadow-green-v1",
      "current-canopy",
      coastBlend,
      "composition-v1",
    );
    return {
      ...f,
      close() {
        try {
          f.close();
        } finally {
          restore();
        }
      },
    };
  } catch (error) {
    restore();
    throw error;
  }
}

type PlacementArrays = Pick<
  GrassWorkerOutput,
  | "count"
  | "offsets"
  | "rotScaleHash"
  | "groundColors"
  | "grassTints"
  | "groundNormals"
>;

function expectPlacementParity(
  actual: PlacementArrays,
  expected: PlacementArrays,
) {
  expect(actual.count).toBe(expected.count);
  for (const key of [
    "offsets",
    "rotScaleHash",
    "groundColors",
    "grassTints",
    "groundNormals",
  ] as const) {
    expect(actual[key].length).toBe(expected[key].length);
    for (let i = 0; i < actual[key].length; i++) {
      // Independent CPU/worker arithmetic may differ by a few Float32 ULPs.
      const tolerance =
        4 *
        2 ** -23 *
        Math.max(1, Math.abs(actual[key][i]), Math.abs(expected[key][i]));
      expect(
        Math.abs(actual[key][i] - expected[key][i]),
        `${key}[${i}]`,
      ).toBeLessThanOrEqual(tolerance);
      if (key === "rotScaleHash" || (key === "offsets" && i % 3 !== 1))
        expect(actual[key][i], `seeded ${key}[${i}]`).toBe(expected[key][i]);
    }
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
  it("keeps omitted and own-undefined road clearance byte-identical and rejects invalid options before allocation", () => {
    const omitted = fixture(undefined, { ...FINE_MEADOW_GRASS_VISUAL_PROFILE });
    const explicit = fixture(undefined, {
      ...FINE_MEADOW_GRASS_VISUAL_PROFILE,
      roadClearance: undefined,
    });
    try {
      expect(explicit.manager.getProfileReceipt()).toEqual(
        omitted.manager.getProfileReceipt(),
      );
      expect(omitted.manager.getProfileReceipt().grounding).not.toHaveProperty(
        "roadClearance",
      );
      for (const [index, geometry] of omitted.manager[
        "lodGeometries"
      ].entries()) {
        expect(geometry.getAttribute("position").array).toEqual(
          explicit.manager["lodGeometries"][index].getAttribute("position")
            .array,
        );
        expect(geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
          false,
        );
      }
      const source = readFileSync(
        new URL("../GrassVisualManager.ts", import.meta.url),
        "utf8",
      );
      expect(
        source.indexOf(
          'throw new Error("Invalid grass visual road-clearance mode")',
        ),
      ).toBeLessThan(source.indexOf("this.lodGeometries ="));
      for (const value of [null, false, 1, "whole-clump", "per-blade-v2"]) {
        const invalid = { ...FINE_MEADOW_GRASS_VISUAL_PROFILE };
        Object.defineProperty(invalid, "roadClearance", { value });
        expect(() => fixture(undefined, invalid)).toThrow(
          "Invalid grass visual road-clearance mode",
        );
      }
      for (const value of [undefined, "per-blade-v1"]) {
        const inherited = { ...FINE_MEADOW_GRASS_VISUAL_PROFILE };
        Object.setPrototypeOf(inherited, { roadClearance: value });
        expect(() => fixture(undefined, inherited)).toThrow(
          "Invalid grass visual road-clearance mode",
        );
      }
      let getterReads = 0;
      const accessor = { ...FINE_MEADOW_GRASS_VISUAL_PROFILE };
      Object.defineProperty(accessor, "roadClearance", {
        get() {
          getterReads++;
          return "per-blade-v1";
        },
      });
      expect(() => fixture(undefined, accessor)).toThrow(
        "Invalid grass visual road-clearance mode",
      );
      expect(getterReads).toBe(0);
      expect(() =>
        fixture(undefined, { roadClearance: "per-blade-v1" }),
      ).toThrow("Grass road clearance requires the explicit fine meadow");
    } finally {
      explicit.close();
      omitted.close();
    }
  });

  it("prewarms only opted-in road-clearance attributes and disposes temporary owners on success and rejection", async () => {
    for (const enabled of [false, true]) {
      const selected: GrassVisualProfile = {
        ...FINE_MEADOW_GRASS_VISUAL_PROFILE,
        ...(enabled ? { roadClearance: "per-blade-v1" as const } : {}),
      };
      const f = fixture(undefined, selected);
      // The mode is restart-owned, not a borrowed mutable settings object.
      selected.roadClearance = enabled ? undefined : "per-blade-v1";
      try {
        for (const reject of [false, true]) {
          let geometryDisposals = 0,
            materialDisposals = 0,
            meshDisposals = 0;
          const compile = f.manager.precompileRepresentativeChunk(
            async (object) => {
              expect(object).toBeInstanceOf(THREE.InstancedMesh);
              const mesh = object as THREE.InstancedMesh;
              const visibility = mesh.geometry.getAttribute(
                GRASS_BLADE_VISIBILITY_ATTRIBUTE,
              );
              expect(Boolean(visibility)).toBe(enabled);
              if (enabled) {
                if (!(visibility instanceof StorageBufferAttribute))
                  throw new Error(
                    "Actual visibility storage attribute required",
                  );
                expect(visibility.array).toEqual(
                  new Uint32Array([2 ** 24 - 1]),
                );
                expect(visibility.array).toBeInstanceOf(Uint32Array);
                expect(visibility.isStorageBufferAttribute).toBe(true);
                expect(visibility.itemSize).toBe(1);
                expect(visibility.count).toBe(1);
                expect(visibility.array.byteLength).toBe(4);
              }
              expect(
                mesh.geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE),
              ).toBe(true);
              expect(mesh.instanceMatrix).toBeInstanceOf(
                THREE.StorageInstancedBufferAttribute,
              );
              expect(
                mesh.geometry.getAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE),
              ).toBe(mesh.instanceMatrix);
              expect(mesh.instanceMatrix.usage).toBe(THREE.StaticDrawUsage);
              expect(mesh.instanceMatrix.version).toBe(1);
              expect(mesh.instanceMatrix.count).toBe(1);
              expect(mesh.instanceMatrix.array).toEqual(
                new Float32Array(new THREE.Matrix4().elements),
              );
              expect(
                f.manager["lodGeometries"].some((geometry) =>
                  geometry.hasAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE),
                ),
              ).toBe(false);
              // Actual production prewarm geometry: interleaved color/tint
              // share one backing. Root/mask/matrix storage are not vertex
              // inputs. This CPU census is not device/pipeline validation.
              const vertexBackings = new Set<
                THREE.BufferAttribute | THREE.InterleavedBuffer
              >();
              for (const attribute of Object.values(mesh.geometry.attributes)) {
                if (
                  attribute instanceof StorageBufferAttribute ||
                  attribute instanceof THREE.StorageInstancedBufferAttribute
                )
                  continue;
                vertexBackings.add(
                  attribute instanceof THREE.InterleavedBufferAttribute
                    ? attribute.data
                    : attribute,
                );
              }
              expect(vertexBackings.size).toBe(7);
              expect([...vertexBackings]).not.toContain(mesh.instanceMatrix);
              if (enabled)
                expect([...vertexBackings]).not.toContain(visibility);
              mesh.geometry.addEventListener("dispose", () => {
                expect(
                  mesh.geometry.getAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE),
                ).toBe(mesh.instanceMatrix);
                geometryDisposals++;
              });
              expect(Array.isArray(mesh.material)).toBe(false);
              if (Array.isArray(mesh.material))
                throw new Error("One grounded material required");
              mesh.material.addEventListener(
                "dispose",
                () => materialDisposals++,
              );
              mesh.addEventListener("dispose", () => meshDisposals++);
              if (reject) throw new Error("Intentional compile rejection");
            },
          );
          if (reject)
            await expect(compile).rejects.toThrow(
              "Intentional compile rejection",
            );
          else await compile;
          expect([geometryDisposals, materialDisposals, meshDisposals]).toEqual(
            [1, 1, 1],
          );
          expect(
            f.manager.getProfileReceipt().grounding?.roadClearance,
          ).toEqual(
            enabled ? { mode: "per-blade-v1", visibilityBytes: 0 } : undefined,
          );
          expect(f.container.children).toHaveLength(0);
        }
      } finally {
        f.close();
      }
    }
  });

  it.each([undefined, "fine-meadow-green-v1"] as const)(
    "publishes opted-in road-clearance masks through real worker and fallback grounding at both fine LODs (grade=%s)",
    async (grassGrade) => {
      const f = await coastalFixture(
        true,
        [350, 350],
        false,
        {
          ...FINE_MEADOW_GRASS_VISUAL_PROFILE,
          roadClearance: "per-blade-v1",
        },
        "current",
        grassGrade,
      );
      const defaultOwner = fixture(undefined, {
        ...FINE_MEADOW_GRASS_VISUAL_PROFILE,
      });
      const key = "gcell_v1_14_12";
      try {
        const work = f.manager["liveWorkUnits"].get(key)!;
        for (const lod of [0, 1] as const) {
          f.manager["lodFocusX"] = lod === 0 ? 350 : 420;
          const input = f.manager["createWorkerInput"](work, key, lod);
          expect(input).not.toHaveProperty("roadClearance");
          const worker = await actualWorker(input);
          const sync = f.manager["generateInstanceData"](
            work,
            GRASS_CONFIG.LOD_TIERS[lod].spacingMul,
          )!;
          expectPlacementParity(sync, worker);
          if (lod === 0) {
            const ticket = f.manager["createWorkerTicket"](
              work,
              key,
              lod,
              false,
            );
            f.manager["settleWorkerResult"](ticket, worker);
          } else f.manager["createChunkMesh"](work, lod, true);
          const queued = f.manager["settledWorkerResults"].find(
            (entry) => entry.ticket.key === key,
          )!;
          expect(queued).toBeDefined();
          f.manager["processSettledWorkerResults"]();
          const entry = f.manager["groundingJobs"].get(key)!;
          expect(entry).toBeDefined();
          let slices = 0;
          while (entry.job.state.status === "running" && slices++ < 500)
            f.manager["advanceGroundingJob"]();
          expect(
            entry.job.state.status,
            JSON.stringify({
              state: entry.job.state.status,
              slices,
              operations: entry.job.operations,
              activeMs: entry.job.activeMs,
              maximumSliceMs: entry.job.maximumSliceMs,
            }),
          ).toBe("ready");
          if (entry.job.state.status !== "ready")
            throw new Error("Grounding must complete under unchanged budgets");
          const ready = entry.job.state.result;
          const mesh = f.manager["chunks"].get(key)!.mesh;
          const visibility = mesh.geometry.getAttribute(
            GRASS_BLADE_VISIBILITY_ATTRIBUTE,
          );
          if (!(visibility instanceof StorageBufferAttribute))
            throw new Error("Actual visibility storage attribute required");
          expect(visibility.array).toBe(ready.bladeVisibility);
          expect(visibility.count).toBe(mesh.count);
          expect(visibility.array).toBeInstanceOf(Uint32Array);
          expect(visibility.isStorageBufferAttribute).toBe(true);
          expect(visibility.itemSize).toBe(1);
          expect(visibility.array.byteLength).toBe(mesh.count * 4);
          expect(
            mesh.geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE).array,
          ).toBe(ready.rootDeltas);
          expect(mesh.userData.grassBladeGrounding.roadClearance).toEqual(
            ready.receipt.roadClearance,
          );
          expect(ready.receipt.roadClearance?.partialClumps).toBeGreaterThan(0);
          const layout = getGrassBladeLayout(
            lod,
            FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
          );
          const visibleCount = [...ready.bladeVisibility!].reduce(
            (sum, mask) => {
              for (let blade = 0; blade < layout.bladesPerClump; blade++)
                sum += (mask >>> blade) & 1;
              return sum;
            },
            0,
          );
          expect(ready.receipt.roadClearance?.retainedBlades).toBe(
            visibleCount,
          );
          expect(ready.receipt.roadClearance?.maskedRetainedBlades).toBe(
            mesh.count * layout.bladesPerClump - visibleCount,
          );
          expect(
            f.manager.getProfileReceipt().grounding?.roadClearance,
          ).toEqual({
            mode: "per-blade-v1",
            visibilityBytes: mesh.count * 4,
          });
          const region = f.manager["captureRenderedRegion"]!(
            entry.ticket.grounding!.bounds,
          );
          const inputs = f.manager["workerSetup"]!.prepareGroundingInputs!(
            entry.ticket.grounding!.bounds,
          );
          let constraints = inputs.steps.next();
          while (!constraints.done) constraints = inputs.steps.next();
          const projected = projectGrassAnchors(
            queued.data,
            entry.ticket.surface,
            f.manager["getWaterSurfaceAt"],
            f.manager["isInFlatZone"],
          );
          const request: GrassBladeGroundingRequest = {
            data: projected,
            ownSurface: entry.ticket.surface,
            surfaces: region.surfaces,
            geometry: f.manager["lodGeometries"][lod],
            lod,
            geometryLayout: FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
            ...(grassGrade
              ? {
                  bankVerge: createCompactTerrainColorOperations().macroField(
                    input.config.TERRAIN_PROFILE,
                  )!.bankVerge!,
                }
              : {}),
            ...constraints.value,
            oceanLevel: f.manager["waterThreshold"],
            wind: {
              x:
                GRASS_CONFIG.WIND_STRENGTH *
                FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX,
              z:
                GRASS_CONFIG.WIND_STRENGTH *
                FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX *
                0.55,
            },
            roadClearance: "per-blade-v1",
          };
          const direct = groundGrassBlades(request);
          expect(direct.status).toBe("ready");
          if (direct.status !== "ready")
            throw new Error("Actual retained terrain is required");
          expect(direct.data).toEqual(ready.data);
          expect(direct.bladeVisibility).toEqual(ready.bladeVisibility);
          expect(direct.rootDeltas).toEqual(ready.rootDeltas);
          expect(direct.sourceIndices).toEqual(ready.sourceIndices);
          expect(direct.sweptBounds).toEqual(ready.sweptBounds);
          expect(direct.receipt.roadClearance).toEqual(
            ready.receipt.roadClearance,
          );
          expect(inputs.isCurrent() && region.isCurrent()).toBe(true);
          expect(() =>
            defaultOwner.manager["assertBladeRoadClearance"](ready),
          ).toThrow("identity mismatch");
          const withoutMask = { ...ready, bladeVisibility: undefined };
          expect(() =>
            f.manager["assertBladeRoadClearance"](withoutMask),
          ).toThrow("identity mismatch");
          const wrongBytes = {
            ...ready,
            receipt: {
              ...ready.receipt,
              roadClearance: {
                ...ready.receipt.roadClearance!,
                visibilityBytes: 0,
              },
            },
          };
          expect(() =>
            f.manager["assertBladeRoadClearance"](wrongBytes),
          ).toThrow("identity mismatch");
          const empty = groundGrassBlades({
            ...request,
            data: {
              count: 0,
              offsets: new Float32Array(),
              rotScaleHash: new Float32Array(),
              groundColors: new Float32Array(),
              grassTints: new Float32Array(),
              groundNormals: new Float32Array(),
            },
          });
          if (empty.status !== "ready")
            throw new Error("Validated empty result required");
          expect(empty.bladeVisibility).toEqual(new Uint32Array());
          expect(() =>
            f.manager["assertBladeRoadClearance"](empty),
          ).not.toThrow();
          expect(() =>
            f.manager["assertBladeRoadClearance"]({
              ...empty,
              bladeVisibility: undefined,
            }),
          ).toThrow("identity mismatch");
          expect(() =>
            defaultOwner.manager["assertBladeRoadClearance"](empty),
          ).toThrow("identity mismatch");
          let disposed = 0;
          mesh.geometry.addEventListener("dispose", () => disposed++);
          f.manager["retireGrassWork"](key);
          expect(disposed).toBe(1);
          expect(
            f.manager.getProfileReceipt().grounding?.roadClearance
              ?.visibilityBytes,
          ).toBe(0);
          expect(f.manager["completedGrounding"].has(key)).toBe(false);
          // Actual publication rejects a mismatched nonempty or empty result
          // before installing anything; the shared guard also runs before the
          // manager marks ready-empty jobs completed.
          for (const bad of [
            withoutMask,
            {
              ...empty,
              grounding: ready.grounding,
              bladeVisibility: undefined,
            },
          ]) {
            expect(() =>
              f.manager["createChunkMeshFromWorkerData"](
                work,
                {
                  ...worker,
                  ...bad.data,
                },
                lod,
                ready.grounding!,
                bad,
              ),
            ).toThrow("identity mismatch");
            expect(f.manager["chunks"].has(key)).toBe(false);
            expect(f.manager["completedGrounding"].has(key)).toBe(false);
          }
        }
      } finally {
        defaultOwner.close();
        f.close();
      }
    },
  );

  it("never publishes opted-in road-clearance masks after stale work or cancellation", async () => {
    const f = await coastalFixture(true, [350, 350], false, {
      ...FINE_MEADOW_GRASS_VISUAL_PROFILE,
      roadClearance: "per-blade-v1",
    });
    const key = "gcell_v1_14_12";
    try {
      const work = f.manager["liveWorkUnits"].get(key)!;
      const old = f.manager["createWorkerTicket"](work, key, 0, false);
      const output = await actualWorker(
        f.manager["createWorkerInput"](work, key, 0),
      );
      f.manager.invalidateRegion(
        work.bounds.minX,
        work.bounds.minZ,
        work.bounds.maxX,
        work.bounds.maxZ,
      );
      const current = f.manager["createWorkerTicket"](work, key, 0, false);
      f.manager["settleWorkerResult"](old, output);
      expect(f.manager["workerInflight"].get(key)).toBe(current);
      expect(f.manager["settledWorkerResults"]).toHaveLength(0);
      f.manager["settleWorkerResult"](current, output);
      f.manager["processSettledWorkerResults"]();
      const job = f.manager["groundingJobs"].get(key)!.job;
      expect(job.state.status).toBe("running");
      job.advance(1);
      f.manager.invalidateRegion(
        work.bounds.minX,
        work.bounds.minZ,
        work.bounds.maxX,
        work.bounds.maxZ,
      );
      expect(job.state.status).toBe("cancelled");
      expect(f.manager["advanceGroundingJob"]()).toBe(0);
      expect(f.manager["chunks"].has(key)).toBe(false);
      expect(f.manager["completedGrounding"].has(key)).toBe(false);
      expect(
        f.manager.getProfileReceipt().grounding?.roadClearance?.visibilityBytes,
      ).toBe(0);
      f.manager.destroy();
      f.manager["settleWorkerResult"](current, output);
      expect(f.manager["settledWorkerResults"]).toHaveLength(0);
      expect(
        f.manager.getProfileReceipt().grounding?.roadClearance?.visibilityBytes,
      ).toBe(0);
    } finally {
      f.close();
    }
  });

  it.each([
    "historical-candidate29",
    "historical-narrow-shoulders",
    "current-canopy",
  ] as const)(
    "measures %s station-verge grass through real worker, fallback and retained grounding without widening model clearances",
    async (captureRecipe) => {
      const pathRecipe =
        captureRecipe === "historical-candidate29" ? "candidate29" : "current";
      const geometryRecipe =
        captureRecipe === "current-canopy"
          ? "current-canopy"
          : "historical-linear";
      await DataManager.getInstance().initialize();
      const originalEntries = stationDataProvider["stationEntries"];
      const originalBytes = JSON.stringify(originalEntries);
      const candidateEntries = structuredClone(originalEntries);
      for (const type of ["bank", "range", "altar"]) {
        const station = candidateEntries.find((row) => row.type === type)!;
        expect(station.grassClearanceMargin).toBeUndefined();
        station.grassClearanceMargin = 1.25;
      }
      const keys = ["gcell_v1_13_12", "gcell_v1_14_12", "gcell_v1_15_14"];
      // Frozen under Node22 before indexed-cell shortcut implementation. The
      // candidate29 core/API/worker/terrain inputs (178 pins) were verified
      // unchanged; only passive test diagnostics were added for this capture.
      // These hash all semantic grounding output bytes and ordered dependencies,
      // not elapsed time, work counters or an assumed native-world speedup.
      const baselineHashes = [
        [
          "54b145b8df8a1a3e9b0b2e0d506adadf4bced541ad5f9c41d2ce7e4e094584ed",
          "6ac4c14b1682eda12af5f1aeac96579c3978e63c2f57dcf0ae5b5951b7ca80a3",
        ],
        [
          "0380b79a7c3173ad5fd611c0d4339788ede1747be45eb47ce4b8b24d8c03b974",
          "38e6d3b506ea7a334b9500a142ca2250cf889b7d562ab47c1badadf2583db2dd",
        ],
        [
          "9fbf87f8331d8572aa9caa2ac548fc506d315813ed46d6fcad67bb715ffd5816",
          "9fbf87f8331d8572aa9caa2ac548fc506d315813ed46d6fcad67bb715ffd5816",
        ],
      ];
      const baselineVisits = [385253, 108889, 49870];
      const baselineOperations = [619759, 284704, 217324];
      // Separate Node22 measurement of the narrowed shoulders: real emitted
      // worker/fallback parity and retained grounding passed before these pins
      // were added. Never use these values to rewrite candidate29's evidence.
      const narrowedShoulderHashes = [
        [
          "0a60a04e0dcc534c847a04091198292cee4c59bc8611a4a7c1e31272e076a5c1",
          "c0a10dde338309729596c0ed12da396d99c619f4b88596b02a36847f4983d08b",
        ],
        [
          "0380b79a7c3173ad5fd611c0d4339788ede1747be45eb47ce4b8b24d8c03b974",
          "38e6d3b506ea7a334b9500a142ca2250cf889b7d562ab47c1badadf2583db2dd",
        ],
        [
          "6b7b7c88eff558d92d1daf38cde918c8d0f0e353b6fcc4e5d9f913a5b649ba70",
          "6b7b7c88eff558d92d1daf38cde918c8d0f0e353b6fcc4e5d9f913a5b649ba70",
        ],
      ];
      const capture = async (diagnoseRoads = false) => {
        const f = await coastalFixture(
          true,
          [350, 350],
          true,
          FINE_MEADOW_GRASS_VISUAL_PROFILE,
          pathRecipe,
          undefined,
          geometryRecipe,
        );
        // Deliberately ungraded to isolate the current geometry from the
        // separate graded bank-wear/height tests; not a full native bank claim.
        expect(f.manager["compactGrassColorGrade"]).toBeUndefined();
        expect(f.terrain["getCompactGrassColorGrade"]()).toBeUndefined();
        expect(f.manager["compactCoastBlend"]).toBeUndefined();
        expect(f.terrain["getCompactCoastBlend"]()).toBeUndefined();
        const rows: Array<{
          key: string;
          worker: GrassWorkerOutput;
          grounded: number;
          offsets: Float32Array;
          transforms: Float32Array;
          sourceIndices: Uint32Array;
          geometryAttributeBytes: number;
          correctionBytes: number;
          maxAcceptedBaseError: number;
          sameFaceEdges: number;
          triangleVisits: number;
          endpointQueries: number;
          groundingOperations: number;
          activeMs: number;
          semanticHash: string;
          legacyCensus?: {
            sameFaceEdges: number;
            triangleVisits: number;
            groundingOperations: number;
            coreOperations: number;
            currentCoreOperations: number;
            workUnits: number;
            currentWorkUnits: number;
          };
          roadDiagnostic?: ReturnType<typeof measureRoadEnvelopeGaps>["report"];
        }> = [];
        try {
          for (const key of keys) {
            const work = f.manager["liveWorkUnits"].get(key)!;
            expect(work).toBeDefined();
            const input = f.manager["createWorkerInput"](work, key, 0);
            expect(input).not.toHaveProperty("compactGrassColorGrade");
            expect(input).not.toHaveProperty("compactCoastBlend");
            const worker = await actualWorker(input);
            const sync = f.manager["generateInstanceData"](work, 1);
            if (!sync)
              throw new Error("Actual station-verge candidates required");
            expectPlacementParity(sync, worker);
            f.manager["createChunkMesh"](work, 0);
            f.manager["processSettledWorkerResults"]();
            const job = f.manager["groundingJobs"].get(key)?.job;
            if (!job)
              throw new Error("Actual station-verge grounding job required");
            let slices = 0;
            while (
              f.manager["groundingJobs"].get(key)?.job.state.status ===
                "running" &&
              slices++ < 500
            )
              f.manager["advanceGroundingJob"]();
            const chunk = f.manager["chunks"].get(key);
            expect(
              chunk,
              JSON.stringify({
                key,
                slices,
                pendingStatus:
                  f.manager["groundingJobs"].get(key)?.job.state.status,
              }),
            ).toBeDefined();
            if (!chunk)
              throw new Error("Station verge must publish grounded geometry");
            if (job.state.status !== "ready")
              throw new Error(
                "Installed station verge requires completed grounding",
              );
            const receipt = chunk.mesh.userData
              .grassBladeGrounding as GrassBladeGroundingReceipt & {
              sourceIndices: Uint32Array;
            };
            expect(receipt).toBeDefined();
            expect(receipt.workUnits).toBeLessThanOrEqual(receipt.workBudget);
            expect(receipt.processedClumps).toBe(receipt.inputClumps);
            expect(receipt.maxAcceptedBaseError).toBeLessThanOrEqual(0.02);
            const offsets = chunk.mesh.geometry.getAttribute("instanceOffset");
            const transforms = chunk.mesh.geometry.getAttribute(
              "instanceRotScaleHash",
            );
            expect(offsets.count).toBe(receipt.retainedClumps);
            expect(offsets.count).toBe(receipt.sourceIndices.length);
            expect(new Set(receipt.sourceIndices).size).toBe(offsets.count);
            for (let i = 0; i < offsets.count; i++) {
              const source = receipt.sourceIndices[i];
              expect(source).toBeLessThan(worker.count);
              expect(offsets.getX(i)).toBe(worker.offsets[source * 3]);
              expect(offsets.getZ(i)).toBe(worker.offsets[source * 3 + 2]);
              expect(transforms.getY(i)).toBe(
                worker.rotScaleHash[source * 3 + 1],
              );
              const x = input.centerX + offsets.getX(i);
              const z = input.centerZ + offsets.getZ(i);
              expect(f.terrain["isGrassExcludedAt"](x, z)).toBe(false);
              expect(
                f.terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
              ).toBeLessThanOrEqual(0.8 + 1e-5);
            }
            const arrays = new Set(
              Object.values(chunk.mesh.geometry.attributes).map(
                (attribute) => attribute.array,
              ),
            );
            let roadDiagnostic:
              ReturnType<typeof measureRoadEnvelopeGaps>["report"] | undefined;
            let legacyCensus: (typeof rows)[number]["legacyCensus"];
            if (diagnoseRoads) {
              const halo = f.manager["groundingHalo"];
              const bounds = {
                minX: work.bounds.minX - halo,
                maxX: work.bounds.maxX + halo,
                minZ: work.bounds.minZ - halo,
                maxZ: work.bounds.maxZ + halo,
              };
              const region = f.manager["captureRenderedRegion"]!(bounds);
              const inputs =
                f.manager["workerSetup"]!.prepareGroundingInputs!(bounds);
              expect(region.isCurrent()).toBe(true);
              expect(inputs.isCurrent()).toBe(true);
              let step = inputs.steps.next();
              while (!step.done) step = inputs.steps.next();
              const surface = f.manager["getRenderedSurface"](work.node)!;
              const projected = projectGrassAnchors(
                worker,
                surface,
                f.manager["getWaterSurfaceAt"],
                f.manager["isInFlatZone"],
              );
              // The indices reported below really identify worker candidates in
              // these cells; fail instead of assuming projection kept its order.
              expect(projected.count).toBe(worker.count);
              for (let i = 0; i < worker.count; i++) {
                expect(projected.offsets[i * 3]).toBe(worker.offsets[i * 3]);
                expect(projected.offsets[i * 3 + 2]).toBe(
                  worker.offsets[i * 3 + 2],
                );
              }
              const diagnosticRequest: GrassBladeGroundingRequest = {
                data: projected,
                ownSurface: surface,
                surfaces: region.surfaces,
                geometry: f.manager["lodGeometries"][0],
                lod: 0,
                geometryLayout: FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
                terrainSurface: step.value.terrainSurface,
                roadSegments: step.value.roadSegments,
                oceanLevel: f.manager["waterThreshold"],
                wind: {
                  x:
                    GRASS_CONFIG.WIND_STRENGTH *
                    FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX,
                  z:
                    GRASS_CONFIG.WIND_STRENGTH *
                    FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX *
                    0.55,
                },
              };
              const diagnostic = measureRoadEnvelopeGaps(diagnosticRequest);
              expect(diagnostic.actual.data).toEqual(job.state.result.data);
              expect(diagnostic.actual.sourceIndices).toEqual(
                job.state.result.sourceIndices,
              );
              expect(diagnostic.actual.rootDeltas).toEqual(
                job.state.result.rootDeltas,
              );
              expect(diagnostic.actual.sweptBounds).toEqual(
                job.state.result.sweptBounds,
              );
              expect(diagnostic.actual.receipt.rejected).toEqual(
                receipt.rejected,
              );
              if (geometryRecipe === "historical-linear") {
                // Historical work counters belong to the frozen exhaustive
                // oracle, not review52's edge-block/root-fade optimization.
                // Execute both cores on identical real inputs; retain all old
                // semantic goldens and derive the prior pipeline census only
                // by replacing its measured core resumptions, not new numbers.
                const drain = <T>(steps: Generator<string, T, void>) => {
                  let operations = 1;
                  let result = steps.next();
                  while (!result.done) {
                    operations++;
                    result = steps.next();
                  }
                  return { result: result.value, operations };
                };
                const current = drain(groundGrassBladeSteps(diagnosticRequest));
                const legacy = drain(
                  legacyGroundGrassBladeSteps(diagnosticRequest),
                );
                expect(current.result.status).toBe("ready");
                expect(legacy.result.status).toBe("ready");
                if (
                  current.result.status !== "ready" ||
                  legacy.result.status !== "ready"
                )
                  throw new Error(
                    "Historical grounding oracle must complete its original work cap",
                  );
                // The installation pipeline adds remapped provenance after
                // either core finishes. Reapply that real owner too, rather
                // than dropping its field from the unchanged semantic hash.
                const currentRemap = drain(
                  remapGrassGroundingSteps(
                    projected.grounding,
                    current.result.sourceIndices,
                  ),
                );
                const legacyRemap = drain(
                  remapGrassGroundingSteps(
                    projected.grounding,
                    legacy.result.sourceIndices,
                  ),
                );
                expect(legacyRemap).toEqual(currentRemap);
                expect(
                  sameFaceHash({
                    ...current.result,
                    grounding: currentRemap.result,
                  }),
                ).toBe(sameFaceHash(job.state.result));
                expect(
                  sameFaceHash({
                    ...legacy.result,
                    grounding: legacyRemap.result,
                  }),
                ).toBe(sameFaceHash(job.state.result));
                expect(sameFaceHash(legacy.result)).toBe(
                  sameFaceHash(current.result),
                );
                expect(legacy.result.data).toEqual(current.result.data);
                expect(legacy.result.rootDeltas).toEqual(
                  current.result.rootDeltas,
                );
                expect(legacy.result.sourceIndices).toEqual(
                  current.result.sourceIndices,
                );
                expect(legacy.result.bladeVisibility).toEqual(
                  current.result.bladeVisibility,
                );
                expect(legacy.result.sweptBounds).toEqual(
                  current.result.sweptBounds,
                );
                expect(legacy.result.dependencies).toEqual(
                  current.result.dependencies,
                );
                expect(current.result.receipt.sameFaceEdges).toBe(
                  legacy.result.receipt.sameFaceEdges,
                );
                expect(current.result.receipt.triangleVisits).toBeLessThan(
                  legacy.result.receipt.triangleVisits,
                );
                expect(current.result.receipt.workUnits).toBeLessThan(
                  legacy.result.receipt.workUnits,
                );
                expect(current.operations).toBeLessThan(legacy.operations);
                legacyCensus = {
                  sameFaceEdges: legacy.result.receipt.sameFaceEdges,
                  triangleVisits: legacy.result.receipt.triangleVisits,
                  groundingOperations:
                    job.operations - current.operations + legacy.operations,
                  coreOperations: legacy.operations,
                  currentCoreOperations: current.operations,
                  workUnits: legacy.result.receipt.workUnits,
                  currentWorkUnits: current.result.receipt.workUnits,
                };
                process.stdout.write(
                  JSON.stringify({
                    diagnostic: `${captureRecipe} frozen exhaustive grounding oracle`,
                    key,
                    originalSemanticHash: sameFaceHash(legacy.result),
                    currentSemanticHash: sameFaceHash(current.result),
                    currentPipelineOperations: job.operations,
                    currentTriangleVisits:
                      current.result.receipt.triangleVisits,
                    ...legacyCensus,
                  }) + "\n",
                );
              }
              expect(region.isCurrent()).toBe(true);
              expect(inputs.isCurrent()).toBe(true);
              roadDiagnostic = diagnostic.report;
              process.stdout.write(
                JSON.stringify({
                  diagnostic: `${captureRecipe} bank road-envelope`,
                  key,
                  ...roadDiagnostic,
                }) + "\n",
              );
            }
            rows.push({
              key,
              worker,
              grounded: offsets.count,
              offsets: Float32Array.from(offsets.array),
              transforms: Float32Array.from(transforms.array),
              sourceIndices: receipt.sourceIndices.slice(),
              geometryAttributeBytes: [...arrays].reduce(
                (sum, array) => sum + array.byteLength,
                0,
              ),
              correctionBytes: receipt.correctionBytes,
              maxAcceptedBaseError: receipt.maxAcceptedBaseError,
              sameFaceEdges: receipt.sameFaceEdges,
              triangleVisits: receipt.triangleVisits,
              endpointQueries: receipt.endpointQueries,
              groundingOperations: job.operations,
              activeMs: job.activeMs,
              semanticHash: sameFaceHash(job.state.result),
              ...(roadDiagnostic ? { roadDiagnostic } : {}),
              ...(legacyCensus ? { legacyCensus } : {}),
            });
            expect(chunk.mesh.userData.walkable).toBe(false);
            expect(chunk.mesh.userData.clickable).toBe(false);
          }
          return rows;
        } finally {
          f.close();
        }
      };
      try {
        const before = await capture();
        stationDataProvider.loadStations({ stations: candidateEntries });
        const after = await capture(true);
        let recoveredGrounded = 0;
        for (let i = 0; i < keys.length; i++) {
          const a = after[i],
            b = before[i];
          expect(a.key).toBe(b.key);
          if (pathRecipe === "candidate29") {
            expect([b.semanticHash, a.semanticHash]).toEqual(baselineHashes[i]);
            expect(a.roadDiagnostic?.roadOnlyFalsePositives).toBe(
              [22, 6, 22][i],
            );
            expect(a.roadDiagnostic?.eligibleRoadOnlyFalsePositives).toBe(
              [17, 5, 20][i],
            );
            expect(a.roadDiagnostic?.actualRoadRejections).toBe(
              [68, 43, 71][i],
            );
          } else if (geometryRecipe === "historical-linear") {
            expect([b.semanticHash, a.semanticHash]).toEqual(
              narrowedShoulderHashes[i],
            );
            expect([
              b.worker.count,
              a.worker.count,
              b.grounded,
              a.grounded,
            ]).toEqual(
              [
                [676, 903, 490, 729],
                [592, 797, 445, 626],
                [852, 852, 720, 720],
              ][i],
            );
            expect(a.roadDiagnostic?.roadOnlyFalsePositives).toBe(
              [20, 5, 28][i],
            );
            expect(a.roadDiagnostic?.eligibleRoadOnlyFalsePositives).toBe(
              [17, 5, 27][i],
            );
            expect(a.roadDiagnostic?.actualRoadRejections).toBe(
              [70, 43, 79][i],
            );
            expect([
              a.legacyCensus?.sameFaceEdges,
              a.legacyCensus?.triangleVisits,
              a.legacyCensus?.groundingOperations,
            ]).toEqual(
              [
                [17306, 369125, 555544],
                [16791, 92094, 217258],
                [17759, 32297, 148311],
              ][i],
            );
          } else {
            // Current generated roots still follow the same exact placement
            // recipe. Retained counts/bounds may legitimately change with wider
            // upper leaves, so validate physical acceptance and real diagnostic
            // equality above rather than blessing replacement historical hashes.
            expect([b.worker.count, a.worker.count]).toEqual(
              [
                [676, 903],
                [592, 797],
                [852, 852],
              ][i],
            );
            expect(b.grounded).toBeGreaterThan(0);
            expect(a.grounded).toBeLessThanOrEqual(a.worker.count);
            expect(a.roadDiagnostic).toBeDefined();
            expect(a.geometryAttributeBytes).toBeGreaterThan(0);
            expect(a.correctionBytes).toBe(
              a.grounded * 24 * 2 * Float32Array.BYTES_PER_ELEMENT,
            );
          }
          expect(a.sameFaceEdges).toBeGreaterThan(0);
          // The frozen pre-review52 oracle retains the earlier same-face
          // optimization, so its census still owns this exact historical delta.
          // Current output must match it while doing less measured core work.
          if (pathRecipe === "candidate29") {
            expect(a.legacyCensus?.triangleVisits).toBe(
              baselineVisits[i] - a.sameFaceEdges,
            );
            expect(a.legacyCensus?.groundingOperations).toBe(
              baselineOperations[i] - 4 * a.sameFaceEdges,
            );
          }
          if (i < 2) {
            expect(a.worker.count).toBeGreaterThan(b.worker.count);
            expect(a.grounded).toBeGreaterThan(b.grounded);
            recoveredGrounded += a.grounded - b.grounded;
          } else {
            expectPlacementParity(a.worker, b.worker);
            expect(a.offsets).toEqual(b.offsets);
            expect(a.transforms).toEqual(b.transforms);
            expect(a.sourceIndices).toEqual(b.sourceIndices);
            expect(a.geometryAttributeBytes).toBe(b.geometryAttributeBytes);
          }
        }
        expect(recoveredGrounded).toBeGreaterThan(0);
        // Acceptance can rephase later rotation draws within changed cells.
        // Do not claim exact poses outside each station rectangle, or GPU cost.
        console.info(
          `${captureRecipe} station clearance actual worker and retained-grounding comparison; not visual or GPU approval`,
          JSON.stringify(
            after.map((a, i) => ({
              key: a.key,
              workerBefore: before[i].worker.count,
              workerAfter: a.worker.count,
              groundedBefore: before[i].grounded,
              groundedAfter: a.grounded,
              attributeBytesBefore: before[i].geometryAttributeBytes,
              attributeBytesAfter: a.geometryAttributeBytes,
              correctionBytes: a.correctionBytes,
              maxAcceptedBaseError: a.maxAcceptedBaseError,
              sameFaceEdges: a.sameFaceEdges,
              triangleVisits: a.triangleVisits,
              endpointQueries: a.endpointQueries,
              groundingOperations: a.groundingOperations,
              activeMs: a.activeMs,
              beforeSemanticHash: before[i].semanticHash,
              semanticHash: a.semanticHash,
            })),
          ),
        );
      } finally {
        stationDataProvider.loadStations({ stations: originalEntries });
        expect(stationDataProvider["stationEntries"]).toBe(originalEntries);
        expect(JSON.stringify(originalEntries)).toBe(originalBytes);
      }
    },
  );

  it.each(["tint", "wear"] as const)(
    "matches real graded worker and fallback colors while bank %s leaves every seeded pose unchanged",
    async (control) => {
      const f = await coastalFixture(
        true,
        [350, 350],
        false,
        FINE_MEADOW_GRASS_VISUAL_PROFILE,
        "current",
        "fine-meadow-green-v1",
      );
      const ops = createCompactTerrainColorOperations();
      const statement =
        "  var compactMacroField = compactTerrainColorOperations.macroField(input.config.TERRAIN_PROFILE);";
      expect(GRASS_WORKER_CODE.split(statement)).toHaveLength(2);
      // Same current worker/roads/grade; only one descriptor contribution is
      // neutralized. These are present-day controls, not historical hash replays.
      const neutralDescriptor =
        control === "tint"
          ? "grassTint: [1, 1, 1]"
          : "wear: [], wornHeightScale: 0.65";
      const neutralSource = GRASS_WORKER_CODE.replace(
        statement,
        statement +
          "\n  if (compactMacroField?.bankVerge) compactMacroField = { ...compactMacroField, bankVerge: { ...compactMacroField.bankVerge, " +
          neutralDescriptor +
          " } };",
      );
      let affected = 0,
        outside = 0;
      try {
        expect(f.manager["compactGrassColorGrade"]).toBe(
          "fine-meadow-green-v1",
        );
        for (const key of [
          "gcell_v1_13_12",
          "gcell_v1_14_12",
          "gcell_v1_15_14",
        ]) {
          const work = f.manager["liveWorkUnits"].get(key)!;
          expect(work).toBeDefined();
          const input = f.manager["createWorkerInput"](work, key, 0);
          expect(input.compactGrassColorGrade).toBe("fine-meadow-green-v1");
          const current = await actualWorker(input);
          const neutral = await actualWorker(input, neutralSource);
          const sync = f.manager["generateInstanceData"](work, 1);
          if (!sync) throw new Error("Actual graded bank grass required");
          expectPlacementParity(sync, current);
          expect(current.count).toBe(neutral.count);
          for (const name of [
            "offsets",
            "rotScaleHash",
            "grassTints",
            "groundNormals",
          ] as const)
            expect(current[name]).toEqual(neutral[name]);
          const field = ops.macroField(input.config.TERRAIN_PROFILE)!;
          for (let index = 0; index < current.count; index++) {
            const k = index * 3;
            const x = input.centerX + current.offsets[k];
            const z = input.centerZ + current.offsets[k + 2];
            const contribution =
              control === "tint"
                ? ops.bankVergeLocality(x, z, field)
                : ops.bankVergeWear(x, z, field);
            if (control === "tint") {
              expect(current.groundColors[k]).toBeLessThanOrEqual(
                neutral.groundColors[k],
              );
              expect(current.groundColors[k + 1]).toBeLessThanOrEqual(
                neutral.groundColors[k + 1],
              );
              expect(current.groundColors[k + 2]).toBe(
                neutral.groundColors[k + 2],
              );
            }
            if (contribution === 0) {
              outside++;
              expect(current.groundColors.subarray(k, k + 3)).toEqual(
                neutral.groundColors.subarray(k, k + 3),
              );
            } else if (
              [0, 1, 2].some(
                (channel) =>
                  current.groundColors[k + channel] !==
                  neutral.groundColors[k + channel],
              )
            ) {
              affected++;
            }
          }
        }
        expect(affected).toBeGreaterThan(0);
        expect(outside).toBeGreaterThan(affected);
      } finally {
        f.close();
      }
    },
  );

  it("keeps bank-verge acceptance and seeded poses while matching real worker, fallback and grounded uniform scale", async () => {
    const f = await coastalFixture(true, [350, 350]);
    const ops = createCompactTerrainColorOperations();
    const statement =
      "  var compactMacroField = compactTerrainColorOperations.macroField(input.config.TERRAIN_PROFILE);";
    expect(GRASS_WORKER_CODE.split(statement)).toHaveLength(2);
    // Retain the actual worker and current road/terrain inputs, omitting only
    // this new optional surface descriptor. No generation method is replaced.
    const previousSource = GRASS_WORKER_CODE.replace(
      statement,
      statement +
        "\n  if (compactMacroField?.bankVerge) { const { bankVerge, ...priorField } = compactMacroField; compactMacroField = priorField; }",
    );
    let changed = 0,
      unchanged = 0,
      scaleTotal = 0,
      scaleAreaTotal = 0;
    let minimum = 1;
    try {
      for (const key of [
        "gcell_v1_13_12",
        "gcell_v1_14_12",
        "gcell_v1_15_14",
      ]) {
        const work = f.manager["liveWorkUnits"].get(key)!;
        expect(work).toBeDefined();
        const input = f.manager["createWorkerInput"](work, key, 0);
        const before = await actualWorker(input, previousSource);
        const after = await actualWorker(input);
        const sync = f.manager["generateInstanceData"](work, 1);
        if (!sync)
          throw new Error("Bank verge requires actual grass candidates");
        expectPlacementParity(sync, after);
        expect(after.count).toBe(before.count);
        for (const name of ["offsets", "grassTints", "groundNormals"] as const)
          expect(after[name]).toEqual(before[name]);
        for (let index = 0; index < after.count; index++) {
          const offset = index * 3;
          const x = input.centerX + after.offsets[offset];
          const z = input.centerZ + after.offsets[offset + 2];
          const field = ops.macroField(input.config.TERRAIN_PROFILE)!;
          const locality = ops.bankVergeLocality(x, z, field);
          expect(after.rotScaleHash[offset]).toBe(before.rotScaleHash[offset]);
          expect(after.rotScaleHash[offset + 2]).toBe(
            before.rotScaleHash[offset + 2],
          );
          const factor =
            after.rotScaleHash[offset + 1] / before.rotScaleHash[offset + 1];
          expect(factor).toBeGreaterThanOrEqual(0.55 - 1e-7);
          expect(factor).toBeLessThanOrEqual(1 + 1e-7);
          const raw = f.terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0);
          expect(factor).toBeCloseTo(
            ops.bankVergeClumpScale(x, z, raw, field),
            5,
          );
          if (locality === 0) {
            expect(after.rotScaleHash[offset + 1]).toBe(
              before.rotScaleHash[offset + 1],
            );
            expect(after.groundColors.subarray(offset, offset + 3)).toEqual(
              before.groundColors.subarray(offset, offset + 3),
            );
          }
          if (factor < 1 - 1e-7) {
            changed++;
            scaleTotal += factor;
            scaleAreaTotal += factor * factor;
            minimum = Math.min(minimum, factor);
          } else unchanged++;
          expect(f.terrain["isGrassExcludedAt"](x, z)).toBe(false);
          expect(raw).toBeLessThanOrEqual(0.8 + 1e-5);
        }
        if (key === "gcell_v1_13_12") {
          f.manager["createChunkMesh"](work, 0);
          f.manager["processSettledWorkerResults"]();
          let slices = 0;
          while (
            f.manager["groundingJobs"].get(key)?.job.state.status ===
              "running" &&
            slices++ < 500
          )
            f.manager["advanceGroundingJob"]();
          const chunk = f.manager["chunks"].get(key);
          expect(
            chunk,
            JSON.stringify({
              pendingStatus:
                f.manager["groundingJobs"].get(key)?.job.state.status,
              completed: f.manager["completedNodes"].has(key),
              settled: f.manager["settledWorkerResults"].length,
              slices,
            }),
          ).toBeDefined();
          if (!chunk)
            throw new Error("Bank verge must publish actual grounded geometry");
          const receipt = chunk.mesh.userData.grassBladeGrounding as {
            sourceIndices: Uint32Array;
          };
          expect(receipt).toBeDefined();
          const scale = chunk.mesh.geometry.getAttribute(
            "instanceRotScaleHash",
          );
          expect(scale.count).toBe(receipt.sourceIndices.length);
          for (let index = 0; index < scale.count; index++)
            expect(scale.getY(index)).toBe(
              after.rotScaleHash[receipt.sourceIndices[index] * 3 + 1],
            );
          expect(chunk.mesh.userData.walkable).toBe(false);
        }
      }
      expect(changed).toBeGreaterThan(0);
      expect(unchanged).toBeGreaterThan(changed);
      console.info(
        "Bank verge uniform clump taper, not GPU or coverage acceptance",
        JSON.stringify({
          changed,
          unchanged,
          minimum,
          meanScale: scaleTotal / changed,
          meanFootprintAreaFactor: scaleAreaTotal / changed,
        }),
      );
    } finally {
      f.close();
    }
  });

  it("replays historical bank clearing core revisions with native23 arrival routes through the real worker", async () => {
    const f = await coastalFixture(true, [350, 350]);
    // Independent native23 route recipe: both core cases must use these old
    // widths and service tips, not inherit the current arrival-route candidate.
    const bankRoutesNative23 = [
      {
        id: "compact-path-bank-workshop",
        width: 1.1,
        blendWidth: 0.85,
        points: [
          [348, 321],
          [341, 321],
          [341, 330],
          [336.5, 333],
        ],
      },
      {
        id: "compact-path-bank-range",
        width: 0.9,
        blendWidth: 0.8,
        points: [
          [348, 321],
          [341, 321],
          [338.5, 317],
        ],
      },
      {
        id: "compact-path-bank-altar",
        width: 0.9,
        blendWidth: 0.8,
        points: [
          [348, 321],
          [354, 318],
          [354, 311],
        ],
      },
    ] as const;
    const sampleHistoricalControls = (
      controls: readonly (readonly [number, number])[],
    ) => {
      let points = controls.map(([x, z]) => ({ x, z }));
      for (let pass = 0; pass < 2; pass++) {
        const smooth = [points[0]];
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1],
            b = points[i];
          smooth.push(
            { x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 },
            { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 },
          );
        }
        smooth.push(points[points.length - 1]);
        points = smooth;
      }
      const sampled = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
          b = points[i];
        const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)));
        for (let j = 1; j <= count; j++)
          sampled.push({
            x: a.x + ((b.x - a.x) * j) / count,
            z: a.z + ((b.z - a.z) * j) / count,
          });
      }
      return sampled;
    };
    const previousCores = new Map([
      ["compact-clearing-bank-apron", { width: 1.8, blendWidth: 0.6 }],
      [
        "compact-clearing-bank-clerk-approach",
        { width: 1.1, blendWidth: 0.55 },
      ],
      [
        "compact-clearing-bank-shopkeeper-approach",
        { width: 0.9, blendWidth: 0.5 },
      ],
    ]);
    const native23Cores = new Map([
      ["compact-clearing-bank-apron", { width: 1, blendWidth: 1 }],
      [
        "compact-clearing-bank-clerk-approach",
        { width: 0.7, blendWidth: 0.75 },
      ],
      [
        "compact-clearing-bank-shopkeeper-approach",
        { width: 0.65, blendWidth: 0.625 },
      ],
    ]);
    const segments = (previous: boolean) =>
      f.roads.getRoads().flatMap((road) => {
        const historical = bankRoutesNative23.find((row) => row.id === road.id);
        const points = historical
          ? sampleHistoricalControls(historical.points)
          : road.path;
        const shape =
          (previous ? previousCores : native23Cores).get(road.id) ??
          historical ??
          HISTORICAL_MEADOW_SHOULDERS.get(road.id) ??
          road;
        return points.slice(1).map((b, i) => ({
          startX: points[i].x,
          startZ: points[i].z,
          endX: b.x,
          endZ: b.z,
          width: shape.width,
          blendWidth: shape.blendWidth,
          ...(road.maxInfluence === undefined
            ? {}
            : { maxInfluence: road.maxInfluence }),
        }));
      });
    const receipts: Array<{
      key: string;
      before: number;
      after: number;
      delta: number;
      typedBytesBefore: number;
      typedBytesAfter: number;
    }> = [];
    try {
      for (const historical of bankRoutesNative23)
        expect(
          f.roads.getRoads().filter((road) => road.id === historical.id),
        ).toHaveLength(1);
      for (const key of [
        "gcell_v1_13_12",
        "gcell_v1_14_12",
        "gcell_v1_15_14",
      ]) {
        const work = f.manager["liveWorkUnits"].get(key)!;
        expect(work).toBeDefined();
        const input = f.manager["createWorkerInput"](work, key, 0);
        const before = await actualWorker({
          ...input,
          roadSegments: segments(true),
        });
        const after = await actualWorker({
          ...input,
          roadSegments: segments(false),
        });
        const bytes = (result: GrassWorkerOutput) =>
          [
            result.offsets,
            result.rotScaleHash,
            result.groundColors,
            result.grassTints,
            result.groundNormals,
          ].reduce((sum, array) => sum + array.byteLength, 0);
        receipts.push({
          key,
          before: before.count,
          after: after.count,
          delta: after.count - before.count,
          typedBytesBefore: bytes(before),
          typedBytesAfter: bytes(after),
        });
        // Different acceptance can consume a rotation and rephase subsequent
        // candidates inside that cell. Do not claim those added roots are free.
        if (key === "gcell_v1_15_14") expectPlacementParity(after, before);
      }
      // A finite seeded sample may legitimately retain the same count even
      // though influence changes; report measured cost, never force an uplift.
      expect(
        receipts.every((receipt) => receipt.before > 0 && receipt.after > 0),
      ).toBe(true);
      // Independent counts already recorded in candidate35's qualification
      // log, before the new shoulder source; not regenerated expectations.
      expect(
        receipts.map((row) => [
          row.before,
          row.after,
          row.typedBytesBefore,
          row.typedBytesAfter,
        ]),
      ).toEqual([
        [669, 669, 42816, 42816],
        [589, 589, 37696, 37696],
        [841, 841, 53824, 53824],
      ]);
      console.info(
        "Historical bank core revision replay with native23 arrival routes; actual-worker counts, not current-candidate or retained-grounding measurements; same candidate budget, acceptance-dependent RNG",
        JSON.stringify(receipts),
      );
    } finally {
      f.close();
    }
  });

  it("matches new authored establishment between actual worker and sync without rephasing surviving or remote roots", async () => {
    const f = await compositionFixture(undefined, true);
    let added = 0,
      retained = 0;
    const receipts: {
      key: string;
      before: number;
      after: number;
      added: number;
    }[] = [];
    try {
      for (const key of [
        "gcell_v1_13_11",
        "gcell_v1_14_11",
        "gcell_v1_15_10",
      ]) {
        const work = f.manager["liveWorkUnits"].get(key)!;
        expect(work).toBeDefined();
        const input = f.manager["createWorkerInput"](work, key, 0);
        const baseline = structuredClone(input);
        for (const zone of baseline.terrainSurface.zones)
          for (const row of zone.radialPond?.bankComposition?.sectors ?? [])
            Reflect.deleteProperty(row, "groundCover");
        const before = await actualWorker(baseline),
          after = await actualWorker(input);
        const sync = f.manager["generateInstanceData"](work, 1);
        expect(sync?.count ?? 0).toBe(after.count);
        if (sync) expectPlacementParity(sync, after);
        const previous = new Map(
          Array.from({ length: before.count }, (_, i) => [
            `${before.offsets[i * 3]},${before.offsets[i * 3 + 2]}`,
            i,
          ]),
        );
        let newInCell = 0;
        for (let i = 0; i < after.count; i++) {
          const prior = previous.get(
            `${after.offsets[i * 3]},${after.offsets[i * 3 + 2]}`,
          );
          if (prior === undefined) {
            newInCell++;
            added++;
            const x = input.centerX + after.offsets[i * 3],
              z = input.centerZ + after.offsets[i * 3 + 2];
            expect(
              f.terrain.getTerrainColorAt(x, z, true, "compact-pbr-v1")
                .grassEstablishment,
            ).toBe(true);
            expect(after.offsets[i * 3 + 1]).toBeGreaterThanOrEqual(
              f.terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z) +
                0.1 -
                2e-6,
            );
          } else {
            retained++;
            for (const [name, stride] of [
              ["offsets", 3],
              ["rotScaleHash", 3],
              ["grassTints", 4],
              ["groundNormals", 3],
            ] as const)
              expect(
                after[name].subarray(i * stride, (i + 1) * stride),
              ).toEqual(
                before[name].subarray(prior * stride, (prior + 1) * stride),
              );
          }
        }
        if (key === "gcell_v1_15_10") expectPlacementParity(after, before);
        receipts.push({
          key,
          before: before.count,
          after: after.count,
          added: newInCell,
        });
      }
      expect(added).toBeGreaterThan(0);
      expect(retained).toBeGreaterThan(0);
      console.info(
        "Review73 real worker/sync authored establishment; same attempt budget, unchanged water/footprint admission",
        JSON.stringify(receipts),
      );
    } finally {
      f.close();
    }
  });
  it.each([undefined, "distribution-v1"] as const)(
    "shares composition-v1 with real manager/sync/worker owners without scaling or inventing roots (coast=%s)",
    async (coastBlend) => {
      const f = await compositionFixture(coastBlend);
      let retained = 0,
        changedColors = 0;
      try {
        const capturedField = f.manager["compactMacroField"]?.pondBankField;
        expect(capturedField).toBeDefined();
        expect(capturedField).toEqual(f.setup.compactPondBankField);
        expect(Object.isFrozen(capturedField)).toBe(true);
        Reflect.set(f.setup, "compactPondBlend", "mutated-after-capture");
        for (const key of [
          "gcell_v1_13_12",
          "gcell_v1_14_12",
          "gcell_v1_15_14",
        ]) {
          const work = f.manager["liveWorkUnits"].get(key)!;
          expect(work).toBeDefined();
          const input = f.manager["createWorkerInput"](work, key, 0);
          expect(input.compactPondBlend).toBe("composition-v1");
          expect(input).not.toHaveProperty("compactPondBankField");
          expect(
            input.terrainSurface.zones.filter(
              (zone) => zone.id === "haven_pond_floor",
            ),
          ).toHaveLength(1);
          expect(
            input.terrainSurface.waterBodies.filter(
              (body) => body.id === "haven_pond_water",
            ),
          ).toHaveLength(1);
          const { compactPondBlend: _mode, ...baseline } = input;
          const before = await actualWorker(baseline);
          const after = await actualWorker(input);
          const sync = f.manager["generateInstanceData"](work, 1);
          expect(after.count).toBeLessThanOrEqual(before.count);
          expect(sync?.count ?? 0).toBe(after.count);
          if (sync) expectPlacementParity(sync, after);
          const keyAt = (data: PlacementArrays, index: number) =>
            `${data.offsets[index * 3]},${data.offsets[index * 3 + 2]}`;
          const previous = new Map(
            Array.from({ length: before.count }, (_, index) => [
              keyAt(before, index),
              index,
            ]),
          );
          let last = -1;
          for (let index = 0; index < after.count; index++) {
            const prior = previous.get(keyAt(after, index));
            if (prior === undefined)
              throw new Error("Composition invented a root");
            expect(prior).toBeGreaterThan(last);
            last = prior;
            for (const [name, stride] of [
              ["offsets", 3],
              ["rotScaleHash", 3],
              ["grassTints", 4],
              ["groundNormals", 3],
            ] as const)
              expect(
                after[name].subarray(index * stride, (index + 1) * stride),
              ).toEqual(
                before[name].subarray(prior * stride, (prior + 1) * stride),
              );
            if (
              [0, 1, 2].some(
                (channel) =>
                  after.groundColors[index * 3 + channel] !==
                  before.groundColors[prior * 3 + channel],
              )
            )
              changedColors++;
            retained++;
          }
          if (key === "gcell_v1_15_14") expectPlacementParity(after, before);
          for (const data of [
            after,
            {
              ...after,
              count: 0,
              offsets: new Float32Array(0),
              rotScaleHash: new Float32Array(0),
              groundColors: new Float32Array(0),
              grassTints: new Float32Array(0),
              groundNormals: new Float32Array(0),
            },
          ]) {
            f.manager["assertWorkerProfileIdentity"](data);
            const missing = { ...data };
            delete missing.compactPondBlend;
            expect(() =>
              f.manager["assertWorkerProfileIdentity"](missing),
            ).toThrow(/pond distribution/i);
            expect(() =>
              f.manager["assertWorkerProfileIdentity"]({
                ...data,
                compactPondBlend: "shore-contact-v1",
              }),
            ).toThrow(/pond distribution/i);
          }
          f.manager["createChunkMesh"](work, 0);
          const settled = f.manager["settledWorkerResults"].find(
            (entry) => entry.ticket.key === key,
          );
          if (!settled) throw new Error("Composition sync result not admitted");
          expect(settled.data.compactPondBlend).toBe("composition-v1");
          expectPlacementParity(settled.data, after);
        }
        expect(retained).toBeGreaterThan(0);
        expect(changedColors).toBeGreaterThan(0);
        console.info(
          "Review68 actual manager/sync/worker composition parity",
          JSON.stringify({
            coastBlend: coastBlend ?? null,
            retained,
            changedColors,
          }),
        );
      } finally {
        f.close();
      }
    },
  );

  it("rejects missing, malformed, foreign-mode and accessor composition setup fields before manager generation", async () => {
    const f = await compositionFixture();
    try {
      const construct = (setup: GrassWorkerSetup) =>
        new GrassVisualManager(
          setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
          new THREE.Group(),
          f.manager["getRenderedSurface"],
          f.manager["getHeightAt"],
          setup.terrainConfig.WATER_THRESHOLD,
          f.manager["getRoadInfluence"],
          f.manager["isInFlatZone"],
          f.manager["getTerrainColorAt"],
          setup,
          FINE_MEADOW_GRASS_VISUAL_PROFILE,
          undefined,
          f.manager["getWaterSurfaceAt"],
          f.manager["captureRenderedRegion"],
          "fine-meadow-v1",
        );
      const { compactPondBankField: _field, ...missing } = f.setup;
      const cases: GrassWorkerSetup[] = [
        missing,
        { ...f.setup, compactPondBlend: "shore-contact-v1" },
      ];
      for (const value of [null, undefined, {}, { id: "composition-v1" }]) {
        const invalid = { ...f.setup };
        Reflect.set(invalid, "compactPondBankField", value);
        cases.push(invalid);
      }
      let getterCalls = 0;
      const accessor = { ...f.setup };
      Object.defineProperty(accessor, "compactPondBankField", {
        enumerable: true,
        get() {
          getterCalls++;
          return f.setup.compactPondBankField;
        },
      });
      cases.push(accessor);
      for (const setup of cases)
        expect(() => construct(setup)).toThrow(/pond|composition/i);
      expect(getterCalls).toBe(0);
    } finally {
      f.close();
    }
  });

  it.each([undefined, "distribution-v1"] as const)(
    "shares pond support and colors with the actual worker and sync owner (coast=%s)",
    async (coastBlend) => {
      const f = await coastalFixture(
        true,
        [350, 350],
        false,
        FINE_MEADOW_GRASS_VISUAL_PROFILE,
        "current",
        "fine-meadow-green-v1",
        "current-canopy",
        coastBlend,
        "shore-contact-v1",
      );
      let retained = 0,
        changedColors = 0,
        changedScales = 0;
      try {
        expect(f.manager["compactPondBlend"]).toBe("shore-contact-v1");
        Reflect.set(f.setup, "compactPondBlend", "mutated-after-capture");
        for (const key of [
          "gcell_v1_13_12",
          "gcell_v1_14_12",
          "gcell_v1_15_14",
        ]) {
          const work = f.manager["liveWorkUnits"].get(key)!;
          expect(work).toBeDefined();
          const input = f.manager["createWorkerInput"](work, key, 0);
          expect(input.compactPondBlend).toBe("shore-contact-v1");
          expect(input.compactCoastBlend).toBe(coastBlend);
          const { compactPondBlend: _selected, ...baselineInput } = input;
          const before = await actualWorker(baselineInput);
          const after = await actualWorker(input);
          const sync = f.manager["generateInstanceData"](work, 1);
          expect(after.count).toBeLessThanOrEqual(before.count);
          expect(sync?.count ?? 0).toBe(after.count);
          if (sync) expectPlacementParity(sync, after);
          const keyAt = (data: PlacementArrays, i: number) =>
            `${data.offsets[i * 3]},${data.offsets[i * 3 + 2]}`;
          const old = new Map(
            Array.from({ length: before.count }, (_, i) => [
              keyAt(before, i),
              i,
            ]),
          );
          let previous = -1;
          for (let i = 0; i < after.count; i++) {
            const original = old.get(keyAt(after, i));
            if (original === undefined)
              throw new Error("Pond support created an unseeded root");
            expect(original).toBeGreaterThan(previous);
            previous = original;
            for (const [name, stride] of [
              ["offsets", 3],
              ["grassTints", 4],
              ["groundNormals", 3],
            ] as const)
              expect(
                after[name].subarray(i * stride, (i + 1) * stride),
              ).toEqual(
                before[name].subarray(
                  original * stride,
                  (original + 1) * stride,
                ),
              );
            expect(after.rotScaleHash[i * 3]).toBe(
              before.rotScaleHash[original * 3],
            );
            expect(after.rotScaleHash[i * 3 + 2]).toBe(
              before.rotScaleHash[original * 3 + 2],
            );
            const scaleRatio =
              after.rotScaleHash[i * 3 + 1] /
              before.rotScaleHash[original * 3 + 1];
            expect(scaleRatio).toBeGreaterThanOrEqual(0.55 - 4 * 2 ** -23);
            expect(scaleRatio).toBeLessThanOrEqual(1 + 4 * 2 ** -23);
            if (
              after.rotScaleHash[i * 3 + 1] !==
              before.rotScaleHash[original * 3 + 1]
            )
              changedScales++;
            if (
              [0, 1, 2].some(
                (channel) =>
                  after.groundColors[i * 3 + channel] !==
                  before.groundColors[original * 3 + channel],
              )
            )
              changedColors++;
            retained++;
          }
          if (key === "gcell_v1_15_14") {
            expect(
              input.terrainSurface.waterBodies.some(
                (body) => body.id === "haven_pond_water",
              ),
            ).toBe(false);
            expectPlacementParity(after, before);
          }
          for (const data of [
            after,
            {
              ...after,
              count: 0,
              offsets: new Float32Array(0),
              rotScaleHash: new Float32Array(0),
              groundColors: new Float32Array(0),
              grassTints: new Float32Array(0),
              groundNormals: new Float32Array(0),
            },
          ]) {
            f.manager["assertWorkerProfileIdentity"](data);
            const missing = { ...data };
            delete missing.compactPondBlend;
            expect(() =>
              f.manager["assertWorkerProfileIdentity"](missing),
            ).toThrow(/pond distribution/i);
            for (const value of [
              undefined,
              "relief-v1",
              "relief-contact-v1",
              "unknown",
            ]) {
              const wrong = { ...data };
              Reflect.set(wrong, "compactPondBlend", value);
              expect(() =>
                f.manager["assertWorkerProfileIdentity"](wrong),
              ).toThrow(/pond distribution/i);
            }
          }
          f.manager["createChunkMesh"](work, 0);
          const settled = f.manager["settledWorkerResults"].find(
            (entry) => entry.ticket.key === key,
          );
          expect(settled?.data.compactPondBlend).toBe("shore-contact-v1");
          if (!settled)
            throw new Error("Synchronous pond result was not admitted");
          expectPlacementParity(settled.data, after);
          if (!coastBlend && key === "gcell_v1_13_12") {
            f.manager["processSettledWorkerResults"]();
            const entry = f.manager["groundingJobs"].get(key);
            if (!entry) throw new Error("Actual pond grounding job required");
            let slices = 0;
            while (entry.job.state.status === "running" && slices++ < 500)
              f.manager["advanceGroundingJob"]();
            expect(entry.job.state.status).toBe("ready");
            const chunk = f.manager["chunks"].get(key);
            if (!chunk)
              throw new Error("Pond fixture must publish grounded geometry");
            const receipt = chunk.mesh.userData
              .grassBladeGrounding as GrassBladeGroundingReceipt & {
              sourceIndices: Uint32Array;
            };
            expect(receipt.workUnits).toBeLessThanOrEqual(receipt.workBudget);
            expect(receipt.processedClumps).toBe(receipt.inputClumps);
            expect(receipt.maxAcceptedBaseError).toBeLessThanOrEqual(0.02);
            const transforms = chunk.mesh.geometry.getAttribute(
              "instanceRotScaleHash",
            );
            const offsets = chunk.mesh.geometry.getAttribute("instanceOffset");
            expect(transforms.count).toBeGreaterThan(0);
            expect(transforms.count).toBe(receipt.sourceIndices.length);
            let installedChangedScales = 0;
            for (let i = 0; i < transforms.count; i++) {
              const source = receipt.sourceIndices[i];
              expect(transforms.getX(i)).toBe(after.rotScaleHash[source * 3]);
              expect(transforms.getY(i)).toBe(
                after.rotScaleHash[source * 3 + 1],
              );
              expect(transforms.getZ(i)).toBe(
                after.rotScaleHash[source * 3 + 2],
              );
              expect(offsets.getX(i)).toBe(after.offsets[source * 3]);
              expect(offsets.getZ(i)).toBe(after.offsets[source * 3 + 2]);
              const prior = old.get(keyAt(after, source));
              if (prior === undefined)
                throw new Error(
                  "Installed pond root must belong to original seeded input",
                );
              if (transforms.getY(i) !== before.rotScaleHash[prior * 3 + 1])
                installedChangedScales++;
            }
            expect(installedChangedScales).toBeGreaterThan(0);
            console.info(
              "Review62 actual retained grounding consumes pond scale",
              JSON.stringify({
                key,
                installedChangedScales,
                input: receipt.inputClumps,
                retained: receipt.retainedClumps,
                workUnits: receipt.workUnits,
                workBudget: receipt.workBudget,
              }),
            );
          }
        }
        expect(retained).toBeGreaterThan(0);
        expect(changedColors).toBeGreaterThan(0);
        expect(changedScales).toBeGreaterThan(0);
        console.info(
          "Review62 pond worker/sync parity with admitted scale",
          JSON.stringify({
            coastBlend: coastBlend ?? null,
            retained,
            changedColors,
            changedScales,
          }),
        );
      } finally {
        f.close();
      }
      const ordinary = await coastalFixture(true);
      try {
        expect(ordinary.manager["compactPondBlend"]).toBeUndefined();
        const work = ordinary.manager["liveWorkUnits"].get("gcell_v1_17_17")!;
        const input = ordinary.manager["createWorkerInput"](work, work.key, 0);
        expect(input).not.toHaveProperty("compactPondBlend");
        const data = await actualWorker(input);
        expect(() =>
          ordinary.manager["assertWorkerProfileIdentity"]({
            ...data,
            compactPondBlend: "shore-contact-v1",
          }),
        ).toThrow(/pond distribution/i);
      } finally {
        ordinary.close();
      }
    },
  );

  it("shares explicit coastal ecology with the real worker without rephasing retained poses or losing result identity", async () => {
    const f = await coastalFixture(
      true,
      [450, 450],
      false,
      FINE_MEADOW_GRASS_VISUAL_PROFILE,
      "current",
      "fine-meadow-green-v1",
      "current-canopy",
      "distribution-v1",
    );
    let removed = 0,
      retained = 0,
      changedColors = 0;
    try {
      expect(f.manager["compactCoastBlend"]).toBe("distribution-v1");
      // Mutating the caller's setup after construction cannot reselect the owner.
      Reflect.set(f.setup, "compactCoastBlend", "mutated-after-capture");
      for (const key of [
        "gcell_v1_17_19",
        "gcell_v1_17_17",
        "gcell_v1_18_19",
      ]) {
        const work = f.manager["liveWorkUnits"].get(key)!;
        expect(work).toBeDefined();
        const input = f.manager["createWorkerInput"](work, key, 0);
        expect(input.compactCoastBlend).toBe("distribution-v1");
        const { compactCoastBlend: _selected, ...baselineInput } = input;
        const before = await actualWorker(baselineInput);
        const after = await actualWorker(input);
        const sync = f.manager["generateInstanceData"](work, 1);
        expect(after.compactCoastBlend).toBe("distribution-v1");
        expect(after.count).toBeLessThanOrEqual(before.count);
        expect(sync?.count ?? 0).toBe(after.count);
        if (sync) expectPlacementParity(sync, after);
        const keyAt = (data: PlacementArrays, i: number) =>
          `${data.offsets[i * 3]},${data.offsets[i * 3 + 2]}`;
        const old = new Map(
          Array.from({ length: before.count }, (_, i) => [keyAt(before, i), i]),
        );
        let previousIndex = -1;
        for (let i = 0; i < after.count; i++) {
          const original = old.get(keyAt(after, i));
          expect(original).toBeDefined();
          if (original === undefined)
            throw new Error("Coastal distribution created an unseeded root");
          expect(original).toBeGreaterThan(previousIndex);
          previousIndex = original;
          for (const [name, stride] of [
            ["offsets", 3],
            ["rotScaleHash", 3],
            ["grassTints", 4],
            ["groundNormals", 3],
          ] as const)
            expect(after[name].subarray(i * stride, (i + 1) * stride)).toEqual(
              before[name].subarray(original * stride, (original + 1) * stride),
            );
          if (
            [0, 1, 2].some(
              (channel) =>
                after.groundColors[i * 3 + channel] !==
                before.groundColors[original * 3 + channel],
            )
          )
            changedColors++;
          retained++;
        }
        removed += before.count - after.count;
        for (const data of [
          after,
          {
            ...after,
            count: 0,
            offsets: new Float32Array(0),
            rotScaleHash: new Float32Array(0),
            groundColors: new Float32Array(0),
            grassTints: new Float32Array(0),
            groundNormals: new Float32Array(0),
          },
        ]) {
          f.manager["assertWorkerProfileIdentity"](data);
          const missing = { ...data };
          delete missing.compactCoastBlend;
          expect(() =>
            f.manager["assertWorkerProfileIdentity"](missing),
          ).toThrow(/coastal distribution/i);
          for (const invalid of [undefined, "detail-v1", "unknown"]) {
            const wrong = { ...data };
            Reflect.set(wrong, "compactCoastBlend", invalid);
            expect(() =>
              f.manager["assertWorkerProfileIdentity"](wrong),
            ).toThrow(/coastal distribution/i);
          }
        }
        f.manager["createChunkMesh"](work, 0);
        const settled = f.manager["settledWorkerResults"].find(
          (entry) => entry.ticket.key === key,
        );
        expect(settled?.data.compactCoastBlend).toBe("distribution-v1");
        if (!settled)
          throw new Error("Synchronous coastal result was not admitted");
        expectPlacementParity(settled.data, after);
      }
      expect(removed).toBeGreaterThan(0);
      expect(retained).toBeGreaterThan(0);
      expect(changedColors).toBeGreaterThan(0);
      console.info(
        "Review55 coastal ecology actual-worker/sync subset, not indexed-root ecology or native visual acceptance",
        JSON.stringify({ removed, retained, changedColors }),
      );
    } finally {
      f.close();
    }
    const ordinary = await coastalFixture(true);
    try {
      expect(ordinary.manager["compactCoastBlend"]).toBeUndefined();
      const work = ordinary.manager["liveWorkUnits"].get("gcell_v1_17_17")!;
      const input = ordinary.manager["createWorkerInput"](work, work.key, 0);
      expect(input).not.toHaveProperty("compactCoastBlend");
      const data = await actualWorker(input);
      expect(() =>
        ordinary.manager["assertWorkerProfileIdentity"]({
          ...data,
          compactCoastBlend: "distribution-v1",
        }),
      ).toThrow(/coastal distribution/i);
    } finally {
      ordinary.close();
    }
  });

  it.each([false, true])(
    "keeps real coastal and inland fallback placement identical to the emitted worker (candidate=%s)",
    async (candidate) => {
      const f = await coastalFixture(candidate);
      try {
        for (const [label, key] of [
          ["coastal", "gcell_v1_17_19"],
          ["inland", "gcell_v1_17_17"],
        ] as const) {
          const work = f.manager["liveWorkUnits"].get(key)!;
          expect(work).toBeDefined();
          f.observed.coastal = 0;
          f.observed.reduced = 0;
          const sync = f.manager["generateInstanceData"](work, 1);
          expect(sync?.count).toBeGreaterThan(0);
          if (!sync) throw new Error("Expected real terrain grass placements");
          if (candidate && label === "coastal") {
            expect(f.observed.coastal).toBeGreaterThan(0);
            expect(f.observed.reduced).toBeGreaterThan(0);
          } else expect(f.observed.coastal).toBe(0);
          const worker = await actualWorker(
            f.manager["createWorkerInput"](work, key, 0),
          );
          expectPlacementParity(sync, worker);
          // Exercise the production synchronous fallback, including its retained
          // terrain ticket, not merely a separately reconstructed placement loop.
          f.manager["createChunkMesh"](work, 0);
          const settled = f.manager["settledWorkerResults"].find(
            (entry) => entry.ticket.key === key,
          );
          expect(settled).toBeDefined();
          expectPlacementParity(settled!.data, worker);
        }
        expect(DataManager.getWorldTerrainProfile()).not.toHaveProperty(
          "southernMeadow",
        );
      } finally {
        f.close();
      }
    },
  );

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
      f.manager["pendingLodSwap"].set(f.key, {
        node: f.node,
        work: ticket.work,
        desiredLod: 2,
      });
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
      f.manager["pendingLodSwap"].set(f.key, {
        node: f.node,
        work: ticket.work,
        desiredLod: 1,
      });
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
