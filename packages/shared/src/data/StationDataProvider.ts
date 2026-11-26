/**
 * StationDataProvider - Runtime Data for World Stations
 *
 * Provides model paths and configuration for permanent world stations:
 * - Anvils (smithing)
 * - Furnaces (smelting)
 * - Ranges (cooking)
 * - Bank booths
 *
 * AUTOMATIC FOOTPRINT DETECTION:
 * Footprints are automatically calculated from model bounds (model-bounds.json)
 * combined with modelScale from stations.json. No manual footprint config needed.
 *
 * How it works:
 * 1. Build step: extract-model-bounds.ts scans GLB files and generates model-bounds.json
 * 2. Server startup: DataManager loads both stations.json and model-bounds.json
 * 3. StationDataProvider: Computes footprint = (rawDimensions * modelScale) rounded to tiles
 *
 * To add a new station:
 * 1. Add the model to assets/models/
 * 2. Add entry to stations.json (no footprint needed - just model path & scale)
 * 3. Build (generates model-bounds.json automatically)
 * 4. Done
 *
 * Usage:
 *   const provider = StationDataProvider.getInstance();
 *   const anvilData = provider.getStationData("anvil");
 *   const footprint = anvilData?.footprint; // Auto-calculated from model
 *
 * @see packages/server/world/assets/manifests/stations.json
 * @see packages/server/world/assets/manifests/model-bounds.json
 */

import type { FootprintSpec } from "../types/game/resource-processing-types";
import type { GrassExclusionBounds } from "../types/world/terrain";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Station definition from manifests/stations.json
 */
export interface StationManifestEntry {
  /** Station type identifier (anvil, furnace, range, bank) */
  type: string;
  /** Display name */
  name: string;
  /** Model path (asset:// URL) or null for placeholder geometry */
  model: string | null;
  /** Model scale factor - applied to model AND used for collision calculation */
  modelScale: number;
  /** Model Y offset to raise model so base sits on ground */
  modelYOffset: number;
  /** Examine text */
  examine: string;
  /** Manual footprint override (optional - auto-detected from model if not specified) */
  footprint?: FootprintSpec;
  /** Enable terrain flattening under this station (default: false) */
  flattenGround?: boolean;
  /** Extra meters around footprint to flatten (default: 0.3) */
  flattenPadding?: number;
  /** Meters over which to blend from flat to procedural terrain (default: 0.5) */
  flattenBlendRadius?: number;
  /** Grass-only clearance in meters beyond the scaled model bounds; omission preserves the terrain pad exclusion. */
  grassClearanceMargin?: number;
}

/**
 * Full manifest structure for manifests/stations.json
 */
export interface StationsManifest {
  stations: StationManifestEntry[];
}

/**
 * Model bounds entry from manifests/model-bounds.json
 */
export interface ModelBoundsEntry {
  /** Model identifier (directory name) */
  id: string;
  /** Full asset path (asset://models/...) */
  assetPath: string;
  /** Raw bounding box in model space */
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  /** Raw dimensions (max - min) at scale 1.0 */
  dimensions: { x: number; y: number; z: number };
  /** Pre-calculated footprint at scale 1.0 (we recalculate with actual scale) */
  footprint: { width: number; depth: number };
}

/**
 * Full manifest structure for manifests/model-bounds.json
 */
export interface ModelBoundsManifest {
  generatedAt: string;
  tileSize: number;
  models: ModelBoundsEntry[];
}

/**
 * Runtime station data with resolved values
 */
export interface StationData {
  type: string;
  name: string;
  model: string | null;
  modelScale: number;
  modelYOffset: number;
  examine: string;
  /** Collision footprint - auto-calculated from model bounds * scale */
  footprint: FootprintSpec;
  /** Enable terrain flattening under this station */
  flattenGround: boolean;
  /** Extra meters around footprint to flatten */
  flattenPadding: number;
  /** Meters over which to blend from flat to procedural terrain */
  flattenBlendRadius: number;
  /** Optional grass-only clearance, independent of terrain grading and collision. */
  grassClearanceMargin?: number;
}

