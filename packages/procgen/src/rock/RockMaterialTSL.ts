/**
 * Rock Material TSL - WebGPU Triplanar Material for Procedural Rocks
 *
 * Implements proper TSL (Three Shading Language) triplanar mapping for
 * realistic rock textures. Supports multiple procedural patterns:
 * - Noise (FBM)
 * - Layered (sandstone-like strata)
 * - Speckled (granite-like)
 * - Veined (marble-like)
 * - Cellular (basalt-like)
 * - Flow (obsidian-like)
 *
 * @module RockMaterialTSL
 */

import * as THREE from "three";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import type { UniformNode } from "three/webgpu";
import {
  Fn,
  positionWorld,
  normalWorld,
  uniform,
  vec2,
  vec3,
  float,
  floor,
  fract,
  sin,
  dot,
  mix,
  abs,
  pow,
  clamp,
  smoothstep,
  min,
  sqrt,
} from "three/tsl";

import type { RockParams, TexturePatternType } from "./types";
import { TexturePattern } from "./types";

// ============================================================================
// TSL TYPES
// ============================================================================

type TSLUniform<TNodeType, TValue> = UniformNode<TNodeType, TValue>;

/**
 * Uniform values for TSL rock material
 */
export interface RockMaterialUniforms {
  baseColor: TSLUniform<"color", THREE.Color>;
  secondaryColor: TSLUniform<"color", THREE.Color>;
  accentColor: TSLUniform<"color", THREE.Color>;
  textureScale: TSLUniform<"float", number>;
  textureDetail: TSLUniform<"float", number>;
  textureContrast: TSLUniform<"float", number>;
  heightBlend: TSLUniform<"float", number>;
  slopeBlend: TSLUniform<"float", number>;
  variation: TSLUniform<"float", number>;
  aoIntensity: TSLUniform<"float", number>;
  textureBlend: TSLUniform<"float", number>;
  triplanarSharpness: TSLUniform<"float", number>;
}

/**
 * Result of rock material creation
 */
export interface RockMaterialResult {
  material: MeshStandardNodeMaterial;
  uniforms: RockMaterialUniforms;
}

// ============================================================================
// TSL NOISE FUNCTIONS
// ============================================================================

/**
 * Hash function for pseudo-random values (TSL)
 */
const tslHash = Fn(([p]: [Node<"vec2">]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));
});

/**
 * Hash function for vec3 input
 * @remarks Exported for use in custom rock patterns (cellular, etc.)
 */
export const tslHash3 = Fn(([p]: [Node<"vec3">]) => {
  const p2 = vec2(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
  );
  return fract(vec2(sin(p2.x), sin(p2.y)).mul(43758.5453123));
});

/**
 * 2D noise function (TSL)
 */
const tslNoise2D = Fn(([p]: [Node<"vec2">]) => {
  const i = floor(p);
  const f = fract(p);
  const smoothF = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));

  const a = tslHash(i);
  const b = tslHash(i.add(vec2(1.0, 0.0)));
  const c = tslHash(i.add(vec2(0.0, 1.0)));
  const d = tslHash(i.add(vec2(1.0, 1.0)));

  return mix(mix(a, b, smoothF.x), mix(c, d, smoothF.x), smoothF.y);
});

/**
 * FBM (Fractal Brownian Motion) noise - 4 octaves (TSL)
 */
const tslFBM = Fn(([p]: [Node<"vec2">]) => {
  const value = float(0.0).toVar();
  const amplitude = float(0.5).toVar();
  const frequency = float(1.0).toVar();

  // 4 octaves unrolled
  value.addAssign(tslNoise2D(p.mul(frequency)).mul(amplitude));
  amplitude.mulAssign(0.5);
  frequency.mulAssign(2.0);

  value.addAssign(tslNoise2D(p.mul(frequency)).mul(amplitude));
  amplitude.mulAssign(0.5);
  frequency.mulAssign(2.0);

  value.addAssign(tslNoise2D(p.mul(frequency)).mul(amplitude));
  amplitude.mulAssign(0.5);
  frequency.mulAssign(2.0);

  value.addAssign(tslNoise2D(p.mul(frequency)).mul(amplitude));

  return value;
});

/**
 * Ridged noise for cracks/crevices (TSL)
 * @remarks Exported for use in custom cracked rock patterns
 */
