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
import { createCompactTerrainColorOperations } from "../../systems/shared/world/CompactTerrainPalette";
import {
  createGrassTerrainSurfaceOperations,
  GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
  type GrassTerrainSurfaceSnapshot,
} from "./GrassTerrainSurfaceSnapshot";

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
  }>;
  roadBlendWidth: number;
  tileSize: number;
  terrainSurface: GrassTerrainSurfaceSnapshot;
}

export interface GrassWorkerOutput {
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

// ============================================================================
// WORKER CODE
// ============================================================================

/**
 * Build a JS string for the sampleNoiseCPU pipeline — exact match of
 * TerrainShader.ts lines 422-549 + 827-861.
 * Worker has no texture, so we always use the seamlessFbm path.
 */
function buildSampleNoiseJS(): string {
  return `
  function _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function _lerp(a, b, t) { return a + t * (b - a); }
  function _grad(hash, x, y) {
    var h = hash & 3;
    var u = h < 2 ? x : y;
    var v = h < 2 ? y : x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  function createPermutation(seed) {
    var p = [];
    for (var i = 0; i < 256; i++) p[i] = i;
    var s = seed;
    for (var i = 255; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      var j = s % (i + 1);
      var tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    return p.concat(p);
  }

  function perlin2DPerm(x, y, perm) {
    var X = Math.floor(x) & 255;
    var Y = Math.floor(y) & 255;
    var xf = x - Math.floor(x);
    var yf = y - Math.floor(y);
    var u = _fade(xf);
    var v = _fade(yf);
    var aa = perm[perm[X] + Y];
    var ab = perm[perm[X] + Y + 1];
    var ba = perm[perm[X + 1] + Y];
    var bb = perm[perm[X + 1] + Y + 1];
    var x1 = _lerp(_grad(aa, xf, yf), _grad(ba, xf - 1, yf), u);
    var x2 = _lerp(_grad(ab, xf, yf - 1), _grad(bb, xf - 1, yf - 1), u);
    return _lerp(x1, x2, v);
  }

  function seamlessPerlin2D(x, y, perm) {
    var TWO_PI = Math.PI * 2;
    var angleX = x * TWO_PI;
    var angleY = y * TWO_PI;
    var nx = Math.cos(angleX);
    var ny = Math.sin(angleX);
    var nz = Math.cos(angleY);
    var nw = Math.sin(angleY);
    var n1 = perlin2DPerm(nx * 4 + 100, nz * 4 + 100, perm);
    var n2 = perlin2DPerm(ny * 4 + 200, nw * 4 + 200, perm);
    var n3 = perlin2DPerm(nx * 4 + ny * 4 + 300, nz * 4 + nw * 4 + 300, perm);
    return (n1 + n2 + n3) / 3;
  }

  function seamlessFbm(x, y, perm, octaves) {
    var value = 0, amplitude = 0.5, maxValue = 0;
    for (var i = 0; i < octaves; i++) {
      var ox = x + i * 17.3;
      var oy = y + i * 31.7;
      value += amplitude * seamlessPerlin2D(ox, oy, perm);
      maxValue += amplitude;
      amplitude *= 0.5;
    }
    return value / maxValue;
  }

  var _noisePerm = createPermutation(12345);

  function sampleNoiseCPU(worldX, worldZ, scale) {
    var u = worldX * scale;
    var v = worldZ * scale;
    var wu = u - Math.floor(u);
    var wv = v - Math.floor(v);
    return (seamlessFbm(wu, wv, _noisePerm, 4) + 1) * 0.5;
  }
`;
}

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
${buildNoiseGeneratorJS()}
${buildBiomeConstantsJS()}

var BIOME_IDS = {};
BIOME_IDS[BT_TUNDRA] = 0;
BIOME_IDS[BT_FOREST] = 1;
BIOME_IDS[BT_CANYON] = 2;

${buildSampleNoiseJS()}
${buildComputeTerrainColorJS()}
var roadInfluenceOperations = (${createRoadInfluenceOperations.toString()})();
var compactTerrainColorOperations = (${createCompactTerrainColorOperations.toString()})();
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
    influence = Math.max(influence, roadInfluenceOperations.sampleSegment(wx, wz, seg.startX, seg.startZ, seg.endX, seg.endZ, seg.width, roadBlendWidth));
    if (influence === 1) return 1;
  }
  return influence;
}

