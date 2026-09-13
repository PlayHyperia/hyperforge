/**
 * Single source of truth for terrain height generation parameters.
 *
 * CPU and inline workers share algorithm constants and consume explicit terrain
 * profiles for island/height/water shape. Worker source is assembled at module
 * load, so profile values must come from each request, never baked-in defaults.
 */

import { BiomeType, DEFAULT_BIOME } from "./TerrainBiomeTypes";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import {
  createCompactIslandLandform,
  buildCompactIslandLandformJS,
} from "./CompactIslandLandform";
import {
  smoothstep,
  mapRangeSmooth,
  normalizeFbmRange,
  pingpong,
} from "../../../utils/NoiseGenerator";

// ---------------------------------------------------------------------------
// Core terrain generation constants
// ---------------------------------------------------------------------------

export const MAX_HEIGHT = 50;

/**
 * Derived from WATER_THRESHOLD / MAX_HEIGHT so there's one source of truth.
 * Terrain generation works in 0-1 normalized space; this is the cutoff.
 */
export const WATER_LEVEL_NORMALIZED =
  TERRAIN_CONSTANTS.WATER_THRESHOLD / MAX_HEIGHT;

// ---------------------------------------------------------------------------
// Shoreline constants — shape terrain near the water edge
// ---------------------------------------------------------------------------

export const SHORELINE_CONFIG = {
  THRESHOLD: 0.25,
  STRENGTH: 0.6,
  MIN_SLOPE: 0.06,
  SLOPE_SAMPLE_DISTANCE: 1.0,
  LAND_BAND: 3.0,
  LAND_MAX_MULTIPLIER: 1.6,
  UNDERWATER_BAND: 3.0,
  UNDERWATER_DEPTH_MULTIPLIER: 1.8,
} as const;

// ---------------------------------------------------------------------------
// Per-biome terrain config — each biome is a complete height function
// ---------------------------------------------------------------------------

export interface BiomeTerrainConfig {
  seedOffset: number;
  frequency: number;
  amplitude: number;
  octaves: number;
  gain: number;
  lacunarity: number;
  noiseOffset: number;
  altitude: number;
  altitudeVariation: number;
  erosion: number;
  erosionSoftness: number;
  rivers: number;
  riverWidth: number;
  lakes: number;
  lakesFalloff: number;
  heightScale: number;
  powerCurve: number;
  smoothLowerPlanes: number;
  canyonMode: boolean;
  canyonFreqScale: number;
  canyonAmpScale: number;
  cliffLow: number;
  cliffHigh: number;
  terraceSteps: number;
  terraceStrength: number;
  terraceSharpness: number;
  terraceHeightScale: number;
  terraceSlope: number;
}

export interface BiomeNoiseAdapter {
  simplexFbm2D(
    x: number,
    y: number,
    octaves: number,
    amplitude: number,
    frequency: number,
    gain: number,
    lacunarity: number,
    offset: number,
  ): number;
}

export interface BiomeNoiseSet {
  main: BiomeNoiseAdapter;
  variation: BiomeNoiseAdapter;
  erosion: BiomeNoiseAdapter;
}

// ---------------------------------------------------------------------------
// Global terrain shaping constants
// ---------------------------------------------------------------------------

export const TERRAIN_SCALE = 32;
export const BASE_OFFSET = 22;
export const FEATURE_SCALE = 1.4;

const NOISE_COORD_SCALE = 55 / 2450;
const compactIslandLandform = createCompactIslandLandform();

// ---------------------------------------------------------------------------
// Per-biome config defaults
// ---------------------------------------------------------------------------

