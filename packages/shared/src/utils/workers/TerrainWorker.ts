/**
 * TerrainWorker - Offloads terrain heightmap generation to Web Worker
 *
 * Heavy terrain calculations (noise, biome blending) run in parallel,
 * freeing the main thread for rendering.
 *
 * Message Protocol:
 * - Input: { type: 'generateHeightmap', tileX, tileZ, config, seed }
 * - Output: { type: 'heightmapResult', tileKey, heightData, colorData, biomeData }
 */

import { WorkerPool } from "./WorkerPool";
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
import type { WorldTerrainProfile } from "../../systems/shared/world/WorldTerrainProfile";

// Types for terrain generation
// MUST match TerrainSystem.CONFIG exactly for height and biome calculation
export interface TerrainWorkerConfig {
  TERRAIN_PROFILE: WorldTerrainProfile;
  TERRAIN_PROFILE_IDENTITY: string;
  TILE_SIZE: number;
  TILE_RESOLUTION: number;
  MAX_HEIGHT: number;
  // Biome calculation - MUST match TerrainSystem.getBiomeInfluencesAtPosition()
  BIOME_GAUSSIAN_COEFF: number;
  BIOME_BOUNDARY_NOISE_SCALE: number;
  BIOME_BOUNDARY_NOISE_AMOUNT: number;
  // Shoreline config - MUST match TerrainSystem.getHeightAt() and createTileGeometry()
  WATER_THRESHOLD: number;
  WATER_LEVEL_NORMALIZED: number;
  SHORELINE_THRESHOLD: number;
  SHORELINE_STRENGTH: number;
  // Shoreline slope adjustment - MUST match TerrainSystem.adjustHeightForShoreline()
  SHORELINE_MIN_SLOPE: number;
  SHORELINE_SLOPE_SAMPLE_DISTANCE: number;
  SHORELINE_LAND_BAND: number;
  SHORELINE_LAND_MAX_MULTIPLIER: number;
  SHORELINE_UNDERWATER_BAND: number;
  UNDERWATER_DEPTH_MULTIPLIER: number;
}

export interface TerrainWorkerInput {
  type: "generateHeightmap";
  tileX: number;
  tileZ: number;
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
    {
      heightModifier: number;
      color: { r: number; g: number; b: number };
    }
  >;
}

export interface TerrainWorkerOutput {
  terrainProfileIdentity: string;
  type: "heightmapResult";
  tileKey: string;
  tileX: number;
  tileZ: number;
  /** Height values as Float32Array (resolution * resolution) — includes shoreline adjustment */
  heightData: Float32Array;
  /** RGB color values as Float32Array (resolution * resolution * 3) */
  colorData: Float32Array;
  /** Biome IDs as Uint8Array (resolution * resolution) */
  biomeData: Uint8Array;
  /** Per-vertex normals as Float32Array (resolution * resolution * 3) — computed from overflow grid */
  normalData: Float32Array;
  /** River proximity: 1.0 = in channel, smoothstep to 0.0 at bank edge */
  riverProximity: Float32Array;
}

/**
 * Inline worker code for terrain generation
 *
 * CRITICAL: This code MUST exactly match TerrainSystem height computation.
 * Includes: getBaseHeightAt, mountain boost, shoreline adjustment, overflow
 * grid normals. Heights and normals computed here are used directly on the
 * main thread for tiles without flat zones.
 *
 * Synced with: packages/shared/src/systems/shared/world/TerrainSystem.ts
 */
