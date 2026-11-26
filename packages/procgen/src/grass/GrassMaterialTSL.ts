/**
 * Grass Material (TSL/WebGPU)
 *
 * Creates grass materials using Three Shading Language for WebGPU rendering.
 * Uses SpriteNodeMaterial for billboard rendering (grass always faces camera).
 * Supports wind animation, color gradients, and instance-based rendering.
 *
 * This is the core material factory used by both the game engine and Asset Forge.
 *
 * @module GrassMaterialTSL
 */

import * as THREE from "three";
import { SpriteNodeMaterial } from "three/webgpu";
import type { UniformNode } from "three/webgpu";
import {
  Fn,
  attribute,
  uv as tslUv,
  uniform as tslUniform,
  vec2 as tslVec2,
  vec3 as tslVec3,
  vec4 as tslVec4,
  float as tslFloat,
  sin as tslSin,
  cos as tslCos,
  abs as tslAbs,
  mix as tslMix,
  smoothstep as tslSmoothstep,
  clamp as tslClamp,
  fract as tslFract,
  time as tslTime,
  hash,
  instanceIndex,
} from "three/tsl";

import type { GrassConfig } from "./types.js";
import { DEFAULT_GRASS_CONFIG } from "./types.js";

// TSL uniform nodes - these are shader nodes, not plain values
type TSLUniform<TNodeType, TValue> = UniformNode<TNodeType, TValue>;

/**
 * Uniform values for TSL grass material (shader node types)
 */
export interface GrassMaterialUniforms {
  time: TSLUniform<"float", number>;
  windStrength: TSLUniform<"float", number>;
  windSpeed: TSLUniform<"float", number>;
  gustSpeed: TSLUniform<"float", number>;
  flutterIntensity: TSLUniform<"float", number>;
  windDirection: TSLUniform<"vec3", THREE.Vector3>;
  bladeHeight: TSLUniform<"float", number>;
  bladeWidth: TSLUniform<"float", number>;
  baseColor: TSLUniform<"color", THREE.Color>;
  tipColor: TSLUniform<"color", THREE.Color>;
  darkColor: TSLUniform<"color", THREE.Color>;
  dryColorMix: TSLUniform<"float", number>;
}

/**
 * Options for creating grass material
 */
export interface GrassMaterialOptions {
  /** Grass configuration */
  config?: Partial<GrassConfig>;
  /** Whether to use double-sided rendering */
  doubleSided?: boolean;
  /** Enable transparency for dithered fading */
  transparent?: boolean;
}

/**
 * Result of grass material creation
 */
export interface GrassMaterialResult {
  /** The TSL material (SpriteNodeMaterial for billboard grass) */
  material: SpriteNodeMaterial;
  /** Uniforms for runtime updates */
  uniforms: GrassMaterialUniforms;
}

/**
 * Create TSL uniforms for grass material
 *
 * @param config - Grass configuration
 * @returns Uniform objects for material
 */
export function createGrassUniforms(
  config: Partial<GrassConfig> = {},
): GrassMaterialUniforms {
  const blade = { ...DEFAULT_GRASS_CONFIG.blade, ...config.blade };
  const wind = { ...DEFAULT_GRASS_CONFIG.wind, ...config.wind };
  const color = { ...DEFAULT_GRASS_CONFIG.color, ...config.color };

  return {
    time: tslUniform(0.0),
    windStrength: tslUniform(wind.strength),
    windSpeed: tslUniform(wind.speed),
    gustSpeed: tslUniform(wind.gustSpeed),
    flutterIntensity: tslUniform(wind.flutterIntensity),
    windDirection: tslUniform(
      new THREE.Vector3(wind.direction.x, 0, wind.direction.z).normalize(),
    ),
    bladeHeight: tslUniform(blade.height),
    bladeWidth: tslUniform(blade.width),
    baseColor: tslUniform(
      new THREE.Color(color.baseColor.r, color.baseColor.g, color.baseColor.b),
    ),
    tipColor: tslUniform(
      new THREE.Color(color.tipColor.r, color.tipColor.g, color.tipColor.b),
    ),
    darkColor: tslUniform(
      new THREE.Color(color.darkColor.r, color.darkColor.g, color.darkColor.b),
    ),
    dryColorMix: tslUniform(color.dryColorMix),
  };
}

/**
 * Create a TSL grass material with wind animation using SpriteNodeMaterial
 *
 * Uses SpriteNodeMaterial for automatic billboard rendering - grass blades
 * always face the camera, providing proper visibility from all angles.
 *
 * This material expects the following instance attributes:
 * - instancePosition (vec4): x, y, z, heightScale
 * - instanceVariation (vec4): rotation, widthScale, colorVariation, phaseOffset
 *
 * @param options - Material options
 * @returns Material and uniforms
 */