export const FOREST_CONFIG: BiomeTerrainConfig = {
  seedOffset: 0,
  frequency: 0.07,
  amplitude: 0.5,
  octaves: 10,
  gain: 0.5,
  lacunarity: 2.0,
  noiseOffset: 0.25,
  altitude: 0.1,
  altitudeVariation: 1.4,
  erosion: 0.6,
  erosionSoftness: 0.3,
  rivers: 0.11,
  riverWidth: 0,
  lakes: 0.34,
  lakesFalloff: 0.27,
  heightScale: 2.8,
  powerCurve: 1.0,
  smoothLowerPlanes: 0,
  canyonMode: false,
  canyonFreqScale: 0.3,
  canyonAmpScale: 1.5,
  cliffLow: 0.5,
  cliffHigh: 0.8,
  terraceSteps: 10,
  terraceStrength: 0,
  terraceSharpness: 0,
  terraceHeightScale: 1,
  terraceSlope: 0,
};

export const TUNDRA_CONFIG: BiomeTerrainConfig = {
  seedOffset: 100,
  frequency: 0.07,
  amplitude: 0.5,
  octaves: 10,
  gain: 0.5,
  lacunarity: 2.0,
  noiseOffset: 0.25,
  altitude: 0.1,
  altitudeVariation: 1.4,
  erosion: 0.6,
  erosionSoftness: 0.3,
  rivers: 0,
  riverWidth: 0,
  lakes: 0,
  lakesFalloff: 0,
  heightScale: 2.8,
  powerCurve: 1.0,
  smoothLowerPlanes: 0,
  canyonMode: false,
  canyonFreqScale: 0.3,
  canyonAmpScale: 1.5,
  cliffLow: 0.5,
  cliffHigh: 0.8,
  terraceSteps: 10,
  terraceStrength: 0,
  terraceSharpness: 0,
  terraceHeightScale: 1,
  terraceSlope: 0,
};

export const CANYON_CONFIG: BiomeTerrainConfig = {
  seedOffset: 200,
  frequency: 0.07,
  amplitude: 0.5,
  octaves: 10,
  gain: 0.5,
  lacunarity: 2.0,
  noiseOffset: 0.25,
  altitude: 0.0,
  altitudeVariation: 0.8,
  erosion: 0.0,
  erosionSoftness: 0.3,
  rivers: 0,
  riverWidth: 0,
  lakes: 0,
  lakesFalloff: 0,
  heightScale: 2.8,
  powerCurve: 1.0,
  smoothLowerPlanes: 0,
  canyonMode: true,
  canyonFreqScale: 0.3,
  canyonAmpScale: 1.5,
  cliffLow: 0.5,
  cliffHigh: 0.8,
  terraceSteps: 10,
  terraceStrength: 0,
  terraceSharpness: 0,
  terraceHeightScale: 1,
  terraceSlope: 0,
};

export const BIOME_CONFIGS: Record<string, BiomeTerrainConfig> = {
  [BiomeType.Tundra]: TUNDRA_CONFIG,
  [BiomeType.Forest]: FOREST_CONFIG,
  [BiomeType.Canyon]: CANYON_CONFIG,
};

// ---------------------------------------------------------------------------
// Island configuration
// ---------------------------------------------------------------------------

export const ISLAND_RADIUS = 2419;
export const ISLAND_FALLOFF = 450;
export const ISLAND_DEEP_OCEAN_BUFFER = 113;
export const OCEAN_FLOOR_HEIGHT = 2.5;
export const BEACH_PROFILE_POWER = 3.0;

// ---------------------------------------------------------------------------
// Biome configuration — single source of truth for biome placement & blending
// ---------------------------------------------------------------------------

export const BIOME_CONFIG = {
  gaussianCoeff: 12.0,
  boundaryNoiseScale: 0.003,
  boundaryNoiseAmount: 0.15,
  placementRadius: ISLAND_RADIUS * 0.45,
  influenceRadius: ISLAND_RADIUS * 0.6,
} as const;

// ---------------------------------------------------------------------------
// Landscape features — positioned lakes, independent of biomes
// ---------------------------------------------------------------------------

export enum LandscapeType {
  Lake = "lake",
}

export interface LandscapeFeatureDef {
  type: LandscapeType;
  x: number;
  z: number;
  radius: number;
  strength: number;
  shapePower: number;
  noiseScale: number;
  noiseAmount: number;
  lakes: number;
  lakesFalloff: number;
}

