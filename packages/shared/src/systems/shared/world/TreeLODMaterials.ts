/**
 * TreeLODMaterials.ts - TSL Materials for Tree LOD Rendering
 *
 * Provides WebGPU-native TSL materials for:
 * - Branch card billboards (SpeedTree-style)
 * - Instanced leaf cards (LOD0)
 * - Cross-fade LOD transitions
 *
 * All materials use Three Shader Language (TSL) for WebGPU compatibility.
 *
 * @module TreeLODMaterials
 */

import type { Node } from "three/webgpu";
import THREE, {
  uniform,
  Fn,
  float,
  vec2,
  vec3,
  add,
  sub,
  mul,
  div,
  sin,
  fract,
  floor,
  smoothstep,
  mix,
  max,
  step,
  abs,
  mod,
  dot,
  normalize,
  positionLocal,
  positionWorld,
  screenUV,
  viewportSize,
  uv,
  instanceIndex,
  cameraPosition,
  normalWorld,
  texture,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
} from "../../../extras/three/three";
import type { TextureNode, UniformNode } from "three/webgpu";

import { applySkyFog } from "./FogConfig";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Branch card material uniforms.
 */
export interface BranchCardUniforms {
  /** Wind time accumulator */
  time: UniformNode<"float", number>;
  /** Wind strength (0-1) */
  windStrength: UniformNode<"float", number>;
  /** Wind direction (normalized) */
  windDirection: UniformNode<"vec3", THREE.Vector3>;
  /** Card atlas texture */
  cardAtlas: TextureNode<"vec4">;
  /** LOD fade factor (0 = invisible, 1 = opaque) */
  lodFade: UniformNode<"float", number>;
  /** Camera position for billboard orientation */
  cameraPos: UniformNode<"vec3", THREE.Vector3>;
}

/**
 * Instanced leaf material uniforms.
 */
export interface InstancedLeafUniforms {
  /** Wind time accumulator */
  time: UniformNode<"float", number>;
  /** Wind strength (0-1) */
  windStrength: UniformNode<"float", number>;
  /** Wind direction (normalized) */
  windDirection: UniformNode<"vec3", THREE.Vector3>;
  /** Base leaf color */
  baseColor: UniformNode<"color", THREE.Color>;
  /** Secondary color for variation */
  secondaryColor: UniformNode<"color", THREE.Color>;
  /** Subsurface scattering color (backlit leaves) */
  subsurfaceColor: UniformNode<"color", THREE.Color>;
  /** Sun direction for SSS */
  sunDirection: UniformNode<"vec3", THREE.Vector3>;
  /** LOD fade multiplier */
  lodFade: UniformNode<"float", number>;
  /** Day/night mix (0 = night, 1 = day) - affects SSS intensity */
  dayNightMix: UniformNode<"float", number>;
}

/**
 * Extended MeshStandardNodeMaterial with branch card uniforms.
 */
export interface BranchCardMaterial extends THREE.MeshStandardNodeMaterial {
  uniforms: BranchCardUniforms;
  updateWind(time: number, strength: number, direction: THREE.Vector3): void;
  updateLODFade(fade: number): void;
}

/**
 * Extended MeshStandardNodeMaterial with instanced leaf uniforms.
 */
export interface InstancedLeafMaterial extends THREE.MeshStandardNodeMaterial {
  uniforms: InstancedLeafUniforms;
  updateWind(time: number, strength: number, direction: THREE.Vector3): void;
  updateLighting(sunDirection: THREE.Vector3, dayMix?: number): void;
  updateLODFade(fade: number): void;
}

// ============================================================================
// WIND ANIMATION FUNCTIONS (TSL)
// ============================================================================

/**
 * Creates wind displacement function for TSL materials.
 * Simulates natural wind sway with main wave + gusts.
 */
