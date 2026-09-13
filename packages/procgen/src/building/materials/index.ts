/**
 * Building Materials Module - TSL/WebGPU procedural materials
 */

export {
  createBuildingMaterial,
  createMaterialFromPreset,
  getMaterialConfigForBuildingType,
  BUILDING_MATERIAL_PRESETS,
  DEFAULT_MATERIAL_CONFIGS,
} from "./BuildingMaterialTSL";

export type {
  BuildingMaterialType,
  BuildingMaterialConfig,
  BuildingMaterialPreset,
  TSLBuildingMaterial,
} from "./BuildingMaterialTSL";

export {
  HAVEN_ARCHITECTURAL_ROOF_CONFIG,
  createHavenLocalMetricUV,
} from "./HavenArchitecturalSurface";

// Window Glass Material - Dithered transparency
export {
  createWindowGlassMaterial,
  createGlassFromPreset,
  getGlassPresetForBuildingType,
  WINDOW_GLASS_PRESETS,
} from "./WindowGlassMaterialTSL";

export type {
  WindowGlassConfig,
  WindowGlassPreset,
  TSLWindowGlassMaterial,
} from "./WindowGlassMaterialTSL";
