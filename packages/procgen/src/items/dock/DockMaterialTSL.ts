/**
 * Dock Material TSL - WebGPU Material for Procedural Wood Docks
 *
 * Implements proper TSL (Three Shading Language) for realistic wood textures.
 * Supports multiple wood types:
 * - Weathered (gray, sun-bleached)
 * - Fresh (warm tan)
 * - Dark (stained)
 * - Mossy (green-tinged)
 *
 * @module DockMaterialTSL
 */

import * as THREE from "three";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import type { UniformNode } from "three/webgpu";
import {
  Fn,
  positionWorld,
  normalWorld,
  attribute,
  uniform,
  uv,
  vec2,
  vec3,
  float,
  floor,
  fract,
  sin,
  dot,
  mix,
  clamp,
  smoothstep,
  max,
  step,
} from "three/tsl";

import type { WoodTypeValue } from "../types";
import { WoodType } from "../types";

// ============================================================================
// TSL TYPES
// ============================================================================

type TSLUniform<TNodeType, TValue> = UniformNode<TNodeType, TValue>;

/**
 * Uniform values for TSL dock material
 */
export interface DockMaterialUniforms {
  woodColor: TSLUniform<"color", THREE.Color>;
  woodColorSecondary: TSLUniform<"color", THREE.Color>;
  grainScale: TSLUniform<"float", number>;
  grainIntensity: TSLUniform<"float", number>;
  weathering: TSLUniform<"float", number>;
  wetness: TSLUniform<"float", number>;
  waterLevel: TSLUniform<"float", number>;
}

/**
 * Result of dock material creation
 */
export interface DockMaterialResult {
  material: MeshStandardNodeMaterial;
  uniforms: DockMaterialUniforms;
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
 * 1D noise for wood grain
 */
const tslNoise1D = Fn(([x]: [Node<"float">]) => {
  const i = floor(x);
  const f = fract(x);
  const smoothF = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));

  const a = tslHash(vec2(i, 0.0));
  const b = tslHash(vec2(i.add(1.0), 0.0));

  return mix(a, b, smoothF);
});

/**
 * FBM noise (2 octaves for performance)
 */
const tslFBM2 = Fn(([p]: [Node<"vec2">]) => {
  const value = float(0.0).toVar();

  value.addAssign(tslNoise2D(p).mul(0.5));
  value.addAssign(tslNoise2D(p.mul(2.0)).mul(0.25));

  return value.mul(1.333); // Normalize
});

// ============================================================================
// WOOD GRAIN PATTERN
// ============================================================================

/**
 * Generate wood grain pattern
 *
 * Creates realistic wood grain with:
 * - Primary grain lines (along plank length)
 * - Secondary variation (knots, rings)
 * - Fine detail noise
 */
const woodGrainPattern = Fn(
  ([uvCoord, grainScale, grainIntensity]: [
    Node<"vec2">,
    Node<"float">,
    Node<"float">,
  ]) => {
    // Scale UV for grain density
    const scaledUV = uvCoord.mul(grainScale);

    // Primary grain - parallel lines along U (plank length)
    // Use sin wave with noise perturbation
    const grainOffset = tslNoise2D(scaledUV.mul(0.5)).mul(0.3);
    const grainLine = sin(scaledUV.x.mul(15.0).add(grainOffset.mul(10.0)));
    const primaryGrain = grainLine.mul(0.5).add(0.5);

    // Secondary grain - larger scale waves
    const secondaryGrain = sin(
      scaledUV.x.mul(3.0).add(tslNoise1D(scaledUV.y.mul(2.0)).mul(2.0)),
    );
    const secondaryPattern = secondaryGrain.mul(0.5).add(0.5);

    // Fine detail noise
    const detailNoise = tslFBM2(scaledUV.mul(8.0));

    // Combine patterns
    const grain = mix(primaryGrain, secondaryPattern, 0.3);
    const grainWithDetail = mix(grain, detailNoise, 0.2);

    // Apply intensity
    return mix(float(0.5), grainWithDetail, grainIntensity);
  },
);

/**
 * Generate wood knot pattern (rare, circular features)
 */
