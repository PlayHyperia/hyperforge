import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { stationDataProvider } from "../../../../data/StationDataProvider";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import {
  createDuelArenaFloorZones,
  getDuelArenaGradeHeight,
} from "../../../../data/arena-grading";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem, roadSegmentInfluence } from "../RoadNetworkSystem";
import {
  COMPACT_PATH_BLEND_WIDTH,
  compactPathIntersectsBounds,
  compactPathSegmentDistance,
  createCompactIslandPaths,
} from "../CompactIslandPaths";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_V2_PROFILE_FIXTURE,
  SCULPTED_COMPACT_V3_PROFILE_FIXTURE,
  SCULPTED_COMPACT_V4_PROFILE_FIXTURE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";
import type { RoadTileSegment } from "../../../../types/world/world-types";
import {
  COMPACT_PREPARATION_LODGE,
  getCompactPreparationLodgeFootprint,
} from "../CompactPreparationLodge";
import { GRASS_WORKER_CODE } from "../../../../utils/workers/GrassWorker";
import THREE from "../../../../extras/three/three";
import { DuelArenaVisualsSystem } from "../../../client/DuelArenaVisualsSystem";
import { COMPACT_BANK_PAVILION } from "../CompactServiceCourt";
import { TownSystem } from "../TownSystem";

// Independently declared surface recipe; centerlines and outer support remain
// those of the previously captured fourteen-path world, not a wider network.
const CORE_RECIPE = [
  ["compact-path-pond-bank", 1.8, 1.1, 0.85],
  ["compact-path-bank-workshop", 1.8, 1.1, 0.85],
  ["compact-path-bank-range", 1.5, 0.9, 0.8],
  ["compact-path-bank-altar", 1.5, 0.9, 0.8],
  ["compact-path-bank-lobby", 2.2, 1.4, 0.9],
  ["compact-path-lobby-arena", 2.2, 1.4, 0.9],
  ["compact-clearing-bank-apron", 4, 1.8, 1.6],
  ["compact-clearing-bank-clerk-approach", 3, 1.1, 1.45],
  ["compact-clearing-bank-shopkeeper-approach", 2.5, 0.9, 1.3],
  ["compact-clearing-workshop-apron", 3.5, 1.2, 1.65],
  ["compact-clearing-workshop-supplier-approach", 2.5, 0.9, 1.3],
] as const;

function previousCoreRecipe(roads: ReturnType<RoadNetworkSystem["getRoads"]>) {
  return roads.map((road, index) => {
    if (index >= CORE_RECIPE.length) return road;
    expect(road.id).toBe(CORE_RECIPE[index][0]);
    const previous = { ...road, width: CORE_RECIPE[index][1] };
    delete previous.blendWidth;
    delete previous.maxInfluence;
    return previous;
  });
}

type TerrainInternals = {
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  subscribeRoadNetworkEvents(): void;
  calculateRoadInfluenceAtVertex(
    x: number,
    z: number,
    tileX: number,
    tileZ: number,
  ): number;
  computeRoadInfluenceBatchCPU(
    vertices: Float32Array,
    tileX: number,
    tileZ: number,
    segments: RoadTileSegment[],
  ): Float32Array;
  getWorldSpaceRoadSegmentsForRegion(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): ReturnType<RoadNetworkSystem["getRoadSegmentsForGPU"]>;
};
type RoadInternals = {
  buildTileCache(): void;
  calculateRoadMaskTextureSize(worldSize: number): number;
  calculateRoadMaskBounds(
    segments: ReturnType<RoadNetworkSystem["getRoadSegmentsForGPU"]>,
  ): { worldSize: number; centerX: number; centerZ: number };
};

async function withRoads(
  run: (
    roads: RoadNetworkSystem,
    terrain: TerrainSystem,
  ) => void | Promise<void>,
  beforeStart?: (roads: RoadNetworkSystem, terrain: TerrainSystem) => void,
) {
  const world = new World(),
    terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  try {
    await terrain.init();
    const internal = terrain as unknown as TerrainInternals;
    internal.loadWaterBodiesFromManifest();
    internal.loadFlatZonesFromManifest();
    await roads.init();
    beforeStart?.(roads, terrain);
    await roads.start();
    await run(roads, terrain);
  } finally {
    world.destroy();
  }
}

// Actual detached world04 terrain/support recipe, with no live manifest edit.
// Only the selected profile starts the new paint branch. Restore the exact
// DataManager owners and area objects after destroying the borrowed World.
async function withMeadowRoads(
  run: (
    roads: RoadNetworkSystem,
    terrain: TerrainSystem,
  ) => void | Promise<void>,
) {
  const config = DataManager.getWorldConfig()!;
  const live = DataManager.getWorldTerrainProfile();
  const owners = Object.fromEntries(
    ["worldConfig", "worldTerrainProfile", "worldContentIdentity"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(DataManager, key)!],
    ),
  );
  const originalAreas = { ...ALL_WORLD_AREAS };
  const areaBytes = JSON.stringify(ALL_WORLD_AREAS);
  const areas = structuredClone(ALL_WORLD_AREAS);
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
      lowland: { ...live.coastalApron!.lowland!, westHoldX: 394 },
    },
    terrace: {
      ...live.terrace!,
      crestHeight: 17.5,
      shelfHeight: 7,
      scarpRun: 16,
      shelfWidth: 8,
      apronWidth: 30,
    },
    ridgeBreakup: {
      ...live.ridgeBreakup!,
      northGapZ: -20,
      northGapDepth: 0,
      southGapZ: 27,
      southGapHalfWidth: 24,
      southGapDepth: 0.5,
    },
  });
  const datum = 28.419301523097687;
  const duel = areas.duel_arena;
  expect(
    duel.flatZones!.filter((zone) => zone.id === "duel_arena_campus_grade"),
  ).toHaveLength(1);
  duel.arenaFloorDatum = { height: datum };
  duel.flatZones = [
    ...duel.flatZones!.filter((zone) => zone.id !== "duel_arena_campus_grade"),
    ...(
      [
        ["arena", 339, 361, 393, 419],
        ["lobby", 375, 395, 367, 385],
        ["hospital", 338, 352, 369, 383],
      ] as const
    ).map(([id, minX, maxX, minZ, maxZ]) => ({
      id: `southern-meadow-${id}-backing`,
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2,
      width: maxX - minX,
      depth: maxZ - minZ,
      height: datum,
      blendRadius: 24,
      blendShape: "rounded" as const,
      blendComposition: "smooth-union" as const,
      excludeGrass: false,
    })),
  ];
  try {
    // The suite's manifest bootstrap is already identified. Model a separate
    // fresh startup before constructing any World; never hot-swap its owners.
    Object.defineProperty(DataManager, "worldContentIdentity", {
      ...owners.worldContentIdentity,
      value: null,
    });
    DataManager.setWorldConfig({ ...config, terrainProfile: profile });
    Object.assign(ALL_WORLD_AREAS, areas);
    await withRoads(run);
  } finally {
    Object.assign(ALL_WORLD_AREAS, originalAreas);
    Object.defineProperties(DataManager, owners);
    expect(JSON.stringify(ALL_WORLD_AREAS)).toBe(areaBytes);
    expect(DataManager.getWorldConfig()).toBe(config);
    expect(DataManager.getWorldTerrainProfile()).toBe(live);
  }
}

const pathFixtures = [
  { name: "baseline", run: withRoads },
  { name: "southern-meadow", run: withMeadowRoads },
];

type Paths = ReturnType<typeof createCompactIslandPaths>;

// Exact bank recipe in native15/executed, before this candidate. Do not derive
// these old blends from the new source or silently update the native10 hooks.
const BANK_BLEND_BEFORE = new Map([
  ["compact-clearing-bank-apron", 1.6],
  ["compact-clearing-bank-clerk-approach", 1.45],
  ["compact-clearing-bank-shopkeeper-approach", 1.3],
]);
// Independent native19 recipe. Preserve this evidence when testing subsequent
// local core edits; do not reconstruct historical widths from current output.
const BANK_NATIVE19 = new Map([
  ["compact-clearing-bank-apron", { width: 1.8, blendWidth: 0.6 }],
  ["compact-clearing-bank-clerk-approach", { width: 1.1, blendWidth: 0.55 }],
  [
    "compact-clearing-bank-shopkeeper-approach",
    { width: 0.9, blendWidth: 0.5 },
  ],
]);
const BANK_WEAR_IDS = [
  "compact-wear-bank-clerk-outer",
  "compact-wear-bank-apron-inner",
];

// Exact native23 shoulder recipe, also retained through native37. These values
// come from the executed source, not today's path output. Keep arrival radii
// and derived feather arithmetic independent too: borrowing current metadata
// would silently rewrite the historical native19/native23 mask comparisons.
const MEADOW_SHOULDERS_NATIVE23 = new Map([
  ["compact-path-pond-bank", { width: 0.65, blendWidth: 1.075 }],
  ["compact-path-bank-lobby", { width: 0.9, blendWidth: 1.15 }],
  ["compact-clearing-bank-apron", { width: 1, blendWidth: 1 }],
  ["compact-clearing-bank-clerk-approach", { width: 0.7, blendWidth: 0.75 }],
  [
    "compact-clearing-bank-shopkeeper-approach",
    { width: 0.65, blendWidth: 0.625 },
  ],
]);
const MEADOW_ARRIVALS_NATIVE23 = [
  {
    pathId: "compact-path-bank-lobby",
    floorId: "duel_lobby_floor",
    endpoint: "end",
    supportRadius: 0.9 / 2 + 1.15,
    wearId: "compact-wear-bank-lobby-end-arrival",
  },
  {
    pathId: "compact-path-lobby-arena",
    floorId: "duel_lobby_floor",
    endpoint: "start",
    supportRadius: 1.4 / 2 + 0.9,
    wearId: "compact-wear-lobby-arena-start-arrival",
  },
  {
    pathId: "compact-path-lobby-arena",
    floorId: "duel_arena_floor_1",
    endpoint: "end",
    supportRadius: 1.4 / 2 + 0.9,
    wearId: "compact-wear-lobby-arena-end-arrival",
  },
] as const;

function beforeMeadowShoulderReduction(paths: Paths): Paths {
  return paths.map((path) => {
    const arrival = MEADOW_ARRIVALS_NATIVE23.find(
      (row) => row.wearId === path.id,
    );
    return {
      ...path,
      ...MEADOW_SHOULDERS_NATIVE23.get(path.id),
      ...(arrival
        ? { width: 2.2, blendWidth: arrival.supportRadius - 1.1 }
        : {}),
      ...(path.platformEntries
        ? {
            platformEntries: path.platformEntries.map((entry) => {
              const old = MEADOW_ARRIVALS_NATIVE23.find(
                (row) =>
                  row.pathId === path.id &&
                  row.floorId === entry.floorId &&
                  row.endpoint === entry.endpoint,
              );
              expect(old).toBeDefined();
              return { ...entry, supportRadius: old!.supportRadius };
            }),
          }
        : {}),
    };
  });
}

