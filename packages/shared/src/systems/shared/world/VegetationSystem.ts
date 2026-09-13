/**
 * VegetationSystem.ts - GPU Instanced Vegetation Rendering
 *
 * Provides efficient rendering of vegetation (trees, bushes, grass, flowers, rocks)
 * using Three.js InstancedMesh for batched GPU rendering.
 *
 * **Features:**
 * - GPU-instanced rendering for thousands of vegetation objects in few draw calls
 * - Procedural placement based on biome vegetation configuration
 * - Automatic LOD culling based on player distance
 * - Deterministic placement using seeded PRNG (same vegetation on client/server)
 * - Per-tile vegetation generation synced with terrain system
 * - Noise-based distribution for natural-looking placement
 * - Clustering support for natural groupings of vegetation
 *
 * **Performance:**
 * - Each vegetation type renders in a single draw call via InstancedMesh
 * - Dynamic visibility culling shows closest N instances
 * - Tile-based generation/unloading tied to terrain system
 *
 * **Integration:**
 * - Listens to TerrainSystem tile events for generation triggers
 * - Uses biome vegetation config from biomes.json
 * - Loads asset definitions from vegetation.json manifest
 *
 * **Runs on:** Client only (vegetation is purely visual)
 */

import THREE, { MeshStandardNodeMaterial } from "../../../extras/three/three";
import { System } from "../infrastructure/System";
import type { World, WorldOptions } from "../../../types";
import type {
  VegetationAsset,
  VegetationCategory,
  VegetationLayer,
  VegetationInstance,
  BiomeVegetationConfig,
} from "../../../types/world/world-types";
import { EventType } from "../../../types/events";
import { LoadPriority } from "../../../types";
import { modelCache } from "../../../utils/rendering/ModelCache";
import { ProjectedGeometryError } from "../../../utils/rendering/ProjectedGeometryError";
import { NoiseGenerator } from "../../../utils/NoiseGenerator";
import { FrustumQuadtree } from "../../../utils/spatial/FrustumQuadtree";
import {
  generateVegetationPlacementsAsync,
  isVegetationWorkerAvailable,
  type VegetationLayerInput,
} from "../../../utils/workers/VegetationWorker";
import {
  createGPUVegetationMaterial,
  type GPUVegetationMaterial,
} from "./GPUMaterials";
import {
  getLODDistances,
  getLODDistancesScaled,
  applyLODSettings,
  type LODDistancesWithSq,
} from "./LODConfig";
import { csmLevels, type Environment } from "./Environment";
import type { TerrainSystem } from "./TerrainSystem";
import type { RoadNetworkSystem } from "./RoadNetworkSystem";
import { updateTreeInstances } from "./ProcgenTreeCache";
import {
  isGPUComputeAvailable,
  getGlobalCullingManager,
} from "../../../utils/compute";
import { isPositionInsideDuelArenaZone } from "../../../data/duel-manifest";
import { shouldStreamVegetationBackgroundLods } from "../../../runtime/clientViewportMode";
// Octahedral impostor for high-quality multi-angle billboard rendering
import {
  OctahedralImpostor,
  OctahedronType,
  type ImpostorBakeResult,
  type ImpostorInstance,
  type CompatibleRenderer,
  type DissolveConfig,
} from "@hyperforge/impostor";

/**
 * NOTE: LOD1 models are PRE-BAKED offline using scripts/bake-lod.sh (Blender).
 * Runtime LOD generation has been removed for performance.
 *
 * LOD models are optional and must be explicitly listed in vegetation.json:
 * - lod1Model: medium distance mesh
 * - lod2Model: far distance mesh
 *
 * To bake LODs:
 *   ./scripts/bake-lod.sh
 *
 * Categories that skip LOD1 (too small, go straight to imposter):
 * - mushroom
 * - grass
 * - flower (small ones)
 */

/**
 * Categories that skip LOD1/LOD2 (go directly to imposter).
 * These are small objects where LOD levels wouldn't provide meaningful benefit.
 */
const SKIP_LOD1_CATEGORIES = new Set([
  "mushroom",
  "grass",
  "flower",
  "fern",
  "ivy",
]);

/**
 * Vegetation rendering configuration.
 *
 * CULLING HIERARCHY (most to least aggressive):
 * 1. CPU Tile Loading: Only generate vegetation for tiles within MAX_VEGETATION_TILE_RADIUS
 * 2. CPU Chunk Visibility: Hide chunks beyond CHUNK_RENDER_DISTANCE or outside camera frustum
 * 3. GPU Shader Fade: Dissolve individual instances between FADE_START and FADE_END
 *
 * IMPORTANT: Vegetation fade must happen BEFORE shadow cutoff to avoid unshadowed trees!
 * Fade distances are dynamically set based on shadow quality in start()
 */
const VEGETATION_CHUNK_SIZE = 64; // meters per chunk
const MAX_INSTANCES_PER_CHUNK = 256;

let FADE_START = 1000; // Shader fade begins (fully opaque inside)
let FADE_END = 1200; // Shader fully culls (invisible beyond)
let CHUNK_RENDER_DISTANCE = 1400; // CPU hides chunks (buffer zone for loading)

// NOTE: Per-category LOD distances are defined in LODConfig.ts LOD_DISTANCES
// Access via getLODDistances(category) for actual LOD decisions.
// The module-level FADE_START/FADE_END above are used for shared material creation.

// Bounding sphere buffer to account for model heights and scale variations
// Trees can be 15-20m tall with 1.0-1.5x scale
// Reduced from 40m to 20m for tighter frustum culling (less off-screen rendering)
const BOUNDING_SPHERE_BUFFER = 20;

/**
 * IMPOSTOR DISABLE FLAG
 * When true, vegetation uses dissolve fade-out at distance instead of impostor billboards.
 * The 3D meshes (LOD0/LOD1/LOD2) stay visible and fade out via GPU dithered dissolve.
 * This matches the tree rendering style for visual consistency.
 */
const DISABLE_IMPOSTORS = true;

/**
 * Chunked instanced mesh - one per spatial chunk per asset type
 */
interface ChunkedInstancedMesh {
  /** The InstancedMesh for this chunk */
  mesh: THREE.InstancedMesh;
  /** Current instance count */
  count: number;
  /** Instance attributes */
  positionAttr: THREE.InstancedBufferAttribute;
  scaleAttr: THREE.InstancedBufferAttribute;
  rotationAttr: THREE.InstancedBufferAttribute;
  /** Chunk world bounds (for bounding sphere) */
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Asset data - tracks geometry/material for a loaded GLB (shared across chunks)
 * Supports 3-level LOD system: LOD0 (full detail), LOD1 (low poly), and LOD2 (very low poly)
 */
interface AssetData {
  /** The GLB geometry (LOD0 - full detail) */
  geometry: THREE.BufferGeometry;
  /** Material(s) from the model */
  material: THREE.Material | THREE.Material[];
  /** Asset definition */
  asset: VegetationAsset;
  /** Y offset to lift model so its base sits on terrain */
  modelBaseOffset: number;
  /** GPU material (shared across all chunks) */
  gpuMaterial: GPUVegetationMaterial;
  /** Bounding size in meters (for LOD distance scaling) */
  boundingSize: number;

  // LOD1 (low poly ~10%) data - optional, only loaded if lod1Model is specified
  /** LOD1 geometry (low poly) - null if no LOD1 model */
  lod1Geometry: THREE.BufferGeometry | null;
  /** LOD1 material (low poly) - null if no LOD1 model */
  lod1Material: THREE.Material | THREE.Material[] | null;
  /** LOD1 model base offset (may differ from LOD0) */
  lod1ModelBaseOffset: number;
  /** Whether LOD1 model is available for this asset */
  hasLOD1: boolean;

  // LOD2 (very low poly ~3%) data - optional, loaded from _lod2.glb files
  /** LOD2 geometry (very low poly) - null if no LOD2 model */
  lod2Geometry: THREE.BufferGeometry | null;
  /** LOD2 material (very low poly) - null if no LOD2 model */
  lod2Material: THREE.Material | THREE.Material[] | null;
  /** LOD2 model base offset (may differ from LOD0/LOD1) */
  lod2ModelBaseOffset: number;
  /** Whether LOD2 model is available for this asset */
  hasLOD2: boolean;
}

type ScreenSpaceChunk = {
  asset: AssetData;
  heroGeometry: THREE.BufferGeometry;
  lodGeometry: THREE.BufferGeometry | null;
  level: 0 | 1;
  errorPixels: number;
  extentPixels: number;
  shadowErrorPixels: number;
};

/**
 * Tile vegetation data - tracks all instances for a terrain tile
 */
interface TileVegetationData {
  /** Tile key (format: "tileX_tileZ") */
  key: string;
  /** All instances in this tile, keyed by instance ID */
  instances: Map<string, VegetationInstance>;
  /** Whether this tile's vegetation has been generated */
  generated: boolean;
  /** Biome this tile belongs to */
  biome: string;
}

/**
 * Configuration for the vegetation system
 */
interface VegetationConfig {
  /** Maximum visible instances per asset type */
  maxInstancesPerAsset: number;
  /** Distance beyond which vegetation is culled */
  cullDistance: number;
  /** Distance at which to switch to imposters (billboards) */
  imposterDistance: number;
  /** How often to update visibility (ms) */
  updateInterval: number;
  /** Minimum player movement to trigger visibility update */
  movementThreshold: number;
}

const DEFAULT_CONFIG: VegetationConfig = {
  maxInstancesPerAsset: 4096, // Power of 2 for GPU efficiency
  cullDistance: 280, // Used for tile loading - must be > fadeEnd (250m) so vegetation loads before visible
  imposterDistance: 120, // Not used in GPU mode (shader handles LOD)
  updateInterval: 100, // Not used in GPU mode
  movementThreshold: 2, // Not used in GPU mode
};

/**
 * LOD CONFIGURATION - Now uses unified system from LODConfig.ts
 *
 * The 3-tier LOD system:
 * - LOD0 (full detail): 0 to lod1Distance
 * - LOD1 (low poly): lod1Distance to imposterDistance
 * - Imposter (billboard): imposterDistance to fadeDistance
 * - Culled: beyond fadeDistance
 *
 * Configuration is defined in LODConfig.ts LOD_DISTANCES and accessed via getLODDistances()
 */

/**
 * Get LOD config for a vegetation asset, with size-based scaling.
 * Uses the asset's bounding size to scale draw distances - larger objects visible from farther away.
 *
 * @param category - Asset category (tree, bush, etc.)
 * @param boundingSize - Optional bounding size in meters for scaling
 */
function getAssetLODConfig(category: string, boundingSize?: number) {
  if (boundingSize !== undefined && boundingSize > 0) {
    return getLODDistancesScaled(category, boundingSize);
  }
  return getLODDistances(category);
}

/** Max tile distance from player to generate vegetation (in tiles, not world units) */
const MAX_VEGETATION_TILE_RADIUS = 5;

/** Water threshold from centralized constants */
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";

/** Water level in world units - from centralized TERRAIN_CONSTANTS */
const WATER_LEVEL = TERRAIN_CONSTANTS.WATER_THRESHOLD;

/** Buffer distance from water edge where vegetation shouldn't spawn - generous buffer */
const WATER_EDGE_BUFFER = 6.0; // Min spawn height = WATER_LEVEL + WATER_EDGE_BUFFER

/**
 * Extended impostor instance with dissolve support
 */
interface ImpostorInstanceWithDissolve extends ImpostorInstance {
  updateDissolve?: (playerPos: THREE.Vector3) => void;
}

/**
 * Imposter data for billboard rendering of distant vegetation.
 * One ImposterData per asset type - shared across all chunks of that asset.
 *
 * Uses octahedral impostor system for high-quality multi-angle rendering.
 * The octahedral impostor bakes the mesh from multiple viewing angles into
 * an atlas texture, then blends between views at runtime for correct appearance
 * from any camera angle.
 */
interface ImposterData {
  /** Octahedral impostor bake result (atlas texture + metadata) */
  bakeResult: ImpostorBakeResult;
  /** Individual impostor instances for per-chunk LOD management (with dissolve support) */
  instances: Map<string, ImpostorInstanceWithDissolve>;
  /** Billboard size (diameter of bounding sphere) in world units */
  size: number;
  /** Y offset to position billboard base at ground level */
  heightOffset: number;
  /** Map from chunk key to array of instance keys (for efficient chunk-based iteration) */
  chunkInstanceKeys: Map<string, string[]>;
  /** Dissolve configuration for this asset type */
  dissolveConfig: DissolveConfig;
  /** LOD configuration for this asset category */
  lodConfig: LODDistancesWithSq;
}

/**
 * LOD level for a chunk
 * 0 = LOD0 (full detail 3D mesh)
 * 1 = LOD1 (low poly 3D mesh ~10% verts)
 * 2 = LOD2 (very low poly 3D mesh ~3% verts)
 * 3 = Imposter (billboard)
 * 4 = Culled (hidden)
 */
type ChunkLODLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Instance data for vegetation placement within a chunk.
 * Used for populating LOD meshes and rebuilding imposters.
 */
interface ChunkInstanceData {
  /** World X position */
  x: number;
  /** World Y position (terrain height) */
  y: number;
  /** World Z position */
  z: number;
  /** Scale factor */
  scale: number;
  /** Y-axis rotation in radians */
  rotationY: number;
}

/**
 * Chunked mesh state - tracks which LOD level a chunk is currently using.
 * LOD transitions use hysteresis (different up/down thresholds) to prevent flickering.
 *
 * **Performance:** Caches all derived data to avoid repeated work in hot path:
 * - Parsed asset ID (avoids string splits)
 * - LOD config with squared distances (avoids function calls and object allocation)
 * - LOD keys (avoids string concatenation)
 * - LOD availability flags (avoids Map lookups)
 */
interface ChunkLODState {
  /** Current active LOD level (0=LOD0, 1=LOD1, 2=LOD2, 3=imposter, 4=culled) */
  lodLevel: ChunkLODLevel;
  /** Chunk center X (for distance calculation) */
  centerX: number;
  /** Chunk center Z (for distance calculation) */
  centerZ: number;
  /** Cached asset ID (parsed from chunk key to avoid repeated splits) */
  assetId: string;
  /** Cached LOD distances with pre-computed squared values */
  lodConfig: LODDistancesWithSq;
  /** Cached LOD1 chunk key */
  lod1Key: string;
  /** Cached LOD2 chunk key */
  lod2Key: string;
  /** Whether LOD1 mesh is available for this asset */
  hasLOD1: boolean;
  /** Whether LOD2 mesh is available for this asset */
  hasLOD2: boolean;
}

/**
 * VegetationSystem - GPU Instanced Vegetation Rendering
 */
export class VegetationSystem extends System {
  private streamBackgroundLods = true;
  private scene: THREE.Scene | null = null;
  private vegetationGroup: THREE.Group | null = null;

  /** Flag to prevent callbacks from executing after destroy() */
  private isDestroyed = false;

  // Asset management
  private assetDefinitions = new Map<string, VegetationAsset>();
  private pendingAssetLoads = new Set<string>();

  // Streaming LOD - deferred loading queues
  private pendingLOD1Loads = new Set<string>();
  private pendingLOD2Loads = new Set<string>();
  private streamingLOD1Queue: string[] = [];
  private streamingLOD2Queue: string[] = [];
  /** Number of LOD models to load per frame (streaming bandwidth) - higher = faster loading, more CPU */
  private static readonly STREAMING_BATCH_SIZE = 4;
  /** Track in-flight LOD loads to avoid overwhelming the system */
  private lodLoadsInFlight = 0;
  private static readonly MAX_CONCURRENT_LOD_LOADS = 8;

  // CHUNKED VEGETATION - Spatial chunking for proper frustum culling
  // Key format: "chunkX_chunkZ_assetId"
  private chunkedMeshes = new Map<string, ChunkedInstancedMesh>();
  // Loaded asset data (geometry/material) shared across chunks
  private assetData = new Map<string, AssetData>();
  private readonly screenSpaceChunks = new Map<
    ChunkedInstancedMesh,
    ScreenSpaceChunk
  >();
  private readonly disposedPrimaryChunks = new WeakSet<ChunkedInstancedMesh>();
  private readonly projectedGeometryError = new ProjectedGeometryError();
  private readonly lodInstanceMatrix = new THREE.Matrix4();
  private readonly lodModelMatrix = new THREE.Matrix4();
  private lodSunLight: THREE.DirectionalLight | null = null;
  private hasUnknownLodShadowLight = false;
  private readonly checkLodShadowLight = (node: THREE.Object3D): void => {
    if (
      node instanceof THREE.Light &&
      node.castShadow &&
      node !== this.lodSunLight
    )
      this.hasUnknownLodShadowLight = true;
  };

  // Imposter (billboard) management - one ImposterData per asset type
  // Uses OctahedralImpostor for high-quality multi-angle rendering
  private imposters = new Map<string, ImposterData>();
  private octahedralImpostor: OctahedralImpostor | null = null;
  // Track if we're using WebGPU (TSL materials) or WebGL (GLSL materials)
  private usesTSL = false;
  // Track LOD state for each chunk (key = chunkKey)
  private chunkLODStates = new Map<string, ChunkLODState>();
  // Track instance data per chunk for imposter rebuilding (key = chunkKey)
  private chunkInstanceData = new Map<string, ChunkInstanceData[]>();

  // LOD1 chunked meshes (low poly ~10%) - key format: "chunkX_chunkZ_assetId"
  private lod1ChunkedMeshes = new Map<string, ChunkedInstancedMesh>();

  // LOD2 chunked meshes (very low poly ~3%) - key format: "chunkX_chunkZ_assetId"
  private lod2ChunkedMeshes = new Map<string, ChunkedInstancedMesh>();

  // OCTAHEDRAL IMPOSTER RENDERING
  // Uses @hyperforge/impostor for high-quality multi-angle billboard rendering.
  // Each asset gets baked into an octahedral atlas (16x8 viewing angles).
  // Runtime view-dependent blending provides correct appearance from any camera angle.
  private static readonly IMPOSTER_ATLAS_SIZE = 2048;
  private static readonly IMPOSTER_GRID_X = 16;
  private static readonly IMPOSTER_GRID_Y = 8; // Hemisphere for ground-viewed vegetation

  /** Debug mode for impostors: 0=normal, 4=solid red, 5=center texture sample, 6=raw UV sample */
  public static IMPOSTOR_DEBUG_MODE: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 0;

  // Tile vegetation tracking
  private tileVegetation = new Map<string, TileVegetationData>();

  // Pending tiles that are too far from player (lazy loading queue)
  private pendingTiles = new Map<
    string,
    { tileX: number; tileZ: number; biome: string }
  >();
  private pendingTileRegenerations = new Map<
    string,
    { tileX: number; tileZ: number; biome: string; reason: string }
  >();
  private tileRegenerationProcessing = false;
  private readonly MAX_TILE_REGENERATIONS_PER_BATCH = 1;

  // Configuration
  private config: VegetationConfig = DEFAULT_CONFIG;

  // SHARED MATERIAL - All vegetation uses ONE material for minimal draw call overhead
  // Even though we have separate InstancedMeshes per asset (can't merge without MultiDrawIndirect),
  // sharing the material eliminates shader program switches between draw calls
  private sharedVegetationMaterial: GPUVegetationMaterial | null = null;

  // Noise generator for procedural placement
  private noise: NoiseGenerator | null = null;

  // Road network system for road avoidance
  private roadNetworkSystem: RoadNetworkSystem | null = null;
  // Cached water body registry for elevated water checks
  private _waterBodyRegistry: {
    getBodyAt: (x: number, z: number) => { surfaceY: number } | null;
    getWaterSurfaceAt?: (x: number, z: number) => number;
  } | null = null;

  // Temp objects to avoid allocations
  private _tempMatrix = new THREE.Matrix4();
  private _tempPosition = new THREE.Vector3();
  private _tempQuaternion = new THREE.Quaternion();
  private _tempScale = new THREE.Vector3();
  private _tempEuler = new THREE.Euler();
  private _dummy = new THREE.Object3D();
  private _billboardQuat = new THREE.Quaternion();
  // Pre-allocated vectors for hot loops to avoid GC pressure
  private _yAxis = new THREE.Vector3(0, 1, 0);
  private _origin = new THREE.Vector3(0, 0, 0);
  private _lookAtMatrix = new THREE.Matrix4();

