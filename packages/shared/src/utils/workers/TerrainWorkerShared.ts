import { BIOME_CONFIG } from "../../systems/shared/world/TerrainHeightParams";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  resolveWorldTerrainProfile,
  worldTerrainProfileIdentity,
  type WorldTerrainProfile,
} from "../../systems/shared/world/WorldTerrainProfile";
import type { TerrainWorkerConfig } from "./TerrainWorker";

/** One immutable config for tile, quad and grass workers. No environment defaults. */
export function createTerrainWorkerConfig(
  input: WorldTerrainProfile,
  tileResolution: number,
): TerrainWorkerConfig {
  const profile = resolveWorldTerrainProfile(input);
  if (
    !Number.isSafeInteger(tileResolution) ||
    tileResolution < 2 ||
    tileResolution > 1024
  )
    throw new Error("Terrain worker resolution must be 2..1024");
  return Object.freeze({
    TERRAIN_PROFILE: profile,
    TERRAIN_PROFILE_IDENTITY: worldTerrainProfileIdentity(profile),
    TILE_SIZE: profile.terrainTileSize,
    TILE_RESOLUTION: tileResolution,
    MAX_HEIGHT: profile.height.maxHeightParameter,
    BIOME_GAUSSIAN_COEFF: BIOME_CONFIG.gaussianCoeff,
    BIOME_BOUNDARY_NOISE_SCALE: BIOME_CONFIG.boundaryNoiseScale,
    BIOME_BOUNDARY_NOISE_AMOUNT: BIOME_CONFIG.boundaryNoiseAmount,
    WATER_THRESHOLD: profile.water.threshold,
    WATER_LEVEL_NORMALIZED:
      profile.water.threshold / profile.height.maxHeightParameter,
    SHORELINE_THRESHOLD: profile.shoreline.THRESHOLD,
    SHORELINE_STRENGTH: profile.shoreline.STRENGTH,
    SHORELINE_MIN_SLOPE: profile.shoreline.MIN_SLOPE,
    SHORELINE_SLOPE_SAMPLE_DISTANCE: profile.shoreline.SLOPE_SAMPLE_DISTANCE,
    SHORELINE_LAND_BAND: profile.shoreline.LAND_BAND,
    SHORELINE_LAND_MAX_MULTIPLIER: profile.shoreline.LAND_MAX_MULTIPLIER,
    SHORELINE_UNDERWATER_BAND: profile.shoreline.UNDERWATER_BAND,
    UNDERWATER_DEPTH_MULTIPLIER: profile.shoreline.UNDERWATER_DEPTH_MULTIPLIER,
  });
}

export function assertTerrainWorkerRequest(
  config: TerrainWorkerConfig,
  seed: number,
): void {
  const expected = createTerrainWorkerConfig(
    config.TERRAIN_PROFILE,
    config.TILE_RESOLUTION,
  );
  if (
    seed !== expected.TERRAIN_PROFILE.seed ||
    config.TERRAIN_PROFILE_IDENTITY !== expected.TERRAIN_PROFILE_IDENTITY
  )
    throw new Error("Terrain worker profile identity or seed mismatch");
  for (const key of Object.keys(expected) as Array<keyof TerrainWorkerConfig>) {
    if (key !== "TERRAIN_PROFILE" && config[key] !== expected[key])
      throw new Error(`Terrain worker derived config mismatch: ${key}`);
  }
}

export function assertTerrainWorkerResult(
  result: { terrainProfileIdentity: string },
  config: TerrainWorkerConfig,
): void {
  if (result.terrainProfileIdentity !== config.TERRAIN_PROFILE_IDENTITY)
    throw new Error("Terrain worker result profile identity mismatch");
}

