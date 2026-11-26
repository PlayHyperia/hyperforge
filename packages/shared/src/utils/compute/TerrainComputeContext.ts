/**
 * Terrain Compute Context
 *
 * High-level GPU compute operations for terrain processing.
 * Wraps RuntimeComputeContext with terrain-specific functionality.
 */

import THREE from "../../extras/three/three";
import {
  RuntimeComputeContext,
  isWebGPUAvailable,
} from "./RuntimeComputeContext";
import {
  ROAD_INFLUENCE_SHADER,
  ROAD_INFLUENCE_TEXTURE_SHADER,
  TERRAIN_VERTEX_COLOR_SHADER,
  INSTANCE_MATRIX_SHADER,
  BATCH_DISTANCE_SHADER,
} from "./shaders/terrain.wgsl";

// ============================================================================
// TYPES
// ============================================================================

/** Road segment data for GPU processing */
export interface GPURoadSegment {
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  width: number;
  /** Edge fade in meters; omission uses the upload call's default. */
  blendWidth?: number;
  /** Peak mask influence; omission means a full-strength road. */
  maxInfluence?: number;
}

/** Exact shared 32-byte road record for both compute kernels. */
export function packRoadSegments(
  roads: readonly GPURoadSegment[],
  defaultBlendWidth = 0.5,
): Float32Array {
  if (!Number.isFinite(defaultBlendWidth) || defaultBlendWidth < 0)
    throw new Error("Road blend width must be finite and nonnegative");
  const data = new Float32Array(roads.length * 8);
  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];
    const blendWidth = road.blendWidth ?? defaultBlendWidth;
    const maxInfluence = road.maxInfluence ?? 1;
    if (
      ![
        road.startX,
        road.startZ,
        road.endX,
        road.endZ,
        road.width,
        blendWidth,
        maxInfluence,
      ].every(Number.isFinite) ||
      road.width < 0 ||
      blendWidth < 0 ||
      maxInfluence < 0 ||
      maxInfluence > 1
    )
      throw new Error(
        "Road GPU record requires finite coordinates, nonnegative width/fade and a peak in [0, 1]",
      );
    const base = i * 8;
    data[base] = road.startX;
    data[base + 1] = road.startZ;
    data[base + 2] = road.endX;
    data[base + 3] = road.endZ;
    data[base + 4] = road.width;
    data[base + 5] = blendWidth;
    data[base + 6] = maxInfluence;
    // The final float remains zero padding. No new GPU record or binding.
    for (let lane = 0; lane < 7; lane++)
      if (!Number.isFinite(data[base + lane]))
        throw new Error("Road GPU record exceeds finite Float32 storage");
  }
  return data;
}

