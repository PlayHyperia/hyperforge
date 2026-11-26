/**
 * GrassWorker.ts - Web Worker for FULL Grass Instance Generation
 *
 * Offloads ALL CPU-intensive grass computation to a worker thread:
 * - Terrain height sampling (getHeightComputed)
 * - Biome weight & terrain color computation (computeTerrainColorCPU)
 * - Road influence calculation
 * - Grass placement probability (biome configs, slope, patchiness)
 * - Instance attribute generation (offsets, rotation, scale, ground color, normal)
 *
 * The main thread only creates InstancedMesh from pre-computed Float32Arrays.
 *
 * Uses the same shared builder functions as TerrainWorker/QuadChunkWorker
 * for height/biome computation to stay perfectly in sync.
 */

import { WorkerPool } from "./WorkerPool";
import type { GrassSurfaceEligibility } from "../../runtime/clientViewportMode";
import {
  buildGetBaseHeightAtJS,
  buildComputeBiomeWeightsJS,
} from "../../systems/shared/world/TerrainHeightParams";
import { buildBiomeConstantsJS } from "../../systems/shared/world/TerrainBiomeTypes";
import {
  buildNoiseGeneratorJS,
  buildHeightHelpersJS,
  buildBiomeInfluencesJS,
  buildCreateBiomeNoiseSetsJS,
  buildTerrainWorkerProfileGuardJS,
  assertTerrainWorkerRequest,
  assertTerrainWorkerResult,
} from "./TerrainWorkerShared";
import type { TerrainWorkerConfig } from "./TerrainWorker";
import { createAuthoredTerrainSurfaceOperations } from "../../systems/shared/world/AuthoredTerrainSurface";
import { createRoadInfluenceOperations } from "../../systems/shared/world/RoadInfluence";
import { createTerrainNoiseSampler } from "../../systems/shared/world/TerrainNoiseSampler";
import {
  createCompactTerrainColorOperations,
  type CompactTerrainPlantingLobe,
  type CompactGrassColorGrade,
  type CompactPondBankField,
  type CompactTerrainBankVerge,
} from "../../systems/shared/world/CompactTerrainPalette";
import {
  createGrassTerrainSurfaceOperations,
  GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
  type GrassTerrainSurfaceSnapshot,
} from "./GrassTerrainSurfaceSnapshot";
import {
  createGrassPlacementCellOperations,
  type GrassPlacementCell,
  type GrassPlacementCoverage,
  type GrassPlacementDistribution,
} from "./GrassPlacementCell";
export type {
  GrassPlacementCell,
  GrassPlacementCoverage,
  GrassPlacementCoverageTrial,
  GrassPlacementDistribution,
} from "./GrassPlacementCell";

// ============================================================================
// TYPES
// ============================================================================

export interface GrassPlacementData {
  x: number;
  z: number;
  heightScale: number;
  rotation: number;
  widthScale: number;
  colorVar: number;
  phaseOffset: number;
}

