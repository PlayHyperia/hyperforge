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
import type { CompactHabitatField } from "./CompactHabitatComposition";
import { createStorageInstancedMesh } from "../../../utils/rendering/createStorageInstancedMesh";
import {
  createCompactHabitatSoilNode,
  createCompactBankVergeLocality,
  createCompactBankVergeHeightScale,
} from "./CompactTerrainMaterial";
import type {
  GrassAppearanceCandidate,
  GrassLightingCandidate,
  GrassGeometryCandidate,
  GrassSurfaceEligibility,
  StreamingGrassProfileReceipt,
} from "../../../runtime/clientViewportMode";
import {
  applyAnimeShade,
  TERRAIN_SHADER_CONSTANTS,
  TerrainShadeUniforms,
} from "./TerrainShader";
import { MeshSSSNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import { faceDirection } from "three/tsl";
import type Node from "three/src/nodes/core/Node.js";
import {
  createGrassMeadowRefinementResponse,
  createGrassMeadowAuthoredResponse,
  type GrassMeadowRefinementSample,
  type GrassMeadowRefinementResponse,
} from "./GrassMeadowRefinementGpu";
import type { TerrainQuadNode, QuadTreeListener } from "./TerrainQuadTree";
import type {
  RetainedTerrainSurface,
  TerrainGridBounds,
} from "./TerrainGridSurface";
import type { RetainedTerrainRegion } from "./TerrainVisualManager";
import {
  GRASS_BLADE_GROUNDING_LIMITS,
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
  GrassGroundingContinuation,
  captureGrassGroundingFailure,
  type GrassBladeGroundingResult,
} from "./GrassBladeGrounding";
import {
  prepareGroundedGrassSteps,
  type GrassGroundingInputLease,
} from "./GrassGroundingPipeline";
import type { GrassGroundingHandoffRequest } from "./GrassGroundingHandoff";
import {
  GrassGroundingWorkerCoordinator,
  type GrassGroundingWorkerJob,
} from "./GrassGroundingWorkerCoordinator";
import type { GrassGroundingWorkerPort } from "../../../utils/workers/GrassGroundingWorkerClient";
import {
  createGroundedGrassMaterial,
  groundedGrassWorldBox,
  GRASS_BLADE_VISIBILITY_ATTRIBUTE,
} from "./GrassGroundingGpu";
import {
  getGrassBladeLayout,
  isFoldedGrassBladeLayout,
  usesGrassBladeHeightFlex,
  usesGrassCloseDetailLods,
  FINE_GRASS_FOLDED_BLADE_INDICES,
  FINE_GRASS_HEIGHT_FLEX_RESPONSE,
  GRASS_MEADOW_REFINEMENT,
  type FineGrassGeometryLayout,
} from "./GrassBladeLayout";
import {
  createMeadowAuthoredShapeGeometry,
  type GrassMeadowAuthoredBlade,
} from "./GrassMeadowAuthoredShape";
import {
  projectGrassAnchors,
  type GrassGrounding,
} from "./GrassTerrainProjection";
import {
  getGrassWorkerPool,
  prepareGrassWorkerRequest,
  admitGrassWorkerPlacementResult,
  createGrassCoastBlendOperations,
  createGrassPondBlendOperations,
  terminateGrassWorkerPool,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../utils/workers/GrassWorker";
import type { TerrainWorkerConfig } from "../../../utils/workers/TerrainWorker";
import type {
  CompactTerrainPlantingLobe,
  CompactGrassColorGrade,
  CompactTerrainMacroField,
  CompactTerrainBankVerge,
  CompactPondBankField,
} from "./CompactTerrainPalette";
import type { BiomeGrassConfigWorker } from "../../../utils/workers/GrassWorker";
import {
  createGrassPlacementCellOperations,
  getGrassPlacementCellBounds,
  type GrassPlacementCell,
  type GrassPlacementCoverage,
  type GrassPlacementCoverageTrial,
  type GrassPlacementDistribution,
} from "../../../utils/workers/GrassPlacementCell";
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
  /** Ribbon segments: 3 paired rows plus 1 tip = 7 vertices. */
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

/** Appearance-only meadow study: four rooted blades form each small fan.
 * Keeps the existing blade topology, instancing and full grounding pipeline.
 * Never selected implicitly by a render-quality or population setting. */
export const NATURAL_TUFT_APPEARANCE = Object.freeze({
  id: "natural-tuft-v1",
  BLADE_HEIGHT_MIN: 0.2,
  BLADE_HEIGHT_MAX: 0.55,
  BLADE_WIDTH_RATIO: 0.095,
  BLADE_ARC_RATIO: 0.48,
  BLADE_CONTROL_HEIGHT: 0.78,
  BLADE_TIP_HEIGHT: 0.92,
  BLADE_NORMAL_WEIGHT: 0.38,
  ROOT_BRIGHTNESS: 0.64,
  TIP_BRIGHTNESS: 1.0,
  TUFT_BLADES: 4,
  TUFT_CENTER_RADIUS: 0.52,
  TUFT_ROOT_RADIUS: 0.065,
  TUFT_HEIGHT_FACTORS: Object.freeze([1, 0.62, 0.82, 0.54] as const),
  TUFT_ARC_FACTORS: Object.freeze([0.35, 1.15, 0.65, 1.35] as const),
} as const);

/** Explicit fine-meadow candidate: restored upper-leaf width and a leaning
 * quadratic centerline retain progressive roots, tips and geometry tiers.
 * Area and swept-footprint changes require fresh grounding and native review;
 * unchanged topology is not equal retained population or raster coverage.
 */
export const FINE_MEADOW_APPEARANCE = Object.freeze({
  id: "fine-meadow-v1",
  // One source-controlled opt-in selects generation, CPU validation and GPU
  // addressing together; the three-segment revision remains available.
  GEOMETRY_LAYOUT: "fine-linear-sweep-3seg-v1" as FineGrassGeometryLayout,
  BLADE_HEIGHT_MIN: 0.38,
  BLADE_HEIGHT_MAX: FINE_GRASS_HEIGHT_FLEX_RESPONSE.maximumHeight,
  BLADE_WIDTH_RATIO: 0.045,
  BLADE_TAPER: 0.85,
  BLADE_TAPER_POWER: 2,
  BLADE_WIDTH_FALLOFF_POWER: 1,
  BLADE_UPPER_WIDTH_GAIN: 0.35,
  BLADE_ARC_RATIO: 0.48,
  BLADE_CONTROL_HEIGHT: FINE_GRASS_HEIGHT_FLEX_RESPONSE.controlHeight,
  BLADE_CONTROL_ARC_RATIO: 0.35,
  BLADE_TIP_HEIGHT: FINE_GRASS_HEIGHT_FLEX_RESPONSE.tipHeight,
  BLADE_NORMAL_WEIGHT: 0.2,
  ROOT_BRIGHTNESS: 0.98,
  TIP_BRIGHTNESS: 1.2,
  ROOT_OCCLUSION: 0.78,
  ROOT_OCCLUSION_END: 0.35,
  PROGRESSIVE_ROOTS: true,
} as const);

/** Near-only geometry study: a rounded transverse ridge and lancet outline.
 * Adds two vertices/four triangles per blade, never removes clumps. Native
 * appearance, clearance and cost must qualify before any default promotion. */
export const FINE_GRASS_FOLDED_BLADE_SHAPE = Object.freeze({
  ...FINE_MEADOW_APPEARANCE,
  GEOMETRY_LAYOUT: "fine-folded-lancet-v1" as FineGrassGeometryLayout,
  BLADE_WIDTH_POLYNOMIAL: Object.freeze([1, 2.06, -5.04, 1.98] as const),
  BLADE_RIDGE_TANGENT: 0.36,
} as const);

/** Narrow basal sheath for the explicit five-segment close-detail candidate.
 * Six segments remain generator-only. Both require fresh root fitting rather
 * than reusing the wider historical footprint's corrections. */
export const FINE_GRASS_BASAL_SHEATH_SHAPE = Object.freeze({
  id: "basal-sheath-v1",
  rootWidthFactor: 0.25,
  // Authored curve parameter t, not a fraction of physical blade height.
  fullWidthHeight: 0.2,
} as const);

/** Additional close geometry only. Distances are to the existing 25m cell
 * bounds, not a per-blade cutoff; this avoids rebuilding placement ownership. */
export const FINE_GRASS_CLOSE_DETAIL = Object.freeze({
  id: "sheath-close-v1",
  geometryLayout: "fine-folded-sheath-near5-v1" as FineGrassGeometryLayout,
  detailDistance: 12,
  nearDistance: 40,
  spacingMultiplier: 1,
} as const);

/** Explicit composition-only trial using the same blades and buffer layouts.
 * Fixed progressive fan centers keep every shorter LOD prefix in place; the
 * historical tuft recipe instead depends on the requested blade count. */
export const FINE_GRASS_ROOTED_FAN_COMPOSITION = Object.freeze({
  id: "rooted-fan-v1",
  bladesPerFan: 4,
  centerRadius: 0.7,
  rootRadius: 0.025,
  facingJitter: 0.16,
  curveJitter: 0.12,
} as const);

export const FINE_GRASS_ROOTED_FAN_SHAPE = Object.freeze({
  ...FINE_GRASS_FOLDED_BLADE_SHAPE,
  ROOT_COMPOSITION: "progressive-fan-v1",
} as const);

/** Mixed meadow stature. Eight three-leaf fans spread the same 24 blades over
 * more plants: overlapping low/mid leaves and a finer tall silhouette. Width
 * and reach use the shared plant height independently of each leaf's stature;
 * shortening a leaf must not inadvertently shrink all three dimensions.
 * Rotate roles between fans so the tallest leaf does not repeat one bearing.
 * The same deterministic prefix is used at every LOD and freshly ground-fit.
 * Wider root spacing separates the leaf silhouettes without adding vertices.
 */
export const FINE_GRASS_MEADOW_CANOPY_COMPOSITION = Object.freeze({
  ...FINE_GRASS_ROOTED_FAN_COMPOSITION,
  id: "meadow-canopy-v1",
  bladesPerFan: 3,
  rootRadius: 0.065,
  dimensionBasis: "shared-plant-height",
  heightFactors: Object.freeze([0.68, 0.84, 1] as const),
  widthFactors: Object.freeze([1.1, 1.25, 0.86] as const),
  arcFactors: Object.freeze([1.15, 1, 0.78] as const),
} as const);

export const FINE_GRASS_MEADOW_CANOPY_SHAPE = Object.freeze({
  ...FINE_GRASS_FOLDED_BLADE_SHAPE,
  ROOT_COMPOSITION: "meadow-canopy-v1",
} as const);

/** Explicit denser field: seven three-leaf fans per near/middle clump,
 * redistributing geometry from each leaf into more slender plants per square
 * metre. This changes placement, fitting and distant cost; it is not
 * a default or a promise of cheaper rendering. Historical recipes stay intact.
 */
export const FINE_GRASS_MEADOW_FIELD_COMPOSITION = Object.freeze({
  ...FINE_GRASS_MEADOW_CANOPY_COMPOSITION,
  id: "meadow-field-v1",
  clumpSpacing: 0.5,
  // Give each plant a lower, outward-reaching leaf without widening the
  // middle/tall silhouette or adding plants. Refit the full swept footprint.
  heightFactors: Object.freeze([0.52, 0.84, 1] as const),
  widthFactors: Object.freeze([0.95, 1.05, 0.8] as const),
  arcFactors: Object.freeze([0.52, 1, 0.8] as const),
} as const);

export const FINE_GRASS_MEADOW_FIELD_SHAPE = Object.freeze({
  ...FINE_MEADOW_APPEARANCE,
  GEOMETRY_LAYOUT: "fine-meadow-ribbon-v1" as FineGrassGeometryLayout,
  ROOT_COMPOSITION: "meadow-field-v1",
  BLADE_WIDTH_RATIO: 0.028,
  BLADE_ARC_RATIO: 0.4,
  // A narrow basal sheath avoids broad rectangular feet. The full upper
  // ribbon width is unchanged; this is not a reduction in plant population.
  BLADE_BASE_WIDTH_FACTOR: 0.25,
  BLADE_FULL_WIDTH_HEIGHT: 0.2,
} as const);

/** Fine-only direct-light scattering trial, not screen-space transmission.
 * The leaf-colored term is multiplied by Three's actual shadowed light color.
 * These are explicit artistic coefficients, not measured tissue properties. */
export const FINE_GRASS_THIN_LEAF_LIGHTING = Object.freeze({
  id: "fine-thin-leaf-v1",
  attenuation: 0.2,
  scale: 1,
  power: 2,
  distortion: 0.1,
  ambient: 0,
  rootStart: 0.05,
  rootEnd: 0.65,
} as const);

/** Field-only thin-leaf fill. Three multiplies this by the actual shadowed
 * direct light, leaf tint and existing root gate; it is not emissive or an
 * environmental-light boost. The added term is at most 0.1 times that light
 * per color channel. This artistic approximation adds no pass or texture. */
export const FINE_GRASS_MEADOW_FIELD_THIN_LEAF_LIGHTING = Object.freeze({
  ...FINE_GRASS_THIN_LEAF_LIGHTING,
  id: "meadow-field-thin-leaf-v1",
  ambient: 0.5,
} as const);

/** Explicit normals-only art trial; the historical fine recipe stays unchanged. */
export const FINE_GRASS_CANOPY_NORMAL_LIGHTING = Object.freeze({
  id: "canopy-normal-v1",
  rootWeight: 0.2,
  upperWeight: 0.45,
  rootEnd: 0.1,
  upperStart: 0.65,
} as const);

/** Historical ribbon lighting, retained at mid/far LOD. The near study replaces
 * this cosmetic transverse fold with its geometry-derived normals. Root
 * blending stays local; neither path claims physical leaf self-shadowing. */
export const FINE_GRASS_LEAF_VOLUME_LIGHTING = Object.freeze({
  id: "leaf-volume-v1",
  rootWeight: 0.2,
  upperWeight: 1,
  rootEnd: 0.1,
  upperStart: 0.65,
  foldTangent: Math.tan((24 * Math.PI) / 180),
  foldTipStart: 0.75,
  // Authored lower-leaf color contrast, not additional physical occlusion.
  // Keep the tip endpoint and the existing AO/scattering coefficients unchanged.
  rootBrightness: 0.55,
  tipBrightness: 1.12,
  colorTipStart: 0.75,
} as const);

/** The near mesh supplies its own transverse normals; never stack the
 * historical cosmetic fold on top of its physical cross-section. */
export const FINE_GRASS_FOLDED_BLADE_LIGHTING = Object.freeze({
  ...FINE_GRASS_LEAF_VOLUME_LIGHTING,
  foldTangent: 0,
  normalSource: "geometry-fold",
  geometryLayout: "fine-folded-lancet-v1",
} as const);

const FINE_GRASS_SHEATH_BLADE_LIGHTING = Object.freeze({
  ...FINE_GRASS_FOLDED_BLADE_LIGHTING,
  geometryLayout: FINE_GRASS_CLOSE_DETAIL.geometryLayout,
});

/** Shading-only transverse relief and root albedo on the explicit meadow field. The ribbon
 * silhouette, surface fitting and wind envelope remain physical and unchanged;
 * this small normal bend is not leaf thickness or self-shadowing. */
export const FINE_GRASS_MEADOW_FIELD_LIGHTING = Object.freeze({
  ...FINE_GRASS_LEAF_VOLUME_LIGHTING,
  // Reduce authored blade/ground contrast without lifting actual shadow or AO.
  rootBrightness: 0.78,
  foldTangent: Math.tan((18 * Math.PI) / 180),
  normalSource: "geometry-ribbon-relief",
  geometryLayout: FINE_GRASS_MEADOW_FIELD_SHAPE.GEOMETRY_LAYOUT,
});

function publishFineGrassCanopyLighting(
  material: MeshStandardNodeMaterial,
  candidate: GrassLightingCandidate,
  folded = false,
  geometryLayout?: FineGrassGeometryLayout,
): void {
  Object.defineProperty(material.userData, "fineGrassCanopyLighting", {
    enumerable: true,
    configurable: false,
    writable: false,
    value:
      geometryLayout === FINE_GRASS_MEADOW_FIELD_SHAPE.GEOMETRY_LAYOUT
        ? FINE_GRASS_MEADOW_FIELD_LIGHTING
        : folded
          ? geometryLayout === FINE_GRASS_CLOSE_DETAIL.geometryLayout
            ? FINE_GRASS_SHEATH_BLADE_LIGHTING
            : FINE_GRASS_FOLDED_BLADE_LIGHTING
          : candidate === FINE_GRASS_LEAF_VOLUME_LIGHTING.id
            ? FINE_GRASS_LEAF_VOLUME_LIGHTING
            : FINE_GRASS_CANOPY_NORMAL_LIGHTING,
  });
}

function fineGrassThinLeafLighting(geometryLayout?: FineGrassGeometryLayout) {
  return geometryLayout === FINE_GRASS_MEADOW_FIELD_SHAPE.GEOMETRY_LAYOUT
    ? FINE_GRASS_MEADOW_FIELD_THIN_LEAF_LIGHTING
    : FINE_GRASS_THIN_LEAF_LIGHTING;
}

function publishFineGrassLighting(
  material: MeshSSSNodeMaterial,
  geometryLayout?: FineGrassGeometryLayout,
): void {
  Object.defineProperty(material.userData, "fineGrassLighting", {
    enumerable: true,
    configurable: false,
    writable: false,
    value: fineGrassThinLeafLighting(geometryLayout),
  });
}

type GrassBladeShape = Pick<
  typeof GRASS_CONFIG,
  | "BLADE_HEIGHT_MIN"
  | "BLADE_HEIGHT_MAX"
  | "BLADE_WIDTH_RATIO"
  | "BLADE_ARC_RATIO"
> & {
  BLADE_TAPER?: number;
  BLADE_TAPER_POWER?: number;
  /** Exponent of the remaining width; one preserves historical arithmetic. */
  BLADE_WIDTH_FALLOFF_POWER?: number;
  /** Additional upper-leaf width; zero at the root, full gain at half height. */
  BLADE_UPPER_WIDTH_GAIN?: number;
  BLADE_BASE_WIDTH_FACTOR?: number;
  BLADE_FULL_WIDTH_HEIGHT?: number;
  PROGRESSIVE_ROOTS?: boolean;
  ROOT_COMPOSITION?:
    "progressive-fan-v1" | "meadow-canopy-v1" | "meadow-field-v1";
  BLADE_CONTROL_HEIGHT?: number;
  /** Quadratic control-point XZ offset as a fraction of the unchanged tip arc. */
  BLADE_CONTROL_ARC_RATIO?: number;
  BLADE_TIP_HEIGHT?: number;
  TUFT_BLADES?: number;
  TUFT_CENTER_RADIUS?: number;
  TUFT_ROOT_RADIUS?: number;
  TUFT_HEIGHT_FACTORS?: readonly number[];
  TUFT_ARC_FACTORS?: readonly number[];
};

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

export function createClumpGeometry(
  bladesPerClump = GRASS_CONFIG.BLADES_PER_CLUMP,
  bladeSegments = GRASS_CONFIG.BLADE_SEGMENTS,
  shape: GrassBladeShape = GRASS_CONFIG,
  crossSection?: "folded-lancet-v1" | "folded-sheath-v1",
  onBlade?: (blade: GrassMeadowAuthoredBlade) => void,
): THREE.BufferGeometry {
  const meadowField = shape.ROOT_COMPOSITION === "meadow-field-v1";
  const meadowCanopy =
    shape.ROOT_COMPOSITION === "meadow-canopy-v1" || meadowField;
  const rootedFan =
    shape.ROOT_COMPOSITION === "progressive-fan-v1" || meadowCanopy;
  const canopyComposition = meadowField
    ? FINE_GRASS_MEADOW_FIELD_COMPOSITION
    : FINE_GRASS_MEADOW_CANOPY_COMPOSITION;
  const fanComposition = meadowCanopy
    ? canopyComposition
    : FINE_GRASS_ROOTED_FAN_COMPOSITION;
  if (
    shape.ROOT_COMPOSITION !== undefined &&
    (!rootedFan ||
      !shape.PROGRESSIVE_ROOTS ||
      shape.TUFT_BLADES !== undefined ||
      shape.TUFT_CENTER_RADIUS !== undefined ||
      shape.TUFT_ROOT_RADIUS !== undefined ||
      shape.TUFT_HEIGHT_FACTORS !== undefined ||
      shape.TUFT_ARC_FACTORS !== undefined)
  )
    throw new Error("Rooted grass fans require the unmixed progressive shape");
  const sheath = crossSection === "folded-sheath-v1";
  const folded = crossSection === "folded-lancet-v1" || sheath;
  if (
    (crossSection !== undefined && !folded) ||
    (folded &&
      ((sheath
        ? bladeSegments !== 5 && bladeSegments !== 6
        : bladeSegments !== 3) ||
        shape.BLADE_CONTROL_HEIGHT === undefined))
  )
    throw new Error(
      "Folded grass requires its explicit curved layout: three segments, or five/six for the sheath study",
    );
  const N = bladesPerClump;
  const segs = bladeSegments;
  const { CLUMP_RADIUS, CLUMP_INNER_RATIO } = GRASS_CONFIG;
  const taper = shape.BLADE_TAPER ?? GRASS_CONFIG.BLADE_TAPER;
  const taperPower = shape.BLADE_TAPER_POWER ?? 1;
  const widthFalloffPower = shape.BLADE_WIDTH_FALLOFF_POWER ?? 1;
  const upperWidthGain = shape.BLADE_UPPER_WIDTH_GAIN ?? 0;
  const {
    BLADE_WIDTH_RATIO,
    BLADE_HEIGHT_MIN: hMin,
    BLADE_HEIGHT_MAX: hMax,
    BLADE_ARC_RATIO,
  } = shape;
  const curved = shape.BLADE_CONTROL_HEIGHT !== undefined;
  const controlHeight = shape.BLADE_CONTROL_HEIGHT ?? 0.5;
  const controlArcRatio = shape.BLADE_CONTROL_ARC_RATIO ?? 0;
  const tipHeight = shape.BLADE_TIP_HEIGHT ?? 1;

  const vertsPerBlade = folded ? 3 * segs : segs * 2 + 1;
  const trisPerBlade = folded ? 4 * segs - 3 : (segs - 1) * 2 + 1;
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
  let tuftHeight = 0;
  let meadowCanopyHeight = 0;

  for (let b = 0; b < N; b++) {
    // Base-two radical inverse distributes each prefix across the whole disk.
    // Its inputs and the per-blade RNG sequence are independent of N/segments:
    // the first twelve fine blades retain roots, widths, height and tips when
    // changing from the twenty-four-blade near geometry.
    let progressiveRadius = 0;
    if (shape.PROGRESSIVE_ROOTS) {
      let value = b + 1;
      let place = 0.5;
      while (value > 0) {
        progressiveRadius += (value % 2) * place;
        value = Math.floor(value / 2);
        place *= 0.5;
      }
    }
    const t01 = shape.PROGRESSIVE_ROOTS ? progressiveRadius : b / N;
    const tuft = shape.TUFT_BLADES ? Math.floor(b / shape.TUFT_BLADES) : null;
    const fanIndex = shape.TUFT_BLADES ? b % shape.TUFT_BLADES : 0;
    const tuftAngle = (tuft ?? 0) * GOLDEN_ANGLE;
    const fanAngle =
      tuftAngle + (fanIndex / (shape.TUFT_BLADES ?? 1)) * Math.PI * 2;
    const rootedFanIndex = Math.floor(b / fanComposition.bladesPerFan);
    const rootedFanAngle =
      rootedFanIndex * GOLDEN_ANGLE +
      ((b % fanComposition.bladesPerFan) / fanComposition.bladesPerFan) *
        Math.PI *
        2;
    const angle = rootedFan
      ? rootedFanAngle
      : tuft === null
        ? b * GOLDEN_ANGLE
        : fanAngle;
    const rNorm = CLUMP_INNER_RATIO + (1 - CLUMP_INNER_RATIO) * Math.sqrt(t01);
    const r = rNorm * CLUMP_RADIUS;
    const jitter = (rng() - 0.5) * 0.15 * CLUMP_RADIUS;
    const tuftRadius =
      (shape.TUFT_CENTER_RADIUS ?? 0) *
      Math.sqrt(((tuft ?? 0) + 0.5) / Math.ceil(N / (shape.TUFT_BLADES ?? 1)));
    const rootRadius =
      (shape.TUFT_ROOT_RADIUS ?? 0) * (0.8 + (0.2 * fanIndex) / 3);
    // This center sequence depends only on fan index, never N or LOD. Keep the
    // original per-blade random draw above even though its positional jitter
    // is not used here: dimensions and all later samples remain unchanged.
    let fanRadiusFraction = 0;
    if (rootedFan) {
      let value = rootedFanIndex + 1;
      let place = 0.5;
      while (value > 0) {
        fanRadiusFraction += (value % 2) * place;
        value = Math.floor(value / 2);
        place *= 0.5;
      }
    }
    const fanCenterRadius =
      fanComposition.centerRadius * Math.sqrt(fanRadiusFraction);
    const ox = rootedFan
      ? Math.cos(rootedFanIndex * GOLDEN_ANGLE) * fanCenterRadius +
        Math.cos(angle) * fanComposition.rootRadius
      : tuft === null
        ? Math.cos(angle) * r + Math.cos(angle + 1.3) * jitter
        : Math.cos(tuftAngle) * tuftRadius + Math.cos(fanAngle) * rootRadius;
    const oz = rootedFan
      ? Math.sin(rootedFanIndex * GOLDEN_ANGLE) * fanCenterRadius +
        Math.sin(angle) * fanComposition.rootRadius
      : tuft === null
        ? Math.sin(angle) * r + Math.sin(angle + 1.3) * jitter
        : Math.sin(tuftAngle) * tuftRadius + Math.sin(fanAngle) * rootRadius;

    const facingAngle =
      angle +
      Math.PI * 0.5 +
      (rng() - 0.5) * (rootedFan ? 2 * fanComposition.facingJitter : Math.PI);
    const cr = Math.cos(facingAngle);
    const sr = Math.sin(facingAngle);

    const rawHeightFraction = 0.3 + 0.7 * t01 + (rng() - 0.5) * 0.4;
    const heightFraction = shape.PROGRESSIVE_ROOTS
      ? THREE.MathUtils.clamp(rawHeightFraction, 0, 1)
      : rawHeightFraction;
    const variedHeight =
      hMin +
      (hMax - hMin) *
        (tuft === null
          ? heightFraction
          : THREE.MathUtils.clamp(
              heightFraction + (fanIndex % 2 ? 0.12 : -0.12),
              0,
              1,
            ));
    // One height hierarchy per rooted tuft, rather than four independently
    // prominent leaves. Still consume each original per-blade random sample.
    if (tuft !== null && fanIndex === 0) tuftHeight = variedHeight;
    const variedBladeHeight =
      (tuft === null ? variedHeight : tuftHeight) *
      (shape.TUFT_HEIGHT_FACTORS?.[fanIndex] ?? 1);
    const canopyRole = (b + rootedFanIndex) % fanComposition.bladesPerFan;
    if (meadowCanopy && b % fanComposition.bladesPerFan === 0)
      meadowCanopyHeight = variedBladeHeight;
    const h = meadowCanopy
      ? meadowCanopyHeight * canopyComposition.heightFactors[canopyRole]
      : variedBladeHeight;
    const w = meadowCanopy
      ? meadowCanopyHeight *
        BLADE_WIDTH_RATIO *
        canopyComposition.widthFactors[canopyRole]
      : h * BLADE_WIDTH_RATIO;

    const curveSample = rng() - 0.5;
    const curveAngle = rootedFan
      ? angle + curveSample * 2 * fanComposition.curveJitter
      : angle + curveSample * Math.PI * 0.6;
    const variedArcDist =
      (meadowCanopy ? meadowCanopyHeight : h) *
      BLADE_ARC_RATIO *
      (0.8 + rng() * 0.4) *
      (shape.TUFT_ARC_FACTORS?.[fanIndex] ?? 1);
    const arcDist = meadowCanopy
      ? variedArcDist * canopyComposition.arcFactors[canopyRole]
      : variedArcDist;
    const curveDirX = Math.cos(curveAngle) * arcDist;
    const curveDirZ = Math.sin(curveAngle) * arcDist;
    // Optional geometry-authoring receipt, before Float32 storage. Ordinary
    // generation allocates no receipt and retains its exact RNG/arithmetic.
    if (onBlade)
      onBlade(
        Object.freeze({
          index: b,
          rootX: ox,
          rootZ: oz,
          height: h,
          width: w,
          facingAngle,
          curveX: curveDirX,
          curveZ: curveDirZ,
        }),
      );

    rng(); // consume one RNG value to keep deterministic sequence stable
    const baseVert = vi;
    const bladeNormal = (t: number) => {
      const dy =
        2 * ((1 - t) * controlHeight + t * (tipHeight - controlHeight)) * h;
      const nx = -sr * dy;
      const arcDerivative =
        2 * ((1 - t) * controlArcRatio + t * (1 - controlArcRatio));
      const ny =
        controlArcRatio === 0
          ? sr * 2 * curveDirX * t - cr * 2 * curveDirZ * t
          : sr * curveDirX * arcDerivative - cr * curveDirZ * arcDerivative;
      const nz = cr * dy;
      const length = Math.hypot(nx, ny, nz);
      return [nx / length, ny / length, nz / length];
    };

    const foldedWidth = (t: number) => {
      const [a, b, c, d] = FINE_GRASS_FOLDED_BLADE_SHAPE.BLADE_WIDTH_POLYNOMIAL;
      const hw = w * 0.5 * (a + b * t + c * t * t + d * t * t * t);
      if (!sheath) return hw;
      const { rootWidthFactor, fullWidthHeight } =
        FINE_GRASS_BASAL_SHEATH_SHAPE;
      const u = THREE.MathUtils.clamp(t / fullWidthHeight, 0, 1);
      return (
        hw * (rootWidthFactor + (1 - rootWidthFactor) * u * u * (3 - 2 * u))
      );
    };
    const foldedNormal = (t: number, s: number) => {
      // P=C+s*hw*S+f*(1-s²)*H, H=(-sr,0,cr). Derive both tangents
      // from that same surface; the old ribbon normal is not valid at edges.
      const [, b, c, d] = FINE_GRASS_FOLDED_BLADE_SHAPE.BLADE_WIDTH_POLYNOMIAL;
      const hw = foldedWidth(t);
      let dhw = w * 0.5 * (b + 2 * c * t + 3 * d * t * t);
      if (sheath) {
        const { rootWidthFactor, fullWidthHeight } =
          FINE_GRASS_BASAL_SHEATH_SHAPE;
        const u = THREE.MathUtils.clamp(t / fullWidthHeight, 0, 1);
        const factor =
          rootWidthFactor + (1 - rootWidthFactor) * u * u * (3 - 2 * u);
        const derivative =
          ((1 - rootWidthFactor) * 6 * u * (1 - u)) / fullWidthHeight;
        const [a] = FINE_GRASS_FOLDED_BLADE_SHAPE.BLADE_WIDTH_POLYNOMIAL;
        const originalWidth = w * 0.5 * (a + b * t + c * t * t + d * t * t * t);
        dhw = dhw * factor + originalWidth * derivative;
      }
      const g = 16 * t * t * (1 - t) * (1 - t);
      const dg = 32 * t * (1 - t) * (1 - 2 * t);
      const ridge = FINE_GRASS_FOLDED_BLADE_SHAPE.BLADE_RIDGE_TANGENT;
      const f = hw * ridge * g;
      const df = ridge * (dhw * g + hw * dg);
      const arcDerivative =
        2 * ((1 - t) * controlArcRatio + t * (1 - controlArcRatio));
      const psx = hw * cr + 2 * s * f * sr;
      const psz = hw * sr - 2 * s * f * cr;
      const ptx =
        curveDirX * arcDerivative + s * dhw * cr - df * (1 - s * s) * sr;
      const pty =
        2 * ((1 - t) * controlHeight + t * (tipHeight - controlHeight)) * h;
      const ptz =
        curveDirZ * arcDerivative + s * dhw * sr + df * (1 - s * s) * cr;
      const nx = -psz * pty;
      const ny = psz * ptx - psx * ptz;
      const nz = psx * pty;
      const length = Math.hypot(nx, ny, nz);
      return [nx / length, ny / length, nz / length];
    };

    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const y = curved
        ? (2 * (1 - t) * t * controlHeight + t * t * tipHeight) * h
        : t * h;
      const normal = curved ? bladeNormal(t) : [-sr, 0, cr];
      // Width-only factors leave centerlines, root edges and tips unchanged.
      // For P(t,u)=C(t)+u*w(t)*S, P_u cross P_t is proportional
      // to S cross C'(t): the w'(t)*S term cancels. The same smooth normal
      // therefore remains valid, including the upper-leaf width envelope.
      const taperedHeight = taperPower === 1 ? t : Math.pow(t, taperPower);
      let hw = w * 0.5 * (1.0 - taperedHeight * taper);
      // Keep all unselected profiles on their original arithmetic path.
      if (widthFalloffPower !== 1)
        hw = w * 0.5 * Math.pow(1.0 - taperedHeight * taper, widthFalloffPower);
      if (upperWidthGain !== 0)
        hw *= 1 + upperWidthGain * THREE.MathUtils.smoothstep(t, 0, 0.5);
      if (shape.BLADE_BASE_WIDTH_FACTOR !== undefined) {
        const factor = shape.BLADE_BASE_WIDTH_FACTOR;
        hw *=
          factor +
          (1 - factor) *
            THREE.MathUtils.smoothstep(
              t,
              0,
              shape.BLADE_FULL_WIDTH_HEIGHT ?? 0.2,
            );
      }
      if (folded && (i !== 0 || sheath)) hw = foldedWidth(t);
      // Keep the historical arithmetic exact when no leaning control is
      // selected. The fine candidate changes only the middle control point;
      // root and tip remain byte-identical, with no extra random draws.
      const arc =
        controlArcRatio === 0
          ? t * t
          : 2 * (1 - t) * t * controlArcRatio + t * t;
      const arcX = curveDirX * arc;
      const arcZ = curveDirZ * arc;

      for (let side = 0; side < 2; side++) {
        const lx = side === 0 ? -hw : hw;
        const surfaceNormal =
          folded && i !== 0 ? foldedNormal(t, side * 2 - 1) : normal;
        positions[vi * 3] = lx * cr + arcX + ox;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = lx * sr + arcZ + oz;
        normals[vi * 3] = surfaceNormal[0];
        normals[vi * 3 + 1] = surfaceNormal[1];
        normals[vi * 3 + 2] = surfaceNormal[2];
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

    if (folded) {
      for (let row = 1; row < segs; row++) {
        const t = row / segs;
        const arc = 2 * (1 - t) * t * controlArcRatio + t * t;
        const ridge =
          foldedWidth(t) *
          FINE_GRASS_FOLDED_BLADE_SHAPE.BLADE_RIDGE_TANGENT *
          16 *
          t *
          t *
          (1 - t) *
          (1 - t);
        positions[vi * 3] = curveDirX * arc + ox - ridge * sr;
        positions[vi * 3 + 1] =
          (2 * (1 - t) * t * controlHeight + t * t * tipHeight) * h;
        positions[vi * 3 + 2] = curveDirZ * arc + oz + ridge * cr;
        normals.set(foldedNormal(t, 0), vi * 3);
        uvs.set([0.5, t], vi * 2);
        vi++;
      }
      if (!sheath) {
        for (const index of FINE_GRASS_FOLDED_BLADE_INDICES)
          indices[ii++] = baseVert + index;
      } else {
        // Same two-root indexing convention, but a narrower footprint; adds
        // longitudinal stations and their physical ridge vertices, not blades.
        const tip = segs * 2;
        const triangle = (a: number, b: number, c: number) => {
          indices[ii++] = baseVert + a;
          indices[ii++] = baseVert + b;
          indices[ii++] = baseVert + c;
        };
        triangle(0, 1, tip + 1);
        triangle(0, tip + 1, 2);
        triangle(1, 3, tip + 1);
        for (let row = 1; row < segs - 1; row++) {
          const left = 2 * row,
            center = tip + row;
          triangle(left, center, left + 2);
          triangle(center, center + 1, left + 2);
          triangle(center, left + 1, center + 1);
          triangle(left + 1, left + 3, center + 1);
        }
        triangle(tip - 2, 2 * segs + segs - 1, tip);
        triangle(2 * segs + segs - 1, tip - 1, tip);
      }
      continue;
    }

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
  if (rootedFan)
    Object.defineProperty(geo.userData, "grassRootComposition", {
      value: fanComposition,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  return geo;
}

/** Build the close-detail template without changing placement or live LODs.
 * The caller owns both returned geometries. Parent pairs index coarseGeometry
 * globally; store them as a shared read-only storage table, not an extra
 * per-instance vertex stream. They must be evaluated after wind/ground tilt.
 * Fresh coarse+fine envelope fitting and explicit worker/GPU admission are
 * required before this template may replace a rendered coarse clump.
 */
export function createMeadowDetailClumpGeometry(): {
  geometry: THREE.BufferGeometry;
  coarseGeometry: THREE.BufferGeometry;
  coarseVertexPairs: Uint32Array;
  layout: typeof GRASS_MEADOW_REFINEMENT;
} {
  const layout = GRASS_MEADOW_REFINEMENT;
  const geometry = new THREE.BufferGeometry();
  let coarseGeometry: THREE.BufferGeometry | undefined;
  let dense: THREE.BufferGeometry | undefined;
  try {
    coarseGeometry = createClumpGeometry(
      layout.bladesPerClump,
      3,
      FINE_GRASS_MEADOW_FIELD_SHAPE,
    );
    dense = createClumpGeometry(
      layout.bladesPerClump,
      6,
      FINE_GRASS_MEADOW_FIELD_SHAPE,
    );
    const count = layout.bladesPerClump * layout.verticesPerBlade;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const indices = new Uint16Array(
      layout.bladesPerClump * layout.indices.length,
    );
    const coarseVertexPairs = new Uint32Array(count * 2);
    const coarseUv = coarseGeometry.getAttribute("uv");
    for (let blade = 0; blade < layout.bladesPerClump; blade++) {
      const coarseBase = blade * layout.sourceVerticesPerBlade;
      const detailBase = blade * layout.verticesPerBlade;
      const denseBase = blade * 13;
      for (let local = 0; local < layout.verticesPerBlade; local++) {
        const vertex = detailBase + local;
        const [a, b] = layout.parentPairs[local];
        coarseVertexPairs.set([coarseBase + a, coarseBase + b], vertex * 2);
        uvs[vertex * 2] =
          (coarseUv.getX(coarseBase + a) + coarseUv.getX(coarseBase + b)) * 0.5;
        uvs[vertex * 2 + 1] =
          (coarseUv.getY(coarseBase + a) + coarseUv.getY(coarseBase + b)) * 0.5;
        for (const [name, output] of [
          ["position", positions],
          ["normal", normals],
        ] as const) {
          if (local < layout.sourceVerticesPerBlade) {
            const source = coarseGeometry.getAttribute(name);
            output[vertex * 3] = source.getX(coarseBase + local);
            output[vertex * 3 + 1] = source.getY(coarseBase + local);
            output[vertex * 3 + 2] = source.getZ(coarseBase + local);
          } else {
            // The same generator evaluates original seeded parameters at the
            // new stations. Never fit a curve to rounded coarse positions.
            const [row, side] =
              layout.fineSamples[local - layout.sourceVerticesPerBlade];
            const source = dense.getAttribute(name);
            const left = denseBase + row * 2;
            output[vertex * 3] =
              source.getX(left) * (1 - side) + source.getX(left + 1) * side;
            output[vertex * 3 + 1] =
              source.getY(left) * (1 - side) + source.getY(left + 1) * side;
            output[vertex * 3 + 2] =
              source.getZ(left) * (1 - side) + source.getZ(left + 1) * side;
          }
        }
      }
      for (let i = 0; i < layout.indices.length; i++)
        indices[blade * layout.indices.length + i] =
          detailBase + layout.indices[i];
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    Object.defineProperty(geometry.userData, "grassRootComposition", {
      value: FINE_GRASS_MEADOW_FIELD_COMPOSITION,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    return { geometry, coarseGeometry, coarseVertexPairs, layout };
  } catch (error) {
    geometry.dispose();
    coarseGeometry?.dispose();
    throw error;
  } finally {
    dense?.dispose();
  }
}

/** Separate authored endpoint only; no live profile/LOD selects this factory.
 * It borrows the real seeded plant dimensions before they are rounded. */
export function createMeadowAuthoredClumpGeometry() {
  const blades: GrassMeadowAuthoredBlade[] = [];
  const coarseGeometry = createClumpGeometry(
    GRASS_MEADOW_REFINEMENT.bladesPerClump,
    3,
    FINE_GRASS_MEADOW_FIELD_SHAPE,
    undefined,
    (blade) => blades.push(blade),
  );
  try {
    return {
      ...createMeadowAuthoredShapeGeometry(
        coarseGeometry,
        blades,
        FINE_GRASS_MEADOW_FIELD_SHAPE,
      ),
      coarseGeometry,
    };
  } catch (error) {
    coarseGeometry.dispose();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A grass scheduling/sampling domain borrowing one REAL retained terrain leaf.
 * Cell coordinates never impersonate terrain geometry or its grid origin. */
interface GrassWorkUnit {
  readonly node: TerrainQuadNode;
  readonly key: string;
  readonly bounds: Readonly<TerrainGridBounds>;
  readonly placementCell?: GrassPlacementCell;
}

type GrassWorkSource = TerrainQuadNode | GrassWorkUnit;

interface GrassChunk {
  nodeId: number;
  mesh: THREE.InstancedMesh;
  box: THREE.Box3;
  lodLevel: number;
  node: TerrainQuadNode;
  work: GrassWorkUnit;
}

interface GrassWorkerTicket {
  readonly node: TerrainQuadNode;
  readonly work: GrassWorkUnit;
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
  job: GrassGroundingContinuation | GrassGroundingWorkerJob;
}

/** Explicit fine-meadow candidate; one worker is owned by this manager. */
export type GrassGroundingWorkerSetup = {
  mode: "worker-v1";
  createPort: () => GrassGroundingWorkerPort;
  isSurfaceCurrent: (surface: RetainedTerrainSurface) => boolean;
};

interface CompletedGrassGrounding {
  region: RetainedTerrainRegion;
  inputs: GrassGroundingInputLease;
}

interface SettledGrassWorkerResult {
  ticket: GrassWorkerTicket;
  data: GrassWorkerOutput;
}

export interface GrassVisualProfile {
  id?:
    | "fixed-arena-v1"
    | "compact-island-v1"
    | "compact-meadow-v2"
    | "fine-meadow-v1";
  eligibility?: GrassSurfaceEligibility;
  /** Multiplies the global spacing without changing deterministic placement. */
  clumpSpacingMultiplier?: number;
  /** Prevents expensive close-up geometry tiers in fixed spectator views. */
  minimumLodLevel?: number;
  maxRenderDistance?: number;
  maxChunksPerFrame?: number;
  placementCellSize?: 25;
  nearLodDistance?: 40;
  /** Restart-owned, opt-in coverage in exactly one world cell. */
  coverageTrial?: GrassPlacementCoverageTrial;
  /** Restart-owned fine-grass road clearance; ordinary profiles stay unchanged. */
  roadClearance?: "per-blade-v1";
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

/** Explicit quality candidate, not a silent change to retained grass profiles. */
export const FINE_MEADOW_GRASS_VISUAL_PROFILE = Object.freeze({
  id: "fine-meadow-v1",
  eligibility: "compact-pbr-v1",
  clumpSpacingMultiplier: 1,
  minimumLodLevel: 0,
  maxRenderDistance: 140,
  maxChunksPerFrame: 1,
  placementCellSize: 25,
  nearLodDistance: 40,
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
  pondServiceGround?: CompactTerrainBankVerge;
  compactPondBlend?: "shore-contact-v1" | "composition-v1";
  compactPondBankField?: CompactPondBankField;
  compactCoastBlend?: "distribution-v1";
  compactGrassColorGrade?: CompactGrassColorGrade;
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
  ) => GrassWorkerInput["roadSegments"];
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
    grassPlacementBeforeCoast?: number;
    grassEstablishment?: true;
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
  private foldedMaterial: MeshStandardNodeMaterial | null = null;
  private foldedBladeNormalNode: MeshStandardNodeMaterial["normalNode"] = null;
  private meadowDetailMaterialFactory:
    | ((
        geometry: THREE.BufferGeometry,
        coarseGeometry: THREE.BufferGeometry,
        weight: Node<"float">,
        endpoint: "conforming" | "authored",
      ) => MeshStandardNodeMaterial)
    | null = null;
  private lodGeometries: THREE.BufferGeometry[];

  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private playerX = 0;
  private playerZ = 0;

  private pendingNodes: {
    node: TerrainQuadNode;
    work?: GrassWorkUnit;
    lod?: number;
  }[] = [];
  private settledWorkerResults: SettledGrassWorkerResult[] = [];
  private maxChunksPerFrame: number;
  private clumpSpacing: number;
  private minimumLodLevel: number;
  private maxRenderDistance: number;
  private readonly profileId: StreamingGrassProfileReceipt["profileId"];
  private readonly geometryLayout: FineGrassGeometryLayout | undefined;
  private readonly compactMeadow: boolean;
  private readonly fineMeadow: boolean;
  private readonly placementDistribution:
    GrassPlacementDistribution | undefined;
  private readonly coverageTrial: GrassPlacementCoverageTrial | undefined;
  private readonly roadClearance: "per-blade-v1" | undefined;
  private readonly placementOperations = createGrassPlacementCellOperations();
  private readonly nodeWorkUnits = new Map<
    TerrainQuadNode,
    readonly GrassWorkUnit[]
  >();
  private readonly liveWorkUnits = new Map<string, GrassWorkUnit>();
  private lodFocusX = 0;
  private lodFocusZ = 0;
  private hasPrimaryView = false;
  private primaryViewValid = false;
  private primaryViewX = 0;
  private primaryViewZ = 0;
  private readonly primaryViewProjection = new THREE.Matrix4();
  private readonly primaryViewFrustum = new THREE.Frustum();
  private readonly meadowAppearance:
    | typeof COMPACT_MEADOW_APPEARANCE
    | typeof CURVED_MEADOW_APPEARANCE
    | typeof NATURAL_TUFT_APPEARANCE
    | typeof FINE_MEADOW_APPEARANCE
    | null;
  private readonly grassEligibility: GrassSurfaceEligibility;
  private readonly compactGrassColorGrade: CompactGrassColorGrade | undefined;
  private readonly compactCoastBlend: "distribution-v1" | undefined;
  private readonly compactPondBlend:
    "shore-contact-v1" | "composition-v1" | undefined;
  private readonly compactTerrainColorOperations =
    createCompactTerrainColorOperations();
  private readonly compactMacroField: CompactTerrainMacroField | null;

  private workerSetup: GrassWorkerSetup | null = null;
  private workerInflight = new Map<string, GrassWorkerTicket>();
  /** Only tree-owned, living max-depth leaves; geometry destruction retires them. */
  private liveNodes = new Map<string, TerrainQuadNode>();
  /** Includes successful empty chunks so flat arena ground can become ready. */
  private completedNodes = new Map<string, TerrainQuadNode>();
  private completedSurfaces = new Map<string, RetainedTerrainSurface>();
  private completedLods = new Map<string, number>();
  private groundingJobs = new Map<string, GrassGroundingEntry>();
  private readonly groundingWorker: GrassGroundingWorkerCoordinator | null;
  private completedGrounding = new Map<string, CompletedGrassGrounding>();
  private groundingHalo = 0;
  private maximumGroundingSliceMs = 0;
  private groundingActiveMs = 0;
  private pendingLodSwap = new Map<
    string,
    { node: TerrainQuadNode; work: GrassWorkUnit; desiredLod: number }
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
      grassPlacementBeforeCoast?: number;
      grassEstablishment?: true;
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
    appearanceCandidate?: GrassAppearanceCandidate,
    private readonly habitatComposition?: CompactHabitatField | null,
    private readonly lightingCandidate?: GrassLightingCandidate,
    groundingWorkerSetup?: GrassGroundingWorkerSetup,
    private readonly geometryCandidate?: GrassGeometryCandidate,
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
    this.fineMeadow = this.profileId === FINE_MEADOW_GRASS_VISUAL_PROFILE.id;
    if (
      groundingWorkerSetup &&
      (groundingWorkerSetup.mode !== "worker-v1" ||
        !this.fineMeadow ||
        appearanceCandidate !== "fine-meadow-v1" ||
        !captureRenderedRegion)
    )
      throw new Error(
        "Grass grounding worker requires the retained fine meadow",
      );
    this.placementDistribution = this.fineMeadow
      ? "fine-cell-stratified-v1"
      : undefined;
    if (
      habitatComposition &&
      appearanceCandidate !== "natural-tuft-v1" &&
      appearanceCandidate !== "fine-meadow-v1"
    )
      throw new Error(
        "Habitat grass requires the explicit natural tuft appearance",
      );
    if (
      appearanceCandidate !== undefined &&
      !(
        (appearanceCandidate === NATURAL_TUFT_APPEARANCE.id &&
          this.profileId === DENSE_MEADOW_GRASS_VISUAL_PROFILE.id) ||
        (appearanceCandidate === FINE_MEADOW_APPEARANCE.id && this.fineMeadow)
      )
    ) {
      throw new Error(
        "Natural tuft appearance requires the exact dense meadow profile",
      );
    }
    if (this.fineMeadow && appearanceCandidate !== FINE_MEADOW_APPEARANCE.id)
      throw new Error("Fine meadow requires its explicit appearance");
    if (
      lightingCandidate !== undefined &&
      ((lightingCandidate !== FINE_GRASS_CANOPY_NORMAL_LIGHTING.id &&
        lightingCandidate !== FINE_GRASS_LEAF_VOLUME_LIGHTING.id) ||
        !this.fineMeadow ||
        appearanceCandidate !== FINE_MEADOW_APPEARANCE.id ||
        !workerSetup ||
        !isCompactSculptProfile(workerSetup.terrainConfig.TERRAIN_PROFILE))
    )
      throw new Error(
        "Grass lighting requires the admitted explicit fine meadow",
      );
    if (
      geometryCandidate !== undefined &&
      ((geometryCandidate !== FINE_GRASS_CLOSE_DETAIL.id &&
        geometryCandidate !== FINE_GRASS_ROOTED_FAN_COMPOSITION.id &&
        geometryCandidate !== FINE_GRASS_MEADOW_CANOPY_COMPOSITION.id &&
        geometryCandidate !== FINE_GRASS_MEADOW_FIELD_COMPOSITION.id) ||
        lightingCandidate !== FINE_GRASS_LEAF_VOLUME_LIGHTING.id)
    )
      throw new Error(
        "Grass geometry requires the explicit leaf-volume fine meadow",
      );
    const coverageField = Object.getOwnPropertyDescriptor(
      profile,
      "coverageTrial",
    );
    if (
      "coverageTrial" in profile &&
      (!coverageField?.enumerable || !("value" in coverageField))
    )
      throw new Error("Grass coverage trial requires an own data field");
    this.coverageTrial = coverageField
      ? this.placementOperations.validateCoverageTrial(coverageField.value)
      : undefined;
    if (this.coverageTrial && !this.fineMeadow)
      throw new Error("Grass coverage trial requires the explicit fine meadow");
    if (
      this.coverageTrial &&
      geometryCandidate === FINE_GRASS_MEADOW_FIELD_COMPOSITION.id
    )
      throw new Error(
        "Dense meadow field cannot mix a single-cell coverage trial",
      );
    const clearanceField = Object.getOwnPropertyDescriptor(
      profile,
      "roadClearance",
    );
    if (
      "roadClearance" in profile &&
      (!clearanceField ||
        !("value" in clearanceField) ||
        (clearanceField.value !== undefined &&
          clearanceField.value !== "per-blade-v1"))
    )
      throw new Error("Invalid grass visual road-clearance mode");
    this.roadClearance = clearanceField?.value;
    if (this.roadClearance && !this.fineMeadow)
      throw new Error("Grass road clearance requires the explicit fine meadow");
    this.compactGrassColorGrade =
      createCompactTerrainColorOperations().grassColorGrade(
        workerSetup?.compactGrassColorGrade,
      );
    this.compactCoastBlend = createGrassCoastBlendOperations().validate(
      workerSetup ?? {},
    );
    this.compactPondBlend = createGrassPondBlendOperations().validate(
      workerSetup ?? {},
    );
    if (this.compactPondBlend && !this.fineMeadow)
      throw new Error(
        "Grass pond distribution requires the explicit fine meadow",
      );
    if (this.compactCoastBlend && !this.fineMeadow)
      throw new Error(
        "Grass coastal distribution requires the explicit fine meadow",
      );
    if (this.compactGrassColorGrade && !this.fineMeadow)
      throw new Error("Grass color grade requires the explicit fine meadow");
    if (
      !this.fineMeadow &&
      (profile.placementCellSize !== undefined ||
        profile.nearLodDistance !== undefined)
    )
      throw new Error(
        "Grass placement cells require the explicit fine meadow profile",
      );
    this.compactMeadow =
      this.profileId === "compact-island-v1" ||
      this.profileId === "compact-meadow-v2" ||
      this.fineMeadow;
    this.meadowAppearance = this.fineMeadow
      ? FINE_MEADOW_APPEARANCE
      : this.profileId === "compact-meadow-v2"
        ? appearanceCandidate === NATURAL_TUFT_APPEARANCE.id
          ? NATURAL_TUFT_APPEARANCE
          : CURVED_MEADOW_APPEARANCE
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
        this.fineMeadow
          ? FINE_MEADOW_GRASS_VISUAL_PROFILE
          : this.profileId === "compact-meadow-v2"
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
    const bankField =
      workerSetup &&
      Object.getOwnPropertyDescriptor(workerSetup, "compactPondBankField");
    if (
      workerSetup &&
      "compactPondBankField" in workerSetup &&
      (!bankField?.enumerable ||
        !("value" in bankField) ||
        this.compactPondBlend !== "composition-v1")
    )
      throw new Error(
        "Grass pond bank field requires an own composition binding",
      );
    this.compactMacroField = workerSetup
      ? this.compactTerrainColorOperations.macroField(
          workerSetup.terrainConfig.TERRAIN_PROFILE,
          this.compactCoastBlend,
          this.compactPondBlend,
          bankField && "value" in bankField ? bankField.value : undefined,
          this.compactTerrainColorOperations.captureGroundVerge(
            workerSetup,
            "pondServiceGround",
          ),
        )
      : null;
    if (
      this.compactMacroField?.pondServiceGround &&
      (!this.fineMeadow || !this.compactGrassColorGrade)
    )
      throw new Error("Pond service ground requires the graded fine meadow");
    createGrassCoastBlendOperations().assertScope(
      this.compactCoastBlend,
      this.grassEligibility,
      this.compactMacroField,
    );
    createGrassPondBlendOperations().assertScope(
      this.compactPondBlend,
      this.grassEligibility,
      this.compactMacroField,
    );
    this.maxChunksPerFrame = Math.max(
      1,
      Math.floor(profile.maxChunksPerFrame ?? 2),
    );
    this.clumpSpacing =
      geometryCandidate === FINE_GRASS_MEADOW_FIELD_COMPOSITION.id
        ? FINE_GRASS_MEADOW_FIELD_COMPOSITION.clumpSpacing
        : GRASS_CONFIG.CLUMP_SPACING *
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

    this.geometryLayout = this.fineMeadow
      ? geometryCandidate === FINE_GRASS_MEADOW_FIELD_COMPOSITION.id
        ? FINE_GRASS_MEADOW_FIELD_SHAPE.GEOMETRY_LAYOUT
        : geometryCandidate === FINE_GRASS_CLOSE_DETAIL.id ||
            geometryCandidate === FINE_GRASS_ROOTED_FAN_COMPOSITION.id ||
            geometryCandidate === FINE_GRASS_MEADOW_CANOPY_COMPOSITION.id
          ? FINE_GRASS_CLOSE_DETAIL.geometryLayout
          : this.lightingCandidate === FINE_GRASS_LEAF_VOLUME_LIGHTING.id
            ? FINE_GRASS_FOLDED_BLADE_SHAPE.GEOMETRY_LAYOUT
            : FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT
      : undefined;
    this.lodGeometries = GRASS_CONFIG.LOD_TIERS.map((_, lod) => {
      const layout = getGrassBladeLayout(lod, this.geometryLayout);
      const folded = isFoldedGrassBladeLayout(lod, this.geometryLayout);
      return createClumpGeometry(
        layout.bladesPerClump,
        layout.bladeSegments,
        geometryCandidate === FINE_GRASS_MEADOW_FIELD_COMPOSITION.id
          ? FINE_GRASS_MEADOW_FIELD_SHAPE
          : geometryCandidate === FINE_GRASS_MEADOW_CANOPY_COMPOSITION.id
            ? FINE_GRASS_MEADOW_CANOPY_SHAPE
            : geometryCandidate === FINE_GRASS_ROOTED_FAN_COMPOSITION.id
              ? FINE_GRASS_ROOTED_FAN_SHAPE
              : folded
                ? FINE_GRASS_FOLDED_BLADE_SHAPE
                : (this.meadowAppearance ?? GRASS_CONFIG),
        folded
          ? layout.bladeSegments === 5
            ? "folded-sheath-v1"
            : "folded-lancet-v1"
          : undefined,
      );
    });
    this.material = this.createMaterial();
    // Construct only after all profile checks and material setup. A failed
    // native Worker construction must not leak the already-owned GPU objects.
    try {
      if (usesGrassBladeHeightFlex(this.geometryLayout)) {
        if (!this.foldedBladeNormalNode)
          throw new Error("Folded grass requires its physical normal graph");
        // Clone once so near/far materials share time, player and light
        // uniforms. Calling createMaterial twice would orphan uniform owners.
        this.foldedMaterial = this.material.clone();
        this.foldedMaterial.normalNode = this.foldedBladeNormalNode;
        if (this.foldedMaterial instanceof MeshSSSNodeMaterial)
          publishFineGrassLighting(this.foldedMaterial, this.geometryLayout);
        if (this.habitatComposition)
          Object.defineProperty(
            this.foldedMaterial.userData,
            "compactHabitatComposition",
            {
              enumerable: true,
              configurable: false,
              writable: false,
              value: this.habitatComposition,
            },
          );
        publishFineGrassCanopyLighting(
          this.foldedMaterial,
          this.lightingCandidate,
          true,
          this.geometryLayout,
        );
      }
      this.groundingWorker = groundingWorkerSetup
        ? new GrassGroundingWorkerCoordinator(
            groundingWorkerSetup.createPort(),
            groundingWorkerSetup.isSurfaceCurrent,
          )
        : null;
    } catch (error) {
      this.lodGeometries.forEach((geometry) => geometry.dispose());
      this.material.dispose();
      this.foldedMaterial?.dispose();
      throw error;
    }
    if (this.compactMeadow) {
      let radius = 0;
      const lastGroundedTier = usesGrassCloseDetailLods(this.geometryLayout)
        ? 2
        : 1;
      for (let tier = this.minimumLodLevel; tier <= lastGroundedTier; tier++) {
        const positions = this.lodGeometries[tier].getAttribute("position");
        for (let i = 0; i < positions.count; i++)
          radius = Math.max(
            radius,
            Math.hypot(positions.getX(i), positions.getY(i), positions.getZ(i)),
          );
      }
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
      const layout = getGrassBladeLayout(i, this.geometryLayout);
      const range = this.fineMeadow
        ? usesGrassCloseDetailLods(this.geometryLayout)
          ? ["<12m", "12–40m", "40–140m"][i]
          : i === 0
            ? "<40m"
            : i === 1
              ? "40–140m"
              : "inactive"
        : `<${t.maxDistance === Infinity ? "inf" : t.maxDistance}m`;
      return (
        `LOD${i}(${layout.bladesPerClump}b/${layout.bladeSegments}s, ` +
        `${g.attributes.position.count}v, ${g.index!.count / 3}t, ` +
        `${range}, ` +
        `×${this.spacingMultiplierForLod(i)})`
      );
    });
    console.log(
      `[GrassVisualManager] ${tierDescs.length} LOD tiers | ` +
        `spacing ${this.clumpSpacing}m | min LOD${this.minimumLodLevel} | ` +
        (this.fineMeadow
          ? usesGrassCloseDetailLods(this.geometryLayout)
            ? "cells25m | detail12m/near40m (10% hysteresis) | "
            : "cells25m | near40m (36/44m hysteresis) | "
          : "") +
        `range ${this.maxRenderDistance}m | ${workerStatus} | ${tierDescs.join(" | ")}`,
    );
  }

  // -- Public API -----------------------------------------------------------

  /** Current owner configuration/counters, not a GPU or visibility qualification. */
  getProfileReceipt(): StreamingGrassProfileReceipt {
    let installedClumps = 0;
    let castShadow = false;
    let correctionBytes = 0;
    let visibilityBytes = 0;
    for (const { mesh } of this.chunks.values()) {
      installedClumps += mesh.count;
      castShadow ||= mesh.castShadow;
      correctionBytes +=
        mesh.geometry.getAttribute("grassRootDeltas")?.array.byteLength ?? 0;
      if (this.roadClearance)
        visibilityBytes +=
          mesh.geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)?.array
            .byteLength ?? 0;
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
      ...(this.geometryLayout === undefined
        ? {}
        : { geometryLayout: this.geometryLayout }),
      ...(this.geometryCandidate === undefined
        ? {}
        : { geometryCandidate: this.geometryCandidate }),
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
      ...(this.fineMeadow
        ? {
            placement: {
              schemaVersion: 1 as const,
              mode: "world-cells-v1" as const,
              cellSize: 25 as const,
              nearLodDistance: 40 as const,
              ...(usesGrassCloseDetailLods(this.geometryLayout)
                ? { detailLodDistance: FINE_GRASS_CLOSE_DETAIL.detailDistance }
                : {}),
              liveCells: this.liveWorkUnits.size,
              ...(this.placementDistribution
                ? { placementDistribution: this.placementDistribution }
                : {}),
              ...(this.coverageTrial
                ? { coverageTrial: this.coverageTrial }
                : {}),
            },
          }
        : {}),
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
              ...(this.roadClearance
                ? {
                    roadClearance: {
                      mode: this.roadClearance,
                      visibilityBytes,
                    },
                  }
                : {}),
              activeSliceMs: this.groundingActiveMs,
              maximumSliceMs: this.maximumGroundingSliceMs,
              ...(this.groundingWorker
                ? {
                    execution: "worker-v1" as const,
                    worker: this.groundingWorker.receipt,
                  }
                : {}),
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
    const requiredNodes = nodes
      .filter((node) => node.isFinal && node.isMaxDepth)
      .flatMap((node) => this.workUnitsFor(node))
      .filter(
        (work) =>
          this.workDistanceSquared(work, this.playerX, this.playerZ) <=
          radiusSquared,
      );
    let readyChunks = 0;
    for (const work of requiredNodes) {
      const { node, key } = work;
      if (
        this.liveWorkUnits.get(key) === work &&
        this.completedNodes.get(key) === node &&
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
    const tiers = usesGrassCloseDetailLods(this.geometryLayout)
      ? [0, 1, 2]
      : [this.minimumLodLevel];
    // Detail introduces three distinct root-addressing/normal programs. Warm
    // every admitted tier during startup, not on the first boundary crossing.
    for (const lod of tiers) {
      if (this.destroyed)
        throw new Error("Grass destroyed during precompilation");
      await this.precompileLodChunk(lod, precompileObject);
      if (this.destroyed)
        throw new Error("Grass destroyed during precompilation");
    }
  }

  private async precompileLodChunk(
    lod: number,
    precompileObject: (object: THREE.Object3D) => Promise<void>,
  ): Promise<void> {
    const geo = this.lodGeometries[lod].clone();
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

    const layout = getGrassBladeLayout(lod, this.geometryLayout);
    const baseMaterial = this.materialForLod(lod);
    const material = this.compactMeadow
      ? createGroundedGrassMaterial(
          baseMaterial,
          geo,
          new Float32Array(layout.bladesPerClump * layout.rootComponents),
          1,
          lod,
          this.geometryLayout,
          this.roadClearance
            ? new Uint32Array([2 ** layout.bladesPerClump - 1])
            : undefined,
        )
      : baseMaterial;
    // NodeMaterial clones userData through JSON; restore the immutable receipt
    // on the actual representative owner without changing any shader nodes.
    if (material instanceof MeshSSSNodeMaterial)
      publishFineGrassLighting(material, this.geometryLayout);
    if (this.lightingCandidate)
      publishFineGrassCanopyLighting(
        material,
        this.lightingCandidate,
        baseMaterial === this.foldedMaterial,
        this.geometryLayout,
      );
    const mesh = createStorageInstancedMesh(geo, material, 1);
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
      if (material !== baseMaterial) material.dispose();
      mesh.dispose();
    }
  }

  /** Snapshot only at the primary ClientGraphics render boundary. Never perform
   * placement, grounding, uploads or LOD publication inside a render pass.
   * The next update consumes this last actually rendered view: camera cuts have
   * one update of scheduling latency, then the normal bounded LOD convergence.
   * Shadow/reflection camera traversals must not call this primary-view hook. */
  capturePrimaryView(camera: THREE.Camera): void {
    if (this.destroyed || !this.fineMeadow) return;
    camera.updateWorldMatrix(true, false);
    this.hasPrimaryView = true;
    this.primaryViewX = camera.matrixWorld.elements[12];
    this.primaryViewZ = camera.matrixWorld.elements[14];
    this.primaryViewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.primaryViewValid = false;
    for (let i = 0; i < 16; i++) {
      if (
        !Number.isFinite(camera.matrixWorld.elements[i]) ||
        !Number.isFinite(this.primaryViewProjection.elements[i])
      )
        return;
    }
    if (
      camera.coordinateSystem !== THREE.WebGPUCoordinateSystem &&
      camera.coordinateSystem !== THREE.WebGLCoordinateSystem
    )
      return;
    this.primaryViewFrustum.setFromProjectionMatrix(
      this.primaryViewProjection,
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    for (let i = 0; i < this.primaryViewFrustum.planes.length; i++) {
      const plane = this.primaryViewFrustum.planes[i];
      if (
        !Number.isFinite(plane.constant) ||
        !Number.isFinite(plane.normal.x) ||
        !Number.isFinite(plane.normal.y) ||
        !Number.isFinite(plane.normal.z) ||
        plane.normal.lengthSq() === 0
      )
        return;
    }
    this.primaryViewValid = true;
  }

  update(playerX: number, playerZ: number, camera?: THREE.Camera): void {
    if (this.destroyed) return;
    this.playerX = playerX;
    this.playerZ = playerZ;
    const usePrimaryView = this.fineMeadow && this.hasPrimaryView;
    this.lodFocusX = usePrimaryView
      ? this.primaryViewX
      : (camera?.matrixWorld.elements[12] ?? playerX);
    this.lodFocusZ = usePrimaryView
      ? this.primaryViewZ
      : (camera?.matrixWorld.elements[14] ?? playerZ);
    if (this.fineMeadow) this.container.updateWorldMatrix(true, false);
    this.playerPosUniform.value.set(playerX, 0, playerZ);
    this.reconcileGrassHorizon();
    this.cancelObsoleteLodWork();
    if (this.fineMeadow)
      this.pendingNodes.sort(
        (a, b) =>
          this.workDistanceSquared(
            a.work ?? this.resolveWorkUnit(a.node),
            this.lodFocusX,
            this.lodFocusZ,
          ) -
          this.workDistanceSquared(
            b.work ?? this.resolveWorkUnit(b.node),
            this.lodFocusX,
            this.lodFocusZ,
          ),
      );

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
      const pending = this.pendingNodes.shift()!;
      const { node, lod } = pending;
      const work = pending.work ?? this.resolveWorkUnit(node);
      if (!this.isNodeInGrassHorizon(work)) continue;
      if (!this.getRenderedSurface(node)) continue;
      const key = work.key;
      if (
        this.chunks.has(key) ||
        this.completedNodes.has(key) ||
        this.workerInflight.has(key) ||
        this.groundingJobs.has(key)
      )
        continue;
      if (pool && this.workerSetup) {
        this.dispatchToWorker(work, key);
        dispatched++;
      } else {
        this.createChunkMesh(work, lod);
        built++;
      }
    }

    if ((!camera && !usePrimaryView) || this.chunks.size === 0) return;

    if (usePrimaryView) {
      if (this.primaryViewValid) this.frustum.copy(this.primaryViewFrustum);
    } else if (camera) {
      this.projScreenMatrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      this.frustum.setFromProjectionMatrix(
        this.projScreenMatrix,
        camera.coordinateSystem,
        camera.reversedDepth,
      );
    }

    for (const [key, chunk] of this.chunks) {
      // This cached primary (or legacy update) view only prioritizes LOD work. Never publish its cull
      // result into Object3D.visible: a later camera/director or secondary pass
      // must test its own frustum against the actual shader-displaced bounds.
      if (
        ((!usePrimaryView || this.primaryViewValid) &&
          !this.frustum.intersectsBox(chunk.box)) ||
        built >= this.maxChunksPerFrame
      )
        continue;

      const desiredLod = this.desiredLod(chunk.work);

      if (desiredLod !== chunk.lodLevel) {
        const nodeKey = key;
        const workerPool = getGrassWorkerPool();
        this.pendingLodSwap.set(nodeKey, {
          node: chunk.node,
          work: chunk.work,
          desiredLod,
        });
        if (workerPool && this.workerSetup) {
          if (
            !this.workerInflight.has(nodeKey) &&
            !this.groundingJobs.has(nodeKey) &&
            dispatched < this.maxChunksPerFrame
          ) {
            this.dispatchLodSwap(chunk.work, nodeKey, desiredLod);
            dispatched++;
          }
        } else if (
          !this.workerInflight.has(key) &&
          !this.groundingJobs.has(key)
        ) {
          this.createChunkMesh(chunk.work, desiredLod, true);
          built++;
        }
      } else if (this.pendingLodSwap.has(key)) {
        // The camera returned to the displayed tier before the swap completed.
        // Cancel its ticket; a late result must not replace the correct mesh.
        this.pendingLodSwap.delete(key);
        this.workerInflight.delete(key);
        this.groundingJobs.get(key)?.job.cancel();
        this.groundingJobs.delete(key);
        this.settledWorkerResults = this.settledWorkerResults.filter(
          (entry) => entry.ticket.key !== key,
        );
      }
    }
  }

  private isNodeInGrassHorizon(source: GrassWorkSource): boolean {
    const work = this.resolveWorkUnit(source);
    const { node } = work;
    if (this.destroyed || !node.isFinal || !node.isMaxDepth) return false;
    if (
      this.liveWorkUnits.get(work.key) !== work ||
      this.liveNodes.get(this.chunkKey(node)) !== node
    )
      return false;
    return (
      this.workDistanceSquared(work, this.playerX, this.playerZ) <=
      this.maxRenderDistance * this.maxRenderDistance
    );
  }

  private retireGrassWork(key: string): void {
    this.workerInflight.delete(key);
    this.pendingLodSwap.delete(key);
    this.completedNodes.delete(key);
    this.completedSurfaces.delete(key);
    this.completedLods.delete(key);
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
      if (
        chunk.mesh.material !== this.material &&
        chunk.mesh.material !== this.foldedMaterial
      )
        chunk.mesh.material.dispose();
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
    const request: GrassGroundingHandoffRequest | undefined =
      !error &&
      region &&
      inputs &&
      (ticket.lodLevel === 1 ||
        (manager.fineMeadow && ticket.lodLevel === 0) ||
        (usesGrassCloseDetailLods(manager.geometryLayout) &&
          ticket.lodLevel === 2))
        ? {
            data,
            ownSurface: ticket.surface,
            surfaces: region.surfaces,
            geometry: manager.lodGeometries[ticket.lodLevel],
            lod: ticket.lodLevel,
            ...(manager.geometryLayout === undefined
              ? {}
              : { geometryLayout: manager.geometryLayout }),
            ...(manager.roadClearance
              ? { roadClearance: manager.roadClearance }
              : {}),
            ...(manager.fineMeadow &&
            manager.compactGrassColorGrade &&
            manager.compactMacroField?.coastalMeadow &&
            manager.compactMacroField.bankVerge
              ? { bankVerge: manager.compactMacroField.bankVerge }
              : {}),
            ...(manager.compactMacroField?.pondServiceGround
              ? {
                  pondServiceGround:
                    manager.compactMacroField.pondServiceGround,
                }
              : {}),
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
          }
        : undefined;
    const steps = function* (): Generator<
      string,
      GrassBladeGroundingResult,
      void
    > {
      if (error) throw error;
      if (!request || !inputs)
        throw new Error("Incomplete compact grass grounding inputs");
      return yield* prepareGroundedGrassSteps(
        request,
        inputs,
        manager.getWaterSurfaceAt,
        manager.isInFlatZone,
      );
    };
    const isCurrent = () =>
      this.groundingJobs.get(ticket.key) === entry &&
      this.isNodeInGrassHorizon(ticket.work) &&
      this.isTicketLodCurrent(ticket) &&
      this.getRenderedSurface(ticket.node) === ticket.surface &&
      (!region || region.isCurrent()) &&
      (!inputs || inputs.isCurrent());
    const entry: GrassGroundingEntry = {
      ticket,
      region,
      job:
        this.groundingWorker && request && inputs
          ? this.groundingWorker.createJob(
              request,
              inputs,
              this.getWaterSurfaceAt,
              this.isInFlatZone,
              isCurrent,
            )
          : new GrassGroundingContinuation(steps(), isCurrent),
    };
    this.groundingJobs.get(ticket.key)?.job.cancel();
    this.groundingJobs.set(ticket.key, entry);
  }

  /** One shared compute slice and at most one upload for the entire manager,
   * not one allowance per resident chunk. Stable waits/failures do no work. */
  private advanceGroundingJob(): number {
    const deadline =
      performance.now() + GRASS_BLADE_GROUNDING_JOB_LIMITS.targetSliceMs;
    let remainingOperations =
      GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumSliceOperations;
    if (this.groundingWorker) {
      const maintenance = this.groundingWorker.advanceMaintenance(
        remainingOperations,
        deadline,
      );
      remainingOperations -= maintenance.operations;
      this.groundingActiveMs += maintenance.activeMs;
      this.maximumGroundingSliceMs = Math.max(
        this.maximumGroundingSliceMs,
        maintenance.activeMs,
      );
    }
    while (remainingOperations > 0 && performance.now() < deadline) {
      let selected: GrassGroundingEntry | undefined;
      let selectedDistance = Infinity;
      for (const entry of this.groundingJobs.values()) {
        if (entry.job.state.status !== "running") continue;
        // Finish or cancel the sole active handoff before preparing any other
        // payload, even if camera motion makes another cell nearer.
        if (entry.job === this.groundingWorker?.activeJob) {
          selected = entry;
          break;
        }
        if (!this.fineMeadow) {
          selected = entry;
          break;
        }
        const distance = this.workDistanceSquared(
          entry.ticket.work,
          this.lodFocusX,
          this.lodFocusZ,
        );
        if (!selected || distance < selectedDistance) {
          selected = entry;
          selectedDistance = distance;
        }
      }
      if (selected) {
        const entry = selected;
        const state = entry.job.advance(remainingOperations, deadline);
        // Remote fitting consumes its own cumulative cap, not another frame's
        // main-thread allowance. These metrics cover only this actual advance.
        remainingOperations -= entry.job.lastSliceOperations;
        this.groundingActiveMs += entry.job.lastSliceMs;
        // Historical metric: maximum individual continuation slice, not the
        // aggregate manager call when ready-empty work hands off. The shared
        // deadline is cooperative; allocations/GC remain non-preemptible.
        this.maximumGroundingSliceMs = Math.max(
          this.maximumGroundingSliceMs,
          entry.job.maximumSliceMs,
        );
        if (
          state.status === "failed_input" ||
          state.status === "failed_budget"
        ) {
          // A failed job is no longer selected above: retain one bounded record
          // at its transition, even if later LOD/horizon retirement removes it.
          // A serialized scalar snapshot survives truncated console object
          // previews. This failure-only observation does not change work caps.
          const failure = {
            ...captureGrassGroundingFailure(entry.job, {
              key: entry.ticket.key,
              nodeId: entry.ticket.node.id,
              lod: entry.ticket.lodLevel,
              isLodSwap: entry.ticket.isLodSwap,
              bounds: entry.ticket.work.bounds,
            }),
            // A cached failure may outlive a different owner's admission
            // failure. This is context, not a causal join to the current job.
            workerAdmissionContext: this.groundingWorker
              ? {
                  association: "last-observed-not-necessarily-this-job",
                  lastFailure:
                    this.groundingWorker.receipt.lastAdmissionFailure,
                }
              : null,
          };
          console.error(
            "[GrassVisualManager] Grounding failed: " + JSON.stringify(failure),
          );
        }
        if (state.status === "cancelled")
          this.groundingJobs.delete(entry.ticket.key);
        // Local worker-handoff stages may share this existing frame allowance.
        // Each advance has already charged its ledger before the next dispatch;
        // never spin on a pending reply or a stage that made no operation progress.
        if (
          state.status === "running" &&
          entry.job === this.groundingWorker?.activeJob &&
          "phase" in entry.job &&
          entry.job.phase !== "waiting_worker" &&
          entry.job.lastSliceOperations > 0
        )
          continue;
        if (state.status !== "ready") return 0;
        const { ticket, region } = entry;
        const inputs = ticket.grounding?.inputs;
        if (
          !region ||
          !inputs ||
          !region.isCurrent() ||
          !inputs.isCurrent() ||
          !this.isNodeInGrassHorizon(ticket.work) ||
          !this.isTicketLodCurrent(ticket) ||
          this.getRenderedSurface(ticket.node) !== ticket.surface
        ) {
          entry.job.cancel();
          this.groundingJobs.delete(ticket.key);
          return 0;
        }
        try {
          const result = state.result;
          if (!result.grounding)
            throw new Error("Missing blade-grounding provenance");
          this.assertBladeRoadClearance(result);
          this.retireGrassChunk(ticket.key);
          if (result.data.count) {
            this.createChunkMeshFromWorkerData(
              ticket.work,
              {
                ...result.data,
                type: "grassInstanceResult",
                ...(this.compactMacroField?.pondServiceGround
                  ? {
                      pondServiceGround:
                        this.compactMacroField.pondServiceGround,
                    }
                  : {}),
                chunkKey: ticket.key,
                terrainProfileIdentity: this.terrainProfileIdentity,
                grassEligibility: this.grassEligibility,
                ...(this.compactCoastBlend
                  ? { compactCoastBlend: this.compactCoastBlend }
                  : {}),
                ...(this.compactPondBlend
                  ? { compactPondBlend: this.compactPondBlend }
                  : {}),
                ...(this.compactGrassColorGrade
                  ? { compactGrassColorGrade: this.compactGrassColorGrade }
                  : {}),
                ...(ticket.work.placementCell
                  ? { placementCell: ticket.work.placementCell }
                  : {}),
                ...(this.placementDistribution
                  ? { placementDistribution: this.placementDistribution }
                  : {}),
                ...this.coverageMarker(ticket.work.placementCell),
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
          this.completedLods.set(ticket.key, ticket.lodLevel);
          this.completedGrounding.set(ticket.key, { region, inputs });
          this.pendingLodSwap.delete(ticket.key);
          this.groundingJobs.delete(ticket.key);
          if (result.data.count) return 1;
          // Validated ready-empty publication needs no mesh upload. Re-select the
          // nearest job using only this call's remaining time and operations.
          continue;
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
    return 0;
  }

  private reconcileGrassHorizon(): void {
    const pendingKeys = new Set(
      this.pendingNodes.map(
        (entry) => (entry.work ?? this.resolveWorkUnit(entry.node)).key,
      ),
    );
    const retired = new Set<string>();
    for (const node of this.liveNodes.values()) {
      if (!node.isFinal || !node.isMaxDepth) {
        this.onNodeDestroyGeometry(node);
        continue;
      }
      for (const work of this.workUnitsFor(node)) {
        const key = work.key;
        if (this.liveWorkUnits.get(key) !== work) continue;
        if (!this.isNodeInGrassHorizon(work)) {
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
            !this.isCompletedGroundingCurrent(key)) ||
          (this.fineMeadow &&
            this.completedNodes.has(key) &&
            !this.chunks.has(key) &&
            this.completedLods.get(key) !== this.getLodLevel(work))
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
          this.pendingNodes.push({ node, work });
          pendingKeys.add(key);
        }
      }
    }
    if (retired.size) {
      this.pendingNodes = this.pendingNodes.filter(
        (entry) =>
          !retired.has((entry.work ?? this.resolveWorkUnit(entry.node)).key),
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
    const previous = this.liveNodes.get(key);
    if (previous && previous !== node) this.onNodeDestroyGeometry(previous);
    const works = this.workUnitsFor(node);
    const replacedParents = new Set<TerrainQuadNode>();
    for (const work of works) {
      const previousWork = this.liveWorkUnits.get(work.key);
      if (previousWork && previousWork.node !== node)
        replacedParents.add(previousWork.node);
    }
    for (const replaced of replacedParents)
      this.onNodeDestroyGeometry(replaced);
    this.liveNodes.set(key, node);
    for (const work of works) {
      const previousWork = this.liveWorkUnits.get(work.key);
      if (previousWork && previousWork !== work) this.retireGrassWork(work.key);
      this.liveWorkUnits.set(work.key, work);
      if (!this.isNodeInGrassHorizon(work)) continue;
      if (
        this.chunks.has(work.key) ||
        this.completedNodes.has(work.key) ||
        this.workerInflight.has(work.key) ||
        this.groundingJobs.has(work.key)
      )
        continue;
      if (!this.pendingNodes.some((entry) => entry.work === work)) {
        this.pendingNodes.push({ node, work });
      }
    }
  }

  private dispatchLodSwap(
    node: GrassWorkSource,
    key: string,
    desiredLod: number,
  ): void {
    this.dispatchWorkerRequest(node, key, desiredLod, true);
  }

  private dispatchToWorker(node: GrassWorkSource, key: string): void {
    this.dispatchWorkerRequest(node, key, this.getLodLevel(node), false);
  }

  private createWorkerInput(
    source: GrassWorkSource,
    key: string,
    lodLevel: number,
  ): GrassWorkerInput {
    const ws = this.workerSetup!;
    const work = this.resolveWorkUnit(source);
    const { node, bounds } = work;
    const normalHalo = GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE;
    return prepareGrassWorkerRequest({
      grassEligibility: this.grassEligibility,
      ...(this.compactCoastBlend
        ? { compactCoastBlend: this.compactCoastBlend }
        : {}),
      ...(this.compactPondBlend
        ? { compactPondBlend: this.compactPondBlend }
        : {}),
      ...(this.compactGrassColorGrade
        ? { compactGrassColorGrade: this.compactGrassColorGrade }
        : {}),
      type: "generateGrassInstances",
      compactPlantingLobes: ws.compactPlantingLobes,
      ...(this.compactMacroField?.pondServiceGround
        ? { pondServiceGround: this.compactMacroField.pondServiceGround }
        : {}),
      chunkKey: key,
      centerX: node.centerX,
      centerZ: node.centerZ,
      size: node.size,
      ...(work.placementCell ? { placementCell: work.placementCell } : {}),
      ...(this.placementDistribution
        ? { placementDistribution: this.placementDistribution }
        : {}),
      ...this.coverageMarker(work.placementCell),
      spacingMul: this.spacingMultiplierForLod(lodLevel),
      config: ws.terrainConfig,
      seed: ws.seed,
      biomeCenters: ws.biomeCenters,
      biomes: ws.biomes,
      grassSeed: GRASS_CONFIG.SEED,
      clumpSpacing: this.placementSpacing(work.placementCell),
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
        bounds.minX,
        bounds.minZ,
        bounds.maxX,
        bounds.maxZ,
      ),
      roadBlendWidth: 0.5,
      tileSize: ws.tileSize,
      terrainSurface: ws.getTerrainSurfaceForRegion(
        bounds.minX - normalHalo,
        bounds.minZ - normalHalo,
        bounds.maxX + normalHalo,
        bounds.maxZ + normalHalo,
      ),
    });
  }

  private createWorkerTicket(
    source: GrassWorkSource,
    key: string,
    lodLevel: number,
    isLodSwap: boolean,
  ): GrassWorkerTicket {
    const work = this.resolveWorkUnit(source);
    const { node } = work;
    if (key !== work.key) throw new Error("Grass work unit key mismatch");
    const surface = this.getRenderedSurface(node);
    if (
      !surface ||
      surface.nodeId !== node.id ||
      surface.terrainProfileIdentity !== this.terrainProfileIdentity
    )
      throw new Error("Grass requires the current retained terrain surface");
    let grounding: GrassWorkerTicket["grounding"];
    if (this.compactMeadow) {
      const bounds = Object.freeze({
        minX: work.bounds.minX - this.groundingHalo,
        maxX: work.bounds.maxX + this.groundingHalo,
        minZ: work.bounds.minZ - this.groundingHalo,
        maxZ: work.bounds.maxZ + this.groundingHalo,
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
      work,
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
    return (
      !this.destroyed &&
      this.workerInflight.get(ticket.key) === ticket &&
      this.liveWorkUnits.get(ticket.key) === ticket.work
    );
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
    if (!this.isNodeInGrassHorizon(ticket.work)) {
      this.workerInflight.delete(ticket.key);
      this.pendingLodSwap.delete(ticket.key);
      return;
    }
    this.assertWorkerProfileIdentity(output);
    this.assertPlacementCell(output, ticket.work);
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
      this.isNodeInGrassHorizon(ticket.work) &&
      !this.chunks.has(ticket.key) &&
      !this.pendingNodes.some((entry) => entry.work === ticket.work)
    ) {
      this.pendingNodes.push({ node: ticket.node, work: ticket.work });
    }
  }

  private dispatchWorkerRequest(
    source: GrassWorkSource,
    key: string,
    lodLevel: number,
    isLodSwap: boolean,
  ): void {
    const work = this.resolveWorkUnit(source);
    const { node } = work;
    if (!this.isNodeInGrassHorizon(work) || this.workerInflight.has(key))
      return;
    if (!this.getRenderedSurface(node)) return;
    const pool = getGrassWorkerPool()!;
    const input = this.createWorkerInput(work, key, lodLevel);
    const ticket = this.createWorkerTicket(work, key, lodLevel, isLodSwap);
    try {
      pool
        .execute(input)
        .then((output: GrassWorkerOutput) =>
          this.settleWorkerResult(
            ticket,
            admitGrassWorkerPlacementResult(output, input),
          ),
        )
        .catch((error: unknown) => this.rejectWorkerResult(ticket, error));
    } catch (error) {
      this.rejectWorkerResult(ticket, error);
    }
  }

  private assertWorkerProfileIdentity(data: GrassWorkerOutput): void {
    const receivedService =
      this.compactTerrainColorOperations.captureGroundVerge(
        data,
        "pondServiceGround",
      );
    if (
      JSON.stringify(receivedService) !==
      JSON.stringify(this.compactMacroField?.pondServiceGround)
    )
      throw new Error("Grass visual result pond service ground mismatch");
    if (
      createGrassPondBlendOperations().validate(data) !== this.compactPondBlend
    )
      throw new Error("Grass visual result pond distribution mismatch");
    if (
      createGrassCoastBlendOperations().validate(data) !==
      this.compactCoastBlend
    )
      throw new Error("Grass visual result coastal distribution mismatch");
    if (data.terrainProfileIdentity !== this.terrainProfileIdentity) {
      throw new Error("Grass visual result profile identity mismatch");
    }
    if ((data.grassEligibility ?? "legacy-biome-v1") !== this.grassEligibility)
      throw new Error("Grass visual result eligibility mismatch");
    if (
      data.compactGrassColorGrade !== this.compactGrassColorGrade ||
      (!this.compactGrassColorGrade &&
        Object.prototype.hasOwnProperty.call(data, "compactGrassColorGrade"))
    )
      throw new Error("Grass visual result grass color grade mismatch");
    if (
      data.placementDistribution !== this.placementDistribution ||
      Object.prototype.hasOwnProperty.call(data, "placementDistribution") !==
        (this.placementDistribution !== undefined)
    )
      throw new Error("Grass visual result placement distribution mismatch");
  }

  /** Includes ready-empty results: a mode mismatch must not become completed. */
  private assertBladeRoadClearance(
    blades: Extract<GrassBladeGroundingResult, { status: "ready" }>,
  ): void {
    const visibility = blades.bladeVisibility;
    const receipt = blades.receipt.roadClearance;
    if (
      this.roadClearance
        ? receipt?.mode !== this.roadClearance ||
          !(visibility instanceof Uint32Array) ||
          visibility.length !== blades.data.count ||
          receipt.visibilityBytes !== visibility.byteLength
        : visibility !== undefined || receipt !== undefined
    )
      throw new Error("Grass visual blade road-clearance identity mismatch");
  }

  private createChunkMeshFromWorkerData(
    source: GrassWorkSource,
    data: GrassWorkerOutput,
    lodLevel: number,
    grounding: GrassGrounding,
    blades?: Extract<GrassBladeGroundingResult, { status: "ready" }>,
  ): void {
    const work = this.resolveWorkUnit(source);
    const { node } = work;
    this.assertWorkerProfileIdentity(data);
    this.assertPlacementCell(data, work);
    if (!this.isNodeInGrassHorizon(work)) return;
    const key = data.chunkKey;
    if (key !== work.key) throw new Error("Grass work unit key mismatch");
    if (this.chunks.has(key)) return;
    if (blades) this.assertBladeRoadClearance(blades);
    if (data.count === 0) return;
    if (
      this.compactMeadow &&
      (!blades ||
        !blades.grounding ||
        blades.data.count !== data.count ||
        blades.receipt.geometryLayout !== this.geometryLayout ||
        grounding !== blades.grounding)
    )
      throw new Error(
        "Compact grass requires complete blade grounding and provenance",
      );

    const geo = this.lodGeometries[lodLevel].clone();
    const baseMaterial = this.materialForLod(lodLevel);
    let material = baseMaterial;
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
          baseMaterial,
          geo,
          blades.rootDeltas,
          data.count,
          lodLevel,
          this.geometryLayout,
          blades.bladeVisibility,
        );
      if (material instanceof MeshSSSNodeMaterial)
        publishFineGrassLighting(material, this.geometryLayout);
      if (this.lightingCandidate)
        publishFineGrassCanopyLighting(
          material,
          this.lightingCandidate,
          baseMaterial === this.foldedMaterial,
          this.geometryLayout,
        );
      // Three clones userData through JSON. Rebind the admitted terrain field
      // so each grounded chunk retains the same immutable material owner.
      if (this.habitatComposition && material !== baseMaterial)
        Object.defineProperty(material.userData, "compactHabitatComposition", {
          enumerable: true,
          writable: false,
          configurable: false,
          value: this.habitatComposition,
        });
      mesh = createStorageInstancedMesh(geo, material, data.count);
      mesh.position.set(node.centerX, 0, node.centerZ);
      // Chunk-local placement is immutable; parent/world transforms stay live.
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
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
        ...(work.placementCell
          ? { grassPlacementCell: work.placementCell }
          : {}),
        ...(data.placementCoverage
          ? { grassPlacementCoverage: data.placementCoverage }
          : {}),
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
      this.chunks.set(key, {
        nodeId: node.id,
        mesh,
        box,
        lodLevel,
        node,
        work,
      });
    } catch (error) {
      mesh?.removeFromParent();
      geo.dispose();
      if (material !== baseMaterial) material.dispose();
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
      if (!this.isNodeInGrassHorizon(ticket.work)) {
        this.workerInflight.delete(ticket.key);
        this.pendingLodSwap.delete(ticket.key);
        this.completedNodes.delete(ticket.key);
        this.completedSurfaces.delete(ticket.key);
        continue;
      }

      try {
        this.assertWorkerProfileIdentity(result.data);
        this.assertPlacementCell(result.data, ticket.work);
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

      if (this.compactMeadow && !this.isTicketLodCurrent(ticket)) {
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
        ? this.getLodLevel(ticket.work)
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
            work: ticket.work,
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
        ticket.work,
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
    if (this.liveNodes.get(key) === node) this.liveNodes.delete(key);
    for (const work of this.nodeWorkUnits.get(node) ?? []) {
      if (this.liveWorkUnits.get(work.key) !== work) continue;
      this.liveWorkUnits.delete(work.key);
      this.retireGrassWork(work.key);
    }
    this.nodeWorkUnits.delete(node);
    this.settledWorkerResults = this.settledWorkerResults.filter(
      (entry) => entry.ticket.node !== node,
    );
    this.pendingNodes = this.pendingNodes.filter(
      (entry) => entry.node !== node,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.meadowDetailMaterialFactory = null;
    this.pendingNodes.length = 0;
    this.settledWorkerResults.length = 0;
    this.workerInflight.clear();
    this.liveNodes.clear();
    this.liveWorkUnits.clear();
    this.nodeWorkUnits.clear();
    this.completedNodes.clear();
    this.completedSurfaces.clear();
    this.completedLods.clear();
    for (const entry of this.groundingJobs.values()) entry.job.cancel();
    this.groundingJobs.clear();
    this.groundingWorker?.destroy();
    this.completedGrounding.clear();
    this.pendingLodSwap.clear();
    terminateGrassWorkerPool();
    for (const key of this.chunks.keys()) this.retireGrassChunk(key);
    this.lodGeometries.forEach((g) => g.dispose());
    if (this.material) this.material.dispose();
    this.foldedMaterial?.dispose();
    if (this.container.parent) this.container.parent.remove(this.container);
  }

  /**
   * Destroy and recreate all grass chunks (e.g. after road data loads).
   */
  rebuildAllChunks(): void {
    if (this.destroyed) return;
    for (const key of this.chunks.keys()) {
      this.retireGrassChunk(key);
    }
    for (const entry of this.groundingJobs.values()) entry.job.cancel();
    this.groundingJobs.clear();
    this.completedGrounding.clear();
    this.completedNodes.clear();
    this.completedSurfaces.clear();
    this.completedLods.clear();
    this.workerInflight.clear();
    this.pendingLodSwap.clear();
    this.settledWorkerResults.length = 0;
    this.pendingNodes.length = 0;
    for (const work of this.liveWorkUnits.values()) {
      if (this.isNodeInGrassHorizon(work)) {
        this.pendingNodes.push({ node: work.node, work });
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
    const affectedKeys = new Set<string>();
    const toRebuild: GrassWorkUnit[] = [];
    for (const [key, work] of this.liveWorkUnits) {
      const halo = Math.max(
        GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
        this.groundingHalo,
      );
      if (
        work.bounds.maxX + halo < minX ||
        work.bounds.minX - halo > maxX ||
        work.bounds.maxZ + halo < minZ ||
        work.bounds.minZ - halo > maxZ
      )
        continue;
      affectedKeys.add(key);
      this.retireGrassWork(key);
      if (this.isNodeInGrassHorizon(work)) toRebuild.push(work);
    }
    this.settledWorkerResults = this.settledWorkerResults.filter(
      (entry) => !affectedKeys.has(entry.ticket.key),
    );
    this.pendingNodes = this.pendingNodes.filter(
      (entry) =>
        !affectedKeys.has((entry.work ?? this.resolveWorkUnit(entry.node)).key),
    );
    for (const work of toRebuild)
      this.pendingNodes.push({ node: work.node, work });
  }

  // -- LOD helpers -----------------------------------------------------------

  private spacingMultiplierForLod(lod: number): number {
    // The candidate's tier2 is the former middle geometry, not the sparse
    // ordinary far tier. Keep the same full placement grid at every range.
    return usesGrassCloseDetailLods(this.geometryLayout)
      ? FINE_GRASS_CLOSE_DETAIL.spacingMultiplier
      : GRASS_CONFIG.LOD_TIERS[lod].spacingMul;
  }

  private fineLodBoundary(lod: number): number {
    return usesGrassCloseDetailLods(this.geometryLayout) && lod === 0
      ? FINE_GRASS_CLOSE_DETAIL.detailDistance
      : FINE_GRASS_CLOSE_DETAIL.nearDistance;
  }

  private getLodLevel(source: GrassWorkSource): number {
    const work = this.resolveWorkUnit(source);
    if (this.fineMeadow) {
      // Cell coordinates are authored in the terrain frame. Unsupported parent
      // transforms must not accidentally choose coarser geometry; actual bounds
      // still use the transformed per-pass frustum hook below.
      if (this.fineLodRequiresHero()) return 0;
      const distanceSquared = this.workDistanceSquared(
        work,
        this.lodFocusX,
        this.lodFocusZ,
      );
      if (usesGrassCloseDetailLods(this.geometryLayout)) {
        if (distanceSquared < FINE_GRASS_CLOSE_DETAIL.detailDistance ** 2)
          return 0;
        return distanceSquared < FINE_GRASS_CLOSE_DETAIL.nearDistance ** 2
          ? 1
          : 2;
      }
      return distanceSquared < 40 * 40 ? 0 : 1;
    }
    const { node } = work;
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
    source: GrassWorkSource,
    lodLevel?: number,
    replace = false,
  ): void {
    const work = this.resolveWorkUnit(source);
    const { node } = work;
    if (!this.isNodeInGrassHorizon(work)) return;
    const key = work.key;
    if (this.chunks.has(key) && !replace) return;
    const surface = this.getRenderedSurface(node);
    if (!surface) return;
    if (
      surface.nodeId !== node.id ||
      surface.terrainProfileIdentity !== this.terrainProfileIdentity
    )
      throw new Error("Grass requires the current retained terrain surface");
    const lod = lodLevel ?? this.getLodLevel(work);
    const instanceData = this.generateInstanceData(
      work,
      this.spacingMultiplierForLod(lod),
    );
    if (this.compactMeadow) {
      const ticket = this.createWorkerTicket(work, key, lod, replace);
      this.settleWorkerResult(ticket, {
        count: 0,
        offsets: new Float32Array(0),
        rotScaleHash: new Float32Array(0),
        groundColors: new Float32Array(0),
        grassTints: new Float32Array(0),
        groundNormals: new Float32Array(0),
        ...instanceData,
        type: "grassInstanceResult",
        ...(this.compactMacroField?.pondServiceGround
          ? { pondServiceGround: this.compactMacroField.pondServiceGround }
          : {}),
        chunkKey: key,
        terrainProfileIdentity: this.terrainProfileIdentity,
        grassEligibility: this.grassEligibility,
        ...(this.compactCoastBlend
          ? { compactCoastBlend: this.compactCoastBlend }
          : {}),
        ...(this.compactPondBlend
          ? { compactPondBlend: this.compactPondBlend }
          : {}),
        ...(this.compactGrassColorGrade
          ? { compactGrassColorGrade: this.compactGrassColorGrade }
          : {}),
        ...(work.placementCell ? { placementCell: work.placementCell } : {}),
        ...(this.placementDistribution
          ? { placementDistribution: this.placementDistribution }
          : {}),
        ...this.coverageMarker(work.placementCell),
      });
      return;
    }
    let projected;
    if (instanceData) {
      projected = projectGrassAnchors(
        {
          ...instanceData,
          type: "grassInstanceResult" as const,
          ...(this.compactMacroField?.pondServiceGround
            ? { pondServiceGround: this.compactMacroField.pondServiceGround }
            : {}),
          chunkKey: key,
          terrainProfileIdentity: this.terrainProfileIdentity,
          grassEligibility: this.grassEligibility,
          ...(this.compactCoastBlend
            ? { compactCoastBlend: this.compactCoastBlend }
            : {}),
          ...(this.compactPondBlend
            ? { compactPondBlend: this.compactPondBlend }
            : {}),
          ...(this.compactGrassColorGrade
            ? { compactGrassColorGrade: this.compactGrassColorGrade }
            : {}),
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
        work,
        projected,
        lod,
        projected.grounding,
      );
    this.completedNodes.set(key, node);
    this.completedSurfaces.set(key, surface);
  }

  // -- Instance data generation ---------------------------------------------

  private generateInstanceData(
    source: GrassWorkSource,
    spacingMul = 1,
  ): {
    offsets: Float32Array;
    rotScaleHash: Float32Array;
    groundColors: Float32Array;
    grassTints: Float32Array;
    groundNormals: Float32Array;
    count: number;
  } | null {
    const work = this.resolveWorkUnit(source);
    const { node } = work;
    const domain = this.placementOperations.resolveDomain({
      centerX: node.centerX,
      centerZ: node.centerZ,
      size: node.size,
      clumpSpacing: this.placementSpacing(work.placementCell),
      spacingMul,
      ...(work.placementCell ? { placementCell: work.placementCell } : {}),
      ...(this.placementDistribution
        ? { placementDistribution: this.placementDistribution }
        : {}),
      ...this.coverageMarker(work.placementCell),
    });
    const maxCount = domain.maxCount;
    const rng = mulberry32(
      GRASS_CONFIG.SEED ^
        ((domain.centerX * 374761393 + domain.centerZ * 668265263) | 0),
    );

    const offsets = new Float32Array(maxCount * 3);
    const rotScaleHash = new Float32Array(maxCount * 3);
    const groundColors = new Float32Array(maxCount * 3);
    const grassTints = new Float32Array(maxCount * 4);
    const groundNormals = new Float32Array(maxCount * 3);

    let count = 0;
    const placementPosition = { x: 0, z: 0, leafX: 0, leafZ: 0 };

    for (let i = 0; i < maxCount; i++) {
      let lx: number, lz: number, wx: number, wz: number;
      if (domain.placementDistribution) {
        this.placementOperations.samplePosition(
          domain,
          i,
          rng(),
          rng(),
          placementPosition,
        );
        lx = placementPosition.leafX;
        lz = placementPosition.leafZ;
        wx = node.centerX + lx;
        wz = node.centerZ + lz;
      } else {
        const sx = (rng() - 0.5) * domain.size;
        const sz = (rng() - 0.5) * domain.size;
        wx = domain.centerX + sx;
        wz = domain.centerZ + sz;
        lx = work.placementCell ? wx - node.centerX : sx;
        lz = work.placementCell ? wz - node.centerZ : sz;
      }
      const clumpRng = rng();
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
        grassPlacementBeforeCoast,
        grassEstablishment,
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
      const originalPlacement = Math.max(
        0,
        (grassPlacementBeforeCoast ?? rawGP) - roadInf,
      );

      const historicalAccepted =
        originalPlacement > 0 && clumpRng <= originalPlacement;
      if (
        !historicalAccepted &&
        (!grassEstablishment ||
          grassPlacement <= 0 ||
          clumpRng > grassPlacement)
      )
        continue;

      offsets[count * 3] = lx;
      offsets[count * 3 + 1] = ty;
      offsets[count * 3 + 2] = lz;

      const rotation = historicalAccepted
        ? rng() * Math.PI * 2
        : this.placementOperations.establishmentRotation(
            domain,
            GRASS_CONFIG.SEED,
            i,
          );
      // Match the worker: preserve each originally accepted rotation draw before
      // coastal rejection, so later roots retain their exact seeded pose.
      if (
        grassPlacementBeforeCoast !== undefined &&
        (grassPlacement <= 0 || clumpRng > grassPlacement)
      )
        continue;
      if (this.workerSetup?.isGrassObstacleAt?.(wx, wz)) continue;
      // TerrainSystem already includes the selected pond-margin factor in
      // grassHeightScale. Store it before grounding; do not apply it again in
      // the blade shader or confuse it with the independent bank-verge factor.
      const scale =
        (GRASS_CONFIG.SCALE_MIN +
          clumpRng * (GRASS_CONFIG.SCALE_MAX - GRASS_CONFIG.SCALE_MIN)) *
        grassHeightScale *
        this.compactTerrainColorOperations.bankVergeClumpScale(
          wx,
          wz,
          roadInf,
          this.compactMacroField,
        );
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

  private materialForLod(lod: number): MeshStandardNodeMaterial {
    return (isFoldedGrassBladeLayout(lod, this.geometryLayout) ||
      this.geometryLayout === FINE_GRASS_MEADOW_FIELD_SHAPE.GEOMETRY_LAYOUT) &&
      this.foldedMaterial
      ? this.foldedMaterial
      : this.material;
  }

  /** Isolated detail binding; this does not publish a placement or admit its
   * grounding. Caller owns the returned material and supplied geometry.
   * Both borrow this owner's live uniforms and require its lifetime. */
  createMeadowDetailMaterial(
    geometry: THREE.BufferGeometry,
    coarseGeometry: THREE.BufferGeometry,
    weight: Node<"float">,
  ): MeshStandardNodeMaterial {
    if (this.destroyed || !this.meadowDetailMaterialFactory)
      throw new Error("Meadow detail requires a live leaf-volume field owner");
    return this.meadowDetailMaterialFactory(
      geometry,
      coarseGeometry,
      weight,
      "conforming",
    );
  }

  /** Opt-in authored shape binding. Uses the same live material/wind owner;
   * no automatic replacement, grounding or quality-default admission. */
  createMeadowAuthoredMaterial(
    geometry: THREE.BufferGeometry,
    coarseGeometry: THREE.BufferGeometry,
    weight: Node<"float">,
  ): MeshStandardNodeMaterial {
    if (this.destroyed || !this.meadowDetailMaterialFactory)
      throw new Error(
        "Authored meadow requires a live leaf-volume field owner",
      );
    return this.meadowDetailMaterialFactory(
      geometry,
      coarseGeometry,
      weight,
      "authored",
    );
  }

  private createMaterial(): MeshStandardNodeMaterial {
    const compactMeadow = this.compactMeadow;
    const appearance = this.meadowAppearance;
    // The validated terrain owner selects physical lighting. The explicit
    // fine leaf-volume study also selects near folded geometry; density is
    // unchanged. Callers without that owner retain their legacy graph.
    const terrainProfile = this.workerSetup?.terrainConfig.TERRAIN_PROFILE;
    const compactPhysical =
      terrainProfile?.kind === "compact-candidate" &&
      isCompactSculptProfile(terrainProfile);
    const mat =
      compactPhysical && appearance?.id === FINE_MEADOW_APPEARANCE.id
        ? new MeshSSSNodeMaterial()
        : new MeshStandardNodeMaterial();
    mat.name = appearance?.id ?? "legacy-blades-v1";
    if (this.lightingCandidate)
      publishFineGrassCanopyLighting(
        mat,
        this.lightingCandidate,
        false,
        this.geometryLayout,
      );
    if (this.habitatComposition)
      Object.defineProperty(mat.userData, "compactHabitatComposition", {
        enumerable: true,
        writable: false,
        configurable: false,
        value: this.habitatComposition,
      });
    mat.side = THREE.DoubleSide;
    mat.transparent = false;
    mat.depthWrite = true;
    mat.roughness = 1.0;
    mat.metalness = 0.0;
    mat.fog = false;

    if (mat instanceof MeshSSSNodeMaterial) {
      // Only the built-in direct-light SSS term is admitted. Do not enable
      // physical transmission (which samples a separate scene buffer), or any
      // unrelated physical lobes. The default dielectric interface is retained.
      mat.transmission = 0;
      mat.transmissionNode = null;
      mat.clearcoat = 0;
      mat.clearcoatNode = null;
      mat.sheen = 0;
      mat.sheenNode = null;
      mat.iridescence = 0;
      mat.iridescenceNode = null;
      mat.anisotropy = 0;
      mat.anisotropyNode = null;
      mat.dispersion = 0;
      mat.dispersionNode = null;
      mat.retroreflectivity = 0;
      mat.retroreflectivityNode = null;
      mat.thicknessAttenuationNode = float(
        FINE_GRASS_THIN_LEAF_LIGHTING.attenuation,
      );
      mat.thicknessScaleNode = float(FINE_GRASS_THIN_LEAF_LIGHTING.scale);
      mat.thicknessPowerNode = float(FINE_GRASS_THIN_LEAF_LIGHTING.power);
      mat.thicknessDistortionNode = float(
        FINE_GRASS_THIN_LEAF_LIGHTING.distortion,
      );
      mat.thicknessAmbientNode = float(
        fineGrassThinLeafLighting(this.geometryLayout).ambient,
      );
      publishFineGrassLighting(mat, this.geometryLayout);
    }

    if (appearance?.id === FINE_MEADOW_APPEARANCE.id) {
      // Approximate occlusion of environmental fill inside the lower canopy.
      // Three applies AO to indirect lighting, not albedo or direct sunlight.
      // Reuse the blade UV: no texture, vertex input or extra rendering pass.
      mat.aoNode = mix(
        float(appearance.ROOT_OCCLUSION),
        float(1),
        smoothstep(float(0), float(appearance.ROOT_OCCLUSION_END), uv().y),
      ).toVar("fineGrassRootOcclusion");
    }

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

    let habitatSoil = null;
    const bankVerge =
      this.fineMeadow &&
      this.compactGrassColorGrade &&
      this.compactMacroField?.coastalMeadow
        ? this.compactMacroField.bankVerge
        : undefined;
    let bankLocality = null;
    if (
      appearance?.id === "natural-tuft-v1" ||
      appearance?.id === "fine-meadow-v1"
    ) {
      // This opt-in graph shares its fade and wind between vertex position and
      // smooth normals. Existing appearance graphs above remain unchanged.
      const offset = attribute("instanceOffset", "vec3");
      const rsh = attribute("instanceRotScaleHash", "vec3");
      const t = uv().y;
      const scale = rsh.y;
      const worldBase = modelWorldMatrix
        .mul(vec4(offset.x, float(0), offset.z, float(1)))
        .toVar("naturalGrassWorldBase");
      const vergeLocality = bankVerge
        ? createCompactBankVergeLocality(worldBase.xyz, this.compactMacroField)
        : float(0);
      const bankHeightScale =
        bankVerge || this.compactMacroField?.pondServiceGround
          ? createCompactBankVergeHeightScale(
              worldBase.xyz,
              this.compactMacroField,
              vergeLocality,
            )
          : float(1);
      if (bankVerge)
        bankLocality = vergeLocality.toVarying("v_naturalGrassBankLocality");
      if (this.habitatComposition)
        habitatSoil = createCompactHabitatSoilNode(
          worldBase.x,
          worldBase.z,
          this.habitatComposition,
        ).toVarying("v_naturalGrassHabitatSoil");
      const toPlayer = sub(
        vec3(worldBase.x, float(0), worldBase.z),
        vec3(uPlayerPos.x, float(0), uPlayerPos.z),
      );
      const fade = clamp(
        sub(
          float(1),
          smoothstep(uFadeStart, uFadeEnd, pow(dot(toPlayer, toPlayer), 0.5)),
        ),
        float(0),
        float(1),
      ).toVar("naturalGrassFade");
      const wt = time.mul(uWindSpeed);
      const heightFlex = usesGrassBladeHeightFlex(this.geometryLayout);
      const cosR = cos(rsh.x);
      const sinR = sin(rsh.x);
      const nx = terrainNormal.x;
      const ny = terrainNormal.y;
      const nz = terrainNormal.z;
      const invOnePlusNy = float(1).div(ny.add(1));
      const cross = nx.mul(nz).mul(invOnePlusNy).negate();
      const turnToGround = (v: ReturnType<typeof vec3>) => {
        const x = v.x.mul(cosR).sub(v.z.mul(sinR));
        const z = v.x.mul(sinR).add(v.z.mul(cosR));
        return vec3(
          x
            .mul(ny.add(nz.mul(nz).mul(invOnePlusNy)))
            .add(v.y.mul(nx))
            .add(z.mul(cross)),
          x.mul(nx.negate()).add(v.y.mul(ny)).sub(z.mul(nz)),
          x
            .mul(cross)
            .add(v.y.mul(nz))
            .add(z.mul(ny.add(nx.mul(nx).mul(invOnePlusNy)))),
        );
      };
      const evaluateVertex = (
        sample: GrassMeadowRefinementSample,
        label = "",
      ): GrassMeadowRefinementResponse => {
        const rawPosition = sample.position;
        const sourceNormal = sample.normal;
        const t = sample.t;
        // The retained graph keeps its original labels. Parent/fine response
        // evaluations must not alias named vertex temporaries or varyings.
        const named = (name: string) => (label ? name + label : name);
        const c = appearance.BLADE_CONTROL_HEIGHT;
        const q = appearance.BLADE_TIP_HEIGHT;
        const curve = t.mul(2 * c).add(t.mul(t).mul(q - 2 * c));
        const curveDerivative = float(2 * c).add(t.mul(2 * (q - 2 * c)));
        // Recover uncompressed source height; bank wear and distance fade are
        // applied separately. The root denominator is guarded in both branches.
        // Scaling only the wind amplitude would leave the sparse tip interval
        // over-bent: distribute flex quadratically over actual blade height too.
        const heightFraction = curve.div(q);
        const flexAmplitude = rawPosition.y
          .mul(scale)
          .div(curve.max(1e-5).mul(uBladeHeight))
          .min(1);
        const bend = heightFlex
          ? heightFraction
              .mul(heightFraction)
              .mul(flexAmplitude)
              .toVar(named("naturalGrassHeightFlex"))
          : pow(t, float(1.8));
        // Chunk-local offsets repeat at each chunk boundary. Key both waves to
        // the actual world-space clump base, not to an animated blade vertex.
        const displacement = vec3(
          sin(wt.add(worldBase.x.mul(0.35)).add(worldBase.z.mul(0.12)))
            .mul(uWindStrength)
            .mul(bend)
            .mul(uBladeHeight),
          float(0),
          sin(
            wt
              .mul(0.67)
              .add(worldBase.x.mul(0.18))
              .add(worldBase.z.mul(0.28))
              .add(2),
          )
            .mul(uWindStrength)
            .mul(0.55)
            .mul(bend)
            .mul(uBladeHeight),
        )
          .mul(bankHeightScale)
          .toVar(named("naturalGrassDisplacement"));
        const position = turnToGround(
          vec3(
            rawPosition.x,
            rawPosition.y.mul(fade).mul(bankHeightScale),
            rawPosition.z,
          ).mul(scale),
        )
          .add(displacement)
          .add(offset);

        // Cofactor of the smooth ribbon deformation, without division by fade:
        // f*h*H + n.y*N + k*(H*dot(d,N) - N*dot(d,H)). Here H is the
        // yaw/tilt-rotated horizontal source normal; d is actual tip displacement.
        // The local vertical factor h also scales d; source XZ/root width stays
        // unchanged. CPU grounding certifies this same height/wind envelope.
        // Recover source blade height from raw y=height*B(t), not deformed y.
        // The deformation adds no normal/height attribute, texture or pass.
        // The selected bank color treatment shares one explicit locality varying.
        // Construct the guarded normal's temporaries inside their own stack.
        // In r186, a loose Var reached through a varying's conditional source
        // can be appended to the fragment base stack during setup. A Fn owns
        // these declarations before that traversal; wrapping an already-built
        // expression would leave its Vars unowned and leak the same dead work.
        const bladeNormal = Fn(() => {
          const horizontalNormal = turnToGround(
            vec3(sourceNormal.x, float(0), sourceNormal.z),
          ).toVar(named("naturalGrassHorizontalNormal"));
          // Both guarded denominators are exact on retained non-root vertices.
          // Roots have t=B(t)=d=0, so their wind correction remains exactly zero.
          // D is proportional to B(t)^2 for the explicit flex path. Therefore
          // D'/D divided by the source vertical derivative is 2/(scale*rawY).
          // The per-blade height cap is constant along the ideal blade surface;
          // it changes amplitude, not this derivative. D remains exactly zero at
          // the root, so its guarded finite coefficient contributes zero there.
          const k = heightFlex
            ? float(2).div(scale.mul(rawPosition.y.max(1e-5)))
            : curve
                .mul(1.8)
                .div(
                  t
                    .max(1e-5)
                    .mul(scale)
                    .mul(rawPosition.y.max(1e-5))
                    .mul(curveDerivative),
                );
          const deformedNormal = horizontalNormal
            .mul(fade)
            .mul(bankHeightScale)
            .add(terrainNormal.mul(sourceNormal.y))
            .add(
              horizontalNormal
                .mul(dot(displacement, terrainNormal))
                .sub(terrainNormal.mul(dot(displacement, horizontalNormal)))
                .mul(k),
            )
            .toVar(named("naturalGrassDeformedNormal"));
          const normalLengthSq = dot(deformedNormal, deformedNormal);
          // A fully distance-collapsed root has no unique ribbon normal. Use its
          // finite terrain normal, including when both branches are evaluated.
          return normalLengthSq
            .greaterThan(1e-12)
            .select(
              deformedNormal.div(pow(normalLengthSq.max(1e-12), 0.5)),
              terrainNormal,
            );
        }, "vec3")();
        const widthAxis = turnToGround(
          vec3(sourceNormal.z, float(0), sourceNormal.x.negate()),
        );
        const width = widthAxis.div(
          pow(dot(widthAxis, widthAxis).max(1e-12), 0.5),
        );

        return { position, normal: bladeNormal, width };
      };
      const buildSurface = (response: GrassMeadowRefinementResponse) => {
        // Normalize each original vertex before interpolation, but never
        // renormalize a refined midpoint at the vertex stage. The guarded
        // fragment normalization below remains the one surface operation.
        const bladeNormal = response.normal.toVarying("v_curvedGrassNormal");
        // Opposite valid vertex normals can cancel during raster interpolation,
        // especially at full distance fade. Guard the fragment value as well as
        // the vertices, keeping both select operands finite even at exact zero.
        const interpolatedLengthSq = dot(bladeNormal, bladeNormal).toVar(
          "naturalGrassInterpolatedLengthSq",
        );
        const fragmentBladeNormal = interpolatedLengthSq
          .greaterThan(1e-12)
          .select(
            bladeNormal.div(pow(interpolatedLengthSq.max(1e-12), 0.5)),
            terrainNormal,
          );
        const leafVolume =
          this.lightingCandidate === FINE_GRASS_LEAF_VOLUME_LIGHTING.id;
        const meadowField =
          this.geometryLayout === FINE_GRASS_MEADOW_FIELD_SHAPE.GEOMETRY_LAYOUT;
        const lightingRecipe = leafVolume
          ? meadowField
            ? FINE_GRASS_MEADOW_FIELD_LIGHTING
            : FINE_GRASS_LEAF_VOLUME_LIGHTING
          : FINE_GRASS_CANOPY_NORMAL_LIGHTING;
        let shadingBladeNormal = fragmentBladeNormal;
        if (leafVolume) {
          // Positive UV width is (cr,0,sr), not a frame reconstructed from the
          // wind-deformed normal: that cross product can reverse during fade.
          // Wind is uniform across a row. Its true width axis therefore remains
          // yaw/ground-tilted source width; only this candidate adds a vec3 varying.
          const widthVarying = response.width.toVarying("v_fineGrassWidthAxis");
          // Interpolation can lose orthogonality; project before bending. An
          // exactly degenerate width yields zero bend, with no NaN operand.
          const transverse = widthVarying.sub(
            fragmentBladeNormal.mul(dot(widthVarying, fragmentBladeNormal)),
          );
          const transverseUnit = transverse.div(
            pow(dot(transverse, transverse).max(1e-12), 0.5),
          );
          const fold = uv()
            .x.mul(2)
            .sub(1)
            .mul(lightingRecipe.foldTangent)
            .mul(
              float(1).sub(
                smoothstep(FINE_GRASS_LEAF_VOLUME_LIGHTING.foldTipStart, 1, t),
              ),
            )
            .toVar("fineGrassTransverseFold");
          const curved = fragmentBladeNormal.add(transverseUnit.mul(fold));
          shadingBladeNormal = curved.div(
            pow(dot(curved, curved).max(1e-12), 0.5),
          );
        }
        const canopyNormalWeight = this.lightingCandidate
          ? mix(
              float(lightingRecipe.rootWeight),
              float(lightingRecipe.upperWeight),
              smoothstep(
                float(lightingRecipe.rootEnd),
                float(lightingRecipe.upperStart),
                t,
              ),
            ).toVar("fineGrassCanopyNormalWeight")
          : float(appearance.BLADE_NORMAL_WEIGHT);
        const mixedNormal = mix(
          terrainNormal,
          shadingBladeNormal.mul(faceDirection),
          canopyNormalWeight,
        );
        // Guard the final shading mixture too; both select operands stay finite.
        const mixedLengthSq = dot(mixedNormal, mixedNormal);
        const normal = cameraViewMatrix.transformDirection(
          leafVolume
            ? mixedLengthSq
                .greaterThan(1e-12)
                .select(
                  mixedNormal.div(pow(mixedLengthSq.max(1e-12), 0.5)),
                  terrainNormal,
                )
            : mixedNormal.normalize(),
        );
        let foldedNormal: MeshStandardNodeMaterial["normalNode"] = null;
        if (usesGrassBladeHeightFlex(this.geometryLayout)) {
          const physicalNormal = mix(
            terrainNormal,
            // Folded meshes already have transverse geometry normals. Only the
            // explicit flat-ribbon field uses the labelled shading relief.
            (meadowField ? shadingBladeNormal : fragmentBladeNormal).mul(
              faceDirection,
            ),
            canopyNormalWeight,
          );
          const lengthSq = dot(physicalNormal, physicalNormal);
          foldedNormal = cameraViewMatrix.transformDirection(
            lengthSq
              .greaterThan(1e-12)
              .select(
                physicalNormal.div(pow(lengthSq.max(1e-12), 0.5)),
                terrainNormal,
              ),
          );
        }

        return { position: response.position, normal, foldedNormal };
      };
      const surface = buildSurface(
        evaluateVertex({
          position: attribute("position", "vec3"),
          normal: attribute("normal", "vec3"),
          t,
        }),
      );
      mat.positionNode = surface.position;
      mat.normalNode = surface.normal;
      if (surface.foldedNormal)
        this.foldedBladeNormalNode = surface.foldedNormal;

      if (
        this.geometryLayout === FINE_GRASS_MEADOW_FIELD_SHAPE.GEOMETRY_LAYOUT &&
        this.lightingCandidate === FINE_GRASS_LEAF_VOLUME_LIGHTING.id
      ) {
        this.meadowDetailMaterialFactory = (
          geometry,
          coarseGeometry,
          weight,
          endpoint,
        ) => {
          // Borrow the selected near material's existing uniforms, albedo and
          // SSS graph. Re-running createMaterial would orphan uniform owners.
          const detail = this.materialForLod(0).clone();
          try {
            let responseIndex = 0;
            const bindResponse =
              endpoint === "authored"
                ? createGrassMeadowAuthoredResponse
                : createGrassMeadowRefinementResponse;
            const refined = bindResponse(
              geometry,
              coarseGeometry,
              weight,
              (sample) => evaluateVertex(sample, "Refined" + responseIndex++),
            );
            const detailSurface = buildSurface(refined);
            detail.positionNode = detailSurface.position;
            detail.normalNode =
              detailSurface.foldedNormal ?? detailSurface.normal;
            // NodeMaterial.clone JSON-copies userData, losing readonly
            // descriptors. Restore the same production recipe receipts.
            if (detail instanceof MeshSSSNodeMaterial)
              publishFineGrassLighting(detail, this.geometryLayout);
            publishFineGrassCanopyLighting(
              detail,
              this.lightingCandidate,
              true,
              this.geometryLayout,
            );
            if (this.habitatComposition)
              Object.defineProperty(
                detail.userData,
                "compactHabitatComposition",
                {
                  enumerable: true,
                  writable: false,
                  configurable: false,
                  value: this.habitatComposition,
                },
              );
            Object.defineProperty(detail.userData, "grassMeadowRefinement", {
              enumerable: true,
              writable: false,
              configurable: false,
              value: GRASS_MEADOW_REFINEMENT,
            });
            Object.defineProperty(detail.userData, "grassMeadowEndpoint", {
              enumerable: true,
              writable: false,
              configurable: false,
              value: endpoint,
            });
            return detail;
          } catch (error) {
            detail.dispose();
            throw error;
          }
        };
      }
      // The existing per-edge root-height correction is applied afterwards by
      // GrassGroundingGpu. Its small cross-blade warp is not in this smooth N.
    }

    mat.colorNode = Fn(() => {
      const groundCol = attribute("instanceGroundColor", "vec3");
      const tint = attribute("instanceGrassTint", "vec4");
      const tintCol = tint.xyz;
      const tintStr = tint.w;
      const t = uv().y;
      const tintedCol = mix(groundCol, tintCol, tintStr);
      // Shared substrate at this actual clump base, not a changed worker tint
      // or placement. The one extra float varying is explicit candidate cost.
      const rootGround = habitatSoil
        ? mix(
            groundCol,
            vec3(...createCompactTerrainColorOperations().getPalette().dirt),
            habitatSoil,
          )
        : groundCol;
      if (compactMeadow) {
        // Root shading suggests tuft occlusion without an extra texture/pass.
        // Retain the terrain palette: the previous 1.4 tip gain made distant
        // blades look like bright wires. This is albedo, not emissive light.
        const leafVolume =
          this.lightingCandidate === FINE_GRASS_LEAF_VOLUME_LIGHTING.id;
        const rootBrightness = leafVolume
          ? this.geometryLayout ===
            FINE_GRASS_MEADOW_FIELD_SHAPE.GEOMETRY_LAYOUT
            ? FINE_GRASS_MEADOW_FIELD_LIGHTING.rootBrightness
            : FINE_GRASS_LEAF_VOLUME_LIGHTING.rootBrightness
          : appearance.ROOT_BRIGHTNESS;
        const tipBrightness = leafVolume
          ? FINE_GRASS_LEAF_VOLUME_LIGHTING.tipBrightness
          : appearance.TIP_BRIGHTNESS;
        const bladeCol = mix(
          rootGround.mul(rootBrightness),
          tintedCol.mul(
            bankVerge && bankLocality
              ? mix(
                  float(tipBrightness),
                  float(
                    leafVolume
                      ? bankVerge.tipBrightness *
                          (tipBrightness / appearance.TIP_BRIGHTNESS)
                      : bankVerge.tipBrightness,
                  ),
                  bankLocality,
                )
              : float(tipBrightness),
          ),
          smoothstep(
            float(0.0),
            float(
              leafVolume ? FINE_GRASS_LEAF_VOLUME_LIGHTING.colorTipStart : 1,
            ),
            t,
          ),
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

    if (mat instanceof MeshSSSNodeMaterial) {
      // One shared non-grazing albedo owner feeds both ordinary reflection and
      // the thin-leaf tint. Scattering itself remains in Three's direct-light
      // model, so zero/shadowed light cannot become an albedo or emissive lift.
      // Preserve the previous fine albedo's upper bound, without its view gain.
      mat.colorNode = vec3(mat.colorNode)
        .min(vec3(1))
        .toVar("fineGrassBladeAlbedo");
      mat.thicknessColorNode = mat.colorNode
        .mul(
          smoothstep(
            float(FINE_GRASS_THIN_LEAF_LIGHTING.rootStart),
            float(FINE_GRASS_THIN_LEAF_LIGHTING.rootEnd),
            uv().y,
          ),
        )
        .toVar("fineGrassThinLeafColor");
    }

    mat.outputNode = Fn(() => {
      return vec4(output.rgb, output.a);
    })();

    return mat;
  }

  // -- Helpers --------------------------------------------------------------

  private workUnitsFor(node: TerrainQuadNode): readonly GrassWorkUnit[] {
    const previous = this.nodeWorkUnits.get(node);
    if (previous) return previous;
    const bounds = Object.freeze({
      minX: node.centerX - node.halfSize,
      maxX: node.centerX + node.halfSize,
      minZ: node.centerZ - node.halfSize,
      maxZ: node.centerZ + node.halfSize,
    });
    const works: GrassWorkUnit[] = [];
    if (!this.fineMeadow)
      works.push(Object.freeze({ node, key: this.chunkKey(node), bounds }));
    else {
      // Fine cells partition real final leaves exactly. Partial or fabricated
      // terrain domains would change both deterministic ownership and support.
      const coordinates = [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ];
      if (
        node.size < 25 ||
        node.size > 100 ||
        coordinates.some((value) => !Number.isSafeInteger(value / 25))
      )
        throw new Error(
          "Fine meadow requires aligned 25m cells in real leaves up to 100m",
        );
      for (let indexZ = bounds.minZ / 25; indexZ < bounds.maxZ / 25; indexZ++) {
        for (
          let indexX = bounds.minX / 25;
          indexX < bounds.maxX / 25;
          indexX++
        ) {
          const placementCell = this.placementOperations.validateCell({
            schemaVersion: 1,
            size: 25,
            indexX,
            indexZ,
          });
          this.placementOperations.resolveDomain({
            centerX: node.centerX,
            centerZ: node.centerZ,
            size: node.size,
            clumpSpacing: this.placementSpacing(placementCell),
            spacingMul: 1,
            placementCell,
            ...(this.placementDistribution
              ? { placementDistribution: this.placementDistribution }
              : {}),
            ...this.coverageMarker(placementCell),
          });
          works.push(
            Object.freeze({
              node,
              placementCell,
              bounds: getGrassPlacementCellBounds(placementCell),
              key: `gcell_v1_${indexX}_${indexZ}`,
            }),
          );
        }
      }
    }
    const result = Object.freeze(works);
    this.nodeWorkUnits.set(node, result);
    return result;
  }

  private resolveWorkUnit(source: GrassWorkSource): GrassWorkUnit {
    if ("node" in source) return source;
    const works = this.workUnitsFor(source);
    if (works.length !== 1)
      throw new Error(
        "Fine meadow requests require an explicit placement cell",
      );
    return works[0];
  }

  private workDistanceSquared(
    work: GrassWorkUnit,
    x: number,
    z: number,
  ): number {
    const dx = this.fineMeadow
      ? Math.max(work.bounds.minX - x, 0, x - work.bounds.maxX)
      : work.node.centerX - x;
    const dz = this.fineMeadow
      ? Math.max(work.bounds.minZ - z, 0, z - work.bounds.maxZ)
      : work.node.centerZ - z;
    return dx * dx + dz * dz;
  }

  private desiredLod(work: GrassWorkUnit): number {
    if (this.fineMeadow && this.fineLodRequiresHero()) return 0;
    const raw = this.getLodLevel(work);
    const chunk = this.chunks.get(work.key);
    if (!chunk || raw === chunk.lodLevel) return raw;
    const distance = Math.sqrt(
      this.workDistanceSquared(
        work,
        this.fineMeadow ? this.lodFocusX : this.playerX,
        this.fineMeadow ? this.lodFocusZ : this.playerZ,
      ),
    );
    const tiers = GRASS_CONFIG.LOD_TIERS;
    if (usesGrassCloseDetailLods(this.geometryLayout)) {
      // Cross every boundary independently, including multi-tier camera jumps.
      // A jump may settle in the intermediate band while one boundary is still
      // inside its hysteresis window; it must not flap or bypass that window.
      let desired = chunk.lodLevel;
      while (
        desired > raw &&
        distance <
          this.fineLodBoundary(desired - 1) * (1 - GRASS_CONFIG.LOD_HYSTERESIS)
      )
        desired--;
      while (
        desired < raw &&
        distance >
          this.fineLodBoundary(desired) * (1 + GRASS_CONFIG.LOD_HYSTERESIS)
      )
        desired++;
      return desired;
    }
    const boundary = this.fineMeadow
      ? 40
      : raw < chunk.lodLevel
        ? tiers[chunk.lodLevel].maxDistance
        : tiers[raw - 1].maxDistance;
    const threshold =
      boundary *
      (1 +
        (raw < chunk.lodLevel
          ? -GRASS_CONFIG.LOD_HYSTERESIS
          : GRASS_CONFIG.LOD_HYSTERESIS));
    return (raw < chunk.lodLevel ? distance < threshold : distance > threshold)
      ? raw
      : chunk.lodLevel;
  }

  private isTicketLodCurrent(ticket: GrassWorkerTicket): boolean {
    if (!this.fineMeadow && !ticket.isLodSwap) return true;
    return (
      this.desiredLod(ticket.work) === ticket.lodLevel &&
      (!ticket.isLodSwap ||
        this.chunks.get(ticket.key)?.lodLevel !== ticket.lodLevel)
    );
  }

  private fineLodRequiresHero(): boolean {
    return (
      (this.hasPrimaryView && !this.primaryViewValid) ||
      !Number.isFinite(this.lodFocusX) ||
      !Number.isFinite(this.lodFocusZ) ||
      this.container.matrixWorld.elements.some(
        (value, index) => value !== (index % 5 === 0 ? 1 : 0),
      )
    );
  }

  private cancelObsoleteLodWork(): void {
    for (const ticket of this.workerInflight.values()) {
      if (!this.compactMeadow) continue;
      if (this.isTicketLodCurrent(ticket)) continue;
      this.workerInflight.delete(ticket.key);
      this.pendingLodSwap.delete(ticket.key);
    }
    for (const [key, entry] of this.groundingJobs) {
      if (this.isTicketLodCurrent(entry.ticket)) continue;
      entry.job.cancel();
      this.groundingJobs.delete(key);
      this.pendingLodSwap.delete(key);
    }
    if (this.fineMeadow) {
      // An intent may have lost its dispatch slot, then left the final view.
      // The visible-chunk loop deliberately skips that view, so only actual
      // ticket/job ownership may keep a fine LOD intent alive. Visible demand
      // is re-derived below each update; legacy retry intents stay unchanged.
      for (const key of this.pendingLodSwap.keys()) {
        if (!this.workerInflight.has(key) && !this.groundingJobs.has(key))
          this.pendingLodSwap.delete(key);
      }
    }
    this.settledWorkerResults = this.settledWorkerResults.filter(({ ticket }) =>
      this.isCurrentWorkerTicket(ticket),
    );
  }

  private selectedCoverage(
    cell: GrassPlacementCell | undefined,
  ): GrassPlacementCoverage | undefined {
    const trial = this.coverageTrial;
    return trial &&
      cell &&
      cell.indexX === trial.cell.indexX &&
      cell.indexZ === trial.cell.indexZ
      ? trial.id
      : undefined;
  }

  private placementSpacing(cell: GrassPlacementCell | undefined): number {
    return this.selectedCoverage(cell) ? 0.6 : this.clumpSpacing;
  }

  private coverageMarker(cell: GrassPlacementCell | undefined): {
    placementCoverage?: GrassPlacementCoverage;
  } {
    const coverage = this.selectedCoverage(cell);
    return coverage ? { placementCoverage: coverage } : {};
  }

  private assertPlacementCell(
    data: GrassWorkerOutput,
    work: GrassWorkUnit,
  ): void {
    const coverageField = Object.getOwnPropertyDescriptor(
      data,
      "placementCoverage",
    );
    if (
      "placementCoverage" in data &&
      (!coverageField?.enumerable || !("value" in coverageField))
    )
      throw new Error("Grass visual result coverage must be own data");
    const coverage = this.placementOperations.validateCoverage(
      coverageField?.value,
    );
    if (
      (coverageField && coverage === undefined) ||
      coverage !== this.selectedCoverage(work.placementCell)
    )
      throw new Error("Grass visual result placement coverage mismatch");
    if (!work.placementCell) {
      if (data.placementCell !== undefined)
        throw new Error("Unexpected grass placement cell");
      return;
    }
    const cell = this.placementOperations.validateCell(data.placementCell);
    if (
      cell.indexX !== work.placementCell.indexX ||
      cell.indexZ !== work.placementCell.indexZ
    )
      throw new Error("Grass visual result placement cell mismatch");
  }

  private chunkKey(node: TerrainQuadNode): string {
    return `gq_${node.id}_d${node.depth}_${node.centerX}_${node.centerZ}`;
  }
}
