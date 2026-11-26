/**
 * POISystem - Points of Interest Generation
 * Generates procedural POIs (dungeons, shrines, landmarks, etc.) for road connections.
 *
 * POIs are smaller than towns but significant enough to warrant road access.
 * The RoadNetworkSystem extends roads from towns to nearby important POIs.
 *
 * Configuration loaded from world-config.json via DataManager.
 * IMPORTANT: DataManager.loadManifests*() must be called BEFORE POISystem.init()
 */

import { System } from "../infrastructure/System";
import type { World } from "../../../core/World";
import type {
  PointOfInterest,
  POICategory,
  POIConfig,
} from "../../../types/world/world-types";
import { NoiseGenerator } from "../../../utils/NoiseGenerator";
import { Logger } from "../../../utils/Logger";
import { BiomeType, DEFAULT_BIOME } from "./TerrainBiomeTypes";
import { DataManager } from "../../../data/DataManager";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import { dist2D } from "../../../utils/MathUtils";
import type { TownSystem } from "./TownSystem";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";

// Default configuration values
const DEFAULTS: POIConfig = {
  countPerCategory: {
    dungeon: 8,
    shrine: 12,
    landmark: 15,
    resource_area: 10,
    ruin: 6,
    camp: 8,
    crossing: 5,
    waystation: 10,
    fishing_spot: 12, // Lakeside fishing locations
  },
  minDistanceFromTowns: 100,
  minPOISpacing: 200,
  maxRoadExtensionDistance: 500,
  importanceThresholdForRoad: 0.5,
};

// POI category properties
const CATEGORY_PROPERTIES: Record<
  POICategory,
  { radius: number; baseImportance: number; preferredBiomes: string[] }
> = {
  dungeon: {
    radius: 30,
    baseImportance: 0.9,
    preferredBiomes: [BiomeType.Canyon, BiomeType.Tundra],
  },
  shrine: {
    radius: 10,
    baseImportance: 0.6,
    preferredBiomes: [BiomeType.Forest, BiomeType.Tundra],
  },
  landmark: {
    radius: 20,
    baseImportance: 0.5,
    preferredBiomes: [BiomeType.Canyon, BiomeType.Tundra],
  },
  resource_area: {
    radius: 25,
    baseImportance: 0.7,
    preferredBiomes: [BiomeType.Forest, BiomeType.Canyon],
  },
  ruin: {
    radius: 35,
    baseImportance: 0.8,
    preferredBiomes: [BiomeType.Canyon, BiomeType.Tundra],
  },
  camp: {
    radius: 20,
    baseImportance: 0.4,
    preferredBiomes: [BiomeType.Forest, BiomeType.Tundra],
  },
  crossing: {
    radius: 15,
    baseImportance: 0.85,
    preferredBiomes: [BiomeType.Canyon, BiomeType.Tundra],
  },
  waystation: {
    radius: 12,
    baseImportance: 0.3,
    preferredBiomes: [BiomeType.Forest, BiomeType.Tundra],
  },
  fishing_spot: {
    radius: 15,
    baseImportance: 0.75,
    preferredBiomes: [BiomeType.Forest, BiomeType.Tundra],
  },
};

// Name generation for POIs
const POI_NAME_PREFIXES: Record<POICategory, string[]> = {
  dungeon: ["Dark", "Ancient", "Forgotten", "Shadow", "Deep", "Lost", "Cursed"],
  shrine: ["Sacred", "Hidden", "Old", "Blessed", "Quiet", "Stone", "Forest"],
  landmark: ["Tall", "Great", "Ancient", "Lone", "Twin", "Fallen", "Standing"],
  resource_area: ["Rich", "Old", "Northern", "Southern", "Eastern", "Western"],
  ruin: ["Crumbling", "Ancient", "Forgotten", "Abandoned", "Broken", "Silent"],
  camp: ["Hidden", "Outlaw", "Hunter", "Ranger", "Traveler", "Merchant"],
  crossing: ["Old", "Stone", "Narrow", "Wide", "Rocky", "Swift"],
  waystation: ["Roadside", "Halfway", "Lonely", "Traveler", "Dusty", "Shady"],
  fishing_spot: [
    "Quiet",
    "Peaceful",
    "Sunny",
    "Shady",
    "Deep",
    "Clear",
    "Misty",
  ],
};

