#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";

import { TERRAIN_CONSTANTS } from "../packages/shared/src/constants/GameConstants";
import { GATHERING_CONSTANTS } from "../packages/shared/src/constants/GatheringConstants";
import { DataManager } from "../packages/shared/src/data/DataManager";
import { stationDataProvider } from "../packages/shared/src/data/StationDataProvider";
import { ALL_WORLD_AREAS } from "../packages/shared/src/data/world-areas";
import { BFSPathfinder } from "../packages/shared/src/systems/shared/movement/BFSPathfinder";
import { CollisionFlag } from "../packages/shared/src/systems/shared/movement/CollisionFlags";
import { CollisionMatrix } from "../packages/shared/src/systems/shared/movement/CollisionMatrix";
import {
  TICK_DURATION_MS,
  TILES_PER_TICK_RUN,
  TILES_PER_TICK_WALK,
  tileToWorld,
  worldToTile,
} from "../packages/shared/src/systems/shared/movement/TileSystem";
import { TerrainSystem } from "../packages/shared/src/systems/shared/world/TerrainSystem";
import { WaterBodyRegistry } from "../packages/shared/src/systems/shared/world/WaterBodyRegistry";
import type {
  MobSpawnPoint,
  WorldArea,
} from "../packages/shared/src/types/world/world-types";
import { resolveFootprint } from "../packages/shared/src/types/game/resource-processing-types";
import { findFishingSpotTiles } from "../packages/shared/src/utils/ShoreUtils";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
process.env.ASSETS_DIR ??= path.join(
  workspaceRoot,
  "packages/server/world/assets",
);

type Tile = { x: number; z: number };
type RouteTarget = {
  id: string;
  kind: "npc" | "store" | "station" | "resource" | "mob" | "fishing";
  position: { x: number; z: number };
  approachRadius: number;
  approachMode: "radius" | "cardinal" | "nearest";
  mustOccupyWalkableTile: boolean;
};

const isFishingResource = (resourceId: string): boolean =>
  resourceId.startsWith("fishing_spot_");

const REQUIRED_PREPARATION_FISHING_SPOT_TYPES = new Set([
  "fishing_spot_net",
  "fishing_spot_bait",
  "fishing_spot_fly",
  "fishing_spot_cage",
  "fishing_spot_harpoon",
]);

type TerrainInternals = {
  waterBodyRegistry: WaterBodyRegistry;
  ensureNoiseInitialized(): void;
  initializeTerrainGenerator(): void;
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  bakeWalkabilityFlags(tileX: number, tileZ: number): void;
  worldToTerrainTileIndex(worldCoordinate: number): number;
};

// The live behavior loop should never need to chain partial routes inside the
// compact preparation complex. Keep a margin below the pathfinder's 4,000
// iteration emergency ceiling so asset drift fails CI before it becomes an
// event-loop or movement-latency problem in production.
const MAX_ROUTE_REQUESTS = 1;
const MAX_ROUTE_ITERATIONS = 3_600;
// A route request can arrive just after an authoritative movement tick, so the
// worst-case wall clock includes one scheduling tick before path consumption.
// Physical clicks may walk; embedded preparation agents always run. Keep both
// paths bounded below the 20-tick PendingGather timeout with explicit margin.
const MAX_WALK_ROUTE_WALL_CLOCK_MS = 10_800;
const MAX_AGENT_RUN_ROUTE_WALL_CLOCK_MS = 6_000;
// The active harpoon strike first reaches 0.312m below the avatar's footing at
// its impact sample. Keep every possible bank within that proven contact
// envelope, with a small tolerance for terrain interpolation.
const MAX_FISHING_FOOT_HEIGHT_ABOVE_WATER = 0.3;
const MIN_FISHING_WATER_DEPTH_AT_TARGET = 0.75;