const woodKnotPattern = Fn(
  ([uvCoord, knotSeed]: [Node<"vec2">, Node<"float">]) => {
    // Check for knot presence based on position hash
    const knotHash = tslHash(floor(uvCoord.mul(2.0)).add(vec2(knotSeed, 0.0)));
    const hasKnot = step(0.85, knotHash); // 15% chance of knot

    // Knot center within cell
    const cellUV = fract(uvCoord.mul(2.0));
    const knotCenter = vec2(0.5, 0.5);
    const distToKnot = cellUV.sub(knotCenter).length();

    // Concentric rings for knot
    const knotRings = sin(distToKnot.mul(30.0)).mul(0.5).add(0.5);
    const knotMask = smoothstep(0.3, 0.0, distToKnot);

    // Darker in knot center
    const knotDarkening = smoothstep(0.2, 0.0, distToKnot).mul(0.3);

    return mix(float(0.0), knotRings.mul(knotMask).sub(knotDarkening), hasKnot);
  },
);

// ============================================================================
// WEATHERING EFFECTS
// ============================================================================

/**
 * Apply weathering effects to wood color
 */
const applyWeathering = Fn(
  ([baseColor, worldPos, weatheringAmount]: [
    Node<"vec3">,
    Node<"vec3">,
    Node<"float">,
  ]) => {
    // Sample noise for weathering variation
    const weatherNoise = tslFBM2(vec2(worldPos.x, worldPos.z).mul(0.5));

    // Weathering desaturates and lightens wood
    const gray = baseColor.r
      .mul(0.299)
      .add(baseColor.g.mul(0.587))
      .add(baseColor.b.mul(0.114));
    const desaturated = mix(
      baseColor,
      vec3(gray, gray, gray),
      weatheringAmount.mul(0.6),
    );

    // Add lighter streaks where weathered
    const lightening = weatherNoise.mul(weatheringAmount).mul(0.15);
    const weathered = desaturated.add(
      vec3(lightening, lightening, lightening.mul(0.8)),
    );

    return weathered;
  },
);

/**
 * Apply wetness effect (darkens wood, adds green tinge for mossy)
 */
const applyWetness = Fn(
  ([baseColor, worldPos, wetnessAmount, isMossy]: [
    Node<"vec3">,
    Node<"vec3">,
    Node<"float">,
    Node<"float">,
  ]) => {
    // Wetness darkens wood
    const darkened = baseColor.mul(float(1.0).sub(wetnessAmount.mul(0.3)));

    // Add green tinge for mossy wood
    const mossNoise = tslFBM2(vec2(worldPos.x, worldPos.z).mul(2.0));
    const mossAmount = mossNoise.mul(isMossy).mul(wetnessAmount);
    const mossColor = vec3(0.2, 0.35, 0.15);

    return mix(darkened, mossColor, mossAmount.mul(0.5));
  },
);

// ============================================================================
// MATERIAL CREATION
// ============================================================================

/**
 * Get base colors for wood type
 */
function getWoodColors(woodType: WoodTypeValue): {
  primary: THREE.Color;
  secondary: THREE.Color;
} {
  switch (woodType) {
    case WoodType.Weathered:
      return {
        primary: new THREE.Color(0.55, 0.5, 0.45), // Gray-brown
        secondary: new THREE.Color(0.5, 0.45, 0.4),
      };
    case WoodType.Fresh:
      return {
        primary: new THREE.Color(0.7, 0.55, 0.35), // Warm tan
        secondary: new THREE.Color(0.6, 0.45, 0.28),
      };
    case WoodType.Dark:
      return {
        primary: new THREE.Color(0.35, 0.25, 0.18), // Dark brown
        secondary: new THREE.Color(0.28, 0.2, 0.14),
      };
    case WoodType.Mossy:
      return {
        primary: new THREE.Color(0.45, 0.42, 0.35), // Greenish brown
        secondary: new THREE.Color(0.38, 0.4, 0.3),
      };
    default:
      return {
        primary: new THREE.Color(0.6, 0.5, 0.35),
        secondary: new THREE.Color(0.5, 0.4, 0.28),
      };
  }
}

/**
 * Create TSL dock material with procedural wood texture
 */
