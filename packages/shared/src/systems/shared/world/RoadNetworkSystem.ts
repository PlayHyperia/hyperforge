/**
 * RoadNetworkSystem - Procedural Road Generation
 * Uses MST + BFS pathfinding + Chaikin smoothing for organic roads.
 *
 * Configuration loaded from world-config.json via DataManager.
 * IMPORTANT: DataManager.loadManifests*() must be called BEFORE RoadNetworkSystem.init()
 * otherwise default configuration values will be used.
 *
 * **Worker Optimization:**
 * - Path smoothing (Chaikin algorithm) is offloaded to ProcgenWorker
 * - BFS pathfinding remains on main thread due to terrain height dependency
 * - Future: Could pre-compute passability grid and move BFS to worker
 */

import * as THREE from "three";
import { System } from "../infrastructure/System";
import type { World } from "../../../core/World";
import type {
  ProceduralRoad,
  ProceduralTown,
  RoadPathPoint,
  RoadTileSegment,
  RoadNetwork,
  PointOfInterest,
  RoadEndpointType,
  RoadBoundaryExit,
  TileEdge,
  WorldConfigManifest,
} from "../../../types/world/world-types";
import { NoiseGenerator } from "../../../utils/NoiseGenerator";
import type { TownSystem } from "./TownSystem";
import type { POISystem } from "./POISystem";
import { EventType } from "../../../types/events";
import { Logger } from "../../../utils/Logger";
import { DataManager } from "../../../data/DataManager";
import { getDuelArenaConfig } from "../../../data/duel-manifest";
import { createCompactIslandPaths } from "./CompactIslandPaths";
import { roadInfluenceOperations } from "./RoadInfluence";
import {
  smoothPathAsync,
  isProcgenWorkerAvailable,
} from "../../../utils/workers";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import {
  getGlobalTerrainComputeContext,
  type GPURoadSegment,
} from "../../../utils/compute";

// Default configuration values
const DEFAULTS = {
  roadWidth: 6, // 6m wide roads for better visibility
  pathStepSize: 20,
  maxPathIterations: 10000,
  extraConnectionsRatio: 0.25,
  costBase: 1.0,
  costSlopeMultiplier: 5.0,
  costWaterPenalty: 1000,
  smoothingIterations: 2,
  noiseDisplacementScale: 0.01,
  noiseDisplacementStrength: 3,
  minPointSpacing: 4,
  heuristicWeight: 2.5,
  // Exploration road settings
  minRoadsPerTown: 2, // Minimum roads from each town
  explorationRoadLength: 150, // How far exploration roads extend
  explorationRoadSearchRadius: 300, // Search radius for natural destinations
} as const;

const DEFAULT_BIOME_COSTS: Record<string, number> = {
  forest: 1.0,
  tundra: 1.5,
  canyon: 2.0,
};

// Road mask generation settings (shared across terrain/grass/flowers)
const ROAD_MASK_BLEND_WIDTH = 0.5; // Extra blend beyond road edge
const ROAD_MASK_MIN_TEXTURE_SIZE = 256;
const ROAD_MASK_MAX_TEXTURE_SIZE = 4096;
const ROAD_MASK_MIN_PIXELS_PER_INFLUENCE = 2;

/** Road configuration loaded from world-config.json (exported for testing) */
export interface RoadConfig {
  roadWidth: number;
  pathStepSize: number;
  maxPathIterations: number;
  extraConnectionsRatio: number;
  costBase: number;
  costSlopeMultiplier: number;
  costWaterPenalty: number;
  smoothingIterations: number;
  noiseDisplacementScale: number;
  noiseDisplacementStrength: number;
  minPointSpacing: number;
  heuristicWeight: number;
  biomeCosts: Record<string, number>;
}

/** Project a supplied manifest, or the admitted startup manifest, into road settings. */
export function loadRoadConfig(
  worldConfig: WorldConfigManifest | null = DataManager.getWorldConfig(),
): RoadConfig {
  const manifest = worldConfig?.roads;
  const biomeCosts = { ...DEFAULT_BIOME_COSTS };
  if (manifest?.costBiomeMultipliers) {
    Object.assign(biomeCosts, manifest.costBiomeMultipliers);
  }
  return {
    roadWidth: manifest?.roadWidth ?? DEFAULTS.roadWidth,
    pathStepSize: manifest?.pathStepSize ?? DEFAULTS.pathStepSize,
    maxPathIterations:
      manifest?.maxPathIterations ?? DEFAULTS.maxPathIterations,
    extraConnectionsRatio:
      manifest?.extraConnectionsRatio ?? DEFAULTS.extraConnectionsRatio,
    costBase: manifest?.costBase ?? DEFAULTS.costBase,
    costSlopeMultiplier:
      manifest?.costSlopeMultiplier ?? DEFAULTS.costSlopeMultiplier,
    costWaterPenalty: manifest?.costWaterPenalty ?? DEFAULTS.costWaterPenalty,
    smoothingIterations:
      manifest?.smoothingIterations ?? DEFAULTS.smoothingIterations,
    noiseDisplacementScale:
      manifest?.noiseDisplacementScale ?? DEFAULTS.noiseDisplacementScale,
    noiseDisplacementStrength:
      manifest?.noiseDisplacementStrength ?? DEFAULTS.noiseDisplacementStrength,
    minPointSpacing: manifest?.minPointSpacing ?? DEFAULTS.minPointSpacing,
    heuristicWeight: manifest?.heuristicWeight ?? DEFAULTS.heuristicWeight,
    biomeCosts,
  };
}

/** Generate A* pathfinding directions from step size (exported for testing) */
export function getDirections(
  stepSize: number,
): Array<{ dx: number; dz: number }> {
  return [
    { dx: stepSize, dz: 0 },
    { dx: -stepSize, dz: 0 },
    { dx: 0, dz: stepSize },
    { dx: 0, dz: -stepSize },
    { dx: stepSize, dz: stepSize },
    { dx: stepSize, dz: -stepSize },
    { dx: -stepSize, dz: stepSize },
    { dx: -stepSize, dz: -stepSize },
  ];
}

const TILE_SIZE = 100;
const WATER_THRESHOLD = TERRAIN_CONSTANTS.WATER_THRESHOLD;

const dist2D = (x1: number, z1: number, x2: number, z2: number): number =>
  Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);

export const roadSegmentInfluence = roadInfluenceOperations.sampleSegment;

/** Simple BFS path node */
interface BFSNode {
  x: number;
  z: number;
  parent: BFSNode | null;
}

interface Edge {
  fromId: string;
  toId: string;
  distance: number;
}

interface RoadInfluenceTextureData {
  data: Float32Array;
  width: number;
  height: number;
  worldSize: number;
  centerX: number;
  centerZ: number;
}

export class RoadNetworkSystem extends System {
  private roads: ProceduralRoad[] = [];
  private townSystem?: TownSystem;
  private poiSystem?: POISystem;
  private noise!: NoiseGenerator;
  private seed: number = 0;
  private randomState: number = 0;
  private _config!: RoadConfig;
  /** Road configuration - read-only access for external systems */
  get config(): RoadConfig {
    return this._config;
  }
  private directions!: Array<{ dx: number; dz: number }>;
  private terrainSystem?: {
    getHeightAt(x: number, z: number): number;
    getProceduralHeightAt?(x: number, z: number): number;
    getBiomeAtWorldPosition?(x: number, z: number): string;
  };
  private tileRoadCache = new Map<string, RoadTileSegment[]>();
  private cachedMaxRoadHalfWidth = 0;
  /** Cache for entry stub segments from adjacent tiles */
  private entryStubCache = new Map<string, RoadTileSegment[]>();
  /** Cache for merged [tile segments + entry stubs] to avoid per-vertex array allocations */
  private mergedTileSegmentCache = new Map<string, RoadTileSegment[]>();
  /** Road boundary exit points for cross-tile continuity */
  private boundaryExits: RoadBoundaryExit[] = [];
  /** World boundary (half the world size) */
  private worldHalfSize: number = 5000;
  private worldCenterX = 0;
  private worldCenterZ = 0;
  /** GPU-generated road influence texture (authoritative road mask) */
  private roadInfluenceTextureData: RoadInfluenceTextureData | null = null;
  /** Pre-computed passability grid for fast BFS pathfinding */
  private passabilityGrid: Set<string> | null = null;
  /** Whether passability grid is currently being built */
  private passabilityGridBuilding = false;
  /** Actual step size used for passability grid (may be larger than pathStepSize for big worlds) */
  private passabilityGridStepSize: number = 20;

  constructor(world: World) {
    super(world);
  }

  getDependencies() {
    return { required: ["terrain"], optional: ["towns", "pois"] };
  }

  async init(): Promise<void> {
    const worldConfig = (this.world as { config?: { terrainSeed?: number } })
      .config;
    this.seed = worldConfig?.terrainSeed ?? 0;
    this.randomState = this.seed;
    this.noise = new NoiseGenerator(this.seed + 54321);
    this._config = loadRoadConfig();
    this.directions = getDirections(this.config.pathStepSize);

    // Set world half size from terrain config (default: 5000m = 10km world)
    const terrainConfig = DataManager.getWorldConfig()?.terrain;
    const worldSize = terrainConfig?.worldSize ?? 100; // tiles
    const tileSize = terrainConfig?.tileSize ?? 100; // meters
    this.worldHalfSize = (worldSize * tileSize) / 2;
    const profile = DataManager.getWorldConfig()?.terrainProfile;
    if (profile?.algorithm === "compact-island-sculpt-v1") {
      this.worldCenterX = (profile.bounds.minX + profile.bounds.maxX) / 2;
      this.worldCenterZ = (profile.bounds.minZ + profile.bounds.maxZ) / 2;
    }

    this.terrainSystem = this.world.getSystem("terrain") as
      | {
          getHeightAt(x: number, z: number): number;
          getProceduralHeightAt?(x: number, z: number): number;
          getBiomeAtWorldPosition?(x: number, z: number): string;
        }
      | undefined;
    this.townSystem = this.world.getSystem("towns") as TownSystem | undefined;
    this.poiSystem = this.world.getSystem("pois") as POISystem | undefined;

    if (DataManager.getWorldConfig()?.roads) {
      Logger.system(
        "RoadNetworkSystem",
        `Config: ${this.config.roadWidth}m roads, ${this.config.extraConnectionsRatio} extra connections`,
      );
    }
  }

  async start(): Promise<void> {
    if (!this.terrainSystem)
      throw new Error("RoadNetworkSystem requires TerrainSystem");
    const profile = DataManager.getWorldConfig()?.terrainProfile;
    if (profile?.algorithm === "compact-island-sculpt-v1") {
      const paths = createCompactIslandPaths(
        profile,
        DataManager.getInstance().getAllWorldAreas(),
        getDuelArenaConfig(),
        (x, z) => this.terrainSystem!.getHeightAt(x, z),
      );
      this.roads = paths.map((path) => ({
        id: path.id,
        fromType: "poi",
        toType: "poi",
        fromTownId: "",
        toTownId: "",
        fromPOIId: path.fromId,
        toPOIId: path.toId,
        width: path.width,
        material: "dirt",
        path: path.path.map((point) => ({ ...point })),
        length: path.length,
      }));
      // The bounded authored network needs neither town procgen nor exploration stubs.
      this.boundaryExits = [];
      this.buildTileCache();
      this.world.emit(EventType.ROADS_GENERATED, {
        roadCount: this.roads.length,
        townCount: 0,
        poiCount: 0,
        explorationRoadCount: 0,
      });
      await this.buildRoadInfluenceMask();
      return;
    }
    if (!this.townSystem)
      throw new Error("RoadNetworkSystem requires TownSystem");

    const towns = this.townSystem.getTowns();
    if (towns.length === 0) {
      Logger.systemWarn("RoadNetworkSystem", "No towns for roads");
      // Still emit event so terrain can proceed with tile generation
      this.world.emit(EventType.ROADS_GENERATED, {
        roadCount: 0,
        townCount: 0,
        poiCount: 0,
        explorationRoadCount: 0,
      });
      // Build (dummy) road mask so vegetation can proceed without polling
      await this.buildRoadInfluenceMask();
      return;
    }

    // Generate roads - uses worker for path smoothing when available
    const startTime = performance.now();

    // Pre-compute passability grid for fast BFS pathfinding
    // This samples terrain height at all grid points once, avoiding repeated lookups
    await this.buildPassabilityGridAsync();

    // Phase 1: Generate town-to-town roads (MST + extra connections)
    // Only if we have 2+ towns
    if (towns.length >= 2) {
      await this.generateRoadNetworkAsync(towns);
    }
    const townRoadCount = this.roads.length;

    // Phase 2: Generate roads to important POIs
    const pois = this.poiSystem?.getImportantPOIs() ?? [];
    if (pois.length > 0) {
      await this.generatePOIRoadsAsync(towns, pois);
    }
    const poiRoadCount = this.roads.length - townRoadCount;

    // Phase 3: Generate exploration roads to natural features
    // This ensures towns with few connections still have roads leading somewhere
    await this.generateExplorationRoadsAsync(towns);
    const explorationRoadCount =
      this.roads.length - townRoadCount - poiRoadCount;

    const elapsed = performance.now() - startTime;

    // Validate connectivity only if we have multiple towns
    if (towns.length >= 2) {
      this.validateNetworkConnectivity(towns);
    }
    await this.buildTileCacheAsync();

    // Update signpost destinations now that roads are generated
    this.townSystem.updateSignpostDestinations(
      this.roads.map((r) => ({
        id: r.id,
        fromTownId: r.fromTownId,
        toTownId: r.toTownId,
      })),
    );

    Logger.system(
      "RoadNetworkSystem",
      `Generated ${this.roads.length} roads (${townRoadCount} town-town, ${poiRoadCount} town-POI, ${explorationRoadCount} exploration) connecting ${towns.length} towns and ${pois.length} POIs in ${elapsed.toFixed(0)}ms` +
        (isProcgenWorkerAvailable() ? " (worker-assisted)" : ""),
    );

    // DEBUG: Log town positions and which tiles they're in
    for (const town of towns) {
      const tileX = Math.floor(town.position.x / TILE_SIZE);
      const tileZ = Math.floor(town.position.z / TILE_SIZE);
      Logger.system(
        "RoadNetworkSystem",
        `Town "${town.name}" at (${town.position.x.toFixed(0)}, ${town.position.z.toFixed(0)}) -> tile (${tileX}, ${tileZ})`,
      );
    }

    this.world.emit(EventType.ROADS_GENERATED, {
      roadCount: this.roads.length,
      townCount: towns.length,
      poiCount: pois.length,
      explorationRoadCount,
    });

    // Generate authoritative road mask on GPU (shared across terrain/grass/flowers)
    await this.buildRoadInfluenceMask();
  }

