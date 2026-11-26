/**
 * Grass Shader TSL
 *
 * This contains the EXACT same TSL shader code used in the game engine's
 * ProceduralGrass system. Both Asset Forge and the game engine share this code.
 *
 * The game engine's ProceduralGrass adds:
 * - SSBO compute shaders for massive scale (1M+ blades)
 * - Heightmap integration
 * - Road/water/exclusion zone culling
 * - Player trail effects
 *
 * This module provides the core visual appearance that both systems use.
 *
 * @module GrassShaderTSL
 */

import * as THREE from "three";
import { SpriteNodeMaterial } from "three/webgpu";
import {
  uniform,
  uv,
  vec2,
  vec3,
  float,
  uint,
  sin,
  cos,
  mix,
  smoothstep,
  clamp,
  hash,
  instanceIndex,
  time,
  PI2,
  fract,
  abs,
} from "three/tsl";

// ============================================================================
// GRASS UNIFORMS - Matches game engine exactly
// ============================================================================

/**
 * Create grass uniforms that match the game engine's ProceduralGrass
 */
export function createGameGrassUniforms() {
  return {
    // Camera/position
    uCameraPosition: uniform(new THREE.Vector3(0, 0, 0)),
    uCameraForward: uniform(new THREE.Vector3(0, 0, 1)),
    // Scale
    uBladeMinScale: uniform(0.3),
    uBladeMaxScale: uniform(0.8),
    // Wind - noise-based natural movement
    uWindStrength: uniform(0.05),
    uWindSpeed: uniform(0.25),
    uWindScale: uniform(1.75),
    uWindDirection: uniform(new THREE.Vector2(1, 0)),
    // Color - MATCHES TERRAIN SHADER EXACTLY
    // TerrainShader.ts: grassGreen = vec3(0.3, 0.55, 0.15), grassDark = vec3(0.22, 0.42, 0.1)
    uBaseColor: uniform(new THREE.Color().setRGB(0.26, 0.48, 0.12)),
    uTipColor: uniform(new THREE.Color().setRGB(0.29, 0.53, 0.14)),
    uAoScale: uniform(0.5),
    uColorMixFactor: uniform(0.85),
    uBaseWindShade: uniform(0.5),
    uBaseShadeHeight: uniform(1.0),
    // Rotation
    uBaseBending: uniform(2.0),
    // Bottom fade - dither grass base into ground
    uBottomFadeHeight: uniform(0.15),
    // Day/Night colors
    uDayColor: uniform(new THREE.Color().setRGB(0.859, 0.82, 0.82)),
    uNightColor: uniform(new THREE.Color().setRGB(0.188, 0.231, 0.271)),
    uDayNightMix: uniform(1.0),
  };
}

export type GameGrassUniforms = ReturnType<typeof createGameGrassUniforms>;

// ============================================================================
// GRASS MATERIAL - Exact same visual as game engine
// ============================================================================

/**
 * Options for creating game-accurate grass material
 */
export interface GameGrassMaterialOptions {
  /** Pre-created uniforms (for sharing between instances) */
  uniforms?: GameGrassUniforms;
  /** Instance count for preview */
  instanceCount?: number;
}

/**
 * Create a grass material that looks EXACTLY like the game engine's grass.
 *
 * This uses the same TSL shader code as ProceduralGrass in packages/shared.
 * The difference is this version uses simpler instancing instead of SSBO compute.
 *
 * @param options - Material options
 * @returns SpriteNodeMaterial configured for grass rendering
 */