const POI_NAME_SUFFIXES: Record<POICategory, string[]> = {
  dungeon: ["Caverns", "Depths", "Mines", "Catacombs", "Tunnels", "Halls"],
  shrine: ["Shrine", "Altar", "Grove", "Circle", "Stones", "Spring"],
  landmark: ["Rock", "Tree", "Falls", "Peak", "Spire", "Mesa"],
  resource_area: ["Quarry", "Grove", "Mine", "Camp", "Fields"],
  ruin: ["Ruins", "Tower", "Keep", "Temple", "Fortress", "Manor"],
  camp: ["Camp", "Hideout", "Lair", "Den", "Outpost", "Shelter"],
  crossing: ["Bridge", "Ford", "Pass", "Crossing", "Gate", "Gap"],
  waystation: ["Rest", "Inn", "Stop", "Shelter", "Post", "Lodge"],
  fishing_spot: ["Cove", "Dock", "Pier", "Shore", "Bank", "Landing"],
};

/**
 * Load POI configuration from DataManager
 */
export function loadPOIConfig(): POIConfig {
  const manifest = DataManager.getWorldConfig()?.pois;
  if (!manifest) return { ...DEFAULTS };

  return {
    countPerCategory: {
      ...DEFAULTS.countPerCategory,
      ...manifest.countPerCategory,
    },
    minDistanceFromTowns:
      manifest.minDistanceFromTowns ?? DEFAULTS.minDistanceFromTowns,
    minPOISpacing: manifest.minPOISpacing ?? DEFAULTS.minPOISpacing,
    maxRoadExtensionDistance:
      manifest.maxRoadExtensionDistance ?? DEFAULTS.maxRoadExtensionDistance,
    importanceThresholdForRoad:
      manifest.importanceThresholdForRoad ??
      DEFAULTS.importanceThresholdForRoad,
  };
}

export class POISystem extends System {
  private pois: PointOfInterest[] = [];
  private seed: number = 0;
  private randomState: number = 0;
  private config!: POIConfig;
  private noise!: NoiseGenerator;
  private townSystem?: TownSystem;
  private terrainSystem?: {
    getHeightAt(x: number, z: number): number;
    getBiomeAtWorldPosition?(x: number, z: number): string;
    getWaterBodyRegistry?(): {
      getWaterSurfaceAt(x: number, z: number): number;
    };
  };

  constructor(world: World) {
    super(world);
  }

  getDependencies() {
    return { required: ["terrain", "towns"], optional: [] };
  }

  async init(): Promise<void> {
    await DataManager.getInstance().initialize();
    this.seed = DataManager.getWorldTerrainProfile().seed;
    this.randomState = this.seed;
    this.config = loadPOIConfig();
    this.noise = new NoiseGenerator(this.seed + 98765);

    this.terrainSystem = this.world.getSystem("terrain") as
      | {
          getHeightAt(x: number, z: number): number;
          getBiomeAtWorldPosition?(x: number, z: number): string;
          getWaterBodyRegistry?(): {
            getWaterSurfaceAt(x: number, z: number): number;
          };
        }
      | undefined;

    this.townSystem = this.world.getSystem("towns") as TownSystem | undefined;

    Logger.system(
      "POISystem",
      `Config: ${Object.values(this.config.countPerCategory).reduce((a, b) => (a ?? 0) + (b ?? 0), 0)} total POIs planned`,
    );
  }

  async start(): Promise<void> {
    if (!this.terrainSystem) {
      throw new Error("POISystem requires TerrainSystem");
    }
    if (!this.townSystem) {
      throw new Error("POISystem requires TownSystem");
    }

    // Generate POIs
    this.generatePOIs();

    Logger.system(
      "POISystem",
      `Generated ${this.pois.length} points of interest`,
    );
  }

  private random(): number {
    this.randomState = (this.randomState * 1664525 + 1013904223) >>> 0;
    return this.randomState / 0xffffffff;
  }

  private resetRandom(seed: number): void {
    this.randomState = seed;
  }

  /**
   * Generate POIs for all categories
   */
  private generatePOIs(): void {
    const categories = Object.keys(
      this.config.countPerCategory,
    ) as POICategory[];
    const bounds = DataManager.getWorldTerrainProfile().bounds;

    for (const category of categories) {
      const count = this.config.countPerCategory[category] ?? 0;
      if (count === 0) continue;

      const generated = this.generatePOIsForCategory(category, count, bounds);
      this.pois.push(...generated);
    }

    // Sort by importance (highest first) for road connection priority
    this.pois.sort((a, b) => b.importance - a.importance);

    Logger.system(
      "POISystem",
      `Categories: ${categories.map((c) => `${c}:${this.pois.filter((p) => p.category === c).length}`).join(", ")}`,
    );
  }

