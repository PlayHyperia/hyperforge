/**
 * Octahedral Impostor Material - WebGPU TSL Version
 *
 * Uses Three.js TSL (Three Shading Language) for WebGPU compatibility.
 * This replaces the GLSL ShaderMaterial for WebGPU rendering.
 *
 * AAA Features:
 * - Octahedral atlas sampling with 3-view blending
 * - Depth atlas for depth-based frame blending (reduces ghosting)
 * - Normal atlas for dynamic lighting
 * - PBR atlas (roughness, metallic, AO)
 * - Multi-light support (4 directional + 4 point lights)
 * - Specular highlights with Fresnel
 * - Distance-based dithered dissolve for LOD transitions
 */

import * as THREE_NAMESPACE from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { ImpostorMaterialConfig, DissolveConfig } from "./types";

// Maximum lights for TSL
const MAX_DIRECTIONAL_LIGHTS_TSL = 4;
const MAX_POINT_LIGHTS_TSL = 4;

// TSL functions are under the TSL namespace in three/webgpu
const {
  Fn,
  uv,
  positionWorld,
  instanceIndex,
  cameraPosition,
  uniform,
  texture,
  float,
  int,
  vec2,
  vec3,
  vec4,
  add,
  sub,
  mul,
  div,
  dot,
  floor,
  fract,
  sin,
  cos,
  pow,
  sqrt,
  max,
  clamp,
  normalize,
  cross,
  smoothstep,
  mix,
  select,
} = THREE_NAMESPACE.TSL;

// ============================================================================
// TSL IMPOSTOR MATERIAL
// ============================================================================

/**
 * Material with TSL impostor uniforms for runtime updates.
 */
export type TSLImpostorMaterial = THREE_NAMESPACE.MeshBasicNodeMaterial & {
  impostorUniforms: {
    faceIndices: { value: THREE_NAMESPACE.Vector3 };
    faceWeights: { value: THREE_NAMESPACE.Vector3 };
    playerPos?: { value: THREE_NAMESPACE.Vector3 };
    fadeStart?: { value: number };
    fadeEnd?: { value: number };
    // Color tint for dynamic coloring (e.g., grass)
    colorTint?: { value: THREE_NAMESPACE.Vector3 };
    // AAA uniforms
    ambientColor?: { value: THREE_NAMESPACE.Vector3 };
    ambientIntensity?: { value: number };
    numDirectionalLights?: { value: number };
    directionalLightDirs?: { value: THREE_NAMESPACE.Vector3[] };
    directionalLightColors?: { value: THREE_NAMESPACE.Vector3[] };
    directionalLightIntensities?: { value: number[] };
    numPointLights?: { value: number };
    pointLightPositions?: { value: THREE_NAMESPACE.Vector3[] };
    pointLightColors?: { value: THREE_NAMESPACE.Vector3[] };
    pointLightIntensities?: { value: number[] };
    pointLightDistances?: { value: number[] };
    pointLightDecays?: { value: number[] };
    specularF0?: { value: number };
    specularShininess?: { value: number };
    specularIntensity?: { value: number };
  };
  /** Update face indices and weights from view data */
  updateView: (
    faceIndices: THREE_NAMESPACE.Vector3,
    faceWeights: THREE_NAMESPACE.Vector3,
  ) => void;
  /** Update color tint for dynamic coloring */
  updateColorTint?: (color: THREE_NAMESPACE.Color) => void;
  /** Update AAA lighting (if AAA mode enabled) */
  updateLighting?: (config: {
    ambientColor?: THREE_NAMESPACE.Vector3;
    ambientIntensity?: number;
    directionalLights?: Array<{
      direction: THREE_NAMESPACE.Vector3;
      color: THREE_NAMESPACE.Vector3;
      intensity: number;
    }>;
    pointLights?: Array<{
      position: THREE_NAMESPACE.Vector3;
      color: THREE_NAMESPACE.Vector3;
      intensity: number;
      distance: number;
      decay: number;
    }>;
    specular?: {
      f0?: number;
      shininess?: number;
      intensity?: number;
    };
  }) => void;
};

/**
 * Options for creating TSL impostor material
 */