export const LANDSCAPE_FEATURES: LandscapeFeatureDef[] = [];

// ---------------------------------------------------------------------------
// Coastline noise — varies the island radius for irregular shoreline
// ---------------------------------------------------------------------------

export const COASTLINE_CIRCLE_SAMPLE_RADIUS = 2;

export const COAST_LARGE = {
  octaves: 3,
  persistence: 0.5,
  lacunarity: 2.0,
  weight: 0.2,
};

export const COAST_MEDIUM = {
  freqMultiplier: 3,
  octaves: 2,
  persistence: 0.5,
  lacunarity: 2.0,
  weight: 0.08,
};

export const COAST_SMALL = {
  freqMultiplier: 8,
  weight: 0.02,
};

// ---------------------------------------------------------------------------
// Legacy exports — kept for backward compatibility with TerrainWorker.ts
// ---------------------------------------------------------------------------

// Legacy lake/pond constants removed — terrain is fully procedural.

// ═══════════════════════════════════════════════════════════════════════════
// SINGLE SOURCE OF TRUTH — pure TypeScript functions
//
// computeBaseHeight()  →  called directly by TerrainSystem (main thread)
// applyLandscapeFeaturesPure() → called by computeBaseHeight
//
// The buildXxxJS() functions below are worker-embeddable MIRRORS of the
// same logic. They MUST stay in sync — edit both together.
// ═══════════════════════════════════════════════════════════════════════════

export interface TerrainNoiseAdapter {
  fractal2D(
    x: number,
    z: number,
    octaves: number,
    persistence: number,
    lacunarity: number,
  ): number;
  ridgeNoise2D(x: number, z: number): number;
  erosionNoise2D(x: number, z: number, iterations: number): number;
  simplex2D(x: number, z: number): number;
}

// ---------------------------------------------------------------------------
// Per-biome height functions — normal mode (reference defaultTerrain)
// ---------------------------------------------------------------------------

function computeNormalHeight(
  x: number,
  z: number,
  cfg: BiomeTerrainConfig,
  ns: BiomeNoiseSet,
  coordScale: number,
): { y: number; water: number } {
  const { main, variation, erosion } = ns;
  const nx = x * coordScale;
  const nz = z * coordScale;

  let terrainNoise = main.simplexFbm2D(
    nx,
    nz,
    cfg.octaves,
    cfg.amplitude,
    cfg.frequency,
    cfg.gain,
    cfg.lacunarity,
    cfg.noiseOffset,
  );

  const erosionVariation =
    variation.simplexFbm2D(nx + 500, nz + 500, 1, 1.0, 0.012, 0.5, 2.0, 0) *
      0.6 -
    0.1;
  const erosionSoft = erosionVariation + cfg.erosionSoftness;
  let ero = erosion.simplexFbm2D(nx, nz, 3, 0.2, cfg.frequency, 0.5, 1.8, 0.3);
  ero = smoothstep(ero, 0, 1);
  ero = Math.pow(ero, 1 + erosionSoft);
  ero = Math.max(0, pingpong(ero * 2, 1) - 0.3);
  terrainNoise *= 1 - cfg.erosion + cfg.erosion * ero;

  const altitudeNoise =
    variation.simplexFbm2D(nx, nz, 1, 1.0, 0.012, 0.5, 2.0, 0) *
      cfg.altitudeVariation -
    0.75;
  terrainNoise += cfg.altitude + altitudeNoise;

  const water =
    mapRangeSmooth(
      terrainNoise,
      -(1 - cfg.lakes),
      -(1 - cfg.lakes) + cfg.lakesFalloff,
      3,
      0,
    ) * 0.2;

  terrainNoise =
    terrainNoise * terrainNoise * (1 - cfg.smoothLowerPlanes) +
    terrainNoise * terrainNoise * terrainNoise * cfg.smoothLowerPlanes;

  const y =
    terrainNoise * (1 - Math.max(0, Math.min(1, water * cfg.rivers * 3))) +
    -3 * Math.max(0, Math.min(1, water * cfg.rivers * 3));

  return { y, water };
}

