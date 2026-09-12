/**
 * GPUMaterials.ts - GPU-Driven Material Factories
 *
 * Provides GPU-accelerated materials using WebGPU/Three.js TSL.
 * Shared across vegetation, mobs, resources, and imposters.
 *
 * ## Material Factories
 * - `createGPUVegetationMaterial()` - Vegetation (far dissolve + water culling + fog)
 * - `createDissolveMaterial()` - Generic dissolve for instanced models (resources, mobs)
 * - `createImposterMaterial()` - Billboard imposter with dithered dissolve
 *
 * ## Shared Shader Features
 * - Screen-space dithered dissolve (Bayer 4x4)
 * - Camera-to-player occlusion cone (classic fantasy MMORPG-style)
 * - Near-camera depth fade
 * - Per-instance Fresnel rim highlight
 *
 * @module GPUMaterials
 */

import * as THREE from "../../../extras/three/three";
import type { Node, NodeBuilder } from "three/webgpu";
import {
  uniform,
  sub,
  add,
  mul,
  div,
  Fn,
  MeshStandardNodeMaterial,
  float,
  dot,
  vec2,
  vec3,
  vec4,
  smoothstep,
  positionLocal,
  positionWorld,
  screenUV,
  cameraPosition,
  vertexColor,
  step,
  texture,
  mix,
  output,
  max,
  clamp,
  sqrt,
  mod,
  floor,
  abs,
  sin,
  viewportCoordinate,
  normalView,
  normalWorld,
  normalWorldGeometry,
  normalize,
  pow,
  attribute,
  positionView,
  normalLocal,
  modelNormalMatrix,
} from "../../../extras/three/three";
import { diffuseColor, materialAO, varyingProperty } from "three/tsl";
import { FOG_NEAR_SQ, FOG_FAR_SQ, fogRenderTarget } from "./FogConfig";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import { SUN_SHADE, SUN_LIGHT, NIGHT, applySunShade } from "./LightingConfig";
import { WorldIlluminationUniforms } from "./WorldIlluminationUniforms";
import {
  isCompactSculptProfile,
  type WorldTerrainProfile,
} from "./WorldTerrainProfile";

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * GPU rendering configuration shared by all material factories.
 * Controls dissolve distances, occlusion, near-camera fade, and water culling.
 */
export const GPU_VEG_CONFIG = {
  /** Distance where far fade begins (fully opaque inside) - default for generic dissolve */
  FADE_START: 1000,

  /** Distance where fully invisible (far) - default for generic dissolve */
  FADE_END: 1200,

  /** Distance where near fade ends (fully opaque outside) */
  NEAR_FADE_END: 3,

  /** Distance where near fade begins (fully invisible inside) */
  NEAR_FADE_START: 1,

  /** Max instances per mesh */
  MAX_INSTANCES: 65536,

  /** Water level (Y coordinate) - from centralized TERRAIN_CONSTANTS */
  WATER_LEVEL: TERRAIN_CONSTANTS.WATER_THRESHOLD,

  /** Buffer above water for shoreline avoidance */
  WATER_BUFFER: 3.0,

  // ========== OCCLUSION DISSOLVE CONFIG ==========
  // Camera-to-player line-of-sight dissolve (classic fantasy MMORPG-style)
  // Uses a CONE shape that expands from camera toward player for natural visibility

  /** Radius at camera end of the cone (meters) - keeps near objects visible */
  OCCLUSION_CAMERA_RADIUS: 0.2,

  /** Radius at player end of the cone (meters) - bubble around player */
  OCCLUSION_PLAYER_RADIUS: 1.0,

  /** Extra radius added based on camera distance (meters per meter of distance) */
  OCCLUSION_DISTANCE_SCALE: 0.03,

  /** Minimum distance from camera before occlusion kicks in (prevents near-clip artifacts) */
  OCCLUSION_NEAR_MARGIN: 0.3,

  /** Distance from player where occlusion stops (small buffer behind player) */
  OCCLUSION_FAR_MARGIN: 0.3,

  /** Sharpness of the cutoff edge (higher = sharper, more binary like classic fantasy MMORPG) */
  OCCLUSION_EDGE_SHARPNESS: 0.5,

  /** Maximum occlusion dissolve strength (0 = disabled, matches buildings) */
  OCCLUSION_STRENGTH: 0.0,

  // ========== NEAR-CAMERA DISSOLVE (classic fantasy MMORPG-style depth fade) ==========
  // Prevents hard geometry clipping when camera clips through objects

  /** Distance from camera where near-fade begins (meters) - fully opaque beyond this */
  NEAR_CAMERA_FADE_START: 1.5,

  /** Distance from camera where geometry is fully dissolved (meters) - at near clip */
  NEAR_CAMERA_FADE_END: 0.05,

  // ========== TREE DEPLETION DISSOLVE ==========
  // BatchedMesh channel layout: R = highlight (1.0 or >1.0), G = snow weight,
  // B = 1.0 - dissolveVal. See GLBTreeBatchedInstancer channel layout comment.
  // InstancedMesh uses a dedicated per-instance `instanceDissolve` float attribute.

  /**
   * Duration of the respawn dissolve-in animation (seconds). Depletion is instant.
   * NOTE: BatchedMesh encodes dissolve in a Uint8 blue channel (~256 levels).
   * At 60fps this gives ~18 steps over 0.3s, which is smooth enough. Increasing
   * this value significantly may require switching to Float32 encoding to avoid banding.
   */
  DISSOLVE_DURATION: 0.3,

  /**
   * Animation progress ceiling (not visual opacity).
   * The actual fraction of fragments discarded is controlled by DISSOLVE_ALPHA_SCALE.
   */
  DISSOLVE_MAX: 1.0,

  /**
   * Fraction of fragments discarded when fully dissolved via screen-door dithering.
   * 0.7 = ~70% of the Bayer 4×4 grid cells are discarded, giving a stippled look.
   */
  DISSOLVE_ALPHA_SCALE: 0.7,
} as const;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Uniforms updated per-frame from CPU.
 */
export type GPUVegetationUniforms = {
  playerPos: { value: THREE.Vector3 };
  cameraPos: { value: THREE.Vector3 };
  fadeStart: { value: number };
  fadeEnd: { value: number };
};

/**
 * Material with GPU vegetation uniforms.
 */
export type GPUVegetationMaterial = THREE.Material & {
  gpuUniforms: GPUVegetationUniforms;
};

/**
 * Options for creating GPU vegetation materials.
 */
export type GPUVegetationMaterialOptions = {
  color?: THREE.Color;
  alphaTest?: number;
  fadeStart?: number;
  fadeEnd?: number;
  vertexColors?: boolean;
  /** Enable camera-to-player occlusion dissolve (default: true) */
  enableOcclusionDissolve?: boolean;
};

/**
 * Options for creating generic dissolve materials.
 * Used for mobs, resources, and any entity that needs dissolve.
 */
