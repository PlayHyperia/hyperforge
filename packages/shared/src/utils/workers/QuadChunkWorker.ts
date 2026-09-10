/**
 * QuadChunkWorker — Offloads quad-tree terrain chunk computation to Web Worker.
 *
 * Computes heights (with overflow grid for normals), per-vertex normals,
 * biome-blended colors, and biome IDs for an arbitrary world-space region
 * defined by (centerX, centerZ, size, resolution).
 *
 * Road influence and flat-zone application stay on the main thread because
 * they depend on runtime game state (road network, building footprints).
 *
 * The inline worker code duplicates the same noise / height / biome logic
 * used by TerrainWorker.ts, keeping both in sync with TerrainHeightParams.ts.
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
import type { TerrainWorkerConfig } from "./TerrainWorker";

export type QuadChunkWorkerConfig = TerrainWorkerConfig;

export interface QuadChunkWorkerInput {
  type: "generateQuadChunk";
  centerX: number;
  centerZ: number;
  size: number;
  resolution: number;
  config: QuadChunkWorkerConfig;
  seed: number;
  biomeCenters: Array<{
    x: number;
    z: number;
    type: string;
    influence: number;
  }>;
  biomes: Record<string, { color: { r: number; g: number; b: number } }>;
}

export interface QuadChunkWorkerOutput {
  terrainProfileIdentity: string;
  type: "quadChunkResult";
  centerX: number;
  centerZ: number;
  size: number;
  resolution: number;
  heightData: Float32Array;
  normalData: Float32Array;
  colorData: Float32Array;
  biomeData: Uint8Array;
  biomeForestWeight: Float32Array;
  biomeCanyonWeight: Float32Array;
  riverProximity: Float32Array;
}

export const QUAD_CHUNK_WORKER_CODE = `
${buildNoiseGeneratorJS()}
${buildBiomeConstantsJS()}
${buildTerrainWorkerProfileGuardJS()}

var BIOME_IDS = {};
BIOME_IDS[BT_TUNDRA] = 0;
BIOME_IDS[BT_FOREST] = 1;
BIOME_IDS[BT_CANYON] = 2;

function generateQuadChunk(input) {
  assertTerrainWorkerInput(input);
  const { centerX, centerZ, size, resolution, config, seed, biomeCenters, biomes } = input;
  const {
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
  const segments = resolution;
  const vertexCount = segments * segments;
  const halfSize = size * 0.5;
  const gridStep = size / (segments - 1);

  ${buildComputeBiomeWeightsJS()}
  ${buildGetBaseHeightAtJS()}
  ${buildCreateBiomeNoiseSetsJS()}
  var biomeNoiseSets = createBiomeNoiseSets(seed);
  ${buildHeightHelpersJS()}
  ${buildBiomeInfluencesJS()}

  // Overflow grid for normals: (segments+2)^2
  const gRes = segments + 2;
  const overflowGrid = new Float32Array(gRes * gRes);

  for (let gz = 0; gz < gRes; gz++) {
    const localZ = -halfSize + (gz - 1) * gridStep;
    const worldZ = centerZ + localZ;
    for (let gx = 0; gx < gRes; gx++) {
      const localX = -halfSize + (gx - 1) * gridStep;
      const worldX = centerX + localX;
      overflowGrid[gz * gRes + gx] = getHeightComputed(worldX, worldZ);
    }
  }

  const heightData = new Float32Array(vertexCount);
  for (let iz = 0; iz < segments; iz++) {
    const srcRow = (iz + 1) * gRes + 1;
    const dstRow = iz * segments;
    for (let ix = 0; ix < segments; ix++) {
      heightData[dstRow + ix] = overflowGrid[srcRow + ix];
    }
  }

  // Normals via centered finite differences
  const normalData = new Float32Array(vertexCount * 3);
  const invTwoStep = 1 / (2 * gridStep);
  for (let iz = 0; iz < segments; iz++) {
    const gz = iz + 1;
    for (let ix = 0; ix < segments; ix++) {
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
      const i3 = (iz * segments + ix) * 3;
      normalData[i3] = nx / len;
      normalData[i3 + 1] = ny / len;
      normalData[i3 + 2] = nz / len;
    }
  }

  // Colors and biome IDs
  const colorData = new Float32Array(vertexCount * 3);
  const biomeData = new Uint8Array(vertexCount);
  const biomeForestWeight = new Float32Array(vertexCount);
  const biomeCanyonWeight = new Float32Array(vertexCount);
  const riverProximity = new Float32Array(vertexCount);

  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const idx = iz * segments + ix;
      const height = heightData[idx];
      const normalizedHeight = height / MAX_HEIGHT;

      const localX = -halfSize + ix * gridStep;
      const localZ = -halfSize + iz * gridStep;
      const worldX = centerX + localX;
      const worldZ = centerZ + localZ;

      var bw = computeBiomeWeightsByPosition(worldX, worldZ);
      var forestW = bw[BT_FOREST] || 0;
      var canyonW = bw[BT_CANYON] || 0;
      biomeForestWeight[idx] = forestW;
      biomeCanyonWeight[idx] = canyonW;

      var dominantBiome = BT_DEFAULT;
      var dominantWeight = -1;
      for (var bk in bw) {
        if (bw[bk] > dominantWeight) { dominantWeight = bw[bk]; dominantBiome = bk; }
      }
      biomeData[idx] = BIOME_IDS[dominantBiome] || 0;

      let colorR = 0, colorG = 0, colorB = 0;
      for (var bk2 in bw) {
        var bwt = bw[bk2];
        var biomeConfig = biomes[bk2] || { color: { r: 0.4, g: 0.6, b: 0.3 } };
        var color = biomeConfig.color || { r: 0.4, g: 0.6, b: 0.3 };
        colorR += color.r * bwt;
        colorG += color.g * bwt;
        colorB += color.b * bwt;
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
    type: 'quadChunkResult',
    terrainProfileIdentity: config.TERRAIN_PROFILE_IDENTITY,
    centerX,
    centerZ,
    size,
    resolution,
    heightData,
    normalData,
    colorData,
    biomeData,
    biomeForestWeight,
    biomeCanyonWeight,
    riverProximity
  };
}

self.onmessage = function(e) {
  const input = e.data;
  if (input.type === 'generateQuadChunk') {
    try {
      const result = generateQuadChunk(input);
      self.postMessage({ result }, [
        result.heightData.buffer,
        result.normalData.buffer,
        result.colorData.buffer,
        result.biomeData.buffer,
        result.biomeForestWeight.buffer,
        result.biomeCanyonWeight.buffer,
        result.riverProximity.buffer
      ]);
    } catch (error) {
      self.postMessage({ error: error.message || 'Unknown error' });
    }
  }
};
`;

let quadChunkWorkerPool: WorkerPool<
  QuadChunkWorkerInput,
  QuadChunkWorkerOutput
> | null = null;

let workersChecked = false;
let workersAvailable = false;

export function isQuadChunkWorkerAvailable(): boolean {
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

export function getQuadChunkWorkerPool(
  poolSize?: number,
): WorkerPool<QuadChunkWorkerInput, QuadChunkWorkerOutput> | null {
  if (!isQuadChunkWorkerAvailable()) {
    return null;
  }

  if (!quadChunkWorkerPool) {
    quadChunkWorkerPool = new WorkerPool<
      QuadChunkWorkerInput,
      QuadChunkWorkerOutput
    >(QUAD_CHUNK_WORKER_CODE, poolSize);
  }
  return quadChunkWorkerPool;
}

export async function generateQuadChunkAsync(
  input: QuadChunkWorkerInput,
): Promise<QuadChunkWorkerOutput | null> {
  assertTerrainWorkerRequest(input.config, input.seed);
  const pool = getQuadChunkWorkerPool();
  if (!pool) {
    return null;
  }
  const result = await pool.execute(input);
  assertTerrainWorkerResult(result, input.config);
  return result;
}

export function terminateQuadChunkWorkerPool(): void {
  if (quadChunkWorkerPool) {
    quadChunkWorkerPool.terminate();
    quadChunkWorkerPool = null;
  }
}
