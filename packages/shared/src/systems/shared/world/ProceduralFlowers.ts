/**
 * ProceduralFlowers.ts - GPU Flower System
 *
 * Architecture:
 * - SpriteNodeMaterial for billboard flowers
 * - SSBO with bit-packed position, height, and visibility data
 * - Uses grass heightmap and exclusion textures for terrain integration
 * - WindManager integration for sway animation
 * - Updates every frame for stable world-space positioning
 *
 * @module ProceduralFlowers
 */

import type { Node } from "three/webgpu";
import THREE, {
  uniform,
  Fn,
  float,
  vec3,
  vec4,
  vec2,
  sin,
  uv,
  floor,
  instanceIndex,
  hash,
  step,
  texture,
  instancedArray,
  mix,
  INFINITY,
  time,
  clamp,
  max,
  PI,
  PI2,
  viewportCoordinate,
  mod,
  abs,
  add,
  sub,
  mul,
  atan,
  smoothstep,
} from "../../../extras/three/three";
import { SpriteNodeMaterial } from "three/webgpu";
import type { StorageBufferNode } from "three/webgpu";
import { System } from "../infrastructure/System";
import type { World } from "../../../types";
import { tslUtils } from "../../../utils/TSLUtils";
import { VegetationSsboUtils } from "./VegetationSsboUtils";
import { windManager } from "./Wind";
import {
  getGrassHeightmapTextureNode,
  getGrassHeightmapUniforms,
  getGrassExclusionTexture,
  getGrassGridExclusionTexture,
  getGrassRoadInfluenceTexture,
} from "./ProceduralGrass";
import { getNoiseTexture, generateNoiseTexture } from "./TerrainShader";

// TSL types - use any for dynamic TSL function signatures
type TSLFn = (...args: any[]) => any;

// ============================================================================
// ASYNC UTILITIES - Non-blocking main thread helpers
// ============================================================================

