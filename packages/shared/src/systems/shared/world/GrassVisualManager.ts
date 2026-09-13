// @ts-nocheck -- TSL type definitions are incomplete for Fn() callbacks and node reassignment
/**
 * GrassVisualManager — Procedural instanced grass clumps aligned with the
 * terrain quad-tree. Each clump is a single geometry containing multiple
 * blades with pre-baked local offsets, rotations and height variation.
 * Each max-depth quad-tree leaf gets one InstancedMesh of clumps.
 *
 * Follows the same QuadTreeListener pattern as WaterVisualManager.
 * CLIENT-ONLY: Only used when USE_QUADTREE_LOD is true.
 */

import THREE, {
  uniform,
  Fn,
  float,
  sin,
  time,
  positionLocal,
  attribute,
  cos,
  uv,
  pow,
  vec3,
  vec4,
  mix,
  smoothstep,
  sub,
  dot,
  clamp,
  mul,
  modelWorldMatrix,
  cameraViewMatrix,
  output,
} from "../../../extras/three/three";
import { SUN_LIGHT } from "./LightingConfig";
import { isCompactSculptProfile } from "./WorldTerrainProfile";
import { createCompactTerrainColorOperations } from "./CompactTerrainPalette";
import type {
  GrassSurfaceEligibility,
  StreamingGrassProfileReceipt,
} from "../../../runtime/clientViewportMode";
import {
  applyAnimeShade,
  TERRAIN_SHADER_CONSTANTS,
  TerrainShadeUniforms,
} from "./TerrainShader";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { faceDirection } from "three/tsl";
import type { TerrainQuadNode, QuadTreeListener } from "./TerrainQuadTree";
import type {
  RetainedTerrainSurface,
  TerrainGridBounds,
} from "./TerrainGridSurface";
import type { RetainedTerrainRegion } from "./TerrainVisualManager";
import {
  GRASS_BLADE_GROUNDING_LIMITS,
  GrassGroundingContinuation,
  type GrassBladeGroundingResult,
} from "./GrassBladeGrounding";
import {
  prepareGroundedGrassSteps,
  type GrassGroundingInputLease,
} from "./GrassGroundingPipeline";
import {
  createGroundedGrassMaterial,
  groundedGrassWorldBox,
} from "./GrassGroundingGpu";
import {
  projectGrassAnchors,
  type GrassGrounding,
} from "./GrassTerrainProjection";
import {
  getGrassWorkerPool,
  terminateGrassWorkerPool,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../utils/workers/GrassWorker";
import type { TerrainWorkerConfig } from "../../../utils/workers/TerrainWorker";
import type { CompactTerrainPlantingLobe } from "./CompactTerrainPalette";
import type { BiomeGrassConfigWorker } from "../../../utils/workers/GrassWorker";
import { assertTerrainWorkerRequest } from "../../../utils/workers/TerrainWorkerShared";
import {
  GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
  type GrassTerrainSurfaceSnapshot,
} from "../../../utils/workers/GrassTerrainSurfaceSnapshot";

// ---------------------------------------------------------------------------
// Configuration — tweak these to control grass appearance & performance
// ---------------------------------------------------------------------------

export const GRASS_CONFIG = {
  // -- Density & distribution -----------------------------------------------
  /** Average distance between clump centers in meters (lower = denser) */
  CLUMP_SPACING: 0.7,

  // -- Clump composition ----------------------------------------------------
  /** Number of blades baked into each clump geometry */
  BLADES_PER_CLUMP: 24,
  /** Outer radius of the clump ring in meters */
  CLUMP_RADIUS: 0.7,
  /** Inner radius ratio (0-1, blades placed between inner*radius and radius) */
  CLUMP_INNER_RATIO: 0.05,

  // -- Blade shape ----------------------------------------------------------
  /** Segments per blade (4 rows of 2 verts + 1 tip = 9 verts) */
  BLADE_SEGMENTS: 3,
  /** Blade width scales with height: width = height * WIDTH_RATIO */
  BLADE_WIDTH_RATIO: 0.04,
  /** Blade min height in world units */
  BLADE_HEIGHT_MIN: 0.45,
  /** Blade max height in world units */
  BLADE_HEIGHT_MAX: 1.15,
  /** Arc curvature ratio (arc distance ≈ height * this) */
  BLADE_ARC_RATIO: 0.18,
  /** Tip taper (0 = rectangle, 1 = full point) */
  BLADE_TAPER: 0.85,

  // -- Per-instance variation -----------------------------------------------
  /** Clump-level scale range */
  SCALE_MIN: 0.7,
  SCALE_MAX: 1.3,

  // -- Wind -----------------------------------------------------------------
  WIND_SPEED: 1.8,
  WIND_STRENGTH: 0.15,

  // -- Color ----------------------------------------------------------------
  /** Gradient power curve (higher = root color persists longer up the blade) */
  GRADIENT_FALLOFF: 1.7,

  // -- Distance limits -------------------------------------------------------
  /** Grass starts shrinking at this distance (meters) */
  FADE_START: 350,
  /** Grass fully invisible / chunks pruned beyond this distance */
  MAX_RENDER_DISTANCE: 500,

  // -- LOD tiers (by distance from camera) ------------------------------------
  LOD_TIERS: [
    { maxDistance: 80, bladesPerClump: 24, bladeSegments: 3, spacingMul: 1.0 },
    { maxDistance: 200, bladesPerClump: 12, bladeSegments: 2, spacingMul: 1.0 },
    {
      maxDistance: 500,
      bladesPerClump: 4,
      bladeSegments: 1,
      spacingMul: 5.0,
    },
  ],
  LOD_HYSTERESIS: 0.1,

  /** Deterministic seed */
  SEED: 73856093,
};

/** Art candidate for the explicit island capture profile, not a global default.
 * Wider, shorter blades retain readable coverage at the existing 12-blade LOD.
 * Placement, blade count, topology and vertex-buffer layout remain unchanged.
 */
export const COMPACT_MEADOW_APPEARANCE = Object.freeze({
  id: "compact-meadow-v1",
  BLADE_HEIGHT_MIN: 0.25,
  BLADE_HEIGHT_MAX: 0.65,
  BLADE_WIDTH_RATIO: 0.1,
  BLADE_ARC_RATIO: 0.32,
  ROOT_BRIGHTNESS: 0.72,
  TIP_BRIGHTNESS: 1.02,
} as const);

/** Dense-profile art candidate. Quadratic centerlines and smoothly varying
 * normals reuse the existing vertex/index and per-blade correction layouts. */
export const CURVED_MEADOW_APPEARANCE = Object.freeze({
  id: "compact-meadow-v2",
  BLADE_HEIGHT_MIN: 0.18,
  BLADE_HEIGHT_MAX: 0.48,
  BLADE_WIDTH_RATIO: 0.08,
  BLADE_ARC_RATIO: 0.65,
  BLADE_CONTROL_HEIGHT: 0.8,
  BLADE_TIP_HEIGHT: 0.84,
  BLADE_NORMAL_WEIGHT: 0.28,
  ROOT_BRIGHTNESS: 0.58,
  TIP_BRIGHTNESS: 1.04,
} as const);

type GrassBladeShape = Pick<
  typeof GRASS_CONFIG,
  | "BLADE_HEIGHT_MIN"
  | "BLADE_HEIGHT_MAX"
  | "BLADE_WIDTH_RATIO"
  | "BLADE_ARC_RATIO"
> & { BLADE_CONTROL_HEIGHT?: number; BLADE_TIP_HEIGHT?: number };

// ---------------------------------------------------------------------------
// Interleave groundColor (vec3) + grassTint (vec4) into a single vertex buffer
// to stay within WebGPU's 8-buffer limit.
// ---------------------------------------------------------------------------

function setColorTintInterleaved(
  geo: THREE.BufferGeometry,
  groundColors: Float32Array,
  grassTints: Float32Array,
  count: number,
): void {
  const stride = 7; // 3 (color) + 4 (tint)
  const buf = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    const s = i * stride;
    const c = i * 3;
    const t = i * 4;
    buf[s] = groundColors[c];
    buf[s + 1] = groundColors[c + 1];
    buf[s + 2] = groundColors[c + 2];
    buf[s + 3] = grassTints[t];
    buf[s + 4] = grassTints[t + 1];
    buf[s + 5] = grassTints[t + 2];
    buf[s + 6] = grassTints[t + 3];
  }
  const ib = new THREE.InstancedInterleavedBuffer(buf, stride);
  geo.setAttribute(
    "instanceGroundColor",
    new THREE.InterleavedBufferAttribute(ib, 3, 0),
  );
  geo.setAttribute(
    "instanceGrassTint",
    new THREE.InterleavedBufferAttribute(ib, 4, 3),
  );
}

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Procedural clump geometry — sunflower-spiral blade arrangement with baked
// arc curvature, per-blade rotation/height/width variation.
// ---------------------------------------------------------------------------