export type DissolveMaterialOptions = {
  /** Distance where far fade begins */
  fadeStart?: number;
  /** Distance where fully invisible (far) */
  fadeEnd?: number;
  /** Distance where near fade ends (fully opaque outside) */
  nearFadeEnd?: number;
  /** Distance where near fade begins (fully invisible inside) */
  nearFadeStart?: number;
  /** Enable near camera dissolve */
  enableNearFade?: boolean;
  /** Enable water level culling */
  enableWaterCulling?: boolean;
  /** Enable camera-to-player occlusion dissolve (default: true) */
  enableOcclusionDissolve?: boolean;
  /** Enable per-instance rim highlight driven by an instanced attribute */
  enableRimHighlight?: boolean;
  /** Use BatchedMesh highlight (vBatchColor varying) instead of InstancedMesh attribute */
  batched?: boolean;
  /**
   * Enable depletion dissolve dithering (tree-specific).
   * Reads dissolve progress from instanceDissolve attribute (InstancedMesh)
   * or vBatchColor blue channel (BatchedMesh) and applies screen-door
   * dithering in the alphaTestNode.
   */
  enableDepletionDissolve?: boolean;
};

/**
 * Material with generic dissolve uniforms.
 */
export type DissolveMaterial = THREE.MeshStandardNodeMaterial & {
  dissolveUniforms: {
    playerPos: { value: THREE.Vector3 };
    cameraPos: { value: THREE.Vector3 };
    fadeStart: { value: number };
    fadeEnd: { value: number };
    nearFadeStart: { value: number };
    nearFadeEnd: { value: number };
  };
  /** Present when enableRimHighlight was true at creation */
  highlightColor?: { value: THREE.Color };
};

// ============================================================================
// GPU VEGETATION MATERIAL
// ============================================================================

/**
 * Creates a GPU vegetation material with distance-based dithered fade
 * and camera-to-player occlusion dissolve (classic fantasy MMORPG-style).
 *
 * Uses cutout rendering (alphaTest) for performance - no alpha blending.
 * Dithering is per-instance (not per-fragment) for consistent fade.
 *
 * OCCLUSION DISSOLVE:
 * When objects are between the camera and player, they dissolve to reveal the player.
 * The occlusion cylinder radius scales dynamically with camera distance:
 * - Zoomed in (close camera): small radius, subtle dissolve
 * - Zoomed out (far camera): larger radius, more dissolve coverage
 */
export function createGPUVegetationMaterial(
  options: GPUVegetationMaterialOptions = {},
): GPUVegetationMaterial {
  const material = new MeshStandardNodeMaterial();

  // ========== UNIFORMS ==========
  const uPlayerPos = uniform(new THREE.Vector3(0, 0, 0));
  const uCameraPos = uniform(new THREE.Vector3(0, 0, 0));
  const uFadeStart = uniform(options.fadeStart ?? GPU_VEG_CONFIG.FADE_START);
  const uFadeEnd = uniform(options.fadeEnd ?? GPU_VEG_CONFIG.FADE_END);

  // ========== CONSTANTS ==========
  const waterCutoff = float(
    GPU_VEG_CONFIG.WATER_LEVEL + GPU_VEG_CONFIG.WATER_BUFFER,
  );
  const fadeStartSq = mul(uFadeStart, uFadeStart);
  const fadeEndSq = mul(uFadeEnd, uFadeEnd);

  // Occlusion dissolve constants (classic fantasy MMORPG-style cone)
  const enableOcclusion = options.enableOcclusionDissolve !== false;
  const occlusionCameraRadius = float(GPU_VEG_CONFIG.OCCLUSION_CAMERA_RADIUS);
  const occlusionPlayerRadius = float(GPU_VEG_CONFIG.OCCLUSION_PLAYER_RADIUS);
  const occlusionDistanceScale = float(GPU_VEG_CONFIG.OCCLUSION_DISTANCE_SCALE);
  const occlusionNearMargin = float(GPU_VEG_CONFIG.OCCLUSION_NEAR_MARGIN);
  const occlusionFarMargin = float(GPU_VEG_CONFIG.OCCLUSION_FAR_MARGIN);
  const occlusionEdgeSharpness = float(GPU_VEG_CONFIG.OCCLUSION_EDGE_SHARPNESS);
  const occlusionStrength = float(GPU_VEG_CONFIG.OCCLUSION_STRENGTH);

  // Near-camera dissolve constants (classic fantasy MMORPG-style depth fade)
  const nearCameraFadeStart = float(GPU_VEG_CONFIG.NEAR_CAMERA_FADE_START);
  const nearCameraFadeEnd = float(GPU_VEG_CONFIG.NEAR_CAMERA_FADE_END);

  // ========== ALPHA TEST (DITHERED DISSOLVE + OCCLUSION + NEAR-CAMERA FADE) ==========
  material.alphaTestNode = Fn(() => {
    const worldPos = positionWorld;

    // 1. Water check: if below water, use threshold of 2.0 to always discard
    const belowWater = step(worldPos.y, waterCutoff);

    // 2. Distance calculation from WORLD position to player (horizontal only, squared)
    const toPlayer = sub(worldPos, uPlayerPos);
    const distSq = add(
      mul(toPlayer.x, toPlayer.x),
      mul(toPlayer.z, toPlayer.z),
    );

    // 3. Distance factor: 0.0 when close (keep fragment), 1.0 when far (discard fragment)
    const distanceFade = smoothstep(fadeStartSq, fadeEndSq, distSq);

    // 4. CAMERA-TO-PLAYER OCCLUSION DISSOLVE (classic fantasy MMORPG-style)
    const occlusionFade = enableOcclusion
      ? (() => {
          const camToPlayer = vec3(
            sub(uPlayerPos.x, uCameraPos.x),
            sub(uPlayerPos.y, uCameraPos.y),
            sub(uPlayerPos.z, uCameraPos.z),
          );

          const camToFrag = vec3(
            sub(worldPos.x, uCameraPos.x),
            sub(worldPos.y, uCameraPos.y),
            sub(worldPos.z, uCameraPos.z),
          );

          const ctLengthSq = add(
            add(
              mul(camToPlayer.x, camToPlayer.x),
              mul(camToPlayer.y, camToPlayer.y),
            ),
            mul(camToPlayer.z, camToPlayer.z),
          );
          const ctLength = sqrt(ctLengthSq);

          const ctDirX = div(camToPlayer.x, ctLength);
          const ctDirY = div(camToPlayer.y, ctLength);
          const ctDirZ = div(camToPlayer.z, ctLength);

          const projDist = add(
            add(mul(camToFrag.x, ctDirX), mul(camToFrag.y, ctDirY)),
            mul(camToFrag.z, ctDirZ),
          );

          const inRangeNear = step(occlusionNearMargin, projDist);
          const inRangeFar = step(projDist, sub(ctLength, occlusionFarMargin));
          const inRange = mul(inRangeNear, inRangeFar);

          const projX = add(uCameraPos.x, mul(projDist, ctDirX));
          const projY = add(uCameraPos.y, mul(projDist, ctDirY));
          const projZ = add(uCameraPos.z, mul(projDist, ctDirZ));

          const perpX = sub(worldPos.x, projX);
          const perpY = sub(worldPos.y, projY);
          const perpZ = sub(worldPos.z, projZ);
          const perpDistSq = add(
            add(mul(perpX, perpX), mul(perpY, perpY)),
            mul(perpZ, perpZ),
          );
          const perpDist = sqrt(perpDistSq);

          const t = clamp(div(projDist, ctLength), float(0.0), float(1.0));

          const coneRadius = add(
            add(
              occlusionCameraRadius,
              mul(t, sub(occlusionPlayerRadius, occlusionCameraRadius)),
            ),
            mul(ctLength, occlusionDistanceScale),
          );

          const edgeStart = mul(
            coneRadius,
            sub(float(1.0), occlusionEdgeSharpness),
          );
          const rawOcclusionFade = sub(
            float(1.0),
            smoothstep(edgeStart, coneRadius, perpDist),
          );

          return mul(mul(rawOcclusionFade, occlusionStrength), inRange);
        })()
      : float(0.0);

    // 5. NEAR-CAMERA DISSOLVE (classic fantasy MMORPG-style depth fade)
    const camToFrag = sub(worldPos, uCameraPos);
    const camDistSq = dot(camToFrag, camToFrag);
    const camDist = sqrt(camDistSq);
    const nearCameraFade = sub(
      float(1.0),
      smoothstep(nearCameraFadeEnd, nearCameraFadeStart, camDist),
    );

    // 6. Combine all fade factors
    const combinedFade = max(max(distanceFade, occlusionFade), nearCameraFade);

    // 7. SCREEN-SPACE 4x4 BAYER DITHERING (modern fantasy MMORPG style)
    const ix = mod(floor(viewportCoordinate.x), float(4.0));
    const iy = mod(floor(viewportCoordinate.y), float(4.0));

    const bit0_x = mod(ix, float(2.0));
    const bit1_x = floor(mul(ix, float(0.5)));
    const bit0_y = mod(iy, float(2.0));
    const bit1_y = floor(mul(iy, float(0.5)));
    const xor0 = abs(sub(bit0_x, bit0_y));
    const xor1 = abs(sub(bit1_x, bit1_y));

    const bayerInt = add(
      add(
        add(mul(xor0, float(8.0)), mul(bit0_y, float(4.0))),
        mul(xor1, float(2.0)),
      ),
      bit1_y,
    );
    const ditherValue = mul(bayerInt, float(0.0625));

    // 8. modern MMORPG-style threshold: discard when fade >= dither
    const hasAnyFade = step(float(0.001), combinedFade);
    const ditherThreshold = mul(
      mul(step(ditherValue, combinedFade), hasAnyFade),
      float(2.0),
    );
    const threshold = max(ditherThreshold, mul(belowWater, float(2.0)));

    return threshold;
  })();

  // ========== SKY-COLOR FOG ==========
  const fogTexNode = texture(fogRenderTarget.texture, screenUV);

  const toCam = sub(cameraPosition, positionWorld);
  const fogDistSq = dot(toCam, toCam);
  const fogFactor = smoothstep(
    float(FOG_NEAR_SQ),
    float(FOG_FAR_SQ),
    fogDistSq,
  );

  material.colorNode = options.vertexColors
    ? Fn(() => vertexColor().rgb)()
    : undefined;
  material.vertexColors = false;
  if (options.color) {
    material.color = options.color;
  }
  material.fog = false;

  material.outputNode = Fn(() => {
    const litColor = output;
    return vec4(mix(litColor.rgb, fogTexNode.rgb, fogFactor), litColor.a);
  })();

  material.transparent = false;
  material.opacity = 1.0;
  material.alphaTest = 0.5;
  material.side = THREE.DoubleSide;
  material.depthWrite = true;

  material.roughness = 0.95;
  material.metalness = 0.0;

  const gpuMaterial = material as unknown as GPUVegetationMaterial;
  gpuMaterial.gpuUniforms = {
    playerPos: uPlayerPos,
    cameraPos: uCameraPos,
    fadeStart: uFadeStart,
    fadeEnd: uFadeEnd,
  };

  return gpuMaterial;
}