function createApproachTiles(
  target: Tile,
  radius: number,
  isWalkable: (tile: Tile) => boolean,
  mode: RouteTarget["approachMode"],
): Tile[] {
  if (mode === "cardinal") {
    return [
      { x: target.x - 1, z: target.z },
      { x: target.x, z: target.z - 1 },
      { x: target.x, z: target.z + 1 },
      { x: target.x + 1, z: target.z },
    ].filter(isWalkable);
  }
  if (mode === "nearest") {
    if (isWalkable(target)) return [target];
    for (let searchRadius = 1; searchRadius <= radius; searchRadius++) {
      const candidates: Array<{ tile: Tile; distance: number }> = [];
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        for (let dz = -searchRadius; dz <= searchRadius; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== searchRadius) continue;
          const tile = { x: target.x + dx, z: target.z + dz };
          if (!isWalkable(tile)) continue;
          candidates.push({
            tile,
            distance: Math.sqrt(dx * dx + dz * dz),
          });
        }
      }
      candidates.sort((left, right) => left.distance - right.distance);
      if (candidates[0]) return [candidates[0].tile];
    }
    return [];
  }
  const destinations: Tile[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) > radius) continue;
      const tile = { x: target.x + dx, z: target.z + dz };
      if (isWalkable(tile)) destinations.push(tile);
    }
  }
  return destinations;
}

function deterministicMobPositions(spawn: MobSpawnPoint) {
  const count = spawn.maxCount ?? 1;
  const radius = spawn.spawnRadius > 0 ? spawn.spawnRadius : count > 1 ? 2 : 0;
  return Array.from({ length: count }, (_, index) => {
    const angle = count > 1 ? (index / count) * Math.PI * 2 : 0;
    return {
      x: spawn.position.x + (count > 1 ? Math.cos(angle) * radius : 0),
      z: spawn.position.z + (count > 1 ? Math.sin(angle) * radius : 0),
    };
  });
}

await DataManager.getInstance().initialize();

const hub = ALL_WORLD_AREAS.central_haven;
const pond = ALL_WORLD_AREAS.haven_pond;
const training = ALL_WORLD_AREAS.preparation_training_grounds;
if (!hub || !pond || !training) {
  throw new Error(
    "Preparation topology requires central_haven, haven_pond, and preparation_training_grounds",
  );
}

const collision = new CollisionMatrix();
const world = {
  config: { terrainSeed: 0 },
  collision,
  network: { isServer: true },
  entities: { players: new Map() },
  getSystem: () => null,
  on: () => undefined,
  off: () => undefined,
};
const terrain = new TerrainSystem(world as never);
const internals = terrain as unknown as TerrainInternals;
internals.ensureNoiseInitialized();
internals.initializeTerrainGenerator();
internals.waterBodyRegistry = new WaterBodyRegistry(
  TERRAIN_CONSTANTS.WATER_THRESHOLD,
);
internals.loadWaterBodiesFromManifest();
internals.loadFlatZonesFromManifest();

const preparationAreas: WorldArea[] = [hub, pond, training];
const minX = Math.min(...preparationAreas.map((area) => area.bounds.minX));
const maxX = Math.max(...preparationAreas.map((area) => area.bounds.maxX));
const minZ = Math.min(...preparationAreas.map((area) => area.bounds.minZ));
const maxZ = Math.max(...preparationAreas.map((area) => area.bounds.maxZ));
const minTileX = internals.worldToTerrainTileIndex(minX);
const maxTileX = internals.worldToTerrainTileIndex(maxX);
const minTileZ = internals.worldToTerrainTileIndex(minZ);
const maxTileZ = internals.worldToTerrainTileIndex(maxZ);
for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
  for (let tileZ = minTileZ; tileZ <= maxTileZ; tileZ++) {
    internals.bakeWalkabilityFlags(tileX, tileZ);
  }
}

// Match TileMovementManager's ground-floor authority: collision is the fast
// rejection path, while live terrain still rejects locally submerged or
// over-steep tiles that have no baked flag. There are no bridge, dock, or
// building-floor overrides inside this audited preparation complex.
const terrainWalkabilityCache = new Map<string, boolean>();
const isRuntimeWalkable = (tile: Tile): boolean => {
  if (!collision.isWalkable(tile.x, tile.z)) return false;
  const key = `${tile.x},${tile.z}`;
  const cached = terrainWalkabilityCache.get(key);
  if (cached !== undefined) return cached;
  const worldPosition = tileToWorld(tile);
  const walkable = terrain.isPositionWalkableFast(
    worldPosition.x,
    worldPosition.z,
  );
  terrainWalkabilityCache.set(key, walkable);
  return walkable;
};