export const TERRAIN_WORKER_CODE = `
${buildNoiseGeneratorJS()}
${buildBiomeConstantsJS()}
${buildTerrainWorkerProfileGuardJS()}

var BIOME_IDS = {};
BIOME_IDS[BT_TUNDRA] = 0;
BIOME_IDS[BT_FOREST] = 1;
BIOME_IDS[BT_CANYON] = 2;

function generateHeightmap(input) {
  assertTerrainWorkerInput(input);
  const { tileX, tileZ, config, seed, biomeCenters, biomes } = input;
  const {
    TILE_SIZE,
    TILE_RESOLUTION,
    MAX_HEIGHT,
    BIOME_GAUSSIAN_COEFF,
    BIOME_BOUNDARY_NOISE_SCALE,
    BIOME_BOUNDARY_NOISE_AMOUNT,
    WATER_THRESHOLD,
    WATER_LEVEL_NORMALIZED,
    SHORELINE_THRESHOLD,
    SHORELINE_STRENGTH,
    SHORELINE_MIN_SLOPE,
    SHORELINE_SLOPE_SAMPLE_DISTANCE,
    SHORELINE_LAND_BAND,
    SHORELINE_LAND_MAX_MULTIPLIER,
    SHORELINE_UNDERWATER_BAND,
    UNDERWATER_DEPTH_MULTIPLIER
  } = config;

  const noise = new NoiseGenerator(seed);
  const resolution = TILE_RESOLUTION;
  const vertexCount = resolution * resolution;

  // ============================================
  // HEIGHT FUNCTIONS — generated from TerrainHeightParams.ts (single source of truth)
  // ============================================

  ${buildComputeBiomeWeightsJS()}

  ${buildGetBaseHeightAtJS()}
  ${buildCreateBiomeNoiseSetsJS()}
  var biomeNoiseSets = createBiomeNoiseSets(seed);

  ${buildHeightHelpersJS()}
  ${buildBiomeInfluencesJS()}

  // ============================================
  // OVERFLOW GRID — (resolution+2)^2 height grid for centered-difference normals
  // ============================================

  const stepSize = TILE_SIZE / (resolution - 1);
  const halfSize = TILE_SIZE / 2;
  const gRes = resolution + 2; // 66 for resolution=64
  const overflowGrid = new Float32Array(gRes * gRes);

  for (let gz = 0; gz < gRes; gz++) {
    const localZ = -halfSize + (gz - 1) * stepSize;
    const worldZ = localZ + tileZ * TILE_SIZE;
    for (let gx = 0; gx < gRes; gx++) {
      const localX = -halfSize + (gx - 1) * stepSize;
      const worldX = localX + tileX * TILE_SIZE;
      overflowGrid[gz * gRes + gx] = getHeightComputed(worldX, worldZ);
    }
  }

  // Extract interior heights (row 1..resolution, col 1..resolution)
  const heightData = new Float32Array(vertexCount);
  for (let iz = 0; iz < resolution; iz++) {
    const srcRow = (iz + 1) * gRes + 1;
    const dstRow = iz * resolution;
    for (let ix = 0; ix < resolution; ix++) {
      heightData[dstRow + ix] = overflowGrid[srcRow + ix];
    }
  }

  // ============================================
  // NORMALS — centered finite differences from overflow grid
  // ============================================

  const normalData = new Float32Array(vertexCount * 3);
  const invTwoStep = 1 / (2 * stepSize);
  for (let iz = 0; iz < resolution; iz++) {
    const gz = iz + 1;
    for (let ix = 0; ix < resolution; ix++) {
      const gx = ix + 1;
      const hL = overflowGrid[gz * gRes + (gx - 1)];
      const hR = overflowGrid[gz * gRes + (gx + 1)];
      const hD = overflowGrid[(gz - 1) * gRes + gx];
      const hU = overflowGrid[(gz + 1) * gRes + gx];
      const dhdx = (hR - hL) * invTwoStep;
      const dhdz = (hU - hD) * invTwoStep;
      const nx = -dhdx;
      const ny = 1;
      const nz = -dhdz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const i3 = (iz * resolution + ix) * 3;
      normalData[i3] = nx / len;
      normalData[i3 + 1] = ny / len;
      normalData[i3 + 2] = nz / len;
    }
  }

  // ============================================
  // COLORS & BIOMES — for interior vertices only
  // ============================================

  const colorData = new Float32Array(vertexCount * 3);
  const biomeData = new Uint8Array(vertexCount);
  const riverProximity = new Float32Array(vertexCount);

  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const idx = iz * resolution + ix;
      const height = heightData[idx];
      const normalizedHeight = height / MAX_HEIGHT;

      const localX = ix * stepSize - halfSize;
      const localZ = iz * stepSize - halfSize;
      const worldX = localX + tileX * TILE_SIZE;
      const worldZ = localZ + tileZ * TILE_SIZE;

      const biomeInfluences = getBiomeInfluences(worldX, worldZ, normalizedHeight);
      biomeData[idx] = BIOME_IDS[biomeInfluences[0].type] || 0;

      let colorR = 0, colorG = 0, colorB = 0;
      for (const influence of biomeInfluences) {
        const biomeConfig = biomes[influence.type] || { color: { r: 0.4, g: 0.6, b: 0.3 } };
        const color = biomeConfig.color || { r: 0.4, g: 0.6, b: 0.3 };
        colorR += color.r * influence.weight;
        colorG += color.g * influence.weight;
        colorB += color.b * influence.weight;
      }

      if (normalizedHeight > WATER_LEVEL_NORMALIZED && normalizedHeight < SHORELINE_THRESHOLD) {
        const shoreFactor = (1.0 - (normalizedHeight - WATER_LEVEL_NORMALIZED) /
                           (SHORELINE_THRESHOLD - WATER_LEVEL_NORMALIZED)) * SHORELINE_STRENGTH;
        colorR = colorR + (0.545 - colorR) * shoreFactor;
        colorG = colorG + (0.451 - colorG) * shoreFactor;
        colorB = colorB + (0.333 - colorB) * shoreFactor;
      }

      colorData[idx * 3] = colorR;
      colorData[idx * 3 + 1] = colorG;
      colorData[idx * 3 + 2] = colorB;
    }
  }

  return {
    type: 'heightmapResult',
    terrainProfileIdentity: config.TERRAIN_PROFILE_IDENTITY,
    tileKey: tileX + '_' + tileZ,
    tileX,
    tileZ,
    heightData,
    colorData,
    biomeData,
    normalData,
    riverProximity
  };
}

// Worker message handler
self.onmessage = function(e) {
  const input = e.data;
  if (input.type === 'generateHeightmap') {
    try {
      const result = generateHeightmap(input);
      self.postMessage({ result }, [
        result.heightData.buffer,
        result.colorData.buffer,
        result.biomeData.buffer,
        result.normalData.buffer,
        result.riverProximity.buffer
      ]);
    } catch (error) {
      self.postMessage({ error: error.message || 'Unknown error' });
    }
  }
};
`;

