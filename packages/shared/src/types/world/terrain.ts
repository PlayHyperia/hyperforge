/**
 * Terrain and resource-related type definitions
 *
 * These interfaces define terrain generation, resource spawning, and world tile management.
 * Common terrain types have been moved to core.ts to avoid duplication.
 */

import * as THREE from "../../extras/three/three";
import type { Position3D } from "../core/core";
import type { PMeshHandle } from "../../extras/three/geometryToPxMesh";
import type { BiomeType } from "../../systems/shared/world/TerrainBiomeTypes";
import type { ActorHandle } from "../systems/physics";
import type { TreeSubType as _TreeSubType } from "../../constants/TreeTypes";

// Terrain resource interfaces
/**
 * Tree subtypes that can spawn in the world.
 * Derived from the single source of truth in constants/TreeTypes.ts.
 */
export type TreeSubType = _TreeSubType;

/**
 * Ore subtypes that can spawn in the world.
 * These map to ore_<subtype> in mining.json manifest.
 */
export type OreSubType =
  "copper" | "tin" | "iron" | "coal" | "mithril" | "adamant" | "runite";

/**
 * Combined resource subtype for spawn points.
 */
export type ResourceSubType = TreeSubType | OreSubType;

export interface TerrainResourceSpawnPoint {
  position: Position3D;
  type: "tree" | "rock" | "ore" | "herb" | "fish" | "gem" | "rare_ore";
  /** Optional subtype for variant selection (e.g., "oak" for tree_oak, "copper" for ore_copper) */
  subType?: ResourceSubType;
  /** Scale multiplier for visual variation (default: 1.0) */
  scale?: number;
  /** Y-axis rotation in radians for visual variation */
  rotation?: number;
}

export interface TerrainTileData {
  tileId: string;
  position: { x: number; z: number };
  biome: BiomeType;
  tileX: number;
  tileZ: number;
  resources: TerrainResource[];
}

export interface TerrainResource {
  position: Position3D;
  type: "tree" | "rock" | "ore" | "herb" | "fish" | "gem" | "rare_ore";
  id: string;
}

// Terrain system interfaces
export interface TerrainTile {
  key: string;
  x: number;
  z: number;
  mesh: THREE.Mesh;
  collision: PMeshHandle | null;
  biome: BiomeType;
  resources: ResourceNode[];
  roads: RoadSegment[];
  waterMeshes: THREE.Mesh[];
  generated: boolean;
  /** Whether gameplay resources/entities were generated for this tile. */
  contentGenerated?: boolean;
  heightData: number[];
  lastActiveTime: Date;
  playerCount: number;
  needsSave: boolean;
  chunkSeed: number;
  heightMap: Float32Array;
  collider: ActorHandle | null;
  lastUpdate: number;
  /** Decorative rock instance IDs for cleanup when tile is unloaded */
  decorativeRockIds?: string[];
  /** Decorative plant instance IDs for cleanup when tile is unloaded */
  decorativePlantIds?: string[];
}

export interface ResourceNode {
  id: string;
  type: "tree" | "rock" | "ore" | "herb" | "fish" | "gem" | "rare_ore";
  /** Specific variant (e.g., "oak" for tree_oak, "copper" for ore_copper) */
  subType?: ResourceSubType;
  position: Position3D | THREE.Vector3;
  mesh?: THREE.Mesh | null; // For non-instanced meshes
  instanceId?: number | null;
  meshType?: string;
  health: number;
  maxHealth: number;
  respawnTime: number;
  harvestable: boolean;
  requiredLevel: number;
  /** Scale multiplier for visual variation (default: 1.0) */
  scale?: number;
  /** Y-axis rotation in radians for visual variation */
  rotation?: number;
}

export interface RoadSegment {
  start: THREE.Vector2 | { x: number; z: number };
  end: THREE.Vector2 | { x: number; z: number };
  width: number;
  mesh: THREE.Mesh | null;
  material: "stone" | "dirt" | "cobblestone";
  condition: number; // 0-100
}

// BiomeData moved to core.ts to avoid duplication

// ResourceNodeData and ResourceMesh moved to core.ts to avoid duplication

