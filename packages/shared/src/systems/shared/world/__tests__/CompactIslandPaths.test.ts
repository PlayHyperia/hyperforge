import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BANK_PAVILION_POSTS } from "../../../../../../procgen/src/building/generator/OpenWorkshop";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { stationDataProvider } from "../../../../data/StationDataProvider";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import {
  getDuelArenaConfig,
  isPositionInsideDuelArenaZone,
} from "../../../../data/duel-manifest";
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
import type {
  CompactPondDocksManifest,
  CompactServiceCourtPlacement,
  CompactServiceCourtsManifest,
  RoadTileSegment,
  WorldArea,
  WorldConfigManifest,
} from "../../../../types/world/world-types";
import type { FlatZone } from "../../../../types/world/terrain";
import { getCompactPondDockSupportBounds } from "../DockDefinition";
import {
  COMPACT_PREPARATION_LODGE,
  getCompactPreparationLodgeFootprint,
} from "../CompactPreparationLodge";
import { GRASS_WORKER_CODE } from "../../../../utils/workers/GrassWorker";
import THREE from "../../../../extras/three/three";
import { DuelArenaVisualsSystem } from "../../../client/DuelArenaVisualsSystem";
import {
  COMPACT_BANK_PAVILION,
  COMPACT_SERVICE_COURT,
  validateCompactServiceCourts,
  validateCompactServiceCourtBindings,
  createCompactServiceCourtGrassExclusions,
  groundCompactServiceCourt,
  createCompactPondServiceGround,
} from "../CompactServiceCourt";
import {
  createCompactTerrainColorOperations,
  type CompactTerrainBankVerge,
} from "../CompactTerrainPalette";
import {
  createTerrainMaterial,
  sampleNoiseCPU,
  TERRAIN_SHADER_CONSTANTS,
} from "../TerrainShader";
import {
  clearRoadInfluenceTexture,
  getRoadInfluenceTexture,
  getRoadInfluenceTextureState,
  setRoadInfluenceTextureData,
} from "../RoadInfluenceMask";
import type { Node } from "three/webgpu";
import { TownSystem } from "../TownSystem";
import { modelBounds } from "./fixtures/StaticGlbBounds";
import { getExternalResource } from "../../../../utils/ExternalAssetUtils";
import { generateCenteredTrees } from "../BiomeResourceGenerator";
import { BFSPathfinder } from "../../movement/BFSPathfinder";
import {
  groundGrassBlades,
  type GrassBladeGroundingRequest,
} from "../GrassBladeGrounding";
import { getGrassBladeLayout } from "../GrassBladeLayout";
import {
  createClumpGeometry,
  FINE_MEADOW_APPEARANCE,
  GRASS_CONFIG,
} from "../GrassVisualManager";
import {
  projectGrassAnchors,
  type GrassAnchorData,
} from "../GrassTerrainProjection";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { gridGeometry } from "./terrain-grid.fixture";
import { BankEntity } from "../../../../entities/world/BankEntity";
import { EntityType, InteractionType } from "../../../../types/entities";
import pondPathStyle from "../../../../data/compact-pond-path-profile-v1.json";
import { packRoadSegments } from "../../../../utils/compute/TerrainComputeContext";

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

class PondBankServiceWorld extends World {
  override get isServer(): boolean {
    return true;
  }
}

/** Historical pins below describe the committed enclosed-bank/old-pond world,
 * not whichever ASSETS_DIR a current native qualification happens to load.
 * Keep their complete real manifest inputs together, without changing any
 * historical expected geometry, field hashes, counters or tolerances. */
function installCommittedPathFixture() {
  const owners = Object.fromEntries(
    ["worldConfig", "worldTerrainProfile", "worldContentIdentity"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(DataManager, key)!],
    ),
  );
  const areaOwners = Object.getOwnPropertyDescriptors(ALL_WORLD_AREAS);
  const before = JSON.stringify(ALL_WORLD_AREAS);
  const restore = () => {
    for (const key of Object.keys(ALL_WORLD_AREAS))
      if (!(key in areaOwners)) delete ALL_WORLD_AREAS[key];
    Object.defineProperties(ALL_WORLD_AREAS, areaOwners);
    Object.defineProperties(DataManager, owners);
    expect(JSON.stringify(ALL_WORLD_AREAS)).toBe(before);
  };
  try {
    const manifests = new URL(
      "../../../../../../server/world/assets/manifests/",
      import.meta.url,
    );
    const config = JSON.parse(
      readFileSync(new URL("world-config.json", manifests), "utf8"),
    ) as WorldConfigManifest;
    const groups = JSON.parse(
      readFileSync(new URL("world-areas.json", manifests), "utf8"),
    ) as Record<string, Record<string, WorldArea>>;
    const areas = Object.assign({}, ...Object.values(groups)) as Record<
      string,
      WorldArea
    >;
    expect(config.terrainProfile?.southernMeadow).toBeUndefined();
    expect(config.compactPreparationLodge).toBeDefined();
    expect(config.compactServiceCourts).toBeUndefined();
    expect(areas.duel_arena.flatZones!.map((zone) => zone.id)).toEqual([
      "duel_arena_campus_grade",
    ]);
    for (const key of Object.keys(ALL_WORLD_AREAS))
      if (!(key in areas)) delete ALL_WORLD_AREAS[key];
    Object.assign(ALL_WORLD_AREAS, areas);
    DataManager["worldContentIdentity"] = null;
    DataManager.setWorldConfig(config);
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}

function useCommittedPathFixture() {
  let restore: (() => void) | undefined;
  beforeEach(() => {
    restore = installCommittedPathFixture();
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });
}

const servedV10 = /\/inland-pond-integration01-UNQUALIFIED\/assets-v10$/.test(
  process.env.ASSETS_DIR ?? "",
);

function currentServedPaths(terrain: TerrainSystem) {
  // Resolve the same explicit asset root as the native world; never silently
  // substitute the committed historical fixtures used by the old goldens.
  expect(servedV10).toBe(true);
  const directory = process.env.ASSETS_DIR! + "/manifests/";
  const manifest = JSON.parse(
    readFileSync(directory + "world-config.json", "utf8"),
  ) as WorldConfigManifest;
  const groups = JSON.parse(
    readFileSync(directory + "world-areas.json", "utf8"),
  ) as Record<string, Record<string, WorldArea>>;
  const config = DataManager.getWorldConfig()!;
  expect(config.terrainProfile).toEqual(manifest.terrainProfile);
  expect(config.compactServiceCourts).toEqual(manifest.compactServiceCourts);
  expect(config.compactPondDocks).toEqual(manifest.compactPondDocks);
  expect(ALL_WORLD_AREAS).toEqual(Object.assign({}, ...Object.values(groups)));
  const court = config.compactServiceCourts!.courts.find(
    (row) => row.layoutId === "haven-pond-bank-v1",
  )!;
  expect(court.position).toEqual({ x: 384, z: 438 });
  const height = (x: number, z: number) =>
    terrain.getResourceGroundHeight(x, z);
  const paths = createCompactIslandPaths(
    config.terrainProfile!,
    ALL_WORLD_AREAS,
    getDuelArenaConfig(),
    height,
    config,
  );
  return { config, court, height, paths };
}

async function withRoads(
  run: (
    roads: RoadNetworkSystem,
    terrain: TerrainSystem,
    world: World,
  ) => void | Promise<void>,
  beforeStart?: (roads: RoadNetworkSystem, terrain: TerrainSystem) => void,
  world = new World(),
) {
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  try {
    await terrain.init();
    const internal = terrain as unknown as TerrainInternals;
    internal.loadWaterBodiesFromManifest();
    internal.loadFlatZonesFromManifest();
    await roads.init();
    beforeStart?.(roads, terrain);
    await roads.start();
    await run(roads, terrain, world);
  } finally {
    world.destroy();
  }
}

function expectPondBankServiceField(
  roads: RoadNetworkSystem,
  court: CompactServiceCourtPlacement,
) {
  const area = ALL_WORLD_AREAS.haven_pond;
  const chest = area.stations!.find((row) => row.id === court.stationIds[0])!;
  const clerk = area.npcs.find((row) => row.id === court.npcIds[0])!;
  const service = roads
    .getRoads()
    .find((row) => row.id === `compact-clearing-${court.layoutId}-service`)!;
  const arrival = roads
    .getRoads()
    .find((row) => row.id === `compact-path-${court.layoutId}-arrival`)!;
  expect(service.path[0]).toMatchObject({
    x: chest.position.x,
    z: chest.position.z,
  });
  expect(service.path.at(-1)).toMatchObject({
    x: clerk.position.x,
    z: clerk.position.z,
  });
  expect(service.width).toBe(1.1);
  expect(service.blendWidth).toBe(0.85);
  const station = stationDataProvider.getStationData("bank")!;
  if (!station.model) throw new Error("Actual bank chest model required");
  const chestBounds = modelBounds(station.model, station.modelScale);
  chestBounds.box.translate(
    new THREE.Vector3(chest.position.x, 0, chest.position.z),
  );
  const standingRadius = 0.35;
  // A court-facing adjacent tile, not just a point outside the visual mesh
  // which could still lie inside the bank's occupied gameplay tile. The real
  // BankEntity below must confirm this is actually reachable and unblocked.
  const chestStanding = {
    x:
      Math.floor(chest.position.x) +
      Math.sign(court.position.x - chest.position.x) +
      0.5,
    z:
      Math.floor(chest.position.z) +
      Math.sign(court.position.z - chest.position.z) +
      0.5,
  };
  const chestCanopy = new THREE.Box2(
    new THREE.Vector2(chestBounds.box.min.x, chestBounds.box.min.z),
    new THREE.Vector2(chestBounds.box.max.x, chestBounds.box.max.z),
  );
  expect(
    chestCanopy.distanceToPoint(
      new THREE.Vector2(chestStanding.x, chestStanding.z),
    ),
  ).toBeGreaterThan(standingRadius);
  const standing = [chestStanding, clerk.position, court.position];
  let standingSamples = 0;
  for (const point of [...standing, ...service.path, ...arrival.path])
    for (let a = 0; a < 32; a++) {
      const x = point.x + Math.cos((a * Math.PI) / 16) * standingRadius;
      const z = point.z + Math.sin((a * Math.PI) / 16) * standingRadius;
      expect(
        roads.getRoadInfluenceAt(x, z),
        `standing ${x},${z}`,
      ).toBeGreaterThan(0.8);
      standingSamples++;
    }
  for (let ix = 0; ix <= 8; ix++)
    for (let iz = 0; iz <= 8; iz++) {
      const x = THREE.MathUtils.lerp(
        chestBounds.box.min.x,
        chestBounds.box.max.x,
        ix / 8,
      );
      const z = THREE.MathUtils.lerp(
        chestBounds.box.min.z,
        chestBounds.box.max.z,
        iz / 8,
      );
      expect(
        roads.getRoadInfluenceAt(x, z),
        `chest canopy ${x},${z}`,
      ).toBeGreaterThan(0.8);
    }
  return {
    chest,
    clerk,
    arrival,
    station,
    chestBounds,
    standingRadius,
    chestStanding,
    standing,
    standingSamples,
  };
}

// Independent squared-distance capsule oracle. The service recipe is neutral
// outside its three ribbons; it is not a rectangular grass-height replacement.
function independentServiceHeight(
  x: number,
  z: number,
  descriptor?: CompactTerrainBankVerge,
) {
  if (!descriptor) return 1;
  const smooth = (low: number, high: number, value: number) => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
  };
  let wear = 0;
  for (const row of descriptor.wear) {
    const dx = row.endX - row.startX,
      dz = row.endZ - row.startZ;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((x - row.startX) * dx + (z - row.startZ) * dz) / (dx * dx + dz * dz),
      ),
    );
    const distanceSquared =
      (x - row.startX - t * dx) ** 2 + (z - row.startZ - t * dz) ** 2;
    wear = Math.max(
      wear,
      row.strength *
        (1 -
          smooth(row.coreRadius ** 2, row.outerRadius ** 2, distanceSquared)),
    );
  }
  const locality =
    smooth(descriptor.minX, descriptor.minX + descriptor.feather, x) *
    (1 - smooth(descriptor.maxX - descriptor.feather, descriptor.maxX, x)) *
    smooth(descriptor.minZ, descriptor.minZ + descriptor.feather, z) *
    (1 - smooth(descriptor.maxZ - descriptor.feather, descriptor.maxZ, z));
  return 1 + wear * locality * (descriptor.wornHeightScale - 1);
}