  /**
   * Build authoritative road influence mask (GPU compute when available).
   */
  private async buildRoadInfluenceMask(): Promise<void> {
    if (!this.world.isClient) {
      return;
    }

    const roadSegments = this.getRoadSegmentsForGPU();
    if (roadSegments.length === 0) {
      // No roads: publish a dummy 1x1 mask so vegetation can proceed
      this.roadInfluenceTextureData = {
        data: new Float32Array([0]),
        width: 1,
        height: 1,
        worldSize: 1,
        centerX: 0,
        centerZ: 0,
      };
      this.world.emit(
        EventType.ROADS_MASK_READY,
        this.roadInfluenceTextureData,
      );
      return;
    }

    const bounds = this.calculateRoadMaskBounds(roadSegments);
    const worldSize = bounds.worldSize;
    const centerX = bounds.centerX;
    const centerZ = bounds.centerZ;
    const textureSize = this.calculateRoadMaskTextureSize(worldSize);

    const computeContext = getGlobalTerrainComputeContext();
    if (computeContext.isReady()) {
      const data = await computeContext.computeRoadInfluenceTexture(
        roadSegments,
        textureSize,
        worldSize,
        centerX,
        centerZ,
        ROAD_MASK_BLEND_WIDTH,
      );
      this.roadInfluenceTextureData = {
        data,
        width: textureSize,
        height: textureSize,
        worldSize,
        centerX,
        centerZ,
      };
      this.world.emit(
        EventType.ROADS_MASK_READY,
        this.roadInfluenceTextureData,
      );
      Logger.system(
        "RoadNetworkSystem",
        `Road mask (GPU) ready: ${textureSize}x${textureSize}, ` +
          `${worldSize.toFixed(1)}m world, center=(${centerX.toFixed(0)}, ${centerZ.toFixed(0)}), ` +
          `blend=${ROAD_MASK_BLEND_WIDTH}m`,
      );
      return;
    }

    // Fallback: CPU-generated mask if GPU compute not available
    const cpuResult = this.generateRoadInfluenceTexture(
      textureSize,
      worldSize,
      ROAD_MASK_BLEND_WIDTH,
      centerX,
      centerZ,
    );
    if (cpuResult) {
      this.roadInfluenceTextureData = {
        data: cpuResult.data,
        width: cpuResult.width,
        height: cpuResult.height,
        worldSize: cpuResult.worldSize,
        centerX,
        centerZ,
      };
      this.world.emit(
        EventType.ROADS_MASK_READY,
        this.roadInfluenceTextureData,
      );
      Logger.system(
        "RoadNetworkSystem",
        `Road mask (CPU) ready: ${cpuResult.width}x${cpuResult.height}, ` +
          `${cpuResult.worldSize.toFixed(1)}m world, center=(${centerX.toFixed(0)}, ${centerZ.toFixed(0)}), ` +
          `blend=${ROAD_MASK_BLEND_WIDTH}m`,
      );
    } else {
      Logger.systemWarn(
        "RoadNetworkSystem",
        "Road mask generation failed (no roads or compute unavailable)",
      );
    }
  }

  /**
   * Calculate road mask texture size to ensure roads are at least a few pixels wide.
   */
  private calculateRoadMaskTextureSize(worldSize: number): number {
    const roadInfluenceWidth =
      this.getNarrowestRoadWidth() / 2 + ROAD_MASK_BLEND_WIDTH;
    const metersPerPixelTarget =
      roadInfluenceWidth / ROAD_MASK_MIN_PIXELS_PER_INFLUENCE;
    const minResolution = Math.ceil(worldSize / metersPerPixelTarget);
    const pow2 = Math.pow(
      2,
      Math.ceil(Math.log2(Math.max(ROAD_MASK_MIN_TEXTURE_SIZE, minResolution))),
    );
    return Math.min(ROAD_MASK_MAX_TEXTURE_SIZE, pow2);
  }

  /**
   * Calculate a tight world-space bounding square for all roads.
   * This improves mask resolution by avoiding empty world coverage.
   */
  private calculateRoadMaskBounds(roadSegments: GPURoadSegment[]): {
    worldSize: number;
    centerX: number;
    centerZ: number;
  } {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const road of roadSegments) {
      const halfWidth = road.width * 0.5 + ROAD_MASK_BLEND_WIDTH;
      const padding = halfWidth + 1.0;
      const segMinX = Math.min(road.startX, road.endX) - padding;
      const segMaxX = Math.max(road.startX, road.endX) + padding;
      const segMinZ = Math.min(road.startZ, road.endZ) - padding;
      const segMaxZ = Math.max(road.startZ, road.endZ) + padding;

      minX = Math.min(minX, segMinX);
      maxX = Math.max(maxX, segMaxX);
      minZ = Math.min(minZ, segMinZ);
      maxZ = Math.max(maxZ, segMaxZ);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) {
      return {
        worldSize: this.worldHalfSize * 2,
        centerX: this.worldCenterX,
        centerZ: this.worldCenterZ,
      };
    }

    const clampToWorld = (value: number, center: number): number =>
      Math.max(
        center - this.worldHalfSize,
        Math.min(center + this.worldHalfSize, value),
      );

    minX = clampToWorld(minX, this.worldCenterX);
    maxX = clampToWorld(maxX, this.worldCenterX);
    minZ = clampToWorld(minZ, this.worldCenterZ);
    maxZ = clampToWorld(maxZ, this.worldCenterZ);

    const sizeX = Math.max(1, maxX - minX);
    const sizeZ = Math.max(1, maxZ - minZ);
    const worldSize = Math.max(sizeX, sizeZ);

