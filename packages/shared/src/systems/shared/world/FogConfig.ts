/**
 * FogConfig - Central fog settings for the entire app
 *
 * Single source of truth for all fog-related constants.
 * Imported by SkySystem (fog render target), TerrainShader, WaterSystem,
 * DissolveMaterial, and any other system that needs fog parameters.
 *
 * FOG TECHNIQUE:
 * The sky dome is rendered to a low-res offscreen texture each frame.
 * Object shaders sample this texture using screenUV to get the sky color
 * behind each pixel, then blend toward it using smoothstep distance fog.
 * Uses squared distances (NEAR_SQ/FAR_SQ) to avoid per-fragment sqrt.
 * This replaces flat-color fog with pixel-accurate sky-color fog.
 *
 * PBR-CORRECT FOG:
 * Fog is applied in material.outputNode AFTER PBR lighting:
 *   outputNode = mix(litColor, skyFogColor, fogFactor)
 * This ensures fog color isn't darkened by ambient occlusion or shadows.
 *
 * SHARED RENDER TARGET:
 * The fog render target is created here at module-load time so all materials
 * can reference its .texture directly — no runtime texture swaps needed.
 * SkySystem renders to this target each frame; the texture contents update in-place.
 *
 * FALLBACK:
 * Objects with standard materials (NPCs, loaded models) still use THREE.Fog
 * on the scene (set up in Environment.ts). Custom-shader objects (terrain,
 * water, vegetation) set material.fog = false and use this sky-color fog instead.
 */

import * as THREE from "../../../extras/three/three";
import {
  texture,
  screenUV,
  positionWorld,
  cameraPosition,
  float,
  vec4,
  mix,
  dot,
  sub,
  mul,
  smoothstep,
  Fn,
  output,
} from "../../../extras/three/three";

// ---------------------------------------------------------------------------
// Fog distance parameters
// smoothstep(NEAR_SQ, FAR_SQ, distSq) gives 0% fog at NEAR, 100% at FAR.
// ---------------------------------------------------------------------------
export const FOG_NEAR = 400;
export const FOG_FAR = 800;

// Pre-computed squared distances — avoids per-fragment sqrt on the GPU.
// Shaders compare dot(toCamera, toCamera) directly against these.
export const FOG_NEAR_SQ = FOG_NEAR * FOG_NEAR;
export const FOG_FAR_SQ = FOG_FAR * FOG_FAR;

// ---------------------------------------------------------------------------
// Fog render target resolution (height in pixels, width = height * aspect)
// Low res is fine since fog is a smooth gradient; keeps render cost minimal
// ---------------------------------------------------------------------------
export const FOG_RENDER_HEIGHT = 72;

// ---------------------------------------------------------------------------
// SHARED FOG RENDER TARGET
// Created at module-load time. All materials reference fogRenderTarget.texture
// directly — the same texture object, updated in-place by SkySystem each frame.
// This avoids runtime TextureNode.value swaps which may not work with WebGPU caching.
// ---------------------------------------------------------------------------
const FOG_RT_WIDTH = Math.ceil(FOG_RENDER_HEIGHT * (16 / 9));
export const fogRenderTarget = new THREE.WebGLRenderTarget(
  FOG_RT_WIDTH,
  FOG_RENDER_HEIGHT,
  {
    // Keep linear sky radiance above 1 until the main pass tone maps it.
    // RGBA8 clips bright horizons and makes distant water a different color
    // from the visible sky. RGBA16F adds 36 KiB at the 128x72 fog resolution.
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  },
);

// ---------------------------------------------------------------------------
// HELPER: Apply sky-color fog to any node material.
// Sets material.fog = false (opt out of THREE.Fog) and adds an outputNode
// that blends the PBR/basic output toward the sky fog texture at distance.
//
// Usage:
//   const material = new MeshStandardNodeMaterial();
//   // ... configure material ...
//   applySkyFog(material);
// ---------------------------------------------------------------------------
export function applySkyFog(material: {
  fog: boolean;
  outputNode: unknown;
}): void {
  const fogTex = texture(fogRenderTarget.texture, screenUV);
  const toCam = sub(cameraPosition, positionWorld);
  const fogDistSq = dot(toCam, toCam);
  const fogFactor = smoothstep(
    float(FOG_NEAR_SQ),
    float(FOG_FAR_SQ),
    fogDistSq,
  );

  material.fog = false;
  material.outputNode = Fn(() => {
    const litColor = output;
    return vec4(mix(litColor.rgb, fogTex.rgb, fogFactor), litColor.a);
  })();
}

// ---------------------------------------------------------------------------
// HELPER: Apply elevation-based fade to cloud materials.
// Reduces cloud opacity based on elevation angle so lower clouds
// gradually dissolve into the sky at the horizon.
// fadeAmount: 0 = fully visible, 1 = fully transparent
// ---------------------------------------------------------------------------
export function applyCloudFog(
  material: { fog: boolean; outputNode: unknown },
  fadeAmount: number,
): void {
  material.fog = false;
  material.outputNode = Fn(() => {
    const litColor = output;
    return vec4(litColor.rgb, mul(litColor.a, float(1.0 - fadeAmount)));
  })();
}