// ============================================================================
// GENERIC DISSOLVE MATERIAL (FOR MOBS, RESOURCES, ETC.)
// ============================================================================

/**
 * Creates a dissolve material from an existing MeshStandardMaterial.
 * Clones the visual properties and adds the dithered dissolve effect.
 *
 * This uses the SAME shader logic as vegetation for consistent visuals.
 * Supports near-camera, far-camera, and camera-to-player occlusion dissolve.
 *
 * @param source - Source material to clone properties from
 * @param options - Dissolve configuration options
 * @returns Material with dissolve shader attached
 */
export function createDissolveMaterial(
  source: THREE.MeshStandardMaterial | THREE.Material,
  options: DissolveMaterialOptions = {},
): DissolveMaterial {
  return configureDissolveMaterial(
    source,
    options,
    new MeshStandardNodeMaterial(),
  );
}

function configureDissolveMaterial(
  source: THREE.MeshStandardMaterial | THREE.Material,
  options: DissolveMaterialOptions,
  material: THREE.MeshStandardNodeMaterial,
): DissolveMaterial {
  // Copy properties from source material.
  // ModelCache converts all materials to MeshStandardNodeMaterial, which may
  // not pass `instanceof MeshStandardMaterial` in the WebGPU build where
  // they are separate classes. Duck-type check for PBR properties instead.
  const src = source as THREE.MeshStandardMaterial & {
    map?: THREE.Texture | null;
    normalMap?: THREE.Texture | null;
    emissiveMap?: THREE.Texture | null;
    roughnessMap?: THREE.Texture | null;
    metalnessMap?: THREE.Texture | null;
    aoMap?: THREE.Texture | null;
  };
  if (src.color && src.roughness !== undefined) {
    material.color.copy(src.color);
    material.roughness = src.roughness;
    material.metalness = src.metalness;
    material.emissive.copy(src.emissive);
    material.emissiveIntensity = src.emissiveIntensity;
    material.vertexColors = src.vertexColors;
    material.side = src.side;
    material.transparent = false;
    material.depthWrite = true;
    material.opacity = 1.0;

    if (src.map) material.map = src.map;
    if (src.normalMap) material.normalMap = src.normalMap;
    if (src.emissiveMap) material.emissiveMap = src.emissiveMap;
    if (src.roughnessMap) material.roughnessMap = src.roughnessMap;
    if (src.metalnessMap) material.metalnessMap = src.metalnessMap;
    if (src.aoMap) material.aoMap = src.aoMap;
  } else {
    material.color.set(0x888888);
    material.roughness = 0.8;
    material.metalness = 0.0;
  }

  // ========== UNIFORMS ==========
  const uPlayerPos = uniform(new THREE.Vector3(0, 0, 0));
  const uCameraPos = uniform(new THREE.Vector3(0, 0, 0));
  const uFadeStart = uniform(options.fadeStart ?? GPU_VEG_CONFIG.FADE_START);
  const uFadeEnd = uniform(options.fadeEnd ?? GPU_VEG_CONFIG.FADE_END);
  const uNearFadeStart = uniform(
    options.nearFadeStart ?? GPU_VEG_CONFIG.NEAR_FADE_START,
  );
  const uNearFadeEnd = uniform(
    options.nearFadeEnd ?? GPU_VEG_CONFIG.NEAR_FADE_END,
  );

  // ========== CONSTANTS ==========
  const fadeStartSq = mul(uFadeStart, uFadeStart);
  const fadeEndSq = mul(uFadeEnd, uFadeEnd);
  const nearFadeStartSq = mul(uNearFadeStart, uNearFadeStart);
  const nearFadeEndSq = mul(uNearFadeEnd, uNearFadeEnd);
  const enableNearFade = options.enableNearFade ?? true;
  const enableWaterCulling = options.enableWaterCulling ?? false;
  const enableOcclusion = options.enableOcclusionDissolve !== false;
  const waterCutoff = float(
    GPU_VEG_CONFIG.WATER_LEVEL + GPU_VEG_CONFIG.WATER_BUFFER,
  );

  // Occlusion dissolve constants (classic fantasy MMORPG-style cone)
  const occlusionCameraRadius = float(GPU_VEG_CONFIG.OCCLUSION_CAMERA_RADIUS);
  const occlusionPlayerRadius = float(GPU_VEG_CONFIG.OCCLUSION_PLAYER_RADIUS);
  const occlusionDistanceScale = float(GPU_VEG_CONFIG.OCCLUSION_DISTANCE_SCALE);
  const occlusionNearMargin = float(GPU_VEG_CONFIG.OCCLUSION_NEAR_MARGIN);
  const occlusionFarMargin = float(GPU_VEG_CONFIG.OCCLUSION_FAR_MARGIN);
  const occlusionEdgeSharpness = float(GPU_VEG_CONFIG.OCCLUSION_EDGE_SHARPNESS);
  const occlusionStrength = float(GPU_VEG_CONFIG.OCCLUSION_STRENGTH);

  // Near-camera dissolve constants (classic fantasy MMORPG-style depth fade)
  const nearCameraFadeStart = float(GPU_VEG_CONFIG.NEAR_CAMERA_FADE_START);
  const nearCameraFadeEnd = float(GPU_VEG_CONFIG.NEAR_CAMERA_FADE_END);

  // ========== ALPHA TEST (DITHERED DISSOLVE + OCCLUSION + NEAR-CAMERA FADE) ==========
  material.alphaTestNode = Fn(() => {
    const worldPos = positionWorld;

    const toPlayer = sub(worldPos, uPlayerPos);
    const distSq = add(
      mul(toPlayer.x, toPlayer.x),
      mul(toPlayer.z, toPlayer.z),
    );

    // FAR fade
    const farFade = smoothstep(fadeStartSq, fadeEndSq, distSq);

    // NEAR fade
    const nearFade = enableNearFade
      ? sub(float(1.0), smoothstep(nearFadeStartSq, nearFadeEndSq, distSq))
      : float(0.0);

    const distanceFadeBase = max(farFade, nearFade);

    // NEAR-CAMERA DISSOLVE
    const camToFrag = sub(worldPos, uCameraPos);
    const camDistSq = dot(camToFrag, camToFrag);
    const camDist = sqrt(camDistSq);
    const nearCameraFade = sub(
      float(1.0),
      smoothstep(nearCameraFadeEnd, nearCameraFadeStart, camDist),
    );

    // CAMERA-TO-PLAYER OCCLUSION DISSOLVE (classic fantasy MMORPG-style)
    const occlusionFade = enableOcclusion
      ? (() => {
          const camToPlayer = vec3(
            sub(uPlayerPos.x, uCameraPos.x),
            sub(uPlayerPos.y, uCameraPos.y),
            sub(uPlayerPos.z, uCameraPos.z),
          );

          const camToFrag = vec3(
            sub(worldPos.x, uCameraPos.x),
            sub(worldPos.y, uCameraPos.y),
            sub(worldPos.z, uCameraPos.z),
          );

          const ctLengthSq = add(
            add(
              mul(camToPlayer.x, camToPlayer.x),
              mul(camToPlayer.y, camToPlayer.y),
            ),
            mul(camToPlayer.z, camToPlayer.z),
          );
          const ctLength = sqrt(ctLengthSq);

          const ctDirX = div(camToPlayer.x, ctLength);
          const ctDirY = div(camToPlayer.y, ctLength);
          const ctDirZ = div(camToPlayer.z, ctLength);

          const projDist = add(
            add(mul(camToFrag.x, ctDirX), mul(camToFrag.y, ctDirY)),
            mul(camToFrag.z, ctDirZ),
          );

          const inRangeNear = step(occlusionNearMargin, projDist);
          const inRangeFar = step(projDist, sub(ctLength, occlusionFarMargin));
          const inRange = mul(inRangeNear, inRangeFar);

          const projX = add(uCameraPos.x, mul(projDist, ctDirX));
          const projY = add(uCameraPos.y, mul(projDist, ctDirY));
          const projZ = add(uCameraPos.z, mul(projDist, ctDirZ));

          const perpX = sub(worldPos.x, projX);
          const perpY = sub(worldPos.y, projY);
          const perpZ = sub(worldPos.z, projZ);
          const perpDistSq = add(
            add(mul(perpX, perpX), mul(perpY, perpY)),
            mul(perpZ, perpZ),
          );
          const perpDist = sqrt(perpDistSq);

          const t = clamp(div(projDist, ctLength), float(0.0), float(1.0));
          const coneRadius = add(
            add(
              occlusionCameraRadius,
              mul(t, sub(occlusionPlayerRadius, occlusionCameraRadius)),
            ),
            mul(ctLength, occlusionDistanceScale),
          );

          const edgeStart = mul(
            coneRadius,
            sub(float(1.0), occlusionEdgeSharpness),
          );
          const rawOcclusionFade = sub(
            float(1.0),
            smoothstep(edgeStart, coneRadius, perpDist),
          );

          return mul(mul(rawOcclusionFade, occlusionStrength), inRange);
        })()
      : float(0.0);

    const distanceFade = max(
      max(distanceFadeBase, occlusionFade),
      nearCameraFade,
    );

    // SCREEN-SPACE 4x4 BAYER DITHERING (modern fantasy MMORPG style)
    const ix = mod(floor(viewportCoordinate.x), float(4.0));
    const iy = mod(floor(viewportCoordinate.y), float(4.0));

    const bit0_x = mod(ix, float(2.0));
    const bit1_x = floor(mul(ix, float(0.5)));
    const bit0_y = mod(iy, float(2.0));
    const bit1_y = floor(mul(iy, float(0.5)));
    const xor0 = abs(sub(bit0_x, bit0_y));
    const xor1 = abs(sub(bit1_x, bit1_y));

    const bayerInt = add(
      add(
        add(mul(xor0, float(8.0)), mul(bit0_y, float(4.0))),
        mul(xor1, float(2.0)),
      ),
      bit1_y,
    );
    const ditherValue = mul(bayerInt, float(0.0625));

    const hasAnyFade = step(float(0.001), distanceFade);
    const ditherThreshold = mul(
      mul(step(ditherValue, distanceFade), hasAnyFade),
      float(2.0),
    );

    const waterCullValue = enableWaterCulling
      ? mul(step(worldPos.y, waterCutoff), float(2.0))
      : float(0.0);
    let threshold = max(ditherThreshold, waterCullValue);

    // Depletion dissolve: screen-door dithering for depleted trees.
    // Reuses the same Bayer dither value computed above for distance fade.
    if (options.enableDepletionDissolve) {
      const dissolveVal = options.batched
        ? clamp(
            sub(float(1.0), varyingProperty("vec3", "vBatchColor").z),
            float(0.0),
            float(1.0),
          )
        : attribute<"float">("instanceDissolve", "float");
      const dissolveAmount = mul(
        dissolveVal,
        float(GPU_VEG_CONFIG.DISSOLVE_ALPHA_SCALE),
      );
      const hasDissolve = step(float(0.001), dissolveAmount);
      const dissolveDiscard = mul(
        mul(step(ditherValue, dissolveAmount), hasDissolve),
        float(2.0),
      );
      threshold = max(threshold, dissolveDiscard);
    }

    return threshold;
  })();

  material.alphaTest = 0.5;
  material.forceSinglePass = true;

  const dissolveMat = material as DissolveMaterial;
  dissolveMat.dissolveUniforms = {
    playerPos: uPlayerPos,
    cameraPos: uCameraPos,
    fadeStart: uFadeStart,
    fadeEnd: uFadeEnd,
    nearFadeStart: uNearFadeStart,
    nearFadeEnd: uNearFadeEnd,
  };

  // Per-instance glow highlight (driven by instanceHighlight attribute)
  if (options.enableRimHighlight) {
    const uHighlightColor = uniform(new THREE.Color(0x00ffff));
    dissolveMat.highlightColor = uHighlightColor;

    const BRIGHTEN = 0.08;
    const RIM_POWER = 2.5;
    const RIM_STRENGTH = 0.4;

    material.outputNode = Fn(() => {
      const litColor = output;
      const hlIntensity = attribute<"float">("instanceHighlight", "float");

      const N = normalize(normalView);
      const V = normalize(sub(vec3(0, 0, 0), positionView.xyz));
      const NdotV = clamp(dot(N, V), float(0.0), float(1.0));

      // Fresnel rim — glow at silhouette edges only
      const rim = mul(
        pow(sub(float(1.0), NdotV), float(RIM_POWER)),
        float(RIM_STRENGTH),
      );

      // Gentle brighten + rim-only highlight color
      const brightened = add(litColor.rgb, float(BRIGHTEN));
      const rimGlow = mul(uHighlightColor.rgb, rim);
      const highlighted = add(brightened, rimGlow);

      const finalRgb = mix(litColor.rgb, highlighted, hlIntensity);
      return vec4(finalRgb, litColor.a);
    })();
  }

  material.needsUpdate = true;
  return dissolveMat;
}

