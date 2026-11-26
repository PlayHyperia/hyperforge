/**
 * Window Glass Material - Dithered Transparency using TSL
 *
 * Creates an old-school Bayer matrix dithered transparency effect for windows.
 * This uses alpha cutout (discard) rather than true blending, which:
 * - Is more performant (no sorting required)
 * - Has a stylized retro aesthetic
 * - Works correctly with depth buffer
 * - Doesn't require special render order handling
 *
 * The Bayer dither pattern creates the illusion of semi-transparency
 * by selectively discarding pixels in a ordered pattern.
 */

import * as THREE from "three";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import {
  Fn,
  uv,
  uniform,
  vec3,
  float,
  floor,
  mod,
  select,
  Discard,
  If,
  attribute,
} from "three/tsl";

// ============================================================================
// TSL BAYER DITHER FUNCTION
// ============================================================================

/**
 * Calculate Bayer dither threshold for a given screen position.
 * Uses a 4x4 Bayer matrix pattern.
 */
const bayerDither4x4 = Fn(([screenPos]: [Node<"vec2">]) => {
  // Get position within 4x4 grid
  const x = mod(floor(screenPos.x), 4.0);
  const y = mod(floor(screenPos.y), 4.0);

  // Manually lookup Bayer matrix value (TSL doesn't support array indexing well)
  // We'll use nested selects to simulate the lookup

  // Row 0: 0, 8, 2, 10 (normalized: 0, 0.5, 0.125, 0.625)
  // Row 1: 12, 4, 14, 6 (normalized: 0.75, 0.25, 0.875, 0.375)
  // Row 2: 3, 11, 1, 9 (normalized: 0.1875, 0.6875, 0.0625, 0.5625)
  // Row 3: 15, 7, 13, 5 (normalized: 0.9375, 0.4375, 0.8125, 0.3125)

  // Build the threshold value using selects
  // This is verbose but necessary for TSL compatibility
  const row0 = select(
    x.lessThan(1.0),
    float(0.0 / 16.0),
    select(
      x.lessThan(2.0),
      float(8.0 / 16.0),
      select(x.lessThan(3.0), float(2.0 / 16.0), float(10.0 / 16.0)),
    ),
  );

  const row1 = select(
    x.lessThan(1.0),
    float(12.0 / 16.0),
    select(
      x.lessThan(2.0),
      float(4.0 / 16.0),
      select(x.lessThan(3.0), float(14.0 / 16.0), float(6.0 / 16.0)),
    ),
  );

  const row2 = select(
    x.lessThan(1.0),
    float(3.0 / 16.0),
    select(
      x.lessThan(2.0),
      float(11.0 / 16.0),
      select(x.lessThan(3.0), float(1.0 / 16.0), float(9.0 / 16.0)),
    ),
  );

  const row3 = select(
    x.lessThan(1.0),
    float(15.0 / 16.0),
    select(
      x.lessThan(2.0),
      float(7.0 / 16.0),
      select(x.lessThan(3.0), float(13.0 / 16.0), float(5.0 / 16.0)),
    ),
  );

  // Select the appropriate row based on y
  const threshold = select(
    y.lessThan(1.0),
    row0,
    select(y.lessThan(2.0), row1, select(y.lessThan(3.0), row2, row3)),
  );

  return threshold;
});

/**
 * 8x8 Bayer dither for higher quality at the cost of more pattern visibility
 */
const bayerDither8x8 = Fn(([screenPos]: [Node<"vec2">]) => {
  // Simplified 8x8 using two 4x4 lookups with offset
  const base = bayerDither4x4(screenPos);
  const offset = bayerDither4x4(screenPos.mul(0.5)).mul(0.25);
  return base.mul(0.75).add(offset);
});

// ============================================================================
// WINDOW GLASS MATERIAL TYPES
// ============================================================================

export interface WindowGlassConfig {
  /** Glass tint color (default: light blue) */
  tintColor: string;
  /** Opacity level 0-1 where 1 is fully opaque (default: 0.4) */
  opacity: number;
  /** Dither scale - higher = smaller pattern (default: 1.0) */
  ditherScale: number;
  /** Whether to use vertex colors for tinting */
  useVertexColors: boolean;
  /** Use 8x8 dither instead of 4x4 (finer pattern) */
  use8x8Dither: boolean;
}

const DEFAULT_GLASS_CONFIG: WindowGlassConfig = {
  tintColor: "#87CEEB", // Light sky blue
  opacity: 0.4, // 40% opacity - shows decent amount of dithering
  ditherScale: 1.0,
  useVertexColors: true,
  use8x8Dither: false,
};

/**
 * Extended material type with glass uniforms
 */