/**
 * Yield to browser event loop - allows rendering and input processing
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => resolve(), { timeout: 16 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const getConfig = () => {
  const FLOWER_WIDTH = 0.5;
  const FLOWER_HEIGHT = 1;
  const TILE_SIZE = 140; // Match grass tile size for 58m visibility
  const FLOWERS_PER_SIDE = 32; // ~1000 flowers - sparse meadow distribution
  const MIN_SCALE = 0.04; // Tiny wildflowers, barely visible
  const MAX_SCALE = 0.08; // Small delicate flowers
  return {
    MIN_SCALE,
    MAX_SCALE,
    FLOWER_WIDTH,
    FLOWER_HEIGHT,
    FLOWER_BOUNDING_SPHERE_RADIUS: FLOWER_HEIGHT,
    TILE_SIZE,
    TILE_HALF_SIZE: TILE_SIZE / 2,
    FLOWERS_PER_SIDE,
    COUNT: FLOWERS_PER_SIDE * FLOWERS_PER_SIDE,
    SPACING: TILE_SIZE / FLOWERS_PER_SIDE,
    WORKGROUP_SIZE: 64,
  };
};

const config = getConfig();

// ============================================================================
// UNIFORMS
// ============================================================================

const uniforms = {
  uPlayerDeltaXZ: uniform(new THREE.Vector2(0, 0)),
  uPlayerPosition: uniform(new THREE.Vector3(0, 0, 0)),
  uCameraPosition: uniform(new THREE.Vector3(0, 0, 0)), // For distance culling
  uCameraForward: uniform(new THREE.Vector3(0, 0, 0)),
  // Culling
  uCameraMatrix: uniform(new THREE.Matrix4()),
  uFx: uniform(1.0),
  uFy: uniform(1.0),
  uCullPadNDCX: uniform(0.075),
  uCullPadNDCYNear: uniform(0.75),
  uCullPadNDCYFar: uniform(0.2),
  // Flower-specific distance culling - match grass distances
  // Grass: R0=36m, R1=54m, FadeStart=54m, FadeEnd=58m
  uR0: uniform(36), // Full density within 36m (match grass)
  uR1: uniform(54), // Thin to minimum by 54m (match grass)
  uPMin: uniform(0.03), // Keep 3% at outer edge
  uFadeStart: uniform(54), // Start Bayer dither at 54m (match grass)
  uFadeEnd: uniform(58), // Fully faded by 58m (match grass)
  // Tint colors - muted, natural tones
  uColor1: uniform(new THREE.Color().setRGB(0.02, 0.1, 0.25)),
  uColor2: uniform(new THREE.Color().setRGB(0.7, 0.5, 0.0)),
  uColorStrength: uniform(0.15), // Reduced for subtle appearance
};

// Noise texture for position variation
let flowerNoiseTexture: THREE.Texture | null = null;
// Flower atlas texture (optional - uses procedural if not available)
let flowerAtlasTexture: THREE.Texture | null = null;
// Terrain noise texture - SHARED with TerrainShader and ProceduralGrass for consistent dirt detection
let terrainNoiseTexture: THREE.Texture | null = null;

// ============================================================================
// FLOWER SSBO - Bit-packed data structure
// ============================================================================
// x -> offsetX
// y -> offsetZ
// z -> 0/12 offsetY - 12/1 visibility (11 unused)
// w -> noise packed (0/6 r, 6/6 g, 12/6 b, 18/6 a)

type InstancedArrayBuffer = StorageBufferNode<"vec4">;

// Max height for bit-packing (matches grass heightmap max)
const HEIGHTMAP_MAX = 100;

class FlowerSsbo {
  private buffer: InstancedArrayBuffer;

  // Track initialization state
  private _initialized = false;

  constructor() {
    this.buffer = instancedArray(config.COUNT, "vec4");
    // NOTE: We DO NOT use onInit callback here anymore!
    // This caused first-frame spikes because computeInit ran during gameplay.
    // Instead, call runInitialization() explicitly during loading.
  }

  /**
   * Run compute initialization explicitly during loading phase.
   * This avoids first-frame spikes by pre-running heavy compute work.
   * @returns Promise that resolves when initialization is complete
   */
  async runInitialization(renderer: THREE.WebGPURenderer): Promise<void> {
    if (this._initialized) return;

    console.log("[ProceduralFlowers] Running SSBO compute initialization...");
    const startTime = performance.now();

    // Run compute init - this populates all flower positions
    await renderer.computeAsync(this.computeInit);

    this._initialized = true;
    console.log(
      `[ProceduralFlowers] SSBO init complete: ${(performance.now() - startTime).toFixed(1)}ms`,
    );
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get computeBuffer(): InstancedArrayBuffer {
    return this.buffer;
  }

  // ============================================================================
  // UNPACKING FUNCTIONS
  // ============================================================================

  // @ts-expect-error TSL Fn with array destructuring params - dynamic typing
  getYOffset: TSLFn = Fn(([data = vec4(0)]) => {
    return tslUtils.unpackUnits(data.z, 0, 12, 0, HEIGHTMAP_MAX);
  });

  // @ts-expect-error TSL Fn with array destructuring params - dynamic typing
  getVisibility: TSLFn = Fn(([data = vec4(0)]) => {
    return tslUtils.unpackFlag(data.z, 12);
  });

  // @ts-expect-error TSL Fn with array destructuring params - dynamic typing
  getNoise: TSLFn = Fn(([data = vec4(0)]) => {
    const x = tslUtils.unpackUnit(data.w, 0, 6);
    const y = tslUtils.unpackUnit(data.w, 6, 6);
    const z = tslUtils.unpackUnit(data.w, 12, 6);
    const w = tslUtils.unpackUnit(data.w, 18, 6);
    return vec4(x, y, z, w);
  });

  // ============================================================================
  // PACKING FUNCTIONS
  // ============================================================================

  // @ts-expect-error TSL Fn with array destructuring params - dynamic typing
  private setYOffset: TSLFn = Fn(([data = vec4(0), value = float(0)]) => {
    data.z = tslUtils.packUnits(data.z, 0, 12, value, 0, HEIGHTMAP_MAX);
    return data;
  });

  // @ts-expect-error TSL Fn with array destructuring params - dynamic typing
  private setVisibility: TSLFn = Fn(([data = vec4(0), value = float(0)]) => {
    data.z = tslUtils.packFlag(data.z, 12, value);
    return data;
  });

  // @ts-expect-error TSL Fn with array destructuring params - dynamic typing
  private setNoise: TSLFn = Fn(([data = vec4(0), value = vec4(0)]) => {
    data.w = tslUtils.packUnit(data.w, 0, 6, value.x);
    data.w = tslUtils.packUnit(data.w, 6, 6, value.y);
    data.w = tslUtils.packUnit(data.w, 12, 6, value.z);
    data.w = tslUtils.packUnit(data.w, 18, 6, value.a);
    return data;
  });

  // ============================================================================
  // COMPUTE INIT
  // ============================================================================

  computeInit = Fn(() => {
    const data = this.buffer.element(instanceIndex);

    // Position XZ in grid
    const row = floor(float(instanceIndex).div(config.FLOWERS_PER_SIDE));
    const col = float(instanceIndex).mod(config.FLOWERS_PER_SIDE);

    const randX = hash(instanceIndex.add(4321));
    const randZ = hash(instanceIndex.add(1234));
    const offsetX = col
      .mul(config.SPACING)
      .sub(config.TILE_HALF_SIZE)
      .add(randX.mul(config.SPACING * 0.5));
    const offsetZ = row
      .mul(config.SPACING)
      .sub(config.TILE_HALF_SIZE)
      .add(randZ.mul(config.SPACING * 0.5));

    // UV for noise sampling
    const _uv = vec3(offsetX, 0, offsetZ)
      .xz.add(config.TILE_HALF_SIZE)
      .div(config.TILE_SIZE)
      .abs();

    // Sample noise for position variation
    // Use hash as fallback since it's always available
    const noiseR = flowerNoiseTexture
      ? texture(flowerNoiseTexture, _uv).r
      : hash(instanceIndex.mul(0.73));
    const noiseG = flowerNoiseTexture
      ? texture(flowerNoiseTexture, _uv).g
      : hash(instanceIndex.mul(1.27));
    const noiseB = flowerNoiseTexture
      ? texture(flowerNoiseTexture, _uv).b
      : hash(instanceIndex.mul(0.91));
    const noiseA = flowerNoiseTexture
      ? texture(flowerNoiseTexture, _uv).a
      : hash(instanceIndex.mul(1.53));

    const noiseVec = vec4(noiseR, noiseG, noiseB, noiseA);
    data.assign(this.setNoise(data, noiseVec));
    const wrapNoise = noiseR;

    const noiseX = wrapNoise.mul(99.37);
    const noiseZ = wrapNoise.mul(49.71);

    data.x = offsetX.add(noiseX);
    data.y = offsetZ.add(noiseZ);
  })().compute(config.COUNT, [config.WORKGROUP_SIZE]);

  // ============================================================================
  // COMPUTE UPDATE
  // ============================================================================

  computeUpdate = Fn(() => {
    const data = this.buffer.element(instanceIndex);

    // Position wrapping using shared utility
    const pos = VegetationSsboUtils.wrapPosition(
      vec2(data.x, data.y),
      uniforms.uPlayerDeltaXZ,
      config.TILE_SIZE,
    );

    data.x = pos.x;
    data.y = pos.z;

    // Local offset from player
    const offsetX = pos.x;
    const offsetZ = pos.z;

    // World position = local offset + player/camera position
    const worldX = offsetX.add(uniforms.uPlayerPosition.x);
    const worldZ = offsetZ.add(uniforms.uPlayerPosition.z);

    // Sample heightmap for Y position using GRASS HEIGHTMAP (same as grass system)
    // This ensures flowers are placed on the exact same terrain as grass
    const grassHeightmap = getGrassHeightmapTextureNode();
    const grassUniforms = getGrassHeightmapUniforms();

    // Calculate heightmap UVs (needed for both height and slope calculation)
    const halfWorld = grassUniforms.uHeightmapWorldSize.mul(0.5);
    const hmUvX = worldX
      .sub(grassUniforms.uHeightmapCenterX)
      .add(halfWorld)
      .div(grassUniforms.uHeightmapWorldSize);
    const hmUvZ = worldZ
      .sub(grassUniforms.uHeightmapCenterZ)
      .add(halfWorld)
      .div(grassUniforms.uHeightmapWorldSize);
    const hmUV = vec2(
      hmUvX.clamp(float(0.001), float(0.999)),
      hmUvZ.clamp(float(0.001), float(0.999)),
    );

    let heightmapY: Node<"float">;
    if (grassHeightmap) {
      const hmSample = grassHeightmap.sample(hmUV);
      heightmapY = hmSample.r.mul(grassUniforms.uHeightmapMax);
    } else {
      // Fallback: use player Y level
      heightmapY = uniforms.uPlayerPosition.y;
    }

    // Store Y offset
    data.assign(this.setYOffset(data, heightmapY));

    // World position with height for visibility check
    const worldPos = vec3(worldX, heightmapY, worldZ);

    // Visibility check using shared utility
    const isVisible = VegetationSsboUtils.computeVisibility(
      worldPos,
      uniforms.uCameraMatrix,
      uniforms.uFx,
      uniforms.uFy,
      config.FLOWER_BOUNDING_SPHERE_RADIUS,
      uniforms.uCullPadNDCX,
      uniforms.uCullPadNDCYNear,
      uniforms.uCullPadNDCYFar,
    );

    // ============================================================================
    // EXCLUSION CHECK - Same as grass for consistent building/road exclusion
    // ============================================================================

    // Grid-based exclusion (CollisionMatrix blocked tiles)
    const gridExclusion = getGrassGridExclusionTexture();
    const gridNotExcluded = float(1.0).toVar();
    if (gridExclusion.isEnabled && gridExclusion.textureNode) {
      const gridHalfWorld = gridExclusion.uWorldSize.mul(0.5);
      const gridUvX = worldX
        .sub(gridExclusion.uCenterX)
        .add(gridHalfWorld)
        .div(gridExclusion.uWorldSize);
      const gridUvZ = worldZ
        .sub(gridExclusion.uCenterZ)
        .add(gridHalfWorld)
        .div(gridExclusion.uWorldSize);
      const gridUV = vec2(
        gridUvX.clamp(0.001, 0.999),
        gridUvZ.clamp(0.001, 0.999),
      );
      const gridExclusionValue = gridExclusion.textureNode.sample(gridUV).r;
      gridNotExcluded.assign(float(1).sub(gridExclusionValue));
    }

    // Legacy texture exclusion (buildings, duel arenas)
    // Use same thresholds as grass for consistent building edge behavior
    const legacyExclusion = getGrassExclusionTexture();
    const legacyHalfWorld = legacyExclusion.uWorldSize.mul(0.5);
    const legacyUvX = worldX
      .sub(legacyExclusion.uCenterX)
      .add(legacyHalfWorld)
      .div(legacyExclusion.uWorldSize);
    const legacyUvZ = worldZ
      .sub(legacyExclusion.uCenterZ)
      .add(legacyHalfWorld)
      .div(legacyExclusion.uWorldSize);
    const legacyUV = vec2(
      legacyUvX.clamp(0.001, 0.999),
      legacyUvZ.clamp(0.001, 0.999),
    );
    const legacyExclusionValue = legacyExclusion.textureNode.sample(legacyUV).r;
    // Hard cutoff with dithering - flowers within 0.1m of building edge are hidden
    // Matches grass threshold (exclusion > 0.6 = hidden)
    const legacyDitherRand = hash(float(instanceIndex).mul(11.45));
    const legacyNotExcluded = step(
      legacyExclusionValue,
      float(0.6).add(legacyDitherRand.mul(0.2)),
    );

    // ============================================================================
    // BIOME CHECKS - Same as grass: no flowers on roads, dirt, sand
    // Uses SAME noise texture as TerrainShader and ProceduralGrass for consistency
    // ============================================================================

    // Road influence culling - sample road texture directly
    const roadInfluence = getGrassRoadInfluenceTexture();
    const hasRoadData = step(float(2), roadInfluence.uWorldSize);
    const roadHalfWorld = roadInfluence.uWorldSize.mul(0.5);
    const roadDx = abs(worldX.sub(roadInfluence.uCenterX));
    const roadDz = abs(worldZ.sub(roadInfluence.uCenterZ));
    const insideMask = step(roadDx, roadHalfWorld).mul(
      step(roadDz, roadHalfWorld),
    );
    const useMask = hasRoadData.mul(insideMask);
    const roadUvX = worldX
      .sub(roadInfluence.uCenterX)
      .add(roadHalfWorld)
      .div(roadInfluence.uWorldSize);
    const roadUvZ = worldZ
      .sub(roadInfluence.uCenterZ)
      .add(roadHalfWorld)
      .div(roadInfluence.uWorldSize);
    const roadUV = vec2(
      roadUvX.clamp(0.001, 0.999),
      roadUvZ.clamp(0.001, 0.999),
    );
    const roadValue = roadInfluence.textureNode.sample(roadUV).r;
    const roadDitherRand = hash(float(instanceIndex).mul(9.12));
    const _notOnRoad = mix(
      float(1.0),
      step(roadValue, roadInfluence.uThreshold.add(roadDitherRand.mul(0.15))),
      useMask,
    );

    // Dirt patch detection - MUST use same noise texture as TerrainShader and ProceduralGrass
    // to ensure flowers are excluded from the EXACT same dirt patches
    const TERRAIN_NOISE_SCALE = 0.0008;
    const DIRT_THRESHOLD = 0.5;

    // Sample terrain noise at world position - MATCHES grass exactly
    const noiseUV = vec2(worldX, worldZ).mul(TERRAIN_NOISE_SCALE);
    let terrainNoiseValue: Node<"float">;
    if (terrainNoiseTexture) {
      // Use shared terrain noise texture for exact dirt patch matching
      terrainNoiseValue = texture(terrainNoiseTexture, noiseUV).r;
    } else {
      // Hash fallback - MUST match grass fallback: same scale for x and z
      terrainNoiseValue = hash(
        worldX
          .mul(TERRAIN_NOISE_SCALE * 1000)
          .add(worldZ.mul(TERRAIN_NOISE_SCALE * 1000)),
      );
    }

    // Dirt patch factor - smoothstep(0.45, 0.65, noiseValue) - MATCHES TerrainShader.ts exactly
    const dirtPatchFactor = smoothstep(
      float(DIRT_THRESHOLD - 0.05),
      float(DIRT_THRESHOLD + 0.15),
      terrainNoiseValue,
    );

    // Calculate slope from heightmap for slope-based culling
    // Sample neighboring heights
    const slopeEpsilon = float(1.0);
    const hmUvRight = vec2(
      hmUvX
        .add(slopeEpsilon.div(grassUniforms.uHeightmapWorldSize))
        .clamp(0.001, 0.999),
      hmUvZ.clamp(0.001, 0.999),
    );
    const hmUvForward = vec2(
      hmUvX.clamp(0.001, 0.999),
      hmUvZ
        .add(slopeEpsilon.div(grassUniforms.uHeightmapWorldSize))
        .clamp(0.001, 0.999),
    );
    const hCenter = heightmapY;
    const hRight = grassHeightmap
      ? grassHeightmap.sample(hmUvRight).r.mul(grassUniforms.uHeightmapMax)
      : heightmapY;
    const hForward = grassHeightmap
      ? grassHeightmap.sample(hmUvForward).r.mul(grassUniforms.uHeightmapMax)
      : heightmapY;

    // Compute slope (0 = flat, 1 = vertical)
    const dx = hRight.sub(hCenter);
    const dz = hForward.sub(hCenter);
    const normalY = float(1.0).div(
      float(1.0).add(dx.mul(dx)).add(dz.mul(dz)).pow(0.5),
    );
    const slope = float(1.0).sub(normalY.abs());

    // Flatness for dirt patches (dirt patches only on flat ground)
    const flatnessFactor = smoothstep(float(0.3), float(0.05), slope);

    // Slope-based suppression - MATCHES GRASS EXACTLY
    const slopeFactor = smoothstep(float(0.25), float(0.6), slope);

    // Combined dirt factor - MATCHES GRASS EXACTLY
    const _combinedDirtFactor = max(
      dirtPatchFactor.mul(flatnessFactor).mul(0.7), // Reduce dirt patch impact
      slopeFactor.mul(0.6), // Reduce slope impact
    );

    // Dithered culling on dirt - MATCHES GRASS EXACTLY (wider range for smooth transition)
    const dirtDitherRand = hash(float(instanceIndex).mul(5.67));
    const _notOnDirt = step(_combinedDirtFactor, dirtDitherRand.mul(0.5)); // 0-0.5 dither range

    // Sand zone (6-10m height on flat ground) - no flowers on beaches
    const sandZone = smoothstep(float(10.0), float(6.0), heightmapY).mul(
      flatnessFactor,
    );
    const sandDitherRand = hash(float(instanceIndex).mul(6.78));
    const _notOnSand = step(sandZone.mul(0.8), sandDitherRand.mul(0.4));

    // Water zone - no flowers below water level (5m)
    const waterDitherRand = hash(float(instanceIndex).mul(7.89));
    const waterFade = smoothstep(float(5.0), float(6.0), heightmapY);
    const _aboveWater = step(waterDitherRand, waterFade);

    // Combine: all must allow flowers
    const notExcluded = gridNotExcluded
      .mul(legacyNotExcluded)
      .mul(_notOnRoad)
      .mul(_notOnDirt)
      .mul(_notOnSand)
      .mul(_aboveWater);

    // Combined visibility
    const finalVisibility = isVisible.mul(notExcluded);
    data.assign(this.setVisibility(data, finalVisibility));
  })().compute(config.COUNT, [config.WORKGROUP_SIZE]);
}