const failures: string[] = [];
const staticTileOwners = new Map<string, string>();
const registerStaticFootprint = (
  owner: string,
  center: Tile,
  width: number,
  depth: number,
) => {
  const offsetX = Math.floor(width / 2);
  const offsetZ = Math.floor(depth / 2);
  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      const tile = {
        x: center.x + dx - offsetX,
        z: center.z + dz - offsetZ,
      };
      const key = `${tile.x},${tile.z}`;
      if (!isRuntimeWalkable(tile)) {
        failures.push(
          `${owner} occupies blocked terrain at (${tile.x}, ${tile.z})`,
        );
      }
      const existingOwner = staticTileOwners.get(key);
      if (existingOwner) {
        failures.push(
          `${owner} physically overlaps ${existingOwner} at (${tile.x}, ${tile.z})`,
        );
      } else {
        staticTileOwners.set(key, owner);
      }
      collision.addFlags(tile.x, tile.z, CollisionFlag.BLOCKED);
    }
  }
};

for (const area of preparationAreas) {
  for (const resource of area.resources ?? []) {
    // Fishing entities belong just inside visible water and therefore must
    // not reserve or require a walkable land footprint.
    if (isFishingResource(resource.resourceId)) continue;
    registerStaticFootprint(
      `resource ${resource.resourceId}`,
      worldToTile(resource.position.x, resource.position.z),
      1,
      1,
    );
  }
  for (const station of area.stations ?? []) {
    const size = resolveFootprint(
      stationDataProvider.getFootprint(station.type),
    );
    registerStaticFootprint(
      `station ${station.id}`,
      worldToTile(station.position.x, station.position.z),
      size.x,
      size.z,
    );
  }
}

const start = worldToTile(
  (hub.bounds.minX + hub.bounds.maxX) / 2,
  (hub.bounds.minZ + hub.bounds.maxZ) / 2,
);
if (!isRuntimeWalkable(start)) {
  failures.push(`spawn tile (${start.x}, ${start.z}) is not walkable`);
}

const routeTargets: RouteTarget[] = [];
for (const area of preparationAreas) {
  for (const npc of area.npcs ?? []) {
    routeTargets.push({
      id: npc.storeId ?? npc.id,
      kind: npc.storeId ? "store" : "npc",
      position: npc.position,
      approachRadius: npc.storeId ? 5 : 3,
      approachMode: "radius",
      mustOccupyWalkableTile: true,
    });
  }
  for (const station of area.stations ?? []) {
    routeTargets.push({
      id: station.id,
      kind: "station",
      position: station.position,
      approachRadius: 3,
      approachMode: "radius",
      mustOccupyWalkableTile: false,
    });
  }
  for (const resource of area.resources ?? []) {
    const fishing = isFishingResource(resource.resourceId);
    routeTargets.push({
      id: resource.resourceId,
      kind: fishing ? "fishing" : "resource",
      position: resource.position,
      approachRadius: fishing ? 10 : 1,
      approachMode: fishing ? "nearest" : "cardinal",
      mustOccupyWalkableTile: false,
    });
  }
  for (const spawn of area.mobSpawns ?? []) {
    routeTargets.push({
      id: spawn.mobId,
      kind: "mob",
      position: spawn.position,
      approachRadius: Math.max(1, spawn.spawnRadius),
      approachMode: "radius",
      mustOccupyWalkableTile: true,
    });
  }
}