    return {
      worldSize,
      centerX: (minX + maxX) * 0.5,
      centerZ: (minZ + maxZ) * 0.5,
    };
  }

  private validateNetworkConnectivity(towns: ProceduralTown[]): void {
    if (towns.length === 0) return;

    const adjacency = new Map<string, Set<string>>();
    for (const town of towns) adjacency.set(town.id, new Set());
    for (const road of this.roads) {
      adjacency.get(road.fromTownId)?.add(road.toTownId);
      adjacency.get(road.toTownId)?.add(road.fromTownId);
    }

    const visited = new Set<string>();
    const queue = [towns[0].id];
    visited.add(towns[0].id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const unreachable = towns.filter((t) => !visited.has(t.id));
    if (unreachable.length > 0) {
      Logger.systemError(
        "RoadNetworkSystem",
        `${unreachable.length} towns not connected: ${unreachable.map((t) => t.name).join(", ")}`,
      );
    }
    if (this.roads.length < towns.length - 1) {
      Logger.systemWarn(
        "RoadNetworkSystem",
        `Only ${this.roads.length} roads, expected >= ${towns.length - 1}`,
      );
    }
  }

  private random(): number {
    this.randomState = (this.randomState * 1664525 + 1013904223) >>> 0;
    return this.randomState / 0xffffffff;
  }

  private resetRandom(seed: number): void {
    this.randomState = seed;
  }

  /**
   * Generate road network asynchronously.
   * Uses worker for path smoothing when available.
   */
  private async generateRoadNetworkAsync(
    towns: ProceduralTown[],
  ): Promise<void> {
    const edges = this.calculateAllEdges(towns);
    const mstEdges = this.buildMST(towns, edges);
    const extraEdges = this.selectExtraEdges(edges, mstEdges, towns.length);
    const allEdges = [...mstEdges, ...extraEdges];
    this.roads = [];

    // Process roads in parallel batches for better performance
    const BATCH_SIZE = 4;
    for (let i = 0; i < allEdges.length; i += BATCH_SIZE) {
      const batch = allEdges.slice(i, i + BATCH_SIZE);
      const roadPromises = batch.map(async (edge, batchIndex) => {
        const roadIndex = i + batchIndex;
        const fromTown = towns.find((t) => t.id === edge.fromId);
        const toTown = towns.find((t) => t.id === edge.toId);
        if (!fromTown || !toTown) return null;

        return this.generateRoadAsync(fromTown, toTown, roadIndex);
      });

      const results = await Promise.all(roadPromises);
      for (let j = 0; j < results.length; j++) {
        const road = results[j];
        if (road) {
          const edge = batch[j];
          const fromTown = towns.find((t) => t.id === edge.fromId);
          const toTown = towns.find((t) => t.id === edge.toId);
          if (fromTown && toTown) {
            this.roads.push(road);
            fromTown.connectedRoads.push(road.id);
            toTown.connectedRoads.push(road.id);
          }
        }
      }
    }
  }

  /** @deprecated Use generateRoadNetworkAsync instead */
  private generateRoadNetwork(towns: ProceduralTown[]): void {
    const edges = this.calculateAllEdges(towns);
    const mstEdges = this.buildMST(towns, edges);
    const extraEdges = this.selectExtraEdges(edges, mstEdges, towns.length);
    const allEdges = [...mstEdges, ...extraEdges];
    this.roads = [];

    for (let i = 0; i < allEdges.length; i++) {
      const edge = allEdges[i];
      const fromTown = towns.find((t) => t.id === edge.fromId);
      const toTown = towns.find((t) => t.id === edge.toId);
      if (!fromTown || !toTown) continue;

      const road = this.generateRoad(fromTown, toTown, i);
      if (road) {
        this.roads.push(road);
        fromTown.connectedRoads.push(road.id);
        toTown.connectedRoads.push(road.id);
      }
    }
  }

  private calculateAllEdges(towns: ProceduralTown[]): Edge[] {
    const edges: Edge[] = [];
    for (let i = 0; i < towns.length; i++) {
      for (let j = i + 1; j < towns.length; j++) {
        edges.push({
          fromId: towns[i].id,
          toId: towns[j].id,
          distance: dist2D(
            towns[i].position.x,
            towns[i].position.z,
            towns[j].position.x,
            towns[j].position.z,
          ),
        });
      }
    }
    return edges;
  }

  /** Prim's algorithm for MST */
  private buildMST(towns: ProceduralTown[], edges: Edge[]): Edge[] {
    const mstEdges: Edge[] = [];
    const inMST = new Set<string>([towns[0].id]);

    while (inMST.size < towns.length) {
      let minEdge: Edge | null = null;
      let minDistance = Infinity;

      for (const edge of edges) {
        const fromInMST = inMST.has(edge.fromId);
        const toInMST = inMST.has(edge.toId);
        if (fromInMST !== toInMST && edge.distance < minDistance) {
          minDistance = edge.distance;
          minEdge = edge;
        }
      }

      if (minEdge) {
        mstEdges.push(minEdge);
        inMST.add(minEdge.fromId);
        inMST.add(minEdge.toId);
      } else {
        break;
      }
    }
    return mstEdges;
  }

  private selectExtraEdges(
    allEdges: Edge[],
    mstEdges: Edge[],
    townCount: number,
  ): Edge[] {
    const mstEdgeSet = new Set<string>();
    for (const edge of mstEdges) {
      mstEdgeSet.add(`${edge.fromId}-${edge.toId}`);
      mstEdgeSet.add(`${edge.toId}-${edge.fromId}`);
    }

    const nonMstEdges = allEdges
      .filter(
        (e) =>
          !mstEdgeSet.has(`${e.fromId}-${e.toId}`) &&
          !mstEdgeSet.has(`${e.toId}-${e.fromId}`),
      )
      .sort((a, b) => a.distance - b.distance);

    return nonMstEdges.slice(
      0,
      Math.floor(townCount * this.config.extraConnectionsRatio),
    );
  }

  /**
   * Generate a single road asynchronously.
   * Uses worker for path smoothing when available.
   */
  private async generateRoadAsync(
    fromTown: ProceduralTown,
    toTown: ProceduralTown,
    roadIndex: number,
  ): Promise<ProceduralRoad | null> {
    // Find the best entry points for each town (closest to the other town)
    const fromEntry = this.findBestEntryPoint(fromTown, toTown.position);
    const toEntry = this.findBestEntryPoint(toTown, fromTown.position);

    // BFS pathfinding - async with yielding to prevent main thread blocking
    // Uses pre-computed passability grid for O(1) water checks (built at start())
    const rawPath = await this.findPathAsync(
      fromEntry.x,
      fromEntry.z,
      toEntry.x,
      toEntry.z,
    );
    if (rawPath.length < 2) {
      Logger.systemWarn(
        "RoadNetworkSystem",
        `No path between ${fromTown.name} and ${toTown.name}`,
      );
      return null;
    }

    // Try to smooth path using worker (Chaikin algorithm offloaded)
    let smoothedPath: RoadPathPoint[];
    if (isProcgenWorkerAvailable()) {
      const smoothResult = await smoothPathAsync(
        rawPath.map((p) => ({ x: p.x, z: p.z })),
        {
          iterations: this.config.smoothingIterations,
          noiseScale: this.config.noiseDisplacementScale,
          noiseStrength: this.config.noiseDisplacementStrength,
          seed: this.seed + roadIndex * 7793,
        },
      );

      if (smoothResult) {
        // Add Y coordinates from terrain (requires main thread)
        smoothedPath = smoothResult.path.map((p) => ({
          x: p.x,
          z: p.z,
          y: this.terrainSystem!.getHeightAt(p.x, p.z),
        }));
      } else {
        // Fallback to sync smoothing
        smoothedPath = this.smoothPath(rawPath, roadIndex);
      }
    } else {
      // No worker available - use sync path
      smoothedPath = this.smoothPath(rawPath, roadIndex);
    }

    let totalLength = 0;
    for (let i = 1; i < smoothedPath.length; i++) {
      totalLength += dist2D(
        smoothedPath[i - 1].x,
        smoothedPath[i - 1].z,
        smoothedPath[i].x,
        smoothedPath[i].z,
      );
    }

    return {
      id: `road_${roadIndex}`,
      fromType: "town" as RoadEndpointType,
      fromTownId: fromTown.id,
      toType: "town" as RoadEndpointType,
      toTownId: toTown.id,
      path: smoothedPath,
      width: this.config.roadWidth,
      material: "dirt",
      length: totalLength,
    };
  }

  /**
   * Generate roads from towns to important POIs.
   * Each POI is connected to its nearest town (if within max distance).
   */
  private async generatePOIRoadsAsync(
    towns: ProceduralTown[],
    pois: PointOfInterest[],
  ): Promise<void> {
    if (!this.poiSystem) return;

    const poiConfig = this.poiSystem.getConfig();
    const maxDistance = poiConfig.maxRoadExtensionDistance;
    const roadStartIndex = this.roads.length;

    // For each POI, find nearest town and create road if within range
    const poiRoadPromises: Array<Promise<ProceduralRoad | null>> = [];

    for (let i = 0; i < pois.length; i++) {
      const poi = pois[i];

      // Find nearest town
      let nearestTown: ProceduralTown | null = null;
      let nearestDistance = Infinity;

      for (const town of towns) {
        const distance = dist2D(
          poi.position.x,
          poi.position.z,
          town.position.x,
          town.position.z,
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestTown = town;
        }
      }

      // Skip if too far from any town
      if (!nearestTown || nearestDistance > maxDistance) {
        continue;
      }

      // Check if there's already a road to this area (avoid duplicates)
      const existingRoad = this.roads.find(
        (r) => r.toPOIId === poi.id || r.fromPOIId === poi.id,
      );
      if (existingRoad) continue;

      // Generate road from town to POI
      const roadIndex = roadStartIndex + poiRoadPromises.length;
      poiRoadPromises.push(
        this.generateTownToPOIRoadAsync(nearestTown, poi, roadIndex),
      );
    }

    // Process roads in batches
    const BATCH_SIZE = 4;
    for (let i = 0; i < poiRoadPromises.length; i += BATCH_SIZE) {
      const batch = poiRoadPromises.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch);

      for (const road of results) {
        if (road) {
          this.roads.push(road);

          // Update POI with connected road
          const poi = pois.find((p) => p.id === road.toPOIId);
          if (poi) {
            poi.connectedRoads.push(road.id);
          }

          // Update town with connected road
          const town = towns.find((t) => t.id === road.fromTownId);
          if (town) {
            town.connectedRoads.push(road.id);
          }
        }
      }
    }
  }

  /**
   * Generate a single road from a town to a POI.
   */
  private async generateTownToPOIRoadAsync(
    town: ProceduralTown,
    poi: PointOfInterest,
    roadIndex: number,
  ): Promise<ProceduralRoad | null> {
    // Find best entry point on town
    const townEntry = this.findBestEntryPoint(town, poi.position);

    // Calculate entry point on POI (edge of POI radius facing the town)
    const poiEntry = this.poiSystem!.calculateEntryPoint(
      poi,
      town.position.x,
      town.position.z,
    );

    // Update POI's entry point
    poi.entryPoint = poiEntry;

    // BFS pathfinding
    const rawPath = await this.findPathAsync(
      townEntry.x,
      townEntry.z,
      poiEntry.x,
      poiEntry.z,
    );

    if (rawPath.length < 2) {
      Logger.systemWarn(
        "RoadNetworkSystem",
        `No path from ${town.name} to POI ${poi.name}`,
      );
      return null;
    }

    // Smooth path
    let smoothedPath: RoadPathPoint[];
    if (isProcgenWorkerAvailable()) {
      const smoothResult = await smoothPathAsync(
        rawPath.map((p) => ({ x: p.x, z: p.z })),
        {
          iterations: this.config.smoothingIterations,
          noiseScale: this.config.noiseDisplacementScale,
          noiseStrength: this.config.noiseDisplacementStrength,
          seed: this.seed + roadIndex * 7793,
        },
      );

      if (smoothResult) {
        smoothedPath = smoothResult.path.map((p) => ({
          x: p.x,
          z: p.z,
          y: this.terrainSystem!.getHeightAt(p.x, p.z),
        }));
      } else {
        smoothedPath = this.smoothPath(rawPath, roadIndex);
      }
    } else {
      smoothedPath = this.smoothPath(rawPath, roadIndex);
    }

    let totalLength = 0;
    for (let i = 1; i < smoothedPath.length; i++) {
      totalLength += dist2D(
        smoothedPath[i - 1].x,
        smoothedPath[i - 1].z,
        smoothedPath[i].x,
        smoothedPath[i].z,
      );
    }

    return {
      id: `road_poi_${roadIndex}`,
      fromType: "town" as RoadEndpointType,
      fromTownId: town.id,
      toType: "poi" as RoadEndpointType,
      toTownId: "", // Empty for POI roads
      toPOIId: poi.id,
      path: smoothedPath,
      width: this.config.roadWidth,
      material: "dirt",
      length: totalLength,
    };
  }

  // ============================================================================
  // EXPLORATION ROADS - Roads to natural features (water, mountains, viewpoints)
  // ============================================================================

  /**
   * Natural destination type for exploration roads
   */
  private static readonly DESTINATION_TYPES = {
    WATER_EDGE: "water_edge",
    MOUNTAIN: "mountain",
    VIEWPOINT: "viewpoint",
    LAKE: "lake",
  } as const;

  /**
   * Generate exploration roads to natural features.
   * Ensures towns with few connections still have roads leading somewhere interesting.
   */
  private async generateExplorationRoadsAsync(
    towns: ProceduralTown[],
  ): Promise<void> {
    const minRoadsPerTown = DEFAULTS.minRoadsPerTown;
    const searchRadius = DEFAULTS.explorationRoadSearchRadius;
    const roadStartIndex = this.roads.length;

    let explorationRoadsGenerated = 0;

    for (const town of towns) {
      // Count existing roads for this town
      const existingRoadCount = town.connectedRoads.length;

      // Skip if town already has enough roads
      if (existingRoadCount >= minRoadsPerTown) continue;

      // Find directions that don't already have roads
      const usedAngles = this.getUsedRoadAngles(town);
      const roadsNeeded = minRoadsPerTown - existingRoadCount;

      // Find natural destinations in unused directions
      const destinations = this.findNaturalDestinations(
        town,
        searchRadius,
        usedAngles,
        roadsNeeded,
      );

      // Generate roads to destinations
      for (const dest of destinations) {
        const roadIndex = roadStartIndex + explorationRoadsGenerated;
        const road = await this.generateExplorationRoadAsync(
          town,
          dest,
          roadIndex,
        );

        if (road) {
          this.roads.push(road);
          town.connectedRoads.push(road.id);
          explorationRoadsGenerated++;
        }
      }
    }

    if (explorationRoadsGenerated > 0) {
      Logger.system(
        "RoadNetworkSystem",
        `Generated ${explorationRoadsGenerated} exploration roads to natural features`,
      );
    }
  }

  /**
   * Get angles of existing roads from a town (to avoid duplicating directions)
   */
  private getUsedRoadAngles(town: ProceduralTown): number[] {
    const angles: number[] = [];

    for (const roadId of town.connectedRoads) {
      const road = this.roads.find((r) => r.id === roadId);
      if (!road || road.path.length < 2) continue;

      // Determine which end of the road is at this town
      const firstPoint = road.path[0];
      const lastPoint = road.path[road.path.length - 1];

      const distToFirst = dist2D(
        town.position.x,
        town.position.z,
        firstPoint.x,
        firstPoint.z,
      );
      const distToLast = dist2D(
        town.position.x,
        town.position.z,
        lastPoint.x,
        lastPoint.z,
      );

      // Get the direction the road goes from the town
      let angle: number;
      if (distToFirst < distToLast) {
        // Road starts at this town
        const secondPoint = road.path[Math.min(5, road.path.length - 1)];
        angle = Math.atan2(
          secondPoint.z - firstPoint.z,
          secondPoint.x - firstPoint.x,
        );
      } else {
        // Road ends at this town
        const secondToLast = road.path[Math.max(0, road.path.length - 6)];
        angle = Math.atan2(
          secondToLast.z - lastPoint.z,
          secondToLast.x - lastPoint.x,
        );
      }

      angles.push(angle);
    }

    return angles;
  }

  /**
   * Find natural destinations for exploration roads
   */
  private findNaturalDestinations(
    town: ProceduralTown,
    searchRadius: number,
    usedAngles: number[],
    maxDestinations: number,
  ): Array<{
    x: number;
    z: number;
    type: string;
    angle: number;
  }> {
    const destinations: Array<{
      x: number;
      z: number;
      type: string;
      angle: number;
      score: number;
    }> = [];

    // Sample points in a circle around the town
    const sampleCount = 24;
    const angleStep = (Math.PI * 2) / sampleCount;

    for (let i = 0; i < sampleCount; i++) {
      const angle = i * angleStep;

      // Skip if this direction is already used by a road (within 45 degrees)
      const isTooClose = usedAngles.some((used) => {
        let diff = Math.abs(angle - used);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        return diff < Math.PI / 4; // 45 degrees
      });
      if (isTooClose) continue;

      // Search along this ray for interesting features
      const dest = this.findDestinationAlongRay(
        town.position.x,
        town.position.z,
        angle,
        searchRadius,
      );

      if (dest) {
        destinations.push({ ...dest, angle });
      }
    }

    // Sort by score (best destinations first)
    destinations.sort((a, b) => b.score - a.score);

    // Return top destinations
    return destinations.slice(0, maxDestinations).map((d) => ({
      x: d.x,
      z: d.z,
      type: d.type,
      angle: d.angle,
    }));
  }

  /**
   * Search along a ray from a point to find interesting natural features
   */
  private findDestinationAlongRay(
    startX: number,
    startZ: number,
    angle: number,
    maxDistance: number,
  ): { x: number; z: number; type: string; score: number } | null {
    if (!this.terrainSystem) return null;

    const stepSize = 20;
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);

    let bestDest: { x: number; z: number; type: string; score: number } | null =
      null;

    // Track terrain features along the ray
    let lastHeight = this.terrainSystem.getHeightAt(startX, startZ);
    let maxHeight = lastHeight;
    let maxHeightPos = { x: startX, z: startZ };
    let waterEdgePos: { x: number; z: number } | null = null;

    for (let dist = stepSize * 2; dist <= maxDistance; dist += stepSize) {
      const x = startX + dirX * dist;
      const z = startZ + dirZ * dist;
      const height = this.terrainSystem.getHeightAt(x, z);

      // Check for water edge (transition from land to water)
      if (lastHeight >= WATER_THRESHOLD && height < WATER_THRESHOLD) {
        // Found water edge - this is a great destination
        waterEdgePos = {
          x: startX + dirX * (dist - stepSize / 2),
          z: startZ + dirZ * (dist - stepSize / 2),
        };
      }

      // Track highest point (mountain/viewpoint)
      if (height > maxHeight) {
        maxHeight = height;
        maxHeightPos = { x, z };
      }

      lastHeight = height;
    }

    // Prioritize destinations:
    // 1. Water edge (ocean, lake) - most scenic
    // 2. High point (mountain, viewpoint)
    // 3. Distance-based viewpoint

    if (waterEdgePos) {
      bestDest = {
        x: waterEdgePos.x,
        z: waterEdgePos.z,
        type: RoadNetworkSystem.DESTINATION_TYPES.WATER_EDGE,
        score: 1.0,
      };
    } else if (maxHeight > lastHeight + 10) {
      // Significant elevation gain - mountain/viewpoint
      bestDest = {
        x: maxHeightPos.x,
        z: maxHeightPos.z,
        type: RoadNetworkSystem.DESTINATION_TYPES.MOUNTAIN,
        score: 0.7 + (maxHeight - lastHeight) / 100,
      };
    } else {
      // Just extend the road in this direction as a scenic viewpoint
      const viewpointDist = Math.min(
        maxDistance * 0.7,
        DEFAULTS.explorationRoadLength,
      );
      bestDest = {
        x: startX + dirX * viewpointDist,
        z: startZ + dirZ * viewpointDist,
        type: RoadNetworkSystem.DESTINATION_TYPES.VIEWPOINT,
        score: 0.4,
      };
    }

    return bestDest;
  }

  /**
   * Generate a single exploration road to a natural destination
   */
  private async generateExplorationRoadAsync(
    town: ProceduralTown,
    destination: { x: number; z: number; type: string; angle: number },
    roadIndex: number,
  ): Promise<ProceduralRoad | null> {
    // Find best entry point on town facing the destination
    const townEntry = this.findBestEntryPoint(town, {
      x: destination.x,
      z: destination.z,
    });

    // BFS pathfinding to destination
    const rawPath = await this.findPathAsync(
      townEntry.x,
      townEntry.z,
      destination.x,
      destination.z,
    );

    if (rawPath.length < 2) {
      return null;
    }

    // Smooth path
    let smoothedPath: RoadPathPoint[];
    if (isProcgenWorkerAvailable()) {
      const smoothResult = await smoothPathAsync(
        rawPath.map((p) => ({ x: p.x, z: p.z })),
        {
          iterations: this.config.smoothingIterations,
          noiseScale: this.config.noiseDisplacementScale,
          noiseStrength: this.config.noiseDisplacementStrength,
          seed: this.seed + roadIndex * 7793,
        },
      );

      if (smoothResult) {
        smoothedPath = smoothResult.path.map((p) => ({
          x: p.x,
          z: p.z,
          y: this.terrainSystem!.getHeightAt(p.x, p.z),
        }));
      } else {
        smoothedPath = this.smoothPath(rawPath, roadIndex);
      }
    } else {
      smoothedPath = this.smoothPath(rawPath, roadIndex);
    }

    // Extend the road past the destination with weighted random walk
    // This makes roads continue toward tile/world boundaries
    const extendedPath = this.extendRoadWithRandomWalk(
      smoothedPath,
      destination.angle,
      roadIndex,
    );

    // Recalculate total length with extension
    let extendedLength = 0;
    for (let i = 1; i < extendedPath.length; i++) {
      extendedLength += dist2D(
        extendedPath[i - 1].x,
        extendedPath[i - 1].z,
        extendedPath[i].x,
        extendedPath[i].z,
      );
    }

    return {
      id: `road_explore_${roadIndex}`,
      fromType: "town" as RoadEndpointType,
      fromTownId: town.id,
      toType: "poi" as RoadEndpointType, // Treat as POI for simplicity
      toTownId: "", // Empty for exploration roads
      toPOIId: `natural_${destination.type}_${roadIndex}`, // Virtual POI ID
      path: extendedPath,
      width: this.config.roadWidth,
      material: "dirt",
      length: extendedLength,
    };
  }

  /**
   * Extend a road path with purposeful organic curves.
   * Continues in the general direction away from town until hitting:
   * - Mountainous terrain (steep upward slope or high elevation)
   * - Near shoreline (approaching water)
   * - World boundary
   *
   * The path curves organically following terrain contours but maintains
   * a consistent general direction (not random walk).
   */
  private extendRoadWithRandomWalk(
    currentPath: RoadPathPoint[],
    baseDirection: number,
    roadIndex: number,
  ): RoadPathPoint[] {
    if (currentPath.length < 2 || !this.terrainSystem) {
      return currentPath;
    }

    this.resetRandom(this.seed + roadIndex * 13337 + 500000);

    const extendedPath = [...currentPath];
    const roadId = `road_explore_${roadIndex}`;

    // Get initial direction from path's last segment, or use base direction
    const last = currentPath[currentPath.length - 1];
    const secondLast = currentPath[currentPath.length - 2];
    const dx = last.x - secondLast.x;
    const dz = last.z - secondLast.z;
    const dirLen = Math.sqrt(dx * dx + dz * dz);
    const initialDirection = dirLen > 0.1 ? Math.atan2(dz, dx) : baseDirection;
    let direction = initialDirection;

    let x = last.x;
    let z = last.z;
    let lastHeight = last.y;

    // Walk parameters - extend further for more natural termination
    const step = this.config.pathStepSize;
    const maxSteps = Math.ceil(800 / step); // Extend up to 800m to reach natural boundaries
    const baseVariance = Math.PI / 12; // Reduced variance for more purposeful direction
    const maxDeviation = Math.PI / 3; // Maximum 60 degrees from initial direction

    // Terrain awareness parameters
    const MOUNTAIN_SLOPE_THRESHOLD = 0.4; // Steep upward slope = mountainous
    const SHORELINE_PROXIMITY = 15; // Stop this many meters from water
    const HIGH_ELEVATION_THRESHOLD = 60; // Consider high ground as mountainous

    for (let i = 0; i < maxSteps; i++) {
      // Sample terrain in the current direction and slightly to each side
      // This helps the road follow terrain contours naturally
      const sampleDist = step * 1.5;
      const leftAngle = direction - Math.PI / 6;
      const rightAngle = direction + Math.PI / 6;

      const forwardHeight = this.terrainSystem.getHeightAt(
        x + Math.cos(direction) * sampleDist,
        z + Math.sin(direction) * sampleDist,
      );
      const leftHeight = this.terrainSystem.getHeightAt(
        x + Math.cos(leftAngle) * sampleDist,
        z + Math.sin(leftAngle) * sampleDist,
      );
      const rightHeight = this.terrainSystem.getHeightAt(
        x + Math.cos(rightAngle) * sampleDist,
        z + Math.sin(rightAngle) * sampleDist,
      );

      // Bias direction toward flatter terrain (contour following)
      const forwardSlope = Math.abs(forwardHeight - lastHeight) / sampleDist;
      const leftSlope = Math.abs(leftHeight - lastHeight) / sampleDist;
      const rightSlope = Math.abs(rightHeight - lastHeight) / sampleDist;

      let slopeBias = 0;
      if (leftSlope < forwardSlope - 0.05 && leftSlope < rightSlope) {
        slopeBias = -baseVariance * 0.5; // Turn slightly left
      } else if (rightSlope < forwardSlope - 0.05 && rightSlope < leftSlope) {
        slopeBias = baseVariance * 0.5; // Turn slightly right
      }

      // Add small random variation for organic feel
      const randomVariation = (this.random() - 0.5) * baseVariance * 0.5;

      // Apply adjustment but clamp to max deviation from initial direction
      let adjustment = slopeBias + randomVariation;
      const proposedDirection = direction + adjustment;
      let deviationFromInitial = proposedDirection - initialDirection;

      // Normalize deviation to [-PI, PI]
      while (deviationFromInitial > Math.PI)
        deviationFromInitial -= Math.PI * 2;
      while (deviationFromInitial < -Math.PI)
        deviationFromInitial += Math.PI * 2;

      // Clamp deviation
      if (Math.abs(deviationFromInitial) > maxDeviation) {
        adjustment = 0; // Don't adjust if we'd exceed max deviation
      }

      direction += adjustment;
      const newX = x + Math.cos(direction) * step;
      const newZ = z + Math.sin(direction) * step;

      // Get terrain at new position
      const height = this.terrainSystem.getHeightAt(newX, newZ);
      const slope = (height - lastHeight) / step; // Signed slope (+ = uphill)
      const absSlope = Math.abs(slope);

      // Check water proximity (look ahead for water)
      const lookAheadDist = SHORELINE_PROXIMITY + step;
      const lookAheadHeight = this.terrainSystem.getHeightAt(
        newX + Math.cos(direction) * lookAheadDist,
        newZ + Math.sin(direction) * lookAheadDist,
      );

      // Stop conditions
      const isNearWater = height < WATER_THRESHOLD + 2; // Very close to water
      const isApproachingWater = lookAheadHeight < WATER_THRESHOLD;
      const isSteepUphill = slope > MOUNTAIN_SLOPE_THRESHOLD; // Going uphill steeply
      const isHighElevation = height > HIGH_ELEVATION_THRESHOLD;
      const isMountainous =
        isSteepUphill || (isHighElevation && absSlope > 0.2);
      const isAtWorldBounds =
        Math.abs(newX) > this.worldHalfSize ||
        Math.abs(newZ) > this.worldHalfSize;

      if (
        isNearWater ||
        isApproachingWater ||
        isMountainous ||
        isAtWorldBounds
      ) {
        // Record boundary exit for cross-tile continuity
        this.recordBoundaryExitIfAtEdge(x, z, direction, roadId);
        break;
      }

      extendedPath.push({ x: newX, z: newZ, y: height });
      x = newX;
      z = newZ;
      lastHeight = height;
    }

    return extendedPath;
  }

  /** Get tile coordinates and local position within tile */
  private getTileInfo(
    x: number,
    z: number,
  ): {
    tileX: number;
    tileZ: number;
    localX: number;
    localZ: number;
  } {
    const tileX = Math.floor(x / TILE_SIZE);
    const tileZ = Math.floor(z / TILE_SIZE);
    return {
      tileX,
      tileZ,
      localX: x - tileX * TILE_SIZE,
      localZ: z - tileZ * TILE_SIZE,
    };
  }

  /** Check if position is within threshold of any tile boundary */
  private isAtTileBoundary(
    x: number,
    z: number,
    threshold: number = 5,
  ): boolean {
    const { localX, localZ } = this.getTileInfo(x, z);
    return (
      localX < threshold ||
      localX > TILE_SIZE - threshold ||
      localZ < threshold ||
      localZ > TILE_SIZE - threshold
    );
  }

  /** Get which tile edge a position is nearest to, or null if not near edge */
  private getNearestTileEdge(
    x: number,
    z: number,
    threshold: number = 10,
  ): TileEdge | null {
    const { localX, localZ } = this.getTileInfo(x, z);
    if (localX < threshold) return "west";
    if (localX > TILE_SIZE - threshold) return "east";
    if (localZ < threshold) return "south";
    if (localZ > TILE_SIZE - threshold) return "north";
    return null;
  }

  /** Record boundary exit if position is at tile edge (skips duplicates) */
  private recordBoundaryExitIfAtEdge(
    x: number,
    z: number,
    direction: number,
    roadId: string,
  ): void {
    const edge = this.getNearestTileEdge(x, z);
    if (!edge) return;

    const { tileX, tileZ } = this.getTileInfo(x, z);

    // Skip if duplicate
    const isDuplicate = this.boundaryExits.some(
      (e) =>
        e.roadId === roadId &&
        e.tileX === tileX &&
        e.tileZ === tileZ &&
        e.edge === edge,
    );
    if (isDuplicate) return;

    this.boundaryExits.push({
      roadId,
      position: { x, z },
      direction,
      tileX,
      tileZ,
      edge,
    });
  }

  /** Get boundary exits for a tile, optionally filtered by edge */
  getBoundaryExitsForTile(
    tileX: number,
    tileZ: number,
    edge?: TileEdge,
  ): RoadBoundaryExit[] {
    return this.boundaryExits.filter(
      (e) =>
        e.tileX === tileX && e.tileZ === tileZ && (!edge || e.edge === edge),
    );
  }

  /** Get all boundary exits in the network */
  getAllBoundaryExits(): RoadBoundaryExit[] {
    return [...this.boundaryExits];
  }

  /**
   * Get road entries for a tile from adjacent tiles.
   * Maps exits from neighbors to entry points on this tile's edges.
   */
  getRoadEntriesForTile(tileX: number, tileZ: number): RoadBoundaryExit[] {
    // Adjacent tiles and edge mappings: [dx, dz, exitEdge, entryEdge]
    const neighbors: [number, number, TileEdge, TileEdge][] = [
      [-1, 0, "east", "west"],
      [1, 0, "west", "east"],
      [0, -1, "north", "south"],
      [0, 1, "south", "north"],
    ];

    const entries: RoadBoundaryExit[] = [];
    for (const [dx, dz, exitEdge, entryEdge] of neighbors) {
      for (const exit of this.getBoundaryExitsForTile(
        tileX + dx,
        tileZ + dz,
        exitEdge,
      )) {
        entries.push({ ...exit, tileX, tileZ, edge: entryEdge });
      }
    }
    return entries;
  }

  /** Check if a road endpoint exists near given coordinates */
  hasRoadAtPoint(x: number, z: number, threshold: number = 10): boolean {
    return this.roads.some((road) => {
      const first = road.path[0];
      const last = road.path[road.path.length - 1];
      return (
        dist2D(first.x, first.z, x, z) < threshold ||
        dist2D(last.x, last.z, x, z) < threshold
      );
    });
  }

  /** @deprecated Use generateRoadAsync instead */
  private generateRoad(
    fromTown: ProceduralTown,
    toTown: ProceduralTown,
    roadIndex: number,
  ): ProceduralRoad | null {
    // Find the best entry points for each town (closest to the other town)
    const fromEntry = this.findBestEntryPoint(fromTown, toTown.position);
    const toEntry = this.findBestEntryPoint(toTown, fromTown.position);

    const rawPath = this.findPath(
      fromEntry.x,
      fromEntry.z,
      toEntry.x,
      toEntry.z,
    );
    if (rawPath.length < 2) {
      Logger.systemWarn(
        "RoadNetworkSystem",
        `No path between ${fromTown.name} and ${toTown.name}`,
      );
      return null;
    }

    const smoothedPath = this.smoothPath(rawPath, roadIndex);
    let totalLength = 0;
    for (let i = 1; i < smoothedPath.length; i++) {
      totalLength += dist2D(
        smoothedPath[i - 1].x,
        smoothedPath[i - 1].z,
        smoothedPath[i].x,
        smoothedPath[i].z,
      );
    }

    return {
      id: `road_${roadIndex}`,
      fromType: "town" as RoadEndpointType,
      fromTownId: fromTown.id,
      toType: "town" as RoadEndpointType,
      toTownId: toTown.id,
      path: smoothedPath,
      width: this.config.roadWidth,
      material: "dirt",
      length: totalLength,
    };
  }

  /**
   * Find the best entry point for a town when connecting to a target position.
   * Returns the entry point position closest to the target, or the town center
   * offset toward the target if no entry points exist.
   */
  private findBestEntryPoint(
    town: ProceduralTown,
    targetPos: { x: number; z: number },
  ): { x: number; z: number } {
    const entryPoints = town.entryPoints;

    if (!entryPoints || entryPoints.length === 0) {
      // No entry points - calculate position at edge of town toward target
      const dx = targetPos.x - town.position.x;
      const dz = targetPos.z - town.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 1) return { x: town.position.x, z: town.position.z };

      // Return position at safe zone edge toward target
      const edgeDist = town.safeZoneRadius * 0.8;
      return {
        x: town.position.x + (dx / dist) * edgeDist,
        z: town.position.z + (dz / dist) * edgeDist,
      };
    }

    // Find entry point closest to target direction
    const angleToTarget = Math.atan2(
      targetPos.z - town.position.z,
      targetPos.x - town.position.x,
    );

    let bestEntry = entryPoints[0];
    let bestAngleDiff = Math.PI * 2;

    for (const entry of entryPoints) {
      let angleDiff = Math.abs(entry.angle - angleToTarget);
      if (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;

      if (angleDiff < bestAngleDiff) {
        bestAngleDiff = angleDiff;
        bestEntry = entry;
      }
    }

    return bestEntry.position;
  }

  /**
   * BFS pathfinding - Simple and reliable path finding (sync version).
   * Finds path avoiding water tiles without complex heuristics.
   * @deprecated Use findPathAsync for non-blocking operation
   */
  private findPath(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
  ): RoadPathPoint[] {
    const { pathStepSize, maxPathIterations } = this.config;
    const gridStartX = Math.round(startX / pathStepSize) * pathStepSize;
    const gridStartZ = Math.round(startZ / pathStepSize) * pathStepSize;
    const gridEndX = Math.round(endX / pathStepSize) * pathStepSize;
    const gridEndZ = Math.round(endZ / pathStepSize) * pathStepSize;

    // BFS uses a simple queue (FIFO)
    const queue: BFSNode[] = [];
    const visited = new Set<string>();

    const startNode: BFSNode = {
      x: gridStartX,
      z: gridStartZ,
      parent: null,
    };
    queue.push(startNode);
    visited.add(`${gridStartX},${gridStartZ}`);

    let iterations = 0;
    while (queue.length > 0 && iterations < maxPathIterations) {
      iterations++;
      const current = queue.shift()!;

      // Check if we reached the goal
      if (
        Math.abs(current.x - gridEndX) <= pathStepSize &&
        Math.abs(current.z - gridEndZ) <= pathStepSize
      ) {
        return this.reconstructBFSPath(current, endX, endZ);
      }

      // Explore neighbors
      for (const dir of this.directions) {
        const neighborX = current.x + dir.dx;
        const neighborZ = current.z + dir.dz;
        const neighborKey = `${neighborX},${neighborZ}`;

        if (visited.has(neighborKey)) continue;

        // Check if tile is passable (not water)
        if (!this.isPassable(neighborX, neighborZ)) continue;

        visited.add(neighborKey);
        queue.push({
          x: neighborX,
          z: neighborZ,
          parent: current,
        });
      }
    }

    // BFS completed without finding path - use direct path as fallback
    Logger.systemWarn(
      "RoadNetworkSystem",
      `BFS completed in ${iterations} iterations, using direct path`,
    );
    return this.generateDirectPath(startX, startZ, endX, endZ);
  }

  /**
   * Async BFS pathfinding with yielding to prevent main thread blocking.
   * Yields every YIELD_INTERVAL iterations to allow frame rendering.
   */
  private async findPathAsync(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
  ): Promise<RoadPathPoint[]> {
    const { pathStepSize, maxPathIterations } = this.config;
    const gridStartX = Math.round(startX / pathStepSize) * pathStepSize;
    const gridStartZ = Math.round(startZ / pathStepSize) * pathStepSize;
    const gridEndX = Math.round(endX / pathStepSize) * pathStepSize;
    const gridEndZ = Math.round(endZ / pathStepSize) * pathStepSize;

    // Yield every 200 iterations to allow frame rendering
    const YIELD_INTERVAL = 200;

    // BFS uses a simple queue (FIFO)
    const queue: BFSNode[] = [];
    const visited = new Set<string>();

    const startNode: BFSNode = {
      x: gridStartX,
      z: gridStartZ,
      parent: null,
    };
    queue.push(startNode);
    visited.add(`${gridStartX},${gridStartZ}`);

    let iterations = 0;
    while (queue.length > 0 && iterations < maxPathIterations) {
      iterations++;
      const current = queue.shift()!;

      // Check if we reached the goal
      if (
        Math.abs(current.x - gridEndX) <= pathStepSize &&
        Math.abs(current.z - gridEndZ) <= pathStepSize
      ) {
        return this.reconstructBFSPath(current, endX, endZ);
      }

      // Explore neighbors
      for (const dir of this.directions) {
        const neighborX = current.x + dir.dx;
        const neighborZ = current.z + dir.dz;
        const neighborKey = `${neighborX},${neighborZ}`;

        if (visited.has(neighborKey)) continue;

        // Check if tile is passable (not water)
        if (!this.isPassable(neighborX, neighborZ)) continue;

        visited.add(neighborKey);
        queue.push({
          x: neighborX,
          z: neighborZ,
          parent: current,
        });
      }

      // Yield to main thread periodically to prevent blocking
      if (iterations % YIELD_INTERVAL === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    // BFS completed without finding path - use direct path as fallback
    Logger.systemWarn(
      "RoadNetworkSystem",
      `BFS completed in ${iterations} iterations, using direct path`,
    );
    return this.generateDirectPath(startX, startZ, endX, endZ);
  }

  /**
   * Build passability grid for the entire world.
   * Pre-computes terrain height at grid points to avoid repeated lookups during BFS.
   *
   * ADAPTIVE RESOLUTION: For large worlds, uses coarser grid to stay under 40k points.
   * - This prevents the grid from taking >15 seconds on large worlds.
   * - BFS pathfinding still works - it just uses coarser water detection.
   * - For a 10km world: uses 60m step → 28,000 points instead of 250,000
   */
  private async buildPassabilityGridAsync(): Promise<void> {
    if (this.passabilityGrid || this.passabilityGridBuilding) {
      return; // Already built or building
    }

    this.passabilityGridBuilding = true;
    const startTime = performance.now();

    // ADAPTIVE GRID RESOLUTION - limit to ~40,000 points max for <5s build time
    const MAX_GRID_POINTS = 40000;
    const worldSize = this.worldHalfSize * 2;
    const baseStep = this.config.pathStepSize;

    // Calculate step size to stay under MAX_GRID_POINTS
    // gridPoints = (worldSize / step)² ≤ MAX_GRID_POINTS
    // step ≥ worldSize / sqrt(MAX_GRID_POINTS)
    const minStepForLimit = worldSize / Math.sqrt(MAX_GRID_POINTS);
    const gridStepSize = Math.max(
      baseStep,
      Math.ceil(minStepForLimit / baseStep) * baseStep,
    );
    this.passabilityGridStepSize = gridStepSize;

    const grid = new Set<string>();
    const getTerrainHeight = this.terrainSystem
      ? (x: number, z: number) =>
          this.terrainSystem!.getProceduralHeightAt
            ? this.terrainSystem!.getProceduralHeightAt(x, z)
            : this.terrainSystem!.getHeightAt(x, z)
      : null;

    // Grid bounds: -worldHalfSize to +worldHalfSize
    const minCoord = -this.worldHalfSize;
    const maxCoord = this.worldHalfSize;

    // Snap bounds to grid
    const gridMin = Math.floor(minCoord / gridStepSize) * gridStepSize;
    const gridMax = Math.ceil(maxCoord / gridStepSize) * gridStepSize;

    // Yield interval to prevent main thread blocking
    const YIELD_INTERVAL = 2000; // Yield every 2000 grid points
    let pointsProcessed = 0;

    for (let x = gridMin; x <= gridMax; x += gridStepSize) {
      for (let z = gridMin; z <= gridMax; z += gridStepSize) {
        // Check if passable (above water threshold)
        const height = getTerrainHeight
          ? getTerrainHeight(x, z)
          : WATER_THRESHOLD;
        if (height >= WATER_THRESHOLD) {
          grid.add(`${x},${z}`);
        }

        pointsProcessed++;
        if (pointsProcessed % YIELD_INTERVAL === 0) {
          // Yield to main thread
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    this.passabilityGrid = grid;
    this.passabilityGridBuilding = false;

    const elapsed = performance.now() - startTime;
    const passableCount = grid.size;
    const waterPercent = (
      ((pointsProcessed - passableCount) / pointsProcessed) *
      100
    ).toFixed(1);

    Logger.system(
      "RoadNetworkSystem",
      `Passability grid built: ${passableCount.toLocaleString()}/${pointsProcessed.toLocaleString()} passable ` +
        `(${waterPercent}% water) in ${elapsed.toFixed(0)}ms ` +
        `(step: ${gridStepSize}m for ${worldSize}m world)`,
    );
  }

  /**
   * Check if a grid position is passable (not underwater).
   * Uses pre-computed passability grid when available for O(1) lookup.
   * Falls back to terrain query if grid not yet built.
   */
  private isPassable(x: number, z: number): boolean {
    // Use pre-computed grid if available (O(1) lookup)
    if (this.passabilityGrid) {
      // Snap to grid coordinates using actual grid step size
      const step = this.passabilityGridStepSize;
      const gridX = Math.round(x / step) * step;
      const gridZ = Math.round(z / step) * step;
      return this.passabilityGrid.has(`${gridX},${gridZ}`);
    }

    // Fallback to terrain query (expensive)
    if (!this.terrainSystem) return true;
    const height = this.terrainSystem.getProceduralHeightAt
      ? this.terrainSystem.getProceduralHeightAt(x, z)
      : this.terrainSystem.getHeightAt(x, z);
    return height >= WATER_THRESHOLD;
  }

  /**
   * Reconstruct path from BFS end node
   */
  private reconstructBFSPath(
    endNode: BFSNode,
    finalX: number,
    finalZ: number,
  ): RoadPathPoint[] {
    const path: RoadPathPoint[] = [];
    let current: BFSNode | null = endNode;
    while (current) {
      path.unshift({
        x: current.x,
        z: current.z,
        y: this.terrainSystem!.getHeightAt(current.x, current.z),
      });
      current = current.parent;
    }
    path.push({
      x: finalX,
      z: finalZ,
      y: this.terrainSystem!.getHeightAt(finalX, finalZ),
    });
    return path;
  }

  private generateDirectPath(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
  ): RoadPathPoint[] {
    const path: RoadPathPoint[] = [];
    const dx = endX - startX;
    const dz = endZ - startZ;
    const steps = Math.ceil(
      Math.sqrt(dx * dx + dz * dz) / this.config.pathStepSize,
    );
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = startX + dx * t;
      const z = startZ + dz * t;
      path.push({ x, z, y: this.terrainSystem!.getHeightAt(x, z) });
    }
    return path;
  }

  /** Chaikin smoothing + noise displacement */
  private smoothPath(
    rawPath: RoadPathPoint[],
    roadIndex: number,
  ): RoadPathPoint[] {
    if (rawPath.length < 3) return rawPath;

    const {
      smoothingIterations,
      noiseDisplacementScale,
      noiseDisplacementStrength,
    } = this.config;
    let smoothed = [...rawPath];

    for (let iter = 0; iter < smoothingIterations; iter++) {
      const newPath: RoadPathPoint[] = [smoothed[0]];
      for (let i = 0; i < smoothed.length - 1; i++) {
        const p0 = smoothed[i];
        const p1 = smoothed[i + 1];
        const q = {
          x: p0.x * 0.75 + p1.x * 0.25,
          z: p0.z * 0.75 + p1.z * 0.25,
          y: 0,
        };
        const r = {
          x: p0.x * 0.25 + p1.x * 0.75,
          z: p0.z * 0.25 + p1.z * 0.75,
          y: 0,
        };
        q.y = this.terrainSystem!.getHeightAt(q.x, q.z);
        r.y = this.terrainSystem!.getHeightAt(r.x, r.z);
        newPath.push(q, r);
      }
      newPath.push(smoothed[smoothed.length - 1]);
      smoothed = newPath;
    }

    this.resetRandom(this.seed + roadIndex * 7793);
    const displaced: RoadPathPoint[] = [smoothed[0]];

    for (let i = 1; i < smoothed.length - 1; i++) {
      const point = smoothed[i];
      const prev = smoothed[i - 1];
      const next = smoothed[i + 1];
      const dirX = next.x - prev.x;
      const dirZ = next.z - prev.z;
      const length = dist2D(0, 0, dirX, dirZ);

      if (length > 0.001) {
        const perpX = -dirZ / length;
        const perpZ = dirX / length;
        const displacement =
          this.noise.simplex2D(
            point.x * noiseDisplacementScale,
            point.z * noiseDisplacementScale,
          ) * noiseDisplacementStrength;
        const newX = point.x + perpX * displacement;
        const newZ = point.z + perpZ * displacement;
        const newY = this.terrainSystem!.getHeightAt(newX, newZ);
        displaced.push(
          newY >= WATER_THRESHOLD ? { x: newX, z: newZ, y: newY } : point,
        );
      } else {
        displaced.push(point);
      }
    }
    displaced.push(smoothed[smoothed.length - 1]);

    const finalPath: RoadPathPoint[] = [displaced[0]];
    for (let i = 1; i < displaced.length; i++) {
      const last = finalPath[finalPath.length - 1];
      if (
        i === displaced.length - 1 ||
        dist2D(displaced[i].x, displaced[i].z, last.x, last.z) >=
          this.config.minPointSpacing
      ) {
        finalPath.push(displaced[i]);
      }
    }
    return finalPath;
  }

  /**
   * Build tile cache synchronously (deprecated - use buildTileCacheAsync)
   * @deprecated Use buildTileCacheAsync for non-blocking operation
   */
  private invalidateTileSegmentCaches(): void {
    this.entryStubCache.clear();
    this.mergedTileSegmentCache.clear();
  }

  private buildTileCache(): void {
    this.tileRoadCache.clear();
    this.cachedMaxRoadHalfWidth = this.roads.reduce(
      (maximum, road) =>
        Math.max(maximum, (road.width || this.config.roadWidth) / 2),
      0,
    );
    this.invalidateTileSegmentCaches();

    for (const road of this.roads) {
      for (let i = 0; i < road.path.length - 1; i++) {
        const p1 = road.path[i];
        const p2 = road.path[i + 1];

        const minTileX = Math.floor(Math.min(p1.x, p2.x) / TILE_SIZE);
        const maxTileX = Math.floor(Math.max(p1.x, p2.x) / TILE_SIZE);
        const minTileZ = Math.floor(Math.min(p1.z, p2.z) / TILE_SIZE);
        const maxTileZ = Math.floor(Math.max(p1.z, p2.z) / TILE_SIZE);

        for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
          for (let tileZ = minTileZ; tileZ <= maxTileZ; tileZ++) {
            const tileKey = `${tileX}_${tileZ}`;
            const tileMinX = tileX * TILE_SIZE;
            const tileMaxX = (tileX + 1) * TILE_SIZE;
            const tileMinZ = tileZ * TILE_SIZE;
            const tileMaxZ = (tileZ + 1) * TILE_SIZE;

            const clipped = this.clipSegmentToTile(
              p1.x,
              p1.z,
              p2.x,
              p2.z,
              tileMinX,
              tileMaxX,
              tileMinZ,
              tileMaxZ,
            );
            if (clipped) {
              const segment: RoadTileSegment = {
                start: { x: clipped.x1 - tileMinX, z: clipped.z1 - tileMinZ },
                end: { x: clipped.x2 - tileMinX, z: clipped.z2 - tileMinZ },
                width: road.width,
                roadId: road.id,
              };
              if (!this.tileRoadCache.has(tileKey))
                this.tileRoadCache.set(tileKey, []);
              this.tileRoadCache.get(tileKey)!.push(segment);
            }
          }
        }
      }
    }
  }

  /**
   * Build tile cache asynchronously with yielding to prevent main thread blocking.
   * Processes roads in batches, yielding between batches.
   * Also includes town internal roads and paths for seamless rendering.
   *
   * IMPORTANT: Also detects boundary exits during clipping to capture ALL roads
   * that cross tile boundaries, not just exploration roads.
   */
  private async buildTileCacheAsync(): Promise<void> {
    this.tileRoadCache.clear();
    this.cachedMaxRoadHalfWidth = this.roads.reduce(
      (maximum, road) =>
        Math.max(maximum, (road.width || this.config.roadWidth) / 2),
      0,
    );
    this.invalidateTileSegmentCaches();
    this.boundaryExits = []; // Clear existing boundary exits before rebuild
    const ROAD_BATCH_SIZE = 5; // Process 5 roads per batch
    const EDGE_EPSILON = 0.01; // Tolerance for detecting edge positions

    // Phase 1: Cache inter-town/POI roads AND detect boundary exits during clipping
    for (
      let roadIdx = 0;
      roadIdx < this.roads.length;
      roadIdx += ROAD_BATCH_SIZE
    ) {
      const batchEnd = Math.min(roadIdx + ROAD_BATCH_SIZE, this.roads.length);

      for (let r = roadIdx; r < batchEnd; r++) {
        const road = this.roads[r];

        for (let i = 0; i < road.path.length - 1; i++) {
          const p1 = road.path[i];
          const p2 = road.path[i + 1];

          const minTileX = Math.floor(Math.min(p1.x, p2.x) / TILE_SIZE);
          const maxTileX = Math.floor(Math.max(p1.x, p2.x) / TILE_SIZE);
          const minTileZ = Math.floor(Math.min(p1.z, p2.z) / TILE_SIZE);
          const maxTileZ = Math.floor(Math.max(p1.z, p2.z) / TILE_SIZE);

          for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
            for (let tileZ = minTileZ; tileZ <= maxTileZ; tileZ++) {
              const tileKey = `${tileX}_${tileZ}`;
              const tileMinX = tileX * TILE_SIZE;
              const tileMaxX = (tileX + 1) * TILE_SIZE;
              const tileMinZ = tileZ * TILE_SIZE;
              const tileMaxZ = (tileZ + 1) * TILE_SIZE;

              const clipped = this.clipSegmentToTile(
                p1.x,
                p1.z,
                p2.x,
                p2.z,
                tileMinX,
                tileMaxX,
                tileMinZ,
                tileMaxZ,
              );
              if (clipped) {
                // Cache the road segment for this tile
                const segment: RoadTileSegment = {
                  start: { x: clipped.x1 - tileMinX, z: clipped.z1 - tileMinZ },
                  end: { x: clipped.x2 - tileMinX, z: clipped.z2 - tileMinZ },
                  width: road.width,
                  roadId: road.id,
                };
                if (!this.tileRoadCache.has(tileKey)) {
                  this.tileRoadCache.set(tileKey, []);
                }
                this.tileRoadCache.get(tileKey)!.push(segment);

                // Detect boundary exits for cross-tile road continuity
                const segDir = Math.atan2(
                  clipped.z2 - clipped.z1,
                  clipped.x2 - clipped.x1,
                );

                // Check start point (was it clipped? → road enters this tile)
                if (
                  Math.abs(clipped.x1 - p1.x) > EDGE_EPSILON ||
                  Math.abs(clipped.z1 - p1.z) > EDGE_EPSILON
                ) {
                  // Use road direction to disambiguate corner crossings
                  const edge = this.getEdgeAtPoint(
                    clipped.x1,
                    clipped.z1,
                    tileMinX,
                    tileMaxX,
                    tileMinZ,
                    tileMaxZ,
                    EDGE_EPSILON,
                    segDir, // Pass direction for corner handling
                  );
                  if (edge) {
                    this.recordBoundaryExitForClip(
                      clipped.x1,
                      clipped.z1,
                      segDir + Math.PI,
                      road.id,
                      tileX,
                      tileZ,
                      edge,
                    );
                  }
                }

                // Check end point (was it clipped? → road exits this tile)
                if (
                  Math.abs(clipped.x2 - p2.x) > EDGE_EPSILON ||
                  Math.abs(clipped.z2 - p2.z) > EDGE_EPSILON
                ) {
                  // Use road direction to disambiguate corner crossings
                  const edge = this.getEdgeAtPoint(
                    clipped.x2,
                    clipped.z2,
                    tileMinX,
                    tileMaxX,
                    tileMinZ,
                    tileMaxZ,
                    EDGE_EPSILON,
                    segDir, // Pass direction for corner handling
                  );
                  if (edge) {
                    this.recordBoundaryExitForClip(
                      clipped.x2,
                      clipped.z2,
                      segDir,
                      road.id,
                      tileX,
                      tileZ,
                      edge,
                    );
                  }
                }
              }
            }
          }
        }
      }

      // Yield to main thread between batches
      if (batchEnd < this.roads.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    // Phase 2: Cache town internal roads and paths
    // This makes roads visually extend through towns instead of stopping at the edge
    await this.cacheTownInternalRoads();

    // Phase 3: Also detect boundary exits for road endpoints not captured by clipping
    // This catches exploration roads that end at natural features near tile edges
    this.detectRoadEndpointBoundaryExits();

    // Log tile cache statistics for debugging
    let totalSegments = 0;
    const tilesWithSegments: string[] = [];
    for (const [key, segments] of this.tileRoadCache.entries()) {
      totalSegments += segments.length;
      if (segments.length > 0) {
        tilesWithSegments.push(`${key}(${segments.length})`);
      }
    }
    Logger.system(
      "RoadNetworkSystem",
      `Tile cache built: ${this.tileRoadCache.size} tiles containing ${totalSegments} road segments`,
    );
    // Log which tiles have road segments (for debugging road visibility)
    if (tilesWithSegments.length > 0 && tilesWithSegments.length <= 20) {
      Logger.system(
        "RoadNetworkSystem",
        `Tiles with road segments: ${tilesWithSegments.join(", ")}`,
      );
    } else if (tilesWithSegments.length > 20) {
      Logger.system(
        "RoadNetworkSystem",
        `Tiles with road segments: ${tilesWithSegments.slice(0, 10).join(", ")}... and ${tilesWithSegments.length - 10} more`,
      );
    }

    if (this.boundaryExits.length > 0) {
      Logger.system(
        "RoadNetworkSystem",
        `Detected ${this.boundaryExits.length} boundary exit points for cross-tile continuity`,
      );
    }
  }

  /**
   * Determine which tile edge a point is on, if any.
   * Returns the edge name or null if not on an edge.
   *
   * For corner cases (point near two edges), uses the road direction to determine
   * the primary crossing edge - the edge perpendicular to the dominant direction component.
   *
   * @param direction - Optional road direction in radians (used for corner disambiguation)
   */
  private getEdgeAtPoint(
    x: number,
    z: number,
    tileMinX: number,
    tileMaxX: number,
    tileMinZ: number,
    tileMaxZ: number,
    epsilon: number,
    direction?: number,
  ): TileEdge | null {
    const nearWest = Math.abs(x - tileMinX) <= epsilon;
    const nearEast = Math.abs(x - tileMaxX) <= epsilon;
    const nearSouth = Math.abs(z - tileMinZ) <= epsilon;
    const nearNorth = Math.abs(z - tileMaxZ) <= epsilon;

    // Count how many edges we're near
    const edgeCount =
      (nearWest ? 1 : 0) +
      (nearEast ? 1 : 0) +
      (nearSouth ? 1 : 0) +
      (nearNorth ? 1 : 0);

    // Corner case: near two edges
    // Use road direction to determine primary edge (perpendicular to dominant direction)
    if (edgeCount >= 2 && direction !== undefined) {
      const dirX = Math.abs(Math.cos(direction));
      const dirZ = Math.abs(Math.sin(direction));

      // If road is moving more in X direction, it crosses east/west edges
      if (dirX > dirZ) {
        if (nearWest) return "west";
        if (nearEast) return "east";
      } else {
        // Road is moving more in Z direction, it crosses north/south edges
        if (nearSouth) return "south";
        if (nearNorth) return "north";
      }
    }

    // Normal case: near exactly one edge, or fallback for corners without direction
    if (nearWest) return "west";
    if (nearEast) return "east";
    if (nearSouth) return "south";
    if (nearNorth) return "north";

    return null;
  }

  /**
   * Record a boundary exit detected during segment clipping.
   * Skips duplicates based on (roadId, tileX, tileZ, edge).
   */
  private recordBoundaryExitForClip(
    x: number,
    z: number,
    direction: number,
    roadId: string,
    tileX: number,
    tileZ: number,
    edge: TileEdge,
  ): void {
    // Skip if duplicate (same road, tile, and edge)
    const isDuplicate = this.boundaryExits.some(
      (e) =>
        e.roadId === roadId &&
        e.tileX === tileX &&
        e.tileZ === tileZ &&
        e.edge === edge,
    );
    if (isDuplicate) return;

    this.boundaryExits.push({
      roadId,
      position: { x, z },
      direction,
      tileX,
      tileZ,
      edge,
    });
  }

  /**
   * Detect boundary exits for road endpoints that weren't captured by segment clipping.
   * This handles roads that END at a tile boundary (e.g., exploration roads to natural features).
   *
   * The main boundary exit detection happens during buildTileCacheAsync() when segments
   * are clipped to tiles. This function is a supplementary check for endpoints.
   */
  private detectRoadEndpointBoundaryExits(): void {
    for (const road of this.roads) {
      if (road.path.length < 2) continue;

      // Check start point - only for roads not starting at towns
      // (Town roads start inside the town, not at tile boundaries)
      if (!road.fromTownId || road.fromTownId === "") {
        const startPoint = road.path[0];
        const secondPoint = road.path[1];
        const startDirection = Math.atan2(
          secondPoint.z - startPoint.z,
          secondPoint.x - startPoint.x,
        );

        // Opposite direction - pointing away from the road (into the wilderness)
        this.recordBoundaryExitIfAtEdge(
          startPoint.x,
          startPoint.z,
          startDirection + Math.PI,
          road.id,
        );
      }

      // Check end point - only for roads not ending at towns
      // (Exploration roads to natural features may end near tile boundaries)
      if (!road.toTownId || road.toTownId === "") {
        const endPoint = road.path[road.path.length - 1];
        const secondLastPoint = road.path[road.path.length - 2];
        const endDirection = Math.atan2(
          endPoint.z - secondLastPoint.z,
          endPoint.x - secondLastPoint.x,
        );

        this.recordBoundaryExitIfAtEdge(
          endPoint.x,
          endPoint.z,
          endDirection,
          road.id,
        );
      }
    }
  }

  /**
   * Cache town internal roads, paths, and plazas for terrain rendering.
   * This ensures roads visually connect through towns.
   */
  private async cacheTownInternalRoads(): Promise<void> {
    if (!this.townSystem) return;

    const towns = this.townSystem.getTowns();
    const TOWN_ROAD_WIDTH = 8; // Main street width (wider than inter-town roads)
    const TOWN_PATH_WIDTH = 3; // Walkway paths to buildings - visible but narrower than roads

    for (const town of towns) {
      // Cache internal roads (main streets through town)
      const internalRoads = town.internalRoads ?? [];
      for (let i = 0; i < internalRoads.length; i++) {
        const road = internalRoads[i];
        const roadWidth = road.isMain ? TOWN_ROAD_WIDTH : 6;
        this.cacheRoadSegment(
          road.start.x,
          road.start.z,
          road.end.x,
          road.end.z,
          roadWidth,
          `${town.id}_internal_${i}`,
        );
      }

      // Cache paths from roads to building entrances
      const paths = town.paths ?? [];
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        this.cacheRoadSegment(
          path.start.x,
          path.start.z,
          path.end.x,
          path.end.z,
          path.width || TOWN_PATH_WIDTH,
          `${town.id}_path_${i}`,
        );
      }

      // Cache plaza as radial road segments (star pattern for circular coverage)
      const plaza = town.plaza;
      if (plaza) {
        const plazaSegments = 8; // 8 directions for good coverage
        for (let i = 0; i < plazaSegments; i++) {
          const angle = (i / plazaSegments) * Math.PI * 2;
          const endX = plaza.position.x + Math.cos(angle) * plaza.radius;
          const endZ = plaza.position.z + Math.sin(angle) * plaza.radius;

          this.cacheRoadSegment(
            plaza.position.x,
            plaza.position.z,
            endX,
            endZ,
            plaza.radius * 1.5, // Wide enough to fill the plaza
            `${town.id}_plaza_${i}`,
          );
        }
      }

      // Yield periodically
      if (towns.indexOf(town) % 5 === 4) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  /**
   * Cache a single road segment into the tile cache.
   * Handles clipping to tile boundaries.
   */
  private cacheRoadSegment(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    width: number,
    roadId: string,
  ): void {
    // Any new segment changes tile contents and potentially boundary entries.
    this.invalidateTileSegmentCaches();

    const minTileX = Math.floor(Math.min(x1, x2) / TILE_SIZE);
    const maxTileX = Math.floor(Math.max(x1, x2) / TILE_SIZE);
    const minTileZ = Math.floor(Math.min(z1, z2) / TILE_SIZE);
    const maxTileZ = Math.floor(Math.max(z1, z2) / TILE_SIZE);

    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
      for (let tileZ = minTileZ; tileZ <= maxTileZ; tileZ++) {
        const tileKey = `${tileX}_${tileZ}`;
        const tileMinX = tileX * TILE_SIZE;
        const tileMaxX = (tileX + 1) * TILE_SIZE;
        const tileMinZ = tileZ * TILE_SIZE;
        const tileMaxZ = (tileZ + 1) * TILE_SIZE;

        const clipped = this.clipSegmentToTile(
          x1,
          z1,
          x2,
          z2,
          tileMinX,
          tileMaxX,
          tileMinZ,
          tileMaxZ,
        );

        if (clipped) {
          const segment: RoadTileSegment = {
            start: { x: clipped.x1 - tileMinX, z: clipped.z1 - tileMinZ },
            end: { x: clipped.x2 - tileMinX, z: clipped.z2 - tileMinZ },
            width,
            roadId,
          };

          if (!this.tileRoadCache.has(tileKey)) {
            this.tileRoadCache.set(tileKey, []);
          }
          this.tileRoadCache.get(tileKey)!.push(segment);
        }
      }
    }
  }

  /** Cohen-Sutherland line clipping */
  private clipSegmentToTile(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): { x1: number; z1: number; x2: number; z2: number } | null {
    const INSIDE = 0,
      LEFT = 1,
      RIGHT = 2,
      BOTTOM = 4,
      TOP = 8;

    const computeCode = (x: number, z: number): number => {
      let code = INSIDE;
      if (x < minX) code |= LEFT;
      else if (x > maxX) code |= RIGHT;
      if (z < minZ) code |= BOTTOM;
      else if (z > maxZ) code |= TOP;
      return code;
    };

    let code1 = computeCode(x1, z1);
    let code2 = computeCode(x2, z2);

    while (true) {
      if ((code1 | code2) === 0) return { x1, z1, x2, z2 };
      if ((code1 & code2) !== 0) return null;

      const codeOut = code1 !== 0 ? code1 : code2;
      let x: number, z: number;

      if (codeOut & TOP) {
        x = x1 + ((x2 - x1) * (maxZ - z1)) / (z2 - z1);
        z = maxZ;
      } else if (codeOut & BOTTOM) {
        x = x1 + ((x2 - x1) * (minZ - z1)) / (z2 - z1);
        z = minZ;
      } else if (codeOut & RIGHT) {
        z = z1 + ((z2 - z1) * (maxX - x1)) / (x2 - x1);
        x = maxX;
      } else {
        z = z1 + ((z2 - z1) * (minX - x1)) / (x2 - x1);
        x = minX;
      }

      if (codeOut === code1) {
        x1 = x;
        z1 = z;
        code1 = computeCode(x1, z1);
      } else {
        x2 = x;
        z2 = z;
        code2 = computeCode(x2, z2);
      }
    }
  }

  /** Direction angles pointing INTO a tile from each edge */
  private static readonly DIRECTION_INTO_TILE: Record<TileEdge, number> = {
    west: 0, // East
    east: Math.PI, // West
    south: Math.PI / 2, // North
    north: -Math.PI / 2, // South
  };

  /** Length of entry stub segments in meters */
  private static readonly STUB_LENGTH = 15;

  /**
   * Get road segments for a tile, including entry stubs from adjacent tiles.
   * Entry stubs ensure visual continuity across tile boundaries.
   */
  getRoadSegmentsForTile(tileX: number, tileZ: number): RoadTileSegment[] {
    const key = `${tileX}_${tileZ}`;
    const mergedCached = this.mergedTileSegmentCache.get(key);
    if (mergedCached) {
      return mergedCached;
    }

    const cachedSegments = this.tileRoadCache.get(key) || [];

    // Get or generate entry stub segments from adjacent tiles
    let stubSegments = this.entryStubCache.get(key);
    if (!stubSegments) {
      const entries = this.getRoadEntriesForTile(tileX, tileZ);
      stubSegments =
        entries.length > 0
          ? this.generateEntryStubSegments(tileX, tileZ, entries)
          : [];
      this.entryStubCache.set(key, stubSegments);
    }

    const merged = [...cachedSegments, ...stubSegments];
    // A centerline need not enter this tile for its width/blend to influence it.
    // Retain neighboring real segments in this tile's local coordinates; do not
    // invent an extension or snap away the actual endpoint at the boundary.
    const appendHalo = (
      segment: RoadTileSegment,
      offsetX: number,
      offsetZ: number,
    ) => {
      const start = {
        x: segment.start.x + offsetX,
        z: segment.start.z + offsetZ,
      };
      const end = { x: segment.end.x + offsetX, z: segment.end.z + offsetZ };
      const padding = segment.width / 2 + ROAD_MASK_BLEND_WIDTH;
      if (
        Math.max(start.x, end.x) + padding < 0 ||
        Math.min(start.x, end.x) - padding > TILE_SIZE ||
        Math.max(start.z, end.z) + padding < 0 ||
        Math.min(start.z, end.z) - padding > TILE_SIZE
      )
        return;
      merged.push({ start, end, width: segment.width, roadId: segment.roadId });
    };
    const radius = Math.max(
      1,
      Math.ceil(
        (this.cachedMaxRoadHalfWidth + ROAD_MASK_BLEND_WIDTH) / TILE_SIZE,
      ),
    );
    if (radius <= 8) {
      for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
          if (dx === 0 && dz === 0) continue;
          for (const segment of this.tileRoadCache.get(
            `${tileX + dx}_${tileZ + dz}`,
          ) ?? [])
            appendHalo(segment, dx * TILE_SIZE, dz * TILE_SIZE);
        }
    } else {
      for (const road of this.roads)
        for (let i = 1; i < road.path.length; i++) {
          const a = road.path[i - 1],
            b = road.path[i];
          appendHalo(
            {
              start: { x: a.x, z: a.z },
              end: { x: b.x, z: b.z },
              width: road.width,
              roadId: road.id,
            },
            -tileX * TILE_SIZE,
            -tileZ * TILE_SIZE,
          );
        }
    }
    this.mergedTileSegmentCache.set(key, merged);
    return merged;
  }

  /**
   * Get the authoritative road influence texture data (GPU-generated).
   * Used by vegetation systems for unified road masking.
   */
  getRoadInfluenceTextureData(): RoadInfluenceTextureData | null {
    return this.roadInfluenceTextureData;
  }

  /**
   * Generate stub segments for road entries from adjacent tiles.
   * Uses the actual road direction (not just perpendicular to edge) for seamless continuity.
   */
  private generateEntryStubSegments(
    tileX: number,
    tileZ: number,
    entries: RoadBoundaryExit[],
  ): RoadTileSegment[] {
    const tileMinX = tileX * TILE_SIZE;
    const tileMinZ = tileZ * TILE_SIZE;
    const segments: RoadTileSegment[] = [];

    for (const entry of entries) {
      const localX = entry.position.x - tileMinX;
      const localZ = entry.position.z - tileMinZ;

      // Use actual road direction for seamless continuity across tiles.
      // entry.direction is the direction the road was heading when it exited the adjacent tile.
      // For roads at angles (not perpendicular to edges), this preserves the road's trajectory.
      // Fallback to perpendicular direction only if entry.direction is missing/invalid.
      let dir: number;
      if (typeof entry.direction === "number" && isFinite(entry.direction)) {
        dir = entry.direction;
      } else {
        // Fallback: use perpendicular direction into tile (legacy behavior)
        dir = RoadNetworkSystem.DIRECTION_INTO_TILE[entry.edge];
      }

      // Calculate stub endpoint, clamped to tile bounds
      const endX = Math.max(
        0,
        Math.min(
          TILE_SIZE,
          localX + Math.cos(dir) * RoadNetworkSystem.STUB_LENGTH,
        ),
      );
      const endZ = Math.max(
        0,
        Math.min(
          TILE_SIZE,
          localZ + Math.sin(dir) * RoadNetworkSystem.STUB_LENGTH,
        ),
      );

      // Only add stub with meaningful length (> 1m)
      const dx = endX - localX,
        dz = endZ - localZ;
      if (dx * dx + dz * dz > 1) {
        segments.push({
          start: { x: localX, z: localZ },
          end: { x: endX, z: endZ },
          width: this.getRoadById(entry.roadId)?.width || this.config.roadWidth,
          roadId: entry.roadId,
        });
      }
    }

    return segments;
  }

  getRoads(): ProceduralRoad[] {
    return this.roads;
  }

  getRoadById(id: string): ProceduralRoad | undefined {
    return this.roads.find((r) => r.id === id);
  }

  /**
   * Get distance to nearest road segment.
   *
   * OPTIMIZATION: Uses tile-based spatial cache to avoid checking all road segments.
   * Only checks segments in the current tile and adjacent tiles (9 tiles total).
   * Falls back to full search if no cached segments found nearby.
   */
  getDistanceToNearestRoad(x: number, z: number): number {
    // Get tile coordinates (assuming 100-unit tiles like TerrainSystem)
    const tileSize = 100;
    const tileX = Math.floor(x / tileSize);
    const tileZ = Math.floor(z / tileSize);

    // Check current tile and 8 adjacent tiles (3x3 grid)
    let minDistance = Infinity;
    let foundSegments = false;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const segments = this.tileRoadCache.get(`${tileX + dx}_${tileZ + dz}`);
        if (!segments) continue;

        foundSegments = true;
        for (const segment of segments) {
          // RoadTileSegment uses local tile coordinates, convert to world
          const worldStartX = (tileX + dx) * tileSize + segment.start.x;
          const worldStartZ = (tileZ + dz) * tileSize + segment.start.z;
          const worldEndX = (tileX + dx) * tileSize + segment.end.x;
          const worldEndZ = (tileZ + dz) * tileSize + segment.end.z;

          minDistance = Math.min(
            minDistance,
            this.distanceToSegment(
              x,
              z,
              worldStartX,
              worldStartZ,
              worldEndX,
              worldEndZ,
            ),
          );
        }
      }
    }

    // If we found segments in nearby tiles, use that result
    if (foundSegments) {
      return minDistance;
    }

    // Fallback: full search if no cached segments (roads not yet generated for this area)
    for (const road of this.roads) {
      for (let i = 0; i < road.path.length - 1; i++) {
        const p1 = road.path[i];
        const p2 = road.path[i + 1];
        minDistance = Math.min(
          minDistance,
          this.distanceToSegment(x, z, p1.x, p1.z, p2.x, p2.z),
        );
      }
    }
    return minDistance;
  }

  isOnRoad(x: number, z: number): boolean {
    return this.getRoadInfluenceAt(x, z) === 1;
  }

  private distanceToSegment(
    px: number,
    pz: number,
    x1: number,
    z1: number,
    x2: number,
    z2: number,
  ): number {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq === 0) return dist2D(px, pz, x1, z1);
    const t = Math.max(
      0,
      Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / lengthSq),
    );
    return dist2D(px, pz, x1 + t * dx, z1 + t * dz);
  }

  getRoadNetwork(): RoadNetwork | null {
    if (!this.townSystem && this.roads.length === 0) return null;
    return {
      towns: this.townSystem?.getTowns() ?? [],
      pois: this.poiSystem?.getPOIs() ?? [],
      roads: this.roads,
      seed: this.seed,
      generatedAt: Date.now(),
      boundaryExits:
        this.boundaryExits.length > 0 ? [...this.boundaryExits] : undefined,
    };
  }

  /**
   * Calculate road influence at a world position.
   * Returns 0-1 where 1 = center of road, 0 = no road influence.
   * Includes smooth falloff at road edges for grass blending.
   *
   * @param worldX - World X coordinate
   * @param worldZ - World Z coordinate
   * @param extraBlendWidth - Additional blend width beyond road edge (default: 0.5m)
   * @returns Road influence value (0-1)
   */
  getRoadInfluenceAt(
    worldX: number,
    worldZ: number,
    extraBlendWidth: number = 0.5,
  ): number {
    let influence = 0;
    const radius = Math.max(
      1,
      Math.ceil((this.cachedMaxRoadHalfWidth + extraBlendWidth) / TILE_SIZE),
    );
    // Preserve the existing localized query cost. Maximum cached width controls
    // the search halo; exceptionally wide roads use the bounded road list.
    if (this.tileRoadCache.size && radius <= 8) {
      const tx = Math.floor(worldX / TILE_SIZE),
        tz = Math.floor(worldZ / TILE_SIZE);
      for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
          const segments = this.tileRoadCache.get(`${tx + dx}_${tz + dz}`);
          if (!segments) continue;
          const originX = (tx + dx) * TILE_SIZE,
            originZ = (tz + dz) * TILE_SIZE;
          for (const segment of segments) {
            influence = Math.max(
              influence,
              roadSegmentInfluence(
                worldX,
                worldZ,
                originX + segment.start.x,
                originZ + segment.start.z,
                originX + segment.end.x,
                originZ + segment.end.z,
                segment.width,
                extraBlendWidth,
              ),
            );
            if (influence === 1) return influence;
          }
        }
      return influence;
    }
    // Evaluate each segment's own width: nearest centerline is not necessarily
    // the most influential road when a narrow spur meets a wider approach.
    for (const road of this.roads) {
      const width = road.width || this.config.roadWidth;
      for (let i = 1; i < road.path.length; i++) {
        const a = road.path[i - 1],
          b = road.path[i];
        influence = Math.max(
          influence,
          roadSegmentInfluence(
            worldX,
            worldZ,
            a.x,
            a.z,
            b.x,
            b.z,
            width,
            extraBlendWidth,
          ),
        );
        if (influence === 1) return influence;
      }
    }
    return influence;
  }

  private getNarrowestRoadWidth(): number {
    return this.roads.reduce(
      (width, road) => Math.min(width, road.width || this.config.roadWidth),
      this.config.roadWidth,
    );
  }

  /**
   * Get all road segments in GPU-compatible format.
   * Used by TerrainComputeContext for GPU-accelerated road influence.
   */
  getRoadSegmentsForGPU(): GPURoadSegment[] {
    const segments: GPURoadSegment[] = [];

    for (const road of this.roads) {
      const width = road.width || this.config.roadWidth;
      for (let i = 0; i < road.path.length - 1; i++) {
        const p1 = road.path[i];
        const p2 = road.path[i + 1];
        segments.push({
          startX: p1.x,
          startZ: p1.z,
          endX: p2.x,
          endZ: p2.z,
          width,
        });
      }
    }

    return segments;
  }

  /**
   * Generate a road influence texture for GPU grass masking.
   * The texture covers the world and stores road influence in the red channel.
   *
   * AUTO-RESOLUTION: If textureSize is not provided, automatically calculates
   * a resolution that ensures roads are at least 2 pixels wide for proper sampling.
   * This prevents sub-pixel roads from being missed by grass/flower culling.
   *
   * @param textureSize - Size of the texture (power of 2 recommended). If 0, auto-calculate.
   * @param worldSize - Size of the world in meters (default: from config)
   * @param extraBlendWidth - Additional blend width for grass fade (default: 0.5m)
   * @returns Float32 DataTexture with road influence values
   */
  generateRoadInfluenceTexture(
    textureSize: number = 0, // 0 = auto-calculate
    worldSize?: number,
    extraBlendWidth: number = 0.5,
    centerX: number = this.worldCenterX,
    centerZ: number = this.worldCenterZ,
  ): {
    data: Float32Array;
    width: number;
    height: number;
    worldSize: number;
    centerX: number;
    centerZ: number;
  } | null {
    if (this.roads.length === 0) {
      Logger.systemWarn(
        "RoadNetworkSystem",
        "No roads generated, skipping road influence texture",
      );
      return null;
    }

    // Get world size from config or use provided value
    const actualWorldSize = worldSize ?? this.worldHalfSize * 2;

    // Auto-calculate texture resolution to ensure roads are at least 2 pixels wide
    // This prevents sub-pixel roads from being missed by grass/flower culling
    let finalTextureSize: number;
    if (textureSize === 0) {
      // Target: road width should span at least 2 pixels
      // road influence extends halfWidth + extraBlendWidth, so use full influence width
      const roadInfluenceWidth =
        this.getNarrowestRoadWidth() / 2 + extraBlendWidth;
      const minPixelsPerRoadInfluence = 2;
      const metersPerPixelTarget =
        roadInfluenceWidth / minPixelsPerRoadInfluence;
      const minResolution = Math.ceil(actualWorldSize / metersPerPixelTarget);

      // Round up to nearest power of 2, capped at 2048 for performance
      finalTextureSize = Math.min(
        2048,
        Math.pow(2, Math.ceil(Math.log2(Math.max(256, minResolution)))),
      );

      Logger.system(
        "RoadNetworkSystem",
        `Auto-calculated road texture size: ${finalTextureSize} ` +
          `(road influence width: ${roadInfluenceWidth.toFixed(1)}m, ` +
          `world: ${actualWorldSize}m)`,
      );
    } else {
      finalTextureSize = textureSize;
    }

    const metersPerPixel = actualWorldSize / finalTextureSize;

    if (
      !Number.isSafeInteger(finalTextureSize) ||
      finalTextureSize < 1 ||
      finalTextureSize > ROAD_MASK_MAX_TEXTURE_SIZE ||
      ![actualWorldSize, centerX, centerZ, extraBlendWidth].every(
        Number.isFinite,
      ) ||
      actualWorldSize <= 0 ||
      extraBlendWidth < 0
    ) {
      throw new Error(
        "Road influence texture requires bounded dimensions and finite world coordinates",
      );
    }

    // Warn if roads are still sub-pixel (shouldn't happen with auto-calc)
    const roadHalfWidth = this.getNarrowestRoadWidth() / 2;
    const pixelsPerRoadCenter = roadHalfWidth / metersPerPixel;
    if (pixelsPerRoadCenter < 1) {
      Logger.systemWarn(
        "RoadNetworkSystem",
        `Road centers may be sub-pixel: ${pixelsPerRoadCenter.toFixed(2)} pixels per road half-width. ` +
          `Consider increasing texture size above ${finalTextureSize}.`,
      );
    }

    // Create texture data (single channel float)
    const data = new Float32Array(finalTextureSize * finalTextureSize);

    // Rasterize only each segment's influence AABB. Texel coordinates and
    // maximum-of-per-width influences match the existing GPU mask kernel.
    const halfWorld = actualWorldSize / 2;
    for (const segment of this.getRoadSegmentsForGPU()) {
      const padding = segment.width / 2 + extraBlendWidth;
      const pixel = (value: number, center: number) =>
        ((value - center + halfWorld) / actualWorldSize) * finalTextureSize;
      const minX = Math.max(
        0,
        Math.floor(
          pixel(Math.min(segment.startX, segment.endX) - padding, centerX),
        ),
      );
      const maxX = Math.min(
        finalTextureSize - 1,
        Math.ceil(
          pixel(Math.max(segment.startX, segment.endX) + padding, centerX),
        ),
      );
      const minZ = Math.max(
        0,
        Math.floor(
          pixel(Math.min(segment.startZ, segment.endZ) - padding, centerZ),
        ),
      );
      const maxZ = Math.min(
        finalTextureSize - 1,
        Math.ceil(
          pixel(Math.max(segment.startZ, segment.endZ) + padding, centerZ),
        ),
      );
      for (let y = minZ; y <= maxZ; y++)
        for (let x = minX; x <= maxX; x++) {
          const worldX =
            (x / finalTextureSize) * actualWorldSize - halfWorld + centerX;
          const worldZ =
            (y / finalTextureSize) * actualWorldSize - halfWorld + centerZ;
          const influence = roadSegmentInfluence(
            worldX,
            worldZ,
            segment.startX,
            segment.startZ,
            segment.endX,
            segment.endZ,
            segment.width,
            extraBlendWidth,
          );
          const index = y * finalTextureSize + x;
          data[index] = Math.max(data[index], influence);
        }
    }

    Logger.system(
      "RoadNetworkSystem",
      `Generated road influence texture (CPU): ${finalTextureSize}x${finalTextureSize}, ` +
        `${metersPerPixel.toFixed(1)}m/pixel, ${pixelsPerRoadCenter.toFixed(1)} pixels per road half-width`,
    );

    return {
      data,
      width: finalTextureSize,
      height: finalTextureSize,
      worldSize: actualWorldSize,
      centerX,
      centerZ,
    };
  }

  // ============================================================================
  // DEBUG VISUALIZATION
  // ============================================================================

  private debugGroup: THREE.Group | null = null;
  private debugEnabled = false;
  private static readonly DEBUG_HEIGHT = 5; // Meters above ground

  /**
   * Toggle debug road visualization on/off.
   * When enabled, draws elevated lines showing road paths.
   */
  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
    if (this.debugGroup) {
      this.debugGroup.visible = enabled;
    }
    Logger.system(
      "RoadNetworkSystem",
      `Debug visualization ${enabled ? "enabled" : "disabled"}`,
    );
  }

  isDebugEnabled(): boolean {
    return this.debugEnabled;
  }

  /**
   * Create debug visualization meshes for all roads.
   * Call this after roads are generated to visualize road paths.
   * @param scene - The THREE.Scene to add debug meshes to
   * @param terrainSystem - Optional terrain system for height sampling
   */
  createDebugVisualization(
    scene: THREE.Scene,
    terrainSystem?: { getHeightAt(x: number, z: number): number },
  ): THREE.Group {
    // Clean up existing debug group
    if (this.debugGroup) {
      scene.remove(this.debugGroup);
      this.debugGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry?.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material?.dispose();
          }
        }
      });
    }

    this.debugGroup = new THREE.Group();
    this.debugGroup.name = "RoadDebugVisualization";
    this.debugGroup.visible = this.debugEnabled;

    if (this.roads.length === 0) {
      scene.add(this.debugGroup);
      return this.debugGroup;
    }

    // Materials for debug visualization
    const roadLineMaterial = new THREE.LineBasicMaterial({
      color: 0xff00ff, // Magenta for regular roads
      linewidth: 2,
    });
    const mainRoadLineMaterial = new THREE.LineBasicMaterial({
      color: 0x00ffff, // Cyan for main roads
      linewidth: 3,
    });
    const vertexMaterial = new THREE.MeshBasicMaterial({
      color: 0xffff00, // Yellow spheres at vertices
    });
    const groundRingMaterial = new THREE.MeshBasicMaterial({
      color: 0xffff00,
      side: THREE.DoubleSide,
    });

    // Shared geometries
    const sphereGeometry = new THREE.SphereGeometry(1, 8, 8);
    const ringGeometry = new THREE.RingGeometry(1.5, 2, 16);
    ringGeometry.rotateX(-Math.PI / 2); // Lay flat

    let ringCount = 0;

    for (const road of this.roads) {
      if (road.path.length < 2) continue;

      // Determine if this is a main road (town-to-town connections)
      const isMainRoad =
        road.fromType === "town" &&
        road.toType === "town" &&
        road.fromTownId &&
        road.toTownId;

      // Create elevated line showing road path
      const linePoints: THREE.Vector3[] = road.path.map((point) => {
        const groundY = terrainSystem?.getHeightAt(point.x, point.z) ?? 0;
        return new THREE.Vector3(
          point.x,
          groundY + RoadNetworkSystem.DEBUG_HEIGHT,
          point.z,
        );
      });

      const lineGeometry = new THREE.BufferGeometry().setFromPoints(linePoints);
      const lineMaterial = isMainRoad ? mainRoadLineMaterial : roadLineMaterial;
      const line = new THREE.Line(lineGeometry, lineMaterial);
      line.name = `debug-road-line-${road.id}`;
      this.debugGroup.add(line);

      // Add spheres at path vertices
      for (const point of linePoints) {
        const sphere = new THREE.Mesh(sphereGeometry, vertexMaterial);
        sphere.position.copy(point);
        sphere.scale.setScalar(0.5);
        this.debugGroup.add(sphere);
      }

      // Add ground-level rings every ~20m
      for (let i = 0; i < road.path.length - 1; i++) {
        const p1 = road.path[i];
        const p2 = road.path[i + 1];
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const segmentLength = Math.sqrt(dx * dx + dz * dz);
        const steps = Math.max(1, Math.floor(segmentLength / 20));

        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = p1.x + dx * t;
          const z = p1.z + dz * t;
          const groundY = terrainSystem?.getHeightAt(x, z) ?? 0;

          const ring = new THREE.Mesh(ringGeometry, groundRingMaterial);
          ring.position.set(x, groundY + 0.2, z);
          this.debugGroup.add(ring);
          ringCount++;
        }
      }
    }

    scene.add(this.debugGroup);

    Logger.system(
      "RoadNetworkSystem",
      `Created debug visualization: ${this.roads.length} roads, ${ringCount} ground markers`,
    );

    return this.debugGroup;
  }

  /**
   * Remove debug visualization from scene.
   */
  removeDebugVisualization(): void {
    if (this.debugGroup?.parent) {
      this.debugGroup.parent.remove(this.debugGroup);
      this.debugGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry?.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material?.dispose();
          }
        }
      });
      this.debugGroup = null;
    }
  }

  destroy(): void {
    this.removeDebugVisualization();
    this.roads = [];
    this.tileRoadCache.clear();
    this.invalidateTileSegmentCaches();
    this.boundaryExits = [];
    this.cachedMaxRoadHalfWidth = 0;
    this.roadInfluenceTextureData = null;
    super.destroy();
  }
}