export type TSLWindowGlassMaterial = MeshStandardNodeMaterial & {
  glassUniforms: {
    tintColor: { value: THREE.Color };
    opacity: { value: number };
    ditherScale: { value: number };
  };
};

// ============================================================================
// MATERIAL FACTORY
// ============================================================================

/**
 * Create a dithered glass material for windows using TSL.
 * Uses Bayer matrix dithering for a retro transparency effect.
 *
 * @param config - Glass configuration options
 * @returns TSL material with dithered transparency
 */
export function createWindowGlassMaterial(
  config: Partial<WindowGlassConfig> = {},
): TSLWindowGlassMaterial {
  const fullConfig: WindowGlassConfig = { ...DEFAULT_GLASS_CONFIG, ...config };

  const material = new MeshStandardNodeMaterial();
  material.roughness = 0.1;
  material.metalness = 0.0;
  material.side = THREE.DoubleSide;

  // Uniforms
  const uTintColor = uniform(new THREE.Color(fullConfig.tintColor));
  const uOpacity = uniform(fullConfig.opacity);
  const uDitherScale = uniform(fullConfig.ditherScale);

  // Color node - glass tint color
  const colorNode = Fn(() => {
    const baseColor = uTintColor.rgb;

    // Optionally blend with vertex colors
    if (fullConfig.useVertexColors) {
      const vertexColor = attribute<"vec3">("color", "vec3");
      return vec3(baseColor).mul(vertexColor);
    }

    return baseColor;
  })();

  material.colorNode = colorNode;

  // Alpha test node - implements the dithered transparency
  // Using outputNode to apply discard based on dither pattern
  const alphaTestNode = Fn(() => {
    // Use fragment position (screen space) for dither pattern
    // positionLocal is model space, we need to convert to something screen-like
    // For simplicity, we use UV coordinates scaled by dither scale
    const uvCoord = uv();
    const ditherCoord = uvCoord.mul(64.0).mul(uDitherScale); // Scale to get reasonable pattern size

    // Get dither threshold
    const threshold = fullConfig.use8x8Dither
      ? bayerDither8x8(ditherCoord)
      : bayerDither4x4(ditherCoord);

    // Discard if opacity is less than threshold
    // This creates the dithered pattern
    const shouldDiscard = uOpacity.lessThan(threshold);

    If(shouldDiscard, () => {
      Discard();
    });

    return colorNode;
  })();

  material.colorNode = alphaTestNode;

  // Store uniforms for runtime updates
  const tslMaterial = material as TSLWindowGlassMaterial;
  tslMaterial.glassUniforms = {
    tintColor: uTintColor,
    opacity: uOpacity,
    ditherScale: uDitherScale,
  };

  return tslMaterial;
}

// ============================================================================
// PRESETS
// ============================================================================

/**
 * Pre-configured glass material presets
 */
export const WINDOW_GLASS_PRESETS = {
  /** Standard clear glass with light blue tint */
  "clear-glass": {
    tintColor: "#87CEEB",
    opacity: 0.35,
    ditherScale: 1.0,
    use8x8Dither: false,
  },
  /** Frosted/textured glass - more opaque */
  "frosted-glass": {
    tintColor: "#E8E8E8",
    opacity: 0.6,
    ditherScale: 0.5, // Larger pattern for frosted look
    use8x8Dither: true,
  },
  /** Stained glass - colored and more opaque */
  "stained-glass": {
    tintColor: "#4169E1",
    opacity: 0.55,
    ditherScale: 1.0,
    use8x8Dither: false,
  },
  /** Dark/tinted glass */
  "dark-glass": {
    tintColor: "#2F4F4F",
    opacity: 0.7,
    ditherScale: 1.0,
    use8x8Dither: true,
  },
  /** Amber/warm glass */
  "amber-glass": {
    tintColor: "#FFBF00",
    opacity: 0.45,
    ditherScale: 1.0,
    use8x8Dither: false,
  },
} as const;

export type WindowGlassPreset = keyof typeof WINDOW_GLASS_PRESETS;

/**
 * Create a glass material from a preset name
 */
export function createGlassFromPreset(
  preset: WindowGlassPreset,
): TSLWindowGlassMaterial {
  const config = WINDOW_GLASS_PRESETS[preset];
  return createWindowGlassMaterial(config);
}

/**
 * Get recommended glass preset for a building type
 */
export function getGlassPresetForBuildingType(
  buildingType: string,
): WindowGlassPreset {
  switch (buildingType) {
    case "church":
    case "cathedral":
      return "stained-glass";
    case "bank":
    case "guild-hall":
      return "frosted-glass";
    case "keep":
    case "fortress":
      return "dark-glass";
    case "inn":
    case "tavern":
      return "amber-glass";
    default:
      return "clear-glass";
  }
}
