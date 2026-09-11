import type { World } from "../../../types";
import type { WorldChunkData } from "../../../types/network/database";
import {
  geometryToPxMesh,
  PMeshHandle,
} from "../../../extras/three/geometryToPxMesh";
import THREE, { MeshStandardNodeMaterial } from "../../../extras/three/three";
import { System } from "../infrastructure/System";
import { EventType } from "../../../types/events";
import { NoiseGenerator } from "../../../utils/NoiseGenerator";
import { InstancedMeshManager } from "../../../utils/rendering/InstancedMeshManager";
import { CollisionFlag, CollisionMask } from "../movement/CollisionFlags";
import { worldToTile } from "../movement/TileSystem";
import {
  generateTerrainTilesBatch,
  terminateTerrainWorkerPool,
  type TerrainWorkerConfig,
  type TerrainWorkerOutput,
} from "../../../utils/workers";
import {
  computeBaseHeight,
  computeIslandMask,
  adjustShorelineHeight,
  buildComputeBiomeWeightsJS,
  BIOME_CONFIG,
  BIOME_CONFIGS,
} from "./TerrainHeightParams";
import {
  worldTerrainProfileIdentity,
  isCompactSculptProfile,
  type WorldTerrainProfile,
} from "./WorldTerrainProfile";
import { createTerrainWorkerConfig } from "../../../utils/workers/TerrainWorkerShared";
import type { ShorelineConfig, BiomeNoiseSet } from "./TerrainHeightParams";
import { BiomeType, DEFAULT_BIOME, BIOME_LIST } from "./TerrainBiomeTypes";
import { WaterBodyRegistry } from "./WaterBodyRegistry";
import { createCompactPondDressing } from "./CompactPondDressing";
import { CompactPondDressingVisuals } from "./CompactPondDressingVisuals";
import { validateRadialPondTerrainProfile } from "./RadialPondTerrainProfile";
import { createAuthoredTerrainSurfaceOperations } from "./AuthoredTerrainSurface";
import {
  createGrassTerrainSurfaceSnapshot,
  GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
  type GrassTerrainSurfaceSnapshot,
} from "../../../utils/workers/GrassTerrainSurfaceSnapshot";
import type { BridgeSystem } from "./BridgeSystem";
// Import terrain generator from procgen package
import { BiomeSystem, type BiomeDefinition } from "@hyperforge/procgen/terrain";

/**
 * Terrain System
 *
 * Specifications:
 * - 100x100m tiles (100m x 100m each)
 * - Explicit compact-world profile shared by authoritative and worker sampling
 * - Only load current tile + adjacent tiles (3x3 = 9 tiles max)
 * - Procedural heightmap generation with biomes
 * - PhysX collision support
 * - Resource placement and road generation
 */

import type { BiomeData } from "../../../types/core/core";
import type {
  ResourceNode,
  TerrainResourceSpawnPoint,
  TerrainTile,
  FlatZone,
  RadialPondTerrainProfile,
} from "../../../types/world/terrain";
import { centeredTerrainTileIndex } from "../../../types/world/terrain";
import type { RoadTileSegment } from "../../../types/world/world-types";
import { PhysicsHandle } from "../../../types/systems/physics";
import { getPhysX } from "../../../physics/PhysXManager";
import { Layers } from "../../../physics/Layers";
import { BIOMES } from "../../../data/world-structure";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import { createCompactResourceGroveNodes } from "./CompactResourceGroves";
import {
  getDuelArenaConfig,
  isPositionInsideDuelArenaZone,
} from "../../../data/duel-manifest";
import {
  createDuelArenaFloorZones,
  getDuelArenaGradeHeight,
} from "../../../data/arena-grading";
import { DataManager } from "../../../data/DataManager";
import { createCompactPreparationDetailRegions } from "./CompactIslandDetail";
import {
  createCompactTerrainColorOperations,
  COMPACT_TERRAIN_COMPOSITION,
  type CompactTerrainPond,
  type CompactTerrainMacroField,
} from "./CompactTerrainPalette";
// NOTE: Import directly to avoid circular dependency through barrel file
import { WaterSystem } from "./WaterSystem";
import {
  generateCenteredTrees,
  generateOres,
  generateRocks,
  // generatePlants, // DISABLED - plants not working/looking good yet
  type ResourceGenerationContext,
  type TreeGenerationSource,
} from "./BiomeResourceGenerator";
import {
  getTreeConfigForBiome,
  getGrassConfigForBiome,
} from "./TerrainBiomeTypes";
import {
  setProcgenRockWorld,
  addRockInstance,
  preWarmRockCache,
  BIOME_ROCK_PRESETS,
} from "./ProcgenRockCache";
import { ProcgenRockInstancer } from "./ProcgenRockInstancer";
// Plants disabled - not working/looking good yet
// import {
//   setProcgenPlantWorld,
//   addPlantInstance,
//   preWarmPlantCache,
//   BIOME_PLANT_PRESETS,
// } from "./ProcgenPlantCache";
import { ProcgenPlantInstancer } from "./ProcgenPlantInstancer"; // Still needed for cleanup
import { stationDataProvider } from "../../../data/StationDataProvider";
import { resolveFootprint } from "../../../types/game/resource-processing-types";
import {
  MAX_VERTEX_LIGHTS,
  type VertexLight,
  updateTerrainVertexLights,
  createTerrainMaterial,
  TerrainUniforms,
  computeTerrainColorCPU,
  sampleNoiseCPU,
  TERRAIN_SHADER_CONSTANTS,
} from "./TerrainShader";
import { isLamppostLightTextureReady } from "./LamppostLightMask";
import { isCsmEnabled } from "./Environment";
import type { RoadNetworkSystem } from "./RoadNetworkSystem";
import { roadInfluenceOperations } from "./RoadInfluence";
import {
  setRoadInfluenceTextureData,
  clearRoadInfluenceTexture,
} from "./RoadInfluenceMask";
import type { TownSystem } from "./TownSystem";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import {
  TerrainComputeContext,
  isTerrainComputeAvailable,
  type GPURoadSegment,
} from "../../../utils/compute";
import {
  TerrainVisualManager,
  type VisualManagerTerrainProvider,
} from "./TerrainVisualManager";
import { WaterVisualManager } from "./WaterVisualManager";
import {
  GrassVisualManager,
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
  STREAMING_GRASS_VISUAL_PROFILE,
  type GrassWorkerSetup,
} from "./GrassVisualManager";
import { terminateGrassWorkerPool } from "../../../utils/workers/GrassWorker";
import { CompositeQuadTreeListener } from "./TerrainQuadTree";
import type { QuadChunkWorkerConfig } from "../../../utils/workers/QuadChunkWorker";
import { terminateQuadChunkWorkerPool } from "../../../utils/workers/QuadChunkWorker";
import {
  isStreamPageRoute,
  isStreamingLikeViewport,
  resolveExplicitStreamingWorldProfile,
  resolveExplicitStreamingRenderProfile,
  type GrassSurfaceEligibility,
} from "../../../runtime/clientViewportMode";
import {
  hasActiveStreamingPreparationPresentation,
  resolveStreamingPreparationFocus,
  type StreamingPreparationEntity,
} from "../../../runtime/streamingPreparationFocus";

const SERVER_LAUNCH_PREPARATION_AREA_IDS = [
  "central_haven",
  "haven_pond",
  "preparation_training_grounds",
] as const;

// Road influence blending - used for shader's roadInfluence attribute
const ROAD_BLEND_WIDTH = 0.5; // Extra blend distance beyond road width (meters)
const compactTerrainColorOperations = createCompactTerrainColorOperations();
const TERRAIN_ROAD_INFLUENCE_DEBUG =
  process.env.TERRAIN_ROAD_INFLUENCE_DEBUG === "true";
const TERRAIN_TIMING_DEBUG = process.env.TERRAIN_TIMING_DEBUG === "true";
/** Maximum entries retained in pendingSerializationData to prevent unbounded growth */
const MAX_PENDING_SERIALIZATION_ENTRIES = 100;
// The fixed broadcast camera never approaches terrain closely enough to reveal
// the exploration mesh's 64x64 vertices per quad-tree leaf. Halving each axis
// retains the authored height field while cutting terrain triangles and vertex
// work by roughly 75% on the public stream.
/**
 * The arena floor and architecture provide the close-range broadcast detail;
 * quad terrain is only the distant landscape behind that set. A 16-segment
 * grid keeps the silhouette while avoiding hundreds of thousands of off-set
 * terrain triangles in every 1080p stream frame. Exploration retains the
 * authored 64-segment terrain profile.
 */
export const STREAMING_TERRAIN_QUADTREE_RESOLUTION = 16;

// Lamppost vertex lighting (terrain-only, GPU shader accumulation)
const LAMP_VERTEX_LIGHT_RANGE = 12;
const LAMP_VERTEX_LIGHT_INTENSITY = 0.8;
const LAMP_VERTEX_LIGHT_COLOR = new THREE.Color(1.0, 0.9, 0.6);
const LAMP_LIGHT_UPDATE_INTERVAL_SEC = 0.4;
const LAMP_LIGHT_SEARCH_RANGE = 45;

interface BiomeCenter {
  x: number;
  z: number;
  type: string;
  influence: number;
}

type DifficultySample = {
  level: number;
  scalar: number;
  biome: string;
  difficultyTier: number;
  isSafe: boolean;
};

type BossHotspot = {
  id: string;
  x: number;
  z: number;
  radius: number;
  minLevel: number;
  maxLevel: number;
  seed: number;
};

export class TerrainSystem extends System {
  private terrainTiles = new Map<string, TerrainTile>();
  private terrainContainer!: THREE.Group;

  // Flat zones for terrain flattening under stations
  private flatZones = new Map<string, FlatZone>();
  private flatZonesByTile = new Map<string, FlatZone[]>(); // Spatial index by terrain tile
  private _flatZoneChecked = new Set<string>(); // PERF: reusable dedup set for flat zone queries
  private readonly authoredSurface = createAuthoredTerrainSurfaceOperations();
  private readonly authoredSurfaceCandidates: FlatZone[] = [];
  private _pendingTileRegeneration = new Set<string>(); // Tracks tiles being regenerated to avoid duplicates
  private _queuedTileRegenerations = new Map<
    string,
    { x: number; z: number; reason: "flat_zone" | "road" | "other" }
  >();
  private _tileRegenerationFlushId?: ReturnType<typeof setTimeout>;
  public instancedMeshManager!: InstancedMeshManager;
  private _terrainInitialized = false;
  private _initialTilesReady = false; // Track when initial tiles are loaded
  private destroyed = false;
  private roadInfluenceRefreshGeneration = 0;
  private lastPlayerTile = { x: 0, z: 0 };
  private updateTimer = 0;
  private terrainTime = 0; // For animated caustics
  private noise!: NoiseGenerator;
  private biomeNoiseSets: Record<string, BiomeNoiseSet> = {};
  private _loggedWorkerTileBiome = 0;
  private _loggedSyncTileBiome = 0;
  private databaseSystem!: {
    saveWorldChunk(chunkData: WorldChunkData): void;
  }; // DatabaseSystem reference

  // Terrain shader material (shared across all tiles)
  // On client: full material with terrainUniforms for visual rendering
  // On server: basic placeholder material (no uniforms needed)
  private terrainMaterial?:
    | THREE.Material
    | (THREE.Material & {
        terrainUniforms: TerrainUniforms;
      });
  private chunkSaveInterval?: NodeJS.Timeout;
  private terrainUpdateIntervalId?: NodeJS.Timeout;
  private serializationIntervalId?: NodeJS.Timeout;
  private boundingBoxIntervalId?: NodeJS.Timeout;
  private activeChunks = new Set<string>();

  private coreChunkRange = 2; // 9 core chunks (5x5 grid)
  private ringChunkRange = 3; // Additional ring around core chunks
  private terrainOnlyChunkRange = 5; // Furthest ring with only terrain geometry
  private unloadPadding = 1; // Hysteresis padding for unloading beyond ring range
  private playerChunks = new Map<string, Set<string>>(); // player -> chunk keys
  private simulatedChunks = new Set<string>(); // chunks with active simulation
  private isGenerating = false; // Track if terrain generation is in progress
  private chunkPlayerCounts = new Map<string, number>(); // chunk -> player count
  // Smooth generation queue to avoid main-thread spikes when player moves
  private pendingTileKeys: string[] = [];
  private pendingTileSet = new Set<string>();
  /** Preserve full-content versus geometry-only intent while a tile is queued. */
  private pendingTileContent = new Map<string, boolean>();
  /** Geometry-only residents entering the core; ownership is the exact tile, not its key. */
  private pendingContentPromotions = new Map<string, TerrainTile>();
  private pendingTileGenerations = new Map<string, object>();
  private workerBatchLease: object | null = null;
  private pendingCollisionKeys: string[] = [];
  private pendingCollisionSet = new Set<string>();
  // Deferred walkability baking queue — spreads 10,000 iterations across ticks
  private pendingWalkabilityTiles: Array<{ tileX: number; tileZ: number }> = [];
  private walkabilityProgress: {
    tileX: number;
    tileZ: number;
    nextRow: number;
  } | null = null;
  private maxTilesPerFrame = 2; // cap tiles generated per frame
  private generationBudgetMsPerFrame = 6; // time budget per frame (ms)
  // Pending resource instance creation (deferred to spread across frames)
  // Uses index-based dequeue to avoid O(n) shift() operations
  private pendingResourceInstances: Array<{
    tile: TerrainTile;
    resourceIndex: number;
  }> = [];
  private pendingResourceHead = 0; // Index of next item to process
  private maxResourceInstancesPerFrame = 10; // Process 10 resource instances per frame
  private _tempVec3 = new THREE.Vector3();
  private _tempVec3_2 = new THREE.Vector3();
  private _tempVec2 = new THREE.Vector2();
  private _tempVec2_2 = new THREE.Vector2();
  private _tempVec2_3 = new THREE.Vector2(); // For road distance calculations
  private _tempBox3 = new THREE.Box3();
  private _spectatorFocusPos = new THREE.Vector3();
  private _streamingPreparationFocusPos = new THREE.Vector3();
  private _hasStreamingArenaFocus = false;
  private lamppostLightUpdateTimer = 0;
  private lamppostActiveLights: VertexLight[] = [];
  private lamppostLightIndices: number[] = [];
  private lamppostLightDistances: number[] = [];
  private waterSystem?: WaterSystem;
  private waterBodyRegistry!: WaterBodyRegistry;
  private roadNetworkSystem?: RoadNetworkSystem;
  private roadEventsSubscribed = false;
  private _cachedRoadTileX = Number.NaN;
  private _cachedRoadTileZ = Number.NaN;
  private _cachedRoadSegments: ReadonlyArray<RoadTileSegment> = [];
  private townSystem: TownSystem | null = null;
  private bossHotspots: BossHotspot[] = [];

  // GPU compute context for accelerated terrain operations
  private terrainComputeContext: TerrainComputeContext | null = null;
  private gpuComputeAvailable = false;

  // Quad-tree LOD visual manager (client-only, when CONFIG.USE_QUADTREE_LOD is true)
  private quadTreeVisualManager: TerrainVisualManager | null = null;
  private waterVisualManager: WaterVisualManager | null = null;
  private compactPondDressing: CompactPondDressingVisuals | null = null;
  private compactPondMaterial: CompactTerrainPond | null = null;
  private compactMacroMaterial: CompactTerrainMacroField | null | undefined;
  private grassVisualManager: GrassVisualManager | null = null;

  // Unified terrain generator from @hyperforge/procgen
  // Provides deterministic height/biome calculation independent of rendering
  private biomeSystem!: BiomeSystem;

  // PERFORMANCE: Template geometry and pre-allocated buffers for tile creation
  private templateGeometry: THREE.PlaneGeometry | null = null;
  private templateColors: Float32Array | null = null;
  private templateBiomeIds: Float32Array | null = null;
  // PERFORMANCE: Low-res collision template (SERVER_COLLISION_RESOLUTION) for PhysX baking
  private serverCollisionTemplate: THREE.PlaneGeometry | null = null;
  // PERFORMANCE: Pre-allocated overflow height grid for normal computation
  // Size = (TILE_RESOLUTION + 2)^2 — one extra row/column on each side for centered differences
  private _overflowHeightGrid: Float32Array | null = null;

  // Serialization system
  private lastSerializationTime = 0;
  private serializationInterval = 15 * 60 * 1000; // 15 minutes in milliseconds
  private worldStateVersion = 1;
  private pendingSerializationData = new Map<
    string,
    {
      key: string;
      tileX: number;
      tileZ: number;
      biome: string;
      heightData?: number[];
      resourceStates: Array<{
        id: string;
        type: string;
        position: [number, number, number];
      }>;
      roadData: Array<{
        start: [number, number];
        end: [number, number];
        width: number;
      }>;
      playerCount: number;
      lastActiveTime?: Date;
      isSimulated: boolean;
      worldStateVersion: number;
      timestamp: number;
    }
  >();

  // Bounding box verification
  private worldBounds = {
    minX: -1000,
    maxX: 1000,
    minZ: -1000,
    maxZ: 1000,
    minY: -50,
    maxY: 100,
  };
  private terrainBoundingBoxes = new Map<string, THREE.Box3>();
  tileSize: number = 0;
  private runtimeIsServer = false;
  private runtimeIsClient = false;
  private readonly serverMeshCollisionEnabled = (() => {
    if (typeof process === "undefined") return false;
    const raw = process.env.TERRAIN_SERVER_MESH_COLLISION_ENABLED;
    if (raw != null && raw !== "") {
      return raw === "true";
    }
    return process.env.NODE_ENV === "production";
  })();

  private activeTerrainProfile: WorldTerrainProfile | null = null;

  /** Capture once: an existing world must never silently switch terrain profiles. */
  public getWorldTerrainProfile(): WorldTerrainProfile {
    if (!this.activeTerrainProfile) {
      const profile = DataManager.getWorldTerrainProfile();
      const config = DataManager.getWorldConfig();
      if (!config)
        throw new Error("Terrain requires loaded world configuration");
      this.CONFIG.TILE_SIZE = profile.terrainTileSize;
      this.CONFIG.WORLD_SIZE =
        (profile.bounds.maxX - profile.bounds.minX) / profile.terrainTileSize;
      this.CONFIG.TILE_RESOLUTION = config.terrain.tileResolution;
      this.CONFIG.QUADTREE_RESOLUTION = config.terrain.tileResolution;
      this.CONFIG.QUADTREE_MIN_SIZE = profile.terrainTileSize;
      this.CONFIG.WATER_THRESHOLD = profile.water.threshold;
      this.CONFIG.ISLAND_MAX_WORLD_SIZE_TILES = this.CONFIG.WORLD_SIZE;
      this.CONFIG.ISLAND_FALLOFF_TILES =
        profile.island.falloff / profile.terrainTileSize;
      this.tileSize = profile.terrainTileSize;
      this.activeTerrainProfile = profile;
    }
    return this.activeTerrainProfile;
  }

  private get maxHeightParameter(): number {
    return this.getWorldTerrainProfile().height.maxHeightParameter;
  }

  private get waterLevelNormalized(): number {
    const profile = this.getWorldTerrainProfile();
    return profile.water.threshold / profile.height.maxHeightParameter;
  }

  private get shorelineParameters(): WorldTerrainProfile["shoreline"] {
    return this.getWorldTerrainProfile().shoreline;
  }