/**
 * Check if a material has dissolve uniforms attached.
 */
export function isDissolveMaterial(
  material: THREE.Material | null | undefined,
): material is DissolveMaterial {
  return material != null && "dissolveUniforms" in material;
}

// ============================================================================
// IMPOSTER BILLBOARD MATERIAL
// ============================================================================

/**
 * Options for creating imposter billboard materials.
 */
export type ImposterMaterialOptions = {
  /** The pre-rendered imposter texture */
  texture: THREE.Texture;
  /** Distance where far fade begins */
  fadeStart?: number;
  /** Distance where fully invisible (far) */
  fadeEnd?: number;
  /** Alpha test threshold for texture cutout (default 0.5) */
  alphaTest?: number;
};

/**
 * Material with imposter-specific uniforms.
 */
export type ImposterMaterial = THREE.MeshStandardNodeMaterial & {
  imposterUniforms: {
    playerPos: { value: THREE.Vector3 };
    fadeStart: { value: number };
    fadeEnd: { value: number };
  };
};

/**
 * Creates an imposter billboard material with dithered dissolve.
 *
 * This material:
 * - Uses the pre-rendered imposter texture
 * - Respects texture alpha (for tree silhouette cutout)
 * - Adds distance-based dithered dissolve (matches 3D vegetation)
 * - Uses same lighting properties as 3D vegetation (roughness, metalness)
 *
 * @param options - Imposter material configuration
 * @returns Material with dissolve shader and uniforms
 */
