/**
 * TerrainShaderTSL - Game-accurate terrain material for TSL/WebGPU
 *
 * This is the EXACT same terrain shader code used in the game engine.
 * Both Asset Forge and the game engine share this code for visual consistency.
 *
 * Features:
 * - classic MMORPG-style flat-shaded vertex colors (no textures)
 * - Height and slope-based biome blending
 * - Noise-based dirt patches
 * - Snow at high elevations
 * - Sand/shoreline near water
 * - Distance fog
 * - Road overlay support
 *
 * @module TerrainShaderTSL
 */

import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  texture,
  positionWorld,
  normalWorld,
  cameraPosition,
  attribute,
  uniform,
  float,
  vec2,
  vec3,
  add,
  sub,
  mul,
  mix,
  smoothstep,
  abs,
  sin,
  cos,
} from "three/tsl";
import type Node from "three/src/nodes/core/Node.js";

// ============================================================================
// TERRAIN CONSTANTS - Shared between all terrain systems
// ============================================================================

export const TERRAIN_CONSTANTS = {
  TRIPLANAR_SCALE: 0.5,
  SNOW_HEIGHT: 50.0,
  FOG_NEAR: 150.0,
  FOG_FAR: 350.0,
  NOISE_SCALE: 0.0008,
  DIRT_THRESHOLD: 0.5,
  LOD_FULL_DETAIL: 100.0,
  LOD_MEDIUM_DETAIL: 200.0,
  WATER_LEVEL: 16, // Overridden at runtime by game; standalone default for procgen previews
  FOG_COLOR: new THREE.Color(0xd4c8b8),
} as const;

// ============================================================================
// PERLIN NOISE TEXTURE GENERATION
// ============================================================================

let cachedNoiseTexture: THREE.DataTexture | null = null;
const NOISE_SIZE = 256;

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

function grad(hash: number, x: number, y: number): number {
  const h = hash & 3;
  const u = h < 2 ? x : y;
  const v = h < 2 ? y : x;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function createPermutation(seed: number): number[] {
  const p: number[] = [];
  for (let i = 0; i < 256; i++) p[i] = i;

  let s = seed;
  for (let i = 255; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }

  return [...p, ...p];
}

function perlin2D(x: number, y: number, perm: number[]): number {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;

  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);

  const u = fade(xf);
  const v = fade(yf);

  const aa = perm[perm[X] + Y];
  const ab = perm[perm[X] + Y + 1];
  const ba = perm[perm[X + 1] + Y];
  const bb = perm[perm[X + 1] + Y + 1];

  const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
  const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);

  return lerp(x1, x2, v);
}

function seamlessPerlin2D(x: number, y: number, perm: number[]): number {
  const TWO_PI = Math.PI * 2;
  const radius = 1.0;

  const angleX = x * TWO_PI;
  const angleY = y * TWO_PI;

  const nx = Math.cos(angleX) * radius;
  const ny = Math.sin(angleX) * radius;
  const nz = Math.cos(angleY) * radius;
  const nw = Math.sin(angleY) * radius;

  const n1 = perlin2D(nx * 4 + 100, nz * 4 + 100, perm);
  const n2 = perlin2D(ny * 4 + 200, nw * 4 + 200, perm);
  const n3 = perlin2D(nx * 4 + ny * 4 + 300, nz * 4 + nw * 4 + 300, perm);

  return (n1 + n2 + n3) / 3;
}

function seamlessFbm(
  x: number,
  y: number,
  perm: number[],
  octaves: number = 4,
): number {
  let value = 0;
  let amplitude = 0.5;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    const ox = x + i * 17.3;
    const oy = y + i * 31.7;
    value += amplitude * seamlessPerlin2D(ox, oy, perm);
    maxValue += amplitude;
    amplitude *= 0.5;
  }

  return value / maxValue;
}

/**
 * Generate a Perlin noise texture for terrain shading
 */