// ---------------------------------------------------------------------------
// Per-biome height: canyon mode (reference desertTerrain)
// ---------------------------------------------------------------------------

function computeCanyonHeight(
  x: number,
  z: number,
  cfg: BiomeTerrainConfig,
  ns: BiomeNoiseSet,
  coordScale: number,
): { y: number; water: number } {
  const { main } = ns;
  const nx = x * coordScale;
  const nz = z * coordScale;

  const canyonFbm = main.simplexFbm2D(
    nx,
    nz,
    cfg.octaves,
    cfg.amplitude * cfg.canyonAmpScale,
    cfg.frequency * cfg.canyonFreqScale,
    cfg.gain,
    cfg.lacunarity,
    cfg.noiseOffset,
  );
  const terrainNoise = normalizeFbmRange(Math.abs(canyonFbm - cfg.noiseOffset));

  const cliffs = mapRangeSmooth(
    terrainNoise,
    cfg.cliffLow,
    cfg.cliffHigh,
    0,
    1,
  );

  return { y: cliffs, water: 0 };
}

// ---------------------------------------------------------------------------
// Per-biome height dispatcher + power curve
// ---------------------------------------------------------------------------

function computeBiomeHeight(
  x: number,
  z: number,
  cfg: BiomeTerrainConfig,
  ns: BiomeNoiseSet,
  coordScale: number,
): { y: number; water: number } {
  const raw = cfg.canyonMode
    ? computeCanyonHeight(x, z, cfg, ns, coordScale)
    : computeNormalHeight(x, z, cfg, ns, coordScale);

  let y = raw.y * cfg.heightScale;

  if (cfg.powerCurve !== 1.0) {
    y = Math.sign(y) * Math.pow(Math.abs(y), cfg.powerCurve);
  }

  return { y, water: raw.water };
}

// ---------------------------------------------------------------------------
// Main: computeBaseHeight — blends independent per-biome heights
// ---------------------------------------------------------------------------

/**
 * THE height generation algorithm. Main thread calls this directly.
 * Workers use the JS-string mirror (buildGetBaseHeightAtJS) which
 * must produce identical results — keep them in sync.
 */
export function computeBaseHeight(
  worldX: number,
  worldZ: number,
  sharedNoise: TerrainNoiseAdapter,
  biomeNoiseSets: Record<string, BiomeNoiseSet>,
  biomeWeights: Record<string, number>,
  profile: WorldTerrainProfile,
): number {
  // ── 1. Blend per-biome heights ──────────────────────────────────────
  if (
    profile.algorithm === "compact-island-sculpt-v1" ||
    profile.algorithm === "compact-island-sculpt-v2" ||
    profile.algorithm === "compact-island-sculpt-v3" ||
    profile.algorithm === "compact-island-sculpt-v4" ||
    profile.algorithm === "compact-island-sculpt-v5"
  ) {
    return compactIslandLandform.height(worldX, worldZ, sharedNoise, profile);
  }
  const coordScale = NOISE_COORD_SCALE * profile.height.featureScale;
  let height = 0;
  for (const key of Object.keys(biomeWeights)) {
    const w = biomeWeights[key];
    if (w < 0.01) continue;
    const biomeCfg = BIOME_CONFIGS[key] ?? BIOME_CONFIGS[DEFAULT_BIOME];
    const ns = biomeNoiseSets[key];
    if (!ns) continue;
    const result = computeBiomeHeight(worldX, worldZ, biomeCfg, ns, coordScale);
    height += result.y * w;
  }

  const islandMask = computeIslandMask(worldX, worldZ, sharedNoise, profile);
  height *= islandMask;
  height *= profile.height.terrainScale;
  height += profile.height.baseOffset * islandMask;
  return islandMask === 0 ? profile.water.oceanFloorHeight : height;
}