export function createImposterMaterial(
  options: ImposterMaterialOptions,
): ImposterMaterial {
  const material = new MeshStandardNodeMaterial();

  material.map = options.texture;

  // ========== UNIFORMS ==========
  const uPlayerPos = uniform(new THREE.Vector3(0, 0, 0));
  const fadeStartVal = options.fadeStart ?? 300;
  const fadeEndVal = options.fadeEnd ?? 350;
  const uFadeStart = uniform(fadeStartVal);
  const uFadeEnd = uniform(fadeEndVal);

  // ========== CONSTANTS (PRE-COMPUTED ON CPU) ==========
  const fadeStartSq = float(fadeStartVal * fadeStartVal);
  const fadeEndSq = float(fadeEndVal * fadeEndVal);
  const baseAlphaThreshold = float(options.alphaTest ?? 0.5);

  // ========== ALPHA TEST (TEXTURE CUTOUT + DITHERED DISSOLVE) ==========
  material.alphaTestNode = Fn(() => {
    const worldPos = positionWorld;

    const toPlayer = sub(worldPos, uPlayerPos);
    const distSq = add(
      mul(toPlayer.x, toPlayer.x),
      mul(toPlayer.z, toPlayer.z),
    );

    const farFade = smoothstep(fadeStartSq, fadeEndSq, distSq);

    // SCREEN-SPACE 4x4 BAYER DITHERING (modern fantasy MMORPG style)
    const ix = mod(floor(viewportCoordinate.x), float(4.0));
    const iy = mod(floor(viewportCoordinate.y), float(4.0));

    const bit0_x = mod(ix, float(2.0));
    const bit1_x = floor(mul(ix, float(0.5)));
    const bit0_y = mod(iy, float(2.0));
    const bit1_y = floor(mul(iy, float(0.5)));
    const xor0 = abs(sub(bit0_x, bit0_y));
    const xor1 = abs(sub(bit1_x, bit1_y));

    const bayerInt = add(
      add(
        add(mul(xor0, float(8.0)), mul(bit0_y, float(4.0))),
        mul(xor1, float(2.0)),
      ),
      bit1_y,
    );
    const ditherValue = mul(bayerInt, float(0.0625));

    const hasAnyFade = step(float(0.001), farFade);
    const ditherDiscard = mul(
      mul(step(ditherValue, farFade), hasAnyFade),
      float(2.0),
    );
    const threshold = max(baseAlphaThreshold, ditherDiscard);

    return threshold;
  })();

  // ========== MATERIAL SETTINGS ==========
  material.roughness = 0.95;
  material.metalness = 0.0;
  material.side = THREE.DoubleSide;

  material.transparent = false;
  material.opacity = 1.0;
  material.alphaTest = options.alphaTest ?? 0.5;
  material.depthWrite = true;

  // ========== ATTACH UNIFORMS ==========
  const imposterMat = material as ImposterMaterial;
  imposterMat.imposterUniforms = {
    playerPos: uPlayerPos,
    fadeStart: uFadeStart,
    fadeEnd: uFadeEnd,
  };

  material.needsUpdate = true;
  return imposterMat;
}

/**
 * Check if a material is an imposter material.
 */
export function isImposterMaterial(
  material: THREE.Material | null | undefined,
): material is ImposterMaterial {
  return material != null && "imposterUniforms" in material;
}

// ============================================================================
// UNIFORM-BASED RIM HIGHLIGHT (FOR NON-INSTANCED ENTITIES)
// ============================================================================

/**
 * Apply a Fresnel rim highlight to an individual (non-instanced) node material.
 * Uses a uniform toggle instead of an instanced attribute.
 *
 * Call this once per material; returns the uniform whose `.value` you set to
 * `1.0` (highlighted) or `0.0` (normal) at runtime.
 *
 * @param material - A MeshStandardNodeMaterial (duck-typed via `outputNode` check)
 * @param color - Highlight rim color (default: cyan 0x00ffff)
 * @returns The highlight uniform, or null if the material is incompatible
 */
