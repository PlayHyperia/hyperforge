/**
 * Runtime WebGPU Compute Context
 *
 * Provides GPU compute shader infrastructure for real-time operations like
 * culling, particle physics, terrain generation, and grass placement.
 *
 * Integrates with Three.js WebGPURenderer to share the GPU device.
 */

import THREE from "../../extras/three/three";
import { alignWebGPUBufferSize } from "../rendering/webgpuBufferUploads";

// ============================================================================
// TYPES
// ============================================================================

export interface ComputePipelineConfig {
  label: string;
  code: string;
  entryPoint?: string;
  workgroupSize?: number;
}

export interface ComputeBufferConfig {
  label: string;
  size: number;
  usage: GPUBufferUsageFlags;
  mappedAtCreation?: boolean;
}

export interface DispatchConfig {
  pipeline: GPUComputePipeline;
  bindGroup: GPUBindGroup;
  workgroupCount: number | [number, number, number];
}

export interface BufferReadBackResult<T extends ArrayBufferView> {
  data: T;
  stagingBuffer: GPUBuffer;
}

/** Indirect draw parameters structure (matches WebGPU spec) */
export interface IndirectDrawParams {
  vertexCount: number;
  instanceCount: number;
  firstVertex: number;
  firstInstance: number;
}

/** Indexed indirect draw parameters structure */
export interface IndexedIndirectDrawParams {
  indexCount: number;
  instanceCount: number;
  firstIndex: number;
  baseVertex: number;
  firstInstance: number;
}

// ============================================================================
// RUNTIME COMPUTE CONTEXT
// ============================================================================

/** Staging buffer pool entry */
interface StagingBufferEntry {
  buffer: GPUBuffer;
  size: number;
  inUse: boolean;
  lastUsedFrame: number;
}

/** Standard staging buffer size tiers */
const STAGING_SIZE_TIERS = [
  1024, // 1KB
  4096, // 4KB
  16384, // 16KB
  65536, // 64KB
  262144, // 256KB
  1048576, // 1MB
  4194304, // 4MB
] as const;

/**
 * Runtime compute context for GPU compute operations.
 *
 * Unlike the decimation context which initializes its own device,
 * this context integrates with Three.js WebGPURenderer to share the device.
 *
 * Includes a staging buffer pool for efficient GPU read-back operations.
 */
export class RuntimeComputeContext {
  private device: GPUDevice | null = null;
  private pipelines: Map<string, GPUComputePipeline> = new Map();
  private buffers: Map<string, GPUBuffer> = new Map();
  private initialized = false;

  // Cached shader modules for reuse
  private shaderModules: Map<string, GPUShaderModule> = new Map();

  // Staging buffer pool for efficient read-back operations
  private stagingPool: Map<number, StagingBufferEntry[]> = new Map();
  private stagingPoolFrame = 0;
  private readonly stagingPoolMaxAge = 300; // ~5 seconds at 60fps
  private readonly stagingPoolMaxPerTier = 4;

  /**
   * Initialize from Three.js WebGPURenderer.
   *
   * @param renderer - Three.js WebGPURenderer instance
   * @returns true if WebGPU is available and initialized
   */
  initializeFromRenderer(renderer: THREE.WebGPURenderer): boolean {
    // Access the WebGPU device from the renderer's backend
    const backend = renderer.backend as {
      device?: GPUDevice;
      utils?: { getDevice?: () => GPUDevice };
    };

    // Try different access patterns based on Three.js version
    if (backend.device) {
      this.device = backend.device;
    } else if (backend.utils?.getDevice) {
      this.device = backend.utils.getDevice();
    } else {
      // Try to access via _device or other internal properties
      const backendAny = backend as Record<string, GPUDevice | undefined>;
      this.device = backendAny._device ?? null;
    }

    if (!this.device) {
      console.warn(
        "[RuntimeComputeContext] Could not access WebGPU device from renderer",
      );
      return false;
    }

    this.initialized = true;
    return true;
  }