/** Singleton worker pool for terrain generation */
let terrainWorkerPool: WorkerPool<
  TerrainWorkerInput,
  TerrainWorkerOutput
> | null = null;

/** Track if workers are available */
let workersChecked = false;
let workersAvailable = false;

/**
 * Check if terrain workers are available (client-side with Worker + Blob URL support)
 * Bun provides Worker and Blob but doesn't support blob URLs for workers
 */
export function isTerrainWorkerAvailable(): boolean {
  if (!workersChecked) {
    workersChecked = true;
    // Check basic Worker/Blob availability
    if (typeof Worker === "undefined" || typeof Blob === "undefined") {
      workersAvailable = false;
      return workersAvailable;
    }
    // Detect Bun runtime - Bun has Worker/Blob but blob URLs don't work for workers
    if (
      typeof process !== "undefined" &&
      process.versions &&
      "bun" in process.versions
    ) {
      workersAvailable = false;
      return workersAvailable;
    }
    // Detect Node.js runtime (no browser globals like window)
    if (typeof window === "undefined") {
      workersAvailable = false;
      return workersAvailable;
    }
    workersAvailable = true;
  }
  return workersAvailable;
}

/**
 * Get or create the terrain worker pool
 * @param poolSize - Number of workers (defaults to CPU cores - 1)
 * @returns Worker pool, or null if workers unavailable (server-side)
 */
export function getTerrainWorkerPool(
  poolSize?: number,
): WorkerPool<TerrainWorkerInput, TerrainWorkerOutput> | null {
  // Return null if workers not available (graceful degradation for server)
  if (!isTerrainWorkerAvailable()) {
    return null;
  }

  if (!terrainWorkerPool) {
    terrainWorkerPool = new WorkerPool<TerrainWorkerInput, TerrainWorkerOutput>(
      TERRAIN_WORKER_CODE,
      poolSize,
    );
  }
  return terrainWorkerPool;
}

/**
 * Generate terrain heightmap data using web worker
 * Returns immediately with a promise that resolves when the worker completes
 * Returns null if workers are not available
 */
export async function generateTerrainHeightmapAsync(
  tileX: number,
  tileZ: number,
  config: TerrainWorkerConfig,
  seed: number,
  biomeCenters: Array<{
    x: number;
    z: number;
    type: string;
    influence: number;
  }>,
  biomes: Record<
    string,
    { heightModifier: number; color: { r: number; g: number; b: number } }
  >,
): Promise<TerrainWorkerOutput | null> {
  assertTerrainWorkerRequest(config, seed);
  const pool = getTerrainWorkerPool();
  if (!pool) {
    return null;
  }
  const result = await pool.execute({
    type: "generateHeightmap",
    tileX,
    tileZ,
    config,
    seed,
    biomeCenters,
    biomes,
  });
  assertTerrainWorkerResult(result, config);
  return result;
}

/**
 * Result of batch terrain generation
 */
export interface TerrainBatchResult {
  /** Successfully generated tiles */
  results: TerrainWorkerOutput[];
  /** Whether workers were available (false = need synchronous fallback) */
  workersAvailable: boolean;
  /** Number of tiles that failed to generate */
  failedCount: number;
}

/**
 * Generate multiple tiles in parallel
 * Returns result object with workersAvailable flag - caller MUST check this!
 */
export async function generateTerrainTilesBatch(
  tiles: Array<{ tileX: number; tileZ: number }>,
  config: TerrainWorkerConfig,
  seed: number,
  biomeCenters: Array<{
    x: number;
    z: number;
    type: string;
    influence: number;
  }>,
  biomes: Record<
    string,
    { heightModifier: number; color: { r: number; g: number; b: number } }
  >,
): Promise<TerrainBatchResult> {
  assertTerrainWorkerRequest(config, seed);
  const pool = getTerrainWorkerPool();
  if (!pool) {
    // Workers not available - caller should fall back to synchronous
    return {
      results: [],
      workersAvailable: false,
      failedCount: 0,
    };
  }

  const tasks = tiles.map((tile) => ({
    data: {
      type: "generateHeightmap" as const,
      tileX: tile.tileX,
      tileZ: tile.tileZ,
      config,
      seed,
      biomeCenters,
      biomes,
    },
  }));

  try {
    const results = await pool.executeAll(tasks);
    for (const result of results) assertTerrainWorkerResult(result, config);
    return {
      results,
      workersAvailable: true,
      failedCount: 0,
    };
  } catch (error) {
    // Some or all tasks failed
    console.error("[TerrainWorker] Batch generation failed:", error);
    return {
      results: [],
      workersAvailable: true,
      failedCount: tiles.length,
    };
  }
}

/**
 * Terminate the terrain worker pool (call on cleanup)
 */
export function terminateTerrainWorkerPool(): void {
  if (terrainWorkerPool) {
    terrainWorkerPool.terminate();
    terrainWorkerPool = null;
  }
}