export function applyRimHighlight(
  material: THREE.Material,
  color: THREE.Color = new THREE.Color(0x00ffff),
): { value: number } | null {
  const mat = material as THREE.MeshStandardNodeMaterial;
  if (!mat || !("outputNode" in mat)) return null;

  const uHighlight = uniform(0.0);
  const uHighlightColor = uniform(color);

  const BRIGHTEN = 0.08;
  const RIM_POWER = 2.5;
  const RIM_STRENGTH = 0.4;

  const prevOutput = mat.outputNode as Node<"vec4"> | null;

  mat.outputNode = Fn(() => {
    const litColor = prevOutput ? prevOutput : output;
    const hlIntensity = uHighlight;

    const N = normalize(normalView);
    const V = normalize(sub(vec3(0, 0, 0), positionView.xyz));
    const NdotV = clamp(dot(N, V), float(0.0), float(1.0));

    const rim = mul(
      pow(sub(float(1.0), NdotV), float(RIM_POWER)),
      float(RIM_STRENGTH),
    );

    const brightened = add(litColor.rgb, float(BRIGHTEN));
    const rimGlow = mul(uHighlightColor.rgb, rim);
    const highlighted = add(brightened, rimGlow);

    const finalRgb = mix(litColor.rgb, highlighted, hlIntensity);
    return vec4(finalRgb, litColor.a);
  })();

  mat.needsUpdate = true;
  return uHighlight as unknown as { value: number };
}

// ============================================================================
// TREE DISSOLVE MATERIAL (TOON FOLIAGE SHADING)
// ============================================================================

/**
 * Options for creating tree dissolve materials.
 */
export type TreeMaterialOptions = DissolveMaterialOptions & {
  /** Per-world art direction; never inferred from shared material/cache state. */
  treePalette?: {
    terrainProfile: WorldTerrainProfile;
    species: string;
  };
};

// The current source leaf maps have uniform visible RGB. Work in linear RGB so
// map detail/alpha remain intact; these muted hues preserve species recognition.
const COMPACT_TREE_LEAF_PALETTE = {
  maple: { source: 0xb75757, target: 0x96534c },
  magic: { source: 0x1a7c8d, target: 0x4f7e77 },
} as const;

/**
 * Tree COLOR_0 and batch colors carry AO/wind/gameplay masks, not RGB tint.
 * r186's native diffuse setup multiplies both into the albedo. Preserve that
 * setup's opacity, alpha test/hash and discard work, then replace RGB only,
 * before standard material variants and lighting consume diffuseColor.
 */
class CompactTreePBRMaterial extends MeshStandardNodeMaterial {
  declare colorNode: Node<"vec3"> | null;

  override setupDiffuseColor(builder: NodeBuilder): void {
    if (this.colorNode === null) {
      throw new Error("Compact tree PBR requires its authored albedo node");
    }
    super.setupDiffuseColor(builder);
    diffuseColor.rgb.assign(this.colorNode.convert("vec3"));
  }
}

/**
 * Tree-specific dissolve material with toon shading.
 * Extends DissolveMaterial with:
 * - Quantized 3-band toon lighting (hard-edged shadow / mid / bright)
 * - Hard-edged Fresnel rim on leaves
 * - Optional leaf SSS (disabled via ENABLE_TREE_SSS in createTreeDissolveMaterial)
 * - Wind vertex animation for leaves
 * - Vertex-color AO (G channel darkens crevices)
 * - Per-instance rim highlight
 */
export type TreeDissolveMaterial = DissolveMaterial & {
  readonly treeLighting: Readonly<{
    mode: "scene-pbr-mask-safe-v1" | "legacy-custom-rgb";
    sourceMaterialName: string;
    species: string | null;
    compactPaletteApplied: boolean;
    /** Original mapped alpha flags, recorded before dissolve conversion. */
    sourceAlphaBearing: boolean;
    /** Selected coverage graph; actual multisampling still requires the renderer. */
    compactLeafCoverage: boolean;
  }>;
  treeUniforms: {
    illumination: WorldIlluminationUniforms;
    sunDirection: { value: THREE.Vector3 };
    sunIntensity: { value: number };
    dayIntensity: { value: number };
    shadeColor: { value: THREE.Color };
    windTime: { value: number };
    windStrength: { value: number };
    windDirection: { value: THREE.Vector2 };
  };
};

/**
 * Creates a tree dissolve material with toon lighting, wind, and optional SSS.
 *
 * Vertex color channel convention (all trees):
 *   R = leafMask (0 = bark, 1 = leaf) — wind; SSS when ENABLE_TREE_SSS
 *   G = AO (ambient occlusion) — darkening + snow weight modulation
 *   B = unused
 *
 * Snow is always compiled in; per-instance biome snow weight (batch color G)
 * is the sole on/off control. Trees outside snow biomes get weight 0.
 *
 * @param source - Source material to clone PBR properties from
 * @param options - Dissolve configuration (fade distances, batched, etc.)
 */