  // Frustum culling - view-dependent culling using camera frustum
  private _frustum = new THREE.Frustum();
  private _projScreenMatrix = new THREE.Matrix4();
  // Cache the actual culled view, including camera parents and projection.
  private _culledCameraWorld = new THREE.Matrix4();
  private _culledCameraProjection = new THREE.Matrix4();
  private _culledCoordinateSystem: THREE.CoordinateSystem | null = null;
  private _culledReversedDepth = false;
  private _frustumDirty = true;
  // Spatial acceleration - quadtree for O(log N) frustum queries instead of O(N)
  private chunkQuadtree: FrustumQuadtree | null = null;
  // Set of chunks that were visible last frame (for hiding when no longer visible)
  private _lastVisibleChunks = new Set<string>();
  // Pre-allocated for updateChunkVisibility to avoid GC pressure (reused each frame)
  private _currentVisibleChunks = new Set<string>();
  private _chunksToLOD0: string[] = [];
  private _chunksToLOD1: string[] = [];
  private _chunksToLOD2: string[] = [];
  private _chunksToImposter: string[] = [];
  private _chunksFrom3D: string[] = [];
  // Deferred LOD transition queues (processed across frames to prevent jank)
  private _deferredToImposter: string[] = [];
  private _deferredFrom3D: string[] = [];
  // Deferred chunk hide queue (when many chunks leave frustum at once)
  private _deferredHideChunks: string[] = [];
  // GPU compute culling (optional - uses CPU quadtree fallback)
  private gpuCullingEnabled = false;
  private gpuCullingInitialized = false;
  // Maximum LOD transitions per frame (prevents frame drops)
  private readonly MAX_LOD_TRANSITIONS_PER_FRAME = 8;
  // Maximum chunk hide operations per frame
  private readonly MAX_HIDE_OPS_PER_FRAME = 20;
  // Tile-to-chunk tracking for proper cleanup on tile unload
  // Maps tileKey -> set of chunkKeys created by that tile
  private tileChunks = new Map<string, Set<string>>();
  // Reference counting: how many tiles reference each chunk
  // When a chunk's refcount hits 0, it can be removed from the quadtree
  private chunkTileRefs = new Map<string, number>();

  constructor(world: World) {
    super(world);
  }

  override getDependencies() {
    return { required: ["stage", "terrain"], optional: ["roads"] };
  }

  async init(_options?: WorldOptions): Promise<void> {
    // Client-only system
    if (!this.world.isClient || typeof window === "undefined") {
      return;
    }

    // Initialize noise generator with world seed
    const seed = this.computeSeedFromWorldId();
    this.noise = new NoiseGenerator(seed);

    // Get road network system for road avoidance
    this.roadNetworkSystem = this.world.getSystem(
      "roads",
    ) as RoadNetworkSystem | null;

    // Cache water body registry for elevated water checks in addInstanceToChunk
    const terrainForRegistry = this.world.getSystem("terrain") as
      | {
          getWaterBodyRegistry?: () => {
            getBodyAt: (x: number, z: number) => { surfaceY: number } | null;
            getWaterSurfaceAt?: (x: number, z: number) => number;
          };
        }
      | undefined;
    this._waterBodyRegistry =
      terrainForRegistry?.getWaterBodyRegistry?.() ?? null;

    // Initialize spatial quadtree for O(log N) frustum culling
    // World bounds: 8192m half-size = 16km total (covers most game worlds)
    // Using 8 max depth and 16 items per node for good balance of granularity and performance
    this.chunkQuadtree = new FrustumQuadtree({
      centerX: 0,
      centerZ: 0,
      halfSize: 8192,
      maxDepth: 8,
      maxItemsPerNode: 16,
    });
  }

  /**
   * Initialize the octahedral imposter system.
   * Creates OctahedralImpostor instance for high-quality multi-angle rendering.
   *
   * NOTE: When DISABLE_IMPOSTORS is true, this function returns immediately.
   */
  private initOctahedralImpostor(): void {
    if (DISABLE_IMPOSTORS) return; // Impostors disabled - using dissolve fade instead
    if (this.octahedralImpostor) return; // Already initialized

    // Get renderer (supports both WebGL and WebGPU renderers)
    const graphics = this.world.graphics as
      { renderer?: THREE.WebGPURenderer } | undefined;
    const renderer = graphics?.renderer;
    if (!renderer) {
      console.warn("[VegetationSystem] Cannot init impostor: no renderer");
      return;
    }

    // Detect if we're using WebGPU (TSL) or WebGL (GLSL)
    // WebGPU backend has isWebGPUBackend = true on renderer.backend
    const backend = renderer.backend as
      { isWebGPUBackend?: boolean } | undefined;
    this.usesTSL = !!backend?.isWebGPUBackend;

    // Create the octahedral impostor system (WebGPU)
    this.octahedralImpostor = new OctahedralImpostor(
      renderer as CompatibleRenderer,
    );

    console.log(
      `[VegetationSystem] Initialized octahedral impostor: ${VegetationSystem.IMPOSTER_ATLAS_SIZE}x${VegetationSystem.IMPOSTER_ATLAS_SIZE} atlas, ${VegetationSystem.IMPOSTER_GRID_X}x${VegetationSystem.IMPOSTER_GRID_Y} grid, usesTSL=${this.usesTSL}`,
    );
  }

  /**
   * Compute a deterministic seed from world configuration
   */
  private computeSeedFromWorldId(): number {
    const worldConfig = (this.world as { config?: { terrainSeed?: number } })
      .config;
    if (worldConfig?.terrainSeed !== undefined) {
      return worldConfig.terrainSeed;
    }

    if (typeof process !== "undefined" && process.env?.TERRAIN_SEED) {
      const envSeed = parseInt(process.env.TERRAIN_SEED, 10);
      if (!isNaN(envSeed)) {
        return envSeed;
      }
    }

    return 0; // Fixed seed for deterministic vegetation
  }

  /**
   * Whitelist of vegetation assets to load.
   * Set to null to load all assets from the manifest.
   * Assets are loaded based on biome configuration which references asset IDs.
   */
  private static readonly VEGETATION_ASSET_WHITELIST: string[] | null = null;

  /**
   * Build manifest URL candidates with resilient fallbacks.
   * Prefer explicit assetsUrl first unless it's the local /game-assets placeholder,
   * in which case /manifests is often the more reliable route.
   */
  private getManifestUrlCandidates(fileName: string): string[] {
    const assetsUrl = (this.world.assetsUrl || "").replace(/\/$/, "");
    const assetsManifestUrl = assetsUrl
      ? `${assetsUrl}/manifests/${fileName}`
      : "";

    const localManifestUrl = `/manifests/${fileName}`;
    const localGameAssetsManifestUrl = `/game-assets/manifests/${fileName}`;

    const isLocalGameAssetsPlaceholder = assetsManifestUrl.includes(
      "/game-assets/manifests/",
    );

    const ordered = isLocalGameAssetsPlaceholder
      ? [localManifestUrl, assetsManifestUrl, localGameAssetsManifestUrl]
      : [assetsManifestUrl, localManifestUrl, localGameAssetsManifestUrl];

    return Array.from(new Set(ordered.filter((url) => url.length > 0)));
  }

  /**
   * Load vegetation asset definitions from manifest
   */
  private async loadAssetDefinitions(): Promise<void> {
    try {
      const manifestUrls = this.getManifestUrlCandidates("vegetation.json");

      let manifest: { version: number; assets: VegetationAsset[] } | null =
        null;
      let lastErrorMessage = "";

      for (const manifestUrl of manifestUrls) {
        try {
          const response = await fetch(manifestUrl);
          if (!response.ok) {
            lastErrorMessage =
              `${response.status} ${response.statusText}`.trim();
            continue;
          }

          manifest = (await response.json()) as {
            version: number;
            assets: VegetationAsset[];
          };
          break;
        } catch (error) {
          lastErrorMessage =
            error instanceof Error ? error.message : String(error);
        }
      }

      if (!manifest) {
        console.warn(
          "[VegetationSystem] Vegetation manifest not available, continuing without vegetation assets:",
          lastErrorMessage || "all manifest URL candidates failed",
        );
        return;
      }

      // Filter assets by whitelist if enabled
      const whitelist = VegetationSystem.VEGETATION_ASSET_WHITELIST;
      let loadedCount = 0;
      let skippedCount = 0;

      for (const asset of manifest.assets) {
        if (whitelist === null || whitelist.includes(asset.id)) {
          if (asset.screenSpaceLod) {
            const lod = asset.screenSpaceLod;
            if (
              !asset.lod1Model ||
              asset.lod2Model ||
              !Object.values(lod).every(
                (value) => Number.isFinite(value) && value > 0,
              ) ||
              !(lod.enterErrorPixels < lod.exitErrorPixels) ||
              !(lod.enterExtentPixels < lod.exitExtentPixels)
            ) {
              console.warn(
                `[VegetationSystem] Invalid screen-space LOD for ${asset.id}; retaining hero geometry`,
              );
              this.assetDefinitions.set(asset.id, {
                ...asset,
                screenSpaceLod: undefined,
                lod1Model: undefined,
                lod2Model: undefined,
              });
              loadedCount++;
              continue;
            }
          }
          this.assetDefinitions.set(asset.id, asset);
          loadedCount++;
        } else {
          skippedCount++;
        }
      }

      if (whitelist !== null) {
        console.log(
          `[VegetationSystem] Loaded ${loadedCount} vegetation assets (${skippedCount} filtered by whitelist: ${whitelist.join(", ")})`,
        );
      } else {
        console.log(
          `[VegetationSystem] Loaded ${this.assetDefinitions.size} vegetation asset definitions`,
        );
      }
    } catch (_error) {
      // Vegetation manifest is optional - silently continue without it
      console.warn(
        "[VegetationSystem] Vegetation manifest not available, continuing without vegetation assets",
      );
    }
  }

  /**
   * Load LOD settings from manifest and apply them to the LOD config
   */
  private async loadLODSettings(): Promise<void> {
    const manifestUrls = this.getManifestUrlCandidates("lod-settings.json");

    let lastErrorMessage = "";

    for (const manifestUrl of manifestUrls) {
      try {
        const response = await fetch(manifestUrl);
        if (!response.ok) {
          lastErrorMessage = `${response.status} ${response.statusText}`.trim();
          continue;
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/html")) {
          lastErrorMessage = "Not Found (HTML SPA fallback)";
          continue;
        }

        const settings = (await response.json()) as {
          version?: number;
          distanceThresholds?: Record<
            string,
            { lod1?: number; imposter: number; fadeOut: number }
          >;
          dissolve?: {
            closeRangeStart: number;
            closeRangeEnd: number;
            transitionDuration: number;
          };
          vertexBudgets?: Record<string, { lod0: number; lod1: number }>;
        };

        // Apply the loaded settings
        applyLODSettings(settings);
        return;
      } catch (error) {
        lastErrorMessage =
          error instanceof Error ? error.message : String(error);
      }
    }

    if (lastErrorMessage.length > 0) {
      // LOD settings are optional, don't fail if they can't be loaded
      console.warn(
        "[VegetationSystem] Could not load LOD settings, using defaults:",
        lastErrorMessage,
      );
    }
  }

  async start(): Promise<void> {
    if (!this.world.isClient || typeof window === "undefined") return;
    if (!this.world.stage?.scene) return;

    this.scene = this.world.stage.scene as THREE.Scene;
    this.streamBackgroundLods = shouldStreamVegetationBackgroundLods();

    // Sync vegetation fade distances with shadow quality
    // Vegetation must dissolve BEFORE shadow cutoff to avoid unshadowed trees
    //
    // DISTANCE HIERARCHY (must be in this order):
    // 1. FADE_START - vegetation starts dissolving (dithering begins)
    // 2. FADE_END - vegetation fully dissolved (invisible)
    // 3. Shadow maxFar - shadows end (must be >= FADE_END to avoid unshadowed trees!)
    // 4. CHUNK_RENDER_DISTANCE - chunks become visible (must be > FADE_END for dissolve to work)
    const shadowsLevel = (this.world.prefs?.shadows as string) || "med";
    const csmConfig =
      csmLevels[shadowsLevel as keyof typeof csmLevels] || csmLevels.med;
    const shadowMaxFar = csmConfig.maxFar;

    // Fade distances are independent of shadow range — distant trees render
    // without shadows rather than disappearing at the shadow cutoff.
    FADE_START = 1000;
    FADE_END = 1200;
    CHUNK_RENDER_DISTANCE = 1400;

    // Imposter distances - switch to billboard before dissolve zone
    // LOD transition: 3D mesh -> Billboard imposter -> Dissolve -> Cull
    // Per-category LOD distances are defined in LODConfig.ts LOD_DISTANCES
    // The shared material uses FADE_START/FADE_END for dissolve shader
    console.log(
      `[VegetationSystem] Synced with shadows "${shadowsLevel}": fade ${FADE_START.toFixed(0)}-${FADE_END.toFixed(0)}m, chunks ${CHUNK_RENDER_DISTANCE.toFixed(0)}m (per-category LOD via getLODDistances)`,
    );

    // Load LOD settings first (affects all subsequent distance calculations)
    await this.loadLODSettings();

    // Load vegetation asset definitions now that world.assetsUrl is set
    await this.loadAssetDefinitions();

    // Create root group for all vegetation
    this.vegetationGroup = new THREE.Group();
    this.vegetationGroup.name = "VegetationSystem";
    this.vegetationGroup.frustumCulled = false; // Disable culling on group
    this.scene.add(this.vegetationGroup);

    // Create SHARED material for all vegetation (reduces shader switches)
    // All vegetation uses vertex colors, so one material works for everything
    // Simple distance culling - no expensive LOD scaling
    // Fog uses the shared fogRenderTarget from FogConfig (no texture swap needed)
    this.sharedVegetationMaterial = createGPUVegetationMaterial({
      vertexColors: true,
      alphaTest: 0.5,
      fadeStart: FADE_START,
      fadeEnd: FADE_END,
    });
    console.log(
      `[VegetationSystem] Created shared material (fade: ${FADE_START.toFixed(0)}-${FADE_END.toFixed(0)}m, chunks: ${CHUNK_RENDER_DISTANCE.toFixed(0)}m)`,
    );

    // PERFORMANCE: Enable layer 1 for main camera so it can see vegetation
    // Minimap camera only sees layer 0, so vegetation won't render in minimap
    if (this.world.camera) {
      this.world.camera.layers.enable(1);
    }

    // Listen for terrain tile events
    this.world.on(
      EventType.TERRAIN_TILE_GENERATED,
      this.onTileGenerated.bind(this),
    );
    this.world.on(
      EventType.TERRAIN_TILE_UNLOADED,
      this.onTileUnloaded.bind(this),
    );
    this.world.on(
      EventType.TERRAIN_TILE_REGENERATED,
      this.onTileRegenerated.bind(this),
    );

    console.log(
      `[VegetationSystem] ✅ Started with ${this.assetDefinitions.size} assets, radius=${MAX_VEGETATION_TILE_RADIUS} tiles`,
    );

    // Initialize GPU compute culling (optional enhancement)
    this.initializeGPUCulling();

    // Process existing terrain tiles that were generated before we subscribed
    await this.processExistingTiles();
  }

  /**
   * Initialize GPU compute culling if available.
   * Falls back to CPU quadtree culling if not available.
   */
  private initializeGPUCulling(): void {
    if (this.gpuCullingInitialized) return;
    this.gpuCullingInitialized = true;

    if (!isGPUComputeAvailable()) {
      this.gpuCullingEnabled = false;
      console.log(
        "[VegetationSystem] GPU compute not available, using CPU quadtree culling",
      );
      return;
    }

    const cullingManager = getGlobalCullingManager();
    if (!cullingManager?.isAvailable()) {
      this.gpuCullingEnabled = false;
      return;
    }

    this.gpuCullingEnabled = true;
    console.log("[VegetationSystem] GPU compute culling enabled");
  }

  /**
   * Process terrain tiles that already exist when VegetationSystem starts
   * Only processes tiles near the player for performance
   */
  private async processExistingTiles(): Promise<void> {
    const terrainSystemRaw = this.world.getSystem("terrain");
    if (!terrainSystemRaw) return;

    // Type assertion for terrain system - use the public getTiles() method
    const terrainSystem = terrainSystemRaw as unknown as {
      getTiles?: () => Map<string, { x: number; z: number; biome: string }>;
      CONFIG?: { TILE_SIZE: number };
    };

    if (!terrainSystem.getTiles) return;

    const tileSize = terrainSystem.CONFIG?.TILE_SIZE || 100;
    const playerPos = this.getPlayerPosition();
    const playerTileX = playerPos ? Math.floor(playerPos.x / tileSize) : 0;
    const playerTileZ = playerPos ? Math.floor(playerPos.z / tileSize) : 0;

    const tiles = terrainSystem.getTiles();
    const allTiles = Array.from(tiles.entries()).map(([_key, tile]) => ({
      tileX: tile.x,
      tileZ: tile.z,
      biome: tile.biome || "plains",
    }));

    // Separate into nearby tiles (generate now) and distant tiles (lazy load later)
    const nearbyTiles: typeof allTiles = [];
    const distantTiles: typeof allTiles = [];

    for (const tile of allTiles) {
      const dx = Math.abs(tile.tileX - playerTileX);
      const dz = Math.abs(tile.tileZ - playerTileZ);
      if (Math.max(dx, dz) <= MAX_VEGETATION_TILE_RADIUS) {
        nearbyTiles.push(tile);
      } else {
        distantTiles.push(tile);
      }
    }

    // Sort nearby by distance (closest first)
    nearbyTiles.sort((a, b) => {
      const distA = Math.max(
        Math.abs(a.tileX - playerTileX),
        Math.abs(a.tileZ - playerTileZ),
      );
      const distB = Math.max(
        Math.abs(b.tileX - playerTileX),
        Math.abs(b.tileZ - playerTileZ),
      );
      return distA - distB;
    });

    // Process nearby tiles in parallel batches for maximum throughput
    const totalTiles = nearbyTiles.length;

    if (totalTiles > 0) {
      // PARALLEL BATCH PROCESSING: Process tiles in batches of 8 for optimal parallelism
      // This balances worker pool utilization with progress reporting
      const BATCH_SIZE = 8;
      let processedTiles = 0;

      for (let i = 0; i < nearbyTiles.length; i += BATCH_SIZE) {
        const batch = nearbyTiles.slice(i, i + BATCH_SIZE);

        // Process entire batch in parallel
        await Promise.all(batch.map((tile) => this.onTileGenerated(tile)));

        processedTiles += batch.length;

        // Emit progress event after each batch
        this.world.emit(EventType.ASSETS_LOADING_PROGRESS, {
          progress: Math.floor((processedTiles / totalTiles) * 100),
          total: totalTiles,
          stage: `Growing vegetation... (${processedTiles}/${totalTiles} tiles)`,
          current: processedTiles,
        });
      }
    }

    // Queue distant tiles for lazy loading
    for (const tile of distantTiles) {
      this.pendingTiles.set(`${tile.tileX}_${tile.tileZ}`, tile);
    }

    // Keep startup logs concise; per-tile detail is noisy in embedded spectator mode.
    console.log(
      `[VegetationSystem] Processed ${nearbyTiles.length} nearby tiles, queued ${distantTiles.length} for lazy loading`,
    );
  }

  /**
   * Get player's current tile coordinates
   */
  private getPlayerTile(): { x: number; z: number } | null {
    const terrainSystemRaw = this.world.getSystem("terrain");
    const tileSize =
      (terrainSystemRaw as unknown as { CONFIG?: { TILE_SIZE: number } })
        ?.CONFIG?.TILE_SIZE || 100;

    const playerPos = this.getPlayerPosition();
    if (!playerPos) return null;

    return {
      x: Math.floor(playerPos.x / tileSize),
      z: Math.floor(playerPos.z / tileSize),
    };
  }

  /**
   * Check if a tile is within vegetation generation range of the player
   */
  private isTileInRange(tileX: number, tileZ: number): boolean {
    const playerTile = this.getPlayerTile();
    if (!playerTile) return true; // Generate if we can't determine player position

    const dx = Math.abs(tileX - playerTile.x);
    const dz = Math.abs(tileZ - playerTile.z);
    return Math.max(dx, dz) <= MAX_VEGETATION_TILE_RADIUS;
  }