export const tslRidgedNoise = Fn(([p]: [Node<"vec2">]) => {
  const value = float(0.0).toVar();
  const amplitude = float(0.5).toVar();
  const frequency = float(1.0).toVar();

  // 3 octaves of ridged noise
  for (let i = 0; i < 3; i++) {
    const n = tslNoise2D(p.mul(frequency));
    const ridge = float(1.0).sub(abs(n.mul(2.0).sub(1.0)));
    value.addAssign(ridge.mul(amplitude));
    amplitude.mulAssign(0.5);
    frequency.mulAssign(2.0);
  }

  return value.div(0.875); // Normalize
});

// ============================================================================
// TSL TEXTURE PATTERN FUNCTIONS
// ============================================================================

/**
 * Standard FBM noise pattern
 */
const noisePattern = Fn(([uv, _detail]: [Node<"vec2">, Node<"float">]) => {
  return tslFBM(uv).mul(0.5).add(0.5);
});

/**
 * Layered/stratified pattern (sandstone-like)
 */
const layeredPattern = Fn(([uv, _detail]: [Node<"vec2">, Node<"float">]) => {
  const layerNoise = tslFBM(vec2(uv.x.mul(0.5), uv.y.mul(3.0)));
  const layerY = uv.y.mul(4.0).add(layerNoise.mul(0.5));
  const value = sin(layerY.mul(3.14159).mul(2.0)).mul(0.5).add(0.5);
  return pow(value, float(0.7));
});

/**
 * Speckled pattern (granite-like)
 */
const speckledPattern = Fn(([uv, _detail]: [Node<"vec2">, Node<"float">]) => {
  const speckle = tslFBM(uv.mul(2.2));
  const spots = tslNoise2D(uv.mul(0.8));
  const darkSpots = tslNoise2D(uv.mul(15.0));

  const value = speckle.mul(0.6).toVar();
  value.addAssign(smoothstep(float(0.3), float(1.0), spots).mul(0.3));
  value.subAssign(smoothstep(float(0.6), float(1.0), darkSpots).mul(0.3));

  return clamp(value, float(0.0), float(1.0));
});

/**
 * Veined pattern (marble-like)
 */
const veinedPattern = Fn(([uv, _detail]: [Node<"vec2">, Node<"float">]) => {
  const warp = tslFBM(uv);
  const veinUV = uv.add(warp.mul(0.5));

  // Primary vein
  const vein1 = sin(veinUV.x.add(veinUV.y).mul(3.14159).mul(2.0));
  const vein1Abs = pow(abs(vein1), float(0.3));

  // Secondary vein
  const vein2 = sin(
    veinUV.x.mul(1.5).sub(veinUV.y.mul(0.8)).mul(3.14159).mul(3.0),
  );
  const vein2Abs = pow(abs(vein2), float(0.5));

  const value = float(1.0).sub(min(vein1Abs, vein2Abs).mul(0.7));
  return clamp(value, float(0.0), float(1.0));
});

/**
 * Cellular/Voronoi pattern (basalt-like)
 */
const cellularPattern = Fn(([uv, _detail]: [Node<"vec2">, Node<"float">]) => {
  const cellSize = float(0.15);
  const scaled = uv.div(cellSize);
  const cellId = floor(scaled);
  const localPos = fract(scaled);

  // Find closest cell (simplified 3x3 search)
  const minDist = float(10.0).toVar();

  // Check center and neighbors - unrolled loop
  const offsets = [
    vec2(-1, -1),
    vec2(0, -1),
    vec2(1, -1),
    vec2(-1, 0),
    vec2(0, 0),
    vec2(1, 0),
    vec2(-1, 1),
    vec2(0, 1),
    vec2(1, 1),
  ];

  for (const offset of offsets) {
    const neighbor = cellId.add(offset);
    const cellHash = tslHash(neighbor);
    const cellCenter = vec2(0.5, 0.5).add(cellHash.sub(0.5).mul(0.8));
    const toCenter = localPos.sub(cellCenter).add(offset);
    const dist = dot(toCenter, toCenter);
    minDist.assign(min(minDist, dist));
  }

  const edge = sqrt(minDist);
  const value = smoothstep(float(0.08), float(0.12), edge);
  return pow(value, float(0.5));
});

/**
 * Flow pattern (obsidian-like)
 */
const flowPattern = Fn(([uv, _detail]: [Node<"vec2">, Node<"float">]) => {
  const flowWarp = tslFBM(uv.mul(0.5));
  const flowUV = uv.add(flowWarp.mul(1.5));
  const flow = tslFBM(vec2(flowUV.x, flowUV.y.mul(0.3)));
  const flowNorm = flow.mul(0.5).add(0.5);
  const streak = sin(flowUV.x.mul(2.0).add(flowNorm.mul(3.0)).mul(3.14159));

  return flowNorm.mul(0.7).add(streak.mul(0.15)).add(0.15);
});