/** The same mask used by the height field and ocean/water classification. */
export function computeIslandMask(
  worldX: number,
  worldZ: number,
  sharedNoise: TerrainNoiseAdapter,
  profile: WorldTerrainProfile,
): number {
  if (
    profile.algorithm === "compact-island-sculpt-v1" ||
    profile.algorithm === "compact-island-sculpt-v2" ||
    profile.algorithm === "compact-island-sculpt-v3" ||
    profile.algorithm === "compact-island-sculpt-v4" ||
    profile.algorithm === "compact-island-sculpt-v5"
  ) {
    return compactIslandLandform.mask(worldX, worldZ, sharedNoise, profile);
  }
  const island = profile.island;
  const x = worldX - island.centerX;
  const z = worldZ - island.centerZ;
  const distFromCenter = Math.sqrt(x * x + z * z);
  const angle = Math.atan2(z, x);
  const cnx = Math.cos(angle) * COASTLINE_CIRCLE_SAMPLE_RADIUS;
  const cnz = Math.sin(angle) * COASTLINE_CIRCLE_SAMPLE_RADIUS;

  const cst1 = sharedNoise.fractal2D(
    cnx,
    cnz,
    COAST_LARGE.octaves,
    COAST_LARGE.persistence,
    COAST_LARGE.lacunarity,
  );
  const cst2 = sharedNoise.fractal2D(
    cnx * COAST_MEDIUM.freqMultiplier,
    cnz * COAST_MEDIUM.freqMultiplier,
    COAST_MEDIUM.octaves,
    COAST_MEDIUM.persistence,
    COAST_MEDIUM.lacunarity,
  );
  const cst3 = sharedNoise.simplex2D(
    cnx * COAST_SMALL.freqMultiplier,
    cnz * COAST_SMALL.freqMultiplier,
  );
  const coastVar = Math.max(
    -island.maxCoastVariation,
    Math.min(
      island.maxCoastVariation,
      cst1 * COAST_LARGE.weight +
        cst2 * COAST_MEDIUM.weight +
        cst3 * COAST_SMALL.weight,
    ),
  );
  const effectiveRadius = island.radius * (1 + coastVar);

  let islandMask = 1.0;
  if (distFromCenter > effectiveRadius - island.falloff) {
    const edgeDist = distFromCenter - (effectiveRadius - island.falloff);
    const t = Math.min(1.0, edgeDist / island.falloff);
    islandMask = 1.0 - Math.pow(t, island.beachProfilePower);
  }
  if (distFromCenter > effectiveRadius + island.deepOceanBuffer) {
    islandMask = 0;
  }

  return islandMask;
}

export interface ShorelineConfig {
  waterThreshold: number;
  shorelineLandBand: number;
  shorelineUnderwaterBand: number;
  shorelineMinSlope: number;
  shorelineLandMaxMultiplier: number;
  underwaterDepthMultiplier: number;
}

/**
 * Adjust height near shoreline to prevent flat beach zones.
 * Both main thread and workers use the same algorithm.
 */
export function adjustShorelineHeight(
  baseHeight: number,
  slope: number,
  config: ShorelineConfig,
): number {
  if (baseHeight === config.waterThreshold) return baseHeight;

  const isLand = baseHeight > config.waterThreshold;
  const band = isLand
    ? config.shorelineLandBand
    : config.shorelineUnderwaterBand;
  if (band <= 0) return baseHeight;

  const delta = Math.abs(baseHeight - config.waterThreshold);
  if (delta >= band) return baseHeight;

  if (config.shorelineMinSlope <= 0) return baseHeight;

  const maxMul = isLand
    ? config.shorelineLandMaxMultiplier
    : config.underwaterDepthMultiplier;
  if (maxMul <= 1) return baseHeight;

  const slopeSafe = Math.max(0.0001, slope);
  const targetMul = Math.min(
    maxMul,
    Math.max(1, config.shorelineMinSlope / slopeSafe),
  );
  const falloff = 1 - delta / band;
  const mul = 1 + (targetMul - 1) * falloff;
  const adjustedDelta = delta * mul;

  return isLand
    ? config.waterThreshold + adjustedDelta
    : config.waterThreshold - adjustedDelta;
}