function createWindDisplacement(
  uTime: UniformNode<"float", number>,
  uStrength: UniformNode<"float", number>,
  uDirection: UniformNode<"vec3", THREE.Vector3>,
) {
  // Wind constants
  const MAIN_SPEED = 2.0;
  const MAIN_AMP = 0.08;
  const GUST_SPEED = 0.7;
  const GUST_AMP = 0.03;
  const MICRO_SPEED = 5.0;
  const MICRO_AMP = 0.01;

  return Fn(([pos, heightFactor]: [Node<"vec3">, Node<"float">]) => {
    // Spatial phase based on position
    const phase = add(mul(pos.x, float(0.5)), mul(pos.z, float(0.7)));

    // Main wind wave (slow, large sway)
    const mainWave = sin(add(mul(uTime, float(MAIN_SPEED)), phase));

    // Gust wave (medium speed, adds variation)
    const gustPhase = mul(phase, float(1.3));
    const gustWave = sin(add(mul(uTime, float(GUST_SPEED)), gustPhase));

    // Micro flutter (fast, small, per-leaf variation)
    const microPhase = add(phase, mul(float(instanceIndex), float(0.1)));
    const microWave = sin(add(mul(uTime, float(MICRO_SPEED)), microPhase));

    // Combine waves
    const totalWave = add(
      add(mul(mainWave, float(MAIN_AMP)), mul(gustWave, float(GUST_AMP))),
      mul(microWave, float(MICRO_AMP)),
    );

    // Apply height factor and wind strength
    const displacement = mul(mul(totalWave, heightFactor), uStrength);

    // Displacement along wind direction
    const offsetX = mul(displacement, uDirection.x);
    const offsetZ = mul(displacement, uDirection.z);
    // Slight vertical bob
    const offsetY = mul(mul(mainWave, float(0.02)), heightFactor);

    return vec3(offsetX, offsetY, offsetZ);
  });
}

/**
 * Creates procedural leaf shape SDF for alpha cutout.
 * Returns opacity value (0-1).
 */
function createLeafShapeSDF() {
  return Fn(([uvCoord]: [Node<"vec2">]) => {
    // Centered coordinates
    const px = sub(uvCoord.x, float(0.5));
    const py = sub(uvCoord.y, float(0.35));

    // Normalized Y (0 at bottom, ~1 at top)
    const normalizedY = add(mul(py, float(1.3)), float(0.5));

    // Parabolic width profile - widest at 40% height
    const widthProfile = mul(
      smoothstep(float(0.0), float(0.4), normalizedY),
      sub(float(1.0), smoothstep(float(0.4), float(1.0), normalizedY)),
    );
    const baseTaper = add(float(0.3), mul(widthProfile, float(0.7)));

    // Tip taper
    const tipTaper = smoothstep(float(0.65), float(0.95), normalizedY);
    const effectiveWidth = mul(
      baseTaper,
      sub(float(1.0), mul(tipTaper, float(0.7))),
    );

    // Per-instance serrated edge
    const instIdx = float(instanceIndex);
    const serrationSeed = fract(mul(instIdx, float(0.0137)));
    const serrationFreq = add(float(4.0), mul(serrationSeed, float(3.0)));
    const serrationAmp = mul(
      float(0.08),
      mul(effectiveWidth, sub(float(1.0), tipTaper)),
    );
    const serration = mul(
      sin(mul(normalizedY, mul(serrationFreq, float(6.28)))),
      serrationAmp,
    );

    // Calculate if point is inside leaf
    const maxHalfWidth = add(mul(effectiveWidth, float(0.38)), serration);
    const insideWidth = sub(
      float(1.0),
      smoothstep(mul(maxHalfWidth, float(0.85)), maxHalfWidth, abs(px)),
    );

    // Length mask
    const lengthMask = mul(
      smoothstep(float(-0.15), float(0.05), normalizedY),
      smoothstep(float(1.05), float(0.85), normalizedY),
    );

    return mul(insideWidth, lengthMask);
  });
}

/**
 * Creates procedural leaf vein pattern.
 * Returns darkening factor for veins (0 = dark vein, 1 = no vein).
 */