// ============================================================================
// TRIPLANAR MAPPING
// ============================================================================

/**
 * Sample a pattern with triplanar projection
 */
const triplanarSample = Fn(
  ([worldPos, worldNormal, scale, detail, sharpness, patternIndex]: [
    Node<"vec3">,
    Node<"vec3">,
    Node<"float">,
    Node<"float">,
    Node<"float">,
    number,
  ]) => {
    // Triplanar blend weights
    const blendWeights = worldNormal
      .abs()
      .pow(vec3(sharpness, sharpness, sharpness));
    const blendSum = blendWeights.x
      .add(blendWeights.y)
      .add(blendWeights.z)
      .add(0.0001);
    const normalizedWeights = blendWeights.div(blendSum);

    // Sample UVs for each projection plane
    const uvYZ = vec2(worldPos.y, worldPos.z).mul(scale); // X-facing
    const uvXZ = vec2(worldPos.x, worldPos.z).mul(scale); // Y-facing
    const uvXY = vec2(worldPos.x, worldPos.y).mul(scale); // Z-facing

    // Sample pattern for each plane based on pattern type
    let sampleYZ, sampleXZ, sampleXY;

    if (patternIndex === 0) {
      // Noise
      sampleYZ = noisePattern(uvYZ, detail);
      sampleXZ = noisePattern(uvXZ, detail);
      sampleXY = noisePattern(uvXY, detail);
    } else if (patternIndex === 1) {
      // Layered
      sampleYZ = layeredPattern(uvYZ, detail);
      sampleXZ = layeredPattern(uvXZ, detail);
      sampleXY = layeredPattern(uvXY, detail);
    } else if (patternIndex === 2) {
      // Speckled
      sampleYZ = speckledPattern(uvYZ, detail);
      sampleXZ = speckledPattern(uvXZ, detail);
      sampleXY = speckledPattern(uvXY, detail);
    } else if (patternIndex === 3) {
      // Veined
      sampleYZ = veinedPattern(uvYZ, detail);
      sampleXZ = veinedPattern(uvXZ, detail);
      sampleXY = veinedPattern(uvXY, detail);
    } else if (patternIndex === 4) {
      // Cellular
      sampleYZ = cellularPattern(uvYZ, detail);
      sampleXZ = cellularPattern(uvXZ, detail);
      sampleXY = cellularPattern(uvXY, detail);
    } else {
      // Flow (default for index 5+)
      sampleYZ = flowPattern(uvYZ, detail);
      sampleXZ = flowPattern(uvXZ, detail);
      sampleXY = flowPattern(uvXY, detail);
    }

    // Blend samples using triplanar weights
    return sampleYZ
      .mul(normalizedWeights.x)
      .add(sampleXZ.mul(normalizedWeights.y))
      .add(sampleXY.mul(normalizedWeights.z));
  },
);

// ============================================================================
// MATERIAL CREATION
// ============================================================================

const PATTERN_INDICES: Record<TexturePatternType, number> = {
  [TexturePattern.Noise]: 0,
  [TexturePattern.Layered]: 1,
  [TexturePattern.Speckled]: 2,
  [TexturePattern.Veined]: 3,
  [TexturePattern.Cellular]: 4,
  [TexturePattern.Flow]: 5,
};

/**
 * Create a TSL rock material with triplanar texturing
 *
 * @param params - Rock generation parameters
 * @param useTextureMode - If true, use full texture; if false, blend with vertex colors
 * @returns Material and uniforms
 */
