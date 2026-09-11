/**
 * Building Material System - WebGPU TSL Version
 *
 * Provides procedural building materials using Three.js TSL (Three Shading Language).
 * Fully compatible with WebGPU renderer.
 *
 * Materials available:
 * - Brick (running bond pattern)
 * - Stone (ashlar and rubble)
 * - Wood (planks and timber frame)
 * - Plaster/stucco
 * - Shingles (roofing)
 */

import * as THREE from "three";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import {
  Fn,
  uv,
  uniform,
  vec2,
  vec3,
  vec4,
  float,
  floor,
  fract,
  sin,
  dot,
  mix,
  clamp,
  smoothstep,
  step,
  min,
  sqrt,
  select,
  attribute,
} from "three/tsl";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Building material type identifier
 */
export type BuildingMaterialType =
  | "brick"
  | "stone-ashlar"
  | "stone-rubble"
  | "wood-plank"
  | "timber-frame"
  | "plaster"
  | "shingle";

/**
 * Configuration for building materials
 */
export interface BuildingMaterialConfig {
  /** Material type */
  type: BuildingMaterialType;
  /** Primary color (hex string) */
  baseColor: string;
  /** Secondary color for variation (hex string) */
  secondaryColor: string;
  /** Accent/mortar color (hex string) */
  accentColor: string;
  /** Texture scale (world units per tile) */
  scale: number;
  /** Surface roughness (0-1) */
  roughness: number;
  /** Surface metalness (0-1) */
  metalness: number;
  /** Color variation amount (0-1) */
  variation: number;
  /** Whether to use vertex colors for tinting */
  useVertexColors: boolean;
}

/**
 * Default material configurations per type
 */
export const DEFAULT_MATERIAL_CONFIGS: Record<
  BuildingMaterialType,
  Omit<BuildingMaterialConfig, "type">
> = {
  brick: {
    baseColor: "#8B4513",
    secondaryColor: "#A0522D",
    accentColor: "#D2B48C",
    scale: 1.0,
    roughness: 0.85,
    metalness: 0.0,
    variation: 0.15,
    useVertexColors: true,
  },
  "stone-ashlar": {
    baseColor: "#808080",
    secondaryColor: "#696969",
    accentColor: "#A9A9A9",
    scale: 0.6,
    roughness: 0.75,
    metalness: 0.0,
    variation: 0.1,
    useVertexColors: true,
  },
  "stone-rubble": {
    baseColor: "#6B6B6B",
    secondaryColor: "#555555",
    accentColor: "#8B8B8B",
    scale: 0.3,
    roughness: 0.9,
    metalness: 0.0,
    variation: 0.25,
    useVertexColors: true,
  },
  "wood-plank": {
    baseColor: "#8B7355",
    secondaryColor: "#6B4423",
    accentColor: "#D2B48C",
    scale: 0.2,
    roughness: 0.7,
    metalness: 0.0,
    variation: 0.2,
    useVertexColors: true,
  },
  "timber-frame": {
    baseColor: "#5C4033",
    secondaryColor: "#3C2415",
    accentColor: "#F5F5DC",
    scale: 1.0,
    roughness: 0.75,
    metalness: 0.0,
    variation: 0.1,
    useVertexColors: true,
  },
  plaster: {
    baseColor: "#F5F5DC",
    secondaryColor: "#FFFAF0",
    accentColor: "#E8E8E8",
    scale: 2.0,
    roughness: 0.6,
    metalness: 0.0,
    variation: 0.05,
    useVertexColors: true,
  },
  shingle: {
    baseColor: "#4A3728",
    secondaryColor: "#3C2A1E",
    accentColor: "#5C4033",
    scale: 0.3,
    roughness: 0.8,
    metalness: 0.0,
    variation: 0.15,
    useVertexColors: true,
  },
};

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
 * FBM (Fractal Brownian Motion) noise (TSL)
 */