  // Explicit overrides may confirm the manifest, never select a different seed.
  private computeSeedFromWorldId(): number {
    const seed = this.getWorldTerrainProfile().seed;
    const worldConfig = (this.world as { config?: { terrainSeed?: number } })
      .config;
    if (
      worldConfig?.terrainSeed !== undefined &&
      worldConfig.terrainSeed !== seed
    ) {
      throw new Error(
        "World terrainSeed conflicts with admitted terrain profile",
      );
    }
    if (typeof process !== "undefined") {
      const raw = process.env?.TERRAIN_SEED;
      if (
        raw !== undefined &&
        raw !== "" &&
        (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) !== seed)
      ) {
        throw new Error("TERRAIN_SEED conflicts with admitted terrain profile");
      }
    }
    return seed;
  }

  private resolveRuntimeRole(): { isServer: boolean; isClient: boolean } {
    const hasWindow = typeof window !== "undefined";
    const isNodeOrBunRuntime =
      typeof process !== "undefined" &&
      !!process.versions &&
      (typeof process.versions.node === "string" ||
        typeof (process.versions as { bun?: string }).bun === "string");
    const networkIsServer = this.world.network?.isServer === true;
    const networkIsClient = this.world.network?.isClient === true;

    const isServer = networkIsServer || (!hasWindow && isNodeOrBunRuntime);
    const isClient = !isServer && (networkIsClient || hasWindow);
    return { isServer, isClient };
  }

  private getActiveWorldSizeTiles(): number {
    const profile = this.getWorldTerrainProfile();
    return (
      (profile.bounds.maxX - profile.bounds.minX) / profile.terrainTileSize
    );
  }

  private getActiveWorldSizeMeters(): number {
    return this.getActiveWorldSizeTiles() * this.CONFIG.TILE_SIZE;
  }

  /**
   * Load terrain textures and create the shared terrain material.
   * Compact terrain uses six channel-packed PBR maps; legacy defaults are kept.
   *
   * This material includes road influence support via the roadInfluence vertex attribute.
   * No fallback material - roads require the full shader to render correctly.
   */
  private initTerrainMaterial(): void {
    const profile = this.getWorldTerrainProfile();
    const material = createTerrainMaterial(undefined, {
      compactPbr: isCompactSculptProfile(profile),
      compactPond: this.getCompactPondMaterial(),
      compactProfile: profile,
    });
    // The generator initializes before this client-only material exists. Apply
    // profile-owned options here so the actual published material is configured
    // before shadow setup or any terrain mesh can consume it.
    material.terrainUniforms.surfaceDetailStrength.value =
      isCompactSculptProfile(profile) ? 1 : 0;
    this.terrainMaterial = material;

    // Setup for CSM shadows
    if (this.world.setupMaterial) {
      this.world.setupMaterial(this.terrainMaterial);
    }

    console.log(
      "[TerrainSystem] Terrain material created with road influence support",
    );
  }

  private getCompactPondMaterial(): CompactTerrainPond | null {
    if (!isCompactSculptProfile(this.getWorldTerrainProfile())) return null;
    if (this.compactPondMaterial) return this.compactPondMaterial;
    const ponds = ALL_WORLD_AREAS.haven_pond?.waterBodies;
    if (ponds?.length !== 1 || ponds[0].id !== "haven_pond_water")
      throw new Error(
        "Compact terrain requires the single admitted Haven pond",
      );
    this.compactPondMaterial = compactTerrainColorOperations.validatePond(
      ponds[0],
    );
    return this.compactPondMaterial;
  }

  /** Restart-owned colour field; never changes terrain height or grass ecology. */
  private getCompactMacroMaterial(): CompactTerrainMacroField | null {
    if (this.compactMacroMaterial === undefined)
      this.compactMacroMaterial = compactTerrainColorOperations.macroField(
        this.getWorldTerrainProfile(),
      );
    return this.compactMacroMaterial;
  }

  /**
   * Get the terrain material.
   * On client: returns the full terrain shader material (must call initTerrainMaterial() first).
   * On server: returns a basic placeholder material since server doesn't render visuals.
   */
  private getTerrainMaterial(): THREE.Material {
    if (!this.terrainMaterial) {
      // Server doesn't need visual materials - just a placeholder for mesh creation
      // Road data is stored in geometry attributes, not in the material
      if (!this.runtimeIsClient) {
        this.terrainMaterial = new THREE.MeshBasicMaterial({ color: 0x808080 });
        return this.terrainMaterial;
      }
      throw new Error(
        "[TerrainSystem] Terrain material not initialized. " +
          "initTerrainMaterial() must be called before creating terrain tiles.",
      );
    }
    return this.terrainMaterial;
  }

  /**
   * Get the terrain material with uniforms for external access (e.g., minimap fog control)
   * Returns null on server since server uses a basic material without uniforms.
   */
  public getTerrainMaterialWithUniforms(): ReturnType<
    typeof createTerrainMaterial
  > | null {
    if (!this.terrainMaterial) return null;
    // Check if material has terrainUniforms (client-only)
    if ("terrainUniforms" in this.terrainMaterial) {
      return this.terrainMaterial as ReturnType<typeof createTerrainMaterial>;
    }
    return null;
  }

  /**
   * Create a deterministic PRNG for a given tile and salt.
   * Ensures identical resource placement across clients and worlds for the same seed.
   */
  private createTileRng(
    tileX: number,
    tileZ: number,
    salt: string,
  ): () => number {
    // Mix world seed, tile coords, and salt into a 32-bit state
    const baseSeed = this.computeSeedFromWorldId() >>> 0;
    // Simple string hash (djb2 variant) for salt
    let saltHash = 5381 >>> 0;
    for (let i = 0; i < salt.length; i++) {
      saltHash = (((saltHash << 5) + saltHash) ^ salt.charCodeAt(i)) >>> 0;
    }
    let state =
      (baseSeed ^
        ((tileX * 73856093) >>> 0) ^
        ((tileZ * 19349663) >>> 0) ^
        saltHash) >>>
      0;

    return () => {
      // LCG parameters (Numerical Recipes)
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 0xffffffff;
    };
  }

  public createDeterministicRng(
    tileX: number,
    tileZ: number,
    salt: string,
  ): () => number {
    return this.createTileRng(tileX, tileZ, salt);
  }

  /**
   * Queue a tile for generation if not already queued or present
   */
  private enqueueTileForGeneration(
    tileX: number,
    tileZ: number,
    generateContent = true,
  ): void {
    if (this.destroyed) return;
    const key = `${tileX}_${tileZ}`;
    const resident = this.terrainTiles.get(key);
    if (resident) {
      if (generateContent && resident.contentGenerated === false)
        this.pendingContentPromotions.set(key, resident);
      return;
    }
    if (this.pendingTileSet.has(key)) {
      // A core/ring request upgrades an earlier horizon-only request.
      if (generateContent) this.pendingTileContent.set(key, true);
      return;
    }
    this.pendingTileSet.add(key);
    this.pendingTileGenerations.set(key, {});
    this.pendingTileKeys.push(key);
    this.pendingTileContent.set(key, generateContent);

    this.queueTileForWorker(tileX, tileZ);
  }

  /** Tiles waiting to be sent to workers for pre-computation */
  private pendingWorkerTiles: Array<{ tileX: number; tileZ: number }> = [];
  /** Tiles queued for or currently executing in a worker. */
  private pendingWorkerTileKeys = new Set<string>();
  /** Tiles whose worker job failed or could not start and may use sync fallback. */
  private workerFallbackTileKeys = new Set<string>();

  private queueTileForWorker(tileX: number, tileZ: number): void {
    const key = `${tileX}_${tileZ}`;
    if (
      !this.runtimeIsClient ||
      !this.CONFIG.USE_WORKERS ||
      this.terrainTiles.has(key) ||
      this.pendingWorkerResults.has(key) ||
      this.pendingWorkerTileKeys.has(key)
    ) {
      return;
    }

    this.pendingWorkerTileKeys.add(key);
    this.workerFallbackTileKeys.delete(key);
    this.pendingWorkerTiles.push({ tileX, tileZ });
  }

  /**
   * Public API: Request prefetch of a tile for speculative loading.
   * Used by VegetationSystem to pre-generate tiles in the direction of player movement.
   * This queues the tile for generation at low priority (after immediate tiles).
   *
   * @param tileX - Tile X coordinate
   * @param tileZ - Tile Z coordinate
   */
  prefetchTile(tileX: number, tileZ: number): void {
    const key = `${tileX}_${tileZ}`;

    if (this.terrainTiles.has(key) || this.pendingTileSet.has(key)) {
      return;
    }

    // Enqueue once for worker pre-computation and main-thread assembly.
    this.enqueueTileForGeneration(tileX, tileZ, true);
  }

  /**
   * Process queued tile generations within per-frame time and count budgets
   * Prefers using pre-computed worker data when available
   */
  private processTileGenerationQueue(): void {
    if (this.destroyed) return;
    if (
      this.pendingTileKeys.length === 0 &&
      this.pendingContentPromotions.size === 0
    )
      return;
    const nowFn =
      typeof performance !== "undefined" && performance.now
        ? () => performance.now()
        : () => Date.now();
    const start = nowFn();
    let generated = 0;
    // Promotions share the geometry queue's existing per-frame work budget.
    // They do not rebuild terrain, collision, or any previously generated content.
    for (const [key, tile] of this.pendingContentPromotions) {
      if (this.destroyed) return;
      if (
        generated >= this.maxTilesPerFrame ||
        nowFn() - start > this.generationBudgetMsPerFrame
      )
        break;
      this.pendingContentPromotions.delete(key);
      if (this.promoteTileContent(tile)) generated++;
    }
    // Inspect each entry at most once per frame. Worker-backed entries rotate
    // to the tail until their result or an explicit fallback arrives.
    const inspectionLimit = this.pendingTileKeys.length;
    let inspected = 0;
    while (this.pendingTileKeys.length > 0 && inspected < inspectionLimit) {
      if (this.destroyed) return;
      if (generated >= this.maxTilesPerFrame) break;
      if (nowFn() - start > this.generationBudgetMsPerFrame) break;
      const key = this.pendingTileKeys.shift()!;
      inspected++;

      const workerData = this.pendingWorkerResults.get(key);
      const waitingForWorker =
        this.runtimeIsClient &&
        this.CONFIG.USE_WORKERS &&
        this.pendingWorkerTileKeys.has(key) &&
        !this.workerFallbackTileKeys.has(key) &&
        !workerData;
      if (waitingForWorker) {
        this.pendingTileKeys.push(key);
        continue;
      }

      this.pendingTileSet.delete(key);
      const generateContent = this.pendingTileContent.get(key) ?? true;
      this.pendingTileContent.delete(key);
      this.pendingTileGenerations.delete(key);
      const [x, z] = key.split("_").map(Number);

      // Check if we have pre-computed worker data for this tile
      const _tStart = performance.now();
      if (workerData) {
        const geometry = this.createTileGeometryFromWorkerData(workerData);
        this.createTileFromGeometryWithResources(
          x,
          z,
          geometry,
          generateContent,
        );
        this.pendingWorkerResults.delete(key);
        if (TERRAIN_TIMING_DEBUG) {
          console.debug(
            `[TerrainTiming] worker tile ${key}: ${(performance.now() - _tStart).toFixed(1)}ms`,
          );
        }
      } else {
        this.generateTile(x, z, generateContent);
        if (TERRAIN_TIMING_DEBUG) {
          console.debug(
            `[TerrainTiming] sync tile ${key}: ${(performance.now() - _tStart).toFixed(1)}ms`,
          );
        }
      }
      this.pendingWorkerTileKeys.delete(key);
      this.workerFallbackTileKeys.delete(key);
      generated++;
    }
  }

  /**
   * Drop queued terrain work that no active terrain center still needs.
   * Duel teleports can invalidate hundreds of queued tiles before generation;
   * retaining them makes the server generate, populate, and immediately unload
   * obsolete world regions for minutes after the camera has moved on.
   */
  private prunePendingTileQueue(
    neededTiles: ReadonlySet<string>,
    contentTiles: ReadonlySet<string> = neededTiles,
  ): void {
    for (const [key, tile] of this.pendingContentPromotions) {
      if (!contentTiles.has(key) || this.terrainTiles.get(key) !== tile)
        this.pendingContentPromotions.delete(key);
    }
    if (this.pendingTileKeys.length === 0) return;

    const retainedKeys: string[] = [];
    for (const key of this.pendingTileKeys) {
      if (neededTiles.has(key)) {
        // A pending worker computes geometry only. Its current content intent
        // must follow the latest core, not the center that dispatched it.
        this.pendingTileContent.set(key, contentTiles.has(key));
        retainedKeys.push(key);
        continue;
      }
      this.pendingTileSet.delete(key);
      this.pendingTileContent.delete(key);
      this.pendingTileGenerations.delete(key);
      this.pendingWorkerResults.delete(key);
      this.pendingWorkerTileKeys.delete(key);
      this.workerFallbackTileKeys.delete(key);
    }
    this.pendingTileKeys = retainedKeys;

    if (this.pendingWorkerTiles.length > 0) {
      this.pendingWorkerTiles = this.pendingWorkerTiles.filter((tile) =>
        neededTiles.has(`${tile.tileX}_${tile.tileZ}`),
      );
    }
  }

  /**
   * Dispatch pending tiles to workers for pre-computation
   * Called each frame to keep workers busy
   */
  private dispatchWorkerBatch(): void {
    if (
      this.pendingWorkerTiles.length === 0 ||
      this.workerBatchInProgress ||
      !this.CONFIG.USE_WORKERS
    ) {
      return;
    }

    // Take a batch of tiles to process
    const batchSize = Math.min(this.pendingWorkerTiles.length, 9); // Up to 9 tiles (3x3)
    const batch = this.pendingWorkerTiles.splice(0, batchSize);

    // Filter out tiles that already have results
    const tilesToProcess = batch.filter(
      (t) => !this.pendingWorkerResults.has(`${t.tileX}_${t.tileZ}`),
    );

    if (tilesToProcess.length === 0) {
      return;
    }

    // Fire and forget - don't await, let it run in background
    this.precomputeTilesWithWorker(tilesToProcess).catch((err) => {
      console.warn("[TerrainSystem] Worker batch error:", err);
    });
  }

  private processCollisionGenerationQueue(): void {
    if (!this.serverMeshCollisionEnabled) return;
    if (this.pendingCollisionKeys.length === 0 || !this.world.network?.isServer)
      return;

    // Time-budgeted: process multiple collision meshes per tick (up to 8ms)
    const budgetMs = 8;
    const t0 = performance.now();

    while (this.pendingCollisionKeys.length > 0) {
      if (performance.now() - t0 > budgetMs) break;

      const key = this.pendingCollisionKeys.shift()!;
      this.pendingCollisionSet.delete(key);

      const tile = this.terrainTiles.get(key);
      if (!tile || tile.collision) continue;

      const geometry = this.buildServerCollisionGeometry(tile.x, tile.z);

      const meshHandle = geometryToPxMesh(this.world, geometry, false);
      if (meshHandle) {
        tile.collision = meshHandle;
      }

      geometry.dispose();
    }
  }

  /**
   * Build a low-resolution collision geometry for PhysX triangle mesh cooking.
   * Uses SERVER_COLLISION_RESOLUTION (16×16) instead of full TILE_RESOLUTION (64×64)
   * to reduce triangle count from ~8192 to ~512, giving ~16x faster PhysX cooking.
   */
  private buildServerCollisionGeometry(
    tileX: number,
    tileZ: number,
  ): THREE.PlaneGeometry {
    if (!this.serverCollisionTemplate) {
      this.serverCollisionTemplate = new THREE.PlaneGeometry(
        this.CONFIG.TILE_SIZE,
        this.CONFIG.TILE_SIZE,
        this.CONFIG.SERVER_COLLISION_RESOLUTION - 1,
        this.CONFIG.SERVER_COLLISION_RESOLUTION - 1,
      );
      this.serverCollisionTemplate.rotateX(-Math.PI / 2);
    }

    const geometry = this.serverCollisionTemplate.clone();
    const positions = geometry.attributes.position;
    const posArray = positions.array as Float32Array;

    const originX = tileX * this.CONFIG.TILE_SIZE;
    const originZ = tileZ * this.CONFIG.TILE_SIZE;

    for (let i = 0; i < positions.count; i++) {
      const i3 = i * 3;
      const worldX = posArray[i3] + originX;
      const worldZ = posArray[i3 + 2] + originZ;
      posArray[i3 + 1] = this.getHeightAtComputed(worldX, worldZ);
    }

    // Translate to world position (collision mesh needs absolute coords)
    geometry.translate(originX, 0, originZ);

    return geometry;
  }

  /**
   * Process pending resource instance creation queue.
   * Spreads instance creation across frames to prevent hitches.
   * Uses index-based dequeue to avoid O(n) shift() operations.
   */
  private processResourceInstanceQueue(): void {
    const queueLength = this.pendingResourceInstances.length;
    if (this.pendingResourceHead >= queueLength) {
      // Queue exhausted - reset for next batch
      if (queueLength > 0) {
        this.pendingResourceInstances.length = 0;
        this.pendingResourceHead = 0;
      }
      return;
    }

    let processed = 0;
    while (
      this.pendingResourceHead < queueLength &&
      processed < this.maxResourceInstancesPerFrame
    ) {
      const item = this.pendingResourceInstances[this.pendingResourceHead++];
      const { tile, resourceIndex } = item;

      // Tile may have been unloaded
      if (!this.terrainTiles.has(tile.key)) continue;
      if (resourceIndex >= tile.resources.length) continue;

      const resource = tile.resources[resourceIndex];
      if (resource.instanceId != null) continue;

      // Skip tree types - they're rendered by ProcgenTreeInstancer with proper models
      // (the InstancedMeshManager only creates placeholder green boxes for trees)
      if (resource.type === "tree") continue;

      // Create the instance
      this._tempVec3.set(
        tile.x * this.CONFIG.TILE_SIZE + resource.position.x,
        resource.position.y,
        tile.z * this.CONFIG.TILE_SIZE + resource.position.z,
      );

      const instanceId = this.instancedMeshManager.addInstance(
        resource.type,
        resource.id,
        this._tempVec3,
      );

      if (instanceId !== null) {
        resource.instanceId = instanceId;
        resource.meshType = resource.type;

        // Emit resource created event
        this.world.emit(EventType.RESOURCE_MESH_CREATED, {
          mesh: undefined,
          instanceId: instanceId,
          resourceId: resource.id,
          resourceType: resource.type === "ore" ? "mining_rock" : resource.type,
          worldPosition: {
            x: this._tempVec3.x,
            y: this._tempVec3.y,
            z: this._tempVec3.z,
          },
        });
      }

      processed++;
    }
  }

  /**
   * Queue resource instances for deferred creation.
   * Called by generateTile/createTileFromGeometryWithResources.
   */
  private queueResourceInstances(tile: TerrainTile): void {
    for (let i = 0; i < tile.resources.length; i++) {
      const resource = tile.resources[i];
      if (resource.instanceId != null) continue;
      this.pendingResourceInstances.push({ tile, resourceIndex: i });
    }
  }

  /** Shared sync/worker/promotion content path. Geometry and collision are untouched. */
  private generateTileContent(tile: TerrainTile): void {
    if (tile.contentGenerated === true) return;
    const isServer =
      this.runtimeIsServer || this.world.network?.isServer === true;
    if (isServer || this.runtimeIsClient) this.generateTileResources(tile);
    if (this.runtimeIsClient) {
      this.generateVisualFeatures(tile);
      if (!this.CONFIG.USE_QUADTREE_LOD) this.generateWaterMeshes(tile);
      if (tile.resources.length > 0) this.queueResourceInstances(tile);
    }
    // Publish once, including empty full-content batches. Re-entrant requests
    // cannot initialize resource state again after an event listener runs.
    tile.contentGenerated = true;
  }

  private emitTileGenerated(tile: TerrainTile): void {
    if (this.destroyed || this.terrainTiles.get(tile.key) !== tile) return;
    const originX = tile.x * this.CONFIG.TILE_SIZE;
    const originZ = tile.z * this.CONFIG.TILE_SIZE;
    const spawnPoints = tile.resources.map(
      (resource): TerrainResourceSpawnPoint => ({
        id: resource.id,
        type: resource.type,
        subType:
          resource.subType ?? (resource.type === "tree" ? "normal" : undefined),
        position: {
          x: originX + resource.position.x,
          y: resource.position.y,
          z: originZ + resource.position.z,
        },
        scale: resource.scale,
        rotation: resource.rotation,
      }),
    );
    this.world.emit(EventType.TERRAIN_TILE_GENERATED, {
      tileId: `${tile.x},${tile.z}`,
      position: { x: originX, z: originZ },
      tileX: tile.x,
      tileZ: tile.z,
      biome: (tile.biome as BiomeType) || DEFAULT_BIOME,
      contentGenerated: tile.contentGenerated === true,
      resources: spawnPoints.map(({ id, type, position }) => ({
        id: id!,
        type,
        position,
      })),
    });
    // A synchronous tile listener can unload/destroy the owner. Never publish a
    // resource batch after its corresponding unload event has already retired it.
    if (
      !this.destroyed &&
      this.terrainTiles.get(tile.key) === tile &&
      tile.contentGenerated === true &&
      (this.runtimeIsServer ||
        this.runtimeIsClient ||
        this.world.network?.isServer)
    )
      this.world.emit(EventType.RESOURCE_SPAWN_POINTS_REGISTERED, {
        owner: { tileX: tile.x, tileZ: tile.z },
        spawnPoints,
      });
  }

  private promoteTileContent(tile: TerrainTile): boolean {
    if (
      this.destroyed ||
      this.terrainTiles.get(tile.key) !== tile ||
      tile.contentGenerated !== false
    )
      return false;
    this.generateTileContent(tile);
    this.emitTileGenerated(tile);
    return true;
  }

  /**
   * Pre-compute terrain data for multiple tiles using web workers
   *
   * This offloads the heavy noise/heightmap calculations to worker threads,
   * allowing parallel processing across CPU cores while keeping the main thread
   * free for rendering and input handling.
   *
   * @param tiles - Array of tile coordinates to pre-compute
   * @returns Promise that resolves when all tiles are computed
   */
  async precomputeTilesWithWorker(
    tiles: Array<{ tileX: number; tileZ: number }>,
  ): Promise<void> {
    // Workers only available on client and when enabled
    if (!this.runtimeIsClient || !this.CONFIG.USE_WORKERS) {
      return;
    }

    if (this.workerBatchInProgress) {
      return;
    }

    // Filter out tiles that are already computed or have pending results
    const tilesToProcess = tiles.filter((t) => {
      const key = `${t.tileX}_${t.tileZ}`;
      return !this.terrainTiles.has(key) && !this.pendingWorkerResults.has(key);
    });

    if (tilesToProcess.length === 0) {
      return;
    }

    this.workerBatchInProgress = true;
    const batchLease = {};
    this.workerBatchLease = batchLease;
    const generations = new Map(
      tilesToProcess.map(({ tileX, tileZ }) => {
        const key = `${tileX}_${tileZ}`;
        return [key, this.pendingTileGenerations.get(key)] as const;
      }),
    );
    const isCurrent = (key: string) =>
      this.isCurrentTileRequest(key, generations.get(key));

    try {
      // Build worker config from current CONFIG
      // MUST match TerrainWorkerConfig interface exactly
      const workerConfig: TerrainWorkerConfig = createTerrainWorkerConfig(
        this.getWorldTerrainProfile(),
        this.CONFIG.TILE_RESOLUTION,
      );

      // Build simplified biome data for worker
      const biomeData: Record<
        string,
        { heightModifier: number; color: { r: number; g: number; b: number } }
      > = {};
      for (const [name, biome] of Object.entries(BIOMES)) {
        const color = new THREE.Color(biome.color);
        biomeData[name] = {
          // Use terrainMultiplier from BiomeData as heightModifier for worker
          heightModifier: biome.terrainMultiplier || 1,
          color: { r: color.r, g: color.g, b: color.b },
        };
      }

      // Generate terrain data in parallel using workers
      const batchResult = await generateTerrainTilesBatch(
        tilesToProcess,
        workerConfig,
        this.computeSeedFromWorldId(),
        this.biomeSystem.getBiomeCenters() as BiomeCenter[],
        biomeData,
      );
      if (this.destroyed) return;

      // Only an explicit worker failure permits synchronous fallback. Normal
      // in-flight work remains queued without blocking the render thread.
      if (!batchResult.workersAvailable) {
        console.warn(
          "[TerrainSystem] Workers not available, tiles will use synchronous generation",
        );
        for (const tile of tilesToProcess) {
          const key = `${tile.tileX}_${tile.tileZ}`;
          if (!isCurrent(key)) continue;
          this.pendingWorkerTileKeys.delete(key);
          this.workerFallbackTileKeys.add(key);
        }
        return;
      }

      // Check if any tiles failed
      if (batchResult.failedCount > 0) {
        console.warn(
          `[TerrainSystem] ${batchResult.failedCount} tiles failed in worker, will retry synchronously`,
        );
      }

      // Store successful results for later geometry creation
      for (const result of batchResult.results) {
        this.acceptTerrainWorkerResult(result, generations.get(result.tileKey));
      }

      if (batchResult.failedCount > 0) {
        const completedKeys = new Set(
          batchResult.results.map((result) => result.tileKey),
        );
        for (const tile of tilesToProcess) {
          const key = `${tile.tileX}_${tile.tileZ}`;
          if (!isCurrent(key)) continue;
          if (completedKeys.has(key)) continue;
          this.pendingWorkerTileKeys.delete(key);
          this.workerFallbackTileKeys.add(key);
        }
      }
    } catch (error) {
      if (this.destroyed) return;
      console.error("[TerrainSystem] Worker batch failed:", error);
      for (const tile of tilesToProcess) {
        const key = `${tile.tileX}_${tile.tileZ}`;
        if (!isCurrent(key)) continue;
        this.pendingWorkerTileKeys.delete(key);
        this.workerFallbackTileKeys.add(key);
      }
    } finally {
      if (this.workerBatchLease === batchLease) {
        this.workerBatchLease = null;
        this.workerBatchInProgress = false;
      }
    }
  }

  private isCurrentTileRequest(
    key: string,
    generation: object | undefined,
  ): boolean {
    return (
      !this.destroyed &&
      generation !== undefined &&
      this.pendingTileGenerations.get(key) === generation &&
      this.pendingTileSet.has(key)
    );
  }

  private acceptTerrainWorkerResult(
    result: TerrainWorkerOutput,
    generation: object | undefined,
  ): void {
    if (!this.isCurrentTileRequest(result.tileKey, generation)) return;
    this.pendingWorkerTileKeys.delete(result.tileKey);
    if (!this.terrainTiles.has(result.tileKey))
      this.pendingWorkerResults.set(result.tileKey, result);
  }

  /**
   * Create tile geometry from pre-computed worker data.
   *
   * Worker now computes heights (with shoreline) and normals (from overflow
   * grid). For tiles WITHOUT flat zones we use worker data directly, avoiding
   * all main-thread noise evaluation. When flat zones overlap the tile we fall
   * back to main-thread height + normal recomputation so flat zone heights are
   * respected.
   */
  private createTileGeometryFromWorkerData(
    workerData: TerrainWorkerOutput,
  ): THREE.PlaneGeometry {
    const { tileX, tileZ, colorData, biomeData, normalData } = workerData;

    const template = this.getOrCreateTemplateGeometry();
    const geometry = template.clone();

    const positions = geometry.attributes.position;
    const roadInfluences = new Float32Array(positions.count);
    const forestWeights = new Float32Array(positions.count);
    const canyonWeights = new Float32Array(positions.count);

    const tileKey = `${tileX}_${tileZ}`;
    const hasFlatZones = (this.flatZonesByTile.get(tileKey)?.length ?? 0) > 0;

    let heightData: Float32Array;

    if (hasFlatZones) {
      // Flat zones are dynamic (buildings/stations) and not known to the
      // worker. Recompute all heights on the main thread so flat zone
      // overrides are applied, then derive normals via the overflow grid.
      heightData = new Float32Array(positions.count);
      for (let i = 0; i < positions.count; i++) {
        const localX = positions.getX(i);
        const localZ = positions.getZ(i);
        const worldX = localX + tileX * this.CONFIG.TILE_SIZE;
        const worldZ = localZ + tileZ * this.CONFIG.TILE_SIZE;
        const height = this.getHeightAtComputed(worldX, worldZ);
        positions.setY(i, height);
        heightData[i] = height;
      }
    } else {
      // Use worker heights directly — they now include shoreline adjustment
      // and match the main-thread computation for procedural terrain.
      heightData = workerData.heightData;
      for (let i = 0; i < positions.count; i++) {
        positions.setY(i, heightData[i]);
      }
    }

    // Road influence and biome weights per vertex
    for (let i = 0; i < positions.count; i++) {
      const localX = positions.getX(i);
      const localZ = positions.getZ(i);
      const worldX = localX + tileX * this.CONFIG.TILE_SIZE;
      const worldZ = localZ + tileZ * this.CONFIG.TILE_SIZE;
      roadInfluences[i] = this.calculateRoadInfluenceAtVertex(
        worldX,
        worldZ,
        tileX,
        tileZ,
      );

      const { biomeWeightMap, totalWeight } =
        this.computeBiomeWeightsAtPosition(worldX, worldZ);
      if (totalWeight > 0) {
        const invW = 1 / totalWeight;
        forestWeights[i] = (biomeWeightMap.get(BiomeType.Forest) || 0) * invW;
        canyonWeights[i] = (biomeWeightMap.get(BiomeType.Canyon) || 0) * invW;
      }
    }

    // Set attributes (color attribute removed — shader computes colors procedurally)
    geometry.setAttribute(
      "biomeId",
      new THREE.BufferAttribute(new Float32Array(biomeData), 1),
    );
    geometry.setAttribute(
      "roadInfluence",
      new THREE.BufferAttribute(roadInfluences, 1),
    );
    geometry.setAttribute(
      "biomeForestWeight",
      new THREE.BufferAttribute(forestWeights, 1),
    );
    geometry.setAttribute(
      "biomeCanyonWeight",
      new THREE.BufferAttribute(canyonWeights, 1),
    );
    const rpData =
      workerData.riverProximity ?? new Float32Array(positions.count);
    geometry.setAttribute(
      "riverProximity",
      new THREE.BufferAttribute(rpData, 1),
    );

    // DEBUG: log biome weights for first 5 tiles
    if (this._loggedWorkerTileBiome < 5) {
      // Also log river proximity stats
      let rpNonZero = 0,
        rpMax = 0;
      for (let _rp = 0; _rp < rpData.length; _rp++) {
        if (rpData[_rp] > 0) rpNonZero++;
        if (rpData[_rp] > rpMax) rpMax = rpData[_rp];
      }
      if (rpNonZero > 0) {
        console.log(
          `[RiverDebug] Tile(${tileX},${tileZ}) riverProximity: ${rpNonZero}/${rpData.length} non-zero, max=${rpMax.toFixed(3)}`,
        );
      }
      this._loggedWorkerTileBiome++;
      let maxF = 0,
        maxD = 0,
        sumF = 0,
        sumD = 0;
      for (let _d = 0; _d < forestWeights.length; _d++) {
        sumF += forestWeights[_d];
        sumD += canyonWeights[_d];
        maxF = Math.max(maxF, forestWeights[_d]);
        maxD = Math.max(maxD, canyonWeights[_d]);
      }
      const n = forestWeights.length;
      const avgP = (1 - sumF / n - sumD / n).toFixed(3);
      console.log(
        `[BiomeDebug/WorkerTile] Tile(${tileX},${tileZ}) plains=${avgP} forest=${(sumF / n).toFixed(3)} canyon=${(sumD / n).toFixed(3)}`,
      );
    }

    if (TERRAIN_ROAD_INFLUENCE_DEBUG) {
      let nonZeroCount = 0;
      let maxInfluence = 0;
      for (let i = 0; i < roadInfluences.length; i++) {
        if (roadInfluences[i] > 0) {
          nonZeroCount++;
          maxInfluence = Math.max(maxInfluence, roadInfluences[i]);
        }
      }
      if (nonZeroCount > 0) {
        console.log(
          `[TerrainSystem/Worker] Tile (${tileX}, ${tileZ}): ${nonZeroCount}/${roadInfluences.length} vertices with road influence, max=${maxInfluence.toFixed(3)}`,
        );
      }
    }

    if (hasFlatZones) {
      // Normals must be recomputed on the main thread since heights changed
      this.computeHeightFieldNormals(geometry, tileX, tileZ, heightData);
    } else {
      // Use pre-computed worker normals directly
      geometry.setAttribute("normal", new THREE.BufferAttribute(normalData, 3));
    }

    this.applyFlatZoneCarve(geometry, tileX, tileZ);

    // Attach heightData to geometry so the caller can store it AFTER the tile
    // is added to terrainTiles (storeHeightData requires the tile to exist).
    geometry.userData.heightData = Array.from(heightData);

    return geometry;
  }

  /**
   * Create a terrain tile from pre-computed geometry WITH full resource generation
   * This is the complete path for worker-generated tiles
   */
  private createTileFromGeometryWithResources(
    tileX: number,
    tileZ: number,
    geometry: THREE.PlaneGeometry,
    generateContent = true,
  ): TerrainTile {
    const key = `${tileX}_${tileZ}`;

    // Check if tile already exists
    if (this.terrainTiles.has(key)) {
      geometry.dispose();
      this.enqueueTileForGeneration(tileX, tileZ, generateContent);
      return this.terrainTiles.get(key)!;
    }

    const material = this.getTerrainMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      tileX * this.CONFIG.TILE_SIZE,
      0,
      tileZ * this.CONFIG.TILE_SIZE,
    );
    mesh.name = `Terrain_${key}`;
    mesh.receiveShadow = this.CONFIG.TERRAIN_RECEIVE_SHADOW && !isCsmEnabled();
    mesh.castShadow = this.CONFIG.TERRAIN_CAST_SHADOW;
    mesh.frustumCulled = true;
    mesh.userData = {
      type: "terrain",
      walkable: true,
      clickable: true,
      biome: this.getBiomeAt(tileX, tileZ),
      tileKey: key,
      tileX,
      tileZ,
    };

    // Create tile object
    const tile: TerrainTile = {
      key,
      x: tileX,
      z: tileZ,
      mesh,
      collision: null,
      biome: this.getBiomeAt(tileX, tileZ) as TerrainTile["biome"],
      resources: [],
      roads: [],
      generated: true,
      contentGenerated: false,
      lastActiveTime: new Date(),
      playerCount: 0,
      needsSave: true,
      waterMeshes: [],
      heightData: [],
      chunkSeed: 0,
      heightMap: new Float32Array(0),
      collider: null,
      lastUpdate: Date.now(),
    };

    // Create physics collision on the client for click-to-move raycasts.
    // Server keeps authoritative tile simulation via chunk/nav systems and
    // does not need per-tile rigid bodies here.
    const physics = this.world.physics;
    const PHYSX = getPhysX();
    if (this.runtimeIsClient && physics && PHYSX) {
      const positionAttribute = geometry.attributes.position;
      const vertices = positionAttribute.array as Float32Array;
      let minY = Infinity;
      let maxY = -Infinity;
      let avgY = 0;
      const vertexCount = positionAttribute.count;
      for (let i = 0; i < vertexCount; i++) {
        const y = vertices[i * 3 + 1];
        avgY += y;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      avgY /= vertexCount;

      const heightRange = maxY - minY;
      const boxThickness = Math.max(5, heightRange * 0.5);
      const halfExtents = {
        x: this.CONFIG.TILE_SIZE / 2,
        y: boxThickness / 2,
        z: this.CONFIG.TILE_SIZE / 2,
      };
      const boxGeometry = new PHYSX.PxBoxGeometry(
        halfExtents.x,
        halfExtents.y,
        halfExtents.z,
      );
      const physicsMaterial = physics.physics.createMaterial(0.5, 0.5, 0.1);
      const shape = physics.physics.createShape(
        boxGeometry,
        physicsMaterial,
        true,
      );

      const terrainLayer = Layers.terrain;
      if (terrainLayer) {
        const filterData = new PHYSX.PxFilterData(
          terrainLayer.group,
          0xffffffff,
          0,
          0,
        );
        shape.setQueryFilterData(filterData);
        const simFilterData = new PHYSX.PxFilterData(
          terrainLayer.group,
          terrainLayer.mask,
          0,
          0,
        );
        shape.setSimulationFilterData(simFilterData);
      }

      const transform = new PHYSX.PxTransform(
        new PHYSX.PxVec3(
          mesh.position.x + this.CONFIG.TILE_SIZE / 2,
          avgY,
          mesh.position.z + this.CONFIG.TILE_SIZE / 2,
        ),
        new PHYSX.PxQuat(0, 0, 0, 1),
      );
      const actor = physics.physics.createRigidStatic(transform);
      actor.attachShape(shape);

      const handle: PhysicsHandle = {
        tag: `terrain_${tile.key}`,
        contactedHandles: new Set<PhysicsHandle>(),
        triggeredHandles: new Set<PhysicsHandle>(),
      };
      tile.collider = physics.addActor(actor, handle);
    }

    // Add to scene (skip when quad-tree LOD handles visual rendering)
    if (this.terrainContainer && !this.CONFIG.USE_QUADTREE_LOD) {
      this.terrainContainer.add(mesh);
    }

    this.terrainTiles.set(key, tile);
    this.activeChunks.add(key);
    if (generateContent) this.generateTileContent(tile);
    this.emitTileGenerated(tile);

    if (this.destroyed || this.terrainTiles.get(key) !== tile) return tile;

    // Store height data NOW that the tile is in the map.
    // createTileGeometryFromWorkerData attaches heightData to geometry.userData
    // because storeHeightData requires the tile to exist in terrainTiles.
    if (geometry.userData.heightData) {
      tile.heightData = geometry.userData.heightData;
      tile.needsSave = true;
    }

    // Synchronously bake WATER and STEEP_SLOPE collision flags (server-only).
    // Must match generateTile() — worker-generated tiles need the same
    // walkability baking (WATER flags, bridge collision overrides, etc.).
    if (this.runtimeIsServer || this.world.network?.isServer) {
      this.bakeWalkabilityFlags(tileX, tileZ);
    }

    return tile;
  }

  /** Initialize shared biome placement using the admitted compact terrain profile. */
  private initializeTerrainGenerator(): void {
    const seed = this.computeSeedFromWorldId();
    const worldSizeMeters = this.getActiveWorldSizeMeters();

    // Convert BIOMES data to BiomeDefinition format
    const biomeDefinitions: Record<string, BiomeDefinition> = {};
    for (const [id, biomeData] of Object.entries(BIOMES)) {
      biomeDefinitions[id] = {
        id,
        name: biomeData.name,
        color: biomeData.color,
        terrainMultiplier: biomeData.terrainMultiplier || 1.0,
        difficultyLevel: biomeData.difficultyLevel || 0,
        heightRange: biomeData.heightRange,
        maxSlope: biomeData.maxSlope,
        resourceDensity: biomeData.resourceDensity,
      };
    }

    const profile = this.getWorldTerrainProfile();
    const influence = profile.island.radius * 0.6;
    const centers = BiomeSystem.computePolygonCenters(
      isCompactSculptProfile(profile)
        ? [BiomeType.Forest]
        : (BIOME_LIST as string[]),
      profile.island.radius * 0.45,
      influence,
    ).map((center) => ({
      ...center,
      x: center.x + profile.island.centerX,
      z: center.z + profile.island.centerZ,
    }));
    // Retain the shared biome implementation, not a second terrain-height
    // generator with an independent island mask and origin-centered bounds.
    this.biomeSystem = new BiomeSystem(
      seed,
      worldSizeMeters,
      {
        gridSize: 3,
        jitter: 0,
        minInfluence: influence,
        maxInfluence: influence,
        gaussianCoeff: BIOME_CONFIG.gaussianCoeff,
        boundaryNoiseScale: BIOME_CONFIG.boundaryNoiseScale,
        boundaryNoiseAmount: BIOME_CONFIG.boundaryNoiseAmount,
        explicitCenters: centers,
      },
      biomeDefinitions,
    );
    console.log(
      `[TerrainSystem] Initialized profile ${profile.id}, seed ${seed}, ${worldSizeMeters}m envelope`,
    );
  }

  // World Configuration - Your Specifications
  // classic MMORPG-STYLE: Rolling terrain with visible hills
  private readonly CONFIG = {
    // Core World Specs
    TILE_SIZE: Number(TERRAIN_CONSTANTS.TERRAIN_TILE_SIZE),
    WORLD_SIZE: 0, // Resolved from the required admitted terrain profile.
    TILE_RESOLUTION: 64, // 64x64 vertices per tile for smooth terrain
    SERVER_COLLISION_RESOLUTION: 16, // 16x16 vertices for PhysX collision (server only)
    WATER_THRESHOLD: Number(TERRAIN_CONSTANTS.WATER_THRESHOLD),

    // LOD (Level of Detail) - Resolution tiers based on distance
    LOD_DISTANCES: [200, 400, 700], // Distance thresholds
    LOD_RESOLUTIONS: [64, 32, 16, 8], // Resolution at each LOD level

    // Chunking
    VIEW_DISTANCE: 5, // Load 5 tiles in each direction (11x11 = 121 tiles, ~1100m)
    UPDATE_INTERVAL: 0.5, // Check player movement every 0.5 seconds

    // Movement Constraints
    WATER_IMPASSABLE: true, // Water blocks movement
    MAX_WALKABLE_SLOPE: TERRAIN_CONSTANTS.MAX_WALKABLE_SLOPE, // Maximum slope for movement (tan of angle)
    SLOPE_CHECK_DISTANCE: TERRAIN_CONSTANTS.SLOPE_CHECK_DISTANCE, // Distance to check for slope calculation

    // Features
    ROAD_WIDTH: 6, // 6m wide roads for better visibility
    RESOURCE_DENSITY: 0.15, // 15% chance per area for resources (increased for more resources)
    TREE_DENSITY: 0.25, // 25% chance for trees in forest biomes (increased for visibility)
    TOWN_RADIUS: 25, // Safe radius around towns

    // Difficulty Scaling
    DIFFICULTY_MAX_LEVEL: 1000,
    DIFFICULTY_NOISE_SCALE: 0.0007,
    DIFFICULTY_NOISE_WEIGHT: 0.3,
    DIFFICULTY_CURVE_EXPONENT: 2.2,
    DIFFICULTY_TOWN_FALLOFF_RADIUS: 300,

    // Boss Hotspots
    BOSS_HOTSPOT_MAX: 3,
    BOSS_HOTSPOT_GRID_STEP: 500,
    BOSS_HOTSPOT_MIN_SCALAR: 0.85,
    BOSS_HOTSPOT_MIN_DISTANCE: 1200,
    BOSS_HOTSPOT_RADIUS: 120,
    BOSS_MIN_LEVEL: 800,

    // Shoreline — delegated to TerrainHeightParams.SHORELINE_CONFIG (single source of truth)

    // Island Mask (default for main world)
    ISLAND_MASK_ENABLED: true,
    ISLAND_MAX_WORLD_SIZE_TILES: 0, // Resolved before any terrain work.
    ISLAND_FALLOFF_TILES: 0,
    ISLAND_EDGE_NOISE_SCALE: 0.0015, // Noise scale for coastline irregularity
    ISLAND_EDGE_NOISE_STRENGTH: 0.03, // Radius variance as fraction of radius

    // Web Worker settings for parallel terrain generation
    USE_WORKERS: true, // Enable web workers for heightmap generation (client-side only)
    WORKER_POOL_SIZE: 0, // Number of workers (0 = auto, based on CPU cores)

    // Quad-tree LOD system (client-only visual terrain)
    // When enabled, terrain rendering uses a quad-tree with uniform resolution
    // chunks instead of the flat 100m grid. Gameplay logic (resources, physics,
    // biomes, server sync) still uses the flat grid. getHeightAt() is unaffected.
    USE_QUADTREE_LOD: true,
    QUADTREE_DEBUG_WIREFRAME: false,
    QUADTREE_MIN_SIZE: 100,
    QUADTREE_MAX_DEPTH: 4,
    QUADTREE_SPLIT_RATIO: 1.5,
    QUADTREE_SKIRT_DROP: 15,
    QUADTREE_UNSPLIT_MULTIPLIER: 1.2,
    QUADTREE_RESOLUTION: 64,
    QUADTREE_MAX_SYNC_PER_FRAME: 4,
    QUADTREE_MAX_ASSEMBLIES_PER_FRAME: 6,

    // Shadow settings for terrain meshes (applies to both flat-grid and quad-tree)
    // NOTE: receiveShadow only works with single shadow map (ENABLE_CSM=false).
    // CSM adds too many shadow textures per cascade, exceeding WebGPU's 16-texture
    // limit (terrain already uses 13 textures for biomes + noise + fog + masks).
    TERRAIN_RECEIVE_SHADOW: true,
    TERRAIN_CAST_SHADOW: false,
  };

  // Pre-computed terrain data from workers (awaiting geometry creation)
  private pendingWorkerResults = new Map<string, TerrainWorkerOutput>();
  private workerBatchInProgress = false;

  // Biomes now loaded from assets/manifests/biomes.json via DataManager
  // Uses imported BIOMES from world-structure.ts
  // No hardcoded biome data - all definitions in JSON!

  constructor(world: World) {
    super(world);
  }

  async init(): Promise<void> {
    // Manifest loading is also used by other init waves; its in-flight promise
    // is shared. Do not generate terrain or create GPU work from fallback data.
    const dataManager = DataManager.getInstance();
    // System registration normally admits the manifests first. Do not yield
    // that already-ready path before synchronous terrain sampling is installed:
    // other systems in the same init wave can request terrain immediately.
    if (!dataManager.isReady()) await dataManager.initialize();
    this.getCompactPondMaterial();
    console.log(
      "[TerrainSystem] Initializing admitted compact terrain profile",
    );
    // Initialize tile size
    this.tileSize = this.CONFIG.TILE_SIZE;
    const runtimeRole = this.resolveRuntimeRole();
    this.runtimeIsServer = runtimeRole.isServer;
    this.runtimeIsClient = runtimeRole.isClient;

    // Initialize deterministic noise from world id + per-biome noise sets
    this.ensureNoiseInitialized();

    // Initialize the shared biome generator; height sampling stays profile-owned.
    this.initializeTerrainGenerator();

    // Water body registry — ocean level only (no manual rivers/ponds)
    this.waterBodyRegistry = new WaterBodyRegistry(this.CONFIG.WATER_THRESHOLD);

    // Cache optional TownSystem for difficulty falloff and boss placement
    this.townSystem = this.world.getSystem<TownSystem>("towns") ?? null;

    // Precompute boss hotspots for this world seed
    this.generateBossHotspots();

    // NOTE: Flat zones are loaded later, after DataManager is ready
    // See loadFlatZonesFromManifest() call after the DataManager wait loop

    // Initialize terrain material (client-side only)
    if (this.runtimeIsClient) {
      this.initTerrainMaterial();
      const material = this.terrainMaterial as ReturnType<
        typeof createTerrainMaterial
      >;
      if (material.compactTerrainSurface) {
        try {
          // Generator/height sampling already exists. Admit all actual PBR maps
          // before this client init can become ready; placeholders are not proof.
          await material.compactTerrainSurface.load();
          if (this.destroyed)
            throw new Error("Terrain destroyed during material admission");
        } catch (error) {
          material.dispose();
          throw error;
        }
      }

      // TEMPORARILY DISABLED - rock system disabled
      // setProcgenRockWorld(this.world);
      // setProcgenPlantWorld(this.world); // DISABLED

      // Pre-warm common rock presets for the world's biomes
      // TEMPORARILY DISABLED
      // const commonRockPresets = ["boulder", "pebble", "granite", "sandstone"];

      // Pre-warm mesh variant caches (rocks only)
      // TEMPORARILY DISABLED
      /*
      preWarmRockCache(commonRockPresets).catch((err) =>
        console.warn("[TerrainSystem] Failed to pre-warm rock cache:", err),
      );

      // Pre-warm impostor caches from IndexedDB (loads without rebaking)
      preWarmRockCache(commonRockPresets)
        .then(() => {
          // Create instancer to enable impostor pre-warming
          const rockInstancer = ProcgenRockInstancer.getInstance(this.world);

          // Pre-warm impostor caches (loads from IndexedDB if available)
          if (rockInstancer) {
            rockInstancer
              .preWarmImpostorCache(commonRockPresets)
              .catch((err) =>
                console.warn(
                  "[TerrainSystem] Failed to pre-warm rock impostors:",
                  err,
                ),
              );
          }
        })
        .catch((err) =>
          console.warn("[TerrainSystem] Failed during cache pre-warming:", err),
        );
      */
    }

    // Initialize water system
    this.waterSystem = new WaterSystem(this.world);
    await this.waterSystem.init();

    // Add water system to scene (required for reflector and debug view)
    if (this.world.stage?.scene) {
      this.waterSystem.addToScene(this.world.stage.scene);
    }

    // Sync water reflections setting from prefs (client-side only)
    if (typeof window !== "undefined" && this.world.prefs) {
      // Set initial value from prefs
      const waterReflectionsEnabled = this.world.prefs.waterReflections ?? true;
      this.waterSystem.setReflectionsEnabled(waterReflectionsEnabled);

      // Listen for prefs changes
      this.world.prefs.on("change", this.onPrefsChange);
    }

    // Get systems references
    // Check if database system exists and has the required method
    const dbSystem = this.world.getSystem("database") as
      { saveWorldChunk(chunkData: WorldChunkData): void } | undefined;
    if (dbSystem) {
      this.databaseSystem = dbSystem;
    }

    // Initialize chunk loading system
    this.initializeChunkLoadingSystem();

    // Initialize serialization system
    this.initializeSerializationSystem();

    // Initialize bounding box verification
    this.initializeBoundingBoxSystem();

    // Environment detection (deferred until network system is available)
    const networkSystem = this.world.network;
    if (networkSystem?.isClient) {
      // Client-side initialization
    } else if (networkSystem?.isServer) {
      // Server-side initialization
    } else {
      // Environment not yet determined
    }
  }

  async start(): Promise<void> {
    this.destroyed = false;
    this.ensureNoiseInitialized();

    // CRITICAL: Wait for DataManager to initialize BIOMES data before generating terrain
    // DataManager is initialized in registerSystems() which happens asynchronously
    // We need to wait for it to be ready AND for BIOMES data to be loaded before generating terrain tiles
    const dataManager = DataManager.getInstance();
    const maxWait = 10000; // 10 seconds
    const startTime = Date.now();

    // Wait for both DataManager to be ready AND BIOMES data to be loaded
    while (
      (!dataManager.isReady() || Object.keys(BIOMES).length === 0) &&
      Date.now() - startTime < maxWait
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Final check - verify BIOMES data is actually loaded
    if (Object.keys(BIOMES).length === 0) {
      const errorMsg =
        "[TerrainSystem] BIOMES data not loaded! DataManager must initialize before terrain generation. " +
        `DataManager ready: ${dataManager.isReady()}, BIOMES count: ${Object.keys(BIOMES).length}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    console.log(
      `[TerrainSystem] DataManager initialized, ${Object.keys(BIOMES).length} biomes loaded, proceeding with terrain generation`,
    );

    // Load explicit ponds/lakes before terrain collision or visual tiles are
    // generated so water, shore discovery, and movement share one registry.
    this.loadWaterBodiesFromManifest();

    // Load flat zones from manifest (now that DataManager has loaded world-areas.json and stations.json)
    this.loadFlatZonesFromManifest();

    // Final environment detection. world.isClient can be transiently true during
    // server bootstrap, so prefer runtime detection to avoid loading client-only
    // terrain visuals in headless/server mode.
    const { isServer, isClient } = this.resolveRuntimeRole();
    this.runtimeIsServer = isServer;
    this.runtimeIsClient = isClient;

    if (isServer) {
      this.setupServerTerrain();
    } else if (isClient) {
      this.setupClientTerrain();
    } else {
      console.warn(
        "[TerrainSystem] Runtime role unresolved, defaulting to server terrain mode",
      );
      this.runtimeIsServer = true;
      this.runtimeIsClient = false;
      this.setupServerTerrain();
    }

    // Initialize GPU compute context for accelerated terrain operations (client only)
    if (isClient && isTerrainComputeAvailable()) {
      this.terrainComputeContext = new TerrainComputeContext({
        minVerticesForGPU: 1000,
        minRoadsForGPU: 3,
      });
      console.log(
        "[TerrainSystem] GPU compute context created (pending renderer init)",
      );
    }

    // Generate initial terrain as soon as terrain data/materials are ready.
    // Road influence can be refreshed later when the road network finishes.
    // This keeps first entry into the world off the critical path for roads/towns.
    if (!this._initialTilesReady) {
      this.loadInitialTiles();
    }
    if (
      this.runtimeIsClient &&
      isStreamingLikeViewport() &&
      this.quadTreeVisualManager &&
      this.world.graphics?.precompileObject
    ) {
      const center = this.getTerrainCenters()[0]?.position;
      if (center) {
        const precompileObject = this.world.graphics.precompileObject.bind(
          this.world.graphics,
        );
        await this.quadTreeVisualManager.precompileRepresentativeChunk(
          center.x,
          center.z,
          precompileObject,
        );
        if (this.grassVisualManager) {
          await this.grassVisualManager.precompileRepresentativeChunk(
            precompileObject,
          );
        }
      }
    }

    this.subscribeRoadNetworkEvents();

    // Start player-based terrain update loop
    // On server, getTerrainCenters() filters out agent players to prevent 25+ agents
    // from queueing hundreds of terrain tiles that overwhelm the event loop.
    this.terrainUpdateIntervalId = setInterval(
      () => {
        this.updatePlayerBasedTerrain();
      },
      isServer ? 2000 : 1000,
    ); // Server: 2s (less frequent), Client: 1s

    // Start serialization loop
    this.serializationIntervalId = setInterval(() => {
      this.performPeriodicSerialization();
    }, 60000); // Check every minute

    // Start bounding box verification
    this.boundingBoxIntervalId = setInterval(() => {
      this.verifyTerrainBoundingBoxes();
    }, 30000); // Verify every 30 seconds

    // Mark terrain as initialized - allows update() to start processing
    this._terrainInitialized = true;
    console.log("[TerrainSystem] Terrain initialization complete");
  }

  private setupClientTerrain(): void {
    const stage = this.world.stage as { scene: THREE.Scene };
    const scene = stage.scene;

    // Create terrain container
    this.terrainContainer = new THREE.Group();
    this.terrainContainer.name = "TerrainContainer";
    scene.add(this.terrainContainer);

    // Initialize InstancedMeshManager
    this.instancedMeshManager = new InstancedMeshManager(scene, this.world);
    this.registerInstancedMeshes();

    // Initialize quad-tree LOD visual manager if enabled
    if (this.CONFIG.USE_QUADTREE_LOD) {
      this.initQuadTreeVisualManager();
    }

    // Setup initial camera only if no client camera system controls it
    // Leave control to ClientCameraSystem for third-person follow

    // Initial tiles will be loaded in start() method
  }

  /**
   * Build the VisualManagerTerrainProvider adapter that exposes TerrainSystem's
   * height/biome/road/flat-zone queries to the quad-tree chunk generator.
   */
  private buildChunkTerrainProvider(): VisualManagerTerrainProvider {
    const biomeColorCache = new Map<
      string,
      { r: number; g: number; b: number }
    >();

    return {
      getHeightAtComputed: (worldX: number, worldZ: number) =>
        this.getHeightAtComputed(worldX, worldZ),

      computeBiomeWeightsAtPosition: (worldX: number, worldZ: number) =>
        this.computeBiomeWeightsAtPosition(worldX, worldZ),

      computeBiomeWeightsByPosition: (worldX: number, worldZ: number) =>
        this.computeBiomeWeightsByPosition(worldX, worldZ),

      calculateRoadInfluenceAtVertex: (
        worldX: number,
        worldZ: number,
        tileX: number,
        tileZ: number,
      ) => this.calculateRoadInfluenceAtVertex(worldX, worldZ, tileX, tileZ),

      getBiomeId: (biomeName: string) => this.getBiomeId(biomeName),

      getBiomeColor: (biomeName: string) => {
        let cached = biomeColorCache.get(biomeName);
        if (!cached) {
          const biomeData = BIOMES[biomeName];
          if (biomeData) {
            const c = new THREE.Color(biomeData.color);
            cached = { r: c.r, g: c.g, b: c.b };
          } else {
            cached = { r: 0.3, g: 0.55, b: 0.15 };
          }
          biomeColorCache.set(biomeName, cached);
        }
        return cached;
      },

      getFlatZoneHeight: (worldX: number, worldZ: number) =>
        this.getFlatZoneHeight(worldX, worldZ),

      terrainProfileIdentity: worldTerrainProfileIdentity(
        this.getWorldTerrainProfile(),
      ),

      WATER_LEVEL_NORMALIZED: this.waterLevelNormalized,
      SHORELINE_THRESHOLD: this.shorelineParameters.THRESHOLD,
      SHORELINE_STRENGTH: this.shorelineParameters.STRENGTH,
      MAX_HEIGHT: this.maxHeightParameter,
      TILE_SIZE: this.CONFIG.TILE_SIZE,
    };
  }

  /**
   * Initialize the quad-tree LOD visual manager.
   * Creates a separate THREE.Group for quad-tree terrain meshes.
   */
  private initQuadTreeVisualManager(): void {
    if (!this.terrainMaterial) {
      console.warn(
        "[TerrainSystem] Cannot init quad-tree: terrain material not ready",
      );
      return;
    }

    const qtContainer = new THREE.Group();
    qtContainer.name = "QuadTreeTerrainContainer";
    const containerParent = this.terrainContainer?.parent;
    if (!containerParent) {
      console.warn(
        "[TerrainSystem] Cannot init quad-tree: terrainContainer has no parent",
      );
      return;
    }
    containerParent.add(qtContainer);

    const provider = this.buildChunkTerrainProvider();

    const workerConfig: QuadChunkWorkerConfig = createTerrainWorkerConfig(
      this.getWorldTerrainProfile(),
      this.CONFIG.TILE_RESOLUTION,
    );

    const biomeCenters = [...this.biomeSystem.getBiomeCenters()].map((c) => ({
      x: c.x,
      z: c.z,
      type: c.type,
      influence: c.influence,
    }));

    // DEBUG: log what we're sending to the worker
    const workerTypeCounts: Record<string, number> = {};
    for (const c of biomeCenters) {
      workerTypeCounts[c.type ?? "UNDEFINED"] =
        (workerTypeCounts[c.type ?? "UNDEFINED"] || 0) + 1;
    }
    console.log(
      "[TerrainSystem] Worker biomeCenters:",
      biomeCenters.length,
      "types:",
      JSON.stringify(workerTypeCounts),
    );
    console.log(
      "[TerrainSystem] First 5 centers:",
      JSON.stringify(biomeCenters.slice(0, 5)),
    );

    const biomeColorCache = new Map<
      string,
      { r: number; g: number; b: number }
    >();
    const workerBiomes: Record<
      string,
      { color: { r: number; g: number; b: number } }
    > = {};
    for (const [name, biomeData] of Object.entries(BIOMES)) {
      let cached = biomeColorCache.get(name);
      if (!cached) {
        const c = new THREE.Color(biomeData.color);
        cached = { r: c.r, g: c.g, b: c.b };
        biomeColorCache.set(name, cached);
      }
      workerBiomes[name] = { color: cached };
    }

    const isStreamingViewport = isStreamingLikeViewport();
    const maxSyncChunksPerFrame = isStreamingViewport
      ? Math.min(1, this.CONFIG.QUADTREE_MAX_SYNC_PER_FRAME)
      : this.CONFIG.QUADTREE_MAX_SYNC_PER_FRAME;
    const maxAssembliesPerFrame = isStreamingViewport
      ? Math.min(2, this.CONFIG.QUADTREE_MAX_ASSEMBLIES_PER_FRAME)
      : this.CONFIG.QUADTREE_MAX_ASSEMBLIES_PER_FRAME;
    const quadTreeResolution = isStreamingViewport
      ? STREAMING_TERRAIN_QUADTREE_RESOLUTION
      : this.CONFIG.QUADTREE_RESOLUTION;

    this.quadTreeVisualManager = new TerrainVisualManager(
      {
        minSize: this.CONFIG.QUADTREE_MIN_SIZE,
        maxDepth: this.CONFIG.QUADTREE_MAX_DEPTH,
        splitRatio: this.CONFIG.QUADTREE_SPLIT_RATIO,
        unsplitMultiplier: this.CONFIG.QUADTREE_UNSPLIT_MULTIPLIER,
        resolution: quadTreeResolution,
        fineDetailRegions: createCompactPreparationDetailRegions(
          this.getWorldTerrainProfile(),
          DataManager.getInstance().getAllWorldAreas(),
          this.CONFIG.QUADTREE_RESOLUTION,
        ),
        skirtDrop: this.CONFIG.QUADTREE_SKIRT_DROP,
        // The broadcast camera is pinned to the compact arena complex. One
        // 1,600 m root covers the complete 250 m critical scene radius, so
        // retaining the exploration viewport's surrounding eight roots only
        // creates off-screen worker, geometry, and GPU residency churn.
        rootChunkRadius: isStreamingViewport ? 0 : 1,
      },
      provider,
      qtContainer,
      this.terrainMaterial,
      workerConfig,
      this.computeSeedFromWorldId(),
      biomeCenters,
      workerBiomes,
      this.CONFIG.QUADTREE_DEBUG_WIREFRAME,
      this.CONFIG.TERRAIN_RECEIVE_SHADOW && !isCsmEnabled(),
      this.CONFIG.TERRAIN_CAST_SHADOW,
      maxSyncChunksPerFrame,
      maxAssembliesPerFrame,
    );

    const pondPlacements = createCompactPondDressing(
      this.getWorldTerrainProfile(),
      DataManager.getInstance().getAllWorldAreas(),
      (x, z) => this.getHeightAtComputed(x, z),
    );
    if (pondPlacements.length) {
      this.compactPondDressing = new CompactPondDressingVisuals(
        containerParent,
        pondPlacements,
      );
      void this.compactPondDressing.load(this.world);
    }

    // Water quad-tree visual manager — flat water meshes aligned with terrain chunks
    if (this.waterSystem) {
      const waterContainer = new THREE.Group();
      waterContainer.name = "QuadTreeWaterContainer";
      if (this.terrainContainer) {
        this.terrainContainer.parent?.add(waterContainer);
      }

      this.waterSystem.setWaterLevel(this.CONFIG.WATER_THRESHOLD);

      this.waterVisualManager = new WaterVisualManager(
        waterContainer,
        this.waterSystem,
        (x: number, z: number) => this.getHeightAt(x, z),
        (x: number, z: number) => this.getIslandMask(x, z),
        this.CONFIG.WATER_THRESHOLD,
        this.waterBodyRegistry.getAllBodies(),
        this.getWorldTerrainProfile(),
      );

      const grassContainer = new THREE.Group();
      grassContainer.name = "QuadTreeGrassContainer";
      if (this.terrainContainer) {
        this.terrainContainer.parent?.add(grassContainer);
      }
      const grassWorkerSetup = this.buildGrassWorkerSetup();
      const terrainShade =
        this.getTerrainMaterialWithUniforms()?.terrainUniforms.shade;
      if (!terrainShade) {
        throw new Error(
          "Terrain shading must be initialized before grass materials",
        );
      }
      this.grassVisualManager = new GrassVisualManager(
        worldTerrainProfileIdentity(this.getWorldTerrainProfile()),
        grassContainer,
        (node) => this.quadTreeVisualManager!.getRetainedSurface(node),
        (x: number, z: number) => this.getHeightAtComputed(x, z),
        this.CONFIG.WATER_THRESHOLD,
        (wx: number, wz: number) =>
          this.calculateRoadInfluenceAtVertex(wx, wz, 0, 0),
        (wx: number, wz: number) => this.isGrassExcludedAt(wx, wz),
        (wx: number, wz: number, eligibility?: GrassSurfaceEligibility) =>
          this.getTerrainColorAt(wx, wz, true, eligibility),
        grassWorkerSetup,
        resolveExplicitStreamingRenderProfile()?.grassProfile ===
          "compact-island-v1"
          ? COMPACT_ISLAND_GRASS_VISUAL_PROFILE
          : isStreamingViewport
            ? STREAMING_GRASS_VISUAL_PROFILE
            : undefined,
        terrainShade,
        (wx: number, wz: number) =>
          this.waterBodyRegistry.getWaterSurfaceAt(wx, wz),
      );

      // Wire terrain, water, grass managers to the same quad-tree via composite
      const composite = new CompositeQuadTreeListener();
      composite.add(this.quadTreeVisualManager);
      composite.add(this.waterVisualManager);
      composite.add(this.grassVisualManager);
      this.quadTreeVisualManager.getQuadTree().setListener(composite);
    }

    console.log(
      "[TerrainSystem] Quad-tree LOD visual manager initialized " +
        `(minSize=${this.CONFIG.QUADTREE_MIN_SIZE}, maxDepth=${this.CONFIG.QUADTREE_MAX_DEPTH}, ` +
        `resolution=${quadTreeResolution}, splitRatio=${this.CONFIG.QUADTREE_SPLIT_RATIO})`,
    );
  }

  private readonly onRoadsGenerated = (): void => {
    if (this.destroyed) return;
    this.roadNetworkSystem = this.world.getSystem("roads") as
      RoadNetworkSystem | undefined;
    // A quadtree-only stream may never have terrainTiles. Always invalidate
    // cached empty pre-road segments before grass or geometry asks again.
    this._cachedRoadTileX = Number.NaN;
    this._cachedRoadTileZ = Number.NaN;
    this._cachedRoadSegments = [];
    void this.refreshRoadInfluence().catch((error) => {
      console.error("[TerrainSystem] Failed to refresh road influence", error);
    });
    this.grassVisualManager?.rebuildAllChunks();
  };

  private readonly onRoadMaskReady = (): void => {
    if (this.destroyed || !this.runtimeIsClient) return;
    // Read the registered producer rather than trusting an unrelated event payload.
    const roads = this.world.getSystem("roads") as
      RoadNetworkSystem | undefined;
    const mask = roads?.getRoadInfluenceTextureData();
    if (!mask) return;
    setRoadInfluenceTextureData(
      mask.data,
      mask.width,
      mask.height,
      mask.worldSize,
      mask.centerX,
      mask.centerZ,
      this,
    );
  };

  private subscribeRoadNetworkEvents(): void {
    if (this.roadEventsSubscribed) return;
    this.roadEventsSubscribed = true;
    if (this.runtimeIsClient) {
      setRoadInfluenceTextureData(new Float32Array([0]), 1, 1, 1, 0, 0, this);
    }
    this.world.on(EventType.ROADS_GENERATED, this.onRoadsGenerated);
    this.world.on(EventType.ROADS_MASK_READY, this.onRoadMaskReady);
    // Admit an already-generated network too, independent of start ordering.
    if (this.world.getSystem("roads")) this.onRoadsGenerated();
    this.onRoadMaskReady();
  }

  private buildGrassWorkerSetup(): GrassWorkerSetup {
    const workerConfig: TerrainWorkerConfig = createTerrainWorkerConfig(
      this.getWorldTerrainProfile(),
      this.CONFIG.TILE_RESOLUTION,
    );

    const biomeData: Record<
      string,
      { heightModifier: number; color: { r: number; g: number; b: number } }
    > = {};
    for (const [name, biome] of Object.entries(BIOMES)) {
      const color = new THREE.Color(biome.color);
      biomeData[name] = {
        heightModifier: biome.terrainMultiplier || 1,
        color: { r: color.r, g: color.g, b: color.b },
      };
    }

    const biomeCenters = this.biomeSystem.getBiomeCenters() as BiomeCenter[];

    const tCfg = getGrassConfigForBiome(BiomeType.Tundra);
    const fCfg = getGrassConfigForBiome(BiomeType.Forest);
    const cCfg = getGrassConfigForBiome(BiomeType.Canyon);

    const resolveTint = (cfg: ReturnType<typeof getGrassConfigForBiome>) => ({
      density: cfg.density,
      maxSlope: cfg.maxSlope,
      minGrassWeight: cfg.minGrassWeight,
      heightScale: cfg.heightScale,
      patchiness: cfg.patchiness,
      patchScale: cfg.patchScale,
      tintR: cfg.tintColor?.[0] ?? 0,
      tintG: cfg.tintColor?.[1] ?? 0,
      tintB: cfg.tintColor?.[2] ?? 0,
      tintStrength: cfg.tintStrength ?? 0,
    });

    const grassConfigs: Record<
      string,
      {
        density: number;
        maxSlope: number;
        minGrassWeight: number;
        heightScale: number;
        patchiness: number;
        patchScale: number;
        tintR: number;
        tintG: number;
        tintB: number;
        tintStrength: number;
      }
    > = {
      [BiomeType.Tundra]: resolveTint(tCfg),
      [BiomeType.Forest]: resolveTint(fCfg),
      [BiomeType.Canyon]: resolveTint(cCfg),
    };

    const tileSize = this.CONFIG.TILE_SIZE;

    return {
      terrainConfig: workerConfig,
      seed: this.computeSeedFromWorldId(),
      biomeCenters: biomeCenters.map((c) => ({
        x: c.x,
        z: c.z,
        type: c.type,
        influence: c.influence,
      })),
      biomes: biomeData,
      grassConfigs,
      tileSize,
      getRoadSegmentsForRegion: (
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
      ) => this.getWorldSpaceRoadSegmentsForRegion(minX, minZ, maxX, maxZ),
      getTerrainSurfaceForRegion: (
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
      ) => this.getTerrainSurfaceForRegion(minX, minZ, maxX, maxZ),
    };
  }

  /**
   * Collect road segments overlapping a world-space AABB, returned in
   * world coordinates for the grass worker.
   */
  private getWorldSpaceRoadSegmentsForRegion(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): Array<{
    startX: number;
    startZ: number;
    endX: number;
    endZ: number;
    width: number;
  }> {
    this.roadNetworkSystem ??= this.world.getSystem("roads") as
      RoadNetworkSystem | undefined;
    if (!this.roadNetworkSystem) return [];

    const ts = this.CONFIG.TILE_SIZE;
    const minTX = Math.floor(minX / ts);
    const minTZ = Math.floor(minZ / ts);
    const maxTX = Math.floor(maxX / ts);
    const maxTZ = Math.floor(maxZ / ts);

    const result: Array<{
      startX: number;
      startZ: number;
      endX: number;
      endZ: number;
      width: number;
    }> = [];

    for (let tx = minTX; tx <= maxTX; tx++) {
      for (let tz = minTZ; tz <= maxTZ; tz++) {
        const segs = this.roadNetworkSystem.getRoadSegmentsForTile(tx, tz);
        const originX = tx * ts;
        const originZ = tz * ts;
        for (const seg of segs) {
          result.push({
            startX: originX + seg.start.x,
            startZ: originZ + seg.start.z,
            endX: originX + seg.end.x,
            endZ: originZ + seg.end.z,
            width: seg.width,
          });
        }
      }
    }

    return result;
  }

  /**
   * Capture the full authored surface, not just exclusion rectangles. The caller
   * includes the normal stencil halo. Preserve registration order so the worker
   * can reconstruct the same ordered 3x3 spatial lookup as the main thread.
   */
  private getTerrainSurfaceForRegion(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): GrassTerrainSurfaceSnapshot {
    if (
      ![minX, minZ, maxX, maxZ].every(Number.isFinite) ||
      minX > maxX ||
      minZ > maxZ
    ) {
      throw new Error("Invalid grass surface query bounds");
    }
    const tileSize = this.CONFIG.TILE_SIZE;
    const halfTile = tileSize / 2;
    const minTX = Math.floor((minX + halfTile) / tileSize) - 1;
    const minTZ = Math.floor((minZ + halfTile) / tileSize) - 1;
    const maxTX = Math.floor((maxX + halfTile) / tileSize) + 1;
    const maxTZ = Math.floor((maxZ + halfTile) / tileSize) + 1;
    if (![minTX, minTZ, maxTX, maxTZ].every(Number.isSafeInteger)) {
      throw new Error("Grass surface query exceeds safe spatial index bounds");
    }
    // Bound work by registered zones, never by an arbitrarily large query AABB.
    // Match registerFlatZone's conservative square indexing, including neighbors
    // that may change first-candidate tie ordering at a tile boundary.
    const zones = [...this.flatZones.values()].filter((zone) => {
      const radius = Math.max(zone.width, zone.depth) / 2 + zone.blendRadius;
      const zoneMinTX = Math.floor(
        (zone.centerX - radius + halfTile) / tileSize,
      );
      const zoneMaxTX = Math.floor(
        (zone.centerX + radius + halfTile) / tileSize,
      );
      const zoneMinTZ = Math.floor(
        (zone.centerZ - radius + halfTile) / tileSize,
      );
      const zoneMaxTZ = Math.floor(
        (zone.centerZ + radius + halfTile) / tileSize,
      );
      return (
        zoneMinTX <= maxTX &&
        zoneMaxTX >= minTX &&
        zoneMinTZ <= maxTZ &&
        zoneMaxTZ >= minTZ
      );
    });
    const seen = new Set(zones.map((zone) => zone.id));
    const waterBodies = this.waterBodyRegistry.getAllBodies().filter((body) => {
      const dx = body.centerX - Math.max(minX, Math.min(maxX, body.centerX));
      const dz = body.centerZ - Math.max(minZ, Math.min(maxZ, body.centerZ));
      const radius =
        body.radius +
        (body.id === this.compactPondMaterial?.id
          ? COMPACT_TERRAIN_COMPOSITION.pondBankReach
          : 0);
      return dx * dx + dz * dz <= radius * radius;
    });
    return createGrassTerrainSurfaceSnapshot({
      zones,
      arenaFloorIds: [...this.arenaFloorZoneIds].filter((id) => seen.has(id)),
      arenaGradeHeight: this.arenaGradeHeight,
      waterBodies,
    });
  }

  private registerInstancedMeshes(): void {
    // Register tree mesh - now with automatic pooling (1000 visible max)
    const treeSize = { x: 1.2, y: 3.0, z: 1.2 };
    const treeGeometry = new THREE.BoxGeometry(
      treeSize.x,
      treeSize.y,
      treeSize.z,
    );
    const treeMaterial = new MeshStandardNodeMaterial({ color: 0x2f7d32 });
    this.instancedMeshManager.registerMesh(
      "tree",
      treeGeometry,
      treeMaterial,
      1000,
    );

    // NOTE: Decorative rocks are now handled by ProcgenRockInstancer
    // with procedurally generated geometry and LODs.
    // Ore meshes remain as placeholder boxes since they are harvestable resources
    // and will be replaced with GLB models from the resource system.
    const oreSize = { x: 1.0, y: 1.0, z: 1.0 };
    const oreGeometry = new THREE.BoxGeometry(oreSize.x, oreSize.y, oreSize.z);
    const oreMaterial = new THREE.MeshLambertMaterial({ color: 0x8a8a8a });
    this.instancedMeshManager.registerMesh(
      "ore",
      oreGeometry,
      oreMaterial,
      500,
    );
    this.instancedMeshManager.registerMesh(
      "rare_ore",
      oreGeometry,
      oreMaterial,
      200,
    );

    // Register herb mesh - pooled to 800 visible instances
    const herbSize = { x: 0.6, y: 0.8, z: 0.6 };
    const herbGeometry = new THREE.BoxGeometry(
      herbSize.x,
      herbSize.y,
      herbSize.z,
    );
    const herbMaterial = new THREE.MeshLambertMaterial({ color: 0x66bb6a });
    this.instancedMeshManager.registerMesh(
      "herb",
      herbGeometry,
      herbMaterial,
      800,
    );

    // Register fish mesh (using a simple sphere) - pooled to 300 visible instances
    const fishGeometry = new THREE.SphereGeometry(0.6);
    const fishMaterial = new THREE.MeshLambertMaterial({
      color: 0x3aa7ff,
      transparent: true,
      opacity: 0.7,
    });
    this.instancedMeshManager.registerMesh(
      "fish",
      fishGeometry,
      fishMaterial,
      300,
    );

    // Grass rendering now handled by ProceduralGrassSystem
  }

  private setupServerTerrain(): void {
    if (!this.serverMeshCollisionEnabled) {
      console.log(
        "[TerrainSystem] Server mesh collision generation disabled (set TERRAIN_SERVER_MESH_COLLISION_ENABLED=true to enable)",
      );
    }

    // Setup chunk save interval for persistence
    if (this.databaseSystem) {
      this.chunkSaveInterval = setInterval(() => {
        this.saveModifiedChunks();
      }, 30000); // Save every 30 seconds
    }

    // Initial tiles will be loaded in start() method
  }

  private getServerLaunchPreparationAreas() {
    return SERVER_LAUNCH_PREPARATION_AREA_IDS.map(
      (areaId) => ALL_WORLD_AREAS[areaId],
    ).filter((area) => area !== undefined);
  }

  private addServerLaunchPreparationTiles(tileKeys: Set<string>): void {
    if (
      !this.runtimeIsServer ||
      typeof process === "undefined" ||
      process.env.STREAMING_DUEL_ENABLED !== "true"
    ) {
      return;
    }

    for (const area of this.getServerLaunchPreparationAreas()) {
      const minTileX = this.worldToTerrainTileIndex(area.bounds.minX);
      const maxTileX = this.worldToTerrainTileIndex(area.bounds.maxX);
      const minTileZ = this.worldToTerrainTileIndex(area.bounds.minZ);
      const maxTileZ = this.worldToTerrainTileIndex(area.bounds.maxZ);
      for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
        for (let tileZ = minTileZ; tileZ <= maxTileZ; tileZ++) {
          tileKeys.add(`${tileX}_${tileZ}`);
        }
      }
    }
  }

  /**
   * Resolve terrain focus centers for streaming.
   *
   * In spectator/stream mode (no local player), center generation on the
   * current camera target instead of all remote players to avoid loading the
   * whole world and to keep duel views fast.
   */
  private getTerrainCenters(): Array<{ id: string; position: THREE.Vector3 }> {
    // Spectator/streaming client: use camera target when there is no local player.
    if (this.runtimeIsClient) {
      const localPlayer = this.world.getPlayer?.();
      if (!localPlayer) {
        // The broadcast page must keep terrain and LOD residency centered on
        // the active duel ring. The scheduler teleports contestants home while
        // the delayed public renderer is still completing RESOLUTION; following
        // either remote avatar here would rebuild far-away terrain even though
        // the cinematic camera intentionally remains at the arena.
        if (
          isStreamPageRoute() &&
          resolveExplicitStreamingWorldProfile() !== "preparation-v1"
        ) {
          const streamState =
            typeof window === "undefined"
              ? null
              : (
                  window as Window & {
                    __HYPERIA_STREAM_STATE__?: {
                      cycle?: {
                        phase?: string;
                        agent1?: { id?: string | null } | null;
                        agent2?: { id?: string | null } | null;
                        arenaPositions?: {
                          agent1?: unknown;
                          agent2?: unknown;
                        } | null;
                      } | null;
                    } | null;
                  }
                ).__HYPERIA_STREAM_STATE__;
          const cycle = streamState?.cycle;
          const arenaPositions = cycle?.arenaPositions;
          const first = arenaPositions?.agent1;
          const second = arenaPositions?.agent2;
          if (
            Array.isArray(first) &&
            first.length === 3 &&
            first.every((value) =>
              Number.isFinite(typeof value === "number" ? value : Number.NaN),
            ) &&
            Array.isArray(second) &&
            second.length === 3 &&
            second.every((value) =>
              Number.isFinite(typeof value === "number" ? value : Number.NaN),
            )
          ) {
            this._spectatorFocusPos.set(
              ((first[0] as number) + (second[0] as number)) / 2,
              ((first[1] as number) + (second[1] as number)) / 2,
              ((first[2] as number) + (second[2] as number)) / 2,
            );
            this._hasStreamingArenaFocus = true;
          } else if (!this._hasStreamingArenaFocus) {
            const arena = getDuelArenaConfig();
            this._spectatorFocusPos.set(
              arena.baseX + arena.arenaWidth / 2,
              arena.baseY,
              arena.baseZ + arena.arenaLength / 2,
            );
            this._hasStreamingArenaFocus = true;
          }

          const participantIds = [cycle?.agent1?.id, cycle?.agent2?.id].filter(
            (participantId): participantId is string =>
              typeof participantId === "string" && participantId.length > 0,
          );
          const equipmentVisuals = this.world.getSystem?.(
            "equipment-visual",
          ) as
            | {
                isStreamingPreparationPresentationActive?: (
                  playerId: string,
                ) => boolean;
              }
            | undefined;
          const preparationFocus = resolveStreamingPreparationFocus({
            phase: cycle?.phase,
            participantIds,
            resolveEntity: (participantId) =>
              this.world.entities?.get(participantId) as
                StreamingPreparationEntity | undefined,
            isParticipantActive: (participantId, entity) =>
              equipmentVisuals?.isStreamingPreparationPresentationActive?.(
                participantId,
              ) === true || hasActiveStreamingPreparationPresentation(entity),
          });
          if (preparationFocus) {
            this._streamingPreparationFocusPos.set(
              preparationFocus.position.x,
              preparationFocus.position.y,
              preparationFocus.position.z,
            );
            // Keep the arena resident as a secondary center so the transition
            // from preparation into announcement cannot expose terrain pop-in.
            return [
              {
                id: "streaming-preparation-focus",
                position: this._streamingPreparationFocusPos,
              },
              {
                id: "streaming-arena-focus",
                position: this._spectatorFocusPos,
              },
            ];
          }

          return [
            {
              id: "streaming-arena-focus",
              position: this._spectatorFocusPos,
            },
          ];
        }

        // Prefer server-assigned spectator target (snapshot/stream updates),
        // then fall back to URL config hints.
        const followEntityId = (() => {
          const network = this.world.getSystem("network") as {
            getSpectatorFollowEntity?: () => string | undefined;
            spectatorFollowEntity?: string;
          } | null;

          const assignedTarget =
            network?.getSpectatorFollowEntity?.() ??
            network?.spectatorFollowEntity;
          if (typeof assignedTarget === "string" && assignedTarget.length > 0) {
            return assignedTarget;
          }

          if (typeof window === "undefined") return undefined;
          const cfg = (
            window as Window & {
              __HYPERIA_CONFIG__?: {
                followEntity?: string;
                characterId?: string;
              };
            }
          ).__HYPERIA_CONFIG__;
          return cfg?.followEntity || cfg?.characterId;
        })();

        if (followEntityId) {
          const followedEntity =
            this.world.entities?.items?.get(followEntityId) ||
            this.world.entities?.players?.get(followEntityId);
          const followedPos = followedEntity?.position as
            { x: number; y: number; z: number } | undefined;
          if (
            followedPos &&
            Number.isFinite(followedPos.x) &&
            Number.isFinite(followedPos.y) &&
            Number.isFinite(followedPos.z)
          ) {
            this._spectatorFocusPos.set(
              followedPos.x,
              followedPos.y,
              followedPos.z,
            );
            return [{ id: followEntityId, position: this._spectatorFocusPos }];
          }

          // If follow target exists in config but entity hasn't spawned yet,
          // preload around duel lobby instead of origin/camera to avoid
          // "world loads in chunks" artifacts for spectator startup.
          const lobby = getDuelArenaConfig().lobbySpawnPoint;
          this._spectatorFocusPos.set(lobby.x, lobby.y, lobby.z);
          return [{ id: followEntityId, position: this._spectatorFocusPos }];
        }

        const cameraSystem =
          (this.world.getSystem("client-camera-system") as
            | {
                getCameraInfo?: () => {
                  target?: {
                    id?: string;
                    data?: { id?: string };
                    position?: { x: number; y: number; z: number };
                  } | null;
                };
              }
            | undefined) ??
          (this.world.getSystem("client-camera") as
            | {
                getCameraInfo?: () => {
                  target?: {
                    id?: string;
                    data?: { id?: string };
                    position?: { x: number; y: number; z: number };
                  } | null;
                };
              }
            | undefined) ??
          (this.world.getSystem("camera") as
            | {
                getCameraInfo?: () => {
                  target?: {
                    id?: string;
                    data?: { id?: string };
                    position?: { x: number; y: number; z: number };
                  } | null;
                };
              }
            | undefined);

        const target = cameraSystem?.getCameraInfo?.().target;
        const targetPos = target?.position;
        if (
          targetPos &&
          Number.isFinite(targetPos.x) &&
          Number.isFinite(targetPos.y) &&
          Number.isFinite(targetPos.z)
        ) {
          const targetId =
            target?.id || target?.data?.id || "spectator-camera-target";
          this._spectatorFocusPos.set(targetPos.x, targetPos.y, targetPos.z);
          return [{ id: targetId, position: this._spectatorFocusPos }];
        }

        // Fallback to camera position until the target entity is available.
        const cameraPos = this.world.camera?.position;
        if (
          cameraPos &&
          (Math.abs(cameraPos.x) > 1 || Math.abs(cameraPos.z) > 1)
        ) {
          this._spectatorFocusPos.set(cameraPos.x, cameraPos.y, cameraPos.z);
          return [
            { id: "spectator-camera", position: this._spectatorFocusPos },
          ];
        }

        // Final fallback: use duel arena lobby so terrain generates at the
        // arena instead of the world origin when no agents exist yet.
        const lobby = getDuelArenaConfig().lobbySpawnPoint;
        this._spectatorFocusPos.set(lobby.x, lobby.y, lobby.z);
        return [
          { id: "spectator-arena-lobby", position: this._spectatorFocusPos },
        ];
      }
    }

    const players = this.world.getPlayers() || [];
    const centers: Array<{ id: string; position: THREE.Vector3 }> = [];

    // The authoritative duel arena must stay resident even while scripted
    // fighters return to their ordinary spawn points between cycles. Without
    // this fixed center, every phase transition swaps the server between two
    // terrain regions and the generation queue never reaches idle.
    if (
      this.runtimeIsServer &&
      typeof process !== "undefined" &&
      process.env.STREAMING_DUEL_ENABLED === "true"
    ) {
      const lobby = getDuelArenaConfig().lobbySpawnPoint;
      this._spectatorFocusPos.set(lobby.x, lobby.y, lobby.z);
      centers.push({
        id: "server-arena-lobby",
        position: this._spectatorFocusPos,
      });
    }

    for (const player of players) {
      if (!player?.node?.position) continue;

      // Server-owned agents are transient simulation actors, not independent
      // terrain viewers. One fixed arena center covers duel simulation while
      // human players retain normal position-based terrain streaming.
      const playerFlags = player as unknown as {
        isAgent?: boolean;
        isEmbeddedAgent?: boolean;
        data?: { isAgent?: boolean; isEmbeddedAgent?: boolean };
      };
      const isAgent =
        playerFlags.isAgent === true ||
        playerFlags.isEmbeddedAgent === true ||
        playerFlags.data?.isAgent === true ||
        playerFlags.data?.isEmbeddedAgent === true;
      if (this.runtimeIsServer && isAgent) continue;

      centers.push({
        id: player.id || "player",
        position: player.node.position,
      });
    }

    // If no players at all (spectator on server, or empty world), use arena lobby.
    if (centers.length === 0) {
      const lobby = getDuelArenaConfig().lobbySpawnPoint;
      this._spectatorFocusPos.set(lobby.x, lobby.y, lobby.z);
      return [
        {
          id: this.runtimeIsClient
            ? "spectator-arena-lobby"
            : "server-arena-lobby",
          position: this._spectatorFocusPos,
        },
      ];
    }

    return centers;
  }

  private loadInitialTiles(): void {
    let _tilesGenerated = 0;

    // Generate initial grid around the active terrain center.
    const centers = this.getTerrainCenters();
    const centerPos =
      centers[0]?.position ??
      this.world.camera?.position ??
      new THREE.Vector3(0, 0, 0);

    const centerTileX = this.worldToTerrainTileIndex(centerPos.x);
    const centerTileZ = this.worldToTerrainTileIndex(centerPos.z);

    // Full-content core range + terrain-only ring (preload around player)
    const coreRange = this.coreChunkRange;
    const ringRange = Math.max(this.ringChunkRange, coreRange);

    let fullTiles = 0;
    let terrainOnlyTiles = 0;

    for (let dx = -ringRange; dx <= ringRange; dx++) {
      for (let dz = -ringRange; dz <= ringRange; dz++) {
        const generateContent =
          Math.abs(dx) <= coreRange && Math.abs(dz) <= coreRange;
        const tile = this.generateTile(
          centerTileX + dx,
          centerTileZ + dz,
          generateContent,
        );
        _tilesGenerated++;
        if (generateContent) fullTiles++;
        else terrainOnlyTiles++;
      }
    }

    // External-value duel agents must be able to bank, train, and gather as
    // soon as the authoritative server becomes ready. The arena is hundreds
    // of metres from the compact preparation complex, so its initial 5x5 grid
    // does not bake the preparation pond. Generate every manifest tile that
    // intersects the launch preparation areas before ResourceSystem starts;
    // the explicit resident-tile set in updatePlayerBasedTerrain keeps them.
    let launchPreparationTiles = 0;
    const preparationTileKeys = new Set<string>();
    this.addServerLaunchPreparationTiles(preparationTileKeys);
    for (const key of preparationTileKeys) {
      const resident = this.terrainTiles.get(key);
      if (resident) {
        this.enqueueTileForGeneration(resident.x, resident.z, true);
        continue;
      }
      const [tileX, tileZ] = key.split("_").map(Number);
      this.generateTile(tileX, tileZ, true);
      _tilesGenerated++;
      fullTiles++;
      launchPreparationTiles++;
    }

    // Debug: Log flat zone statistics
    console.log(
      `[TerrainSystem] Initial tiles generated around (${centerTileX}, ${centerTileZ}). ` +
        `Tiles: ${_tilesGenerated} (full=${fullTiles}, terrain-only=${terrainOnlyTiles}). ` +
        `Launch preparation tiles: ${launchPreparationTiles}. ` +
        `Flat zones: ${this.flatZones.size} zones, ` +
        `${this.flatZonesByTile.size} tile keys, ` +
        `${this._flatZoneHitCount} height lookups used flat zones`,
    );

    // Mark initial tiles as ready
    this.lastPlayerTile = { x: centerTileX, z: centerTileZ };
    this._initialTilesReady = true;
  }

  private generateTile(
    tileX: number,
    tileZ: number,
    generateContent = true,
  ): TerrainTile {
    const key = `${tileX}_${tileZ}`;

    // Check if tile already exists
    if (this.terrainTiles.has(key)) {
      this.enqueueTileForGeneration(tileX, tileZ, generateContent);
      return this.terrainTiles.get(key)!;
    }

    // Create geometry for this tile
    const geometry = this.createTileGeometry(tileX, tileZ);

    // Use triplanar terrain shader material (or fallback to vertex colors)
    const material = this.getTerrainMaterial();

    // Create mesh
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      tileX * this.CONFIG.TILE_SIZE,
      0,
      tileZ * this.CONFIG.TILE_SIZE,
    );
    mesh.name = `Terrain_${key}`;

    mesh.receiveShadow = this.CONFIG.TERRAIN_RECEIVE_SHADOW && !isCsmEnabled();
    mesh.castShadow = this.CONFIG.TERRAIN_CAST_SHADOW;

    // Enable frustum culling (Three.js built-in)
    mesh.frustumCulled = true;

    // Add userData for click-to-move detection and other systems
    mesh.userData = {
      type: "terrain",
      walkable: true,
      clickable: true,
      biome: this.getBiomeAt(tileX, tileZ),
      tileKey: key,
      tileX: tileX,
      tileZ: tileZ,
    };

    // Generate collision only on server when mesh collision is enabled.
    // Dev defaults disable this to avoid heavy PhysX triangle mesh memory use.
    const collision: PMeshHandle | null = null;
    const isServer = this.world.network?.isServer || false;
    if (isServer && this.serverMeshCollisionEnabled) {
      const collisionKey = `${tileX}_${tileZ}`;
      if (!this.pendingCollisionSet.has(collisionKey)) {
        this.pendingCollisionSet.add(collisionKey);
        this.pendingCollisionKeys.push(collisionKey);
      }
    }

    // Create tile object
    const tile: TerrainTile = {
      key,
      x: tileX,
      z: tileZ,
      mesh,
      collision: collision || null,
      biome: this.getBiomeAt(tileX, tileZ) as TerrainTile["biome"],
      resources: [],
      roads: [],
      generated: true,
      contentGenerated: false,
      lastActiveTime: new Date(),
      playerCount: 0,
      needsSave: true,
      waterMeshes: [],
      heightData: [],
      chunkSeed: 0,
      heightMap: new Float32Array(0),
      collider: null,
      lastUpdate: Date.now(),
    };

    // Add simple physics plane for the terrain tile (for raycasting).
    // Client-only to avoid server-side rigid-body explosion in large worlds.
    const physics = this.world.physics;
    const PHYSX = getPhysX();

    // Create a simple plane at the average height of the terrain
    // This is sufficient for click-to-move raycasting
    const positionAttribute = geometry.attributes.position;
    const vertices = positionAttribute.array as Float32Array;

    // Calculate average height and bounds
    let minY = Infinity;
    let maxY = -Infinity;
    let avgY = 0;
    const vertexCount = positionAttribute.count;

    for (let i = 0; i < vertexCount; i++) {
      const y = vertices[i * 3 + 1]; // Y is at index 1 in each vertex
      avgY += y;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    avgY /= vertexCount;

    // Create a box shape that covers the terrain tile
    // Use a thicker box to ensure proper collision
    const heightRange = maxY - minY;
    const boxThickness = Math.max(5, heightRange * 0.5); // At least 5 units thick or half the height range
    const halfExtents = {
      x: this.CONFIG.TILE_SIZE / 2, // Half width
      y: boxThickness / 2, // Half thickness of the collision box
      z: this.CONFIG.TILE_SIZE / 2, // Half depth
    };
    if (this.runtimeIsClient && physics && PHYSX) {
      const boxGeometry = new PHYSX!.PxBoxGeometry(
        halfExtents.x,
        halfExtents.y,
        halfExtents.z,
      );

      // Create material and shape
      const physicsMaterial = physics.physics.createMaterial(0.5, 0.5, 0.1);
      const shape = physics.physics.createShape(
        boxGeometry,
        physicsMaterial,
        true,
      );

      // Set the terrain to the 'terrain' layer
      const terrainLayer = Layers.terrain;
      if (terrainLayer) {
        // For filter data:
        // word0 = what group this shape belongs to (terrain.group)
        // word1 = what groups can query/hit this shape (0xFFFFFFFF allows all)
        // This allows raycasts with any layer mask to hit terrain
        const filterData = new PHYSX!.PxFilterData(
          terrainLayer.group,
          0xffffffff,
          0,
          0,
        );
        shape.setQueryFilterData(filterData);

        // For simulation, use the terrain's actual collision mask
        const simFilterData = new PHYSX!.PxFilterData(
          terrainLayer.group,
          terrainLayer.mask,
          0,
          0,
        );
        shape.setSimulationFilterData(simFilterData);
      }

      // Create actor at tile position with average height
      const transform = new PHYSX!.PxTransform(
        new PHYSX!.PxVec3(
          mesh.position.x + this.CONFIG.TILE_SIZE / 2, // Center of tile
          avgY, // Average terrain height
          mesh.position.z + this.CONFIG.TILE_SIZE / 2, // Center of tile
        ),
        new PHYSX!.PxQuat(0, 0, 0, 1),
      );
      const actor = physics.physics.createRigidStatic(transform);
      actor.attachShape(shape);

      const handle: PhysicsHandle = {
        tag: `terrain_${tile.key}`,
        contactedHandles: new Set<PhysicsHandle>(),
        triggeredHandles: new Set<PhysicsHandle>(),
      };
      tile.collider = physics.addActor(actor, handle);
    }

    // Add to scene if client-side (skip when quad-tree LOD handles visual rendering)
    if (this.terrainContainer && !this.CONFIG.USE_QUADTREE_LOD) {
      this.terrainContainer.add(mesh);
    }

    this.terrainTiles.set(key, tile);
    this.activeChunks.add(key);
    if (generateContent) this.generateTileContent(tile);
    this.emitTileGenerated(tile);

    if (this.destroyed || this.terrainTiles.get(key) !== tile) return tile;

    // Store height data NOW that the tile is in the map.
    // createTileGeometry attaches heightData to geometry.userData because
    // storeHeightData requires the tile to exist in terrainTiles.
    if (geometry.userData.heightData) {
      tile.heightData = geometry.userData.heightData;
      tile.needsSave = true;
    }

    // Synchronously bake WATER and STEEP_SLOPE collision flags (server-only).
    // Must complete before any movement query can reach this tile, otherwise
    // players can walk into water during the gap between tile generation and
    // flag baking. ~1-2ms per tile (10K height lookups with cached data).
    if (isServer) {
      this.bakeWalkabilityFlags(tileX, tileZ);
    }

    return tile;
  }

  /**
   * Get or create the template geometry (shared structure, cloned per tile)
   * PERFORMANCE: Creating PlaneGeometry from scratch is expensive - clone template instead
   */
  private getOrCreateTemplateGeometry(): THREE.PlaneGeometry {
    if (!this.templateGeometry) {
      this.templateGeometry = new THREE.PlaneGeometry(
        this.CONFIG.TILE_SIZE,
        this.CONFIG.TILE_SIZE,
        this.CONFIG.TILE_RESOLUTION - 1,
        this.CONFIG.TILE_RESOLUTION - 1,
      );
      this.templateGeometry.rotateX(-Math.PI / 2);

      // Pre-allocate reusable buffers
      const vertexCount = this.templateGeometry.attributes.position.count;
      this.templateColors = new Float32Array(vertexCount * 3);
      this.templateBiomeIds = new Float32Array(vertexCount);
    }
    return this.templateGeometry;
  }

  private createTileGeometry(
    tileX: number,
    tileZ: number,
  ): THREE.PlaneGeometry {
    // PERFORMANCE: Clone template geometry instead of creating new PlaneGeometry
    const template = this.getOrCreateTemplateGeometry();
    const geometry = template.clone();

    const positions = geometry.attributes.position;
    const positionsArray = positions.array as Float32Array;
    const heightData: number[] = [];

    // Generate heightmap — needed on both server and client
    // IMPORTANT: Always use getHeightAtComputed during tile generation to ensure
    // deterministic heights. Cached heights (from other tiles) use bilinear interpolation
    // which can differ slightly from computed values, causing seams at ANY position
    // where the shoreline adjustment samples across tile boundaries.
    for (let i = 0; i < positions.count; i++) {
      const i3 = i * 3;
      const x = positionsArray[i3] + tileX * this.CONFIG.TILE_SIZE;
      const z = positionsArray[i3 + 2] + tileZ * this.CONFIG.TILE_SIZE;

      const height = this.getHeightAtComputed(x, z);
      positionsArray[i3 + 1] = height;
      heightData.push(height);
    }

    // Compute normals from overflow height grid (centered differences).
    // Passes the already-computed heightData to avoid recomputing interior heights.
    this.computeHeightFieldNormals(geometry, tileX, tileZ, heightData);
    // Carve terrain triangles inside building flat zones to avoid overdraw
    this.applyFlatZoneCarve(geometry, tileX, tileZ);

    // Attach heightData to geometry so the caller can store it AFTER the tile
    // is added to terrainTiles (storeHeightData requires the tile to exist).
    geometry.userData.heightData = heightData;

    // SERVER: Skip all visual-only attributes (colors, biomeIds, roadInfluences,
    // forestWeights, canyonWeights) and the expensive per-vertex biome/color
    // computation. The server only needs heights, normals, and flat zone carving.
    // This reduces per-tile memory by ~80% and eliminates GC pressure from
    // Float32Array allocations that caused tick death spirals with 25+ agents.
    if (this.runtimeIsServer) {
      return geometry;
    }

    // CLIENT: Visual attribute generation (shader computes colors procedurally)
    const biomeIds = new Float32Array(positions.count);
    const roadInfluences = new Float32Array(positions.count);
    const forestWeights = new Float32Array(positions.count);
    const canyonWeights = new Float32Array(positions.count);

    for (let i = 0; i < positions.count; i++) {
      const i3 = i * 3;
      const x = positionsArray[i3] + tileX * this.CONFIG.TILE_SIZE;
      const z = positionsArray[i3 + 2] + tileZ * this.CONFIG.TILE_SIZE;

      const { biomeWeightMap, totalWeight } =
        this.computeBiomeWeightsAtPosition(x, z);

      let dominantBiome = DEFAULT_BIOME as string;
      let dominantWeight = -Infinity;

      if (totalWeight > 0) {
        const invW = 1 / totalWeight;
        for (const [type, rawWeight] of biomeWeightMap) {
          const weight = rawWeight * invW;
          if (weight > dominantWeight) {
            dominantWeight = weight;
            dominantBiome = type;
          }
        }
        forestWeights[i] = (biomeWeightMap.get(BiomeType.Forest) || 0) * invW;
        canyonWeights[i] = (biomeWeightMap.get(BiomeType.Canyon) || 0) * invW;
      }
      biomeIds[i] = this.getBiomeId(dominantBiome);

      roadInfluences[i] = this.calculateRoadInfluenceAtVertex(
        x,
        z,
        tileX,
        tileZ,
      );
    }

    geometry.setAttribute("biomeId", new THREE.BufferAttribute(biomeIds, 1));
    geometry.setAttribute(
      "roadInfluence",
      new THREE.BufferAttribute(roadInfluences, 1),
    );
    geometry.setAttribute(
      "biomeForestWeight",
      new THREE.BufferAttribute(forestWeights, 1),
    );
    geometry.setAttribute(
      "biomeCanyonWeight",
      new THREE.BufferAttribute(canyonWeights, 1),
    );

    // DEBUG: log biome weights for first 5 sync tiles
    if (this._loggedSyncTileBiome < 5) {
      this._loggedSyncTileBiome++;
      let sumF = 0,
        sumD = 0;
      for (let _d = 0; _d < forestWeights.length; _d++) {
        sumF += forestWeights[_d];
        sumD += canyonWeights[_d];
      }
      const n = forestWeights.length;
      const avgP = (1 - sumF / n - sumD / n).toFixed(3);
      console.log(
        `[BiomeDebug/SyncTile] Tile(${tileX},${tileZ}) plains=${avgP} forest=${(sumF / n).toFixed(3)} canyon=${(sumD / n).toFixed(3)}`,
      );
    }

    if (TERRAIN_ROAD_INFLUENCE_DEBUG) {
      let nonZeroCount = 0;
      let maxInfluence = 0;
      for (let i = 0; i < roadInfluences.length; i++) {
        if (roadInfluences[i] > 0) {
          nonZeroCount++;
          maxInfluence = Math.max(maxInfluence, roadInfluences[i]);
        }
      }
      if (nonZeroCount > 0) {
        console.log(
          `[TerrainSystem] Tile (${tileX}, ${tileZ}): ${nonZeroCount}/${roadInfluences.length} vertices with road influence, max=${maxInfluence.toFixed(3)}`,
        );
      }
    }

    return geometry;
  }

  // Track which tiles we've logged road segment info for (to avoid spam)
  private _loggedTileSegments = new Set<string>();

  /**
   * Calculate road influence at a vertex position
   * Returns 0-1 where 1 = center of road, 0 = no road
   *
   * COORDINATE SYSTEM NOTE:
   * - Terrain tiles are centered: tile (0,0) covers world X/Z = -50 to +50
   * - Road tiles use origin-based: tile (0,0) covers world X/Z = 0 to 100
   * - We must convert world coords to road tile coords for correct lookup
   */
  private calculateRoadInfluenceAtVertex(
    worldX: number,
    worldZ: number,
    _tileX: number, // Terrain tile X (unused - we compute road tile from world coords)
    _tileZ: number, // Terrain tile Z (unused - we compute road tile from world coords)
  ): number {
    // Lazy-load road system reference
    this.roadNetworkSystem ??= this.world.getSystem("roads") as
      RoadNetworkSystem | undefined;
    if (!this.roadNetworkSystem) return 0;

    // Convert world coordinates to road tile coordinates
    // Road system uses origin-based tiles: tile (0,0) = world X/Z 0 to 100
    const roadTileX = Math.floor(worldX / this.CONFIG.TILE_SIZE);
    const roadTileZ = Math.floor(worldZ / this.CONFIG.TILE_SIZE);
    let segments: ReadonlyArray<RoadTileSegment>;
    if (
      roadTileX === this._cachedRoadTileX &&
      roadTileZ === this._cachedRoadTileZ
    ) {
      segments = this._cachedRoadSegments;
    } else {
      segments = this.roadNetworkSystem.getRoadSegmentsForTile(
        roadTileX,
        roadTileZ,
      );
      this._cachedRoadTileX = roadTileX;
      this._cachedRoadTileZ = roadTileZ;
      this._cachedRoadSegments = segments;
    }

    if (TERRAIN_ROAD_INFLUENCE_DEBUG) {
      const debugKey = `road_${roadTileX}_${roadTileZ}`;
      if (!this._loggedTileSegments.has(debugKey)) {
        this._loggedTileSegments.add(debugKey);
        if (segments.length > 0) {
          console.log(
            `[TerrainSystem] Road tile (${roadTileX}, ${roadTileZ}) has ${segments.length} road segments`,
          );
        }
      }
    }

    if (segments.length === 0) return 0;

    // Convert world coords to road-tile-local coordinates (0 to TILE_SIZE range)
    const localX = worldX - roadTileX * this.CONFIG.TILE_SIZE;
    const localZ = worldZ - roadTileZ * this.CONFIG.TILE_SIZE;

    // Union actual path widths; a nearer narrow spur must not erase a wider
    // path at their junction. This is also used by the worker and road mask.
    let influence = 0;
    for (const segment of segments) {
      influence = Math.max(
        influence,
        roadInfluenceOperations.sampleSegment(
          localX,
          localZ,
          segment.start.x,
          segment.start.z,
          segment.end.x,
          segment.end.z,
          segment.width,
          ROAD_BLEND_WIDTH,
        ),
      );
      if (influence === 1) return 1;
    }
    return influence;
  }

  /**
   * Calculate squared distance from point to line segment (local coordinates)
   */
  private distanceToLineSegmentLocalSq(
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

    if (lengthSq === 0) {
      // Segment is a point
      const ddx = px - x1;
      const ddz = pz - z1;
      return ddx * ddx + ddz * ddz;
    }

    // Project point onto segment
    const t = Math.max(
      0,
      Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / lengthSq),
    );

    const projX = x1 + t * dx;
    const projZ = z1 + t * dz;

    const ddx = px - projX;
    const ddz = pz - projZ;
    return ddx * ddx + ddz * ddz;
  }

  /**
   * Calculate distance from point to line segment (local coordinates)
   */
  private distanceToLineSegmentLocal(
    px: number,
    pz: number,
    x1: number,
    z1: number,
    x2: number,
    z2: number,
  ): number {
    return Math.sqrt(this.distanceToLineSegmentLocalSq(px, pz, x1, z1, x2, z2));
  }

  /**
   * Initialize GPU compute context from renderer.
   * Should be called when the WebGPU renderer is available.
   */
  public initializeGPUCompute(renderer: THREE.WebGPURenderer): boolean {
    if (!this.terrainComputeContext) {
      return false;
    }

    try {
      this.gpuComputeAvailable =
        this.terrainComputeContext.initializeFromRenderer(renderer);
      if (this.gpuComputeAvailable) {
        console.log("[TerrainSystem] GPU compute initialized successfully");
      }
      return this.gpuComputeAvailable;
    } catch (error) {
      console.warn("[TerrainSystem] GPU compute initialization failed:", error);
      this.gpuComputeAvailable = false;
      return false;
    }
  }

  /**
   * Compute road influence for all vertices in a tile using GPU.
   * Falls back to CPU if GPU is not available.
   *
   * @param vertices - Float32Array of [localX, localZ, ...] pairs
   * @param tileX - Tile X coordinate
   * @param tileZ - Tile Z coordinate
   * @returns Float32Array of influence values (0-1) per vertex
   */
  private async computeRoadInfluenceBatchGPU(
    vertices: Float32Array,
    tileX: number,
    tileZ: number,
  ): Promise<Float32Array | null> {
    // Get road segments
    this.roadNetworkSystem ??= this.world.getSystem("roads") as
      RoadNetworkSystem | undefined;
    if (!this.roadNetworkSystem) return null;

    const segments = this.roadNetworkSystem.getRoadSegmentsForTile(
      tileX,
      tileZ,
    );
    if (segments.length === 0) return null;

    const vertexCount = vertices.length / 2;

    // Check if GPU should be used
    if (
      this.gpuComputeAvailable &&
      this.terrainComputeContext &&
      this.terrainComputeContext.shouldUseGPUForRoadInfluence(
        vertexCount,
        segments.length,
      )
    ) {
      try {
        // Convert segments to GPU format
        const gpuRoads: GPURoadSegment[] = segments.map((seg) => ({
          startX: seg.start.x,
          startZ: seg.start.z,
          endX: seg.end.x,
          endZ: seg.end.z,
          width: seg.width,
        }));

        const tileOffset = {
          x: tileX * this.CONFIG.TILE_SIZE,
          z: tileZ * this.CONFIG.TILE_SIZE,
        };

        // Use GPU compute
        const influences =
          await this.terrainComputeContext.computeRoadInfluence(
            vertices,
            gpuRoads,
            tileOffset,
          );

        return influences;
      } catch (error) {
        console.warn(
          "[TerrainSystem] GPU road influence failed, falling back to CPU:",
          error,
        );
        // Fall through to CPU computation
      }
    }

    // CPU fallback
    return this.computeRoadInfluenceBatchCPU(vertices, tileX, tileZ, segments);
  }

  /**
   * Compute road influence for all vertices using CPU (fallback).
   */
  private computeRoadInfluenceBatchCPU(
    vertices: Float32Array,
    tileX: number,
    tileZ: number,
    segments: Array<{
      start: { x: number; z: number };
      end: { x: number; z: number };
      width: number;
    }>,
  ): Float32Array {
    const vertexCount = vertices.length / 2;
    const influences = new Float32Array(vertexCount);

    for (let i = 0; i < vertexCount; i++) {
      const localX = vertices[i * 2];
      const localZ = vertices[i * 2 + 1];

      let influence = 0;
      for (const segment of segments) {
        influence = Math.max(
          influence,
          roadInfluenceOperations.sampleSegment(
            localX,
            localZ,
            segment.start.x,
            segment.start.z,
            segment.end.x,
            segment.end.z,
            segment.width,
            ROAD_BLEND_WIDTH,
          ),
        );
        if (influence === 1) break;
      }
      influences[i] = influence;
    }

    return influences;
  }

  /**
   * Refresh vertex colors for all loaded tiles
   * Called when road network becomes available to apply road coloring
   *
   * MAIN THREAD PROTECTION: Processes tiles in batches with yielding
   * to prevent frame drops during road color updates.
   */
  /**
   * Refresh road influence for all loaded terrain tiles.
   * Called when road network becomes available to apply road coloring.
   *
   * NOTE: The terrain shader uses the `roadInfluence` attribute for road coloring,
   * NOT vertex colors. Colors are computed procedurally in the shader from height/slope/noise.
   *
   * MAIN THREAD PROTECTION: Processes tiles in batches with yielding.
   */
  private async refreshRoadInfluence(): Promise<void> {
    const generation = ++this.roadInfluenceRefreshGeneration;
    if (this.destroyed) return;
    const roadNetwork = this.roadNetworkSystem;
    if (!roadNetwork) {
      console.warn(
        "[TerrainSystem] Cannot refresh road influence - road system not available",
      );
      return;
    }
    const isCurrent = (): boolean =>
      !this.destroyed &&
      generation === this.roadInfluenceRefreshGeneration &&
      this.roadNetworkSystem === roadNetwork;

    // Invalidate per-tile road segment lookup cache before recomputing attributes.
    this._cachedRoadTileX = Number.NaN;
    this._cachedRoadTileZ = Number.NaN;
    this._cachedRoadSegments = [];

    const roads = roadNetwork.getRoads();
    console.log(
      `[TerrainSystem] Refreshing road influence for ${this.terrainTiles.size} tiles (${roads.length} roads in network)`,
    );

    // Capture mesh/geometry ownership as well as the map entry: a tile can be
    // regenerated in place while a batch is yielding.
    const tiles = Array.from(this.terrainTiles, ([key, tile]) => ({
      key,
      tile,
      mesh: tile.mesh,
      geometry: tile.mesh?.geometry,
      parent: tile.mesh?.parent,
    }));
    const TILES_PER_BATCH = 4; // Process 4 tiles per batch
    let tilesUpdated = 0;
    let totalVerticesWithRoads = 0;

    for (let tileIdx = 0; tileIdx < tiles.length; tileIdx += TILES_PER_BATCH) {
      if (!isCurrent()) return;
      const batchEnd = Math.min(tileIdx + TILES_PER_BATCH, tiles.length);

      for (let t = tileIdx; t < batchEnd; t++) {
        const { key, tile, mesh, geometry, parent } = tiles[t];
        if (
          !isCurrent() ||
          this.terrainTiles.get(key) !== tile ||
          !mesh ||
          tile.mesh !== mesh ||
          mesh.geometry !== geometry ||
          mesh.parent !== parent ||
          !geometry
        )
          continue;

        const tileX = tile.x;
        const tileZ = tile.z;

        // Terrain tile (tileX, tileZ) covers world coords:
        // X: (tileX * TILE_SIZE - TILE_SIZE/2) to (tileX * TILE_SIZE + TILE_SIZE/2)
        // This overlaps road tiles: floor(worldMin/TILE_SIZE) to floor(worldMax/TILE_SIZE)
        const halfTile = this.CONFIG.TILE_SIZE / 2;
        const worldMinX = tileX * this.CONFIG.TILE_SIZE - halfTile;
        const worldMaxX = tileX * this.CONFIG.TILE_SIZE + halfTile;
        const worldMinZ = tileZ * this.CONFIG.TILE_SIZE - halfTile;
        const worldMaxZ = tileZ * this.CONFIG.TILE_SIZE + halfTile;

        const roadTileMinX = Math.floor(worldMinX / this.CONFIG.TILE_SIZE);
        const roadTileMaxX = Math.floor(worldMaxX / this.CONFIG.TILE_SIZE);
        const roadTileMinZ = Math.floor(worldMinZ / this.CONFIG.TILE_SIZE);
        const roadTileMaxZ = Math.floor(worldMaxZ / this.CONFIG.TILE_SIZE);

        // Check if ANY overlapping road tile has segments
        let hasRoadSegments = false;
        for (
          let rx = roadTileMinX;
          rx <= roadTileMaxX && !hasRoadSegments;
          rx++
        ) {
          for (
            let rz = roadTileMinZ;
            rz <= roadTileMaxZ && !hasRoadSegments;
            rz++
          ) {
            const segments = roadNetwork.getRoadSegmentsForTile(rx, rz);
            if (segments.length > 0) hasRoadSegments = true;
          }
        }
        if (!hasRoadSegments) continue;

        // Get geometry and roadInfluence attribute
        const positions = geometry.attributes.position;
        const roadInfluenceAttr = geometry.getAttribute("roadInfluence");
        if (!positions || !(roadInfluenceAttr instanceof THREE.BufferAttribute))
          continue;

        const positionArray = positions.array as Float32Array;
        const roadInfluenceArray = roadInfluenceAttr.array as Float32Array;
        let verticesWithRoadInfluence = 0;

        // Update road influence for each vertex
        for (let i = 0; i < positions.count; i++) {
          const i3 = i * 3;
          const localX = positionArray[i3];
          const localZ = positionArray[i3 + 2];
          const worldX = localX + tileX * this.CONFIG.TILE_SIZE;
          const worldZ = localZ + tileZ * this.CONFIG.TILE_SIZE;

          const influence = this.calculateRoadInfluenceAtVertex(
            worldX,
            worldZ,
            tileX,
            tileZ,
          );
          roadInfluenceArray[i] = influence;
          if (influence > 0) verticesWithRoadInfluence++;
        }

        // Mark attribute as needing GPU update
        roadInfluenceAttr.needsUpdate = true;
        tilesUpdated++;
        totalVerticesWithRoads += verticesWithRoadInfluence;
      }

      // Yield to main thread between batches
      if (batchEnd < tiles.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!isCurrent()) return;
      }
    }

    if (!isCurrent()) return;

    console.log(
      `[TerrainSystem] Road influence refresh (tiles): ${tilesUpdated}/${tiles.length} tiles updated, ${totalVerticesWithRoads} vertices with road influence`,
    );

    // Also refresh quad-tree LOD chunks if enabled
    const visualManager = this.quadTreeVisualManager;
    if (visualManager) {
      let quadChunksUpdated = 0;
      let quadVerticesWithRoads = 0;
      const chunks = visualManager.getChunks();
      const chunkEntries = Array.from(chunks, ([key, chunk]) => ({
        key,
        chunk,
        mesh: chunk.mesh,
        geometry: chunk.mesh.geometry,
        parent: chunk.mesh.parent,
      }));
      const CHUNKS_PER_BATCH = 4;

      for (let ci = 0; ci < chunkEntries.length; ci += CHUNKS_PER_BATCH) {
        if (!isCurrent() || this.quadTreeVisualManager !== visualManager)
          return;
        const batchEnd = Math.min(ci + CHUNKS_PER_BATCH, chunkEntries.length);

        for (let c = ci; c < batchEnd; c++) {
          const { key, chunk, mesh, geometry, parent } = chunkEntries[c];
          if (
            !isCurrent() ||
            this.quadTreeVisualManager !== visualManager ||
            chunks.get(key) !== chunk ||
            chunk.mesh !== mesh ||
            mesh.geometry !== geometry ||
            !parent ||
            mesh.parent !== parent
          )
            continue;

          const positions = geometry.attributes.position;
          const roadInfluenceAttr = geometry.getAttribute("roadInfluence");
          if (
            !positions ||
            !(roadInfluenceAttr instanceof THREE.BufferAttribute)
          )
            continue;

          const posArray = positions.array as Float32Array;
          const roadArray = roadInfluenceAttr.array as Float32Array;
          const cx = mesh.position.x;
          const cz = mesh.position.z;
          let vertsWithRoad = 0;

          for (let i = 0; i < positions.count; i++) {
            const worldX = posArray[i * 3] + cx;
            const worldZ = posArray[i * 3 + 2] + cz;
            const roadTileX = Math.floor(worldX / this.CONFIG.TILE_SIZE);
            const roadTileZ = Math.floor(worldZ / this.CONFIG.TILE_SIZE);
            const influence = this.calculateRoadInfluenceAtVertex(
              worldX,
              worldZ,
              roadTileX,
              roadTileZ,
            );
            roadArray[i] = influence;
            if (influence > 0) vertsWithRoad++;
          }

          roadInfluenceAttr.needsUpdate = true;
          quadChunksUpdated++;
          quadVerticesWithRoads += vertsWithRoad;
        }

        if (batchEnd < chunkEntries.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (!isCurrent() || this.quadTreeVisualManager !== visualManager)
            return;
        }
      }

      console.log(
        `[TerrainSystem] Road influence refresh (quadtree): ${quadChunksUpdated}/${chunkEntries.length} chunks updated, ${quadVerticesWithRoads} vertices with road influence`,
      );
    }
  }

  /**
   * Map biome name to numeric ID for shader
   */
  private getBiomeId(biomeName: string): number {
    const biomeIds: Record<string, number> = {
      tundra: 0,
      forest: 1,
      canyon: 2,
    };
    return biomeIds[biomeName] ?? 0;
  }

  private getIslandMask(worldX: number, worldZ: number): number {
    this.ensureNoiseInitialized();
    return computeIslandMask(
      worldX,
      worldZ,
      this.noise,
      this.getWorldTerrainProfile(),
    );
  }

  /**
   * Get base terrain height WITHOUT mountain biome boost.
   * Delegates to the single source of truth in TerrainHeightParams.
   */
  private ensureNoiseInitialized(): void {
    if (!this.noise) {
      const seed = this.computeSeedFromWorldId();
      this.noise = new NoiseGenerator(seed);
      for (const [key, cfg] of Object.entries(BIOME_CONFIGS)) {
        const base = seed + cfg.seedOffset;
        this.biomeNoiseSets[key] = {
          main: new NoiseGenerator(base),
          variation: new NoiseGenerator(base + 4),
          erosion: new NoiseGenerator(base + 1),
        };
      }
    }
  }

  private getBaseHeightAt(
    worldX: number,
    worldZ: number,
    biomeWeights?: Record<string, number>,
  ): number {
    this.ensureNoiseInitialized();

    const weights =
      biomeWeights ?? this.computeBiomeWeightsByPosition(worldX, worldZ);
    return computeBaseHeight(
      worldX,
      worldZ,
      this.noise,
      this.biomeNoiseSets,
      weights,
      this.getWorldTerrainProfile(),
    );
  }

  private getHeightAtWithoutShore(worldX: number, worldZ: number): number {
    this.ensureNoiseInitialized();
    return this.getBaseHeightAt(worldX, worldZ);
  }

  /**
   * Get procedural terrain height.
   * This bypasses flat zones and returns the raw procedural height.
   * Useful for positioning objects that should sit above the terrain mesh.
   */
  getProceduralHeightAt(worldX: number, worldZ: number): number {
    return this.getBaseHeightAt(worldX, worldZ);
  }

  private calculateBaseSlopeAt(
    worldX: number,
    worldZ: number,
    centerHeight: number,
  ): number {
    const checkDistance = this.shorelineParameters.SLOPE_SAMPLE_DISTANCE;
    const northHeight = this.getHeightAtWithoutShore(
      worldX,
      worldZ + checkDistance,
    );
    const southHeight = this.getHeightAtWithoutShore(
      worldX,
      worldZ - checkDistance,
    );
    const eastHeight = this.getHeightAtWithoutShore(
      worldX + checkDistance,
      worldZ,
    );
    const westHeight = this.getHeightAtWithoutShore(
      worldX - checkDistance,
      worldZ,
    );

    const slopes = [
      Math.abs(northHeight - centerHeight) / checkDistance,
      Math.abs(southHeight - centerHeight) / checkDistance,
      Math.abs(eastHeight - centerHeight) / checkDistance,
      Math.abs(westHeight - centerHeight) / checkDistance,
    ];

    return Math.max(...slopes);
  }

  private _shorelineConfig: ShorelineConfig | null = null;

  private getShorelineConfig(): ShorelineConfig {
    if (!this._shorelineConfig) {
      this._shorelineConfig = {
        waterThreshold: this.CONFIG.WATER_THRESHOLD,
        shorelineLandBand: this.shorelineParameters.LAND_BAND,
        shorelineUnderwaterBand: this.shorelineParameters.UNDERWATER_BAND,
        shorelineMinSlope: this.shorelineParameters.MIN_SLOPE,
        shorelineLandMaxMultiplier:
          this.shorelineParameters.LAND_MAX_MULTIPLIER,
        underwaterDepthMultiplier:
          this.shorelineParameters.UNDERWATER_DEPTH_MULTIPLIER,
      };
    }
    return this._shorelineConfig;
  }

  private adjustHeightForShoreline(baseHeight: number, slope: number): number {
    return adjustShorelineHeight(baseHeight, slope, this.getShorelineConfig());
  }

  // ============================================================================
  // WORLD ↔ TILE COORDINATE HELPERS (Single source of truth)
  //
  // Terrain geometry is CENTERED at (tileX * TILE_SIZE, 0, tileZ * TILE_SIZE).
  // PlaneGeometry vertices range from -TILE_SIZE/2 to +TILE_SIZE/2.
  // So terrain tile N covers world coords [(N-0.5)*SIZE, (N+0.5)*SIZE).
  //
  // heightData is row-major: heightData[iz * RESOLUTION + ix], where
  //   ix=0 → geom_x = -TILE_SIZE/2,  ix=RESOLUTION-1 → geom_x = +TILE_SIZE/2
  // ============================================================================

  /**
   * World coordinate → terrain tile index (accounts for centered geometry).
   * Tile N's geometry spans world [(N-0.5)*SIZE, (N+0.5)*SIZE).
   */
  private worldToTerrainTileIndex(worldCoord: number): number {
    return centeredTerrainTileIndex(worldCoord, this.CONFIG.TILE_SIZE);
  }

  /**
   * Geometry-local coordinate → heightData grid index.
   * localCoord is worldCoord - tileIndex * TILE_SIZE, ranging [-SIZE/2, +SIZE/2].
   * Returns a float in [0, RESOLUTION-1] suitable for bilinear interpolation.
   */
  private localToGridIndex(localCoord: number): number {
    const gridStep = this.CONFIG.TILE_SIZE / (this.CONFIG.TILE_RESOLUTION - 1);
    return (localCoord + this.CONFIG.TILE_SIZE * 0.5) / gridStep;
  }

  /**
   * PERFORMANCE: Get height from cached tile data using bilinear interpolation.
   * Returns null if tile not loaded - caller should fallback to getHeightAtComputed().
   * O(1) lookup vs O(n) noise computation.
   */
  // Last-tile cache for getHeightAtCached — avoids string allocation + Map.get()
  // for the ~90% of calls that hit the same terrain tile (BFS spatial locality).
  private _cachedHeightTileX = NaN;
  private _cachedHeightTileZ = NaN;
  private _cachedHeightTile: { heightData?: number[] } | null = null;

  private getHeightAtCached(worldX: number, worldZ: number): number | null {
    const tileX = this.worldToTerrainTileIndex(worldX);
    const tileZ = this.worldToTerrainTileIndex(worldZ);

    // Fast path: reuse last tile if same coordinates (BFS spatial locality)
    let tile: { heightData?: number[] } | null;
    if (
      tileX === this._cachedHeightTileX &&
      tileZ === this._cachedHeightTileZ
    ) {
      tile = this._cachedHeightTile;
    } else {
      const key = `${tileX}_${tileZ}`;
      tile = this.terrainTiles.get(key) ?? null;
      this._cachedHeightTileX = tileX;
      this._cachedHeightTileZ = tileZ;
      this._cachedHeightTile = tile;
    }

    if (!tile?.heightData || tile.heightData.length === 0) {
      return null;
    }

    const resolution = this.CONFIG.TILE_RESOLUTION;

    const localX = worldX - tileX * this.CONFIG.TILE_SIZE;
    const localZ = worldZ - tileZ * this.CONFIG.TILE_SIZE;

    const gx = this.localToGridIndex(localX);
    const gz = this.localToGridIndex(localZ);

    // Clamp to valid range
    const gxClamped = Math.max(0, Math.min(resolution - 1.001, gx));
    const gzClamped = Math.max(0, Math.min(resolution - 1.001, gz));

    // Integer indices for bilinear interpolation
    const ix0 = Math.floor(gxClamped);
    const iz0 = Math.floor(gzClamped);
    const ix1 = Math.min(ix0 + 1, resolution - 1);
    const iz1 = Math.min(iz0 + 1, resolution - 1);

    // Fractional parts
    const fx = gxClamped - ix0;
    const fz = gzClamped - iz0;

    // Sample four corners (row-major: index = iz * resolution + ix)
    const h00 = tile.heightData[iz0 * resolution + ix0];
    const h10 = tile.heightData[iz0 * resolution + ix1];
    const h01 = tile.heightData[iz1 * resolution + ix0];
    const h11 = tile.heightData[iz1 * resolution + ix1];

    // Bilinear interpolation
    const h0 = h00 + (h10 - h00) * fx;
    const h1 = h01 + (h11 - h01) * fx;
    return h0 + (h1 - h0) * fz;
  }

  /**
   * Compute height using noise functions (expensive, used when tile not cached)
   *
   * CRITICAL: Also checks flat zones to ensure terrain mesh vertices are at the correct
   * height under buildings/stations. Without this, terrain mesh would render at procedural
   * height while building floors are at flat zone height, causing z-fighting.
   */
  private getHeightAtComputed(worldX: number, worldZ: number): number {
    // Check flat zones FIRST - buildings and stations need terrain at their floor height
    // to prevent z-fighting between terrain mesh and building floor geometry
    const flatHeight = this.getFlatZoneHeight(worldX, worldZ);
    if (flatHeight !== null) {
      return flatHeight;
    }

    return this.getHeightAtComputedSkipFlatZone(worldX, worldZ);
  }

  /** Stable authored ground for resources, independent of resident mesh caches/decks. */
  getResourceGroundHeight(worldX: number, worldZ: number): number {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
      throw new Error("Resource grounding requires finite world coordinates");
    }
    return this.getHeightAtComputed(worldX, worldZ);
  }

  /**
   * Compute height using noise (expensive). Skips flat zone check — caller must check first.
   * PERF: Avoids redundant getFlatZoneHeight() when called from getHeightAt().
   */
  private getHeightAtComputedSkipFlatZone(
    worldX: number,
    worldZ: number,
  ): number {
    const baseHeight = this.getHeightAtWithoutShore(worldX, worldZ);
    const waterThreshold = this.CONFIG.WATER_THRESHOLD;
    const landBand = this.shorelineParameters.LAND_BAND;
    const underwaterBand = this.shorelineParameters.UNDERWATER_BAND;

    if (
      baseHeight >= waterThreshold + landBand ||
      baseHeight <= waterThreshold - underwaterBand
    ) {
      return baseHeight;
    }

    const slope = this.calculateBaseSlopeAt(worldX, worldZ, baseHeight);
    return this.adjustHeightForShoreline(baseHeight, slope);
  }

  getHeightAt(worldX: number, worldZ: number): number {
    // Validate inputs
    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
      throw new Error(
        `[TerrainSystem] getHeightAt: invalid coords (${worldX}, ${worldZ})`,
      );
    }

    // HIGHEST PRIORITY: Bridge deck height — single source of truth.
    // Uses pre-computed deck heights with bilinear interpolation (no recursion).
    // Every caller of getHeightAt() automatically gets bridge deck height on
    // bridge tiles, eliminating Y-oscillation from competing height sources.
    const bridgeSys = this.world?.getSystem("bridges") as {
      getDeckHeightAtSmooth?(wx: number, wz: number): number | null;
    } | null;
    if (bridgeSys?.getDeckHeightAtSmooth) {
      const deckH = bridgeSys.getDeckHeightAtSmooth(worldX, worldZ);
      if (deckH !== null) return deckH;
    }

    // Dock deck height — same pattern as bridges.
    const dockSys = this.world?.getSystem("docks") as {
      getDeckHeightAtSmooth?(wx: number, wz: number): number | null;
    } | null;
    if (dockSys?.getDeckHeightAtSmooth) {
      const dockH = dockSys.getDeckHeightAtSmooth(worldX, worldZ);
      if (dockH !== null) return dockH;
    }

    // CRITICAL: Check flat zones FIRST - they may be registered after terrain generation
    // This ensures buildings and other structures have correct floor heights even when
    // terrain tiles were generated before their flat zones were registered.
    const flatHeight = this.getFlatZoneHeight(worldX, worldZ);
    if (flatHeight !== null) {
      return flatHeight;
    }

    // PERFORMANCE: Try cached tile data (O(1) bilinear interpolation)
    const cachedHeight = this.getHeightAtCached(worldX, worldZ);
    if (cachedHeight !== null) {
      return cachedHeight;
    }

    // Fallback to expensive noise computation
    // PERF: skip flat zone check inside getHeightAtComputed — we already checked above
    return this.getHeightAtComputedSkipFlatZone(worldX, worldZ);
  }

  /** Get the water body registry for elevated water queries. */
  getWaterBodyRegistry(): WaterBodyRegistry {
    return this.waterBodyRegistry;
  }

  // ============================================================================
  // FLAT ZONE SYSTEM (Terrain Flattening for Stations)
  // ============================================================================

  /**
   * Check if position is within a flat zone and return modified height.
   * Returns null if no flat zone applies.
   *
   * Uses terrain tile spatial index (100m tiles) for fast lookup.
   */
  // Debug counter to avoid log spam
  private _flatZoneHitCount = 0;
  private readonly arenaFloorZoneIds = new Set<string>();
  private arenaGradeHeight: number | null = null;

  /** Reused ordered candidates; consume synchronously without recursive lookup. */
  private getAuthoredSurfaceCandidates(
    worldX: number,
    worldZ: number,
  ): readonly FlatZone[] {
    const candidates = this.authoredSurfaceCandidates;
    candidates.length = 0;
    this._flatZoneChecked.clear();
    if (this.flatZones.size === 0) return candidates;
    const tileSize = this.CONFIG.TILE_SIZE;
    const halfTile = tileSize / 2;
    const terrainTileX = Math.floor((worldX + halfTile) / tileSize);
    const terrainTileZ = Math.floor((worldZ + halfTile) / tileSize);
    for (let dtx = -1; dtx <= 1; dtx++) {
      for (let dtz = -1; dtz <= 1; dtz++) {
        const key = `${terrainTileX + dtx}_${terrainTileZ + dtz}`;
        const zones = this.flatZonesByTile.get(key);
        if (!zones) continue;
        for (const zone of zones) {
          if (this._flatZoneChecked.has(zone.id)) continue;
          this._flatZoneChecked.add(zone.id);
          candidates.push(zone);
        }
      }
    }
    return candidates;
  }

  private getFlatZoneHeight(worldX: number, worldZ: number): number | null {
    const height = this.authoredSurface.resolveHeight(
      this.getAuthoredSurfaceCandidates(worldX, worldZ),
      worldX,
      worldZ,
      () => this.getProceduralHeightAt(worldX, worldZ),
      this.arenaFloorZoneIds,
      this.arenaGradeHeight,
    );
    if (height !== null) this._flatZoneHitCount++;
    return height;
  }

  /** Whether authored shaping affects this point, including its blend region. */
  isInFlatZone(worldX: number, worldZ: number): boolean {
    return this.getFlatZoneHeight(worldX, worldZ) !== null;
  }

  /** Grass exclusion is independent of terrain shaping on broad natural grades. */
  private isGrassExcludedAt(worldX: number, worldZ: number): boolean {
    return this.authoredSurface.isGrassExcluded(
      this.getAuthoredSurfaceCandidates(worldX, worldZ),
      worldX,
      worldZ,
    );
  }

  /**
   * Register a flat zone and update spatial index.
   * Spatial index uses terrain tiles (100m each) for efficient lookup.
   *
   * IMPORTANT: Also regenerates affected terrain tile meshes so that
   * the visual terrain reflects the flat zone heights. This is critical
   * because terrain tiles may have been generated before flat zones
   * were registered (e.g., building flat zones registered after terrain init).
   */
  registerFlatZone(zone: FlatZone): void {
    // Validate zone data
    if (!zone || !zone.id || typeof zone.id !== "string") {
      throw new Error(
        `[TerrainSystem] registerFlatZone: invalid zone id: ${zone?.id}`,
      );
    }
    if (!Number.isFinite(zone.centerX) || !Number.isFinite(zone.centerZ)) {
      throw new Error(
        `[TerrainSystem] registerFlatZone "${zone.id}": invalid center (${zone.centerX}, ${zone.centerZ})`,
      );
    }
    if (!Number.isFinite(zone.width) || zone.width <= 0) {
      throw new Error(
        `[TerrainSystem] registerFlatZone "${zone.id}": invalid width ${zone.width}`,
      );
    }
    if (!Number.isFinite(zone.depth) || zone.depth <= 0) {
      throw new Error(
        `[TerrainSystem] registerFlatZone "${zone.id}": invalid depth ${zone.depth}`,
      );
    }
    if (!Number.isFinite(zone.height)) {
      throw new Error(
        `[TerrainSystem] registerFlatZone "${zone.id}": invalid height ${zone.height}`,
      );
    }
    if (!Number.isFinite(zone.blendRadius) || zone.blendRadius < 0) {
      throw new Error(
        `[TerrainSystem] registerFlatZone "${zone.id}": invalid blendRadius ${zone.blendRadius}`,
      );
    }
    if (
      zone.excludeGrass !== undefined &&
      typeof zone.excludeGrass !== "boolean"
    ) {
      throw new Error(
        `[TerrainSystem] registerFlatZone "${zone.id}": excludeGrass must be boolean`,
      );
    }
    const radialProfileError = validateRadialPondTerrainProfile(zone);
    if (radialProfileError) {
      throw new Error(
        `[TerrainSystem] registerFlatZone "${zone.id}": ${radialProfileError}`,
      );
    }

    // A replacement must remove the previous bounds before indexing the new
    // zone, including when an authored layout is rebuilt with the same IDs.
    if (this.flatZones.has(zone.id)) this.unregisterFlatZone(zone.id);
    this.flatZones.set(zone.id, zone);

    // Calculate affected terrain tiles
    // IMPORTANT: Visual terrain tiles are CENTERED at (tileX * TILE_SIZE, tileZ * TILE_SIZE)
    // So tile 0 covers world X from -TILE_SIZE/2 to +TILE_SIZE/2, NOT 0 to TILE_SIZE.
    // We must calculate which visual tiles overlap the flat zone's influence area.
    const totalRadius = Math.max(zone.width, zone.depth) / 2 + zone.blendRadius;
    const halfTile = this.CONFIG.TILE_SIZE / 2;

    // For visual tiles centered at tileX * TILE_SIZE:
    // Tile covers [tileX * TILE_SIZE - halfTile, tileX * TILE_SIZE + halfTile]
    // We need tiles where: tileX * TILE_SIZE + halfTile >= zone.minX AND tileX * TILE_SIZE - halfTile <= zone.maxX
    // Simplifying: tileX >= (zone.minX - halfTile) / TILE_SIZE AND tileX <= (zone.maxX + halfTile) / TILE_SIZE
    const zoneMinX = zone.centerX - totalRadius;
    const zoneMaxX = zone.centerX + totalRadius;
    const zoneMinZ = zone.centerZ - totalRadius;
    const zoneMaxZ = zone.centerZ + totalRadius;

    const minTileX = Math.floor((zoneMinX + halfTile) / this.CONFIG.TILE_SIZE);
    const maxTileX = Math.floor((zoneMaxX + halfTile) / this.CONFIG.TILE_SIZE);
    const minTileZ = Math.floor((zoneMinZ + halfTile) / this.CONFIG.TILE_SIZE);
    const maxTileZ = Math.floor((zoneMaxZ + halfTile) / this.CONFIG.TILE_SIZE);

    const tilesToRegenerate: Array<{ x: number; z: number }> = [];

    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let tz = minTileZ; tz <= maxTileZ; tz++) {
        const key = `${tx}_${tz}`;
        let zones = this.flatZonesByTile.get(key);
        if (!zones) {
          zones = [];
          this.flatZonesByTile.set(key, zones);
        }
        zones.push(zone);

        // Track tiles that need regeneration (if they already exist)
        if (this.terrainTiles.has(key)) {
          tilesToRegenerate.push({ x: tx, z: tz });
        }
      }
    }

    // Regenerate any existing terrain tiles to apply flat zone heights
    // This ensures terrain meshes reflect the flat zone even if they were
    // generated before the flat zone was registered
    //
    // Use deduplication set to avoid regenerating the same tile multiple times
    // (e.g., when multiple buildings register flat zones in the same terrain tile)
    if (tilesToRegenerate.length > 0) {
      const uniqueTiles = new Set<string>();
      const filteredTiles = tilesToRegenerate.filter((tile) => {
        const key = `${tile.x}_${tile.z}`;
        if (this._pendingTileRegeneration.has(key)) {
          return false; // Already scheduled for regeneration
        }
        if (uniqueTiles.has(key)) {
          return false; // Duplicate in this batch
        }
        uniqueTiles.add(key);
        this._pendingTileRegeneration.add(key);
        return true;
      });

      if (filteredTiles.length > 0) {
        console.log(
          `[TerrainSystem] Regenerating ${filteredTiles.length} terrain tiles for flat zone "${zone.id}"`,
        );
        for (const tile of filteredTiles) {
          this.queueTerrainTileRegeneration(tile.x, tile.z, "flat_zone");
        }
      }
    }

    // Invalidate quad-tree visual chunks so they regenerate with flat zone heights.
    // Without this, chunks generated before the flat zone was registered would
    // show the procedural height instead of the flat zone height.
    if (this.quadTreeVisualManager) {
      this.quadTreeVisualManager.invalidateRegion(
        zoneMinX,
        zoneMinZ,
        zoneMaxX,
        zoneMaxZ,
      );
    }
    if (this.grassVisualManager) {
      this.grassVisualManager.invalidateRegion(
        zoneMinX,
        zoneMinZ,
        zoneMaxX,
        zoneMaxZ,
      );
    }
  }

  /**
   * Queue terrain tile regeneration and flush incrementally.
   * This coalesces many flat-zone updates into small batches to avoid frame stalls.
   */
  private queueTerrainTileRegeneration(
    tileX: number,
    tileZ: number,
    reason: "flat_zone" | "road" | "other",
  ): void {
    const key = `${tileX}_${tileZ}`;
    if (
      this._pendingTileRegeneration.has(key) &&
      this._queuedTileRegenerations.has(key)
    ) {
      return;
    }
    this._pendingTileRegeneration.add(key);
    if (this._queuedTileRegenerations.has(key)) return;

    this._queuedTileRegenerations.set(key, { x: tileX, z: tileZ, reason });

    if (this._tileRegenerationFlushId) return;
    this._tileRegenerationFlushId = setTimeout(() => {
      this._tileRegenerationFlushId = undefined;
      this.flushQueuedTileRegenerations();
    }, 0);
  }

  /**
   * Flush queued tile regenerations in small batches to protect frame time.
   */
  private flushQueuedTileRegenerations(): void {
    if (this._queuedTileRegenerations.size === 0) return;

    const MAX_REGENERATIONS_PER_BATCH = 4;
    let processed = 0;

    for (const [key, tile] of this._queuedTileRegenerations) {
      this._queuedTileRegenerations.delete(key);
      this.regenerateTerrainTile(tile.x, tile.z, tile.reason);
      this._pendingTileRegeneration.delete(key);
      processed++;

      if (processed >= MAX_REGENERATIONS_PER_BATCH) {
        break;
      }
    }

    if (this._queuedTileRegenerations.size > 0) {
      this._tileRegenerationFlushId = setTimeout(() => {
        this._tileRegenerationFlushId = undefined;
        this.flushQueuedTileRegenerations();
      }, 0);
    }
  }

  /**
   * Regenerate a terrain tile's visual mesh to reflect current flat zones.
   * Called when flat zones are registered after terrain tiles were already generated.
   *
   * NOTE: Only updates the visual mesh geometry. Physics height queries already
   * use getHeightAt() which checks flat zones dynamically, so physics doesn't
   * need regeneration.
   */
  private regenerateTerrainTile(
    tileX: number,
    tileZ: number,
    reason: "flat_zone" | "road" | "other" = "other",
  ): void {
    const key = `${tileX}_${tileZ}`;
    const existingTile = this.terrainTiles.get(key);
    if (!existingTile || !existingTile.mesh) return;

    // Regenerate geometry with current flat zones
    const newGeometry = this.createTileGeometry(tileX, tileZ);

    // Update the existing mesh's geometry (preserves material, position, etc.)
    existingTile.mesh.geometry.dispose();
    existingTile.mesh.geometry = newGeometry;
    existingTile.mesh.geometry.computeBoundingSphere();
    existingTile.mesh.geometry.computeBoundingBox();

    console.log(
      `[TerrainSystem] Regenerated terrain tile (${tileX},${tileZ}) for ${reason}`,
    );

    // Emit event so VegetationSystem can regenerate grass/vegetation for this tile
    this.world.emit(EventType.TERRAIN_TILE_REGENERATED, {
      tileId: key,
      tileX,
      tileZ,
      biome: existingTile.biome || "grassland",
      reason,
    });
  }

  /**
   * Remove a flat zone by ID.
   * Used when dynamic structures are removed.
   */
  unregisterFlatZone(id: string): void {
    const zone = this.flatZones.get(id);
    if (!zone) return;

    this.flatZones.delete(id);
    this.arenaFloorZoneIds.delete(id);
    if (this.arenaFloorZoneIds.size === 0) this.arenaGradeHeight = null;

    // Remove from spatial index
    const totalRadius = Math.max(zone.width, zone.depth) / 2 + zone.blendRadius;
    const halfTile = this.CONFIG.TILE_SIZE / 2;
    const minTileX = Math.floor(
      (zone.centerX - totalRadius + halfTile) / this.CONFIG.TILE_SIZE,
    );
    const maxTileX = Math.floor(
      (zone.centerX + totalRadius + halfTile) / this.CONFIG.TILE_SIZE,
    );
    const minTileZ = Math.floor(
      (zone.centerZ - totalRadius + halfTile) / this.CONFIG.TILE_SIZE,
    );
    const maxTileZ = Math.floor(
      (zone.centerZ + totalRadius + halfTile) / this.CONFIG.TILE_SIZE,
    );

    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let tz = minTileZ; tz <= maxTileZ; tz++) {
        const key = `${tx}_${tz}`;
        const zones = this.flatZonesByTile.get(key);
        if (zones) {
          const filtered = zones.filter((z) => z.id !== id);
          if (filtered.length > 0) {
            this.flatZonesByTile.set(key, filtered);
          } else {
            this.flatZonesByTile.delete(key);
          }
        }
      }
    }

    // Invalidate quad-tree visual chunks so they regenerate without the flat zone.
    const minX = zone.centerX - totalRadius;
    const maxX = zone.centerX + totalRadius;
    const minZ = zone.centerZ - totalRadius;
    const maxZ = zone.centerZ + totalRadius;
    if (this.quadTreeVisualManager) {
      this.quadTreeVisualManager.invalidateRegion(minX, minZ, maxX, maxZ);
    }
    if (this.grassVisualManager) {
      this.grassVisualManager.invalidateRegion(minX, minZ, maxX, maxZ);
    }
  }

  /**
   * Get a flat zone at a position (if any).
   */
  getFlatZoneAt(worldX: number, worldZ: number): FlatZone | null {
    const halfTile = this.CONFIG.TILE_SIZE / 2;
    const tileX = Math.floor((worldX + halfTile) / this.CONFIG.TILE_SIZE);
    const tileZ = Math.floor((worldZ + halfTile) / this.CONFIG.TILE_SIZE);
    const key = `${tileX}_${tileZ}`;

    const zones = this.flatZonesByTile.get(key);
    if (!zones) return null;

    for (const zone of zones) {
      const dx = Math.abs(worldX - zone.centerX);
      const dz = Math.abs(worldZ - zone.centerZ);
      const halfWidth = zone.width / 2 + zone.blendRadius;
      const halfDepth = zone.depth / 2 + zone.blendRadius;

      if (dx <= halfWidth && dz <= halfDepth) {
        return zone;
      }
    }

    return null;
  }

  /**
   * Load explicit elevated water bodies from world-areas.json.
   *
   * These are registered after DataManager is ready but before any terrain
   * tile is generated. The same registry drives collision baking, rendered
   * water, vegetation exclusion, and dynamic fishing-shore discovery.
   */
  private loadWaterBodiesFromManifest(): void {
    const seenIds = new Set<string>();
    let loadedCount = 0;

    for (const [areaId, area] of Object.entries(ALL_WORLD_AREAS)) {
      for (const body of area.waterBodies ?? []) {
        const values = [body.centerX, body.centerZ, body.radius, body.surfaceY];
        if (
          typeof body.id !== "string" ||
          body.id.trim().length === 0 ||
          !values.every(Number.isFinite) ||
          body.radius <= 0
        ) {
          throw new Error(
            `[TerrainSystem] Invalid water body in area ${areaId}: ${JSON.stringify(body)}`,
          );
        }
        if (seenIds.has(body.id)) {
          throw new Error(
            `[TerrainSystem] Duplicate water body ID ${body.id} in world-areas.json`,
          );
        }
        seenIds.add(body.id);
        this.waterBodyRegistry.register({
          id: body.id,
          centerX: body.centerX,
          centerZ: body.centerZ,
          radius: body.radius,
          radiusSq: body.radius * body.radius,
          surfaceY: body.surfaceY,
          sourceType: "explicit",
        });
        loadedCount++;
      }
    }

    if (loadedCount > 0) {
      console.log(
        `[TerrainSystem] Registered ${loadedCount} explicit water bodies from world-areas.json`,
      );
    }
  }

  /**
   * Load flat zones from world-areas manifest during initialization.
   * Called before any tiles are generated.
   *
   * Note: Station footprints are in movement tiles (1m = 1 tile).
   * Terrain tiles are 100m each, used only for spatial indexing.
   */
  private loadFlatZonesFromManifest(): void {
    // Movement tile size (1m) - used for station footprints
    const MOVEMENT_TILE_SIZE = 1.0;

    let loadedCount = 0;
    const areaNames = Object.keys(ALL_WORLD_AREAS);

    console.log(
      `[TerrainSystem] Loading flat zones from ${areaNames.length} world areas`,
    );

    if (!ALL_WORLD_AREAS["duel_arena"]) {
      console.warn(`[TerrainSystem] duel_arena NOT in ALL_WORLD_AREAS!`);
    }

    const areaConfigs = Object.values(ALL_WORLD_AREAS).map(
      (area) =>
        area as {
          stations?: typeof area.stations;
          flatZones?: Array<{
            id: string;
            centerX: number;
            centerZ: number;
            width: number;
            depth: number;
            height?: number;
            heightOffset?: number;
            blendRadius: number;
            excludeGrass?: boolean;
            radialPond?: RadialPondTerrainProfile;
          }>;
        },
    );

    // Establish authored grading across ALL areas before sampling station pads.
    // A station may sit on a plaza or pond declared in a different, later area.
    for (const areaConfig of areaConfigs) {
      for (const zoneConfig of areaConfig.flatZones ?? []) {
        const proceduralHeight = this.getProceduralHeightAt(
          zoneConfig.centerX,
          zoneConfig.centerZ,
        );
        const flatHeight =
          zoneConfig.height !== undefined
            ? zoneConfig.height
            : proceduralHeight + (zoneConfig.heightOffset ?? 0);

        this.registerFlatZone({
          id: zoneConfig.id,
          centerX: zoneConfig.centerX,
          centerZ: zoneConfig.centerZ,
          width: zoneConfig.width,
          depth: zoneConfig.depth,
          height: flatHeight,
          blendRadius: zoneConfig.blendRadius,
          excludeGrass: zoneConfig.excludeGrass,
          radialPond: zoneConfig.radialPond
            ? { ...zoneConfig.radialPond }
            : undefined,
        });
        loadedCount++;
      }
    }

    // Terrain owns these surfaces on BOTH roles before meshes/navigation bake.
    // Rendering borrows the same base; it must not register client-only grades.
    this.arenaFloorZoneIds.clear();
    this.arenaGradeHeight = null;
    if (ALL_WORLD_AREAS.duel_arena) {
      const baseHeight = getDuelArenaGradeHeight();
      for (const zone of createDuelArenaFloorZones(
        getDuelArenaConfig(),
        baseHeight,
      )) {
        this.registerFlatZone(zone);
        this.arenaFloorZoneIds.add(zone.id);
        loadedCount++;
      }
      this.arenaGradeHeight = baseHeight;
    }

    // Collect every pad before registering any of them. Sampling and registering
    // sequentially would let an earlier station's pad change a later one's grade.
    const stationZones: FlatZone[] = [];
    for (const areaConfig of areaConfigs) {
      if (areaConfig.stations) {
        for (const station of areaConfig.stations) {
          const stationData = stationDataProvider.getStationData(station.type);

          // Skip if station type not found or doesn't want ground flattening
          if (!stationData) {
            continue;
          }

          if (!stationData.flattenGround) {
            continue;
          }

          // Get footprint from model bounds (returns movement tiles, e.g., {x: 2, z: 2})
          const footprint = stationDataProvider.getFootprint(station.type);
          const size = resolveFootprint(footprint);

          // Calculate flat zone dimensions in world units (meters)
          const padding = stationData.flattenPadding;
          const blendRadius = stationData.flattenBlendRadius;
          const width = size.x * MOVEMENT_TILE_SIZE + padding * 2;
          const depth = size.z * MOVEMENT_TILE_SIZE + padding * 2;

          // Use explicit-only grading, preserving radial pond/core/blend
          // precedence. Stations outside authored grading retain raw terrain.
          const flatHeight =
            this.getFlatZoneHeight(station.position.x, station.position.z) ??
            this.getProceduralHeightAt(station.position.x, station.position.z);

          const zone: FlatZone = {
            id: `station_${station.id}`,
            centerX: station.position.x,
            centerZ: station.position.z,
            width,
            depth,
            height: flatHeight,
            blendRadius,
          };

          stationZones.push(zone);
        }
      }
    }
    for (const zone of stationZones) {
      this.registerFlatZone(zone);
      loadedCount++;
    }

    console.log(
      `[TerrainSystem] Flat zone loading complete: ${loadedCount} zones registered`,
    );
  }

  /**
   * Compute the terrain surface normal at a world position.
   * Uses central differences on the scalar height field h(x, z).
   * Returns a normalized THREE.Vector3 where y is the up component.
   */
  getNormalAt(worldX: number, worldZ: number): THREE.Vector3 {
    // Use a small sampling distance relative to tile resolution
    const sampleDistance = 0.5;

    // Sample heights around the point with central differences
    const hL = this.getHeightAt(worldX - sampleDistance, worldZ);
    const hR = this.getHeightAt(worldX + sampleDistance, worldZ);
    const hD = this.getHeightAt(worldX, worldZ - sampleDistance);
    const hU = this.getHeightAt(worldX, worldZ + sampleDistance);

    // Partial derivatives: dh/dx and dh/dz
    const dhdx = (hR - hL) / (2 * sampleDistance);
    const dhdz = (hU - hD) / (2 * sampleDistance);

    // For a heightfield y = h(x, z), a surface normal can be constructed as (-dhdx, 1, -dhdz)
    const normal = this._tempVec3.set(-dhdx, 1, -dhdz);
    normal.normalize();
    return normal;
  }

  /**
   * Compute normals using an overflow height grid (centered differences).
   *
   * Builds a (resolution+2)x(resolution+2) grid — the interior is filled from
   * the already-computed tile heights, and a 1-cell border is computed via
   * getHeightAtComputed (~260 calls). Normals are then derived with pure
   * array lookups instead of 4x getHeightAtComputed per vertex (~16 384 calls
   * previously). This is a ~63x reduction in noise evaluations for normals.
   *
   * When tileHeights is provided (from the vertex generation loop), the interior
   * is copied directly. Otherwise falls back to reading the geometry positions.
   *
   * @param tileHeights - Flat array of tile vertex heights in row-major order
   *                      (iz * resolution + ix). Length must equal resolution^2.
   *                      Pass the heightData array from createTileGeometry or
   *                      createTileGeometryFromWorkerData.
   */
  private computeHeightFieldNormals(
    geometry: THREE.PlaneGeometry,
    tileX: number,
    tileZ: number,
    tileHeights?: ArrayLike<number>,
  ): void {
    const resolution = this.CONFIG.TILE_RESOLUTION; // 64
    const tileSize = this.CONFIG.TILE_SIZE; // 100
    const gridStep = tileSize / (resolution - 1); // ~1.587m
    const halfSize = tileSize / 2; // 50
    const originX = tileX * tileSize;
    const originZ = tileZ * tileSize;

    // (resolution+2)^2 overflow grid — lazily allocate once, reuse across tiles
    const gRes = resolution + 2; // 66
    if (
      !this._overflowHeightGrid ||
      this._overflowHeightGrid.length !== gRes * gRes
    ) {
      this._overflowHeightGrid = new Float32Array(gRes * gRes);
    }
    const grid = this._overflowHeightGrid;

    // --- Fill interior from already-computed tile heights ---
    if (tileHeights && tileHeights.length >= resolution * resolution) {
      for (let iz = 0; iz < resolution; iz++) {
        const srcRow = iz * resolution;
        const dstRow = (iz + 1) * gRes + 1; // offset by 1 in both axes
        for (let ix = 0; ix < resolution; ix++) {
          grid[dstRow + ix] = tileHeights[srcRow + ix];
        }
      }
    } else {
      // Fallback: read Y component from geometry positions
      const posArr = geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < resolution * resolution; i++) {
        const ix = i % resolution;
        const iz = (i - ix) / resolution;
        grid[(iz + 1) * gRes + (ix + 1)] = posArr[i * 3 + 1];
      }
    }

    // --- Fill 1-cell border via getHeightAtComputed (~260 cells) ---
    // World position for overflow grid index (gx, gz):
    //   localX = -halfSize + (gx - 1) * gridStep
    //   localZ = -halfSize + (gz - 1) * gridStep
    for (let gz = 0; gz < gRes; gz++) {
      const localZ = -halfSize + (gz - 1) * gridStep;
      const worldZ = originZ + localZ;
      for (let gx = 0; gx < gRes; gx++) {
        // Skip interior — already filled above
        if (gx >= 1 && gx <= resolution && gz >= 1 && gz <= resolution)
          continue;
        const localX = -halfSize + (gx - 1) * gridStep;
        const worldX = originX + localX;
        grid[gz * gRes + gx] = this.getHeightAtComputed(worldX, worldZ);
      }
    }

    // --- Compute normals via centered finite differences ---
    const positions = geometry.attributes.position;
    const normals = new Float32Array(positions.count * 3);
    const invTwoStep = 1 / (2 * gridStep);

    for (let iz = 0; iz < resolution; iz++) {
      const gz = iz + 1; // overflow grid row
      for (let ix = 0; ix < resolution; ix++) {
        const gx = ix + 1; // overflow grid col

        const hL = grid[gz * gRes + (gx - 1)];
        const hR = grid[gz * gRes + (gx + 1)];
        const hD = grid[(gz - 1) * gRes + gx];
        const hU = grid[(gz + 1) * gRes + gx];

        const dhdx = (hR - hL) * invTwoStep;
        const dhdz = (hU - hD) * invTwoStep;

        const nx = -dhdx;
        const ny = 1;
        const nz = -dhdz;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

        const i3 = (iz * resolution + ix) * 3;
        normals[i3] = nx / len;
        normals[i3 + 1] = ny / len;
        normals[i3 + 2] = nz / len;
      }
    }

    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  }

  /**
   * Carve terrain triangles inside flat zone core areas to prevent overdraw under buildings.
   * Uses the flat zone spatial index and optional carveInset to keep blend padding intact.
   */
  private applyFlatZoneCarve(
    geometry: THREE.PlaneGeometry,
    tileX: number,
    tileZ: number,
  ): void {
    const key = `${tileX}_${tileZ}`;
    const zones = this.flatZonesByTile.get(key);
    if (!zones || zones.length === 0) return;

    const carveZones: Array<
      | {
          type: "rect";
          centerX: number;
          centerZ: number;
          halfWidth: number;
          halfDepth: number;
        }
      | {
          type: "mask";
          tileMask: Set<string>;
        }
    > = [];

    for (const zone of zones) {
      if (zone.tileMask && zone.tileMask.size > 0) {
        carveZones.push({
          type: "mask",
          tileMask: zone.tileMask,
        });
        continue;
      }

      if (
        typeof zone.carveInset !== "number" ||
        !Number.isFinite(zone.carveInset)
      ) {
        continue;
      }
      const halfWidth = zone.width / 2 - zone.carveInset;
      const halfDepth = zone.depth / 2 - zone.carveInset;
      if (halfWidth <= 0 || halfDepth <= 0) continue;
      carveZones.push({
        type: "rect",
        centerX: zone.centerX,
        centerZ: zone.centerZ,
        halfWidth,
        halfDepth,
      });
    }

    if (carveZones.length === 0) return;

    const positions = geometry.attributes.position;
    const vertexCount = positions.count;
    const resolution = Math.round(Math.sqrt(vertexCount));
    if (resolution * resolution !== vertexCount) return;

    const gridSize = resolution - 1;
    if (gridSize <= 0) return;

    const positionsArray = positions.array as Float32Array;
    const indices: number[] = [];
    const tileOffsetX = tileX * this.CONFIG.TILE_SIZE;
    const tileOffsetZ = tileZ * this.CONFIG.TILE_SIZE;

    const isVertexInZone = (
      vertexIndex: number,
      zone:
        | {
            type: "rect";
            centerX: number;
            centerZ: number;
            halfWidth: number;
            halfDepth: number;
          }
        | {
            type: "mask";
            tileMask: Set<string>;
          },
    ): boolean => {
      const base = vertexIndex * 3;
      const worldX = positionsArray[base] + tileOffsetX;
      const worldZ = positionsArray[base + 2] + tileOffsetZ;

      if (zone.type === "mask") {
        const tileX = Math.floor(worldX);
        const tileZ = Math.floor(worldZ);
        return zone.tileMask.has(`${tileX},${tileZ}`);
      }

      const dx = Math.abs(worldX - zone.centerX);
      const dz = Math.abs(worldZ - zone.centerZ);
      return dx <= zone.halfWidth && dz <= zone.halfDepth;
    };

    for (let iz = 0; iz < gridSize; iz += 1) {
      for (let ix = 0; ix < gridSize; ix += 1) {
        const a = ix + resolution * iz;
        const b = ix + resolution * (iz + 1);
        const c = ix + 1 + resolution * (iz + 1);
        const d = ix + 1 + resolution * iz;

        let carved = false;
        for (const zone of carveZones) {
          if (
            isVertexInZone(a, zone) &&
            isVertexInZone(b, zone) &&
            isVertexInZone(c, zone) &&
            isVertexInZone(d, zone)
          ) {
            carved = true;
            break;
          }
        }

        if (!carved) {
          // Same winding as PlaneGeometry: a, b, d and b, c, d
          indices.push(a, b, d, b, c, d);
        }
      }
    }

    geometry.setIndex(indices);
  }

  private generateNoise(x: number, z: number): number {
    const sin1 = Math.sin(x * 2.1 + z * 1.7);
    const cos1 = Math.cos(x * 1.3 - z * 2.4);
    const sin2 = Math.sin(x * 3.7 - z * 4.1);
    const cos2 = Math.cos(x * 5.2 + z * 3.8);

    const result = (sin1 * cos1 + sin2 * cos2 * 0.5) * 0.5;

    return result;
  }

  private getBiomeAt(tileX: number, tileZ: number): string {
    return this.biomeSystem.getBiomeForTile(
      tileX,
      tileZ,
      this.CONFIG.TILE_SIZE,
    );
  }

  private getBiomeInfluencesAtPosition(
    worldX: number,
    worldZ: number,
  ): Array<{ type: string; weight: number }> {
    return this.biomeSystem.getBiomeInfluencesAtPosition(worldX, worldZ, 0);
  }

  private computeBiomeWeightsAtPosition(
    worldX: number,
    worldZ: number,
  ): { biomeWeightMap: Map<string, number>; totalWeight: number } {
    const influences = this.biomeSystem.getBiomeInfluencesAtPosition(
      worldX,
      worldZ,
      0,
    );
    const biomeWeightMap = new Map<string, number>();
    let totalWeight = 0;
    for (const inf of influences) {
      biomeWeightMap.set(inf.type, inf.weight);
      totalWeight += inf.weight;
    }
    return { biomeWeightMap, totalWeight };
  }

  /**
   * Single entry point for getting the terrain base color and grass weight
   * at a world position.  Encapsulates height, slope, biome-weight lookups
   * and the CPU terrain-color computation so callers (e.g. GrassVisualManager)
   * don't need any biome knowledge.
   */
  getTerrainColorAt(
    wx: number,
    wz: number,
    computedSurface = false,
    grassEligibility?: GrassSurfaceEligibility,
  ): {
    r: number;
    g: number;
    b: number;
    grassWeight: number;
    grassPlacement: number;
    grassHeightScale: number;
    tintR: number;
    tintG: number;
    tintB: number;
    tintStrength: number;
    nx: number;
    ny: number;
    nz: number;
  } {
    const eligibility = compactTerrainColorOperations.grassEligibility(
      grassEligibility,
      this.getWorldTerrainProfile().algorithm,
    );
    // Grass uses the worker's computed authored surface, independent of loaded
    // tile interpolation. Other callers retain their existing cached sampler.
    const sampleHeight = computedSurface
      ? this.getHeightAtComputed
      : this.getHeightAt;
    const height = sampleHeight.call(this, wx, wz);

    const sd = GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE;
    const hL = sampleHeight.call(this, wx - sd, wz);
    const hR = sampleHeight.call(this, wx + sd, wz);
    const hD = sampleHeight.call(this, wx, wz - sd);
    const hU = sampleHeight.call(this, wx, wz + sd);
    const dhdx = (hR - hL) / (2 * sd);
    const dhdz = (hU - hD) / (2 * sd);
    const gradMag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
    const normalY = 1 / Math.sqrt(1 + gradMag * gradMag);
    const slope = 1 - normalY;

    const rnx = -dhdx;
    const rnz = -dhdz;
    const rny = 1.0;
    const nLen = Math.sqrt(rnx * rnx + rny * rny + rnz * rnz);
    const invLen = 1 / nLen;

    const { biomeWeightMap, totalWeight } = this.computeBiomeWeightsAtPosition(
      wx,
      wz,
    );
    const invW = totalWeight > 0 ? 1 / totalWeight : 1;
    const forestW = (biomeWeightMap.get("forest") || 0) * invW;
    const canyonW = (biomeWeightMap.get("canyon") || 0) * invW;
    const tundraW = 1 - forestW - canyonW;

    const color = computeTerrainColorCPU(
      wx,
      wz,
      height,
      slope,
      forestW,
      canyonW,
    );
    if (isCompactSculptProfile(this.getWorldTerrainProfile())) {
      // Match the compact diffuse palette, not the superseded biome colors.
      // Legacy ecology remains independent of colour. The explicit compact
      // candidate instead uses physical layer support, before road suppression.
      const paletteInput = {
        noiseValue: sampleNoiseCPU(
          wx,
          wz,
          TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
        ),
        distortNoise: sampleNoiseCPU(
          wx,
          wz,
          TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
        ),
        slope,
        roadInfluence: this.calculateRoadInfluenceAtVertex(wx, wz, 0, 0),
        surface: {
          x: wx,
          z: wz,
          height,
          pond: this.compactPondMaterial,
          macroField: this.getCompactMacroMaterial(),
        },
      };
      Object.assign(color, compactTerrainColorOperations.sample(paletteInput));
      if (eligibility === "compact-pbr-v1") {
        color.grassWeight =
          compactTerrainColorOperations.grassSupport(paletteInput);
      }
    }

    const tCfg = getGrassConfigForBiome(BiomeType.Tundra);
    const fCfg = getGrassConfigForBiome(BiomeType.Forest);
    const cCfg = getGrassConfigForBiome(BiomeType.Canyon);

    const maxSlope =
      tCfg.maxSlope * tundraW +
      fCfg.maxSlope * forestW +
      cCfg.maxSlope * canyonW;
    const minGW =
      tCfg.minGrassWeight * tundraW +
      fCfg.minGrassWeight * forestW +
      cCfg.minGrassWeight * canyonW;
    const density =
      tCfg.density * tundraW + fCfg.density * forestW + cCfg.density * canyonW;
    const grassHeightScale =
      tCfg.heightScale * tundraW +
      fCfg.heightScale * forestW +
      cCfg.heightScale * canyonW;
    const patchiness =
      tCfg.patchiness * tundraW +
      fCfg.patchiness * forestW +
      cCfg.patchiness * canyonW;
    const patchScale =
      tCfg.patchScale * tundraW +
      fCfg.patchScale * forestW +
      cCfg.patchScale * canyonW;

    const slopeOk = slope <= maxSlope ? 1.0 : 0.0;
    const weightOk = (
      eligibility === "compact-pbr-v1"
        ? color.grassWeight > 0
        : color.grassWeight >= minGW
    )
      ? 1.0
      : 0.0;

    // Noise-based patch mask: patchiness 0 = uniform, 1 = tight clusters
    const patchThreshold = patchiness * 2 - 1; // maps [0,1] -> [-1,1]
    const noiseVal = this.noise.simplex2D(wx * patchScale, wz * patchScale);
    const patchMask = noiseVal > patchThreshold ? 1.0 : 0.0;

    const grassPlacement =
      color.grassWeight * density * slopeOk * weightOk * patchMask;

    // Biome-blended grass tint (returned separately for tip-only application)
    const tintStrength =
      (tCfg.tintStrength ?? 0) * tundraW +
      (fCfg.tintStrength ?? 0) * forestW +
      (cCfg.tintStrength ?? 0) * canyonW;
    let tintR = 0,
      tintG = 0,
      tintB = 0;
    if (tintStrength > 0) {
      const wR =
        (tCfg.tintColor?.[0] ?? 0) * (tCfg.tintStrength ?? 0) * tundraW +
        (fCfg.tintColor?.[0] ?? 0) * (fCfg.tintStrength ?? 0) * forestW +
        (cCfg.tintColor?.[0] ?? 0) * (cCfg.tintStrength ?? 0) * canyonW;
      const wG =
        (tCfg.tintColor?.[1] ?? 0) * (tCfg.tintStrength ?? 0) * tundraW +
        (fCfg.tintColor?.[1] ?? 0) * (fCfg.tintStrength ?? 0) * forestW +
        (cCfg.tintColor?.[1] ?? 0) * (cCfg.tintStrength ?? 0) * canyonW;
      const wB =
        (tCfg.tintColor?.[2] ?? 0) * (tCfg.tintStrength ?? 0) * tundraW +
        (fCfg.tintColor?.[2] ?? 0) * (fCfg.tintStrength ?? 0) * forestW +
        (cCfg.tintColor?.[2] ?? 0) * (cCfg.tintStrength ?? 0) * canyonW;
      const inv = 1 / tintStrength;
      tintR = wR * inv;
      tintG = wG * inv;
      tintB = wB * inv;
    }

    return {
      ...color,
      grassPlacement,
      grassHeightScale,
      tintR,
      tintG,
      tintB,
      tintStrength,
      nx: rnx * invLen,
      ny: rny * invLen,
      nz: rnz * invLen,
    };
  }

  computeBiomeWeightsByPosition(
    worldX: number,
    worldZ: number,
  ): Record<string, number> {
    const influences = this.biomeSystem.getBiomeInfluencesAtPosition(
      worldX,
      worldZ,
      0,
    );
    const result: Record<string, number> = {};
    for (const inf of influences) {
      result[inf.type] = inf.weight;
    }
    if (influences.length === 0) {
      result[DEFAULT_BIOME] = 1.0;
    }
    return result;
  }

  private getBiomeAtWorldPosition(worldX: number, worldZ: number): string {
    return this.biomeSystem.getDominantBiome(worldX, worldZ, 0);
  }

  private generateTileResources(tile: TerrainTile): void {
    const biomeData = BIOMES[tile.biome];

    // Guard against undefined biome data
    if (!biomeData) {
      console.warn(
        `[TerrainSystem] Biome data not found for biome: ${tile.biome}`,
      );
      return;
    }

    // Re-enabled: tree spawning with optimized LOD system
    this.generateTreesForTile(tile);

    // Re-enabled for ore LOD testing
    // this.generateOtherResourcesForTile(tile, biomeData);

    // Generate decorative rocks (client only)
    const isClient = this.runtimeIsClient;
    if (isClient) {
      // this.generateDecorativeRocksForTile(tile, biomeData);
      // NOTE: Plants disabled - not working/looking good yet
      // this.generateDecorativePlantsForTile(tile, biomeData);
    }
    // Roads are now generated using noise patterns instead of segments
  }

  /**
   * Generate decorative (non-harvestable) rocks for a tile.
   * Uses procedural generation from @hyperforge/procgen/rock.
   */
  private generateDecorativeRocksForTile(
    tile: TerrainTile,
    biomeData: BiomeData,
  ): void {
    // Use default rock config if not specified in biome
    // Scale range reduced from [0.3, 1.5] to [0.2, 0.9] for more realistic ground rocks
    const rockConfig = biomeData.rocks ?? {
      enabled: true,
      density: 8, // 8 rocks per 100m²
      presets: BIOME_ROCK_PRESETS[tile.biome] ?? ["boulder", "pebble"],
      scaleRange: [0.2, 0.9] as [number, number],
      clusterChance: 0.3,
      minSpacing: 2.5, // Reduced spacing since rocks are smaller
    };

    if (!rockConfig.enabled) {
      return;
    }

    // Create context for resource generation
    const ctx: ResourceGenerationContext = {
      tileX: tile.x,
      tileZ: tile.z,
      tileKey: tile.key,
      tileSize: this.CONFIG.TILE_SIZE,
      waterThreshold: this.CONFIG.WATER_THRESHOLD,
      getHeightAt: (worldX, worldZ) => this.getHeightAt(worldX, worldZ),
      getWaterSurfaceAt: (worldX, worldZ) =>
        this.waterBodyRegistry.getWaterSurfaceAt(worldX, worldZ),
      isOnRoad: this.roadNetworkSystem
        ? (worldX, worldZ) => this.roadNetworkSystem!.isOnRoad(worldX, worldZ)
        : undefined,
      createRng: (salt) => this.createTileRng(tile.x, tile.z, salt),
    };

    // TEMPORARILY DISABLED - rock spawning disabled
    // const rocks = generateRocks(ctx, rockConfig, tile.biome);
    tile.decorativeRockIds = tile.decorativeRockIds ?? [];
  }

  /**
   * Generate decorative (non-harvestable) plants for a tile.
   * Uses procedural generation from @hyperforge/procgen/plant.
   * DISABLED: Plants not working/looking good yet
   */
  // private generateDecorativePlantsForTile(tile: TerrainTile, biomeData: BiomeData): void {
  //   // Use default plant config if not specified in biome
  //   const plantConfig = biomeData.plants ?? {
  //     enabled: true,
  //     density: 15, // 15 plants per 100m²
  //     presets: BIOME_PLANT_PRESETS[tile.biome] ?? ["monstera", "philodendron"],
  //     scaleRange: [0.5, 1.2] as [number, number],
  //     minSpacing: 1.5,
  //     clustering: true,
  //     clusterSize: [2, 4] as [number, number],
  //   };
  //
  //   if (!plantConfig.enabled) {
  //     return;
  //   }
  //
  //   // Create context for resource generation
  //   const ctx: ResourceGenerationContext = {
  //     tileX: tile.x,
  //     tileZ: tile.z,
  //     tileKey: tile.key,
  //     tileSize: this.CONFIG.TILE_SIZE,
  //     waterThreshold: this.CONFIG.WATER_THRESHOLD,
  //     getHeightAt: (worldX, worldZ) => this.getHeightAt(worldX, worldZ),
  //     isOnRoad: this.roadNetworkSystem
  //       ? (worldX, worldZ) => this.roadNetworkSystem!.isOnRoad(worldX, worldZ)
  //       : undefined,
  //     createRng: (salt) => this.createTileRng(tile.x, tile.z, salt),
  //   };
  //
  //   // Generate plant placement data
  //   const plants = generatePlants(ctx, plantConfig, tile.biome);
  //
  //   // Initialize array if not exists
  //   tile.decorativePlantIds = tile.decorativePlantIds ?? [];
  //
  //   // Add each plant to the instancer (async but don't wait)
  //   for (const plant of plants) {
  //     const position = new THREE.Vector3(plant.position.x, plant.position.y, plant.position.z);
  //     addPlantInstance(plant.assetId, position, plant.rotation.y, plant.scale, plant.id)
  //       .then((id) => {
  //         if (id && tile.decorativePlantIds) {
  //           tile.decorativePlantIds.push(id);
  //         }
  //       })
  //       .catch((err) => {
  //         console.warn(`[TerrainSystem] Failed to add plant instance:`, err);
  //       });
  //   }
  // }

  /**
   * Generate harvestable trees for a tile based on biome configuration.
   * Uses the extracted BiomeResourceGenerator for the actual algorithm.
   * getTreeConfigForBiome always returns a config (falls back to forest).
   */
  private createTreeGenerationSource(
    tileX: number,
    tileZ: number,
  ): TreeGenerationSource {
    const biome = this.getBiomeAt(tileX, tileZ);
    const treeConfig = BIOMES[biome]?.trees ?? getTreeConfigForBiome(biome);
    // Create context for resource generation.
    // getDominantBiome lets generateTrees() resolve the actual biome at each
    // tree position instead of using the single tile-center biome, which
    // prevents wrong tree types appearing near biome boundaries.
    const biomeSystem = this.biomeSystem;
    const ctx: ResourceGenerationContext = {
      tileX,
      tileZ,
      tileKey: `${tileX}_${tileZ}`,
      tileSize: this.CONFIG.TILE_SIZE,
      waterThreshold: this.CONFIG.WATER_THRESHOLD,
      // Placement must not depend on which neighbouring mesh is resident.
      getHeightAt: (worldX, worldZ) =>
        this.getResourceGroundHeight(worldX, worldZ),
      getWaterSurfaceAt: (worldX, worldZ) =>
        this.waterBodyRegistry.getWaterSurfaceAt(worldX, worldZ),
      isOnRoad: this.roadNetworkSystem
        ? (worldX, worldZ) => this.roadNetworkSystem!.isOnRoad(worldX, worldZ)
        : undefined,
      createRng: (salt) => this.createTileRng(tileX, tileZ, salt),
      getDominantBiome: (worldX, worldZ) =>
        biomeSystem.getDominantBiome(worldX, worldZ, 0),
    };

    return { context: ctx, config: treeConfig };
  }

  private generateTreesForTile(tile: TerrainTile): void {
    const result = generateCenteredTrees(
      { tileX: tile.x, tileZ: tile.z },
      this.CONFIG.TILE_SIZE,
      (x, z) => this.createTreeGenerationSource(x, z),
      isPositionInsideDuelArenaZone,
    );
    const layout = DataManager.getWorldConfig()?.compactResourceGroves;
    if (!layout) {
      tile.resources.push(...result.resources);
      return;
    }
    const reservedIds = new Set(
      result.resources.map(
        ({ position }) =>
          `tree_${(tile.x * this.CONFIG.TILE_SIZE + position.x).toFixed(0)}_${(tile.z * this.CONFIG.TILE_SIZE + position.z).toFixed(0)}`,
      ),
    );
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      for (const point of area.resources ?? []) {
        if (point.type !== "tree") continue;
        const x = Math.floor(point.position.x) + 0.5;
        const z = Math.floor(point.position.z) + 0.5;
        // A relocated authored actor reserves both its durable old ID and its
        // actual occupied anchor, which can have a different coordinate ID.
        reservedIds.add(`tree_${x.toFixed(0)}_${z.toFixed(0)}`);
        if (point.instanceId) reservedIds.add(point.instanceId);
      }
    }
    const groves = createCompactResourceGroveNodes(
      layout,
      { tileX: tile.x, tileZ: tile.z },
      this.createTreeGenerationSource(tile.x, tile.z),
      reservedIds,
      isPositionInsideDuelArenaZone,
    );
    // Publish only after the entire frozen owner passes. Never backfill/drop an
    // unsafe anchor or replace the existing seeded candidate population.
    tile.resources.push(...result.resources, ...groves);
  }

  /**
   * Generate ore nodes and other resources for a tile based on biome configuration.
   * Uses the extracted BiomeResourceGenerator for ores.
   */
  private generateOtherResourcesForTile(
    tile: TerrainTile,
    biomeData: BiomeData,
  ): void {
    // Generate ore nodes from biome ore config
    this.generateOresForTile(tile, biomeData);

    // Generate other resources (herbs, fishing spots) from legacy config
    const otherResources = biomeData.resources.filter(
      (r) =>
        // r !== "tree" &&
        r !== "trees" && r !== "ore" && r !== "ores" && r !== "rock",
    );

    for (const resourceType of otherResources) {
      const rng = this.createTileRng(tile.x, tile.z, `res:${resourceType}`);
      let resourceCount = 0;

      // Determine count based on resource type and biome
      switch (resourceType) {
        case "fish":
        case "fishing_spots":
          resourceCount = (tile.biome as string) === "lakes" ? 3 : 0;
          break;
        case "herb":
          resourceCount = Math.floor(rng() * 3);
          break;
        case "gem":
          resourceCount = rng() < 0.1 ? 1 : 0; // Rare
          break;
      }

      for (let i = 0; i < resourceCount; i++) {
        const localX = rng() * this.CONFIG.TILE_SIZE;
        const localZ = rng() * this.CONFIG.TILE_SIZE;
        const worldX = tile.x * this.CONFIG.TILE_SIZE + localX;
        const worldZ = tile.z * this.CONFIG.TILE_SIZE + localZ;

        // For fishing spots, place in water only (ocean or elevated body)
        if (resourceType === "fish" || resourceType === "fishing_spots") {
          const height = this.getHeightAt(worldX, worldZ);
          if (!this.waterBodyRegistry.isUnderwater(worldX, worldZ, height))
            continue;
        }

        const height = this.getHeightAt(worldX, worldZ);

        const resource: ResourceNode = {
          id: `${tile.key}_${resourceType}_${i}`,
          type:
            resourceType === "fishing_spots"
              ? "fish"
              : (resourceType as ResourceNode["type"]),
          position: { x: localX, y: height, z: localZ },
          mesh: null,
          health: 100,
          maxHealth: 100,
          respawnTime: 300000, // 5 minutes
          harvestable: true,
          requiredLevel: 1,
        };

        tile.resources.push(resource);
      }
    }
  }

  /**
   * Generate ore nodes for a tile based on biome ore configuration.
   * Uses the extracted BiomeResourceGenerator for the actual algorithm.
   */
  private generateOresForTile(tile: TerrainTile, biomeData: BiomeData): void {
    const oreConfig = biomeData.ores;
    if (!oreConfig) {
      return;
    }

    // Create context for resource generation
    const ctx: ResourceGenerationContext = {
      tileX: tile.x,
      tileZ: tile.z,
      tileKey: tile.key,
      tileSize: this.CONFIG.TILE_SIZE,
      waterThreshold: this.CONFIG.WATER_THRESHOLD,
      getHeightAt: (worldX, worldZ) => this.getHeightAt(worldX, worldZ),
      getWaterSurfaceAt: (worldX, worldZ) =>
        this.waterBodyRegistry.getWaterSurfaceAt(worldX, worldZ),
      isOnRoad: this.roadNetworkSystem
        ? (worldX, worldZ) => this.roadNetworkSystem!.isOnRoad(worldX, worldZ)
        : undefined,
      createRng: (salt) => this.createTileRng(tile.x, tile.z, salt),
    };

    // Generate ores using the extracted algorithm
    const ores = generateOres(ctx, oreConfig);
    tile.resources.push(...ores);
  }

  // DEPRECATED: Roads are now generated using noise patterns instead of segments
  private generateRoadsForTile(_tile: TerrainTile): void {
    // No longer generating road segments - using noise-based paths instead
  }

  /**
   * Calculate road influence for vertex coloring
   */
  private calculateRoadVertexInfluence(
    tileX: number,
    tileZ: number,
  ): Map<string, number> {
    const roadMap = new Map<string, number>();

    // Generate temporary tile to get road data
    const tempTile: TerrainTile = {
      key: `temp_${tileX}_${tileZ}`,
      x: tileX,
      z: tileZ,
      mesh: null as unknown as THREE.Mesh,
      biome: this.getBiomeAt(tileX, tileZ) as TerrainTile["biome"],
      resources: [],
      roads: [],
      generated: false,
      contentGenerated: false,
      playerCount: 0,
      needsSave: false,
      collision: null,
      waterMeshes: [],
      heightData: [],
      lastActiveTime: new Date(),
      chunkSeed: 0,
      heightMap: new Float32Array(0),
      collider: null,
      lastUpdate: Date.now(),
    };

    // Roads are now generated using noise patterns

    // Calculate influence for each vertex position
    const resolution = this.CONFIG.TILE_RESOLUTION;
    const step = this.CONFIG.TILE_SIZE / (resolution - 1);

    // OPTIMIZATION: Reuse pre-allocated Vector2s to avoid allocations in nested loop
    const pointVec = this._tempVec2;
    const startVec = this._tempVec2_2;
    const endVec = this._tempVec2_3;

    for (let i = 0; i < resolution; i++) {
      for (let j = 0; j < resolution; j++) {
        const localX = (i - (resolution - 1) / 2) * step;
        const localZ = (j - (resolution - 1) / 2) * step;

        let maxInfluence = 0;

        // Check distance to each road segment
        for (const road of tempTile.roads) {
          // Set point position
          pointVec.set(localX, localZ);

          // Set start position (reuse if already Vector2, otherwise convert)
          if (road.start instanceof THREE.Vector2) {
            startVec.copy(road.start);
          } else {
            startVec.set(road.start.x, road.start.z);
          }

          // Set end position (reuse if already Vector2, otherwise convert)
          if (road.end instanceof THREE.Vector2) {
            endVec.copy(road.end);
          } else {
            endVec.set(road.end.x, road.end.z);
          }

          const distanceToRoad = this.distanceToLineSegment(
            pointVec,
            startVec,
            endVec,
          );

          // Calculate influence based on distance (closer = more influence)
          const halfWidth = road.width * 0.5;
          if (distanceToRoad <= halfWidth) {
            const influence = 1 - distanceToRoad / halfWidth;
            maxInfluence = Math.max(maxInfluence, influence);
          }
        }

        if (maxInfluence > 0) {
          roadMap.set(
            `${localX.toFixed(1)},${localZ.toFixed(1)}`,
            maxInfluence,
          );
        }
      }
    }

    return roadMap;
  }

  /**
   * Calculate distance from point to line segment
   */
  private distanceToLineSegment(
    point: THREE.Vector2,
    lineStart: THREE.Vector2,
    lineEnd: THREE.Vector2,
  ): number {
    const lineLengthSquared = lineStart.distanceToSquared(lineEnd);

    if (lineLengthSquared === 0) {
      return point.distanceTo(lineStart);
    }

    const t = Math.max(
      0,
      Math.min(
        1,
        this._tempVec2
          .copy(point)
          .sub(lineStart)
          .dot(this._tempVec2_2.copy(lineEnd).sub(lineStart)) /
          lineLengthSquared,
      ),
    );

    const projection = this._tempVec2
      .copy(lineStart)
      .add(this._tempVec2_2.copy(lineEnd).sub(lineStart).multiplyScalar(t));

    return point.distanceTo(projection);
  }

  /**
   * Store height data for persistence and collision generation
   */
  private storeHeightData(
    tileX: number,
    tileZ: number,
    heightData: number[],
  ): void {
    const key = `${tileX}_${tileZ}`;
    const tile = this.terrainTiles.get(key);

    if (tile) {
      tile.heightData = heightData;
      tile.needsSave = true;
    }
  }

  private saveModifiedChunks(): void {
    // Assume database system exists - this method is only called on server
    const chunksToSave = Array.from(this.terrainTiles.values()).filter(
      (tile) => tile.needsSave,
    );

    for (const tile of chunksToSave) {
      const chunkData: WorldChunkData = {
        chunkX: tile.x,
        chunkZ: tile.z,
        data: JSON.stringify({
          biome: tile.biome || "grassland",
          heightData: tile.heightData || [],
          chunkSeed: tile.chunkSeed || 0,
        }),
        lastActive: tile.lastActiveTime?.getTime() || Date.now(),
        playerCount: tile.playerCount || 0,
        version: this.worldStateVersion,
      };

      if (this.databaseSystem) {
        this.databaseSystem.saveWorldChunk(chunkData);
      }
      tile.needsSave = false;
    }

    if (chunksToSave.length > 0) {
      // Chunks successfully saved to database
    }
  }

  update(_deltaTime: number): void {
    // Skip processing until terrain is fully initialized (DataManager loaded BIOMES)
    // This prevents race conditions where update() is called before start() completes
    if (!this._terrainInitialized) {
      return;
    }

    // Dispatch pending tiles to workers for pre-computation (client only)
    if (this.runtimeIsClient && this.CONFIG.USE_WORKERS) {
      this.dispatchWorkerBatch();
    }

    // Process queued tile generations within a small per-frame budget
    // (also processes pre-computed worker results when available)
    this.processTileGenerationQueue();

    // Process queued collision generation and walkability baking on the server
    if (this.world.network?.isServer) {
      this.processCollisionGenerationQueue();
      this.processWalkabilityQueue();
    }

    // Process pending resource instance creation (client only, spreads work across frames)
    if (this.runtimeIsClient) {
      this.processResourceInstanceQueue();
    }

    // Update quad-tree LOD visual manager (client only)
    if (this.runtimeIsClient && this.quadTreeVisualManager) {
      const centers = this.getTerrainCenters();
      if (centers.length > 0) {
        const pos = centers[0].position;

        // Set grass player position BEFORE quad-tree update so
        // onNodeNeedsGeometry dispatches with correct LOD & distance
        if (this.grassVisualManager) {
          this.grassVisualManager.setPlayerPosition(pos.x, pos.z);
        }

        this.quadTreeVisualManager.update(pos.x, pos.z);
        this.compactPondDressing?.update(
          _deltaTime,
          (x, z) =>
            this.quadTreeVisualManager?.getRetainedSurfaceAt(x, z) ?? null,
        );

        if (this.grassVisualManager) {
          this.grassVisualManager.update(pos.x, pos.z, this.world.camera);
        }
      }
    }

    // Update instance visibility on client based on player position
    if (this.runtimeIsClient && this.instancedMeshManager) {
      this.instancedMeshManager.updateAllInstanceVisibility();

      // TEMPORARILY DISABLED - rock instancer update
      // const rockInstancer = ProcgenRockInstancer.getInstance(null);
      // if (rockInstancer) {
      //   rockInstancer.update(_deltaTime);
      // }
      // Plant instancer disabled - not working/looking good yet
      // const plantInstancer = ProcgenPlantInstancer.getInstance(null);
      // if (plantInstancer) {
      //   plantInstancer.update(_deltaTime);
      // }

      // Log pooling stats occasionally for debugging
      if (Math.random() < 0.002) {
        // Log approximately once every 500 frames at 60fps
        const _stats = this.instancedMeshManager.getPoolingStats();
      }
    }

    // Animate water, grass, and terrain caustics (client-side only)
    if (this.runtimeIsClient) {
      const dt =
        typeof _deltaTime === "number" && isFinite(_deltaTime)
          ? _deltaTime
          : 1 / 60;

      // Update terrain time for animated caustics
      this.terrainTime += dt;
      const materialWithUniforms = this.getTerrainMaterialWithUniforms();
      if (materialWithUniforms) {
        materialWithUniforms.terrainUniforms.time.value = this.terrainTime;

        // Sync sun direction + day intensity from Environment system
        const env = this.world.getSystem("environment") as {
          lightDirection?: THREE.Vector3;
          getDayIntensity?: () => number;
        } | null;
        if (env?.lightDirection) {
          materialWithUniforms.terrainUniforms.sunDirection.value
            .copy(env.lightDirection)
            .negate();
          if (this.grassVisualManager) {
            this.grassVisualManager.updateLighting(
              materialWithUniforms.terrainUniforms.sunDirection.value,
            );
          }
        }
        if (env?.getDayIntensity) {
          const dayVal = env.getDayIntensity();
          materialWithUniforms.terrainUniforms.dayIntensity.value = dayVal;
          if (this.grassVisualManager) {
            this.grassVisualManager.updateDayIntensity(dayVal);
          }
        }

        // Fog texture is the shared fogRenderTarget from FogConfig — no sync needed

        // Update lamppost vertex lights (night-only)
        if (isLamppostLightTextureReady()) {
          updateTerrainVertexLights(materialWithUniforms.terrainUniforms, []);
        } else {
          this.lamppostLightUpdateTimer += dt;
          if (this.lamppostLightUpdateTimer >= LAMP_LIGHT_UPDATE_INTERVAL_SEC) {
            this.lamppostLightUpdateTimer = 0;
            this.syncLamppostVertexLights(materialWithUniforms);
          }
        }
      }

      // Update water system
      if (this.waterSystem) {
        this.waterSystem.update(dt);
      }
    }
  }

  /**
   * Update terrain vertex lights from nearby lampposts (night-only)
   */
  private syncLamppostVertexLights(material: {
    terrainUniforms: TerrainUniforms;
  }): void {
    const environment = this.world.getSystem("environment") as {
      getDayIntensity?: () => number;
    } | null;
    const dayIntensity = environment?.getDayIntensity?.() ?? 1;
    const nightMix = this.computeNightMix(dayIntensity);

    if (nightMix <= 0.001) {
      updateTerrainVertexLights(material.terrainUniforms, []);
      return;
    }

    const landmarksSystem = this.world.getSystem("town-landmarks") as {
      getLamppostLightPositions?: () => ReadonlyArray<THREE.Vector3>;
    } | null;
    const lightPositions = landmarksSystem?.getLamppostLightPositions?.() ?? [];

    if (lightPositions.length === 0) {
      updateTerrainVertexLights(material.terrainUniforms, []);
      return;
    }

    const origin = this.world.rig.position;
    const maxRangeSq = LAMP_LIGHT_SEARCH_RANGE * LAMP_LIGHT_SEARCH_RANGE;

    this.lamppostLightIndices.length = 0;
    this.lamppostLightDistances.length = 0;

    for (let i = 0; i < lightPositions.length; i++) {
      const pos = lightPositions[i];
      const dx = pos.x - origin.x;
      const dy = pos.y - origin.y;
      const dz = pos.z - origin.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > maxRangeSq) continue;

      if (this.lamppostLightIndices.length < MAX_VERTEX_LIGHTS) {
        this.lamppostLightIndices.push(i);
        this.lamppostLightDistances.push(distSq);
        continue;
      }

      let worstIndex = 0;
      let worstDist = this.lamppostLightDistances[0];
      for (let j = 1; j < this.lamppostLightDistances.length; j++) {
        if (this.lamppostLightDistances[j] > worstDist) {
          worstDist = this.lamppostLightDistances[j];
          worstIndex = j;
        }
      }
      if (distSq < worstDist) {
        this.lamppostLightIndices[worstIndex] = i;
        this.lamppostLightDistances[worstIndex] = distSq;
      }
    }

    const count = this.lamppostLightIndices.length;
    if (count === 0) {
      updateTerrainVertexLights(material.terrainUniforms, []);
      return;
    }

    while (this.lamppostActiveLights.length < count) {
      this.lamppostActiveLights.push({
        position: new THREE.Vector3(),
        color: new THREE.Color(),
        intensity: 0,
        range: 1,
      });
    }
    this.lamppostActiveLights.length = count;

    const intensity = LAMP_VERTEX_LIGHT_INTENSITY * nightMix;
    for (let i = 0; i < count; i++) {
      const index = this.lamppostLightIndices[i];
      const pos = lightPositions[index];
      const light = this.lamppostActiveLights[i];
      light.position.copy(pos);
      light.color.copy(LAMP_VERTEX_LIGHT_COLOR);
      light.intensity = intensity;
      light.range = LAMP_VERTEX_LIGHT_RANGE;
    }

    updateTerrainVertexLights(
      material.terrainUniforms,
      this.lamppostActiveLights,
    );
  }

  /**
   * Compute night mix for lamp activation (0 = day, 1 = full night)
   */
  private computeNightMix(dayIntensity: number): number {
    const night = 1 - dayIntensity;
    const t = Math.max(0, Math.min(1, (night - 0.4) / 0.3));
    return t * t * (3 - 2 * t);
  }

  private checkPlayerMovement(): void {
    // Get player positions and update loaded tiles accordingly
    const players = this.world.getPlayers() || [];

    for (const player of players) {
      const x = player.node.position.x;
      const z = player.node.position.z;

      const tileX = Math.floor(x / this.CONFIG.TILE_SIZE);
      const tileZ = Math.floor(z / this.CONFIG.TILE_SIZE);

      // Check if player moved to a new tile
      if (tileX !== this.lastPlayerTile.x || tileZ !== this.lastPlayerTile.z) {
        this.updateTilesAroundPlayer(tileX, tileZ);
        this.lastPlayerTile = { x: tileX, z: tileZ };
      }
    }
  }

  private updateTilesAroundPlayer(centerX: number, centerZ: number): void {
    const requiredTiles = new Set<string>();

    // Generate list of required tiles (3x3 around player)
    for (
      let dx = -this.CONFIG.VIEW_DISTANCE;
      dx <= this.CONFIG.VIEW_DISTANCE;
      dx++
    ) {
      for (
        let dz = -this.CONFIG.VIEW_DISTANCE;
        dz <= this.CONFIG.VIEW_DISTANCE;
        dz++
      ) {
        const tileX = centerX + dx;
        const tileZ = centerZ + dz;
        requiredTiles.add(`${tileX}_${tileZ}`);
      }
    }

    // Unload tiles that are no longer needed
    for (const [key, tile] of this.terrainTiles) {
      if (!requiredTiles.has(key)) {
        this.unloadTile(tile);
      }
    }

    // Load new tiles that are needed
    for (const key of requiredTiles) {
      if (!this.terrainTiles.has(key)) {
        const [tileX, tileZ] = key.split("_").map(Number);
        this.generateTile(tileX, tileZ);
      }
    }
  }

  /**
   * Safely dispose a Three.js material, handling WebGPU NodeMaterial edge cases
   * where the internal nodeBuilderState may be undefined if the material was
   * never rendered or already cleaned up by the renderer.
   */
  private safeDisposeMaterial(material: THREE.Material): void {
    try {
      material.dispose();
    } catch (err) {
      // WebGPU NodeMaterial may throw if nodeBuilderState was never created
      // (e.g., material was never rendered before disposal)
      // This is safe to ignore - the material is still cleaned up
      if (err instanceof TypeError && String(err).includes("usedTimes")) {
        // Expected error for unrendered WebGPU materials - silently ignore
      } else {
        console.warn("[TerrainSystem] Material disposal error:", err);
      }
    }
  }

  private unloadTile(tile: TerrainTile): void {
    if (this.terrainTiles.get(tile.key) !== tile) return;
    if (this.pendingContentPromotions.get(tile.key) === tile)
      this.pendingContentPromotions.delete(tile.key);
    // Cancel any pending/in-progress walkability baking for this tile
    if (this.runtimeIsServer) {
      this.pendingWalkabilityTiles = this.pendingWalkabilityTiles.filter(
        (t) => t.tileX !== tile.x || t.tileZ !== tile.z,
      );
      if (
        this.walkabilityProgress &&
        this.walkabilityProgress.tileX === tile.x &&
        this.walkabilityProgress.tileZ === tile.z
      ) {
        this.walkabilityProgress = null;
      }
    }
    // Clear baked terrain walkability flags (server-only)
    if (this.runtimeIsServer && this.world?.collision) {
      const tileSize = this.CONFIG.TILE_SIZE;
      const originX = tile.x * tileSize - tileSize * 0.5;
      const originZ = tile.z * tileSize - tileSize * 0.5;
      const tilesPerSide = Math.floor(tileSize / 1.0);
      const terrainFlagsMask = CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE;
      this.world.collision.replaceFlagsInRegion(
        Math.floor(originX),
        Math.floor(originZ),
        tilesPerSide,
        tilesPerSide,
        terrainFlagsMask,
        new Int32Array(tilesPerSide * tilesPerSide),
      );
    }

    // Clean up road meshes
    for (const road of tile.roads) {
      if (road.mesh && road.mesh.parent) {
        road.mesh.parent.remove(road.mesh);
        road.mesh.geometry.dispose();
        if (road.mesh.material instanceof THREE.Material) {
          this.safeDisposeMaterial(road.mesh.material);
        }
        road.mesh = null;
      }
    }

    // Remove instanced meshes for this tile
    if (this.instancedMeshManager) {
      for (const resource of tile.resources) {
        if (resource.instanceId != null && resource.meshType) {
          this.instancedMeshManager.removeInstance(
            resource.meshType,
            resource.instanceId,
          );
        }
      }
    }

    // Remove decorative rock instances
    if (tile.decorativeRockIds?.length) {
      const rockInstancer = ProcgenRockInstancer.getInstance(null);
      if (rockInstancer) {
        for (const id of tile.decorativeRockIds) {
          rockInstancer.removeInstance(id);
        }
      }
      tile.decorativeRockIds = [];
    }

    // Remove decorative plant instances
    if (tile.decorativePlantIds?.length) {
      const plantInstancer = ProcgenPlantInstancer.getInstance(null);
      if (plantInstancer) {
        for (const id of tile.decorativePlantIds) {
          plantInstancer.removeInstance(id);
        }
      }
      tile.decorativePlantIds = [];
    }

    // Clean up water meshes
    if (tile.waterMeshes) {
      for (const waterMesh of tile.waterMeshes) {
        if (waterMesh.parent) {
          waterMesh.parent.remove(waterMesh);
          waterMesh.geometry.dispose();
          if (waterMesh.material instanceof THREE.Material) {
            this.safeDisposeMaterial(waterMesh.material);
          }
        }
      }
      tile.waterMeshes = [];
    }

    // Remove main tile mesh from scene
    if (this.terrainContainer && tile.mesh.parent) {
      this.terrainContainer.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      if (tile.mesh.material instanceof THREE.Material) {
        this.safeDisposeMaterial(tile.mesh.material);
      }
    }

    // Remove collision
    if (tile.collision) {
      tile.collision.release();
    }

    // Save if needed
    if (tile.needsSave && this.databaseSystem) {
      // Save tile data before unloading
      // This would be implemented when we have the database schema
    }

    // Remove from maps
    this.terrainTiles.delete(tile.key);
    this.activeChunks.delete(tile.key);
    // Remove cached bounding box if present
    this.terrainBoundingBoxes.delete(tile.key);
    // Remove pending serialization data to prevent unbounded memory growth
    this.pendingSerializationData.delete(tile.key);
    this.emitTileUnloaded(`${tile.x},${tile.z}`, tile.x, tile.z);
  }

  // ===== TERRAIN MOVEMENT CONSTRAINTS (GDD Requirement) =====

  /**
   * Check if a position is walkable based on terrain constraints
   * Implements GDD rules: "Water bodies are impassable" and "Steep mountain slopes block movement"
   */
  isPositionWalkable(
    worldX: number,
    worldZ: number,
  ): { walkable: boolean; reason?: string } {
    if (!this.isPositionWalkableFast(worldX, worldZ)) {
      // Only allocate the reason object on the slow path (non-walkable)
      // Check center and corners for water (ocean or elevated body)
      const waterSurface = this.waterBodyRegistry.getWaterSurfaceAt(
        worldX,
        worldZ,
      );
      const tx = Math.floor(worldX);
      const tz = Math.floor(worldZ);
      if (
        this.getHeightAt(worldX, worldZ) < waterSurface ||
        this.getHeightAt(tx, tz) < waterSurface ||
        this.getHeightAt(tx + 1, tz) < waterSurface ||
        this.getHeightAt(tx, tz + 1) < waterSurface ||
        this.getHeightAt(tx + 1, tz + 1) < waterSurface
      ) {
        return { walkable: false, reason: "Water bodies are impassable" };
      }
      const tileX = Math.floor(worldX / this.CONFIG.TILE_SIZE);
      const tileZ = Math.floor(worldZ / this.CONFIG.TILE_SIZE);
      const biome = this.getBiomeAt(tileX, tileZ);
      if (biome === "lakes") {
        return { walkable: false, reason: "Lake water is impassable" };
      }
      return {
        walkable: false,
        reason: "Steep mountain slopes block movement",
      };
    }
    return { walkable: true };
  }

  /**
   * Fast boolean-only walkability check — no object allocation.
   * Used by BFS pathfinding hot path where reason string isn't needed.
   */
  isPositionWalkableFast(worldX: number, worldZ: number): boolean {
    const tileX = Math.floor(worldX / this.CONFIG.TILE_SIZE);
    const tileZ = Math.floor(worldZ / this.CONFIG.TILE_SIZE);
    const biome = this.getBiomeAt(tileX, tileZ);

    // Special case for lakes biome - always impassable
    if (biome === "lakes") return false;

    const biomeData = BIOMES[biome];

    // Check if center or any corner of this tile is underwater (ocean or elevated body)
    const waterSurface = this.waterBodyRegistry.getWaterSurfaceAt(
      worldX,
      worldZ,
    );
    const tx = Math.floor(worldX);
    const tz = Math.floor(worldZ);
    if (
      this.getHeightAt(worldX, worldZ) < waterSurface ||
      this.getHeightAt(tx, tz) < waterSurface ||
      this.getHeightAt(tx + 1, tz) < waterSurface ||
      this.getHeightAt(tx, tz + 1) < waterSurface ||
      this.getHeightAt(tx + 1, tz + 1) < waterSurface
    )
      return false;

    // Check slope constraints
    const slope = this.calculateSlope(worldX, worldZ);
    if (slope > biomeData.maxSlope) return false;

    return true;
  }

  /**
   * Unified walkability check combining CollisionMatrix and terrain.
   *
   * This is the single source of truth for tile walkability:
   * 1. Check CollisionMatrix for static objects (trees, rocks, stations, entities)
   * 2. Check terrain constraints (water, slopes)
   *
   * @param worldX - World X coordinate
   * @param worldZ - World Z coordinate
   * @returns Whether the position is walkable
   */
  isTileWalkable(worldX: number, worldZ: number): boolean {
    // Convert to tile coordinates
    const tile = worldToTile(worldX, worldZ);

    // Check CollisionMatrix for static objects and entities
    if (
      this.world.collision.hasFlags(
        tile.x,
        tile.z,
        CollisionMask.BLOCKS_MOVEMENT,
      )
    ) {
      return false;
    }

    // Check terrain walkability (water, slopes)
    const terrainCheck = this.isPositionWalkable(worldX, worldZ);
    return terrainCheck.walkable;
  }

  /**
   * Calculate slope at a given world position using 8-directional sampling.
   * Includes cardinal and diagonal directions to catch steep slopes that
   * might be missed by 4-directional sampling.
   */
  private calculateSlope(worldX: number, worldZ: number): number {
    const d = this.CONFIG.SLOPE_CHECK_DISTANCE;
    const c = this.getHeightAt(worldX, worldZ);
    const invD = 1 / d;
    const invDiag = 1 / (d * Math.SQRT2);

    // Calculate max slope inline (zero allocation — no array, no spread)
    let maxSlope = Math.abs(this.getHeightAt(worldX, worldZ + d) - c) * invD;
    let s: number;
    s = Math.abs(this.getHeightAt(worldX, worldZ - d) - c) * invD;
    if (s > maxSlope) maxSlope = s;
    s = Math.abs(this.getHeightAt(worldX + d, worldZ) - c) * invD;
    if (s > maxSlope) maxSlope = s;
    s = Math.abs(this.getHeightAt(worldX - d, worldZ) - c) * invD;
    if (s > maxSlope) maxSlope = s;
    s = Math.abs(this.getHeightAt(worldX + d, worldZ + d) - c) * invDiag;
    if (s > maxSlope) maxSlope = s;
    s = Math.abs(this.getHeightAt(worldX - d, worldZ + d) - c) * invDiag;
    if (s > maxSlope) maxSlope = s;
    s = Math.abs(this.getHeightAt(worldX + d, worldZ - d) - c) * invDiag;
    if (s > maxSlope) maxSlope = s;
    s = Math.abs(this.getHeightAt(worldX - d, worldZ - d) - c) * invDiag;
    if (s > maxSlope) maxSlope = s;
    return maxSlope;
  }

  /**
   * Check if a terrain tile has been generated.
   * Used by pathfinding to determine if walkability flags have been baked.
   */
  isTerrainTileGenerated(terrainTileX: number, terrainTileZ: number): boolean {
    return this.terrainTiles.has(`${terrainTileX}_${terrainTileZ}`);
  }

  /**
   * Whether server walkability flags have been baked for the terrain containing
   * this world position. Generated tiles bake WATER/STEEP_SLOPE synchronously,
   * so movement can trust CollisionMatrix instead of recomputing procedural
   * height, biome, water, and slope data in its hot path.
   */
  hasBakedWalkabilityAt(worldX: number, worldZ: number): boolean {
    return this.isTerrainTileGenerated(
      this.worldToTerrainTileIndex(worldX),
      this.worldToTerrainTileIndex(worldZ),
    );
  }

  /**
   * Pre-compute WATER and STEEP_SLOPE collision flags for all movement tiles
   * within a terrain tile. Called once when terrain is generated.
   *
   * This eliminates runtime terrain queries during BFS pathfinding —
   * walkability becomes a single bitwise AND against the CollisionMatrix.
   *
   * WATER flags use a forward approach that replicates the WaterSystem's
   * generateWaterMesh() quad-inclusion logic: heights are sampled at the same
   * 1.5625m spacing (100m / 64 quads) the water mesh uses, and any quad with
   * at least one corner below WATER_THRESHOLD blocks the movement tiles whose
   * CENTER falls inside that quad. The grid is extended one cell beyond the
   * movement tile range in each direction so that water quads originating from
   * adjacent terrain tiles (which may not be loaded yet) are still caught.
   *
   * Grid positions align with the water mesh grid modulo 1.5625m, so the
   * quad-inclusion decisions are identical to what the client renders.
   */
  private bakeWalkabilityFlags(
    terrainTileX: number,
    terrainTileZ: number,
  ): void {
    const collision = this.world?.collision;
    if (!collision) return;

    const tileSize = this.CONFIG.TILE_SIZE; // 100m terrain tile
    const tilesPerSide = Math.floor(tileSize / 1.0); // 100 movement tiles per side
    const wt = this.CONFIG.WATER_THRESHOLD;

    // Terrain geometry is centered on tileIndex * tileSize. Its movement grid
    // therefore begins half a tile before the mesh position.
    const originX = terrainTileX * tileSize - tileSize * 0.5;
    const originZ = terrainTileZ * tileSize - tileSize * 0.5;
    const originXInt = Math.floor(originX);
    const originZInt = Math.floor(originZ);

    const terrainFlagsMask = CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE;
    const terrainFlags = new Int32Array(tilesPerSide * tilesPerSide);

    // ---- PASS 1: Water flags (aligned with visual water mesh) ----
    //
    // The water mesh samples at 64 quads per terrain tile = 1.5625m cell size.
    // To cover ALL movement tiles [originX, originX+100) we need a grid that
    // extends from originX-cellSize to originX+tileSize (one extra cell of
    // margin so water quads starting just before the tile range are caught).
    //
    // Grid samples: waterRes+2 = 66 points per axis → 65 quads per axis.
    // Grid aligns with the water mesh grid (offset is a multiple of cellSize).
    // Total height lookups: 66×66 = 4356.
    const waterRes = 64;
    const cellSize = tileSize / waterRes; // 1.5625m
    const gridPoints = waterRes + 2; // 66 sample points per axis
    const gridQuads = waterRes + 1; // 65 quads per axis
    const gridStartX = originX - cellSize;
    const gridStartZ = originZ - cellSize;

    const heights = new Float64Array(gridPoints * gridPoints);

    for (let i = 0; i < gridPoints; i++) {
      const wx = gridStartX + i * cellSize;
      const iStride = i * gridPoints;
      for (let j = 0; j < gridPoints; j++) {
        const wz = gridStartZ + j * cellSize;
        heights[iStride + j] = this.getHeightAt(wx, wz);
      }
    }

    // Track which movement tiles are flagged as water (avoids double-flagging)
    const waterTileFlags = new Uint8Array(tilesPerSide * tilesPerSide);

    // For each water quad, if ANY corner < threshold, mark ALL movement tiles
    // that overlap the quad (not just tiles whose center is inside). This ensures
    // the walkability boundary matches the visual water mesh — water quads at the
    // shore extend ~1.5m past the height<threshold line, and players must not be
    // able to walk onto any tile covered by the water mesh.
    for (let i = 0; i < gridQuads; i++) {
      const iStride = i * gridPoints;
      const i1Stride = (i + 1) * gridPoints;
      for (let j = 0; j < gridQuads; j++) {
        if (
          heights[iStride + j] >= wt &&
          heights[i1Stride + j] >= wt &&
          heights[iStride + j + 1] >= wt &&
          heights[i1Stride + j + 1] >= wt
        )
          continue; // No water in this quad

        // Quad spans X: [qMinX, qMaxX], tile lx spans [originXInt+lx, originXInt+lx+1].
        // Any-overlap: tile overlaps quad when lx < qMaxX-originXInt AND lx+1 > qMinX-originXInt.
        const qMinX = gridStartX + i * cellSize;
        const qMaxX = qMinX + cellSize;
        const qMinZ = gridStartZ + j * cellSize;
        const qMaxZ = qMinZ + cellSize;

        const tMinX = Math.max(0, Math.floor(qMinX - originXInt));
        const tMaxX = Math.min(
          tilesPerSide - 1,
          Math.ceil(qMaxX - originXInt) - 1,
        );
        const tMinZ = Math.max(0, Math.floor(qMinZ - originZInt));
        const tMaxZ = Math.min(
          tilesPerSide - 1,
          Math.ceil(qMaxZ - originZInt) - 1,
        );

        for (let tx = tMinX; tx <= tMaxX; tx++) {
          const flagRow = tx * tilesPerSide;
          for (let tz = tMinZ; tz <= tMaxZ; tz++) {
            const flagIdx = flagRow + tz;
            if (!waterTileFlags[flagIdx]) {
              waterTileFlags[flagIdx] = 1;
              terrainFlags[flagIdx] |= CollisionFlag.WATER;
            }
          }
        }
      }
    }

    // ---- PASS 1b: Elevated water body flags ----
    const elevatedBodies = this.waterBodyRegistry.getBodiesInTile(
      terrainTileX,
      terrainTileZ,
      tileSize,
    );
    for (const body of elevatedBodies) {
      const bodySurfaceY = body.surfaceY;
      for (let i = 0; i < gridQuads; i++) {
        const iStride = i * gridPoints;
        const i1Stride = (i + 1) * gridPoints;
        for (let j = 0; j < gridQuads; j++) {
          // Skip if no corner is below this body's surface
          if (
            heights[iStride + j] >= bodySurfaceY &&
            heights[i1Stride + j] >= bodySurfaceY &&
            heights[iStride + j + 1] >= bodySurfaceY &&
            heights[i1Stride + j + 1] >= bodySurfaceY
          )
            continue;

          // Check quad center is within body radius
          const qCenterX = gridStartX + (i + 0.5) * cellSize;
          const qCenterZ = gridStartZ + (j + 0.5) * cellSize;
          const dx = qCenterX - body.centerX;
          const dz = qCenterZ - body.centerZ;
          if (dx * dx + dz * dz > body.radiusSq) continue;

          const qMinX = gridStartX + i * cellSize;
          const qMaxX = qMinX + cellSize;
          const qMinZ = gridStartZ + j * cellSize;
          const qMaxZ = qMinZ + cellSize;

          const tMinX = Math.max(0, Math.floor(qMinX - originXInt));
          const tMaxX = Math.min(
            tilesPerSide - 1,
            Math.ceil(qMaxX - originXInt) - 1,
          );
          const tMinZ = Math.max(0, Math.floor(qMinZ - originZInt));
          const tMaxZ = Math.min(
            tilesPerSide - 1,
            Math.ceil(qMaxZ - originZInt) - 1,
          );

          for (let tx = tMinX; tx <= tMaxX; tx++) {
            const flagRow = tx * tilesPerSide;
            for (let tz = tMinZ; tz <= tMaxZ; tz++) {
              const flagIdx = flagRow + tz;
              if (!waterTileFlags[flagIdx]) {
                waterTileFlags[flagIdx] = 1;
                terrainFlags[flagIdx] |= CollisionFlag.WATER;
              }
            }
          }
        }
      }
    }

    // ---- PASS 2: Biome + slope flags (non-water tiles only) ----
    // Sample a one-meter grid once and reuse neighboring samples. The prior
    // path called calculateSlope() for each of 10,000 movement tiles, causing
    // up to 90,000 cached-height queries and 100ms+ authoritative tick stalls.
    const biome = this.getBiomeAt(terrainTileX, terrainTileZ);
    const biomeData = BIOMES[biome];
    const slopeDistance = this.CONFIG.SLOPE_CHECK_DISTANCE;
    const integerSlopeDistance = Number.isInteger(slopeDistance)
      ? slopeDistance
      : null;
    let slopeHeights: Float64Array | null = null;
    let slopeGridSide = 0;

    if (biome !== "lakes" && biomeData && integerSlopeDistance !== null) {
      slopeGridSide = tilesPerSide + integerSlopeDistance * 2;
      slopeHeights = new Float64Array(slopeGridSide * slopeGridSide);
      for (let gx = 0; gx < slopeGridSide; gx++) {
        const worldX = originX + gx - integerSlopeDistance + 0.5;
        const rowOffset = gx * slopeGridSide;
        for (let gz = 0; gz < slopeGridSide; gz++) {
          const worldZ = originZ + gz - integerSlopeDistance + 0.5;
          slopeHeights[rowOffset + gz] = this.getHeightAt(worldX, worldZ);
        }
      }
    }

    const inverseSlopeDistance = 1 / slopeDistance;
    const inverseDiagonalDistance = 1 / (slopeDistance * Math.SQRT2);
    for (let lx = 0; lx < tilesPerSide; lx++) {
      const worldX = originX + lx + 0.5;
      const flagRow = lx * tilesPerSide;

      for (let lz = 0; lz < tilesPerSide; lz++) {
        const flagIndex = flagRow + lz;
        if (waterTileFlags[flagIndex]) continue; // Already water

        const worldZ = originZ + lz + 0.5;

        if (biome === "lakes") {
          terrainFlags[flagIndex] |= CollisionFlag.WATER;
          continue;
        }
        if (!biomeData) continue;

        let slope: number;
        if (slopeHeights && integerSlopeDistance !== null) {
          const gx = lx + integerSlopeDistance;
          const gz = lz + integerSlopeDistance;
          const center = slopeHeights[gx * slopeGridSide + gz];
          const north =
            Math.abs(
              slopeHeights[gx * slopeGridSide + gz + integerSlopeDistance] -
                center,
            ) * inverseSlopeDistance;
          const south =
            Math.abs(
              slopeHeights[gx * slopeGridSide + gz - integerSlopeDistance] -
                center,
            ) * inverseSlopeDistance;
          const east =
            Math.abs(
              slopeHeights[(gx + integerSlopeDistance) * slopeGridSide + gz] -
                center,
            ) * inverseSlopeDistance;
          const west =
            Math.abs(
              slopeHeights[(gx - integerSlopeDistance) * slopeGridSide + gz] -
                center,
            ) * inverseSlopeDistance;
          const northEast =
            Math.abs(
              slopeHeights[
                (gx + integerSlopeDistance) * slopeGridSide +
                  gz +
                  integerSlopeDistance
              ] - center,
            ) * inverseDiagonalDistance;
          const northWest =
            Math.abs(
              slopeHeights[
                (gx - integerSlopeDistance) * slopeGridSide +
                  gz +
                  integerSlopeDistance
              ] - center,
            ) * inverseDiagonalDistance;
          const southEast =
            Math.abs(
              slopeHeights[
                (gx + integerSlopeDistance) * slopeGridSide +
                  gz -
                  integerSlopeDistance
              ] - center,
            ) * inverseDiagonalDistance;
          const southWest =
            Math.abs(
              slopeHeights[
                (gx - integerSlopeDistance) * slopeGridSide +
                  gz -
                  integerSlopeDistance
              ] - center,
            ) * inverseDiagonalDistance;
          slope = Math.max(
            north,
            south,
            east,
            west,
            northEast,
            northWest,
            southEast,
            southWest,
          );
        } else {
          slope = this.calculateSlope(worldX, worldZ);
        }

        if (slope > biomeData.maxSlope) {
          terrainFlags[flagIndex] |= CollisionFlag.STEEP_SLOPE;
        }
      }
    }

    // Apply the complete terrain result in one zone-oriented batch. This also
    // clears stale WATER/STEEP_SLOPE flags while preserving every other flag.
    collision.replaceFlagsInRegion(
      originXInt,
      originZInt,
      tilesPerSide,
      tilesPerSide,
      terrainFlagsMask,
      terrainFlags,
    );

    // ---- PASS 3: Bridge collision (overrides WATER → walkable) ----
    const bridgeSystem = this.world.getSystem("bridges") as BridgeSystem | null;
    if (bridgeSystem) {
      bridgeSystem.registerBridgeCollision(
        terrainTileX,
        terrainTileZ,
        tileSize,
        this as TerrainSystem,
      );
    }

    // ---- PASS 4: Dock collision (overrides WATER → walkable) ----
    // Re-apply dock flags after terrain baking, same pattern as bridges.
    // Without this, bakeWalkabilityFlags would overwrite DOCK with WATER.
    const dockSystem = this.world.getSystem("docks") as {
      reapplyCollisionForTile?(
        originX: number,
        originZ: number,
        tileSize: number,
      ): void;
    } | null;
    if (dockSystem?.reapplyCollisionForTile) {
      dockSystem.reapplyCollisionForTile(originX, originZ, tileSize);
    }
  }

  /**
   * Process walkability baking incrementally across ticks.
   * Processes rows of a terrain tile within a time budget (~4ms) to avoid
   * the synchronous 10,000-iteration spike from bakeWalkabilityFlags.
   */
  /**
   * Process queued walkability baking incrementally. Delegates to
   * bakeWalkabilityFlags() which uses the water-mesh-aligned approach.
   * Note: Since baking is now synchronous during terrain generation,
   * this queue is only used for deferred re-baking (e.g. flat zone changes).
   */
  private processWalkabilityQueue(): void {
    if (!this.runtimeIsServer) return;
    if (this.pendingWalkabilityTiles.length === 0) return;

    const budgetMs = 4;
    const t0 = performance.now();

    while (
      this.pendingWalkabilityTiles.length > 0 &&
      performance.now() - t0 < budgetMs
    ) {
      const next = this.pendingWalkabilityTiles.shift()!;
      this.bakeWalkabilityFlags(next.tileX, next.tileZ);
    }

    // Clear stale progress state (no longer used for row-by-row processing)
    this.walkabilityProgress = null;
  }

  /**
   * Find a walkable path between two points (basic pathfinding)
   */
  findWalkablePath(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
  ): { path: Array<{ x: number; z: number }>; blocked: boolean } {
    // Simple line-of-sight check first
    const steps = 20;
    const dx = (endX - startX) / steps;
    const dz = (endZ - startZ) / steps;

    const path: Array<{ x: number; z: number }> = [];

    for (let i = 0; i <= steps; i++) {
      const x = startX + dx * i;
      const z = startZ + dz * i;

      const walkableCheck = this.isPositionWalkable(x, z);
      if (!walkableCheck.walkable) {
        // Path is blocked, would need A* pathfinding for complex routing
        return { path: [], blocked: true };
      }

      path.push({ x, z });
    }

    return { path, blocked: false };
  }

  /**
   * Get terrain info at world position (for movement system integration)
   */
  getTerrainInfoAt(
    worldX: number,
    worldZ: number,
  ): {
    height: number;
    biome: string;
    walkable: boolean;
    slope: number;
    underwater: boolean;
  } {
    const height = this.getHeightAt(worldX, worldZ);
    const tileX = Math.floor(worldX / this.CONFIG.TILE_SIZE);
    const tileZ = Math.floor(worldZ / this.CONFIG.TILE_SIZE);
    const biome = this.getBiomeAt(tileX, tileZ);
    const slope = this.calculateSlope(worldX, worldZ);
    const walkableCheck = this.isPositionWalkable(worldX, worldZ);

    return {
      height,
      biome,
      walkable: walkableCheck.walkable,
      slope,
      underwater: this.waterBodyRegistry.isUnderwater(worldX, worldZ, height),
    };
  }

  // ===== TERRAIN-BASED MOB SPAWNING (GDD Integration) =====

  /**
   * Generate visual features (road meshes, lake meshes) for a tile
   */
  private generateVisualFeatures(tile: TerrainTile): void {
    // Roads are rendered as noise-based color paths; no mesh generation

    // Generate lake meshes for water bodies
    this.generateLakeMeshes(tile);
  }

  /**
   * Generate visual road meshes for better visibility
   */
  private generateRoadMeshes(_tile: TerrainTile): void {}

  /**
   * Generate water meshes for low areas
   * Water geometry is shaped to only cover actual underwater terrain
   * Uses "ocean" shader for water at island boundary, "lake" for inland water
   */
  private generateWaterMeshes(tile: TerrainTile): void {
    if (!this.waterSystem) return;

    // Determine water type based on tile position relative to island
    // Ocean water is at the world boundaries (outside island radius)
    // Lake water is inland (ponds, lakes within the island)
    const waterType = this.determineWaterType(tile);

    // Pass height function so water mesh can be shaped to underwater areas only
    // Water will only be created where terrain is below WATER_THRESHOLD
    // Geometry is shaped to match shorelines (not a full rectangle)
    const waterMesh = this.waterSystem.generateWaterMesh(
      tile,
      this.CONFIG.WATER_THRESHOLD,
      this.CONFIG.TILE_SIZE,
      (worldX: number, worldZ: number) => this.getHeightAt(worldX, worldZ),
      waterType,
    );

    // waterMesh is null if no underwater areas exist
    if (waterMesh && tile.mesh) {
      if (this.CONFIG.USE_QUADTREE_LOD && this.terrainContainer) {
        // Quad-tree LOD doesn't add tile.mesh to the scene, so parent the
        // water mesh directly to terrainContainer with the tile's world pos.
        // Preserve Y (water level) already set by WaterSystem.generateWaterMesh.
        waterMesh.position.x = tile.x * this.CONFIG.TILE_SIZE;
        waterMesh.position.z = tile.z * this.CONFIG.TILE_SIZE;
        this.terrainContainer.add(waterMesh);
      } else {
        tile.mesh.add(waterMesh);
      }
      tile.waterMeshes.push(waterMesh);
    }

    // Elevated water body meshes (mountain ponds, highland lakes)
    // Height function is clipped to body radius: positions outside the circle
    // report height = surfaceY so no water quad is emitted there. This ensures
    // the visual mesh boundary matches collision and minimap exactly.
    const tileSize = this.CONFIG.TILE_SIZE;
    const bodies = this.waterBodyRegistry.getBodiesInTile(
      tile.x,
      tile.z,
      tileSize,
    );
    for (const body of bodies) {
      const cx = body.centerX;
      const cz = body.centerZ;
      const rSq = body.radiusSq;
      const sy = body.surfaceY;
      const baseGetHeight = (wx: number, wz: number) =>
        this.getHeightAt(wx, wz);
      const clippedHeightFn = (wx: number, wz: number) => {
        const dx = wx - cx;
        const dz = wz - cz;
        return dx * dx + dz * dz > rSq ? sy : baseGetHeight(wx, wz);
      };
      const bodyMesh = this.waterSystem.generateWaterMesh(
        tile,
        body.surfaceY,
        tileSize,
        clippedHeightFn,
        "lake",
      );
      if (bodyMesh && tile.mesh) {
        if (this.CONFIG.USE_QUADTREE_LOD && this.terrainContainer) {
          bodyMesh.position.x = tile.x * tileSize;
          bodyMesh.position.z = tile.z * tileSize;
          this.terrainContainer.add(bodyMesh);
        } else {
          tile.mesh.add(bodyMesh);
        }
        tile.waterMeshes.push(bodyMesh);
      }
    }
  }

  /**
   * Determine if a tile's water should be "ocean" (boundary) or "lake" (inland)
   * Ocean: water at world edges where island mask < threshold
   * Lake: inland water bodies (ponds, rivers within the island)
   */
  private determineWaterType(tile: TerrainTile): "lake" | "ocean" {
    // If island mask is disabled, all water is lake
    if (!this.CONFIG.ISLAND_MASK_ENABLED) {
      return "lake";
    }

    // Calculate tile center position
    const tileCenterX = tile.x * this.CONFIG.TILE_SIZE;
    const tileCenterZ = tile.z * this.CONFIG.TILE_SIZE;

    // Get the island mask at tile center
    // Island mask is 1.0 at center, falls to 0.0 at ocean
    const islandMask = this.getIslandMask(tileCenterX, tileCenterZ);

    // If island mask is below threshold, this is ocean water
    // Use 0.3 as threshold - water in the outer 70% of falloff zone is ocean
    const OCEAN_THRESHOLD = 0.3;
    if (islandMask < OCEAN_THRESHOLD) {
      return "ocean";
    }

    return "lake";
  }

  /**
   * Generate visual lake meshes for water bodies
   * Note: generateWaterMeshes now only creates water where terrain is underwater,
   * so this is a no-op. Keeping for future enhancements (special lake effects).
   */
  private generateLakeMeshes(_tile: TerrainTile): void {
    // Water is handled by generateWaterMeshes (only where terrain < WATER_THRESHOLD)
    // Future: Could add special effects for lake biomes here (waves, ripples, etc.)
  }

  /**
   * Find water areas within a tile that need visual representation
   */
  private findWaterAreas(
    tile: TerrainTile,
  ): Array<{ centerX: number; centerZ: number; width: number; depth: number }> {
    const waterAreas: Array<{
      centerX: number;
      centerZ: number;
      width: number;
      depth: number;
    }> = [];
    const biomeData = BIOMES[tile.biome];
    if (!biomeData) return waterAreas;

    // For lakes biome, create a large water area covering most of the tile
    if ((tile.biome as string) === "lakes") {
      waterAreas.push({
        centerX: 0,
        centerZ: 0,
        width: this.CONFIG.TILE_SIZE * 0.8,
        depth: this.CONFIG.TILE_SIZE * 0.8,
      });
    } else {
      // For other biomes, sample the heightmap to find areas below water level
      const sampleSize = 10; // Sample every 10 meters
      const samples: Array<{ x: number; z: number; underwater: boolean }> = [];

      for (
        let x = -this.CONFIG.TILE_SIZE / 2;
        x < this.CONFIG.TILE_SIZE / 2;
        x += sampleSize
      ) {
        for (
          let z = -this.CONFIG.TILE_SIZE / 2;
          z < this.CONFIG.TILE_SIZE / 2;
          z += sampleSize
        ) {
          const worldX = tile.x * this.CONFIG.TILE_SIZE + x;
          const worldZ = tile.z * this.CONFIG.TILE_SIZE + z;
          const height = this.getHeightAt(worldX, worldZ);

          samples.push({
            x,
            z,
            underwater: this.waterBodyRegistry.isUnderwater(
              worldX,
              worldZ,
              height,
            ),
          });
        }
      }

      // Group contiguous underwater areas (simplified approach)
      const underwaterSamples = samples.filter((s) => s.underwater);
      if (underwaterSamples.length > 0) {
        // Create one water area covering the underwater region
        const minX = Math.min(...underwaterSamples.map((s) => s.x));
        const maxX = Math.max(...underwaterSamples.map((s) => s.x));
        const minZ = Math.min(...underwaterSamples.map((s) => s.z));
        const maxZ = Math.max(...underwaterSamples.map((s) => s.z));

        waterAreas.push({
          centerX: (minX + maxX) / 2,
          centerZ: (minZ + maxZ) / 2,
          width: maxX - minX + sampleSize,
          depth: maxZ - minZ + sampleSize,
        });
      }
    }

    return waterAreas;
  }

  /**
   * Get valid mob spawn positions in a tile based on biome and terrain constraints
   */
  getMobSpawnPositionsForTile(
    tileX: number,
    tileZ: number,
    maxSpawns: number = 10,
  ): Array<{
    position: { x: number; y: number; z: number };
    mobTypes: string[];
    biome: string;
    difficulty: number;
  }> {
    const biome = this.getBiomeAt(tileX, tileZ);
    const biomeData = BIOMES[biome];
    const rng = this.createTileRng(tileX, tileZ, "mob-spawn-positions");

    // Don't spawn mobs in safe zones
    if (biomeData.difficulty === 0 || biomeData.mobTypes.length === 0) {
      return [];
    }

    const spawnPositions: Array<{
      position: { x: number; y: number; z: number };
      mobTypes: string[];
      biome: string;
      difficulty: number;
    }> = [];

    // Try to find valid spawn positions
    let attempts = 0;
    const maxAttempts = maxSpawns * 3; // Allow some failures

    while (spawnPositions.length < maxSpawns && attempts < maxAttempts) {
      attempts++;

      // Random position within tile
      const worldX =
        tileX * this.CONFIG.TILE_SIZE +
        (rng() - 0.5) * this.CONFIG.TILE_SIZE * 0.8;
      const worldZ =
        tileZ * this.CONFIG.TILE_SIZE +
        (rng() - 0.5) * this.CONFIG.TILE_SIZE * 0.8;

      // Check if position is suitable for mob spawning
      const terrainInfo = this.getTerrainInfoAt(worldX, worldZ);

      if (!terrainInfo.walkable || terrainInfo.underwater) {
        continue; // Skip unwalkable positions
      }

      // Check distance from roads (don't spawn too close to roads)
      if (this.isPositionNearRoad(worldX, worldZ, 8)) {
        continue; // Skip positions near roads
      }

      // Check distance from starter towns
      if (this.isPositionNearTown(worldX, worldZ, this.CONFIG.TOWN_RADIUS)) {
        continue; // Skip positions near safe towns
      }

      spawnPositions.push({
        position: {
          x: worldX,
          y: terrainInfo.height,
          z: worldZ,
        },
        mobTypes: [...biomeData.mobTypes],
        biome: biome,
        difficulty: biomeData.difficulty,
      });
    }

    return spawnPositions;
  }

  /**
   * Check if position is near a road
   */
  private isPositionNearRoad(
    worldX: number,
    worldZ: number,
    minDistance: number,
  ): boolean {
    const tileX = Math.floor(worldX / this.CONFIG.TILE_SIZE);
    const tileZ = Math.floor(worldZ / this.CONFIG.TILE_SIZE);

    // Check current tile and adjacent tiles for roads
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const checkTileX = tileX + dx;
        const checkTileZ = tileZ + dz;
        const tileKey = `${checkTileX}_${checkTileZ}`;
        const tile = this.terrainTiles.get(tileKey);

        if (tile && tile.roads.length > 0) {
          for (const road of tile.roads) {
            const localX = worldX - checkTileX * this.CONFIG.TILE_SIZE;
            const localZ = worldZ - checkTileZ * this.CONFIG.TILE_SIZE;

            const distanceToRoad = this.distanceToLineSegment(
              new THREE.Vector2(localX, localZ),
              road.start instanceof THREE.Vector2
                ? road.start
                : new THREE.Vector2(road.start.x, road.start.z),
              road.end instanceof THREE.Vector2
                ? road.end
                : new THREE.Vector2(road.end.x, road.end.z),
            );

            if (distanceToRoad < minDistance) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Check if position is near a starter town
   */
  private isPositionNearTown(
    worldX: number,
    worldZ: number,
    minDistance: number,
  ): boolean {
    const towns = [
      { x: 0, z: 0 },
      { x: 10 * this.CONFIG.TILE_SIZE, z: 0 },
      { x: -10 * this.CONFIG.TILE_SIZE, z: 0 },
      { x: 0, z: 10 * this.CONFIG.TILE_SIZE },
      { x: 0, z: -10 * this.CONFIG.TILE_SIZE },
    ];

    for (const town of towns) {
      const distance = Math.sqrt(
        (worldX - town.x) ** 2 + (worldZ - town.z) ** 2,
      );
      if (distance < minDistance) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get all mob types available in a specific biome
   */
  getBiomeMobTypes(biome: string): string[] {
    const biomeData = BIOMES[biome];
    return biomeData ? [...biomeData.mobTypes] : [];
  }

  /**
   * Get biome difficulty level for mob spawning
   */
  getBiomeDifficulty(biome: string): number {
    const biomeData = BIOMES[biome];
    return biomeData ? biomeData.difficulty : 0;
  }

  /**
   * Get difficulty sample at a world position.
   * Scales from biome difficulty with noise and town falloff.
   */
  getDifficultyAtWorldPosition(
    worldX: number,
    worldZ: number,
    overrideDifficultyLevel?: number,
  ): DifficultySample {
    this.ensureNoiseInitialized();

    const biome = this.getBiomeAtWorldPosition(worldX, worldZ);
    const biomeData = BIOMES[biome];
    const biomeDifficulty = biomeData ? biomeData.difficulty : 0;
    const difficultyTier =
      overrideDifficultyLevel !== undefined
        ? overrideDifficultyLevel
        : biomeDifficulty;

    const townDistance = this.getNearestTownDistance(worldX, worldZ);
    const townFalloff =
      townDistance === null
        ? 1
        : Math.min(
            1,
            Math.max(
              0,
              townDistance / this.CONFIG.DIFFICULTY_TOWN_FALLOFF_RADIUS,
            ),
          );

    if (difficultyTier <= 0 || townFalloff <= 0) {
      return {
        level: 0,
        scalar: 0,
        biome,
        difficultyTier,
        isSafe: true,
      };
    }

    const baseScalar = Math.min(1, Math.max(0, difficultyTier / 3));
    const noiseValue = this.noise.simplex2D(
      worldX * this.CONFIG.DIFFICULTY_NOISE_SCALE,
      worldZ * this.CONFIG.DIFFICULTY_NOISE_SCALE,
    );
    const noiseNormalized = (noiseValue + 1) * 0.5;
    const blendedScalar =
      baseScalar * (1 - this.CONFIG.DIFFICULTY_NOISE_WEIGHT) +
      noiseNormalized * this.CONFIG.DIFFICULTY_NOISE_WEIGHT;

    const scalar = Math.min(
      1,
      Math.max(
        0,
        Math.pow(
          blendedScalar * townFalloff,
          this.CONFIG.DIFFICULTY_CURVE_EXPONENT,
        ),
      ),
    );

    const maxLevel = this.CONFIG.DIFFICULTY_MAX_LEVEL;
    const level =
      scalar <= 0 ? 0 : Math.max(1, Math.floor(1 + scalar * (maxLevel - 1)));

    return {
      level,
      scalar,
      biome,
      difficultyTier,
      isSafe: false,
    };
  }

  getBossLevelAtWorldPosition(worldX: number, worldZ: number): number {
    const sample = this.getDifficultyAtWorldPosition(worldX, worldZ);
    const maxLevel = this.CONFIG.DIFFICULTY_MAX_LEVEL;
    if (sample.level <= 0) {
      return this.CONFIG.BOSS_MIN_LEVEL;
    }
    return Math.min(
      maxLevel,
      Math.max(this.CONFIG.BOSS_MIN_LEVEL, sample.level),
    );
  }

  getBossHotspots(): BossHotspot[] {
    if (this.bossHotspots.length === 0) {
      this.generateBossHotspots();
    }
    return [...this.bossHotspots];
  }

  getBossHotspotAtWorldPosition(
    worldX: number,
    worldZ: number,
  ): BossHotspot | null {
    const hotspots = this.getBossHotspots();
    for (const hotspot of hotspots) {
      const dx = worldX - hotspot.x;
      const dz = worldZ - hotspot.z;
      if (dx * dx + dz * dz <= hotspot.radius * hotspot.radius) {
        return hotspot;
      }
    }
    return null;
  }

  private getNearestTownDistance(
    worldX: number,
    worldZ: number,
  ): number | null {
    let nearest: number | null = null;

    if (this.townSystem) {
      const towns = this.townSystem.getTowns();
      if (towns.length > 0) {
        for (const town of towns) {
          const dx = worldX - town.position.x;
          const dz = worldZ - town.position.z;
          const distance = Math.sqrt(dx * dx + dz * dz);
          const distanceFromEdge = Math.max(0, distance - town.safeZoneRadius);
          if (nearest === null || distanceFromEdge < nearest) {
            nearest = distanceFromEdge;
          }
        }
      }
    }

    if (nearest !== null) {
      return nearest;
    }

    const fallbackRadius = this.CONFIG.TOWN_RADIUS;
    const fallbackTowns = [
      { x: 0, z: 0 },
      { x: 10 * this.CONFIG.TILE_SIZE, z: 0 },
      { x: -10 * this.CONFIG.TILE_SIZE, z: 0 },
      { x: 0, z: 10 * this.CONFIG.TILE_SIZE },
      { x: 0, z: -10 * this.CONFIG.TILE_SIZE },
    ];

    for (const town of fallbackTowns) {
      const dx = worldX - town.x;
      const dz = worldZ - town.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const distanceFromEdge = Math.max(0, distance - fallbackRadius);
      if (nearest === null || distanceFromEdge < nearest) {
        nearest = distanceFromEdge;
      }
    }

    return nearest;
  }

  private isPositionInSafeWorldArea(worldX: number, worldZ: number): boolean {
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      if (!area.bounds) continue;
      if (!area.safeZone && area.difficultyLevel !== 0) continue;
      const { minX, maxX, minZ, maxZ } = area.bounds;
      if (worldX > minX && worldX <= maxX && worldZ > minZ && worldZ <= maxZ) {
        return true;
      }
    }
    return false;
  }

  private generateBossHotspots(): void {
    if (this.bossHotspots.length > 0) return;

    this.ensureNoiseInitialized();

    const bounds = this.getWorldTerrainProfile().bounds;
    const step = this.CONFIG.BOSS_HOTSPOT_GRID_STEP;
    const minScalar = this.CONFIG.BOSS_HOTSPOT_MIN_SCALAR;
    const candidates: Array<{
      x: number;
      z: number;
      score: number;
      seed: number;
    }> = [];

    for (
      let x = bounds.minX + step * 0.5;
      x <= bounds.maxX - step * 0.5;
      x += step
    ) {
      for (
        let z = bounds.minZ + step * 0.5;
        z <= bounds.maxZ - step * 0.5;
        z += step
      ) {
        const sample = this.getDifficultyAtWorldPosition(x, z);
        if (sample.isSafe || sample.scalar < minScalar) continue;

        const height = this.getHeightAt(x, z);
        if (this.waterBodyRegistry.isUnderwater(x, z, height)) continue;

        const slope = this.calculateSlope(x, z);
        if (slope > this.CONFIG.MAX_WALKABLE_SLOPE) continue;

        const townDistance = this.getNearestTownDistance(x, z);
        if (
          townDistance !== null &&
          townDistance < this.CONFIG.DIFFICULTY_TOWN_FALLOFF_RADIUS
        ) {
          continue;
        }

        if (this.isPositionInSafeWorldArea(x, z)) {
          continue;
        }

        const roadAvoidDistance = Math.max(10, this.CONFIG.ROAD_WIDTH * 2);
        if (this.isPositionNearRoad(x, z, roadAvoidDistance)) {
          continue;
        }

        const noiseValue = this.noise.simplex2D(
          x * this.CONFIG.DIFFICULTY_NOISE_SCALE * 1.3 + 12.7,
          z * this.CONFIG.DIFFICULTY_NOISE_SCALE * 1.3 - 8.1,
        );
        const seed = (noiseValue + 1) * 0.5;
        const score = sample.scalar + seed * 0.1;

        candidates.push({ x, z, score, seed });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    const minDistanceSq =
      this.CONFIG.BOSS_HOTSPOT_MIN_DISTANCE *
      this.CONFIG.BOSS_HOTSPOT_MIN_DISTANCE;
    const selected: BossHotspot[] = [];

    for (const candidate of candidates) {
      if (selected.length >= this.CONFIG.BOSS_HOTSPOT_MAX) break;

      let tooClose = false;
      for (const hotspot of selected) {
        const dx = candidate.x - hotspot.x;
        const dz = candidate.z - hotspot.z;
        if (dx * dx + dz * dz < minDistanceSq) {
          tooClose = true;
          break;
        }
      }

      if (tooClose) continue;

      const id = `boss_hotspot_${selected.length}`;
      selected.push({
        id,
        x: candidate.x,
        z: candidate.z,
        radius: this.CONFIG.BOSS_HOTSPOT_RADIUS,
        minLevel: this.CONFIG.BOSS_MIN_LEVEL,
        maxLevel: this.CONFIG.DIFFICULTY_MAX_LEVEL,
        seed: candidate.seed,
      });
    }

    this.bossHotspots = selected;
  }

  /**
   * Get all loaded tiles with their biome (for ProceduralGrassSystem and other systems)
   * Returns ALL tiles regardless of difficulty or mob presence.
   */
  getLoadedTiles(): Array<{
    tileX: number;
    tileZ: number;
    biome: string;
  }> {
    const tilesData: Array<{
      tileX: number;
      tileZ: number;
      biome: string;
    }> = [];

    for (const [_key, tile] of this.terrainTiles.entries()) {
      tilesData.push({
        tileX: tile.x,
        tileZ: tile.z,
        biome: (tile.biome as BiomeType) || DEFAULT_BIOME,
      });
    }

    return tilesData;
  }

  /**
   * Get all loaded tiles with their biome and mob spawn data
   * Note: Only returns tiles with difficulty > 0 AND mobTypes (for mob spawning)
   */
  getLoadedTilesWithSpawnData(): Array<{
    tileX: number;
    tileZ: number;
    biome: string;
    difficulty: number;
    mobTypes: string[];
    spawnPositions: Array<{ x: number; y: number; z: number }>;
  }> {
    const tilesData: Array<{
      tileX: number;
      tileZ: number;
      biome: string;
      difficulty: number;
      mobTypes: string[];
      spawnPositions: Array<{ x: number; y: number; z: number }>;
    }> = [];

    for (const [_key, tile] of this.terrainTiles.entries()) {
      const biomeData = BIOMES[tile.biome];

      if (
        biomeData &&
        biomeData.difficulty > 0 &&
        biomeData.mobTypes.length > 0
      ) {
        const spawnPositions = this.getMobSpawnPositionsForTile(
          tile.x,
          tile.z,
          5,
        );

        tilesData.push({
          tileX: tile.x,
          tileZ: tile.z,
          biome: tile.biome,
          difficulty: biomeData.difficulty,
          mobTypes: [...biomeData.mobTypes],
          spawnPositions: spawnPositions.map((spawn) => spawn.position),
        });
      }
    }

    return tilesData;
  }

  destroy(): void {
    this.destroyed = true;
    this.workerBatchLease = null;
    this.roadInfluenceRefreshGeneration++;
    this.world.off(EventType.ROADS_GENERATED, this.onRoadsGenerated);
    this.world.off(EventType.ROADS_MASK_READY, this.onRoadMaskReady);
    this.roadEventsSubscribed = false;
    clearRoadInfluenceTexture(this);
    this.compactPondDressing?.destroy();
    this.compactPondDressing = null;
    // Dispose quad-tree visual manager
    if (this.quadTreeVisualManager) {
      this.quadTreeVisualManager.dispose();
      this.quadTreeVisualManager = null;
    }

    if (this.waterVisualManager) {
      this.waterVisualManager.destroy();
      this.waterVisualManager = null;
    }

    if (this.grassVisualManager) {
      this.grassVisualManager.destroy();
      this.grassVisualManager = null;
    }

    // Terminate worker pools to free resources
    terminateTerrainWorkerPool();
    terminateQuadChunkWorkerPool();
    terminateGrassWorkerPool();

    // Clear pending worker state
    this.pendingWorkerResults.clear();
    this.pendingWorkerTiles.length = 0;
    this.pendingWorkerTileKeys.clear();
    this.workerFallbackTileKeys.clear();

    // Remove prefs listener
    if (this.world.prefs) {
      this.world.prefs.off("change", this.onPrefsChange);
    }

    // Perform final serialization before shutdown
    this.performImmediateSerialization();

    // Dispose instanced mesh manager
    if (this.instancedMeshManager) {
      this.instancedMeshManager.dispose();
    }

    // Clear save interval
    if (this.chunkSaveInterval) {
      clearInterval(this.chunkSaveInterval);
    }
    if (this.terrainUpdateIntervalId) {
      clearInterval(this.terrainUpdateIntervalId);
    }
    if (this.serializationIntervalId) {
      clearInterval(this.serializationIntervalId);
    }
    if (this.boundingBoxIntervalId) {
      clearInterval(this.boundingBoxIntervalId);
    }
    if (this._tileRegenerationFlushId) {
      clearTimeout(this._tileRegenerationFlushId);
      this._tileRegenerationFlushId = undefined;
    }

    // Save all modified chunks before shutdown
    this.saveModifiedChunks();

    // Unload all tiles
    for (const tile of this.terrainTiles.values()) {
      this.unloadTile(tile);
    }

    // Remove terrain container
    if (this.terrainContainer && this.terrainContainer.parent) {
      this.terrainContainer.parent.remove(this.terrainContainer);
    }

    // Clear tracking data
    this.playerChunks.clear();
    this.simulatedChunks.clear();
    this.chunkPlayerCounts.clear();
    this._queuedTileRegenerations.clear();
    this._pendingTileRegeneration.clear();
    this.terrainBoundingBoxes.clear();
    this.pendingSerializationData.clear();
    this.pendingTileKeys.length = 0;
    this.pendingTileSet.clear();
    this.pendingTileContent.clear();
    this.pendingContentPromotions.clear();
    this.pendingTileGenerations.clear();
    this.flatZones.clear();
    this.flatZonesByTile.clear();
    this._flatZoneChecked.clear();
    this.authoredSurfaceCandidates.length = 0;
    this.arenaFloorZoneIds.clear();
    this.arenaGradeHeight = null;

    // Cleanup GPU compute context
    if (this.terrainComputeContext) {
      this.terrainComputeContext.destroy();
      this.terrainComputeContext = null;
      this.gpuComputeAvailable = false;
    }
    // Also cancels pending compact texture admission and rejects late loads.
    this.terrainMaterial?.dispose();
    this.terrainMaterial = undefined;
  }

  private emitTileUnloaded(tileId: string, tileX: number, tileZ: number): void {
    this.world.emit(EventType.TERRAIN_TILE_UNLOADED, { tileId, tileX, tileZ });
  }

  // Methods for chunk persistence (used by tests)
  markChunkActive(chunkX: number, chunkZ: number): void {
    const key = `${chunkX}_${chunkZ}`;

    // Add to simulated chunks if not already there
    this.simulatedChunks.add(key);

    // Update chunk player count
    const currentCount = this.chunkPlayerCounts.get(key) || 0;
    this.chunkPlayerCounts.set(key, currentCount + 1);
  }

  markChunkInactive(chunkX: number, chunkZ: number): void {
    const key = `${chunkX}_${chunkZ}`;

    // Decrease chunk player count
    const currentCount = this.chunkPlayerCounts.get(key) || 0;
    if (currentCount > 1) {
      this.chunkPlayerCounts.set(key, currentCount - 1);
    } else {
      // No more active references - remove from simulation
      this.chunkPlayerCounts.delete(key);
      this.simulatedChunks.delete(key);
    }
  }

  getActiveChunks(): Array<{ x: number; z: number }> {
    // Return currently loaded terrain tiles as "active chunks"
    const activeChunks: Array<{ x: number; z: number }> = [];
    for (const [key, _tile] of this.terrainTiles.entries()) {
      // FIX: Use '_' separator, not ','
      const [x, z] = key.split("_").map(Number);
      activeChunks.push({ x, z });
    }
    return activeChunks;
  }

  async saveAllActiveChunks(): Promise<void> {
    // In a real implementation, this would persist chunk data
    // For now, just save modified chunks
    this.saveModifiedChunks();
  }

  // ===== TEST INTEGRATION METHODS (expected by test-terrain.mjs) =====

  /**
   * Get comprehensive terrain statistics for testing
   */
  getTerrainStats(): {
    terrainProfileId: string;
    worldContentIdentity: string;
    tileSize: string;
    worldSize: string;
    totalArea: string;
    maxLoadedTiles: number;
    tilesLoaded: number;
    currentlyLoaded: string[];
    biomeCount: number;
    chunkSize: number;
    worldBounds: {
      min: { x: number; z: number };
      max: { x: number; z: number };
    };
    activeBiomes: string[];
    totalRoads: number;
  } {
    const worldSizeTiles = this.getActiveWorldSizeTiles();
    const worldSizeMeters = worldSizeTiles * this.CONFIG.TILE_SIZE;
    const worldSizeKm = worldSizeMeters / 1000;
    const activeChunks = Array.from(this.terrainTiles.keys());
    return {
      terrainProfileId: this.getWorldTerrainProfile().id,
      worldContentIdentity: DataManager.getWorldContentIdentity(),
      tileSize: `${this.CONFIG.TILE_SIZE}x${this.CONFIG.TILE_SIZE}m`,
      worldSize: `${worldSizeTiles}x${worldSizeTiles}`,
      totalArea: `${worldSizeKm}km x ${worldSizeKm}km`,
      maxLoadedTiles: 9,
      tilesLoaded: this.terrainTiles.size,
      currentlyLoaded: activeChunks,
      biomeCount: Object.keys(BIOMES).length,
      chunkSize: this.CONFIG.TILE_SIZE,
      worldBounds: {
        min: {
          x: this.getWorldTerrainProfile().bounds.minX,
          z: this.getWorldTerrainProfile().bounds.minZ,
        },
        max: {
          x: this.getWorldTerrainProfile().bounds.maxX,
          z: this.getWorldTerrainProfile().bounds.maxZ,
        },
      },
      activeBiomes: Array.from(
        new Set(Array.from(this.terrainTiles.values()).map((t) => t.biome)),
      ),
      totalRoads: Array.from(this.terrainTiles.values()).reduce(
        (sum, t) => sum + t.roads.length,
        0,
      ),
    };
  }

  /**
   * Get biome name at world position (wrapper for test compatibility)
   */
  getBiomeAtPosition(x: number, z: number): string {
    const tileX = Math.floor(x / this.CONFIG.TILE_SIZE);
    const tileZ = Math.floor(z / this.CONFIG.TILE_SIZE);
    const biome = this.getBiomeAt(tileX, tileZ);
    return biome;
  }

  /**
   * Get height at world position (wrapper for test compatibility)
   */
  getHeightAtPosition(x: number, z: number): number {
    return this.getHeightAt(x, z);
  }

  // ===== MMOCHUNK LOADING AND SIMULATION SYSTEM =====

  /**
   * Initialize chunk loading system with 9 core + ring strategy
   */
  private initializeChunkLoadingSystem(): void {
    const isStreamingViewport = isStreamingLikeViewport();
    // world.isServer can be false during early bootstrap (before network mode
    // is finalized). Resolve runtime role explicitly so server startup always
    // uses tight headless chunk ranges.
    const { isServer: isServerRuntime } = this.resolveRuntimeRole();

    // Streaming viewports prioritize first-frame time over gameplay travel
    // preload. Quad-tree visuals retain the horizon independently of these
    // flat-grid simulation/content tiles.
    if (isServerRuntime) {
      // The authoritative server does not render a horizon. A 3x3 simulation
      // core plus one-tile preload ring covers movement/network interest while
      // avoiding 121 full terrain tiles per player or duel teleport.
      this.coreChunkRange = 1;
      this.ringChunkRange = 2;
      this.terrainOnlyChunkRange = 2;
      this.maxTilesPerFrame = 1;
      this.generationBudgetMsPerFrame = 6;
    } else if (isStreamingViewport) {
      this.coreChunkRange = 1; // 3x3 core grid
      this.ringChunkRange = 2; // Preload ring up to 5x5
      this.terrainOnlyChunkRange = 2; // Avoid far-horizon churn in embedded stream view
      this.maxTilesPerFrame = 4; // Catch up faster after camera retargets
      this.generationBudgetMsPerFrame = 10;
    } else {
      // Client: load tiles out to match LOD fade distances (~1000m)
      this.coreChunkRange = 3; // 7x7 core grid
      this.ringChunkRange = 5; // 11x11 ring — content generated here (~1100m)
      this.terrainOnlyChunkRange = 7; // Terrain mesh horizon (~1500m)
      this.maxTilesPerFrame = 3;
      this.generationBudgetMsPerFrame = 8;
    }

    // Initialize tracking maps
    this.playerChunks.clear();
    this.simulatedChunks.clear();
    this.chunkPlayerCounts.clear();
  }

  /**
   * Initialize 15-minute serialization system
   */
  private initializeSerializationSystem(): void {
    this.lastSerializationTime = Date.now();
    this.serializationInterval = 15 * 60 * 1000; // 15 minutes
    this.worldStateVersion = 1;
    this.pendingSerializationData.clear();
  }

  /**
   * Initialize bounding box verification system
   */
  private initializeBoundingBoxSystem(): void {
    this.worldBounds = {
      ...this.getWorldTerrainProfile().bounds,
      minY: -50,
      maxY: 100,
    };

    this.terrainBoundingBoxes.clear();
  }

  /**
   * Player-based terrain update with 9 core + ring strategy
   */
  private updatePlayerBasedTerrain(): void {
    if (this.destroyed || this.isGenerating) return;

    // Resolve terrain centers (local players, or spectator camera target).
    const centers = this.getTerrainCenters();

    // Clear previous player chunk tracking
    this.playerChunks.clear();
    this.chunkPlayerCounts.clear();

    // Track which tiles are needed based on 9 core + ring strategy
    const neededTiles = new Set<string>();
    const simulationTiles = new Set<string>();

    for (const center of centers) {
      const playerPos = center.position;
      const playerId = center.id || "unknown";

      const x = playerPos.x;
      const z = playerPos.z;

      // Calculate tile position
      const tileX = this.worldToTerrainTileIndex(x);
      const tileZ = this.worldToTerrainTileIndex(z);

      // Core chunks get content and simulation; the outer ring is terrain-only.
      const coreChunks = new Set<string>();
      for (let dx = -this.coreChunkRange; dx <= this.coreChunkRange; dx++) {
        for (let dz = -this.coreChunkRange; dz <= this.coreChunkRange; dz++) {
          const tx = tileX + dx;
          const tz = tileZ + dz;
          const key = `${tx}_${tz}`;
          coreChunks.add(key);
          neededTiles.add(key);
          simulationTiles.add(key);
        }
      }

      // Ring chunks around core - these are loaded but not simulated
      for (let dx = -this.ringChunkRange; dx <= this.ringChunkRange; dx++) {
        for (let dz = -this.ringChunkRange; dz <= this.ringChunkRange; dz++) {
          // Skip core chunks
          if (
            Math.abs(dx) <= this.coreChunkRange &&
            Math.abs(dz) <= this.coreChunkRange
          ) {
            continue;
          }

          const tx = tileX + dx;
          const tz = tileZ + dz;
          const key = `${tx}_${tz}`;
          neededTiles.add(key);
        }
      }

      // Terrain-only chunks for the horizon
      for (
        let dx = -this.terrainOnlyChunkRange;
        dx <= this.terrainOnlyChunkRange;
        dx++
      ) {
        for (
          let dz = -this.terrainOnlyChunkRange;
          dz <= this.terrainOnlyChunkRange;
          dz++
        ) {
          if (
            Math.abs(dx) <= this.ringChunkRange &&
            Math.abs(dz) <= this.ringChunkRange
          ) {
            continue;
          }

          const tx = tileX + dx;
          const tz = tileZ + dz;
          const key = `${tx}_${tz}`;
          neededTiles.add(key);
        }
      }

      // Track player chunks for shared world simulation
      this.playerChunks.set(playerId, coreChunks);

      // Count players per chunk for shared simulation
      for (const chunkKey of coreChunks) {
        const currentCount = this.chunkPlayerCounts.get(chunkKey) || 0;
        this.chunkPlayerCounts.set(chunkKey, currentCount + 1);
      }
    }

    // Launch preparation is a compact authoritative service region, not a
    // second terrain viewer. Retain only the exact manifest-intersecting tiles
    // so banking/gathering stays live without generating another 5x5 horizon.
    const contentTiles = new Set(simulationTiles);
    this.addServerLaunchPreparationTiles(contentTiles);
    for (const key of contentTiles) neededTiles.add(key);

    // Update simulated chunks - only chunks with players get simulation
    this.simulatedChunks.clear();
    for (const chunkKey of simulationTiles) {
      if (this.chunkPlayerCounts.get(chunkKey)! > 0) {
        this.simulatedChunks.add(chunkKey);
      }
    }

    // Approximate each player's center from their core chunk set
    const playerCenters: Array<{ x: number; z: number }> = [];
    for (const center of centers) {
      const playerPos = center.position;
      if (playerPos) {
        const tileX = this.worldToTerrainTileIndex(playerPos.x);
        const tileZ = this.worldToTerrainTileIndex(playerPos.z);
        playerCenters.push({ x: tileX, z: tileZ });
      }
    }

    // A duel teleport or camera retarget invalidates queued work immediately.
    // Prune before adding current requests so old regions never compete with
    // the arena for the authoritative loop.
    this.prunePendingTileQueue(neededTiles, contentTiles);

    // Queue missing geometry and exact resident promotions. Full-content tiles
    // are never regenerated when centers move or requests repeat.
    for (const tileKey of neededTiles) {
      const [x, z] = tileKey.split("_").map(Number);
      this.enqueueTileForGeneration(x, z, contentTiles.has(tileKey));
    }

    // Remove tiles that are no longer needed, with hysteresis padding
    // Approximate each player's center from their core chunk set
    for (const [tileKey, tile] of this.terrainTiles) {
      if (!neededTiles.has(tileKey)) {
        let minChebyshev = Infinity;
        for (const c of playerCenters) {
          const d = Math.max(Math.abs(tile.x - c.x), Math.abs(tile.z - c.z));
          if (d < minChebyshev) minChebyshev = d;
        }
        if (minChebyshev > this.terrainOnlyChunkRange + this.unloadPadding) {
          this.unloadTile(tile);
        }
      }
    }

    // Log simulation status every 10 updates
    if (Math.random() < 0.1) {
      const _totalPlayers = centers.length;
      const _simulatedChunkCount = this.simulatedChunks.size;
      const _loadedChunkCount = this.terrainTiles.size;

      // Simulation status tracked for debugging

      // Log shared world status
      const sharedChunks = Array.from(this.chunkPlayerCounts.entries())
        .filter(([_, count]) => count > 1)
        .map(([key, count]) => `${key}(${count})`)
        .join(", ");

      if (sharedChunks) {
        // Multiple players sharing chunks - enhanced simulation active
      }
    }
  }

  /**
   * Perform periodic serialization every 15 minutes
   */
  private performPeriodicSerialization(): void {
    const now = Date.now();

    if (now - this.lastSerializationTime >= this.serializationInterval) {
      this.performImmediateSerialization();
      this.lastSerializationTime = now;
    }
  }

  /**
   * Perform immediate serialization of all world state
   */
  private performImmediateSerialization(): void {
    const startTime = Date.now();
    let _serializedChunks = 0;

    // Serialize all active chunks
    for (const [key, tile] of this.terrainTiles) {
      const serializationData = {
        key: key,
        tileX: tile.x,
        tileZ: tile.z,
        biome: tile.biome,
        heightData: tile.heightData,
        resourceStates: tile.resources.map((r) => ({
          id: r.id,
          type: r.type,
          position: [r.position.x, r.position.y, r.position.z] as [
            number,
            number,
            number,
          ],
        })),
        roadData: tile.roads.map((r) => {
          // Roads use {x, z} format based on generateRoadsForTile implementation
          const startZ = (r.start as { x: number; z: number }).z;
          const endZ = (r.end as { x: number; z: number }).z;
          return {
            start: [r.start.x, startZ] as [number, number],
            end: [r.end.x, endZ] as [number, number],
            width: r.width,
          };
        }),
        playerCount: this.chunkPlayerCounts.get(key) || 0,
        lastActiveTime: tile.lastActiveTime,
        isSimulated: this.simulatedChunks.has(key),
        worldStateVersion: this.worldStateVersion,
        timestamp: Date.now(),
      };

      // Store for database persistence with proper tuple types
      const typedSerializationData = {
        ...serializationData,
        resourceStates: serializationData.resourceStates.map((rs) => ({
          ...rs,
          position: rs.position as [number, number, number],
        })),
        roadData: serializationData.roadData.map((rd) => ({
          ...rd,
          start: rd.start as [number, number],
          end: rd.end as [number, number],
        })),
      };
      this.pendingSerializationData.set(key, typedSerializationData);

      // Save to database if available
      if (this.databaseSystem) {
        const chunkData: WorldChunkData = {
          chunkX: tile.x,
          chunkZ: tile.z,
          data: JSON.stringify({
            biome: tile.biome || "grassland",
            heightData: tile.heightData || [],
            chunkSeed: tile.chunkSeed || 0,
            resourceStates: serializationData.resourceStates,
            roadData: serializationData.roadData,
          }),
          lastActive: tile.lastActiveTime?.getTime() || Date.now(),
          playerCount: this.chunkPlayerCounts.get(key) || 0,
          version: this.worldStateVersion,
        };

        this.databaseSystem.saveWorldChunk(chunkData);
        _serializedChunks++;
      }
    }

    // Cap pendingSerializationData to prevent unbounded memory growth.
    // Evict oldest entries (by insertion order) when over the limit.
    if (
      this.pendingSerializationData.size > MAX_PENDING_SERIALIZATION_ENTRIES
    ) {
      const excess =
        this.pendingSerializationData.size - MAX_PENDING_SERIALIZATION_ENTRIES;
      let evicted = 0;
      for (const evictKey of this.pendingSerializationData.keys()) {
        if (evicted >= excess) break;
        // Only evict tiles that are no longer loaded
        if (!this.terrainTiles.has(evictKey)) {
          this.pendingSerializationData.delete(evictKey);
          evicted++;
        }
      }
    }

    // Increment world state version
    this.worldStateVersion++;

    const _elapsed = Date.now() - startTime;
  }

  /**
   * Verify terrain bounding boxes for size validation
   */
  private verifyTerrainBoundingBoxes(): void {
    let _validBoxes = 0;
    let _invalidBoxes = 0;
    const oversizedTiles: string[] = [];

    for (const [key, tile] of this.terrainTiles) {
      // Calculate bounding box for this tile
      const box = this._tempBox3;

      if (tile.mesh && tile.mesh.geometry) {
        box.setFromObject(tile.mesh);

        // Verify tile is within expected size bounds
        const tempVector = this._tempVec3;
        const size = box.getSize(tempVector);
        const expectedSize = this.CONFIG.TILE_SIZE;

        if (size.x > expectedSize * 1.1 || size.z > expectedSize * 1.1) {
          _invalidBoxes++;
          oversizedTiles.push(key);
        } else {
          _validBoxes++;
        }

        // Store bounding box for future reference
        this.terrainBoundingBoxes.set(key, box.clone());

        // Verify tile is within world bounds
        if (
          box.min.x < this.worldBounds.minX ||
          box.max.x > this.worldBounds.maxX ||
          box.min.z < this.worldBounds.minZ ||
          box.max.z > this.worldBounds.maxZ
        ) {
          // Tile exceeds world bounds - tracked but no logging
        }
      }
    }

    // Verification completed - results available via getChunkSimulationStatus()
  }

  /**
   * Get chunk simulation status for debugging
   */
  getChunkSimulationStatus(): {
    totalChunks: number;
    simulatedChunks: number;
    playerChunks: Map<string, Set<string>>;
    chunkPlayerCounts: Map<string, number>;
    lastSerializationTime: number;
    nextSerializationIn: number;
    worldStateVersion: number;
    quadTreeLOD?: {
      totalNodes: number;
      visualChunks: number;
      pendingWorkers: number;
      settledQueue: number;
      syncQueue: number;
    };
  } {
    return {
      totalChunks: this.terrainTiles.size,
      simulatedChunks: this.simulatedChunks.size,
      playerChunks: new Map(this.playerChunks),
      chunkPlayerCounts: new Map(this.chunkPlayerCounts),
      lastSerializationTime: this.lastSerializationTime,
      nextSerializationIn:
        this.serializationInterval - (Date.now() - this.lastSerializationTime),
      worldStateVersion: this.worldStateVersion,
      quadTreeLOD: this.quadTreeVisualManager?.getStats(),
    };
  }

  /**
   * Check if a chunk is being simulated
   */
  isChunkSimulated(chunkX: number, chunkZ: number): boolean {
    const key = `${chunkX}_${chunkZ}`;
    return this.simulatedChunks.has(key);
  }

  /**
   * Get players in a specific chunk
   */
  getPlayersInChunk(chunkX: number, chunkZ: number): string[] {
    const key = `${chunkX}_${chunkZ}`;
    const playersInChunk: string[] = [];

    for (const [playerId, chunks] of this.playerChunks) {
      if (chunks.has(key)) {
        playersInChunk.push(playerId);
      }
    }

    return playersInChunk;
  }

  /**
   * Force immediate serialization (for testing/admin commands)
   */
  forceSerialization(): void {
    this.performImmediateSerialization();
  }

  public getTiles(): Map<string, TerrainTile> {
    return this.terrainTiles;
  }

  /**
   * Checks if the physics mesh for a specific world coordinate is ready.
   * @param worldX The world X coordinate.
   * @param worldZ The world Z coordinate.
   * @returns True if the physics mesh for the containing tile exists.
   */
  public isPhysicsReadyAt(worldX: number, worldZ: number): boolean {
    const tileX = Math.floor(worldX / this.CONFIG.TILE_SIZE);
    const tileZ = Math.floor(worldZ / this.CONFIG.TILE_SIZE);
    const key = `${tileX}_${tileZ}`;

    const tile = this.terrainTiles.get(key);
    if (!this.serverMeshCollisionEnabled) {
      return !!tile;
    }
    return !!(tile && (tile.collision as PMeshHandle | null));
  }

  /**
   * Check if terrain system is ready for players to spawn
   */
  public isReady(): boolean {
    return this._initialTilesReady && this.noise !== undefined;
  }

  /**
   * A stricter client-stream gate than isReady(): the gameplay height field
   * may be usable while visible quad terrain and grass are still arriving.
   */
  public getStreamingVisualReadiness(criticalRadius = 250): {
    ready: boolean;
    terrain: ReturnType<TerrainVisualManager["getStreamingReadiness"]> | null;
    grass: ReturnType<GrassVisualManager["getStreamingReadiness"]> | null;
  } {
    const terrain =
      this.quadTreeVisualManager?.getStreamingReadiness(criticalRadius) ?? null;
    const grass =
      this.grassVisualManager && this.quadTreeVisualManager
        ? this.grassVisualManager.getStreamingReadiness(
            this.quadTreeVisualManager.getQuadTree().getFinalNodes(),
            criticalRadius,
          )
        : null;
    return {
      ready: Boolean(
        terrain?.ready &&
        (!this.grassVisualManager || grass?.ready) &&
        (!this.compactPondDressing ||
          this.compactPondDressing.getReceipt().ready),
      ),
      terrain,
      grass,
    };
  }

  public getCompactPondDressingReceipt() {
    return this.compactPondDressing?.getReceipt() ?? null;
  }

  public getGrassProfileReceipt() {
    return this.grassVisualManager?.getProfileReceipt() ?? null;
  }

  public getTileSize(): number {
    return this.CONFIG.TILE_SIZE;
  }

  /**
   * Get biome data by ID - used by VegetationSystem to get vegetation config
   */
  public getBiomeData(biomeId: string): (typeof BIOMES)[string] | null {
    return BIOMES[biomeId] ?? null;
  }

  /**
   * Handle preference changes - specifically water reflections
   */
  private onPrefsChange = (changes: {
    waterReflections?: { value: boolean };
  }) => {
    if (changes.waterReflections && this.waterSystem) {
      this.waterSystem.setReflectionsEnabled(changes.waterReflections.value);
    }
  };

  // ============================================================================
  // DEBUG / DEVELOPMENT METHODS
  // ============================================================================

  /**
   * Force refresh road influence on all loaded terrain tiles.
   * Call this from the browser console if roads aren't visible:
   *   world.getSystem('terrain').forceRefreshRoads()
   *
   * This recalculates road influence for every vertex in every loaded tile,
   * which should make roads visible if the road data exists.
   */
  public async forceRefreshRoads(): Promise<void> {
    console.log(
      "[TerrainSystem] Force refreshing road influence on all tiles...",
    );

    // Ensure road system reference is current
    this.roadNetworkSystem = this.world.getSystem("roads") as
      RoadNetworkSystem | undefined;

    if (!this.roadNetworkSystem) {
      console.error("[TerrainSystem] Road system not found!");
      return;
    }

    const roads = this.roadNetworkSystem.getRoads();
    console.log(`[TerrainSystem] Road system has ${roads.length} roads`);

    // Clear the logged tiles set to see fresh logs
    this._loggedTileSegments.clear();

    // Force refresh
    await this.refreshRoadInfluence();

    console.log(
      "[TerrainSystem] Road refresh complete. If roads are still not visible:",
    );
    console.log("  1. Check that tiles have road segments (see logs above)");
    console.log(
      "  2. Try regenerating tiles: world.getSystem('terrain').regenerateAllTiles()",
    );
  }

  /**
   * Regenerate all loaded terrain tiles from scratch.
   * This is more aggressive than forceRefreshRoads() - it completely
   * recreates the geometry including road influence calculation.
   *
   * Call from console: world.getSystem('terrain').regenerateAllTiles()
   */
  public async regenerateAllTiles(): Promise<void> {
    console.log("[TerrainSystem] Regenerating all terrain tiles...");

    // Ensure road system reference is current
    this.roadNetworkSystem = this.world.getSystem("roads") as
      RoadNetworkSystem | undefined;

    // Clear the logged tiles set to see fresh logs
    this._loggedTileSegments.clear();

    const tiles = Array.from(this.terrainTiles.entries());
    console.log(`[TerrainSystem] Regenerating ${tiles.length} tiles...`);

    for (const [key, tile] of tiles) {
      // Remove old mesh from scene
      if (tile.mesh && this.terrainContainer) {
        this.terrainContainer.remove(tile.mesh);
        tile.mesh.geometry.dispose();
      }

      // Remove from tiles map
      this.terrainTiles.delete(key);
    }

    // Regenerate tiles
    const tileCoords = tiles.map(([key]) => {
      const [x, z] = key.split("_").map(Number);
      return { x, z };
    });

    for (const { x, z } of tileCoords) {
      this.generateTile(x, z);
    }

    console.log(`[TerrainSystem] Regenerated ${tileCoords.length} tiles`);
  }

  /**
   * Debug: Get road influence at a specific world position
   * Call from console: world.getSystem('terrain').debugRoadInfluenceAt(x, z)
   */
  public debugRoadInfluenceAt(worldX: number, worldZ: number): void {
    // Road tile coordinates (road system uses origin-based tiles)
    const roadTileX = Math.floor(worldX / this.CONFIG.TILE_SIZE);
    const roadTileZ = Math.floor(worldZ / this.CONFIG.TILE_SIZE);

    const terrainTileX = this.worldToTerrainTileIndex(worldX);
    const terrainTileZ = this.worldToTerrainTileIndex(worldZ);

    console.log(
      `[TerrainSystem] Debug road influence at (${worldX}, ${worldZ}):`,
    );
    console.log(`  Road tile: (${roadTileX}, ${roadTileZ})`);
    console.log(`  Terrain tile: (${terrainTileX}, ${terrainTileZ})`);

    // Check road system
    this.roadNetworkSystem ??= this.world.getSystem("roads") as
      RoadNetworkSystem | undefined;

    if (!this.roadNetworkSystem) {
      console.log("  Road system: NOT FOUND");
      return;
    }

    const segments = this.roadNetworkSystem.getRoadSegmentsForTile(
      roadTileX,
      roadTileZ,
    );
    console.log(
      `  Road segments in road tile (${roadTileX}, ${roadTileZ}): ${segments.length}`,
    );

    if (segments.length > 0) {
      // Calculate influence
      const influence = this.calculateRoadInfluenceAtVertex(
        worldX,
        worldZ,
        terrainTileX,
        terrainTileZ,
      );
      console.log(`  Calculated road influence: ${influence.toFixed(4)}`);

      // Show nearest segment - use road-tile-local coordinates
      const localX = worldX - roadTileX * this.CONFIG.TILE_SIZE;
      const localZ = worldZ - roadTileZ * this.CONFIG.TILE_SIZE;
      let minDist = Infinity;
      let nearestSeg: RoadTileSegment | null = null;
      for (const seg of segments) {
        const dist = this.distanceToLineSegmentLocal(
          localX,
          localZ,
          seg.start.x,
          seg.start.z,
          seg.end.x,
          seg.end.z,
        );
        if (dist < minDist) {
          minDist = dist;
          nearestSeg = seg;
        }
      }
      console.log(`  Distance to nearest road segment: ${minDist.toFixed(2)}m`);
      if (nearestSeg) {
        console.log(
          `  Nearest segment: (${nearestSeg.start.x.toFixed(1)}, ${nearestSeg.start.z.toFixed(1)}) -> (${nearestSeg.end.x.toFixed(1)}, ${nearestSeg.end.z.toFixed(1)}), width=${nearestSeg.width}`,
        );
      }
    }

    // Check if terrain tile exists and has roadInfluence attribute
    const tileKey = `${terrainTileX}_${terrainTileZ}`;
    const tile = this.terrainTiles.get(tileKey);
    if (tile?.mesh) {
      const geometry = (tile.mesh as THREE.Mesh)
        .geometry as THREE.BufferGeometry;
      const roadAttr = geometry.getAttribute("roadInfluence");
      if (roadAttr) {
        const arr = roadAttr.array as Float32Array;
        let nonZero = 0;
        let maxVal = 0;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] > 0) nonZero++;
          maxVal = Math.max(maxVal, arr[i]);
        }
        console.log(
          `  Tile roadInfluence attribute: ${nonZero}/${arr.length} non-zero, max=${maxVal.toFixed(4)}`,
        );
      } else {
        console.log(`  Tile roadInfluence attribute: NOT FOUND`);
      }
    } else {
      console.log(`  Terrain tile mesh: NOT LOADED (key: ${tileKey})`);
    }
  }
}