export function generateNoiseTexture(seed: number = 12345): THREE.DataTexture {
  if (cachedNoiseTexture) return cachedNoiseTexture;

  const perm = createPermutation(seed);
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);

  for (let y = 0; y < NOISE_SIZE; y++) {
    for (let x = 0; x < NOISE_SIZE; x++) {
      const nx = x / NOISE_SIZE;
      const ny = y / NOISE_SIZE;

      const noise = seamlessFbm(nx, ny, perm, 4);
      const value = (noise + 1) * 0.5;
      const byte = Math.floor(Math.max(0, Math.min(255, value * 255)));

      const idx = (y * NOISE_SIZE + x) * 4;
      data[idx] = byte;
      data[idx + 1] = byte;
      data[idx + 2] = byte;
      data[idx + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(
    data,
    NOISE_SIZE,
    NOISE_SIZE,
    THREE.RGBAFormat,
  );
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;

  cachedNoiseTexture = tex;
  return tex;
}

/**
 * Get the cached noise texture
 */
export function getNoiseTexture(): THREE.DataTexture | null {
  return cachedNoiseTexture;
}

// CPU-side noise sampling
let cachedPerm: number[] | null = null;

/**
 * Sample noise at world position (for CPU-side operations like grass placement)
 */
export function sampleNoiseAtPosition(
  worldX: number,
  worldZ: number,
  seed: number = 12345,
): number {
  if (!cachedPerm) {
    cachedPerm = createPermutation(seed);
  }

  const u = worldX * TERRAIN_CONSTANTS.NOISE_SCALE;
  const v = worldZ * TERRAIN_CONSTANTS.NOISE_SCALE;

  const wrappedU = u - Math.floor(u);
  const wrappedV = v - Math.floor(v);

  const noise = seamlessFbm(wrappedU, wrappedV, cachedPerm, 4);
  return (noise + 1) * 0.5;
}

function smoothstepCPU(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Check if terrain at position should display as grass
 */
export function getGrassiness(
  _worldX: number,
  _worldZ: number,
  height: number,
  slope: number,
  _seed: number = 12345,
): number {
  let grassiness = 1.0;

  // Very steep slopes = rock
  if (slope > 0.6) {
    const rockFactor = smoothstepCPU(0.6, 0.8, slope);
    grassiness -= rockFactor;
  }

  // Snow at high elevation
  if (height > TERRAIN_CONSTANTS.SNOW_HEIGHT - 5.0) {
    const snowFactor = smoothstepCPU(
      TERRAIN_CONSTANTS.SNOW_HEIGHT - 5.0,
      TERRAIN_CONSTANTS.SNOW_HEIGHT + 5.0,
      height,
    );
    grassiness -= snowFactor;
  }

  return Math.max(0, Math.min(1, grassiness));
}

/**
 * Calculate terrain slope from height samples
 */
export function calculateSlope(
  getHeight: (x: number, z: number) => number,
  x: number,
  z: number,
  sampleDistance: number = 1.0,
): number {
  const hPosX = getHeight(x + sampleDistance, z);
  const hNegX = getHeight(x - sampleDistance, z);
  const hPosZ = getHeight(x, z + sampleDistance);
  const hNegZ = getHeight(x, z - sampleDistance);

  const dhdx = (hPosX - hNegX) / (2 * sampleDistance);
  const dhdz = (hPosZ - hNegZ) / (2 * sampleDistance);

  const gradientMag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
  const normalY = 1 / Math.sqrt(1 + gradientMag * gradientMag);
  const slope = 1 - Math.abs(normalY);

  return slope;
}

// ============================================================================
// TERRAIN MATERIAL UNIFORMS
// ============================================================================

export interface TerrainUniforms {
  sunPosition: { value: THREE.Vector3 };
  time: { value: number };
  fogNear: { value: number };
  fogFar: { value: number };
  fogNearSq: { value: number };
  fogFarSq: { value: number };
  fogColor: { value: THREE.Vector3 };
  fogEnabled: { value: number };
}

export interface TerrainMaterialOptions {
  /** Enable fog (default: true) */
  fogEnabled?: boolean;
  /** Include road overlay attribute (default: true) */
  includeRoadOverlay?: boolean;
  /** Custom fog color */
  fogColor?: THREE.Color;
  /** Custom fog distances */
  fogNear?: number;
  fogFar?: number;
}

// ============================================================================
// TERRAIN MATERIAL - classic MMORPG Style (No Textures)
// ============================================================================

/**
 * Create the game-accurate classic MMORPG-style terrain material
 *
 * This is the EXACT same material used in the game engine.
 * Uses TSL (Three Shader Language) for WebGPU rendering.
 */
export function createTerrainMaterial(
  options: TerrainMaterialOptions = {},
): MeshStandardNodeMaterial & { terrainUniforms: TerrainUniforms } {
  const {
    fogEnabled = true,
    includeRoadOverlay = true,
    fogColor = TERRAIN_CONSTANTS.FOG_COLOR,
    fogNear = TERRAIN_CONSTANTS.FOG_NEAR,
    fogFar = TERRAIN_CONSTANTS.FOG_FAR,
  } = options;

  // Generate noise texture
  const noiseTex = generateNoiseTexture();

  // Uniforms
  const sunPositionUniform = uniform(vec3(100, 100, 100));
  const timeUniform = uniform(float(0));
  const noiseScale = uniform(float(TERRAIN_CONSTANTS.NOISE_SCALE));

  const fogNearUniform = uniform(float(fogNear));
  const fogFarUniform = uniform(float(fogFar));
  const fogNearSqUniform = uniform(float(fogNear * fogNear));
  const fogFarSqUniform = uniform(float(fogFar * fogFar));
  const fogColorUniform = uniform(vec3(fogColor.r, fogColor.g, fogColor.b));
  const fogEnabledUniform = uniform(float(fogEnabled ? 1.0 : 0.0));

  const worldPos = positionWorld;
  const worldNormal = normalWorld;
  const height = worldPos.y;
  const slope = sub(float(1.0), abs(worldNormal.y));

  // ============================================================================
  // classic MMORPG-STYLE VERTEX COLORS
  // ============================================================================

  // Core terrain colors (classic MMORPG palette)
  const grassGreen = vec3(0.3, 0.55, 0.15);
  const grassDark = vec3(0.22, 0.42, 0.1);
  const dirtBrown = vec3(0.45, 0.32, 0.18);
  const dirtDark = vec3(0.32, 0.22, 0.12);
  const rockGray = vec3(0.45, 0.42, 0.38);
  const rockDark = vec3(0.3, 0.28, 0.25);
  const sandYellow = vec3(0.7, 0.6, 0.38);
  const snowWhite = vec3(0.92, 0.94, 0.96);
  const mudBrown = vec3(0.18, 0.12, 0.08);
  const waterEdge = vec3(0.08, 0.06, 0.04);

  // Distance-based LOD
  const toCamera = sub(worldPos, cameraPosition);
  const distSq = add(
    add(mul(toCamera.x, toCamera.x), mul(toCamera.y, toCamera.y)),
    mul(toCamera.z, toCamera.z),
  );

  // Noise sampling
  const noiseUV = mul(vec2(worldPos.x, worldPos.z), noiseScale);
  const noiseValue = texture(noiseTex, noiseUV).r;

  // Derived noise (no extra texture fetch)
  const noiseValue2 = add(
    mul(sin(mul(noiseValue, float(6.28))), float(0.3)),
    float(0.5),
  );

  // Fine detail (conditional based on distance)
  const closeEnough = smoothstep(float(12000.0), float(8000.0), distSq);
  const noiseUV3 = mul(vec2(worldPos.x, worldPos.z), float(0.12));
  const fineNoiseSample = texture(noiseTex, noiseUV3).r;
  const fineNoise = mix(float(0.5), fineNoiseSample, closeEnough);

  // Micro noise (derived)
  const microNoise = add(
    mul(cos(mul(noiseValue, float(12.56))), float(0.2)),
    float(0.5),
  );

  // === BASE: GRASS with variation ===
  const grassVariation = smoothstep(float(0.4), float(0.6), noiseValue2);
  let baseColor = mix(grassGreen, grassDark, grassVariation);

  // === DIRT PATCHES ===
  const dirtPatchFactor = smoothstep(
    float(TERRAIN_CONSTANTS.DIRT_THRESHOLD - 0.05),
    float(TERRAIN_CONSTANTS.DIRT_THRESHOLD + 0.15),
    noiseValue,
  );
  const flatnessFactor = smoothstep(float(0.3), float(0.05), slope);
  const dirtVariation = smoothstep(float(0.3), float(0.7), noiseValue2);
  const dirtColor = mix(dirtBrown, dirtDark, dirtVariation);
  baseColor = mix(baseColor, dirtColor, mul(dirtPatchFactor, flatnessFactor));

  // === SLOPE-BASED DIRT ===
  baseColor = mix(
    baseColor,
    dirtColor,
    mul(smoothstep(float(0.15), float(0.5), slope), float(0.6)),
  );

  // === ROCK ON STEEP SLOPES ===
  const rockVariation = smoothstep(float(0.3), float(0.7), noiseValue);
  const rockColorFinal = mix(rockGray, rockDark, rockVariation);
  baseColor = mix(
    baseColor,
    rockColorFinal,
    smoothstep(float(0.45), float(0.75), slope),
  );

  // === SNOW AT HIGH ELEVATION ===
  baseColor = mix(
    baseColor,
    snowWhite,
    smoothstep(float(TERRAIN_CONSTANTS.SNOW_HEIGHT - 5.0), float(60.0), height),
  );

  // === SAND NEAR WATER ===
  const sandBlend = mul(
    smoothstep(float(10.0), float(6.0), height),
    smoothstep(float(0.25), float(0.0), slope),
  );
  baseColor = mix(baseColor, sandYellow, mul(sandBlend, float(0.6)));

  // === SHORELINE TRANSITIONS ===
  const wetDirtZone = smoothstep(float(14.0), float(8.0), height);
  baseColor = mix(baseColor, dirtDark, mul(wetDirtZone, float(0.4)));

  const mudZone = smoothstep(float(9.0), float(6.0), height);
  baseColor = mix(baseColor, mudBrown, mul(mudZone, float(0.7)));

  const edgeZone = smoothstep(float(6.5), float(5.0), height);
  baseColor = mix(baseColor, waterEdge, mul(edgeZone, float(0.9)));

  // === ANTI-DITHERING ===
  const brightnessVar = mul(sub(fineNoise, float(0.5)), float(0.08));
  const colorVar = mul(sub(microNoise, float(0.5)), float(0.04));

  const variedColor = add(
    baseColor,
    vec3(
      add(brightnessVar, colorVar),
      brightnessVar,
      sub(brightnessVar, colorVar),
    ),
  );

  // === ROAD OVERLAY (optional) ===
  // Roads are compacted dirt paths - use same dirt colors as terrain for consistency
  let colorWithRoads: Node<"vec3"> = variedColor;
  if (includeRoadOverlay) {
    const roadInfluence = attribute<"float">("roadInfluence", "float");

    // Use same dirt colors as terrain dirt patches (dirtBrown, dirtDark defined above)
    // Add noise variation for natural look - compacted dirt has less variation
    const roadNoiseVar = mul(noiseValue2, float(0.5)); // Less variation than regular dirt
    const roadDirtColor = mix(dirtBrown, dirtDark, roadNoiseVar);

    // Road center is darker (compacted, worn surface)
    const roadCenterDarken = mul(roadInfluence, float(0.15));
    const compactedRoadColor = sub(roadDirtColor, vec3(roadCenterDarken));

    // Blend road color with terrain based on influence
    colorWithRoads = mix(variedColor, compactedRoadColor, roadInfluence);
  }

  // === DISTANCE FOG ===
  const baseFogFactor = smoothstep(fogNearSqUniform, fogFarSqUniform, distSq);
  const fogFactor = mul(baseFogFactor, fogEnabledUniform);
  const finalColor = mix(colorWithRoads, fogColorUniform, fogFactor);

  // === CREATE MATERIAL ===
  const material = new MeshStandardNodeMaterial();
  material.colorNode = finalColor;
  material.roughness = 1.0;
  material.metalness = 0.0;
  material.side = THREE.FrontSide;
  material.fog = false;

  const terrainUniforms: TerrainUniforms = {
    sunPosition: sunPositionUniform,
    time: timeUniform,
    fogNear: fogNearUniform,
    fogFar: fogFarUniform,
    fogNearSq: fogNearSqUniform,
    fogFarSq: fogFarSqUniform,
    fogColor: fogColorUniform,
    fogEnabled: fogEnabledUniform,
  };

  const result = material as typeof material & {
    terrainUniforms: TerrainUniforms;
  };
  result.terrainUniforms = terrainUniforms;
  return result;
}

/**
 * Update fog uniforms
 */
export function updateTerrainFog(
  uniforms: TerrainUniforms,
  near: number,
  far: number,
  color?: THREE.Color,
): void {
  uniforms.fogNear.value = near;
  uniforms.fogFar.value = far;
  uniforms.fogNearSq.value = near * near;
  uniforms.fogFarSq.value = far * far;
  if (color) {
    (uniforms.fogColor.value as THREE.Vector3).set(color.r, color.g, color.b);
  }
}

/**
 * Enable/disable fog
 */
export function setTerrainFogEnabled(
  uniforms: TerrainUniforms,
  enabled: boolean,
): void {
  uniforms.fogEnabled.value = enabled ? 1.0 : 0.0;
}
