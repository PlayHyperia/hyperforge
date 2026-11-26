/**
 * LightingConfig - Central lighting & sky settings for the entire app
 *
 * Single source of truth for all lighting-related constants:
 * sun shade, hemisphere/ambient lights, exposure, fog colors, day-night cycle.
 *
 * Imported by Environment, SkySystem, TerrainShader, GPUMaterials, and any
 * other system that needs lighting parameters.
 *
 * @module LightingConfig
 */

// ============================================================================
// DAY / NIGHT CYCLE
// ============================================================================

export const DAY_CYCLE = {
  /** Full day cycle duration in seconds */
  DURATION_SEC: 240,

  /** dayPhase thresholds — 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset */
  DAWN_START: 0.22,
  DAWN_MID: 0.25,
  DAWN_END: 0.28,
  DUSK_START: 0.72,
  DUSK_MID: 0.75,
  DUSK_END: 0.78,

  /** During full day the intensity oscillates between this floor and 1.0 */
  NOON_MIN_INTENSITY: 0.85,
} as const;

// ============================================================================
// DIRECTIONAL LIGHT (SUN / MOON)
// ============================================================================

/**
 * Chromaticity calibration candidate: the four night RGB endpoints and shared
 * shade tint below retain 25% of their original chroma and 75% achromatic Y.
 * Values are linear RGB, with Rec709 Y = .2126 R + .7152 G + .0722 B; each
 * precomputed endpoint preserves its original Y without per-frame work.
 * This conserves palette luminance, not every colored surface's rendered
 * luminance. Intensities, exposure and timing are unchanged; art approval still
 * requires actual day/night captures with the shared shade treatment.
 */
export const SUN_LIGHT = {
  /** Fallback sun direction before SkySystem takes over */
  DEFAULT_DIRECTION: [0.5, 0.8, 0.3] as readonly [number, number, number],

  /** Sun intensity = dayIntensity × this × transitionFade */
  DAY_INTENSITY_MULTIPLIER: 1.8,
  DAY_COLOR: [1.0, 0.98, 0.92] as readonly [number, number, number],

  /** Golden-hour phase ranges [start, end] (pairs) */
  GOLDEN_HOUR_RANGES: [
    [0.22, 0.32],
    [0.68, 0.78],
  ] as readonly (readonly [number, number])[],
  GOLDEN_HOUR_COLOR: [1.0, 0.85, 0.6] as readonly [number, number, number],

  /** Moon intensity = nightIntensity × this × transitionFade */
  MOON_INTENSITY_MULTIPLIER: 0.35,
  MOON_COLOR: [0.3265775, 0.4390775, 0.4890775] as readonly [
    number,
    number,
    number,
  ],

  /** Z-axis tilt of the sun arc (0 = flat E-W, 1 = full N-S) */
  TILT: 0.3,

  /** Lerp speed for smooth light-direction interpolation (per frame) */
  DIRECTION_LERP: 0.02,
} as const;

// ============================================================================
// SUN SHADE (shadow-side sky tint applied in shaders)
// ============================================================================

export const SUN_SHADE = {
  /**
   * Mix strength: 0 = no shade, 1 = full shade.
   * The shade factor is `0.5 − dot(N,L) × 0.5`  (0 on lit side, 1 on shadow side).
   * Applied on the ALBEDO (before lighting) to avoid double-darkening.
   */
  STRENGTH: 1.0,

  /**
   * Luminance-preserving, lower-chroma calibration of the original teal tint.
   * Applied as: tinted = color × TINT_COLOR, then mixed by shade factor.
   * Dynamic behavior comes from the shade factor (sun position), not this color.
   */
  TINT_COLOR: [0.306105, 0.431105, 0.481105] as readonly [
    number,
    number,
    number,
  ],
} as const;

// ============================================================================
// NIGHT BRIGHTNESS (master knob for tree + terrain)
// ============================================================================

export const NIGHT = {
  /** Master night brightness (0 = pitch black, 1 = full day brightness).
   *  Controls both the tree shader nightDim floor and scene light intensity bases. */
  BRIGHTNESS: 0.8,
} as const;

// ============================================================================
// HEMISPHERE LIGHT (sky / ground ambient)
// ============================================================================

const HEMISPHERE_DAY_TOTAL = 0.9;