// ============================================================================
// DEFAULT STATION DATA (fallback if manifests not loaded)
// ============================================================================

const DEFAULT_STATIONS: StationManifestEntry[] = [
  {
    type: "anvil",
    name: "Anvil",
    model: "asset://models/anvil/anvil.glb",
    modelScale: 0.5,
    modelYOffset: 0.4,
    examine: "An anvil for smithing metal bars into weapons and tools.",
    // Footprint will be auto-calculated: raw 2.01x1.15 * 0.5 = 1.0x0.58 → 1x1 tiles
  },
  {
    type: "furnace",
    name: "Furnace",
    model: "asset://models/furnace/furnace.glb",
    modelScale: 1.5,
    modelYOffset: 1.0,
    examine: "A furnace for smelting ores into metal bars.",
    // Footprint will be auto-calculated: raw 1.51x1.45 * 1.5 = 2.27x2.18 → 2x2 tiles
  },
  {
    type: "range",
    name: "Cooking Range",
    model: null,
    modelScale: 1.0,
    modelYOffset: 0,
    examine: "A range for cooking food. Reduces burn chance.",
    footprint: { width: 1, depth: 1 }, // No model, use explicit footprint
  },
  {
    type: "bank",
    name: "Bank Booth",
    model: null,
    modelScale: 1.0,
    modelYOffset: 0,
    examine: "A bank booth for storing items.",
    footprint: { width: 1, depth: 1 }, // No model, use explicit footprint
  },
];

// ============================================================================
// STATION DATA PROVIDER
// ============================================================================

/** Tile size in world units (1 tile = 1 meter) */
const TILE_SIZE = 1.0;

/**
 * Runtime data provider for world station entities.
 * Provides model paths and configuration for anvils, furnaces, ranges, etc.
 * Automatically calculates footprints from model bounds.
 */
export class StationDataProvider {
  private static instance: StationDataProvider;

  // Station lookup by type
  private stationsByType = new Map<string, StationData>();

  // Model bounds lookup by asset path
  private modelBoundsByPath = new Map<string, ModelBoundsEntry>();

  // Raw station entries (before footprint calculation)
  private stationEntries: StationManifestEntry[] = [];

  // Initialization state
  private isInitialized = false;
  private hasBoundsData = false;

  private constructor() {
    // Initialize with defaults immediately
    this.stationEntries = DEFAULT_STATIONS;
    this.rebuildStations();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): StationDataProvider {
    if (!StationDataProvider.instance) {
      StationDataProvider.instance = new StationDataProvider();
    }
    return StationDataProvider.instance;
  }

  // ==========================================================================
  // MANIFEST LOADING (called by DataManager)
  // ==========================================================================

  /**
   * Load station definitions from manifest.
   * Called by DataManager after loading manifests/stations.json.
   */
  public loadStations(manifest: StationsManifest): void {
    // Bounds may arrive later. Validate authored margins before replacing the
    // current station table, then resolve geometry only when it is requested.
    for (const entry of manifest.stations) {
      if (entry.grassClearanceMargin !== undefined) {
        this.validateGrassClearanceMargin(
          entry.type,
          entry.grassClearanceMargin,
        );
      }
    }
    this.stationEntries = manifest.stations;
    this.rebuildStations();
  }

  /**
   * Load model bounds from manifest.
   * Called by DataManager after loading manifests/model-bounds.json.
   * This enables automatic footprint calculation from actual model geometry.
   */
  public loadModelBounds(manifest: ModelBoundsManifest): void {
    this.modelBoundsByPath.clear();

    for (const entry of manifest.models) {
      this.modelBoundsByPath.set(entry.assetPath, entry);
    }

    this.hasBoundsData = true;

    // Rebuild stations now that we have bounds data
    this.rebuildStations();
  }