function createLeafVeins() {
  return Fn(([uvCoord]: [Node<"vec2">]) => {
    const px = sub(uvCoord.x, float(0.5));
    const py = sub(uvCoord.y, float(0.35));
    const normalizedY = add(mul(py, float(1.3)), float(0.5));

    // Central vein
    const tipTaper = smoothstep(float(0.65), float(0.95), normalizedY);
    const veinWidth = mul(float(0.025), sub(float(1.0), tipTaper));
    const centralVein = sub(
      float(1.0),
      mul(smoothstep(veinWidth, float(0.0), abs(px)), float(0.2)),
    );

    // Side veins (curved lines from central vein)
    const sideVeinCount = float(5.0);
    const veinSpacing = div(float(1.0), sideVeinCount);
    const veinY = mod(normalizedY, veinSpacing);
    const veinPhase = div(veinY, veinSpacing);

    // Curved side vein
    const sideVeinX = mul(
      veinPhase,
      mul(float(0.4), sub(float(1.0), tipTaper)),
    );
    const sideVeinDist = abs(sub(abs(px), sideVeinX));
    const sideVein = sub(
      float(1.0),
      mul(smoothstep(float(0.02), float(0.0), sideVeinDist), float(0.1)),
    );

    return mul(centralVein, sideVein);
  });
}

// ============================================================================
// BRANCH CARD MATERIAL
// ============================================================================

/**
 * Creates a TSL material for SpeedTree-style branch cards.
 *
 * Features:
 * - Billboard orientation toward camera
 * - Wind animation with branch-like sway
 * - Atlas texture sampling
 * - LOD fade via dithered dissolve
 */
export function createBranchCardMaterial(
  cardAtlas: THREE.Texture,
): BranchCardMaterial {
  const material = new MeshStandardNodeMaterial() as BranchCardMaterial;

  // Create uniforms
  const uTime = uniform(0);
  const uWindStrength = uniform(0.5);
  const uWindDirection = uniform(new THREE.Vector3(1, 0, 0));
  const uLodFade = uniform(1);
  const uCameraPos = uniform(new THREE.Vector3());

  // Store texture reference for TSL
  const atlasTexture = cardAtlas;

  material.uniforms = {
    time: uTime,
    windStrength: uWindStrength,
    windDirection: uWindDirection,
    cardAtlas: texture(cardAtlas),
    lodFade: uLodFade,
    cameraPos: uCameraPos,
  };

  // Wind displacement function
  const windDisplace = createWindDisplacement(
    uTime,
    uWindStrength,
    uWindDirection,
  );

  // Position node with billboard orientation and wind
  material.positionNode = Fn(() => {
    const localPos = positionLocal;
    const worldPos = positionWorld;

    // Height factor for wind (cards attached at bottom sway more at top)
    const cardHeight = float(1.5); // Approximate card height
    const heightFactor = smoothstep(float(0.0), cardHeight, localPos.y);

    // Get wind offset
    const windOffset = windDisplace(worldPos, heightFactor);

    // Apply wind to local position
    return add(localPos, windOffset);
  })();

  // Color from atlas texture
  material.colorNode = Fn(() => {
    const uvCoord = uv();
    const atlasColor = texture(atlasTexture, uvCoord);
    return atlasColor.rgb;
  })();

  // Opacity with LOD fade dithering
  material.opacityNode = Fn(() => {
    const uvCoord = uv();
    const atlasAlpha = texture(atlasTexture, uvCoord).a;

    // Dithered LOD fade
    const screenPos = screenUV;
    const ditherPattern = fract(
      add(mul(screenPos.x, float(4.0)), mul(screenPos.y, float(4.0))),
    );
    const ditherThreshold = sub(uLodFade, mul(ditherPattern, float(0.5)));

    // Combine atlas alpha with LOD fade
    const fadedAlpha = mul(atlasAlpha, step(float(0.5), ditherThreshold));
    return fadedAlpha;
  })();

  material.transparent = false;
  material.alphaTest = 0.5;
  material.side = THREE.DoubleSide;
  material.depthWrite = true;

  // Helper methods
  material.updateWind = (
    time: number,
    strength: number,
    direction: THREE.Vector3,
  ) => {
    uTime.value = time;
    uWindStrength.value = strength;
    uWindDirection.value.copy(direction);
  };

  material.updateLODFade = (fade: number) => {
    uLodFade.value = fade;
  };

  applySkyFog(material);

  return material;
}