function expectPondBankServiceClearance(
  world: World,
  terrain: TerrainSystem,
  roads: RoadNetworkSystem,
  court: CompactServiceCourtPlacement,
  pondServiceGround?: CompactTerrainBankVerge,
) {
  const {
    chest,
    clerk,
    arrival,
    station,
    chestBounds,
    standingRadius,
    chestStanding,
    standing,
    standingSamples,
  } = expectPondBankServiceField(roads, court);
  const height = (x: number, z: number) =>
    terrain.getResourceGroundHeight(x, z);
  const grounded = groundCompactServiceCourt(
    court,
    BANK_PAVILION_POSTS,
    height,
  );
  const polygons = createCompactServiceCourtGrassExclusions(
    grounded,
    BANK_PAVILION_POSTS,
  );
  expect(polygons).toHaveLength(4);
  expect(grounded.blockingTiles).toHaveLength(4);
  const collision = world.collision.acquireStaticFootprint(
    grounded.blockingTiles,
  );
  const vegetation = terrain.acquireGrassExclusionPolygons(polygons);
  const support = gridGeometry(32, 33, (x, z) =>
    height(x + court.position.x, z + court.position.z),
  );
  expect(world.isServer).toBe(true);
  const bank = new BankEntity(world, {
    id: chest.id,
    name: "Pond service access proof",
    type: EntityType.BANK,
    position: {
      ...chest.position,
      y: height(chest.position.x, chest.position.z),
    },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    interactable: true,
    interactionType: InteractionType.BANK,
    interactionDistance: 3,
    description: "Actual bank collision and access.",
    model: station.model,
    properties: {
      bankId: chest.id,
      movementComponent: null,
      combatComponent: null,
      healthComponent: null,
      visualComponent: null,
      health: { current: 1, max: 1 },
      level: 1,
    },
  });
  try {
    expect(
      world.collision.isWalkable(
        Math.floor(chest.position.x),
        Math.floor(chest.position.z),
      ),
    ).toBe(false);
    expect(
      world.collision.isWalkable(
        Math.floor(chestStanding.x),
        Math.floor(chestStanding.z),
      ),
    ).toBe(true);
    const flags = () =>
      Array.from({ length: 19 * 23 }, (_, index) =>
        world.collision.getFlags(
          375 + (index % 19),
          423 + Math.floor(index / 19),
        ),
      );
    const beforeFlags = flags();
    const pathsBefore = roads
      .getRoads()
      .map((row) => structuredClone(row.path));
    createCompactIslandPaths(
      DataManager.getWorldTerrainProfile()!,
      ALL_WORLD_AREAS,
      getDuelArenaConfig(),
      height,
      DataManager.getWorldConfig()!,
    );
    expect(flags()).toEqual(beforeFlags);
    expect(roads.getRoads().map((row) => row.path)).toEqual(pathsBefore);
    const pathfinder = new BFSPathfinder();
    // Real bank, footing collision leases and pathfinder; painted capsules are
    // deliberately not walkability inputs. Retain unpainted meadow access too.
    for (const [from, to] of [
      [arrival.path[0], chestStanding],
      [arrival.path[0], clerk.position],
      [
        { x: 378, z: 438 },
        { x: 390, z: 438 },
      ],
      [{ x: 384, z: 445 }, court.position],
    ]) {
      const start = { x: Math.floor(from.x), z: Math.floor(from.z) };
      const end = { x: Math.floor(to.x), z: Math.floor(to.z) };
      const path = pathfinder.findPath(start, end, (tile) =>
        world.collision.isWalkable(tile.x, tile.z),
      );
      expect(path.at(-1)).toEqual(end);
      expect(pathfinder.wasLastPathPartial()).toBe(false);
    }
    const surface = new RetainedTerrainSurface(
      1,
      DataManager.getWorldTerrainProfile()!.id,
      court.position.x,
      court.position.z,
      32,
      33,
      support,
    );
    // Authored numerical probes on actual height samples, not a population or
    // native-render claim. Include inner, shoulder and untouched meadow roots.
    const probes = standing.flatMap((center) =>
      [0, 0.35, 0.8, 1.4, 2.4].flatMap((radius) =>
        Array.from({ length: radius === 0 ? 1 : 8 }, (_, a) => ({
          x: center.x + Math.cos((a * Math.PI) / 4) * radius,
          z: center.z + Math.sin((a * Math.PI) / 4) * radius,
        })),
      ),
    );
    const input: GrassAnchorData = {
      count: probes.length,
      offsets: new Float32Array(probes.length * 3),
      rotScaleHash: new Float32Array(probes.length * 3),
      groundColors: new Float32Array(probes.length * 3),
      grassTints: new Float32Array(probes.length * 4),
      groundNormals: new Float32Array(probes.length * 3),
    };
    probes.forEach((point, i) => {
      input.offsets.set(
        [
          point.x - surface.centerX,
          height(point.x, point.z),
          point.z - surface.centerZ,
        ],
        i * 3,
      );
      input.rotScaleHash.set(
        [((i % 8) * Math.PI) / 4, GRASS_CONFIG.SCALE_MAX, 0.4],
        i * 3,
      );
      input.groundColors.set([0.2, 0.3, 0.1], i * 3);
      input.grassTints.set([1, 1, 1, 0.2], i * 4);
      input.groundNormals.set([0, 1, 0], i * 3);
    });
    const data = projectGrassAnchors(
      input,
      surface,
      (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
      (x, z) => terrain["isGrassExcludedAt"](x, z),
    );
    expect(data.count).toBeGreaterThan(0);
    const dataBefore = structuredClone(data);
    const receipts: {
      geometryLayout: NonNullable<GrassBladeGroundingRequest["geometryLayout"]>;
      lod: GrassBladeGroundingRequest["lod"];
      input: number;
      retained: number;
      retainedBlades: number;
      work: number;
      standingSamples: number;
      scope: string;
    }[] = [];
    for (const [geometryLayout, lod] of [
      ["fine-linear-sweep-near4-v1", 0],
      ["fine-linear-sweep-3seg-v1", 1],
    ] as const) {
      const layout = getGrassBladeLayout(lod, geometryLayout);
      const geometry = createClumpGeometry(
        layout.bladesPerClump,
        layout.bladeSegments,
        FINE_MEADOW_APPEARANCE,
      );
      try {
        const wind = {
          x:
            GRASS_CONFIG.WIND_STRENGTH *
            FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX,
          z:
            GRASS_CONFIG.WIND_STRENGTH *
            FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX *
            0.55,
        };
        const request: GrassBladeGroundingRequest = {
          data,
          geometry,
          lod,
          geometryLayout,
          roadClearance: "per-blade-v1",
          ownSurface: surface,
          surfaces: [surface],
          wind,
          oceanLevel: 0,
          terrainSurface: terrain["getTerrainSurfaceForRegion"](
            368,
            422,
            400,
            454,
          ),
          roadSegments: roads.getRoadSegmentsForGPU(),
          ...(pondServiceGround ? { pondServiceGround } : {}),
        };
        const result = groundGrassBlades(request);
        const withoutRoads = groundGrassBlades({
          ...request,
          roadSegments: [],
        });
        expect(result.status).toBe("ready");
        expect(withoutRoads.status).toBe("ready");
        if (result.status !== "ready" || withoutRoads.status !== "ready")
          throw new Error(
            "Service grounding did not complete within the existing cap",
          );
        expect(result.data.count).toBeGreaterThan(0);
        expect(result.receipt.roadClearance!.retainedBlades).toBeLessThan(
          withoutRoads.receipt.roadClearance!.retainedBlades,
        );
        const overlapsService = (output: typeof result) => {
          let overlaps = 0;
          const position = geometry.getAttribute("position"),
            uv = geometry.getAttribute("uv");
          for (let instance = 0; instance < output.data.count; instance++) {
            const k = instance * 3;
            const heightScale = independentServiceHeight(
              surface.centerX + output.data.offsets[k],
              surface.centerZ + output.data.offsets[k + 2],
              pondServiceGround,
            );
            const tilt = new THREE.Quaternion().setFromUnitVectors(
              new THREE.Vector3(0, 1, 0),
              new THREE.Vector3().fromArray(output.data.groundNormals, k),
            );
            for (let blade = 0; blade < layout.bladesPerClump; blade++) {
              if (!(output.bladeVisibility![instance] & (1 << blade))) continue;
              const box = new THREE.Box2();
              for (
                let vertex = blade * layout.verticesPerBlade;
                vertex < (blade + 1) * layout.verticesPerBlade;
                vertex++
              ) {
                const reach = uv.getY(vertex) ** 1.8;
                for (const fade of [0, 1]) {
                  const point = new THREE.Vector3(
                    position.getX(vertex),
                    position.getY(vertex) * fade * heightScale,
                    position.getZ(vertex),
                  )
                    .multiplyScalar(output.data.rotScaleHash[k + 1])
                    .applyAxisAngle(
                      new THREE.Vector3(0, 1, 0),
                      -output.data.rotScaleHash[k],
                    )
                    .applyQuaternion(tilt)
                    .add(
                      new THREE.Vector3(
                        surface.centerX + output.data.offsets[k],
                        output.data.offsets[k + 1],
                        surface.centerZ + output.data.offsets[k + 2],
                      ),
                    );
                  box.expandByPoint(
                    new THREE.Vector2(
                      point.x - wind.x * reach * heightScale,
                      point.z - wind.z * reach * heightScale,
                    ),
                  );
                  box.expandByPoint(
                    new THREE.Vector2(
                      point.x + wind.x * reach * heightScale,
                      point.z + wind.z * reach * heightScale,
                    ),
                  );
                }
              }
              const inStanding = standing.some(
                (point) =>
                  box.distanceToPoint(new THREE.Vector2(point.x, point.z)) <=
                  standingRadius,
              );
              const inChest =
                box.max.x >= chestBounds.box.min.x &&
                box.min.x <= chestBounds.box.max.x &&
                box.max.y >= chestBounds.box.min.z &&
                box.min.y <= chestBounds.box.max.z;
              if (inStanding || inChest) overlaps++;
            }
          }
          return overlaps;
        };
        expect(overlapsService(withoutRoads)).toBeGreaterThan(0);
        expect(overlapsService(result)).toBe(0);
        expect(data).toEqual(dataBefore);
        receipts.push({
          geometryLayout,
          lod,
          input: data.count,
          retained: result.data.count,
          retainedBlades: result.receipt.roadClearance!.retainedBlades,
          work: result.receipt.workUnits,
          standingSamples,
          scope:
            "Actual core on numerical terrain samples; swept wind/fade canopy clearance and real tile navigation, not native visual acceptance.",
        });
      } finally {
        geometry.dispose();
      }
    }
    process.stdout.write(
      "Pond bank service clearance " + JSON.stringify(receipts) + "\n",
    );
  } finally {
    bank.destroy();
    support.dispose();
    vegetation.release();
    collision.release();
  }
}

describe("inland pond opt-in circulation with actual terrain and road owner", () => {
  it.runIf(servedV10)(
    "connects the current v10 pond court and dock to the final spine without the northern bypass",
    async () => {
      await withRoads((roads, terrain) => {
        const { config, court, height, paths } = currentServedPaths(terrain);
        const before = JSON.stringify([config, ALL_WORLD_AREAS]);
        const noOutpost = createCompactIslandPaths(
          config.terrainProfile!,
          ALL_WORLD_AREAS,
          getDuelArenaConfig(),
          height,
          {
            ...config,
            compactServiceCourts: {
              ...config.compactServiceCourts!,
              courts: config.compactServiceCourts!.courts.filter(
                (row) => row !== court,
              ),
            },
          },
        );
        const retired = new Set([
          "compact-path-pond-bank",
          "compact-wear-pond-bank-east",
          "compact-wear-pond-bank-west",
        ]);
        const outpost = (id: string) =>
          id.includes(court.layoutId) || id === "compact-path-pond-approach";
        expect(noOutpost.filter((row) => retired.has(row.id))).toHaveLength(3);
        expect(paths.filter((row) => retired.has(row.id))).toHaveLength(0);
        // This real alternate architecture selects the prior branch. Only the
        // pond trunk and spine core/shoulder recipe change; the other 22 paths
        // and all stone-entry support/positions remain byte-identical.
        const spineId = "compact-path-lobby-arena";
        const stable = paths.filter(
          (row) => !outpost(row.id) && row.id !== spineId,
        );
        expect(stable).toEqual(
          noOutpost.filter((row) => !retired.has(row.id) && row.id !== spineId),
        );
        const spine = paths.find(
          (row) => row.id === "compact-path-lobby-arena",
        )!;
        const trunk = paths.find(
          (row) => row.id === "compact-path-pond-approach",
        )!;
        const dock = paths.find(
          (row) => row.id === `compact-path-${court.layoutId}-arrival`,
        )!;
        const previousSpine = noOutpost.find((row) => row.id === spineId)!;
        expect(spine).toEqual({
          ...previousSpine,
          width: 0.9,
          blendWidth: 1.6 - 0.9 / 2,
        });
        expect(spine.width / 2 + spine.blendWidth!).toBe(
          previousSpine.width / 2 + previousSpine.blendWidth!,
        );
        const entries = paths.flatMap((row) => row.platformEntries ?? []);
        expect(entries).toHaveLength(3);
        expect(entries.map((row) => row.to)).toEqual([
          { x: 385, z: 368.5 },
          { x: 385, z: 383.5 },
          { x: 350, z: 395 },
        ]);
        expect(trunk).toMatchObject({
          fromId: court.layoutId,
          toId: "lobby-arena-junction",
          width: 0.6,
          blendWidth: 0.75,
        });
        expect(trunk.path[0]).toMatchObject(court.position);
        expect(dock).toMatchObject({
          fromId: "pond-shore",
          toId: "pond-approach-junction",
          width: 0.8,
          blendWidth: 0.65,
        });
        expect(dock.path[0]).toMatchObject({ x: 386.5, z: 424.5 });
        // Real Three line projection is independent of the factory's scalar
        // closest-point implementation. Both junctions land on final sampled
        // curves, not their control polygons or an image-derived coordinate.
        const closest = (
          path: typeof spine,
          anchor: { x: number; z: number },
        ) => {
          const point = new THREE.Vector3(anchor.x, 0, anchor.z);
          return path.path
            .slice(1)
            .map((b, index) => {
              const a = path.path[index];
              return new THREE.Line3(
                new THREE.Vector3(a.x, 0, a.z),
                new THREE.Vector3(b.x, 0, b.z),
              ).closestPointToPoint(point, true, new THREE.Vector3());
            })
            .sort(
              (a, b) => a.distanceToSquared(point) - b.distanceToSquared(point),
            )[0];
        };
        const guide = ALL_WORLD_AREAS.haven_pond.npcs.find(
          (row) => row.id === "fisherman_pete",
        )!;
        const expectedSpine = closest(spine, {
          x: guide.position.x - 2.5,
          z: guide.position.z,
        });
        expect(trunk.path.at(-1)!.x).toBeCloseTo(expectedSpine.x, 12);
        expect(trunk.path.at(-1)!.z).toBeCloseTo(expectedSpine.z, 12);
        // Independently reconstruct the former three-anchor sampled approach
        // with Three vectors, then require exact upstream and dock continuity.
        // This is a mathematical comparison, not native visual acceptance.
        let controls = [
          new THREE.Vector2(court.position.x, court.position.z),
          new THREE.Vector2(guide.position.x - 2.5, guide.position.z),
          new THREE.Vector2(expectedSpine.x, expectedSpine.z),
        ];
        for (let pass = 0; pass < 2; pass++) {
          const next = [controls[0]];
          for (let index = 1; index < controls.length; index++)
            for (const t of [0.25, 0.75])
              next.push(
                controls[index - 1]
                  .clone()
                  .multiplyScalar(1 - t)
                  .addScaledVector(controls[index], t),
              );
          next.push(controls.at(-1)!);
          controls = next;
        }
        const original = [controls[0]];
        for (let index = 1; index < controls.length; index++) {
          const a = controls[index - 1],
            b = controls[index];
          const steps = Math.max(1, Math.ceil(a.distanceTo(b)));
          for (let step = 1; step <= steps; step++)
            original.push(
              a.clone().add(
                b
                  .clone()
                  .sub(a)
                  .multiplyScalar(step / steps),
              ),
            );
        }
        let splice = original.length - 1,
          removedLength = 0;
        while (splice > 1 && removedLength < 10) {
          removedLength += original[splice].distanceTo(original[splice - 1]);
          splice--;
        }
        expect(removedLength).toBeGreaterThanOrEqual(10);
        expect(removedLength).toBeLessThan(11);
        for (let index = 0; index <= splice; index++) {
          expect(trunk.path[index].x).toBeCloseTo(original[index].x, 12);
          expect(trunk.path[index].z).toBeCloseTo(original[index].y, 12);
          expect(trunk.path[index].y).toBe(
            height(trunk.path[index].x, trunk.path[index].z),
          );
        }
        const directions = trunk.path
          .slice(1)
          .map(
            (point, index) =>
              new THREE.Vector2(
                point.x - trunk.path[index].x,
                point.z - trunk.path[index].z,
              ),
          );
        const angleBetween = (a: THREE.Vector2, b: THREE.Vector2) =>
          (Math.acos(
            THREE.MathUtils.clamp(
              a.clone().normalize().dot(b.clone().normalize()),
              -1,
              1,
            ),
          ) *
            180) /
          Math.PI;
        let maxTurn = 0;
        for (let index = splice; index < directions.length; index++) {
          expect(directions[index].length()).toBeLessThanOrEqual(0.5);
          const angle = angleBetween(directions[index], directions[index - 1]);
          expect(angle).toBeLessThan(index === splice ? 2 : 9);
          maxTurn = Math.max(maxTurn, angle);
        }
        const previousTrunk = {
          ...trunk,
          path: original.map((point) => ({
            x: point.x,
            y: height(point.x, point.y),
            z: point.y,
          })),
        };
        const previousDock = closest(previousTrunk, dock.path[0]);
        expect(dock.path.at(-1)!.x).toBeCloseTo(previousDock.x, 12);
        expect(dock.path.at(-1)!.z).toBeCloseTo(previousDock.z, 12);
        const spineSegment = spine.path
          .slice(1)
          .map((b, index) => {
            const a = spine.path[index];
            const line = new THREE.Line3(
              new THREE.Vector3(a.x, 0, a.z),
              new THREE.Vector3(b.x, 0, b.z),
            );
            return {
              lobbyward: new THREE.Vector2(a.x - b.x, a.z - b.z),
              distance: line
                .closestPointToPoint(expectedSpine, true, new THREE.Vector3())
                .distanceTo(expectedSpine),
            };
          })
          .sort((a, b) => a.distance - b.distance)[0];
        const oldArrivalAngle = angleBetween(
          original.at(-1)!.clone().sub(original.at(-2)!),
          spineSegment.lobbyward,
        );
        const arrivalAngle = angleBetween(
          directions.at(-1)!,
          spineSegment.lobbyward,
        );
        expect(oldArrivalAngle).toBeCloseTo(90, 10);
        expect(arrivalAngle).toBeGreaterThan(40);
        expect(arrivalAngle).toBeLessThan(50);
        const maximumShift = Math.max(
          ...trunk.path
            .slice(splice)
            .map((point) =>
              closest(previousTrunk, point).distanceTo(
                new THREE.Vector3(point.x, 0, point.z),
              ),
            ),
        );
        expect(maximumShift).toBeGreaterThan(0.75);
        expect(maximumShift).toBeLessThan(1);
        expect(trunk.width / 2 + trunk.blendWidth!).toBe(0.8 / 2 + 0.65);
        // Historical unprofiled core/shoulder recipe. The separately tested
        // segment profile can now intentionally expand or contract this field.
        for (const [path, oldWidth, oldBlend] of [
          [trunk, 0.8, 0.65],
          [spine, 1.4, 0.9],
        ] as const)
          for (let distance = 0; distance <= 2; distance += 0.01) {
            const before = roadSegmentInfluence(
              0,
              distance,
              -1,
              0,
              1,
              0,
              oldWidth,
              oldBlend,
            );
            const after = roadSegmentInfluence(
              0,
              distance,
              -1,
              0,
              1,
              0,
              path.width,
              path.blendWidth!,
            );
            expect(after).toBeLessThanOrEqual(before + 1e-12);
            expect(after > 0).toBe(before > 0);
          }
        expect(trunk.path.length).toBeLessThanOrEqual(256);
        expect(
          paths.reduce((sum, row) => sum + row.path.length - 1, 0),
        ).toBeLessThanOrEqual(600);
        const expectedDock = closest(trunk, dock.path[0]);
        expect(dock.path.at(-1)!.x).toBeCloseTo(expectedDock.x, 12);
        expect(dock.path.at(-1)!.z).toBeCloseTo(expectedDock.z, 12);
        expect(dock.length).toBeLessThan(4);
        expect(trunk.length).toBeLessThan(55);
        // Existing walkable lobby stone connects these logical route ends;
        // the new route does not paint a second north/west town-bank bypass.
        expect(
          paths.find((row) => row.id === "compact-path-bank-lobby")!.toId,
        ).toBe(spine.fromId);
        expect(spine.toId).toBe("arena-approach");
        for (const path of paths) {
          const published = roads.getRoads().find((row) => row.id === path.id)!;
          expect(published).toMatchObject({
            path: path.path,
            fromPOIId: path.fromId,
            toPOIId: path.toId,
            width: path.width,
            blendWidth: path.blendWidth,
            ...(path.maxInfluence === undefined
              ? {}
              : { maxInfluence: path.maxInfluence }),
            length: path.length,
          });
          expect(published.maxInfluence).toBe(path.maxInfluence);
        }
        expect(roads.getRoads()).toHaveLength(paths.length);
        expect(JSON.stringify([config, ALL_WORLD_AREAS])).toBe(before);
        const mask = roads.getRoadInfluenceTextureData()!;
        process.stdout.write(
          "CURRENT_TOPOLOGY " +
            JSON.stringify({
              scope:
                "Actual v10 factory and road publication; not native art or grass-population parity",
              routes: paths
                .filter((row) => outpost(row.id))
                .map((row) => ({
                  id: row.id,
                  from: row.fromId,
                  to: row.toId,
                  width: row.width,
                  blend: row.blendWidth,
                  cap: row.maxInfluence,
                  length: row.length,
                  segments: row.path.length - 1,
                  start: row.path[0],
                  end: row.path.at(-1),
                })),
              totalRoutes: paths.length,
              totalSegments: paths.reduce(
                (sum, row) => sum + row.path.length - 1,
                0,
              ),
              curve: {
                removedLength,
                maxTurn,
                oldArrivalAngle,
                arrivalAngle,
                maximumShift,
              },
              unaffectedRowsSha256: createHash("sha256")
                .update(JSON.stringify(stable))
                .digest("hex"),
              maskSha256: createHash("sha256").update(mask.data).digest("hex"),
              domain: {
                worldSize: mask.worldSize,
                centerX: mask.centerX,
                centerZ: mask.centerZ,
                width: mask.width,
                height: mask.height,
              },
            }) +
            "\n",
        );
      });
    },
  );

  it.runIf(servedV10)(
    "bakes broad pond width variation into existing segments while retaining service fields and the shared mask domain",
    async () => {
      await withRoads((roads, terrain) => {
        const { paths } = currentServedPaths(terrain);
        // Pre-profile actual-v10 receipt, retained before this implementation.
        // Removing only the new field must reproduce every original road byte,
        // including every centerline sample, height, length and service record.
        expect(
          createHash("sha256")
            .update(
              JSON.stringify(
                paths.map(({ segmentSurfaces: _surface, ...path }) => path),
              ),
            )
            .digest("hex"),
        ).toBe(
          "2750f821cef622f7c853f1a0f201567b938a348e1ae12134b252a6eaabc4c6b0",
        );
        const authored = paths.find(
          (path) => path.id === pondPathStyle.routeId,
        )!;
        const route = roads.getRoads().find((path) => path.id === authored.id)!;
        const surfaces = route.segmentSurfaces!;
        expect(surfaces).toHaveLength(route.path.length - 1);
        expect(surfaces).toEqual(authored.segmentSurfaces);
        expect(surfaces).not.toBe(authored.segmentSurfaces);
        expect(Object.isFrozen(authored.segmentSurfaces)).toBe(true);
        expect(authored.segmentSurfaces!.every(Object.isFrozen)).toBe(true);
        expect(route.path).toEqual(authored.path);
        const identity = JSON.stringify(
          roads
            .getRoads()
            .map(({ segmentSurfaces: _surface, ...road }) => road),
        );
        const candidateSegments = roads.getRoadSegmentsForGPU();
        expect(candidateSegments).toHaveLength(556);
        expect(packRoadSegments(candidateSegments).byteLength).toBe(556 * 32);
        let index = 0,
          variedLength = 0,
          maximumStep = 0;
        const radii = surfaces.map(
          (surface) => surface.width / 2 + surface.blendWidth,
        );
        for (const road of roads.getRoads()) {
          for (let i = 1; i < road.path.length; i++, index++) {
            const surface = road.segmentSurfaces?.[i - 1] ?? road;
            expect(candidateSegments[index]).toEqual({
              startX: road.path[i - 1].x,
              startZ: road.path[i - 1].z,
              endX: road.path[i].x,
              endZ: road.path[i].z,
              width: surface.width,
              ...(surface.blendWidth === undefined
                ? {}
                : { blendWidth: surface.blendWidth }),
              ...(road.maxInfluence === undefined
                ? {}
                : { maxInfluence: road.maxInfluence }),
            });
          }
        }
        for (let i = 0; i < surfaces.length; i++) {
          if (Math.abs(radii[i] - 1.05) > 0.15)
            variedLength += Math.hypot(
              route.path[i + 1].x - route.path[i].x,
              route.path[i + 1].z - route.path[i].z,
            );
          if (i)
            maximumStep = Math.max(
              maximumStep,
              Math.abs(radii[i] - radii[i - 1]),
            );
        }
        expect(Math.max(...radii)).toBeGreaterThan(1.5);
        expect(Math.min(...radii)).toBeLessThan(0.9);
        expect(variedLength).toBeGreaterThan(8);
        const candidate = roads.getRoadInfluenceTextureData()!;
        expect(candidate).toMatchObject({
          width: 512,
          height: 512,
          worldSize: 146,
          centerX: 379.5,
          centerZ: 375,
        });
        expect(maximumStep).toBeLessThan(candidate.worldSize / candidate.width);
        const bounds = {
          worldSize: candidate.worldSize,
          centerX: candidate.centerX,
          centerZ: candidate.centerZ,
        };
        const internal = roads as unknown as RoadInternals;
        let baseline: ReturnType<
          RoadNetworkSystem["generateRoadInfluenceTexture"]
        >;
        try {
          delete route.segmentSurfaces;
          internal.buildTileCache();
          baseline = roads.generateRoadInfluenceTexture(
            512,
            bounds.worldSize,
            0.5,
            bounds.centerX,
            bounds.centerZ,
          )!;
        } finally {
          route.segmentSurfaces = surfaces;
          internal.buildTileCache();
        }
        expect(baseline!).toMatchObject({ width: 512, height: 512, ...bounds });
        expect(
          JSON.stringify(
            roads
              .getRoads()
              .map(({ segmentSurfaces: _surface, ...road }) => road),
          ),
        ).toBe(identity);
        let raised = 0,
          lowered = 0,
          addedSupport = 0,
          removedSupport = 0;
        const changedCells = new Set<number>();
        for (let i = 0; i < candidate.data.length; i++) {
          const before = baseline!.data[i],
            after = candidate.data[i];
          if (after > before) raised++;
          if (after < before) lowered++;
          if (!before && after) addedSupport++;
          if (before && !after) removedSupport++;
          if (after !== before) {
            const x = i % 512,
              z = Math.floor(i / 512);
            for (const dx of [-1, 0])
              for (const dz of [-1, 0])
                if (x + dx >= 0 && x + dx < 511 && z + dz >= 0 && z + dz < 511)
                  changedCells.add((z + dz) * 512 + x + dx);
          }
        }
        expect(raised).toBeGreaterThan(0);
        expect(lowered).toBeGreaterThan(0);
        expect(addedSupport).toBeGreaterThan(0);
        expect(removedSupport).toBeGreaterThan(0);
        const pixel = candidate.worldSize / candidate.width;
        let addedClearanceSamples = 0,
          recoveredClearanceSamples = 0;
        // Midpoint quadrature is disclosed as an estimate, not a root census or
        // conservative bound. There is no artificial zero-clearance art gate.
        for (const cell of changedCells)
          for (let iz = 0; iz < 8; iz++)
            for (let ix = 0; ix < 8; ix++) {
              const x =
                candidate.centerX -
                candidate.worldSize / 2 +
                ((cell % 512) + 0.5 + (ix + 0.5) / 8) * pixel;
              const z =
                candidate.centerZ -
                candidate.worldSize / 2 +
                (Math.floor(cell / 512) + 0.5 + (iz + 0.5) / 8) * pixel;
              const before =
                sampleLinearMask(baseline!.data, candidate, x, z) > 0.8;
              const after =
                sampleLinearMask(candidate.data, candidate, x, z) > 0.8;
              if (after && !before) addedClearanceSamples++;
              if (before && !after) recoveredClearanceSamples++;
            }
        const dock = paths.find(
          (path) => path.id === "compact-path-haven-pond-bank-v1-arrival",
        )!;
        const holds = [
          [route.path[0], pondPathStyle.protectedStartMeters],
          [route.path.at(-1)!, pondPathStyle.protectedEndMeters],
          [dock.path.at(-1)!, pondPathStyle.protectedDockMeters],
        ] as const;
        for (const [point, radius] of holds)
          for (let r = 0; r <= radius; r += 0.25)
            for (let i = 0; i < 32; i++) {
              const x = point.x + Math.cos((i * Math.PI) / 16) * r;
              const z = point.z + Math.sin((i * Math.PI) / 16) * r;
              expect(sampleLinearMask(candidate.data, candidate, x, z)).toBe(
                sampleLinearMask(baseline!.data, candidate, x, z),
              );
            }
        process.stdout.write(
          "POND_SEGMENT_PROFILE " +
            JSON.stringify({
              style: pondPathStyle,
              segments: candidateSegments.length,
              profiledSegments: surfaces.length,
              radiusRange: [Math.min(...radii), Math.max(...radii)],
              maximumStep,
              variedLength,
              raised,
              lowered,
              addedSupport,
              removedSupport,
              changedCells: changedCells.size,
              quadratureSubdivisions: 8,
              estimatedAddedClearanceM2:
                (addedClearanceSamples * pixel * pixel) / 64,
              estimatedRecoveredClearanceM2:
                (recoveredClearanceSamples * pixel * pixel) / 64,
              scope:
                "Actual authored data and production fields; no rendered art, grass-root census, startup or GPU performance acceptance",
            }) +
            "\n",
        );
      });
    },
  );

  it.runIf(servedV10)(
    "keeps original segment profiles through both real cache builders, halo queries and uncached evaluation",
    async () => {
      await withRoads(async (roads) => {
        const road = roads
          .getRoads()
          .find((row) => row.id === pondPathStyle.routeId)!;
        const surfaces = road.segmentSurfaces!;
        const gpu = roads.getRoadSegmentsForGPU();
        const sample = (x: number, z: number) =>
          gpu.reduce(
            (value, segment) =>
              Math.max(
                value,
                roadSegmentInfluence(
                  x,
                  z,
                  segment.startX,
                  segment.startZ,
                  segment.endX,
                  segment.endZ,
                  segment.width,
                  segment.blendWidth ?? 0.5,
                  segment.maxInfluence ?? 1,
                ),
              ),
            0,
          );
        const queries: [number, number][] = [];
        for (let i = 1; i < road.path.length; i++) {
          const a = road.path[i - 1],
            b = road.path[i];
          const length = Math.hypot(b.x - a.x, b.z - a.z);
          for (const offset of [-1.75, -1, -0.5, 0, 0.5, 1, 1.75])
            queries.push([
              (a.x + b.x) / 2 - ((b.z - a.z) / length) * offset,
              (a.z + b.z) / 2 + ((b.x - a.x) / length) * offset,
            ]);
        }
        const check = () => {
          for (const [x, z] of queries)
            expect(roads.getRoadInfluenceAt(x, z)).toBeCloseTo(
              sample(x, z),
              10,
            );
        };
        const cached = () =>
          [...roads["tileRoadCache"]].flatMap(([tile, segments]) =>
            segments
              .filter((segment) => segment.roadId === road.id)
              .map((segment) => ({ tile, ...segment })),
          );
        const original = cached();
        expect(original.length).toBeGreaterThan(surfaces.length); // Real z=400 clip.
        for (const segment of original) {
          const [tx, tz] = segment.tile.split("_").map(Number);
          const start = new THREE.Vector3(
            segment.start.x + tx * 100,
            0,
            segment.start.z + tz * 100,
          );
          const end = new THREE.Vector3(
            segment.end.x + tx * 100,
            0,
            segment.end.z + tz * 100,
          );
          expect(
            road.path.slice(1).some((b, index) => {
              const a = road.path[index];
              const line = new THREE.Line3(
                new THREE.Vector3(a.x, 0, a.z),
                new THREE.Vector3(b.x, 0, b.z),
              );
              return (
                line
                  .closestPointToPoint(start, true, new THREE.Vector3())
                  .distanceTo(start) < 1e-8 &&
                line
                  .closestPointToPoint(end, true, new THREE.Vector3())
                  .distanceTo(end) < 1e-8 &&
                segment.width === surfaces[index].width &&
                segment.blendWidth === surfaces[index].blendWidth
              );
            }),
          ).toBe(true);
        }
        check();
        roads["tileRoadCache"].clear();
        check(); // Same field through the real no-cache branch.
        await roads["buildTileCacheAsync"]();
        expect(cached()).toEqual(original);
        check();
        const boundary = roads
          .getAllBoundaryExits()
          .find((entry) => entry.roadId === road.id)!;
        expect(boundary).toBeDefined();
        const destinationX =
          boundary.tileX +
          (boundary.edge === "east" ? 1 : boundary.edge === "west" ? -1 : 0);
        const destinationZ =
          boundary.tileZ +
          (boundary.edge === "north" ? 1 : boundary.edge === "south" ? -1 : 0);
        expect(() =>
          roads["generateEntryStubSegments"](destinationX, destinationZ, [
            boundary,
          ]),
        ).toThrow(/authored continuations/);
        roads["boundaryExits"] = [];
        const saved = surfaces[0];
        try {
          surfaces[0] = { width: 1000, blendWidth: 400 };
          roads["buildTileCache"]();
          expect(roads["cachedMaxExplicitRoadInfluenceRadius"]).toBe(900);
          expect(
            roads
              .getRoadSegmentsForTile(12, 4)
              .some(
                (segment) =>
                  segment.roadId === road.id &&
                  segment.width === 1000 &&
                  segment.blendWidth === 400,
              ),
          ).toBe(true);
          surfaces[0] = { width: 0.05, blendWidth: 0.025 };
          roads["buildTileCache"]();
          expect(roads["getNarrowestRoadWidth"]()).toBe(0.05);
          expect(roads["getNarrowestRoadInfluenceRadius"](0.5)).toBe(0.05);
          for (const invalid of [
            { width: 0, blendWidth: 0.5 },
            { width: NaN, blendWidth: 0.5 },
            { width: 1, blendWidth: -1 },
            { width: 1, blendWidth: Infinity },
            { width: 1025, blendWidth: 0 },
            { width: 1000, blendWidth: 525 },
          ]) {
            surfaces[0] = invalid;
            expect(() => roads.getRoadSegmentsForGPU()).toThrow(
              /segment surfaces/,
            );
            expect(() => roads["buildTileCache"]()).toThrow(/segment surfaces/);
          }
          surfaces[0] = saved;
          const last = surfaces.pop()!;
          expect(() => roads.getRoadSegmentsForGPU()).toThrow(
            /every original segment/,
          );
          surfaces.push(last);
          delete surfaces[0];
          expect(() => roads.getRoadSegmentsForGPU()).toThrow(
            /segment surfaces/,
          );
        } finally {
          surfaces[0] = saved;
          roads["buildTileCache"]();
        }
        expect(roads.getRoadSegmentsForGPU()).toEqual(gpu);
      });
    },
  );

  it.runIf(servedV10)(
    "keeps the current v10 new full-width branches dry and outside actual floors and dock support",
    async () => {
      await withRoads((roads, terrain) => {
        const { config, court, height, paths } = currentServedPaths(terrain);
        const floors = createDuelArenaFloorZones(
          getDuelArenaConfig(),
          getDuelArenaGradeHeight(),
        );
        expect(floors.map((row) => row.id)).toEqual([
          "duel_arena_floor_1",
          "duel_lobby_floor",
        ]);
        const bounds = floors
          .map((row) => ({
            minX: row.centerX - row.width / 2,
            maxX: row.centerX + row.width / 2,
            minZ: row.centerZ - row.depth / 2,
            maxZ: row.centerZ + row.depth / 2,
          }))
          .concat(
            config.compactPondDocks!.docks.map(getCompactPondDockSupportBounds),
          );
        const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
        const changed = paths.filter(
          (row) =>
            row.id === "compact-path-pond-approach" ||
            row.id === `compact-path-${court.layoutId}-arrival`,
        );
        expect(changed).toHaveLength(2);
        let dryBankSamples = 0,
          fullCoreSamples = 0;
        for (const path of changed) {
          expect(path.platformEntries).toBeUndefined();
          for (let i = 1; i < path.path.length; i++) {
            const a = path.path[i - 1],
              b = path.path[i];
            const surface = path.segmentSurfaces?.[i - 1] ?? path;
            const radius =
              surface.width / 2 +
              (surface.blendWidth ?? COMPACT_PATH_BLEND_WIDTH);
            expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThanOrEqual(
              1 + 1e-12,
            );
            for (const box of bounds)
              expect(compactPathIntersectsBounds(a, b, box, radius)).toBe(
                false,
              );
            // Interior and perimeter samples, with round end caps. Terrain is
            // sampled from the real admitted ground owner, not a flat stand-in.
            for (const t of [0, 0.5, 1]) {
              const centerX = a.x + (b.x - a.x) * t;
              const centerZ = a.z + (b.z - a.z) * t;
              expect(roads.getRoadInfluenceAt(centerX, centerZ)).toBe(1);
              fullCoreSamples++;
              for (const radial of [0, 0.5, 1])
                for (let k = 0; k < 24; k++) {
                  const x =
                    centerX + Math.cos((k * Math.PI) / 12) * radius * radial;
                  const z =
                    centerZ + Math.sin((k * Math.PI) / 12) * radius * radial;
                  const y = height(x, z);
                  expect(Number.isFinite(y)).toBe(true);
                  expect(y).toBeGreaterThan(
                    config.terrainProfile!.water.threshold,
                  );
                  if (
                    Math.hypot(x - pond.centerX, z - pond.centerZ) <=
                    pond.radius
                  ) {
                    expect(y).toBeGreaterThan(pond.surfaceY + 0.06);
                    dryBankSamples++;
                  }
                }
            }
          }
        }
        expect(dryBankSamples).toBeGreaterThan(0);
        expect(fullCoreSamples).toBeGreaterThan(100);
        process.stdout.write(
          "CURRENT_KEEP_OUTS " +
            JSON.stringify({
              fullCoreSamples,
              dryBankSamples,
              floorCount: floors.length,
              dockCount: config.compactPondDocks!.docks.length,
              scope:
                "CPU full-width branch samples; existing separate tests retain real bank standing/BFS/swept-blade clearance",
            }) +
            "\n",
        );
      });
    },
  );

  it.runIf(servedV10)(
    "shares the current v10 route field with terrain, emitted grass worker and actual shader mask binding",
    async () => {
      await withRoads((roads, terrain) => {
        const { config } = currentServedPaths(terrain);
        const internal = terrain as unknown as TerrainInternals;
        const grassSample = new Function(
          "self",
          `${GRASS_WORKER_CODE}\nreturn calculateRoadInfluence;`,
        )({}) as (
          x: number,
          z: number,
          segments: ReturnType<RoadNetworkSystem["getRoadSegmentsForGPU"]>,
          blend: number,
        ) => number;
        const mask = roads.getRoadInfluenceTextureData()!;
        expect(mask).toMatchObject({
          worldSize: 146,
          centerX: 379.5,
          centerZ: 375,
          width: 512,
          height: 512,
        });
        const maskHash = createHash("sha256").update(mask.data).digest("hex");
        const half = mask.worldSize / 2,
          pixel = mask.worldSize / mask.width;
        let fieldSamples = 0,
          rasterSamples = 0;
        for (const road of roads.getRoads())
          for (let i = 1; i < road.path.length; i++) {
            const a = road.path[i - 1],
              b = road.path[i];
            const length = Math.hypot(b.x - a.x, b.z - a.z);
            if (!length) continue;
            const surface = road.segmentSurfaces?.[i - 1] ?? road;
            const blend = surface.blendWidth ?? COMPACT_PATH_BLEND_WIDTH;
            for (const distance of [
              0,
              surface.width / 2,
              surface.width / 2 + blend / 2,
              surface.width / 2 + blend + 0.1,
            ])
              for (const offset of distance === 0
                ? [0]
                : [-distance, distance]) {
                const x = (a.x + b.x) / 2 - ((b.z - a.z) / length) * offset;
                const z = (a.z + b.z) / 2 + ((b.x - a.x) / length) * offset;
                const tx = Math.floor(x / 100),
                  tz = Math.floor(z / 100);
                const expected = roads.getRoadInfluenceAt(x, z);
                expect(
                  internal.calculateRoadInfluenceAtVertex(x, z, tx, tz),
                ).toBeCloseTo(expected, 10);
                const local = new Float32Array([x - tx * 100, z - tz * 100]);
                expect(
                  internal.computeRoadInfluenceBatchCPU(
                    local,
                    tx,
                    tz,
                    roads.getRoadSegmentsForTile(tx, tz),
                  )[0],
                ).toBeCloseTo(
                  roads.getRoadInfluenceAt(
                    local[0] + tx * 100,
                    local[1] + tz * 100,
                  ),
                  6,
                );
                const region = internal.getWorldSpaceRoadSegmentsForRegion(
                  x - 0.25,
                  z - 0.25,
                  x + 0.25,
                  z + 0.25,
                );
                expect(
                  grassSample(x, z, region, COMPACT_PATH_BLEND_WIDTH),
                ).toBeCloseTo(expected, 10);
                expect(
                  grassSample(x, z, region, COMPACT_PATH_BLEND_WIDTH) > 0.8,
                ).toBe(expected > 0.8);
                fieldSamples++;
                const ix = Math.floor((x - mask.centerX + half) / pixel);
                const iz = Math.floor((z - mask.centerZ + half) / pixel);
                for (const dx of [0, 1])
                  for (const dz of [0, 1]) {
                    const col = Math.max(0, Math.min(mask.width - 1, ix + dx));
                    const row = Math.max(0, Math.min(mask.height - 1, iz + dz));
                    // Preserve the historical index/N raster phase explicitly.
                    const sx = mask.centerX - half + col * pixel;
                    const sz = mask.centerZ - half + row * pixel;
                    expect(mask.data[row * mask.width + col]).toBe(
                      Math.fround(roads.getRoadInfluenceAt(sx, sz)),
                    );
                    expect(
                      sampleLinearMask(
                        mask.data,
                        mask,
                        sx + pixel / 2,
                        sz + pixel / 2,
                      ),
                    ).toBe(mask.data[row * mask.width + col]);
                    rasterSamples++;
                  }
              }
          }
        // Bind the real published data to the actual material's shared node;
        // this is a CPU graph/input proof, not executed WGSL or pixel parity.
        const owner = {};
        let material: ReturnType<typeof createTerrainMaterial> | undefined;
        try {
          setRoadInfluenceTextureData(
            mask.data,
            mask.width,
            mask.height,
            mask.worldSize,
            mask.centerX,
            mask.centerZ,
            owner,
          );
          material = createTerrainMaterial(undefined, {
            compactPbr: true,
            compactProfile: config.terrainProfile,
          });
          if (!(material instanceof THREE.MeshStandardNodeMaterial))
            throw new Error("Actual terrain node material required");
          const texture = getRoadInfluenceTexture();
          const state = getRoadInfluenceTextureState();
          expect(texture.image.data).toBe(mask.data);
          expect(texture.minFilter).toBe(THREE.LinearFilter);
          expect(texture.magFilter).toBe(THREE.LinearFilter);
          expect(texture.wrapS).toBe(THREE.ClampToEdgeWrapping);
          expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping);
          expect(texture.generateMipmaps).toBe(false);
          const roots = [
            material.colorNode,
            material.normalNode,
            material.roughnessNode,
            material.aoNode,
          ];
          const sampleOwners = new Set<Node>();
          for (const root of roots) {
            if (!(root instanceof THREE.Node))
              throw new Error("Actual PBR node required");
            const visited = new Set<Node>();
            const visit = (node: Node) => {
              if (visited.has(node)) return;
              visited.add(node);
              for (const child of node.getChildren()) visit(child);
            };
            visit(root);
            const samples = [...visited].filter(
              (node) =>
                Reflect.get(node, "isTextureNode") === true &&
                Reflect.get(node, "value") === texture &&
                Reflect.get(node, "uvNode"),
            );
            expect(samples).toHaveLength(1);
            sampleOwners.add(samples[0]);
            for (const uniform of [
              state.uWorldSize,
              state.uCenterX,
              state.uCenterZ,
            ])
              expect(visited.has(uniform)).toBe(true);
          }
          expect(sampleOwners.size).toBe(1);
          expect([
            state.uWorldSize.value,
            state.uCenterX.value,
            state.uCenterZ.value,
          ]).toEqual([mask.worldSize, mask.centerX, mask.centerZ]);
        } finally {
          try {
            material?.dispose();
          } finally {
            clearRoadInfluenceTexture(owner);
          }
        }
        expect(fieldSamples).toBeGreaterThan(1000);
        expect(createHash("sha256").update(mask.data).digest("hex")).toBe(
          maskHash,
        );
        process.stdout.write(
          "CURRENT_SHARED_FIELD " +
            JSON.stringify({
              fieldSamples,
              rasterSamples,
              pixelMetres: pixel,
              preservedTexelPhaseMetres: pixel / 2,
              maskHash,
              shaderRoots: 4,
              scope:
                "CPU field + real TSL texture binding, not native WGSL/pixel acceptance",
            }) +
            "\n",
        );
      });
    },
  );

  it.runIf(
    /\/inland-pond-integration01-UNQUALIFIED\/assets-v10$/.test(
      process.env.ASSETS_DIR ?? "",
    ),
  )(
    "keeps the current served road lattice and clearance while recovering continuous worn shoulders",
    async () => {
      await withRoads((roads, terrain) => {
        const networkBytes = JSON.stringify(roads.getRoads());
        const published = roads.getRoadInfluenceTextureData()!;
        const maskHash = createHash("sha256")
          .update(published.data)
          .digest("hex");
        expect(published).toMatchObject({
          worldSize: 146,
          centerX: 379.5,
          centerZ: 375,
          width: 512,
          height: 512,
        });
        const ops = createCompactTerrainColorOperations();
        const field = ops.macroField(DataManager.getWorldTerrainProfile())!;
        expect(field.coastalMeadow).toBe(true);
        const clamp = (x: number) => Math.max(0, Math.min(1, x));
        const smooth = (a: number, b: number, x: number) => {
          const t = clamp((x - a) / (b - a));
          return t * t * (3 - 2 * t);
        };
        const evaluate = (x: number, z: number) => {
          const raw = sampleLinearMask(published.data, published, x, z);
          const distort = sampleNoiseCPU(
            x,
            z,
            TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
          );
          const meadow = sampleNoiseCPU(
            x,
            z,
            ops.getComposition().meadowNoiseScale,
          );
          const road = ops.weights({
            noiseValue: 0.5,
            slope: 0,
            roadInfluence: raw,
            distortNoise: distort,
          }).road;
          const patch = smooth(
            0.35,
            0.65,
            clamp(meadow) * 0.55 + clamp(distort) * 0.45,
          );
          const second = smooth(0.12 + 0.24 * patch, 0.64 + 0.24 * patch, road);
          const previous =
            road +
            (second - road) *
              (1 - smooth(0.7, 0.8, raw)) *
              (1 - ops.bankVergeLocality(x, z, field));
          const current = ops.wornTurfWeights({
            x,
            z,
            meadowNoise: meadow,
            distortNoise: distort,
            slope: 0,
            roadInfluence: raw,
            road,
            pondSoil: 0,
            coastalCoverage: 0,
            field,
          }).road;
          expect(current).toBe(road);
          if (raw === 0 || raw === 1) expect(current).toBe(raw);
          if (raw >= 0.8) expect(current).toBe(previous);
          return { raw, previous, current };
        };
        const selected = [
          "compact-path-lobby-arena",
          "compact-path-bank-lobby",
          "compact-clearing-bank-apron",
        ].map((id) => {
          const road = roads.getRoads().find((row) => row.id === id);
          if (!road) throw new Error("Missing actual route: " + id);
          return road;
        });
        const measurements = selected.map((road) => {
          const i = Math.floor((road.path.length - 1) * 0.5);
          const a = road.path[i],
            b = road.path[i + 1];
          const dx = b.x - a.x,
            dz = b.z - a.z,
            length = Math.hypot(dx, dz);
          expect(length).toBeGreaterThan(0);
          const centerX = (a.x + b.x) / 2,
            centerZ = (a.z + b.z) / 2;
          const step = 0.005,
            reach = road.width / 2 + (road.blendWidth ?? 0.5) + 0.5;
          const sides = [-1, 1].map((side) => {
            let previousWidth = 0,
              currentWidth = 0,
              clearanceEdge: number | null = null;
            let finalRaw = 0;
            for (let d = 0; d <= reach; d += step) {
              const x = centerX - (dz / length) * d * side,
                z = centerZ + (dx / length) * d * side;
              const weights = evaluate(x, z);
              finalRaw = weights.raw;
              if (weights.previous > 0.1 && weights.previous < 0.9)
                previousWidth += step;
              if (weights.current > 0.1 && weights.current < 0.9)
                currentWidth += step;
              if (roads.getRoadInfluenceAt(x, z) > 0.8) clearanceEdge = d;
            }
            return {
              side,
              previous10to90Width: previousWidth,
              current10to90Width: currentWidth,
              lastAnalyticallyExcludedPointInWindow: clearanceEdge,
              shoulderLeavesWindow: finalRaw > 0.1,
              sampledReach: reach,
            };
          });
          return {
            id: road.id,
            center: [centerX, centerZ],
            width: road.width,
            blendWidth: road.blendWidth,
            sides,
          };
        });
        // The actual arena-route junction and every stone-entry capsule retain
        // their input field. MAX unions are not replaced by summed road paint.
        let junctionSamples = 0,
          apronSamples = 0;
        const arena = selected[0];
        for (const point of [arena.path[0], arena.path.at(-1)!])
          for (let dx = -2; dx <= 2; dx += 0.2)
            for (let dz = -2; dz <= 2; dz += 0.2) {
              evaluate(point.x + dx, point.z + dz);
              junctionSamples++;
            }
        const authored = createCompactIslandPaths(
          DataManager.getWorldTerrainProfile(),
          ALL_WORLD_AREAS,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
          DataManager.getWorldConfig()!,
        );
        for (const road of authored)
          for (const entry of road.platformEntries ?? [])
            for (const point of entry.approach) {
              evaluate(point.x, point.z);
              apronSamples++;
            }
        expect(junctionSamples).toBeGreaterThan(0);
        expect(apronSamples).toBeGreaterThan(0);
        expect(
          measurements.some((row) =>
            row.sides.some(
              (side) =>
                side.current10to90Width > side.previous10to90Width + 0.02,
            ),
          ),
        ).toBe(true);
        expect(JSON.stringify(roads.getRoads())).toBe(networkBytes);
        expect(roads.getRoadInfluenceTextureData()).toBe(published);
        expect(createHash("sha256").update(published.data).digest("hex")).toBe(
          maskHash,
        );
        process.stdout.write(
          "PATH_SHOULDER_COMPOSITION " +
            JSON.stringify({
              scope:
                "Dry road-weight cross-sections before material-height competition; not native visual or swept-blade clearance proof",
              domain: {
                worldSize: published.worldSize,
                resolution: published.width,
                pixelMetres: published.worldSize / published.width,
                preservedTexelPhaseMetres:
                  published.worldSize / published.width / 2,
              },
              maskHash,
              measurements,
              junctionSamples,
              apronSamples,
            }) +
            "\n",
        );
      });
    },
  );
  it.each([false, true])(
    "starts the moved basin and joins the landing, guide and bank without floor, dock or wet-ground paint (outpost=%s)",
    async (withOutpost) => {
      const basin = JSON.parse(
        readFileSync(
          new URL(
            "../__fixtures__/inland-pond-basin-candidate.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as {
        flatZone: FlatZone;
        waterBody: {
          id: string;
          centerX: number;
          centerZ: number;
          radius: number;
          surfaceY: number;
        };
        outlyingBankStudy: {
          court: CompactServiceCourtPlacement;
          station: NonNullable<WorldArea["stations"]>[number];
          npc: WorldArea["npcs"][number];
        };
      };
      const docks: CompactPondDocksManifest = {
        schemaVersion: 1,
        layoutId: "compact-pond-docks-v1",
        terrainProfileId: "compact-duel-island-v6",
        waterBodyId: basin.waterBody.id,
        docks: [
          {
            id: "haven-fishing-landing",
            x: 390,
            z: 424.5,
            rotation: 90,
            recipeId: "haven-fishing-landing-v1",
          },
          {
            id: "haven-reed-jetty",
            x: 433,
            z: 415.5,
            rotation: 270,
            recipeId: "haven-reed-jetty-v1",
          },
        ],
      };
      const restoreManifest = installCommittedPathFixture();
      try {
        const saved = {
          config: DataManager["worldConfig"],
          profile: DataManager["worldTerrainProfile"],
          identity: DataManager["worldContentIdentity"],
          pond: ALL_WORLD_AREAS.haven_pond,
          haven: ALL_WORLD_AREAS.central_haven,
        };
        const world = new World();
        try {
          const config = structuredClone(saved.config!);
          delete config.compactPreparationLodge;
          delete config.compactServiceCourts;
          config.compactBankPavilion = structuredClone(COMPACT_BANK_PAVILION);
          config.compactPondDocks = docks;
          const pete = Object.values(ALL_WORLD_AREAS)
            .flatMap((area) => area.npcs)
            .find((npc) => npc.id === "fisherman_pete")!;
          ALL_WORLD_AREAS.central_haven = {
            ...saved.haven,
            npcs: saved.haven.npcs
              .filter((npc) => npc.id !== "fisherman_pete")
              .map((npc) =>
                npc.id === "bank_clerk"
                  ? { ...npc, position: { ...npc.position, x: 352, z: 322 } }
                  : npc,
              ),
          };
          ALL_WORLD_AREAS.haven_pond = {
            ...structuredClone(saved.pond),
            flatZones: [basin.flatZone],
            waterBodies: [basin.waterBody],
            npcs: [{ ...pete, position: { x: 387, y: 0, z: 419 } }],
          };
          if (withOutpost) {
            const study = basin.outlyingBankStudy;
            const clerk = saved.haven.npcs.find(
              (row) => row.id === "bank_clerk",
            )!;
            ALL_WORLD_AREAS.haven_pond.stations = [
              structuredClone(study.station),
            ];
            ALL_WORLD_AREAS.haven_pond.npcs.push({
              ...structuredClone(clerk),
              ...structuredClone(study.npc),
            });
            config.compactServiceCourts = {
              schemaVersion: 1,
              layoutId: "compact-service-courts-v1",
              terrainProfileId: "compact-duel-island-v6",
              primaryBankId: COMPACT_BANK_PAVILION.layoutId,
              courts: [
                {
                  ...structuredClone(COMPACT_SERVICE_COURT),
                  schemaVersion: 2,
                  recipeId: "open-timber-smithy-haven-v3",
                  stationIds: ["furnace_spawn", "anvil_spawn"],
                  npcIds: [],
                },
                {
                  ...structuredClone(COMPACT_BANK_PAVILION),
                  schemaVersion: 2,
                  stationIds: ["bank_spawn"],
                  npcIds: ["bank_clerk"],
                },
                structuredClone(study.court),
              ],
            };
            delete config.compactBankPavilion;
            delete config.compactServiceCourt;
          }
          DataManager["worldContentIdentity"] = null;
          DataManager.setWorldConfig(config);
          const terrain = world.register(
            "terrain",
            TerrainSystem,
          ) as TerrainSystem;
          const roads = world.register(
            "roads",
            RoadNetworkSystem,
          ) as RoadNetworkSystem;
          await terrain.init();
          terrain["loadWaterBodiesFromManifest"]();
          terrain["loadFlatZonesFromManifest"]();
          await roads.init();
          const height = (x: number, z: number) =>
            terrain.getResourceGroundHeight(x, z);
          // Reproduce the actual old startup fault: relocation alone cannot pass
          // the existing complete-footprint lobby keep-out.
          expect(() =>
            createCompactIslandPaths(
              config.terrainProfile!,
              ALL_WORLD_AREAS,
              getDuelArenaConfig(),
              height,
              { compactBankPavilion: COMPACT_BANK_PAVILION },
            ),
          ).toThrow("Compact path would paint an authored floor: pond-bank");
          await roads.start();
          const paths = createCompactIslandPaths(
            config.terrainProfile!,
            ALL_WORLD_AREAS,
            getDuelArenaConfig(),
            height,
            config,
          );
          if (withOutpost) {
            const before = createCompactIslandPaths(
              config.terrainProfile!,
              ALL_WORLD_AREAS,
              getDuelArenaConfig(),
              height,
              {
                compactBankPavilion: COMPACT_BANK_PAVILION,
                compactPondDocks: docks,
              },
            );
            const added = paths.filter((path) =>
              path.id.includes("haven-pond-bank-v1"),
            );
            expect(added.map((path) => path.id)).toEqual([
              "compact-path-haven-pond-bank-v1-arrival",
              "compact-clearing-haven-pond-bank-v1-service",
              "compact-wear-haven-pond-bank-v1-activity",
            ]);
            expect(paths.filter((path) => !added.includes(path))).toEqual(
              before,
            );
            expect(added[0].path[0]).toMatchObject({ x: 386.5, z: 424.5 });
            expect(added[0].path.at(-1)).toMatchObject({ x: 384, z: 438 });
            expect(added[1]).toMatchObject({
              fromId: "bank_haven_pond",
              toId: "pond_bank_clerk",
            });
            expect(added[2].maxInfluence).toBeLessThan(0.8);
            expect(added.every((path) => path.path.length <= 256)).toBe(true);
            // This historical basin pins the paint field, not the later
            // pavilion's support. Native-owner checks use admitted v9/v10 below.
            expectPondBankServiceField(roads, basin.outlyingBankStudy.court);
            // Existing paths remain exact; shared wear raises only this service
            // area. It is a scalar paint field, never an authority for walkability.
            expect(roads.getRoadInfluenceAt(384, 438)).toBe(1);
            expect(roads.getRoadInfluenceAt(378, 438)).toBe(0);
            const segments = roads.getRoadSegmentsForGPU();
            expect(segments.length).toBeLessThanOrEqual(600);
            const internal = terrain as unknown as TerrainInternals;
            const grassSample = new Function(
              "self",
              `${GRASS_WORKER_CODE}\nreturn calculateRoadInfluence;`,
            )({}) as (
              x: number,
              z: number,
              candidates: typeof segments,
              blend: number,
            ) => number;
            let fieldChecks = 0;
            for (const path of added)
              for (const point of path.path)
                for (const offset of [-1.5, -0.5, 0, 0.5, 1.5]) {
                  const x = point.x + offset,
                    z = point.z;
                  const expected = roads.getRoadInfluenceAt(x, z);
                  const candidates =
                    internal.getWorldSpaceRoadSegmentsForRegion(
                      x - 0.25,
                      z - 0.25,
                      x + 0.25,
                      z + 0.25,
                    );
                  expect(grassSample(x, z, candidates, 0.5)).toBeCloseTo(
                    expected,
                    10,
                  );
                  expect(
                    internal.calculateRoadInfluenceAtVertex(
                      x,
                      z,
                      Math.floor(x / 100),
                      Math.floor(z / 100),
                    ),
                  ).toBeCloseTo(expected, 10);
                  fieldChecks++;
                }
            const bounds =
              roads["calculateAuthoredRoadMaskBounds"](segments) ??
              roads["calculateRoadMaskBounds"](segments);
            const resolution = roads["calculateRoadMaskTextureSize"](
              bounds.worldSize,
            );
            const mask = roads.generateRoadInfluenceTexture(
              resolution,
              bounds.worldSize,
              0.5,
              bounds.centerX,
              bounds.centerZ,
            )!;
            const stored = roads.getRoads(),
              current = stored.slice();
            let previousMask: typeof mask;
            try {
              stored.splice(
                0,
                stored.length,
                ...current.filter(
                  (row) => !row.id.includes("haven-pond-bank-v1"),
                ),
              );
              previousMask = roads.generateRoadInfluenceTexture(
                resolution,
                bounds.worldSize,
                0.5,
                bounds.centerX,
                bounds.centerZ,
              )!;
            } finally {
              stored.splice(0, stored.length, ...current);
              roads["buildTileCache"]();
              roads.generateRoadInfluenceTexture(
                resolution,
                bounds.worldSize,
                0.5,
                bounds.centerX,
                bounds.centerZ,
              );
            }
            // Check the actually filtered mask, not just the analytical capsules.
            // The entire new footprint is dry; retain dock/apron exclusion on a
            // dense independent lattice around the outpost and its connector.
            let checked = 0,
              historicalDockMaximum = 0;
            for (let x = 378; x <= 390; x += 0.25)
              for (let z = 423; z <= 444; z += 0.25) {
                const value = sampleLinearMask(mask.data, bounds, x, z);
                const wet =
                  Math.hypot(
                    x - basin.waterBody.centerX,
                    z - basin.waterBody.centerZ,
                  ) <= basin.waterBody.radius &&
                  height(x, z) <= basin.waterBody.surfaceY;
                const dock = docks.docks.some((row) => {
                  const b = getCompactPondDockSupportBounds(row);
                  return (
                    x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ
                  );
                });
                if (wet || dock) {
                  const previous = sampleLinearMask(
                    previousMask.data,
                    bounds,
                    x,
                    z,
                  );
                  expect(value, `new filtered paint at ${x},${z}`).toBe(
                    previous,
                  );
                  if (wet) expect(value).toBe(0);
                  else
                    historicalDockMaximum = Math.max(
                      historicalDockMaximum,
                      previous,
                    );
                  checked++;
                }
              }
            expect(checked).toBeGreaterThan(0);
            process.stdout.write(
              "Pond outpost wear " +
                JSON.stringify({
                  addedSegments: added.reduce(
                    (n, path) => n + path.path.length - 1,
                    0,
                  ),
                  totalSegments: segments.length,
                  resolution,
                  checked,
                  historicalDockMaximum,
                  fieldChecks,
                  centerInfluence: roads.getRoadInfluenceAt(384, 438),
                }) +
                "\n",
            );
          }
          expect(roads.getRoads().map((road) => road.path)).toEqual(
            paths.map((path) => path.path),
          );
          const route = paths.find(
            (path) => path.id === "compact-path-pond-bank",
          )!;
          expect(route.path[0]).toMatchObject({ x: 386.5, z: 424.5 });
          expect(route.path.at(-1)).toMatchObject({ x: 348, z: 321 });
          expect(route.path.length).toBeLessThanOrEqual(256);
          // Removing the decorative court keeps the admitted west passage at
          // exactly its existing centerline; it no longer depends on a floor.
          expect(
            route.path.some(
              (point) => point.x === 363.5 && point.z > 370 && point.z < 390,
            ),
          ).toBe(true);
          expect(
            Math.min(
              ...route.path
                .slice(1)
                .map((b, i) =>
                  compactPathSegmentDistance(
                    { x: 387, z: 419 },
                    route.path[i],
                    b,
                  ),
                ),
            ),
          ).toBeLessThan(3.5);
          const floors = createDuelArenaFloorZones(
            getDuelArenaConfig(),
            getDuelArenaGradeHeight(),
          );
          expect(floors.map((floor) => floor.id)).toEqual([
            "duel_arena_floor_1",
            "duel_lobby_floor",
          ]);
          const pondPaths = paths.filter((path) =>
            path.id.includes("pond-bank"),
          );
          let dryBankChecks = 0;
          for (const path of pondPaths) {
            const radius =
              path.width / 2 + (path.blendWidth ?? COMPACT_PATH_BLEND_WIDTH);
            for (let i = 1; i < path.path.length; i++) {
              const a = path.path[i - 1],
                b = path.path[i];
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
                    radius,
                  ),
                ).toBe(false);
              for (const dock of docks.docks)
                expect(
                  compactPathIntersectsBounds(
                    a,
                    b,
                    getCompactPondDockSupportBounds(dock),
                    radius,
                  ),
                ).toBe(false);
              // Independent denser polar samples around every segment, including
              // end caps: complete paint support, not merely the centerline.
              for (let t = 0; t <= 8; t++)
                for (let angle = 0; angle < 32; angle++) {
                  const x =
                    a.x +
                    ((b.x - a.x) * t) / 8 +
                    Math.cos((angle * Math.PI) / 16) * radius;
                  const z =
                    a.z +
                    ((b.z - a.z) * t) / 8 +
                    Math.sin((angle * Math.PI) / 16) * radius;
                  if (
                    Math.hypot(
                      x - basin.waterBody.centerX,
                      z - basin.waterBody.centerZ,
                    ) <= basin.waterBody.radius
                  ) {
                    expect(height(x, z)).toBeGreaterThan(
                      basin.waterBody.surfaceY,
                    );
                    dryBankChecks++;
                  }
                }
            }
          }
          expect(dryBankChecks).toBeGreaterThan(0);
          const terminal = route.path[0];
          expect(() =>
            createCompactIslandPaths(
              config.terrainProfile!,
              ALL_WORLD_AREAS,
              getDuelArenaConfig(),
              (x, z) =>
                Math.hypot(x - terminal.x, z - terminal.z) < 1.5
                  ? basin.waterBody.surfaceY - 0.1
                  : height(x, z),
              config,
            ),
          ).toThrow("Compact path would paint water: pond-bank");
        } finally {
          world.destroy();
          DataManager["worldConfig"] = saved.config;
          DataManager["worldTerrainProfile"] = saved.profile;
          DataManager["worldContentIdentity"] = saved.identity;
          ALL_WORLD_AREAS.haven_pond = saved.pond;
          ALL_WORLD_AREAS.central_haven = saved.haven;
        }
      } finally {
        restoreManifest();
      }
    },
  );

  it.runIf(
    /\/inland-pond-integration01-UNQUALIFIED\/assets-v(?:9|10)$/.test(
      process.env.ASSETS_DIR ?? "",
    ),
  )(
    "clears the admitted pond bank service anchors and swept grass without restricting its open ground",
    async () => {
      await withRoads(
        (roads, terrain, world) => {
          const court =
            DataManager.getWorldConfig()!.compactServiceCourts!.courts.find(
              (row) => row.layoutId === "haven-pond-bank-v1",
            )!;
          expect(court.recipeId).toBe("open-timber-pond-bank-haven-v1");
          expectPondBankServiceClearance(world, terrain, roads, court);
        },
        undefined,
        new PondBankServiceWorld(),
      );
    },
  );

  it.runIf(
    /\/inland-pond-integration01-UNQUALIFIED\/assets-v(?:9|10)$/.test(
      process.env.ASSETS_DIR ?? "",
    ),
  )(
    "binds the pond service ground to actual owners while preserving open-ground navigation and swept clearance",
    async () => {
      await withRoads(
        (roads, terrain, world) => {
          const config = DataManager.getWorldConfig()!;
          const profile = DataManager.getWorldTerrainProfile();
          const court = config.compactServiceCourts!.courts.find(
            (row) => row.layoutId === "haven-pond-bank-v1",
          )!;
          const ownersBefore = JSON.stringify([
            config,
            ALL_WORLD_AREAS,
            roads.getRoads(),
          ]);
          const { chestStanding, clerk, arrival } = expectPondBankServiceField(
            roads,
            court,
          );
          const descriptor = createCompactPondServiceGround(
            profile,
            config,
            ALL_WORLD_AREAS,
          )!;
          expect(descriptor).not.toBeNull();
          expect(Object.isFrozen(descriptor)).toBe(true);
          expect(Object.isFrozen(descriptor.wear)).toBe(true);
          descriptor.wear.forEach((row) =>
            expect(Object.isFrozen(row)).toBe(true),
          );
          const direction = new THREE.Vector2(
            arrival.path[0].x - court.position.x,
            arrival.path[0].z - court.position.z,
          ).normalize();
          // Recipe expectations declared independently of the JSON/factory.
          expect(descriptor.wear).toEqual([
            {
              startX: chestStanding.x,
              startZ: chestStanding.z,
              endX: court.position.x,
              endZ: court.position.z,
              coreRadius: 1.5,
              outerRadius: 4.2,
              strength: 0.92,
            },
            {
              startX: court.position.x,
              startZ: court.position.z,
              endX: clerk.position.x,
              endZ: clerk.position.z,
              coreRadius: 1.2,
              outerRadius: 3.4,
              strength: 0.86,
            },
            {
              startX: court.position.x,
              startZ: court.position.z,
              endX: court.position.x + direction.x * 6,
              endZ: court.position.z + direction.y * 6,
              coreRadius: 0.85,
              outerRadius: 2.7,
              strength: 0.78,
            },
          ]);
          const colors = createCompactTerrainColorOperations();
          const before = colors.macroField(profile)!;
          const after = colors.macroField(
            profile,
            undefined,
            undefined,
            undefined,
            descriptor,
          )!;
          expect(after.bankVerge).toEqual(before.bankVerge);
          expect(after.pondServiceGround).toEqual(descriptor);
          let shorter = 0,
            neutralInside = 0;
          for (let ix = 0; ix <= 24; ix++)
            for (let iz = 0; iz <= 24; iz++) {
              const x = THREE.MathUtils.lerp(
                descriptor.minX,
                descriptor.maxX,
                ix / 24,
              );
              const z = THREE.MathUtils.lerp(
                descriptor.minZ,
                descriptor.maxZ,
                iz / 24,
              );
              const expected = independentServiceHeight(x, z, descriptor);
              expect(colors.bankVergeHeightScale(x, z, after)).toBeCloseTo(
                expected,
                12,
              );
              expect(colors.bankVergeClumpScale(x, z, 1, after)).toBe(1);
              if (expected < 1) shorter++;
              else if (ix > 0 && ix < 24 && iz > 0 && iz < 24) neutralInside++;
            }
          expect(shorter).toBeGreaterThan(100);
          expect(neutralInside).toBeGreaterThan(10);
          for (const [x, z] of [
            [350, 318],
            [348, 319.25],
            [320, 300],
            [descriptor.minX - 0.01, court.position.z],
            [descriptor.maxX + 0.01, court.position.z],
          ]) {
            expect(colors.bankVergeHeightScale(x, z, after)).toBe(
              colors.bankVergeHeightScale(x, z, before),
            );
            expect(colors.bankVergeWear(x, z, after)).toBe(
              colors.bankVergeWear(x, z, before),
            );
          }
          expect(
            createCompactPondServiceGround(profile, undefined, ALL_WORLD_AREAS),
          ).toBeNull();
          const noOwner = {
            ...structuredClone(config),
            compactServiceCourts: {
              ...config.compactServiceCourts!,
              courts: config.compactServiceCourts!.courts.filter(
                (row) => row.layoutId !== court.layoutId,
              ),
            },
          };
          expect(
            createCompactPondServiceGround(profile, noOwner, ALL_WORLD_AREAS),
          ).toBeNull();
          const noDock = structuredClone(config);
          delete noDock.compactPondDocks;
          expect(() =>
            createCompactPondServiceGround(profile, noDock, ALL_WORLD_AREAS),
          ).toThrow();
          const noClerk = structuredClone(ALL_WORLD_AREAS);
          noClerk.haven_pond.npcs = noClerk.haven_pond.npcs.filter(
            (row) => row.id !== clerk.id,
          );
          expect(() =>
            createCompactPondServiceGround(profile, config, noClerk),
          ).toThrow();
          const duplicate = {
            ...structuredClone(config),
            compactServiceCourts: {
              ...config.compactServiceCourts!,
              courts: [
                ...config.compactServiceCourts!.courts,
                { ...court, layoutId: "duplicate-pond-owner" },
              ],
            },
          };
          expect(() =>
            createCompactPondServiceGround(profile, duplicate, ALL_WORLD_AREAS),
          ).toThrow();
          expect(
            JSON.stringify([config, ALL_WORLD_AREAS, roads.getRoads()]),
          ).toBe(ownersBefore);
          expectPondBankServiceClearance(
            world,
            terrain,
            roads,
            court,
            descriptor,
          );
          expect(
            JSON.stringify([config, ALL_WORLD_AREAS, roads.getRoads()]),
          ).toBe(ownersBefore);
        },
        undefined,
        new PondBankServiceWorld(),
      );
    },
  );
});

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