// ============================================================================
// FLOWER MATERIAL
// ============================================================================

class FlowerMaterial extends SpriteNodeMaterial {
  private ssbo: FlowerSsbo;

  constructor(ssbo: FlowerSsbo) {
    super();
    this.ssbo = ssbo;
    this.createFlowerMaterial();
  }

  private createFlowerMaterial(): void {
    this.precision = "lowp";
    this.stencilWrite = false;
    this.forceSinglePass = true;
    this.transparent = true; // Enable for dithered fade

    const data = this.ssbo.computeBuffer.element(instanceIndex);
    const isVisible = this.ssbo.getVisibility(data);
    const x = data.x;
    const y = this.ssbo.getYOffset(data);
    const z = data.y;

    const rand1 = hash(instanceIndex.add(9234));
    const rand2 = hash(instanceIndex.add(33.87));

    // === DISTANCE-BASED CULLING - FLOWER-SPECIFIC (SHORTER than grass) ===
    // Flowers fade closer than grass to reduce visual noise and popping at distance
    // Grass: R0=8m, R1=14m, FadeStart=14m, FadeEnd=18m
    // Flowers: R0=6m, R1=10m, FadeStart=10m, FadeEnd=14m

    // Distance from camera (x,z are local offsets from mesh center which follows camera)
    const distSq = x.mul(x).add(z.mul(z));

    // Stochastic distance culling with flower-specific distances
    const R0 = uniforms.uR0;
    const R1 = uniforms.uR1;
    const pMin = uniforms.uPMin;
    const R0Sq = R0.mul(R0);
    const R1Sq = R1.mul(R1);
    const t = clamp(
      distSq.sub(R0Sq).div(max(R1Sq.sub(R0Sq), float(0.00001))),
      0.0,
      1.0,
    );
    const p = mix(float(1.0), pMin, t); // 1 at center, pMin at edge
    const rnd = hash(float(instanceIndex).mul(0.73));
    const stochasticKeep = step(rnd, p);

    // Distance fade with Bayer dithering - flower-specific shorter range
    const fadeStartSq = uniforms.uFadeStart.mul(uniforms.uFadeStart);
    const fadeEndSq = uniforms.uFadeEnd.mul(uniforms.uFadeEnd);
    const linearFade = float(1.0).sub(
      clamp(
        distSq
          .sub(fadeStartSq)
          .div(max(fadeEndSq.sub(fadeStartSq), float(0.001))),
        0.0,
        1.0,
      ),
    );
    const ditherRand = hash(float(instanceIndex).mul(1.31));
    const ditherVisible = step(ditherRand, linearFade);

    // Combined visibility
    const finalVisible = isVisible.mul(stochasticKeep).mul(ditherVisible);

    // NATURAL WIND - noise-modulated, not pure sinusoidal
    const windIntensity = windManager.uIntensity;
    const windDirection = windManager.uDirection;

    // Per-instance frequency variation (breaks uniform oscillation)
    const freqX = rand1.mul(0.4).add(0.8); // 0.8-1.2x base
    const freqZ = rand2.mul(0.3).add(0.85); // 0.85-1.15x base
    const phaseX = rand1.mul(PI2);
    const phaseZ = rand2.mul(PI2);

    // Layer multiple frequencies for organic motion
    const baseSpeed = float(0.8).add(windIntensity.mul(0.3));
    const sway1X = sin(time.mul(baseSpeed.mul(freqX)).add(phaseX));
    const sway2X = sin(
      time.mul(baseSpeed.mul(freqX).mul(1.7)).add(phaseX.mul(0.6)),
    );
    const sway1Z = sin(time.mul(baseSpeed.mul(freqZ).mul(0.9)).add(phaseZ));
    const sway2Z = sin(
      time.mul(baseSpeed.mul(freqZ).mul(1.5)).add(phaseZ.mul(0.8)),
    );

    // Blend layers for natural movement
    const swayX = sway1X.mul(0.6).add(sway2X.mul(0.3)).mul(0.08);
    const swayY = rand2.mul(0.2); // Static height variation
    const swayZ = sway1Z.mul(0.5).add(sway2Z.mul(0.35)).mul(0.06);

    // Add wind direction influence
    const windSwayX = swayX.add(windDirection.x.mul(windIntensity).mul(0.15));
    const windSwayZ = swayZ.add(windDirection.y.mul(windIntensity).mul(0.15));
    const swayOffset = vec3(windSwayX, swayY, windSwayZ);

    // INFINITY offset for invisible flowers
    const offscreenOffset = uniforms.uCameraForward
      .mul(INFINITY)
      .mul(float(1).sub(finalVisible));

    const offsetX = x.add(windDirection.x.mul(windIntensity).mul(0.3));
    // Height offset: 0.02-0.15 range - flowers sit low in the grass
    // Grass blade height is 0.5m, so flowers should peek just above ground
    const baseHeight = rand1.mul(0.13).add(0.02);
    const offsetY = y.add(baseHeight);
    const offsetZ = z.add(windDirection.y.mul(windIntensity).mul(0.3));
    const basePosition = vec3(offsetX, offsetY, offsetZ);
    this.positionNode = basePosition.add(swayOffset).add(offscreenOffset);

    // Size - uniform scale to avoid stretching (flower sprites are square)
    const baseScale = rand1.remap(
      float(0),
      float(1),
      float(config.MIN_SCALE),
      float(config.MAX_SCALE),
    );
    this.scaleNode = vec3(baseScale, baseScale, baseScale);

    // OLD SCHOOL 8x8 BAYER SCREEN-SPACE DITHERING for flowers
    const fragCoord = viewportCoordinate;
    const ix = mod(floor(fragCoord.x), float(8.0));
    const iy = mod(floor(fragCoord.y), float(8.0));

    // 8x8 Bayer matrix calculation
    const bit0_x = mod(ix, float(2.0));
    const bit1_x = mod(floor(mul(ix, float(0.5))), float(2.0));
    const bit2_x = floor(mul(ix, float(0.25)));
    const bit0_y = mod(iy, float(2.0));
    const bit1_y = mod(floor(mul(iy, float(0.5))), float(2.0));
    const bit2_y = floor(mul(iy, float(0.25)));

    const xor0 = abs(sub(bit0_x, bit0_y));
    const xor1 = abs(sub(bit1_x, bit1_y));
    const xor2 = abs(sub(bit2_x, bit2_y));

    const bayerInt = add(
      add(
        add(mul(xor0, float(32.0)), mul(bit0_y, float(16.0))),
        add(mul(xor1, float(8.0)), mul(bit1_y, float(4.0))),
      ),
      add(mul(xor2, float(2.0)), bit2_y),
    );
    const bayerThreshold = mul(bayerInt, float(0.015625)); // 1/64

    // Distance-based Bayer fade (x, z are local offsets from mesh center)
    const distFromCamSq = x.mul(x).add(z.mul(z));
    // Reuse fadeStartSq and fadeEndSq from earlier distance fade calculation
    const distFade = float(1.0).sub(
      clamp(
        distFromCamSq
          .sub(fadeStartSq)
          .div(max(fadeEndSq.sub(fadeStartSq), float(0.001))),
        0.0,
        1.0,
      ),
    );
    const bayerFadeVisible = step(bayerThreshold, distFade);

    // Diffuse color
    if (flowerAtlasTexture) {
      // Use flower atlas texture if available
      const flower = texture(flowerAtlasTexture, uv());
      const tint = mix(uniforms.uColor1, uniforms.uColor2, rand2);
      const sign = step(rand2, rand1).mul(2).sub(1);
      const color = mix(tint, flower.xyz, rand1.add(rand2.mul(sign)));
      this.colorNode = color.mul(uniforms.uColorStrength);
      this.opacityNode = finalVisible.mul(flower.w).mul(bayerFadeVisible);
      this.alphaTest = 0.1;
    } else {
      // Procedural wildflower colors - natural meadow tones
      // White/cream daisies, yellow buttercups, purple clover, pink/red poppies, blue forget-me-nots
      const white = vec3(0.95, 0.93, 0.88);
      const cream = vec3(0.95, 0.9, 0.75);
      const yellow = vec3(0.9, 0.8, 0.2);
      const purple = vec3(0.6, 0.4, 0.7);
      const pink = vec3(0.85, 0.5, 0.55);
      const blue = vec3(0.4, 0.55, 0.85);
      const red = vec3(0.8, 0.25, 0.2);

      // Select flower type (0-6) based on random
      const flowerType = floor(rand2.mul(7));

      // UV coordinates centered at 0
      const uvCoord = uv().sub(0.5);
      const dist = uvCoord.length();
      const angle = atan(uvCoord.y, uvCoord.x);

      // Flower type 0-1: Daisy (white/cream petals, yellow center)
      // Petals using polar coordinates with sin modulation
      const daisyPetals = float(8).add(rand1.mul(4)); // 8-12 petals
      const daisyPetalShape = sin(angle.mul(daisyPetals)).mul(0.5).add(0.5);
      const daisyRadius = float(0.35).add(daisyPetalShape.mul(0.1));
      const daisyMask = smoothstep(daisyRadius.add(0.02), daisyRadius, dist);
      const daisyCenter = smoothstep(float(0.12), float(0.08), dist);
      const daisyPetalColor = mix(white, cream, rand1);
      const daisyColor = mix(daisyPetalColor, yellow, daisyCenter);

      // Flower type 2: Buttercup (simple yellow 5 petals)
      const buttercupPetals = float(5);
      const buttercupShape = sin(angle.mul(buttercupPetals).add(PI.mul(0.5)))
        .mul(0.5)
        .add(0.5);
      const buttercupRadius = float(0.3).add(buttercupShape.mul(0.12));
      const buttercupMask = smoothstep(
        buttercupRadius.add(0.02),
        buttercupRadius,
        dist,
      );
      const buttercupCenter = smoothstep(float(0.08), float(0.05), dist);
      const buttercupColor = mix(yellow, yellow.mul(0.7), buttercupCenter);

      // Flower type 3: Clover (purple/pink fuzzy ball)
      const cloverNoise = sin(angle.mul(12).add(dist.mul(20)))
        .mul(0.5)
        .add(0.5);
      const cloverRadius = float(0.32).add(cloverNoise.mul(0.08));
      const cloverMask = smoothstep(cloverRadius.add(0.03), cloverRadius, dist);
      const cloverColor = mix(purple, pink, rand1.mul(0.5));

      // Flower type 4: Forget-me-not (tiny blue 5 petals, white center)
      const forgetPetals = float(5);
      const forgetShape = sin(angle.mul(forgetPetals)).mul(0.5).add(0.5);
      const forgetRadius = float(0.28).add(forgetShape.mul(0.15));
      const forgetMask = smoothstep(forgetRadius.add(0.02), forgetRadius, dist);
      const forgetCenter = smoothstep(float(0.1), float(0.06), dist);
      const forgetColor = mix(blue, white, forgetCenter);

      // Flower type 5: Poppy (red 4 petals, dark center)
      const poppyPetals = float(4);
      const poppyShape = sin(angle.mul(poppyPetals).add(PI.mul(0.25)))
        .mul(0.5)
        .add(0.5);
      const poppyRadius = float(0.32).add(poppyShape.mul(0.1));
      const poppyMask = smoothstep(poppyRadius.add(0.02), poppyRadius, dist);
      const poppyCenter = smoothstep(float(0.1), float(0.06), dist);
      const poppyColor = mix(red, vec3(0.15, 0.1, 0.1), poppyCenter);

      // Flower type 6: Simple dot (tiny colored dot)
      const dotMask = smoothstep(float(0.2), float(0.15), dist);
      const dotColorMix = floor(rand1.mul(4));
      const dotColor1 = mix(yellow, pink, step(float(1), dotColorMix));
      const dotColor2 = mix(dotColor1, white, step(float(2), dotColorMix));
      const dotColor = mix(dotColor2, purple, step(float(3), dotColorMix));

      // Select flower based on type
      const isDaisy = step(flowerType, float(1.5)); // types 0-1
      const isButtercup = step(float(1.5), flowerType).mul(
        step(flowerType, float(2.5)),
      );
      const isClover = step(float(2.5), flowerType).mul(
        step(flowerType, float(3.5)),
      );
      const isForget = step(float(3.5), flowerType).mul(
        step(flowerType, float(4.5)),
      );
      const isPoppy = step(float(4.5), flowerType).mul(
        step(flowerType, float(5.5)),
      );
      const isDot = step(float(5.5), flowerType);

      // Combine masks
      const flowerMask = daisyMask
        .mul(isDaisy)
        .add(buttercupMask.mul(isButtercup))
        .add(cloverMask.mul(isClover))
        .add(forgetMask.mul(isForget))
        .add(poppyMask.mul(isPoppy))
        .add(dotMask.mul(isDot));

      // Combine colors
      const flowerColor = daisyColor
        .mul(isDaisy)
        .add(buttercupColor.mul(isButtercup))
        .add(cloverColor.mul(isClover))
        .add(forgetColor.mul(isForget))
        .add(poppyColor.mul(isPoppy))
        .add(dotColor.mul(isDot));

      this.colorNode = flowerColor.mul(float(0.8).add(rand1.mul(0.4))); // Slight brightness variation
      this.opacityNode = finalVisible.mul(flowerMask).mul(bayerFadeVisible);
      this.alphaTest = 0.1;
    }
  }
}