// ============================================================================
// INSTANCED LEAF MATERIAL
// ============================================================================

/**
 * Creates a TSL material for compute-instanced leaves.
 *
 * Features:
 * - Procedural leaf shape (no texture needed)
 * - Wind animation with micro-flutter
 * - Subsurface scattering (backlit leaves glow)
 * - Per-instance color variation
 * - LOD density fade
 */
export function createInstancedLeafMaterial(): InstancedLeafMaterial {
  const material = new MeshStandardNodeMaterial() as InstancedLeafMaterial;

  // Create uniforms
  const uTime = uniform(0);
  const uWindStrength = uniform(0.5);
  const uWindDirection = uniform(new THREE.Vector3(1, 0, 0));
  const uBaseColor = uniform(new THREE.Color(0x3d7a3d));
  const uSecondaryColor = uniform(new THREE.Color(0x5a9a5a));
  const uSubsurfaceColor = uniform(new THREE.Color(0x8fbc8f));
  const uSunDirection = uniform(new THREE.Vector3(0.5, 1, 0.3).normalize());
  const uLodFade = uniform(1);
  const uDayNightMix = uniform(1.0); // 1.0 = day, 0.0 = night

  material.uniforms = {
    time: uTime,
    windStrength: uWindStrength,
    windDirection: uWindDirection,
    baseColor: uBaseColor,
    secondaryColor: uSecondaryColor,
    subsurfaceColor: uSubsurfaceColor,
    sunDirection: uSunDirection,
    lodFade: uLodFade,
    dayNightMix: uDayNightMix,
  };

  // Wind displacement
  const windDisplace = createWindDisplacement(
    uTime,
    uWindStrength,
    uWindDirection,
  );

  // Leaf shape SDF
  const leafShape = createLeafShapeSDF();

  // Leaf veins
  const leafVeins = createLeafVeins();

  // Position node with wind
  material.positionNode = Fn(() => {
    const localPos = positionLocal;
    const worldPos = positionWorld;

    // Leaf card size
    const leafHeight = float(0.225); // 0.15 * 1.5
    const heightFactor = smoothstep(float(0.0), leafHeight, localPos.y);

    // Wind offset
    const windOffset = windDisplace(worldPos, heightFactor);

    return add(localPos, windOffset);
  })();

  // Color node with variation and veins
  material.colorNode = Fn(() => {
    const uvCoord = uv();

    // Per-instance color variation using golden ratio hash
    const instIdx = float(instanceIndex);
    const colorHash = fract(mul(instIdx, float(0.618033988)));
    const variedColor = mix(uBaseColor, uSecondaryColor, colorHash);

    // Apply vein darkening
    const veinFactor = leafVeins(uvCoord);
    const veinedColor = mul(variedColor, veinFactor);

    // UV-based gradient (darker at base, lighter at tip)
    const tipGradient = smoothstep(float(0.2), float(0.8), uvCoord.y);
    const gradientColor = add(veinedColor, mul(vec3(float(0.05)), tipGradient));

    return gradientColor;
  })();

  // Opacity with leaf shape
  material.opacityNode = Fn(() => {
    const uvCoord = uv();
    const shape = leafShape(uvCoord);

    // LOD fade with dithering
    const screenPos = screenUV;
    const ditherPattern = fract(
      add(
        mul(floor(mul(screenPos.x, viewportSize.x)), float(0.5)),
        mul(floor(mul(screenPos.y, viewportSize.y)), float(0.5)),
      ),
    );
    const fadeThreshold = sub(
      uLodFade,
      mul(sub(ditherPattern, float(0.5)), float(0.1)),
    );

    return mul(shape, step(float(0.5), fadeThreshold));
  })();

  // Subsurface scattering (simple approximation)
  material.emissiveNode = Fn(() => {
    const worldNorm = normalWorld;
    const viewDir = normalize(sub(cameraPosition, positionWorld));

    // Backlit check: dot product of view and sun direction
    const backlit = max(
      float(0.0),
      dot(mul(uSunDirection, float(-1.0)), viewDir),
    );

    // SSS intensity based on backlit and normal alignment
    // Modulated by day/night mix (less SSS at night since there's less sun)
    const normalAlignment = max(float(0.0), dot(worldNorm, uSunDirection));
    const sssIntensity = mul(
      mul(mul(backlit, normalAlignment), float(0.3)),
      uDayNightMix,
    );

    return mul(uSubsurfaceColor.rgb, sssIntensity);
  })();

  // Alpha test node - required for TSL materials to enable alpha cutoff
  // Fragment is discarded when opacity < alphaTestNode
  material.alphaTestNode = float(0.5);

  material.transparent = false;
  material.alphaTest = 0.5; // Fallback for non-TSL path
  material.side = THREE.DoubleSide;
  material.depthWrite = true;
  material.roughness = 0.7;
  material.metalness = 0.0;

  // Helper methods
  material.updateWind = (
    time: number,
    strength: number,
    direction: THREE.Vector3,
  ) => {
    uTime.value = time;
    uWindStrength.value = strength;
    uWindDirection.value.copy(direction);
  };

  material.updateLighting = (sunDirection: THREE.Vector3, dayMix?: number) => {
    uSunDirection.value.copy(sunDirection).normalize();
    if (dayMix !== undefined) {
      uDayNightMix.value = dayMix;
    }
  };

  material.updateLODFade = (fade: number) => {
    uLodFade.value = fade;
  };

  applySkyFog(material);

  return material;
}