export interface TSLImpostorMaterialOptions extends ImpostorMaterialConfig {
  /** Optional dissolve configuration */
  dissolve?: DissolveConfig;
  /** Enable AAA features (depth blending, multi-light, specular) */
  enableAAA?: boolean;
  /**
   * Color tint to multiply the albedo by.
   * Useful for grayscale impostors that should be tinted (e.g., grass).
   * Defaults to white (1, 1, 1) = no tint.
   */
  colorTint?: THREE_NAMESPACE.Color;
  /**
   * Debug mode for diagnosing rendering issues:
   * - 0: Normal rendering (default)
   * - 1: Raw texture sample from center (no blending)
   * - 2: Show UV coordinates as color (red=U, green=V)
   * - 3: Show face indices as color (R=idx0, G=idx1, B=idx2)
   * - 4: Solid red (verify shader runs at all)
   * - 5: Sample texture at fixed (0.5, 0.5) coords - test texture binding
   * - 6: Sample texture with billboard UVs directly - test UV mapping
   */
  debugMode?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Create a WebGPU-compatible impostor material using TSL.
 *
 * This material samples an octahedral atlas texture and blends 3 views
 * based on face indices and barycentric weights.
 *
 * AAA mode adds:
 * - Depth-based frame blending (reduces ghosting)
 * - Multi-light support (4 directional + 4 point)
 * - Specular highlights with Fresnel
 * - PBR support (roughness, metallic, AO)
 *
 * @param options - Material configuration
 * @returns TSL-based impostor material
 */
export function createTSLImpostorMaterial(
  options: TSLImpostorMaterialOptions,
): TSLImpostorMaterial {
  const {
    atlasTexture,
    normalAtlasTexture,
    depthAtlasTexture,
    pbrAtlasTexture,
    gridSizeX,
    gridSizeY,
    dissolve,
    transparent = true,
    depthWrite = true,
    enableAAA = !!(depthAtlasTexture || normalAtlasTexture),
    enableDepthBlending = !!depthAtlasTexture,
    enableSpecular = !!normalAtlasTexture,
    colorTint,
    debugMode = 0,
  } = options;

  // Ensure render target textures work with TSL
  // CRITICAL: All atlases must be marked as LINEAR to prevent WebGPU from auto-decoding.
  // The shader handles gamma decode manually via pow(2.2) for the albedo atlas.
  // If atlas is marked sRGB, WebGPU auto-decodes + shader decodes = double gamma = wrong colors.
  const setupTexture = (tex: THREE_NAMESPACE.Texture | undefined) => {
    if (!tex) return;
    if (!tex.isRenderTargetTexture) {
      tex.needsUpdate = true;
    }
    tex.wrapS = THREE_NAMESPACE.ClampToEdgeWrapping;
    tex.wrapT = THREE_NAMESPACE.ClampToEdgeWrapping;
    // For WebGPU, ensure the texture is marked ready
    if (!tex.generateMipmaps) {
      tex.generateMipmaps = false;
    }
    // ALL textures must be linear to prevent WebGPU auto-gamma conversion.
    // The shader manually handles sRGB decode for albedo.
    tex.colorSpace = THREE_NAMESPACE.LinearSRGBColorSpace;
  };
  setupTexture(atlasTexture); // Albedo atlas - shader does sRGB decode manually
  setupTexture(normalAtlasTexture); // Normal atlas - raw data
  setupTexture(depthAtlasTexture); // Depth atlas - raw data
  setupTexture(pbrAtlasTexture); // PBR atlas - raw data

  // Create node material
  const material = new MeshBasicNodeMaterial();

  // ========== UNIFORMS ==========
  const uAtlasTexture = texture(atlasTexture);
  const uGridSize = uniform(vec2(gridSizeX, gridSizeY));

  // Compute valid initial face indices for the center of the atlas
  // For HEMI octahedrons, cell (0,0) is often empty/edge, so use center cells
  // This ensures the impostor shows content before the first update() call
  const centerCol = Math.floor(gridSizeX / 2);
  const centerRow = Math.floor(gridSizeY / 2);
  const centerIndex = centerRow * gridSizeX + centerCol;
  // Use 3 adjacent vertices that form a valid sampling region
  const indexA = centerIndex;
  const indexB = Math.min(centerIndex + 1, gridSizeX * gridSizeY - 1);
  const indexC = Math.min(centerIndex + gridSizeX, gridSizeX * gridSizeY - 1);

  const uFaceIndices = uniform(vec3(indexA, indexB, indexC));
  const uFaceWeights = uniform(vec3(0.33, 0.33, 0.34));
  const uAlphaThreshold = uniform(float(0.5));

  // AAA uniforms
  const placeholderTex = atlasTexture; // Use albedo as placeholder
  const uNormalAtlasTexture = texture(normalAtlasTexture ?? placeholderTex);
  const uDepthAtlasTexture = texture(depthAtlasTexture ?? placeholderTex);
  const uPBRAtlasTexture = texture(pbrAtlasTexture ?? placeholderTex);

  const uUseDepthBlending = uniform(int(enableDepthBlending ? 1 : 0));
  const uUsePBR = uniform(int(pbrAtlasTexture ? 1 : 0));
  const uUseSpecular = uniform(int(enableSpecular ? 1 : 0));
  const uHasNormals = uniform(int(normalAtlasTexture ? 1 : 0));

  // Lighting uniforms - reduced defaults to better match original tree appearance
  const uAmbientColor = uniform(vec3(0.6, 0.65, 0.7)); // Slightly bluish ambient (sky)
  const uAmbientIntensity = uniform(float(0.3)); // Reduced from 0.4
  const uNumDirectionalLights = uniform(int(1));

  // Directional light arrays (up to 4)
  const uDirLightDirs = [
    uniform(vec3(0.5, 0.8, 0.3)),
    uniform(vec3(0, 1, 0)),
    uniform(vec3(0, 1, 0)),
    uniform(vec3(0, 1, 0)),
  ];
  const uDirLightColors = [
    uniform(vec3(1, 0.98, 0.95)), // Warm sunlight
    uniform(vec3(1, 1, 1)),
    uniform(vec3(1, 1, 1)),
    uniform(vec3(1, 1, 1)),
  ];
  const uDirLightIntensities = [
    uniform(float(0.9)), // Reduced from 1.2
    uniform(float(0)),
    uniform(float(0)),
    uniform(float(0)),
  ];

  // Point light arrays (up to 4)
  const uNumPointLights = uniform(int(0));
  const uPointLightPositions = [
    uniform(vec3(0, 0, 0)),
    uniform(vec3(0, 0, 0)),
    uniform(vec3(0, 0, 0)),
    uniform(vec3(0, 0, 0)),
  ];
  const uPointLightColors = [
    uniform(vec3(1, 1, 1)),
    uniform(vec3(1, 1, 1)),
    uniform(vec3(1, 1, 1)),
    uniform(vec3(1, 1, 1)),
  ];
  const uPointLightIntensities = [
    uniform(float(0)),
    uniform(float(0)),
    uniform(float(0)),
    uniform(float(0)),
  ];
  const uPointLightDistances = [
    uniform(float(10)),
    uniform(float(10)),
    uniform(float(10)),
    uniform(float(10)),
  ];
  const uPointLightDecays = [
    uniform(float(2)),
    uniform(float(2)),
    uniform(float(2)),
    uniform(float(2)),
  ];

  // Specular uniforms
  const uSpecularF0 = uniform(float(0.04));
  const uSpecularShininess = uniform(float(32));
  const uSpecularIntensity = uniform(float(0.5));

  // Dissolve uniforms
  const dissolveEnabled = dissolve?.enabled ?? false;
  const uPlayerPos = uniform(vec3(0, 0, 0));
  const uFadeStart = uniform(float(dissolve?.fadeStart ?? 300));
  const uFadeEnd = uniform(float(dissolve?.fadeEnd ?? 350));

  // Color tint uniform - defaults to white (no tint)
  // For grass: use green like RGB(0.26, 0.48, 0.12) from ProceduralGrass
  const defaultTint = colorTint ?? new THREE_NAMESPACE.Color(1, 1, 1);
  const uColorTint = uniform(vec3(defaultTint.r, defaultTint.g, defaultTint.b));

  // ========== HELPER: Convert flat index to grid coords ==========
  const flatToCoords = Fn(([flatIndex]: [THREE_NAMESPACE.Node<"float">]) => {
    const row = floor(div(flatIndex, uGridSize.x));
    const col = sub(flatIndex, mul(row, uGridSize.x));
    return vec2(col, row);
  });

  // ========== HELPER: Fresnel Schlick ==========
  const fresnelSchlick = Fn(
    ([cosTheta, f0]: [
      THREE_NAMESPACE.Node<"float">,
      THREE_NAMESPACE.Node<"vec3">,
    ]) => {
      return add(
        f0,
        mul(
          sub(vec3(1, 1, 1), f0),
          pow(clamp(sub(float(1), cosTheta), float(0), float(1)), float(5)),
        ),
      );
    },
  );

  // ========== COLOR NODE (with debug modes) ==========
  // debugMode:
  // 0 = Normal rendering with lighting
  // 1 = Raw texture from center cell (no blending, no lighting)
  // 2 = UV coordinates as color (red=U, green=V)
  // 3 = Face indices as colors (divided by gridSize for visibility)
  // 4 = Solid red (verify shader runs)
  // 5 = Sample texture at fixed coords (0.5,0.5) - test if texture has content
  // 6 = Sample texture at dynamic UVs without grid division - raw UV sample

  let colorNode;

  if (debugMode === 6) {
    // Mode 6: Sample texture using billboard UVs directly (no grid division)
    // This helps diagnose if the issue is UV math or texture binding
    colorNode = Fn(() => {
      const billboardUV = uv();
      // Sample directly with billboard UVs (will stretch across entire atlas)
      const color = uAtlasTexture.sample(billboardUV);
      return vec4(color.rgb, float(1)); // Force alpha to 1 to see if there's any content
    })();
  } else if (debugMode === 5) {
    // Mode 5: Sample texture at fixed center coordinate (0.5, 0.5)
    // This tests if the texture binding works at all
    colorNode = Fn(() => {
      const fixedUV = vec2(0.5, 0.5);
      const color = uAtlasTexture.sample(fixedUV);
      return vec4(color.rgb, float(1)); // Force alpha to 1
    })();
  } else if (debugMode === 4) {
    // Mode 4: Solid red - verifies shader runs at all
    // Also disable alpha test for this mode
    material.alphaTest = 0;
    colorNode = Fn(() => {
      return vec4(1, 0, 0, 1);
    })();
  } else if (debugMode === 3) {
    // Mode 3: Face indices as colors
    colorNode = Fn(() => {
      const idx0Norm = div(uFaceIndices.x, mul(uGridSize.x, uGridSize.y));
      const idx1Norm = div(uFaceIndices.y, mul(uGridSize.x, uGridSize.y));
      const idx2Norm = div(uFaceIndices.z, mul(uGridSize.x, uGridSize.y));
      return vec4(idx0Norm, idx1Norm, idx2Norm, float(1));
    })();
  } else if (debugMode === 2) {
    // Mode 2: UV coordinates as color
    colorNode = Fn(() => {
      const billboardUV = uv();
      return vec4(billboardUV.x, billboardUV.y, float(0), float(1));
    })();
  } else if (debugMode === 1) {
    // Mode 1: Raw texture from center (no blending, no lighting)
    // Sample from first cell using raw UVs
    colorNode = Fn(() => {
      const billboardUV = uv();
      // Sample from first grid cell (0,0) directly
      const cellUV = div(billboardUV, uGridSize);
      const color = uAtlasTexture.sample(cellUV);
      return vec4(color.rgb, color.a);
    })();
  } else {
    // =========================================================================
    // UNIFIED RENDERING PATH - Always uses correct gamma pipeline
    // Lighting is applied when normals are available, otherwise just gamma-correct
    // =========================================================================
    // Mode 0: Full AAA rendering with blending and lighting
    // NOTE: TSL doesn't support traditional loops, so we unroll for all 4 lights
    colorNode = Fn(() => {
      const billboardUV = uv();
      const worldPos = positionWorld;

      // Get cell indices
      const cellA = flatToCoords(uFaceIndices.x);
      const cellB = flatToCoords(uFaceIndices.y);
      const cellC = flatToCoords(uFaceIndices.z);

      // Atlas UVs
      const atlasUV_a = div(add(cellA, billboardUV), uGridSize);
      const atlasUV_b = div(add(cellB, billboardUV), uGridSize);
      const atlasUV_c = div(add(cellC, billboardUV), uGridSize);

      // Sample all atlases
      const color_a = uAtlasTexture.sample(atlasUV_a);
      const color_b = uAtlasTexture.sample(atlasUV_b);
      const color_c = uAtlasTexture.sample(atlasUV_c);

      const depth_a = uDepthAtlasTexture.sample(atlasUV_a).r;
      const depth_b = uDepthAtlasTexture.sample(atlasUV_b).r;
      const depth_c = uDepthAtlasTexture.sample(atlasUV_c).r;

      const normal_a = uNormalAtlasTexture.sample(atlasUV_a).rgb;
      const normal_b = uNormalAtlasTexture.sample(atlasUV_b).rgb;
      const normal_c = uNormalAtlasTexture.sample(atlasUV_c).rgb;

      const pbr_a = uPBRAtlasTexture.sample(atlasUV_a).rgb;
      const pbr_b = uPBRAtlasTexture.sample(atlasUV_b).rgb;
      const pbr_c = uPBRAtlasTexture.sample(atlasUV_c).rgb;

      // Compute weights - depth-based or standard
      const depthWeight_a = sub(float(1), depth_a);
      const depthWeight_b = sub(float(1), depth_b);
      const depthWeight_c = sub(float(1), depth_c);

      // Standard weights
      const wa_std = mul(uFaceWeights.x, color_a.a);
      const wb_std = mul(uFaceWeights.y, color_b.a);
      const wc_std = mul(uFaceWeights.z, color_c.a);

      // Depth-weighted
      const wa_depth = mul(mul(uFaceWeights.x, color_a.a), depthWeight_a);
      const wb_depth = mul(mul(uFaceWeights.y, color_b.a), depthWeight_b);
      const wc_depth = mul(mul(uFaceWeights.z, color_c.a), depthWeight_c);

      // Select based on depth blending flag
      const useDepthBlending = uUseDepthBlending.greaterThan(0);
      const wa_raw = select(useDepthBlending, wa_depth, wa_std);
      const wb_raw = select(useDepthBlending, wb_depth, wb_std);
      const wc_raw = select(useDepthBlending, wc_depth, wc_std);

      const totalWeightRaw = add(add(wa_raw, wb_raw), wc_raw);
      // Prevent division by zero when all sampled cells have alpha=0
      // This can happen at edge viewing angles where atlas cells are transparent
      const totalWeight = max(totalWeightRaw, float(0.0001));

      // Normalize weights
      const wa = div(wa_raw, totalWeight);
      const wb = div(wb_raw, totalWeight);
      const wc = div(wc_raw, totalWeight);

      // Blend all channels
      const albedo = add(
        add(mul(color_a, wa), mul(color_b, wb)),
        mul(color_c, wc),
      );
      // Apply gamma decode then multiply by color tint (for dynamic grass coloring etc.)
      const albedoDecoded = albedo.rgb.pow(vec3(2.2, 2.2, 2.2));
      const albedoLinear = mul(albedoDecoded, uColorTint);

      // Decode and blend normals
      const normal_dec_a = normalize(
        sub(mul(normal_a, float(2)), vec3(1, 1, 1)),
      );
      const normal_dec_b = normalize(
        sub(mul(normal_b, float(2)), vec3(1, 1, 1)),
      );
      const normal_dec_c = normalize(
        sub(mul(normal_c, float(2)), vec3(1, 1, 1)),
      );
      const viewNormal = normalize(
        add(
          add(mul(normal_dec_a, wa), mul(normal_dec_b, wb)),
          mul(normal_dec_c, wc),
        ),
      );

      // Blend PBR
      const pbrBlended = add(
        add(mul(pbr_a, wa), mul(pbr_b, wb)),
        mul(pbr_c, wc),
      );
      const usePBR = uUsePBR.greaterThan(0);
      const roughness = select(usePBR, pbrBlended.r, float(0.8));
      const metallic = select(usePBR, pbrBlended.g, float(0));
      const ao = select(usePBR, pbrBlended.b, float(1));

      // Transform normal to world space
      const N = normalize(sub(cameraPosition, worldPos));
      const worldUp = vec3(0, 1, 0);
      const T = normalize(cross(worldUp, N));
      const B = normalize(cross(N, T));
      const worldNormal = normalize(
        add(
          add(mul(T, viewNormal.x), mul(B, viewNormal.y)),
          mul(N, viewNormal.z),
        ),
      );

      // View direction
      const V = normalize(sub(cameraPosition, worldPos));

      // F0 based on metallic
      const f0Base = vec3(0.04, 0.04, 0.04);
      const F0 = mix(f0Base, albedoLinear, metallic);

      // Effective shininess (roughness-modulated)
      const effectiveShininess = mul(
        uSpecularShininess,
        sub(float(1), mul(roughness, float(0.9))),
      );

      // =========================================================================
      // DIRECTIONAL LIGHTS (all 4 - intensity=0 makes inactive lights contribute nothing)
      // JS-level for-loop generates identical unrolled TSL node graph, but source is DRY.
      // =========================================================================
      const dirDiffuses: THREE_NAMESPACE.Node<"vec3">[] = [];
      const dirSpeculars: THREE_NAMESPACE.Node<"vec3">[] = [];

      for (let i = 0; i < MAX_DIRECTIONAL_LIGHTS_TSL; i++) {
        const L = normalize(uDirLightDirs[i]);
        const H = normalize(add(V, L));
        const NdotL = max(dot(worldNormal, L), float(0));
        const NdotH = max(dot(worldNormal, H), float(0));
        const VdotH = max(dot(V, H), float(0));
        const halfLambert = add(mul(NdotL, float(0.5)), float(0.5));
        dirDiffuses.push(
          mul(mul(uDirLightColors[i], uDirLightIntensities[i]), halfLambert),
        );
        const F_spec = fresnelSchlick(VdotH, F0);
        const spec = pow(NdotH, effectiveShininess);
        dirSpeculars.push(
          mul(
            mul(mul(F_spec, spec), uDirLightColors[i]),
            uDirLightIntensities[i],
          ),
        );
      }

      const totalDirDiffuse = add(
        add(add(dirDiffuses[0], dirDiffuses[1]), dirDiffuses[2]),
        dirDiffuses[3],
      );
      const totalDirSpecular = add(
        add(add(dirSpeculars[0], dirSpeculars[1]), dirSpeculars[2]),
        dirSpeculars[3],
      );

      // =========================================================================
      // POINT LIGHTS (all 4 - intensity=0 makes inactive lights contribute nothing)
      // Uses sqrt(dot(v,v)) instead of manual pow(sum-of-squares, 0.5) - same WGSL,
      // but ~6 fewer TSL nodes per light = faster material creation + smaller graph.
      // =========================================================================
      const ptDiffuses: THREE_NAMESPACE.Node<"vec3">[] = [];
      const ptSpeculars: THREE_NAMESPACE.Node<"vec3">[] = [];

      for (let i = 0; i < MAX_POINT_LIGHTS_TSL; i++) {
        const pVec = sub(uPointLightPositions[i], worldPos);
        const pDist = max(float(0.0001), sqrt(dot(pVec, pVec)));
        const pL = div(pVec, pDist);
        const pH = normalize(add(V, pL));
        const pD = div(pDist, max(uPointLightDistances[i], float(0.0001)));
        const pSmooth = clamp(
          sub(float(1), mul(mul(mul(pD, pD), pD), pD)),
          float(0),
          float(1),
        );
        const pAtten = mul(
          mul(pSmooth, pSmooth),
          div(float(1), mul(pDist, pDist)),
        );
        const pNdotL = max(dot(worldNormal, pL), float(0));
        const pNdotH = max(dot(worldNormal, pH), float(0));
        const pVdotH = max(dot(V, pH), float(0));
        const pHalfLambert = add(mul(pNdotL, float(0.5)), float(0.5));
        ptDiffuses.push(
          mul(
            mul(mul(uPointLightColors[i], uPointLightIntensities[i]), pAtten),
            pHalfLambert,
          ),
        );
        const pF = fresnelSchlick(pVdotH, F0);
        const pSpec = pow(pNdotH, effectiveShininess);
        ptSpeculars.push(
          mul(
            mul(
              mul(mul(pF, pSpec), uPointLightColors[i]),
              uPointLightIntensities[i],
            ),
            pAtten,
          ),
        );
      }

      const totalPointDiffuse = add(
        add(add(ptDiffuses[0], ptDiffuses[1]), ptDiffuses[2]),
        ptDiffuses[3],
      );
      const totalPointSpecular = add(
        add(add(ptSpeculars[0], ptSpeculars[1]), ptSpeculars[2]),
        ptSpeculars[3],
      );

      // =========================================================================
      // COMBINE ALL LIGHTING
      // =========================================================================

      // Total diffuse and specular from all lights
      const totalDiffuse = add(totalDirDiffuse, totalPointDiffuse);
      const totalSpecularRaw = add(totalDirSpecular, totalPointSpecular);
      const totalSpecular = select(
        uUseSpecular.greaterThan(0),
        mul(totalSpecularRaw, uSpecularIntensity),
        vec3(0, 0, 0),
      );

      // Ambient with AO
      const ambient = mul(mul(uAmbientColor, uAmbientIntensity), ao);

      // Final composition - diffuse contribution (metals have reduced diffuse)
      const oneMinusMetallic = sub(float(1), metallic);
      // Use full diffuse contribution (removed 0.5 multiplier that was reducing light response)
      const lightingSum = add(ambient, totalDiffuse);
      const diffuseContrib = mul(
        mul(oneMinusMetallic, albedoLinear),
        lightingSum,
      );

      // Add specular (reduced intensity for more natural look)
      const litColor = add(diffuseContrib, mul(totalSpecular, float(0.5)));

      // If no normals available, skip lighting and just use albedo with full brightness
      // This handles the case where only a color atlas is provided (fallback)
      const colorToOutput = select(
        uHasNormals.greaterThan(0),
        litColor,
        albedoLinear,
      );

      // Simple clamp - no tonemapping needed since lighting values are pre-balanced
      // The ambient + diffuse values are designed to stay in 0-1 range for typical scenes
      // Heavy tonemapping was compressing lighting contrast and hiding normal-based shading
      const clampedColor = clamp(colorToOutput, vec3(0, 0, 0), vec3(1, 1, 1));

      // Output LINEAR values - the renderer handles sRGB encoding automatically
      // (removing manual pow(0.4545) to avoid double gamma correction)
      return vec4(clampedColor, totalWeight);
    })();
  }

  material.colorNode = colorNode;

  // ========== ALPHA TEST NODE ==========
  if (dissolveEnabled) {
    material.alphaTestNode = Fn(() => {
      const worldPos = positionWorld;
      const toPlayer = sub(worldPos, uPlayerPos);
      const distSq = add(
        mul(toPlayer.x, toPlayer.x),
        mul(toPlayer.z, toPlayer.z),
      );
      const fadeStartSq = mul(uFadeStart, uFadeStart);
      const fadeEndSq = mul(uFadeEnd, uFadeEnd);
      const farFade = smoothstep(fadeStartSq, fadeEndSq, distSq);

      const ditherScale = float(0.5);
      const instanceSeed = fract(
        mul(float(instanceIndex), float(0.61803398875)),
      );
      const ditherInput = vec2(
        add(
          mul(instanceSeed, float(100)),
          add(mul(worldPos.x, ditherScale), mul(worldPos.y, float(0.2))),
        ),
        add(
          mul(fract(mul(instanceSeed, float(1.618))), float(100)),
          add(mul(worldPos.z, ditherScale), mul(worldPos.y, float(0.15))),
        ),
      );
      const hash1 = fract(
        mul(sin(dot(ditherInput, vec2(12.9898, 78.233))), float(43758.5453)),
      );
      const hash2 = fract(
        mul(cos(dot(ditherInput, vec2(39.346, 11.135))), float(23421.6312)),
      );
      const ditherValue = mul(add(hash1, hash2), float(0.5));

      return add(uAlphaThreshold, mul(ditherValue, farFade));
    })();
  } else {
    material.alphaTestNode = uAlphaThreshold;
  }

  // ========== MATERIAL SETTINGS ==========
  material.transparent = transparent;
  material.depthWrite = depthWrite;
  material.side = THREE_NAMESPACE.DoubleSide;
  material.alphaTest = 0.1;

  // ========== ATTACH UNIFORMS ==========
  // Cast to TSLImpostorMaterial and attach uniforms
  // Use explicit typing to match the expected interface
  const tslMaterial = material as unknown as TSLImpostorMaterial;

  // Build uniforms object
  const uniformsObj: TSLImpostorMaterial["impostorUniforms"] = {
    faceIndices: uFaceIndices as unknown as { value: THREE_NAMESPACE.Vector3 },
    faceWeights: uFaceWeights as unknown as { value: THREE_NAMESPACE.Vector3 },
  };

  if (dissolveEnabled) {
    uniformsObj.playerPos = uPlayerPos as unknown as {
      value: THREE_NAMESPACE.Vector3;
    };
    uniformsObj.fadeStart = uFadeStart as unknown as { value: number };
    uniformsObj.fadeEnd = uFadeEnd as unknown as { value: number };
  }

  if (enableAAA) {
    uniformsObj.ambientColor = uAmbientColor as unknown as {
      value: THREE_NAMESPACE.Vector3;
    };
    uniformsObj.ambientIntensity = uAmbientIntensity as unknown as {
      value: number;
    };
    uniformsObj.numDirectionalLights = uNumDirectionalLights as unknown as {
      value: number;
    };
    uniformsObj.directionalLightDirs = uDirLightDirs as unknown as {
      value: THREE_NAMESPACE.Vector3[];
    };
    uniformsObj.directionalLightColors = uDirLightColors as unknown as {
      value: THREE_NAMESPACE.Vector3[];
    };
    uniformsObj.directionalLightIntensities =
      uDirLightIntensities as unknown as { value: number[] };
    uniformsObj.numPointLights = uNumPointLights as unknown as {
      value: number;
    };
    uniformsObj.pointLightPositions = uPointLightPositions as unknown as {
      value: THREE_NAMESPACE.Vector3[];
    };
    uniformsObj.pointLightColors = uPointLightColors as unknown as {
      value: THREE_NAMESPACE.Vector3[];
    };
    uniformsObj.pointLightIntensities = uPointLightIntensities as unknown as {
      value: number[];
    };
    uniformsObj.pointLightDistances = uPointLightDistances as unknown as {
      value: number[];
    };
    uniformsObj.pointLightDecays = uPointLightDecays as unknown as {
      value: number[];
    };
    uniformsObj.specularF0 = uSpecularF0 as unknown as { value: number };
    uniformsObj.specularShininess = uSpecularShininess as unknown as {
      value: number;
    };
    uniformsObj.specularIntensity = uSpecularIntensity as unknown as {
      value: number;
    };
  }

  // Add color tint uniform
  uniformsObj.colorTint = uColorTint as unknown as {
    value: THREE_NAMESPACE.Vector3;
  };

  tslMaterial.impostorUniforms = uniformsObj;

  // Helper to update view
  // NOTE: Do NOT set material.needsUpdate here - that triggers a full shader recompile.
  // TSL uniform values are automatically synced to the GPU uniform buffer each frame.
  tslMaterial.updateView = (
    faceIndices: THREE_NAMESPACE.Vector3,
    faceWeights: THREE_NAMESPACE.Vector3,
  ) => {
    uFaceIndices.value.copy(faceIndices);
    uFaceWeights.value.copy(faceWeights);
  };

  // Helper to update color tint
  tslMaterial.updateColorTint = (color: THREE_NAMESPACE.Color) => {
    uColorTint.value.set(color.r, color.g, color.b);
  };

  // Helper to update AAA lighting
  if (enableAAA) {
    tslMaterial.updateLighting = (config) => {
      if (config.ambientColor) uAmbientColor.value.copy(config.ambientColor);
      if (config.ambientIntensity !== undefined)
        uAmbientIntensity.value = config.ambientIntensity;

      if (config.directionalLights) {
        const count = Math.min(
          config.directionalLights.length,
          MAX_DIRECTIONAL_LIGHTS_TSL,
        );
        uNumDirectionalLights.value = count;
        for (let i = 0; i < count; i++) {
          const light = config.directionalLights[i];
          uDirLightDirs[i].value.copy(light.direction).normalize();
          uDirLightColors[i].value.copy(light.color);
          uDirLightIntensities[i].value = light.intensity;
        }
      }

      if (config.pointLights) {
        const count = Math.min(config.pointLights.length, MAX_POINT_LIGHTS_TSL);
        uNumPointLights.value = count;
        for (let i = 0; i < count; i++) {
          const light = config.pointLights[i];
          uPointLightPositions[i].value.copy(light.position);
          uPointLightColors[i].value.copy(light.color);
          uPointLightIntensities[i].value = light.intensity;
          uPointLightDistances[i].value = light.distance;
          uPointLightDecays[i].value = light.decay;
        }
      }

      if (config.specular) {
        if (config.specular.f0 !== undefined)
          uSpecularF0.value = config.specular.f0;
        if (config.specular.shininess !== undefined)
          uSpecularShininess.value = config.specular.shininess;
        if (config.specular.intensity !== undefined)
          uSpecularIntensity.value = config.specular.intensity;
      }
      // NOTE: Do NOT set material.needsUpdate - that triggers a full shader recompile.
      // TSL uniform values are automatically synced to the GPU uniform buffer each frame.
    };
  }

  material.needsUpdate = true;

  return tslMaterial;
}

/**
 * Check if a material is a TSL impostor material.
 */
export function isTSLImpostorMaterial(
  material: THREE_NAMESPACE.Material,
): material is TSLImpostorMaterial {
  return (
    material instanceof MeshBasicNodeMaterial &&
    "impostorUniforms" in material &&
    "updateView" in material
  );
}

// ============================================================================
// SIMPLE IMPOSTOR MATERIAL (TSL)
// ============================================================================

/**
 * Simple TSL impostor material type - single view, no blending
 */
export type TSLSimpleImpostorMaterial = MeshBasicNodeMaterial & {
  impostorUniforms: {
    gridSize: { value: THREE_NAMESPACE.Vector2 };
    cellIndex: { value: THREE_NAMESPACE.Vector2 };
  };
};

/**
 * Create a simplified TSL impostor material for static billboards.
 * Uses single-view sampling without dynamic view updates.
 * WebGPU-compatible version of createSimpleImpostorMaterial().
 *
 * @param config - Material configuration
 * @returns TSL material for simple impostor rendering
 */
export function createSimpleTSLImpostorMaterial(
  config: ImpostorMaterialConfig,
): TSLSimpleImpostorMaterial {
  const {
    atlasTexture,
    gridSizeX,
    gridSizeY,
    transparent = true,
    depthTest = true,
    depthWrite = true,
    side = THREE_NAMESPACE.DoubleSide,
  } = config;

  // Configure texture for proper sampling
  // Mark as sRGB so WebGPU auto-decodes to linear, then renderer encodes back to sRGB
  // This is the standard approach when no manual lighting calculations are needed
  atlasTexture.colorSpace = THREE_NAMESPACE.SRGBColorSpace;
  atlasTexture.wrapS = THREE_NAMESPACE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE_NAMESPACE.ClampToEdgeWrapping;
  if (!atlasTexture.isRenderTargetTexture) {
    atlasTexture.needsUpdate = true;
  }

  const material = new MeshBasicNodeMaterial();

  // Center cell index - middle of the grid
  const centerCellX = Math.floor(gridSizeX / 2);
  const centerCellY = Math.floor(gridSizeY / 2);

  // Uniforms - texture is passed directly to texture() function, not wrapped in uniform
  const uGridSize = uniform(new THREE_NAMESPACE.Vector2(gridSizeX, gridSizeY));
  const uCellIndex = uniform(
    new THREE_NAMESPACE.Vector2(centerCellX, centerCellY),
  );

  // Color node - simple atlas sampling at fixed cell
  // WebGPU handles gamma automatically: sRGB texture → linear sample → sRGB output
  material.colorNode = Fn(() => {
    const uvCoord = uv();

    // Calculate cell UV (scale and offset by cell index)
    const cellSize = div(vec2(1.0, 1.0), uGridSize);
    const cellOffset = mul(uCellIndex, cellSize);
    const cellUV = add(cellOffset, mul(uvCoord, cellSize));

    // Sample atlas at cell UV (WebGPU auto-decodes sRGB to linear)
    const color = texture(atlasTexture, cellUV);

    return color;
  })();

  // Opacity from alpha channel
  material.opacityNode = Fn(() => {
    const uvCoord = uv();
    const cellSize = div(vec2(1.0, 1.0), uGridSize);
    const cellOffset = mul(uCellIndex, cellSize);
    const cellUV = add(cellOffset, mul(uvCoord, cellSize));
    return texture(atlasTexture, cellUV).a;
  })();

  // Material settings
  material.transparent = transparent;
  material.depthTest = depthTest;
  material.depthWrite = depthWrite;
  material.side = side;
  material.alphaTest = 0.01;

  // Store uniforms for runtime updates
  const tslMaterial = material as TSLSimpleImpostorMaterial;
  tslMaterial.impostorUniforms = {
    gridSize: uGridSize,
    cellIndex: uCellIndex,
  };

  return tslMaterial;
}