  /**
   * Generate POIs for a specific category
   */
  private generatePOIsForCategory(
    category: POICategory,
    targetCount: number,
    bounds: WorldTerrainProfile["bounds"],
  ): PointOfInterest[] {
    // Special handling for fishing spots - they need to be at water edges
    if (category === "fishing_spot") {
      return this.generateFishingSpotPOIs(targetCount, bounds);
    }

    const pois: PointOfInterest[] = [];
    const properties = CATEGORY_PROPERTIES[category];
    const towns = this.townSystem?.getTowns() ?? [];
    const maxAttempts = targetCount * 20;

    this.resetRandom(this.seed + category.charCodeAt(0) * 12345);

    for (
      let attempt = 0;
      attempt < maxAttempts && pois.length < targetCount;
      attempt++
    ) {
      // Random position with some clustering based on noise
      const baseX = bounds.minX + this.random() * (bounds.maxX - bounds.minX);
      const baseZ = bounds.minZ + this.random() * (bounds.maxZ - bounds.minZ);

      // Add noise-based clustering
      const clusterNoise = this.noise.simplex2D(baseX * 0.001, baseZ * 0.001);
      if (clusterNoise < -0.3) continue; // Skip low-noise areas for variety

      const x = baseX;
      const z = baseZ;

      // Check world bounds
      if (
        x - properties.radius < bounds.minX ||
        x + properties.radius > bounds.maxX ||
        z - properties.radius < bounds.minZ ||
        z + properties.radius > bounds.maxZ
      ) {
        continue;
      }

      // Check distance from towns
      const tooCloseToTown = towns.some(
        (t) =>
          dist2D(x, z, t.position.x, t.position.z) <
          this.config.minDistanceFromTowns,
      );
      if (tooCloseToTown) continue;

      // Check distance from existing POIs (all, not just this category)
      const tooCloseToOtherPOI = [...this.pois, ...pois].some(
        (p) =>
          dist2D(x, z, p.position.x, p.position.z) < this.config.minPOISpacing,
      );
      if (tooCloseToOtherPOI) continue;

      // Get terrain info
      const y = this.terrainSystem!.getHeightAt(x, z);
      const biome =
        this.terrainSystem?.getBiomeAtWorldPosition?.(x, z) ?? DEFAULT_BIOME;

      // Skip underwater (ocean or elevated body)
      const registry = this.terrainSystem?.getWaterBodyRegistry?.();
      const waterSurface = registry
        ? registry.getWaterSurfaceAt(x, z)
        : TERRAIN_CONSTANTS.WATER_THRESHOLD;
      if (y < waterSurface && category !== "crossing") continue;

      // Calculate importance based on biome suitability and noise
      let importance = properties.baseImportance;

      // Biome bonus
      if (properties.preferredBiomes.includes(biome)) {
        importance += 0.1;
      }

      // Noise-based variation
      const importanceNoise = this.noise.simplex2D(
        x * 0.002 + 1000,
        z * 0.002 + 1000,
      );
      importance += importanceNoise * 0.15;

      // Clamp importance
      importance = Math.max(0.1, Math.min(1.0, importance));

      // Generate name
      const name = this.generatePOIName(category, pois.length);

      pois.push({
        id: `poi_${category}_${pois.length}`,
        name,
        category,
        position: { x, y, z },
        importance,
        radius: properties.radius,
        biome,
        connectedRoads: [],
        procedural: true,
      });
    }

    return pois;
  }