function createClumpGeometry(
  bladesPerClump = GRASS_CONFIG.BLADES_PER_CLUMP,
  bladeSegments = GRASS_CONFIG.BLADE_SEGMENTS,
  shape: GrassBladeShape = GRASS_CONFIG,
): THREE.BufferGeometry {
  const N = bladesPerClump;
  const segs = bladeSegments;
  const { CLUMP_RADIUS, CLUMP_INNER_RATIO, BLADE_TAPER: taper } = GRASS_CONFIG;
  const {
    BLADE_WIDTH_RATIO,
    BLADE_HEIGHT_MIN: hMin,
    BLADE_HEIGHT_MAX: hMax,
    BLADE_ARC_RATIO,
  } = shape;
  const curved = shape.BLADE_CONTROL_HEIGHT !== undefined;
  const controlHeight = shape.BLADE_CONTROL_HEIGHT ?? 0.5;
  const tipHeight = shape.BLADE_TIP_HEIGHT ?? 1;

  const vertsPerBlade = segs * 2 + 1;
  const trisPerBlade = (segs - 1) * 2 + 1;
  const totalVerts = vertsPerBlade * N;
  const totalIdx = trisPerBlade * 3 * N;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint16Array(totalIdx);

  const rng = mulberry32(91827364);
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  let vi = 0;
  let ii = 0;

  for (let b = 0; b < N; b++) {
    const t01 = b / N;
    const angle = b * GOLDEN_ANGLE;
    const rNorm = CLUMP_INNER_RATIO + (1 - CLUMP_INNER_RATIO) * Math.sqrt(t01);
    const r = rNorm * CLUMP_RADIUS;
    const jitter = (rng() - 0.5) * 0.15 * CLUMP_RADIUS;
    const ox = Math.cos(angle) * r + Math.cos(angle + 1.3) * jitter;
    const oz = Math.sin(angle) * r + Math.sin(angle + 1.3) * jitter;

    const facingAngle = angle + Math.PI * 0.5 + (rng() - 0.5) * Math.PI;
    const cr = Math.cos(facingAngle);
    const sr = Math.sin(facingAngle);

    const h = hMin + (hMax - hMin) * (0.3 + 0.7 * t01 + (rng() - 0.5) * 0.4);
    const w = h * BLADE_WIDTH_RATIO;

    const curveAngle = angle + (rng() - 0.5) * Math.PI * 0.6;
    const arcDist = h * BLADE_ARC_RATIO * (0.8 + rng() * 0.4);
    const curveDirX = Math.cos(curveAngle) * arcDist;
    const curveDirZ = Math.sin(curveAngle) * arcDist;

    rng(); // consume one RNG value to keep deterministic sequence stable
    const baseVert = vi;
    const bladeNormal = (t: number) => {
      const dy =
        2 * ((1 - t) * controlHeight + t * (tipHeight - controlHeight)) * h;
      const nx = -sr * dy;
      const ny = sr * 2 * curveDirX * t - cr * 2 * curveDirZ * t;
      const nz = cr * dy;
      const length = Math.hypot(nx, ny, nz);
      return [nx / length, ny / length, nz / length];
    };

    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const y = curved
        ? (2 * (1 - t) * t * controlHeight + t * t * tipHeight) * h
        : t * h;
      const normal = curved ? bladeNormal(t) : [-sr, 0, cr];
      const hw = w * 0.5 * (1.0 - t * taper);
      const arc = t * t;
      const arcX = curveDirX * arc;
      const arcZ = curveDirZ * arc;

      for (let side = 0; side < 2; side++) {
        const lx = side === 0 ? -hw : hw;
        positions[vi * 3] = lx * cr + arcX + ox;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = lx * sr + arcZ + oz;
        normals[vi * 3] = normal[0];
        normals[vi * 3 + 1] = normal[1];
        normals[vi * 3 + 2] = normal[2];
        uvs[vi * 2] = side;
        uvs[vi * 2 + 1] = t;
        vi++;
      }
    }

    positions[vi * 3] = curveDirX + ox;
    positions[vi * 3 + 1] = curved ? h * tipHeight : h;
    positions[vi * 3 + 2] = curveDirZ + oz;
    const tipNormal = curved ? bladeNormal(1) : [-sr, 0, cr];
    normals[vi * 3] = tipNormal[0];
    normals[vi * 3 + 1] = tipNormal[1];
    normals[vi * 3 + 2] = tipNormal[2];
    uvs[vi * 2] = 0.5;
    uvs[vi * 2 + 1] = 1.0;
    vi++;

    for (let i = 0; i < segs - 1; i++) {
      const bv = baseVert + i * 2;
      indices[ii++] = bv;
      indices[ii++] = bv + 1;
      indices[ii++] = bv + 2;
      indices[ii++] = bv + 1;
      indices[ii++] = bv + 3;
      indices[ii++] = bv + 2;
    }
    const lastRow = baseVert + (segs - 1) * 2;
    const tipIdx = baseVert + segs * 2;
    indices[ii++] = lastRow;
    indices[ii++] = lastRow + 1;
    indices[ii++] = tipIdx;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GrassChunk {
  nodeId: number;
  mesh: THREE.InstancedMesh;
  box: THREE.Box3;
  lodLevel: number;
  node: TerrainQuadNode;
}

interface GrassWorkerTicket {
  readonly node: TerrainQuadNode;
  readonly key: string;
  readonly lodLevel: number;
  readonly isLodSwap: boolean;
  readonly surface: RetainedTerrainSurface;
  readonly grounding?: {
    bounds: TerrainGridBounds;
    inputs: GrassGroundingInputLease | null;
    error: unknown;
  };
}

interface GrassGroundingEntry {
  ticket: GrassWorkerTicket;
  region: RetainedTerrainRegion | null;
  job: GrassGroundingContinuation;
}

interface CompletedGrassGrounding {
  region: RetainedTerrainRegion;
  inputs: GrassGroundingInputLease;
}

interface SettledGrassWorkerResult {
  ticket: GrassWorkerTicket;
  data: GrassWorkerOutput;
}

export interface GrassVisualProfile {
  id?: "fixed-arena-v1" | "compact-island-v1" | "compact-meadow-v2";
  eligibility?: GrassSurfaceEligibility;
  /** Multiplies the global spacing without changing deterministic placement. */
  clumpSpacingMultiplier?: number;
  /** Prevents expensive close-up geometry tiers in fixed spectator views. */
  minimumLodLevel?: number;
  maxRenderDistance?: number;
  maxChunksPerFrame?: number;
}

/**
 * Broadcast cameras never enter the grass at player height. Keep the authored
 * coverage, tint, and wind response while avoiding close-player blade geometry
 * that is both visually indistinguishable and expensive in the fixed stream
 * composition.
 */
export const STREAMING_GRASS_VISUAL_PROFILE = {
  id: "fixed-arena-v1",
  clumpSpacingMultiplier: 4,
  minimumLodLevel: 2,
  maxRenderDistance: 140,
  maxChunksPerFrame: 1,
} as const satisfies GrassVisualProfile;

/** Opt-in only. Changing profile requires a new manager, retiring all old tickets. */
export const COMPACT_ISLAND_GRASS_VISUAL_PROFILE = Object.freeze({
  id: "compact-island-v1",
  eligibility: "compact-pbr-v1",
  clumpSpacingMultiplier: 4,
  minimumLodLevel: 1,
  maxRenderDistance: 140,
  maxChunksPerFrame: 1,
} as const satisfies GrassVisualProfile);

/** Independent visual trial; preserves the original profile for comparisons.
 * Same blades, range, shadows and bounded grounding pipeline; more placements.
 */
export const DENSE_MEADOW_GRASS_VISUAL_PROFILE = Object.freeze({
  ...COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
  id: "compact-meadow-v2",
  clumpSpacingMultiplier: 2.5,
} as const satisfies GrassVisualProfile);

export interface GrassVisualReadiness {
  ready: boolean;
  criticalRadius: number;
  requiredChunks: number;
  readyChunks: number;
  pendingChunks: number;
}

// ---------------------------------------------------------------------------
// GrassVisualManager
// ---------------------------------------------------------------------------

/** Config data for the grass worker, passed from TerrainSystem at construction. */
export interface GrassWorkerSetup {
  compactPlantingLobes?: readonly CompactTerrainPlantingLobe[];
  /** Same vegetation-only silhouettes as the worker snapshot. Called after
   * accepted-clump RNG consumption to preserve all unrelated placement. */
  isGrassObstacleAt?: (x: number, z: number) => boolean;
  terrainConfig: TerrainWorkerConfig;
  seed: number;
  biomeCenters: Array<{
    x: number;
    z: number;
    type: string;
    influence: number;
  }>;
  biomes: Record<
    string,
    { heightModifier: number; color: { r: number; g: number; b: number } }
  >;
  grassConfigs: Record<string, BiomeGrassConfigWorker>;
  tileSize: number;
  getRoadSegmentsForRegion: (
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ) => Array<{
    startX: number;
    startZ: number;
    endX: number;
    endZ: number;
    width: number;
  }>;
  getTerrainSurfaceForRegion: (
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ) => GrassTerrainSurfaceSnapshot;
  prepareGroundingInputs?: (
    bounds: TerrainGridBounds,
  ) => GrassGroundingInputLease;
}

export class GrassVisualManager implements QuadTreeListener {
  private container: THREE.Group;
  private getHeightAt: (x: number, z: number) => number;
  private getRoadInfluence: (wx: number, wz: number) => number;
  private isInFlatZone: (wx: number, wz: number) => boolean;
  private getTerrainColorAt: (
    wx: number,
    wz: number,
    eligibility?: GrassSurfaceEligibility,
  ) => {
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
  };
  private sunDirUniform: ReturnType<typeof uniform<THREE.Vector3>>;
  private dayIntensityUniform: ReturnType<typeof uniform<number>>;
  private playerPosUniform: ReturnType<typeof uniform<THREE.Vector3>>;
  private waterThreshold: number;
  private chunks = new Map<string, GrassChunk>();
  private material: MeshStandardNodeMaterial;
  private lodGeometries: THREE.BufferGeometry[];

  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private playerX = 0;
  private playerZ = 0;

  private pendingNodes: { node: TerrainQuadNode; lod?: number }[] = [];
  private settledWorkerResults: SettledGrassWorkerResult[] = [];
  private maxChunksPerFrame: number;
  private clumpSpacing: number;
  private minimumLodLevel: number;
  private maxRenderDistance: number;
  private readonly profileId: StreamingGrassProfileReceipt["profileId"];
  private readonly compactMeadow: boolean;
  private readonly meadowAppearance:
    typeof COMPACT_MEADOW_APPEARANCE | typeof CURVED_MEADOW_APPEARANCE | null;
  private readonly grassEligibility: GrassSurfaceEligibility;

  private workerSetup: GrassWorkerSetup | null = null;
  private workerInflight = new Map<string, GrassWorkerTicket>();
  /** Only tree-owned, living max-depth leaves; geometry destruction retires them. */
  private liveNodes = new Map<string, TerrainQuadNode>();
  /** Includes successful empty chunks so flat arena ground can become ready. */
  private completedNodes = new Map<string, TerrainQuadNode>();
  private completedSurfaces = new Map<string, RetainedTerrainSurface>();
  private groundingJobs = new Map<string, GrassGroundingEntry>();
  private completedGrounding = new Map<string, CompletedGrassGrounding>();
  private groundingHalo = 0;
  private maximumGroundingSliceMs = 0;
  private groundingActiveMs = 0;
  private pendingLodSwap = new Map<
    string,
    { node: TerrainQuadNode; desiredLod: number }
  >();
  private destroyed = false;

  constructor(
    private readonly terrainProfileIdentity: string,
    container: THREE.Group,
    private readonly getRenderedSurface: (
      node: TerrainQuadNode,
    ) => RetainedTerrainSurface | null,
    getHeightAt: (x: number, z: number) => number,
    waterThreshold: number,
    getRoadInfluence: (wx: number, wz: number) => number,
    isInFlatZone: (wx: number, wz: number) => boolean,
    getTerrainColorAt: (
      wx: number,
      wz: number,
      eligibility?: GrassSurfaceEligibility,
    ) => {
      r: number;
      g: number;
      b: number;
      grassWeight: number;
      grassPlacement: number;
      grassHeightScale: number;
    },
    workerSetup?: GrassWorkerSetup,
    profile: GrassVisualProfile = {},
    readonly shadeUniforms: TerrainShadeUniforms = new TerrainShadeUniforms(),
    private readonly getWaterSurfaceAt: (x: number, z: number) => number = () =>
      waterThreshold,
    private readonly captureRenderedRegion?: (
      bounds: TerrainGridBounds,
    ) => RetainedTerrainRegion,
  ) {
    if (typeof terrainProfileIdentity !== "string" || !terrainProfileIdentity) {
      throw new Error("Grass visual terrain profile identity is required");
    }
    if (workerSetup) {
      // No geometry, material or worker pool may be allocated with a different
      // profile from the main-thread terrain callbacks supplied by the caller.
      assertTerrainWorkerRequest(workerSetup.terrainConfig, workerSetup.seed);
      if (
        terrainProfileIdentity !==
        workerSetup.terrainConfig.TERRAIN_PROFILE_IDENTITY
      ) {
        throw new Error(
          "Grass visual provider/worker profile identity mismatch",
        );
      }
      if (
        waterThreshold !== workerSetup.terrainConfig.WATER_THRESHOLD ||
        workerSetup.tileSize !== workerSetup.terrainConfig.TILE_SIZE
      ) {
        throw new Error("Grass visual provider/worker derived config mismatch");
      }
    }
    this.profileId = profile.id ?? "ordinary-v1";
    this.compactMeadow =
      this.profileId === "compact-island-v1" ||
      this.profileId === "compact-meadow-v2";
    this.meadowAppearance =
      this.profileId === "compact-meadow-v2"
        ? CURVED_MEADOW_APPEARANCE
        : this.compactMeadow
          ? COMPACT_MEADOW_APPEARANCE
          : null;
    this.grassEligibility =
      createCompactTerrainColorOperations().grassEligibility(
        profile.eligibility,
        workerSetup?.terrainConfig.TERRAIN_PROFILE.algorithm ?? "",
      );
    if (this.compactMeadow || this.grassEligibility === "compact-pbr-v1") {
      for (const [key, value] of Object.entries(
        this.profileId === "compact-meadow-v2"
          ? DENSE_MEADOW_GRASS_VISUAL_PROFILE
          : COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
      )) {
        if (profile[key] !== value)
          throw new Error(`Compact grass profile mismatch: ${key}`);
      }
    } else if (
      this.profileId !== "ordinary-v1" &&
      this.profileId !== "fixed-arena-v1"
    ) {
      throw new Error("Unknown grass visual profile");
    }
    this.container = container;
    this.getHeightAt = getHeightAt;
    this.waterThreshold = waterThreshold;
    this.getRoadInfluence = getRoadInfluence;
    this.isInFlatZone = isInFlatZone;
    this.getTerrainColorAt = getTerrainColorAt;
    this.workerSetup = workerSetup ?? null;
    this.maxChunksPerFrame = Math.max(
      1,
      Math.floor(profile.maxChunksPerFrame ?? 2),
    );
    this.clumpSpacing =
      GRASS_CONFIG.CLUMP_SPACING *
      Math.max(1, profile.clumpSpacingMultiplier ?? 1);
    this.minimumLodLevel = THREE.MathUtils.clamp(
      Math.floor(profile.minimumLodLevel ?? 0),
      0,
      GRASS_CONFIG.LOD_TIERS.length - 1,
    );
    this.maxRenderDistance = Math.min(
      GRASS_CONFIG.MAX_RENDER_DISTANCE,
      Math.max(
        1,
        profile.maxRenderDistance ?? GRASS_CONFIG.MAX_RENDER_DISTANCE,
      ),
    );

    this.lodGeometries = GRASS_CONFIG.LOD_TIERS.map((tier) =>
      createClumpGeometry(
        tier.bladesPerClump,
        tier.bladeSegments,
        this.meadowAppearance ?? GRASS_CONFIG,
      ),
    );
    this.material = this.createMaterial();
    if (this.compactMeadow) {
      const positions = this.lodGeometries[1].getAttribute("position");
      let radius = 0;
      for (let i = 0; i < positions.count; i++)
        radius = Math.max(
          radius,
          Math.hypot(positions.getX(i), positions.getY(i), positions.getZ(i)),
        );
      // Rotation/tilt preserve radius, fade never increases it. Leave numerical
      // margin and full wind sweep; the old normal-only 0.5m halo is insufficient.
      this.groundingHalo = Math.max(
        GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
        radius * GRASS_BLADE_GROUNDING_LIMITS.maxScale * 1.01 +
          GRASS_CONFIG.WIND_STRENGTH * this.meadowAppearance.BLADE_HEIGHT_MAX +
          0.01,
      );
    }

    const pool = getGrassWorkerPool();
    const workerStatus = pool ? "workers available" : "sync fallback";

    const tierDescs = GRASS_CONFIG.LOD_TIERS.map((t, i) => {
      const g = this.lodGeometries[i];
      return (
        `LOD${i}(${t.bladesPerClump}b/${t.bladeSegments}s, ` +
        `${g.attributes.position.count}v, ${g.index!.count / 3}t, ` +
        `<${t.maxDistance === Infinity ? "inf" : t.maxDistance}m, ` +
        `×${t.spacingMul})`
      );
    });
    console.log(
      `[GrassVisualManager] ${tierDescs.length} LOD tiers | ` +
        `spacing ${this.clumpSpacing}m | min LOD${this.minimumLodLevel} | ` +
        `range ${this.maxRenderDistance}m | ${workerStatus} | ${tierDescs.join(" | ")}`,
    );
  }

  // -- Public API -----------------------------------------------------------

  /** Current owner configuration/counters, not a GPU or visibility qualification. */
  getProfileReceipt(): StreamingGrassProfileReceipt {
    let installedClumps = 0;
    let castShadow = false;
    let correctionBytes = 0;
    for (const { mesh } of this.chunks.values()) {
      installedClumps += mesh.count;
      castShadow ||= mesh.castShadow;
      correctionBytes +=
        mesh.geometry.getAttribute("grassRootDeltas")?.array.byteLength ?? 0;
    }
    let runningChunks = 0,
      waitingSupportChunks = 0,
      failedChunks = 0,
      cancelledChunks = 0;
    for (const { job } of this.groundingJobs.values()) {
      if (job.state.status === "running") runningChunks++;
      else if (job.state.status === "waiting_support") waitingSupportChunks++;
      else if (job.state.status === "cancelled") cancelledChunks++;
      else if (job.state.status !== "ready") failedChunks++;
    }
    return {
      schemaVersion: 1,
      profileId: this.profileId,
      eligibility: this.grassEligibility,
      terrainProfileIdentity: this.terrainProfileIdentity,
      minimumLodLevel: this.minimumLodLevel,
      clumpSpacingMultiplier: this.clumpSpacing / GRASS_CONFIG.CLUMP_SPACING,
      clumpSpacing: this.clumpSpacing,
      maxRenderDistance: this.maxRenderDistance,
      maxChunksPerFrame: this.maxChunksPerFrame,
      castShadow,
      destroyed: this.destroyed,
      liveNodes: this.liveNodes.size,
      pendingChunks: this.pendingNodes.length,
      inflightChunks: this.workerInflight.size,
      settledChunks: this.settledWorkerResults.length,
      installedChunks: this.chunks.size,
      installedClumps,
      ...(this.compactMeadow
        ? {
            grounding: {
              schemaVersion: 1 as const,
              mode: "blade-roots-v1" as const,
              runningChunks,
              waitingSupportChunks,
              failedChunks,
              cancelledChunks,
              completedChunks: this.completedGrounding.size,
              readyEmptyChunks: this.completedGrounding.size - this.chunks.size,
              correctionBytes,
              activeSliceMs: this.groundingActiveMs,
              maximumSliceMs: this.maximumGroundingSliceMs,
            },
          }
        : {}),
    };
  }

  setPlayerPosition(x: number, z: number): void {
    this.playerX = x;
    this.playerZ = z;
  }

  updateLighting(sunDir: THREE.Vector3): void {
    this.sunDirUniform.value.copy(sunDir);
  }

  updateDayIntensity(val: number): void {
    this.dayIntensityUniform.value = val;
  }

  getStreamingReadiness(
    nodes: readonly TerrainQuadNode[],
    criticalRadius = 250,
  ): GrassVisualReadiness {
    const safeRadius = Math.min(
      this.maxRenderDistance,
      Math.max(1, criticalRadius),
    );
    const radiusSquared = safeRadius * safeRadius;
    const requiredNodes = nodes.filter((node) => {
      if (!node.isFinal || !node.isMaxDepth) return false;
      const dx = node.centerX - this.playerX;
      const dz = node.centerZ - this.playerZ;
      return dx * dx + dz * dz <= radiusSquared;
    });
    let readyChunks = 0;
    for (const node of requiredNodes) {
      const key = this.chunkKey(node);
      if (
        this.completedNodes.has(key) &&
        this.completedSurfaces.get(key) === this.getRenderedSurface(node) &&
        (!this.compactMeadow || this.isCompletedGroundingCurrent(key))
      )
        readyChunks++;
    }
    const requiredChunks = requiredNodes.length;
    return {
      ready: requiredChunks > 0 && readyChunks === requiredChunks,
      criticalRadius: safeRadius,
      requiredChunks,
      readyChunks,
      pendingChunks: requiredChunks - readyChunks,
    };
  }

  /** Compile the production instanced-grass vertex layout before it is visible. */
  async precompileRepresentativeChunk(
    precompileObject: (object: THREE.Object3D) => Promise<void>,
  ): Promise<void> {
    const geo = this.lodGeometries[this.minimumLodLevel].clone();
    geo.setAttribute(
      "instanceOffset",
      new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0]), 3),
    );
    geo.setAttribute(
      "instanceRotScaleHash",
      new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 0.5]), 3),
    );
    setColorTintInterleaved(
      geo,
      new Float32Array([0.2, 0.5, 0.1]),
      new Float32Array([0.2, 0.5, 0.1, 0]),
      1,
    );
    geo.setAttribute(
      "instanceGroundNormal",
      new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 0]), 3),
    );

    const material = this.compactMeadow
      ? createGroundedGrassMaterial(
          this.material,
          geo,
          new Float32Array(24),
          1,
          1,
        )
      : this.material;
    const mesh = new THREE.InstancedMesh(geo, material, 1);
    mesh.name = "GrassQT_PrecompileSample";
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.setMatrixAt(0, new THREE.Matrix4());
    mesh.instanceMatrix.needsUpdate = true;

    try {
      await precompileObject(mesh);
    } finally {
      geo.dispose();
      if (material !== this.material) material.dispose();
      mesh.dispose();
    }
  }

  update(playerX: number, playerZ: number, camera?: THREE.Camera): void {
    if (this.destroyed) return;
    this.playerX = playerX;
    this.playerZ = playerZ;
    this.playerPosUniform.value.set(playerX, 0, playerZ);
    this.reconcileGrassHorizon();

    // Worker callbacks only enqueue results. GPU-facing geometry creation is
    // bounded here so several workers settling together cannot upload multiple
    // dense chunks in one render frame.
    let built = this.processSettledWorkerResults();
    if (this.compactMeadow) built += this.advanceGroundingJob();

    // Drain pending queue — dispatch to worker or build sync (fallback only)
    const pool = getGrassWorkerPool();
    let dispatched = 0;
    while (
      this.pendingNodes.length > 0 &&
      built < this.maxChunksPerFrame &&
      dispatched < this.maxChunksPerFrame
    ) {
      const { node, lod } = this.pendingNodes.shift()!;
      if (!this.isNodeInGrassHorizon(node)) continue;
      if (!this.getRenderedSurface(node)) continue;
      const key = this.chunkKey(node);
      if (
        this.chunks.has(key) ||
        this.completedNodes.has(key) ||
        this.workerInflight.has(key) ||
        this.groundingJobs.has(key)
      )
        continue;
      if (pool && this.workerSetup) {
        this.dispatchToWorker(node, key);
        dispatched++;
      } else {
        this.createChunkMesh(node, lod);
        built++;
      }
    }

    if (!camera || this.chunks.size === 0) return;

    this.projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(
      this.projScreenMatrix,
      camera.coordinateSystem,
      camera.reversedDepth,
    );

    const tiers = GRASS_CONFIG.LOD_TIERS;
    const hysteresis = GRASS_CONFIG.LOD_HYSTERESIS;

    for (const [key, chunk] of this.chunks) {
      const dx = chunk.node.centerX - playerX;
      const dz = chunk.node.centerZ - playerZ;
      const distSq = dx * dx + dz * dz;

      // This earlier camera only prioritizes LOD work. Never publish its cull
      // result into Object3D.visible: a later camera/director or secondary pass
      // must test its own frustum against the actual shader-displaced bounds.
      if (
        !this.frustum.intersectsBox(chunk.box) ||
        built >= this.maxChunksPerFrame
      )
        continue;

      const dist = Math.sqrt(distSq);
      const desiredLod = this.getLodLevel(chunk.node);

      if (desiredLod !== chunk.lodLevel) {
        const currentTier = tiers[chunk.lodLevel];
        const boundary =
          desiredLod < chunk.lodLevel
            ? currentTier.maxDistance
            : (tiers[desiredLod - 1]?.maxDistance ?? 0);
        const threshold =
          boundary *
          (1 + (desiredLod < chunk.lodLevel ? -hysteresis : hysteresis));
        const shouldSwitch =
          desiredLod < chunk.lodLevel ? dist < threshold : dist > threshold;

        if (shouldSwitch) {
          const nodeKey = this.chunkKey(chunk.node);
          const workerPool = getGrassWorkerPool();
          if (workerPool && this.workerSetup) {
            this.pendingLodSwap.set(nodeKey, {
              node: chunk.node,
              desiredLod,
            });
            if (
              !this.workerInflight.has(nodeKey) &&
              dispatched < this.maxChunksPerFrame
            ) {
              this.dispatchLodSwap(chunk.node, nodeKey, desiredLod);
              dispatched++;
            }
          } else {
            this.createChunkMesh(chunk.node, desiredLod, true);
            built++;
          }
        }
      } else if (this.pendingLodSwap.has(key)) {
        // The camera returned to the displayed tier before the swap completed.
        // Cancel its ticket; a late result must not replace the correct mesh.
        this.pendingLodSwap.delete(key);
        this.workerInflight.delete(key);
        this.settledWorkerResults = this.settledWorkerResults.filter(
          (entry) => entry.ticket.key !== key,
        );
      }
    }
  }

  private isNodeInGrassHorizon(node: TerrainQuadNode): boolean {
    if (this.destroyed || !node.isFinal || !node.isMaxDepth) return false;
    if (this.liveNodes.get(this.chunkKey(node)) !== node) return false;
    const dx = node.centerX - this.playerX;
    const dz = node.centerZ - this.playerZ;
    return dx * dx + dz * dz <= this.maxRenderDistance * this.maxRenderDistance;
  }

  private retireGrassWork(key: string): void {
    this.workerInflight.delete(key);
    this.pendingLodSwap.delete(key);
    this.completedNodes.delete(key);
    this.completedSurfaces.delete(key);
    this.groundingJobs.get(key)?.job.cancel();
    this.groundingJobs.delete(key);
    this.completedGrounding.delete(key);
    this.retireGrassChunk(key);
  }

  private retireGrassChunk(key: string): void {
    const chunk = this.chunks.get(key);
    if (chunk) {
      if (chunk.mesh.parent) chunk.mesh.parent.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      if (chunk.mesh.material !== this.material) chunk.mesh.material.dispose();
      chunk.mesh.dispose();
      this.chunks.delete(key);
    }
  }

  private isCompletedGroundingCurrent(key: string): boolean {
    const owner = this.completedGrounding.get(key);
    return !!owner && owner.region.isCurrent() && owner.inputs.isCurrent();
  }

  private beginGroundingJob(
    ticket: GrassWorkerTicket,
    data: GrassWorkerOutput,
  ): void {
    let region: RetainedTerrainRegion | null = null;
    let error = ticket.grounding?.error;
    const inputs = ticket.grounding?.inputs;
    try {
      if (!this.captureRenderedRegion || !ticket.grounding)
        throw new Error("Missing compact retained terrain-region owner");
      region = this.captureRenderedRegion(ticket.grounding.bounds);
    } catch (reason) {
      error = reason;
    }
    const manager = this;
    const steps = function* (): Generator<
      string,
      GrassBladeGroundingResult,
      void
    > {
      if (error) throw error;
      if (!region || !inputs || ticket.lodLevel !== 1)
        throw new Error("Incomplete compact grass grounding inputs");
      return yield* prepareGroundedGrassSteps(
        {
          data,
          ownSurface: ticket.surface,
          surfaces: region.surfaces,
          geometry: manager.lodGeometries[1],
          lod: 1,
          oceanLevel: manager.waterThreshold,
          wind: {
            x:
              GRASS_CONFIG.WIND_STRENGTH *
              manager.meadowAppearance.BLADE_HEIGHT_MAX,
            z:
              GRASS_CONFIG.WIND_STRENGTH *
              manager.meadowAppearance.BLADE_HEIGHT_MAX *
              0.55,
          },
        },
        inputs,
        manager.getWaterSurfaceAt,
        manager.isInFlatZone,
      );
    };
    const entry: GrassGroundingEntry = {
      ticket,
      region,
      job: new GrassGroundingContinuation(
        steps(),
        () =>
          this.groundingJobs.get(ticket.key) === entry &&
          this.isNodeInGrassHorizon(ticket.node) &&
          this.getRenderedSurface(ticket.node) === ticket.surface &&
          (!region || region.isCurrent()) &&
          (!inputs || inputs.isCurrent()),
      ),
    };
    this.groundingJobs.get(ticket.key)?.job.cancel();
    this.groundingJobs.set(ticket.key, entry);
  }

  /** One shared compute slice and at most one upload for the entire manager,
   * not one allowance per resident chunk. Stable waits/failures do no work. */
  private advanceGroundingJob(): number {
    for (const entry of this.groundingJobs.values()) {
      if (entry.job.state.status !== "running") continue;
      const before = entry.job.activeMs;
      const state = entry.job.advance();
      this.groundingActiveMs += entry.job.activeMs - before;
      this.maximumGroundingSliceMs = Math.max(
        this.maximumGroundingSliceMs,
        entry.job.maximumSliceMs,
      );
      if (state.status === "failed_input" || state.status === "failed_budget")
        console.error("[GrassVisualManager] Grounding failed:", state);
      if (state.status !== "ready") return 0;
      const { ticket, region } = entry;
      const inputs = ticket.grounding?.inputs;
      if (
        !region ||
        !inputs ||
        !region.isCurrent() ||
        !inputs.isCurrent() ||
        !this.isNodeInGrassHorizon(ticket.node) ||
        this.getRenderedSurface(ticket.node) !== ticket.surface
      )
        return 0;
      try {
        const result = state.result;
        if (!result.grounding)
          throw new Error("Missing blade-grounding provenance");
        this.retireGrassChunk(ticket.key);
        if (result.data.count) {
          this.createChunkMeshFromWorkerData(
            ticket.node,
            {
              ...result.data,
              type: "grassInstanceResult",
              chunkKey: ticket.key,
              terrainProfileIdentity: this.terrainProfileIdentity,
              grassEligibility: this.grassEligibility,
            },
            ticket.lodLevel,
            result.grounding,
            result,
          );
          if (!this.chunks.has(ticket.key))
            throw new Error("Grounded grass was not installed");
        }
        this.completedNodes.set(ticket.key, ticket.node);
        this.completedSurfaces.set(ticket.key, ticket.surface);
        this.completedGrounding.set(ticket.key, { region, inputs });
        this.pendingLodSwap.delete(ticket.key);
        this.groundingJobs.delete(ticket.key);
        return result.data.count ? 1 : 0;
      } catch (error) {
        entry.job.rejectPublication(error);
        console.error(
          "[GrassVisualManager] Grounded grass publication failed:",
          error,
        );
        return 0;
      }
    }
    return 0;
  }

  private reconcileGrassHorizon(): void {
    const pendingKeys = new Set(
      this.pendingNodes.map((entry) => this.chunkKey(entry.node)),
    );
    const retired = new Set<string>();
    for (const [key, node] of this.liveNodes) {
      if (!node.isFinal || !node.isMaxDepth) {
        this.liveNodes.delete(key);
        retired.add(key);
        this.retireGrassWork(key);
        continue;
      }
      if (!this.isNodeInGrassHorizon(node)) {
        if (
          this.chunks.has(key) ||
          this.completedNodes.has(key) ||
          this.workerInflight.has(key) ||
          this.groundingJobs.has(key) ||
          pendingKeys.has(key)
        ) {
          retired.add(key);
          this.retireGrassWork(key);
        }
        continue;
      }
      const surface = this.getRenderedSurface(node);
      const previous =
        this.completedSurfaces.get(key) ??
        this.workerInflight.get(key)?.surface ??
        this.groundingJobs.get(key)?.ticket.surface;
      const groundJob = this.groundingJobs.get(key);
      const constraints =
        this.workerInflight.get(key)?.grounding?.inputs ??
        groundJob?.ticket.grounding?.inputs;
      if (
        (previous && previous !== surface) ||
        (constraints && !constraints.isCurrent()) ||
        (groundJob?.region && !groundJob.region.isCurrent()) ||
        (this.completedGrounding.has(key) &&
          !this.isCompletedGroundingCurrent(key))
      ) {
        this.retireGrassWork(key);
        this.settledWorkerResults = this.settledWorkerResults.filter(
          (entry) => entry.ticket.key !== key,
        );
      }
      if (!surface) continue;
      if (
        !this.chunks.has(key) &&
        !this.completedNodes.has(key) &&
        !this.workerInflight.has(key) &&
        !this.groundingJobs.has(key) &&
        !pendingKeys.has(key)
      ) {
        this.pendingNodes.push({ node });
        pendingKeys.add(key);
      }
    }
    if (retired.size) {
      this.pendingNodes = this.pendingNodes.filter(
        (entry) => !retired.has(this.chunkKey(entry.node)),
      );
      this.settledWorkerResults = this.settledWorkerResults.filter(
        (entry) => !retired.has(entry.ticket.key),
      );
    }
  }

  // -- QuadTreeListener -----------------------------------------------------

  onNodeNeedsGeometry(node: TerrainQuadNode): void {
    if (this.destroyed || !node.isFinal) return;
    if (!node.isMaxDepth) return;
    const key = this.chunkKey(node);
    this.liveNodes.set(key, node);
    if (!this.isNodeInGrassHorizon(node)) return;
    if (
      this.chunks.has(key) ||
      this.completedNodes.has(key) ||
      this.workerInflight.has(key) ||
      this.groundingJobs.has(key)
    )
      return;
    if (!this.pendingNodes.some((entry) => entry.node === node)) {
      this.pendingNodes.push({ node });
    }
  }

  private dispatchLodSwap(
    node: TerrainQuadNode,
    key: string,
    desiredLod: number,
  ): void {
    this.dispatchWorkerRequest(node, key, desiredLod, true);
  }

  private dispatchToWorker(node: TerrainQuadNode, key: string): void {
    this.dispatchWorkerRequest(node, key, this.getLodLevel(node), false);
  }

  private createWorkerInput(
    node: TerrainQuadNode,
    key: string,
    lodLevel: number,
  ): GrassWorkerInput {
    const ws = this.workerSetup!;
    const half = node.halfSize;
    const normalHalo = GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE;
    return {
      grassEligibility: this.grassEligibility,
      type: "generateGrassInstances",
      compactPlantingLobes: ws.compactPlantingLobes,
      chunkKey: key,
      centerX: node.centerX,
      centerZ: node.centerZ,
      size: node.size,
      spacingMul: GRASS_CONFIG.LOD_TIERS[lodLevel].spacingMul,
      config: ws.terrainConfig,
      seed: ws.seed,
      biomeCenters: ws.biomeCenters,
      biomes: ws.biomes,
      grassSeed: GRASS_CONFIG.SEED,
      clumpSpacing: this.clumpSpacing,
      scaleMin: GRASS_CONFIG.SCALE_MIN,
      scaleMax: GRASS_CONFIG.SCALE_MAX,
      waterThreshold: this.waterThreshold,
      grassConfigs: ws.grassConfigs,
      shaderConstants: {
        NOISE_SCALE: TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
        DISTORT_NOISE_SCALE: TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
        VARIATION_NOISE_SCALE: TERRAIN_SHADER_CONSTANTS.VARIATION_NOISE_SCALE,
        ROCK_DISTORT_STRENGTH: TERRAIN_SHADER_CONSTANTS.ROCK_DISTORT_STRENGTH,
        HEIGHT_DISTORT_STRENGTH:
          TERRAIN_SHADER_CONSTANTS.HEIGHT_DISTORT_STRENGTH,
        DIRT_THRESHOLD: TERRAIN_SHADER_CONSTANTS.DIRT_THRESHOLD,
        SATURATION_BOOST: TERRAIN_SHADER_CONSTANTS.SATURATION_BOOST,
      },
      roadSegments: ws.getRoadSegmentsForRegion(
        node.centerX - half,
        node.centerZ - half,
        node.centerX + half,
        node.centerZ + half,
      ),
      roadBlendWidth: 0.5,
      tileSize: ws.tileSize,
      terrainSurface: ws.getTerrainSurfaceForRegion(
        node.centerX - half - normalHalo,
        node.centerZ - half - normalHalo,
        node.centerX + half + normalHalo,
        node.centerZ + half + normalHalo,
      ),
    };
  }

  private createWorkerTicket(
    node: TerrainQuadNode,
    key: string,
    lodLevel: number,
    isLodSwap: boolean,
  ): GrassWorkerTicket {
    const surface = this.getRenderedSurface(node);
    if (
      !surface ||
      surface.nodeId !== node.id ||
      surface.terrainProfileIdentity !== this.terrainProfileIdentity
    )
      throw new Error("Grass requires the current retained terrain surface");
    let grounding: GrassWorkerTicket["grounding"];
    if (this.compactMeadow) {
      const half = node.halfSize + this.groundingHalo;
      const bounds = Object.freeze({
        minX: node.centerX - half,
        maxX: node.centerX + half,
        minZ: node.centerZ - half,
        maxZ: node.centerZ + half,
      });
      let inputs: GrassGroundingInputLease | null = null,
        error: unknown = null;
      try {
        if (!this.workerSetup?.prepareGroundingInputs)
          throw new Error("Missing compact grass constraint owner");
        inputs = this.workerSetup.prepareGroundingInputs(bounds);
      } catch (reason) {
        error = reason;
      }
      grounding = { bounds, inputs, error };
    }
    const ticket = Object.freeze({
      node,
      key,
      lodLevel,
      isLodSwap,
      surface,
      ...(grounding ? { grounding } : {}),
    });
    this.workerInflight.set(key, ticket);
    return ticket;
  }

  private isCurrentWorkerTicket(ticket: GrassWorkerTicket): boolean {
    return !this.destroyed && this.workerInflight.get(ticket.key) === ticket;
  }

  private settleWorkerResult(
    ticket: GrassWorkerTicket,
    output: GrassWorkerOutput,
  ): void {
    if (!this.isCurrentWorkerTicket(ticket)) return;
    if (
      this.getRenderedSurface(ticket.node) !== ticket.surface ||
      (ticket.grounding?.inputs && !ticket.grounding.inputs.isCurrent())
    ) {
      this.workerInflight.delete(ticket.key);
      this.pendingLodSwap.delete(ticket.key);
      return;
    }
    if (!this.isNodeInGrassHorizon(ticket.node)) {
      this.workerInflight.delete(ticket.key);
      this.pendingLodSwap.delete(ticket.key);
      return;
    }
    this.assertWorkerProfileIdentity(output);
    if (output.chunkKey !== ticket.key) {
      throw new Error("Grass visual result chunk key mismatch");
    }
    this.settledWorkerResults.push({ ticket, data: output });
  }

  private rejectWorkerResult(ticket: GrassWorkerTicket, error: unknown): void {
    if (!this.isCurrentWorkerTicket(ticket)) return;
    this.workerInflight.delete(ticket.key);
    this.pendingLodSwap.delete(ticket.key);
    console.warn(
      `[GrassVisualManager] Worker failed for ${ticket.key}:`,
      error,
    );
    if (
      !ticket.isLodSwap &&
      this.isNodeInGrassHorizon(ticket.node) &&
      !this.chunks.has(ticket.key) &&
      !this.pendingNodes.some((entry) => entry.node === ticket.node)
    ) {
      this.pendingNodes.push({ node: ticket.node });
    }
  }

  private dispatchWorkerRequest(
    node: TerrainQuadNode,
    key: string,
    lodLevel: number,
    isLodSwap: boolean,
  ): void {
    if (!this.isNodeInGrassHorizon(node) || this.workerInflight.has(key))
      return;
    if (!this.getRenderedSurface(node)) return;
    const pool = getGrassWorkerPool()!;
    const input = this.createWorkerInput(node, key, lodLevel);
    const ticket = this.createWorkerTicket(node, key, lodLevel, isLodSwap);
    try {
      pool
        .execute(input)
        .then((output: GrassWorkerOutput) =>
          this.settleWorkerResult(ticket, output),
        )
        .catch((error: unknown) => this.rejectWorkerResult(ticket, error));
    } catch (error) {
      this.rejectWorkerResult(ticket, error);
    }
  }

  private assertWorkerProfileIdentity(data: GrassWorkerOutput): void {
    if (data.terrainProfileIdentity !== this.terrainProfileIdentity) {
      throw new Error("Grass visual result profile identity mismatch");
    }
    if ((data.grassEligibility ?? "legacy-biome-v1") !== this.grassEligibility)
      throw new Error("Grass visual result eligibility mismatch");
  }

  private createChunkMeshFromWorkerData(
    node: TerrainQuadNode,
    data: GrassWorkerOutput,
    lodLevel: number,
    grounding: GrassGrounding,
    blades?: Extract<GrassBladeGroundingResult, { status: "ready" }>,
  ): void {
    this.assertWorkerProfileIdentity(data);
    if (!this.isNodeInGrassHorizon(node)) return;
    const key = data.chunkKey;
    if (this.chunks.has(key)) return;
    if (data.count === 0) return;
    if (
      this.compactMeadow &&
      (!blades ||
        !blades.grounding ||
        blades.data.count !== data.count ||
        grounding !== blades.grounding)
    )
      throw new Error(
        "Compact grass requires complete blade grounding and provenance",
      );

    const geo = this.lodGeometries[lodLevel].clone();
    let material = this.material;
    let mesh: THREE.InstancedMesh | null = null;
    try {
      geo.setAttribute(
        "instanceOffset",
        new THREE.InstancedBufferAttribute(data.offsets, 3),
      );
      geo.setAttribute(
        "instanceRotScaleHash",
        new THREE.InstancedBufferAttribute(data.rotScaleHash, 3),
      );
      setColorTintInterleaved(
        geo,
        data.groundColors,
        data.grassTints,
        data.count,
      );
      geo.setAttribute(
        "instanceGroundNormal",
        new THREE.InstancedBufferAttribute(data.groundNormals, 3),
      );

      if (blades)
        material = createGroundedGrassMaterial(
          this.material,
          geo,
          blades.rootDeltas,
          data.count,
          lodLevel,
        );
      mesh = new THREE.InstancedMesh(geo, material, data.count);
      mesh.position.set(node.centerX, 0, node.centerZ);
      mesh.name = `GrassQT_${key}`;
      mesh.frustumCulled = true;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.userData = {
        type: "grass",
        walkable: false,
        clickable: false,
        grassGrounding: grounding,
        ...(blades
          ? {
              grassBladeGrounding: {
                schemaVersion: 1,
                ...blades.receipt,
                sweptBounds: blades.sweptBounds,
                sourceIndices: blades.sourceIndices,
                surfaceRevisions: blades.dependencies.map(
                  ({ surface }) => surface.revision,
                ),
              },
            }
          : {}),
        grassAppearance: this.meadowAppearance?.id ?? "legacy-blades-v1",
      };

      const identity = new THREE.Matrix4();
      for (let i = 0; i < data.count; i++) {
        mesh.setMatrixAt(i, identity);
      }
      mesh.instanceMatrix.needsUpdate = true;

      const half = node.halfSize;
      const box = blades
        ? groundedGrassWorldBox(blades)
        : new THREE.Box3(
            new THREE.Vector3(node.centerX - half, -50, node.centerZ - half),
            new THREE.Vector3(node.centerX + half, 200, node.centerZ + half),
          );

      // Instance matrices are intentionally identity; the vertex shader places
      // clumps and grounded roots. Default geometry/instance bounds therefore
      // cannot describe this chunk. Use the full accepted wind-swept envelope
      // in r186's per-render-pass culling hook, including any prepared parent
      // transform, without allocating or updating matrices during rendering.
      const localBounds = box.clone().translate(mesh.position.clone().negate());
      const renderedBounds = new THREE.Box3();
      mesh.boundingBox = localBounds;
      mesh.boundingSphere = localBounds.getBoundingSphere(new THREE.Sphere());
      mesh.intersectsFrustum = (frustum) =>
        frustum.intersectsBox(
          renderedBounds.copy(localBounds).applyMatrix4(mesh.matrixWorld),
        );

      this.container.add(mesh);
      this.chunks.set(key, { nodeId: node.id, mesh, box, lodLevel, node });
    } catch (error) {
      mesh?.removeFromParent();
      geo.dispose();
      if (material !== this.material) material.dispose();
      mesh?.dispose();
      throw error;
    }
  }

  private processSettledWorkerResults(): number {
    let built = 0;
    let queued = 0;
    while (
      this.settledWorkerResults.length > 0 &&
      built < this.maxChunksPerFrame &&
      queued < this.maxChunksPerFrame
    ) {
      const result = this.settledWorkerResults.shift()!;
      const ticket = result.ticket;
      // Identity precedes every mutation: an obsolete result must never clear
      // a newer request at the same spatial key, even when the old result is empty.
      if (!this.isCurrentWorkerTicket(ticket)) continue;
      if (
        this.getRenderedSurface(ticket.node) !== ticket.surface ||
        (ticket.grounding?.inputs && !ticket.grounding.inputs.isCurrent())
      ) {
        this.workerInflight.delete(ticket.key);
        this.pendingLodSwap.delete(ticket.key);
        continue;
      }
      if (!this.isNodeInGrassHorizon(ticket.node)) {
        this.workerInflight.delete(ticket.key);
        this.pendingLodSwap.delete(ticket.key);
        this.completedNodes.delete(ticket.key);
        this.completedSurfaces.delete(ticket.key);
        continue;
      }

      try {
        this.assertWorkerProfileIdentity(result.data);
        if (result.data.chunkKey !== ticket.key) {
          throw new Error("Grass visual result chunk key mismatch");
        }
      } catch (error) {
        // Reject before marking even an empty result ready, or disposing a
        // previously valid LOD mesh. No stale geometry enters the scene.
        console.error("[GrassVisualManager] Rejected worker result:", error);
        this.workerInflight.delete(ticket.key);
        this.pendingLodSwap.delete(ticket.key);
        continue;
      }

      if (this.compactMeadow) {
        this.workerInflight.delete(ticket.key);
        this.beginGroundingJob(ticket, result.data);
        queued++;
        continue;
      }
      this.workerInflight.delete(ticket.key);
      const latest = this.pendingLodSwap.get(ticket.key);
      const currentLod = ticket.isLodSwap
        ? this.getLodLevel(ticket.node)
        : ticket.lodLevel;
      if (
        ticket.isLodSwap &&
        (currentLod !== ticket.lodLevel ||
          (latest && latest.desiredLod !== ticket.lodLevel))
      ) {
        // This output contains the captured tier's spacing and clump instances.
        // Recheck the camera before disposal: update drains results before its
        // ordinary LOD loop, and the camera may have moved since the last frame.
        if (currentLod === this.chunks.get(ticket.key)?.lodLevel) {
          this.pendingLodSwap.delete(ticket.key);
        } else {
          this.pendingLodSwap.set(ticket.key, {
            node: ticket.node,
            desiredLod: currentLod,
          });
        }
        continue;
      }
      this.pendingLodSwap.delete(ticket.key);
      if (result.data.count > 0) built++;
      let projected;
      try {
        projected = projectGrassAnchors(
          result.data,
          ticket.surface,
          this.getWaterSurfaceAt,
          this.isInFlatZone,
        );
      } catch (error) {
        console.error(
          "[GrassVisualManager] Rejected terrain projection:",
          error,
        );
        continue;
      }
      // Nonempty projections consume the install budget even if every anchor
      // was rejected by water/exclusion. Otherwise failed coverage is unbounded.
      if (ticket.isLodSwap) {
        this.retireGrassChunk(ticket.key);
      } else if (this.chunks.has(ticket.key)) {
        this.completedNodes.set(ticket.key, ticket.node);
        continue;
      }

      if (projected.count === 0) {
        this.completedNodes.set(ticket.key, ticket.node);
        this.completedSurfaces.set(ticket.key, ticket.surface);
        continue;
      }
      this.createChunkMeshFromWorkerData(
        ticket.node,
        projected,
        ticket.lodLevel,
        projected.grounding,
      );
      this.completedNodes.set(ticket.key, ticket.node);
      this.completedSurfaces.set(ticket.key, ticket.surface);
    }
    return built;
  }

  onNodeDestroyGeometry(node: TerrainQuadNode): void {
    const key = this.chunkKey(node);
    this.liveNodes.delete(key);
    this.retireGrassWork(key);
    this.settledWorkerResults = this.settledWorkerResults.filter(
      (entry) => entry.ticket.key !== key,
    );
    this.pendingNodes = this.pendingNodes.filter(
      (entry) => entry.node !== node,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pendingNodes.length = 0;
    this.settledWorkerResults.length = 0;
    this.workerInflight.clear();
    this.liveNodes.clear();
    this.completedNodes.clear();
    this.completedSurfaces.clear();
    for (const entry of this.groundingJobs.values()) entry.job.cancel();
    this.groundingJobs.clear();
    this.completedGrounding.clear();
    this.pendingLodSwap.clear();
    terminateGrassWorkerPool();
    for (const key of this.chunks.keys()) this.retireGrassChunk(key);
    this.lodGeometries.forEach((g) => g.dispose());
    if (this.material) this.material.dispose();
    if (this.container.parent) this.container.parent.remove(this.container);
  }

  /**
   * Destroy and recreate all grass chunks (e.g. after road data loads).
   */
  rebuildAllChunks(): void {
    if (this.destroyed) return;
    const nodes = new Map(this.completedNodes);
    for (const [key, entry] of this.groundingJobs)
      nodes.set(key, entry.ticket.node);
    for (const [key, ticket] of this.workerInflight)
      nodes.set(key, ticket.node);
    for (const entry of this.pendingNodes)
      nodes.set(this.chunkKey(entry.node), entry.node);
    for (const [key, chunk] of this.chunks) {
      nodes.set(key, chunk.node);
      this.retireGrassChunk(key);
    }
    for (const entry of this.groundingJobs.values()) entry.job.cancel();
    this.groundingJobs.clear();
    this.completedGrounding.clear();
    this.completedNodes.clear();
    this.completedSurfaces.clear();
    this.workerInflight.clear();
    this.pendingLodSwap.clear();
    this.settledWorkerResults.length = 0;
    this.pendingNodes.length = 0;
    for (const node of nodes.values()) {
      if (this.isNodeInGrassHorizon(node)) {
        this.pendingNodes.push({ node });
      }
    }
  }

  /**
   * Invalidate grass chunks that overlap a world-space bounding box.
   * Used when flat zones are registered/unregistered so grass regenerates
   * with correct heights and placement.
   */
  invalidateRegion(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): void {
    if (this.destroyed) return;
    const candidates = new Map(this.completedNodes);
    for (const [key, entry] of this.groundingJobs)
      candidates.set(key, entry.ticket.node);
    for (const [key, chunk] of this.chunks) candidates.set(key, chunk.node);
    // Pending work may have no mesh/completed record yet. It still sampled the
    // old surface and must lose ownership before replacement work can begin.
    for (const [key, ticket] of this.workerInflight)
      candidates.set(key, ticket.node);
    for (const entry of this.pendingNodes)
      candidates.set(this.chunkKey(entry.node), entry.node);

    const affectedKeys = new Set<string>();
    const toRebuild: TerrainQuadNode[] = [];
    for (const [key, node] of candidates) {
      const half =
        node.halfSize +
        Math.max(GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE, this.groundingHalo);
      if (
        node.centerX + half < minX ||
        node.centerX - half > maxX ||
        node.centerZ + half < minZ ||
        node.centerZ - half > maxZ
      )
        continue;
      affectedKeys.add(key);
      this.retireGrassWork(key);
      if (this.isNodeInGrassHorizon(node)) toRebuild.push(node);
    }
    this.settledWorkerResults = this.settledWorkerResults.filter(
      (entry) => !affectedKeys.has(entry.ticket.key),
    );
    this.pendingNodes = this.pendingNodes.filter(
      (entry) => !affectedKeys.has(this.chunkKey(entry.node)),
    );
    for (const node of toRebuild) this.pendingNodes.push({ node });
  }

  // -- LOD helpers -----------------------------------------------------------

  private getLodLevel(node: TerrainQuadNode): number {
    const dx = node.centerX - this.playerX;
    const dz = node.centerZ - this.playerZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const tiers = GRASS_CONFIG.LOD_TIERS;
    for (let i = this.minimumLodLevel; i < tiers.length; i++) {
      if (dist < tiers[i].maxDistance) return i;
    }
    return tiers.length - 1;
  }

  // -- Chunk mesh creation --------------------------------------------------

  private createChunkMesh(
    node: TerrainQuadNode,
    lodLevel?: number,
    replace = false,
  ): void {
    if (!this.isNodeInGrassHorizon(node)) return;
    const key = this.chunkKey(node);
    if (this.chunks.has(key) && !replace) return;
    const surface = this.getRenderedSurface(node);
    if (!surface) return;
    if (
      surface.nodeId !== node.id ||
      surface.terrainProfileIdentity !== this.terrainProfileIdentity
    )
      throw new Error("Grass requires the current retained terrain surface");
    const lod = lodLevel ?? this.getLodLevel(node);
    const tier = GRASS_CONFIG.LOD_TIERS[lod];
    const instanceData = this.generateInstanceData(node, tier.spacingMul);
    if (this.compactMeadow) {
      const ticket = this.createWorkerTicket(node, key, lod, replace);
      this.settleWorkerResult(ticket, {
        count: 0,
        offsets: new Float32Array(0),
        rotScaleHash: new Float32Array(0),
        groundColors: new Float32Array(0),
        grassTints: new Float32Array(0),
        groundNormals: new Float32Array(0),
        ...instanceData,
        type: "grassInstanceResult",
        chunkKey: key,
        terrainProfileIdentity: this.terrainProfileIdentity,
        grassEligibility: this.grassEligibility,
      });
      return;
    }
    let projected;
    if (instanceData) {
      projected = projectGrassAnchors(
        {
          ...instanceData,
          type: "grassInstanceResult" as const,
          chunkKey: key,
          terrainProfileIdentity: this.terrainProfileIdentity,
          grassEligibility: this.grassEligibility,
        },
        surface,
        this.getWaterSurfaceAt,
        this.isInFlatZone,
      );
    }
    if (replace) {
      this.retireGrassChunk(key);
    }
    if (projected?.count)
      this.createChunkMeshFromWorkerData(
        node,
        projected,
        lod,
        projected.grounding,
      );
    this.completedNodes.set(key, node);
    this.completedSurfaces.set(key, surface);
  }

  // -- Instance data generation ---------------------------------------------

  private generateInstanceData(
    node: TerrainQuadNode,
    spacingMul = 1,
  ): {
    offsets: Float32Array;
    rotScaleHash: Float32Array;
    groundColors: Float32Array;
    grassTints: Float32Array;
    groundNormals: Float32Array;
    count: number;
  } | null {
    const spacing = this.clumpSpacing * spacingMul;
    const maxCount = Math.ceil((node.size * node.size) / (spacing * spacing));
    const rng = mulberry32(
      GRASS_CONFIG.SEED ^
        ((node.centerX * 374761393 + node.centerZ * 668265263) | 0),
    );

    const offsets = new Float32Array(maxCount * 3);
    const rotScaleHash = new Float32Array(maxCount * 3);
    const groundColors = new Float32Array(maxCount * 3);
    const grassTints = new Float32Array(maxCount * 4);
    const groundNormals = new Float32Array(maxCount * 3);

    let count = 0;

    for (let i = 0; i < maxCount; i++) {
      const lx = (rng() - 0.5) * node.size;
      const lz = (rng() - 0.5) * node.size;
      const clumpRng = rng();

      const wx = node.centerX + lx;
      const wz = node.centerZ + lz;
      const ty = this.getHeightAt(wx, wz);

      if (ty < this.getWaterSurfaceAt(wx, wz) + 0.1) continue;

      if (this.isInFlatZone(wx, wz)) continue;

      const roadInf = this.getRoadInfluence(wx, wz);
      if (roadInf > 0.8) continue;

      const {
        r,
        g,
        b,
        grassPlacement: rawGP,
        grassHeightScale,
        tintR,
        tintG,
        tintB,
        tintStrength,
        nx,
        ny,
        nz,
      } = this.getTerrainColorAt(wx, wz, this.grassEligibility);
      const grassPlacement = Math.max(0, rawGP - roadInf);

      if (grassPlacement <= 0) continue;
      if (clumpRng > grassPlacement) continue;

      offsets[count * 3] = lx;
      offsets[count * 3 + 1] = ty;
      offsets[count * 3 + 2] = lz;

      const rotation = rng() * Math.PI * 2;
      if (this.workerSetup?.isGrassObstacleAt?.(wx, wz)) continue;
      const scale =
        (GRASS_CONFIG.SCALE_MIN +
          clumpRng * (GRASS_CONFIG.SCALE_MAX - GRASS_CONFIG.SCALE_MIN)) *
        grassHeightScale;
      rotScaleHash[count * 3] = rotation;
      rotScaleHash[count * 3 + 1] = scale;
      rotScaleHash[count * 3 + 2] = clumpRng;

      groundColors[count * 3] = r;
      groundColors[count * 3 + 1] = g;
      groundColors[count * 3 + 2] = b;

      grassTints[count * 4] = tintR;
      grassTints[count * 4 + 1] = tintG;
      grassTints[count * 4 + 2] = tintB;
      grassTints[count * 4 + 3] = tintStrength;

      groundNormals[count * 3] = nx;
      groundNormals[count * 3 + 1] = ny;
      groundNormals[count * 3 + 2] = nz;

      count++;
    }

    if (count === 0) return null;

    return {
      offsets: offsets.slice(0, count * 3),
      rotScaleHash: rotScaleHash.slice(0, count * 3),
      groundColors: groundColors.slice(0, count * 3),
      grassTints: grassTints.slice(0, count * 4),
      groundNormals: groundNormals.slice(0, count * 3),
      count,
    };
  }

  // -- TSL Material ---------------------------------------------------------

  private createMaterial(): MeshStandardNodeMaterial {
    const compactMeadow = this.compactMeadow;
    const appearance = this.meadowAppearance;
    // The validated terrain owner selects lighting, independently of blade
    // shape/density. Callers without that owner retain their legacy graph.
    const terrainProfile = this.workerSetup?.terrainConfig.TERRAIN_PROFILE;
    const compactPhysical =
      terrainProfile?.kind === "compact-candidate" &&
      isCompactSculptProfile(terrainProfile);
    const mat = new MeshStandardNodeMaterial();
    mat.name = appearance?.id ?? "legacy-blades-v1";
    mat.side = THREE.DoubleSide;
    mat.transparent = false;
    mat.depthWrite = true;
    mat.roughness = 1.0;
    mat.metalness = 0.0;
    mat.fog = false;

    const uWindSpeed = uniform(GRASS_CONFIG.WIND_SPEED);
    const uWindStrength = uniform(GRASS_CONFIG.WIND_STRENGTH);
    const uBladeHeight = uniform(
      appearance?.BLADE_HEIGHT_MAX ?? GRASS_CONFIG.BLADE_HEIGHT_MAX,
    );
    this.sunDirUniform = uniform(
      new THREE.Vector3(...SUN_LIGHT.DEFAULT_DIRECTION),
    );
    this.dayIntensityUniform = uniform(1.0);
    this.playerPosUniform = uniform(new THREE.Vector3(0, 0, 0));

    const uPlayerPos = this.playerPosUniform;
    const uFadeStart = float(
      Math.min(GRASS_CONFIG.FADE_START, this.maxRenderDistance * 0.8),
    );
    const uFadeEnd = float(this.maxRenderDistance);

    mat.positionNode = Fn(() => {
      const localPos = positionLocal.toVar("gp");

      const offset = attribute("instanceOffset", "vec3");
      const rsh = attribute("instanceRotScaleHash", "vec3");
      const rot = rsh.x;
      const scale = rsh.y;

      const t = uv().y;

      // Compute world-space XZ of the instance base for distance fade.
      // offset is chunk-local; modelWorldMatrix translates by mesh.position (chunk center).
      const worldBase = modelWorldMatrix.mul(
        vec4(offset.x, float(0), offset.z, float(1.0)),
      );
      const toPlayer = sub(
        vec3(worldBase.x, float(0), worldBase.z),
        vec3(uPlayerPos.x, float(0), uPlayerPos.z),
      );
      const distSq = dot(toPlayer, toPlayer);
      const dist = pow(distSq, float(0.5));
      const fadeFactor = clamp(
        sub(float(1.0), smoothstep(uFadeStart, uFadeEnd, dist)),
        float(0.0),
        float(1.0),
      );

      // Scale entire clump (with distance fade on Y)
      localPos.x.assign(localPos.x.mul(scale));
      localPos.y.assign(localPos.y.mul(scale).mul(fadeFactor));
      localPos.z.assign(localPos.z.mul(scale));

      // Rotate entire clump around Y — snapshot x/z first because TSL assign
      // is sequential in WGSL (second assign would read the modified first).
      const cosR = cos(rot);
      const sinR = sin(rot);
      const preRotX = localPos.x.toVar("preRotX");
      const preRotZ = localPos.z.toVar("preRotZ");
      localPos.x.assign(preRotX.mul(cosR).sub(preRotZ.mul(sinR)));
      localPos.z.assign(preRotX.mul(sinR).add(preRotZ.mul(cosR)));

      // Tilt grass to align with terrain slope (axis-angle rotation from Y-up to ground normal).
      // Uses Rodrigues' rotation matrix with axis = cross((0,1,0), N) = (nz, 0, -nx).
      // The 1/(1+ny) substitution avoids acos/sin and has no singularity for upward-facing normals.
      const gn = attribute("instanceGroundNormal", "vec3");
      const nx = gn.x;
      const ny = gn.y;
      const nz = gn.z;
      const invOnePlusNy = float(1.0).div(ny.add(float(1.0)));
      const nxnzTerm = nx.mul(nz).mul(invOnePlusNy).negate();

      const preTiltX = localPos.x.toVar("preTiltX");
      const preTiltY = localPos.y.toVar("preTiltY");
      const preTiltZ = localPos.z.toVar("preTiltZ");

      localPos.x.assign(
        preTiltX
          .mul(ny.add(nz.mul(nz).mul(invOnePlusNy)))
          .add(preTiltY.mul(nx))
          .add(preTiltZ.mul(nxnzTerm)),
      );
      localPos.y.assign(
        preTiltX
          .mul(nx.negate())
          .add(preTiltY.mul(ny))
          .add(preTiltZ.mul(nz.negate())),
      );
      localPos.z.assign(
        preTiltX
          .mul(nxnzTerm)
          .add(preTiltY.mul(nz))
          .add(preTiltZ.mul(ny.add(nx.mul(nx).mul(invOnePlusNy)))),
      );

      // Wind: displace tips via sine waves keyed to world-space offset
      const wt = time.mul(uWindSpeed);
      const bendFactor = pow(t, float(1.8));
      localPos.x.addAssign(
        sin(wt.add(offset.x.mul(0.35)).add(offset.z.mul(0.12)))
          .mul(uWindStrength)
          .mul(bendFactor)
          .mul(uBladeHeight),
      );
      localPos.z.addAssign(
        sin(
          wt.mul(0.67).add(offset.x.mul(0.18)).add(offset.z.mul(0.28)).add(2.0),
        )
          .mul(uWindStrength)
          .mul(0.55)
          .mul(bendFactor)
          .mul(uBladeHeight),
      );

      // Translate to instance world position (chunk-local XZ + baked terrainY)
      localPos.x.addAssign(offset.x);
      localPos.y.addAssign(offset.y);
      localPos.z.addAssign(offset.z);

      return localPos;
    })();

    const uSunDir = this.sunDirUniform;
    const terrainNormal = attribute("instanceGroundNormal", "vec3");

    // Override PBR surface normal to terrain normal (world→view transform).
    // mat4.transformDirection(vec3) is left-multiply: matrixWorldInverse * normal
    // = correct world→view.  With normalNode set, PBR's faceDirection flip is
    // bypassed so both sides of a blade get the same terrain N·L.
    mat.normalNode = cameraViewMatrix.transformDirection(terrainNormal);
    if (appearance?.id === CURVED_MEADOW_APPEARANCE.id) {
      const normal = attribute("normal", "vec3");
      const rotation = attribute("instanceRotScaleHash", "vec3").x;
      const c = cos(rotation),
        s = sin(rotation);
      const rotated = vec3(
        normal.x.mul(c).sub(normal.z.mul(s)),
        normal.y,
        normal.x.mul(s).add(normal.z.mul(c)),
      );
      const nx = terrainNormal.x,
        ny = terrainNormal.y,
        nz = terrainNormal.z;
      const q = float(1).div(ny.add(1));
      const cross = nx.mul(nz).mul(q).negate();
      // Vertex-stage yaw/tilt matches the position path. Only the face correction
      // and soft-normal blend run per fragment. No extra attribute or texture.
      const bladeNormal = vec3(
        rotated.x
          .mul(ny.add(nz.mul(nz).mul(q)))
          .add(rotated.y.mul(nx))
          .add(rotated.z.mul(cross)),
        rotated.x
          .mul(nx.negate())
          .add(rotated.y.mul(ny))
          .sub(rotated.z.mul(nz)),
        rotated.x
          .mul(cross)
          .add(rotated.y.mul(nz))
          .add(rotated.z.mul(ny.add(nx.mul(nx).mul(q)))),
      ).toVarying("v_curvedGrassNormal");
      mat.normalNode = cameraViewMatrix.transformDirection(
        mix(
          terrainNormal,
          bladeNormal.normalize().mul(faceDirection),
          float(appearance.BLADE_NORMAL_WEIGHT),
        ).normalize(),
      );
    }

    mat.colorNode = Fn(() => {
      const groundCol = attribute("instanceGroundColor", "vec3");
      const tint = attribute("instanceGrassTint", "vec4");
      const tintCol = tint.xyz;
      const tintStr = tint.w;
      const t = uv().y;
      const tintedCol = mix(groundCol, tintCol, tintStr);
      if (compactMeadow) {
        // Root shading suggests tuft occlusion without an extra texture/pass.
        // Retain the terrain palette: the previous 1.4 tip gain made distant
        // blades look like bright wires. This is albedo, not emissive light.
        const bladeCol = mix(
          groundCol.mul(appearance.ROOT_BRIGHTNESS),
          tintedCol.mul(appearance.TIP_BRIGHTNESS),
          smoothstep(float(0.0), float(1.0), t),
        );
        return compactPhysical
          ? bladeCol
          : applyAnimeShade(
              bladeCol,
              terrainNormal,
              uSunDir,
              this.shadeUniforms,
            );
      }
      const tipCol = mix(
        groundCol,
        tintedCol,
        smoothstep(float(0.0), float(1.0), t),
      ).mul(1.4);
      const bladeCol = mix(
        groundCol,
        tipCol,
        smoothstep(float(0.0), float(1.0), t),
      );
      return compactPhysical
        ? bladeCol
        : applyAnimeShade(bladeCol, terrainNormal, uSunDir, this.shadeUniforms);
    })();

    mat.outputNode = Fn(() => {
      return vec4(output.rgb, output.a);
    })();

    return mat;
  }

  // -- Helpers --------------------------------------------------------------

  private chunkKey(node: TerrainQuadNode): string {
    return `gq_${node.id}_d${node.depth}_${node.centerX}_${node.centerZ}`;
  }
}