/** WGSL Uniforms begins with two u32 counts, followed by two f32 offsets. */
export function packRoadInfluenceUniforms(
  vertexCount: number,
  roadCount: number,
  tileOffset: { x: number; z: number },
): Uint32Array {
  if (
    ![vertexCount, roadCount].every(
      (value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
    )
  )
    throw new Error("Road compute counts must fit u32");
  const data = new Uint32Array(4);
  const floats = new Float32Array(data.buffer);
  data[0] = vertexCount;
  data[1] = roadCount;
  floats[2] = tileOffset.x;
  floats[3] = tileOffset.z;
  if (!Number.isFinite(floats[2]) || !Number.isFinite(floats[3]))
    throw new Error("Road tile offsets must fit finite Float32 storage");
  return data;
}

/** Biome data for GPU color blending */
export interface GPUBiomeData {
  colorR: number;
  colorG: number;
  colorB: number;
  heightScale: number;
}

/** Instance transform data (position + quaternion + scale) */
export interface GPUInstanceTRS {
  posX: number;
  posY: number;
  posZ: number;
  quatX: number;
  quatY: number;
  quatZ: number;
  quatW: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
}

/** Terrain compute configuration */
export interface TerrainComputeConfig {
  /** Minimum vertices to use GPU (smaller batches use CPU) */
  minVerticesForGPU?: number;
  /** Minimum roads to use GPU for road influence */
  minRoadsForGPU?: number;
  /** Minimum instances to use GPU for matrix composition */
  minInstancesForGPU?: number;
}

const DEFAULT_CONFIG: Required<TerrainComputeConfig> = {
  minVerticesForGPU: 1000,
  minRoadsForGPU: 3,
  minInstancesForGPU: 500,
};

// ============================================================================
// TERRAIN COMPUTE CONTEXT
// ============================================================================

/**
 * GPU compute context specialized for terrain operations.
 *
 * Provides high-level methods for:
 * - Road influence calculation
 * - Vertex color blending
 * - Instance matrix composition
 * - Batch distance calculations
 */
export class TerrainComputeContext {
  private ctx: RuntimeComputeContext;
  private config: Required<TerrainComputeConfig>;
  private initialized = false;

  // Pipeline references
  private roadInfluencePipeline: GPUComputePipeline | null = null;
  private roadInfluenceTexturePipeline: GPUComputePipeline | null = null;
  private vertexColorPipeline: GPUComputePipeline | null = null;
  private instanceMatrixPipeline: GPUComputePipeline | null = null;
  private batchDistancePipeline: GPUComputePipeline | null = null;

  constructor(config: TerrainComputeConfig = {}) {
    this.ctx = new RuntimeComputeContext();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  /**
   * Initialize from Three.js WebGPURenderer.
   */
  initializeFromRenderer(renderer: THREE.WebGPURenderer): boolean {
    if (!this.ctx.initializeFromRenderer(renderer)) {
      return false;
    }
    return this.createPipelines();
  }

  /**
   * Initialize with standalone WebGPU device.
   */
  async initializeStandalone(): Promise<boolean> {
    if (!(await this.ctx.initializeStandalone())) {
      return false;
    }
    return this.createPipelines();
  }

  private createPipelines(): boolean {
    this.roadInfluencePipeline = this.ctx.createPipeline({
      label: "RoadInfluence",
      code: ROAD_INFLUENCE_SHADER,
      entryPoint: "main",
    });

    this.roadInfluenceTexturePipeline = this.ctx.createPipeline({
      label: "RoadInfluenceTexture",
      code: ROAD_INFLUENCE_TEXTURE_SHADER,
      entryPoint: "main",
    });

    this.vertexColorPipeline = this.ctx.createPipeline({
      label: "TerrainVertexColor",
      code: TERRAIN_VERTEX_COLOR_SHADER,
      entryPoint: "main",
    });

    this.instanceMatrixPipeline = this.ctx.createPipeline({
      label: "InstanceMatrix",
      code: INSTANCE_MATRIX_SHADER,
      entryPoint: "main",
    });

    this.batchDistancePipeline = this.ctx.createPipeline({
      label: "BatchDistance",
      code: BATCH_DISTANCE_SHADER,
      entryPoint: "main",
    });

    this.initialized =
      this.roadInfluencePipeline !== null &&
      this.roadInfluenceTexturePipeline !== null &&
      this.vertexColorPipeline !== null &&
      this.instanceMatrixPipeline !== null &&
      this.batchDistancePipeline !== null;

    return this.initialized;
  }

  // ==========================================================================
  // ROAD INFLUENCE
  // ==========================================================================

  /**
   * Check if GPU should be used for road influence calculation.
   */
  shouldUseGPUForRoadInfluence(
    vertexCount: number,
    roadCount: number,
  ): boolean {
    return (
      this.initialized &&
      vertexCount >= this.config.minVerticesForGPU &&
      roadCount >= this.config.minRoadsForGPU
    );
  }

  /**
   * Compute road influence for terrain vertices on GPU.
   *
   * @param vertices - [localX, localZ, ...] per vertex
   * @param roads - Array of road segments
   * @param tileOffset - World offset for the tile
   * @returns Influence value (0-1) per vertex
   */
  async computeRoadInfluence(
    vertices: Float32Array,
    roads: GPURoadSegment[],
    tileOffset: { x: number; z: number },
  ): Promise<Float32Array> {
    if (!this.initialized || !this.roadInfluencePipeline) {
      throw new Error("TerrainComputeContext not initialized");
    }

    const vertexCount = vertices.length / 2;
    const roadCount = roads.length;

    const roadData = packRoadSegments(roads);
    const uniforms = packRoadInfluenceUniforms(
      vertexCount,
      roadCount,
      tileOffset,
    );

    // Create buffers
    const vertexBuffer = this.ctx.createStorageBuffer("ri_vertices", vertices);
    const roadBuffer = this.ctx.createStorageBuffer("ri_roads", roadData);
    const outputBuffer = this.ctx.createEmptyStorageBuffer(
      "ri_output",
      vertexCount * 4,
    );
    const uniformBuffer = this.ctx.createUniformBuffer("ri_uniforms", uniforms);

    if (!vertexBuffer || !roadBuffer || !outputBuffer || !uniformBuffer) {
      throw new Error("Failed to create GPU buffers");
    }

    // Create bind group
    const bindGroup = this.ctx.createBindGroup(this.roadInfluencePipeline, [
      { binding: 0, resource: { buffer: vertexBuffer } },
      { binding: 1, resource: { buffer: roadBuffer } },
      { binding: 2, resource: { buffer: outputBuffer } },
      { binding: 3, resource: { buffer: uniformBuffer } },
    ]);

    if (!bindGroup) {
      throw new Error("Failed to create bind group");
    }

    // Dispatch
    await this.ctx.dispatchAndWait({
      pipeline: this.roadInfluencePipeline,
      bindGroup,
      workgroupCount: this.ctx.calculateWorkgroupCount(vertexCount, 64),
    });

    // Read back results
    const result = await this.ctx.readFloat32Buffer(outputBuffer, vertexCount);

    // Cleanup
    this.ctx.destroyBuffer("ri_vertices");
    this.ctx.destroyBuffer("ri_roads");
    this.ctx.destroyBuffer("ri_output");
    this.ctx.destroyBuffer("ri_uniforms");

    return result;
  }

  /**
   * Generate a road influence texture for GPU grass masking.
   * Uses the same road influence calculation as terrain vertices.
   *
   * @param roads - Array of road segments in world coordinates
   * @param textureSize - Size of output texture (power of 2 recommended)
   * @param worldSize - Size of world in meters
   * @param centerX - World center X (default 0)
   * @param centerZ - World center Z (default 0)
   * @param blendWidth - Blend width beyond road edge (meters)
   * @returns Float32Array of road influence values (textureSize x textureSize)
   */
  async computeRoadInfluenceTexture(
    roads: GPURoadSegment[],
    textureSize: number,
    worldSize: number,
    centerX = 0,
    centerZ = 0,
    blendWidth = 0.5,
  ): Promise<Float32Array> {
    if (!this.initialized || !this.roadInfluenceTexturePipeline) {
      throw new Error("TerrainComputeContext not initialized");
    }

    const pixelCount = textureSize * textureSize;
    const roadCount = roads.length;

    if (roadCount === 0) {
      return new Float32Array(pixelCount);
    }

    const roadData = packRoadSegments(roads, blendWidth);

    // Create buffers
    const roadBuffer = this.ctx.createStorageBuffer("rtex_roads", roadData);
    const outputBuffer = this.ctx.createEmptyStorageBuffer(
      "rtex_output",
      pixelCount * 4,
    );
    const uniformBuffer = this.ctx.createUniformBuffer(
      "rtex_uniforms",
      new Float32Array([
        pixelCount,
        roadCount,
        textureSize,
        worldSize,
        centerX,
        centerZ,
        blendWidth,
        0, // padding
      ]),
    );

    if (!roadBuffer || !outputBuffer || !uniformBuffer) {
      throw new Error("Failed to create GPU buffers");
    }

    // Create bind group
    const bindGroup = this.ctx.createBindGroup(
      this.roadInfluenceTexturePipeline,
      [
        { binding: 0, resource: { buffer: roadBuffer } },
        { binding: 1, resource: { buffer: outputBuffer } },
        { binding: 2, resource: { buffer: uniformBuffer } },
      ],
    );

    if (!bindGroup) {
      throw new Error("Failed to create bind group");
    }

    // Dispatch
    await this.ctx.dispatchAndWait({
      pipeline: this.roadInfluenceTexturePipeline,
      bindGroup,
      workgroupCount: this.ctx.calculateWorkgroupCount(pixelCount, 64),
    });

    // Read back results
    const result = await this.ctx.readFloat32Buffer(outputBuffer, pixelCount);

    // Cleanup
    this.ctx.destroyBuffer("rtex_roads");
    this.ctx.destroyBuffer("rtex_output");
    this.ctx.destroyBuffer("rtex_uniforms");

    return result;
  }

  // ==========================================================================
  // TERRAIN VERTEX COLORS
  // ==========================================================================

  /**
   * Compute terrain vertex colors with biome blending and road influence.
   *
   * @param heights - Height per vertex
   * @param biomeInfluences - [biomeId, weight, ...] per vertex (3 biomes max)
   * @param biomes - Array of biome data with colors
   * @param roadInfluences - Influence value per vertex
   * @param config - Height/water configuration
   * @returns RGB colors per vertex [r, g, b, ...]
   */
  async computeVertexColors(
    heights: Float32Array,
    biomeInfluences: Float32Array,
    biomes: GPUBiomeData[],
    roadInfluences: Float32Array,
    config: {
      maxHeight: number;
      waterLevel: number;
      shorelineThreshold: number;
      shorelineStrength: number;
    },
  ): Promise<Float32Array> {
    if (!this.initialized || !this.vertexColorPipeline) {
      throw new Error("TerrainComputeContext not initialized");
    }

    const vertexCount = heights.length;
    const biomeCount = biomes.length;

    // Pack biome data (4 floats per biome)
    const biomeData = new Float32Array(biomeCount * 4);
    for (let i = 0; i < biomeCount; i++) {
      const b = biomes[i];
      const base = i * 4;
      biomeData[base + 0] = b.colorR;
      biomeData[base + 1] = b.colorG;
      biomeData[base + 2] = b.colorB;
      biomeData[base + 3] = b.heightScale;
    }

    // Create buffers
    const heightBuffer = this.ctx.createStorageBuffer("vc_heights", heights);
    const influenceBuffer = this.ctx.createStorageBuffer(
      "vc_biomeInfluences",
      biomeInfluences,
    );
    const biomeBuffer = this.ctx.createStorageBuffer("vc_biomes", biomeData);
    const roadBuffer = this.ctx.createStorageBuffer(
      "vc_roadInfluences",
      roadInfluences,
    );
    const outputBuffer = this.ctx.createEmptyStorageBuffer(
      "vc_output",
      vertexCount * 3 * 4,
    );
    const uniformBuffer = this.ctx.createUniformBuffer(
      "vc_uniforms",
      new Float32Array([
        vertexCount,
        biomeCount,
        config.maxHeight,
        config.waterLevel,
        config.shorelineThreshold,
        config.shorelineStrength,
        0, // padding
        0, // padding
      ]),
    );

    if (
      !heightBuffer ||
      !influenceBuffer ||
      !biomeBuffer ||
      !roadBuffer ||
      !outputBuffer ||
      !uniformBuffer
    ) {
      throw new Error("Failed to create GPU buffers");
    }

    // Create bind group
    const bindGroup = this.ctx.createBindGroup(this.vertexColorPipeline, [
      { binding: 0, resource: { buffer: heightBuffer } },
      { binding: 1, resource: { buffer: influenceBuffer } },
      { binding: 2, resource: { buffer: biomeBuffer } },
      { binding: 3, resource: { buffer: roadBuffer } },
      { binding: 4, resource: { buffer: outputBuffer } },
      { binding: 5, resource: { buffer: uniformBuffer } },
    ]);

    if (!bindGroup) {
      throw new Error("Failed to create bind group");
    }

    // Dispatch
    await this.ctx.dispatchAndWait({
      pipeline: this.vertexColorPipeline,
      bindGroup,
      workgroupCount: this.ctx.calculateWorkgroupCount(vertexCount, 64),
    });

    // Read back results
    const result = await this.ctx.readFloat32Buffer(
      outputBuffer,
      vertexCount * 3,
    );

    // Cleanup
    this.ctx.destroyBuffer("vc_heights");
    this.ctx.destroyBuffer("vc_biomeInfluences");
    this.ctx.destroyBuffer("vc_biomes");
    this.ctx.destroyBuffer("vc_roadInfluences");
    this.ctx.destroyBuffer("vc_output");
    this.ctx.destroyBuffer("vc_uniforms");

    return result;
  }

  // ==========================================================================
  // INSTANCE MATRICES
  // ==========================================================================

  /**
   * Check if GPU should be used for instance matrix composition.
   */
  shouldUseGPUForInstanceMatrices(instanceCount: number): boolean {
    return this.initialized && instanceCount >= this.config.minInstancesForGPU;
  }

  /**
   * Compose instance matrices from TRS data on GPU.
   *
   * @param instances - Array of position/quaternion/scale data
   * @returns Float32Array with 16 floats per matrix (column-major)
   */
  async composeInstanceMatrices(
    instances: GPUInstanceTRS[],
  ): Promise<Float32Array> {
    if (!this.initialized || !this.instanceMatrixPipeline) {
      throw new Error("TerrainComputeContext not initialized");
    }

    const instanceCount = instances.length;

    // Pack instance data (12 floats per instance for alignment)
    const instanceData = new Float32Array(instanceCount * 12);
    for (let i = 0; i < instanceCount; i++) {
      const inst = instances[i];
      const base = i * 12;
      instanceData[base + 0] = inst.posX;
      instanceData[base + 1] = inst.posY;
      instanceData[base + 2] = inst.posZ;
      instanceData[base + 3] = inst.quatX;
      instanceData[base + 4] = inst.quatY;
      instanceData[base + 5] = inst.quatZ;
      instanceData[base + 6] = inst.quatW;
      instanceData[base + 7] = inst.scaleX;
      instanceData[base + 8] = inst.scaleY;
      instanceData[base + 9] = inst.scaleZ;
      instanceData[base + 10] = 0; // padding
      instanceData[base + 11] = 0; // padding
    }

    // Create buffers
    const inputBuffer = this.ctx.createStorageBuffer(
      "im_instances",
      instanceData,
    );
    const outputBuffer = this.ctx.createEmptyStorageBuffer(
      "im_output",
      instanceCount * 16 * 4,
    );
    const uniformBuffer = this.ctx.createUniformBuffer(
      "im_uniforms",
      new Uint32Array([instanceCount, 0, 0, 0]),
    );

    if (!inputBuffer || !outputBuffer || !uniformBuffer) {
      throw new Error("Failed to create GPU buffers");
    }

    // Create bind group
    const bindGroup = this.ctx.createBindGroup(this.instanceMatrixPipeline, [
      { binding: 0, resource: { buffer: inputBuffer } },
      { binding: 1, resource: { buffer: outputBuffer } },
      { binding: 2, resource: { buffer: uniformBuffer } },
    ]);

    if (!bindGroup) {
      throw new Error("Failed to create bind group");
    }

    // Dispatch
    await this.ctx.dispatchAndWait({
      pipeline: this.instanceMatrixPipeline,
      bindGroup,
      workgroupCount: this.ctx.calculateWorkgroupCount(instanceCount, 64),
    });

    // Read back results
    const result = await this.ctx.readFloat32Buffer(
      outputBuffer,
      instanceCount * 16,
    );

    // Cleanup
    this.ctx.destroyBuffer("im_instances");
    this.ctx.destroyBuffer("im_output");
    this.ctx.destroyBuffer("im_uniforms");

    return result;
  }

  /**
   * Compose instance matrices from flat Float32Array data.
   * More efficient when data is already packed.
   *
   * @param instanceData - Flat array [posX, posY, posZ, quatX, quatY, quatZ, quatW, scaleX, scaleY, scaleZ, pad, pad, ...]
   * @returns Float32Array with 16 floats per matrix
   */
  async composeInstanceMatricesFromArray(
    instanceData: Float32Array,
  ): Promise<Float32Array> {
    if (!this.initialized || !this.instanceMatrixPipeline) {
      throw new Error("TerrainComputeContext not initialized");
    }

    const instanceCount = instanceData.length / 12;

    // Create buffers
    const inputBuffer = this.ctx.createStorageBuffer(
      "im_instances",
      instanceData,
    );
    const outputBuffer = this.ctx.createEmptyStorageBuffer(
      "im_output",
      instanceCount * 16 * 4,
    );
    const uniformBuffer = this.ctx.createUniformBuffer(
      "im_uniforms",
      new Uint32Array([instanceCount, 0, 0, 0]),
    );

    if (!inputBuffer || !outputBuffer || !uniformBuffer) {
      throw new Error("Failed to create GPU buffers");
    }

    // Create bind group
    const bindGroup = this.ctx.createBindGroup(this.instanceMatrixPipeline, [
      { binding: 0, resource: { buffer: inputBuffer } },
      { binding: 1, resource: { buffer: outputBuffer } },
      { binding: 2, resource: { buffer: uniformBuffer } },
    ]);

    if (!bindGroup) {
      throw new Error("Failed to create bind group");
    }

    // Dispatch
    await this.ctx.dispatchAndWait({
      pipeline: this.instanceMatrixPipeline,
      bindGroup,
      workgroupCount: this.ctx.calculateWorkgroupCount(instanceCount, 64),
    });

    // Read back results
    const result = await this.ctx.readFloat32Buffer(
      outputBuffer,
      instanceCount * 16,
    );

    // Cleanup
    this.ctx.destroyBuffer("im_instances");
    this.ctx.destroyBuffer("im_output");
    this.ctx.destroyBuffer("im_uniforms");

    return result;
  }

  // ==========================================================================
  // BATCH DISTANCE
  // ==========================================================================

  /**
   * Compute distances from points to their nearest targets.
   *
   * @param points - [x, y, z, ...] source points
   * @param targets - [x, y, z, ...] target points
   * @param useXZDistance - If true, ignore Y component
   * @returns Object with distances and nearest indices
   */
  async computeNearestDistances(
    points: Float32Array,
    targets: Float32Array,
    useXZDistance = false,
  ): Promise<{ distances: Float32Array; nearestIndices: Uint32Array }> {
    if (!this.initialized || !this.batchDistancePipeline) {
      throw new Error("TerrainComputeContext not initialized");
    }

    const pointCount = points.length / 3;
    const targetCount = targets.length / 3;

    // Create buffers
    const pointBuffer = this.ctx.createStorageBuffer("bd_points", points);
    const targetBuffer = this.ctx.createStorageBuffer("bd_targets", targets);
    const distanceBuffer = this.ctx.createEmptyStorageBuffer(
      "bd_distances",
      pointCount * 4,
    );
    const indexBuffer = this.ctx.createEmptyStorageBuffer(
      "bd_indices",
      pointCount * 4,
    );
    const uniformBuffer = this.ctx.createUniformBuffer(
      "bd_uniforms",
      new Uint32Array([pointCount, targetCount, useXZDistance ? 1 : 0, 0]),
    );

    if (
      !pointBuffer ||
      !targetBuffer ||
      !distanceBuffer ||
      !indexBuffer ||
      !uniformBuffer
    ) {
      throw new Error("Failed to create GPU buffers");
    }

    // Create bind group
    const bindGroup = this.ctx.createBindGroup(this.batchDistancePipeline, [
      { binding: 0, resource: { buffer: pointBuffer } },
      { binding: 1, resource: { buffer: targetBuffer } },
      { binding: 2, resource: { buffer: distanceBuffer } },
      { binding: 3, resource: { buffer: indexBuffer } },
      { binding: 4, resource: { buffer: uniformBuffer } },
    ]);

    if (!bindGroup) {
      throw new Error("Failed to create bind group");
    }

    // Dispatch
    await this.ctx.dispatchAndWait({
      pipeline: this.batchDistancePipeline,
      bindGroup,
      workgroupCount: this.ctx.calculateWorkgroupCount(pointCount, 64),
    });

    // Read back results
    const distances = await this.ctx.readFloat32Buffer(
      distanceBuffer,
      pointCount,
    );
    const nearestIndices = await this.ctx.readUint32Buffer(
      indexBuffer,
      pointCount,
    );

    // Cleanup
    this.ctx.destroyBuffer("bd_points");
    this.ctx.destroyBuffer("bd_targets");
    this.ctx.destroyBuffer("bd_distances");
    this.ctx.destroyBuffer("bd_indices");
    this.ctx.destroyBuffer("bd_uniforms");

    return { distances, nearestIndices };
  }

  // ==========================================================================
  // UTILITY
  // ==========================================================================

  /**
   * Check if the context is ready for use.
   */
  isReady(): boolean {
    return this.initialized && this.ctx.isReady();
  }

  /**
   * Get the underlying RuntimeComputeContext.
   */
  getRuntimeContext(): RuntimeComputeContext {
    return this.ctx;
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this.ctx.destroy();
    this.roadInfluencePipeline = null;
    this.roadInfluenceTexturePipeline = null;
    this.vertexColorPipeline = null;
    this.instanceMatrixPipeline = null;
    this.batchDistancePipeline = null;
    this.initialized = false;
  }
}

// ============================================================================
// GLOBAL INSTANCE
// ============================================================================

let globalTerrainContext: TerrainComputeContext | null = null;

/**
 * Get or create the global TerrainComputeContext.
 */
export function getGlobalTerrainComputeContext(): TerrainComputeContext {
  if (!globalTerrainContext) {
    globalTerrainContext = new TerrainComputeContext();
  }
  return globalTerrainContext;
}

/**
 * Initialize the global context from a renderer.
 */
export function initializeGlobalTerrainComputeContext(
  renderer: THREE.WebGPURenderer,
): boolean {
  const context = getGlobalTerrainComputeContext();
  return context.initializeFromRenderer(renderer);
}

/**
 * Check if GPU terrain compute is available.
 */
export function isTerrainComputeAvailable(): boolean {
  return isWebGPUAvailable();
}