  /**
   * Handle terrain tile generation - spawn vegetation for the tile
   * Only generates vegetation if the tile is within range of the player
   */
  private async onTileGenerated(data: {
    tileX: number;
    tileZ: number;
    biome: string;
  }): Promise<void> {
    const key = `${data.tileX}_${data.tileZ}`;

    if (this.tileVegetation.has(key)) {
      return;
    }

    if (!this.isTileInRange(data.tileX, data.tileZ)) {
      // Store as pending for later generation when player gets closer
      this.pendingTiles.set(key, data);
      return;
    }

    // Get biome vegetation configuration for trees/bushes/etc
    const biomeConfig = await this.getBiomeVegetationConfig(data.biome);

    if (!biomeConfig || !biomeConfig.enabled) {
      // Still remove from pending even if no other vegetation
      this.pendingTiles.delete(key);
      return;
    }

    // Create tile vegetation data
    const tileData: TileVegetationData = {
      key,
      instances: new Map(),
      generated: false,
      biome: data.biome,
    };
    this.tileVegetation.set(key, tileData);

    // Generate vegetation instances for this tile (trees, bushes, etc)
    await this.generateTileVegetation(data.tileX, data.tileZ, biomeConfig);
    tileData.generated = true;

    // Per-tile vegetation logs are intentionally suppressed to reduce startup log spam.

    // Remove from pending if it was there
    this.pendingTiles.delete(key);
  }

  /**
   * Handle terrain tile unload - remove vegetation instances and dispose chunks
   */
  private onTileUnloaded(data: { tileX: number; tileZ: number }): void {
    const key = `${data.tileX}_${data.tileZ}`;

    // Remove tile vegetation tracking
    this.tileVegetation.delete(key);

    // Remove tile-chunk relationships and dispose orphaned chunks
    // This handles actual mesh cleanup, quadtree removal, and imposter disposal
    this.removeTileChunkRelationships(key);
  }

  /**
   * Handle terrain tile regeneration - clear and regenerate vegetation
   * Called when terrain is modified (e.g., flat zones registered for buildings)
   */
  private onTileRegenerated(data: {
    tileX: number;
    tileZ: number;
    biome: string;
    reason: string;
  }): void {
    const key = `${data.tileX}_${data.tileZ}`;
    // Coalesce duplicate regenerations for the same tile.
    this.pendingTileRegenerations.set(key, data);

    if (!this.tileRegenerationProcessing) {
      void this.processQueuedTileRegenerations();
    }
  }