async function withPavilionGroundRoads(
  profileFixture: (
    run: (
      roads: RoadNetworkSystem,
      terrain: TerrainSystem,
    ) => void | Promise<void>,
  ) => Promise<void>,
  run: (
    roads: RoadNetworkSystem,
    terrain: TerrainSystem,
  ) => void | Promise<void>,
) {
  await profileFixture(async () => {
    const owners = Object.fromEntries(
      ["worldConfig", "worldTerrainProfile", "worldContentIdentity"].map(
        (key) => [key, Object.getOwnPropertyDescriptor(DataManager, key)!],
      ),
    );
    const haven = ALL_WORLD_AREAS.central_haven;
    try {
      const config = structuredClone(DataManager.getWorldConfig()!);
      delete config.compactPreparationLodge;
      config.compactBankPavilion = structuredClone(COMPACT_BANK_PAVILION);
      const selected = structuredClone(haven);
      selected.flatZones = selected.flatZones!.filter(
        (zone) => zone.id !== "central_haven_lodge_grass_clearance",
      );
      const clerk = selected.npcs!.find((row) => row.id === "bank_clerk")!;
      clerk.position.x = 352;
      clerk.position.z = 322;
      ALL_WORLD_AREAS.central_haven = selected;
      DataManager["worldContentIdentity"] = null;
      DataManager.setWorldConfig(config);
      // A separate genuine startup publishes the bank-pavilion mask. Never
      // compare a mutated network with the earlier world's stale mask cache.
      await withRoads(run);
    } finally {
      ALL_WORLD_AREAS.central_haven = haven;
      Object.defineProperties(DataManager, owners);
    }
  });
}

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
  useCommittedPathFixture();
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
            segmentSurfaces: path.segmentSurfaces?.map((surface) => ({
              ...surface,
            })),
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
            segmentSurfaces: path.segmentSurfaces?.map((surface) => ({
              ...surface,
            })),
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
            segmentSurfaces: path.segmentSurfaces?.map((surface) => ({
              ...surface,
            })),
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
            segmentSurfaces: path.segmentSurfaces?.map((surface) => ({
              ...surface,
            })),
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

  it("keeps every entire width-plus-blend segment outside water, lobby and the combat floor", async () => {
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
  useCommittedPathFixture();
  it("keeps primary-bank paths exact with three actual bank bindings in non-primary manifest order", async () => {
    await withRoads((_roads, terrain) => {
      const profile = terrain.getWorldTerrainProfile();
      const areas = structuredClone(ALL_WORLD_AREAS);
      const haven = areas.central_haven;
      // Preserve the admitted open-pavilion checkpoint coordinates, not the
      // older enclosed lodge's clerk outside the new court footprint.
      const clerk = haven.npcs!.find((row) => row.id === "bank_clerk")!;
      clerk.position.x = 352;
      clerk.position.z = 322;
      const bank = haven.stations!.find((row) => row.type === "bank")!;
      const reference = createCompactIslandPaths(
        profile,
        areas,
        getDuelArenaConfig(),
        (x, z) => terrain.getHeightAt(x, z),
        { compactBankPavilion: COMPACT_BANK_PAVILION },
      );
      const coordinates = {
        bank: { ...bank.position },
        clerk: { ...clerk.position },
      };
      bank.id = "network_primary_station";
      clerk.id = "network_primary_clerk";
      haven.stations!.unshift(
        {
          ...structuredClone(bank),
          id: "network_east_station",
          position: { x: 370, y: 0, z: 320 },
        },
        {
          ...structuredClone(bank),
          id: "network_south_station",
          position: { x: 370, y: 0, z: 340 },
        },
      );
      const layout: CompactServiceCourtsManifest = {
        schemaVersion: 1,
        layoutId: "compact-service-courts-v1",
        terrainProfileId: "compact-duel-island-v6",
        primaryBankId: "network_primary",
        courts: [
          {
            schemaVersion: 2,
            layoutId: "network_east",
            terrainProfileId: "compact-duel-island-v6",
            position: { x: 370, z: 320 },
            rotation: 0,
            recipeId: "open-timber-bank-haven-v2",
            stationIds: ["network_east_station"],
            npcIds: [],
          },
          {
            schemaVersion: 2,
            layoutId: "network_south",
            terrainProfileId: "compact-duel-island-v6",
            position: { x: 370, z: 340 },
            rotation: 0,
            recipeId: "open-timber-bank-haven-v2",
            stationIds: ["network_south_station"],
            npcIds: [],
          },
          {
            schemaVersion: 2,
            layoutId: "network_primary",
            terrainProfileId: "compact-duel-island-v6",
            position: { x: 350, z: 320 },
            rotation: 0,
            recipeId: "open-timber-bank-haven-v2",
            stationIds: [bank.id],
            npcIds: [clerk.id],
          },
        ],
      };
      const admitted = validateCompactServiceCourts(layout, profile)!;
      expect(() =>
        validateCompactServiceCourtBindings(admitted, areas),
      ).not.toThrow();
      expect(haven.stations!.filter((row) => row.type === "bank")).toHaveLength(
        3,
      );
      expect(admitted.courts[0].layoutId).not.toBe(admitted.primaryBankId);
      const selected = createCompactIslandPaths(
        profile,
        areas,
        getDuelArenaConfig(),
        (x, z) => terrain.getHeightAt(x, z),
        { compactServiceCourts: admitted },
      );
      expect(selected).toEqual(reference);
      expect(JSON.stringify(selected)).toBe(JSON.stringify(reference));
      expect({ bank: bank.position, clerk: clerk.position }).toEqual(
        coordinates,
      );
      const reversed = validateCompactServiceCourts(
        { ...layout, courts: [...layout.courts].reverse() },
        profile,
      )!;
      expect(
        createCompactIslandPaths(
          profile,
          areas,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
          { compactServiceCourts: reversed },
        ),
      ).toEqual(reference);
      // Without the explicit owner the same additional real bank records are
      // ambiguous; do not fall back to whichever station happens to be first.
      expect(() =>
        createCompactIslandPaths(
          profile,
          areas,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
          { compactBankPavilion: COMPACT_BANK_PAVILION },
        ),
      ).toThrow(/one admitted Haven station: bank/);
      for (const architecture of [
        {
          compactServiceCourts: {
            ...admitted,
            primaryBankId: "absent_primary",
          },
        },
        {
          compactServiceCourts: admitted,
          compactBankPavilion: COMPACT_BANK_PAVILION,
        },
        {
          compactServiceCourts: admitted,
          compactPreparationLodge: COMPACT_PREPARATION_LODGE,
        },
      ])
        expect(() =>
          createCompactIslandPaths(
            profile,
            areas,
            getDuelArenaConfig(),
            (x, z) => terrain.getHeightAt(x, z),
            architecture,
          ),
        ).toThrow(/unambiguous primary bank owner/);
      const missing = structuredClone(areas);
      missing.central_haven.stations = missing.central_haven.stations!.filter(
        (row) => row.id !== bank.id,
      );
      expect(() =>
        createCompactIslandPaths(
          profile,
          missing,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
          { compactServiceCourts: admitted },
        ),
      ).toThrow(/station binding/);
    });
  });

  it.each(pathFixtures)(
    "pins $name historical ground paint before pavilion ground art",
    async ({ name, run }) => {
      await run((_roads, terrain) => {
        const profile = terrain.getWorldTerrainProfile();
        const paths = createCompactIslandPaths(
          profile,
          ALL_WORLD_AREAS,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
        );
        const areas = structuredClone(ALL_WORLD_AREAS);
        const clerk = areas.central_haven.npcs!.find(
          (row) => row.id === "bank_clerk",
        )!;
        clerk.position.x = 352;
        clerk.position.z = 322;
        const pavilion = createCompactIslandPaths(
          profile,
          areas,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
          { compactBankPavilion: COMPACT_BANK_PAVILION },
        );
        // Captured from the actual pre-ground03 source, not recomputed from an
        // alternative candidate branch. Includes every point, Y, width and cap.
        const historicalSha =
          name === "baseline"
            ? "9a50310b07c62c7e9caa3c33dc72a771657d867de59dbe85a10891b18f693ae3"
            : "605b5731348601653cb47dd6e90b137c22395a779e607394d171d7330409c905";
        expect(
          createHash("sha256").update(JSON.stringify(paths)).digest("hex"),
        ).toBe(historicalSha);
        const unchanged = pavilion.filter(
          (row) =>
            ![
              "compact-clearing-bank-apron",
              "compact-clearing-bank-clerk-approach",
              "compact-wear-bank-clerk-outer",
              "compact-wear-bank-apron-inner",
              "compact-wear-bank-service",
              "compact-wear-bank-south-arrival",
            ].includes(row.id),
        );
        expect(
          createHash("sha256").update(JSON.stringify(unchanged)).digest("hex"),
        ).toBe(
          name === "baseline"
            ? "e230f8b89ca2f22fc79a8082be5de1657dac25d87eeedd25c9afb634cd30a499"
            : "59b442e408edac5fc7680ef3722f311e341dde6e9e5d169ee79d90d4483adc4d",
        );
        process.stdout.write(
          "Bank ground paint baseline " +
            JSON.stringify({
              name,
              historicalSha: createHash("sha256")
                .update(JSON.stringify(paths))
                .digest("hex"),
              historicalSegments: paths.reduce(
                (n, row) => n + row.path.length - 1,
                0,
              ),
              pavilionSegments: pavilion.reduce(
                (n, row) => n + row.path.length - 1,
                0,
              ),
              unaffectedSha: createHash("sha256")
                .update(
                  JSON.stringify(
                    pavilion.filter(
                      (row) =>
                        ![
                          "compact-clearing-bank-apron",
                          "compact-clearing-bank-clerk-approach",
                          "compact-wear-bank-clerk-outer",
                          "compact-wear-bank-apron-inner",
                          "compact-wear-bank-service",
                          "compact-wear-bank-south-arrival",
                        ].includes(row.id),
                    ),
                  ),
                )
                .digest("hex"),
            }) +
            "\n",
        );
        expect(paths.length).toBeGreaterThan(0);
      });
    },
  );
  it.each(pathFixtures)(
    "shares $name pavilion service wear with the actual bounded road mask and retains filtered keep-outs",
    async ({ name, run }) => {
      await withPavilionGroundRoads(run, (roads, terrain) => {
        const areas = structuredClone(ALL_WORLD_AREAS);
        const haven = areas.central_haven;
        const clerk = haven.npcs!.find((row) => row.id === "bank_clerk")!;
        clerk.position.x = 352;
        clerk.position.z = 322;
        const profile = terrain.getWorldTerrainProfile();
        const originalAreas = JSON.stringify(areas);
        const beforeHeights = Array.from({ length: 121 }, (_, i) =>
          terrain.getHeightAt(345 + (i % 11), 316 + Math.floor(i / 11)),
        );
        const paths = createCompactIslandPaths(
          profile,
          areas,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
          { compactBankPavilion: COMPACT_BANK_PAVILION },
        );
        const ids = [
          "compact-clearing-bank-apron",
          "compact-clearing-bank-clerk-approach",
          "compact-wear-bank-service",
          "compact-wear-bank-south-arrival",
        ];
        const local = paths.filter((row) => ids.includes(row.id));
        expect(local.map((row) => row.id)).toEqual(ids);
        expect(
          local.map((row) => [
            row.width,
            row.blendWidth,
            row.maxInfluence ?? 1,
          ]),
        ).toEqual([
          [0.8, 0.95, 1],
          [0.65, 0.85, 1],
          [0.45, 1.1, 0.48],
          [0.5, 1.15, 0.5],
        ]);
        expect(local[0].path.at(-1)).toEqual(local[1].path[0]);
        expect(local[0].path.at(-1)).toMatchObject({ x: 350, z: 320 });
        expect(local[1].path.at(-1)).toMatchObject({ x: 351, z: 322 });
        const sample = (list: Paths, x: number, z: number) =>
          list.reduce(
            (peak, row) =>
              row.path
                .slice(1)
                .reduce(
                  (value, end, i) =>
                    Math.max(
                      value,
                      roadSegmentInfluence(
                        x,
                        z,
                        row.path[i].x,
                        row.path[i].z,
                        end.x,
                        end.z,
                        row.width,
                        row.blendWidth ?? 0.5,
                        row.maxInfluence ?? 1,
                      ),
                    ),
                  peak,
                ),
            0,
          );
        expect(sample(local, 348, 318)).toBeGreaterThan(0);
        expect(sample(local, 352, 322)).toBeGreaterThan(0);
        expect(sample(local, 350, 320)).toBe(1);
        for (let z = 320; z <= 326; z += 0.125)
          expect(sample(paths, 350, z), `south arrival z=${z}`).toBeGreaterThan(
            0,
          );
        for (const skirt of local.slice(2))
          expect(
            sample(paths, skirt.path[0].x, skirt.path[0].z),
          ).toBeGreaterThan(0);
        let partial = 0,
          full = 0,
          zero = 0;
        for (let z = 315; z <= 328; z += 0.125)
          for (let x = 343; x <= 357; x += 0.125) {
            const value = sample(local, x, z);
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
            expect(sample(local.slice(2), x, z)).toBeLessThanOrEqual(0.5);
            if (value === 0) zero++;
            else if (value > 0.8) full++;
            else partial++;
          }
        expect(partial).toBeGreaterThan(full);
        expect(full).toBeGreaterThan(0);
        expect(zero).toBeGreaterThan(partial);
        const waters = Object.values(areas).flatMap(
          (area) => area.waterBodies ?? [],
        );
        const floors = createDuelArenaFloorZones(
          getDuelArenaConfig(),
          getDuelArenaGradeHeight(areas),
        );
        // All frozen functional-tree anchors, not only the nearest visible LOD.
        // Explicit manifest resources have no spawn scale variation; grove rows
        // retain their admitted scale. A circular all-variant/all-LOD envelope
        // conservatively covers every Y rotation without guessing a crown size.
        const resources = Object.values(areas)
          .flatMap((area) => area.resources ?? [])
          .filter((row) => row.type === "tree")
          .map((row) => ({
            id: row.instanceId,
            x: row.position.x,
            z: row.position.z,
            resourceId: row.resourceId,
            scale: 1,
          }));
        for (const region of DataManager.getWorldConfig()!
          .compactResourceGroves!.regions)
          for (const row of region.anchors)
            resources.push({
              id: row.id,
              x: row.position.x,
              z: row.position.z,
              resourceId: `tree_${row.subType}`,
              scale: row.scale,
            });
        expect(resources).toHaveLength(40);
        // Include the actual seeded owners adjacent to the complete changed
        // footprint. Do not mistake the 40 authored anchors for the complete
        // live resource population (the scene also has procedural trees).
        let localGeneratedTrees = 0;
        for (const tileX of [3, 4])
          for (const tileZ of [3, 4]) {
            const generated = generateCenteredTrees(
              { tileX, tileZ },
              100,
              (x, z) => terrain["createTreeGenerationSource"](x, z),
              isPositionInsideDuelArenaZone,
            );
            for (const row of generated.resources) {
              resources.push({
                id: row.id,
                x: tileX * 100 + row.position.x,
                z: tileZ * 100 + row.position.z,
                resourceId: `tree_${row.subType}`,
                scale: row.scale ?? 1,
              });
              localGeneratedTrees++;
            }
          }
        const boundsCache = new Map<string, number>();
        const crowns = resources.map((row) => {
          const def = getExternalResource(row.resourceId);
          if (!def) throw Error(`Missing actual resource ${row.resourceId}`);
          const models = [
            def.modelPath,
            ...(def.modelVariants ?? []),
            def.lod1ModelPath,
            def.lod2ModelPath,
          ].filter((model): model is string => typeof model === "string");
          expect(models.length).toBeGreaterThan(0);
          let radius = 0;
          for (const model of new Set(models)) {
            let base = boundsCache.get(model);
            if (base === undefined) {
              base = modelBounds(model, 1).radius;
              boundsCache.set(model, base);
            }
            radius = Math.max(radius, base * def.scale * row.scale);
          }
          return { ...row, radius };
        });
        expect(crowns).toHaveLength(40 + localGeneratedTrees);
        for (const row of local)
          for (let i = 1; i < row.path.length; i++) {
            const a = row.path[i - 1],
              b = row.path[i],
              pad = row.width / 2 + row.blendWidth!;
            for (const water of waters)
              expect(
                compactPathSegmentDistance(
                  { x: water.centerX, z: water.centerZ },
                  a,
                  b,
                ) - pad,
              ).toBeGreaterThan(water.radius);
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
                  pad,
                ),
              ).toBe(false);
            for (const crown of crowns)
              expect(
                compactPathSegmentDistance(crown, a, b) - pad,
                `${row.id} ${crown.id}`,
              ).toBeGreaterThan(crown.radius);
          }
        const stored = roads.getRoads(),
          saved = stored.slice();
        let receipt: Record<string, unknown> = {};
        try {
          stored.splice(
            0,
            stored.length,
            ...paths.map((row) => ({
              ...saved[0],
              ...row,
              segmentSurfaces: row.segmentSurfaces?.map((surface) => ({
                ...surface,
              })),
              path: row.path.map((point) => ({ ...point })),
            })),
          );
          roads["buildTileCache"]();
          const segments = roads.getRoadSegmentsForGPU();
          expect(segments.length).toBeLessThanOrEqual(600);
          const bounds =
            roads["calculateAuthoredRoadMaskBounds"](segments) ??
            roads["calculateRoadMaskBounds"](segments);
          const resolution = roads["calculateRoadMaskTextureSize"](
            bounds.worldSize,
          );
          expect(resolution).toBe(name === "baseline" ? 256 : 512);
          const mask = roads.generateRoadInfluenceTexture(
            resolution,
            bounds.worldSize,
            0.5,
            bounds.centerX,
            bounds.centerZ,
          )!;
          expect(mask).toEqual(roads.getRoadInfluenceTextureData());
          expect(mask.data.byteLength).toBe(resolution * resolution * 4);
          const pixel = bounds.worldSize / resolution;
          let localSupportTexels = 0;
          for (let iz = 0; iz < resolution; iz++)
            for (let ix = 0; ix < resolution; ix++) {
              const x = ix * pixel - bounds.worldSize / 2 + bounds.centerX,
                z = iz * pixel - bounds.worldSize / 2 + bounds.centerZ;
              const index = iz * resolution + ix;
              // The real CPU texture is a Float32 sample of exactly the same
              // MAX-unioned per-segment field used by road/grass owners.
              expect(mask.data[index]).toBe(
                Math.fround(roads.getRoadInfluenceAt(x, z)),
              );
              if (sample(local, x, z) === 0) continue;
              localSupportTexels++;
              const support = {
                minX: x - 0.5 * pixel,
                maxX: x + 1.5 * pixel,
                minZ: z - 0.5 * pixel,
                maxZ: z + 1.5 * pixel,
              };
              const distance = (cx: number, cz: number) =>
                Math.hypot(
                  Math.max(support.minX - cx, 0, cx - support.maxX),
                  Math.max(support.minZ - cz, 0, cz - support.maxZ),
                );
              for (const water of waters)
                expect(distance(water.centerX, water.centerZ)).toBeGreaterThan(
                  water.radius,
                );
              for (const crown of crowns)
                expect(
                  distance(crown.x, crown.z),
                  `${crown.id} filtered support`,
                ).toBeGreaterThan(crown.radius);
              for (const floor of floors)
                expect(
                  support.maxX > floor.centerX - floor.width / 2 &&
                    support.minX < floor.centerX + floor.width / 2 &&
                    support.maxZ > floor.centerZ - floor.depth / 2 &&
                    support.minZ < floor.centerZ + floor.depth / 2,
                ).toBe(false);
            }
          expect(localSupportTexels).toBeGreaterThan(0);
          const fieldProbes = [
            [348, 318],
            [350, 320],
            [352, 322],
            [350, 324],
            [350, 326],
          ].map(([x, z]) => ({
            x,
            z,
            analytical: roads.getRoadInfluenceAt(x, z),
            filtered: sampleLinearMask(mask.data, bounds, x, z),
          }));
          expect(
            fieldProbes.every((p) => p.analytical > 0 && p.filtered > 0),
          ).toBe(true);
          receipt = {
            name,
            previousSegments: name === "baseline" ? 292 : 568,
            currentSegments: segments.length,
            resolution,
            bounds,
            maskBytes: mask.data.byteLength,
            localSupportTexels,
            analyticalCounts: { partial, full, zero },
            authoredTrees: 40,
            adjacentSeededTrees: localGeneratedTrees,
            boundedCrownCensus: crowns.length,
            modelHeaders: boundsCache.size,
            nearestTree: crowns.sort(
              (a, b) =>
                Math.hypot(a.x - 350, a.z - 320) -
                Math.hypot(b.x - 350, b.z - 320),
            )[0],
            fieldProbes,
          };
        } finally {
          stored.splice(0, stored.length, ...saved);
          roads["buildTileCache"]();
        }
        expect(JSON.stringify(areas)).toBe(originalAreas);
        expect(
          Array.from({ length: 121 }, (_, i) =>
            terrain.getHeightAt(345 + (i % 11), 316 + Math.floor(i / 11)),
          ),
        ).toEqual(beforeHeights);
        process.stdout.write(
          "Bank pavilion ground field (CPU/mask support, not grass density/native art acceptance) " +
            JSON.stringify(receipt) +
            "\n",
        );
      });
    },
  );
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
