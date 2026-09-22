/**
 * Flower Generation Module
 *
 * Procedural flower generation with WebGPU/TSL support.
 * This module provides the core flower generation primitives used by
 * both the game engine (ProceduralFlowers system) and Asset Forge.
 *
 * @module Flowers
 *
 * @example
 * ```ts
 * import { FlowerGen } from "@hyperforge/procgen";
 *
 * // Quick flower field generation
 * const field = FlowerGen.FlowerGenerator.generateField({
 *   config: { density: 2000, tileSize: 30 },
 * });
 * scene.add(field.mesh);
 *
 * // Or use individual components:
 * const geometry = FlowerGen.createFlowerGeometry();
 * const { material, uniforms } = FlowerGen.createFlowerMaterial();
 * ```
 */

// Types
export type {
  FlowerConfig,
  FlowerAppearanceConfig,
  FlowerColorConfig,
  FlowerPalette,
  FlowerLODConfig,
  FlowerBiomePreset,
} from "./types.js";

export type { FlowerMaterialUniforms } from "./FlowerMaterialTSL.js";

export {
  DEFAULT_FLOWER_APPEARANCE,
  DEFAULT_FLOWER_COLORS,
  DEFAULT_FLOWER_PALETTE,
  DEFAULT_FLOWER_LOD,
  DEFAULT_FLOWER_CONFIG,
  FLOWER_BIOME_PRESETS,
  getFlowerBiomePreset,
  getFlowerBiomePresetNames,
  mergeFlowerConfig,
} from "./types.js";

// Geometry
export type { RootedFlowerGeometryOptions } from "./RootedFlowerGeometry.js";
export { createRootedFlowerGeometry } from "./RootedFlowerGeometry.js";

export type {
  FlowerInstanceData,
  FlowerPatchResult,
  FlowerPatchOptions,
} from "./FlowerGeometry.js";

export {
  createFlowerGeometry,
  generateFlowerPatch,
  attachFlowerInstanceAttributes,
  createProceduralPetalTexture,
  createMultiPetalTexture,
} from "./FlowerGeometry.js";

// Materials
export type {
  FlowerMaterialOptions,
  FlowerMaterialResult,
} from "./FlowerMaterialTSL.js";

export {
  createFlowerMaterial,
  createFlowerUniforms,
  updateFlowerTime,
  updateFlowerWind,
  updateFlowerColors,
} from "./FlowerMaterialTSL.js";

// Generator
export type {
  FlowerFieldOptions,
  FlowerFieldResult,
} from "./FlowerGenerator.js";

export { FlowerGenerator } from "./FlowerGenerator.js";