  private async processQueuedTileRegenerations(): Promise<void> {
    if (
      this.tileRegenerationProcessing ||
      this.pendingTileRegenerations.size === 0
    ) {
      return;
    }

    this.tileRegenerationProcessing = true;

    try {
      while (this.pendingTileRegenerations.size > 0 && !this.isDestroyed) {
        let processed = 0;

        while (
          processed < this.MAX_TILE_REGENERATIONS_PER_BATCH &&
          this.pendingTileRegenerations.size > 0
        ) {
          const next = this.pendingTileRegenerations.entries().next().value as
            | [
                string,
                { tileX: number; tileZ: number; biome: string; reason: string },
              ]
            | undefined;
          if (!next) break;

          const [key, regenData] = next;
          this.pendingTileRegenerations.delete(key);
          await this.regenerateTileVegetation(regenData);
          processed++;
        }

        if (this.pendingTileRegenerations.size > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } finally {
      this.tileRegenerationProcessing = false;
      if (!this.isDestroyed && this.pendingTileRegenerations.size > 0) {
        void this.processQueuedTileRegenerations();
      }
    }
  }

  private async regenerateTileVegetation(data: {
    tileX: number;
    tileZ: number;
    biome: string;
    reason: string;
  }): Promise<void> {
    const key = `${data.tileX}_${data.tileZ}`;

    // Get terrain tile size for bounds calculation
    const terrainSystem = this.world.getSystem("terrain") as {
      CONFIG?: { TILE_SIZE: number };
    } | null;
    const tileSize = terrainSystem?.CONFIG?.TILE_SIZE ?? 100;
    const tileWorldX = data.tileX * tileSize;
    const tileWorldZ = data.tileZ * tileSize;

    // Prefer tile-to-chunk tracking for O(chunks-for-tile) cleanup.
    // Fall back to overlap scanning only if no tracking exists.
    const chunksToRemoveSet = new Set<string>();
    const trackedChunks = this.tileChunks.get(key);
    if (trackedChunks && trackedChunks.size > 0) {
      for (const chunkKey of trackedChunks) {
        chunksToRemoveSet.add(chunkKey);
      }
    } else {
      for (const [chunkKey, chunked] of this.chunkedMeshes) {
        if (
          chunked.maxX >= tileWorldX &&
          chunked.minX <= tileWorldX + tileSize &&
          chunked.maxZ >= tileWorldZ &&
          chunked.minZ <= tileWorldZ + tileSize
        ) {
          chunksToRemoveSet.add(chunkKey);
        }
      }
    }
    const chunksToRemove = Array.from(chunksToRemoveSet);

    // Remove overlapping chunks from scene and tracking
    for (const chunkKey of chunksToRemove) {
      // Remove LOD0
      const chunked = this.chunkedMeshes.get(chunkKey);
      if (chunked && this.vegetationGroup) {
        this.vegetationGroup.remove(chunked.mesh);
        this.disposePrimaryChunk(chunked);
        this.chunkedMeshes.delete(chunkKey);
      }

      // Remove LOD1
      const lod1Key = `${chunkKey}_lod1`;
      const lod1Chunked = this.lod1ChunkedMeshes.get(lod1Key);
      if (lod1Chunked && this.vegetationGroup) {
        this.vegetationGroup.remove(lod1Chunked.mesh);
        lod1Chunked.mesh.geometry.dispose();
        this.lod1ChunkedMeshes.delete(lod1Key);
      }

      // Remove LOD2
      const lod2Key = `${chunkKey}_lod2`;
      const lod2Chunked = this.lod2ChunkedMeshes.get(lod2Key);
      if (lod2Chunked && this.vegetationGroup) {
        this.vegetationGroup.remove(lod2Chunked.mesh);
        lod2Chunked.mesh.geometry.dispose();
        this.lod2ChunkedMeshes.delete(lod2Key);
      }

      // Remove from quadtree and other tracking
      if (this.chunkQuadtree) {
        this.chunkQuadtree.remove(chunkKey);
      }
      this._lastVisibleChunks.delete(chunkKey);
      this.chunkLODStates.delete(chunkKey);
      this.chunkInstanceData.delete(chunkKey);
      this.chunkTileRefs.delete(chunkKey);
      this.removeChunkFromImposter(chunkKey);
    }

    // Clear tile tracking data
    if (this.tileVegetation.has(key)) {
      this.tileVegetation.delete(key);
    }
    this.tileChunks.delete(key);
    this.pendingTiles.delete(key);

    // Now regenerate vegetation with updated terrain heights
    await this.onTileGenerated({
      tileX: data.tileX,
      tileZ: data.tileZ,
      biome: data.biome,
    });
  }

  /**
   * Get biome vegetation configuration from BIOMES data
   */
  private async getBiomeVegetationConfig(
    biomeId: string,
  ): Promise<BiomeVegetationConfig | null> {
    // Access BIOMES data through the terrain system or data manager
    const terrainSystem = this.world.getSystem("terrain") as {
      getBiomeData?: (id: string) => { vegetation?: BiomeVegetationConfig };
    };

    if (terrainSystem?.getBiomeData) {
      const biomeData = terrainSystem.getBiomeData(biomeId);
      return biomeData?.vegetation ?? null;
    }

    // Fallback: try to get from global BIOMES using dynamic import
    try {
      const worldStructure = await import("../../../data/world-structure");
      const biome = worldStructure.BIOMES[biomeId];
      return biome?.vegetation ?? null;
    } catch (err) {
      // Log error for debugging - this could indicate missing world-structure module
      console.warn(
        `[VegetationSystem] Failed to load biome vegetation config for ${biomeId}:`,
        err,
      );
      return null;
    }
  }

  /**
   * Generate vegetation instances for a terrain tile.
   * Uses web worker for placement computation when available (off main thread).
   */
  private async generateTileVegetation(
    tileX: number,
    tileZ: number,
    config: BiomeVegetationConfig,
  ): Promise<void> {
    const tileKey = `${tileX}_${tileZ}`;
    const tileData = this.tileVegetation.get(tileKey);
    if (!tileData) return;

    const terrainSystemRaw = this.world.getSystem("terrain");
    if (!terrainSystemRaw) {
      console.warn("[VegetationSystem] TerrainSystem not available");
      return;
    }

    // Type assertion through unknown to satisfy TypeScript
    const terrainSystem = terrainSystemRaw as unknown as {
      getHeightAt: (x: number, z: number) => number;
      getNormalAt?: (x: number, z: number) => THREE.Vector3;
      getTileSize: () => number;
      getWaterBodyRegistry?: () => {
        getBodyAt: (x: number, z: number) => { surfaceY: number } | null;
        getWaterSurfaceAt?: (x: number, z: number) => number;
      };
    };

    if (!terrainSystem.getHeightAt) {
      console.warn("[VegetationSystem] TerrainSystem missing getHeightAt");
      return;
    }

    const tileSize = terrainSystem.getTileSize();
    const tileWorldX = tileX * tileSize;
    const tileWorldZ = tileZ * tileSize;

    // Try to use worker for placement computation (off main thread)
    if (isVegetationWorkerAvailable()) {
      await this.generateTileVegetationWithWorker(
        tileKey,
        tileWorldX,
        tileWorldZ,
        tileSize,
        config,
        terrainSystem,
        tileData,
      );
    } else {
      // Fallback to synchronous generation on main thread
      for (const layer of config.layers) {
        await this.generateLayerVegetation(
          tileKey,
          tileWorldX,
          tileWorldZ,
          tileSize,
          layer,
          terrainSystem,
        );
      }
    }

    // Finalize all chunks - update bounding spheres for proper frustum culling
    // Runs in batches to avoid blocking main thread
    await this.finalizeAllChunks();
  }

  /**
   * Generate vegetation using web worker for placement computation.
   * Worker handles: noise filtering, clustering, spacing, asset selection.
   * Main thread handles: terrain validation, instance creation, mesh building.
   */
  private async generateTileVegetationWithWorker(
    tileKey: string,
    tileWorldX: number,
    tileWorldZ: number,
    tileSize: number,
    config: BiomeVegetationConfig,
    terrainSystem: {
      getHeightAt: (x: number, z: number) => number;
      getNormalAt?: (x: number, z: number) => THREE.Vector3;
      getWaterBodyRegistry?: () => {
        getBodyAt: (x: number, z: number) => { surfaceY: number } | null;
        getWaterSurfaceAt?: (x: number, z: number) => number;
      };
    },
    tileData: TileVegetationData,
  ): Promise<void> {
    // Convert layers to worker input format
    const workerLayers: VegetationLayerInput[] = config.layers.map((layer) => {
      const validAssets = layer.assets
        .map((id) => this.assetDefinitions.get(id))
        .filter((a): a is VegetationAsset => a !== undefined);

      return {
        category: layer.category,
        assets: validAssets.map((asset) => ({
          id: asset.id,
          weight: asset.weight,
          scaleMin: asset.baseScale * asset.scaleVariation[0],
          scaleMax: asset.baseScale * asset.scaleVariation[1],
          randomRotation: asset.randomRotation,
          alignToNormal: asset.alignToNormal ?? false,
          yOffset: asset.yOffset ?? 0,
        })),
        density: layer.density,
        minSpacing: layer.minSpacing,
        noiseScale: layer.noiseScale,
        noiseThreshold: layer.noiseThreshold,
        clustering: layer.clustering,
        clusterSize: layer.clusterSize,
        minHeight: layer.minHeight,
        maxHeight: layer.maxHeight,
        maxSlope: layer.avoidSteepSlopes ? 0.6 : undefined,
        avoidWater: layer.avoidWater,
      };
    });

    // Use deterministic seed based on tile key
    const seed = this.hashString(tileKey);

    // Generate placements in worker (off main thread)
    const result = await generateVegetationPlacementsAsync(
      tileKey,
      tileWorldX,
      tileWorldZ,
      tileSize,
      workerLayers,
      seed,
    );

    if (!result) {
      // Worker failed, fall back to synchronous
      for (const layer of config.layers) {
        await this.generateLayerVegetation(
          tileKey,
          tileWorldX,
          tileWorldZ,
          tileSize,
          layer,
          terrainSystem,
        );
      }
      return;
    }

    // PHASE 1: Pre-load all required assets in parallel (async I/O)
    const uniqueAssetIds = new Set(result.placements.map((p) => p.assetId));
    const assetLoadPromises: Promise<void>[] = [];

    for (const assetId of uniqueAssetIds) {
      const asset = this.assetDefinitions.get(assetId);
      if (asset && !this.assetData.has(assetId)) {
        assetLoadPromises.push(
          this.loadAssetData(asset).then(() => {
            // Asset loaded, nothing else to do
          }),
        );
      }
    }

    // Wait for all assets to load in parallel
    if (assetLoadPromises.length > 0) {
      await Promise.all(assetLoadPromises);
    }

    // PHASE 2: Process placements in yielding batches (prevents main thread blocking)
    // Process in chunks of 50 placements, yielding between chunks for smooth gameplay
    const PLACEMENT_BATCH_SIZE = 50;
    const getHeight = terrainSystem.getHeightAt.bind(terrainSystem);
    const waterThreshold = WATER_LEVEL + WATER_EDGE_BUFFER;
    const bodyRegistry = terrainSystem.getWaterBodyRegistry?.();
    let placedCount = 0;
    let index = 0;
    const placements = result.placements;

    // Process placements in batches, yielding between each batch
    while (index < placements.length) {
      const batchEnd = Math.min(
        index + PLACEMENT_BATCH_SIZE,
        placements.length,
      );

      for (; index < batchEnd; index++) {
        const placement = placements[index];

        // Get terrain height at position
        const height = getHeight(placement.x, placement.z);

        // Check water avoidance (ocean)
        if (height < waterThreshold) {
          continue;
        }

        // Check elevated water body avoidance (mountain ponds, highland lakes, rivers)
        if (bodyRegistry) {
          // Unified check: getWaterSurfaceAt covers ponds, rivers, and ocean
          if (bodyRegistry.getWaterSurfaceAt) {
            const waterY = bodyRegistry.getWaterSurfaceAt(
              placement.x,
              placement.z,
            );
            if (height < waterY + WATER_EDGE_BUFFER) {
              continue;
            }
          } else {
            const body = bodyRegistry.getBodyAt(placement.x, placement.z);
            if (body && height < body.surfaceY + WATER_EDGE_BUFFER) {
              continue;
            }
          }
        }

        // Check road avoidance
        if (this.roadNetworkSystem?.isOnRoad(placement.x, placement.z)) {
          continue;
        }

        // Keep duel arena floors clear of decorative vegetation.
        if (isPositionInsideDuelArenaZone(placement.x, placement.z)) {
          continue;
        }

        // Get asset definition for slope constraints
        const asset = this.assetDefinitions.get(placement.assetId);
        if (!asset) {
          continue;
        }

        // Get asset data (guaranteed to be loaded from Phase 1)
        const assetDataRef = this.assetData.get(placement.assetId);
        if (!assetDataRef) {
          continue;
        }

        // Calculate slope only when the selected asset has slope constraints.
        if (asset.minSlope !== undefined || asset.maxSlope !== undefined) {
          const slope = this.estimateSlope(placement.x, placement.z, getHeight);
          if (asset.minSlope !== undefined && slope < asset.minSlope) {
            continue;
          }
          if (asset.maxSlope !== undefined && slope > asset.maxSlope) {
            continue;
          }
        }

        // Calculate rotation from terrain normal if needed
        let rotationX = 0;
        let rotationZ = 0;
        if (asset.alignToNormal && terrainSystem.getNormalAt) {
          const normal = terrainSystem.getNormalAt(placement.x, placement.z);
          this._tempEuler.setFromRotationMatrix(
            this._lookAtMatrix.lookAt(this._origin, normal, this._yAxis),
          );
          rotationX = this._tempEuler.x;
          rotationZ = this._tempEuler.z;
        }

        // Create instance
        const instance: VegetationInstance = {
          id: `${tileKey}_${placement.category}_${placedCount}`,
          assetId: placement.assetId,
          category: placement.category as VegetationCategory,
          position: {
            x: placement.x,
            y: height + (asset.yOffset ?? 0),
            z: placement.z,
          },
          rotation: { x: rotationX, y: placement.rotationY, z: rotationZ },
          scale: placement.scale,
          tileKey,
        };

        // Add instance to tile data
        tileData.instances.set(instance.id, instance);

        // Add to chunked mesh (synchronous - asset already loaded)
        this.addInstanceToChunk(instance, assetDataRef);
        placedCount++;
      }

      // Yield to main thread between batches if more work remains
      // This prevents blocking during gameplay - uses setTimeout(0) to yield
      if (index < placements.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  /**
   * Hash a string to a number for deterministic seeding
   */
  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    return hash >>> 0;
  }

  /**
   * Generate vegetation for a single layer within a tile (fallback for non-worker path)
   * Optimized with parallel asset pre-loading.
   */
  private async generateLayerVegetation(
    tileKey: string,
    tileWorldX: number,
    tileWorldZ: number,
    tileSize: number,
    layer: VegetationLayer,
    terrainSystem: {
      getHeightAt: (x: number, z: number) => number;
      getNormalAt?: (x: number, z: number) => THREE.Vector3;
      getWaterBodyRegistry?: () => {
        getBodyAt: (x: number, z: number) => { surfaceY: number } | null;
        getWaterSurfaceAt?: (x: number, z: number) => number;
      };
    },
  ): Promise<void> {
    const tileData = this.tileVegetation.get(tileKey);
    if (!tileData) return;

    // Compute number of instances to generate based on density
    const targetCount = Math.floor(layer.density * (tileSize / 100) ** 2);

    // Create deterministic RNG for this tile/layer
    const rng = this.createTileLayerRng(tileKey, layer.category);

    // Get valid asset definitions for this layer
    const validAssets = layer.assets
      .map((id) => this.assetDefinitions.get(id))
      .filter((a): a is VegetationAsset => a !== undefined);

    if (validAssets.length === 0) {
      return;
    }

    // PHASE 1: Pre-load all layer assets in parallel
    const assetLoadPromises: Promise<void>[] = [];
    for (const asset of validAssets) {
      if (!this.assetData.has(asset.id)) {
        assetLoadPromises.push(
          this.loadAssetData(asset).then(() => {
            // Asset loaded
          }),
        );
      }
    }
    if (assetLoadPromises.length > 0) {
      await Promise.all(assetLoadPromises);
    }

    // Calculate total weight for weighted random selection
    const totalWeight = validAssets.reduce((sum, a) => sum + a.weight, 0);

    // Generate candidate positions with clustering support
    const positions = this.generatePlacementPositions(
      tileWorldX,
      tileWorldZ,
      tileSize,
      targetCount,
      layer,
      rng,
    );

    // Bind getHeightAt to preserve context (needed for internal state access)
    const getHeight = terrainSystem.getHeightAt.bind(terrainSystem);
    const bodyRegistryLayer = terrainSystem.getWaterBodyRegistry?.();

    // PHASE 2: Place instances in yielding batches (prevents main thread blocking)
    const BATCH_SIZE = 50;
    let placedCount = 0;
    let posIndex = 0;
    const shouldAvoidSteep = !!layer.avoidSteepSlopes;

    while (posIndex < positions.length && placedCount < targetCount) {
      const batchEnd = Math.min(posIndex + BATCH_SIZE, positions.length);

      for (; posIndex < batchEnd && placedCount < targetCount; posIndex++) {
        const pos = positions[posIndex];

        // Get terrain height at position
        const height = getHeight(pos.x, pos.z);

        // Check height constraints
        if (layer.minHeight !== undefined && height < layer.minHeight) continue;
        if (layer.maxHeight !== undefined && height > layer.maxHeight) continue;

        // Check water avoidance - ALWAYS avoid water unless explicitly disabled
        const shouldAvoidWater = layer.avoidWater !== false;
        const waterThresholdLayer = WATER_LEVEL + WATER_EDGE_BUFFER;
        if (shouldAvoidWater && height < waterThresholdLayer) {
          continue;
        }

        // Check elevated water body avoidance (mountain ponds, highland lakes, rivers)
        if (shouldAvoidWater && bodyRegistryLayer) {
          if (bodyRegistryLayer.getWaterSurfaceAt) {
            const waterY = bodyRegistryLayer.getWaterSurfaceAt(pos.x, pos.z);
            if (height < waterY + WATER_EDGE_BUFFER) continue;
          } else {
            const body = bodyRegistryLayer.getBodyAt(pos.x, pos.z);
            if (body && height < body.surfaceY + WATER_EDGE_BUFFER) continue;
          }
        }

        // Check road avoidance - never place vegetation on roads
        if (
          this.roadNetworkSystem &&
          this.roadNetworkSystem.isOnRoad(pos.x, pos.z)
        ) {
          continue;
        }

        if (isPositionInsideDuelArenaZone(pos.x, pos.z)) {
          continue;
        }

        // Calculate slope only when this layer needs steep-slope filtering.
        let slope: number | undefined;
        if (shouldAvoidSteep) {
          slope = this.estimateSlope(pos.x, pos.z, getHeight);
          if (slope > 0.6) continue; // Skip steep slopes
        }

        // Select asset based on weighted random
        const asset = this.selectWeightedAsset(validAssets, totalWeight, rng);
        if (!asset) continue;

        // Get pre-loaded asset data
        const assetDataRef = this.assetData.get(asset.id);
        if (!assetDataRef) continue;

        // Check asset-specific slope constraints
        if (asset.minSlope !== undefined || asset.maxSlope !== undefined) {
          if (slope === undefined) {
            slope = this.estimateSlope(pos.x, pos.z, getHeight);
          }
          if (asset.minSlope !== undefined && slope < asset.minSlope) continue;
          if (asset.maxSlope !== undefined && slope > asset.maxSlope) continue;
        }

        // Calculate instance transform
        const scale =
          asset.baseScale *
          (asset.scaleVariation[0] +
            rng() * (asset.scaleVariation[1] - asset.scaleVariation[0]));

        const rotationY = asset.randomRotation ? rng() * Math.PI * 2 : 0;
        let rotationX = 0;
        let rotationZ = 0;

        // Align to terrain normal if requested
        if (asset.alignToNormal && terrainSystem.getNormalAt) {
          const normal = terrainSystem.getNormalAt(pos.x, pos.z);
          this._tempEuler.setFromRotationMatrix(
            this._lookAtMatrix.lookAt(this._origin, normal, this._yAxis),
          );
          rotationX = this._tempEuler.x;
          rotationZ = this._tempEuler.z;
        }

        // Create instance
        const instance: VegetationInstance = {
          id: `${tileKey}_${layer.category}_${placedCount}`,
          assetId: asset.id,
          category: layer.category,
          position: {
            x: pos.x,
            y: height + (asset.yOffset ?? 0),
            z: pos.z,
          },
          rotation: { x: rotationX, y: rotationY, z: rotationZ },
          scale,
          tileKey,
        };

        // Add instance to tile data
        tileData.instances.set(instance.id, instance);

        // Add to chunked mesh (synchronous - asset already loaded)
        this.addInstanceToChunk(instance, assetDataRef);

        placedCount++;
      }

      // Yield to main thread between batches if more work remains
      if (posIndex < positions.length && placedCount < targetCount) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  /**
   * Generate placement positions with optional clustering
   */
  private generatePlacementPositions(
    tileWorldX: number,
    tileWorldZ: number,
    tileSize: number,
    targetCount: number,
    layer: VegetationLayer,
    rng: () => number,
  ): Array<{ x: number; z: number }> {
    const positions: Array<{ x: number; z: number }> = [];
    const noiseScale = layer.noiseScale ?? 0.05;
    const noiseThreshold = layer.noiseThreshold ?? 0.3;
    const minSpacing = layer.minSpacing;
    const minSpacingSq = minSpacing * minSpacing;
    const cellSize = Math.max(minSpacing, 0.0001);
    const useSpacingGrid = minSpacing > 0;
    const spacingGrid = new Map<string, Array<{ x: number; z: number }>>();
    const tileMaxX = tileWorldX + tileSize;
    const tileMaxZ = tileWorldZ + tileSize;

    const getCellCoords = (x: number, z: number): [number, number] => [
      Math.floor((x - tileWorldX) / cellSize),
      Math.floor((z - tileWorldZ) / cellSize),
    ];
    const getCellKey = (cx: number, cz: number): string => `${cx},${cz}`;

    const canPlaceWithSpacing = (x: number, z: number): boolean => {
      if (!useSpacingGrid) return true;
      const [cellX, cellZ] = getCellCoords(x, z);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = spacingGrid.get(getCellKey(cellX + dx, cellZ + dz));
          if (!bucket) continue;
          for (const existing of bucket) {
            const ddx = existing.x - x;
            const ddz = existing.z - z;
            if (ddx * ddx + ddz * ddz < minSpacingSq) {
              return false;
            }
          }
        }
      }
      return true;
    };

    const registerPosition = (x: number, z: number): void => {
      positions.push({ x, z });
      if (!useSpacingGrid) return;
      const [cellX, cellZ] = getCellCoords(x, z);
      const key = getCellKey(cellX, cellZ);
      const bucket = spacingGrid.get(key);
      if (bucket) {
        bucket.push({ x, z });
      } else {
        spacingGrid.set(key, [{ x, z }]);
      }
    };

    // Precompute deterministic cluster centers once per tile/layer.
    let clusterCenters: Array<{ x: number; z: number }> | null = null;
    if (layer.clustering && layer.clusterSize) {
      const clusterCount = Math.max(
        1,
        Math.floor(targetCount / layer.clusterSize),
      );
      clusterCenters = new Array(clusterCount);
      for (let i = 0; i < clusterCount; i++) {
        const clusterRng = this.createTileLayerRng(
          `${tileWorldX}_${tileWorldZ}_cluster_${i}`,
          layer.category,
        );
        clusterCenters[i] = {
          x: tileWorldX + tileSize * 0.1 + clusterRng() * tileSize * 0.8,
          z: tileWorldZ + tileSize * 0.1 + clusterRng() * tileSize * 0.8,
        };
      }
    }

    // Generate more candidates than needed, then filter
    const candidateMultiplier = 3;
    const maxCandidates = targetCount * candidateMultiplier;

    for (let i = 0; i < maxCandidates && positions.length < targetCount; i++) {
      let x: number;
      let z: number;

      if (clusterCenters && layer.clusterSize) {
        const clusterCenter =
          clusterCenters[Math.floor(rng() * clusterCenters.length)];
        // Scatter around cluster center with Gaussian-like distribution
        const angle = rng() * Math.PI * 2;
        const radius = rng() * rng() * minSpacing * layer.clusterSize;
        x = clusterCenter.x + Math.cos(angle) * radius;
        z = clusterCenter.z + Math.sin(angle) * radius;
      } else {
        // Uniform random distribution
        x = tileWorldX + rng() * tileSize;
        z = tileWorldZ + rng() * tileSize;
      }

      // Ensure within tile bounds
      if (x < tileWorldX || x >= tileMaxX || z < tileWorldZ || z >= tileMaxZ) {
        continue;
      }

      // Noise-based filtering
      if (this.noise) {
        const noiseValue =
          (this.noise.perlin2D(x * noiseScale, z * noiseScale) + 1) / 2;
        if (noiseValue < noiseThreshold) continue;
      }

      if (!canPlaceWithSpacing(x, z)) continue;
      registerPosition(x, z);
    }

    return positions;
  }

  /**
   * Estimate terrain slope at a position
   */
  /**
   * Estimate terrain slope at a position using central differences.
   * Returns the magnitude of the gradient vector (rise/run).
   */
  private estimateSlope(
    x: number,
    z: number,
    getHeight: (x: number, z: number) => number,
  ): number {
    const delta = 1.0;
    const hN = getHeight(x, z - delta);
    const hS = getHeight(x, z + delta);
    const hE = getHeight(x + delta, z);
    const hW = getHeight(x - delta, z);

    const dhdx = (hE - hW) / (2 * delta);
    const dhdz = (hS - hN) / (2 * delta);

    return Math.sqrt(dhdx * dhdx + dhdz * dhdz);
  }

  /**
   * Setup a vegetation material for proper lighting
   * Converts to MeshStandardMaterial and configures for CSM shadows
   * OPTIMIZATION: Prefers vertex colors over textures when available
   */
  private setupVegetationMaterial(
    material: THREE.Material,
    _asset: VegetationAsset,
  ): THREE.Material {
    // Extract properties from any material type
    const matAny = material as THREE.MeshStandardMaterial;
    const hasVertexColors = matAny.vertexColors || false;

    // OPTIMIZATION: Only use textures if vertex colors are not available
    // Vertex colors are faster (no texture sampling) and use less GPU memory
    // NOTE: Use undefined instead of null for optional textures
    // Setting null causes WebGPU texture cache corruption (WeakMap key error)
    const map = hasVertexColors ? undefined : matAny.map || undefined;
    const color = matAny.color || new THREE.Color(0xffffff);
    const alphaMap = hasVertexColors ? undefined : matAny.alphaMap || undefined;

    // Create fresh MeshStandardNodeMaterial for WebGPU-native TSL dissolve support
    const stdMat = new MeshStandardNodeMaterial({
      color: color,
      map: map,
      alphaMap: alphaMap,
      vertexColors: hasVertexColors,
      // Alpha handling - use alphaTest for hard edges (faster than blending)
      transparent: false,
      alphaTest: hasVertexColors ? 0.1 : 0.5, // Lower alpha test for vertex color models
      // Double-sided for foliage
      side: THREE.DoubleSide,
      // Matte surface - no specular, no reflections
      roughness: 1.0,
      metalness: 0.0,
      // NOTE: Don't set envMap to null - it causes WebGPU texture cache corruption
      // Setting envMapIntensity to 0 is sufficient to disable the environment map effect
      envMapIntensity: 0,
      // Enable fog
      fog: true,
    });

    // Ensure texture colorspace is correct (only if using texture)
    if (stdMat.map) {
      stdMat.map.colorSpace = THREE.SRGBColorSpace;
    }

    // Setup for CSM shadows (realtime lighting)
    if (this.world.setupMaterial) {
      this.world.setupMaterial(stdMat);
    }

    stdMat.needsUpdate = true;
    return stdMat;
  }

  /**
   * Select a vegetation asset based on weighted probability
   */
  private selectWeightedAsset(
    assets: VegetationAsset[],
    totalWeight: number,
    rng: () => number,
  ): VegetationAsset | null {
    let random = rng() * totalWeight;
    for (const asset of assets) {
      random -= asset.weight;
      if (random <= 0) {
        return asset;
      }
    }
    return assets[assets.length - 1] ?? null;
  }

  /**
   * Create a deterministic RNG for a tile and layer
   */
  private createTileLayerRng(tileKey: string, category: string): () => number {
    // Hash the tile key and category into a seed
    let hash = 5381;
    const str = `${tileKey}_${category}`;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }

    let state = (hash >>> 0) ^ this.computeSeedFromWorldId();

    return () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 0xffffffff;
    };
  }

  // ============================================================================
  // CHUNKED VEGETATION SYSTEM
  // ============================================================================

  /**
   * Get chunk coordinates from world position
   */
  private getChunkCoords(
    x: number,
    z: number,
  ): { chunkX: number; chunkZ: number } {
    return {
      chunkX: Math.floor(x / VEGETATION_CHUNK_SIZE),
      chunkZ: Math.floor(z / VEGETATION_CHUNK_SIZE),
    };
  }

  /**
   * Get chunk key from world position and asset ID
   */
  private getChunkKey(x: number, z: number, assetId: string): string {
    const { chunkX, chunkZ } = this.getChunkCoords(x, z);
    return `${chunkX}_${chunkZ}_${assetId}`;
  }

  /**
   * Track the relationship between a tile and a chunk.
   * A chunk can be referenced by multiple tiles (at tile boundaries).
   * Uses reference counting to know when a chunk can be safely removed.
   */
  private trackTileChunkRelationship(tileKey: string, chunkKey: string): void {
    // Get or create the set of chunks for this tile
    let chunks = this.tileChunks.get(tileKey);
    if (!chunks) {
      chunks = new Set<string>();
      this.tileChunks.set(tileKey, chunks);
    }

    // Only increment ref count if this is a new relationship
    if (!chunks.has(chunkKey)) {
      chunks.add(chunkKey);
      const refCount = this.chunkTileRefs.get(chunkKey) ?? 0;
      this.chunkTileRefs.set(chunkKey, refCount + 1);
    }
  }

  /**
   * Remove tile-chunk tracking when a tile unloads.
   * Decrements ref counts and disposes orphaned chunks.
   */
  private removeTileChunkRelationships(tileKey: string): void {
    const chunks = this.tileChunks.get(tileKey);
    if (!chunks) return;

    for (const chunkKey of chunks) {
      const refCount = this.chunkTileRefs.get(chunkKey) ?? 0;
      const newRefCount = refCount - 1;

      if (newRefCount <= 0) {
        // No more tiles reference this chunk - fully dispose it
        this.chunkTileRefs.delete(chunkKey);

        // Remove from quadtree
        if (this.chunkQuadtree) {
          this.chunkQuadtree.remove(chunkKey);
        }

        // Remove from visible chunks tracking
        this._lastVisibleChunks.delete(chunkKey);

        // Remove imposters for this chunk BEFORE disposing mesh data
        this.removeChunkFromImposter(chunkKey);

        // Dispose LOD0 mesh
        const chunked = this.chunkedMeshes.get(chunkKey);
        if (chunked) {
          if (this.vegetationGroup) {
            this.vegetationGroup.remove(chunked.mesh);
          }
          this.disposePrimaryChunk(chunked);
          // Material is shared, don't dispose
          this.chunkedMeshes.delete(chunkKey);
        }

        // Dispose LOD1 mesh
        const lod1Key = `${chunkKey}_lod1`;
        const lod1Chunked = this.lod1ChunkedMeshes.get(lod1Key);
        if (lod1Chunked) {
          if (this.vegetationGroup) {
            this.vegetationGroup.remove(lod1Chunked.mesh);
          }
          lod1Chunked.mesh.geometry.dispose();
          this.lod1ChunkedMeshes.delete(lod1Key);
        }

        // Dispose LOD2 mesh
        const lod2Key = `${chunkKey}_lod2`;
        const lod2Chunked = this.lod2ChunkedMeshes.get(lod2Key);
        if (lod2Chunked) {
          if (this.vegetationGroup) {
            this.vegetationGroup.remove(lod2Chunked.mesh);
          }
          lod2Chunked.mesh.geometry.dispose();
          this.lod2ChunkedMeshes.delete(lod2Key);
        }

        // Remove LOD state tracking
        this.chunkLODStates.delete(chunkKey);

        // Remove instance data
        this.chunkInstanceData.delete(chunkKey);
      } else {
        this.chunkTileRefs.set(chunkKey, newRefCount);
      }
    }

    this.tileChunks.delete(tileKey);
  }

  /**
   * Get or create a chunked mesh for a position and asset
   */
  private getOrCreateChunkedMesh(
    x: number,
    z: number,
    assetId: string,
    assetDataRef: AssetData,
  ): ChunkedInstancedMesh | null {
    const chunkKey = this.getChunkKey(x, z, assetId);

    // Return existing chunk mesh
    let chunked = this.chunkedMeshes.get(chunkKey);
    if (chunked) return chunked;

    // Create new chunk mesh
    const geometry = assetDataRef.geometry.clone();

    // Create instance attributes
    const positionAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_CHUNK * 3),
      3,
    );
    const scaleAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_CHUNK),
      1,
    );
    const rotationAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_CHUNK),
      1,
    );

    positionAttr.setUsage(THREE.DynamicDrawUsage);
    scaleAttr.setUsage(THREE.DynamicDrawUsage);
    rotationAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute("instancePosition", positionAttr);
    geometry.setAttribute("instanceScale", scaleAttr);
    geometry.setAttribute("instanceRotationY", rotationAttr);

    // Create instanced mesh with shared material
    const mesh = new THREE.InstancedMesh(
      geometry,
      assetDataRef.gpuMaterial,
      MAX_INSTANCES_PER_CHUNK,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    // DISABLE Three.js frustum culling - we do manual frustum culling in updateChunkVisibility()
    // which sets mesh.visible = false. Manual culling is more efficient because:
    // 1. We batch all checks in one loop before render
    // 2. Setting visible=false skips the entire render pipeline for that mesh
    // 3. Avoids redundant frustum checks (we'd be checking twice otherwise)
    mesh.frustumCulled = false;
    // Vegetation casts shadows but does NOT receive them
    // Receiving shadows on thin/double-sided geometry (leaves) causes severe banding artifacts
    // The visual difference is minimal - trees look fine without self-shadowing
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.name = `VegChunk_${chunkKey}`;
    mesh.layers.set(1);
    // Start hidden - visibility is set by updateChunkVisibility() after frustum check
    // This prevents chunks from "popping in" for 1+ frames before culling runs
    mesh.visible = false;

    // Add to scene
    if (this.vegetationGroup) {
      this.vegetationGroup.add(mesh);
    }

    // Track chunk bounds
    const { chunkX: _chunkX, chunkZ: _chunkZ } = this.getChunkCoords(x, z);

    chunked = {
      mesh,
      count: 0,
      positionAttr,
      scaleAttr,
      rotationAttr,
      // Track ACTUAL instance bounds (not chunk bounds)
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity,
    };

    this.chunkedMeshes.set(chunkKey, chunked);
    if (assetDataRef.asset.screenSpaceLod) {
      const state: ScreenSpaceChunk = {
        asset: assetDataRef,
        heroGeometry: geometry,
        lodGeometry: null,
        level: 0,
        errorPixels: Infinity,
        extentPixels: Infinity,
        shadowErrorPixels: Infinity,
      };
      this.screenSpaceChunks.set(chunked, state);
      this.installScreenSpaceChunkLod(chunked, state);
    }
    return chunked;
  }

  /** Allocate once while a chunk/asset loads. Both geometries borrow the same
   * instance attributes; no second mesh, matrix upload or material is created.
   */
  private installScreenSpaceChunkLod(
    chunk: ChunkedInstancedMesh,
    state: ScreenSpaceChunk,
  ): void {
    if (state.lodGeometry || !state.asset.lod1Geometry || this.isDestroyed)
      return;
    const geometry = state.asset.lod1Geometry.clone();
    geometry.setAttribute("instancePosition", chunk.positionAttr);
    geometry.setAttribute("instanceScale", chunk.scaleAttr);
    geometry.setAttribute("instanceRotationY", chunk.rotationAttr);
    state.lodGeometry = geometry;
  }

  private disposePrimaryChunk(chunk: ChunkedInstancedMesh): void {
    if (this.disposedPrimaryChunks.has(chunk)) return;
    this.disposedPrimaryChunks.add(chunk);
    const state = this.screenSpaceChunks.get(chunk);
    this.screenSpaceChunks.delete(chunk);
    if (state) {
      state.heroGeometry.dispose();
      state.lodGeometry?.dispose();
    } else chunk.mesh.geometry.dispose();
    chunk.mesh.dispose();
  }

  /** Select after the final camera owner, before render/shadow lists are built.
   * Every actual instance must qualify; a nearby member keeps the whole batch
   * at hero detail. Reflections/custom shadows retain hero until separately
   * qualified. These decisions never change populations, fade or shadow flags.
   */
  prepareForRender(
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
  ): void {
    if (this.isDestroyed) return;
    camera.updateWorldMatrix(true, false);
    // Late camera owners may change the pose after update(). Reconcile only
    // that changed view; ordinary frames retain their existing culling pass.
    // This also applies to assets without a screen-space LOD descriptor.
    if (!this.matchesCulledView(camera)) {
      const position = camera.getWorldPosition(this._tempPosition);
      this.updateGPUUniforms(position.x, position.y, position.z);
      this.updateChunkVisibility(position.x, position.z, camera);
    }
    this.selectScreenSpaceLodForRender(camera, width, height);
  }

  private matchesCulledView(camera: THREE.PerspectiveCamera): boolean {
    return (
      !this._frustumDirty &&
      camera.matrixWorld.equals(this._culledCameraWorld) &&
      camera.projectionMatrix.equals(this._culledCameraProjection) &&
      camera.coordinateSystem === this._culledCoordinateSystem &&
      camera.reversedDepth === this._culledReversedDepth
    );
  }

  private selectScreenSpaceLodForRender(
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
  ): void {
    if (this.isDestroyed || !this.screenSpaceChunks.size) return;
    const terrain = this.world.getSystem<TerrainSystem>("terrain");
    const environment = this.world.getSystem<Environment>("environment");
    const sun = environment?.sunLight ?? null;
    this.lodSunLight = sun;
    this.hasUnknownLodShadowLight = false;
    this.world.stage.scene.traverseVisible(this.checkLodShadowLight);
    let knownViews =
      terrain?.areWaterReflectionsEnabled() === false &&
      !!sun &&
      !this.hasUnknownLodShadowLight &&
      !this.world.graphics?.renderer.xr?.isPresenting;
    let shadowCamera: THREE.OrthographicCamera | null = null;
    if (knownViews && sun?.castShadow) {
      if (
        sun.shadow.shadowNode !== undefined ||
        !sun.shadow.autoUpdate ||
        !(sun.shadow.camera instanceof THREE.OrthographicCamera) ||
        !sun.shadow.map
      )
        knownViews = false;
      else {
        sun.updateWorldMatrix(true, false);
        sun.target.updateWorldMatrix(true, false);
        sun.shadow.updateMatrices(sun);
        shadowCamera = sun.shadow.camera;
      }
    }
    camera.updateWorldMatrix(true, false);
    for (const [chunk, state] of this.screenSpaceChunks) {
      const lod = state.asset.asset.screenSpaceLod!;
      const bounds = state.asset.geometry.boundingBox;
      let error = 0,
        extent = 0,
        shadowError = 0;
      const material = state.asset.gpuMaterial;
      if (
        !knownViews ||
        !state.lodGeometry ||
        !bounds ||
        !chunk.count ||
        chunk.mesh.material !== material ||
        !(material instanceof MeshStandardNodeMaterial) ||
        material.positionNode ||
        material.vertexNode ||
        material.displacementMap ||
        material.castShadowPositionNode ||
        material.depthNode
      ) {
        error = extent = shadowError = Infinity;
      } else if (chunk.mesh.visible) {
        chunk.mesh.updateWorldMatrix(true, false);
        for (let i = 0; i < chunk.count; i++) {
          chunk.mesh.getMatrixAt(i, this.lodInstanceMatrix);
          this.lodModelMatrix.multiplyMatrices(
            chunk.mesh.matrixWorld,
            this.lodInstanceMatrix,
          );
          const projected = this.projectedGeometryError.measure(
            camera,
            this.lodModelMatrix,
            bounds,
            lod.maxSurfaceError,
            width,
            height,
          );
          error = Math.max(error, projected.errorPixels);
          extent = Math.max(extent, projected.extentPixels);
          if (shadowCamera && sun) {
            const projectedShadow = this.projectedGeometryError.measure(
              shadowCamera,
              this.lodModelMatrix,
              bounds,
              lod.maxSurfaceError,
              Math.max(sun.shadow.map!.width, sun.shadow.mapSize.width),
              Math.max(sun.shadow.map!.height, sun.shadow.mapSize.height),
            );
            shadowError = Math.max(shadowError, projectedShadow.errorPixels);
          }
        }
      } else continue;
      state.errorPixels = error;
      state.extentPixels = extent;
      state.shadowErrorPixels = shadowError;
      const combinedError = Math.max(error, shadowError);
      const level =
        state.level === 0
          ? combinedError < lod.enterErrorPixels &&
            extent < lod.enterExtentPixels
            ? 1
            : 0
          : combinedError > lod.exitErrorPixels || extent > lod.exitExtentPixels
            ? 0
            : 1;
      state.level = level;
      // The original culling owner uses a WORLD-space aggregate sphere. Keep
      // that same bound on either geometry; the source-local box above differs.
      if (state.lodGeometry)
        state.lodGeometry.boundingSphere = state.heroGeometry.boundingSphere;
      chunk.mesh.geometry =
        level === 1 && state.lodGeometry
          ? state.lodGeometry
          : state.heroGeometry;
    }
  }

  /**
   * Get or create a LOD1 (low poly) chunked mesh for a position and asset.
   * Only creates if the asset has a LOD1 model available.
   */
  private getOrCreateLOD1ChunkedMesh(
    x: number,
    z: number,
    assetId: string,
    assetDataRef: AssetData,
  ): ChunkedInstancedMesh | null {
    if (!assetDataRef.hasLOD1 || !assetDataRef.lod1Geometry) return null;

    const chunkKey = this.getChunkKey(x, z, assetId);
    const lod1Key = `${chunkKey}_lod1`;

    // Return existing chunk mesh
    let chunked = this.lod1ChunkedMeshes.get(lod1Key);
    if (chunked) return chunked;

    // Create new LOD1 chunk mesh
    const geometry = assetDataRef.lod1Geometry.clone();

    // Create instance attributes
    const positionAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_CHUNK * 3),
      3,
    );
    const scaleAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_CHUNK),
      1,
    );
    const rotationAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_CHUNK),
      1,
    );

    positionAttr.setUsage(THREE.DynamicDrawUsage);
    scaleAttr.setUsage(THREE.DynamicDrawUsage);
    rotationAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute("instancePosition", positionAttr);
    geometry.setAttribute("instanceScale", scaleAttr);
    geometry.setAttribute("instanceRotationY", rotationAttr);

    // Create instanced mesh with shared material
    const mesh = new THREE.InstancedMesh(
      geometry,
      assetDataRef.gpuMaterial,
      MAX_INSTANCES_PER_CHUNK,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.name = `VegChunkLOD1_${chunkKey}`;
    mesh.layers.set(1);
    // Start hidden - LOD0 shows first
    mesh.visible = false;

    // Add to scene
    if (this.vegetationGroup) {
      this.vegetationGroup.add(mesh);
    }

    chunked = {
      mesh,
      count: 0,
      positionAttr,
      scaleAttr,
      rotationAttr,
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity,
    };

    this.lod1ChunkedMeshes.set(lod1Key, chunked);
    return chunked;
  }

  /**
   * Get or create a LOD2 (very low poly ~3%) chunked mesh for a position and asset.
   * Only creates if the asset has a LOD2 model available.
   */
  private getOrCreateLOD2ChunkedMesh(
    x: number,
    z: number,
    assetId: string,
    assetDataRef: AssetData,
  ): ChunkedInstancedMesh | null {
    if (!assetDataRef.hasLOD2 || !assetDataRef.lod2Geometry) return null;

    const chunkKey = this.getChunkKey(x, z, assetId);
    const lod2Key = `${chunkKey}_lod2`;

    // Return existing chunk mesh
    let chunked = this.lod2ChunkedMeshes.get(lod2Key);
    if (chunked) return chunked;

    // Create new LOD2 chunk mesh
    const geometry = assetDataRef.lod2Geometry.clone();

    // Create instance attributes
    const positionAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_CHUNK * 3),
      3,
    );
    const scaleAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_CHUNK),
      1,
    );
    const rotationAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES_PER_CHUNK),
      1,
    );

    positionAttr.setUsage(THREE.DynamicDrawUsage);
    scaleAttr.setUsage(THREE.DynamicDrawUsage);
    rotationAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute("instancePosition", positionAttr);
    geometry.setAttribute("instanceScale", scaleAttr);
    geometry.setAttribute("instanceRotationY", rotationAttr);

    // Create instanced mesh with shared material
    const mesh = new THREE.InstancedMesh(
      geometry,
      assetDataRef.gpuMaterial,
      MAX_INSTANCES_PER_CHUNK,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false; // LOD2 doesn't cast shadows (too far)
    mesh.receiveShadow = false;
    mesh.name = `VegChunkLOD2_${chunkKey}`;
    mesh.layers.set(1);
    // Start hidden - LOD0/LOD1 shows first
    mesh.visible = false;

    // Add to scene
    if (this.vegetationGroup) {
      this.vegetationGroup.add(mesh);
    }

    chunked = {
      mesh,
      count: 0,
      positionAttr,
      scaleAttr,
      rotationAttr,
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity,
    };

    this.lod2ChunkedMeshes.set(lod2Key, chunked);
    return chunked;
  }

  /**
   * Add instance to chunked mesh (LOD0, LOD1, and LOD2 if available)
   */
  private addInstanceToChunk(
    instance: VegetationInstance,
    assetDataRef: AssetData,
  ): boolean {
    const { x, z } = instance.position;
    if (isPositionInsideDuelArenaZone(x, z)) return false;

    const worldY =
      instance.position.y + assetDataRef.modelBaseOffset * instance.scale;

    // Skip instances with invalid height (terrain data not ready yet)
    if (!Number.isFinite(worldY)) {
      return false;
    }

    // Water check — ocean level
    const waterCutoff = WATER_LEVEL + WATER_EDGE_BUFFER;
    if (worldY < waterCutoff) return false;

    // Elevated water body check (mountain ponds, highland lakes, rivers)
    if (this._waterBodyRegistry) {
      if (this._waterBodyRegistry.getWaterSurfaceAt) {
        const waterY = this._waterBodyRegistry.getWaterSurfaceAt(x, z);
        if (instance.position.y < waterY + WATER_EDGE_BUFFER) return false;
      } else {
        const body = this._waterBodyRegistry.getBodyAt(x, z);
        if (body && instance.position.y < body.surfaceY + WATER_EDGE_BUFFER)
          return false;
      }
    }

    // Get or create chunk mesh (LOD0 - full detail)
    const chunked = this.getOrCreateChunkedMesh(
      x,
      z,
      instance.assetId,
      assetDataRef,
    );
    if (!chunked || chunked.count >= MAX_INSTANCES_PER_CHUNK) return false;

    // Track tile-chunk relationship for proper cleanup on tile unload
    const chunkKey = this.getChunkKey(x, z, instance.assetId);
    const tileKey = instance.tileKey;
    this.trackTileChunkRelationship(tileKey, chunkKey);

    const idx = chunked.count;
    const i3 = idx * 3;

    // Write instance attributes to LOD0
    chunked.positionAttr.array[i3] = x;
    chunked.positionAttr.array[i3 + 1] = worldY;
    chunked.positionAttr.array[i3 + 2] = z;
    chunked.scaleAttr.array[idx] = instance.scale;
    chunked.rotationAttr.array[idx] = instance.rotation.y;

    // Update bounds for bounding sphere (track ALL axes)
    chunked.minX = Math.min(chunked.minX, x);
    chunked.maxX = Math.max(chunked.maxX, x);
    chunked.minY = Math.min(chunked.minY, worldY);
    chunked.maxY = Math.max(chunked.maxY, worldY);
    chunked.minZ = Math.min(chunked.minZ, z);
    chunked.maxZ = Math.max(chunked.maxZ, z);

    // Write instance matrix to LOD0
    this._tempPosition.set(x, worldY, z);
    this._tempEuler.set(0, instance.rotation.y, 0);
    this._tempQuaternion.setFromEuler(this._tempEuler);
    this._tempScale.setScalar(instance.scale);
    this._tempMatrix.compose(
      this._tempPosition,
      this._tempQuaternion,
      this._tempScale,
    );
    chunked.mesh.setMatrixAt(idx, this._tempMatrix);

    chunked.count++;

    // Also add to LOD1 mesh if available
    const lod1Chunked = this.getOrCreateLOD1ChunkedMesh(
      x,
      z,
      instance.assetId,
      assetDataRef,
    );
    if (lod1Chunked && lod1Chunked.count < MAX_INSTANCES_PER_CHUNK) {
      const lod1Idx = lod1Chunked.count;
      const lod1I3 = lod1Idx * 3;

      // LOD1 may have different base offset
      const lod1WorldY =
        instance.position.y + assetDataRef.lod1ModelBaseOffset * instance.scale;

      // Write instance attributes to LOD1
      lod1Chunked.positionAttr.array[lod1I3] = x;
      lod1Chunked.positionAttr.array[lod1I3 + 1] = lod1WorldY;
      lod1Chunked.positionAttr.array[lod1I3 + 2] = z;
      lod1Chunked.scaleAttr.array[lod1Idx] = instance.scale;
      lod1Chunked.rotationAttr.array[lod1Idx] = instance.rotation.y;

      // Update bounds for LOD1
      lod1Chunked.minX = Math.min(lod1Chunked.minX, x);
      lod1Chunked.maxX = Math.max(lod1Chunked.maxX, x);
      lod1Chunked.minY = Math.min(lod1Chunked.minY, lod1WorldY);
      lod1Chunked.maxY = Math.max(lod1Chunked.maxY, lod1WorldY);
      lod1Chunked.minZ = Math.min(lod1Chunked.minZ, z);
      lod1Chunked.maxZ = Math.max(lod1Chunked.maxZ, z);

      // Write instance matrix to LOD1
      this._tempPosition.set(x, lod1WorldY, z);
      this._tempMatrix.compose(
        this._tempPosition,
        this._tempQuaternion,
        this._tempScale,
      );
      lod1Chunked.mesh.setMatrixAt(lod1Idx, this._tempMatrix);

      lod1Chunked.count++;
    }

    // Also add to LOD2 mesh if available
    const lod2Chunked = this.getOrCreateLOD2ChunkedMesh(
      x,
      z,
      instance.assetId,
      assetDataRef,
    );
    if (lod2Chunked && lod2Chunked.count < MAX_INSTANCES_PER_CHUNK) {
      const lod2Idx = lod2Chunked.count;
      const lod2I3 = lod2Idx * 3;

      // LOD2 may have different base offset
      const lod2WorldY =
        instance.position.y + assetDataRef.lod2ModelBaseOffset * instance.scale;

      // Write instance attributes to LOD2
      lod2Chunked.positionAttr.array[lod2I3] = x;
      lod2Chunked.positionAttr.array[lod2I3 + 1] = lod2WorldY;
      lod2Chunked.positionAttr.array[lod2I3 + 2] = z;
      lod2Chunked.scaleAttr.array[lod2Idx] = instance.scale;
      lod2Chunked.rotationAttr.array[lod2Idx] = instance.rotation.y;

      // Update bounds for LOD2
      lod2Chunked.minX = Math.min(lod2Chunked.minX, x);
      lod2Chunked.maxX = Math.max(lod2Chunked.maxX, x);
      lod2Chunked.minY = Math.min(lod2Chunked.minY, lod2WorldY);
      lod2Chunked.maxY = Math.max(lod2Chunked.maxY, lod2WorldY);
      lod2Chunked.minZ = Math.min(lod2Chunked.minZ, z);
      lod2Chunked.maxZ = Math.max(lod2Chunked.maxZ, z);

      // Write instance matrix to LOD2
      this._tempPosition.set(x, lod2WorldY, z);
      this._tempMatrix.compose(
        this._tempPosition,
        this._tempQuaternion,
        this._tempScale,
      );
      lod2Chunked.mesh.setMatrixAt(lod2Idx, this._tempMatrix);

      lod2Chunked.count++;
    }

    // Store instance data for imposter system (allows rebuilding imposters per-chunk)
    // Note: chunkKey was already defined above for tile-chunk relationship tracking
    let instanceList = this.chunkInstanceData.get(chunkKey);
    if (!instanceList) {
      instanceList = [];
      this.chunkInstanceData.set(chunkKey, instanceList);
    }
    instanceList.push({
      x,
      y: worldY,
      z,
      scale: instance.scale,
      rotationY: instance.rotation.y,
    });

    return true;
  }

  /**
   * Finalize chunk - update bounding sphere and GPU buffers
   *
   * IMPORTANT: The bounding sphere is stored in geometry.boundingSphere but with
   * WORLD coordinates (not local). This works because chunk meshes are always at
   * the origin with identity transforms. The frustum test in updateChunkVisibility()
   * passes this sphere directly to Frustum.intersectsSphere() which expects world space.
   */
  private finalizeChunk(chunkKey: string): void {
    const chunked = this.chunkedMeshes.get(chunkKey);
    if (!chunked || chunked.count === 0) return;
    // A streamed/repopulated owner must enter the final view even if no camera
    // movement or world update occurs before the next render (for example resize).
    this._frustumDirty = true;

    // Update mesh count
    chunked.mesh.count = chunked.count;
    // Mark attributes for upload
    chunked.positionAttr.needsUpdate = true;
    chunked.scaleAttr.needsUpdate = true;
    chunked.rotationAttr.needsUpdate = true;
    chunked.mesh.instanceMatrix.needsUpdate = true;

    // Also finalize LOD1 chunk if it exists
    const lod1Key = `${chunkKey}_lod1`;
    const lod1Chunked = this.lod1ChunkedMeshes.get(lod1Key);
    if (lod1Chunked && lod1Chunked.count > 0) {
      lod1Chunked.mesh.count = lod1Chunked.count;
      lod1Chunked.positionAttr.needsUpdate = true;
      lod1Chunked.scaleAttr.needsUpdate = true;
      lod1Chunked.rotationAttr.needsUpdate = true;
      lod1Chunked.mesh.instanceMatrix.needsUpdate = true;
    }

    // Also finalize LOD2 chunk if it exists
    const lod2Key = `${chunkKey}_lod2`;
    const lod2Chunked = this.lod2ChunkedMeshes.get(lod2Key);
    if (lod2Chunked && lod2Chunked.count > 0) {
      lod2Chunked.mesh.count = lod2Chunked.count;
      lod2Chunked.positionAttr.needsUpdate = true;
      lod2Chunked.scaleAttr.needsUpdate = true;
      lod2Chunked.rotationAttr.needsUpdate = true;
      lod2Chunked.mesh.instanceMatrix.needsUpdate = true;
    }

    // Compute bounding sphere for frustum culling (in WORLD space)
    // Note: We store world coords in geometry.boundingSphere which is normally local space.
    // This works because chunk meshes have identity transforms (position=0, no rotation/scale).
    const geometry = chunked.mesh.geometry;
    const centerX = (chunked.minX + chunked.maxX) / 2;
    const centerY =
      Number.isFinite(chunked.minY) && Number.isFinite(chunked.maxY)
        ? (chunked.minY + chunked.maxY) / 2
        : 0;
    const centerZ = (chunked.minZ + chunked.maxZ) / 2;

    // Radius calculation:
    // - Half diagonal of instance positions (where bases are placed)
    // - Plus BOUNDING_SPHERE_BUFFER for model heights and scale variations
    // The buffer accounts for: tree height (~15-20m), scale variations (0.8-1.5x),
    // and ensures the sphere fully contains all visible geometry
    const dx = chunked.maxX - chunked.minX;
    const dy = chunked.maxY - chunked.minY;
    const dz = chunked.maxZ - chunked.minZ;
    const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const radius = diagonal / 2 + BOUNDING_SPHERE_BUFFER;

    if (!geometry.boundingSphere) {
      geometry.boundingSphere = new THREE.Sphere();
    }
    geometry.boundingSphere.center.set(centerX, centerY, centerZ);
    geometry.boundingSphere.radius = radius;
    const screenSpaceState = this.screenSpaceChunks.get(chunked);
    if (screenSpaceState) {
      screenSpaceState.heroGeometry.boundingSphere = geometry.boundingSphere;
      if (screenSpaceState.lodGeometry)
        screenSpaceState.lodGeometry.boundingSphere = geometry.boundingSphere;
    }

    // Insert into spatial quadtree for O(log N) frustum queries
    if (this.chunkQuadtree) {
      const indexed = this.chunkQuadtree.insert(
        chunkKey,
        centerX,
        centerZ,
        centerY,
        radius,
      );
      if (!indexed) {
        // Chunk is outside quadtree bounds — will never be made visible by updateChunkVisibility()
        console.warn(
          `[VegetationSystem] Chunk "${chunkKey}" at (${centerX.toFixed(1)}, ${centerZ.toFixed(1)}) outside quadtree bounds — check world size config`,
        );
      }
    }
  }

  /**
   * Finalize all chunks after population - processes in batches to avoid blocking
   */
  private async finalizeAllChunks(): Promise<void> {
    const CHUNK_BATCH_SIZE = 20; // Finalize 20 chunks per batch
    let totalChunks = 0;
    let totalInstances = 0;

    // Collect chunks that need finalizing
    const chunksToFinalize: Array<[string, ChunkedInstancedMesh]> = [];
    for (const [chunkKey, chunked] of this.chunkedMeshes) {
      if (chunked.count > 0) {
        chunksToFinalize.push([chunkKey, chunked]);
      }
    }

    // Process in batches, yielding between each
    for (let i = 0; i < chunksToFinalize.length; i += CHUNK_BATCH_SIZE) {
      const batchEnd = Math.min(i + CHUNK_BATCH_SIZE, chunksToFinalize.length);

      for (let j = i; j < batchEnd; j++) {
        const [chunkKey, chunked] = chunksToFinalize[j];
        this.finalizeChunk(chunkKey);
        totalChunks++;
        totalInstances += chunked.count;
      }

      // Yield to main thread between batches
      if (batchEnd < chunksToFinalize.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  /**
   * Add a vegetation instance to the scene using chunked system
   */
  private async addInstance(instance: VegetationInstance): Promise<void> {
    const asset = this.assetDefinitions.get(instance.assetId);
    if (!asset) return;

    // Ensure asset data is loaded
    let assetDataRef = this.assetData.get(instance.assetId);
    if (!assetDataRef) {
      // Load the asset
      const loaded = await this.loadAssetData(asset);
      if (!loaded) return;
      assetDataRef = loaded;
    }

    // Add to chunked mesh
    this.addInstanceToChunk(instance, assetDataRef);
  }

  /**
   * Load asset geometry/material for chunked system
   * Loads both LOD0 (full detail) and LOD1 (low poly) if available
   */
  private async loadAssetData(
    asset: VegetationAsset,
  ): Promise<AssetData | null> {
    // Check if already loaded
    const existing = this.assetData.get(asset.id);
    if (existing) return existing;

    // Check if currently loading
    if (this.pendingAssetLoads.has(asset.id)) {
      // Wait for load to complete
      while (this.pendingAssetLoads.has(asset.id)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return this.assetData.get(asset.id) ?? null;
    }

    this.pendingAssetLoads.add(asset.id);

    try {
      const baseUrl = (this.world.assetsUrl || "").replace(/\/$/, "");
      const modelPath = `${baseUrl}/${asset.model}`;

      // Use modelCache which has proper meshopt decoder setup
      const { scene } = await modelCache.loadModel(modelPath, this.world);
      if (this.isDestroyed) return null;

      // Extract geometry and material from loaded scene (LOD0 - full detail)
      let geometry: THREE.BufferGeometry | null = null;
      let material: THREE.Material | THREE.Material[] =
        new MeshStandardNodeMaterial();

      scene.traverse((child) => {
        if (child instanceof THREE.Mesh && !geometry) {
          geometry = child.geometry;
          material = child.material;
        }
      });

      if (!geometry) {
        console.warn(
          `[VegetationSystem] loadAssetData: no geometry found in model "${asset.id}"`,
        );
        return null;
      }

      // Type assertion after null check
      const validGeometry = geometry as THREE.BufferGeometry;

      // Compute model base offset and bounding size for LOD scaling
      validGeometry.computeBoundingBox();
      const modelBaseOffset = validGeometry.boundingBox
        ? -validGeometry.boundingBox.min.y
        : 0;

      // Calculate bounding size (diagonal) for size-based LOD distance scaling
      // Multiply by baseScale since larger assets get scaled up
      let boundingSize = 1.0; // Default 1m for missing bounds
      if (validGeometry.boundingBox) {
        const size = new THREE.Vector3();
        validGeometry.boundingBox.getSize(size);
        boundingSize = size.length() * asset.baseScale;
      }

      // Create asset data with streaming LOD support.
      // LOD1/LOD2 are only loaded when explicit model paths are provided.
      const data: AssetData = {
        geometry: validGeometry,
        material,
        asset,
        modelBaseOffset,
        gpuMaterial: this.sharedVegetationMaterial!,
        boundingSize,
        lod1Geometry: null,
        lod1Material: null,
        lod1ModelBaseOffset: modelBaseOffset,
        hasLOD1: false,
        lod2Geometry: null,
        lod2Material: null,
        lod2ModelBaseOffset: modelBaseOffset,
        hasLOD2: false,
      };

      this.assetData.set(asset.id, data);

      // Create imposter (billboard) mesh for this asset type
      this.createAssetImposter(asset.id, scene, validGeometry);

      const vertCount = validGeometry.attributes.position?.count ?? 0;
      console.log(
        `[VegetationSystem] ✅ Loaded asset ${asset.id}: LOD0=${vertCount} verts (LOD1/LOD2 streamed on demand)`,
      );

      // Queue LOD1 and LOD2 for streaming load only when explicitly configured.
      const skipLOD =
        SKIP_LOD1_CATEGORIES.has(asset.category) && !asset.screenSpaceLod;
      const hasLOD1Model =
        typeof asset.lod1Model === "string" && asset.lod1Model.length > 0;
      const hasLOD2Model =
        typeof asset.lod2Model === "string" && asset.lod2Model.length > 0;
      if (!skipLOD && hasLOD1Model && !this.pendingLOD1Loads.has(asset.id)) {
        this.streamingLOD1Queue.push(asset.id);
        this.pendingLOD1Loads.add(asset.id);
      }
      if (!skipLOD && hasLOD2Model && !this.pendingLOD2Loads.has(asset.id)) {
        this.streamingLOD2Queue.push(asset.id);
        this.pendingLOD2Loads.add(asset.id);
      }

      return data;
    } catch (err) {
      console.error(
        `[VegetationSystem] loadAssetData failed for "${asset.id}":`,
        err,
      );
      return null;
    } finally {
      this.pendingAssetLoads.delete(asset.id);
    }
  }

  /** Queue of pending imposter bakes - processed one at a time to avoid frame drops */
  private pendingImposterBakes: Array<{
    assetId: string;
    modelScene: THREE.Object3D;
  }> = [];

  /** Whether imposter bake processing is currently running */
  private imposterBakeProcessing = false;

  /**
   * Queue an imposter for deferred baking.
   * Imposter baking is GPU-intensive, so we process one per idle callback
   * to avoid frame drops during asset loading.
   *
   * NOTE: When DISABLE_IMPOSTORS is true, this function returns immediately.
   * Vegetation uses dissolve fade instead of impostors for visual consistency.
   *
   * @param assetId - Asset identifier
   * @param modelScene - The loaded 3D model scene
   * @param _geometry - Model geometry (unused, kept for API compatibility)
   */
  private createAssetImposter(
    assetId: string,
    modelScene: THREE.Object3D,
    _geometry: THREE.BufferGeometry,
  ): void {
    // Skip impostor creation when disabled - vegetation fades out via GPU dissolve shader
    if (DISABLE_IMPOSTORS) return;
    if (this.imposters.has(assetId)) return;
    if (this.pendingImposterBakes.some((p) => p.assetId === assetId)) return;

    // Clone the scene for deferred processing (original may be modified)
    const clonedScene = modelScene.clone();

    // Queue for deferred processing
    this.pendingImposterBakes.push({ assetId, modelScene: clonedScene });

    // Start processing if not already running
    this.processImposterBakeQueue();
  }

  /**
   * Process imposter bake queue using requestIdleCallback.
   * Bakes one imposter per callback to maintain smooth framerate.
   */
  private processImposterBakeQueue(): void {
    if (this.imposterBakeProcessing || this.pendingImposterBakes.length === 0)
      return;

    this.imposterBakeProcessing = true;

    const processBake = async () => {
      // Stop if system was destroyed
      if (this.isDestroyed) {
        this.imposterBakeProcessing = false;
        return;
      }

      const pending = this.pendingImposterBakes.shift();
      if (!pending) {
        this.imposterBakeProcessing = false;
        return;
      }

      const { assetId, modelScene } = pending;

      if (this.imposters.has(assetId)) {
        // Continue processing queue
        if (this.pendingImposterBakes.length > 0) {
          if (typeof requestIdleCallback !== "undefined") {
            requestIdleCallback(() => processBake(), { timeout: 200 });
          } else {
            setTimeout(processBake, 16); // ~60fps timing
          }
        } else {
          this.imposterBakeProcessing = false;
        }
        return;
      }

      // Initialize octahedral impostor system if needed
      this.initOctahedralImpostor();

      if (!this.octahedralImpostor) {
        console.warn(
          `[VegetationSystem] Cannot create imposter: no impostor system`,
        );
        this.imposterBakeProcessing = false;
        return;
      }

      // Bake the model into an octahedral atlas - bake() is async
      // Uses hemisphere mapping (HEMI) since vegetation is viewed from ground level
      const bakeResult = await this.octahedralImpostor.bake(modelScene, {
        atlasWidth: VegetationSystem.IMPOSTER_ATLAS_SIZE,
        atlasHeight: VegetationSystem.IMPOSTER_ATLAS_SIZE,
        gridSizeX: VegetationSystem.IMPOSTER_GRID_X,
        gridSizeY: VegetationSystem.IMPOSTER_GRID_Y,
        octType: OctahedronType.HEMI, // Hemisphere for ground-viewed vegetation
        backgroundColor: 0x000000,
        backgroundAlpha: 0,
      });

      // Calculate size and offset from bounding sphere
      const size = bakeResult.boundingSphere.radius * 2;
      const heightOffset =
        bakeResult.boundingSphere.center.y - bakeResult.boundingSphere.radius;

      // Get LOD config for imposter fade distances, scaled by size
      // Larger vegetation (trees) visible from farther away than small (mushrooms)
      const category = this.assetDefinitions.get(assetId)?.category ?? "tree";
      const assetData = this.assetData.get(assetId);
      const lodConfig = getAssetLODConfig(
        category,
        assetData?.boundingSize ?? size,
      );

      // Create dissolve configuration for this asset type
      const dissolveConfig: DissolveConfig = {
        enabled: true,
        fadeStart: lodConfig.imposterDistance + 20,
        fadeEnd: lodConfig.fadeDistance,
      };

      // Store imposter data
      const imposterData: ImposterData = {
        bakeResult,
        instances: new Map(),
        size,
        heightOffset,
        chunkInstanceKeys: new Map(),
        dissolveConfig,
        lodConfig,
      };
      this.imposters.set(assetId, imposterData);

      console.log(`[VegetationSystem] 📸 Baked imposter for ${assetId}:`, {
        size: size.toFixed(1) + "m",
        atlasTextureValid: !!bakeResult.atlasTexture,
        atlasColorSpace: bakeResult.atlasTexture?.colorSpace ?? "none",
        gridSize: `${bakeResult.gridSizeX}x${bakeResult.gridSizeY}`,
        imposterDistance: lodConfig.imposterDistance,
        fadeDistance: lodConfig.fadeDistance,
      });

      // Continue processing queue
      if (this.pendingImposterBakes.length > 0) {
        if (typeof requestIdleCallback !== "undefined") {
          requestIdleCallback(() => processBake(), { timeout: 200 });
        } else {
          setTimeout(processBake, 16);
        }
      } else {
        this.imposterBakeProcessing = false;
      }
    };

    // Start processing
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => processBake(), { timeout: 200 });
    } else {
      setTimeout(processBake, 16);
    }
  }
  /**
   * Get the reference position for distance-based culling and fade.
   *
   * Uses camera position (not player) because:
   * 1. In third-person view, fade should be relative to what the player SEES
   * 2. Camera position gives intuitive "fog of war" effect
   * 3. Frustum culling already uses camera, so distances should match
   *
   * NOTE: Returns a reused temp vector - do not store the result!
   */
  private getPlayerPosition(): THREE.Vector3 | null {
    // Use camera position for view-relative culling
    const camera = this.world.camera;
    if (camera) {
      camera.getWorldPosition(this._tempPosition);
      return this._tempPosition;
    }

    // Fallback to player position if no camera available
    const players = this.world.getPlayers();
    if (!players || players.length === 0) return null;

    const player = players[0];
    if (player.node?.position) {
      return this._tempPosition.set(
        player.node.position.x,
        player.node.position.y,
        player.node.position.z,
      );
    }

    return null;
  }

  // Debug: periodic stats logging
  private lastStatsLog = 0;
  private lastPendingCheck = 0;
  private lastPlayerTileKey = "";

  // Movement tracking for terrain prefetching (tile pre-generation in movement direction)
  private lastPlayerPos = new THREE.Vector3();
  private lastPlayerPosInitialized = false;
  private playerVelocity = new THREE.Vector3();
  private lastPrefetchCheck = 0;
  /** How many tiles ahead to prefetch based on movement direction */
  private readonly PREFETCH_LOOKAHEAD_TILES = 2;

  // Camera layer setup
  private cameraLayerSet = false;

  /**
   * Per-frame update for vegetation culling.
   *
   * CULLING PIPELINE (each frame):
   * 1. updateGPUUniforms() - Pass camera position to shader for GPU fade
   * 2. updateChunkVisibility() - CPU distance + frustum culling (sets mesh.visible)
   * 3. GPU shader - Per-fragment dithered dissolve based on distance
   *
   * This hybrid approach is optimal because:
   * - CPU culling skips entire draw calls (mesh.visible = false)
   * - GPU fade provides smooth transitions without CPU overhead
   * - Frustum culling prevents rendering behind the camera
   */
  override update(_delta: number): void {
    if (!this.world.isClient) return;

    // Ensure camera can see vegetation layer (one-time setup)
    // Layer 1 = main camera only (minimap uses layer 0)
    if (!this.cameraLayerSet && this.world.camera) {
      this.world.camera.layers.enable(1);
      this.cameraLayerSet = true;
    }

    const now = Date.now();
    // Get camera position (used for distance-based culling and shader fade)
    // We use camera position (not player position) for proper third-person view fade
    const cameraPos = this.getPlayerPosition();

    // Update GPU uniforms and perform CPU-side culling
    if (cameraPos) {
      // GPU uniforms: playerPos used by shader for distance fade calculation
      this.updateGPUUniforms(cameraPos.x, cameraPos.y, cameraPos.z);

      // CPU culling: hide chunks outside camera frustum or beyond render distance
      // This is more efficient than GPU culling because we skip entire draw calls
      this.updateChunkVisibility(cameraPos.x, cameraPos.z);

      // Update procgen tree instances (LOD transitions, wind animation)
      // Pass delta time for wind animation and cross-fade transitions
      updateTreeInstances(cameraPos, _delta);

      // Update ClientLoader with player position for priority-based loading
      // This allows distant tiles to be loaded with lower priority
      const loader = this.world.loader as {
        updatePlayerPosition?: (pos: THREE.Vector3) => void;
      };
      if (loader?.updatePlayerPosition) {
        loader.updatePlayerPosition(cameraPos);
      }
    }

    // Lazy load pending tiles as player moves
    if (now - this.lastPendingCheck > 1000) {
      this.lastPendingCheck = now;
      this.processPendingTiles();
    }

    if (
      !this.tileRegenerationProcessing &&
      this.pendingTileRegenerations.size > 0
    ) {
      void this.processQueuedTileRegenerations();
    }

    // Track player movement and prefetch tiles in movement direction
    if (cameraPos) {
      if (!this.lastPlayerPosInitialized) {
        this.lastPlayerPos.copy(cameraPos);
        this.lastPlayerPosInitialized = true;
      } else {
        // Calculate velocity (movement since last frame)
        this.playerVelocity.subVectors(cameraPos, this.lastPlayerPos);
        this.lastPlayerPos.copy(cameraPos);

        // Prefetch tiles in movement direction (every 2 seconds to avoid spam)
        if (now - this.lastPrefetchCheck > 2000) {
          this.lastPrefetchCheck = now;
          this.prefetchTilesInDirection();
        }
      }
    }

    // Exploration clients stream distant vegetation LODs as they move. The
    // fixed broadcast viewport keeps LOD0 arena-adjacent vegetation and avoids
    // deferred model decode/GPU uploads that otherwise interrupt early frames.
    if (this.streamBackgroundLods) this.processStreamingLODQueue();

    // Periodic stats logging (debug only)
    if (now - this.lastStatsLog > 30000) {
      this.lastStatsLog = now;
    }
  }

  /**
   * Prefetch terrain tiles in the direction of player movement.
   * This triggers TerrainSystem.prefetchTile() to pre-generate tiles ahead of the player,
   * which in turn triggers vegetation generation for those tiles.
   */
  private prefetchTilesInDirection(): void {
    if (this.playerVelocity.lengthSq() < 0.01) return;

    const playerTile = this.getPlayerTile();
    if (!playerTile) return;

    // Normalize velocity to get movement direction
    const dirX = this.playerVelocity.x;
    const dirZ = this.playerVelocity.z;
    const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (len < 0.01) return;

    const normX = dirX / len;
    const normZ = dirZ / len;

    // Get TerrainSystem for prefetching
    const terrainSystem = this.world.getSystem("terrain") as {
      prefetchTile?: (x: number, z: number) => void;
    };
    if (!terrainSystem?.prefetchTile) {
      return;
    }

    // Prefetch tiles in the movement direction
    for (let i = 1; i <= this.PREFETCH_LOOKAHEAD_TILES; i++) {
      const predictedTileX = Math.floor(playerTile.x + normX * i + 0.5);
      const predictedTileZ = Math.floor(playerTile.z + normZ * i + 0.5);
      const key = `${predictedTileX}_${predictedTileZ}`;

      if (this.tileVegetation.has(key) || this.pendingTiles.has(key)) {
        continue;
      }

      // Request terrain prefetch - this will trigger vegetation generation
      // via the TERRAIN_TILE_GENERATED event when the tile completes
      terrainSystem.prefetchTile(predictedTileX, predictedTileZ);
    }
  }

  /**
   * Process streaming LOD queue - loads LOD1 and LOD2 models in parallel.
   * Uses concurrency limiting to avoid overwhelming the network/CPU.
   */
  private processStreamingLODQueue(): void {
    // Calculate how many new loads we can start
    const availableSlots =
      VegetationSystem.MAX_CONCURRENT_LOD_LOADS - this.lodLoadsInFlight;
    if (availableSlots <= 0) return;

    // Split available slots between LOD1 (priority) and LOD2
    const lod1Slots = Math.min(
      Math.ceil(availableSlots * 0.7), // 70% priority to LOD1
      this.streamingLOD1Queue.length,
      VegetationSystem.STREAMING_BATCH_SIZE,
    );
    const lod2Slots = Math.min(
      availableSlots - lod1Slots,
      this.streamingLOD2Queue.length,
      VegetationSystem.STREAMING_BATCH_SIZE,
    );

    // Start LOD1 loads (fire-and-forget with tracking)
    for (const assetId of this.streamingLOD1Queue.splice(0, lod1Slots)) {
      this.lodLoadsInFlight++;
      this.loadLODForAsset(assetId, 1).finally(() => {
        this.lodLoadsInFlight--;
      });
    }

    // Start LOD2 loads (fire-and-forget with tracking)
    for (const assetId of this.streamingLOD2Queue.splice(0, lod2Slots)) {
      this.lodLoadsInFlight++;
      this.loadLODForAsset(assetId, 2).finally(() => {
        this.lodLoadsInFlight--;
      });
    }
  }

  /**
   * Load LOD model for an asset in background.
   * Unified function for LOD1 and LOD2 loading.
   */
  private async loadLODForAsset(
    assetId: string,
    lodLevel: 1 | 2,
  ): Promise<void> {
    const assetData = this.assetData.get(assetId);
    const asset = this.assetDefinitions.get(assetId);
    const pendingSet =
      lodLevel === 1 ? this.pendingLOD1Loads : this.pendingLOD2Loads;
    const hasLOD = lodLevel === 1 ? assetData?.hasLOD1 : assetData?.hasLOD2;

    if (!assetData || !asset || hasLOD) {
      pendingSet.delete(assetId);
      return;
    }

    try {
      const baseUrl = (this.world.assetsUrl || "").replace(/\/$/, "");
      const modelPath = lodLevel === 1 ? asset.lod1Model : asset.lod2Model;

      if (!modelPath) {
        return;
      }

      // Use priority-based loading: LOD1 is LOW priority (background), LOD2 is PREFETCH (even lower)
      const priority =
        lodLevel === 1 ? LoadPriority.LOW : LoadPriority.PREFETCH;
      const { scene: lodScene } = await modelCache.loadModel(
        `${baseUrl}/${modelPath}`,
        this.world,
        {
          priority,
        },
      );
      if (
        this.isDestroyed ||
        this.assetData.get(assetId) !== assetData ||
        this.assetDefinitions.get(assetId) !== asset
      )
        return;

      // Extract first mesh geometry
      let foundGeometry: THREE.BufferGeometry | null = null;
      let foundMaterial: THREE.Material | THREE.Material[] | null = null;
      lodScene.traverse((child) => {
        if (child instanceof THREE.Mesh && !foundGeometry) {
          foundGeometry = child.geometry;
          foundMaterial = child.material;
        }
      });

      if (foundGeometry) {
        const geometry = foundGeometry as THREE.BufferGeometry;
        geometry.computeBoundingBox();
        if (asset.screenSpaceLod && lodLevel === 1) {
          const hero = assetData.geometry;
          const position = geometry.getAttribute("position");
          const normal = geometry.getAttribute("normal");
          const color = geometry.getAttribute("color");
          // This path currently admits rigid, opaque vertex-colour geometry
          // with an identical pivot/footprint and a strictly smaller index set.
          // Shading/wind remain owned by the original shared GPU material.
          if (
            !position ||
            !normal ||
            !color ||
            !geometry.index ||
            !hero.index ||
            geometry.index.count >= hero.index.count ||
            normal.count !== position.count ||
            color.count !== position.count ||
            Object.keys(geometry.morphAttributes).length ||
            !geometry.boundingBox ||
            !hero.boundingBox ||
            !geometry.boundingBox.equals(hero.boundingBox) ||
            !(assetData.gpuMaterial instanceof MeshStandardNodeMaterial) ||
            assetData.gpuMaterial.positionNode ||
            assetData.gpuMaterial.vertexNode
          )
            return;
          assetData.lod1Geometry = geometry;
          for (const [chunk, state] of this.screenSpaceChunks)
            if (state.asset === assetData)
              this.installScreenSpaceChunkLod(chunk, state);
          return;
        }
        const baseOffset = geometry.boundingBox
          ? -geometry.boundingBox.min.y
          : assetData.modelBaseOffset;
        const vertCount = geometry.attributes.position?.count ?? 0;

        // Update asset data
        if (lodLevel === 1) {
          assetData.lod1Geometry = geometry;
          assetData.lod1Material = foundMaterial;
          assetData.lod1ModelBaseOffset = baseOffset;
          assetData.hasLOD1 = true;
        } else {
          assetData.lod2Geometry = geometry;
          assetData.lod2Material = foundMaterial;
          assetData.lod2ModelBaseOffset = baseOffset;
          assetData.hasLOD2 = true;
        }

        console.log(
          `[VegetationSystem] 📦 Streamed LOD${lodLevel} for ${assetId}: ${vertCount} verts`,
        );
        this.rebuildLODChunksForAsset(assetId, assetData, lodLevel);
      }
    } catch (err) {
      // LOD file not found is expected if not baked - only log unexpected errors
      const error = err as Error;
      const is404 =
        error?.message?.includes("404") ||
        error?.message?.includes("not found");
      if (!is404) {
        console.warn(
          `[VegetationSystem] Failed to load LOD${lodLevel} for ${assetId}:`,
          error?.message || err,
        );
      }
    } finally {
      pendingSet.delete(assetId);
    }
  }

  /** Pending LOD chunk rebuilds - processed incrementally to avoid frame drops */
  private pendingLODRebuilds: Array<{
    assetId: string;
    assetDataRef: AssetData;
    lodLevel: 1 | 2;
    chunkKeys: string[];
    currentIndex: number;
  }> = [];

  /** Whether LOD rebuild processing is currently running */
  private lodRebuildProcessing = false;

  /** Max chunks to rebuild per frame (prevents frame drops) */
  private static readonly MAX_LOD_CHUNKS_PER_FRAME = 4;

  /**
   * Rebuild LOD chunks for an asset after its LOD model is streamed in.
   * Uses incremental processing via requestIdleCallback to avoid frame drops.
   */
  private rebuildLODChunksForAsset(
    assetId: string,
    assetDataRef: AssetData,
    lodLevel: 1 | 2,
  ): void {
    const geometry =
      lodLevel === 1 ? assetDataRef.lod1Geometry : assetDataRef.lod2Geometry;
    const hasLOD = lodLevel === 1 ? assetDataRef.hasLOD1 : assetDataRef.hasLOD2;

    if (!hasLOD || !geometry) return;

    // Collect chunk keys that need rebuilding for this asset
    const chunkKeys: string[] = [];
    for (const chunkKey of this.chunkInstanceData.keys()) {
      if (chunkKey.endsWith(`_${assetId}`)) {
        chunkKeys.push(chunkKey);
      }
    }

    if (chunkKeys.length === 0) return;

    // Queue for incremental processing
    this.pendingLODRebuilds.push({
      assetId,
      assetDataRef,
      lodLevel,
      chunkKeys,
      currentIndex: 0,
    });

    // Start processing if not already running
    this.processLODRebuildsIncremental();
  }

  /**
   * Process LOD rebuilds incrementally using requestIdleCallback.
   * Processes a limited number of chunks per idle callback to maintain 60fps.
   */
  private processLODRebuildsIncremental(): void {
    if (this.lodRebuildProcessing || this.pendingLODRebuilds.length === 0)
      return;

    this.lodRebuildProcessing = true;

    const processChunk = () => {
      // Stop if system was destroyed
      if (this.isDestroyed) {
        this.lodRebuildProcessing = false;
        return;
      }

      const rebuild = this.pendingLODRebuilds[0];
      if (!rebuild) {
        this.lodRebuildProcessing = false;
        return;
      }

      const { assetId, assetDataRef, lodLevel, chunkKeys, currentIndex } =
        rebuild;
      const meshMap =
        lodLevel === 1 ? this.lod1ChunkedMeshes : this.lod2ChunkedMeshes;
      const lodOffset =
        lodLevel === 1
          ? assetDataRef.lod1ModelBaseOffset
          : assetDataRef.lod2ModelBaseOffset;
      const createMesh =
        lodLevel === 1
          ? (x: number, z: number) =>
              this.getOrCreateLOD1ChunkedMesh(x, z, assetId, assetDataRef)
          : (x: number, z: number) =>
              this.getOrCreateLOD2ChunkedMesh(x, z, assetId, assetDataRef);

      // Process up to MAX_LOD_CHUNKS_PER_FRAME chunks
      const endIndex = Math.min(
        currentIndex + VegetationSystem.MAX_LOD_CHUNKS_PER_FRAME,
        chunkKeys.length,
      );

      for (let i = currentIndex; i < endIndex; i++) {
        const chunkKey = chunkKeys[i];
        const instanceList = this.chunkInstanceData.get(chunkKey);
        if (!instanceList) continue;

        const lodKey = `${chunkKey}_lod${lodLevel}`;
        let chunk = meshMap.get(lodKey);

        // Create chunk if needed
        if (!chunk) {
          const parts = chunkKey.split("_");
          if (parts.length >= 3) {
            const newChunk = createMesh(
              parseFloat(parts[0]) * VEGETATION_CHUNK_SIZE,
              parseFloat(parts[1]) * VEGETATION_CHUNK_SIZE,
            );
            if (newChunk) chunk = newChunk;
          }
        }
        if (!chunk) continue;

        // Populate instances using batch-optimized approach
        this.populateLODChunk(chunk, instanceList, assetDataRef, lodOffset);
      }

      // Update progress
      rebuild.currentIndex = endIndex;

      // Check if done with this rebuild
      if (rebuild.currentIndex >= chunkKeys.length) {
        this.pendingLODRebuilds.shift();
      }

      // Continue processing if more work remains
      if (this.pendingLODRebuilds.length > 0) {
        if (typeof requestIdleCallback !== "undefined") {
          requestIdleCallback(() => processChunk(), { timeout: 100 });
        } else {
          // Fallback for environments without requestIdleCallback
          setTimeout(processChunk, 0);
        }
      } else {
        this.lodRebuildProcessing = false;
      }
    };

    // Start processing
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => processChunk(), { timeout: 100 });
    } else {
      setTimeout(processChunk, 0);
    }
  }

  /**
   * Populate a LOD chunk with instances - optimized batch version.
   * Skips if chunk is already populated to prevent duplicates.
   */
  private populateLODChunk(
    chunk: ChunkedInstancedMesh,
    instanceList: ChunkInstanceData[],
    assetDataRef: AssetData,
    lodOffset: number,
  ): void {
    if (chunk.count > 0) return;

    const posArr = chunk.positionAttr.array as Float32Array;
    const scaleArr = chunk.scaleAttr.array as Float32Array;
    const rotArr = chunk.rotationAttr.array as Float32Array;

    let count = chunk.count;
    const maxCount = MAX_INSTANCES_PER_CHUNK;

    for (const inst of instanceList) {
      if (count >= maxCount) break;

      const worldY =
        inst.y -
        assetDataRef.modelBaseOffset * inst.scale +
        lodOffset * inst.scale;
      const i3 = count * 3;

      // Batch write attributes (faster than individual sets)
      posArr[i3] = inst.x;
      posArr[i3 + 1] = worldY;
      posArr[i3 + 2] = inst.z;
      scaleArr[count] = inst.scale;
      rotArr[count] = inst.rotationY;

      // Update bounds
      chunk.minX = Math.min(chunk.minX, inst.x);
      chunk.maxX = Math.max(chunk.maxX, inst.x);
      chunk.minY = Math.min(chunk.minY, worldY);
      chunk.maxY = Math.max(chunk.maxY, worldY);
      chunk.minZ = Math.min(chunk.minZ, inst.z);
      chunk.maxZ = Math.max(chunk.maxZ, inst.z);

      // Set matrix
      this._tempPosition.set(inst.x, worldY, inst.z);
      this._tempQuaternion.setFromAxisAngle(this._yAxis, inst.rotationY);
      this._tempScale.setScalar(inst.scale);
      this._tempMatrix.compose(
        this._tempPosition,
        this._tempQuaternion,
        this._tempScale,
      );
      chunk.mesh.setMatrixAt(count, this._tempMatrix);

      count++;
    }

    // Finalize chunk
    if (count > chunk.count) {
      chunk.count = count;
      chunk.mesh.count = count;
      chunk.positionAttr.needsUpdate = true;
      chunk.scaleAttr.needsUpdate = true;
      chunk.rotationAttr.needsUpdate = true;
      chunk.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Get the actual player entity position (for occlusion target).
   * This is separate from camera position - the player is what we want to keep visible.
   */
  private getActualPlayerPosition(): THREE.Vector3 | null {
    // Spectator/streaming mode: no local player, so use camera target.
    const localPlayer = this.world.getPlayer();
    if (!localPlayer) {
      const cameraSystem =
        (this.world.getSystem("client-camera-system") as
          | {
              getCameraInfo?: () => {
                target?: { position?: THREE.Vector3 } | null;
              };
            }
          | undefined) ??
        (this.world.getSystem("client-camera") as
          | {
              getCameraInfo?: () => {
                target?: { position?: THREE.Vector3 } | null;
              };
            }
          | undefined) ??
        (this.world.getSystem("camera") as
          | {
              getCameraInfo?: () => {
                target?: { position?: THREE.Vector3 } | null;
              };
            }
          | undefined);
      const targetPos = cameraSystem?.getCameraInfo?.().target?.position;
      if (targetPos) {
        return targetPos;
      }
    }

    const players = this.world.getPlayers();
    if (!players || players.length === 0) return null;

    const player = players[0];
    if (player.node?.position) {
      return player.node.position;
    }

    return null;
  }

  /**
   * Update GPU material uniforms. This is the ONLY CPU work per frame (~32 bytes).
   * All distance fade, water culling, occlusion, and transforms happen in the shader.
   *
   * For occlusion dissolve:
   * - playerPos = the target we want to keep visible (actual player position)
   * - cameraPos = the source of the view ray (camera position)
   * Objects between cameraPos and playerPos will dissolve.
   */
  private updateGPUUniforms(
    cameraX: number,
    cameraY: number,
    cameraZ: number,
  ): void {
    // Get actual player position for occlusion target
    const actualPlayerPos = this.getActualPlayerPosition();
    const playerX = actualPlayerPos?.x ?? cameraX;
    const playerY = actualPlayerPos?.y ?? cameraY;
    const playerZ = actualPlayerPos?.z ?? cameraZ;

    // OPTIMIZATION: Update shared material ONCE (used by all vertex-color vegetation)
    if (this.sharedVegetationMaterial) {
      // playerPos = target (actual player) - used for distance fade AND occlusion target
      this.sharedVegetationMaterial.gpuUniforms.playerPos.value.set(
        playerX,
        playerY,
        playerZ,
      );
      // cameraPos = camera position - used for occlusion ray origin
      this.sharedVegetationMaterial.gpuUniforms.cameraPos.value.set(
        cameraX,
        cameraY,
        cameraZ,
      );
    }

    // OPTIMIZATION: Only update dissolve for visible imposters (lodLevel === 3)
    // Uses cached chunkInstanceKeys for O(1) chunk->instances lookup (avoids O(n) string matching)
    // Further optimized: Check frame budget and skip if over budget (dissolve is visual polish, not critical)
    const frameBudget = this.world.frameBudget;
    if (frameBudget && !frameBudget.hasTimeRemaining(2)) {
      // Over budget - skip dissolve updates this frame (visual quality vs. smoothness tradeoff)
      return;
    }

    this._tempPosition.set(cameraX, cameraY, cameraZ);
    let dissolveUpdates = 0;
    const maxDissolveUpdates = 50; // Cap dissolve updates per frame

    for (const chunkKey of this._lastVisibleChunks) {
      if (dissolveUpdates >= maxDissolveUpdates) break;

      const state = this.chunkLODStates.get(chunkKey);
      if (!state || state.lodLevel !== 3) continue;

      const imposterData = this.imposters.get(state.assetId);
      if (!imposterData) continue;

      // Use cached instance keys for this chunk (populated in addChunkToImposter)
      const instanceKeys = imposterData.chunkInstanceKeys.get(chunkKey);
      if (!instanceKeys) continue;

      for (const instanceKey of instanceKeys) {
        if (dissolveUpdates >= maxDissolveUpdates) break;
        const instance = imposterData.instances.get(instanceKey);
        if (instance?.updateDissolve) {
          instance.updateDissolve(this._tempPosition);
          dissolveUpdates++;
        }
      }
    }
  }

  /**
   * Show/hide chunks and manage LOD transitions based on distance and frustum.
   *
   * 3-TIER LOD PIPELINE (per chunk):
   * 1. Close (< lod1Distance): Show LOD0 (full detail), hide LOD1 and imposter
   * 2. Medium (lod1Distance - imposterDistance): Show LOD1 (low poly), hide LOD0 and imposter
   * 3. Far (imposterDistance - fadeDistance): Hide 3D, show imposter billboard
   * 4. Very Far (> fadeDistance): Hide everything (culled)
   *
   * LOD distances are configurable per category (trees have longer distances than flowers).
   * Hysteresis prevents flickering at LOD boundaries.
   *
   * @param cameraX - Camera X position (used for distance culling)
   * @param cameraZ - Camera Z position (used for distance culling)
   */
  private updateChunkVisibility(
    cameraX: number,
    cameraZ: number,
    camera = this.world.camera,
  ): void {
    if (!camera) return;

    camera.updateWorldMatrix(true, false);
    // Use the owner's final projection, including view offsets, WebGPU depth,
    // and parent transforms. Do not overwrite an authored projection here.
    if (!this.matchesCulledView(camera)) {
      this._projScreenMatrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      this._frustum.setFromProjectionMatrix(
        this._projScreenMatrix,
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      this._culledCameraWorld.copy(camera.matrixWorld);
      this._culledCameraProjection.copy(camera.projectionMatrix);
      this._culledCoordinateSystem = camera.coordinateSystem;
      this._culledReversedDepth = camera.reversedDepth;
      this._frustumDirty = false;

      // Update GPU compute frustum when available
      if (this.gpuCullingEnabled && isGPUComputeAvailable()) {
        const cullingManager = getGlobalCullingManager();
        // GPU culling provides parallel frustum tests - updates are batched
        cullingManager?.updateFrustum(camera);
      }
    }

    // OPTIMIZATION: Reuse pre-allocated arrays instead of allocating new ones each frame
    // Clear but don't reallocate - this avoids GC pressure
    this._chunksToLOD0.length = 0;
    this._chunksToLOD1.length = 0;
    this._chunksToLOD2.length = 0;
    this._chunksToImposter.length = 0;
    this._chunksFrom3D.length = 0;
    this._currentVisibleChunks.clear();

    // Pre-compute hysteresis squared (0.9^2 = 0.81)
    const hysteresisSq = 0.81;

    // Use quadtree for O(log N) frustum query instead of O(N) linear iteration
    // This returns only chunks that intersect the frustum, sorted front-to-back
    const visibleChunkKeys = this.chunkQuadtree
      ? this.chunkQuadtree.queryFrustum(this._frustum, cameraX, cameraZ)
      : Array.from(this.chunkedMeshes.keys()); // Fallback to linear if no quadtree

    for (const chunkKey of visibleChunkKeys) {
      const chunked = this.chunkedMeshes.get(chunkKey);
      if (!chunked) continue;

      // Get bounding sphere (stored in world coordinates)
      const bs = chunked.mesh.geometry.boundingSphere;
      if (!bs) {
        chunked.mesh.visible = false;
        continue;
      }

      // Calculate SQUARED distance to chunk center (avoid Math.sqrt in hot path)
      const dx = bs.center.x - cameraX;
      const dz = bs.center.z - cameraZ;
      const distSq = dx * dx + dz * dz;

      // Get or create LOD state (caches ALL derived data to avoid work in hot path)
      let state = this.chunkLODStates.get(chunkKey);
      if (!state) {
        // Extract asset info from chunk key (format: "chunkX_chunkZ_assetId")
        // This parsing only happens once per chunk, then everything is cached
        const parts = chunkKey.split("_");
        const assetId = parts.length >= 3 ? parts.slice(2).join("_") : "";
        const assetDef = this.assetDefinitions.get(assetId);
        const assetData = this.assetData.get(assetId);
        const category = assetDef?.category || "tree";
        const boundingSize = assetData?.boundingSize ?? 1.0;

        state = {
          lodLevel: 0 as ChunkLODLevel,
          centerX: bs.center.x,
          centerZ: bs.center.z,
          assetId,
          // Cache LOD config with pre-computed squared distances
          lodConfig: getAssetLODConfig(category, boundingSize),
          // Cache LOD keys to avoid string concatenation every frame
          lod1Key: `${chunkKey}_lod1`,
          lod2Key: `${chunkKey}_lod2`,
          // Cache LOD availability flags
          hasLOD1: assetData?.hasLOD1 ?? false,
          hasLOD2: assetData?.hasLOD2 ?? false,
        };
        this.chunkLODStates.set(chunkKey, state);
      }

      // All values pre-cached in state - zero allocations or lookups per frame
      const { lodConfig, lod1Key, lod2Key, hasLOD1, hasLOD2 } = state;
      const lod1Chunked = this.lod1ChunkedMeshes.get(lod1Key);
      const lod2Chunked = this.lod2ChunkedMeshes.get(lod2Key);

      // STAGE 1: Culling - beyond fade distance, hide everything
      // Compare squared distances (avoids sqrt)
      if (distSq >= lodConfig.fadeDistanceSq) {
        chunked.mesh.visible = false;
        if (lod1Chunked) lod1Chunked.mesh.visible = false;
        if (lod2Chunked) lod2Chunked.mesh.visible = false;
        if (state.lodLevel === 3) {
          this.removeChunkFromImposter(chunkKey);
        }
        state.lodLevel = 4;
        continue;
      }

      // Track this chunk as visible (passed frustum and distance checks)
      this._currentVisibleChunks.add(chunkKey);

      // STAGE 2: Determine target LOD level based on distance
      // LOD Pipeline: 0=LOD0, 1=LOD1, 2=LOD2, 3=Impostor (disabled), 4=Culled
      // All comparisons use squared distances for performance
      // When DISABLE_IMPOSTORS is true, 3D meshes stay visible and dissolve fade at distance
      // Force impostor mode when rendering for reflection camera (performance) - only if enabled
      const forceImpostor =
        !DISABLE_IMPOSTORS &&
        this.world.isRenderingReflection &&
        this.imposters.has(state.assetId);

      let targetLOD: ChunkLODLevel;
      if (forceImpostor) {
        // Reflection camera: always use impostor for performance (when enabled)
        targetLOD = 3;
      } else if (distSq < lodConfig.lod1DistanceSq * hysteresisSq) {
        // Very close - use LOD0 (full detail)
        targetLOD = 0;
      } else if (distSq < lodConfig.lod1DistanceSq) {
        // In LOD0/LOD1 transition zone - use hysteresis
        targetLOD = state.lodLevel <= 1 ? state.lodLevel : hasLOD1 ? 1 : 0;
      } else if (distSq < lodConfig.lod2DistanceSq * hysteresisSq) {
        // LOD1 range - use LOD1 if available, otherwise LOD0
        targetLOD = hasLOD1 ? 1 : 0;
      } else if (distSq < lodConfig.lod2DistanceSq) {
        // In LOD1/LOD2 transition zone - use hysteresis
        targetLOD =
          state.lodLevel <= 2 ? state.lodLevel : hasLOD2 ? 2 : hasLOD1 ? 1 : 0;
      } else if (DISABLE_IMPOSTORS) {
        // IMPOSTORS DISABLED: Stay on best available 3D LOD, let GPU shader dissolve fade
        targetLOD = hasLOD2 ? 2 : hasLOD1 ? 1 : 0;
      } else if (distSq < lodConfig.imposterDistanceSq * hysteresisSq) {
        // LOD2 range - use LOD2 if available, otherwise best available
        targetLOD = hasLOD2 ? 2 : hasLOD1 ? 1 : 0;
      } else if (distSq < lodConfig.imposterDistanceSq) {
        // In LOD2/imposter transition zone - use hysteresis
        targetLOD = state.lodLevel === 3 ? 3 : hasLOD2 ? 2 : hasLOD1 ? 1 : 0;
      } else {
        // Far distance - use imposter (if available)
        const imposter = this.imposters.get(state.assetId);
        if (imposter) {
          targetLOD = 3;
        } else {
          // No imposter available - fall back to best available 3D LOD
          targetLOD = hasLOD2 ? 2 : hasLOD1 ? 1 : 0;
        }
      }

      // STAGE 3: Apply LOD transitions
      const prevLOD = state.lodLevel;
      if (targetLOD !== prevLOD) {
        // Transitioning to new LOD level
        if (targetLOD === 0) {
          // Switch to LOD0
          if (prevLOD === 3) this._chunksFrom3D.push(chunkKey);
          this._chunksToLOD0.push(chunkKey);
        } else if (targetLOD === 1) {
          // Switch to LOD1
          if (prevLOD === 3) this._chunksFrom3D.push(chunkKey);
          this._chunksToLOD1.push(chunkKey);
        } else if (targetLOD === 2) {
          // Switch to LOD2
          if (prevLOD === 3) this._chunksFrom3D.push(chunkKey);
          this._chunksToLOD2.push(chunkKey);
        } else if (targetLOD === 3) {
          // Switch to imposter
          this._chunksToImposter.push(chunkKey);
        }
        state.lodLevel = targetLOD;
      }

      // STAGE 4: Set mesh visibility based on current LOD
      switch (state.lodLevel) {
        case 0: // LOD0 (full detail)
          chunked.mesh.visible = true;
          if (lod1Chunked) lod1Chunked.mesh.visible = false;
          if (lod2Chunked) lod2Chunked.mesh.visible = false;
          break;
        case 1: // LOD1 (low poly ~10%)
          chunked.mesh.visible = false;
          if (lod1Chunked) lod1Chunked.mesh.visible = true;
          if (lod2Chunked) lod2Chunked.mesh.visible = false;
          break;
        case 2: // LOD2 (very low poly ~3%)
          chunked.mesh.visible = false;
          if (lod1Chunked) lod1Chunked.mesh.visible = false;
          if (lod2Chunked) lod2Chunked.mesh.visible = true;
          break;
        case 3: // Imposter (billboard)
          chunked.mesh.visible = false;
          if (lod1Chunked) lod1Chunked.mesh.visible = false;
          if (lod2Chunked) lod2Chunked.mesh.visible = false;
          break;
        case 4: // Culled
          chunked.mesh.visible = false;
          if (lod1Chunked) lod1Chunked.mesh.visible = false;
          if (lod2Chunked) lod2Chunked.mesh.visible = false;
          break;
      }
    }

    // Hide chunks that were visible last frame but are no longer visible
    // This handles chunks that moved out of the frustum
    // OPTIMIZATION: Cap hide operations per frame, defer excess to prevent jank
    let hideOps = 0;
    for (const chunkKey of this._lastVisibleChunks) {
      if (!this._currentVisibleChunks.has(chunkKey)) {
        if (hideOps >= this.MAX_HIDE_OPS_PER_FRAME) {
          // Defer excess hide operations to next frame
          this._deferredHideChunks.push(chunkKey);
          continue;
        }
        this.hideChunk(chunkKey);
        hideOps++;
      }
    }

    // Process deferred hide operations from previous frames
    while (
      this._deferredHideChunks.length > 0 &&
      hideOps < this.MAX_HIDE_OPS_PER_FRAME
    ) {
      const chunkKey = this._deferredHideChunks.pop()!;
      // Skip if chunk became visible again
      if (!this._currentVisibleChunks.has(chunkKey)) {
        this.hideChunk(chunkKey);
        hideOps++;
      }
    }

    // Swap visible chunk sets (reuse the cleared set as next frame's _lastVisibleChunks)
    const temp = this._lastVisibleChunks;
    this._lastVisibleChunks = this._currentVisibleChunks;
    this._currentVisibleChunks = temp;

    // OPTIMIZATION: Add new LOD transitions to deferred queues instead of processing immediately
    // This prevents frame drops when many chunks transition at once (e.g., fast camera movement)
    for (const chunkKey of this._chunksFrom3D) {
      this._deferredFrom3D.push(chunkKey);
    }
    for (const chunkKey of this._chunksToImposter) {
      this._deferredToImposter.push(chunkKey);
    }

    // Process deferred LOD transitions progressively (limited per frame)
    this.processLODTransitions();

    // Update imposter billboards (only for visible imposters)
    this.updateImposterBillboards(cameraX, cameraZ);
  }

  /**
   * Hide a chunk and all its LOD variants.
   * Used by deferred hide processing to spread work across frames.
   */
  private hideChunk(chunkKey: string): void {
    const chunked = this.chunkedMeshes.get(chunkKey);
    if (chunked) {
      chunked.mesh.visible = false;
      // Use cached LOD keys from state if available
      const state = this.chunkLODStates.get(chunkKey);
      if (state) {
        const lod1Chunked = this.lod1ChunkedMeshes.get(state.lod1Key);
        const lod2Chunked = this.lod2ChunkedMeshes.get(state.lod2Key);
        if (lod1Chunked) lod1Chunked.mesh.visible = false;
        if (lod2Chunked) lod2Chunked.mesh.visible = false;
      }
    }
  }

  /**
   * Process pending LOD transitions progressively across frames.
   * Heavy operations (imposter add/remove) are spread across frames to prevent jank.
   * Prioritizes "from3D" (remove from imposter) over "toImposter" (add to imposter)
   * to free up memory first.
   *
   * NOTE: When DISABLE_IMPOSTORS is true, impostor queues are skipped entirely.
   */
  private processLODTransitions(): void {
    // Skip impostor processing when disabled
    if (DISABLE_IMPOSTORS) {
      // Clear any queues that might have been populated before flag was checked
      this._deferredFrom3D.length = 0;
      this._deferredToImposter.length = 0;
      return;
    }

    let processed = 0;
    const maxTransitions = this.MAX_LOD_TRANSITIONS_PER_FRAME;

    // Priority 1: Remove from imposter (free memory first)
    while (this._deferredFrom3D.length > 0 && processed < maxTransitions) {
      const chunkKey = this._deferredFrom3D.pop()!;
      this.removeChunkFromImposter(chunkKey);
      processed++;
    }

    // Priority 2: Add to imposter (create new instances)
    while (this._deferredToImposter.length > 0 && processed < maxTransitions) {
      const chunkKey = this._deferredToImposter.pop()!;
      this.addChunkToImposter(chunkKey);
      processed++;
    }
  }

  /**
   * Add a chunk's instances to the octahedral imposter system.
   * Creates individual ImpostorInstance objects with view-dependent blending.
   * Each instance has its own material with dissolve support for distance-based fading.
   *
   * NOTE: When DISABLE_IMPOSTORS is true, this function returns immediately.
   */
  private addChunkToImposter(chunkKey: string): void {
    if (DISABLE_IMPOSTORS) return; // Impostors disabled - using dissolve fade instead
    const instanceData = this.chunkInstanceData.get(chunkKey);
    if (!instanceData || instanceData.length === 0) return;

    // Extract asset ID from chunk key (format: "chunkX_chunkZ_assetId")
    const parts = chunkKey.split("_");
    if (parts.length < 3) return;
    const assetId = parts.slice(2).join("_");

    const imposter = this.imposters.get(assetId);
    if (!imposter || !this.octahedralImpostor) return;

    // Check if chunk already has imposters
    if (imposter.chunkInstanceKeys.has(chunkKey)) return;

    // Collect instance keys for efficient iteration later
    const instanceKeys: string[] = [];

    // Create impostor instances for each vegetation in this chunk
    // Each instance gets its own material for correct view-dependent blending
    // plus dissolve support for distance-based fading
    for (const inst of instanceData) {
      const instanceKey = `${chunkKey}_${inst.x.toFixed(1)}_${inst.z.toFixed(1)}`;

      // Create impostor instance with dissolve configuration
      // useTSL: WebGPU (TSL materials) vs WebGL (GLSL materials)
      const impostorInstance = this.octahedralImpostor.createInstance(
        imposter.bakeResult,
        imposter.size * inst.scale,
        {
          dissolve: imposter.dissolveConfig,
          useTSL: this.usesTSL,
          debugMode: VegetationSystem.IMPOSTOR_DEBUG_MODE,
        },
      ) as ImpostorInstanceWithDissolve;

      // Position the impostor mesh
      impostorInstance.mesh.position.set(
        inst.x,
        inst.y + imposter.heightOffset * inst.scale,
        inst.z,
      );
      impostorInstance.mesh.layers.set(1); // Main camera only
      impostorInstance.mesh.name = `VegImposter_${instanceKey}`;

      // Add to scene
      if (this.vegetationGroup) {
        this.vegetationGroup.add(impostorInstance.mesh);
      }

      // Debug: Log first impostor instance per asset for diagnostics
      if (imposter.instances.size === 0) {
        console.log(
          `[VegetationSystem] 🎯 Created first impostor instance for chunk ${chunkKey}:`,
          {
            position: `(${inst.x.toFixed(1)}, ${inst.y.toFixed(1)}, ${inst.z.toFixed(1)})`,
            scale: inst.scale.toFixed(2),
            meshVisible: impostorInstance.mesh.visible,
            materialType: impostorInstance.material?.type ?? "unknown",
            usesTSL: this.usesTSL,
            debugMode: VegetationSystem.IMPOSTOR_DEBUG_MODE,
          },
        );
      }

      // Store instance for later update
      imposter.instances.set(instanceKey, impostorInstance);
      instanceKeys.push(instanceKey);
    }

    // Track all instance keys for this chunk (for efficient chunk-based iteration)
    imposter.chunkInstanceKeys.set(chunkKey, instanceKeys);
  }

  /**
   * Remove a chunk's instances from the octahedral imposter system.
   */
  private removeChunkFromImposter(chunkKey: string): void {
    // Extract asset ID from chunk key
    const parts = chunkKey.split("_");
    if (parts.length < 3) return;
    const assetId = parts.slice(2).join("_");

    const imposter = this.imposters.get(assetId);
    if (!imposter) return;

    // Check if chunk has imposters
    const instanceKeys = imposter.chunkInstanceKeys.get(chunkKey);
    if (!instanceKeys) return;

    // Remove all instances for this chunk using cached keys (O(n) where n = instances in chunk)
    for (const instanceKey of instanceKeys) {
      const impostorInstance = imposter.instances.get(instanceKey);

      if (impostorInstance) {
        // Remove from scene
        if (this.vegetationGroup) {
          this.vegetationGroup.remove(impostorInstance.mesh);
        }

        // Dispose instance
        impostorInstance.dispose();

        // Remove from tracking
        imposter.instances.delete(instanceKey);
      }
    }

    // Remove chunk from tracking
    imposter.chunkInstanceKeys.delete(chunkKey);
  }

  /**
   * Update octahedral imposter billboards with view-dependent blending.
   *
   * Each ImpostorInstance has an update(camera) method that performs raycasting
   * against the octahedral mesh to determine which atlas cells to blend based
   * on the current viewing angle. This provides correct appearance from any
   * camera position.
   *
   * OPTIMIZATION: Limited per frame to prevent jank. Billboard updates are
   * visual polish - slight lag in view-dependent blending is less noticeable
   * than frame drops.
   *
   * NOTE: When DISABLE_IMPOSTORS is true, this function returns immediately.
   */
  private updateImposterBillboards(_cameraX: number, _cameraZ: number): void {
    if (DISABLE_IMPOSTORS) return; // Impostors disabled - using dissolve fade instead
    const camera = this.world.camera;
    if (!camera) return;

    // Check frame budget - billboard updates are visual polish, not critical
    const frameBudget = this.world.frameBudget;
    if (frameBudget && !frameBudget.hasTimeRemaining(1)) {
      return; // Skip this frame to maintain smoothness
    }

    let updatedCount = 0;
    const maxUpdatesPerFrame = 30; // Cap updates to prevent jank

    // OPTIMIZATION: Only update imposters for chunks currently at LOD level 3 (imposter)
    // Skip hidden/culled imposters since they don't need view updates
    for (const chunkKey of this._lastVisibleChunks) {
      if (updatedCount >= maxUpdatesPerFrame) break;

      const state = this.chunkLODStates.get(chunkKey);
      if (!state || state.lodLevel !== 3) continue;

      // Get imposter data for this asset
      const imposterData = this.imposters.get(state.assetId);
      if (!imposterData) continue;

      // Get cached instance keys for this chunk (O(1) lookup + O(n) iteration where n = chunk instances)
      const instanceKeys = imposterData.chunkInstanceKeys.get(chunkKey);
      if (!instanceKeys) continue;

      for (const instanceKey of instanceKeys) {
        if (updatedCount >= maxUpdatesPerFrame) break;
        const instance = imposterData.instances.get(instanceKey);
        if (instance) {
          instance.update(camera);
          updatedCount++;
        }
      }
    }
  }

  /**
   * Process pending tiles that are now within range of the player
   */
  private async processPendingTiles(): Promise<void> {
    if (this.pendingTiles.size === 0) return;

    const playerTile = this.getPlayerTile();
    if (!playerTile) return;

    const currentTileKey = `${playerTile.x}_${playerTile.z}`;

    // Only check if player has moved to a new tile
    if (currentTileKey === this.lastPlayerTileKey) return;
    this.lastPlayerTileKey = currentTileKey;

    // Find pending tiles that are now in range
    const tilesToGenerate: Array<{
      tileX: number;
      tileZ: number;
      biome: string;
    }> = [];

    for (const [key, tileData] of this.pendingTiles) {
      if (this.isTileInRange(tileData.tileX, tileData.tileZ)) {
        tilesToGenerate.push(tileData);
        this.pendingTiles.delete(key);
      }
    }

    // Sort by distance (closest first) and generate
    if (tilesToGenerate.length > 0) {
      tilesToGenerate.sort((a, b) => {
        const distA = Math.max(
          Math.abs(a.tileX - playerTile.x),
          Math.abs(a.tileZ - playerTile.z),
        );
        const distB = Math.max(
          Math.abs(b.tileX - playerTile.x),
          Math.abs(b.tileZ - playerTile.z),
        );
        return distA - distB;
      });

      // Generate one tile per frame to avoid hitches
      const tile = tilesToGenerate[0];
      await this.onTileGenerated(tile);

      // Re-add remaining tiles to pending
      for (let i = 1; i < tilesToGenerate.length; i++) {
        const t = tilesToGenerate[i];
        this.pendingTiles.set(`${t.tileX}_${t.tileZ}`, t);
      }
    }
  }

  /**
   * Configure the vegetation system
   */
  setConfig(config: Partial<VegetationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get statistics about vegetation system
   */
  getStats(): {
    totalAssets: number;
    loadedAssets: number;
    totalInstances: number;
    visibleInstances: number;
    tilesWithVegetation: number;
  } {
    let totalInstances = 0;
    let visibleInstances = 0;

    // Count instances from chunked system
    for (const chunked of this.chunkedMeshes.values()) {
      totalInstances += chunked.count;
      visibleInstances += chunked.mesh.visible ? chunked.mesh.count : 0;
    }

    return {
      totalAssets: this.assetDefinitions.size,
      loadedAssets: this.assetData.size,
      totalInstances,
      visibleInstances,
      tilesWithVegetation: this.tileVegetation.size,
    };
  }

  /**
   * Get detailed render statistics for debugging performance issues
   * Call this from console: world.getSystem('vegetation').getDetailedStats()
   */
  getDetailedStats(): void {
    console.log("=== VEGETATION SYSTEM DETAILED STATS ===");
    console.log(`Asset definitions: ${this.assetDefinitions.size}`);
    console.log(`Loaded asset data: ${this.assetData.size}`);
    console.log(`Tiles with vegetation: ${this.tileVegetation.size}`);
    console.log(`Chunks (LOD0): ${this.chunkedMeshes.size}`);
    console.log(`Chunks (LOD1): ${this.lod1ChunkedMeshes.size}`);
    console.log(`Chunks (LOD2): ${this.lod2ChunkedMeshes.size}`);
    console.log("");

    let totalTriangles = 0;
    let totalVertices = 0;
    let totalInstances = 0;
    let totalVisibleInstances = 0;
    let visibleChunks = 0;

    // Count per-asset stats from chunk data
    const assetStats = new Map<
      string,
      { instances: number; visibleInstances: number }
    >();

    for (const [chunkKey, chunked] of this.chunkedMeshes) {
      const parts = chunkKey.split("_");
      const assetId = parts.length >= 3 ? parts.slice(2).join("_") : "unknown";

      const stats = assetStats.get(assetId) ?? {
        instances: 0,
        visibleInstances: 0,
      };
      stats.instances += chunked.count;
      if (chunked.mesh.visible) {
        stats.visibleInstances += chunked.mesh.count;
        visibleChunks++;
      }
      assetStats.set(assetId, stats);

      // Count geometry stats
      const geo = chunked.mesh.geometry;
      const vertCount = geo.attributes.position?.count ?? 0;
      const indexCount = geo.index?.count ?? vertCount;
      const triCount = Math.floor(indexCount / 3);

      if (chunked.mesh.visible) {
        totalTriangles += triCount * chunked.mesh.count;
        totalVertices += vertCount * chunked.mesh.count;
      }
      totalInstances += chunked.count;
      totalVisibleInstances += chunked.mesh.visible ? chunked.mesh.count : 0;
    }

    console.log("--- Per-Asset Summary ---");
    for (const [assetId, stats] of assetStats) {
      console.log(
        `  ${assetId}: ${stats.instances} total, ${stats.visibleInstances} visible`,
      );
    }

    console.log("");
    console.log("--- Totals ---");
    console.log(
      `Visible chunks: ${visibleChunks} / ${this.chunkedMeshes.size}`,
    );
    console.log(`Total instances: ${totalInstances}`);
    console.log(`Visible instances: ${totalVisibleInstances}`);
    console.log(`Triangles rendered: ${totalTriangles.toLocaleString()}`);
    console.log(`Vertices rendered: ${totalVertices.toLocaleString()}`);
    console.log("============================================");
  }

  override destroy(): void {
    // Set destroyed flag first to stop any pending callbacks
    this.isDestroyed = true;

    // Clear pending processing queues
    this.pendingImposterBakes.length = 0;
    this.pendingLODRebuilds.length = 0;
    this._deferredToImposter.length = 0;
    this._deferredFrom3D.length = 0;
    this._deferredHideChunks.length = 0;
    this.pendingTileRegenerations.clear();
    this.imposterBakeProcessing = false;
    this.lodRebuildProcessing = false;
    this.tileRegenerationProcessing = false;

    // Remove from scene
    if (this.vegetationGroup && this.vegetationGroup.parent) {
      this.vegetationGroup.parent.remove(this.vegetationGroup);
    }

    // Dispose chunked meshes
    for (const chunked of this.chunkedMeshes.values()) {
      this.disposePrimaryChunk(chunked);
      // Material is shared (sharedVegetationMaterial), disposed below
    }
    this.chunkedMeshes.clear();

    // Dispose LOD1 chunked meshes
    for (const chunked of this.lod1ChunkedMeshes.values()) {
      chunked.mesh.geometry.dispose();
    }
    this.lod1ChunkedMeshes.clear();

    // Dispose LOD2 chunked meshes
    for (const chunked of this.lod2ChunkedMeshes.values()) {
      chunked.mesh.geometry.dispose();
    }
    this.lod2ChunkedMeshes.clear();

    // Dispose shared vegetation material
    if (this.sharedVegetationMaterial) {
      this.sharedVegetationMaterial.dispose();
      this.sharedVegetationMaterial = null;
    }

    // Dispose octahedral imposters
    for (const imposterData of this.imposters.values()) {
      // Dispose all impostor instances (each has its own geometry and material)
      for (const [, instance] of imposterData.instances) {
        instance.dispose();
      }
      imposterData.instances.clear();
      imposterData.chunkInstanceKeys.clear();

      // Dispose the bake result's render target
      if (imposterData.bakeResult.renderTarget) {
        imposterData.bakeResult.renderTarget.dispose();
      }
    }
    this.imposters.clear();

    // Dispose octahedral impostor system
    if (this.octahedralImpostor) {
      this.octahedralImpostor.dispose();
      this.octahedralImpostor = null;
    }

    // Clear all tracking maps
    this.chunkLODStates.clear();
    this.chunkInstanceData.clear();
    this.assetData.clear();
    this.tileVegetation.clear();
    this.assetDefinitions.clear();
    this.pendingTiles.clear();
    this.pendingTileRegenerations.clear();
    this._lastVisibleChunks.clear();
    this.tileChunks.clear();
    this.chunkTileRefs.clear();

    // Clear spatial quadtree
    if (this.chunkQuadtree) {
      this.chunkQuadtree.clear();
    }

    this.vegetationGroup = null;
    this.scene = null;
  }
}

export default VegetationSystem;