export function createRockMaterial(
  params: RockParams,
  useTextureMode: boolean = false,
): RockMaterialResult {
  // Create uniforms
  const uniforms: RockMaterialUniforms = {
    baseColor: uniform(new THREE.Color(params.colors.baseColor)),
    secondaryColor: uniform(new THREE.Color(params.colors.secondaryColor)),
    accentColor: uniform(new THREE.Color(params.colors.accentColor)),
    textureScale: uniform(params.texture.scale),
    textureDetail: uniform(params.texture.detail),
    textureContrast: uniform(params.texture.contrast),
    heightBlend: uniform(params.colors.heightBlend),
    slopeBlend: uniform(params.colors.slopeBlend),
    variation: uniform(params.colors.variation),
    aoIntensity: uniform(params.colors.aoIntensity),
    textureBlend: uniform(params.textureBlend),
    triplanarSharpness: uniform(4.0),
  };

  const patternIndex = PATTERN_INDICES[params.texture.pattern];
  if (patternIndex === undefined) {
    throw new Error(
      `[RockMaterialTSL] Unknown texture pattern: ${params.texture.pattern}`,
    );
  }

  // Create material
  const material = new MeshStandardNodeMaterial();
  material.roughness = params.material.roughness;
  material.metalness = params.material.metalness;
  material.flatShading = params.flatShading;

  // Build color node
  const colorNode = Fn(() => {
    const worldPos = positionWorld;
    const worldNormal = normalWorld;

    // Sample triplanar texture pattern
    const patternValue = triplanarSample(
      worldPos,
      worldNormal,
      uniforms.textureScale,
      uniforms.textureDetail,
      uniforms.triplanarSharpness,
      patternIndex,
    );

    // Apply contrast
    const contrastedValue = pow(
      clamp(patternValue, float(0.0), float(1.0)),
      float(1.0).div(uniforms.textureContrast),
    );

    // Color gradient based on pattern value
    // Low values -> accent, mid -> base, high -> secondary
    const colorLow = mix(
      uniforms.accentColor,
      uniforms.baseColor,
      contrastedValue.mul(2.0),
    );
    const colorHigh = mix(
      uniforms.baseColor,
      uniforms.secondaryColor,
      contrastedValue.sub(0.5).mul(2.0),
    );
    const textureColor = mix(
      colorLow,
      colorHigh,
      smoothstep(float(0.0), float(1.0), contrastedValue),
    );

    // Height-based blending
    const height = worldPos.y;
    const heightFactor = smoothstep(float(-1.0), float(1.0), height);
    const heightColor = mix(
      uniforms.baseColor,
      uniforms.secondaryColor,
      heightFactor.mul(uniforms.heightBlend),
    );

    // Slope-based blending (accent in steep areas)
    const slopeFactor = float(1.0).sub(abs(worldNormal.y));
    const slopeColor = mix(
      textureColor,
      uniforms.accentColor,
      slopeFactor.mul(uniforms.slopeBlend),
    );

    // Combine texture with height/slope influences
    const combinedColor = mix(slopeColor, heightColor, float(0.3));

    // Add noise variation for micro-detail
    const noiseUV = vec2(worldPos.x, worldPos.z).mul(5.0);
    const microNoise = tslNoise2D(noiseUV).sub(0.5).mul(uniforms.variation);
    const variedColor = combinedColor.add(
      vec3(microNoise, microNoise, microNoise),
    );

    // Simple AO based on position (crevices are darker)
    const aoNoise = tslNoise2D(vec2(worldPos.x, worldPos.y).mul(3.0));
    const aoFactor = float(1.0).sub(aoNoise.mul(uniforms.aoIntensity).mul(0.5));
    const aoColor = variedColor.mul(aoFactor);

    // If blend mode, mix with vertex colors (which will be set on geometry)
    if (!useTextureMode) {
      // For blend mode, the final color is lerped between vertex color and texture
      // Vertex colors are applied via vertexColors = true on the material
      return aoColor;
    }

    return aoColor;
  })();

  material.colorNode = colorNode;

  // Enable vertex colors for blend mode
  if (!useTextureMode) {
    material.vertexColors = true;
  }

  return { material, uniforms };
}

/**
 * Create a simple vertex-color-only rock material (for LOD/fallback)
 */
export function createVertexColorRockMaterial(
  params: RockParams,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.vertexColors = true;
  material.roughness = params.material.roughness;
  material.metalness = params.material.metalness;
  material.flatShading = params.flatShading;
  return material;
}

/**
 * Update rock material colors
 */
export function updateRockColors(
  uniforms: RockMaterialUniforms,
  baseColor: THREE.Color,
  secondaryColor: THREE.Color,
  accentColor: THREE.Color,
): void {
  uniforms.baseColor.value.copy(baseColor);
  uniforms.secondaryColor.value.copy(secondaryColor);
  uniforms.accentColor.value.copy(accentColor);
}

/**
 * Update rock material texture parameters
 */
export function updateRockTexture(
  uniforms: RockMaterialUniforms,
  scale: number,
  detail: number,
  contrast: number,
): void {
  uniforms.textureScale.value = scale;
  uniforms.textureDetail.value = detail;
  uniforms.textureContrast.value = contrast;
}
