/**
 * Flower Material (TSL/WebGPU)
 *
 * Creates flower materials using Three Shading Language for WebGPU rendering.
 * Supports billboard sprites with wind animation and color variation.
 *
 * @module FlowerMaterialTSL
 */

import * as THREE from "three";
import { SpriteNodeMaterial } from "three/webgpu";
import type { UniformNode } from "three/webgpu";
import {
  attribute,
  uv as tslUv,
  uniform as tslUniform,
  vec3 as tslVec3,
  float as tslFloat,
  sin as tslSin,
  mix as tslMix,
  step as tslStep,
  floor as tslFloor,
  instanceIndex,
  hash,
  PI2,
  time,
} from "three/tsl";

import type { FlowerConfig } from "./types.js";
import { DEFAULT_FLOWER_CONFIG, DEFAULT_FLOWER_PALETTE } from "./types.js";

// TSL uniform nodes - these are shader nodes, not plain values
type TSLUniform<TNodeType, TValue> = UniformNode<TNodeType, TValue>;

/**
 * Uniform values for TSL flower material (shader node types)
 */
export interface FlowerMaterialUniforms {
  time: TSLUniform<"float", number>;
  color1: TSLUniform<"color", THREE.Color>;
  color2: TSLUniform<"color", THREE.Color>;
  colorStrength: TSLUniform<"float", number>;
  windIntensity: TSLUniform<"float", number>;
  windDirection: TSLUniform<"vec2", THREE.Vector2>;
}

/**
 * Options for creating flower material
 */
export interface FlowerMaterialOptions {
  /** Flower configuration */
  config?: Partial<FlowerConfig>;
  /** Flower atlas texture (optional, uses procedural if not provided) */
  atlasTexture?: THREE.Texture;
  /** Whether to use procedural colors */
  proceduralColors?: boolean;
}

/**
 * Result of flower material creation
 */
export interface FlowerMaterialResult {
  /** The TSL sprite material */
  material: SpriteNodeMaterial;
  /** Uniforms for runtime updates */
  uniforms: FlowerMaterialUniforms;
}

/**
 * Create TSL uniforms for flower material
 *
 * @param config - Flower configuration
 * @returns Uniform objects for material
 */
export function createFlowerUniforms(
  config: Partial<FlowerConfig> = {},
): FlowerMaterialUniforms {
  const color = { ...DEFAULT_FLOWER_CONFIG.color, ...config.color };

  return {
    time: tslUniform(0.0),
    color1: tslUniform(
      new THREE.Color(color.color1.r, color.color1.g, color.color1.b),
    ),
    color2: tslUniform(
      new THREE.Color(color.color2.r, color.color2.g, color.color2.b),
    ),
    colorStrength: tslUniform(color.colorStrength),
    windIntensity: tslUniform(0.5),
    windDirection: tslUniform(new THREE.Vector2(1, 0)),
  };
}

/**
 * Create a TSL flower material with billboard sprites
 *
 * This material uses SpriteNodeMaterial for efficient billboard rendering.
 * Expects instance attributes:
 * - instanceData (vec4): x, z, scale, colorIndex
 * - instanceVariation (vec4): phaseOffset, windVar, heightVar, reserved
 *
 * @param options - Material options
 * @returns Material and uniforms
 */