// ═══════════════════════════════════════════════════════════════════════════
// Worker JS string mirrors — MUST match the pure functions above.
// Workers can't import TS modules, so we generate equivalent JS strings
// with constants baked in. Keep these in lock-step with the TS functions.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * JS source for position-only biome weight computation.
 * Worker mirror — depends on: noise, biomeCenters,
 * BIOME_BOUNDARY_NOISE_SCALE, BIOME_BOUNDARY_NOISE_AMOUNT, BIOME_GAUSSIAN_COEFF.
 */
export function buildComputeBiomeWeightsJS(): string {
  return `
  function computeBiomeWeightsByPosition(worldX, worldZ) {
    var boundaryNoise = noise.simplex2D(
      worldX * BIOME_BOUNDARY_NOISE_SCALE,
      worldZ * BIOME_BOUNDARY_NOISE_SCALE
    );
    var weights = {};
    var totalWeight = 0;
    for (var i = 0; i < biomeCenters.length; i++) {
      var center = biomeCenters[i];
      var dx = worldX - center.x;
      var dz = worldZ - center.z;
      var dist = Math.sqrt(dx * dx + dz * dz);
      var noisyDist = dist * (1 + boundaryNoise * BIOME_BOUNDARY_NOISE_AMOUNT);
      var normDist = noisyDist / center.influence;
      var w = Math.exp(-normDist * normDist * BIOME_GAUSSIAN_COEFF);
      var type = center.type;
      weights[type] = (weights[type] || 0) + w;
      totalWeight += w;
    }
    if (totalWeight > 0) {
      for (var key in weights) { weights[key] /= totalWeight; }
    } else {
      weights[BT_DEFAULT] = 1.0;
    }
    return weights;
  }`;
}

/**
 * Bake BiomeTerrainConfig per-biome into worker JS.
 */
function biomeConfigToJS(name: string, cfg: BiomeTerrainConfig): string {
  return `BIOME_CONFIGS[${name}] = {
    seedOffset:${cfg.seedOffset}, frequency:${cfg.frequency}, amplitude:${cfg.amplitude},
    octaves:${cfg.octaves}, gain:${cfg.gain}, lacunarity:${cfg.lacunarity}, noiseOffset:${cfg.noiseOffset},
    altitude:${cfg.altitude}, altitudeVariation:${cfg.altitudeVariation},
    erosion:${cfg.erosion}, erosionSoftness:${cfg.erosionSoftness},
    rivers:${cfg.rivers}, riverWidth:${cfg.riverWidth}, lakes:${cfg.lakes}, lakesFalloff:${cfg.lakesFalloff},
    heightScale:${cfg.heightScale}, powerCurve:${cfg.powerCurve}, smoothLowerPlanes:${cfg.smoothLowerPlanes},
    canyonMode:${cfg.canyonMode}, canyonFreqScale:${cfg.canyonFreqScale}, canyonAmpScale:${cfg.canyonAmpScale},
    cliffLow:${cfg.cliffLow}, cliffHigh:${cfg.cliffHigh},
    terraceSteps:${cfg.terraceSteps}, terraceStrength:${cfg.terraceStrength},
    terraceSharpness:${cfg.terraceSharpness}, terraceHeightScale:${cfg.terraceHeightScale}, terraceSlope:${cfg.terraceSlope}
  };`;
}

const BIOME_CONFIGS_JS = `
  var BIOME_CONFIGS = {};
  ${biomeConfigToJS("BT_TUNDRA", TUNDRA_CONFIG)}
  ${biomeConfigToJS("BT_FOREST", FOREST_CONFIG)}
  ${biomeConfigToJS("BT_CANYON", CANYON_CONFIG)}
`;