export interface BiomeGrassConfigWorker {
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

export interface GrassWorkerInput {
  /** Admitted appearance only; never a placement probability or root scale. */
  pondServiceGround?: CompactTerrainBankVerge;
  /** Restart-owned pond support; appearance-only pond modes are omitted. */
  compactPondBlend?: "shore-contact-v1" | "composition-v1";
  /** Restart-owned coastal ecology; detail-only material selection is omitted. */
  compactCoastBlend?: "distribution-v1";
  /** Explicit colour-only compact policy; the manager admits the fine profile. */
  compactGrassColorGrade?: CompactGrassColorGrade;
  /** Optional sampling domain; offsets remain relative to the real leaf frame. */
  placementCell?: GrassPlacementCell;
  /** Explicit one-cell coverage trial, independently admitted from terrain. */
  placementCoverage?: GrassPlacementCoverage;
  /** Explicit candidate distribution; the manager alone admits the fine profile. */
  placementDistribution?: GrassPlacementDistribution;
  /** Colour-only authored soil; never participates in placement eligibility. */
  compactPlantingLobes?: readonly CompactTerrainPlantingLobe[];
  /** Absent retains historical biome eligibility. Never inferred from terrain. */
  grassEligibility?: GrassSurfaceEligibility;
  type: "generateGrassInstances";
  chunkKey: string;
  centerX: number;
  centerZ: number;
  size: number;
  spacingMul: number;
  config: TerrainWorkerConfig;
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
  grassSeed: number;
  clumpSpacing: number;
  scaleMin: number;
  scaleMax: number;
  waterThreshold: number;
  grassConfigs: Record<string, BiomeGrassConfigWorker>;
  shaderConstants: {
    NOISE_SCALE: number;
    DISTORT_NOISE_SCALE: number;
    VARIATION_NOISE_SCALE: number;
    ROCK_DISTORT_STRENGTH: number;
    HEIGHT_DISTORT_STRENGTH: number;
    DIRT_THRESHOLD: number;
    SATURATION_BOOST: number;
  };
  roadSegments: Array<{
    startX: number;
    startZ: number;
    endX: number;
    endZ: number;
    width: number;
    blendWidth?: number;
    maxInfluence?: number;
  }>;
  roadBlendWidth: number;
  tileSize: number;
  terrainSurface: GrassTerrainSurfaceSnapshot;
}

export interface GrassWorkerOutput {
  /** Exact detached appearance descriptor, also for empty results. */
  pondServiceGround?: CompactTerrainBankVerge;
  /** Exact selected request marker, including empty regional results. */
  compactPondBlend?: "shore-contact-v1" | "composition-v1";
  /** Exact selected request marker, including empty results. */
  compactCoastBlend?: "distribution-v1";
  /** Echoed only when selected, independently of authoritative terrain identity. */
  compactGrassColorGrade?: CompactGrassColorGrade;
  /** Echoed only for an explicit cell request, never inferred from chunkKey. */
  placementCell?: GrassPlacementCell;
  placementCoverage?: GrassPlacementCoverage;
  placementDistribution?: GrassPlacementDistribution;
  grassEligibility?: GrassSurfaceEligibility;
  terrainProfileIdentity: string;
  type: "grassInstanceResult";
  chunkKey: string;
  offsets: Float32Array;
  rotScaleHash: Float32Array;
  groundColors: Float32Array;
  grassTints: Float32Array;
  groundNormals: Float32Array;
  count: number;
}

export interface GrassBatchResult {
  results: GrassWorkerOutput[];
  workersAvailable: boolean;
  failedCount: number;
}

/** Shared admission for the manager, queued requests and emitted worker. Never
 * read accessors or infer a material choice from terrain or placement identity. */
export function createGrassCoastBlendOperations() {
  return {
    validate(owner: object): "distribution-v1" | undefined {
      if (!("compactCoastBlend" in owner)) return undefined;
      const field = Object.getOwnPropertyDescriptor(owner, "compactCoastBlend");
      if (
        !field?.enumerable ||
        !("value" in field) ||
        field.value !== "distribution-v1"
      )
        throw new Error("Invalid grass coastal distribution selection");
      return field.value;
    },
    assertScope(
      mode: "distribution-v1" | undefined,
      eligibility: GrassSurfaceEligibility,
      field: { coastalMeadow?: unknown } | null,
    ): void {
      if (mode && eligibility !== "compact-pbr-v1")
        throw new Error(
          "Grass coastal distribution requires compact eligibility",
        );
      if (mode && !field?.coastalMeadow)
        throw new Error(
          "Grass coastal distribution requires admitted coastal meadow",
        );
    },
  };
}

/** Historical selection is independent of regional water snapshots. The new
 * composition mode requires its complete small bound zone/water pair even for
 * remote jobs; masks there are neutral, but missing ownership is never inferred. */
export function createGrassPondBlendOperations() {
  return {
    validate(owner: object): "shore-contact-v1" | "composition-v1" | undefined {
      if (!("compactPondBlend" in owner)) return undefined;
      const field = Object.getOwnPropertyDescriptor(owner, "compactPondBlend");
      if (
        !field?.enumerable ||
        !("value" in field) ||
        (field.value !== "shore-contact-v1" && field.value !== "composition-v1")
      )
        throw new Error("Invalid grass pond distribution selection");
      return field.value;
    },
    assertScope(
      mode: "shore-contact-v1" | "composition-v1" | undefined,
      eligibility: GrassSurfaceEligibility,
      field: { pondDistribution?: unknown; pondBankField?: unknown } | null,
    ): void {
      if (mode && eligibility !== "compact-pbr-v1")
        throw new Error("Grass pond distribution requires compact eligibility");
      if (mode === "shore-contact-v1" && !field?.pondDistribution)
        throw new Error("Grass pond distribution requires admitted pond field");
      if (mode === "composition-v1" && !field?.pondBankField)
        throw new Error(
          "Grass pond composition requires snapshot-bound pond field",
        );
    },
    bankField(
      mode: "shore-contact-v1" | "composition-v1" | undefined,
      surface: GrassTerrainSurfaceSnapshot,
      colors: Pick<
        ReturnType<typeof createCompactTerrainColorOperations>,
        "pondBankField" | "validatePond"
      >,
    ): CompactPondBankField | undefined {
      if (mode !== "composition-v1") return undefined;
      // The snapshot has already passed its full own-data and shape admission.
      // Never accept a caller-authored field in place of these actual owners.
      const ponds = surface.waterBodies.filter(
        (body) => body.id === "haven_pond_water",
      );
      const zones = surface.zones.filter(
        (zone) => zone.id === "haven_pond_floor",
      );
      if (ponds.length !== 1 || zones.length !== 1)
        throw new Error(
          "Grass pond composition requires complete snapshot owners",
        );
      const field = colors.pondBankField(
        zones[0],
        colors.validatePond(ponds[0]),
      );
      if (!field)
        throw new Error(
          "Grass pond composition requires admitted snapshot field",
        );
      return field;
    },
  };
}

/** One admission pass, shared verbatim with the emitted worker. Ordinary road
 * records stay untouched; explicit overrides must be own numeric data fields. */
function createGrassWorkerRoadProfileOperations() {
  return {
    validate(roads: GrassWorkerInput["roadSegments"]): void {
      for (const road of roads) {
        for (let field = 0; field < 2; field++) {
          const key = field === 0 ? "blendWidth" : "maxInfluence";
          if (!(key in road)) continue;
          const property = Object.getOwnPropertyDescriptor(road, key);
          if (
            !property ||
            !("value" in property) ||
            typeof property.value !== "number" ||
            !Number.isFinite(property.value) ||
            property.value < 0 ||
            property.value > (field === 0 ? 1024 : 1)
          )
            throw new Error("Invalid grass worker road influence profile");
        }
      }
    },
  };
}

// ============================================================================
// WORKER CODE
// ============================================================================

/**
 * Build a JS string for computeTerrainColorCPU — exact match of
 * TerrainShader.ts lines 869-1022 with all color constants baked
 * as pre-computed linear-space values.
 */
function buildComputeTerrainColorJS(): string {
  return `
  function smoothstepCPU(edge0, edge1, x) {
    var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }
  function mixRGB(a, b, t) {
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
  }
  function blendBiome(tundra, forest, canyon, tW, fW, dW) {
    return {
      r: tundra.r * tW + forest.r * fW + canyon.r * dW,
      g: tundra.g * tW + forest.g * fW + canyon.g * dW,
      b: tundra.b * tW + forest.b * fW + canyon.b * dW
    };
  }

  var _TUNDRA_GRASS = {r:0.587016,g:0.603827,b:0.603827};
  var _TUNDRA_GRASS_DARK = {r:0.381561,g:0.392488,b:0.392488};
  var _TUNDRA_GRASS_HIGH = {r:0.68,g:0.72,b:0.78};
  var _TUNDRA_VARIATION = {r:0.6,g:0.64,b:0.7};
  var _TUNDRA_DIRT = {r:0.570482,g:0.638283,b:0.673860};
  var _TUNDRA_DIRT_DARK = {r:0.370813,g:0.414884,b:0.438009};
  var _TUNDRA_CLIFF = {r:0.570482,g:0.638283,b:0.673860};
  var _TUNDRA_CLIFF_DARK = {r:0.370813,g:0.414884,b:0.438009};

  var _FOREST_GRASS = {r:0.1281,g:0.2393,b:0.0437};
  var _FOREST_GRASS_DARK = {r:0.0833,g:0.1555,b:0.0284};
  var _FOREST_GRASS_HIGH = {r:0.24,g:0.45,b:0.18};
  var _FOREST_VARIATION = {r:0.15,g:0.35,b:0.1};
  var _FOREST_DIRT = {r:0.2641,g:0.1936,b:0.1068};
  var _FOREST_DIRT_DARK = {r:0.1717,g:0.1258,b:0.0694};
  var _FOREST_CLIFF = {r:0.462361,g:0.406448,b:0.318547};
  var _FOREST_CLIFF_DARK = {r:0.300535,g:0.264191,b:0.207055};

  var _CANYON_SAND = {r:0.223414,g:0.139985,b:0.063724};
  var _CANYON_SAND_DARK = {r:0.145219,g:0.090990,b:0.041420};
  var _CANYON_SAND_HIGH = {r:0.62,g:0.38,b:0.22};
  var _CANYON_VARIATION = {r:0.58,g:0.34,b:0.16};
  var _CANYON_ROCK = {r:0.252950,g:0.147319,b:0.083535};
  var _CANYON_ROCK_DARK = {r:0.164418,g:0.095757,b:0.054298};
  var _CANYON_CLIFF = {r:0.252950,g:0.147319,b:0.083535};
  var _CANYON_CLIFF_DARK = {r:0.164418,g:0.095757,b:0.054298};

  var _CLIFF_TINT = {r:0.28,g:0.3,b:0.36};
  var _SAND_YELLOW = {r:0.7,g:0.6,b:0.38};
  var _DIRT_DARK_CPU = {r:0.22,g:0.15,b:0.08};
  var _MUD_BROWN = {r:0.18,g:0.12,b:0.08};
  var _WATER_EDGE = {r:0.08,g:0.06,b:0.04};

  function computeTerrainColorCPU(worldX, worldZ, height, slope, forestW, canyonW, sc) {
    var fW = forestW, dW = canyonW, tW = 1 - fW - dW;

    var noiseVal = sampleNoiseCPU(worldX, worldZ, sc.NOISE_SCALE);
    var noiseVal2 = Math.sin(noiseVal * 6.28) * 0.3 + 0.5;
    var distortN = sampleNoiseCPU(worldX, worldZ, sc.DISTORT_NOISE_SCALE);
    var variationN = sampleNoiseCPU(worldX, worldZ, sc.VARIATION_NOISE_SCALE);

    var distortedNY = 1 - slope + (distortN - 0.5) * sc.ROCK_DISTORT_STRENGTH;
    var dSlope = 1 - distortedNY;
    var dHeight = height + (distortN - 0.5) * sc.HEIGHT_DISTORT_STRENGTH;

    var grassVar = smoothstepCPU(0.4, 0.6, noiseVal2);
    var tundraGrass = mixRGB(_TUNDRA_GRASS, _TUNDRA_GRASS_DARK, grassVar);
    var forestGrass = mixRGB(_FOREST_GRASS, _FOREST_GRASS_DARK, grassVar);
    var canyonGrass = mixRGB(_CANYON_SAND, _CANYON_SAND_DARK, grassVar);
    var c = blendBiome(tundraGrass, forestGrass, canyonGrass, tW, fW, dW);

    var heightGrad = smoothstepCPU(25, 55, height) * 0.3;
    var grassHigh = blendBiome(_TUNDRA_GRASS_HIGH, _FOREST_GRASS_HIGH, _CANYON_SAND_HIGH, tW, fW, dW);
    c = mixRGB(c, grassHigh, heightGrad);

    var gVar = Math.max(0, Math.min(1, Math.pow(variationN + 0.3, 5)));
    var varColor = blendBiome(_TUNDRA_VARIATION, _FOREST_VARIATION, _CANYON_VARIATION, tW, fW, dW);
    c = mixRGB(c, varColor, gVar * 0.25);

    var dirtVar = smoothstepCPU(0.3, 0.7, noiseVal2);
    var dirtColor = blendBiome(
      mixRGB(_TUNDRA_DIRT, _TUNDRA_DIRT_DARK, dirtVar),
      mixRGB(_FOREST_DIRT, _FOREST_DIRT_DARK, dirtVar),
      mixRGB(_CANYON_ROCK, _CANYON_ROCK_DARK, dirtVar),
      tW, fW, dW);

    var cliffVar = smoothstepCPU(0.3, 0.7, noiseVal);
    var cliffColor = blendBiome(
      mixRGB(_TUNDRA_CLIFF, _TUNDRA_CLIFF_DARK, cliffVar),
      mixRGB(_FOREST_CLIFF, _FOREST_CLIFF_DARK, cliffVar),
      mixRGB(_CANYON_CLIFF, _CANYON_CLIFF_DARK, cliffVar),
      tW, fW, dW);
    var rockTexV = Math.pow(distortN, 0.5) * 0.3;
    cliffColor = mixRGB(cliffColor, _CLIFF_TINT, rockTexV);

    var grassWeight = 1.0;

    var nDirtF = smoothstepCPU(sc.DIRT_THRESHOLD - 0.05, sc.DIRT_THRESHOLD + 0.15, noiseVal) * smoothstepCPU(0.3, 0.05, dSlope);
    c = mixRGB(c, dirtColor, nDirtF);
    grassWeight -= nDirtF;

    var dirtSlopeF = smoothstepCPU(0.15, 0.4, dSlope) * smoothstepCPU(0.6, 0.3, dSlope) * 0.6;
    c = mixRGB(c, dirtColor, dirtSlopeF);
    grassWeight -= dirtSlopeF;

    var cliffF = smoothstepCPU(0.3, 0.55, dSlope);
    c = mixRGB(c, cliffColor, cliffF);
    grassWeight -= cliffF;

    var sandBlend = smoothstepCPU(18, 12, dHeight) * smoothstepCPU(0.25, 0.0, slope);
    var sandStr = 0.6 + (0.9 - 0.6) * dW;
    var sandF = sandBlend * sandStr;
    c = mixRGB(c, _SAND_YELLOW, sandF);
    grassWeight -= sandF;

    var shore1 = smoothstepCPU(22, 14, dHeight) * 0.4;
    c = mixRGB(c, _DIRT_DARK_CPU, shore1);
    grassWeight -= shore1;

    var shore2 = smoothstepCPU(15, 10, dHeight) * 0.7;
    c = mixRGB(c, _MUD_BROWN, shore2);
    grassWeight -= shore2;

    var shore3 = smoothstepCPU(11, 7, dHeight) * 0.9;
    c = mixRGB(c, _WATER_EDGE, shore3);
    grassWeight -= shore3;

    var luma = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
    var sat = sc.SATURATION_BOOST;
    c = { r: luma + (c.r - luma) * sat, g: luma + (c.g - luma) * sat, b: luma + (c.b - luma) * sat };

    return { r: c.r, g: c.g, b: c.b, grassWeight: Math.max(0, Math.min(1, grassWeight)) };
  }
`;
}

/**
 * Inline worker code for complete grass instance generation.
 *
 * Embeds: terrain height, biome weights, terrain color, road influence,
 * grass placement, and instance attribute generation.
 */
export const GRASS_WORKER_CODE = `
${buildTerrainWorkerProfileGuardJS()}
var authoredSurface = (${createAuthoredTerrainSurfaceOperations.toString()})();
var terrainSurfaceOperations = (${createGrassTerrainSurfaceOperations.toString()})();
var placementCellOperations = (${createGrassPlacementCellOperations.toString()})();
${buildNoiseGeneratorJS()}
${buildBiomeConstantsJS()}

var BIOME_IDS = {};
BIOME_IDS[BT_TUNDRA] = 0;
BIOME_IDS[BT_FOREST] = 1;
BIOME_IDS[BT_CANYON] = 2;

// One private quantized field per worker, shared with the main-thread sampler.
// This preserves existing texture bytes, not the old analytic worker population.
var terrainNoiseSampler = (${createTerrainNoiseSampler.toString()})();
function sampleNoiseCPU(worldX, worldZ, scale) {
  return terrainNoiseSampler.sample(worldX, worldZ, scale);
}
${buildComputeTerrainColorJS()}
var roadInfluenceOperations = (${createRoadInfluenceOperations.toString()})();
var roadProfileOperations = (${createGrassWorkerRoadProfileOperations.toString()})();
var compactTerrainColorOperations = (${createCompactTerrainColorOperations.toString()})();
var coastBlendOperations = (${createGrassCoastBlendOperations.toString()})();
var pondBlendOperations = (${createGrassPondBlendOperations.toString()})();
var compactMeadowNoiseScale = compactTerrainColorOperations.getComposition().meadowNoiseScale;

function mulberry32(seed) {
  var s = seed | 0;
  return function() {
    s = (s + 0x6d2b79f5) | 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function calculateRoadInfluence(wx, wz, roadSegments, roadBlendWidth) {
  var influence = 0;
  for (var i = 0; i < roadSegments.length; i++) {
    var seg = roadSegments[i];
    influence = Math.max(influence, roadInfluenceOperations.sampleSegment(wx, wz, seg.startX, seg.startZ, seg.endX, seg.endZ, seg.width, seg.blendWidth ?? roadBlendWidth, seg.maxInfluence ?? 1));
    if (influence === 1) return 1;
  }
  return influence;
}

function generateGrassInstances(input) {
  assertTerrainWorkerInput(input);
  roadProfileOperations.validate(input.roadSegments);
  var placementDomain = placementCellOperations.resolveDomain(input);
  var grassEligibility = compactTerrainColorOperations.grassEligibility(input.grassEligibility, input.config.TERRAIN_PROFILE.algorithm);
  var compactGrassColorGrade = compactTerrainColorOperations.grassColorGrade(input.compactGrassColorGrade);
  var compactCoastBlend = coastBlendOperations.validate(input);
  var compactPondBlend = pondBlendOperations.validate(input);
  if (compactGrassColorGrade && grassEligibility !== "compact-pbr-v1")
    throw new Error("Grass color grade requires compact grass eligibility");
  if (placementDomain.placementDistribution && grassEligibility !== "compact-pbr-v1")
    throw new Error("Grass placement distribution requires compact grass eligibility");
  var surface = terrainSurfaceOperations.validateSnapshot(input.terrainSurface);
  var compactPondBankField = pondBlendOperations.bankField(compactPondBlend, surface, compactTerrainColorOperations);
  var pondServiceGround = compactTerrainColorOperations.captureGroundVerge(input, "pondServiceGround");
  if (pondServiceGround && !compactGrassColorGrade)
    throw new Error("Pond service ground requires the graded compact meadow");
  var compactMacroField = compactTerrainColorOperations.macroField(input.config.TERRAIN_PROFILE);
  if (compactPondBlend === "composition-v1")
    compactMacroField = compactTerrainColorOperations.macroField(input.config.TERRAIN_PROFILE, compactCoastBlend, compactPondBlend, compactPondBankField);
  else if (compactCoastBlend || compactPondBlend)
    compactMacroField = compactTerrainColorOperations.macroField(input.config.TERRAIN_PROFILE, compactCoastBlend, compactPondBlend);
  if (pondServiceGround)
    compactMacroField = compactTerrainColorOperations.macroField(input.config.TERRAIN_PROFILE, compactCoastBlend, compactPondBlend, compactPondBankField, pondServiceGround);
  coastBlendOperations.assertScope(compactCoastBlend, grassEligibility, compactMacroField);
  pondBlendOperations.assertScope(compactPondBlend, grassEligibility, compactMacroField);
  var compactPlantingLobes = compactTerrainColorOperations.validatePlantingLobes(input.compactPlantingLobes);
  var compactPondMaterial = (input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v1" || (input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v2" || input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v3" || (input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v4" || input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v5")))
    ? compactTerrainColorOperations.validatePond(surface.waterBodies.find(function(body){return body.id === "haven_pond_water";}) || null) : null;
  var zoneIndex = terrainSurfaceOperations.createZoneIndex(surface, input.tileSize);
  var arenaFloorIds = new Set(surface.arenaFloorIds);
  var startTime = performance.now();
  var centerX = input.centerX, centerZ = input.centerZ, size = input.size;
  var spacingMul = input.spacingMul;
  var config = input.config;
  var biomeCenters = input.biomeCenters;
  var biomes = input.biomes;
  var sc = input.shaderConstants;
  var grassConfigs = input.grassConfigs;

  var BIOME_GAUSSIAN_COEFF = config.BIOME_GAUSSIAN_COEFF;
  var BIOME_BOUNDARY_NOISE_SCALE = config.BIOME_BOUNDARY_NOISE_SCALE;
  var BIOME_BOUNDARY_NOISE_AMOUNT = config.BIOME_BOUNDARY_NOISE_AMOUNT;
  var WATER_THRESHOLD = input.waterThreshold;
  var SHORELINE_THRESHOLD = config.SHORELINE_THRESHOLD;
  var SHORELINE_STRENGTH = config.SHORELINE_STRENGTH;
  var SHORELINE_MIN_SLOPE = config.SHORELINE_MIN_SLOPE;
  var SHORELINE_SLOPE_SAMPLE_DISTANCE = config.SHORELINE_SLOPE_SAMPLE_DISTANCE;
  var SHORELINE_LAND_BAND = config.SHORELINE_LAND_BAND;
  var SHORELINE_LAND_MAX_MULTIPLIER = config.SHORELINE_LAND_MAX_MULTIPLIER;
  var SHORELINE_UNDERWATER_BAND = config.SHORELINE_UNDERWATER_BAND;
  var UNDERWATER_DEPTH_MULTIPLIER = config.UNDERWATER_DEPTH_MULTIPLIER;
  var MAX_HEIGHT = config.MAX_HEIGHT;

  var noise = new NoiseGenerator(input.seed);

  ${buildComputeBiomeWeightsJS()}
  ${buildGetBaseHeightAtJS()}
  ${buildCreateBiomeNoiseSetsJS()}
  var biomeNoiseSets = createBiomeNoiseSets(input.seed);
  ${buildHeightHelpersJS()}
  ${buildBiomeInfluencesJS()}

  function getAuthoredHeight(wx, wz) {
    var height = authoredSurface.resolveHeight(
      zoneIndex.getZonesAt(wx, wz), wx, wz,
      function() { return getHeightAtWithoutShore(wx, wz); },
      arenaFloorIds, surface.arenaGradeHeight
    );
    return height === null ? getHeightComputed(wx, wz) : height;
  }

  var spacing = input.clumpSpacing * spacingMul;
  var maxCount = placementDomain.maxCount;
  var rng = mulberry32(input.grassSeed ^ ((placementDomain.centerX * 374761393 + placementDomain.centerZ * 668265263) | 0));

  var offsets = new Float32Array(maxCount * 3);
  var rotScaleHash = new Float32Array(maxCount * 3);
  var groundColors = new Float32Array(maxCount * 3);
  var grassTints = new Float32Array(maxCount * 4);
  var groundNormals = new Float32Array(maxCount * 3);
  var count = 0;
  var placementPosition = { x: 0, z: 0, leafX: 0, leafZ: 0 };

  var tCfg = grassConfigs[BT_TUNDRA] || grassConfigs["tundra"];
  var fCfg = grassConfigs[BT_FOREST] || grassConfigs["forest"];
  var cCfg = grassConfigs[BT_CANYON] || grassConfigs["canyon"];

  for (var i = 0; i < maxCount; i++) {
    var lx, lz, wx, wz;
    if (placementDomain.placementDistribution) {
      placementCellOperations.samplePosition(placementDomain, i, rng(), rng(), placementPosition);
      lx = placementPosition.leafX;
      lz = placementPosition.leafZ;
      wx = centerX + lx;
      wz = centerZ + lz;
    } else {
      lx = (rng() - 0.5) * placementDomain.size;
      lz = (rng() - 0.5) * placementDomain.size;
      wx = centerX + lx;
      wz = centerZ + lz;
      if (placementDomain.placementCell) {
        wx = placementDomain.centerX + lx;
        wz = placementDomain.centerZ + lz;
        // Grounding and GPU placement retain the real terrain leaf's local frame.
        lx = wx - centerX;
        lz = wz - centerZ;
      }
    }
    var clumpRng = rng();
    var ty = getAuthoredHeight(wx, wz);

    var waterSurface = terrainSurfaceOperations.getWaterSurfaceAt(surface, WATER_THRESHOLD, wx, wz);
    if (ty < waterSurface + 0.1) continue;

    if (authoredSurface.isGrassExcluded(zoneIndex.getZonesAt(wx, wz), wx, wz)) continue;

    var roadInf = calculateRoadInfluence(wx, wz, input.roadSegments, input.roadBlendWidth);
    if (roadInf > 0.8) continue;

    // Normal via finite differences (matches TerrainSystem.getTerrainColorAt)
    var sd = ${GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE};
    var hL = getAuthoredHeight(wx - sd, wz);
    var hR = getAuthoredHeight(wx + sd, wz);
    var hD = getAuthoredHeight(wx, wz - sd);
    var hU = getAuthoredHeight(wx, wz + sd);
    var dhdx = (hR - hL) / (2 * sd);
    var dhdz = (hU - hD) / (2 * sd);
    var gradMag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
    var normalY = 1 / Math.sqrt(1 + gradMag * gradMag);
    var slope = 1 - normalY;

    var rnx = -dhdx, rny = 1.0, rnz = -dhdz;
    var nLen = Math.sqrt(rnx * rnx + rny * rny + rnz * rnz);
    var invLen = 1 / nLen;

    // Biome weights
    var bw = computeBiomeWeightsByPosition(wx, wz);
    var forestW = bw[BT_FOREST] || 0;
    var canyonW = bw[BT_CANYON] || 0;
    var tundraW = 1 - forestW - canyonW;

    var color = computeTerrainColorCPU(wx, wz, ty, slope, forestW, canyonW, sc);
    var coastalGroundCover = 0;
    var coastalDistributionSupport = 0;
    var pondMarginScale = 1;
    var grassEstablishment = false;
    var grassEstablishmentWeight = 0;
    if (input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v1" || (input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v2" || input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v3" || (input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v4" || input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v5"))) {
      var compactInput = {
        grassColorGrade: compactGrassColorGrade,
        noiseValue: sampleNoiseCPU(wx, wz, sc.NOISE_SCALE),
        meadowNoise: sampleNoiseCPU(wx, wz, compactMeadowNoiseScale),
        distortNoise: sampleNoiseCPU(wx, wz, sc.DISTORT_NOISE_SCALE),
        slope: slope, roadInfluence: roadInf,
        surface: {x:wx,z:wz,height:ty,pond:compactPondMaterial,macroField:compactMacroField,plantingLobes:compactPlantingLobes}
      };
      var compactRGB = compactTerrainColorOperations.sample(compactInput);
      color.r = compactRGB.r; color.g = compactRGB.g; color.b = compactRGB.b;
      if (grassEligibility === "compact-pbr-v1") {
        color.grassWeight = compactTerrainColorOperations.grassSupportBeforeCoast(compactInput);
      }
      coastalGroundCover = compactTerrainColorOperations.coastalGroundCover({
        height: ty, noiseValue: compactInput.noiseValue,
        distortNoise: compactInput.distortNoise, field: compactMacroField
      });
      if (compactCoastBlend || compactPondBlend)
        coastalDistributionSupport = compactTerrainColorOperations.grassSupport(compactInput);
      if (compactPondBlend === "shore-contact-v1")
        pondMarginScale = compactTerrainColorOperations.pondMarginAt(compactInput).clumpScale;
      if (compactPondBlend === "composition-v1") {
        grassEstablishmentWeight = compactTerrainColorOperations.bankCompositionAt(compactInput).groundCoverWeight;
        grassEstablishment = grassEstablishmentWeight > 0;
      }
    }

    // Biome-blended grass params
    var maxSlope = tCfg.maxSlope * tundraW + fCfg.maxSlope * forestW + cCfg.maxSlope * canyonW;
    var minGW = tCfg.minGrassWeight * tundraW + fCfg.minGrassWeight * forestW + cCfg.minGrassWeight * canyonW;
    var density = tCfg.density * tundraW + fCfg.density * forestW + cCfg.density * canyonW;
    var grassHeightScale = tCfg.heightScale * tundraW + fCfg.heightScale * forestW + cCfg.heightScale * canyonW;
    var patchiness = tCfg.patchiness * tundraW + fCfg.patchiness * forestW + cCfg.patchiness * canyonW;
    var patchScale = tCfg.patchScale * tundraW + fCfg.patchScale * forestW + cCfg.patchScale * canyonW;

    var slopeOk = slope <= maxSlope ? 1.0 : 0.0;
    var weightOk = (grassEligibility === "compact-pbr-v1" ? color.grassWeight > 0 : color.grassWeight >= minGW) ? 1.0 : 0.0;

    var patchThreshold = patchiness * 2 - 1;
    var noiseVal = noise.simplex2D(wx * patchScale, wz * patchScale);
    var patchMask = noiseVal > patchThreshold ? 1.0 : 0.0;

    var rawGP = color.grassWeight * density * slopeOk * weightOk * patchMask;
    var grassPlacement = Math.max(0, rawGP - roadInf);

    var historicalAccepted = grassPlacement > 0 && clumpRng <= grassPlacement;
    var distributionRaw = coastalDistributionSupport * density * slopeOk *
      (grassEstablishment ? (coastalDistributionSupport > 0 ? 1 : 0) : weightOk) * patchMask;
    if (grassEstablishment)
      distributionRaw = compactTerrainColorOperations.bankEstablishmentPlacement(distributionRaw, rawGP * (1 - coastalGroundCover), grassEstablishmentWeight);
    var distributionPlacement = Math.max(0, distributionRaw - roadInf);
    if (!historicalAccepted && (!grassEstablishment || distributionPlacement <= 0 || clumpRng > distributionPlacement)) continue;

    offsets[count * 3] = lx;
    offsets[count * 3 + 1] = ty;
    offsets[count * 3 + 2] = lz;

    var rotation = historicalAccepted ? rng() * Math.PI * 2 :
      placementCellOperations.establishmentRotation(placementDomain, input.grassSeed, i);
    // Keep original acceptance and rotation draws before applying candidate
    // coastal support. Surviving roots elsewhere keep their exact seeded pose.
    if (!grassEstablishment && coastalGroundCover > 0) {
      var coastalPlacement = Math.max(0, rawGP * (1 - coastalGroundCover) - roadInf);
      if (coastalPlacement <= 0 || clumpRng > coastalPlacement) continue;
    }
    // Old attempts consume their original rotation even when later removed.
    // Newly admitted authored roots use the stateless fork above, never RNG.
    if (compactCoastBlend || compactPondBlend) {
      if (distributionPlacement <= 0 || clumpRng > distributionPlacement) continue;
    }
    // Consume the original accepted-clump rotation before filtering obstacles.
    // A new rock removes intersecting clumps without re-phasing later samples.
    if (terrainSurfaceOperations.isGrassExcluded(surface, wx, wz)) continue;
    // Match TerrainSystem's returned height factor exactly. This is the
    // accepted instance's real scale, not a GPU-only deformation: retained
    // grounding and swept footprints therefore receive the same smaller tuft.
    var scale = (input.scaleMin + clumpRng * (input.scaleMax - input.scaleMin)) * (grassHeightScale * pondMarginScale);
    // Scale only after the existing acceptance/rotation/obstacle decisions.
    // No new roots or random draws; the same bounded field softens the ground.
    if (compactMacroField?.bankVerge) {
      scale *= compactTerrainColorOperations.bankVergeClumpScale(wx, wz, roadInf, compactMacroField);
    }
    rotScaleHash[count * 3] = rotation;
    rotScaleHash[count * 3 + 1] = scale;
    rotScaleHash[count * 3 + 2] = clumpRng;

    groundColors[count * 3] = color.r;
    groundColors[count * 3 + 1] = color.g;
    groundColors[count * 3 + 2] = color.b;

    var tS = tCfg.tintStrength * tundraW + fCfg.tintStrength * forestW + cCfg.tintStrength * canyonW;
    if (tS > 0) {
      var tR = tCfg.tintR * tCfg.tintStrength * tundraW + fCfg.tintR * fCfg.tintStrength * forestW + cCfg.tintR * cCfg.tintStrength * canyonW;
      var tG = tCfg.tintG * tCfg.tintStrength * tundraW + fCfg.tintG * fCfg.tintStrength * forestW + cCfg.tintG * cCfg.tintStrength * canyonW;
      var tB = tCfg.tintB * tCfg.tintStrength * tundraW + fCfg.tintB * fCfg.tintStrength * forestW + cCfg.tintB * cCfg.tintStrength * canyonW;
      var inv = 1 / tS;
      grassTints[count * 4] = tR * inv;
      grassTints[count * 4 + 1] = tG * inv;
      grassTints[count * 4 + 2] = tB * inv;
      grassTints[count * 4 + 3] = tS;
    }

    groundNormals[count * 3] = rnx * invLen;
    groundNormals[count * 3 + 1] = rny * invLen;
    groundNormals[count * 3 + 2] = rnz * invLen;

    count++;
  }

  if (count === 0) {
    return {
      ...(pondServiceGround ? { pondServiceGround: pondServiceGround } : {}),
      ...(compactPondBlend ? { compactPondBlend: compactPondBlend } : {}),
      ...(compactCoastBlend ? { compactCoastBlend: compactCoastBlend } : {}),
      ...(compactGrassColorGrade ? { compactGrassColorGrade: compactGrassColorGrade } : {}),
      ...(placementDomain.placementCell ? { placementCell: placementCellOperations.validateCell(placementDomain.placementCell) } : {}),
      ...(placementDomain.placementDistribution ? { placementDistribution: placementDomain.placementDistribution } : {}),
      ...(placementDomain.placementCoverage ? { placementCoverage: placementDomain.placementCoverage } : {}),
      type: "grassInstanceResult",
      grassEligibility: grassEligibility,
      terrainProfileIdentity: config.TERRAIN_PROFILE_IDENTITY,
      chunkKey: input.chunkKey,
      offsets: new Float32Array(0),
      rotScaleHash: new Float32Array(0),
      groundColors: new Float32Array(0),
      grassTints: new Float32Array(0),
      groundNormals: new Float32Array(0),
      count: 0
    };
  }

  return {
    ...(pondServiceGround ? { pondServiceGround: pondServiceGround } : {}),
    ...(compactPondBlend ? { compactPondBlend: compactPondBlend } : {}),
    ...(compactCoastBlend ? { compactCoastBlend: compactCoastBlend } : {}),
    ...(compactGrassColorGrade ? { compactGrassColorGrade: compactGrassColorGrade } : {}),
    ...(placementDomain.placementCell ? { placementCell: placementCellOperations.validateCell(placementDomain.placementCell) } : {}),
    ...(placementDomain.placementDistribution ? { placementDistribution: placementDomain.placementDistribution } : {}),
    ...(placementDomain.placementCoverage ? { placementCoverage: placementDomain.placementCoverage } : {}),
    type: "grassInstanceResult",
    grassEligibility: grassEligibility,
    terrainProfileIdentity: config.TERRAIN_PROFILE_IDENTITY,
    chunkKey: input.chunkKey,
    offsets: offsets.subarray(0, count * 3),
    rotScaleHash: rotScaleHash.subarray(0, count * 3),
    groundColors: groundColors.subarray(0, count * 3),
    grassTints: grassTints.subarray(0, count * 4),
    groundNormals: groundNormals.subarray(0, count * 3),
    count: count
  };
}

self.onmessage = function(e) {
  var input = e.data;
  if (input.type === "generateGrassInstances") {
    try {
      var result = generateGrassInstances(input);
      // Transfer Float32Array buffers for zero-copy
      var transfers = [];
      if (result.offsets.buffer.byteLength > 0) transfers.push(result.offsets.buffer);
      if (result.rotScaleHash.buffer.byteLength > 0) transfers.push(result.rotScaleHash.buffer);
      if (result.groundColors.buffer.byteLength > 0) transfers.push(result.groundColors.buffer);
      if (result.grassTints.buffer.byteLength > 0) transfers.push(result.grassTints.buffer);
      if (result.groundNormals.buffer.byteLength > 0) transfers.push(result.groundNormals.buffer);
      self.postMessage({ result: result }, transfers);
    } catch (err) {
      self.postMessage({ error: err.message || "Grass worker error" });
    }
  } else {
    self.postMessage({ error: "Unknown message type: " + input.type });
  }
};
`;

// ============================================================================
// WORKER POOL MANAGEMENT
// ============================================================================

let grassWorkerPool: WorkerPool<GrassWorkerInput, GrassWorkerOutput> | null =
  null;

let workersChecked = false;
let workersAvailable = false;
const surfaceOperations = createGrassTerrainSurfaceOperations();
const colorOperations = createCompactTerrainColorOperations();
const placementCellOperations = createGrassPlacementCellOperations();
const roadProfileOperations = createGrassWorkerRoadProfileOperations();
const coastBlendOperations = createGrassCoastBlendOperations();
const pondBlendOperations = createGrassPondBlendOperations();

/** Capture the wire-owned cell and authored surface before a pool may queue it. */
export function prepareGrassWorkerRequest(
  input: GrassWorkerInput,
): GrassWorkerInput {
  assertTerrainWorkerRequest(input.config, input.seed);
  roadProfileOperations.validate(input.roadSegments);
  const eligibility = colorOperations.grassEligibility(
    input.grassEligibility,
    input.config.TERRAIN_PROFILE.algorithm,
  );
  const grade = colorOperations.grassColorGrade(input.compactGrassColorGrade);
  const pondServiceGround = colorOperations.captureGroundVerge(
    input,
    "pondServiceGround",
  );
  if (pondServiceGround && !grade)
    throw new Error("Pond service ground requires the graded compact meadow");
  const coastBlend = coastBlendOperations.validate(input);
  const pondBlend = pondBlendOperations.validate(input);
  const terrainSurface = surfaceOperations.cloneSnapshot(input.terrainSurface);
  const pondBankField = pondBlendOperations.bankField(
    pondBlend,
    terrainSurface,
    colorOperations,
  );
  if (coastBlend)
    coastBlendOperations.assertScope(
      coastBlend,
      eligibility,
      colorOperations.macroField(input.config.TERRAIN_PROFILE, coastBlend),
    );
  if (pondBlend)
    pondBlendOperations.assertScope(
      pondBlend,
      eligibility,
      colorOperations.macroField(
        input.config.TERRAIN_PROFILE,
        coastBlend,
        pondBlend,
        pondBankField,
      ),
    );
  if (grade && eligibility !== "compact-pbr-v1")
    throw new Error("Grass color grade requires compact grass eligibility");
  const domain = placementCellOperations.resolveDomain(input);
  if (pondServiceGround)
    colorOperations.macroField(
      input.config.TERRAIN_PROFILE,
      coastBlend,
      pondBlend,
      pondBankField,
      pondServiceGround,
    );
  if (domain.placementDistribution && eligibility !== "compact-pbr-v1")
    throw new Error(
      "Grass placement distribution requires compact grass eligibility",
    );
  return {
    ...input,
    ...(pondServiceGround ? { pondServiceGround } : {}),
    ...(pondBlend ? { compactPondBlend: pondBlend } : {}),
    ...(coastBlend ? { compactCoastBlend: coastBlend } : {}),
    ...(domain.placementCell ? { placementCell: domain.placementCell } : {}),
    ...(domain.placementDistribution
      ? { placementDistribution: domain.placementDistribution }
      : {}),
    ...(domain.placementCoverage
      ? { placementCoverage: domain.placementCoverage }
      : {}),
    terrainSurface,
  };
}

/** Admit cell and visual grade separately from terrain identity and chunk key. */
export function admitGrassWorkerPlacementResult(
  result: GrassWorkerOutput,
  request: GrassWorkerInput,
): GrassWorkerOutput {
  const expectedService = colorOperations.captureGroundVerge(
    request,
    "pondServiceGround",
  );
  const receivedService = colorOperations.captureGroundVerge(
    result,
    "pondServiceGround",
  );
  if (JSON.stringify(expectedService) !== JSON.stringify(receivedService))
    throw new Error("Grass worker pond service ground mismatch");
  const expectedPondBlend = pondBlendOperations.validate(request);
  const receivedPondBlend = pondBlendOperations.validate(result);
  if (receivedPondBlend !== expectedPondBlend)
    throw new Error("Grass worker pond distribution mismatch");
  const expectedCoastBlend = coastBlendOperations.validate(request);
  const receivedCoastBlend = coastBlendOperations.validate(result);
  if (receivedCoastBlend !== expectedCoastBlend)
    throw new Error("Grass worker coastal distribution mismatch");
  const expectedGrade = colorOperations.grassColorGrade(
    request.compactGrassColorGrade,
  );
  const receivedGrade = colorOperations.grassColorGrade(
    result.compactGrassColorGrade,
  );
  if (
    receivedGrade !== expectedGrade ||
    (!expectedGrade &&
      Object.prototype.hasOwnProperty.call(result, "compactGrassColorGrade"))
  )
    throw new Error("Grass worker grass color grade mismatch");
  const expectedDomain = placementCellOperations.resolveDomain(request);
  const coverageField = Object.getOwnPropertyDescriptor(
    result,
    "placementCoverage",
  );
  if (
    "placementCoverage" in result &&
    (!coverageField?.enumerable || !("value" in coverageField))
  )
    throw new Error("Grass worker placement coverage must be own data");
  const receivedCoverage = placementCellOperations.validateCoverage(
    coverageField?.value,
  );
  if (
    receivedCoverage !== expectedDomain.placementCoverage ||
    (coverageField !== undefined) !==
      (expectedDomain.placementCoverage !== undefined)
  )
    throw new Error("Grass worker placement coverage mismatch");
  const expectedDistribution = expectedDomain.placementDistribution;
  if (
    expectedDistribution &&
    colorOperations.grassEligibility(
      request.grassEligibility,
      request.config.TERRAIN_PROFILE.algorithm,
    ) !== "compact-pbr-v1"
  )
    throw new Error(
      "Grass placement distribution requires compact grass eligibility",
    );
  const receivedDistribution = placementCellOperations.validateDistribution(
    result.placementDistribution,
  );
  const hasDistribution = Object.prototype.hasOwnProperty.call(
    result,
    "placementDistribution",
  );
  if (
    receivedDistribution !== expectedDistribution ||
    hasDistribution !== (expectedDistribution !== undefined)
  )
    throw new Error("Grass worker placement distribution mismatch");
  const expected = expectedDomain.placementCell;
  if (!expected) {
    if (Object.prototype.hasOwnProperty.call(result, "placementCell"))
      throw new Error("Unexpected grass worker placement cell");
    // Validate original markers before copying: a spread must not normalize
    // inherited fields or invoke their getters ahead of their own admission.
    return receivedService
      ? { ...result, pondServiceGround: receivedService }
      : result;
  }
  const cell = placementCellOperations.validateCell(result.placementCell);
  if (cell.indexX !== expected.indexX || cell.indexZ !== expected.indexZ)
    throw new Error("Grass worker placement cell mismatch");
  return {
    ...result,
    placementCell: cell,
    ...(receivedService ? { pondServiceGround: receivedService } : {}),
  };
}

export function isGrassWorkerAvailable(): boolean {
  if (!workersChecked) {
    workersChecked = true;
    if (typeof Worker === "undefined" || typeof Blob === "undefined") {
      workersAvailable = false;
      return workersAvailable;
    }
    if (
      typeof process !== "undefined" &&
      process.versions &&
      "bun" in process.versions
    ) {
      workersAvailable = false;
      return workersAvailable;
    }
    if (typeof window === "undefined") {
      workersAvailable = false;
      return workersAvailable;
    }
    workersAvailable = true;
  }
  return workersAvailable;
}

export function getGrassWorkerPool(
  poolSize?: number,
): WorkerPool<GrassWorkerInput, GrassWorkerOutput> | null {
  if (!isGrassWorkerAvailable()) {
    return null;
  }

  if (!grassWorkerPool) {
    grassWorkerPool = new WorkerPool<GrassWorkerInput, GrassWorkerOutput>(
      GRASS_WORKER_CODE,
      poolSize,
    );
  }
  return grassWorkerPool;
}

export async function generateGrassPlacementsAsync(
  input: GrassWorkerInput,
): Promise<GrassWorkerOutput | null> {
  const request = prepareGrassWorkerRequest(input);
  const eligibility = colorOperations.grassEligibility(
    input.grassEligibility,
    input.config.TERRAIN_PROFILE.algorithm,
  );
  const pool = getGrassWorkerPool();
  if (!pool) {
    return null;
  }
  const result = await pool.execute(request);
  assertTerrainWorkerResult(result, input.config);
  if ((result.grassEligibility ?? "legacy-biome-v1") !== eligibility)
    throw new Error("Grass worker eligibility mismatch");
  return admitGrassWorkerPlacementResult(result, request);
}

export async function generateGrassChunksBatch(
  inputs: GrassWorkerInput[],
): Promise<GrassBatchResult> {
  // Validate and detach the entire batch before dispatch: a malformed later
  // snapshot must not leave an earlier subset running after this call rejects.
  const requests = inputs.map(prepareGrassWorkerRequest);
  const pool = getGrassWorkerPool();
  if (!pool) {
    return { results: [], workersAvailable: false, failedCount: inputs.length };
  }

  const results: GrassWorkerOutput[] = [];
  let failedCount = 0;

  const promises = requests.map((input) =>
    pool
      .execute(input)
      .then((result) => {
        assertTerrainWorkerResult(result, input.config);
        if (
          (result.grassEligibility ?? "legacy-biome-v1") !==
          (input.grassEligibility ?? "legacy-biome-v1")
        )
          throw new Error("Grass worker eligibility mismatch");
        results.push(admitGrassWorkerPlacementResult(result, input));
      })
      .catch(() => {
        failedCount++;
      }),
  );

  await Promise.all(promises);

  return { results, workersAvailable: true, failedCount };
}

export function terminateGrassWorkerPool(): void {
  if (grassWorkerPool) {
    grassWorkerPool.terminate();
    grassWorkerPool = null;
  }
}