/** Guard executes inside the actual module-load-built worker source, per request. */
export function buildTerrainWorkerProfileGuardJS(): string {
  const shape = COMPACT_WORLD_TERRAIN_PROFILE;
  const groups = ["bounds", "island", "height", "water", "shoreline"] as const;
  return `
function assertTerrainWorkerInput(input) {
  var config = input.config;
  var p = config && config.TERRAIN_PROFILE;
  function fail() { throw new Error("Terrain worker invalid profile/config identity"); }
  function keys(value, expected) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    var actual = Object.keys(value);
    if (actual.length !== expected.length || actual.some(k => !expected.includes(k))) fail();
  }
  keys(p, ${JSON.stringify(Object.keys(shape))});
  ${groups
    .map(
      (
        group,
      ) => `keys(p.${group}, ${JSON.stringify(Object.keys(shape[group]))});
  if (!Object.values(p.${group}).every(Number.isFinite)) fail();`,
    )
    .join("\n")}
  if (p.schemaVersion !== 1 || (p.algorithm !== "terrain-height-params-v1" && p.algorithm !== "compact-island-sculpt-v1") ||
      p.boundsMeaning !== "nominal-generation-envelope" || typeof p.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(p.id) ||
      p.kind !== "compact-candidate" || p.id === "large-world-v1" ||
      !Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff || input.seed !== p.seed) fail();
  var b = p.bounds, i = p.island, h = p.height, w = p.water, s = p.shoreline;
  if (!Number.isFinite(p.terrainTileSize) || p.terrainTileSize <= 0 ||
      b.minX >= b.maxX || b.minZ >= b.maxZ ||
      !Number.isSafeInteger((b.maxX-b.minX)/p.terrainTileSize) ||
      !Number.isSafeInteger((b.maxZ-b.minZ)/p.terrainTileSize) ||
      i.radius <= 0 || i.falloff <= 0 || i.falloff > i.radius || i.deepOceanBuffer < 0 ||
      i.beachProfilePower <= 0 || i.maxCoastVariation < 0 || i.maxCoastVariation >= 1) fail();
  var extent = i.radius * (1+i.maxCoastVariation) + i.deepOceanBuffer;
  if (!Number.isFinite(extent) || i.centerX-extent < b.minX || i.centerX+extent > b.maxX ||
      i.centerZ-extent < b.minZ || i.centerZ+extent > b.maxZ ||
      h.maxHeightParameter <= 0 || h.terrainScale <= 0 || h.featureScale <= 0 ||
      w.threshold <= w.oceanFloorHeight || w.threshold >= h.maxHeightParameter ||
      s.THRESHOLD < 0 || s.THRESHOLD > 1 || s.STRENGTH < 0 || s.STRENGTH > 1 ||
      s.MIN_SLOPE < 0 || s.SLOPE_SAMPLE_DISTANCE <= 0 || s.LAND_BAND <= 0 ||
      s.LAND_MAX_MULTIPLIER <= 0 || s.UNDERWATER_BAND <= 0 || s.UNDERWATER_DEPTH_MULTIPLIER <= 0) fail();
  var identity = "hyperia-world-terrain-profile-v1\\n" + JSON.stringify(p);
  if (identity !== config.TERRAIN_PROFILE_IDENTITY) fail();
  if (!Number.isSafeInteger(config.TILE_RESOLUTION) || config.TILE_RESOLUTION < 2 || config.TILE_RESOLUTION > 1024) fail();
  var derived = {
    TILE_SIZE:p.terrainTileSize, MAX_HEIGHT:h.maxHeightParameter,
    WATER_THRESHOLD:w.threshold, WATER_LEVEL_NORMALIZED:w.threshold/h.maxHeightParameter,
    BIOME_GAUSSIAN_COEFF:${BIOME_CONFIG.gaussianCoeff},
    BIOME_BOUNDARY_NOISE_SCALE:${BIOME_CONFIG.boundaryNoiseScale},
    BIOME_BOUNDARY_NOISE_AMOUNT:${BIOME_CONFIG.boundaryNoiseAmount},
    SHORELINE_THRESHOLD:s.THRESHOLD, SHORELINE_STRENGTH:s.STRENGTH,
    SHORELINE_MIN_SLOPE:s.MIN_SLOPE, SHORELINE_SLOPE_SAMPLE_DISTANCE:s.SLOPE_SAMPLE_DISTANCE,
    SHORELINE_LAND_BAND:s.LAND_BAND, SHORELINE_LAND_MAX_MULTIPLIER:s.LAND_MAX_MULTIPLIER,
    SHORELINE_UNDERWATER_BAND:s.UNDERWATER_BAND, UNDERWATER_DEPTH_MULTIPLIER:s.UNDERWATER_DEPTH_MULTIPLIER
  };
  for (var key of Object.keys(derived)) if (config[key] !== derived[key]) fail();
  if (input.type === "generateGrassInstances" &&
      (input.waterThreshold !== w.threshold || input.tileSize !== p.terrainTileSize)) fail();
}`;
}

/**
 * TerrainWorkerShared — Single source of truth for inline worker JS code
 * shared between QuadChunkWorker, TerrainWorker and GrassWorker.
 *
 * Workers can't import TS modules, so we build JS strings that get injected
 * into the inline worker code. All three workers call these builders to get
 * identical copies of the shared logic.
 *
 * If you need to change noise generation, height helpers, biome influence
 * calculation, or shoreline adjustment — change it HERE once.
 */

/**
 * NoiseGenerator class — worker-side noise implementation.
 * Mirrors packages/shared/src/utils/NoiseGenerator.ts.
 */