const tslFBM = Fn(([p]: [Node<"vec2">]) => {
  const value = float(0.0).toVar();
  const amplitude = float(0.5).toVar();
  const frequency = float(1.0).toVar();

  // 4 octaves unrolled (TSL doesn't support loops well)
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

// ============================================================================
// TSL PATTERN FUNCTIONS
// ============================================================================

/**
 * Brick pattern - returns (isBrick, brickIdX, brickIdY, 0)
 */
const brickPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const brickWidth = float(0.25);
  const brickHeight = float(0.065);
  const mortarWidth = float(0.01);

  const scaled = uvIn.div(vec2(brickWidth, brickHeight));
  const row = floor(scaled.y);
  const rowOffset = row.mod(2.0).mul(0.5);
  const offsetUV = vec2(scaled.x.add(rowOffset), scaled.y);

  const brickId = floor(offsetUV);
  const localUV = fract(offsetUV);

  const mortarU = mortarWidth.div(brickWidth);
  const mortarV = mortarWidth.div(brickHeight);

  const inMortarX = step(localUV.x, mortarU).add(
    step(float(1.0).sub(mortarU), localUV.x),
  );
  const inMortarY = step(localUV.y, mortarV).add(
    step(float(1.0).sub(mortarV), localUV.y),
  );
  const inMortar = clamp(inMortarX.add(inMortarY), 0.0, 1.0);

  const isBrick = float(1.0).sub(inMortar);
  return vec4(isBrick, brickId.x, brickId.y, 0.0);
});

/**
 * Ashlar stone pattern - returns (isStone, stoneIdX, stoneIdY, bevel)
 */
const ashlarPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const blockWidth = float(0.6);
  const blockHeight = float(0.3);
  const mortarWidth = float(0.015);

  const scaled = uvIn.div(vec2(blockWidth, blockHeight));
  const row = floor(scaled.y);
  const rowOffset = row.mod(2.0).mul(0.5);
  const offsetUV = vec2(scaled.x.add(rowOffset), scaled.y);

  const blockId = floor(offsetUV);
  const localUV = fract(offsetUV);

  const mortarU = mortarWidth.div(blockWidth);
  const mortarV = mortarWidth.div(blockHeight);

  // Bevel at edges
  const edgeDistX = min(localUV.x, float(1.0).sub(localUV.x));
  const edgeDistY = min(localUV.y, float(1.0).sub(localUV.y));
  const bevel = smoothstep(0.0, 0.05, min(edgeDistX, edgeDistY));

  const inMortarX = step(localUV.x, mortarU).add(
    step(float(1.0).sub(mortarU), localUV.x),
  );
  const inMortarY = step(localUV.y, mortarV).add(
    step(float(1.0).sub(mortarV), localUV.y),
  );
  const inMortar = clamp(inMortarX.add(inMortarY), 0.0, 1.0);

  const isStone = float(1.0).sub(inMortar);
  return vec4(isStone, blockId.x, blockId.y, bevel);
});

/**
 * Rubble stone pattern (Voronoi-based) - returns (isStone, cellIdX, cellIdY, 0)
 */
const rubblePattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const scale = float(0.15);
  const scaled = uvIn.div(scale);
  const cellId = floor(scaled);
  const localPos = fract(scaled);

  // Find closest cell center (3x3 search unrolled)
  const minDist = float(10.0).toVar();
  const closestCellX = float(0.0).toVar();
  const closestCellY = float(0.0).toVar();

  // Unrolled 3x3 loop for Voronoi
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const neighbor = cellId.add(vec2(float(dx), float(dy)));
      const cellHash = tslHash(neighbor);
      const cellCenter = vec2(0.5, 0.5).add(cellHash.sub(0.5).mul(0.8));
      const toCenter = localPos.sub(cellCenter).add(vec2(float(dx), float(dy)));
      const dist = dot(toCenter, toCenter);

      // Update closest if this is nearer
      closestCellX.assign(
        select(dist.lessThan(minDist), neighbor.x, closestCellX),
      );
      closestCellY.assign(
        select(dist.lessThan(minDist), neighbor.y, closestCellY),
      );
      minDist.assign(min(minDist, dist));
    }
  }

  const mortarWidthV = float(0.08);
  const isStone = smoothstep(
    mortarWidthV,
    mortarWidthV.mul(1.5),
    sqrt(minDist),
  );

  return vec4(isStone, closestCellX, closestCellY, 0.0);
});