export const HEMISPHERE_LIGHT = {
  INITIAL_SKY_COLOR: 0x87ceeb,
  INITIAL_GROUND_COLOR: 0x5d4837,
  INITIAL_INTENSITY: 0.5,

  /** Runtime intensity = NIGHT.BRIGHTNESS + dayIntensity × DAY_ADD */
  INTENSITY_BASE: NIGHT.BRIGHTNESS,
  INTENSITY_DAY_ADD: HEMISPHERE_DAY_TOTAL - NIGHT.BRIGHTNESS,

  /** Sky color lerped between NIGHT → DAY based on dayIntensity */
  DAY_SKY_COLOR: [0.53, 0.81, 0.92] as readonly [number, number, number],
  NIGHT_SKY_COLOR: [0.096705, 0.134205, 0.171705] as readonly [
    number,
    number,
    number,
  ],

  /** Ground color lerped between NIGHT → DAY */
  DAY_GROUND_COLOR: [0.36, 0.27, 0.18] as readonly [number, number, number],
  NIGHT_GROUND_COLOR: [0.040424, 0.047924, 0.060424] as readonly [
    number,
    number,
    number,
  ],
} as const;

// ============================================================================
// AMBIENT LIGHT (flat fill)
// ============================================================================

const AMBIENT_DAY_TOTAL = 0.5;

export const AMBIENT_LIGHT = {
  INITIAL_COLOR: 0x606070,
  INITIAL_INTENSITY: 0.5,

  /** Runtime intensity = NIGHT.BRIGHTNESS + dayIntensity × DAY_ADD */
  INTENSITY_BASE: NIGHT.BRIGHTNESS,
  INTENSITY_DAY_ADD: AMBIENT_DAY_TOTAL - NIGHT.BRIGHTNESS,

  /** Color lerped between NIGHT → DAY */
  DAY_COLOR: [1.0, 0.95, 0.95] as readonly [number, number, number],
  NIGHT_COLOR: [0.2352875, 0.3102875, 0.3477875] as readonly [
    number,
    number,
    number,
  ],
} as const;

// ============================================================================
// AUTO EXPOSURE (eye adaptation)
// ============================================================================

export const EXPOSURE = {
  DAY: 0.85,
  /** Slight boost at night */
  NIGHT: 1.1,
  /** Per-frame lerp speed toward target exposure */
  LERP_SPEED: 0.03,
} as const;

// ============================================================================
// SHARED SUN-SHADE SHADER FUNCTION (TSL)
// ============================================================================

import {
  sub,
  mul,
  float,
  mix,
  vec3,
  add,
  dot,
  normalize,
} from "../../../extras/three/three";
import type { Node } from "three/webgpu";

/**
 * Apply a day/night sky-tint to a colour in TSL.
 *
 * Driven by `dayIntensity` (0 = full night, 1 = full day) so the tint
 * transitions at the exact same rate as the scene lights. Reusable for
 * any custom shader that bypasses standard PBR lighting.
 *
 * Should be called on the raw **albedo** (before lighting) so the hue
 * shift survives through subsequent brightness reductions.
 *
 * @param color      - Albedo / base color node
 * @param dayIntensity - Uniform or node with range [0, 1]
 * @param shadeColor - Tint color node (e.g. `vec3(...SUN_SHADE.TINT_COLOR)`)
 */
export function applySunShade(
  color: Node<"vec3">,
  dayIntensity: Node<"float">,
  shadeColor: Node<"vec3">,
): Node<"vec3"> {
  const shadeFactor = sub(float(1.0), dayIntensity);
  const tinted = mul(color, shadeColor);
  return mix(color, tinted, shadeFactor);
}

/**
 * Shared custom lighting for terrain and grass — bypasses PBR entirely.
 * Applies day/night tint + half-lambert directional shading + ambient floor.
 * Both terrain and grass call this with the same parameters to guarantee
 * identical pixel output at the same world position.
 *
 * @param albedo       - Pre-lit base color (after anime shade + vertex lights)
 * @param normal       - Surface normal (terrain slope)
 * @param sunDirNode   - Sun direction uniform
 * @param dayIntensity - Day intensity uniform [0,1]
 * @param shadeColor   - Night tint color node
 */
export function applyCustomLighting(
  albedo: Node<"vec3">,
  normal: Node<"vec3">,
  sunDirNode: Node<"vec3">,
  dayIntensity: Node<"float">,
  shadeColor: Node<"vec3">,
): Node<"vec3"> {
  const tinted = applySunShade(albedo, dayIntensity, shadeColor);
  const sunDir = normalize(vec3(sunDirNode));
  const NdotL = dot(normal, sunDir);
  const halfLambert = add(mul(NdotL, float(0.5)), float(0.5));
  const ambient = float(0.35);
  const lighting = add(ambient, mul(float(0.65), halfLambert));
  const nightDim = mix(float(NIGHT.BRIGHTNESS), float(1.0), dayIntensity);
  return mul(tinted, mul(lighting, nightDim));
}

// ============================================================================
// FOG COLORS (day / night scene fog — separate from sky-fog render target)
// ============================================================================

export const FOG_COLORS = {
  DAY: 0xd4c8b8,
  NIGHT: 0x2b3445,
} as const;