export function createDockMaterial(
  woodType: WoodTypeValue = WoodType.Weathered,
): DockMaterialResult {
  const colors = getWoodColors(woodType);

  // Create uniforms
  const uniforms: DockMaterialUniforms = {
    woodColor: uniform(colors.primary),
    woodColorSecondary: uniform(colors.secondary),
    grainScale: uniform(1.0),
    grainIntensity: uniform(0.4),
    weathering: uniform(woodType === WoodType.Weathered ? 0.6 : 0.2),
    wetness: uniform(woodType === WoodType.Mossy ? 0.5 : 0.1),
    waterLevel: uniform(5.0),
  };

  const isMossy = float(woodType === WoodType.Mossy ? 1.0 : 0.0);

  // Create material
  const material = new MeshStandardNodeMaterial();
  material.vertexColors = true;

  // Color node - combines vertex colors with procedural wood grain
  material.colorNode = Fn(() => {
    const worldPos = positionWorld;
    const uvCoord = uv();
    const vertexColor = attribute<"vec3">("color", "vec3");

    // Get base wood color from uniform, modulated by vertex color
    const baseWood = mix(
      uniforms.woodColor,
      uniforms.woodColorSecondary,
      vertexColor.r,
    );

    // Generate wood grain pattern
    const grain = woodGrainPattern(
      uvCoord,
      uniforms.grainScale,
      uniforms.grainIntensity,
    );

    // Generate knot pattern
    const knot = woodKnotPattern(uvCoord, float(42.0));

    // Combine grain and knot
    const grainColor = mix(baseWood, baseWood.mul(0.7), grain.mul(0.3));
    const withKnots = mix(grainColor, grainColor.mul(0.6), knot);

    // Apply weathering
    const weathered = applyWeathering(withKnots, worldPos, uniforms.weathering);

    // Apply wetness (below water level or for mossy wood)
    const belowWater = smoothstep(
      uniforms.waterLevel,
      uniforms.waterLevel.sub(0.5),
      worldPos.y,
    );
    const totalWetness = max(uniforms.wetness, belowWater);
    const wet = applyWetness(weathered, worldPos, totalWetness, isMossy);

    // Final color with vertex color AO
    const ao = vertexColor.g.mul(0.3).add(0.7); // Use green channel for AO
    return wet.mul(ao);
  })();

  // Roughness node - varies based on weathering
  material.roughnessNode = Fn(() => {
    const uvCoord = uv();
    const worldPos = positionWorld;

    // Base roughness
    const baseRoughness = float(0.75);

    // Add variation from grain
    const grainVariation = tslNoise2D(
      uvCoord.mul(uniforms.grainScale).mul(4.0),
    );
    const roughnessVariation = grainVariation.mul(0.15);

    // Wetness reduces roughness (smoother when wet)
    const belowWater = smoothstep(
      uniforms.waterLevel,
      uniforms.waterLevel.sub(0.5),
      worldPos.y,
    );
    const wetnessReduction = max(uniforms.wetness, belowWater).mul(0.2);

    // Weathering increases roughness
    const weatheringIncrease = uniforms.weathering.mul(0.1);

    return clamp(
      baseRoughness
        .add(roughnessVariation)
        .add(weatheringIncrease)
        .sub(wetnessReduction),
      0.3,
      0.95,
    );
  })();

  // Normal node - subtle wood grain bump
  material.normalNode = Fn(() => {
    const uvCoord = uv();
    const baseNormal = normalWorld;

    // Sample grain at offset points for normal calculation
    const eps = float(0.01);
    const grainCenter = woodGrainPattern(
      uvCoord,
      uniforms.grainScale,
      uniforms.grainIntensity,
    );
    const grainRight = woodGrainPattern(
      uvCoord.add(vec2(eps, 0.0)),
      uniforms.grainScale,
      uniforms.grainIntensity,
    );
    const grainUp = woodGrainPattern(
      uvCoord.add(vec2(0.0, eps)),
      uniforms.grainScale,
      uniforms.grainIntensity,
    );

    // Calculate normal perturbation
    const bumpStrength = float(0.1);
    const dx = grainRight.sub(grainCenter).mul(bumpStrength);
    const dy = grainUp.sub(grainCenter).mul(bumpStrength);

    // Perturb normal
    const tangent = vec3(1.0, 0.0, dx);
    const bitangent = vec3(0.0, 1.0, dy);
    const perturbedNormal = tangent.cross(bitangent).normalize();

    // Blend with base normal
    return mix(baseNormal, perturbedNormal, 0.3).normalize();
  })();

  // Metalness - wood is not metallic
  material.metalnessNode = float(0.0);

  return { material, uniforms };
}

/**
 * Create simple vertex-color-only dock material (for performance)
 */
export function createSimpleDockMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.vertexColors = true;
  material.roughness = 0.8;
  material.metalness = 0.0;
  return material;
}

/**
 * Update dock material water level (for correct wetness rendering)
 */
export function updateDockMaterialWaterLevel(
  uniforms: DockMaterialUniforms,
  waterLevel: number,
): void {
  uniforms.waterLevel.value = waterLevel;
}