export function createGrassMaterial(
  options: GrassMaterialOptions = {},
): GrassMaterialResult {
  const config = { ...DEFAULT_GRASS_CONFIG, ...options.config };
  const uniforms = createGrassUniforms(config);

  // Use SpriteNodeMaterial for billboard rendering (always faces camera)
  const material = new SpriteNodeMaterial();
  material.transparent = true;
  material.alphaTest = 0.1;

  // Instance attributes
  const instancePosition = attribute<"vec4">("instancePosition", "vec4");
  const instanceVariation = attribute<"vec4">("instanceVariation", "vec4");

  // === UNPACK INSTANCE DATA ===
  const worldPos = instancePosition.xyz;
  const heightScale = instancePosition.w;
  const widthScale = instanceVariation.y;
  const colorVar = instanceVariation.z;
  const phaseOffset = instanceVariation.w;

  // Per-instance noise for variation
  const positionNoise = hash(instanceIndex.add(1234));

  // === SCALE ===
  // SpriteNodeMaterial scales the sprite; we set width and height
  const scaledWidth = uniforms.bladeWidth
    .mul(widthScale)
    .mul(positionNoise.add(0.5));
  const scaledHeight = uniforms.bladeHeight.mul(heightScale);
  material.scaleNode = tslVec3(scaledWidth, scaledHeight, tslFloat(1.0));

  // === GAME-ACCURATE WIND SYSTEM ===
  // Matches ProceduralGrass.ts wind implementation with gusts and turbulence

  const windDir = uniforms.windDirection;

  // Per-instance speed jitter (±10%) - like game
  const speed = uniforms.windSpeed.mul(positionNoise.add(0.5).mul(1.1));

  // Base UV for noise sampling + scroll
  const uvBase = tslVec2(worldPos.x, worldPos.z).mul(0.01);
  const scroll = tslVec2(windDir.x, windDir.z).mul(speed).mul(tslTime);

  // Sample noise using hash-based approach
  const uvA = uvBase.add(scroll);
  const uvB = uvBase.mul(1.37).add(scroll.mul(1.11));

  // Noise samples (remapped to -1 to 1)
  const nA = hash(uvA.x.add(uvA.y.mul(100)))
    .mul(2.0)
    .sub(1.0);
  const nB = hash(uvB.x.add(uvB.y.mul(100)))
    .mul(2.0)
    .sub(1.0);

  // Mix noises with time variation
  const mixRand = tslFract(tslSin(positionNoise.mul(12.9898)).mul(78.233));
  const mixTime = tslSin(tslTime.mul(0.4).add(positionNoise.mul(0.1))).mul(
    0.25,
  );
  const w = tslClamp(mixRand.add(mixTime), 0.2, 0.8);
  const n = tslMix(nA, nB, w);

  // ========== GUST PATCHES ==========
  const gustNoiseThreshold = tslFloat(0.45);
  const gustMask = tslSmoothstep(
    gustNoiseThreshold,
    gustNoiseThreshold.add(0.2),
    n.add(0.5).mul(0.5),
  );

  // ========== TURBULENCE LAYER ==========
  const phase = positionNoise.mul(6.28);
  const turbulenceTime = tslTime.mul(20.0).add(phase.mul(100.0));

  const turb1 = tslSin(turbulenceTime).mul(0.15);
  const turb2 = tslSin(turbulenceTime.mul(1.7).add(2.3)).mul(0.12);
  const turb3 = tslCos(turbulenceTime.mul(0.8).add(phase.mul(50.0))).mul(0.1);
  const turbulence = turb1
    .add(turb2)
    .add(turb3)
    .mul(uniforms.windStrength)
    .mul(0.6);

  // ========== COMBINE WIND ==========
  const baseMag = n.mul(uniforms.windStrength);
  const gustMag = hash(uvB.x.sub(uvB.y.mul(50)))
    .mul(2.0)
    .sub(1.0)
    .mul(uniforms.windStrength)
    .mul(0.35)
    .mul(gustMask);

  const windFactor = baseMag.add(gustMag).add(turbulence);

  // Height-based bend profile (quadratic)
  const uvCoordForWind = tslUv();
  const h = uvCoordForWind.y;
  const bendProfile = h.mul(h);

  const windBend = windFactor.mul(bendProfile);

  // Flutter
  const flutterWave = tslSin(tslTime.mul(4.0).add(phaseOffset.mul(10.0)));
  const flutter = flutterWave
    .mul(uniforms.flutterIntensity)
    .mul(uniforms.windStrength)
    .mul(bendProfile)
    .mul(0.1);

  // Wind displacement for position
  const windOffsetX = windBend.mul(windDir.x).mul(scaledHeight).mul(0.5);
  const windOffsetZ = windBend.mul(windDir.z).mul(scaledHeight).mul(0.5);
  const flutterOffsetX = flutter.mul(windDir.z.negate());
  const flutterOffsetZ = flutter.mul(windDir.x);

  // Vertical bob from wind intensity
  const verticalBob = tslAbs(windFactor).mul(h).mul(0.02);

  // Final position
  const finalX = worldPos.x.add(windOffsetX).add(flutterOffsetX);
  const finalY = worldPos.y.add(verticalBob);
  const finalZ = worldPos.z.add(windOffsetZ).add(flutterOffsetZ);
  material.positionNode = tslVec3(finalX, finalY, finalZ);

  // Cloud shadow effect - darker in gusty areas
  const windNoiseFactor = gustMask.mul(tslAbs(windFactor));

  // === ROTATION (bend from wind) ===
  const bendAngle = windBend.add(positionNoise.sub(0.5).mul(0.1));
  material.rotationNode = tslVec3(bendAngle, tslFloat(0), flutter.mul(0.5));

  // === COLOR ===
  // Color with gradient, variation, and wind cloud shadow
  material.colorNode = Fn(() => {
    const uvCoord = tslUv();

    // Base to tip gradient
    const gradientColor = tslMix(
      uniforms.baseColor,
      uniforms.tipColor,
      uvCoord.y.mul(0.6),
    );

    // Mix in darker color for natural variety
    const variedColor = tslMix(
      gradientColor,
      uniforms.darkColor,
      colorVar.mul(uniforms.dryColorMix),
    );

    // Ambient occlusion at base for grounding
    const ao = tslSmoothstep(0.0, 0.25, uvCoord.y);
    const aoColor = variedColor.mul(tslFloat(0.65).add(ao.mul(0.35)));

    // Cloud shadow effect - grass in gusty areas is slightly darker
    const cloudShadowStrength = tslFloat(0.15);
    const cloudShadow = tslFloat(1.0).sub(
      windNoiseFactor.mul(cloudShadowStrength),
    );
    const finalColor = aoColor.mul(cloudShadow);

    return tslVec4(finalColor, 1.0);
  })();

  // Bottom fade opacity for grounding effect
  const uvCoord = tslUv();
  const bottomFade = tslSmoothstep(0.0, 0.15, uvCoord.y);
  material.opacityNode = bottomFade;

  return { material, uniforms };
}