function generateGrassInstances(input) {
  assertTerrainWorkerInput(input);
  var grassEligibility = compactTerrainColorOperations.grassEligibility(input.grassEligibility, input.config.TERRAIN_PROFILE.algorithm);
  var compactMacroField = compactTerrainColorOperations.macroField(input.config.TERRAIN_PROFILE);
  var surface = terrainSurfaceOperations.validateSnapshot(input.terrainSurface);
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
  var maxCount = Math.ceil((size * size) / (spacing * spacing));
  var rng = mulberry32(input.grassSeed ^ ((centerX * 374761393 + centerZ * 668265263) | 0));

  var offsets = new Float32Array(maxCount * 3);
  var rotScaleHash = new Float32Array(maxCount * 3);
  var groundColors = new Float32Array(maxCount * 3);
  var grassTints = new Float32Array(maxCount * 4);
  var groundNormals = new Float32Array(maxCount * 3);
  var count = 0;

  var tCfg = grassConfigs[BT_TUNDRA] || grassConfigs["tundra"];
  var fCfg = grassConfigs[BT_FOREST] || grassConfigs["forest"];
  var cCfg = grassConfigs[BT_CANYON] || grassConfigs["canyon"];

  for (var i = 0; i < maxCount; i++) {
    var lx = (rng() - 0.5) * size;
    var lz = (rng() - 0.5) * size;
    var clumpRng = rng();

    var wx = centerX + lx;
    var wz = centerZ + lz;
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
    if (input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v1" || (input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v2" || input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v3" || (input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v4" || input.config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v5"))) {
      var compactInput = {
        noiseValue: sampleNoiseCPU(wx, wz, sc.NOISE_SCALE),
        meadowNoise: sampleNoiseCPU(wx, wz, compactMeadowNoiseScale),
        distortNoise: sampleNoiseCPU(wx, wz, sc.DISTORT_NOISE_SCALE),
        slope: slope, roadInfluence: roadInf,
        surface: {x:wx,z:wz,height:ty,pond:compactPondMaterial,macroField:compactMacroField}
      };
      var compactRGB = compactTerrainColorOperations.sample(compactInput);
      color.r = compactRGB.r; color.g = compactRGB.g; color.b = compactRGB.b;
      if (grassEligibility === "compact-pbr-v1") {
        color.grassWeight = compactTerrainColorOperations.grassSupport(compactInput);
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

    if (grassPlacement <= 0) continue;
    if (clumpRng > grassPlacement) continue;

    offsets[count * 3] = lx;
    offsets[count * 3 + 1] = ty;
    offsets[count * 3 + 2] = lz;

    var rotation = rng() * Math.PI * 2;
    var scale = (input.scaleMin + clumpRng * (input.scaleMax - input.scaleMin)) * grassHeightScale;
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
  assertTerrainWorkerRequest(input.config, input.seed);
  const eligibility = colorOperations.grassEligibility(
    input.grassEligibility,
    input.config.TERRAIN_PROFILE.algorithm,
  );
  const request = {
    ...input,
    terrainSurface: surfaceOperations.cloneSnapshot(input.terrainSurface),
  };
  const pool = getGrassWorkerPool();
  if (!pool) {
    return null;
  }
  const result = await pool.execute(request);
  assertTerrainWorkerResult(result, input.config);
  if ((result.grassEligibility ?? "legacy-biome-v1") !== eligibility)
    throw new Error("Grass worker eligibility mismatch");
  return result;
}

export async function generateGrassChunksBatch(
  inputs: GrassWorkerInput[],
): Promise<GrassBatchResult> {
  // Validate and detach the entire batch before dispatch: a malformed later
  // snapshot must not leave an earlier subset running after this call rejects.
  const requests = inputs.map((input) => {
    assertTerrainWorkerRequest(input.config, input.seed);
    colorOperations.grassEligibility(
      input.grassEligibility,
      input.config.TERRAIN_PROFILE.algorithm,
    );
    return {
      ...input,
      terrainSurface: surfaceOperations.cloneSnapshot(input.terrainSurface),
    };
  });
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
        results.push(result);
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