/**
 * Wood plank pattern - returns (isPlank, plankId, grainOffset, 0)
 */
const woodPlankPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const plankWidth = float(0.15);
  const plankHeight = float(2.0);
  const gapWidth = float(0.005);

  const scaled = vec2(uvIn.x.div(plankHeight), uvIn.y.div(plankWidth));
  const plankId = floor(scaled.y);
  const localUV = vec2(fract(scaled.x), fract(scaled.y));

  // Random offset per plank
  const plankOffset = tslHash(vec2(plankId, 0.0)).mul(0.3);
  const offsetU = fract(localUV.x.add(plankOffset));

  // Gap between planks
  const gapV = gapWidth.div(plankWidth);
  const inGap = step(localUV.y, gapV).add(
    step(float(1.0).sub(gapV), localUV.y),
  );

  const isPlank = float(1.0).sub(clamp(inGap, 0.0, 1.0));
  return vec4(isPlank, plankId, offsetU, 0.0);
});

/**
 * Shingle pattern - returns (isShingle, shingleIdX, shingleIdY, thickness)
 */
const shinglePattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const shingleWidth = float(0.2);
  const shingleHeight = float(0.15);
  const overlap = float(0.3);

  const scaled = vec2(
    uvIn.x.div(shingleWidth),
    uvIn.y.div(shingleHeight.mul(float(1.0).sub(overlap))),
  );
  const row = floor(scaled.y);
  const rowOffset = row.mod(2.0).mul(0.5);
  const offsetUV = vec2(scaled.x.add(rowOffset), scaled.y);

  const shingleId = floor(offsetUV);
  const localUV = fract(offsetUV);

  // Rounded bottom
  const bottomCurve = sin(localUV.x.mul(3.14159)).mul(0.1);
  const bottomEdge = bottomCurve.add(0.05);
  const isShingle = step(bottomEdge, localUV.y);

  const thickness = float(0.95).add(tslHash(shingleId).mul(0.1));
  return vec4(isShingle, shingleId.x, shingleId.y, thickness);
});

/**
 * Plaster pattern - returns (1.0, variationValue, 0, 0)
 */
const plasterPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const scaled = uvIn.mul(2.0);
  const noise1 = tslFBM(scaled);
  const noise2 = tslFBM(scaled.mul(3.0));
  const variation = noise1.mul(0.7).add(noise2.mul(0.3));
  return vec4(1.0, variation, 0.0, 0.0);
});

// ============================================================================
// PATTERN INDICES
// ============================================================================

const PATTERN_INDICES: Record<BuildingMaterialType, number> = {
  brick: 0,
  "stone-ashlar": 1,
  "stone-rubble": 2,
  "wood-plank": 3,
  "timber-frame": 4,
  plaster: 5,
  shingle: 6,
};

// ============================================================================
// TSL MATERIAL FACTORY
// ============================================================================

/**
 * Extended material type with building uniforms
 */
export type TSLBuildingMaterial = MeshStandardNodeMaterial & {
  buildingUniforms: {
    baseColor: { value: THREE.Color };
    secondaryColor: { value: THREE.Color };
    accentColor: { value: THREE.Color };
    textureScale: { value: number };
    variation: { value: number };
  };
};

/**
 * Create a procedural building material using TSL for WebGPU
 */