const waterRegistry = terrain.getWaterBodyRegistry();
const allShorePoints = findFishingSpotTiles(
  collision,
  pond.bounds,
  terrain.getHeightAt.bind(terrain),
  waterRegistry.getWaterSurfaceAt.bind(waterRegistry),
  GATHERING_CONSTANTS.FISHING_SPOT_MOVE.shoreMinSpacing,
);
const authoredFishingResources = (pond.resources ?? []).filter((resource) =>
  isFishingResource(resource.resourceId),
);
const configuredFishingSpotTypes = new Set([
  ...authoredFishingResources.map((resource) => resource.resourceId),
  ...(pond.fishing?.spotTypes ?? []),
]);
for (const requiredSpotType of REQUIRED_PREPARATION_FISHING_SPOT_TYPES) {
  if (!configuredFishingSpotTypes.has(requiredSpotType)) {
    failures.push(
      `haven_pond does not expose required preparation method ${requiredSpotType}`,
    );
  }
}
const authoredFishingTiles = new Set(
  authoredFishingResources.map((resource) => {
    const tile = worldToTile(resource.position.x, resource.position.z);
    return `${tile.x},${tile.z}`;
  }),
);
for (const resource of authoredFishingResources) {
  const authoredTile = worldToTile(resource.position.x, resource.position.z);
  const matchesDiscoveredShore = allShorePoints.some((point) => {
    const discoveredTile = worldToTile(point.x, point.z);
    return (
      discoveredTile.x === authoredTile.x && discoveredTile.z === authoredTile.z
    );
  });
  if (!matchesDiscoveredShore) {
    failures.push(
      `authored fishing resource ${resource.resourceId} at (${resource.position.x}, ${resource.position.z}) does not match a collision-derived visible shore tile`,
    );
  }
}
const shorePoints = allShorePoints.filter((point) => {
  const tile = worldToTile(point.x, point.z);
  return !authoredFishingTiles.has(`${tile.x},${tile.z}`);
});
const requiredFishingSpots = pond.fishing?.spotCount ?? 0;
if (shorePoints.length < requiredFishingSpots) {
  failures.push(
    `haven_pond exposes ${shorePoints.length} valid shore positions but requires ${requiredFishingSpots}`,
  );
}
// Runtime shuffles the valid shore set before selecting the configured count,
// so every possible authored spawn must pass rather than only the first N.
for (let index = 0; index < shorePoints.length; index++) {
  const point = shorePoints[index];
  if (!point) break;
  routeTargets.push({
    id: `haven_pond_shore_${index + 1}`,
    kind: "fishing",
    position: point,
    approachRadius: 10,
    approachMode: "nearest",
    mustOccupyWalkableTile: false,
  });
}

function combinations<T>(values: readonly T[], size: number): T[][] {
  if (size <= 0) return [[]];
  const result: T[][] = [];
  const current: T[] = [];
  const visit = (start: number): void => {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    for (let index = start; index < values.length; index++) {
      current.push(values[index]);
      visit(index + 1);
      current.pop();
    }
  };
  visit(0);
  return result;
}

const fishingSelections = combinations(
  shorePoints,
  Math.min(requiredFishingSpots, shorePoints.length),
);
const relocationPositions = new Map<
  string,
  { x: number; y: number; z: number }
>();
let minFishingRelocationCandidates = Number.POSITIVE_INFINITY;
const { relocateRadius, relocateMinDistance } =
  GATHERING_CONSTANTS.FISHING_SPOT_MOVE;
for (
  let selectionIndex = 0;
  selectionIndex < fishingSelections.length;
  selectionIndex++
) {
  const selection = fishingSelections[selectionIndex];
  for (let spotIndex = 0; spotIndex < selection.length; spotIndex++) {
    const spot = selection[spotIndex];
    const occupiedTiles = new Set(
      [
        ...authoredFishingResources.map((resource) => resource.position),
        ...selection.filter((_, index) => index !== spotIndex),
      ].map((other) => {
        const tile = worldToTile(other.x, other.z);
        return `${tile.x},${tile.z}`;
      }),
    );
    const localCandidates = findFishingSpotTiles(
      collision,
      {
        minX: spot.x - relocateRadius,
        maxX: spot.x + relocateRadius,
        minZ: spot.z - relocateRadius,
        maxZ: spot.z + relocateRadius,
      },
      terrain.getHeightAt.bind(terrain),
      waterRegistry.getWaterSurfaceAt.bind(waterRegistry),
      GATHERING_CONSTANTS.FISHING_SPOT_MOVE.shoreMinSpacing,
    ).filter((candidate) => {
      const distance = Math.hypot(candidate.x - spot.x, candidate.z - spot.z);
      const tile = worldToTile(candidate.x, candidate.z);
      return (
        distance >= relocateMinDistance &&
        distance <= relocateRadius &&
        !occupiedTiles.has(`${tile.x},${tile.z}`)
      );
    });
    minFishingRelocationCandidates = Math.min(
      minFishingRelocationCandidates,
      localCandidates.length,
    );
    if (localCandidates.length === 0) {
      failures.push(
        `haven_pond selection ${selectionIndex + 1} spot (${spot.x}, ${spot.z}) has no bounded collision-free relocation candidate`,
      );
    }
    for (const candidate of localCandidates) {
      const tile = worldToTile(candidate.x, candidate.z);
      relocationPositions.set(`${tile.x},${tile.z}`, candidate);
    }
  }
}
for (const [key, position] of relocationPositions) {
  routeTargets.push({
    id: `haven_pond_relocation_${key}`,
    kind: "fishing",
    position,
    approachRadius: 10,
    approachMode: "nearest",
    mustOccupyWalkableTile: false,
  });
}
if (!Number.isFinite(minFishingRelocationCandidates)) {
  minFishingRelocationCandidates = 0;
}