  /**
   * Initialize with a standalone WebGPU device (for testing or non-Three.js use).
   */
  async initializeStandalone(
    powerPreference: GPUPowerPreference = "high-performance",
  ): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      return false;
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference });
    if (!adapter) return false;

    this.device = await adapter.requestDevice({
      requiredFeatures: [],
      requiredLimits: {
        maxStorageBufferBindingSize: 256 * 1024 * 1024,
        maxBufferSize: 256 * 1024 * 1024,
      },
    });

    if (!this.device) return false;

    this.initialized = true;
    return true;
  }

  // ==========================================================================
  // PIPELINE MANAGEMENT
  // ==========================================================================

  /**
   * Create a compute pipeline from WGSL shader code.
   */
  createPipeline(config: ComputePipelineConfig): GPUComputePipeline | null {
    if (!this.device) return null;

    // Check cache first
    if (this.pipelines.has(config.label)) {
      return this.pipelines.get(config.label)!;
    }

    // Get or create shader module
    let shaderModule = this.shaderModules.get(config.code);
    if (!shaderModule) {
      shaderModule = this.device.createShaderModule({
        label: `${config.label}_module`,
        code: config.code,
      });
      this.shaderModules.set(config.code, shaderModule);
    }

    const pipeline = this.device.createComputePipeline({
      label: config.label,
      layout: "auto",
      compute: {
        module: shaderModule,
        entryPoint: config.entryPoint ?? "main",
      },
    });

    this.pipelines.set(config.label, pipeline);
    return pipeline;
  }

  /**
   * Get a previously created pipeline by label.
   */
  getPipeline(label: string): GPUComputePipeline | null {
    return this.pipelines.get(label) ?? null;
  }

  // ==========================================================================
  // BUFFER MANAGEMENT
  // ==========================================================================

  /**
   * Create a GPU buffer.
   */
  createBuffer(config: ComputeBufferConfig): GPUBuffer | null {
    if (!this.device) return null;

    const buffer = this.device.createBuffer({
      label: config.label,
      size: config.size,
      usage: config.usage,
      mappedAtCreation: config.mappedAtCreation ?? false,
    });

    this.buffers.set(config.label, buffer);
    return buffer;
  }

  /**
   * Create a buffer and upload data to it.
   */
  createBufferWithData(
    label: string,
    data: ArrayBufferView,
    usage: GPUBufferUsageFlags,
  ): GPUBuffer | null {
    if (!this.device) return null;

    const buffer = this.device.createBuffer({
      label,
      size: alignWebGPUBufferSize(data.byteLength),
      usage: usage | GPUBufferUsage.COPY_DST,
    });

    this.device.queue.writeBuffer(
      buffer,
      0,
      data.buffer as ArrayBuffer,
      data.byteOffset,
      data.byteLength,
    );

    this.buffers.set(label, buffer);
    return buffer;
  }

  /**
   * Create a uniform buffer with data.
   */
  createUniformBuffer(label: string, data: ArrayBufferView): GPUBuffer | null {
    return this.createBufferWithData(label, data, GPUBufferUsage.UNIFORM);
  }

  /**
   * Create a storage buffer with data.
   */
  createStorageBuffer(label: string, data: ArrayBufferView): GPUBuffer | null {
    return this.createBufferWithData(
      label,
      data,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
  }

  /**
   * Create an empty storage buffer.
   */
  createEmptyStorageBuffer(label: string, size: number): GPUBuffer | null {
    return this.createBuffer({
      label,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  /**
   * Create a staging buffer for CPU read-back.
   */
  createStagingBuffer(label: string, size: number): GPUBuffer | null {
    return this.createBuffer({
      label,
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  /**
   * Create an indirect draw buffer.
   */
  createIndirectBuffer(
    label: string,
    indexed: boolean = false,
  ): GPUBuffer | null {
    const size = indexed ? 20 : 16; // 5 or 4 u32 values
    return this.createBuffer({
      label,
      size,
      usage:
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Upload data to an existing buffer.
   */
  uploadToBuffer(
    buffer: GPUBuffer,
    data: Float32Array | Uint32Array | Int32Array | Uint8Array,
    offset = 0,
  ): void {
    if (!this.device) return;
    // Cast to handle TypeScript's strict ArrayBuffer typing for WebGPU
    this.device.queue.writeBuffer(
      buffer,
      offset,
      data.buffer as ArrayBuffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  /**
   * Get a previously created buffer by label.
   */
  getBuffer(label: string): GPUBuffer | null {
    return this.buffers.get(label) ?? null;
  }

  /**
   * Destroy a buffer and remove from cache.
   */
  destroyBuffer(label: string): void {
    const buffer = this.buffers.get(label);
    if (buffer) {
      buffer.destroy();
      this.buffers.delete(label);
    }
  }

  // ==========================================================================
  // BIND GROUP MANAGEMENT
  // ==========================================================================

  /**
   * Create a bind group for a pipeline.
   */
  createBindGroup(
    pipeline: GPUComputePipeline,
    entries: GPUBindGroupEntry[],
    label?: string,
  ): GPUBindGroup | null {
    if (!this.device) return null;

    return this.device.createBindGroup({
      label,
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
  }

  /**
   * Helper to create bind group entries from buffers.
   */
  createBindGroupEntries(
    buffers: Array<{ binding: number; buffer: GPUBuffer }>,
  ): GPUBindGroupEntry[] {
    return buffers.map(({ binding, buffer }) => ({
      binding,
      resource: { buffer },
    }));
  }

  // ==========================================================================
  // DISPATCH OPERATIONS
  // ==========================================================================

  /**
   * Dispatch a compute shader.
   */
  dispatch(config: DispatchConfig): void {
    if (!this.device) return;

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();

    pass.setPipeline(config.pipeline);
    pass.setBindGroup(0, config.bindGroup);

    if (typeof config.workgroupCount === "number") {
      pass.dispatchWorkgroups(config.workgroupCount);
    } else {
      pass.dispatchWorkgroups(
        config.workgroupCount[0],
        config.workgroupCount[1],
        config.workgroupCount[2],
      );
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Dispatch a compute shader and wait for completion.
   */
  async dispatchAndWait(config: DispatchConfig): Promise<void> {
    this.dispatch(config);
    await this.device?.queue.onSubmittedWorkDone();
  }

  /**
   * Dispatch multiple compute passes in a single command buffer.
   */
  dispatchMultiple(configs: DispatchConfig[]): void {
    if (!this.device) return;

    const encoder = this.device.createCommandEncoder();

    for (const config of configs) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(config.pipeline);
      pass.setBindGroup(0, config.bindGroup);

      if (typeof config.workgroupCount === "number") {
        pass.dispatchWorkgroups(config.workgroupCount);
      } else {
        pass.dispatchWorkgroups(
          config.workgroupCount[0],
          config.workgroupCount[1],
          config.workgroupCount[2],
        );
      }

      pass.end();
    }

    this.device.queue.submit([encoder.finish()]);
  }

  // ==========================================================================
  // STAGING BUFFER POOL
  // ==========================================================================

  /**
   * Find the appropriate size tier for a given size.
   */
  private findStagingSizeTier(size: number): number {
    for (const tier of STAGING_SIZE_TIERS) {
      if (tier >= size) return tier;
    }
    // Round up to next power of 2 for very large buffers
    return Math.pow(2, Math.ceil(Math.log2(size)));
  }

  /**
   * Acquire a staging buffer from the pool.
   */
  private acquireStagingBuffer(size: number): GPUBuffer | null {
    if (!this.device) return null;

    const tierSize = this.findStagingSizeTier(size);
    let pool = this.stagingPool.get(tierSize);

    if (!pool) {
      pool = [];
      this.stagingPool.set(tierSize, pool);
    }

    // Find an available buffer
    for (const entry of pool) {
      if (!entry.inUse) {
        entry.inUse = true;
        entry.lastUsedFrame = this.stagingPoolFrame;
        return entry.buffer;
      }
    }

    // Create new buffer if pool not full
    if (pool.length < this.stagingPoolMaxPerTier) {
      const buffer = this.device.createBuffer({
        label: `staging_pool_${tierSize}_${pool.length}`,
        size: tierSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      pool.push({
        buffer,
        size: tierSize,
        inUse: true,
        lastUsedFrame: this.stagingPoolFrame,
      });

      return buffer;
    }

    // Pool full, create temporary buffer (will be destroyed after use)
    return this.device.createBuffer({
      label: `staging_temp_${tierSize}`,
      size: tierSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  /**
   * Release a staging buffer back to the pool.
   */
  private releaseStagingBuffer(buffer: GPUBuffer): void {
    for (const pool of this.stagingPool.values()) {
      for (const entry of pool) {
        if (entry.buffer === buffer) {
          entry.inUse = false;
          return;
        }
      }
    }
    // Buffer not in pool (temporary), destroy it
    buffer.destroy();
  }

  /**
   * Clean up stale staging buffers.
   * Call periodically (e.g., every few seconds).
   */
  cleanupStagingPool(): void {
    const threshold = this.stagingPoolFrame - this.stagingPoolMaxAge;

    for (const [tierSize, pool] of this.stagingPool.entries()) {
      const filtered = pool.filter((entry) => {
        if (!entry.inUse && entry.lastUsedFrame < threshold) {
          entry.buffer.destroy();
          return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        this.stagingPool.delete(tierSize);
      } else {
        this.stagingPool.set(tierSize, filtered);
      }
    }
  }

  /**
   * Advance the staging pool frame counter.
   * Call once per frame.
   */
  advanceFrame(): void {
    this.stagingPoolFrame++;
    // Cleanup every 300 frames (~5 seconds)
    if (this.stagingPoolFrame % 300 === 0) {
      this.cleanupStagingPool();
    }
  }

  /**
   * Get staging pool statistics.
   */
  getStagingPoolStats(): { total: number; inUse: number; totalSize: number } {
    let total = 0;
    let inUse = 0;
    let totalSize = 0;

    for (const pool of this.stagingPool.values()) {
      for (const entry of pool) {
        total++;
        if (entry.inUse) inUse++;
        totalSize += entry.size;
      }
    }

    return { total, inUse, totalSize };
  }

  // ==========================================================================
  // READ-BACK OPERATIONS
  // ==========================================================================

  /**
   * Copy a buffer to a staging buffer for read-back.
   */
  copyToStagingBuffer(
    source: GPUBuffer,
    staging: GPUBuffer,
    size: number,
    sourceOffset = 0,
    stagingOffset = 0,
  ): void {
    if (!this.device) return;

    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(
      source,
      sourceOffset,
      staging,
      stagingOffset,
      size,
    );
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Read back data from a storage buffer to CPU.
   * Uses pooled staging buffers for efficiency.
   */
  async readBuffer<T extends ArrayBufferView>(
    source: GPUBuffer,
    size: number,
    ArrayType: new (buffer: ArrayBuffer) => T,
  ): Promise<T> {
    if (!this.device) throw new Error("Device not initialized");

    // Acquire staging buffer from pool
    const staging = this.acquireStagingBuffer(size);
    if (!staging) throw new Error("Failed to acquire staging buffer");

    // Copy source to staging
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);

    // Map and read
    await staging.mapAsync(GPUMapMode.READ);
    // The pool may return a larger size tier. Only requested bytes belong to
    // this result; the remaining mapped capacity can contain an older job.
    const data = new ArrayType(staging.getMappedRange().slice(0, size));

    // Release back to pool
    staging.unmap();
    this.releaseStagingBuffer(staging);

    return data;
  }

  /**
   * Read back Float32Array data from a storage buffer.
   */
  async readFloat32Buffer(
    source: GPUBuffer,
    count: number,
  ): Promise<Float32Array> {
    return this.readBuffer(source, count * 4, Float32Array);
  }

  /**
   * Read back Uint32Array data from a storage buffer.
   */
  async readUint32Buffer(
    source: GPUBuffer,
    count: number,
  ): Promise<Uint32Array> {
    return this.readBuffer(source, count * 4, Uint32Array);
  }

  // ==========================================================================
  // UTILITY METHODS
  // ==========================================================================

  /**
   * Calculate workgroup count for a given element count.
   */
  calculateWorkgroupCount(
    elementCount: number,
    workgroupSize: number = 64,
  ): number {
    return Math.ceil(elementCount / workgroupSize);
  }

  /**
   * Calculate 2D workgroup count for a given grid size.
   */
  calculateWorkgroupCount2D(
    width: number,
    height: number,
    workgroupSizeX: number = 8,
    workgroupSizeY: number = 8,
  ): [number, number, number] {
    return [
      Math.ceil(width / workgroupSizeX),
      Math.ceil(height / workgroupSizeY),
      1,
    ];
  }

  /**
   * Check if the context is ready for use.
   */
  isReady(): boolean {
    return this.initialized && this.device !== null;
  }

  /**
   * Get the underlying WebGPU device.
   */
  getDevice(): GPUDevice | null {
    return this.device;
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    // Destroy all buffers
    for (const buffer of this.buffers.values()) {
      buffer.destroy();
    }
    this.buffers.clear();

    // Destroy staging pool
    for (const pool of this.stagingPool.values()) {
      for (const entry of pool) {
        entry.buffer.destroy();
      }
    }
    this.stagingPool.clear();

    // Clear caches
    this.pipelines.clear();
    this.shaderModules.clear();

    this.device = null;
    this.initialized = false;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if WebGPU is available in the current environment.
 */
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * Check if a renderer is a WebGPU renderer.
 */
export function isWebGPURenderer(
  renderer: THREE.Renderer,
): renderer is THREE.WebGPURenderer {
  const rendererWithBackend = renderer as THREE.WebGPURenderer & {
    backend?: { isWebGPUBackend?: boolean };
  };
  return rendererWithBackend.backend?.isWebGPUBackend === true;
}

/**
 * Global singleton instance (lazy initialized).
 */
let globalContext: RuntimeComputeContext | null = null;

/**
 * Get or create the global RuntimeComputeContext.
 */
export function getGlobalComputeContext(): RuntimeComputeContext {
  if (!globalContext) {
    globalContext = new RuntimeComputeContext();
  }
  return globalContext;
}

/**
 * Initialize the global context from a renderer.
 */
export function initializeGlobalComputeContext(
  renderer: THREE.WebGPURenderer,
): boolean {
  const context = getGlobalComputeContext();
  return context.initializeFromRenderer(renderer);
}