// ============================================================================
// MAIN FLOWER SYSTEM
// ============================================================================

export class ProceduralFlowerSystem extends System {
  private mesh: THREE.InstancedMesh | null = null;
  private ssbo: FlowerSsbo | null = null;
  private material: FlowerMaterial | null = null;
  private renderer: THREE.WebGPURenderer | null = null;
  private flowersInitialized = false;

  // Track camera position for proper delta calculation (world-stable positioning)
  private lastCameraX = 0;
  private lastCameraZ = 0;

  // Textures
  private noiseTexture: THREE.Texture | null = null;
  private atlasTexture: THREE.Texture | null = null;
  private terrainNoiseTexture: THREE.Texture | null = null;

  constructor(world: World) {
    super(world);
  }

  getDependencies() {
    // Flowers depend on grass for shared heightmap texture
    return { required: [], optional: ["graphics", "terrain", "grass"] };
  }

  async start(): Promise<void> {
    if (!this.world.isClient || typeof window === "undefined") return;

    this.renderer =
      (
        this.world.getSystem("graphics") as {
          renderer?: THREE.WebGPURenderer;
        } | null
      )?.renderer ?? null;

    const stage = this.world.stage as { scene?: THREE.Scene } | null;
    if (!stage?.scene) {
      setTimeout(() => this.initializeFlowers(), 100);
      return;
    }

    await this.initializeFlowers();
  }