// ============================================================================
// TERRAIN FLATTENING
// ============================================================================

/**
 * A single tile coordinate for flat zone masking.
 */
export interface FlatZoneTile {
  /** Tile X coordinate (world tile coords, 1m per tile) */
  x: number;
  /** Tile Z coordinate (world tile coords, 1m per tile) */
  z: number;
}

/**
 * Inclusive tile bounds for quick rejection in tile-mask queries.
 */
export interface FlatZoneTileBounds {
  /** Minimum tile X (inclusive) */
  minX: number;
  /** Maximum tile X (inclusive) */
  maxX: number;
  /** Minimum tile Z (inclusive) */
  minZ: number;
  /** Maximum tile Z (inclusive) */
  maxZ: number;
}

/**
 * Smooth radial basin profile for an authored pond.
 * `FlatZone.height` is the bed height and `FlatZone.blendRadius` controls the
 * final transition from the level bank back to procedural terrain.
 */
export interface RadialPondTerrainProfile {
  /** Radius of the level underwater bed. */
  bedRadius: number;
  /** Radius where the rising shoreline reaches the level bank. */
  bankInnerRadius: number;
  /** Outer radius of the level bank. */
  bankOuterRadius: number;
  /** Height of the dry bank. */
  bankHeight: number;
}

/**
 * Defines an area where terrain should be flattened.
 * Used for stations, buildings, and other world objects that need level ground.
 *
 * When `tileMask` is provided, the core flat area uses the exact tile set
 * instead of a rectangular half-width/half-depth check. This supports
 * L-shaped and other non-rectangular building footprints.
 */
export interface FlatZone {
  /** Unique identifier (e.g., "station_furnace_town_1") */
  id: string;
  /** Center X position in world coordinates (meters) */
  centerX: number;
  /** Center Z position in world coordinates (meters) */
  centerZ: number;
  /** Width in meters (X axis) - used for rectangular zones and blend indexing */
  width: number;
  /** Depth in meters (Z axis) - used for rectangular zones and blend indexing */
  depth: number;
  /** Target height for the flat area (meters) */
  height: number;
  /** Blend radius for smooth transition to procedural terrain (meters) */
  blendRadius: number;
  /** Optional smooth radial pond basin instead of a rectangular flat zone. */
  radialPond?: RadialPondTerrainProfile;
  /**
   * Optional carve inset for removing terrain triangles in the flat zone core.
   * If provided, terrain will be carved inside the core area shrunk by this inset.
   * Use this for buildings to avoid terrain overdraw under volumes.
   */
  carveInset?: number;
  /**
   * Optional tile mask for non-rectangular flat zones (building footprints).
   * Keys use "tileX,tileZ" format (see building-collision-types tileKey).
   */
  tileMask?: Set<string>;
  /**
   * Optional tile list for blend distance queries.
   */
  tileMaskTiles?: FlatZoneTile[];
  /**
   * Optional bounds (inclusive) for quick tile-mask rejection.
   */
  tileMaskBounds?: FlatZoneTileBounds;
}

/**
 * Spatial index key for flat zone lookup.
 * Format: "tileX_tileZ" where tiles are terrain tiles (100m each).
 */
export type FlatZoneKey = `${number}_${number}`;

// ============================================================================
// QUAD-TREE LOD VISUAL CHUNKS
// ============================================================================

/**
 * A visual terrain chunk generated by the quad-tree LOD system.
 * These are client-only rendering primitives — gameplay logic uses TerrainTile.
 */
export interface TerrainVisualChunkData {
  /** Unique key (e.g., "quad_42_3_100_200") */
  key: string;
  /** Center X in world coordinates */
  centerX: number;
  /** Center Z in world coordinates */
  centerZ: number;
  /** World-space size of this chunk (varies by LOD depth) */
  size: number;
  /** Vertex resolution per axis (uniform across all depths) */
  resolution: number;
  /** Quad-tree depth (0 = root, maxDepth = leaf) */
  depth: number;
  /** Height data for the main grid (resolution × resolution) */
  heightData: Float32Array;
}