export function createTreeDissolveMaterial(
  source: THREE.MeshStandardMaterial | THREE.Material,
  options: TreeMaterialOptions = {},
): TreeDissolveMaterial {
  const palette = options.treePalette;
  const compact =
    palette?.terrainProfile.kind === "compact-candidate" &&
    isCompactSculptProfile(palette.terrainProfile);
  // Inspect the original source before configureDissolveMaterial replaces its
  // transparency. Names alone miss General "Leaves" and unnamed Oak leaves.
  const sourceMap = (source as THREE.Material & { map?: THREE.Texture | null })
    .map;
  const sourceAlphaBearing =
    sourceMap?.isTexture === true &&
    (source.alphaTest > 0 || source.transparent === true);
  const compactLeafCoverage = compact && sourceAlphaBearing;
  const compactMaterial = compact ? new CompactTreePBRMaterial() : null;
  const baseDm = configureDissolveMaterial(
    source,
    {
      ...options,
      enableRimHighlight: false,
      enableDepletionDissolve: true,
    },
    compactMaterial ?? new MeshStandardNodeMaterial(),
  );

  const material = baseDm as unknown as THREE.MeshStandardNodeMaterial;

  const compactPaletteApplied =
    source.name === "leaf" &&
    compact &&
    (palette.species === "maple" || palette.species === "magic");
  if (
    compactPaletteApplied &&
    (palette.species === "maple" || palette.species === "magic")
  ) {
    const colors = COMPACT_TREE_LEAF_PALETTE[palette.species];
    const original = new THREE.Color(colors.source);
    const target = new THREE.Color(colors.target);
    material.color.multiply(
      new THREE.Color(
        target.r / original.r,
        target.g / original.g,
        target.b / original.b,
      ),
    );
  }

  const srcMat = source as any;
  const hasVertexColors =
    !!srcMat.vertexColors ||
    !!(srcMat._geometry ?? srcMat.geometry)?.attributes?.color;
  material.vertexColors = hasVertexColors;

  // --- Uniforms ---
  const uSunDir = uniform(new THREE.Vector3(...SUN_LIGHT.DEFAULT_DIRECTION));
  const uSunIntensity = uniform(1.0);
  const uDayIntensity = uniform(1.0);
  const uShadeColor = uniform(new THREE.Color(...SUN_SHADE.TINT_COLOR));
  const uHighlightColor = uniform(new THREE.Color(0x00ffff));
  const illumination = new WorldIlluminationUniforms();
  const uWindTime = uniform(0.0);
  const uWindStrength = uniform(0.3);
  const uWindDir = uniform(new THREE.Vector2(1, 0));

  // --- Tuning ---
  const AO_POWER = 1.8;
  const AO_DARK = 0.4;
  const SNOW_COLOR: [number, number, number] = [0.92, 0.95, 0.98];
  const SNOW_AO_TINT: [number, number, number] = [0.55, 0.6, 0.72];
  const SNOW_THRESHOLD = 0.15;
  const SNOW_RANGE = 0.08;
  const SNOW_STRENGTH = 4.0;
  const SAT_BOOST = 1.15;
  const HL_BRIGHTEN = 0.08;
  const HL_RIM_POWER = 2.5;
  const HL_RIM_STRENGTH = 0.4;
  const DIFFUSE_RAMP_MIN = -0.15;
  const DIFFUSE_RAMP_MAX = 0.6;
  const TERMINATOR_BAND_STRENGTH = 0.3;
  const RIM_EDGE_INNER = 0.15;
  const RIM_EDGE_OUTER = 0.4;
  const RIM_BRIGHT = 1.3;
  const NIGHT_MIN_BRIGHTNESS = NIGHT.BRIGHTNESS;
  /** Leaf back-scatter translucency (disabled = no extra warm glow when backlit). */
  const ENABLE_TREE_SSS = true;

  // --- Wind vertex displacement ---
  // Modulated by leafMask from vertex color R so bark stays still.
  // Displacement proportional to local Y auto-scales to any model coord system.
  material.positionNode = Fn(() => {
    const pos = positionLocal;
    const vc = hasVertexColors
      ? attribute<"vec3">("color", "vec3")
      : vec3(0, 1, 0);
    const leafMask = vc.x;

    const phase = add(mul(pos.x, float(0.013)), mul(pos.z, float(0.017)));
    const wave1 = sin(add(mul(uWindTime, float(1.8)), phase));
    const wave2 = sin(add(mul(uWindTime, float(3.2)), mul(phase, float(0.6))));
    const combined = add(mul(wave1, float(0.65)), mul(wave2, float(0.35)));
    const amplitude = mul(abs(pos.y), float(0.006));
    const disp = mul(combined, mul(uWindStrength, mul(amplitude, leafMask)));
    return vec3(
      add(pos.x, mul(disp, uWindDir.x)),
      pos.y,
      add(pos.z, mul(disp, uWindDir.y)),
    );
  })();

  // --- Alpha cutout sharpening ---
  // Applied to any material with a texture map (leaf textures have alpha).
  if (material.map) {
    material.alphaTest = 0.5;
    const leafCutoutMap = material.map;
    material.opacityNode = Fn(() => {
      const uv = attribute<"vec2">("uv", "vec2");
      const alpha = texture(leafCutoutMap, uv).a;
      return compactLeafCoverage ? alpha : step(float(0.5), alpha);
    })();
    if (compactLeafCoverage) {
      // configureDissolveMaterial constructs a scalar 0-or-2 threshold. Three's
      // public material slot erases that known node type.
      const dissolveThreshold = material.alphaTestNode as Node<"float"> | null;
      if (dissolveThreshold === null) {
        throw new Error(
          "Compact leaf coverage requires its dissolve threshold",
        );
      }
      // Native r186 smooths from T to T+fwidth(alpha). Center that interval on
      // the authored .5 cutoff: an unshifted T=.5 erodes minified crowns. D is
      // the unchanged 0-or-2 Bayer threshold; max with D also prevents a
      // negative cutoff and transparent-texel leakage at very wide gradients.
      // Widths above one still need separate mip/coverage qualification.
      const alpha = material.opacityNode as Node<"float">;
      const centeredCutoff = float(0.5).sub(alpha.fwidth().mul(0.5));
      material.alphaTestNode = max(centeredCutoff, dissolveThreshold);
      material.alphaToCoverage = true;
      // Numeric alphaTest stays .5 for the existing single-sample shadow pass.
      // Its pre-existing omission of custom dissolve nodes is not changed here.
    }
  }

  // --- Sky-color fog (same as terrain/vegetation) ---
  const treeFogTex = texture(fogRenderTarget.texture, screenUV);
  const treeToCam = sub(cameraPosition, positionWorld);
  const treeFogDistSq = dot(treeToCam, treeToCam);
  const treeFogFactor = smoothstep(
    float(FOG_NEAR_SQ),
    float(FOG_FAR_SQ),
    treeFogDistSq,
  );
  material.fog = false;

  // --- Output: custom lighting (bypass PBR, compute diffuse ramp from scratch) ---
  const albedoMap = material.map;
  const matColor = vec3(material.color.r, material.color.g, material.color.b);

  if (compactMaterial) {
    // Keep mask attributes available to wind, snow and dissolve, but never use
    // the leaf/AO channels as vertex RGB. Batch mask multiplication is removed
    // by CompactTreePBRMaterial after native alpha/discard setup.
    material.vertexColors = false;
    compactMaterial.colorNode = Fn(() => {
      const texCoord = attribute<"vec2">("uv", "vec2");
      const sampled = albedoMap ? texture(albedoMap, texCoord).rgb : vec3(1);
      const albedo = mul(sampled, matColor);
      const aoRaw = hasVertexColors
        ? attribute<"vec3">("color", "vec3").y
        : float(1);
      const aoFactor = pow(aoRaw, float(AO_POWER));
      const upFacing = smoothstep(
        float(SNOW_THRESHOLD),
        float(SNOW_THRESHOLD + SNOW_RANGE),
        normalize(normalWorld).y,
      );
      const snowMask = clamp(
        mul(mul(upFacing, aoRaw), float(SNOW_STRENGTH)),
        float(0),
        float(1),
      );
      const snowCol = mix(vec3(...SNOW_AO_TINT), vec3(...SNOW_COLOR), aoFactor);
      const snowStrength = options.batched
        ? pow(
            clamp(varyingProperty("vec3", "vBatchColor").y, float(0), float(1)),
            float(3),
          )
        : float(0);
      return mix(albedo, snowCol, mul(snowMask, snowStrength));
    })();
    // AO attenuates indirect light through the native PBR AO stage; it is not
    // an albedo hue multiplier or an added unshadowed lighting term.
    const aoRaw = hasVertexColors
      ? attribute<"vec3">("color", "vec3").y
      : float(1);
    material.aoNode = mul(
      materialAO,
      mix(float(AO_DARK), float(1), pow(aoRaw, float(AO_POWER))),
    );
  }

  const finishTreeOutput = (litRgb: Node<"vec3">, alpha: Node<"float">) => {
    const batchColor = varyingProperty("vec3", "vBatchColor");
    const hlIntensity = options.batched
      ? step(float(1.01), batchColor.x)
      : attribute<"float">("instanceHighlight", "float");
    const NV = normalize(normalView);
    const Vv = normalize(sub(vec3(0, 0, 0), positionView.xyz));
    const NdotV = clamp(dot(NV, Vv), float(0), float(1));
    const hlRim = mul(
      pow(sub(float(1), NdotV), float(HL_RIM_POWER)),
      float(HL_RIM_STRENGTH),
    );
    const highlighted = add(
      add(litRgb, float(HL_BRIGHTEN)),
      mul(uHighlightColor.rgb, hlRim),
    );
    const finalRgb = mix(litRgb, highlighted, hlIntensity);
    return vec4(mix(finalRgb, treeFogTex.rgb, treeFogFactor), alpha);
  };

  material.outputNode = Fn(() => {
    if (compactMaterial) return finishTreeOutput(output.rgb, output.a);
    const pbrOut = output;

    // ---- Albedo ----
    const texCoord = attribute<"vec2">("uv", "vec2");
    const albedoSample = albedoMap
      ? texture(albedoMap, texCoord)
      : vec4(1, 1, 1, 1);
    let baseAlbedo: Node<"vec3"> = mul(albedoSample.rgb, matColor);

    // ---- Vertex colors ----
    const vtxColor = hasVertexColors
      ? attribute<"vec3">("color", "vec3")
      : vec3(0, 1, 0);
    const aoRaw = vtxColor.y;

    // ---- AO (post-diffuse multiplier) ----
    const aoFactor = pow(aoRaw, float(AO_POWER));

    // ---- Snow ----
    const geometricN = normalize(normalWorld);
    const upFacing = smoothstep(
      float(SNOW_THRESHOLD),
      float(SNOW_THRESHOLD + SNOW_RANGE),
      geometricN.y,
    );
    const snowMask = clamp(
      mul(mul(upFacing, aoRaw), float(SNOW_STRENGTH)),
      float(0.0),
      float(1.0),
    );
    const snowCol = mix(vec3(...SNOW_AO_TINT), vec3(...SNOW_COLOR), aoFactor);
    const batchColor = varyingProperty("vec3", "vBatchColor");
    const biomeSnowRaw = clamp(batchColor.y, float(0.0), float(1.0));
    // Sharp falloff so biome boundaries show little snow — only
    // strongly-tundra areas get substantial coverage.
    const biomeSnowStrength = pow(biomeSnowRaw, float(3.0));
    const snowWeight = mul(snowMask, biomeSnowStrength);
    baseAlbedo = mix(baseAlbedo, snowCol, snowWeight);
    // Preserve literal textured/snow albedo before the legacy color treatment.
    const worldAlbedo = baseAlbedo;

    // ---- dayFactor (night fading for rim / saturation; SSS when enabled) ----
    const sunI = clamp(uSunIntensity, float(0.0), float(2.0));
    const dayFactor = div(sunI, float(2.0));

    // ---- Sun shade on albedo ----
    baseAlbedo = applySunShade(baseAlbedo, uDayIntensity, uShadeColor.rgb);

    // ---- Smooth diffuse ramp (warm highlights -> cool shadows) ----
    const leafMask = vtxColor.x;
    const L = normalize(vec3(uSunDir));
    const N = normalize(normalWorldGeometry);
    const NdotL = dot(N, L);

    // Smooth 0..1 ramp across the terminator — no hard bands
    const diffuseRamp = smoothstep(
      float(DIFFUSE_RAMP_MIN),
      float(DIFFUSE_RAMP_MAX),
      NdotL,
    );

    // Warm highlight -> cool deep shadow
    const litColor = mul(baseAlbedo, vec3(1.28, 1.06, 0.88));
    const shadowColor = mul(baseAlbedo, vec3(0.42, 0.54, 0.72));
    let rampColor: any = mix(shadowColor, litColor, diffuseRamp);

    // Narrow warm-tinted band at the shadow terminator
    const terminatorA = smoothstep(float(-0.2), float(0.25), NdotL);
    const terminatorB = smoothstep(float(0.08), float(0.45), NdotL);
    const terminatorBand = sub(terminatorA, terminatorB);
    const terminatorTint = mul(baseAlbedo, vec3(1.12, 0.72, 0.54));
    rampColor = mix(
      rampColor,
      terminatorTint,
      mul(terminatorBand, float(TERMINATOR_BAND_STRENGTH)),
    );

    const nightDim = mix(
      float(NIGHT_MIN_BRIGHTNESS),
      float(1.0),
      uDayIntensity,
    );
    const aoMul = mix(float(AO_DARK), float(1.0), aoFactor);
    let result: any = mul(mul(rampColor, nightDim), aoMul);

    // ---- View vector (rim); optional leaf SSS when ENABLE_TREE_SSS ----
    const V = normalize(sub(cameraPosition, positionWorld));

    if (ENABLE_TREE_SSS) {
      const backL = normalize(sub(vec3(0, 0, 0), L));
      const backSSS = clamp(dot(V, backL), float(0), float(1));
      const sssFactor = mul(
        mul(pow(backSSS, float(3.0)), float(0.12)),
        mul(dayFactor, leafMask),
      );
      result = add(result, mul(vec3(0.95, 1.0, 0.7), sssFactor));
    }

    const EDotN = clamp(dot(V, N), float(0.0), float(1.0));
    const rimMask = sub(
      float(1.0),
      smoothstep(float(RIM_EDGE_INNER), float(RIM_EDGE_OUTER), EDotN),
    );
    const rimBright = mix(
      float(1.0),
      float(RIM_BRIGHT),
      mul(mul(rimMask, dayFactor), leafMask),
    );
    result = mul(result, rimBright);

    // ---- Saturation boost (scales with dayFactor so night stays muted) ----
    const satScale = mix(float(1.0), float(SAT_BOOST), dayFactor);
    const luma = dot(result, vec3(0.299, 0.587, 0.114));
    const boosted = add(
      mul(sub(result, vec3(luma, luma, luma)), satScale),
      vec3(luma, luma, luma),
    );
    // Opt-in Lambert diffuse uses the geometric normal and the same vertex AO.
    // Legacy warm/cool ramp, additive SSS, rim and saturation remain at blend=0;
    // they are not treated as physically sourced illumination at blend=1.
    const litRgb = illumination.select(
      boosted,
      mul(illumination.diffuse(worldAlbedo, N), aoMul),
    );

    return finishTreeOutput(litRgb, pbrOut.a);
  })();

  material.needsUpdate = true;

  const treeMat = baseDm as TreeDissolveMaterial;
  Object.defineProperty(treeMat, "treeLighting", {
    value: Object.freeze({
      mode: compactMaterial ? "scene-pbr-mask-safe-v1" : "legacy-custom-rgb",
      sourceMaterialName: source.name,
      species: palette?.species ?? null,
      compactPaletteApplied,
      sourceAlphaBearing,
      compactLeafCoverage,
    }),
    enumerable: true,
  });
  treeMat.highlightColor = uHighlightColor;
  treeMat.treeUniforms = {
    illumination,
    sunDirection: uSunDir as unknown as { value: THREE.Vector3 },
    sunIntensity: uSunIntensity as unknown as { value: number },
    dayIntensity: uDayIntensity as unknown as { value: number },
    shadeColor: uShadeColor as unknown as { value: THREE.Color },
    windTime: uWindTime as unknown as { value: number },
    windStrength: uWindStrength as unknown as { value: number },
    windDirection: uWindDir as unknown as { value: THREE.Vector2 },
  };

  return treeMat;
}
