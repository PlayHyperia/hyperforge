/**
 * World Systems
 * Environment, terrain, sky, water, vegetation, towns, roads, POIs, and atmospheric effects
 */

export * from "./Environment";
export * from "./TerrainSystem";
export * from "./TerrainShader";
export * from "./SkySystem";
export * from "./WaterSystem";
export * from "./WaterBodyRegistry";
export * from "./Wind";
export * from "./VegetationSsboUtils";
export * from "./VegetationSystem";
export * from "./ProceduralGrass";
export * from "./ProceduralFlowers";
export * from "./ProceduralDocks";
export * from "./TownSystem";
export * from "./POISystem";
export * from "./RoadNetworkSystem";
export * from "./BuildingRenderingSystem";
export * from "./ProceduralTownLandmarks";
export * from "./BuildingCollisionService";
export * from "./GrassExclusionManager";
export * from "./ProcgenRockCache";
export * from "./ProcgenRockInstancer";
export * from "./ProcgenPlantCache";
export * from "./ProcgenPlantInstancer";
export * from "./ProcgenTreeCache";
export * from "./ProcgenTreeInstancer";
export {
  getGLBTreeRenderOwnership,
  type GLBTreeRenderOwnership,
} from "./GLBTreeInstancer";
export { getGLBTreeBatchedRenderOwnership } from "./GLBTreeBatchedInstancer";
export * from "./AtlasedTreeImpostors";

// Tree LOD System (consolidated tree baking and rendering)
export * from "./TreeLODSystem";
export * from "./TreeLODMaterials";
export * from "./TreeLODIntegration";