export function buildNoiseGeneratorJS(): string {
  return `
class NoiseGenerator {
  constructor(seed = 12345) {
    this.permutation = [];
    this.p = [];
    this.initializePermutation(seed);
  }

  initializePermutation(seed) {
    const perm = Array.from({ length: 256 }, (_, i) => i);
    let random = seed;
    for (let i = perm.length - 1; i > 0; i--) {
      random = (random * 1664525 + 1013904223) % 4294967296;
      const j = Math.floor((random / 4294967296) * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    this.permutation = perm;
    this.p = [...perm, ...perm];
  }

  fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  lerp(t, a, b) { return a + t * (b - a); }
  grad2D(hash, x, y) {
    const h = hash & 3;
    const u = h < 2 ? x : y;
    const v = h < 2 ? y : x;
    return (h & 1 ? -u : u) + (h & 2 ? -v : v);
  }

  perlin2D(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = this.fade(x);
    const v = this.fade(y);
    const A = this.p[X] + Y;
    const AA = this.p[A];
    const AB = this.p[A + 1];
    const B = this.p[X + 1] + Y;
    const BA = this.p[B];
    const BB = this.p[B + 1];
    const result = this.lerp(v,
      this.lerp(u, this.grad2D(this.p[AA], x, y), this.grad2D(this.p[BA], x - 1, y)),
      this.lerp(u, this.grad2D(this.p[AB], x, y - 1), this.grad2D(this.p[BB], x - 1, y - 1))
    );
    return Math.max(-1, Math.min(1, result));
  }

  gradSimplex2D(hash, x, y) {
    const grad3 = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
    return grad3[hash % 12][0] * x + grad3[hash % 12][1] * y;
  }

  simplex2D(x, y) {
    const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
    const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = x - X0;
    const y0 = y - Y0;
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1.0 + 2.0 * G2;
    const y2 = y0 - 1.0 + 2.0 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const gi0 = this.p[ii + this.p[jj]] % 12;
    const gi1 = this.p[ii + i1 + this.p[jj + j1]] % 12;
    const gi2 = this.p[ii + 1 + this.p[jj + 1]] % 12;
    let n0, n1, n2;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 < 0) n0 = 0.0;
    else { t0 *= t0; n0 = t0 * t0 * this.gradSimplex2D(gi0, x0, y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 < 0) n1 = 0.0;
    else { t1 *= t1; n1 = t1 * t1 * this.gradSimplex2D(gi1, x1, y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 < 0) n2 = 0.0;
    else { t2 *= t2; n2 = t2 * t2 * this.gradSimplex2D(gi2, x2, y2); }
    return 70.0 * (n0 + n1 + n2);
  }

  ridgeNoise2D(x, y) {
    const perlinValue = this.perlin2D(x, y);
    return 1.0 - Math.abs(Math.max(-1, Math.min(1, perlinValue)));
  }

  fractal2D(x, y, octaves = 4, persistence = 0.5, lacunarity = 2.0) {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;
    for (let i = 0; i < octaves; i++) {
      value += this.perlin2D(x * frequency, y * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return value / maxValue;
  }

  erosionNoise2D(x, y, iterations = 3) {
    let height = this.fractal2D(x, y, 6);
    for (let i = 0; i < iterations; i++) {
      const delta = 0.01;
      const hC = this.perlin2D(x, y);
      const hX = this.perlin2D(x + delta, y);
      const hY = this.perlin2D(x, y + delta);
      const gradX = (hX - hC) / delta;
      const gradY = (hY - hC) / delta;
      const magnitude = Math.sqrt(gradX * gradX + gradY * gradY);
      const erosionFactor = Math.min(1.0, magnitude * 2.0);
      height *= 1.0 - erosionFactor * 0.1;
    }
    return height;
  }

  simplexFbm2D(x, y, octaves, amplitude, frequency, gain, lacunarity, offset) {
    var value = 0;
    var amp = amplitude;
    var fx = x * frequency;
    var fy = y * frequency;
    for (var i = 0; i < octaves; i++) {
      value += amp * this.simplex2D(fx, fy);
      fx *= lacunarity;
      fy *= lacunarity;
      amp *= gain;
    }
    return value + offset;
  }
}`;
}

/**
 * Height helper functions used by both workers.
 *
 * Expects these variables to already be in scope:
 *   - noise: NoiseGenerator
 *   - biomeCenters: array of biome center objects
 *   - MAX_HEIGHT: from config
 *   - WATER_THRESHOLD, SHORELINE_*: from config
 *   - getBaseHeightAt(): from buildGetBaseHeightAtJS()
 *   - computeBiomeWeightsByPosition(): from buildComputeBiomeWeightsJS()
 */