/**
 * JS source — worker mirror of computeBaseHeight() and per-biome height functions.
 * MUST stay in sync with the TS functions above.
 *
 * Expects in worker scope: config.TERRAIN_PROFILE, noise, biomeNoiseSets,
 * BT_DEFAULT and computeBiomeWeightsByPosition.
 */
export function buildGetBaseHeightAtJS(): string {
  return `
  ${BIOME_CONFIGS_JS}
  var compactIslandLandform = ${buildCompactIslandLandformJS()};

  var NOISE_COORD_SCALE = ${NOISE_COORD_SCALE};
  var TERRAIN_SCALE_VAL = config.TERRAIN_PROFILE.height.terrainScale;
  var BASE_OFFSET_VAL = config.TERRAIN_PROFILE.height.baseOffset;
  var FEATURE_SCALE_VAL = config.TERRAIN_PROFILE.height.featureScale;

  function _smoothstep(x, edge0, edge1) {
    var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }
  function _mapRangeSmooth(val, a1, a2, b1, b2) {
    return b1 + _smoothstep(val, a1, a2) * (b2 - b1);
  }
  function _normalizeFbmRange(fbmNoise) {
    return Math.min(1, Math.max(0, (fbmNoise + 0.4) / 1.3));
  }
  function _pingpong(x, length) {
    var t = x % (length * 2);
    return length - Math.abs(t - length);
  }

  function computeNormalHeight(x, z, cfg, ns, coordScale) {
    var nx = x * coordScale;
    var nz = z * coordScale;
    var terrainNoise = ns.main.simplexFbm2D(nx, nz, cfg.octaves, cfg.amplitude, cfg.frequency, cfg.gain, cfg.lacunarity, cfg.noiseOffset);

    var erosionVariation = ns.variation.simplexFbm2D(nx + 500, nz + 500, 1, 1.0, 0.012, 0.5, 2.0, 0) * 0.6 - 0.1;
    var erosionSoft = erosionVariation + cfg.erosionSoftness;
    var ero = ns.erosion.simplexFbm2D(nx, nz, 3, 0.2, cfg.frequency, 0.5, 1.8, 0.3);
    ero = _smoothstep(ero, 0, 1);
    ero = Math.pow(ero, 1 + erosionSoft);
    ero = Math.max(0, _pingpong(ero * 2, 1) - 0.3);
    terrainNoise *= (1 - cfg.erosion) + cfg.erosion * ero;

    var altitudeNoise = ns.variation.simplexFbm2D(nx, nz, 1, 1.0, 0.012, 0.5, 2.0, 0) * cfg.altitudeVariation - 0.75;
    terrainNoise += cfg.altitude + altitudeNoise;

    var water = _mapRangeSmooth(terrainNoise, -(1 - cfg.lakes), -(1 - cfg.lakes) + cfg.lakesFalloff, 3, 0) * 0.2;
    terrainNoise = terrainNoise * terrainNoise * (1 - cfg.smoothLowerPlanes) + terrainNoise * terrainNoise * terrainNoise * cfg.smoothLowerPlanes;
    var y = terrainNoise * (1 - Math.max(0, Math.min(1, water * cfg.rivers * 3))) + (-3) * Math.max(0, Math.min(1, water * cfg.rivers * 3));
    return { y: y, water: water };
  }

  function computeCanyonHeight(x, z, cfg, ns, coordScale) {
    var nx = x * coordScale;
    var nz = z * coordScale;
    var canyonFbm = ns.main.simplexFbm2D(nx, nz, cfg.octaves, cfg.amplitude * cfg.canyonAmpScale, cfg.frequency * cfg.canyonFreqScale, cfg.gain, cfg.lacunarity, cfg.noiseOffset);
    var terrainNoise = _normalizeFbmRange(Math.abs(canyonFbm - cfg.noiseOffset));
    var cliffs = _mapRangeSmooth(terrainNoise, cfg.cliffLow, cfg.cliffHigh, 0, 1);
    return { y: cliffs, water: 0 };
  }

  function computeBiomeHeight(x, z, cfg, ns, coordScale) {
    var raw = cfg.canyonMode ? computeCanyonHeight(x, z, cfg, ns, coordScale) : computeNormalHeight(x, z, cfg, ns, coordScale);
    var y = raw.y * cfg.heightScale;
    if (cfg.powerCurve !== 1.0) {
      y = (y >= 0 ? 1 : -1) * Math.pow(Math.abs(y), cfg.powerCurve);
    }
    return { y: y, water: raw.water };
  }

  function getBaseHeightAt(worldX, worldZ, biomeWeights) {
    if (config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v1" || (config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v2" || config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v3" || (config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v4" || config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v5"))) {
      return compactIslandLandform.height(worldX, worldZ, noise, config.TERRAIN_PROFILE);
    }
    var bw = biomeWeights || computeBiomeWeightsByPosition(worldX, worldZ);
    var coordScale = NOISE_COORD_SCALE * FEATURE_SCALE_VAL;
    var height = 0;
    for (var key in bw) {
      var w = bw[key];
      if (w < 0.01) continue;
      var biomeCfg = BIOME_CONFIGS[key] || BIOME_CONFIGS[BT_DEFAULT];
      var ns = biomeNoiseSets[key];
      if (!ns) continue;
      var result = computeBiomeHeight(worldX, worldZ, biomeCfg, ns, coordScale);
      height += result.y * w;
    }

    var islandMask = getIslandMask(worldX, worldZ);
    height *= islandMask;
    height *= TERRAIN_SCALE_VAL;
    height += BASE_OFFSET_VAL * islandMask;
    if (islandMask === 0) { height = config.TERRAIN_PROFILE.water.oceanFloorHeight; }
    return height;
  }

  function getIslandMask(worldX, worldZ) {
    if (config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v1" || (config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v2" || config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v3" || (config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v4" || config.TERRAIN_PROFILE.algorithm === "compact-island-sculpt-v5"))) {
      return compactIslandLandform.mask(worldX, worldZ, noise, config.TERRAIN_PROFILE);
    }
    var island = config.TERRAIN_PROFILE.island;
    var x = worldX - island.centerX;
    var z = worldZ - island.centerZ;
    var distFromCenter = Math.sqrt(x * x + z * z);
    var angle = Math.atan2(z, x);
    var cnx = Math.cos(angle) * ${COASTLINE_CIRCLE_SAMPLE_RADIUS};
    var cnz = Math.sin(angle) * ${COASTLINE_CIRCLE_SAMPLE_RADIUS};
    var cst1 = noise.fractal2D(cnx, cnz, ${COAST_LARGE.octaves}, ${COAST_LARGE.persistence}, ${COAST_LARGE.lacunarity});
    var cst2 = noise.fractal2D(cnx * ${COAST_MEDIUM.freqMultiplier}, cnz * ${COAST_MEDIUM.freqMultiplier}, ${COAST_MEDIUM.octaves}, ${COAST_MEDIUM.persistence}, ${COAST_MEDIUM.lacunarity});
    var cst3 = noise.simplex2D(cnx * ${COAST_SMALL.freqMultiplier}, cnz * ${COAST_SMALL.freqMultiplier});
    var coastVar = Math.max(-island.maxCoastVariation, Math.min(island.maxCoastVariation, cst1 * ${COAST_LARGE.weight} + cst2 * ${COAST_MEDIUM.weight} + cst3 * ${COAST_SMALL.weight}));
    var effectiveRadius = island.radius * (1 + coastVar);

    var islandMask = 1.0;
    if (distFromCenter > effectiveRadius - island.falloff) {
      var edgeDist = distFromCenter - (effectiveRadius - island.falloff);
      var t = Math.min(1.0, edgeDist / island.falloff);
      islandMask = 1.0 - Math.pow(t, island.beachProfilePower);
    }
    if (distFromCenter > effectiveRadius + island.deepOceanBuffer) {
      islandMask = 0;
    }

    return islandMask;
  }`;
}
