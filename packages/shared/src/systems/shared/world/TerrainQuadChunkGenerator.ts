/**
 * TerrainQuadChunkGenerator — Assembles terrain geometry for quad-tree chunks
 * from pre-computed worker output.
 *
 * The heavy lifting (noise, heights, normals, biome blending) is done by
 * QuadChunkWorker on a background thread. This module handles:
 * - Road influence sampling (needs live road network)
 * - Flat-zone height overrides via getFlatZoneHeight (needs live building data)
 * - Skirt geometry generation
 * - Index buffer generation
 * - THREE.BufferGeometry assembly
 *
 * A synchronous data generator (generateQuadChunkDataSync) is also provided
 * as a fallback when workers are unavailable. It produces the same
 * QuadChunkWorkerOutput format and feeds it through assembleQuadChunkGeometry,
 * keeping all assembly logic in one place.
 *
 * CLIENT-ONLY: Server terrain uses the flat tile grid.
 */

import THREE from "../../../extras/three/three";
import type { QuadChunkWorkerOutput } from "../../../utils/workers/QuadChunkWorker";
import { BiomeType, DEFAULT_BIOME } from "./TerrainBiomeTypes";

/**
 * Main-thread callbacks for game-state queries that can't run in a worker.
 * Used by assembleQuadChunkGeometry for road influence and flat-zone overrides.
 */
export interface ChunkTerrainProvider {
  calculateRoadInfluenceAtVertex(
    worldX: number,
    worldZ: number,
    tileX: number,
    tileZ: number,
  ): number;
  /**
   * Returns the final terrain height at this position if a flat zone applies,
   * including smooth blend transitions. Returns null if no flat zone affects
   * this point. This delegates to TerrainSystem.getFlatZoneHeight() which
   * handles core/blend classification and smoothstep interpolation.
   */
  getFlatZoneHeight(worldX: number, worldZ: number): number | null;
  getHeightAtComputed(worldX: number, worldZ: number): number;
  readonly TILE_SIZE: number;
}

/**
 * Extended provider that includes sync fallback methods for the data generator.
 * Used by generateQuadChunkDataSync (main-thread fallback) and by the
 * TerrainVisualManager for worker dispatch.
 */
export interface FullTerrainProvider extends ChunkTerrainProvider {
  computeBiomeWeightsAtPosition(
    worldX: number,
    worldZ: number,
  ): { biomeWeightMap: Map<string, number>; totalWeight: number };
  computeBiomeWeightsByPosition(
    worldX: number,
    worldZ: number,
  ): Record<string, number>;
  getBiomeId(biomeName: string): number;
  getBiomeColor(biomeName: string): { r: number; g: number; b: number };
  readonly WATER_LEVEL_NORMALIZED: number;
  readonly SHORELINE_THRESHOLD: number;
  readonly SHORELINE_STRENGTH: number;
  readonly MAX_HEIGHT: number;
}

export interface ChunkGeometryResult {
  geometry: THREE.BufferGeometry;
  /** Final main-grid heights, including live flat zones, without skirt vertices. */
  heightData: Float32Array;
}

/**
 * Assemble a THREE.BufferGeometry from worker-computed height/normal/color/biome
 * data, adding flat-zone overrides, road influence, and skirts on the main thread.
 */