// ============================================================================
// LOD CROSS-FADE MATERIAL MODIFIER
// ============================================================================

/**
 * Adds LOD cross-fade capability to any material.
 * Uses screen-space dithering for smooth transitions.
 */
export function addLODCrossFade(
  material: THREE.MeshStandardNodeMaterial,
  fadeUniform: UniformNode<"float", number>,
): void {
  // Create dithered fade opacity node
  const fadeOpacityNode = Fn(() => {
    // Screen-space dither for smooth transitions
    const screenPos = screenUV;
    const ditherX = fract(
      mul(floor(mul(screenPos.x, viewportSize.x)), float(0.5)),
    );
    const ditherY = fract(
      mul(floor(mul(screenPos.y, viewportSize.y)), float(0.5)),
    );
    const ditherPattern = add(ditherX, ditherY);

    // Fade threshold with hysteresis
    const fadeThreshold = sub(
      fadeUniform,
      mul(sub(ditherPattern, float(0.5)), float(0.2)),
    );

    return step(float(0.5), fadeThreshold);
  })();

  // If material has existing opacity, multiply with fade
  // Otherwise just use fade directly
  if (material.opacityNode) {
    // Use shader node method chaining for multiplication
    const existingOpacity = material.opacityNode as ReturnType<typeof float>;
    material.opacityNode = existingOpacity.mul(fadeOpacityNode);
  } else {
    material.opacityNode = fadeOpacityNode;
  }
}

// ============================================================================
// SHADOW MATERIAL
// ============================================================================

/**
 * Creates a simplified depth-only material for shadow rendering.
 * Much cheaper than full leaf material but maintains silhouette.
 */
export function createLeafShadowMaterial(): THREE.MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();

  // Simplified leaf shape (faster for shadows)
  material.opacityNode = Fn(() => {
    const uvCoord = uv();
    const px = sub(uvCoord.x, float(0.5));
    const py = sub(uvCoord.y, float(0.4));

    // Simple ellipse for shadow
    const ellipseX = div(abs(px), float(0.35));
    const ellipseY = div(abs(py), float(0.45));
    const dist = add(mul(ellipseX, ellipseX), mul(ellipseY, ellipseY));

    return sub(float(1.0), smoothstep(float(0.8), float(1.0), dist));
  })();

  material.transparent = false;
  material.alphaTest = 0.5;
  material.side = THREE.DoubleSide;

  return material;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { createWindDisplacement, createLeafShapeSDF, createLeafVeins };
