/**
 * TownSystem - Procedural Town Generation
 * Generates deterministic towns with flatness-based placement.
 * Towns are safe zones with bank/store/anvil buildings.
 *
 * This system delegates procedural generation to @hyperforge/procgen/building/town
 * while handling runtime concerns (manifest loading, terrain integration, queries).
 *
 * **Building Collision:**
 * - Generates building layouts using BuildingGenerator
 * - Registers collision data with BuildingCollisionService
 * - Stores layouts for BuildingRenderingSystem to reuse
 *
 * Configuration loaded from world-config.json via DataManager.
 * IMPORTANT: DataManager.loadManifests*() must be called BEFORE TownSystem.init()
 * otherwise default configuration values will be used.
 */

import { System } from "../infrastructure/System";
import type { World } from "../../../core/World";
import type {
  ProceduralTown,
  TownBuilding,
  TownSize,
  TownBuildingType,
  ManifestTown,
  ManifestTownSize,
  TownEntryPoint,
  TownInternalRoad,
  TownPath,
  TownLandmark,
  TownPlaza,
  WorldConfigManifest,
} from "../../../types/world/world-types";
import type { BuildingLayoutInput } from "../../../types/world/building-collision-types";
import { Logger } from "../../../utils/Logger";
import { DataManager } from "../../../data/DataManager";
import {
  TownGenerator,
  type TownGeneratorConfig,
  type LandmarkConfig,
  type TownSizeConfig,
  type GeneratedTown,
  type TerrainProvider,
  DEFAULT_LANDMARK_CONFIG,
} from "@hyperforge/procgen/building/town";
import {
  BuildingGenerator,
  type BuildingLayout,
  type PropPlacements,
  CELL_SIZE,
  FOUNDATION_HEIGHT,
  FOUNDATION_OVERHANG,
  ENTRANCE_STEP_HEIGHT,
  TILES_PER_CELL,
  NPC_BEHIND_COUNTER_OFFSET,
  snapToBuildingGrid,
  getCellCenter,
  getSideVector,
} from "@hyperforge/procgen/building";
import { BuildingCollisionService } from "./BuildingCollisionService";
import type {
  FlatZone,
  FlatZoneTile,
  FlatZoneTileBounds,
} from "../../../types/world/terrain";
import {
  cellToWorldTile,
  tileKey,
} from "../../../types/world/building-collision-types";
import { BFSPathfinder } from "../movement/BFSPathfinder";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import { DEFAULT_BIOME } from "./TerrainBiomeTypes";

// Default configuration values
// IMPORTANT: waterThreshold must match TERRAIN_CONSTANTS.WATER_THRESHOLD (9.0)
// to ensure town candidates are placed on actual land, not underwater
const DEFAULTS = {
  townCount: 25,
  worldSize: 10000,
  minTownSpacing: 800,
  flatnessSampleRadius: 40,
  flatnessSampleCount: 16,
  waterThreshold: TERRAIN_CONSTANTS.WATER_THRESHOLD, // 9.0 - must match TerrainSystem
  optimalWaterDistanceMin: 30,
  optimalWaterDistanceMax: 150,
} as const;

const DEFAULT_TOWN_SIZES: Record<TownSize, TownSizeConfig> = {
  hamlet: { buildingCount: { min: 3, max: 5 }, radius: 25, safeZoneRadius: 40 },
  village: {
    buildingCount: { min: 6, max: 10 },
    radius: 40,
    safeZoneRadius: 60,
  },
  town: { buildingCount: { min: 11, max: 16 }, radius: 60, safeZoneRadius: 80 },
};

const DEFAULT_BIOME_SUITABILITY: Record<string, number> = {
  forest: 0.8,
  tundra: 0.4,
  canyon: 0.3,
};

function isTruthyEnv(rawValue: string | undefined): boolean {
  if (!rawValue) return false;
  return ["1", "true", "yes", "on"].includes(rawValue.trim().toLowerCase());
}

/** Town configuration loaded from world-config.json (exported for testing) */
export interface TownConfig {
  townCount: number;
  worldSize: number;
  minTownSpacing: number;
  flatnessSampleRadius: number;
  flatnessSampleCount: number;
  waterThreshold: number;
  optimalWaterDistanceMin: number;
  optimalWaterDistanceMax: number;
  townSizes: Record<TownSize, TownSizeConfig>;
  biomeSuitability: Record<string, number>;
  landmarks: LandmarkConfig;
}

/** Project a supplied manifest, or the admitted startup manifest, into town settings. */
export function loadTownConfig(
  worldConfig: WorldConfigManifest | null = DataManager.getWorldConfig(),
): TownConfig {
  const manifest = worldConfig?.towns;
  const sizes = { ...DEFAULT_TOWN_SIZES };
  const suitability = { ...DEFAULT_BIOME_SUITABILITY };
  const manifestLandmarks = manifest?.landmarks;
  const landmarks: LandmarkConfig = {
    fencesEnabled:
      manifestLandmarks?.fencesEnabled ?? DEFAULT_LANDMARK_CONFIG.fencesEnabled,
    fenceDensity:
      manifestLandmarks?.fenceDensity ?? DEFAULT_LANDMARK_CONFIG.fenceDensity,
    fencePostHeight:
      manifestLandmarks?.fencePostHeight ??
      DEFAULT_LANDMARK_CONFIG.fencePostHeight,
    lamppostsInVillages:
      manifestLandmarks?.lamppostsInVillages ??
      DEFAULT_LANDMARK_CONFIG.lamppostsInVillages,
    lamppostSpacing:
      manifestLandmarks?.lamppostSpacing ??
      DEFAULT_LANDMARK_CONFIG.lamppostSpacing,
    marketStallsEnabled:
      manifestLandmarks?.marketStallsEnabled ??
      DEFAULT_LANDMARK_CONFIG.marketStallsEnabled,
    decorationsEnabled:
      manifestLandmarks?.decorationsEnabled ??
      DEFAULT_LANDMARK_CONFIG.decorationsEnabled,
  };

  if (manifest?.townSizes) {
    for (const key of ["hamlet", "village", "town"] as const) {
      const src = manifest.townSizes[key];
      if (src) {
        sizes[key] = {
          buildingCount: { min: src.minBuildings, max: src.maxBuildings },
          radius: src.radius,
          safeZoneRadius: src.safeZoneRadius,
        };
      }
    }
  }

  if (manifest?.biomeSuitability) {
    Object.assign(suitability, manifest.biomeSuitability);
  }

  return {
    townCount: manifest?.townCount ?? DEFAULTS.townCount,
    worldSize: worldConfig
      ? worldConfig.terrain.worldSize * worldConfig.terrain.tileSize
      : DEFAULTS.worldSize,
    minTownSpacing: manifest?.minTownSpacing ?? DEFAULTS.minTownSpacing,
    flatnessSampleRadius:
      manifest?.flatnessSampleRadius ?? DEFAULTS.flatnessSampleRadius,
    flatnessSampleCount:
      manifest?.flatnessSampleCount ?? DEFAULTS.flatnessSampleCount,
    waterThreshold: manifest?.waterThreshold ?? DEFAULTS.waterThreshold,
    optimalWaterDistanceMin:
      manifest?.optimalWaterDistanceMin ?? DEFAULTS.optimalWaterDistanceMin,
    optimalWaterDistanceMax:
      manifest?.optimalWaterDistanceMax ?? DEFAULTS.optimalWaterDistanceMax,
    townSizes: sizes,
    biomeSuitability: suitability,
    landmarks,
  };
}

const dist2D = (x1: number, z1: number, x2: number, z2: number): number =>
  Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);

/**
 * Building type mapping from TownBuildingType to procgen recipe keys.
 * Some town building types don't have direct procgen equivalents and use fallbacks.
 */
const BUILDING_TYPE_TO_RECIPE: Record<string, string> = {
  bank: "bank",
  store: "store",
  inn: "inn",
  smithy: "smithy",
  house: "simple-house",
  "simple-house": "simple-house",
  "long-house": "long-house",
  church: "church",
  cathedral: "cathedral",
  chapel: "chapel",
  keep: "keep",
  fortress: "fortress",
  castle: "castle",
  "guild-hall": "guild-hall",
  "town-hall": "town-hall",
  mansion: "mansion",
  manor: "manor",
};

/**
 * Building types that are stations (not visual buildings with collision).
 * These are spawned as interactive entities by StationSpawnerSystem.
 */
const STATION_TYPES = new Set(["well", "anvil"]);

/** NPC spawn position calculated from building interior placement */
interface BuildingNPCSpawn {
  /** World position for the NPC */
  position: { x: number; y: number; z: number };
  /** NPC facing direction (radians) */
  rotation: number;
  /** NPC type to spawn (e.g., "innkeeper", "banker", "blacksmith") */
  npcType: string;
}

/** Mapping from building type to NPC type */
const BUILDING_NPC_TYPES: Record<string, string> = {
  inn: "innkeeper",
  bank: "banker",
  smithy: "blacksmith",
  store: "shopkeeper",
  church: "priest",
  cathedral: "priest",
  chapel: "priest",
  "guild-hall": "guild-master",
  "town-hall": "mayor",
  mansion: "noble",
  manor: "noble",
  keep: "guard-captain",
  fortress: "guard-captain",
  castle: "lord",
};

export class TownSystem extends System {
  private towns: ProceduralTown[] = [];
  private seed: number = 0;
  private config!: TownConfig;
  private townGenerator!: TownGenerator;
  private terrainSystem?: {
    getHeightAt(x: number, z: number): number;
    getBiomeAtWorldPosition?(x: number, z: number): string;
  };

  /** BuildingGenerator for generating building layouts */
  private buildingGenerator!: BuildingGenerator;

  /** BuildingCollisionService for registering building collision */
  private collisionService!: BuildingCollisionService;

  /** Cached building layouts by building ID (for BuildingRenderingSystem reuse) */
  private buildingLayouts: Map<string, BuildingLayout> = new Map();

  /** NPC spawn positions by building ID (for spawning NPCs inside buildings) */
  private buildingNPCSpawns: Map<string, BuildingNPCSpawn> = new Map();

  constructor(world: World) {
    super(world);
  }

  getDependencies() {
    return { required: ["terrain"], optional: [] };
  }

  async init(): Promise<void> {
    await DataManager.getInstance().initialize();
    this.seed = DataManager.getWorldTerrainProfile().seed;
    this.config = loadTownConfig();
    this.terrainSystem = this.world.getSystem("terrain") as
      | {
          getHeightAt(x: number, z: number): number;
          getBiomeAtWorldPosition?(x: number, z: number): string;
        }
      | undefined;

    // Initialize the procedural town generator with terrain integration
    this.initializeTownGenerator();

    // Initialize building generator for layout generation
    this.buildingGenerator = new BuildingGenerator();

    // Initialize building collision service
    this.collisionService = new BuildingCollisionService(this.world);

    if (DataManager.getWorldConfig()?.towns) {
      Logger.system(
        "TownSystem",
        `Config: ${this.config.townCount} towns, ${this.config.minTownSpacing}m spacing`,
      );
    }
    this.initialized = true;
  }