let maxRouteTiles = 0;
let maxRouteIterations = 0;
const gatherApproachTiles = new Set<string>();
const routeEvidence: Array<{
  id: string;
  kind: RouteTarget["kind"];
  targetX: number;
  targetZ: number;
  destinationCount: number;
  destinationTiles: string[];
  pathTiles: number;
  segments: number;
  iterations: number;
  fishingInteractionDistance?: number;
  fishingFootHeightAboveWater?: number;
  fishingWaterDepthAtTarget?: number;
  walkTicks: number;
  walkWallClockMs: number;
  runTicks: number;
  runWallClockMs: number;
}> = [];
let maxRouteSegments = 0;
let maxWalkTicks = 0;
let maxWalkWallClockMs = 0;
let maxRunTicks = 0;
let maxRunWallClockMs = 0;
let maxFishingInteractionDistance = 0;
let minFishingFootHeightAboveWater = Number.POSITIVE_INFINITY;
let maxFishingFootHeightAboveWater = Number.NEGATIVE_INFINITY;
let minFishingWaterDepthAtTarget = Number.POSITIVE_INFINITY;
for (const target of routeTargets) {
  const targetTile = worldToTile(target.position.x, target.position.z);
  if (target.mustOccupyWalkableTile && !isRuntimeWalkable(targetTile)) {
    failures.push(
      `${target.kind} ${target.id} occupies blocked terrain at (${targetTile.x}, ${targetTile.z})`,
    );
  }

  const destinations = createApproachTiles(
    targetTile,
    target.approachRadius,
    isRuntimeWalkable,
    target.approachMode,
  );
  if (destinations.length === 0) {
    failures.push(`${target.kind} ${target.id} has no walkable approach tile`);
    continue;
  }
  if (target.kind === "resource") {
    if (destinations.length < 2) {
      failures.push(
        `resource ${target.id} exposes only ${destinations.length} physical approach tile`,
      );
    }
    for (const tile of destinations) {
      gatherApproachTiles.add(`${tile.x},${tile.z}`);
    }
  } else if (target.kind === "fishing") {
    for (const tile of destinations) {
      gatherApproachTiles.add(`${tile.x},${tile.z}`);
    }
  }

  let fishingInteractionDistance: number | undefined;
  let fishingFootHeightAboveWater: number | undefined;
  let fishingWaterDepthAtTarget: number | undefined;
  if (target.kind === "fishing") {
    const approachWorld = tileToWorld(destinations[0]);
    const waterSurfaceY = waterRegistry.getWaterSurfaceAt(
      target.position.x,
      target.position.z,
    );
    const targetTerrainY = terrain.getHeightAt(
      target.position.x,
      target.position.z,
    );
    fishingInteractionDistance = Math.hypot(
      approachWorld.x - target.position.x,
      approachWorld.z - target.position.z,
    );
    fishingFootHeightAboveWater =
      terrain.getHeightAt(approachWorld.x, approachWorld.z) - waterSurfaceY;
    fishingWaterDepthAtTarget = waterSurfaceY - targetTerrainY;
    maxFishingInteractionDistance = Math.max(
      maxFishingInteractionDistance,
      fishingInteractionDistance,
    );
    minFishingFootHeightAboveWater = Math.min(
      minFishingFootHeightAboveWater,
      fishingFootHeightAboveWater,
    );
    maxFishingFootHeightAboveWater = Math.max(
      maxFishingFootHeightAboveWater,
      fishingFootHeightAboveWater,
    );
    minFishingWaterDepthAtTarget = Math.min(
      minFishingWaterDepthAtTarget,
      fishingWaterDepthAtTarget,
    );
    if (
      fishingInteractionDistance > GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE
    ) {
      failures.push(
        `fishing ${target.id} requires ${fishingInteractionDistance.toFixed(3)}m reach, exceeding ${GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE}m`,
      );
    }
    if (fishingFootHeightAboveWater < 0) {
      failures.push(
        `fishing ${target.id} approach is ${Math.abs(fishingFootHeightAboveWater).toFixed(3)}m below the water surface`,
      );
    }
    if (fishingFootHeightAboveWater > MAX_FISHING_FOOT_HEIGHT_ABOVE_WATER) {
      failures.push(
        `fishing ${target.id} bank is ${fishingFootHeightAboveWater.toFixed(3)}m above water, exceeding the ${MAX_FISHING_FOOT_HEIGHT_ABOVE_WATER}m motion-contact envelope`,
      );
    }
    if (fishingWaterDepthAtTarget < MIN_FISHING_WATER_DEPTH_AT_TARGET) {
      failures.push(
        `fishing ${target.id} exposes only ${fishingWaterDepthAtTarget.toFixed(3)}m visible depth; ${MIN_FISHING_WATER_DEPTH_AT_TARGET}m is required`,
      );
    }
  }

  let current = start;
  let reached = destinations.some(
    (tile) => tile.x === current.x && tile.z === current.z,
  );
  let routeTiles = 0;
  let routeSegments = 0;
  let routeMaxIterations = 0;
  while (!reached && routeSegments < MAX_ROUTE_REQUESTS) {
    const pathfinder = new BFSPathfinder();
    const path = pathfinder.findPathToAny(
      current,
      destinations,
      isRuntimeWalkable,
      MAX_ROUTE_ITERATIONS,
    );
    routeSegments++;
    routeTiles += path.length;
    routeMaxIterations = Math.max(
      routeMaxIterations,
      pathfinder.getLastIterationsUsed(),
    );
    const finalTile = path.at(-1);
    if (!finalTile) break;
    if (finalTile.x === current.x && finalTile.z === current.z) break;
    current = finalTile;
    reached = destinations.some(
      (tile) => tile.x === current.x && tile.z === current.z,
    );
  }
  if (!reached) {
    failures.push(
      `${target.kind} ${target.id} is not fully reachable within ${MAX_ROUTE_REQUESTS} authoritative route request and ${MAX_ROUTE_ITERATIONS} iterations`,
    );
  }

  maxRouteTiles = Math.max(maxRouteTiles, routeTiles);
  maxRouteIterations = Math.max(maxRouteIterations, routeMaxIterations);
  maxRouteSegments = Math.max(maxRouteSegments, routeSegments);
  const walkTicks = Math.ceil(routeTiles / TILES_PER_TICK_WALK);
  const runTicks = Math.ceil(routeTiles / TILES_PER_TICK_RUN);
  const walkWallClockMs =
    routeTiles === 0 ? 0 : (walkTicks + 1) * TICK_DURATION_MS;
  const runWallClockMs =
    routeTiles === 0 ? 0 : (runTicks + 1) * TICK_DURATION_MS;
  maxWalkTicks = Math.max(maxWalkTicks, walkTicks);
  maxWalkWallClockMs = Math.max(maxWalkWallClockMs, walkWallClockMs);
  maxRunTicks = Math.max(maxRunTicks, runTicks);
  maxRunWallClockMs = Math.max(maxRunWallClockMs, runWallClockMs);
  if (walkWallClockMs > MAX_WALK_ROUTE_WALL_CLOCK_MS) {
    failures.push(
      `${target.kind} ${target.id} requires ${walkWallClockMs}ms worst-case walking time, exceeding ${MAX_WALK_ROUTE_WALL_CLOCK_MS}ms`,
    );
  }
  if (runWallClockMs > MAX_AGENT_RUN_ROUTE_WALL_CLOCK_MS) {
    failures.push(
      `${target.kind} ${target.id} requires ${runWallClockMs}ms worst-case agent run time, exceeding ${MAX_AGENT_RUN_ROUTE_WALL_CLOCK_MS}ms`,
    );
  }
  routeEvidence.push({
    id: target.id,
    kind: target.kind,
    targetX: target.position.x,
    targetZ: target.position.z,
    destinationCount: destinations.length,
    destinationTiles: destinations.map((tile) => `${tile.x},${tile.z}`),
    pathTiles: routeTiles,
    segments: routeSegments,
    iterations: routeMaxIterations,
    fishingInteractionDistance,
    fishingFootHeightAboveWater,
    fishingWaterDepthAtTarget,
    walkTicks,
    walkWallClockMs,
    runTicks,
    runWallClockMs,
  });
}