export function createBuildingMaterial(
  config: Partial<BuildingMaterialConfig> & { type: BuildingMaterialType },
): TSLBuildingMaterial {
  const defaults = DEFAULT_MATERIAL_CONFIGS[config.type];
  const fullConfig: BuildingMaterialConfig = {
    ...defaults,
    ...config,
    type: config.type,
  };

  const material = new MeshStandardNodeMaterial();
  material.roughness = fullConfig.roughness;
  material.metalness = fullConfig.metalness;

  // Uniforms
  const uBaseColor = uniform(new THREE.Color(fullConfig.baseColor));
  const uSecondaryColor = uniform(new THREE.Color(fullConfig.secondaryColor));
  const uAccentColor = uniform(new THREE.Color(fullConfig.accentColor));
  const uTextureScale = uniform(fullConfig.scale);
  const uVariation = uniform(fullConfig.variation);
  const patternType = PATTERN_INDICES[fullConfig.type];

  // Color node - procedural pattern generation
  const colorNode = Fn(() => {
    // Get UV from mesh UV attribute, scaled
    const meshUV = uv();
    const scaledUV = meshUV.div(uTextureScale);

    // Get vertex color for tinting (if available)
    const vertexColor = fullConfig.useVertexColors
      ? attribute<"vec3">("color", "vec3")
      : vec3(1.0, 1.0, 1.0);

    // Pattern result placeholder
    const patternResult = vec4(1.0, 0.0, 0.0, 0.0).toVar();
    const surfaceColor = vec3(1.0, 1.0, 1.0).toVar();

    // Select pattern based on type
    if (patternType === 0) {
      // Brick
      patternResult.assign(brickPattern(scaledUV));
      const isBrick = patternResult.x;
      const brickId = patternResult.yz;

      const brickNoise = tslHash(brickId);
      const brickColor = mix(
        uBaseColor,
        uSecondaryColor,
        brickNoise.mul(uVariation),
      );
      surfaceColor.assign(mix(uAccentColor, brickColor, isBrick));
    } else if (patternType === 1) {
      // Stone Ashlar
      patternResult.assign(ashlarPattern(scaledUV));
      const isStone = patternResult.x;
      const stoneId = patternResult.yz;
      const bevel = patternResult.w;

      const stoneNoise = tslHash(stoneId);
      const stoneColor = mix(
        uBaseColor,
        uSecondaryColor,
        stoneNoise.mul(uVariation),
      );
      const beveledColor = mix(stoneColor.mul(0.8), stoneColor, bevel);
      surfaceColor.assign(mix(uAccentColor, beveledColor, isStone));
    } else if (patternType === 2) {
      // Stone Rubble
      patternResult.assign(rubblePattern(scaledUV));
      const isStone = patternResult.x;
      const stoneId = patternResult.yz;

      const stoneNoise = tslHash(stoneId);
      const stoneColor = mix(
        uBaseColor,
        uSecondaryColor,
        stoneNoise.mul(uVariation.mul(2.0)),
      );
      surfaceColor.assign(mix(uAccentColor, stoneColor, isStone));
    } else if (patternType === 3) {
      // Wood Plank
      patternResult.assign(woodPlankPattern(scaledUV));
      const isPlank = patternResult.x;
      const plankId = patternResult.y;
      const grainOffset = patternResult.z;

      const plankNoise = tslHash(vec2(plankId, 0.0));
      const baseWood = mix(
        uBaseColor,
        uSecondaryColor,
        plankNoise.mul(uVariation),
      );

      const grainNoise = tslNoise2D(vec2(grainOffset.mul(20.0), plankId));
      const grainedColor = mix(
        baseWood,
        baseWood.mul(0.85),
        grainNoise.mul(0.3),
      );
      surfaceColor.assign(mix(uAccentColor, grainedColor, isPlank));
    } else if (patternType === 4 || patternType === 5) {
      // Timber Frame or Plaster
      patternResult.assign(plasterPattern(scaledUV));
      const variationValue = patternResult.y;
      surfaceColor.assign(
        mix(uBaseColor, uSecondaryColor, variationValue.mul(uVariation)),
      );
    } else if (patternType === 6) {
      // Shingle
      patternResult.assign(shinglePattern(scaledUV));
      const isShingle = patternResult.x;
      const shingleId = patternResult.yz;
      const thickness = patternResult.w;

      const shingleNoise = tslHash(shingleId);
      const shingleColor = mix(
        uBaseColor,
        uSecondaryColor,
        shingleNoise.mul(uVariation),
      );
      const shadedColor = shingleColor.mul(thickness);
      surfaceColor.assign(mix(uBaseColor.mul(0.3), shadedColor, isShingle));
    } else {
      surfaceColor.assign(uBaseColor);
    }

    // Blend with vertex colors for tinting
    const finalColor = surfaceColor.mul(vertexColor);

    return finalColor;
  })();

  material.colorNode = colorNode;

  // Store uniforms for runtime updates
  const tslMaterial = material as TSLBuildingMaterial;
  tslMaterial.buildingUniforms = {
    baseColor: uBaseColor,
    secondaryColor: uSecondaryColor,
    accentColor: uAccentColor,
    textureScale: uTextureScale,
    variation: uVariation,
  };

  return tslMaterial;
}