  /**
   * Rebuild station data, computing footprints from model bounds.
   */
  private rebuildStations(): void {
    this.stationsByType.clear();

    for (const entry of this.stationEntries) {
      // Calculate footprint from model bounds if available
      let footprint: FootprintSpec;

      if (entry.footprint) {
        // Explicit footprint override takes precedence
        footprint = entry.footprint;
      } else if (entry.model && this.hasBoundsData) {
        // Auto-calculate from model bounds
        footprint = this.calculateFootprint(
          entry.model,
          entry.modelScale ?? 1.0,
        );
      } else {
        // Default fallback
        footprint = { width: 1, depth: 1 };
      }

      const stationData: StationData = {
        type: entry.type,
        name: entry.name,
        model: entry.model,
        modelScale: entry.modelScale,
        modelYOffset: entry.modelYOffset ?? 0,
        examine: entry.examine,
        footprint,
        flattenGround: entry.flattenGround ?? false,
        flattenPadding: entry.flattenPadding ?? 0.3,
        flattenBlendRadius: entry.flattenBlendRadius ?? 0.5,
      };
      if (entry.grassClearanceMargin !== undefined) {
        this.validateGrassClearanceMargin(
          entry.type,
          entry.grassClearanceMargin,
        );
        stationData.grassClearanceMargin = entry.grassClearanceMargin;
      }

      this.stationsByType.set(entry.type, stationData);
    }

    this.isInitialized = true;
  }

  /**
   * Calculate footprint from model bounds and scale.
   * @param modelPath - Asset path (asset://models/...)
   * @param modelScale - Scale factor from stations.json
   * @returns Footprint in tiles
   */
  private calculateFootprint(
    modelPath: string,
    modelScale: number,
  ): FootprintSpec {
    const bounds = this.modelBoundsByPath.get(modelPath);

    if (!bounds) {
      // Model not found in bounds manifest, return default
      return { width: 1, depth: 1 };
    }

    // SAFETY: Detect corrupted bounds data (values > 1000 are clearly wrong)
    // This catches the 32767 overflow issue in model-bounds.json
    const MAX_REASONABLE_DIMENSION = 100; // 100 meters max for any model
    if (
      bounds.dimensions.x > MAX_REASONABLE_DIMENSION ||
      bounds.dimensions.z > MAX_REASONABLE_DIMENSION
    ) {
      console.warn(
        `[StationDataProvider] Corrupted bounds for ${modelPath}: ${bounds.dimensions.x}x${bounds.dimensions.z}m - using default 1x1`,
      );
      return { width: 1, depth: 1 };
    }

    // Apply scale to raw dimensions to get actual visual footprint
    const scaledWidth = bounds.dimensions.x * modelScale;
    const scaledDepth = bounds.dimensions.z * modelScale;

    // Round to nearest tile (not ceil - avoids over-blocking)
    // Also clamp to max 10 tiles per dimension as a final safety net
    return {
      width: Math.min(10, Math.max(1, Math.round(scaledWidth / TILE_SIZE))),
      depth: Math.min(10, Math.max(1, Math.round(scaledDepth / TILE_SIZE))),
    };
  }

  /**
   * Rebuild lookup tables (e.g., after manifest reload)
   */
  public rebuild(): void {
    this.rebuildStations();
  }

  // ==========================================================================
  // DATA ACCESS METHODS
  // ==========================================================================

  /**
   * Get station data by type.
   * @param stationType - Station type (anvil, furnace, range, bank)
   * @returns Station data or undefined if not found
   */
  public getStationData(stationType: string): StationData | undefined {
    return this.stationsByType.get(stationType);
  }

  private validateGrassClearanceMargin(
    stationType: string,
    margin: number,
  ): void {
    if (typeof margin !== "number" || !Number.isFinite(margin) || margin < 0) {
      throw new Error(
        `[StationDataProvider] ${stationType}: grassClearanceMargin must be a finite nonnegative number`,
      );
    }
  }