if (gatherApproachTiles.size < 25) {
  failures.push(
    `preparation topology exposes only ${gatherApproachTiles.size} unique gathering approach tiles; 25 are required`,
  );
}

let validatedMobInstances = 0;
for (const spawn of training.mobSpawns ?? []) {
  for (const position of deterministicMobPositions(spawn)) {
    validatedMobInstances++;
    const tile = worldToTile(position.x, position.z);
    if (!isRuntimeWalkable(tile)) {
      failures.push(
        `training mob ${spawn.mobId} instance lands on blocked terrain at (${tile.x}, ${tile.z})`,
      );
    }
    const difficulty = terrain.getDifficultyAtWorldPosition(
      position.x,
      position.z,
      training.difficultyLevel,
    );
    if (difficulty.isSafe || difficulty.level <= 0) {
      failures.push(
        `training mob ${spawn.mobId} instance is suppressed by runtime safety at (${position.x.toFixed(2)}, ${position.z.toFixed(2)})`,
      );
    }
  }
}

let walkableTiles = 0;
let totalTiles = 0;
for (let x = Math.floor(minX); x < Math.ceil(maxX); x++) {
  for (let z = Math.floor(minZ); z < Math.ceil(maxZ); z++) {
    totalTiles++;
    if (isRuntimeWalkable({ x, z })) walkableTiles++;
  }
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures,
        routeTargets: routeTargets.length,
        routeRequestBudget: MAX_ROUTE_REQUESTS,
        routeIterationBudget: MAX_ROUTE_ITERATIONS,
        maxWalkRouteWallClockMs: MAX_WALK_ROUTE_WALL_CLOCK_MS,
        maxAgentRunRouteWallClockMs: MAX_AGENT_RUN_ROUTE_WALL_CLOCK_MS,
        authoredFishingSpots: authoredFishingResources.length,
        totalFishingShorePoints: allShorePoints.length,
        fishingShorePoints: shorePoints.length,
        fishingSpawnSelections: fishingSelections.length,
        fishingRelocationPositions: relocationPositions.size,
        minFishingRelocationCandidates,
        maxFishingInteractionDistance,
        minFishingFootHeightAboveWater,
        maxFishingFootHeightAboveWater,
        minFishingWaterDepthAtTarget,
        validatedMobInstances,
        staticOccupiedTiles: staticTileOwners.size,
        uniqueGatherApproachTiles: gatherApproachTiles.size,
        routes: routeEvidence,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      ok: true,
      terrainSeed: 0,
      preparationBounds: { minX, maxX, minZ, maxZ },
      routeTargets: routeTargets.length,
      routeRequestBudget: MAX_ROUTE_REQUESTS,
      routeIterationBudget: MAX_ROUTE_ITERATIONS,
      authoredFishingSpots: authoredFishingResources.length,
      totalFishingShorePoints: allShorePoints.length,
      fishingShorePoints: shorePoints.length,
      fishingSpawnSelections: fishingSelections.length,
      fishingRelocationPositions: relocationPositions.size,
      minFishingRelocationCandidates,
      maxFishingInteractionDistance,
      minFishingFootHeightAboveWater,
      maxFishingFootHeightAboveWater,
      minFishingWaterDepthAtTarget,
      validatedMobInstances,
      staticOccupiedTiles: staticTileOwners.size,
      uniqueGatherApproachTiles: gatherApproachTiles.size,
      maxRouteTiles,
      maxRouteIterations,
      maxRouteSegments,
      maxWalkRouteWallClockMs: MAX_WALK_ROUTE_WALL_CLOCK_MS,
      maxAgentRunRouteWallClockMs: MAX_AGENT_RUN_ROUTE_WALL_CLOCK_MS,
      maxWalkTicks,
      maxWalkWallClockMs,
      maxRunTicks,
      maxRunWallClockMs,
      walkableTiles,
      totalTiles,
      routes: routeEvidence,
    }),
  );
}