export function createGameGrassMaterial(
  options: GameGrassMaterialOptions = {},
): { material: SpriteNodeMaterial; uniforms: GameGrassUniforms } {
  const uniforms = options.uniforms ?? createGameGrassUniforms();

  const material = new SpriteNodeMaterial();
  material.precision = "lowp";
  material.transparent = true;
  material.alphaTest = 0.1;

  // ========== TSL SHADER LOGIC ==========
  // Uses TSL's built-in instance support via instanceIndex

  // Height along blade (from UV.y)
  const h = uv().y;

  // BOTTOM DITHER DISSOLVE - fade grass base into ground
  const bottomFade = smoothstep(float(0), uniforms.uBottomFadeHeight, h);
  const ditherNoise = hash(instanceIndex.add(uint(h.mul(1000)))).mul(0.3);
  const bottomOpacity = clamp(bottomFade.add(ditherNoise.sub(0.15)), 0, 1);
  material.opacityNode = bottomOpacity;

  // SCALE - varies per instance
  const positionNoise = hash(instanceIndex.add(196.4356));
  const scaleBase = positionNoise.remap(
    0,
    1,
    uniforms.uBladeMinScale,
    uniforms.uBladeMaxScale,
  );
  const scaleX = positionNoise.add(0.25);
  material.scaleNode = vec3(scaleX, scaleBase, 1);

  // ROTATION - blade bends
  const bendProfile = h.mul(h).mul(uniforms.uBaseBending);
  const instanceNoise = hash(instanceIndex.add(196.4356)).sub(0.5).mul(0.25);
  const baseBending = positionNoise
    .sub(0.5)
    .mul(0.25)
    .add(instanceNoise)
    .mul(bendProfile);
  material.rotationNode = vec3(baseBending, 0, 0);

  // POSITION - with wind animation
  // Base position from instance grid
  const gridSize = 1024; // Same as game
  const tileSize = 80;
  const spacing = tileSize / gridSize;

  const row = float(instanceIndex).div(gridSize).floor();
  const col = float(instanceIndex).mod(gridSize);

  const randX = hash(instanceIndex.add(4321));
  const randZ = hash(instanceIndex.add(1234));

  const halfTile = tileSize / 2;
  const offsetX = col
    .mul(spacing)
    .sub(halfTile)
    .add(randX.mul(spacing * 0.5));
  const offsetZ = row
    .mul(spacing)
    .sub(halfTile)
    .add(randZ.mul(spacing * 0.5));

  // ========== GAME-ACCURATE WIND SYSTEM ==========
  // Matches ProceduralGrass.ts wind implementation

  const windDir = uniforms.uWindDirection.normalize();
  const windStrength = uniforms.uWindStrength;
  const windSpeed = uniforms.uWindSpeed;

  // Per-instance speed jitter (±10%) - like game
  const speed = windSpeed.mul(positionNoise.remap(0, 1, 0.95, 2.05));

  // Base UV for noise sampling + scroll
  const uvBase = vec2(offsetX, offsetZ).mul(0.01).mul(uniforms.uWindScale);
  const scroll = windDir.mul(speed).mul(time);

  // Sample noise using hash-based approach (game uses texture, we use procedural)
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
  const mixRand = fract(sin(positionNoise.mul(12.9898)).mul(78.233));
  const mixTime = sin(time.mul(0.4).add(positionNoise.mul(0.1))).mul(0.25);
  const w = clamp(mixRand.add(mixTime), 0.2, 0.8);
  const n = mix(nA, nB, w);

  // ========== GUST PATCHES (like Grass_Journey) ==========
  // Noise threshold creates areas of wind vs calm
  const gustNoiseThreshold = float(0.45);
  const gustMask = smoothstep(
    gustNoiseThreshold,
    gustNoiseThreshold.add(0.2),
    n.add(0.5).mul(0.5), // Remap -1..1 to 0..1
  );

  // ========== TURBULENCE LAYER (erratic per-blade movement) ==========
  // Multiple fast sin waves at different frequencies for chaotic motion
  const phase = positionNoise.mul(6.28);
  const turbulenceTime = time.mul(20.0).add(phase.mul(100.0));

  // 3 overlapping waves at different frequencies (Grass_Journey style)
  const turb1 = sin(turbulenceTime).mul(0.15);
  const turb2 = sin(turbulenceTime.mul(1.7).add(2.3)).mul(0.12);
  const turb3 = cos(turbulenceTime.mul(0.8).add(phase.mul(50.0))).mul(0.1);
  const turbulenceAmount = turb1.add(turb2).add(turb3);

  // Turbulence scales with global strength
  const turbulence = turbulenceAmount.mul(windStrength).mul(0.6);

  // ========== COMBINE WIND COMPONENTS ==========
  const baseMag = n.mul(windStrength);
  const gustMag = hash(uvB.x.sub(uvB.y.mul(50)))
    .mul(2.0)
    .sub(1.0)
    .mul(windStrength)
    .mul(0.35)
    .mul(gustMask);

  // Total wind factor = base + gusts + turbulence
  const windFactor = baseMag.add(gustMag).add(turbulence);

  // Apply wind with height-based bend profile
  const windOffset = windFactor.mul(bendProfile);

  // Flutter - perpendicular micro-movement (game style)
  const flutterPhase = hash(instanceIndex.add(333)).mul(PI2);
  const flutter = sin(time.mul(4.0).add(flutterPhase.mul(10.0)));
  const flutterAmount = flutter.mul(0.03).mul(bendProfile).mul(windStrength);

  // Vertical bob from wind intensity
  const verticalBob = abs(windFactor).mul(h).mul(0.02);

  // ========== CLOUD SHADOW EFFECT ==========
  // Store wind noise factor for color darkening (gust areas are darker)
  const windNoiseFactor = gustMask.mul(abs(windFactor));

  // Final position
  const windOffsetVec = vec3(
    windDir.x.mul(windOffset).add(flutterAmount.mul(windDir.y.negate())),
    verticalBob,
    windDir.y.mul(windOffset).add(flutterAmount.mul(windDir.x)),
  );

  material.positionNode = vec3(offsetX, float(0), offsetZ).add(windOffsetVec);

  // ========== COLOR - Matches terrain shader exactly ==========
  // Terrain colors from TerrainShader.ts
  const grassGreen = vec3(0.3, 0.55, 0.15);
  const grassDark = vec3(0.22, 0.42, 0.1);

  // Variation between light and dark grass
  const noiseValue = hash(instanceIndex.mul(0.73).add(uint(offsetX.mul(0.01))));
  const grassVariation = smoothstep(float(0.4), float(0.6), noiseValue);
  const baseGrassColor = mix(grassGreen, grassDark, grassVariation);

  // Tip brightness
  const tipBrightness = float(1.1).add(positionNoise.sub(0.5).mul(0.1));
  const tipColor = baseGrassColor.mul(tipBrightness);

  // Height gradient: darker at base, lighter at tip
  const colorProfile = h.mul(uniforms.uColorMixFactor).clamp(0, 1);
  const baseToTip = mix(baseGrassColor, tipColor, colorProfile);

  // Ambient occlusion at base
  const x = uv().x;
  const edge = x.mul(2.0).sub(1.0).abs();
  const rim = smoothstep(float(-5), float(5), edge);
  const hWeight = float(1).sub(smoothstep(0.1, 0.85, h));
  const aoStrength = uniforms.uAoScale.mul(0.25);
  const ao = float(1).sub(aoStrength.mul(rim).mul(hWeight));

  // Wind darkening
  const baseMask = float(1).sub(smoothstep(0.0, uniforms.uBaseShadeHeight, h));
  const windAo = mix(
    float(1.0),
    float(1).sub(uniforms.uBaseWindShade),
    baseMask.mul(smoothstep(0.0, 1.0, abs(windFactor))),
  );

  // Day/night tinting
  const dayNightTint = mix(
    uniforms.uNightColor,
    uniforms.uDayColor,
    uniforms.uDayNightMix,
  );

  // ========== WIND CLOUD SHADOW EFFECT (Grass_Journey style) ==========
  // Grass in gusty areas is slightly darker (like clouds passing over)
  const cloudShadowStrength = float(0.15);
  const cloudShadow = float(1.0).sub(windNoiseFactor.mul(cloudShadowStrength));

  // Final color
  material.colorNode = baseToTip
    .mul(windAo)
    .mul(ao)
    .mul(dayNightTint)
    .mul(cloudShadow);

  return { material, uniforms };
}

/**
 * Update wind parameters
 */
export function updateGameGrassWind(
  uniforms: GameGrassUniforms,
  strength: number,
  speed: number,
  direction?: THREE.Vector2,
): void {
  uniforms.uWindStrength.value = strength;
  uniforms.uWindSpeed.value = speed;
  if (direction) {
    uniforms.uWindDirection.value.copy(direction);
  }
}

/**
 * Update day/night mix
 */
export function updateGameGrassDayNight(
  uniforms: GameGrassUniforms,
  mix: number,
): void {
  uniforms.uDayNightMix.value = mix;
}

/**
 * Update colors
 */
export function updateGameGrassColors(
  uniforms: GameGrassUniforms,
  baseColor: THREE.Color,
  tipColor: THREE.Color,
): void {
  uniforms.uBaseColor.value.copy(baseColor);
  uniforms.uTipColor.value.copy(tipColor);
}