export function assembleQuadChunkGeometry(
  workerData: QuadChunkWorkerOutput,
  provider: ChunkTerrainProvider,
  skirtDrop: number,
): ChunkGeometryResult {
  const {
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
    riverProximity: riverProximityData,
  } = workerData;
  const segments = resolution;
  const halfSize = size * 0.5;
  const gridStep = size / (segments - 1);

  const skirtCount = segments * 4;
  const totalVertices = segments * segments + skirtCount;
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const colors = new Float32Array(totalVertices * 3);
  const biomeIds = new Float32Array(totalVertices);
  const forestWeights = new Float32Array(totalVertices);
  const canyonWeights = new Float32Array(totalVertices);
  const roadInfluences = new Float32Array(totalVertices);
  const riverProximities = new Float32Array(totalVertices);

  let flatZoneModified = false;
  // Preserve the worker result: it can still be held by a caller/cache. Chunks
  // without live overrides keep the original allocation; modified chunks expose
  // the same Float32 heights as their rendered main-grid position attribute.
  let surfaceHeights = heightData;

  for (let iz = 0; iz < segments; iz++) {
    const localZ = -halfSize + iz * gridStep;
    const worldZ = centerZ + localZ;

    for (let ix = 0; ix < segments; ix++) {
      const localX = -halfSize + ix * gridStep;
      const worldX = centerX + localX;
      const idx = iz * segments + ix;
      const i3 = idx * 3;

      let height = heightData[idx];

      const flatHeight = provider.getFlatZoneHeight(worldX, worldZ);
      if (flatHeight !== null) {
        height = flatHeight;
        if (!flatZoneModified) surfaceHeights = heightData.slice();
        surfaceHeights[idx] = height;
        flatZoneModified = true;
      }

      positions[i3] = localX;
      positions[i3 + 1] = height;
      positions[i3 + 2] = localZ;

      normals[i3] = normalData[i3];
      normals[i3 + 1] = normalData[i3 + 1];
      normals[i3 + 2] = normalData[i3 + 2];

      colors[i3] = colorData[i3];
      colors[i3 + 1] = colorData[i3 + 1];
      colors[i3 + 2] = colorData[i3 + 2];

      biomeIds[idx] = biomeData[idx];
      forestWeights[idx] = biomeForestWeight[idx];
      canyonWeights[idx] = biomeCanyonWeight[idx];
      riverProximities[idx] = riverProximityData?.[idx] ?? 0;

      const roadTileX = Math.floor(worldX / provider.TILE_SIZE);
      const roadTileZ = Math.floor(worldZ / provider.TILE_SIZE);
      roadInfluences[idx] = provider.calculateRoadInfluenceAtVertex(
        worldX,
        worldZ,
        roadTileX,
        roadTileZ,
      );
    }
  }

  // A neighboring grade can change an edge normal without touching any vertex
  // inside this chunk. Check only the normal stencil's outer samples in that
  // case; ungraded chunks still avoid all computed-height queries.
  if (
    flatZoneModified ||
    hasGradingInNormalBorder(
      segments,
      gridStep,
      centerX - halfSize,
      centerZ - halfSize,
      provider,
    )
  ) {
    recomputeNormals(
      positions,
      normals,
      segments,
      gridStep,
      centerX - halfSize,
      centerZ - halfSize,
      provider,
    );
  }

  // =========================================================================
  // Skirt geometry
  // =========================================================================
  let skirtIdx = segments * segments;

  const copyEdgeVertex = (mainIdx: number) => {
    const si3 = skirtIdx * 3;
    const mi3 = mainIdx * 3;
    positions[si3] = positions[mi3];
    positions[si3 + 1] = positions[mi3 + 1] - skirtDrop;
    positions[si3 + 2] = positions[mi3 + 2];
    normals[si3] = normals[mi3];
    normals[si3 + 1] = normals[mi3 + 1];
    normals[si3 + 2] = normals[mi3 + 2];
    colors[si3] = colors[mi3];
    colors[si3 + 1] = colors[mi3 + 1];
    colors[si3 + 2] = colors[mi3 + 2];
    biomeIds[skirtIdx] = biomeIds[mainIdx];
    forestWeights[skirtIdx] = forestWeights[mainIdx];
    canyonWeights[skirtIdx] = canyonWeights[mainIdx];
    roadInfluences[skirtIdx] = roadInfluences[mainIdx];
    riverProximities[skirtIdx] = riverProximities[mainIdx];
    skirtIdx++;
  };

  for (let ix = 0; ix < segments; ix++) copyEdgeVertex(ix);
  for (let ix = 0; ix < segments; ix++)
    copyEdgeVertex((segments - 1) * segments + ix);
  for (let iz = 0; iz < segments; iz++) copyEdgeVertex(iz * segments);
  for (let iz = 0; iz < segments; iz++)
    copyEdgeVertex(iz * segments + (segments - 1));

  // =========================================================================
  // Indices
  // =========================================================================
  const subs = segments - 1;
  const mainFaceCount = subs * subs;
  const skirtFaceCount = subs * 4;
  const totalIndices = (mainFaceCount + skirtFaceCount) * 6;
  const indices = new Uint32Array(totalIndices);
  let ii = 0;

  for (let iz = 0; iz < subs; iz++) {
    for (let ix = 0; ix < subs; ix++) {
      const a = iz * segments + ix;
      const b = a + 1;
      const c = a + segments;
      const d = c + 1;
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }

  const skirtBase = segments * segments;
  const northSkirtBase = skirtBase;
  const southSkirtBase = skirtBase + segments;
  const westSkirtBase = skirtBase + segments * 2;
  const eastSkirtBase = skirtBase + segments * 3;

  for (let ix = 0; ix < subs; ix++) {
    const mainA = ix;
    const mainB = ix + 1;
    const skirtA = northSkirtBase + ix;
    const skirtB = northSkirtBase + ix + 1;
    indices[ii++] = skirtA;
    indices[ii++] = mainA;
    indices[ii++] = skirtB;
    indices[ii++] = skirtB;
    indices[ii++] = mainA;
    indices[ii++] = mainB;
  }

  for (let ix = 0; ix < subs; ix++) {
    const mainA = (segments - 1) * segments + ix;
    const mainB = mainA + 1;
    const skirtA = southSkirtBase + ix;
    const skirtB = southSkirtBase + ix + 1;
    indices[ii++] = mainA;
    indices[ii++] = skirtA;
    indices[ii++] = mainB;
    indices[ii++] = mainB;
    indices[ii++] = skirtA;
    indices[ii++] = skirtB;
  }

  for (let iz = 0; iz < subs; iz++) {
    const mainA = iz * segments;
    const mainB = (iz + 1) * segments;
    const skirtA = westSkirtBase + iz;
    const skirtB = westSkirtBase + iz + 1;
    indices[ii++] = mainA;
    indices[ii++] = skirtA;
    indices[ii++] = mainB;
    indices[ii++] = mainB;
    indices[ii++] = skirtA;
    indices[ii++] = skirtB;
  }

  for (let iz = 0; iz < subs; iz++) {
    const mainA = iz * segments + (segments - 1);
    const mainB = (iz + 1) * segments + (segments - 1);
    const skirtA = eastSkirtBase + iz;
    const skirtB = eastSkirtBase + iz + 1;
    indices[ii++] = skirtA;
    indices[ii++] = mainA;
    indices[ii++] = skirtB;
    indices[ii++] = skirtB;
    indices[ii++] = mainA;
    indices[ii++] = mainB;
  }

  // =========================================================================
  // Build BufferGeometry
  // =========================================================================
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("biomeId", new THREE.BufferAttribute(biomeIds, 1));
  geometry.setAttribute(
    "biomeForestWeight",
    new THREE.BufferAttribute(forestWeights, 1),
  );
  geometry.setAttribute(
    "biomeCanyonWeight",
    new THREE.BufferAttribute(canyonWeights, 1),
  );
  geometry.setAttribute(
    "roadInfluence",
    new THREE.BufferAttribute(roadInfluences, 1),
  );
  geometry.setAttribute(
    "riverProximity",
    new THREE.BufferAttribute(riverProximities, 1),
  );
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return { geometry, heightData: surfaceHeights };
}

/**
 * Test the four one-step-outside normal stencils, not the whole neighboring
 * chunk. At most 4N grading queries are needed; stop at the first affected one.
 * No height query is needed when all these samples are ungraded.
 */
function hasGradingInNormalBorder(
  segments: number,
  gridStep: number,
  minX: number,
  minZ: number,
  provider: ChunkTerrainProvider,
): boolean {
  const maxX = minX + (segments - 1) * gridStep;
  const maxZ = minZ + (segments - 1) * gridStep;
  for (let i = 0; i < segments; i++) {
    const x = minX + i * gridStep;
    const z = minZ + i * gridStep;
    if (
      provider.getFlatZoneHeight(minX - gridStep, z) !== null ||
      provider.getFlatZoneHeight(maxX + gridStep, z) !== null ||
      provider.getFlatZoneHeight(x, minZ - gridStep) !== null ||
      provider.getFlatZoneHeight(x, maxZ + gridStep) !== null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Recompute normals for the main grid after flat-zone height overrides.
 * Uses centered finite differences from the final position buffer. At chunk
 * edges, sample the final height field one grid step beyond the chunk rather
 * than clamping to the edge (which halves the slope and creates lighting seams).
 * Extra terrain work is bounded to four samples per grid row/column, not one
 * procedural evaluation per interior vertex.
 */
function recomputeNormals(
  positions: Float32Array,
  normals: Float32Array,
  segments: number,
  gridStep: number,
  minX: number,
  minZ: number,
  provider: ChunkTerrainProvider,
): void {
  const invTwoStep = 1 / (2 * gridStep);

  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const idx = iz * segments + ix;
      const i3 = idx * 3;

      const worldX = minX + ix * gridStep;
      const worldZ = minZ + iz * gridStep;
      const hL =
        ix > 0
          ? positions[(idx - 1) * 3 + 1]
          : Math.fround(
              provider.getHeightAtComputed(worldX - gridStep, worldZ),
            );
      const hR =
        ix < segments - 1
          ? positions[(idx + 1) * 3 + 1]
          : Math.fround(
              provider.getHeightAtComputed(worldX + gridStep, worldZ),
            );
      const hD =
        iz > 0
          ? positions[(idx - segments) * 3 + 1]
          : Math.fround(
              provider.getHeightAtComputed(worldX, worldZ - gridStep),
            );
      const hU =
        iz < segments - 1
          ? positions[(idx + segments) * 3 + 1]
          : Math.fround(
              provider.getHeightAtComputed(worldX, worldZ + gridStep),
            );

      const dhdx = (hR - hL) * invTwoStep;
      const dhdz = (hU - hD) * invTwoStep;
      const nx = -dhdx;
      const ny = 1;
      const nz = -dhdz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

      normals[i3] = nx / len;
      normals[i3 + 1] = ny / len;
      normals[i3 + 2] = nz / len;
    }
  }
}

/**
 * Synchronous data generator — produces QuadChunkWorkerOutput on the main thread.
 * Used as fallback when workers are unavailable. The output feeds directly into
 * assembleQuadChunkGeometry, keeping all assembly logic in one place.
 */
export function generateQuadChunkDataSync(
  centerX: number,
  centerZ: number,
  size: number,
  resolution: number,
  provider: FullTerrainProvider,
): QuadChunkWorkerOutput {
  const segments = resolution;
  const halfSize = size * 0.5;
  const gridStep = size / (segments - 1);
  const vertexCount = segments * segments;

  // Overflow grid for normals: (segments+2)^2
  const gRes = segments + 2;
  const overflowGrid = new Float32Array(gRes * gRes);

  for (let gz = 0; gz < gRes; gz++) {
    const localZ = -halfSize + (gz - 1) * gridStep;
    const worldZ = centerZ + localZ;
    for (let gx = 0; gx < gRes; gx++) {
      const localX = -halfSize + (gx - 1) * gridStep;
      const worldX = centerX + localX;
      overflowGrid[gz * gRes + gx] = provider.getHeightAtComputed(
        worldX,
        worldZ,
      );
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

  // Normals via centered finite differences on the overflow grid
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

  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const idx = iz * segments + ix;
      const height = heightData[idx];
      const normalizedHeight = height / provider.MAX_HEIGHT;

      const localX = -halfSize + ix * gridStep;
      const localZ = -halfSize + iz * gridStep;
      const worldX = centerX + localX;
      const worldZ = centerZ + localZ;

      const { biomeWeightMap, totalWeight } =
        provider.computeBiomeWeightsAtPosition(worldX, worldZ);

      let dominantBiome: string = DEFAULT_BIOME;
      let dominantWeight = -Infinity;
      let cr = 0,
        cg = 0,
        cb = 0;

      if (totalWeight > 0) {
        const invTotal = 1 / totalWeight;
        for (const [type, rawWeight] of biomeWeightMap) {
          const weight = rawWeight * invTotal;
          if (weight > dominantWeight) {
            dominantWeight = weight;
            dominantBiome = type;
          }
          const bc = provider.getBiomeColor(type);
          cr += bc.r * weight;
          cg += bc.g * weight;
          cb += bc.b * weight;
        }
      } else {
        const bc = provider.getBiomeColor(DEFAULT_BIOME);
        cr = bc.r;
        cg = bc.g;
        cb = bc.b;
      }

      biomeData[idx] = provider.getBiomeId(dominantBiome);

      const fwNorm =
        totalWeight > 0
          ? (biomeWeightMap.get(BiomeType.Forest) || 0) / totalWeight
          : 0;
      const dwNorm =
        totalWeight > 0
          ? (biomeWeightMap.get(BiomeType.Canyon) || 0) / totalWeight
          : 0;
      biomeForestWeight[idx] = fwNorm;
      biomeCanyonWeight[idx] = dwNorm;

      const waterLevel = provider.WATER_LEVEL_NORMALIZED;
      const shoreThreshold = provider.SHORELINE_THRESHOLD;
      if (normalizedHeight > waterLevel && normalizedHeight < shoreThreshold) {
        const shoreFactor =
          (1.0 -
            (normalizedHeight - waterLevel) / (shoreThreshold - waterLevel)) *
          provider.SHORELINE_STRENGTH;
        cr += (0.545 - cr) * shoreFactor;
        cg += (0.451 - cg) * shoreFactor;
        cb += (0.333 - cb) * shoreFactor;
      }

      colorData[idx * 3] = cr;
      colorData[idx * 3 + 1] = cg;
      colorData[idx * 3 + 2] = cb;
    }
  }

  // River proximity not computed in sync fallback — zeros (shader uses attribute default)
  const riverProximity = new Float32Array(vertexCount);

  return {
    type: "quadChunkResult",
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
    riverProximity,
  };
}