  /**
   * Resolve optional grass clearance around the actual, unrotated station model.
   * Uses model-space min/max rather than rounded collision tiles, preserving an
   * off-center model pivot. The margin and result never alter the grading pad.
   * Configured clearances require usable geometry; there is no fallback box.
   */
  public getGrassExclusionBounds(
    stationType: string,
    centerX: number,
    centerZ: number,
  ): GrassExclusionBounds | undefined {
    const station = this.stationsByType.get(stationType);
    const margin = station?.grassClearanceMargin;
    if (margin === undefined) return undefined;
    this.validateGrassClearanceMargin(stationType, margin);

    if (!Number.isFinite(centerX) || !Number.isFinite(centerZ)) {
      throw new Error(
        `[StationDataProvider] ${stationType}: grass clearance requires a finite world position`,
      );
    }
    if (
      !station ||
      typeof station.model !== "string" ||
      station.model.length === 0 ||
      !Number.isFinite(station.modelScale) ||
      station.modelScale <= 0
    ) {
      throw new Error(
        `[StationDataProvider] ${stationType}: grass clearance requires a model and positive finite modelScale`,
      );
    }

    const bounds = this.modelBoundsByPath.get(station.model)?.bounds;
    if (
      !bounds ||
      !Number.isFinite(bounds.min?.x) ||
      !Number.isFinite(bounds.max?.x) ||
      !Number.isFinite(bounds.min?.z) ||
      !Number.isFinite(bounds.max?.z) ||
      bounds.min.x >= bounds.max.x ||
      bounds.min.z >= bounds.max.z
    ) {
      throw new Error(
        `[StationDataProvider] ${stationType}: grass clearance requires finite, nonempty XZ model bounds for ${station.model}`,
      );
    }

    const result: GrassExclusionBounds = {
      minX: centerX + bounds.min.x * station.modelScale - margin,
      maxX: centerX + bounds.max.x * station.modelScale + margin,
      minZ: centerZ + bounds.min.z * station.modelScale - margin,
      maxZ: centerZ + bounds.max.z * station.modelScale + margin,
    };
    if (
      !Object.values(result).every(Number.isFinite) ||
      result.minX >= result.maxX ||
      result.minZ >= result.maxZ
    ) {
      throw new Error(
        `[StationDataProvider] ${stationType}: grass clearance cannot be represented as finite, nonempty world bounds`,
      );
    }
    return result;
  }

  /**
   * Get model path for a station type.
   * @param stationType - Station type
   * @returns Model path or null if no model / not found
   */
  public getModelPath(stationType: string): string | null {
    return this.stationsByType.get(stationType)?.model ?? null;
  }

  /**
   * Get model scale for a station type.
   * @param stationType - Station type
   * @returns Model scale or 1.0 if not found
   */
  public getModelScale(stationType: string): number {
    return this.stationsByType.get(stationType)?.modelScale ?? 1.0;
  }

  /**
   * Get model Y offset for a station type.
   * Used to raise the model so its base sits on the ground.
   * @param stationType - Station type
   * @returns Y offset or 0 if not found
   */
  public getModelYOffset(stationType: string): number {
    return this.stationsByType.get(stationType)?.modelYOffset ?? 0;
  }

  /**
   * Get collision footprint for a station type.
   * Auto-calculated from model bounds and scale.
   * @param stationType - Station type
   * @returns Footprint dimensions or 1x1 if not found
   */
  public getFootprint(stationType: string): FootprintSpec {
    return (
      this.stationsByType.get(stationType)?.footprint ?? { width: 1, depth: 1 }
    );
  }

  /**
   * Get examine text for a station type.
   * @param stationType - Station type
   * @returns Examine text or default string if not found
   */
  public getExamineText(stationType: string): string {
    return (
      this.stationsByType.get(stationType)?.examine ??
      "A station for processing items."
    );
  }

  /**
   * Check if a station type exists in the manifest.
   * @param stationType - Station type to check
   */
  public hasStation(stationType: string): boolean {
    return this.stationsByType.has(stationType);
  }

  /**
   * Get all station types.
   */
  public getAllStationTypes(): string[] {
    return Array.from(this.stationsByType.keys());
  }

  /**
   * Check if provider is initialized.
   */
  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Check if model bounds data is loaded.
   */
  public hasBounds(): boolean {
    return this.hasBoundsData;
  }
}

// Export singleton instance
export const stationDataProvider = StationDataProvider.getInstance();