  /**
   * Generate fishing spot POIs specifically at water edges (lakes, rivers)
   * These are placed at the transition between land and water for scenic fishing locations.
   */
  private generateFishingSpotPOIs(
    targetCount: number,
    bounds: WorldTerrainProfile["bounds"],
  ): PointOfInterest[] {
    const pois: PointOfInterest[] = [];
    const properties = CATEGORY_PROPERTIES["fishing_spot"];
    const towns = this.townSystem?.getTowns() ?? [];
    const waterThreshold = DataManager.getWorldTerrainProfile().water.threshold;
    const maxAttempts = targetCount * 50; // More attempts needed for water edge finding
    const searchRadius = 300; // Increased search radius for better water finding
    const searchStepSize = 8; // Smaller steps for more precise edge detection
    const searchDirections = 8; // Search in 8 cardinal/diagonal directions per attempt

    this.resetRandom(this.seed + 99999); // Unique seed offset for fishing spots

    let waterEdgesFound = 0;
    let tooCloseToTown = 0;
    let tooCloseToOtherPOI = 0;

    for (
      let attempt = 0;
      attempt < maxAttempts && pois.length < targetCount;
      attempt++
    ) {
      // Random starting position
      const startX = bounds.minX + this.random() * (bounds.maxX - bounds.minX);
      const startZ = bounds.minZ + this.random() * (bounds.maxZ - bounds.minZ);

      // Search in multiple directions from each starting point to maximize chance of finding water
      let waterEdge: { x: number; z: number } | null = null;
      const baseAngle = this.random() * Math.PI * 2; // Random offset for variety
      for (let dir = 0; dir < searchDirections && !waterEdge; dir++) {
        const searchAngle = baseAngle + (dir / searchDirections) * Math.PI * 2;
        waterEdge = this.findWaterEdge(
          startX,
          startZ,
          searchAngle,
          searchRadius,
          searchStepSize,
          waterThreshold,
        );
      }

      if (!waterEdge) continue;

      waterEdgesFound++;
      const { x, z } = waterEdge;
      if (
        x - properties.radius < bounds.minX ||
        x + properties.radius > bounds.maxX ||
        z - properties.radius < bounds.minZ ||
        z + properties.radius > bounds.maxZ
      )
        continue;

      // Check distance from towns (fishing spots can be closer than other POIs)
      const minDistFromTown = this.config.minDistanceFromTowns * 0.5;
      const isTooCloseToTown = towns.some(
        (t) => dist2D(x, z, t.position.x, t.position.z) < minDistFromTown,
      );
      if (isTooCloseToTown) {
        tooCloseToTown++;
        continue;
      }

      // Check distance from other fishing spots only
      // Fishing spots are tied to water edges (natural features), so they only need
      // spacing from each other, not from unrelated POIs like shrines or dungeons
      const minFishingSpotSpacing = this.config.minPOISpacing * 0.75; // 150m between fishing spots
      const isTooCloseToOtherFishingSpot = pois.some(
        (p) => dist2D(x, z, p.position.x, p.position.z) < minFishingSpotSpacing,
      );
      if (isTooCloseToOtherFishingSpot) {
        tooCloseToOtherPOI++;
        continue;
      }

      // Get terrain info at the water edge (on land side)
      const y = this.terrainSystem!.getHeightAt(x, z);
      const biome =
        this.terrainSystem?.getBiomeAtWorldPosition?.(x, z) ?? DEFAULT_BIOME;

      // Calculate importance - fishing spots are important destinations
      let importance = properties.baseImportance;
      if (properties.preferredBiomes.includes(biome)) {
        importance += 0.1;
      }
      // Add variation
      const importanceNoise = this.noise.simplex2D(
        x * 0.002 + 2000,
        z * 0.002 + 2000,
      );
      importance += importanceNoise * 0.1;
      importance = Math.max(0.5, Math.min(1.0, importance)); // Ensure high importance

      const name = this.generatePOIName("fishing_spot", pois.length);

      pois.push({
        id: `poi_fishing_spot_${pois.length}`,
        name,
        category: "fishing_spot",
        position: { x, y, z },
        importance,
        radius: properties.radius,
        biome,
        connectedRoads: [],
        procedural: true,
      });
    }

    if (pois.length > 0) {
      Logger.system(
        "POISystem",
        `Generated ${pois.length} fishing spots at water edges`,
      );
    } else if (waterEdgesFound === 0) {
      Logger.systemWarn(
        "POISystem",
        `Failed to generate fishing spots: no water edges found in ${maxAttempts} attempts. Check if world has water bodies.`,
        { threshold: waterThreshold, attempts: maxAttempts },
      );
    } else {
      Logger.systemWarn(
        "POISystem",
        `Failed to place fishing spots despite finding water edges.`,
        { waterEdgesFound, tooCloseToTown, tooCloseToOtherPOI },
      );
    }

    return pois;
  }

  /**
   * Search for a water edge (transition from land to water) along a ray
   * Returns the position just before the water starts (on land)
   */
  private findWaterEdge(
    startX: number,
    startZ: number,
    angle: number,
    maxDistance: number,
    stepSize: number,
    waterThreshold: number,
  ): { x: number; z: number } | null {
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);

    let currentX = startX;
    let currentZ = startZ;
    let lastHeight = this.terrainSystem!.getHeightAt(currentX, currentZ);
    let lastX = currentX;
    let lastZ = currentZ;