export function createFlowerMaterial(
  options: FlowerMaterialOptions = {},
): FlowerMaterialResult {
  const config = { ...DEFAULT_FLOWER_CONFIG, ...options.config };
  const uniforms = createFlowerUniforms(config);

  const material = new SpriteNodeMaterial();
  material.precision = "lowp";
  material.transparent = true;
  material.alphaTest = 0.1;

  // Instance attributes
  const instanceData = attribute<"vec4">("instanceData", "vec4");
  const instanceVariation = attribute<"vec4">("instanceVariation", "vec4");

  // Unpack instance data
  const offsetX = instanceData.x;
  const offsetZ = instanceData.y;
  const scale = instanceData.z;
  const colorIndex = instanceData.w;

  const heightVar = instanceVariation.z;

  // Random values per instance
  const rand1 = hash(instanceIndex.add(9234));
  const rand2 = hash(instanceIndex.add(33.87));

  // === WIND ANIMATION ===
  // Multi-frequency natural sway
  const freqX = rand1.mul(0.4).add(0.8);
  const freqZ = rand2.mul(0.3).add(0.85);
  const phaseX = rand1.mul(PI2);
  const phaseZ = rand2.mul(PI2);

  // Use time directly since uniforms.windIntensity is a TSL node
  const baseSpeed = tslFloat(0.8).add(tslFloat(0.3));

  // Layered sway for organic motion
  const sway1X = tslSin(time.mul(baseSpeed.mul(freqX)).add(phaseX));
  const sway2X = tslSin(
    time.mul(baseSpeed.mul(freqX).mul(1.7)).add(phaseX.mul(0.6)),
  );
  const sway1Z = tslSin(time.mul(baseSpeed.mul(freqZ).mul(0.9)).add(phaseZ));
  const sway2Z = tslSin(
    time.mul(baseSpeed.mul(freqZ).mul(1.5)).add(phaseZ.mul(0.8)),
  );

  // Blend layers
  const swayX = sway1X.mul(0.6).add(sway2X.mul(0.3)).mul(0.08);
  const swayZ = sway1Z.mul(0.5).add(sway2Z.mul(0.35)).mul(0.06);

  // Position with wind offset (simplified - no uniform access in node graph)
  const finalX = offsetX.add(swayX);
  const finalY = heightVar.add(0.25).clamp(0.0, 1.0); // Base height
  const finalZ = offsetZ.add(swayZ);

  material.positionNode = tslVec3(finalX, finalY, finalZ);

  // Scale
  material.scaleNode = tslVec3(scale, scale, scale);

  // === COLOR ===
  if (options.proceduralColors !== false) {
    // Procedural flower colors
    const pink = tslVec3(
      DEFAULT_FLOWER_PALETTE.pink.r,
      DEFAULT_FLOWER_PALETTE.pink.g,
      DEFAULT_FLOWER_PALETTE.pink.b,
    );
    const yellow = tslVec3(
      DEFAULT_FLOWER_PALETTE.yellow.r,
      DEFAULT_FLOWER_PALETTE.yellow.g,
      DEFAULT_FLOWER_PALETTE.yellow.b,
    );
    const purple = tslVec3(
      DEFAULT_FLOWER_PALETTE.purple.r,
      DEFAULT_FLOWER_PALETTE.purple.g,
      DEFAULT_FLOWER_PALETTE.purple.b,
    );
    const orange = tslVec3(
      DEFAULT_FLOWER_PALETTE.orange.r,
      DEFAULT_FLOWER_PALETTE.orange.g,
      DEFAULT_FLOWER_PALETTE.orange.b,
    );

    // Select color based on colorIndex (0-1 maps to 4 colors)
    const colorIdx = tslFloor(colorIndex.mul(4));
    const selectedColor1 = tslMix(pink, yellow, tslStep(tslFloat(1), colorIdx));
    const selectedColor2 = tslMix(
      selectedColor1,
      purple,
      tslStep(tslFloat(2), colorIdx),
    );
    const finalColor = tslMix(
      selectedColor2,
      orange,
      tslStep(tslFloat(3), colorIdx),
    );

    // Petal pattern (simple circle)
    const uvCoord = tslUv();
    const distFromCenter = uvCoord.sub(0.5).length();
    const petalPattern = tslStep(distFromCenter, tslFloat(0.4));

    // Use a constant color strength since uniforms can't be directly multiplied
    material.colorNode = finalColor.mul(petalPattern).mul(tslFloat(0.275));
    material.opacityNode = petalPattern;
  } else {
    // Procedural fallback - simple white with variation
    const uvCoord = tslUv();
    const distFromCenter = uvCoord.sub(0.5).length();
    const petalPattern = tslStep(distFromCenter, tslFloat(0.4));
    material.colorNode = tslVec3(1.0, 1.0, 1.0).mul(petalPattern);
    material.opacityNode = petalPattern;
  }

  return { material, uniforms };
}

/**
 * Update flower material time for animation
 *
 * @param uniforms - Material uniforms
 * @param elapsedTime - Total elapsed time in seconds
 */
export function updateFlowerTime(
  uniforms: FlowerMaterialUniforms,
  elapsedTime: number,
): void {
  uniforms.time.value = elapsedTime;
}

/**
 * Update flower material wind parameters
 *
 * @param uniforms - Material uniforms
 * @param intensity - Wind intensity (0-1)
 * @param direction - Wind direction (will be normalized)
 */
export function updateFlowerWind(
  uniforms: FlowerMaterialUniforms,
  intensity: number,
  direction?: THREE.Vector2,
): void {
  uniforms.windIntensity.value = intensity;
  if (direction) {
    uniforms.windDirection.value.copy(direction).normalize();
  }
}

/**
 * Update flower material colors
 *
 * @param uniforms - Material uniforms
 * @param color1 - Primary tint color
 * @param color2 - Secondary tint color
 */
export function updateFlowerColors(
  uniforms: FlowerMaterialUniforms,
  color1: THREE.Color,
  color2: THREE.Color,
): void {
  uniforms.color1.value.copy(color1);
  uniforms.color2.value.copy(color2);
}