  /**
   * Initialize the TownGenerator from @hyperforge/procgen with terrain provider
   */
  private initializeTownGenerator(): void {
    // Create a terrain provider adapter for the terrain system
    const terrainProvider: TerrainProvider = {
      getHeightAt: (x: number, z: number): number => {
        return this.terrainSystem?.getHeightAt(x, z) ?? 10;
      },
      getBiomeAt: (x: number, z: number): string => {
        return (
          this.terrainSystem?.getBiomeAtWorldPosition?.(x, z) ?? DEFAULT_BIOME
        );
      },
      getWaterThreshold: (): number => {
        return this.config.waterThreshold;
      },
    };

    // Convert TownConfig to TownGeneratorConfig
    const generatorConfig: Partial<TownGeneratorConfig> = {
      townCount: this.config.townCount,
      worldSize: this.config.worldSize,
      minTownSpacing: this.config.minTownSpacing,
      flatnessSampleRadius: this.config.flatnessSampleRadius,
      flatnessSampleCount: this.config.flatnessSampleCount,
      waterThreshold: this.config.waterThreshold,
      optimalWaterDistanceMin: this.config.optimalWaterDistanceMin,
      optimalWaterDistanceMax: this.config.optimalWaterDistanceMax,
      townSizes: this.config.townSizes,
      biomeSuitability: this.config.biomeSuitability,
      landmarks: this.config.landmarks,
    };

    this.townGenerator = new TownGenerator({
      seed: this.seed,
      terrain: terrainProvider,
      config: generatorConfig,
    });

    // Debug: log the config being used
    Logger.system(
      "TownSystem",
      `TownGenerator config: worldSize=${generatorConfig.worldSize}m, townCount=${generatorConfig.townCount}, minSpacing=${generatorConfig.minTownSpacing}m, waterThreshold=${generatorConfig.waterThreshold}`,
    );

    // Debug: Sample terrain heights at a few locations to verify terrain is working
    const testPoints = [
      { x: 0, z: 0 }, // World center
      { x: 1000, z: 1000 }, // Northeast
      { x: -1000, z: -1000 }, // Southwest
      { x: 500, z: -500 }, // Southeast-ish
    ];
    const heights = testPoints.map((p) => ({
      ...p,
      height: terrainProvider.getHeightAt(p.x, p.z).toFixed(1),
      biome: terrainProvider.getBiomeAt?.(p.x, p.z) ?? "unknown",
    }));
    Logger.system(
      "TownSystem",
      `Sample terrain heights: ${heights.map((h) => `(${h.x},${h.z}): ${h.height}m/${h.biome}`).join(", ")}`,
    );
  }

  async start(): Promise<void> {
    if (!this.terrainSystem) {
      throw new Error("TownSystem requires TerrainSystem");
    }

    // Load pre-defined towns from buildings manifest first
    this.loadManifestTowns();

    // Then generate procedural towns (avoiding pre-defined town locations)
    this.generateTowns();

    const manifestTownCount =
      DataManager.getBuildingsManifest()?.towns?.length ?? 0;
    const proceduralTownCount = this.towns.length - manifestTownCount;

    if (manifestTownCount > 0) {
      Logger.system(
        "TownSystem",
        `Loaded ${manifestTownCount} pre-defined towns from buildings manifest`,
      );
    }

    if (this.towns.length === 0) {
      Logger.systemWarn(
        "TownSystem",
        "No towns generated - using manifest-defined areas only",
      );
      return;
    }

    if (
      proceduralTownCount > 0 &&
      proceduralTownCount < this.config.townCount
    ) {
      Logger.systemWarn(
        "TownSystem",
        `Only ${proceduralTownCount}/${this.config.townCount} procedural towns generated`,
      );
    }

    // Generate building layouts, register collision, and register flat zones
    // IMPORTANT: Runs on BOTH client and server:
    // - Server: Authoritative collision data for pathfinding
    // - Client: Prediction collision + flat zones for terrain flattening
    // Note: Runs async with yielding to prevent main thread blocking
    Logger.system(
      "TownSystem",
      `isServer=${this.world.isServer}, towns=${this.towns.length} - registering building collision and flat zones`,
    );
    await this.registerBuildingCollision();

    Logger.system(
      "TownSystem",
      `Total towns: ${this.towns.length} (${manifestTownCount} manifest + ${proceduralTownCount} procedural)`,
    );
  }

  /**
   * Load pre-defined towns from the buildings manifest
   */
  private loadManifestTowns(): void {
    const buildingsManifest = DataManager.getBuildingsManifest();
    if (!buildingsManifest?.towns?.length) {
      return;
    }

    for (const manifestTown of buildingsManifest.towns) {
      // Validate manifest town structure
      if (!manifestTown.id || typeof manifestTown.id !== "string") {
        throw new Error(
          `[TownSystem] Manifest town has invalid id: ${JSON.stringify(manifestTown.id)}`,
        );
      }
      if (
        !manifestTown.position ||
        typeof manifestTown.position.x !== "number" ||
        typeof manifestTown.position.z !== "number"
      ) {
        throw new Error(
          `[TownSystem] Manifest town "${manifestTown.id}" has invalid position: ${JSON.stringify(manifestTown.position)}`,
        );
      }
      if (
        !Array.isArray(manifestTown.buildings) ||
        manifestTown.buildings.length === 0
      ) {
        throw new Error(
          `[TownSystem] Manifest town "${manifestTown.id}" has no buildings`,
        );
      }

      const town = this.convertManifestTown(manifestTown);
      this.towns.push(town);
    }
  }

  /**
   * Convert a manifest town to a ProceduralTown
   * Also generates layout features (roads, paths, landmarks, plaza) using the TownGenerator
   */
  private convertManifestTown(manifest: ManifestTown): ProceduralTown {
    // Map manifest size (sm, md, lg) to TownSize (hamlet, village, town)
    const sizeMap: Record<ManifestTownSize, TownSize> = {
      sm: "hamlet",
      md: "village",
      lg: "town",
    };

    const townSize = sizeMap[manifest.size] ?? "village";

    // Get terrain height at town center
    const y =
      this.terrainSystem?.getHeightAt(
        manifest.position.x,
        manifest.position.z,
      ) ?? manifest.position.y;

    // Get biome at town location
    const biome =
      this.terrainSystem?.getBiomeAtWorldPosition?.(
        manifest.position.x,
        manifest.position.z,
      ) ?? DEFAULT_BIOME;

    // Convert buildings - positions are relative in manifest, convert to world coords
    // Also calculate entrance positions for each building
    // IMPORTANT: Snap to building grid for proper tile alignment (cells must align with tiles)
    const buildings: TownBuilding[] = manifest.buildings.map((b, index) => {
      // Validate each building in manifest
      if (!b.id || typeof b.id !== "string") {
        throw new Error(
          `[TownSystem] Building ${index} in town "${manifest.id}" has invalid id: ${JSON.stringify(b.id)}`,
        );
      }
      if (!b.type || typeof b.type !== "string") {
        throw new Error(
          `[TownSystem] Building "${b.id}" in town "${manifest.id}" has invalid type: ${JSON.stringify(b.type)}`,
        );
      }
      if (
        !b.position ||
        typeof b.position.x !== "number" ||
        typeof b.position.z !== "number"
      ) {
        throw new Error(
          `[TownSystem] Building "${b.id}" in town "${manifest.id}" has invalid position: ${JSON.stringify(b.position)}`,
        );
      }
      if (
        !b.size ||
        typeof b.size.width !== "number" ||
        typeof b.size.depth !== "number"
      ) {
        throw new Error(
          `[TownSystem] Building "${b.id}" in town "${manifest.id}" has invalid size: ${JSON.stringify(b.size)}`,
        );
      }
      if (typeof b.rotation !== "number" || !Number.isFinite(b.rotation)) {
        throw new Error(
          `[TownSystem] Building "${b.id}" in town "${manifest.id}" has invalid rotation: ${b.rotation}`,
        );
      }

      const rawWorldX = manifest.position.x + b.position.x;
      const rawWorldZ = manifest.position.z + b.position.z;
      // Snap to building grid - critical for collision tile alignment
      const snapped = snapToBuildingGrid(rawWorldX, rawWorldZ);
      const worldX = snapped.x;
      const worldZ = snapped.z;
      const worldY =
        this.terrainSystem?.getHeightAt(worldX, worldZ) ?? b.position.y;

      // Calculate entrance position at the front of the building
      // Front direction based on rotation (Three.js: local +Z faces (sin(θ), cos(θ)))
      const frontDirX = Math.sin(b.rotation);
      const frontDirZ = Math.cos(b.rotation);
      const entranceOffset = b.size.depth / 2 + 0.3;

      return {
        id: b.id,
        type: b.type,
        position: { x: worldX, y: worldY, z: worldZ },
        rotation: b.rotation,
        size: b.size,
        entrance: {
          x: worldX + frontDirX * entranceOffset,
          z: worldZ + frontDirZ * entranceOffset,
        },
      };
    });

    // Use TownGenerator to generate layout features (roads, landmarks, plaza)
    // This ensures manifest towns have the same features as procedurally generated towns
    const generatedTown = this.townGenerator.generateSingleTown(
      manifest.position.x,
      manifest.position.z,
      townSize,
      {
        id: manifest.id,
        name: manifest.name,
        layoutType: townSize === "town" ? "crossroads" : "throughway",
      },
    );

    // Generate paths from roads to manifest building entrances
    const paths = this.generatePathsForManifestBuildings(
      buildings,
      generatedTown.internalRoads ?? [],
      manifest.position,
    );

    // Use the generated layout features but keep the manifest's buildings
    return {
      id: manifest.id,
      name: manifest.name,
      position: {
        x: manifest.position.x,
        y,
        z: manifest.position.z,
      },
      size: townSize,
      safeZoneRadius: manifest.safeZoneRadius,
      biome,
      buildings, // Use manifest buildings with calculated entrances
      suitabilityScore: 1.0, // Pre-defined towns have max suitability
      connectedRoads: [],
      // Use generated layout features
      layoutType: generatedTown.layoutType,
      entryPoints: generatedTown.entryPoints,
      internalRoads: generatedTown.internalRoads,
      paths, // Use paths generated for manifest buildings
      landmarks: generatedTown.landmarks,
      plaza: generatedTown.plaza,
    };
  }

  /**
   * Generate paths from roads to manifest building entrances
   */
  private generatePathsForManifestBuildings(
    buildings: TownBuilding[],
    roads: TownInternalRoad[],
    townCenter: { x: number; z: number },
  ): TownPath[] {
    const paths: TownPath[] = [];
    const roadHalfWidth = 3; // 6m road width / 2
    const pathWidth = 3; // Visible walkway to building entrances

    for (const building of buildings) {
      if (!building.entrance) continue;

      // Find closest point on any road to the entrance
      let closestPoint: { x: number; z: number } | null = null;
      let closestDistance = Infinity;

      for (const road of roads) {
        const point = this.closestPointOnSegment(
          building.entrance.x,
          building.entrance.z,
          road.start.x,
          road.start.z,
          road.end.x,
          road.end.z,
        );

        const dist = dist2D(
          building.entrance.x,
          building.entrance.z,
          point.x,
          point.z,
        );
        if (dist < closestDistance) {
          closestDistance = dist;
          closestPoint = point;
        }
      }

      // If no road found, connect to town center
      if (!closestPoint || closestDistance > 50) {
        closestPoint = { x: townCenter.x, z: townCenter.z };
        closestDistance = dist2D(
          building.entrance.x,
          building.entrance.z,
          closestPoint.x,
          closestPoint.z,
        );
      }

      if (closestDistance < 1 || closestDistance > 50) continue;

      // Direction from road to entrance
      const dx = building.entrance.x - closestPoint.x;
      const dz = building.entrance.z - closestPoint.z;
      const len = Math.sqrt(dx * dx + dz * dz);

      if (len < 0.1) continue;

      // Path starts at road edge
      const pathStart = {
        x: closestPoint.x + (dx / len) * roadHalfWidth,
        z: closestPoint.z + (dz / len) * roadHalfWidth,
      };

      paths.push({
        start: pathStart,
        end: { x: building.entrance.x, z: building.entrance.z },
        width: pathWidth,
        buildingId: building.id,
      });
    }

    return paths;
  }