export function buildHeightHelpersJS(): string {
  return `
  function getHeightAtWithoutShore(worldX, worldZ) {
    var bw = computeBiomeWeightsByPosition(worldX, worldZ);
    return getBaseHeightAt(worldX, worldZ, bw);
  }

  function calculateBaseSlopeAt(worldX, worldZ, centerHeight) {
    const d = SHORELINE_SLOPE_SAMPLE_DISTANCE;
    const hN = getHeightAtWithoutShore(worldX, worldZ + d);
    const hS = getHeightAtWithoutShore(worldX, worldZ - d);
    const hE = getHeightAtWithoutShore(worldX + d, worldZ);
    const hW = getHeightAtWithoutShore(worldX - d, worldZ);
    return Math.max(
      Math.abs(hN - centerHeight) / d,
      Math.abs(hS - centerHeight) / d,
      Math.abs(hE - centerHeight) / d,
      Math.abs(hW - centerHeight) / d
    );
  }

  function adjustHeightForShoreline(baseHeight, slope) {
    if (baseHeight === WATER_THRESHOLD) return baseHeight;
    const isLand = baseHeight > WATER_THRESHOLD;
    const band = isLand ? SHORELINE_LAND_BAND : SHORELINE_UNDERWATER_BAND;
    if (band <= 0) return baseHeight;
    const delta = Math.abs(baseHeight - WATER_THRESHOLD);
    if (delta >= band) return baseHeight;
    if (SHORELINE_MIN_SLOPE <= 0) return baseHeight;
    const maxMul = isLand ? SHORELINE_LAND_MAX_MULTIPLIER : UNDERWATER_DEPTH_MULTIPLIER;
    if (maxMul <= 1) return baseHeight;
    const slopeSafe = Math.max(0.0001, slope);
    const targetMul = Math.min(maxMul, Math.max(1, SHORELINE_MIN_SLOPE / slopeSafe));
    const falloff = 1 - delta / band;
    const mul = 1 + (targetMul - 1) * falloff;
    const adjustedDelta = delta * mul;
    return isLand ? WATER_THRESHOLD + adjustedDelta : WATER_THRESHOLD - adjustedDelta;
  }

  function getHeightComputed(worldX, worldZ) {
    const h = getHeightAtWithoutShore(worldX, worldZ);
    if (h >= WATER_THRESHOLD + SHORELINE_LAND_BAND || h <= WATER_THRESHOLD - SHORELINE_UNDERWATER_BAND) {
      return h;
    }
    const slope = calculateBaseSlopeAt(worldX, worldZ, h);
    return adjustHeightForShoreline(h, slope);
  }`;
}

/**
 * Creates per-biome noise sets in the worker.
 * Expects: seed (number), BIOME_CONFIGS (object) to be in scope.
 */
export function buildCreateBiomeNoiseSetsJS(): string {
  return `
  function createBiomeNoiseSets(seed) {
    var sets = {};
    for (var key in BIOME_CONFIGS) {
      var cfg = BIOME_CONFIGS[key];
      var base = seed + cfg.seedOffset;
      sets[key] = {
        main: new NoiseGenerator(base),
        variation: new NoiseGenerator(base + 4),
        erosion: new NoiseGenerator(base + 1)
      };
    }
    return sets;
  }`;
}

/**
 * Biome influence function used by both workers.
 *
 * Expects these variables to already be in scope:
 *   - noise: NoiseGenerator
 *   - biomeCenters: array of biome center objects
 *   - BIOME_GAUSSIAN_COEFF, BIOME_BOUNDARY_NOISE_*: from config
 *   - BT_DEFAULT: from buildBiomeConstantsJS()
 */
export function buildBiomeInfluencesJS(): string {
  return `
  function getBiomeInfluences(worldX, worldZ, normalizedHeight) {
    if (!biomeCenters || biomeCenters.length === 0) {
      return [{ type: BT_DEFAULT, weight: 1.0 }];
    }
    const boundaryNoise = noise.simplex2D(
      worldX * BIOME_BOUNDARY_NOISE_SCALE,
      worldZ * BIOME_BOUNDARY_NOISE_SCALE
    );
    const biomeWeightMap = {};
    for (const center of biomeCenters) {
      const dx = worldX - center.x;
      const dz = worldZ - center.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const noisyDistance = distance * (1 + boundaryNoise * BIOME_BOUNDARY_NOISE_AMOUNT);
      const normalizedDistance = noisyDistance / center.influence;
      const weight = Math.exp(-normalizedDistance * normalizedDistance * BIOME_GAUSSIAN_COEFF);
      biomeWeightMap[center.type] = (biomeWeightMap[center.type] || 0) + weight;
    }
    const biomeInfluences = [];
    for (const type in biomeWeightMap) {
      biomeInfluences.push({ type, weight: biomeWeightMap[type] });
    }
    const totalWeight = biomeInfluences.reduce((sum, b) => sum + b.weight, 0);
    if (totalWeight > 0) {
      for (const inf of biomeInfluences) { inf.weight /= totalWeight; }
    } else {
      biomeInfluences.push({ type: BT_DEFAULT, weight: 1.0 });
    }
    biomeInfluences.sort((a, b) => b.weight - a.weight);
    return biomeInfluences.slice(0, 3);
  }`;
}