// Native23's three bank arrivals, independently pinned before the next art
// slice. Historical masks must not inherit a newly shortened service tip.
const BANK_ROUTES_NATIVE23 = [
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

function sampleBankControls(
  controls: readonly (readonly [number, number])[],
  terrain: TerrainSystem,
) {
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
  return {
    path: sampled.map((point) => ({
      ...point,
      y: terrain.getHeightAt(point.x, point.z),
    })),
    length: sampled
      .slice(1)
      .reduce(
        (sum, p, i) => sum + Math.hypot(p.x - sampled[i].x, p.z - sampled[i].z),
        0,
      ),
  };
}

// Run older checkpoint assertions through the real RoadNetworkSystem with its
// explicit historical recipe and rebuilt tile cache. Tests below reconstruct
// its former tight256 raster explicitly; the current production mask is NOT
// republished or replaced by that historical fixture.
async function withHistoricalMeadowRoads(
  run: (roads: RoadNetworkSystem, terrain: TerrainSystem) => void,
  recipe: "selected" | "beforeShoulders",
) {
  await withMeadowRoads((roads, terrain) => {
    const stored = roads.getRoads(),
      current = stored.slice();
    const selected = selectedAndPrevious(terrain)[recipe];
    const productionMask = roads.getRoadInfluenceTextureData();
    try {
      stored.splice(
        0,
        stored.length,
        ...selected.map((path, i) => ({
          ...current[i],
          ...path,
          path: path.path.map((point) => ({ ...point })),
        })),
      );
      roads["buildTileCache"]();
      run(roads, terrain);
    } finally {
      stored.splice(0, stored.length, ...current);
      roads["buildTileCache"]();
      expect(roads.getRoadInfluenceTextureData()).toBe(productionMask);
    }
  });
}

function withNative23MeadowRoads(
  run: (roads: RoadNetworkSystem, terrain: TerrainSystem) => void,
) {
  return withHistoricalMeadowRoads(run, "selected");
}

function beforeBankForecourt(paths: Paths): Paths {
  return paths
    .filter((path) => !BANK_WEAR_IDS.includes(path.id))
    .map((path) => ({
      ...path,
      ...(BANK_BLEND_BEFORE.has(path.id)
        ? {
            width: BANK_NATIVE19.get(path.id)!.width,
            blendWidth: BANK_BLEND_BEFORE.get(path.id)!,
          }
        : {}),
    }));
}

function samplePaths(paths: Paths, x: number, z: number): number {
  let value = 0;
  for (const road of paths)
    for (let i = 1; i < road.path.length; i++) {
      const a = road.path[i - 1],
        b = road.path[i];
      value = Math.max(
        value,
        roadSegmentInfluence(
          x,
          z,
          a.x,
          a.z,
          b.x,
          b.z,
          road.width,
          road.blendWidth ?? 0.5,
          road.maxInfluence ?? 1,
        ),
      );
    }
  return value;
}

function selectedAndPrevious(terrain: TerrainSystem) {
  const profile = DataManager.getWorldTerrainProfile();
  const { southernMeadow, ...withoutMeadow } = profile;
  expect(southernMeadow).toBeDefined();
  const areas = DataManager.getInstance().getAllWorldAreas();
  const paths = (value: typeof profile) =>
    createCompactIslandPaths(value, areas, getDuelArenaConfig(), (x, z) =>
      terrain.getHeightAt(x, z),
    );
  const candidate = paths(profile);
  const beforeShoulders = beforeMeadowShoulderReduction(candidate);
  const selected = beforeShoulders.map((path) => {
    const historical = BANK_ROUTES_NATIVE23.find((row) => row.id === path.id);
    return historical
      ? {
          ...path,
          width: historical.width,
          blendWidth: historical.blendWidth,
          ...sampleBankControls(historical.points, terrain),
        }
      : path;
  });
  const previous = paths(validateWorldTerrainProfile(withoutMeadow));
  const preBankForecourt = beforeBankForecourt(selected);
  // Candidate wear/widths with the exact pre-entry centerlines. Historical
  // straight stubs below reproduce native10's three hooked entry polylines,
  // independently of the new curve controls and arrival shoulder samples.
  const beforeEntries = preBankForecourt.slice(0, 18).map((path, index) => ({
    ...path,
    ...(index < previous.length
      ? { path: previous[index].path, length: previous[index].length }
      : {}),
    platformEntries: undefined,
  }));
  const hooked = beforeEntries.map((path) => ({ ...path }));
  for (const [index, endpoint, to] of [
    [4, "end", { x: 385, z: 368.5 }],
    [5, "start", { x: 385, z: 383.5 }],
    [5, "end", { x: 350, z: 395 }],
  ] as const) {
    const route = hooked[index];
    const from = route.path[endpoint === "start" ? 0 : route.path.length - 1];
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.ceil(length);
    const extension = Array.from({ length: steps }, (_, index) => {
      const t = (index + 1) / steps;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      return { x, z, y: terrain.getHeightAt(x, z) };
    });
    hooked[index] = {
      ...route,
      path:
        endpoint === "start"
          ? [...extension.reverse(), ...route.path]
          : [...route.path, ...extension],
      length: route.length + length,
    };
  }
  return {
    candidate,
    beforeShoulders,
    selected,
    previous,
    preBankForecourt,
    beforeEntries,
    hooked,
  };
}

function containsEntry(paths: Paths, x: number, z: number, halo = 0) {
  return paths.some((path) =>
    path.platformEntries?.some((entry) =>
      [entry.approach, entry.previousApproach].some((points) =>
        points
          .slice(1)
          .some(
            (b, i) =>
              compactPathSegmentDistance({ x, z }, points[i], b) <=
              entry.supportRadius + halo,
          ),
      ),
    ),
  );
}

function sampleLinearMask(
  data: Float32Array,
  bounds: { worldSize: number; centerX: number; centerZ: number },
  x: number,
  z: number,
) {
  const resolution = Math.sqrt(data.length);
  const tx = ((x - bounds.centerX) / bounds.worldSize + 0.5) * resolution - 0.5;
  const tz = ((z - bounds.centerZ) / bounds.worldSize + 0.5) * resolution - 0.5;
  const ix = Math.floor(tx),
    iz = Math.floor(tz);
  const fx = tx - ix,
    fz = tz - iz;
  const at = (dx: number, dz: number) =>
    data[
      Math.max(0, Math.min(resolution - 1, iz + dz)) * resolution +
        Math.max(0, Math.min(resolution - 1, ix + dx))
    ];
  return (
    (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fz) +
    (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fz
  );
}

describe("actual compact preparation paths and centered road mask", () => {
  it("selects the authored mask domain only for the admitted v6 meadow and preserves ordinary tight startup", async () => {
    await withRoads((roads) => {
      const segments = roads.getRoadSegmentsForGPU();
      expect(roads["calculateAuthoredRoadMaskBounds"](segments)).toBeNull();
      const tight = roads["calculateRoadMaskBounds"](segments);
      expect(roads.getRoadInfluenceTextureData()).toMatchObject({
        ...tight,
        width: 256,
        height: 256,
      });
    });
    await withMeadowRoads((roads) => {
      const segments = roads.getRoadSegmentsForGPU();
      const owner = Object.getOwnPropertyDescriptor(
        DataManager,
        "worldConfig",
      )!;
      const config = DataManager.getWorldConfig()!;
      const profile = config.terrainProfile!;
      try {
        expect(roads["calculateAuthoredRoadMaskBounds"](segments)).toEqual({
          worldSize: 142,
          centerX: 368,
          centerZ: 362,
        });
        for (const terrainProfile of [
          { ...profile, southernMeadow: undefined },
          {
            ...SCULPTED_COMPACT_V4_PROFILE_FIXTURE,
            southernMeadow: profile.southernMeadow,
          },
        ]) {
          Object.defineProperty(DataManager, "worldConfig", {
            ...owner,
            value: { ...config, terrainProfile },
          });
          expect(roads["calculateAuthoredRoadMaskBounds"](segments)).toBeNull();
        }
      } finally {
        Object.defineProperty(DataManager, "worldConfig", owner);
        expect(DataManager.getWorldConfig()).toBe(config);
      }
    });
  });

  it("contains every padded authored route and rejects malformed or overflowing road support without resizing", async () => {
    await withMeadowRoads((roads) => {
      const segments = roads.getRoadSegmentsForGPU();
      const saved = structuredClone(segments);
      const bounds = roads["calculateAuthoredRoadMaskBounds"](segments)!;
      expect(bounds).toEqual({ worldSize: 142, centerX: 368, centerZ: 362 });
      for (const segment of segments) {
        const padding = segment.width / 2 + (segment.blendWidth ?? 0.5) + 1;
        expect(
          Math.min(segment.startX, segment.endX) - padding,
        ).toBeGreaterThanOrEqual(297);
        expect(
          Math.max(segment.startX, segment.endX) + padding,
        ).toBeLessThanOrEqual(439);
        expect(
          Math.min(segment.startZ, segment.endZ) - padding,
        ).toBeGreaterThanOrEqual(291);
        expect(
          Math.max(segment.startZ, segment.endZ) + padding,
        ).toBeLessThanOrEqual(433);
      }
      const edge = {
        startX: 299,
        endX: 437,
        startZ: 350,
        endZ: 350,
        width: 1,
        blendWidth: 0.5,
      };
      expect(roads["calculateAuthoredRoadMaskBounds"]([edge])).toEqual(bounds);
      for (const invalid of [
        { ...edge, startX: NaN },
        { ...edge, endZ: Infinity },
        { ...edge, width: 0 },
        { ...edge, width: -1 },
        { ...edge, width: Infinity },
        { ...edge, blendWidth: NaN },
        { ...edge, blendWidth: -0.1 },
      ])
        expect(() =>
          roads["calculateAuthoredRoadMaskBounds"]([invalid]),
        ).toThrow("requires finite positive road support");
      for (const overflow of [
        { ...edge, startX: 298.999 },
        { ...edge, endX: 437.001 },
        { ...edge, startZ: 292.999 },
        { ...edge, endZ: 431.001 },
      ])
        expect(() =>
          roads["calculateAuthoredRoadMaskBounds"]([overflow]),
        ).toThrow("route support leaves admitted layout");
      expect(segments).toEqual(saved);
      expect(roads["calculateAuthoredRoadMaskBounds"](segments)).toEqual(
        bounds,
      );
    });
  });

  it("rejects missing layout bounds and validates the expanded square against both admitted profile and world bounds", async () => {
    await withMeadowRoads((roads) => {
      const segments = roads.getRoadSegmentsForGPU();
      const areas = DataManager.getInstance().getAllWorldAreas();
      const original = { ...areas };
      const bytes = JSON.stringify(areas);
      const configOwner = Object.getOwnPropertyDescriptor(
        DataManager,
        "worldConfig",
      )!;
      const config = DataManager.getWorldConfig()!;
      const halfSize = roads["worldHalfSize"];
      try {
        for (const id of ["central_haven", "haven_pond", "duel_arena"]) {
          Reflect.set(areas, id, undefined);
          expect(() =>
            roads["calculateAuthoredRoadMaskBounds"](segments),
          ).toThrow("requires valid admitted layout bounds");
          areas[id] = original[id];
          for (const bounds of [
            { ...original[id].bounds, minX: NaN },
            { ...original[id].bounds, maxZ: Infinity },
            { ...original[id].bounds, maxX: original[id].bounds.minX },
            { ...original[id].bounds, maxZ: original[id].bounds.minZ - 1 },
          ]) {
            areas[id] = { ...original[id], bounds };
            expect(() =>
              roads["calculateAuthoredRoadMaskBounds"](segments),
            ).toThrow("requires valid admitted layout bounds");
          }
          areas[id] = original[id];
        }
        // Every original rectangle fits X316..420; its expanded square starts
        // at297. This catches an implementation checking rectangles only.
        Object.defineProperty(DataManager, "worldConfig", {
          ...configOwner,
          value: {
            ...config,
            terrainProfile: {
              ...config.terrainProfile!,
              bounds: { ...config.terrainProfile!.bounds, minX: 300 },
            },
          },
        });
        expect(() =>
          roads["calculateAuthoredRoadMaskBounds"](segments),
        ).toThrow("layout square leaves admitted world bounds");
        Object.defineProperty(DataManager, "worldConfig", configOwner);
        roads["worldHalfSize"] = 50;
        expect(() =>
          roads["calculateAuthoredRoadMaskBounds"](segments),
        ).toThrow("layout square leaves admitted world bounds");
      } finally {
        Object.assign(areas, original);
        Object.defineProperty(DataManager, "worldConfig", configOwner);
        roads["worldHalfSize"] = halfSize;
        expect(JSON.stringify(areas)).toBe(bytes);
        expect(DataManager.getWorldConfig()).toBe(config);
      }
      expect(roads["calculateAuthoredRoadMaskBounds"](segments)).toEqual({
        worldSize: 142,
        centerX: 368,
        centerZ: 362,
      });
    });
  });

  it("retains the historical three-bank-arrival refinement with service contact and bounded measured fan reduction", async () => {
    await withHistoricalMeadowRoads((roads, terrain) => {
      const {
        beforeShoulders: candidate,
        selected: native23,
        previous,
      } = selectedAndPrevious(terrain);
      const expected = [
        { ...BANK_ROUTES_NATIVE23[0], width: 0.75, blendWidth: 0.65 },
        {
          ...BANK_ROUTES_NATIVE23[1],
          width: 0.65,
          blendWidth: 0.45,
          points: [
            [348, 321],
            [341, 321],
            [337.5, 317],
          ],
        },
        {
          ...BANK_ROUTES_NATIVE23[2],
          width: 0.65,
          blendWidth: 0.45,
          points: [
            [348, 321],
            [354, 318],
            [354, 309.25],
          ],
        },
      ] as const;
      expect(candidate.map((p) => [p.id, p.fromId, p.toId])).toEqual(
        native23.map((p) => [p.id, p.fromId, p.toId]),
      );
      for (const [i, after] of candidate.entries()) {
        const recipe = expected.find((row) => row.id === after.id);
        if (!recipe) expect(after).toEqual(native23[i]);
        else {
          expect(after).toEqual({
            ...native23[i],
            width: recipe.width,
            blendWidth: recipe.blendWidth,
            ...sampleBankControls(recipe.points, terrain),
          });
          expect(after.path[0]).toMatchObject({ x: 348, z: 321 });
          // Default v6 continues to use the independently pinned old controls.
          expect(previous.find((p) => p.id === after.id)).toEqual(native23[i]);
        }
      }
      const areas = DataManager.getInstance().getAllWorldAreas();
      const areaBytes = JSON.stringify(areas);
      const stationsBefore = JSON.stringify(
        stationDataProvider["stationEntries"],
      );
      for (const type of ["range", "altar"]) {
        const station = stationDataProvider.getStationData(type)!;
        const location = areas.central_haven.stations!.find(
          (row) => row.type === type,
        )!.position;
        const raw = stationDataProvider["modelBoundsByPath"].get(
          station.model!,
        )!.bounds;
        const model = {
          minX: location.x + raw.min.x * station.modelScale,
          maxX: location.x + raw.max.x * station.modelScale,
          minZ: location.z + raw.min.z * station.modelScale,
          maxZ: location.z + raw.max.z * station.modelScale,
        };
        const endpoint = candidate
          .find((p) => p.id === `compact-path-bank-${type}`)!
          .path.at(-1)!;
        // The service tip meets world12's existing1.25m model clearance, not
        // the solid model. No global station provider/manifest is changed here.
        expect(endpoint.x).toBeGreaterThan(model.minX - 1.25);
        expect(endpoint.x).toBeLessThan(model.maxX + 1.25);
        expect(endpoint.z).toBeGreaterThan(model.minZ - 1.25);
        expect(endpoint.z).toBeLessThan(model.maxZ + 1.25);
        expect(endpoint.x > model.maxX || endpoint.z > model.maxZ).toBe(true);
      }
      const stored = roads.getRoads(),
        current = stored.slice();
      const bounds = roads["calculateAuthoredRoadMaskBounds"](
        roads.getRoadSegmentsForGPU(),
      )!;
      expect(bounds).toEqual({ worldSize: 142, centerX: 368, centerZ: 362 });
      const resolution = roads["calculateRoadMaskTextureSize"](
        bounds.worldSize,
      );
      expect(resolution).toBe(512);
      const mask = (domain: typeof bounds, size = resolution) =>
        roads.generateRoadInfluenceTexture(
          size,
          domain.worldSize,
          0.5,
          domain.centerX,
          domain.centerZ,
        )!;
      const after = mask(bounds);
      // Historical recipe on the current lattice; the wrapper preserves the
      // separately published current mask, checked by the shoulder test below.
      let before: typeof after,
        oldDomain: typeof after,
        beforeBounds: typeof bounds;
      try {
        stored.splice(
          0,
          stored.length,
          ...native23.map((path, i) => ({
            ...current[i],
            ...path,
            path: path.path.map((point) => ({ ...point })),
          })),
        );
        beforeBounds = roads["calculateRoadMaskBounds"](
          roads.getRoadSegmentsForGPU(),
        );
        expect(
          roads["calculateAuthoredRoadMaskBounds"](
            roads.getRoadSegmentsForGPU(),
          ),
        ).toEqual(bounds);
        expect(roads["calculateRoadMaskTextureSize"](bounds.worldSize)).toBe(
          resolution,
        );
        before = mask(bounds);
        // Original native23's256 raster is kept solely to measure the explicit
        // one-time migration, never treated as a same-grid locality comparison.
        oldDomain = mask(beforeBounds, 256);
      } finally {
        stored.splice(0, stored.length, ...current);
        roads["buildTileCache"]();
      }
      const changedPaths = [...native23, ...candidate].filter((p) =>
        expected.some((row) => row.id === p.id),
      );
      const withinChange = (x: number, z: number, halo = 0) =>
        changedPaths.some((path) =>
          path.path
            .slice(1)
            .some(
              (b, i) =>
                compactPathSegmentDistance({ x, z }, path.path[i], b) <=
                path.width / 2 + path.blendWidth! + halo,
            ),
        );
      let changedTexels = 0,
        recoveredTexels = 0,
        addedTexels = 0;
      let outsideNativeMaxDelta = 0,
        outsideStableMaxDelta = 0,
        outsideStableSamples = 0;
      const pixel = bounds.worldSize / resolution;
      // The raster samples index/N but LinearFilter centers at(index+.5)/N.
      // A changed texel reaches[-.5,+1.5]pixels per axis; this radial halo
      // contains its ENTIRE bilinear support, not only sampled centers.
      const stableHalo = 1.5 * Math.SQRT2 * pixel;
      for (let iz = 0; iz < resolution; iz++)
        for (let ix = 0; ix < resolution; ix++) {
          const index = iz * resolution + ix;
          const x = (ix / resolution - 0.5) * bounds.worldSize + bounds.centerX;
          const z = (iz / resolution - 0.5) * bounds.worldSize + bounds.centerZ;
          if (after.data[index] !== before.data[index]) {
            changedTexels++;
            expect(withinChange(x, z)).toBe(true);
          }
          if (before.data[index] > 0.8 && after.data[index] <= 0.8)
            recoveredTexels++;
          if (before.data[index] <= 0.8 && after.data[index] > 0.8)
            addedTexels++;
          if (!withinChange(x, z, stableHalo)) {
            outsideStableSamples++;
            outsideStableMaxDelta = Math.max(
              outsideStableMaxDelta,
              Math.abs(
                sampleLinearMask(after.data, bounds, x, z) -
                  sampleLinearMask(before.data, bounds, x, z),
              ),
            );
          }
          const halo =
            Math.max(pixel, beforeBounds.worldSize / 256) * 1.5 * Math.SQRT2;
          if (!withinChange(x, z, halo))
            outsideNativeMaxDelta = Math.max(
              outsideNativeMaxDelta,
              Math.abs(
                sampleLinearMask(after.data, bounds, x, z) -
                  sampleLinearMask(oldDomain.data, beforeBounds, x, z),
              ),
            );
        }
      let beforeBare = 0,
        afterBare = 0;
      for (let ix = 0; ix <= 170; ix++)
        for (let iz = 0; iz <= 100; iz++) {
          const x = 340 + ix * 0.1,
            z = 316 + iz * 0.1;
          if (samplePaths(native23, x, z) > 0.8) beforeBare++;
          if (samplePaths(candidate, x, z) > 0.8) afterBare++;
          expect(roads.getRoadInfluenceAt(x, z)).toBe(
            samplePaths(candidate, x, z),
          );
        }
      expect(beforeBare).toBe(4709);
      expect(afterBare).toBe(4253);
      expect(changedTexels).toBeGreaterThan(0);
      expect(recoveredTexels).toBeGreaterThan(addedTexels);
      expect(outsideStableMaxDelta).toBe(0);
      expect(outsideStableSamples).toBeGreaterThan(250000);
      expect(after.data.byteLength).toBe(1048576);
      expect(after.data.byteLength - oldDomain.data.byteLength).toBe(786432);
      expect(pixel).toBe(0.27734375);
      expect(pixel).toBeLessThan(beforeBounds.worldSize / 256);
      expect(roads.getRoadSegmentsForGPU().length).toBe(579);
      expect(JSON.stringify(areas)).toBe(areaBytes);
      expect(JSON.stringify(stationDataProvider["stationEntries"])).toBe(
        stationsBefore,
      );
      process.stdout.write(
        "Bank arrivals native23/candidate; unqualified visual candidate " +
          JSON.stringify({
            beforeBare,
            afterBare,
            sampledAreaReductionM2: (beforeBare - afterBare) * 0.01,
            changedTexels,
            recoveredTexels,
            addedTexels,
            beforeBounds,
            bounds,
            resolution,
            outsideStableMaxDelta,
            outsideStableSamples,
            stableHalo,
            outsideNativeMaxDelta,
            maskBytes: after.data.byteLength,
            segments: roads.getRoadSegmentsForGPU().length,
          }) +
          "\n",
      );
    }, "beforeShoulders");
  });

  it("narrows only five meadow shoulders on the published lattice while retaining full cores, service joins and asymmetric wear", async () => {
    await withMeadowRoads((roads, terrain) => {
      const { candidate, beforeShoulders } = selectedAndPrevious(terrain);
      const blends = new Map([
        ["compact-path-pond-bank", 0.6],
        ["compact-path-bank-lobby", 0.85],
        ["compact-clearing-bank-apron", 0.6],
        ["compact-clearing-bank-clerk-approach", 0.45],
        ["compact-clearing-bank-shopkeeper-approach", 0.45],
      ]);
      const areas = DataManager.getInstance().getAllWorldAreas();
      const areaBytes = JSON.stringify(areas);
      const changed = candidate.filter((path) => blends.has(path.id));
      expect(changed).toHaveLength(5);
      for (const [index, after] of candidate.entries()) {
        const before = beforeShoulders[index];
        expect(after.path).toEqual(before.path);
        expect(after.length).toBe(before.length);
        expect(after.width).toBe(before.width);
        expect(after.maxInfluence).toBe(before.maxInfluence);
        expect([after.fromId, after.toId]).toEqual([
          before.fromId,
          before.toId,
        ]);
        if (blends.has(after.id)) {
          expect(after.blendWidth).toBe(blends.get(after.id));
          expect(after.blendWidth).toBeLessThan(before.blendWidth!);
        } else if (after.id !== "compact-wear-bank-lobby-end-arrival") {
          expect(after).toEqual(before);
        }
      }
      const lobby = candidate.find((p) => p.id === "compact-path-bank-lobby")!;
      const oldLobby = beforeShoulders.find((p) => p.id === lobby.id)!;
      expect(lobby.platformEntries).toEqual(
        oldLobby.platformEntries!.map((entry) => ({
          ...entry,
          supportRadius: 1.3,
        })),
      );
      const arrival = candidate.find(
        (p) => p.id === "compact-wear-bank-lobby-end-arrival",
      )!;
      expect(arrival.width).toBe(2.2);
      expect(arrival.blendWidth).toBeCloseTo(0.2, 14);
      expect(arrival.width / 2 + arrival.blendWidth!).toBe(1.3);
      expect(arrival.maxInfluence).toBe(0.76);

      // Full-width capsules, not merely the centerline: narrowing a fade must
      // leave every existing saturated core and every authored endpoint intact.
      // These are paint/ground invariants, not a claim of a new navmesh test.
      for (const path of candidate.filter(
        (p) => !p.id.startsWith("compact-wear-"),
      )) {
        for (let i = 1; i < path.path.length; i++) {
          const a = path.path[i - 1],
            b = path.path[i];
          const length = Math.hypot(b.x - a.x, b.z - a.z);
          for (const t of [0, 0.25, 0.5, 0.75, 1])
            for (const offset of [-path.width / 2, 0, path.width / 2]) {
              const x = a.x + (b.x - a.x) * t - ((b.z - a.z) / length) * offset;
              const z = a.z + (b.z - a.z) * t + ((b.x - a.x) / length) * offset;
              expect(roads.getRoadInfluenceAt(x, z)).toBeCloseTo(1, 12);
              expect(samplePaths(beforeShoulders, x, z)).toBeCloseTo(1, 12);
            }
        }
        for (const point of path.path)
          expect(point.y).toBe(terrain.getHeightAt(point.x, point.z));
      }
      const route = (id: string) => candidate.find((p) => p.id === id)!;
      const bankJoin = route("compact-path-pond-bank").path.at(-1)!;
      for (const id of ["workshop", "range", "altar", "lobby"])
        expect(route(`compact-path-bank-${id}`).path[0]).toEqual(bankJoin);
      const apron = route("compact-clearing-bank-apron");
      expect(route("compact-clearing-bank-clerk-approach").path[0]).toEqual(
        apron.path.at(-1),
      );
      expect(
        route("compact-clearing-bank-shopkeeper-approach").path[0],
      ).toEqual(apron.path[0]);

      const stored = roads.getRoads(),
        current = stored.slice();
      const segments = roads.getRoadSegmentsForGPU();
      const bounds = roads["calculateAuthoredRoadMaskBounds"](segments)!;
      expect(bounds).toEqual({ worldSize: 142, centerX: 368, centerZ: 362 });
      expect(roads["calculateRoadMaskTextureSize"](bounds.worldSize)).toBe(512);
      expect(segments).toHaveLength(579);
      const mask = () =>
        roads.generateRoadInfluenceTexture(
          512,
          bounds.worldSize,
          0.5,
          bounds.centerX,
          bounds.centerZ,
        )!;
      const after = mask();
      expect(after).toEqual(roads.getRoadInfluenceTextureData());
      let before: typeof after;
      try {
        stored.splice(
          0,
          stored.length,
          ...beforeShoulders.map((path, i) => ({
            ...current[i],
            ...path,
            path: path.path.map((point) => ({ ...point })),
          })),
        );
        expect(
          roads["calculateAuthoredRoadMaskBounds"](
            roads.getRoadSegmentsForGPU(),
          ),
        ).toEqual(bounds);
        expect(roads["calculateRoadMaskTextureSize"](bounds.worldSize)).toBe(
          512,
        );
        before = mask();
      } finally {
        stored.splice(0, stored.length, ...current);
        roads["buildTileCache"]();
      }
      let reducedTexels = 0,
        removedSupport = 0,
        recoveredVerge = 0,
        retainedCore = 0;
      for (let i = 0; i < after.data.length; i++) {
        const old = before.data[i],
          value = after.data[i];
        expect(value).toBeLessThanOrEqual(old);
        if (old === 0) expect(value).toBe(0);
        if (old === 1) {
          expect(value).toBe(1);
          retainedCore++;
        }
        if (value < old) reducedTexels++;
        if (old > 0 && value === 0) removedSupport++;
        if (old > 0.8 && value <= 0.8) recoveredVerge++;
      }
      expect(reducedTexels).toBeGreaterThan(0);
      expect(removedSupport).toBeGreaterThan(0);
      expect(recoveredVerge).toBeGreaterThan(0);
      expect(retainedCore).toBeGreaterThan(0);
      expect(after.data.byteLength).toBe(1048576);
      expect(roads.getRoadInfluenceTextureData()).toEqual(after);
      expect(roads.getRoadSegmentsForGPU()).toEqual(segments);
      expect(JSON.stringify(areas)).toBe(areaBytes);
      process.stdout.write(
        "Meadow shoulders: current512 MAX field, not visual approval " +
          JSON.stringify({
            bounds,
            reducedTexels,
            removedSupport,
            recoveredVerge,
            retainedCore,
            maskBytes: after.data.byteLength,
            segments: segments.length,
          }) +
          "\n",
      );
    });
  });

  it("selects narrower meadow cores and shoulders, four exact partial skirts and three local curved arrivals without changing other routes or ground", async () => {
    await withMeadowRoads((roads, terrain) => {
      const { candidate: selected, previous } = selectedAndPrevious(terrain);
      expect(previous).toHaveLength(14);
      expect(selected).toHaveLength(23);
      expect(roads.getRoads()).toHaveLength(23);
      const changed = new Map([
        ["compact-path-pond-bank", { width: 0.65, blendWidth: 0.6 }],
        ["compact-path-bank-lobby", { width: 0.9, blendWidth: 0.85 }],
        ["compact-path-bank-workshop", { width: 0.75, blendWidth: 0.65 }],
        ["compact-path-bank-range", { width: 0.65, blendWidth: 0.45 }],
        ["compact-path-bank-altar", { width: 0.65, blendWidth: 0.45 }],
        ["compact-clearing-bank-apron", { width: 1, blendWidth: 0.6 }],
        [
          "compact-clearing-bank-clerk-approach",
          { width: 0.7, blendWidth: 0.45 },
        ],
        [
          "compact-clearing-bank-shopkeeper-approach",
          { width: 0.65, blendWidth: 0.45 },
        ],
      ]);
      selected.slice(0, 14).forEach((path, index) => {
        const old = previous[index];
        const { platformEntries, ...surface } = path;
        expect({ ...surface, path: old.path, length: old.length }).toEqual({
          ...old,
          ...changed.get(path.id),
        });
        const serviceTip =
          path.id === "compact-path-bank-range" ||
          path.id === "compact-path-bank-altar";
        if (!platformEntries && !serviceTip)
          expect(path.path).toEqual(old.path);
        for (const point of old.path) {
          const replaced = platformEntries?.some((entry) =>
            entry.previousApproach.some(
              (p) => p.x === point.x && p.z === point.z,
            ),
          );
          if (!replaced && !serviceTip) expect(path.path).toContainEqual(point);
        }
        const actualLength = path.path
          .slice(1)
          .reduce(
            (sum, point, i) =>
              sum +
              Math.hypot(point.x - path.path[i].x, point.z - path.path[i].z),
            0,
          );
        expect(path.length).toBeCloseTo(actualLength, 10);
        const radius = path.width / 2 + (path.blendWidth ?? 0.5);
        const previousRadius =
          previous[index].width / 2 + (previous[index].blendWidth ?? 0.5);
        if (
          MEADOW_SHOULDERS_NATIVE23.has(path.id) ||
          BANK_ROUTES_NATIVE23.some((row) => row.id === path.id)
        )
          expect(radius).toBeLessThan(previousRadius);
        else expect(radius).toBeCloseTo(previousRadius, 14);
      });
      expect(
        selected
          .slice(14, 18)
          .map((path) => [
            path.id,
            path.width,
            path.blendWidth,
            path.maxInfluence,
          ]),
      ).toEqual([
        ["compact-wear-pond-bank-east", 1.2, 0.3, 0.62],
        ["compact-wear-pond-bank-west", 1.2, 0.3, 0.58],
        ["compact-wear-bank-lobby-outer", 1.2, 0.3, 0.64],
        ["compact-wear-bank-lobby-inner", 1.2, 0.3, 0.6],
      ]);
      expect(Object.isFrozen(selected)).toBe(true);
      for (const path of selected) {
        expect(Object.isFrozen(path)).toBe(true);
        expect(Object.isFrozen(path.path)).toBe(true);
        expect(path.path.length).toBeGreaterThan(1);
        expect(path.path.length).toBeLessThanOrEqual(256);
        for (const point of path.path) {
          expect(Object.isFrozen(point)).toBe(true);
          expect(point.y).toBe(terrain.getHeightAt(point.x, point.z));
        }
        for (let i = 1; i < path.path.length; i++)
          expect(
            Math.hypot(
              path.path[i].x - path.path[i - 1].x,
              path.path[i].z - path.path[i - 1].z,
            ),
          ).toBeLessThanOrEqual(1 + 1e-12);
        if (path.platformEntries) {
          expect(Object.isFrozen(path.platformEntries)).toBe(true);
          for (const entry of path.platformEntries) {
            expect(Object.isFrozen(entry)).toBe(true);
            expect(Object.isFrozen(entry.from)).toBe(true);
            expect(Object.isFrozen(entry.to)).toBe(true);
            expect(Object.isFrozen(entry.approach)).toBe(true);
            expect(Object.isFrozen(entry.previousApproach)).toBe(true);
          }
        }
      }
      // The full route core stays connected at every segment, including both
      // original service endpoints. This is paint connectivity, not nav proof.
      for (const path of selected.slice(0, 6)) {
        for (let i = 1; i < path.path.length; i++) {
          const a = path.path[i - 1],
            b = path.path[i];
          for (const t of [0, 0.25, 0.5, 0.75, 1])
            expect(
              roads.getRoadInfluenceAt(
                a.x + (b.x - a.x) * t,
                a.z + (b.z - a.z) * t,
              ),
            ).toBe(1);
        }
      }
      for (const skirt of selected.slice(14, 18)) {
        expect(skirt.maxInfluence).toBeLessThanOrEqual(0.65);
        for (const point of [skirt.path[0], skirt.path[skirt.path.length - 1]])
          expect(samplePaths(selected.slice(0, 14), point.x, point.z)).toBe(1);
        const route = previous.find(
          (path) => path.fromId === skirt.fromId && path.toId === skirt.toId,
        )!;
        const radius = route.width / 2 + route.blendWidth!;
        // A capsule around both endpoints inside ONE original segment's
        // capsule proves the whole skirt segment, not just sampled centers.
        for (let i = 1; i < skirt.path.length; i++) {
          const a = skirt.path[i - 1],
            b = skirt.path[i];
          const enclosingDistance = Math.min(
            ...route.path
              .slice(1)
              .map((end, j) =>
                Math.max(
                  compactPathSegmentDistance(a, route.path[j], end),
                  compactPathSegmentDistance(b, route.path[j], end),
                ),
              ),
          );
          expect(
            enclosingDistance + skirt.width / 2 + skirt.blendWidth!,
            `${skirt.id} capsule ${i}`,
          ).toBeLessThanOrEqual(radius);
        }
      }
      expect(roads.getRoadNetwork()?.towns).toEqual([]);
      expect(roads.getRoadNetwork()?.boundaryExits).toBeUndefined();
    });
  });

  it("retains the pre-bank candidate's asymmetric meadow wear under MAX union outside declared entry capsules on the actual256 mask", async () => {
    await withNative23MeadowRoads((roads, terrain) => {
      const { preBankForecourt: selected, previous } =
        selectedAndPrevious(terrain);
      const core = selected.slice(0, 14),
        skirts = selected.slice(14, 18);
      const asymmetry: Record<
        string,
        { increased: number; asymmetric: number; maxDelta: number }
      > = {};
      for (const id of ["compact-path-pond-bank", "compact-path-bank-lobby"]) {
        const route = selected.find((path) => path.id === id)!;
        const counts = { increased: 0, asymmetric: 0, maxDelta: 0 };
        for (let i = 1; i < route.path.length; i++) {
          const a = route.path[i - 1],
            b = route.path[i];
          const length = Math.hypot(b.x - a.x, b.z - a.z);
          if (length === 0) continue;
          for (const offset of [0.65, 0.85, 1.05, 1.25]) {
            const increases = [-1, 1].map((side) => {
              const x =
                (a.x + b.x) / 2 - ((b.z - a.z) / length) * offset * side;
              const z =
                (a.z + b.z) / 2 + ((b.x - a.x) / length) * offset * side;
              const base = samplePaths(core, x, z);
              const wear = samplePaths(skirts, x, z);
              const actual = samplePaths(selected, x, z);
              expect(wear).toBeLessThanOrEqual(0.65);
              const arrivalWear = samplePaths(selected.slice(18), x, z);
              expect(actual).toBe(Math.max(base, wear, arrivalWear));
              expect(actual > 0.8).toBe(base > 0.8);
              if (!containsEntry(selected, x, z))
                expect(actual > 0).toBe(samplePaths(previous, x, z) > 0);
              const increase = actual - base;
              if (increase > 0.01) counts.increased++;
              counts.maxDelta = Math.max(counts.maxDelta, increase);
              return increase;
            });
            if (Math.abs(increases[0] - increases[1]) > 0.03)
              counts.asymmetric++;
          }
        }
        expect(counts.increased, id).toBeGreaterThan(0);
        expect(counts.asymmetric, id).toBeGreaterThan(0);
        asymmetry[id] = counts;
      }
      const internal = roads as unknown as RoadInternals;
      const stored = roads.getRoads(),
        current = stored.slice();
      const bounds = internal.calculateRoadMaskBounds(
        roads.getRoadSegmentsForGPU(),
      );
      expect(internal.calculateRoadMaskTextureSize(bounds.worldSize)).toBe(256);
      const mask = () =>
        roads.generateRoadInfluenceTexture(
          256,
          bounds.worldSize,
          0.5,
          bounds.centerX,
          bounds.centerZ,
        )!;
      const actualMask = mask();
      // Explicit historical recipe through the real CPU kernel, not the
      // current production authored512 startup mask. Native review is separate.
      expect(actualMask.width).toBe(256);
      let selectedMask: ReturnType<typeof mask>;
      let widerJoinedCoreMask: ReturnType<typeof mask>;
      let coreMask: ReturnType<typeof mask>;
      try {
        const historical = current.slice(0, 21).map((road) => ({
          ...road,
          ...(BANK_BLEND_BEFORE.has(road.id)
            ? {
                width: BANK_NATIVE19.get(road.id)!.width,
                blendWidth: BANK_BLEND_BEFORE.get(road.id)!,
              }
            : {}),
        }));
        stored.splice(0, stored.length, ...historical);
        selectedMask = mask();
        stored.splice(0, stored.length, ...historical.slice(0, 14));
        coreMask = mask();
        stored.splice(
          0,
          stored.length,
          ...historical.slice(0, 14).map((road, index) => ({
            ...road,
            width: previous[index].width,
            blendWidth: previous[index].blendWidth,
          })),
        );
        expect(
          internal.calculateRoadMaskBounds(roads.getRoadSegmentsForGPU()),
        ).toEqual(bounds);
        // A controlled wear comparison: same new joins, old core widths.
        // The independent test below compares actual old versus new geometry.
        widerJoinedCoreMask = mask();
      } finally {
        stored.splice(0, stored.length, ...current);
        internal.buildTileCache();
      }
      // Reconstruct the runtime LinearFilter/ClampToEdge sampler at its actual
      // texel centers. Keep the existing index/N raster convention unchanged.
      const bilinear = (data: Float32Array, x: number, z: number) => {
        const tx = ((x - bounds.centerX) / bounds.worldSize + 0.5) * 256 - 0.5;
        const tz = ((z - bounds.centerZ) / bounds.worldSize + 0.5) * 256 - 0.5;
        const ix = Math.floor(tx),
          iz = Math.floor(tz);
        const fx = tx - ix,
          fz = tz - iz;
        const at = (dx: number, dz: number) =>
          data[
            Math.max(0, Math.min(255, iz + dz)) * 256 +
              Math.max(0, Math.min(255, ix + dx))
          ];
        return (
          (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fz) +
          (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fz
        );
      };
      const rasterAsymmetry: typeof asymmetry = {};
      for (const id of Object.keys(asymmetry)) {
        const route = selected.find((path) => path.id === id)!;
        const counts = { increased: 0, asymmetric: 0, maxDelta: 0 };
        for (let i = 1; i < route.path.length; i++) {
          const a = route.path[i - 1],
            b = route.path[i];
          const length = Math.hypot(b.x - a.x, b.z - a.z);
          if (length === 0) continue;
          for (const offset of [0.65, 0.85, 1.05, 1.25]) {
            const increases = [-1, 1].map((side) => {
              const x =
                (a.x + b.x) / 2 - ((b.z - a.z) / length) * offset * side;
              const z =
                (a.z + b.z) / 2 + ((b.x - a.x) / length) * offset * side;
              const increase =
                bilinear(selectedMask.data, x, z) -
                bilinear(coreMask.data, x, z);
              expect(increase).toBeGreaterThanOrEqual(0);
              if (increase > 0.01) counts.increased++;
              counts.maxDelta = Math.max(counts.maxDelta, increase);
              return increase;
            });
            if (Math.abs(increases[0] - increases[1]) > 0.03)
              counts.asymmetric++;
          }
        }
        expect(counts.increased, `${id} bilinear`).toBeGreaterThan(0);
        expect(counts.asymmetric, `${id} bilinear`).toBeGreaterThan(0);
        rasterAsymmetry[id] = counts;
      }
      let lowered = 0,
        raised = 0,
        recoveredFromSaturation = 0;
      for (let i = 0; i < selectedMask.data.length; i++) {
        const before = widerJoinedCoreMask.data[i],
          after = selectedMask.data[i];
        expect(after > 0, `selected texel ${i} support`).toBe(before > 0);
        if (after < before) lowered++;
        if (after > before) raised++;
        if (before > 0.8 && after <= 0.8) recoveredFromSaturation++;
      }
      expect(lowered).toBeGreaterThan(0);
      expect(recoveredFromSaturation).toBeGreaterThan(0);
      process.stdout.write(
        "Meadow paint-only actual256/source measurements (not rendered quality or grass cost) " +
          JSON.stringify({
            lowered,
            raised,
            recoveredFromSaturation,
            asymmetry,
            rasterAsymmetry,
            previousSegments: previous.reduce(
              (sum, path) => sum + path.path.length - 1,
              0,
            ),
            historicalSelectedSegments: selected.reduce(
              (sum, path) => sum + path.path.length - 1,
              0,
            ),
            currentSegments: roads.getRoadSegmentsForGPU().length,
            maskBytes: selectedMask.data.byteLength,
            bounds,
          }) +
          "\n",
      );
    });
  });

  it("narrows only three bank service cores without changing their native19 support, centerlines or mask budget", async () => {
    await withNative23MeadowRoads((roads, terrain) => {
      const { selected } = selectedAndPrevious(terrain);
      const native19 = selected.map((path) => ({
        ...path,
        ...BANK_NATIVE19.get(path.id),
      }));
      for (const [index, after] of selected.entries()) {
        const before = native19[index];
        if (!BANK_NATIVE19.has(after.id)) {
          expect(after).toEqual(before);
          continue;
        }
        expect(after.width).toBeLessThan(before.width);
        expect(after.width / 2 + after.blendWidth!).toBeCloseTo(
          before.width / 2 + before.blendWidth!,
          14,
        );
        expect({
          ...after,
          width: before.width,
          blendWidth: before.blendWidth,
        }).toEqual(before);
        for (const point of after.path)
          expect(samplePaths(selected, point.x, point.z)).toBe(1);
      }
      const internals = roads as unknown as RoadInternals;
      const stored = roads.getRoads();
      const current = stored.slice();
      const bounds = internals.calculateRoadMaskBounds(
        roads.getRoadSegmentsForGPU(),
      );
      const mask = () =>
        roads.generateRoadInfluenceTexture(
          256,
          bounds.worldSize,
          0.5,
          bounds.centerX,
          bounds.centerZ,
        )!;
      const after = mask();
      let before: typeof after;
      try {
        stored.splice(
          0,
          stored.length,
          ...current.map((road) => ({
            ...road,
            ...BANK_NATIVE19.get(road.id),
          })),
        );
        expect(
          internals.calculateRoadMaskBounds(roads.getRoadSegmentsForGPU()),
        ).toEqual(bounds);
        before = mask();
      } finally {
        stored.splice(0, stored.length, ...current);
        internals.buildTileCache();
      }
      let changedTexels = 0,
        recoveredVergeTexels = 0;
      for (let i = 0; i < after.data.length; i++) {
        const old = before.data[i],
          value = after.data[i];
        expect(value).toBeLessThanOrEqual(old);
        expect(value > 0).toBe(old > 0);
        if (value !== old) changedTexels++;
        if (old > 0.8 && value <= 0.8) recoveredVergeTexels++;
      }
      // Dense analytical sampling quantifies the joined bank core rather than
      // only checking each independently narrowed capsule.
      let beforeBare = 0,
        afterBare = 0;
      for (let ix = 0; ix <= 170; ix++)
        for (let iz = 0; iz <= 100; iz++) {
          const x = 340 + ix * 0.1,
            z = 316 + iz * 0.1;
          const old = samplePaths(native19, x, z),
            value = samplePaths(selected, x, z);
          expect(value).toBeLessThanOrEqual(old);
          if (old > 0.8) beforeBare++;
          if (value > 0.8) afterBare++;
        }
      expect(changedTexels).toBe(106);
      expect(recoveredVergeTexels).toBe(29);
      expect(beforeBare).toBe(5026);
      expect(afterBare).toBe(4709);
      expect(after.data.byteLength).toBe(262144);
      expect(roads.getRoadSegmentsForGPU()).toHaveLength(577);
      process.stdout.write(
        "Bank core versus native19 (not rendered approval) " +
          JSON.stringify({
            changedTexels,
            recoveredVergeTexels,
            beforeBare,
            afterBare,
            sampledAreaReductionM2: (beforeBare - afterBare) * 0.01,
            maskBytes: after.data.byteLength,
            segments: 577,
          }) +
          "\n",
      );
    });
  });

  it("tightens only the three bank halos and preserves connected asymmetric wear on the real256 mask within previous support", async () => {
    await withNative23MeadowRoads((roads, terrain) => {
      const { selected, preBankForecourt } = selectedAndPrevious(terrain);
      const lobes = selected.filter((path) => BANK_WEAR_IDS.includes(path.id));
      const cores = selected.filter((path) => !BANK_WEAR_IDS.includes(path.id));
      expect(
        lobes.map((path) => [
          path.id,
          path.width,
          path.blendWidth,
          path.maxInfluence,
        ]),
      ).toEqual([
        [BANK_WEAR_IDS[0], 0.7, 0.4, 0.62],
        [BANK_WEAR_IDS[1], 0.7, 0.4, 0.55],
      ]);
      expect(selected.slice(0, 21).map((path) => path.id)).toEqual(
        preBankForecourt.map((path) => path.id),
      );
      for (const [index, before] of preBankForecourt.entries()) {
        const after = selected[index];
        expect({
          ...after,
          width: before.width,
          blendWidth: before.blendWidth,
        }).toEqual(before);
        if (!BANK_BLEND_BEFORE.has(after.id)) expect(after).toEqual(before);
        if (BANK_BLEND_BEFORE.has(after.id)) {
          // Sweep the full remaining service core, not only its spine.
          for (let i = 1; i < after.path.length; i++) {
            const a = after.path[i - 1],
              b = after.path[i];
            const length = Math.hypot(b.x - a.x, b.z - a.z);
            for (const t of [0, 0.25, 0.5, 0.75, 1])
              for (const offset of [-after.width / 2, 0, after.width / 2]) {
                const x =
                  a.x + (b.x - a.x) * t - ((b.z - a.z) / length) * offset;
                const z =
                  a.z + (b.z - a.z) * t + ((b.x - a.x) / length) * offset;
                expect(roads.getRoadInfluenceAt(x, z)).toBeCloseTo(1, 12);
              }
          }
        }
      }
      const apron = preBankForecourt.find(
        (path) => path.id === "compact-clearing-bank-apron",
      )!;
      const a = apron.path[0],
        b = apron.path.at(-1)!;
      for (const lobe of lobes) {
        const owner = preBankForecourt.find(
          (path) =>
            BANK_BLEND_BEFORE.has(path.id) &&
            path.fromId === lobe.fromId &&
            path.toId === lobe.toId,
        )!;
        const radius = owner.width / 2 + owner.blendWidth!;
        expect(lobe.maxInfluence).toBeLessThanOrEqual(0.65);
        for (const point of [lobe.path[0], lobe.path.at(-1)!])
          expect(samplePaths(cores, point.x, point.z)).toBe(1);
        for (const point of lobe.path)
          expect(
            compactPathSegmentDistance(
              point,
              owner.path[0],
              owner.path.at(-1)!,
            ) +
              lobe.width / 2 +
              lobe.blendWidth!,
          ).toBeLessThanOrEqual(radius);
      }
      const internal = roads as unknown as RoadInternals;
      const stored = roads.getRoads(),
        current = stored.slice();
      const bounds = internal.calculateRoadMaskBounds(
        roads.getRoadSegmentsForGPU(),
      );
      const mask = () =>
        roads.generateRoadInfluenceTexture(
          256,
          bounds.worldSize,
          0.5,
          bounds.centerX,
          bounds.centerZ,
        )!;
      const actual = mask();
      // Historical native23 tight256 reconstruction, not startup publication.
      expect(actual.width).toBe(256);
      let before: typeof actual, core: typeof actual;
      const withoutLobeMasks: Array<typeof actual> = [];
      try {
        stored.splice(
          0,
          stored.length,
          ...preBankForecourt.map((path, index) => ({
            ...current[index],
            ...path,
            path: path.path.map((point) => ({ ...point })),
          })),
        );
        expect(
          internal.calculateRoadMaskBounds(roads.getRoadSegmentsForGPU()),
        ).toEqual(bounds);
        before = mask();
        stored.splice(0, stored.length, ...current.slice(0, 21));
        core = mask();
        for (const lobe of lobes) {
          stored.splice(
            0,
            stored.length,
            ...current.filter((road) => road.id !== lobe.id),
          );
          withoutLobeMasks.push(mask());
        }
      } finally {
        stored.splice(0, stored.length, ...current);
        internal.buildTileCache();
      }
      const oldBank = preBankForecourt.filter((path) =>
        BANK_BLEND_BEFORE.has(path.id),
      );
      const inOldBank = (x: number, z: number) =>
        oldBank.some((path) =>
          path.path
            .slice(1)
            .some(
              (end, i) =>
                compactPathSegmentDistance({ x, z }, path.path[i], end) <=
                path.width / 2 + path.blendWidth!,
            ),
        );
      let changedTexels = 0,
        removedSupport = 0,
        recoveredGrassTexels = 0;
      for (let iz = 0; iz < 256; iz++)
        for (let ix = 0; ix < 256; ix++) {
          const index = iz * 256 + ix;
          const old = before.data[index],
            value = actual.data[index];
          const x =
            (ix / 256) * bounds.worldSize -
            bounds.worldSize / 2 +
            bounds.centerX;
          const z =
            (iz / 256) * bounds.worldSize -
            bounds.worldSize / 2 +
            bounds.centerZ;
          if (old !== value) {
            changedTexels++;
            expect(inOldBank(x, z), `bank-only changed texel ${ix},${iz}`).toBe(
              true,
            );
          }
          // No new support. Bilinear filtering has nonnegative weights, so
          // this also proves whole filtered support cannot grow at any point.
          if (value > 0) expect(old).toBeGreaterThan(0);
          expect(value).toBeLessThanOrEqual(old);
          expect(value).toBeGreaterThanOrEqual(core.data[index]);
          if (old > 0 && value === 0) removedSupport++;
          if (old > 0.8 && value <= 0.8) recoveredGrassTexels++;
        }
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const nx = -(b.z - a.z) / length,
        nz = (b.x - a.x) / length;
      const measured = lobes.map((lobe, lobeIndex) => {
        const others = selected.filter((path) => path.id !== lobe.id);
        let raised = 0,
          rasterRaised = 0,
          maxDelta = 0,
          maxRasterDelta = 0;
        for (let i = 1; i < lobe.path.length; i++) {
          const p = lobe.path[i - 1],
            q = lobe.path[i];
          for (const offset of [-0.4, 0, 0.4]) {
            const x = (p.x + q.x) / 2 + nx * offset;
            const z = (p.z + q.z) / 2 + nz * offset;
            const base = samplePaths(others, x, z);
            const value = roads.getRoadInfluenceAt(x, z);
            expect(value).toBe(Math.max(base, samplePaths([lobe], x, z)));
            expect(value > 0.8).toBe(base > 0.8);
            const delta = value - base;
            const rasterDelta =
              sampleLinearMask(actual.data, bounds, x, z) -
              sampleLinearMask(withoutLobeMasks[lobeIndex].data, bounds, x, z);
            if (delta > 0.01) raised++;
            if (rasterDelta > 0.01) rasterRaised++;
            maxDelta = Math.max(maxDelta, delta);
            maxRasterDelta = Math.max(maxRasterDelta, rasterDelta);
          }
        }
        return { id: lobe.id, raised, rasterRaised, maxDelta, maxRasterDelta };
      });
      let asymmetric = 0;
      for (let along = 0.1; along < 1; along += 0.1)
        for (const offset of [0.8, 1, 1.2, 1.4, 1.6, 1.8]) {
          const increments = [-1, 1].map((side) => {
            const x = a.x + (b.x - a.x) * along + nx * offset * side;
            const z = a.z + (b.z - a.z) * along + nz * offset * side;
            return (
              sampleLinearMask(actual.data, bounds, x, z) -
              sampleLinearMask(core.data, bounds, x, z)
            );
          });
          if (Math.abs(increments[0] - increments[1]) > 0.03) asymmetric++;
        }
      const segments = roads.getRoadSegmentsForGPU().length;
      process.stdout.write(
        "Bank forecourt: real256 bounded wear, not native/grass performance approval " +
          JSON.stringify({
            changedTexels,
            removedSupport,
            recoveredGrassTexels,
            measured,
            asymmetric,
            previousSegments: preBankForecourt.reduce(
              (sum, path) => sum + path.path.length - 1,
              0,
            ),
            segments,
            maskBytes: actual.data.byteLength,
            bounds,
          }) +
          "\n",
      );
      expect(changedTexels).toBeGreaterThan(0);
      expect(removedSupport).toBeGreaterThan(0);
      expect(recoveredGrassTexels).toBeGreaterThan(0);
      for (const row of measured) {
        expect(row.raised, row.id).toBeGreaterThan(0);
        expect(row.rasterRaised, row.id).toBeGreaterThan(0);
        expect(row.maxRasterDelta, row.id).toBeGreaterThan(0.03);
      }
      expect(asymmetric).toBeGreaterThan(0);
      expect(segments).toBeLessThanOrEqual(600);
      expect(actual.data.byteLength).toBe(262144);
    });
  });

  it("clears a real previously empty terrain segment cache on the actual roads-generated event without resident terrain tiles", async () => {
    await withRoads(
      (roads, terrain) => {
        expect(roads.getRoadInfluenceAt(348, 321)).toBe(1);
        expect(
          (
            terrain as unknown as TerrainInternals
          ).calculateRoadInfluenceAtVertex(348, 321, 3, 3),
        ).toBe(1);
      },
      (_, terrain) => {
        const internal = terrain as unknown as TerrainInternals;
        internal.subscribeRoadNetworkEvents();
        expect(internal.calculateRoadInfluenceAtVertex(348, 321, 3, 3)).toBe(0);
      },
    );
  });

  it("replaces the three native10 hooks with tangent-continuous arrivals, actual stone contact and localized analytical/256-mask deltas", async () => {
    await withNative23MeadowRoads((roads, terrain) => {
      const {
        preBankForecourt: selected,
        previous,
        beforeEntries,
        hooked,
      } = selectedAndPrevious(terrain);
      const entries = selected.flatMap((path) =>
        (path.platformEntries ?? []).map((entry) => ({
          ...entry,
          pathId: path.id,
          width: path.width,
        })),
      );
      expect(previous.every((path) => path.platformEntries === undefined)).toBe(
        true,
      );
      expect(
        entries.map(({ pathId, floorId, endpoint, to, supportRadius }) => [
          pathId,
          floorId,
          endpoint,
          to,
          Number(supportRadius.toFixed(12)),
        ]),
      ).toEqual([
        [
          "compact-path-bank-lobby",
          "duel_lobby_floor",
          "end",
          { x: 385, z: 368.5 },
          1.6,
        ],
        [
          "compact-path-lobby-arena",
          "duel_lobby_floor",
          "start",
          { x: 385, z: 383.5 },
          1.6,
        ],
        [
          "compact-path-lobby-arena",
          "duel_arena_floor_1",
          "end",
          { x: 350, z: 395 },
          1.6,
        ],
      ]);
      const internal = roads as unknown as RoadInternals;
      const bounds = internal.calculateRoadMaskBounds(
        roads.getRoadSegmentsForGPU(),
      );
      let selectedMask: NonNullable<
        ReturnType<RoadNetworkSystem["generateRoadInfluenceTexture"]>
      >;
      const stored = roads.getRoads(),
        current = stored.slice();
      let beforeMask: NonNullable<
        ReturnType<RoadNetworkSystem["generateRoadInfluenceTexture"]>
      >;
      try {
        stored.splice(
          0,
          stored.length,
          ...selected.map((path, index) => ({
            ...current[index],
            ...path,
            path: path.path.map((point) => ({ ...point })),
          })),
        );
        selectedMask = roads.generateRoadInfluenceTexture(
          256,
          bounds.worldSize,
          0.5,
          bounds.centerX,
          bounds.centerZ,
        )!;
        stored.splice(
          0,
          stored.length,
          ...hooked.map((path, index) => ({
            ...current[index],
            width: path.width,
            blendWidth: path.blendWidth,
            path: path.path.map((point) => ({ ...point })),
            length: path.length,
          })),
        );
        // Align both rasters to the new bounds. Tight production mask bounds
        // legitimately change, so comparing unrelated texel phases is invalid.
        beforeMask = roads.generateRoadInfluenceTexture(
          256,
          bounds.worldSize,
          0.5,
          bounds.centerX,
          bounds.centerZ,
        )!;
      } finally {
        stored.splice(0, stored.length, ...current);
        internal.buildTileCache();
      }
      const pixel = bounds.worldSize / 256;
      let addedSupport = 0,
        removedSupport = 0,
        changed = 0;
      for (let iz = 0; iz < 256; iz++)
        for (let ix = 0; ix < 256; ix++) {
          const index = iz * 256 + ix;
          const before = beforeMask.data[index],
            after = selectedMask.data[index];
          const x = ix * pixel - bounds.worldSize / 2 + bounds.centerX;
          const z = iz * pixel - bounds.worldSize / 2 + bounds.centerZ;
          if (after !== before) {
            changed++;
            expect(
              containsEntry(selected, x, z),
              `changed texel ${ix},${iz}`,
            ).toBe(true);
          }
          if (before === 0 && after > 0) addedSupport++;
          if (before > 0 && after === 0) removedSupport++;
          if (!containsEntry(selected, x, z)) expect(after).toBe(before);
        }
      expect(addedSupport).toBeGreaterThan(0);
      expect(removedSupport).toBeGreaterThan(0);
      expect(changed).toBeGreaterThan(addedSupport);

      const angle = (
        a: { x: number; z: number },
        b: { x: number; z: number },
      ) =>
        (Math.acos(
          Math.max(
            -1,
            Math.min(
              1,
              (a.x * b.x + a.z * b.z) /
                (Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z)),
            ),
          ),
        ) *
          180) /
        Math.PI;
      const measurements: unknown[] = [];
      for (const entry of entries) {
        const route = selected.find((path) => path.id === entry.pathId)!;
        const oriented =
          entry.endpoint === "start" ? [...route.path].reverse() : route.path;
        const splice = oriented.findIndex(
          (p) => p.x === entry.from.x && p.z === entry.from.z,
        );
        expect(splice).toBeGreaterThan(0);
        const retained = oriented[splice - 1];
        const approach = entry.approach;
        const incoming = {
          x: entry.from.x - retained.x,
          z: entry.from.z - retained.z,
        };
        const vectors = approach.slice(1).map((point, i) => ({
          x: point.x - approach[i].x,
          z: point.z - approach[i].z,
        }));
        const spliceAngle = angle(incoming, vectors[0]);
        const arrivalAngle = angle(vectors.at(-1)!, {
          x: 0,
          z: entry.endpoint === "start" ? -1 : 1,
        });
        const turns = vectors
          .slice(1)
          .map((vector, i) => angle(vectors[i], vector));
        const maxTurn = Math.max(...turns);
        expect(
          spliceAngle,
          `${entry.pathId} ${entry.endpoint} splice`,
        ).toBeLessThan(5);
        expect(
          arrivalAngle,
          `${entry.pathId} ${entry.endpoint} arrival`,
        ).toBeLessThan(5);
        expect(maxTurn, `${entry.pathId} ${entry.endpoint} turn`).toBeLessThan(
          15,
        );
        // No hairpin/reversal: every segment must make progress toward stone.
        const chord = {
          x: entry.to.x - entry.from.x,
          z: entry.to.z - entry.from.z,
        };
        for (const v of vectors)
          expect(v.x * chord.x + v.z * chord.z).toBeGreaterThan(0);
        const oldTail = entry.previousApproach.slice(0, -1);
        const replacedLength = oldTail
          .slice(1)
          .reduce(
            (sum, point, i) =>
              sum + Math.hypot(point.x - oldTail[i].x, point.z - oldTail[i].z),
            0,
          );
        expect(replacedLength).toBeGreaterThanOrEqual(10);
        expect(replacedLength).toBeLessThanOrEqual(11);
        const previousVectors = entry.previousApproach
          .slice(1)
          .map((point, i) => ({
            x: point.x - entry.previousApproach[i].x,
            z: point.z - entry.previousApproach[i].z,
          }));
        const previousMaxTurn = Math.max(
          ...previousVectors
            .slice(1)
            .map((v, i) => angle(previousVectors[i], v)),
        );
        expect(maxTurn).toBeLessThan(previousMaxTurn / 2);
        measurements.push({
          pathId: entry.pathId,
          endpoint: entry.endpoint,
          from: entry.from,
          to: entry.to,
          replacedLength,
          spliceAngle,
          arrivalAngle,
          maxTurn,
          previousMaxTurn,
          samples: approach.length,
        });
      }

      const world = new World();
      const visuals = new DuelArenaVisualsSystem(world);
      const build = visuals as unknown as {
        arenaCfg: ReturnType<typeof getDuelArenaConfig>;
        arenaGroup: THREE.Group;
        createSharedMaterials(): void;
        createArenaFloors(): void;
        createLobbyFloor(): void;
      };
      try {
        build.arenaCfg = getDuelArenaConfig();
        build.arenaGroup = new THREE.Group();
        world.stage.scene.add(build.arenaGroup);
        build.createSharedMaterials();
        build.createArenaFloors();
        build.createLobbyFloor();
        for (const entry of entries) {
          const floor = build.arenaGroup.getObjectByName(
            entry.floorId === "duel_lobby_floor"
              ? "LobbyFloor"
              : "ArenaFloor_1",
          );
          if (!(floor instanceof THREE.Mesh) || Array.isArray(floor.material))
            throw new Error("Expected actual single-material platform mesh");
          const stone = new THREE.Box3().setFromObject(floor);
          expect(floor.material.transparent).toBe(false);
          expect(floor.material.depthTest).toBe(true);
          expect(floor.material.depthWrite).toBe(true);
          expect(
            stone.containsPoint(
              new THREE.Vector3(entry.to.x, floor.position.y, entry.to.z),
            ),
          ).toBe(true);
          const edgeZ = entry.endpoint === "start" ? stone.max.z : stone.min.z;
          expect(Math.abs(entry.to.z - edgeZ)).toBe(0.5);
          expect(terrain.getHeightAt(entry.to.x, entry.to.z)).toBeLessThan(
            stone.max.y,
          );
          const beforeEdge =
            edgeZ + (entry.endpoint === "start" ? 0.05 : -0.05);
          expect(samplePaths(beforeEntries, entry.to.x, beforeEdge)).toBe(0);
          expect(roads.getRoadInfluenceAt(entry.to.x, beforeEdge)).toBe(1);
          // Sweep actual curved segments and their perpendicular core lanes.
          // A chord-only test would miss new gaps or a malformed arrival curve.
          for (let index = 1; index < entry.approach.length; index++) {
            const a = entry.approach[index - 1],
              b = entry.approach[index];
            const length = Math.hypot(b.x - a.x, b.z - a.z);
            for (const t of [0, 0.25, 0.5, 0.75, 1])
              for (const offset of [-entry.width / 4, 0, entry.width / 4]) {
                const x =
                  a.x + (b.x - a.x) * t - ((b.z - a.z) * offset) / length;
                const z =
                  a.z + (b.z - a.z) * t + ((b.x - a.x) * offset) / length;
                expect(roads.getRoadInfluenceAt(x, z)).toBe(1);
                expect(
                  sampleLinearMask(selectedMask.data, bounds, x, z),
                  `${entry.pathId} ${entry.endpoint} linear core ${index},${t},${offset}`,
                ).toBeGreaterThan(0.8);
              }
          }
          // Exterior sweep compares against actual previous straight-stub
          // semantics; both removal and addition are legitimate inside the
          // declared old/new capsule union, with exact equality outside it.
          for (
            let z = Math.min(entry.from.z, entry.to.z) - 4;
            z <= Math.max(entry.from.z, entry.to.z) + 4;
            z += 0.25
          ) {
            for (
              let x = Math.min(entry.from.x, entry.to.x) - 4;
              x <= Math.max(entry.from.x, entry.to.x) + 4;
              x += 0.25
            ) {
              if (!containsEntry(selected, x, z))
                expect(samplePaths(selected, x, z)).toBe(
                  samplePaths(hooked, x, z),
                );
            }
          }
        }
      } finally {
        visuals.destroy();
        world.destroy();
      }
      const segments = roads.getRoadSegmentsForGPU().length;
      expect(hooked.reduce((sum, path) => sum + path.path.length - 1, 0)).toBe(
        515,
      );
      expect(segments).toBeLessThanOrEqual(600);
      expect(selectedMask.data.byteLength).toBe(256 * 256 * 4);
      process.stdout.write(
        "Meadow platform entries: analytical/mask receipt, not native approval " +
          JSON.stringify({
            entries: entries.length,
            changed,
            addedSupport,
            removedSupport,
            previousSegments: 515,
            segments,
            measurements,
            maskBytes: selectedMask.data.byteLength,
            bounds,
          }) +
          "\n",
      );
    });
  });

  it("retains the historical arrival shoulders inside their core support without expanding full grass exclusion", async () => {
    await withNative23MeadowRoads((roads, terrain) => {
      const { selected } = selectedAndPrevious(terrain);
      const withoutShoulders = selected.filter(
        (path) => !path.id.endsWith("-arrival"),
      );
      const shoulders = selected.filter((path) => path.id.endsWith("-arrival"));
      expect(shoulders.map((path) => path.id)).toEqual([
        "compact-wear-bank-lobby-end-arrival",
        "compact-wear-lobby-arena-start-arrival",
        "compact-wear-lobby-arena-end-arrival",
      ]);
      const measurements: Array<{
        id: string;
        length: number;
        raised: number;
        maxIncrease: number;
        segments: number;
      }> = [];
      for (const shoulder of shoulders) {
        expect(shoulder.maxInfluence).toBe(0.76);
        expect(shoulder.length).toBeGreaterThanOrEqual(2.5);
        expect(shoulder.length).toBeLessThanOrEqual(3.25);
        const entry = selected
          .flatMap((path) => path.platformEntries ?? [])
          .find(
            (entry) =>
              entry.to.x === shoulder.path.at(-1)!.x &&
              entry.to.z === shoulder.path.at(-1)!.z,
          )!;
        expect(shoulder.width / 2 + shoulder.blendWidth!).toBe(
          entry.supportRadius,
        );
        for (let i = 1; i < shoulder.path.length; i++) {
          const a = shoulder.path[i - 1],
            b = shoulder.path[i];
          expect(
            entry.approach
              .slice(1)
              .some(
                (end, j) =>
                  a.x === entry.approach[j].x &&
                  a.z === entry.approach[j].z &&
                  b.x === end.x &&
                  b.z === end.z,
              ),
          ).toBe(true);
        }
        let raised = 0,
          maxIncrease = 0;
        for (let i = 1; i < entry.approach.length; i++) {
          const a = entry.approach[i - 1],
            b = entry.approach[i];
          const length = Math.hypot(b.x - a.x, b.z - a.z);
          for (let offset = -1.8; offset <= 1.8; offset += 0.05) {
            const x = (a.x + b.x) / 2 - ((b.z - a.z) * offset) / length;
            const z = (a.z + b.z) / 2 + ((b.x - a.x) * offset) / length;
            const before = samplePaths(withoutShoulders, x, z);
            const after = roads.getRoadInfluenceAt(x, z);
            expect(after).toBeGreaterThanOrEqual(before);
            expect(after > 0).toBe(before > 0);
            expect(after > 0.8).toBe(before > 0.8);
            if (after - before > 0.02) raised++;
            maxIncrease = Math.max(maxIncrease, after - before);
          }
        }
        expect(raised).toBeGreaterThan(20);
        expect(maxIncrease).toBeGreaterThan(0.1);
        expect(samplePaths(shoulders, entry.from.x, entry.from.z)).toBe(0);
        measurements.push({
          id: shoulder.id,
          length: shoulder.length,
          raised,
          maxIncrease,
          segments: shoulder.path.length - 1,
        });
      }
      process.stdout.write(
        "Arrival shoulders: actual scalar field, not native width approval " +
          JSON.stringify(measurements) +
          "\n",
      );
    });
  });

  it("rejects water and non-finite ground introduced only inside a new platform entry", async () => {
    await withMeadowRoads((_, terrain) => {
      const profile = DataManager.getWorldTerrainProfile();
      const areas = DataManager.getInstance().getAllWorldAreas();
      const invalid = structuredClone(areas);
      invalid.duel_arena.waterBodies = [
        ...(invalid.duel_arena.waterBodies ?? []),
        {
          ...invalid.haven_pond.waterBodies![0],
          id: "entry-keepout",
          centerX: 385,
          centerZ: 368.5,
          radius: 0.1,
        },
      ];
      expect(() =>
        createCompactIslandPaths(
          profile,
          invalid,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
        ),
      ).toThrow("Compact platform entry would paint water");
      expect(() =>
        createCompactIslandPaths(
          profile,
          areas,
          getDuelArenaConfig(),
          (x, z) =>
            x === 385 && z === 368.5 ? NaN : terrain.getHeightAt(x, z),
        ),
      ).toThrow("Compact platform entry leaves dry admitted terrain");
    });
  });

  it.each(pathFixtures)(
    "$name current production mask keeps strict water/unrelated-floor bilinear support, analytical lodge exclusion and declared stone underlap",
    async ({ run }) => {
      await run((roads, terrain) => {
        const segments = roads.getRoadSegmentsForGPU();
        const authored = roads["calculateAuthoredRoadMaskBounds"](segments);
        const bounds = authored ?? roads["calculateRoadMaskBounds"](segments);
        const resolution = authored ? 512 : 256;
        expect(
          (roads as unknown as RoadInternals).calculateRoadMaskTextureSize(
            bounds.worldSize,
          ),
        ).toBe(resolution);
        const mask = roads.generateRoadInfluenceTexture(
          resolution,
          bounds.worldSize,
          0.5,
          bounds.centerX,
          bounds.centerZ,
        )!;
        expect(mask).toEqual(roads.getRoadInfluenceTextureData());
        expect(mask.width).toBe(resolution);
        expect(mask.height).toBe(resolution);
        expect(mask.data.byteLength).toBe(resolution * resolution * 4);
        const pixel = bounds.worldSize / resolution;
        const areas = DataManager.getInstance().getAllWorldAreas();
        const floors = createDuelArenaFloorZones(
          getDuelArenaConfig(),
          getDuelArenaGradeHeight(areas),
        );
        const paths = createCompactIslandPaths(
          DataManager.getWorldTerrainProfile(),
          areas,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
        );
        const entries = paths.flatMap((path) => path.platformEntries ?? []);
        const touched = new Set<string>();
        const lodge = getCompactPreparationLodgeFootprint(
          COMPACT_PREPARATION_LODGE,
          false,
        );
        for (const path of paths)
          for (let index = 1; index < path.path.length; index++)
            expect(
              compactPathIntersectsBounds(
                path.path[index - 1],
                path.path[index],
                lodge,
                path.width / 2 + (path.blendWidth ?? 0.5),
              ),
              `${path.id} analytical lodge keep-out ${index}`,
            ).toBe(false);
        const knots = (minimum: number, maximum: number, center: number) => [
          minimum,
          maximum,
          ...Array.from(
            { length: resolution },
            (_, index) => (index + 0.5) * pixel - bounds.worldSize / 2 + center,
          ).filter((value) => value > minimum && value < maximum),
        ];
        let lodgeMaximum = 0;
        let lodgeMaximumAt = { x: 0, z: 0 };
        // A bilinear patch reaches its rectangular-domain maximum at a corner.
        // Include every filter knot and both footprint boundaries, so this is
        // the complete piecewise-bilinear maximum, not a sparse point estimate.
        for (const x of knots(lodge.minX, lodge.maxX, bounds.centerX))
          for (const z of knots(lodge.minZ, lodge.maxZ, bounds.centerZ)) {
            const value = sampleLinearMask(mask.data, bounds, x, z);
            if (value > lodgeMaximum) {
              lodgeMaximum = value;
              lodgeMaximumAt = { x, z };
            }
          }
        // Keep the existing one-millionth meadow tolerance; never increase it
        // for a new raster. Historical tight256 measured7.815638770178923e-7;
        // this test now evaluates the ENTIRE currently published lattice.
        // Baseline and analytical exclusion remain exact zero.
        const lodgeRasterTolerance = entries.length ? 1e-6 : 0;
        expect(lodgeMaximum).toBeLessThanOrEqual(lodgeRasterTolerance);
        process.stdout.write(
          "Full lodge bilinear maximum " +
            JSON.stringify({
              entries: entries.length,
              resolution,
              bounds,
              lodgeMaximum,
              lodgeMaximumAt,
            }) +
            "\n",
        );
        for (let iz = 0; iz < resolution; iz++)
          for (let ix = 0; ix < resolution; ix++) {
            if (mask.data[iz * resolution + ix] === 0) continue;
            const x = ix * pixel - bounds.worldSize / 2 + bounds.centerX;
            const z = iz * pixel - bounds.worldSize / 2 + bounds.centerZ;
            // Existing kernel samples texel-index/N; linear sampler texel centers are
            // (index+.5)/N and each nonzero texel has a one-pixel support radius.
            const support = {
              minX: x - 0.5 * pixel,
              maxX: x + 1.5 * pixel,
              minZ: z - 0.5 * pixel,
              maxZ: z + 1.5 * pixel,
            };
            for (const floor of floors) {
              const overlap =
                support.maxX > floor.centerX - floor.width / 2 &&
                support.minX < floor.centerX + floor.width / 2 &&
                support.maxZ > floor.centerZ - floor.depth / 2 &&
                support.minZ < floor.centerZ + floor.depth / 2;
              if (overlap) {
                touched.add(floor.id);
                // Bound the entire nonzero texel's bilinear support, including
                // the index/N raster's asymmetric half-pixel center shift.
                expect(
                  entries.some(
                    (entry) =>
                      entry.floorId === floor.id &&
                      entry.approach.slice(1).some((b, i) => {
                        const a = entry.approach[i];
                        return (
                          compactPathSegmentDistance({ x, z }, a, b) <
                            entry.supportRadius &&
                          support.minX >=
                            Math.min(a.x, b.x) -
                              entry.supportRadius -
                              0.5 * pixel &&
                          support.maxX <=
                            Math.max(a.x, b.x) +
                              entry.supportRadius +
                              1.5 * pixel &&
                          support.minZ >=
                            Math.min(a.z, b.z) -
                              entry.supportRadius -
                              0.5 * pixel &&
                          support.maxZ <=
                            Math.max(a.z, b.z) +
                              entry.supportRadius +
                              1.5 * pixel
                        );
                      }),
                  ),
                  `${floor.id} allowed entry support ${ix},${iz}`,
                ).toBe(true);
              }
            }
            const overlapsLodge =
              support.maxX > lodge.minX &&
              support.minX < lodge.maxX &&
              support.maxZ > lodge.minZ &&
              support.minZ < lodge.maxZ;
            if (lodgeRasterTolerance === 0)
              expect(
                overlapsLodge,
                `baseline lodge mask support ${ix},${iz}`,
              ).toBe(false);
            for (const water of Object.values(areas).flatMap(
              (area) => area.waterBodies ?? [],
            )) {
              const dx = Math.max(
                support.minX - water.centerX,
                0,
                water.centerX - support.maxX,
              );
              const dz = Math.max(
                support.minZ - water.centerZ,
                0,
                water.centerZ - support.maxZ,
              );
              expect(Math.hypot(dx, dz)).toBeGreaterThan(water.radius);
            }
          }
        expect([...touched].sort()).toEqual(
          entries.length ? ["duel_arena_floor_1", "duel_lobby_floor"] : [],
        );
        for (const floor of floors)
          expect(
            sampleLinearMask(mask.data, bounds, floor.centerX, floor.centerZ),
          ).toBe(0);
      });
    },
  );
  it.each(pathFixtures)(
    "$name keeps actual terrain point/batch and regional worker candidates consistent at every path and blend edge",
    async ({ run }) => {
      await run((roads, terrain) => {
        const internal = terrain as unknown as TerrainInternals;
        // Execute the actual emitted worker's road calculator, with only its
        // browser message-host supplied. No replacement influence algorithm.
        const grassSample = new Function(
          "self",
          `${GRASS_WORKER_CODE}\nreturn calculateRoadInfluence;`,
        )({}) as (
          x: number,
          z: number,
          segments: ReturnType<RoadNetworkSystem["getRoadSegmentsForGPU"]>,
          blend: number,
        ) => number;
        for (const road of roads.getRoads())
          for (let i = 1; i < road.path.length; i++) {
            const a = road.path[i - 1],
              b = road.path[i],
              length = Math.hypot(b.x - a.x, b.z - a.z);
            if (length === 0) continue;
            for (const distance of [
              0,
              road.width / 2,
              road.width / 2 + (road.blendWidth ?? 0.5) / 2,
              road.width / 2 + (road.blendWidth ?? 0.5) + 0.1,
            ]) {
              for (const offset of distance === 0
                ? [0]
                : [-distance, distance]) {
                const x = (a.x + b.x) / 2 - ((b.z - a.z) / length) * offset;
                const z = (a.z + b.z) / 2 + ((b.x - a.x) / length) * offset;
                const tx = Math.floor(x / 100),
                  tz = Math.floor(z / 100),
                  expected = roads.getRoadInfluenceAt(x, z);
                expect(
                  internal.calculateRoadInfluenceAtVertex(x, z, tx, tz),
                ).toBeCloseTo(expected, 10);
                const vertices = new Float32Array([x - tx * 100, z - tz * 100]);
                const batch = internal.computeRoadInfluenceBatchCPU(
                  vertices,
                  tx,
                  tz,
                  roads.getRoadSegmentsForTile(tx, tz),
                );
                expect(batch[0]).toBeCloseTo(
                  roads.getRoadInfluenceAt(
                    vertices[0] + tx * 100,
                    vertices[1] + tz * 100,
                  ),
                  6,
                );
                const candidates = internal.getWorldSpaceRoadSegmentsForRegion(
                  x - 0.25,
                  z - 0.25,
                  x + 0.25,
                  z + 0.25,
                );
                const regionValue = candidates.reduce(
                  (value, s) =>
                    Math.max(
                      value,
                      roadSegmentInfluence(
                        x,
                        z,
                        s.startX,
                        s.startZ,
                        s.endX,
                        s.endZ,
                        s.width,
                        s.blendWidth ?? 0.5,
                        s.maxInfluence ?? 1,
                      ),
                    ),
                  0,
                );
                expect(regionValue).toBeCloseTo(expected, 10);
                expect(grassSample(x, z, candidates, 0.5)).toBeCloseTo(
                  expected,
                  10,
                );
                expect(grassSample(x, z, candidates, 0.5) > 0.8).toBe(
                  expected > 0.8,
                );
              }
            }
          }
      });
    },
  );

  it("retains real segment influence across positive and negative tile boundaries even when centerline stops short", async () => {
    await withRoads((roads, terrain) => {
      const stored = roads.getRoads(),
        exemplar = { ...stored[0] };
      // These remain ordinary absent-profile boundary fixtures, irrespective
      // of the new explicit fade selected by the current v6 exemplar.
      delete exemplar.blendWidth;
      delete exemplar.maxInfluence;
      stored.splice(
        0,
        stored.length,
        ...[300, 400, -100].map((boundary, index) => ({
          ...exemplar,
          id: "boundary-data-" + index,
          width: index === 1 ? 2.2 : 1.5,
          path: [
            { x: 398, z: boundary - 5, y: 28 },
            { x: 399.5, z: boundary - 0.4, y: 28 },
          ],
        })),
      );
      (roads as unknown as RoadInternals).buildTileCache();
      const internal = terrain as unknown as TerrainInternals;
      for (const boundary of [300, 400, -100])
        for (const x of [399.5, 400, 400.25])
          for (const z of [boundary - 0.25, boundary, boundary + 0.25]) {
            const tx = Math.floor(x / 100),
              tz = Math.floor(z / 100),
              expected = roads.getRoadInfluenceAt(x, z);
            expect(expected).toBeGreaterThan(0);
            expect(
              internal.calculateRoadInfluenceAtVertex(x, z, tx, tz),
            ).toBeCloseTo(expected, 10);
            const segments = internal.getWorldSpaceRoadSegmentsForRegion(
              x,
              z,
              x,
              z,
            );
            expect(
              segments.reduce(
                (value, s) =>
                  Math.max(
                    value,
                    roadSegmentInfluence(
                      x,
                      z,
                      s.startX,
                      s.startZ,
                      s.endX,
                      s.endZ,
                      s.width,
                      0.5,
                    ),
                  ),
                0,
              ),
            ).toBeCloseTo(expected, 10);
          }
    });
  });
  it("retains explicit wide fades through ordinary halos and the bounded far-halo fallback", async () => {
    await withRoads((roads, terrain) => {
      const stored = roads.getRoads();
      const exemplar = stored[0];
      stored.splice(0, stored.length, {
        ...exemplar,
        id: "wide-partial-test",
        width: 1,
        blendWidth: 1000,
        maxInfluence: 0.55,
        path: [
          { x: -1, z: -10, y: 28 },
          { x: -1, z: 10, y: 28 },
        ],
      });
      (roads as unknown as RoadInternals).buildTileCache();
      const internal = terrain as unknown as TerrainInternals;
      for (const x of [-900, -100, 100, 900]) {
        const expected = roadSegmentInfluence(
          x,
          0,
          -1,
          -10,
          -1,
          10,
          1,
          1000,
          0.55,
        );
        expect(expected).toBeGreaterThan(0);
        expect(roads.getRoadInfluenceAt(x, 0)).toBe(expected);
        expect(
          internal.calculateRoadInfluenceAtVertex(x, 0, Math.floor(x / 100), 0),
        ).toBeCloseTo(expected, 12);
        const candidates = internal.getWorldSpaceRoadSegmentsForRegion(
          x,
          0,
          x,
          0,
        );
        expect(
          candidates.some(
            (s) => s.blendWidth === 1000 && s.maxInfluence === 0.55,
          ),
        ).toBe(true);
      }
    });
  });

  it("keeps connected partial wear while reducing the saturated workshop footprint inside unchanged support", async () => {
    await withRoads((roads) => {
      const all = roads.getRoads();
      const original = all.slice(0, 11);
      const wear = all.slice(11);
      const previous = previousCoreRecipe(all);
      expect(
        wear.map((r) => [r.id, r.width, r.blendWidth, r.maxInfluence]),
      ).toEqual([
        ["compact-wear-workshop-south", 0.65, 1.5, 0.6],
        ["compact-wear-workshop-west", 0.7, 1.25, 0.55],
        ["compact-wear-supplier-north", 0.45, 1.4, 0.5],
      ]);
      const sample = (list: typeof all, x: number, z: number) =>
        list.reduce(
          (peak, road) =>
            road.path.slice(1).reduce((value, b, i) => {
              const a = road.path[i];
              return Math.max(
                value,
                roadSegmentInfluence(
                  x,
                  z,
                  a.x,
                  a.z,
                  b.x,
                  b.z,
                  road.width,
                  road.blendWidth ?? 0.5,
                  road.maxInfluence ?? 1,
                ),
              );
            }, peak),
          0,
        );
      for (const path of wear) {
        expect(
          sample(previous.slice(0, 11), path.path[0].x, path.path[0].z),
        ).toBe(1);
        expect(
          sample(original, path.path[0].x, path.path[0].z),
        ).toBeGreaterThan(0);
        const gpu = roads
          .getRoadSegmentsForGPU()
          .filter((s) => s.maxInfluence === path.maxInfluence);
        expect(gpu).toHaveLength(path.path.length - 1);
        expect(gpu.every((s) => s.blendWidth === path.blendWidth)).toBe(true);
      }
      let addedSupport = 0,
        previousSaturated = 0,
        currentSaturated = 0;
      for (let x = 330; x <= 342; x += 0.125)
        for (let z = 328; z <= 340; z += 0.125) {
          const core = sample(original, x, z);
          const skirt = sample(wear, x, z);
          const current = roads.getRoadInfluenceAt(x, z);
          const before = sample(previous, x, z);
          expect(current).toBe(Math.max(core, skirt));
          expect(current > 0.8).toBe(core > 0.8);
          expect(current).toBeLessThanOrEqual(before);
          expect(current > 0).toBe(before > 0);
          if (before > 0.8) previousSaturated++;
          if (current > 0.8) currentSaturated++;
          if (core === 0 && current > 0) addedSupport++;
        }
      expect(addedSupport).toBeGreaterThan(100);
      expect(currentSaturated).toBeGreaterThan(0);
      expect(currentSaturated).toBeLessThan(previousSaturated);
      process.stdout.write(
        "Workshop analytical >.8 footprint at .125m spacing (not rendered canopy) " +
          JSON.stringify({
            previousSaturated,
            currentSaturated,
            addedSupport,
          }) +
          "\n",
      );
    });
  });

  it("generates a bounded curved immutable network from admitted subjects without towns or changing terrain", async () => {
    await withRoads((roads, terrain) => {
      expect(DataManager.getInstance().isReady()).toBe(true);
      const areas = DataManager.getInstance().getAllWorldAreas(),
        profile = DataManager.getWorldTerrainProfile();
      const before = JSON.stringify(areas);
      const paths = createCompactIslandPaths(
        profile,
        areas,
        getDuelArenaConfig(),
        (x, z) => terrain.getHeightAt(x, z),
      );
      expect(paths).toHaveLength(14);
      // Actual compact-natural-paths-art01/natural-paths.json SHA256
      // 60ca43d296e1f9c37436bebed78750646b2c09c3c366953dfcc9b09c898e5390.
      // This pin uses only its pre-change IDs, XZ samples and lengths, never
      // candidate widths or new output. Heights remain independently checked.
      expect(
        createHash("sha256")
          .update(
            JSON.stringify(
              paths.map((path) => [
                path.id,
                path.path.map((point) => [point.x, point.z]),
                path.length,
              ]),
            ),
          )
          .digest("hex"),
      ).toBe(
        "56baadca901dbbcfa744826dc996da4b792a104395cd5fb030589003f698564a",
      );
      expect(roads.getRoads()).toHaveLength(14);
      expect(roads.getRoadNetwork()?.towns).toEqual([]);
      expect(roads.getRoadNetwork()?.roads).toHaveLength(14);
      expect(roads.getDependencies().required).toEqual(["terrain"]);
      expect(JSON.stringify(areas)).toBe(before);
      expect(Object.isFrozen(paths)).toBe(true);
      for (const path of paths) {
        expect(Object.isFrozen(path)).toBe(true);
        expect(Object.isFrozen(path.path)).toBe(true);
        expect(path.path.length).toBeGreaterThan(1);
        expect(path.path.length).toBeLessThanOrEqual(256);
        expect(path.width).toBeGreaterThanOrEqual(0.45);
        expect(path.width).toBeLessThanOrEqual(4);
        expect(path.length).toBeLessThan(80);
        for (let i = 0; i < path.path.length; i++) {
          const p = path.path[i];
          expect(Object.isFrozen(p)).toBe(true);
          expect(p.y).toBe(terrain.getHeightAt(p.x, p.z));
          if (i)
            expect(
              Math.hypot(p.x - path.path[i - 1].x, p.z - path.path[i - 1].z),
            ).toBeLessThanOrEqual(1.000001);
        }
      }
      // Preserve the original centerline roles and complete width-plus-blend
      // support, while explicitly qualifying the narrower current paint cores.
      for (const path of paths.slice(0, 6)) {
        expect(path.id).toMatch(/^compact-path-/);
        expect(path.path.length).toBeGreaterThan(8);
        expect(path.width).toBeLessThanOrEqual(2.2);
      }
      for (const [index, path] of paths.slice(0, 11).entries()) {
        expect(path.path.length).toBeGreaterThan(7);
        const [id, previousWidth, width, blend] = CORE_RECIPE[index];
        expect([path.id, path.width, path.blendWidth]).toEqual([
          id,
          width,
          blend,
        ]);
        expect(path.width).toBeLessThan(previousWidth);
        expect(path.width / 2 + path.blendWidth!).toBe(previousWidth / 2 + 0.5);
        expect(Object.prototype.hasOwnProperty.call(path, "blendWidth")).toBe(
          true,
        );
        expect(Object.prototype.hasOwnProperty.call(path, "maxInfluence")).toBe(
          false,
        );
      }
      expect(paths.slice(6, 11).map((path) => path.id)).toEqual([
        "compact-clearing-bank-apron",
        "compact-clearing-bank-clerk-approach",
        "compact-clearing-bank-shopkeeper-approach",
        "compact-clearing-workshop-apron",
        "compact-clearing-workshop-supplier-approach",
      ]);
      const main = paths.find((p) => p.id === "compact-path-bank-lobby")!;
      expect(
        main.path.some(
          (p) =>
            compactPathSegmentDistance(p, main.path[0], main.path.at(-1)!) > 1,
        ),
      ).toBe(true);
      expect(
        paths.find((p) => p.id === "compact-path-pond-bank")?.path.at(-1),
      ).toEqual(main.path[0]);
      expect(main.toId).toBe(
        paths.find((p) => p.id === "compact-path-lobby-arena")?.fromId,
      );
    });
  });

  it("keeps every entire width-plus-blend segment outside water, lobby, hospital and the combat floor", async () => {
    await withRoads((roads) => {
      const areas = DataManager.getInstance().getAllWorldAreas();
      const floors = createDuelArenaFloorZones(
        getDuelArenaConfig(),
        getDuelArenaGradeHeight(areas),
      );
      let checked = 0;
      for (const road of roads.getRoads())
        for (let i = 1; i < road.path.length; i++) {
          const a = road.path[i - 1],
            b = road.path[i],
            padding =
              road.width / 2 + (road.blendWidth ?? COMPACT_PATH_BLEND_WIDTH);
          for (const floor of floors)
            expect(
              compactPathIntersectsBounds(
                a,
                b,
                {
                  minX: floor.centerX - floor.width / 2,
                  maxX: floor.centerX + floor.width / 2,
                  minZ: floor.centerZ - floor.depth / 2,
                  maxZ: floor.centerZ + floor.depth / 2,
                },
                padding,
              ),
            ).toBe(false);
          for (const water of Object.values(areas).flatMap(
            (area) => area.waterBodies ?? [],
          ))
            expect(
              compactPathSegmentDistance(
                { x: water.centerX, z: water.centerZ },
                a,
                b,
              ),
            ).toBeGreaterThan(water.radius + padding);
          checked++;
        }
      expect(checked).toBeGreaterThan(100);
      for (const floor of floors)
        expect(roads.getRoadInfluenceAt(floor.centerX, floor.centerZ)).toBe(0);
      expect(roads.getRoadInfluenceAt(343, 302)).toBe(0);
    });
  });

  it("retains legacy profile behavior and rejects missing compact admitted station geometry", async () => {
    await withRoads((_, terrain) => {
      const areas = DataManager.getInstance().getAllWorldAreas();
      expect(
        createCompactIslandPaths(
          COMPACT_WORLD_TERRAIN_PROFILE,
          areas,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
        ),
      ).toEqual([]);
      for (const profile of [
        SCULPTED_COMPACT_V2_PROFILE_FIXTURE,
        SCULPTED_COMPACT_V3_PROFILE_FIXTURE,
        SCULPTED_COMPACT_V4_PROFILE_FIXTURE,
      ]) {
        const historical = createCompactIslandPaths(
          profile,
          areas,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
        );
        expect(historical).toHaveLength(11);
        expect(historical.map((path) => [path.id, path.width])).toEqual(
          CORE_RECIPE.map(([id, previousWidth]) => [id, previousWidth]),
        );
        for (const path of historical) {
          expect(Object.prototype.hasOwnProperty.call(path, "blendWidth")).toBe(
            false,
          );
          expect(
            Object.prototype.hasOwnProperty.call(path, "maxInfluence"),
          ).toBe(false);
        }
      }
      const changed = structuredClone(areas);
      changed.central_haven.stations = [];
      expect(() =>
        createCompactIslandPaths(
          DataManager.getWorldTerrainProfile(),
          changed,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
        ),
      ).toThrow(/station/);
    });
  });

  it("retains exact actual256 support and mask bounds while lowering the former fourteen-path core field", async () => {
    await withRoads((roads) => {
      const internal = roads as unknown as RoadInternals;
      const stored = roads.getRoads(),
        current = stored.slice();
      const previous = previousCoreRecipe(current);
      const currentBounds = internal.calculateRoadMaskBounds(
        roads.getRoadSegmentsForGPU(),
      );
      const currentMask = roads.generateRoadInfluenceTexture(
        256,
        currentBounds.worldSize,
        0.5,
        currentBounds.centerX,
        currentBounds.centerZ,
      )!;
      let previousMask: typeof currentMask;
      try {
        stored.splice(0, stored.length, ...previous);
        const previousBounds = internal.calculateRoadMaskBounds(
          roads.getRoadSegmentsForGPU(),
        );
        expect(currentBounds).toEqual(previousBounds);
        expect(
          internal.calculateRoadMaskTextureSize(previousBounds.worldSize),
        ).toBe(256);
        previousMask = roads.generateRoadInfluenceTexture(
          256,
          previousBounds.worldSize,
          0.5,
          previousBounds.centerX,
          previousBounds.centerZ,
        )!;
      } finally {
        stored.splice(0, stored.length, ...current);
      }
      expect(currentMask.data.length).toBe(previousMask.data.length);
      let lowered = 0,
        recoveredFromSaturation = 0;
      for (let i = 0; i < currentMask.data.length; i++) {
        const before = previousMask.data[i],
          after = currentMask.data[i];
        expect(after, `texel ${i}`).toBeLessThanOrEqual(before);
        expect(after > 0, `texel ${i} support`).toBe(before > 0);
        if (after < before) lowered++;
        if (before > 0.8 && after <= 0.8) recoveredFromSaturation++;
      }
      expect(lowered).toBeGreaterThan(0);
      expect(recoveredFromSaturation).toBeGreaterThan(0);
      process.stdout.write(
        "Actual256 same-support core redistribution " +
          JSON.stringify({ lowered, recoveredFromSaturation }) +
          "\n",
      );
    });
  });

  it("uses translated tight mask bounds and matches every CPU texel to the same per-width world sampling contract", async () => {
    await withRoads((roads) => {
      const segments = roads.getRoadSegmentsForGPU();
      const bounds = (
        roads as unknown as RoadInternals
      ).calculateRoadMaskBounds(segments);
      expect(bounds.centerX).toBeGreaterThan(330);
      expect(bounds.centerZ).toBeGreaterThan(320);
      expect(bounds.worldSize).toBeLessThan(110);
      const mask = roads.generateRoadInfluenceTexture(
        64,
        bounds.worldSize,
        0.5,
        bounds.centerX,
        bounds.centerZ,
      )!;
      let nonzero = 0;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const wx =
            (x / 64) * bounds.worldSize - bounds.worldSize / 2 + bounds.centerX;
          const wz =
            (y / 64) * bounds.worldSize - bounds.worldSize / 2 + bounds.centerZ;
          expect(mask.data[y * 64 + x]).toBeCloseTo(
            roads.getRoadInfluenceAt(wx, wz),
            6,
          );
          if (mask.data[y * 64 + x] > 0) nonzero++;
        }
      expect(nonzero).toBeGreaterThan(100);
      expect(mask.centerX).toBe(bounds.centerX);
      expect(roads.generateRoadInfluenceTexture(64, 400)?.centerX).toBe(350);
      expect(roads.generateRoadInfluenceTexture(64, 400)?.centerZ).toBe(400);
    });
  });

  it("unions unequal widths instead of selecting only the nearest centerline, and keeps legacy equal-width math", async () => {
    await withRoads((roads) => {
      const originals = roads.getRoads().slice();
      roads.getRoads().splice(
        0,
        originals.length,
        ...[1, 6].map((width, index) => ({
          id: "width-test-" + index,
          fromType: "poi" as const,
          toType: "poi" as const,
          fromTownId: "",
          toTownId: "",
          width,
          material: "dirt" as const,
          length: 20,
          path: [
            { x: -10, y: 28, z: index * 3 },
            { x: 10, y: 28, z: index * 3 },
          ],
        })),
      );
      (roads as unknown as RoadInternals).buildTileCache();
      expect(roads.getRoadInfluenceAt(0, 1)).toBe(1);
      expect(roads.isOnRoad(0, 1)).toBe(true);
      expect(roadSegmentInfluence(0, 3.25, -10, 0, 10, 0, 6, 0.5)).toBe(0.5);
      expect(roadSegmentInfluence(0, 3.5, -10, 0, 10, 0, 6, 0.5)).toBe(0);
      expect(roadSegmentInfluence(0, 0, 0, 0, 0, 0, 6, 0.5)).toBe(1);
      const mask = roads.generateRoadInfluenceTexture(32, 32, 0.5, 0, 0)!;
      expect(mask.data[17 * 32 + 16]).toBe(1);
    });
  });
});

describe("bank pavilion admitted architecture and real path owners", () => {
  it("rejects simultaneous enclosed and open bank ownership before changing admitted configuration", () => {
    const before = DataManager.getWorldConfig();
    const identity = DataManager["worldContentIdentity"];
    DataManager["worldContentIdentity"] = null;
    try {
      expect(() =>
        DataManager.setWorldConfig({
          ...structuredClone(before!),
          compactPreparationLodge: structuredClone(COMPACT_PREPARATION_LODGE),
          compactBankPavilion: structuredClone(COMPACT_BANK_PAVILION),
        }),
      ).toThrow("both cannot own");
      expect(DataManager.getWorldConfig()).toBe(before);
    } finally {
      DataManager["worldContentIdentity"] = identity;
    }
  });

  it("routes through the retired lodge, clears real post footprints and leaves no enclosed building owner", async () => {
    const saved = {
      config: DataManager["worldConfig"],
      profile: DataManager["worldTerrainProfile"],
      identity: DataManager["worldContentIdentity"],
      haven: ALL_WORLD_AREAS.central_haven,
    };
    const world = new (class extends World {
      override get isServer() {
        return true;
      }
    })();
    try {
      const config = structuredClone(saved.config!);
      delete config.compactPreparationLodge;
      config.compactBankPavilion = structuredClone(COMPACT_BANK_PAVILION);
      const haven = structuredClone(saved.haven);
      haven.flatZones = haven.flatZones!.filter(
        (zone) => zone.id !== "central_haven_lodge_grass_clearance",
      );
      const clerk = haven.npcs!.find((npc) => npc.id === "bank_clerk")!;
      clerk.position.x = 352;
      clerk.position.z = 322;
      ALL_WORLD_AREAS.central_haven = haven;
      DataManager["worldContentIdentity"] = null;
      DataManager.setWorldConfig(config);
      expect(config.towns.townCount).toBe(0);
      expect(DataManager.getBuildingsManifest()?.towns).toEqual([]);
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      const roads = world.register(
        "roads",
        RoadNetworkSystem,
      ) as RoadNetworkSystem;
      const towns = world.register("towns", TownSystem) as TownSystem;
      await terrain.init();
      await roads.init();
      await towns.init();
      await roads.start();
      await towns.start();
      expect(towns.getCompactPreparationLodge()).toBeNull();
      expect(towns.getCollisionService().getBuildingCount()).toBe(0);
      expect(
        haven.flatZones.some(
          (zone) => zone.id === "central_haven_lodge_grass_clearance",
        ),
      ).toBe(false);
      const profile = DataManager.getWorldTerrainProfile();
      const paths = createCompactIslandPaths(
        profile,
        ALL_WORLD_AREAS,
        getDuelArenaConfig(),
        (x, z) => terrain.getHeightAt(x, z),
        config,
      );
      const actual = roads.getRoads();
      expect(
        actual.map((road) => ({
          id: road.id,
          path: road.path,
          width: road.width,
        })),
      ).toEqual(
        paths.map((road) => ({
          id: road.id,
          path: road.path,
          width: road.width,
        })),
      );
      const former = getCompactPreparationLodgeFootprint(
        COMPACT_PREPARATION_LODGE,
        false,
      );
      const lobbyPath = paths.find(
        (path) => path.id === "compact-path-bank-lobby",
      )!;
      expect(
        lobbyPath.path.some(
          (p, i) =>
            i > 0 &&
            compactPathIntersectsBounds(lobbyPath.path[i - 1], p, former, 0),
        ),
      ).toBe(true);
      const posts = [-3.5, 3.5].flatMap((x) =>
        [-3.5, 3.5].map((z) => ({
          x: 350 + x,
          z: 320 + z,
        })),
      );
      for (const path of paths.filter(
        (row) =>
          row.id.startsWith("compact-path-") || row.id.includes("bank-clerk"),
      ))
        for (let i = 1; i < path.path.length; i++)
          for (const post of posts)
            expect(
              compactPathIntersectsBounds(
                path.path[i - 1],
                path.path[i],
                {
                  minX: post.x - 0.15,
                  maxX: post.x + 0.15,
                  minZ: post.z - 0.15,
                  maxZ: post.z + 0.15,
                },
                0.3,
              ),
              `${path.id} intersects a post/capsule`,
            ).toBe(false);
      const approach = paths.find(
        (path) => path.id === "compact-clearing-bank-clerk-approach",
      )!;
      expect(approach.path.at(-1)).toMatchObject({ x: 351, z: 322 });
      expect(haven.stations).toEqual(saved.haven.stations);
      expect(haven.resources).toEqual(saved.haven.resources);
      expect(haven.npcs!.map((npc) => npc.id)).toEqual(
        saved.haven.npcs!.map((npc) => npc.id),
      );
      // Omitted architecture is a named historical fixture path only. Runtime
      // explicitly supplies config; no deleted lodge footprint can reappear.
      const historical = createCompactIslandPaths(
        profile,
        { ...ALL_WORLD_AREAS, central_haven: saved.haven },
        getDuelArenaConfig(),
        (x, z) => terrain.getHeightAt(x, z),
      );
      const explicitHistorical = createCompactIslandPaths(
        profile,
        { ...ALL_WORLD_AREAS, central_haven: saved.haven },
        getDuelArenaConfig(),
        (x, z) => terrain.getHeightAt(x, z),
        { compactPreparationLodge: COMPACT_PREPARATION_LODGE },
      );
      expect(historical).toEqual(explicitHistorical);
    } finally {
      world.destroy();
      DataManager["worldConfig"] = saved.config;
      DataManager["worldTerrainProfile"] = saved.profile;
      DataManager["worldContentIdentity"] = saved.identity;
      ALL_WORLD_AREAS.central_haven = saved.haven;
    }
  });
});