  private async loadTextures(): Promise<void> {
    const loader = new THREE.TextureLoader();

    // Load noise texture
    const noisePromise = new Promise<THREE.Texture>((resolve, reject) => {
      loader.load(
        "/textures/noise.png",
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          resolve(tex);
        },
        undefined,
        () => reject(new Error("Failed to load noise texture")),
      );
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[ProceduralFlowers] Noise texture load failed:", message);
      return null;
    });

    const noise = await noisePromise;
    if (noise) {
      this.noiseTexture = noise;
      flowerNoiseTexture = noise;
      console.log("[ProceduralFlowers] Loaded noise texture");
    }

    // Try to load flower atlas (optional)
    const atlasPromise = new Promise<THREE.Texture>((resolve, reject) => {
      loader.load(
        "/textures/edelweiss.png",
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          resolve(tex);
        },
        undefined,
        () => reject(new Error("Failed to load flower atlas")),
      );
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[ProceduralFlowers] Atlas texture load failed:", message);
      return null;
    });

    const atlas = await atlasPromise;
    if (atlas) {
      this.atlasTexture = atlas;
      flowerAtlasTexture = atlas;
      console.log("[ProceduralFlowers] Loaded flower atlas texture");
    } else {
      console.log("[ProceduralFlowers] Using procedural flower colors");
    }

    // Load terrain noise texture - SHARED with TerrainShader and ProceduralGrass
    // This ensures flowers respect the EXACT same dirt patches as grass and terrain
    let terrainNoise = getNoiseTexture();
    if (!terrainNoise) {
      // Generate it if terrain hasn't yet (shouldn't happen normally)
      terrainNoise = generateNoiseTexture();
    }
    if (terrainNoise) {
      this.terrainNoiseTexture = terrainNoise;
      terrainNoiseTexture = terrainNoise;
      console.log(
        "[ProceduralFlowers] Using terrain's noise texture for consistent dirt patches",
      );
    } else {
      console.log(
        "[ProceduralFlowers] Using hash fallback for noise (terrain noise unavailable)",
      );
    }
  }

  private async initializeFlowers(): Promise<void> {
    if (this.flowersInitialized) return;

    const stage = this.world.stage as { scene?: THREE.Scene } | null;
    if (!stage?.scene) {
      setTimeout(() => this.initializeFlowers(), 100);
      return;
    }

    this.renderer ??=
      (
        this.world.getSystem("graphics") as {
          renderer?: THREE.WebGPURenderer;
        } | null
      )?.renderer ?? null;

    if (!this.renderer) {
      console.warn("[ProceduralFlowers] No WebGPU renderer available");
      return;
    }

    // Wait for grass heightmap to be ready (flowers depend on it)
    // The grass system must initialize first so we can share its heightmap
    let retries = 0;
    const maxRetries = 50; // 5 seconds max wait
    while (!getGrassHeightmapTextureNode() && retries < maxRetries) {
      // Avoid per-frame log spam while still showing coarse progress in dev.
      if (retries === 0 || (retries + 1) % 10 === 0) {
        console.log(
          `[ProceduralFlowers] Waiting for grass heightmap... (${retries + 1}/${maxRetries})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      retries++;
    }

    if (!getGrassHeightmapTextureNode()) {
      console.warn(
        "[ProceduralFlowers] Grass heightmap not available after timeout - flowers will use player Y level",
      );
    } else {
      console.log(
        "[ProceduralFlowers] Grass heightmap ready, proceeding with initialization",
      );
    }

    const initStartTime = performance.now();
    console.log("[ProceduralFlowers] Starting async initialization...");

    // Load textures first
    await this.loadTextures();

    // Create SSBO
    this.ssbo = new FlowerSsbo();

    // Create material
    this.material = new FlowerMaterial(this.ssbo);

    // Create geometry (simple plane)
    const geometry = new THREE.PlaneGeometry(1, 1);

    // Create instanced mesh
    this.mesh = new THREE.InstancedMesh(geometry, this.material, config.COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.name = "ProceduralFlowers_GPU";
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    // Render order: Flowers render AFTER player silhouette (50) but BEFORE player (100)
    this.mesh.renderOrder = 76;

    // Layer 1 = main camera only (excludes minimap and reflection cameras)
    this.mesh.layers.set(1);

    stage.scene.add(this.mesh);

    // Initialize camera tracking to current position to prevent first-frame jump
    const camera = this.world.camera;
    if (camera) {
      this.lastCameraX = camera.position.x;
      this.lastCameraZ = camera.position.z;
      this.mesh.position.set(camera.position.x, 0, camera.position.z);
    }

    // Pre-run GPU compute initialization during loading
    // This is the KEY OPTIMIZATION - run heavy compute BEFORE gameplay starts
    console.log(
      "[ProceduralFlowers] Pre-running GPU compute initialization...",
    );
    await this.ssbo.runInitialization(this.renderer);

    // Yield to ensure GPU work is flushed
    await yieldToMain();

    this.flowersInitialized = true;

    const totalTime = performance.now() - initStartTime;
    console.log(
      `[ProceduralFlowers] Initialization complete: ${totalTime.toFixed(1)}ms total, ` +
        `${config.COUNT.toLocaleString()} flowers`,
    );
  }

  update(_deltaTime: number): void {
    if (!this.flowersInitialized || !this.mesh || !this.ssbo || !this.renderer)
      return;

    const camera = this.world.camera;
    if (!camera) return;

    const cameraPos = camera.position;

    // Calculate camera movement delta for position wrapping (EVERY FRAME - no throttling)
    const deltaX = cameraPos.x - this.lastCameraX;
    const deltaZ = cameraPos.z - this.lastCameraZ;
    this.lastCameraX = cameraPos.x;
    this.lastCameraZ = cameraPos.z;

    uniforms.uPlayerDeltaXZ.value.set(deltaX, deltaZ);
    uniforms.uPlayerPosition.value.copy(cameraPos);
    uniforms.uCameraPosition.value.copy(cameraPos);

    // Camera frustum data
    const proj = camera.projectionMatrix;
    uniforms.uFx.value = proj.elements[0];
    uniforms.uFy.value = proj.elements[5];
    uniforms.uCameraMatrix.value.copy(proj).multiply(camera.matrixWorldInverse);
    camera.getWorldDirection(uniforms.uCameraForward.value);

    // Move mesh to follow camera
    this.mesh.position.set(cameraPos.x, 0, cameraPos.z);

    // Run compute shader every frame (no throttling)
    this.renderer.computeAsync(this.ssbo.computeUpdate);
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  getMesh(): THREE.InstancedMesh | null {
    return this.mesh;
  }

  setVisible(visible: boolean): void {
    if (this.mesh) {
      this.mesh.visible = visible;
    }
  }

  isVisible(): boolean {
    return this.mesh?.visible ?? false;
  }

  getActiveInstanceCount(): number {
    return config.COUNT;
  }

  static getConfig(): typeof config {
    return config;
  }

  // Color controls
  setColor1(color: THREE.Color): void {
    uniforms.uColor1.value.copy(color);
  }

  getColor1(): THREE.Color {
    return uniforms.uColor1.value.clone();
  }

  setColor2(color: THREE.Color): void {
    uniforms.uColor2.value.copy(color);
  }

  getColor2(): THREE.Color {
    return uniforms.uColor2.value.clone();
  }

  setColorStrength(value: number): void {
    uniforms.uColorStrength.value = value;
  }

  getColorStrength(): number {
    return uniforms.uColorStrength.value;
  }

  stop(): void {
    this.mesh?.removeFromParent();
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.ssbo = null;
    this.material = null;
    this.flowersInitialized = false;

    this.noiseTexture?.dispose();
    this.atlasTexture?.dispose();
    this.noiseTexture = null;
    this.atlasTexture = null;
    // Don't dispose terrainNoiseTexture - it's shared with TerrainShader and ProceduralGrass
    this.terrainNoiseTexture = null;

    flowerNoiseTexture = null;
    flowerAtlasTexture = null;
    terrainNoiseTexture = null;
  }
}