/**
 * Create a simplified grass card material for LOD1
 *
 * Cards are simpler billboards for distant grass rendering.
 * Uses SpriteNodeMaterial for consistent billboard behavior.
 *
 * @param options - Material options
 * @returns Material for grass cards
 */
export function createGrassCardMaterial(
  options: GrassMaterialOptions = {},
): GrassMaterialResult {
  const config = { ...DEFAULT_GRASS_CONFIG, ...options.config };
  const uniforms = createGrassUniforms(config);

  // Use SpriteNodeMaterial for billboard rendering
  const material = new SpriteNodeMaterial();
  material.transparent = true;
  material.alphaTest = 0.1;

  // Instance attributes for cards
  const instancePosition = attribute<"vec4">("instancePosition", "vec4");
  const instanceVariation = attribute<"vec4">("instanceVariation", "vec4");

  // Unpack instance data
  const worldPos = instancePosition.xyz;
  const heightScale = instancePosition.w;
  const widthScale = instanceVariation.y;
  const phaseOffset = instanceVariation.w;

  // Scale for cards (larger than individual blades)
  const cardWidth = tslFloat(0.8).mul(widthScale);
  const cardHeight = tslFloat(0.5).mul(heightScale);
  material.scaleNode = tslVec3(cardWidth, cardHeight, tslFloat(1.0));

  // Simple sway animation
  const sway = tslSin(tslTime.mul(uniforms.windSpeed).add(phaseOffset))
    .mul(uniforms.windStrength)
    .mul(0.1);

  // Position - base at ground level
  const finalX = worldPos.x.add(sway);
  const finalY = worldPos.y;
  const finalZ = worldPos.z;
  material.positionNode = tslVec3(finalX, finalY, finalZ);

  // Rotation from wind sway
  material.rotationNode = tslVec3(sway.mul(0.5), tslFloat(0), tslFloat(0));

  // Gradient color for cards
  material.colorNode = Fn(() => {
    const uvCoord = tslUv();
    const gradientColor = tslMix(
      uniforms.baseColor,
      uniforms.tipColor,
      uvCoord.y,
    );
    return tslVec4(gradientColor, 1.0);
  })();

  return { material, uniforms };
}

/**
 * Update grass material time uniform for animation
 *
 * Call this every frame with elapsed time to animate wind.
 *
 * @param uniforms - Material uniforms
 * @param elapsedTime - Total elapsed time in seconds
 */
export function updateGrassTime(
  uniforms: GrassMaterialUniforms,
  elapsedTime: number,
): void {
  uniforms.time.value = elapsedTime;
}

/**
 * Update grass material wind parameters
 *
 * @param uniforms - Material uniforms
 * @param strength - Wind strength (0-3 typical)
 * @param direction - Wind direction (will be normalized)
 */
export function updateGrassWind(
  uniforms: GrassMaterialUniforms,
  strength: number,
  direction?: THREE.Vector3,
): void {
  uniforms.windStrength.value = strength;
  if (direction) {
    uniforms.windDirection.value.copy(direction).normalize();
  }
}

/**
 * Update grass material colors
 *
 * @param uniforms - Material uniforms
 * @param baseColor - Base color (at root)
 * @param tipColor - Tip color (at top)
 */
export function updateGrassColors(
  uniforms: GrassMaterialUniforms,
  baseColor: THREE.Color,
  tipColor: THREE.Color,
): void {
  uniforms.baseColor.value.copy(baseColor);
  uniforms.tipColor.value.copy(tipColor);
}