// ============================================================================
// MATERIAL PRESETS
// ============================================================================

/**
 * Pre-configured material presets for common building types
 */
export const BUILDING_MATERIAL_PRESETS = {
  // Residential
  "house-brick": {
    type: "brick" as const,
    baseColor: "#8B4513",
    secondaryColor: "#A0522D",
    accentColor: "#D2B48C",
  },
  "house-stone": {
    type: "stone-ashlar" as const,
    baseColor: "#808080",
    secondaryColor: "#696969",
    accentColor: "#A9A9A9",
  },
  "house-plaster": {
    type: "plaster" as const,
    baseColor: "#F5F5DC",
    secondaryColor: "#FFFAF0",
    accentColor: "#E8E8E8",
  },

  // Commercial
  "shop-timber": {
    type: "timber-frame" as const,
    baseColor: "#F5F5DC",
    secondaryColor: "#FFFAF0",
    accentColor: "#5C4033",
  },
  "inn-brick": {
    type: "brick" as const,
    baseColor: "#6B4423",
    secondaryColor: "#8B4513",
    accentColor: "#C4A484",
  },

  // Civic
  "bank-stone": {
    type: "stone-ashlar" as const,
    baseColor: "#A9A9A9",
    secondaryColor: "#808080",
    accentColor: "#D3D3D3",
  },
  "church-stone": {
    type: "stone-ashlar" as const,
    baseColor: "#C0C0C0",
    secondaryColor: "#A9A9A9",
    accentColor: "#E8E8E8",
  },

  // Fortification
  "keep-stone": {
    type: "stone-ashlar" as const,
    baseColor: "#696969",
    secondaryColor: "#555555",
    accentColor: "#808080",
  },
  "fortress-rubble": {
    type: "stone-rubble" as const,
    baseColor: "#555555",
    secondaryColor: "#444444",
    accentColor: "#666666",
  },

  // Roofing
  "roof-shingle": {
    type: "shingle" as const,
    baseColor: "#4A3728",
    secondaryColor: "#3C2A1E",
    accentColor: "#5C4033",
  },
  "roof-slate": {
    type: "shingle" as const,
    baseColor: "#3C3C3C",
    secondaryColor: "#2F2F2F",
    accentColor: "#4A4A4A",
  },

  // Interior
  "floor-wood": {
    type: "wood-plank" as const,
    baseColor: "#8B7355",
    secondaryColor: "#6B4423",
    accentColor: "#D2B48C",
  },
  "floor-stone": {
    type: "stone-ashlar" as const,
    baseColor: "#6B6B6B",
    secondaryColor: "#555555",
    accentColor: "#808080",
  },
} as const;

export type BuildingMaterialPreset = keyof typeof BUILDING_MATERIAL_PRESETS;

/**
 * Create a material from a preset name
 */
export function createMaterialFromPreset(
  preset: BuildingMaterialPreset,
): TSLBuildingMaterial {
  const config = BUILDING_MATERIAL_PRESETS[preset];
  return createBuildingMaterial(config);
}

/**
 * Get the default material config for a building type based on recipe type
 */
export function getMaterialConfigForBuildingType(
  buildingType: string,
): Partial<BuildingMaterialConfig> & { type: BuildingMaterialType } {
  switch (buildingType) {
    case "bank":
    case "guild-hall":
      return BUILDING_MATERIAL_PRESETS["bank-stone"];
    case "church":
    case "cathedral":
      return BUILDING_MATERIAL_PRESETS["church-stone"];
    case "keep":
    case "fortress":
      return BUILDING_MATERIAL_PRESETS["keep-stone"];
    case "inn":
      return BUILDING_MATERIAL_PRESETS["inn-brick"];
    case "store":
    case "smithy":
      return BUILDING_MATERIAL_PRESETS["shop-timber"];
    case "simple-house":
    case "long-house":
    default:
      return BUILDING_MATERIAL_PRESETS["house-brick"];
  }
}