    // If starting underwater, first find land by searching along the ray
    if (lastHeight < waterThreshold) {
      let foundLand = false;
      for (let dist = stepSize; dist <= maxDistance; dist += stepSize) {
        const x = startX + dirX * dist;
        const z = startZ + dirZ * dist;
        const height = this.terrainSystem!.getHeightAt(x, z);
        if (height >= waterThreshold) {
          // Found land - continue search from here (no recursion)
          currentX = x;
          currentZ = z;
          lastHeight = height;
          lastX = x;
          lastZ = z;
          foundLand = true;
          // Continue searching from this point for water edge
          break;
        }
      }
      if (!foundLand) return null;
    }

    // Search for land-to-water transition
    for (let dist = stepSize; dist <= maxDistance; dist += stepSize) {
      const x = currentX + dirX * dist;
      const z = currentZ + dirZ * dist;
      const height = this.terrainSystem!.getHeightAt(x, z);

      if (height < waterThreshold && lastHeight >= waterThreshold) {
        // Found transition from land to water - return position just before water
        // Move slightly toward the edge (30% of step) to be close but on land
        return {
          x: lastX + dirX * (stepSize * 0.3),
          z: lastZ + dirZ * (stepSize * 0.3),
        };
      }

      lastHeight = height;
      lastX = x;
      lastZ = z;
    }

    return null;
  }

  /**
   * Generate a name for a POI
   */
  private generatePOIName(category: POICategory, index: number): string {
    this.resetRandom(this.seed + index * 7919 + category.charCodeAt(0));

    const prefixes = POI_NAME_PREFIXES[category];
    const suffixes = POI_NAME_SUFFIXES[category];

    const prefix = prefixes[Math.floor(this.random() * prefixes.length)];
    const suffix = suffixes[Math.floor(this.random() * suffixes.length)];

    return `${prefix} ${suffix}`;
  }

  /**
   * Calculate entry point for a POI (where road connects)
   * Chooses a point on the perimeter closest to a given target
   */
  calculateEntryPoint(
    poi: PointOfInterest,
    targetX: number,
    targetZ: number,
  ): { x: number; z: number; angle: number } {
    const dx = targetX - poi.position.x;
    const dz = targetZ - poi.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 1) {
      return { x: poi.position.x, z: poi.position.z, angle: 0 };
    }

    const angle = Math.atan2(dz, dx);
    const edgeDist = poi.radius * 0.8;

    return {
      x: poi.position.x + (dx / dist) * edgeDist,
      z: poi.position.z + (dz / dist) * edgeDist,
      angle,
    };
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  getPOIs(): PointOfInterest[] {
    return this.pois;
  }

  getPOIById(id: string): PointOfInterest | undefined {
    return this.pois.find((p) => p.id === id);
  }

  getPOIsByCategory(category: POICategory): PointOfInterest[] {
    return this.pois.filter((p) => p.category === category);
  }

  /**
   * Get POIs that should be connected to roads
   * (importance >= threshold)
   */
  getImportantPOIs(): PointOfInterest[] {
    return this.pois.filter(
      (p) => p.importance >= this.config.importanceThresholdForRoad,
    );
  }

  /**
   * Get POIs within a certain distance of a position
   */
  getPOIsNear(x: number, z: number, maxDistance: number): PointOfInterest[] {
    return this.pois.filter(
      (p) => dist2D(x, z, p.position.x, p.position.z) <= maxDistance,
    );
  }

  /**
   * Get the nearest POI to a position
   */
  getNearestPOI(x: number, z: number): PointOfInterest | undefined {
    if (this.pois.length === 0) return undefined;

    return this.pois.reduce((nearest, poi) =>
      dist2D(x, z, poi.position.x, poi.position.z) <
      dist2D(x, z, nearest.position.x, nearest.position.z)
        ? poi
        : nearest,
    );
  }

  /**
   * Get POI at a specific position (within its radius)
   */
  getPOIAtPosition(x: number, z: number): PointOfInterest | undefined {
    return this.pois.find(
      (p) => dist2D(x, z, p.position.x, p.position.z) <= p.radius,
    );
  }

  /**
   * Get POIs within bounds
   */
  getPOIsInBounds(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): PointOfInterest[] {
    return this.pois.filter((poi) => {
      const r = poi.radius;
      return (
        poi.position.x + r >= minX &&
        poi.position.x - r <= maxX &&
        poi.position.z + r >= minZ &&
        poi.position.z - r <= maxZ
      );
    });
  }

  getConfig(): POIConfig {
    return { ...this.config };
  }

  destroy(): void {
    this.pois = [];
    super.destroy();
  }
}