  /**
   * Find closest point on a line segment to a given point
   */
  private closestPointOnSegment(
    px: number,
    pz: number,
    ax: number,
    az: number,
    bx: number,
    bz: number,
  ): { x: number; z: number } {
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;

    if (lengthSq === 0) return { x: ax, z: az };

    const t = Math.max(
      0,
      Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq),
    );
    return {
      x: ax + t * dx,
      z: az + t * dz,
    };
  }

  /**
   * Generate procedural towns using the TownGenerator from @hyperforge/procgen
   */
  private generateTowns(): void {
    // Convert existing manifest towns to GeneratedTown format for avoidance
    const existingTowns: GeneratedTown[] = this.towns.map((t) => ({
      id: t.id,
      name: t.name,
      position: t.position,
      size: t.size,
      safeZoneRadius: t.safeZoneRadius,
      biome: t.biome,
      buildings: t.buildings.map((b) => ({
        id: b.id,
        type: b.type,
        position: b.position,
        rotation: b.rotation,
        size: b.size,
      })),
      suitabilityScore: t.suitabilityScore,
      connectedRoads: t.connectedRoads,
    }));

    // Generate towns using the procgen library
    const result = this.townGenerator.generate(existingTowns);

    // Debug: Log generation statistics to diagnose why towns aren't being generated
    Logger.system(
      "TownSystem",
      `Town generation stats: ${result.stats.candidatesEvaluated} candidates evaluated, ${result.towns.length} towns generated`,
    );
    Logger.system(
      "TownSystem",
      `Generation time: ${result.stats.generationTime.toFixed(1)}ms`,
    );

    // Convert GeneratedTown to ProceduralTown and add to list
    for (const generatedTown of result.towns) {
      const proceduralTown = this.convertGeneratedTown(generatedTown);
      this.towns.push(proceduralTown);
    }

    // Log statistics
    const sizeCount = { hamlet: 0, village: 0, town: 0 };
    const layoutCount: Record<string, number> = {};
    for (const town of this.towns) {
      sizeCount[town.size]++;
      const layout = town.layoutType ?? "unknown";
      layoutCount[layout] = (layoutCount[layout] ?? 0) + 1;
    }
    Logger.system(
      "TownSystem",
      `Sizes: ${sizeCount.hamlet} hamlets, ${sizeCount.village} villages, ${sizeCount.town} towns`,
    );
    Logger.system(
      "TownSystem",
      `Layouts: ${Object.entries(layoutCount)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}`,
    );
  }

  /**
   * Convert a GeneratedTown from @hyperforge/procgen to ProceduralTown
   */
  private convertGeneratedTown(generated: GeneratedTown): ProceduralTown {
    // Convert buildings
    const buildings: TownBuilding[] = generated.buildings.map((b) => ({
      id: b.id,
      type: b.type as TownBuildingType,
      position: b.position,
      rotation: b.rotation,
      size: b.size,
    }));

    // Convert entry points
    const entryPoints: TownEntryPoint[] | undefined =
      generated.entryPoints?.map((e) => ({
        angle: e.angle,
        position: e.position,
      }));

    // Convert internal roads
    const internalRoads: TownInternalRoad[] | undefined =
      generated.internalRoads?.map((r) => ({
        start: r.start,
        end: r.end,
        isMain: r.isMain,
      }));

    // Convert paths
    const paths: TownPath[] | undefined = generated.paths?.map((p) => ({
      start: p.start,
      end: p.end,
      width: p.width,
      buildingId: p.buildingId,
    }));

    // Convert landmarks
    const landmarks: TownLandmark[] | undefined = generated.landmarks?.map(
      (l) => ({
        id: l.id,
        type: l.type,
        position: l.position,
        rotation: l.rotation,
        size: l.size,
        metadata: l.metadata,
      }),
    );

    // Convert plaza
    const plaza: TownPlaza | undefined = generated.plaza
      ? {
          position: generated.plaza.position,
          radius: generated.plaza.radius,
          shape: generated.plaza.shape,
          material: generated.plaza.material,
        }
      : undefined;

    return {
      id: generated.id,
      name: generated.name,
      position: generated.position,
      size: generated.size,
      safeZoneRadius: generated.safeZoneRadius,
      biome: generated.biome,
      buildings,
      suitabilityScore: generated.suitabilityScore,
      connectedRoads: generated.connectedRoads,
      layoutType: generated.layoutType,
      entryPoints,
      internalRoads,
      paths,
      landmarks,
      plaza,
    };
  }

  /**
   * Get the underlying TownGenerator for direct access
   */
  getTownGenerator(): TownGenerator {
    return this.townGenerator;
  }

  getWorldSizeMeters(): number {
    return this.config.worldSize;
  }

  getTowns(): ProceduralTown[] {
    return this.towns;
  }

  getTownById(id: string): ProceduralTown | undefined {
    return this.towns.find((t) => t.id === id);
  }

  getNearestTown(x: number, z: number): ProceduralTown | undefined {
    if (this.towns.length === 0) return undefined;
    return this.towns.reduce((nearest, town) =>
      dist2D(x, z, town.position.x, town.position.z) <
      dist2D(x, z, nearest.position.x, nearest.position.z)
        ? town
        : nearest,
    );
  }

  /** Get the spawn town (nearest to world origin). Used for initial player spawn and respawn. */
  getSpawnTown(): ProceduralTown | undefined {
    return this.getNearestTown(0, 0);
  }

  isInSafeZone(x: number, z: number): boolean {
    return this.towns.some(
      (town) =>
        dist2D(x, z, town.position.x, town.position.z) <= town.safeZoneRadius,
    );
  }

  getTownAtPosition(x: number, z: number): ProceduralTown | undefined {
    return this.towns.find(
      (town) =>
        dist2D(x, z, town.position.x, town.position.z) <= town.safeZoneRadius,
    );
  }

  getTownsInBounds(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): ProceduralTown[] {
    return this.towns.filter((town) => {
      const r = town.safeZoneRadius;
      return (
        town.position.x + r >= minX &&
        town.position.x - r <= maxX &&
        town.position.z + r >= minZ &&
        town.position.z - r <= maxZ
      );
    });
  }

  /**
   * Update signpost destinations after roads have been generated.
   * Call this from RoadNetworkSystem after generating roads.
   *
   * @param roads - Array of roads with fromTownId and toTownId
   */
  updateSignpostDestinations(
    roads: Array<{ id: string; fromTownId: string; toTownId: string }>,
  ): void {
    // Build map of road connections: townId -> array of destination town IDs
    const townConnections = new Map<string, string[]>();
    for (const road of roads) {
      // From town -> to town
      const fromConns = townConnections.get(road.fromTownId) ?? [];
      fromConns.push(road.toTownId);
      townConnections.set(road.fromTownId, fromConns);

      // To town -> from town (bidirectional roads)
      const toConns = townConnections.get(road.toTownId) ?? [];
      toConns.push(road.fromTownId);
      townConnections.set(road.toTownId, toConns);
    }

    // Build town ID -> name map
    const townNames = new Map<string, string>();
    for (const town of this.towns) {
      townNames.set(town.id, town.name);
    }

    // Update signpost metadata for each town
    for (const town of this.towns) {
      if (!town.landmarks) continue;

      const destinations = townConnections.get(town.id) ?? [];

      // Find signposts and assign destinations based on entry point order
      const signposts = town.landmarks.filter((l) => l.type === "signpost");

      for (let i = 0; i < signposts.length && i < destinations.length; i++) {
        const signpost = signposts[i];
        const destTownId = destinations[i];
        const destTownName = townNames.get(destTownId);

        if (destTownName) {
          signpost.metadata = {
            ...signpost.metadata,
            destination: destTownName,
            destinationId: destTownId,
          };
        }
      }
    }

    Logger.system(
      "TownSystem",
      `Updated signpost destinations for ${this.towns.length} towns`,
    );
  }

  shouldAvoidSpawning(x: number, z: number, avoidRadius: number = 30): boolean {
    return this.towns.some(
      (town) => dist2D(x, z, town.position.x, town.position.z) <= avoidRadius,
    );
  }

  /**
   * Get NPC spawn points INSIDE buildings of a given type.
   * Uses the extracted prop placements from building generation for accurate
   * interior positioning (behind counters, bars, etc.).
   *
   * @param buildingType - Type of building (e.g., "inn", "bank", "smithy")
   * @returns Array of spawn points with world positions and NPC types
   */
  getNPCSpawnPointsForBuildingType(buildingType: TownBuildingType): Array<{
    townId: string;
    townName: string;
    buildingId: string;
    position: { x: number; y: number; z: number };
    rotation: number;
    npcType: string;
  }> {
    const spawnPoints: Array<{
      townId: string;
      townName: string;
      buildingId: string;
      position: { x: number; y: number; z: number };
      rotation: number;
      npcType: string;
    }> = [];

    for (const town of this.towns) {
      for (const building of town.buildings) {
        if (building.type === buildingType) {
          // Use stored NPC spawn position from building interior
          const npcSpawn = this.buildingNPCSpawns.get(building.id);
          if (npcSpawn) {
            // Update Y to use the actual building position (which may have been
            // adjusted for terrain slope). Use dynamic foundation height from layout.
            const cachedLayout = this.buildingLayouts.get(building.id);
            const foundationH = cachedLayout
              ? cachedLayout.foundationSteps * ENTRANCE_STEP_HEIGHT
              : FOUNDATION_HEIGHT;
            const adjustedY = building.position.y + foundationH;
            spawnPoints.push({
              townId: town.id,
              townName: town.name,
              buildingId: building.id,
              position: {
                x: npcSpawn.position.x,
                y: adjustedY,
                z: npcSpawn.position.z,
              },
              rotation: npcSpawn.rotation,
              npcType: npcSpawn.npcType,
            });
          } else {
            // Fallback for buildings without prop placements (like smithy)
            // These NPCs spawn in the center of the building
            const cachedLayout = this.buildingLayouts.get(building.id);
            const foundationH = cachedLayout
              ? cachedLayout.foundationSteps * ENTRANCE_STEP_HEIGHT
              : FOUNDATION_HEIGHT;
            const npcType = BUILDING_NPC_TYPES[buildingType] || "generic";
            spawnPoints.push({
              townId: town.id,
              townName: town.name,
              buildingId: building.id,
              position: {
                x: building.position.x,
                y: building.position.y + foundationH,
                z: building.position.z,
              },
              rotation: building.rotation + Math.PI, // Face the entrance
              npcType,
            });
          }
        }
      }
    }
    return spawnPoints;
  }

  /**
   * Get all NPC spawn points for all buildings that should have NPCs.
   * This is the main method to call when spawning building NPCs.
   */
  getAllBuildingNPCSpawnPoints(): Array<{
    townId: string;
    townName: string;
    buildingId: string;
    buildingType: TownBuildingType;
    position: { x: number; y: number; z: number };
    rotation: number;
    npcType: string;
  }> {
    const allSpawnPoints: Array<{
      townId: string;
      townName: string;
      buildingId: string;
      buildingType: TownBuildingType;
      position: { x: number; y: number; z: number };
      rotation: number;
      npcType: string;
    }> = [];

    // Get spawn points for each building type that has NPCs
    for (const buildingType of Object.keys(
      BUILDING_NPC_TYPES,
    ) as TownBuildingType[]) {
      const points = this.getNPCSpawnPointsForBuildingType(buildingType);
      for (const point of points) {
        allSpawnPoints.push({
          ...point,
          buildingType,
        });
      }
    }

    return allSpawnPoints;
  }

  getBuildingsByType(buildingType: TownBuildingType): TownBuilding[] {
    return this.towns.flatMap((town) =>
      town.buildings.filter((b) => b.type === buildingType),
    );
  }

  getTownStats(): {
    totalTowns: number;
    hamlets: number;
    villages: number;
    towns: number;
    totalBuildings: number;
    buildingCounts: Record<TownBuildingType, number>;
  } {
    const stats = {
      totalTowns: this.towns.length,
      hamlets: 0,
      villages: 0,
      towns: 0,
      totalBuildings: 0,
      buildingCounts: {
        bank: 0,
        store: 0,
        anvil: 0,
        well: 0,
        house: 0,
        inn: 0,
        smithy: 0,
        "simple-house": 0,
        "long-house": 0,
        church: 0,
        cathedral: 0,
        chapel: 0,
        keep: 0,
        fortress: 0,
        castle: 0,
        "guild-hall": 0,
        "town-hall": 0,
        mansion: 0,
        manor: 0,
      } as Record<TownBuildingType, number>,
    };

    for (const town of this.towns) {
      if (town.size === "hamlet") stats.hamlets++;
      else if (town.size === "village") stats.villages++;
      else stats.towns++;

      stats.totalBuildings += town.buildings.length;
      for (const building of town.buildings)
        stats.buildingCounts[building.type]++;
    }
    return stats;
  }

  // ============================================================================
  // NPC SPAWN EXTRACTION
  // ============================================================================

  /**
   * Extract NPC spawn position from building prop placements.
   * Converts building-local coordinates to world coordinates.
   *
   * @param building - The building data
   * @param layout - The building's generated layout
   * @param propPlacements - Optional prop placements from building generator
   */
  private extractNPCSpawnPosition(
    building: TownBuilding,
    layout: BuildingLayout,
    propPlacements?: PropPlacements,
  ): void {
    if (!propPlacements) return;

    // Get NPC type for this building type
    const npcType = BUILDING_NPC_TYPES[building.type];
    if (!npcType) return;

    let localX: number;
    let localZ: number;
    let npcRotation: number;

    // Handle different building types
    if (building.type === "smithy" && propPlacements.forge) {
      // Blacksmith stands near the forge
      const forgePlacement = propPlacements.forge;
      const cellCenter = getCellCenter(
        forgePlacement.col,
        forgePlacement.row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );
      // Stand next to the forge (offset by 1 meter)
      localX = cellCenter.x + 1.0;
      localZ = cellCenter.z;
      // Face toward the forge (toward the entrance usually)
      npcRotation = building.rotation + Math.PI;
    } else {
      // Inn bar or bank counter - NPC stands behind counter
      let placement:
        | {
            col: number;
            row: number;
            side: string;
            secondCell?: { col: number; row: number };
          }
        | null
        | undefined;
      if (building.type === "inn") {
        placement = propPlacements.innBar;
      } else if (building.type === "bank") {
        placement = propPlacements.bankCounter;
      }

      if (!placement) return;

      // Calculate cell center in building-local coordinates
      if (placement.secondCell) {
        // 2-tile counter: use center between the two cells
        const cell1 = getCellCenter(
          placement.col,
          placement.row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );
        const cell2 = getCellCenter(
          placement.secondCell.col,
          placement.secondCell.row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );
        localX = (cell1.x + cell2.x) / 2;
        localZ = (cell1.z + cell2.z) / 2;
      } else {
        // Single-tile counter
        const cellCenter = getCellCenter(
          placement.col,
          placement.row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );
        localX = cellCenter.x;
        localZ = cellCenter.z;
      }

      // Apply NPC offset (behind the counter, between counter and wall)
      // NPC_BEHIND_COUNTER_OFFSET is the distance from cell center toward the wall
      // where the NPC stands. This places them between the counter's back face
      // and the wall's interior face, snug against the wall.
      const sideVec = getSideVector(placement.side);
      localX += sideVec.x * NPC_BEHIND_COUNTER_OFFSET;
      localZ += sideVec.z * NPC_BEHIND_COUNTER_OFFSET;

      // Calculate NPC facing direction (opposite of the counter side, rotated by building)
      // NPC faces away from the wall they're against (toward customers)
      let faceAngle = 0;
      switch (placement.side) {
        case "north":
          faceAngle = Math.PI; // Face south
          break;
        case "south":
          faceAngle = 0; // Face north
          break;
        case "east":
          faceAngle = -Math.PI / 2; // Face west
          break;
        case "west":
          faceAngle = Math.PI / 2; // Face east
          break;
      }
      // Apply building rotation
      npcRotation = faceAngle + building.rotation;
    }

    // Transform to world coordinates using building position and rotation
    const cos = Math.cos(building.rotation);
    const sin = Math.sin(building.rotation);

    const worldX = building.position.x + localX * cos - localZ * sin;
    const worldZ = building.position.z + localX * sin + localZ * cos;

    // Y position is building floor height above building.position.y.
    // Use dynamic foundation height from the layout's step count.
    // Note: building.position.y gets updated later to maxGroundY, so we store the base
    // and compute the actual Y when reading the spawn point.
    const dynamicFoundationH = layout.foundationSteps * ENTRANCE_STEP_HEIGHT;
    const worldY = building.position.y + dynamicFoundationH;

    // Store the NPC spawn data
    this.buildingNPCSpawns.set(building.id, {
      position: { x: worldX, y: worldY, z: worldZ },
      rotation: npcRotation,
      npcType,
    });

    Logger.system(
      "TownSystem",
      `NPC spawn for ${building.id}: ${npcType} at (${worldX.toFixed(1)}, ${worldY.toFixed(1)}, ${worldZ.toFixed(1)})`,
    );
  }

  // ============================================================================
  // BUILDING COLLISION
  // ============================================================================

  /**
   * Generate building layouts and register collision for all buildings.
   * Called during start() on server side.
   *
   * MAIN THREAD PROTECTION: Processes buildings in batches with yielding
   * to prevent blocking during server startup.
   */
  private async registerBuildingCollision(): Promise<void> {
    let totalBuildings = 0;
    let registeredBuildings = 0;

    // Collect all buildings to process (excluding stations)
    const buildingsToProcess: Array<{
      town: ProceduralTown;
      building: TownBuilding;
    }> = [];

    for (const town of this.towns) {
      for (const building of town.buildings) {
        if (!STATION_TYPES.has(building.type)) {
          buildingsToProcess.push({ town, building });
        }
      }
    }

    totalBuildings = buildingsToProcess.length;

    // Process in batches with yielding to prevent main thread blocking
    const BATCH_SIZE = 5;
    for (
      let batchStart = 0;
      batchStart < buildingsToProcess.length;
      batchStart += BATCH_SIZE
    ) {
      const batchEnd = Math.min(
        batchStart + BATCH_SIZE,
        buildingsToProcess.length,
      );

      for (let i = batchStart; i < batchEnd; i++) {
        const { town, building } = buildingsToProcess[i];

        const recipeKey = BUILDING_TYPE_TO_RECIPE[building.type];
        if (!recipeKey) {
          Logger.systemWarn(
            "TownSystem",
            `Unknown building type for collision: ${building.type} - skipping`,
          );
          continue;
        }

        // Generate building layout using BuildingGenerator
        const generated = this.buildingGenerator.generate(recipeKey, {
          seed: `${town.id}_${building.id}`,
          includeRoof: true,
        });

        if (!generated) {
          Logger.systemWarn(
            "TownSystem",
            `Failed to generate layout for ${building.type} in ${town.name}`,
          );
          continue;
        }

        // Cache the layout for BuildingRenderingSystem to reuse
        this.buildingLayouts.set(building.id, generated.layout);

        // Extract NPC spawn position from propPlacements if available
        this.extractNPCSpawnPosition(
          building,
          generated.layout,
          generated.propPlacements,
        );

        // CRITICAL: Calculate maximum terrain height under the building footprint
        // On steep hills, the building floor must be at the HIGHEST terrain point
        // Use getProceduralHeightAt to get raw terrain (ignoring previously registered flat zones)
        const tileMaskData = this.buildFootprintTileMask(
          building,
          generated.layout,
        );
        const maxGroundY = this.calculateMaxTerrainHeightForBuilding(
          building,
          generated.layout,
          tileMaskData,
        );

        // CRITICAL: Update building.position.y to maxGroundY for consistency
        // This ensures the rendered mesh matches collision and flat zone heights
        // Without this, on slopes: mesh renders at center height, but collision/flat zones use max height
        building.position.y = maxGroundY;

        // Convert BuildingLayout to BuildingLayoutInput for collision service
        const layoutInput = this.convertLayoutToInput(generated.layout);

        // Register collision with the service using maxGroundY
        // This ensures collision floor elevations match the flat zone height
        this.collisionService.registerBuilding(
          building.id,
          town.id,
          layoutInput,
          {
            x: building.position.x,
            y: building.position.y,
            z: building.position.z,
          },
          building.rotation,
        );

        // NOTE: Building grass exclusion is handled by GrassExclusionGrid,
        // which uses the exact walkable footprint (supports L-shaped buildings).

        // Register flat zone with TerrainSystem (like duel arena does)
        // This ensures terrain heightmap is modified so players walk at correct height
        // Uses the same maxGroundY for consistency
        this.registerBuildingFlatZone(
          building,
          generated.layout,
          maxGroundY,
          tileMaskData,
        );

        registeredBuildings++;
      }

      // Yield to main thread between batches
      if (batchEnd < buildingsToProcess.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    Logger.system(
      "TownSystem",
      `Registered collision for ${registeredBuildings}/${totalBuildings} buildings`,
    );

    // Log collision service status for debugging
    const buildingCount = this.collisionService.getBuildingCount();
    Logger.system(
      "TownSystem",
      `BuildingCollisionService now has ${buildingCount} buildings registered`,
    );

    // === VALIDATION: Verify building collision system is working ===
    this.validateBuildingCollisionSystem();
  }

  /**
   * Validate that the building collision system is properly set up.
   * Throws errors if critical problems are detected.
   */
  private validateBuildingCollisionSystem(): void {
    const buildingCount = this.collisionService.getBuildingCount();

    // ERROR: No buildings registered when we should have some
    if (buildingCount === 0 && this.towns.length > 0) {
      const totalBuildings = this.towns.reduce(
        (sum, t) => sum + t.buildings.length,
        0,
      );
      throw new Error(
        `[TownSystem] CRITICAL: No buildings registered with collision service! ` +
          `Expected ${totalBuildings} buildings from ${this.towns.length} towns.`,
      );
    }

    // Validate each building has:
    // 1. Walkable tiles
    // 2. At least one door
    // 3. Proper terrain integration (flat zone)
    const allBuildings = this.collisionService.getAllBuildings();
    let errorsFound = 0;

    for (const building of allBuildings) {
      // Use static helper for consistent ground floor lookup
      const groundFloor =
        BuildingCollisionService.getGroundFloorFromData(building);
      if (!groundFloor) {
        Logger.systemError(
          "TownSystem",
          `Building ${building.buildingId} has NO ground floor!`,
        );
        errorsFound++;
        continue;
      }

      // Check walkable tiles
      if (groundFloor.walkableTiles.size === 0) {
        Logger.systemError(
          "TownSystem",
          `Building ${building.buildingId} has NO walkable tiles on ground floor!`,
        );
        errorsFound++;
      }

      // Check for entrances (doors OR arches - both allow passage)
      const entranceWalls = groundFloor.wallSegments.filter(
        (wall) =>
          wall.hasOpening &&
          (wall.openingType === "door" || wall.openingType === "arch"),
      );
      const entranceCount = entranceWalls.length;
      if (entranceCount === 0) {
        Logger.systemError(
          "TownSystem",
          `Building ${building.buildingId} has NO entrances (doors or arches)! Players cannot enter.`,
        );
        errorsFound++;
      }

      // Verify terrain flat zone exists for this building
      // NOTE: We query the building center, but for L-shaped buildings the center may be
      // outside flat zone cells. Use a higher tolerance (2m) to avoid false positives.
      // The actual gameplay uses per-tile height queries which work correctly.
      if (this.terrainSystem) {
        const centerHeight = this.terrainSystem.getHeightAt(
          building.worldPosition.x,
          building.worldPosition.z,
        );
        const expectedFloor = groundFloor.elevation;
        const heightDiff = Math.abs((centerHeight ?? 0) - expectedFloor);

        if (heightDiff > 2.0) {
          Logger.systemWarn(
            "TownSystem",
            `Building ${building.buildingId} terrain height mismatch: ` +
              `terrain=${centerHeight?.toFixed(2)}, floor=${expectedFloor.toFixed(2)}, diff=${heightDiff.toFixed(2)}m`,
          );
        }
      }

      // Validate entrance tiles (doors AND arches) are reachable from outside
      const entranceTiles = this.collisionService.getEntranceTiles(
        building.buildingId,
      );
      if (entranceTiles.length > 0) {
        let reachableEntrances = 0;
        for (const entrance of entranceTiles) {
          // Check if the exterior approach tile is walkable
          const exteriorWalkable =
            this.collisionService.isTileWalkableInBuilding(
              entrance.tileX,
              entrance.tileZ,
              0,
            );
          if (exteriorWalkable) {
            reachableEntrances++;
          } else {
            Logger.systemWarn(
              "TownSystem",
              `Building ${building.buildingId} entrance at (${entrance.tileX},${entrance.tileZ}) ` +
                `exterior approach tile is NOT walkable!`,
            );
          }
        }

        if (reachableEntrances === 0) {
          Logger.systemError(
            "TownSystem",
            `Building ${building.buildingId} has ${entranceTiles.length} entrances but NONE are reachable from outside!`,
          );
          errorsFound++;
        }
      }
    }

    if (errorsFound > 0) {
      throw new Error(
        `[TownSystem] CRITICAL: ${errorsFound} building collision errors detected! ` +
          `Check logs above for details. Navigation will NOT work correctly.`,
      );
    }

    const runDeepCollisionValidation = this.shouldRunDeepCollisionValidation();
    if (runDeepCollisionValidation) {
      // === CRITICAL: Test actual pathfinding to buildings ===
      this.validateBuildingPathfinding(allBuildings);

      // === CRITICAL: Validate tiles under buildings are blocked ===
      this.validateBuildingTileBlocking(allBuildings);

      // === CRITICAL: Use BuildingCollisionService's comprehensive validation ===
      // This uses BFS flood fill to verify ALL tiles are actually reachable from doors
      this.validateBuildingReachability(allBuildings);

      // === CRITICAL: Exhaustive perimeter navigation test ===
      // Tests EVERY tile around EVERY building can reach center through door
      this.validatePerimeterNavigation(allBuildings);

      // === MOST CRITICAL: Validate NO path enters footprint except through doors ===
      // This catches any bug where ground players can clip into buildings
      this.validateNoFootprintEntryExceptDoor(allBuildings);
    } else {
      Logger.system(
        "TownSystem",
        "Skipping deep startup collision/pathfinding validation (set TOWN_COLLISION_DEEP_VALIDATION=true to enable)",
      );
    }

    // Summary stats using helper methods
    const totalWalkableTiles = allBuildings.reduce((sum, b) => {
      const floor0 = BuildingCollisionService.getGroundFloorFromData(b);
      return sum + (floor0?.walkableTiles.size ?? 0);
    }, 0);
    const totalEntrances = allBuildings.reduce((sum, b) => {
      const floor0 = BuildingCollisionService.getGroundFloorFromData(b);
      if (!floor0) return sum;
      // Count both doors and arches as entrances
      return (
        sum +
        floor0.wallSegments.filter(
          (w) =>
            w.hasOpening &&
            (w.openingType === "door" || w.openingType === "arch"),
        ).length
      );
    }, 0);

    // Print prominent success message
    console.log(
      `\n╔══════════════════════════════════════════════════════════════╗`,
    );
    console.log(
      `║  BUILDING COLLISION SYSTEM: INITIALIZED SUCCESSFULLY         ║`,
    );
    console.log(
      `╠══════════════════════════════════════════════════════════════╣`,
    );
    console.log(
      `║  Buildings registered: ${String(allBuildings.length).padEnd(38)}║`,
    );
    console.log(
      `║  Total walkable tiles: ${String(totalWalkableTiles).padEnd(38)}║`,
    );
    console.log(`║  Total entrances: ${String(totalEntrances).padEnd(43)}║`);
    console.log(`║  Towns: ${String(this.towns.length).padEnd(53)}║`);
    console.log(
      `╚══════════════════════════════════════════════════════════════╝\n`,
    );

    Logger.system(
      "TownSystem",
      `✓ Building collision validation passed: ${allBuildings.length} buildings, all have doors and walkable tiles`,
    );
  }

  private shouldRunDeepCollisionValidation(): boolean {
    const envFlag =
      typeof process !== "undefined"
        ? process.env.TOWN_COLLISION_DEEP_VALIDATION
        : undefined;
    if (envFlag !== undefined && envFlag !== "") {
      return isTruthyEnv(envFlag);
    }
    const nodeEnv =
      typeof process !== "undefined" ? process.env.NODE_ENV : undefined;
    // Keep exhaustive validation enabled for test runs while avoiding
    // multi-gigabyte startup churn in normal server runtimes.
    return nodeEnv === "test";
  }

  /**
   * Validate that pathfinding actually works to buildings.
   * Tests path from outside to DOOR INTERIOR (the actual entry point).
   * THROWS if pathfinding fails - this is a critical error.
   */
  private validateBuildingPathfinding(
    allBuildings: import("../../../types/world/building-collision-types").BuildingCollisionData[],
  ): void {
    // Import BFSPathfinder for testing (lazy import to avoid circular deps)
    const pathfinder = new BFSPathfinder();

    let buildingsTested = 0;
    let pathfindingErrors = 0;
    const failedBuildings: string[] = [];

    for (const building of allBuildings) {
      // Use static helper for consistent ground floor lookup
      const groundFloor =
        BuildingCollisionService.getGroundFloorFromData(building);
      if (!groundFloor) {
        // This is a critical error - all buildings MUST have a ground floor
        Logger.systemError(
          "TownSystem",
          `VALIDATION ERROR [${building.buildingId}]: No ground floor found!`,
        );
        pathfindingErrors++;
        failedBuildings.push(`${building.buildingId}:no-ground-floor`);
        continue;
      }

      if (groundFloor.walkableTiles.size === 0) {
        Logger.systemError(
          "TownSystem",
          `VALIDATION ERROR [${building.buildingId}]: Ground floor has no walkable tiles!`,
        );
        pathfindingErrors++;
        failedBuildings.push(`${building.buildingId}:no-walkable-tiles`);
        continue;
      }

      // Get ALL entrances (doors AND arches) for this building - test each one
      const allEntrances = this.collisionService.getEntranceTiles(
        building.buildingId,
      );
      if (allEntrances.length === 0) {
        Logger.systemError(
          "TownSystem",
          `VALIDATION ERROR [${building.buildingId}]: No entrances (doors or arches) found! Building is inaccessible.`,
        );
        pathfindingErrors++;
        failedBuildings.push(`${building.buildingId}:no-entrances`);
        continue;
      }

      // Define walkability check using collision service (reused for all entrances)
      const isWalkable = (
        tile: { x: number; z: number },
        fromTile?: { x: number; z: number },
      ): boolean => {
        // Check building walkability
        const buildingWalkable = this.collisionService.isTileWalkableInBuilding(
          tile.x,
          tile.z,
          0,
        );
        if (!buildingWalkable) return false;

        // Check wall blocking if we have a source tile
        if (fromTile) {
          const wallBlocked = this.collisionService.isWallBlocked(
            fromTile.x,
            fromTile.z,
            tile.x,
            tile.z,
            0,
          );
          if (wallBlocked) return false;
        }

        return true;
      };

      // Test EACH entrance (door or arch) for this building
      let entrancesWorking = 0;
      let entrancesFailed = 0;
      const entranceResults: string[] = [];

      for (const entranceInfo of allEntrances) {
        // entranceInfo has: tileX, tileZ (exterior approach), direction
        // getEntranceTiles returns exterior tiles, so we need to calculate interior
        const exteriorX = entranceInfo.tileX;
        const exteriorZ = entranceInfo.tileZ;

        // Interior tile is one step INTO the building (opposite of entrance direction)
        let interiorX = exteriorX;
        let interiorZ = exteriorZ;
        switch (entranceInfo.direction) {
          case "north":
            interiorZ += 1;
            break; // Entrance faces north, interior is south (higher Z)
          case "south":
            interiorZ -= 1;
            break; // Entrance faces south, interior is north (lower Z)
          case "east":
            interiorX -= 1;
            break; // Entrance faces east, interior is west (lower X)
          case "west":
            interiorX += 1;
            break; // Entrance faces west, interior is east (higher X)
        }

        // Start from 5 tiles AWAY from entrance in the approach direction
        let startX = exteriorX;
        let startZ = exteriorZ;
        const approachDistance = 5;
        switch (entranceInfo.direction) {
          case "north":
            startZ -= approachDistance;
            break;
          case "south":
            startZ += approachDistance;
            break;
          case "east":
            startX += approachDistance;
            break;
          case "west":
            startX -= approachDistance;
            break;
        }

        // TEST 1: Can we path from outside to entrance EXTERIOR?
        const pathToExterior = pathfinder.findPath(
          { x: startX, z: startZ },
          { x: exteriorX, z: exteriorZ },
          isWalkable,
        );

        if (pathToExterior.length === 0) {
          entrancesFailed++;
          entranceResults.push(`entrance@(${exteriorX},${exteriorZ}):no-path`);
          continue;
        }

        // Verify path reaches exterior (not truncated)
        const lastTile = pathToExterior[pathToExterior.length - 1];
        if (lastTile.x !== exteriorX || lastTile.z !== exteriorZ) {
          entrancesFailed++;
          entranceResults.push(
            `entrance@(${exteriorX},${exteriorZ}):truncated`,
          );
          continue;
        }

        // TEST 2: Can we step from entrance exterior to entrance INTERIOR?
        const canEnter = isWalkable(
          { x: interiorX, z: interiorZ },
          { x: exteriorX, z: exteriorZ },
        );
        if (!canEnter) {
          entrancesFailed++;
          entranceResults.push(`entrance@(${exteriorX},${exteriorZ}):blocked`);
          continue;
        }

        entrancesWorking++;
        entranceResults.push(
          `entrance@(${exteriorX},${exteriorZ}):OK[${pathToExterior.length}]`,
        );
      }

      // Building passes if AT LEAST ONE entrance works
      if (entrancesWorking === 0) {
        Logger.systemError(
          "TownSystem",
          `ALL ENTRANCES FAILED [${building.buildingId}]: ${entrancesFailed} entrances tested, none accessible. ${entranceResults.join(", ")}`,
        );
        pathfindingErrors++;
        failedBuildings.push(`${building.buildingId}:all-entrances-failed`);
        continue;
      }

      buildingsTested++;
      if (entrancesFailed > 0) {
        Logger.systemWarn(
          "TownSystem",
          `Building ${building.buildingId}: ${entrancesWorking}/${allEntrances.length} entrances work (${entrancesFailed} blocked)`,
        );
      }
      Logger.system(
        "TownSystem",
        `✓ Building ${building.buildingId}: ${entrancesWorking}/${allEntrances.length} entrances accessible`,
      );
    }

    if (pathfindingErrors > 0) {
      throw new Error(
        `[TownSystem] CRITICAL PATHFINDING FAILURE: ${pathfindingErrors} building(s) unreachable!\n` +
          `Failed: ${failedBuildings.join(", ")}\n` +
          `Players will NOT be able to enter these buildings. Server startup aborted.`,
      );
    }

    // LARP check: Ensure we actually tested something
    if (buildingsTested === 0 && allBuildings.length > 0) {
      throw new Error(
        `[TownSystem] CRITICAL: ${allBuildings.length} buildings exist but ZERO were validated! ` +
          `All buildings failed pre-checks (no ground floor, no entrances, or no walkable tiles).`,
      );
    }

    Logger.system(
      "TownSystem",
      `✓ Pathfinding validation PASSED: All ${buildingsTested}/${allBuildings.length} buildings are reachable from outside`,
    );
  }

  /**
   * Validate that tiles under buildings are properly blocked.
   * This ensures:
   * 1. Tiles INSIDE the building (not walkable floors) are BLOCKED
   * 2. Tiles OUTSIDE (approach areas) are WALKABLE
   * 3. Building floor tiles are WALKABLE
   */
  private validateBuildingTileBlocking(
    allBuildings: import("../../../types/world/building-collision-types").BuildingCollisionData[],
  ): void {
    let tilesChecked = 0;
    let errors = 0;
    const failedChecks: string[] = [];

    for (const building of allBuildings) {
      const bbox = building.boundingBox;
      // Use static helper for consistent ground floor lookup
      const groundFloor =
        BuildingCollisionService.getGroundFloorFromData(building);
      if (!groundFloor) continue;

      // Get entrance walls (doors and arches) once for the entire building check
      const entranceWalls = groundFloor.wallSegments.filter(
        (w) =>
          w.hasOpening &&
          (w.openingType === "door" || w.openingType === "arch"),
      );

      // Check ALL tiles within the building's bounding box
      for (let tx = bbox.minTileX; tx <= bbox.maxTileX; tx++) {
        for (let tz = bbox.minTileZ; tz <= bbox.maxTileZ; tz++) {
          tilesChecked++;
          const key = `${tx},${tz}`;
          const isWalkableFloor = groundFloor.walkableTiles.has(key);
          const isWalkable = this.collisionService.isTileWalkableInBuilding(
            tx,
            tz,
            0,
          );

          if (isWalkableFloor) {
            // Floor tile SHOULD be walkable
            if (!isWalkable) {
              errors++;
              if (failedChecks.length < 5) {
                failedChecks.push(
                  `${building.buildingId}:(${tx},${tz}) floor tile marked NOT walkable`,
                );
              }
            }
          } else {
            // Not a floor tile - check if it's in the interior (should be blocked)
            // Tiles at the edge (within 1 tile margin) are allowed for approach
            const margin = 1;
            const isInterior =
              tx > bbox.minTileX + margin &&
              tx < bbox.maxTileX - margin &&
              tz > bbox.minTileZ + margin &&
              tz < bbox.maxTileZ - margin;

            if (isInterior && isWalkable) {
              // Interior non-floor tile SHOULD be blocked unless it's an entrance exterior
              // or a concave footprint hole (low adjacency to walkable tiles).
              // Directions: North = -Z, South = +Z, East = +X, West = -X
              const adjacentOffsets = [
                { dx: 0, dz: -1, dir: "north" as const },
                { dx: 0, dz: 1, dir: "south" as const },
                { dx: 1, dz: 0, dir: "east" as const },
                { dx: -1, dz: 0, dir: "west" as const },
              ];
              const mask = {
                north: false,
                south: false,
                east: false,
                west: false,
                count: 0,
              };
              for (const { dx, dz, dir } of adjacentOffsets) {
                const adjKey = `${tx + dx},${tz + dz}`;
                if (groundFloor.walkableTiles.has(adjKey)) {
                  mask[dir] = true;
                  mask.count++;
                }
              }

              const oppositeNS = mask.north && mask.south;
              const oppositeEW = mask.east && mask.west;
              const isInteriorUnderBuilding =
                mask.count >= 3 ||
                (mask.count === 2 && (oppositeNS || oppositeEW));

              // Allow concave holes / exterior notches
              if (!isInteriorUnderBuilding) {
                continue;
              }

              // Check against pre-fetched entrance walls (doors and arches)
              let isEntranceExterior = false;
              for (const wall of entranceWalls) {
                const doorTiles =
                  BuildingCollisionService.getDoorExteriorAndInterior(
                    wall.tileX,
                    wall.tileZ,
                    wall.side,
                  );
                if (doorTiles.exteriorX === tx && doorTiles.exteriorZ === tz) {
                  isEntranceExterior = true;
                  break;
                }
              }

              if (!isEntranceExterior) {
                errors++;
                if (failedChecks.length < 5) {
                  failedChecks.push(
                    `${building.buildingId}:(${tx},${tz}) interior non-floor tile is WALKABLE (should be blocked)`,
                  );
                }
              }
            }
          }
        }
      }
    }

    if (errors > 0) {
      Logger.systemError(
        "TownSystem",
        `TILE BLOCKING VALIDATION FAILED: ${errors} tiles have incorrect walkability!`,
      );
      for (const check of failedChecks) {
        Logger.systemError("TownSystem", `  - ${check}`);
      }
      throw new Error(
        `[TownSystem] CRITICAL: ${errors} tiles have incorrect walkability. ` +
          `Players may walk through walls or be blocked from valid tiles.`,
      );
    }

    Logger.system(
      "TownSystem",
      `✓ Tile blocking validation PASSED: ${tilesChecked} tiles checked, all correct`,
    );
  }

  /**
   * Validate that ALL tiles in each building are actually reachable from the entrance.
   * Uses BuildingCollisionService's BFS flood fill to verify real navigation works.
   *
   * This catches issues where tiles are registered but unreachable due to internal walls.
   */
  private validateBuildingReachability(
    allBuildings: import("../../../types/world/building-collision-types").BuildingCollisionData[],
  ): void {
    let totalUnreachable = 0;
    const failedBuildings: string[] = [];

    for (const building of allBuildings) {
      const validation = this.collisionService.validateBuildingNavigation(
        building.buildingId,
      );

      if (!validation.valid) {
        // Check if it's a reachability issue specifically
        const reachabilityError = validation.errors.find((e) =>
          e.includes("reachable from entrance"),
        );
        if (reachabilityError) {
          const unreachable =
            validation.stats.walkableTiles - validation.stats.reachableTiles;
          totalUnreachable += unreachable;
          failedBuildings.push(
            `${building.buildingId}: ${unreachable}/${validation.stats.walkableTiles} tiles unreachable`,
          );
        }

        // Log all errors but don't fail for minor issues
        for (const error of validation.errors) {
          Logger.systemWarn("TownSystem", `[Reachability] ${error}`);
        }
      }
    }

    if (totalUnreachable > 0) {
      // Calculate total walkable tiles for severity assessment
      const totalWalkableTiles = allBuildings.reduce((sum, b) => {
        const floor0 = BuildingCollisionService.getGroundFloorFromData(b);
        return sum + (floor0?.walkableTiles.size ?? 0);
      }, 0);
      const unreachablePercent = (totalUnreachable / totalWalkableTiles) * 100;

      Logger.systemError(
        "TownSystem",
        `REACHABILITY VALIDATION: ${totalUnreachable}/${totalWalkableTiles} (${unreachablePercent.toFixed(1)}%) tiles unreachable across ${failedBuildings.length} buildings`,
      );
      for (const building of failedBuildings.slice(0, 5)) {
        Logger.systemError("TownSystem", `  - ${building}`);
      }

      // CRITICAL: If more than 25% of tiles are unreachable, this is a serious bug
      // Small percentages (< 25%) may be intentional design (secret rooms, etc.)
      if (unreachablePercent > 25) {
        throw new Error(
          `[TownSystem] CRITICAL: ${unreachablePercent.toFixed(1)}% of building tiles are unreachable! ` +
            `This indicates a serious navigation bug. Server startup ABORTED.`,
        );
      }
    } else {
      Logger.system(
        "TownSystem",
        `✓ Reachability validation PASSED: All tiles in ${allBuildings.length} buildings are reachable`,
      );
    }
  }

  /**
   * EXHAUSTIVE PERIMETER NAVIGATION TEST
   *
   * Tests that EVERY tile around EVERY building can navigate to the building's center
   * through the door using proper two-stage navigation.
   *
   * This catches edge cases where specific approach angles might bypass walls.
   */
  private validatePerimeterNavigation(
    allBuildings: import("../../../types/world/building-collision-types").BuildingCollisionData[],
  ): void {
    const pathfinder = new BFSPathfinder();

    let totalBuildingsTested = 0;
    let totalTilesTested = 0;
    let totalFailures = 0;
    const failedPaths: string[] = [];

    // Limit detailed logging to avoid spam
    const MAX_FAILURES_LOGGED = 10;

    for (const building of allBuildings) {
      const groundFloor =
        BuildingCollisionService.getGroundFloorFromData(building);
      if (!groundFloor || groundFloor.walkableTiles.size === 0) continue;

      const bbox = building.boundingBox;

      // Find closest door for this building (used as waypoint)
      const centerX = Math.floor((bbox.minTileX + bbox.maxTileX) / 2);
      const centerZ = Math.floor((bbox.minTileZ + bbox.maxTileZ) / 2);
      const closestDoor = this.collisionService.findClosestDoorTile(
        building.buildingId,
        centerX,
        centerZ,
      );

      if (!closestDoor) {
        Logger.systemWarn(
          "TownSystem",
          `[PerimeterNav] ${building.buildingId}: No door found, skipping`,
        );
        continue;
      }

      const doorExterior = { x: closestDoor.tileX, z: closestDoor.tileZ };
      const doorInterior = {
        x: closestDoor.interiorTileX,
        z: closestDoor.interiorTileZ,
      };
      const buildingCenter = { x: centerX, z: centerZ };

      // Ground player walkability (layer separation)
      const groundWalkable = (
        tile: { x: number; z: number },
        fromTile?: { x: number; z: number },
      ): boolean => {
        const check = this.collisionService.checkBuildingMovement(
          fromTile ?? null,
          tile,
          0,
          null, // ground player
        );
        return check.buildingAllowsMovement;
      };

      // Building player walkability (inside building)
      const buildingWalkable = (
        tile: { x: number; z: number },
        fromTile?: { x: number; z: number },
      ): boolean => {
        const check = this.collisionService.checkBuildingMovement(
          fromTile ?? null,
          tile,
          0,
          building.buildingId,
        );
        return check.buildingAllowsMovement;
      };

      // Generate perimeter tiles (ring around building, 2 tiles out)
      const perimeterDistance = 3;
      const perimeterTiles: Array<{ x: number; z: number }> = [];

      for (
        let x = bbox.minTileX - perimeterDistance;
        x <= bbox.maxTileX + perimeterDistance;
        x++
      ) {
        for (
          let z = bbox.minTileZ - perimeterDistance;
          z <= bbox.maxTileZ + perimeterDistance;
          z++
        ) {
          // Only include tiles ON the perimeter (not inside)
          const isOnPerimeter =
            x === bbox.minTileX - perimeterDistance ||
            x === bbox.maxTileX + perimeterDistance ||
            z === bbox.minTileZ - perimeterDistance ||
            z === bbox.maxTileZ + perimeterDistance;

          // Skip tiles inside building
          const inFootprint =
            this.collisionService.isTileInBuildingFootprint(x, z) !== null;

          if (isOnPerimeter && !inFootprint) {
            perimeterTiles.push({ x, z });
          }
        }
      }

      // Test each perimeter tile
      let buildingFailures = 0;

      for (const startTile of perimeterTiles) {
        totalTilesTested++;

        // STAGE 1: Path from perimeter to door exterior (ground player)
        const pathToDoor = pathfinder.findPath(
          startTile,
          doorExterior,
          groundWalkable,
        );

        if (pathToDoor.length === 0) {
          buildingFailures++;
          totalFailures++;
          if (failedPaths.length < MAX_FAILURES_LOGGED) {
            failedPaths.push(
              `${building.buildingId}: (${startTile.x},${startTile.z}) → door: NO PATH`,
            );
          }
          continue;
        }

        // Verify path doesn't go through walls
        let wallViolation = false;
        for (let i = 0; i < pathToDoor.length - 1; i++) {
          const from = pathToDoor[i];
          const to = pathToDoor[i + 1];
          const wallBlocked = this.collisionService.isWallBlocked(
            from.x,
            from.z,
            to.x,
            to.z,
            0,
          );
          if (wallBlocked) {
            wallViolation = true;
            buildingFailures++;
            totalFailures++;
            if (failedPaths.length < MAX_FAILURES_LOGGED) {
              failedPaths.push(
                `${building.buildingId}: (${startTile.x},${startTile.z}) → door WALL VIOLATION at step ${i}`,
              );
            }
            break;
          }
        }

        if (wallViolation) continue;

        // DOOR TRANSITION: Verify step from exterior to interior
        const canEnter = this.collisionService.checkBuildingMovement(
          doorExterior,
          doorInterior,
          0,
          null, // ground player entering
        );
        if (!canEnter.buildingAllowsMovement) {
          buildingFailures++;
          totalFailures++;
          if (failedPaths.length < MAX_FAILURES_LOGGED) {
            failedPaths.push(
              `${building.buildingId}: (${startTile.x},${startTile.z}) DOOR BLOCKED: ${canEnter.blockReason}`,
            );
          }
          continue;
        }

        // STAGE 2: Path from door interior to center (building player)
        const pathToCenter = pathfinder.findPath(
          doorInterior,
          buildingCenter,
          buildingWalkable,
        );

        if (pathToCenter.length === 0) {
          buildingFailures++;
          totalFailures++;
          if (failedPaths.length < MAX_FAILURES_LOGGED) {
            failedPaths.push(
              `${building.buildingId}: (${startTile.x},${startTile.z}) → center: NO INTERIOR PATH`,
            );
          }
          continue;
        }

        // Verify interior path doesn't go through walls
        for (let i = 0; i < pathToCenter.length - 1; i++) {
          const from = pathToCenter[i];
          const to = pathToCenter[i + 1];
          const wallBlocked = this.collisionService.isWallBlocked(
            from.x,
            from.z,
            to.x,
            to.z,
            0,
          );
          if (wallBlocked) {
            buildingFailures++;
            totalFailures++;
            if (failedPaths.length < MAX_FAILURES_LOGGED) {
              failedPaths.push(
                `${building.buildingId}: interior WALL VIOLATION at step ${i}`,
              );
            }
            break;
          }
        }
      }

      totalBuildingsTested++;

      if (buildingFailures > 0) {
        Logger.systemWarn(
          "TownSystem",
          `[PerimeterNav] ${building.buildingId}: ${buildingFailures}/${perimeterTiles.length} perimeter tiles FAILED`,
        );
      }
    }

    // Report results
    if (totalFailures > 0) {
      Logger.systemError(
        "TownSystem",
        `PERIMETER NAVIGATION VALIDATION: ${totalFailures}/${totalTilesTested} paths FAILED!`,
      );
      for (const failure of failedPaths) {
        Logger.systemError("TownSystem", `  ❌ ${failure}`);
      }
      if (failedPaths.length >= MAX_FAILURES_LOGGED) {
        Logger.systemError(
          "TownSystem",
          `  ... and ${totalFailures - MAX_FAILURES_LOGGED} more failures`,
        );
      }

      // This is critical - throw if too many failures
      const failureRate = totalFailures / totalTilesTested;
      if (failureRate > 0.1) {
        // More than 10% failure rate
        throw new Error(
          `[TownSystem] CRITICAL: ${(failureRate * 100).toFixed(1)}% of perimeter paths failed! ` +
            `Navigation is severely broken.`,
        );
      }
    } else {
      Logger.system(
        "TownSystem",
        `✓ Perimeter navigation PASSED: All ${totalTilesTested} paths across ${totalBuildingsTested} buildings work`,
      );
    }
  }

  /**
   * CRITICAL: Validate that NO single step from exterior to footprint is allowed
   * except through actual door tiles.
   *
   * This is the MOST rigorous test - it checks EVERY possible entry step, not paths.
   * If this passes but paths still fail, the bug is in BFS pathfinding.
   * If this fails, the bug is in checkBuildingMovement.
   *
   * THROWS IMMEDIATELY if any violation found - this is a critical security issue.
   */
  private validateNoFootprintEntryExceptDoor(
    allBuildings: import("../../../types/world/building-collision-types").BuildingCollisionData[],
  ): void {
    let totalStepsTested = 0;
    let violations = 0;
    const violationDetails: string[] = [];

    for (const building of allBuildings) {
      const groundFloor =
        BuildingCollisionService.getGroundFloorFromData(building);
      if (!groundFloor) continue;

      // Get all door tiles for this building
      const doorTileSet = new Set<string>();
      const doorWalls = groundFloor.wallSegments.filter(
        (w) =>
          w.hasOpening &&
          (w.openingType === "door" || w.openingType === "arch"),
      );
      for (const door of doorWalls) {
        doorTileSet.add(`${door.tileX},${door.tileZ}`);
      }

      // Test EVERY footprint tile
      for (const key of groundFloor.walkableTiles) {
        const [tx, tz] = key.split(",").map(Number);
        const footprintTile: { x: number; z: number } = { x: tx, z: tz };
        const isDoorTile = doorTileSet.has(key);

        // Check ALL 8 adjacent tiles (cardinal + diagonal)
        const adjacents = [
          { dx: 0, dz: -1, name: "N" },
          { dx: 0, dz: 1, name: "S" },
          { dx: 1, dz: 0, name: "E" },
          { dx: -1, dz: 0, name: "W" },
          { dx: 1, dz: -1, name: "NE" },
          { dx: -1, dz: -1, name: "NW" },
          { dx: 1, dz: 1, name: "SE" },
          { dx: -1, dz: 1, name: "SW" },
        ];

        for (const adj of adjacents) {
          const fromTile = {
            x: footprintTile.x + adj.dx,
            z: footprintTile.z + adj.dz,
          };

          // Only test entry FROM OUTSIDE to footprint
          const fromInFootprint =
            this.collisionService.isTileInBuildingFootprint(
              fromTile.x,
              fromTile.z,
            ) !== null;
          if (fromInFootprint) continue; // Skip interior-to-interior moves

          totalStepsTested++;

          // Test ground player entry
          const check = this.collisionService.checkBuildingMovement(
            fromTile,
            footprintTile,
            0, // floor
            null, // ground player
          );

          if (check.buildingAllowsMovement) {
            // Entry was ALLOWED - this is only valid for door tiles with correct direction
            if (!isDoorTile) {
              // VIOLATION: Entry to non-door tile allowed!
              violations++;
              if (violationDetails.length < 20) {
                violationDetails.push(
                  `${building.buildingId}: (${fromTile.x},${fromTile.z})→(${footprintTile.x},${footprintTile.z}) [${adj.name}] ` +
                    `ENTRY ALLOWED to NON-DOOR tile! doors=[${Array.from(doorTileSet).slice(0, 3).join(";")}...]`,
                );
              }
            } else {
              // Entry to door tile - verify direction is correct
              // The door should face the direction we're coming from
              const doorWall = doorWalls.find(
                (d) =>
                  d.tileX === footprintTile.x && d.tileZ === footprintTile.z,
              );
              if (doorWall) {
                // Calculate expected approach direction for this door
                let expectedApproachDx = 0,
                  expectedApproachDz = 0;
                switch (doorWall.side) {
                  case "north":
                    expectedApproachDz = -1;
                    break; // Door faces north, approach from north (dz < 0)
                  case "south":
                    expectedApproachDz = 1;
                    break;
                  case "east":
                    expectedApproachDx = 1;
                    break;
                  case "west":
                    expectedApproachDx = -1;
                    break;
                }

                // For diagonal entry, one component must match
                const isCardinal = adj.dx === 0 || adj.dz === 0;
                let directionValid = false;

                if (isCardinal) {
                  // Cardinal: must match exactly
                  directionValid =
                    adj.dx === expectedApproachDx &&
                    adj.dz === expectedApproachDz;
                } else {
                  // Diagonal: at least one component must be coming from door direction
                  directionValid =
                    (expectedApproachDx !== 0 &&
                      adj.dx === expectedApproachDx) ||
                    (expectedApproachDz !== 0 && adj.dz === expectedApproachDz);
                }

                if (!directionValid) {
                  violations++;
                  if (violationDetails.length < 20) {
                    violationDetails.push(
                      `${building.buildingId}: (${fromTile.x},${fromTile.z})→(${footprintTile.x},${footprintTile.z}) [${adj.name}] ` +
                        `ENTRY ALLOWED from WRONG DIRECTION! door faces ${doorWall.side}`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }

    // Report results
    Logger.system(
      "TownSystem",
      `Entry validation: tested ${totalStepsTested} exterior→footprint steps`,
    );

    if (violations > 0) {
      Logger.systemError(
        "TownSystem",
        `\n╔══════════════════════════════════════════════════════════════╗`,
      );
      Logger.systemError(
        "TownSystem",
        `║  CRITICAL: ${violations} INVALID BUILDING ENTRIES DETECTED!           ║`,
      );
      Logger.systemError(
        "TownSystem",
        `╠══════════════════════════════════════════════════════════════╣`,
      );

      for (const violation of violationDetails) {
        Logger.systemError("TownSystem", `║  ❌ ${violation}`);
      }

      if (violationDetails.length < violations) {
        Logger.systemError(
          "TownSystem",
          `║  ... and ${violations - violationDetails.length} more violations`,
        );
      }

      Logger.systemError(
        "TownSystem",
        `╚══════════════════════════════════════════════════════════════╝\n`,
      );

      throw new Error(
        `[TownSystem] CRITICAL NAVIGATION BUG: ${violations} ways to enter buildings without using doors! ` +
          `Players can clip through walls. Server startup ABORTED.`,
      );
    } else {
      Logger.system(
        "TownSystem",
        `✓ Entry validation PASSED: All ${totalStepsTested} exterior→footprint steps require doors`,
      );
    }
  }

  /**
   * Build a per-tile footprint mask (1m tiles) for a building.
   * Used for precise flat zones and terrain carving on non-rectangular footprints.
   */
  private buildFootprintTileMask(
    building: TownBuilding,
    layout: BuildingLayout,
  ): {
    tileMask: Set<string>;
    tileMaskTiles: FlatZoneTile[];
    tileMaskBounds: FlatZoneTileBounds;
  } | null {
    // Use the exterior footprint for terrain carving if available.
    // The exterior footprint fills interior voids (courtyards) so the
    // terrain is correctly removed under the entire building silhouette,
    // not just the walkable interior cells.
    const footprint =
      layout.exteriorFootprint ?? layout.floorPlans[0]?.footprint;
    if (!footprint) return null;
    const tileMask = new Set<string>();
    const tileMaskTiles: FlatZoneTile[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    const tilesPerCell = TILES_PER_CELL;
    const halfTiles = Math.floor(tilesPerCell / 2);

    for (let row = 0; row < footprint.length; row++) {
      for (let col = 0; col < footprint[row].length; col++) {
        if (!footprint[row][col]) continue;

        const centerTile = cellToWorldTile(
          { col, row },
          building.position.x,
          building.position.z,
          layout.width,
          layout.depth,
          building.rotation,
          CELL_SIZE,
        );

        for (let dtx = -halfTiles; dtx < tilesPerCell - halfTiles; dtx++) {
          for (let dtz = -halfTiles; dtz < tilesPerCell - halfTiles; dtz++) {
            const tileX = centerTile.x + dtx;
            const tileZ = centerTile.z + dtz;
            const key = tileKey(tileX, tileZ);
            if (tileMask.has(key)) continue;
            tileMask.add(key);
            tileMaskTiles.push({ x: tileX, z: tileZ });
            minX = Math.min(minX, tileX);
            maxX = Math.max(maxX, tileX);
            minZ = Math.min(minZ, tileZ);
            maxZ = Math.max(maxZ, tileZ);
          }
        }
      }
    }

    if (tileMaskTiles.length === 0) return null;

    return {
      tileMask,
      tileMaskTiles,
      tileMaskBounds: { minX, maxX, minZ, maxZ },
    };
  }

  /**
   * Calculate the maximum terrain height under a building's footprint.
   * On steep hills, the building floor must be at the HIGHEST terrain point
   * to prevent terrain from poking through the building.
   *
   * Uses getProceduralHeightAt to get raw terrain height, ignoring previously
   * registered flat zones (which could cause double-counting of FOUNDATION_HEIGHT).
   *
   * @param building - The building to calculate height for
   * @param layout - The building's generated layout
   * @returns Maximum terrain height under the building footprint
   */
  private calculateMaxTerrainHeightForBuilding(
    building: TownBuilding,
    layout: BuildingLayout,
    tileMaskData?: {
      tileMask: Set<string>;
      tileMaskTiles: FlatZoneTile[];
      tileMaskBounds: FlatZoneTileBounds;
    } | null,
  ): number {
    // Fallback to building center height if terrain system unavailable
    if (!this.terrainSystem) {
      return building.position.y;
    }

    tileMaskData ??= this.buildFootprintTileMask(building, layout);
    if (!tileMaskData) {
      return building.position.y;
    }

    // Get procedural height function (ignores flat zones)
    const terrain = this.terrainSystem as {
      getProceduralHeightAt?: (x: number, z: number) => number;
      getHeightAt: (x: number, z: number) => number;
    };
    const getHeight = terrain.getProceduralHeightAt
      ? (x: number, z: number) =>
          (terrain.getProceduralHeightAt as (x: number, z: number) => number)(
            x,
            z,
          )
      : (x: number, z: number) => terrain.getHeightAt(x, z);

    // Find maximum terrain height across all footprint tiles
    let maxTerrainHeight = building.position.y;
    for (const tile of tileMaskData.tileMaskTiles) {
      const height = getHeight(tile.x + 0.5, tile.z + 0.5);
      maxTerrainHeight = Math.max(maxTerrainHeight, height);
    }

    return maxTerrainHeight;
  }

  /**
   * Register a flat zone for a building with TerrainSystem.
   *
   * This is the key to making buildings walkable - same approach as duel arena:
   * 1. Flat zones modify the terrain heightmap
   * 2. getHeightAt() returns the flat zone height instead of procedural terrain
   * 3. Players naturally walk at the correct elevation
   *
   * **IMPORTANT:** Creates ONE flat zone per building (not per-cell) to avoid
   * seams between adjacent cells. The `getFlatZoneHeight` function only uses
   * the first matching zone, so multiple overlapping zones cause hard edges.
   *
   * **STEEP HILL HANDLING:**
   * - The groundY passed in is already the MAXIMUM terrain height (from calculateMaxTerrainHeightForBuilding)
   * - Accounts for building rotation when calculating flat zone bounds
   * - Flat zone is axis-aligned bounding box of the rotated footprint
   *
   * For L-shaped buildings, the flat zone core uses the exact tile footprint,
   * while the blend zone still uses the AABB for smooth terrain transitions.
   *
   * @param building - The building to register a flat zone for
   * @param layout - The building's generated layout
   * @param groundY - The MAXIMUM terrain height under the building footprint
   */
  private registerBuildingFlatZone(
    building: TownBuilding,
    layout: BuildingLayout,
    maxGroundY: number,
    tileMaskData?: {
      tileMask: Set<string>;
      tileMaskTiles: FlatZoneTile[];
      tileMaskBounds: FlatZoneTileBounds;
    } | null,
  ): void {
    if (!this.terrainSystem) return;

    // Use the exterior footprint for flat zone registration.
    // This ensures the entire building silhouette (including courtyards, enclosed voids)
    // is properly flattened and carved from the terrain.
    const footprint =
      layout.exteriorFootprint ?? layout.floorPlans[0]?.footprint;
    if (!footprint || footprint.length === 0) {
      Logger.systemWarn(
        "TownSystem",
        `No footprint for ${building.id}, skipping flat zone`,
      );
      return;
    }

    tileMaskData ??= this.buildFootprintTileMask(building, layout);

    // Find the bounding box of all occupied cells in LOCAL space
    let minCol = Infinity,
      maxCol = -Infinity;
    let minRow = Infinity,
      maxRow = -Infinity;
    let cellCount = 0;

    for (let row = 0; row < footprint.length; row++) {
      for (let col = 0; col < footprint[row].length; col++) {
        if (footprint[row][col]) {
          minCol = Math.min(minCol, col);
          maxCol = Math.max(maxCol, col);
          minRow = Math.min(minRow, row);
          maxRow = Math.max(maxRow, row);
          cellCount++;
        }
      }
    }

    if (cellCount === 0) {
      Logger.systemWarn(
        "TownSystem",
        `Empty footprint for ${building.id}, skipping flat zone`,
      );
      return;
    }

    // Terrain registration function
    const terrain = this.terrainSystem as {
      registerFlatZone?: (zone: FlatZone) => void;
    };
    if (!terrain.registerFlatZone) return;

    // Exterior padding and blend radius (must match calculateMaxTerrainHeightForBuilding)
    const exteriorPadding = 3.0; // 3m around building
    const blendRadius = 10.0; // 10m smooth blend for natural transitions on steep hills
    // Carve inset trims the flat zone core back to the building footprint
    // plus foundation overhang (prevents carving into the blended padding).
    const carveInset = Math.max(0, exteriorPadding - FOUNDATION_OVERHANG);

    // Calculate building bounds in LOCAL space (before rotation)
    const localMinX = (minCol - layout.width / 2) * CELL_SIZE - exteriorPadding;
    const localMaxX =
      (maxCol + 1 - layout.width / 2) * CELL_SIZE + exteriorPadding;
    const localMinZ = (minRow - layout.depth / 2) * CELL_SIZE - exteriorPadding;
    const localMaxZ =
      (maxRow + 1 - layout.depth / 2) * CELL_SIZE + exteriorPadding;

    // Get building rotation
    const cos = Math.cos(building.rotation);
    const sin = Math.sin(building.rotation);

    // Helper to rotate a local point to world coordinates
    const rotateToWorld = (
      localX: number,
      localZ: number,
    ): { x: number; z: number } => ({
      x: building.position.x + localX * cos - localZ * sin,
      z: building.position.z + localX * sin + localZ * cos,
    });

    // Calculate all 4 corners of the rotated footprint in world coordinates
    const corners = [
      rotateToWorld(localMinX, localMinZ),
      rotateToWorld(localMaxX, localMinZ),
      rotateToWorld(localMinX, localMaxZ),
      rotateToWorld(localMaxX, localMaxZ),
    ];

    // Calculate axis-aligned bounding box of the rotated footprint
    let worldMinX = Infinity,
      worldMaxX = -Infinity;
    let worldMinZ = Infinity,
      worldMaxZ = -Infinity;

    for (const corner of corners) {
      worldMinX = Math.min(worldMinX, corner.x);
      worldMaxX = Math.max(worldMaxX, corner.x);
      worldMinZ = Math.min(worldMinZ, corner.z);
      worldMaxZ = Math.max(worldMaxZ, corner.z);
    }

    // Terrain height should sit just below the FOUNDATION BASE to avoid clipping
    // through the building volumes and reduce overdraw under floors.
    // maxGroundY is already calculated by calculateMaxTerrainHeightForBuilding.
    const TERRAIN_Z_FIGHT_OFFSET = 0.05;
    const terrainHeight = maxGroundY - TERRAIN_Z_FIGHT_OFFSET;

    // Flat zone dimensions from axis-aligned bounding box
    const zoneWidth = worldMaxX - worldMinX;
    const zoneDepth = worldMaxZ - worldMinZ;
    const zoneCenterX = (worldMinX + worldMaxX) / 2;
    const zoneCenterZ = (worldMinZ + worldMaxZ) / 2;

    const zone: FlatZone = {
      id: `building_${building.id}`,
      centerX: zoneCenterX,
      centerZ: zoneCenterZ,
      width: zoneWidth,
      depth: zoneDepth,
      height: terrainHeight,
      blendRadius,
      carveInset,
    };

    if (tileMaskData) {
      zone.tileMask = tileMaskData.tileMask;
      zone.tileMaskTiles = tileMaskData.tileMaskTiles;
      zone.tileMaskBounds = tileMaskData.tileMaskBounds;
    }

    terrain.registerFlatZone(zone);

    // Log for debugging steep hill cases
    const centerHeight = building.position.y;
    const heightDiff = maxGroundY - centerHeight;
    Logger.system(
      "TownSystem",
      `Registered flat zone for ${building.id}: ${zoneWidth.toFixed(1)}x${zoneDepth.toFixed(1)}m at (${zoneCenterX.toFixed(0)}, ${zoneCenterZ.toFixed(0)}), ` +
        `terrain=${terrainHeight.toFixed(2)}m (maxTerrain=${maxGroundY.toFixed(2)}, center=${centerHeight.toFixed(2)}, slopeDiff=${heightDiff.toFixed(2)}m)`,
    );
  }

  /**
   * Convert BuildingLayout from procgen to BuildingLayoutInput for collision service
   */
  private convertLayoutToInput(layout: BuildingLayout): BuildingLayoutInput {
    return {
      width: layout.width,
      depth: layout.depth,
      floors: layout.floors,
      floorPlans: layout.floorPlans.map((fp) => ({
        footprint: fp.footprint,
        roomMap: fp.roomMap,
        internalOpenings: fp.internalOpenings,
        externalOpenings: fp.externalOpenings,
      })),
      exteriorFootprint: layout.exteriorFootprint,
      stairs: layout.stairs,
    };
  }

  // ============================================================================
  // BUILDING LAYOUT ACCESS
  // ============================================================================

  /**
   * Get cached building layout by building ID.
   * Used by BuildingRenderingSystem to avoid regenerating layouts.
   *
   * @param buildingId - Building ID to get layout for
   * @returns BuildingLayout if cached, undefined otherwise
   */
  getBuildingLayout(buildingId: string): BuildingLayout | undefined {
    return this.buildingLayouts.get(buildingId);
  }

  /**
   * Get all cached building layouts.
   * Used by BuildingRenderingSystem for batch rendering.
   */
  getAllBuildingLayouts(): Map<string, BuildingLayout> {
    return this.buildingLayouts;
  }

  /**
   * Get the BuildingCollisionService instance.
   * Used for floor-aware collision queries.
   */
  getCollisionService(): BuildingCollisionService {
    return this.collisionService;
  }

  /**
   * Check if a tile is walkable considering building collision.
   * This is for pathfinding integration.
   *
   * @param tileX - World tile X coordinate
   * @param tileZ - World tile Z coordinate
   * @param floorIndex - Floor level (0 = ground floor)
   * @returns true if walkable at this floor
   */
  isBuildingTileWalkable(
    tileX: number,
    tileZ: number,
    floorIndex: number = 0,
  ): boolean {
    return this.collisionService.isWalkableAtFloor(tileX, tileZ, floorIndex);
  }

  /**
   * Check if movement between tiles is blocked by a building wall.
   *
   * @param fromX - Source tile X
   * @param fromZ - Source tile Z
   * @param toX - Destination tile X
   * @param toZ - Destination tile Z
   * @param floorIndex - Current floor level
   * @returns true if movement blocked by wall
   */
  isBuildingWallBlocked(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    floorIndex: number = 0,
  ): boolean {
    return this.collisionService.isWallBlocked(
      fromX,
      fromZ,
      toX,
      toZ,
      floorIndex,
    );
  }

  destroy(): void {
    // Clear collision service
    if (this.collisionService) {
      this.collisionService.clear();
    }

    // Clear cached layouts
    this.buildingLayouts.clear();

    this.towns = [];
    super.destroy();
  }
}
