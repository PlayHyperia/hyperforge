/**
 * World Types
 * All world-related type definitions including world generation, zones, biomes, areas, and chunks
 */

import * as THREE from "../../extras/three/three";
import type { Position3D } from "../core/base-types";
import type { BiomeType } from "../../systems/shared/world/TerrainBiomeTypes";

// Temporary imports from core.ts - will be updated when those modules are created
import type { MobData } from "../core/core";
import type { InventoryItem } from "../core/core";

// ============== BASIC WORLD STRUCTURES ==============

/**
 * World position - basic position type for world coordinates
 */
export interface WorldPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * Town data structure
 * Represents a safe zone town with services
 */
export interface Town {
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
  safeZoneRadius: number;
  hasBank: boolean;
  hasStore: boolean;
  isRespawnPoint: boolean;
}

// ============== WORLD INITIALIZATION ==============

/**
 * World initialization configuration interface
 * Used to configure terrain, biomes, and structures when creating a new world
 */
export interface WorldInitConfig {
  seed?: number;
  config?: {
    terrain?: Record<
      string,
      {
        enabled?: boolean;
        scale?: number;
        octaves?: number;
        persistence?: number;
        lacunarity?: number;
        amplitude?: number;
        [key: string]: unknown;
      }
    >;
    biomes?: Record<
      string,
      {
        enabled?: boolean;
        temperature?: number;
        humidity?: number;
        elevation?: number;
        resources?: string[];
        [key: string]: unknown;
      }
    >;
    structures?: Record<
      string,
      {
        enabled?: boolean;
        frequency?: number;
        minDistance?: number;
        maxDistance?: number;
        [key: string]: unknown;
      }
    >;
  };
}

// ============== VEGETATION SYSTEM TYPES ==============
// (Defined before BiomeData since BiomeData references these types)

/**
 * Vegetation category type - defines the type of vegetation
 */
export type VegetationCategory =
  | "tree"
  | "bush"
  | "grass"
  | "flower"
  | "fern"
  | "rock"
  | "plant"
  | "fallen_tree"
  | "mushroom"
  | "ivy";

/**
 * LOD (Level of Detail) configuration for vegetation assets
 * Controls when to switch between detail levels and imposters
 */
export interface VegetationLODConfig {
  /**
   * Distance at which LOD1 (low poly) is used instead of LOD0 (full detail)
   * Only applies if lod1Model is specified
   */
  lod1Distance?: number;
  /**
   * Distance at which imposter (billboard) replaces 3D mesh
   * Defaults vary by category: trees ~200m, bushes ~120m, small objects ~60m
   */
  imposterDistance?: number;
  /**
   * Distance at which vegetation completely fades out
   * Should be > imposterDistance for smooth transition
   */
  fadeDistance?: number;
}

/**
 * Single vegetation asset model definition
 * Each asset represents a GLB model that can be instanced
 *
 * **LOD System (2-level + imposter):**
 * - LOD0: Full detail model (close range) - uses `model` path
 * - LOD1: Low-poly model (medium range) - uses `lod1Model` path (optional)
 * - LOD2: Very low-poly model (far range) - uses `lod2Model` path (optional)
 * - Imposter: Billboard (far range) - auto-generated from model
 *
 * **Vertex Budget Guidelines:**
 * - Large objects (trees): LOD0 ~5000 verts, LOD1 ~500 verts
 * - Medium objects (bushes): LOD0 ~1000 verts, LOD1 ~200 verts
 * - Small objects (mushrooms, flowers <0.3m): 100-200 verts max (no LOD1 needed)
 */
export interface VegetationAsset {
  /** Unique identifier for this asset */
  id: string;
  /** Path to the GLB model file (relative to assets folder) - LOD0 (full detail) */
  model: string;
  /**
   * Path to low-poly GLB model for LOD1 (optional)
   * If not provided, the full model is used until imposter distance
   * Recommended for trees and large vegetation to improve mid-range performance
   */
  lod1Model?: string;
  /**
   * Path to very low-poly GLB model for LOD2 (optional)
   * If not provided, vegetation transitions from LOD1 (or LOD0) to imposter.
   */
  lod2Model?: string;
  /** Category of vegetation this asset belongs to */
  category: VegetationCategory;
  /** Base scale of the model (1.0 = original size) */
  baseScale: number;
  /** Random scale variation range [min, max] applied as multiplier */
  scaleVariation: [number, number];
  /** Whether the asset can have random Y-axis rotation */
  randomRotation: boolean;
  /** Probability weight for this asset when selecting from category (higher = more common) */
  weight: number;
  /** Minimum slope this can be placed on (0-1, 0 = flat only) */
  minSlope?: number;
  /** Maximum slope this can be placed on (0-1, 1 = any slope) */
  maxSlope?: number;
  /** Whether to align to terrain normal (tilt with ground) */
  alignToNormal?: boolean;
  /** Y offset to apply after placement (for buried objects, etc.) */
  yOffset?: number;
  /** LOD configuration (optional - uses category defaults if not specified) */
  lod?: VegetationLODConfig;
}

/**
 * Vegetation layer configuration for a biome
 * Each layer defines how a category of vegetation is distributed
 */
export interface VegetationLayer {
  /** Category of vegetation for this layer */
  category: VegetationCategory;
  /** Density of instances per 100x100m tile (approximate) */
  density: number;
  /** Asset IDs to use for this layer (references VegetationAsset.id) */
  assets: string[];
  /** Minimum distance between instances of this category */
  minSpacing: number;
  /** Whether to cluster instances (creates natural groupings) */
  clustering?: boolean;
  /** Cluster size if clustering is enabled */
  clusterSize?: number;
  /** Noise scale for distribution (higher = larger patterns) */
  noiseScale?: number;
  /** Noise threshold (0-1, instances only placed where noise > threshold) */
  noiseThreshold?: number;
  /** Minimum height this layer spawns at */
  minHeight?: number;
  /** Maximum height this layer spawns at */
  maxHeight?: number;
  /** Whether to avoid water areas */
  avoidWater?: boolean;
  /** Whether to avoid steep slopes */
  avoidSteepSlopes?: boolean;
}

/**
 * Complete vegetation configuration for a biome
 * Defines all vegetation layers and their assets for procedural placement
 */
export interface BiomeVegetationConfig {
  /** Whether vegetation is enabled for this biome */
  enabled: boolean;
  /** All vegetation layers for this biome */
  layers: VegetationLayer[];
}

// ============== GRASS SYSTEM TYPES ==============

/**
 * Grass rendering configuration for a biome.
 * Controls procedural grass density, color, and appearance per biome.
 */
export interface BiomeGrassConfig {
  /** Whether grass is enabled for this biome */
  enabled: boolean;
  /** Density multiplier (1.0 = normal, 0.5 = half density, 2.0 = double) */
  densityMultiplier: number;
  /** Optional color tint applied to grass (hex color) */
  colorTint?: number;
  /** Height multiplier (1.0 = normal, 0.5 = short grass, 1.5 = tall grass) */
  heightMultiplier?: number;
  /** Wind responsiveness multiplier (1.0 = normal, 0.5 = stiff, 2.0 = very bendy) */
  windMultiplier?: number;
}

// ============== BIOME TYPES ==============

/**
 * Distribution weight for a resource type within a biome.
 * Keys are resource IDs (from woodcutting.json/mining.json), values are spawn weights.
 * Higher weight = more likely to spawn relative to other resources.
 */
export interface ResourceDistribution {
  [resourceId: string]: number;
}

/**
 * Configuration for harvestable tree spawning in a biome.
 * Controls which tree types spawn and at what density.
 */
export interface BiomeTreeConfig {
  /** Whether harvestable trees are enabled for this biome */
  enabled: boolean;
  /** Per-tree spawn weight + placement rules, keyed by TreeId */
  trees: Record<string, import("../../constants/TreeTypes").TreeSpawnConfig>;
  /** Target tree count per terrain tile (100m). Actual count depends on terrain filters and Poisson disk packing. */
  density: number;
  /** Minimum spacing between trees in meters */
  minSpacing: number;
  /** Whether trees should cluster together */
  clustering: boolean;
  /** Whether snow-capable trees in this biome receive snow coverage */
  enableSnow?: boolean;
  /** Average number of trees per cluster (default: 4) */
  clusterSize?: number;
  /** Radius of each cluster in meters (default: clusterSize * minSpacing) */
  clusterRadius?: number;
  /** Minimum distance between cluster centers in meters (default: clusterRadius * 2) */
  clusterSpacing?: number;
  /** Scale variation range [min, max] multiplier (default: [0.8, 1.2]) */
  scaleVariation?: [number, number];
  /** Maximum terrain slope for tree placement (gradient magnitude, default: 1.5) */
  maxSlope?: number;
}

/**
 * Configuration for ore spawning in a biome.
 * Controls which ore types spawn and at what density.
 */
export interface BiomeOreConfig {
  /** Whether ore spawning is enabled for this biome */
  enabled: boolean;
  /** Distribution weights for ore types (IDs from mining.json) */
  distribution: ResourceDistribution;
  /** Ores per 64m tile (base density) */
  density: number;
  /** Minimum spacing between ore nodes in meters */
  minSpacing: number;
  /** Whether ores should form veins (clusters) */
  veins: boolean;
  /** Vein size if veins is enabled */
  veinSize?: number;
  /** Scale variation range [min, max] multiplier (default: [0.9, 1.1]) */
  scaleVariation?: [number, number];
}

/**
 * Configuration for decorative rock spawning in a biome.
 * These are non-harvestable environmental rocks for visual variety.
 * Uses procedural generation from @hyperforge/procgen/rock.
 */
export interface BiomeRockConfig {
  /** Whether decorative rocks are enabled for this biome */
  enabled: boolean;
  /** Rocks per 100m² (density multiplier) */
  density: number;
  /**
   * Rock preset names from @hyperforge/procgen/rock.
   * Available presets:
   * - Shape: boulder, pebble, crystal, asteroid, cliff, lowpoly
   * - Geology: sandstone, limestone, granite, marble, basalt, slate, obsidian, quartzite
   */
  presets: string[];
  /** Distribution weights for each preset (higher = more common) */
  distribution?: Record<string, number>;
  /** Scale range [min, max] multiplier (default: [0.2, 0.9] for realistic ground rocks) */
  scaleRange: [number, number];
  /** Chance (0-1) for rocks to cluster together (default: 0.3) */
  clusterChance: number;
  /** Number of rocks per cluster (default: 3-6) */
  clusterSize?: [number, number];
  /** Minimum slope (0-1) where rocks prefer to spawn (rocks like slopes) */
  minSlope?: number;
  /** Maximum slope (0-1) for rock placement */
  maxSlope?: number;
  /** Minimum spacing between rocks in meters */
  minSpacing: number;
}

/**
 * Configuration for decorative plant spawning in a biome.
 * These are non-harvestable environmental plants for visual variety.
 * Uses procedural generation from @hyperforge/procgen/plant.
 */
export interface BiomePlantConfig {
  /** Whether decorative plants are enabled for this biome */
  enabled: boolean;
  /** Plants per 100m² (density multiplier) */
  density: number;
  /**
   * Plant preset names from @hyperforge/procgen/plant.
   * Common presets: fern, monstera, pothos, calathea, philodendron,
   * snakePlant, peperomia, prayer, croton, dracaena, etc.
   */
  presets: string[];
  /** Distribution weights for each preset (higher = more common) */
  distribution?: Record<string, number>;
  /** Scale range [min, max] multiplier (default: [0.5, 1.2]) */
  scaleRange: [number, number];
  /** Minimum spacing between plants in meters */
  minSpacing: number;
  /** Maximum slope (0-1) for plant placement (plants don't like steep slopes) */
  maxSlope?: number;
  /** Whether plants should cluster in small groups */
  clustering?: boolean;
  /** Cluster size if clustering is enabled */
  clusterSize?: [number, number];
}

/**
 * Biome data - defines characteristics of a biome type
 */
export interface BiomeData {
  id: string;
  name: string;
  description: string;
  difficultyLevel: 0 | 1 | 2 | 3; // 0 = safe zones, 1-3 = mob levels
  terrain: BiomeType;
  resources: string[]; // Available resource types
  mobs: string[]; // Mob types that spawn here
  fogIntensity: number; // 0-1 for visual atmosphere
  ambientSound: string;
  colorScheme: {
    primary: string;
    secondary: string;
    fog: string;
  };
  color: number; // Hex color for terrain rendering
  heightRange: [number, number]; // Min and max height multipliers
  terrainMultiplier: number; // Terrain height multiplier
  waterLevel: number; // Water level threshold
  maxSlope: number; // Maximum walkable slope
  mobTypes: string[]; // Mob types that spawn here
  difficulty: number; // Difficulty level (0-3)
  baseHeight: number; // Base terrain height
  heightVariation: number; // Height variation factor
  resourceDensity: number; // Resource spawn density
  resourceTypes: string[]; // Types of resources that can spawn
  /** Vegetation configuration for procedural placement (optional) */
  vegetation?: BiomeVegetationConfig;
  /** Grass rendering configuration (optional) */
  grass?: BiomeGrassConfig;
  /** Harvestable tree configuration for procedural spawning (optional) */
  trees?: BiomeTreeConfig;
  /** Ore node configuration for procedural spawning (optional) */
  ores?: BiomeOreConfig;
  /** Decorative rock configuration for procedural spawning (optional) */
  rocks?: BiomeRockConfig;
  /** Decorative plant configuration for procedural spawning (optional) */
  plants?: BiomePlantConfig;
}

/**
 * Biome resource - resource spawn location in a biome
 */
export interface BiomeResource {
  type: "tree" | "fishing_spot" | "mine" | "herb_patch";
  position: WorldPosition;
  resourceId: string;
  /** Optional durable existing identity for an authored tree; layout changes require restart. */
  instanceId?: string;
  respawnTime: number;
  level: number; // Required level to harvest
}

// ============== NPC AND MOB LOCATIONS ==============

/**
 * NPC location - where NPCs spawn in the world
 * Only id, type, and position are required - all other data comes from npcs.json manifest
 */
export interface NPCLocation {
  id: string; // Must match ID in npcs.json
  type:
    | "bank"
    | "general_store"
    | "skill_trainer"
    | "quest_giver"
    | "armor_store"
    | "crafting_store"
    | "magic_store"
    | "range_store"
    | "tanner";
  position: WorldPosition;
  // The following are optional - data should come from npcs.json manifest
  name?: string;
  services?: string[];
  modelPath?: string;
  description?: string;
  storeId?: string; // Links any store-capable NPC to its exact stores.json identity
}

/**
 * Mob spawn point - where mobs spawn in the world
 */
export interface MobSpawnPoint {
  mobId: string;
  position: WorldPosition;
  spawnRadius: number;
  maxCount: number;
  respawnTime: number;
}

/**
 * Station placement in a world area
 * Position only - full data comes from stations.json manifest
 */
export interface StationLocation {
  /** Unique instance ID for this station */
  id: string;
  /** Station type - must match type in stations.json */
  type: "bank" | "furnace" | "anvil" | "altar" | "range" | "runecrafting_altar";
  /** World position (Y will be grounded to terrain) */
  position: WorldPosition;
  /** Optional rotation in degrees (Y-axis only, default: 0) */
  rotation?: number;
  /** Optional: override bankId for bank stations (default: "spawn_bank") */
  bankId?: string;
}

// ============== WORLD AREAS ==============

/**
 * World area - a region of the world with specific characteristics
 */
export interface WorldArea {
  id: string;
  name: string;
  description: string;
  difficultyLevel: 0 | 1 | 2 | 3; // 0 = safe zone, 1-3 = combat zones
  bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  biomeType: string;
  safeZone: boolean;
  /** PvP enabled - players can attack each other in this zone */
  pvpEnabled?: boolean;
  /** Marks a bounded area as part of the autonomous duel-preparation loop. */
  agentPreparationArea?: boolean;
  /**
   * Explicit death-custody contract for a preparation area. Unsupported or
   * contradictory policies fail closed instead of falling through to public
   * wilderness drops.
   */
  deathCustodyPolicy?: {
    version: 1;
    mode: "private_grave" | "no_loss" | "public_risk";
    approvalStatus: "diagnostic_only" | "approved";
    keptItemCount: number;
    ownerProtectionTicks: number | null;
    publicTransitionTicks: number | null;
    terminalExpirationTicks: number | null;
    spectatorCopyKey: string;
    approvalId?: string;
    approvedAt?: string;
  };
  npcs: NPCLocation[];
  resources: BiomeResource[];
  mobSpawns: MobSpawnPoint[];
  /**
   * Dynamic fishing spot configuration.
   * When enabled, fishing spots are spawned at detected shore positions
   * instead of using static coordinates from resources array.
   */
  fishing?: {
    /** Enable dynamic fishing spot spawning for this area */
    enabled: boolean;
    /** Number of fishing spots to spawn in this area */
    spotCount: number;
    /** Resource IDs to spawn (e.g., "fishing_spot_net", "fishing_spot_bait") */
    spotTypes: string[];
  };
  /** Station placements for this area (furnaces, anvils, banks, altars, ranges) */
  stations?: StationLocation[];
  /** Flat zones for terrain flattening (e.g., arena floors) */
  flatZones?: Array<{
    id: string;
    centerX: number;
    centerZ: number;
    width: number;
    depth: number;
    height?: number;
    heightOffset?: number;
    blendRadius: number;
    /** Defaults to true; terrain shaping and grass exclusion are independent. */
    excludeGrass?: boolean;
    radialPond?: {
      bedRadius: number;
      bankInnerRadius: number;
      bankOuterRadius: number;
      bankHeight: number;
      shorelineAmplitude?: number;
    };
  }>;
  /** Explicit elevated water bodies used for compact ponds and lakes. */
  waterBodies?: Array<{
    id: string;
    centerX: number;
    centerZ: number;
    radius: number;
    surfaceY: number;
  }>;
  /** Sub-zones within this area (e.g., lobby, hospital, arenas) */
  subZones?: Record<
    string,
    {
      name: string;
      bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
      safeZone: boolean;
      spawnPoint?: { x: number; y: number; z: number };
      duelOnly?: boolean;
      arenaCount?: number;
      arenaLayout?: string;
      arenaSize?: { width: number; length: number };
      arenaGap?: number;
      /** `alongLength` (default): spawns ±Z. `alongWidth`: spawns ±X (east/west). */
      spawnLayout?: "alongLength" | "alongWidth";
    }
  >;
}

// ============== ZONE SPAWN POINTS ==============

/**
 * Player spawn point data
 */
export interface PlayerSpawnPointData {
  isMainSpawn: boolean;
}

/**
 * Resource spawn point data
 */
export interface ResourceSpawnPointData {
  type: string; // Can be 'bank', 'general_store', 'tree', 'trees', 'fishing_spot', 'mine', etc.
  name: string;
  resourceId: string;
  respawnTime: number;
}

/**
 * Mob spawn point data
 */
export interface MobSpawnPointData {
  type: string; // Can be mob type like 'goblin', 'bandit', etc.
  mobId: string;
  spawnRadius: number;
  maxCount: number;
  respawnTime: number;
}

/**
 * Zone spawn point data - union type for all spawn point types
 */
export type ZoneSpawnPointData =
  PlayerSpawnPointData | ResourceSpawnPointData | MobSpawnPointData;

/**
 * Zone spawn point - a spawn point in a zone
 */
export interface ZoneSpawnPoint {
  type: "player" | "mob" | "resource";
  position: Position3D;
  data: PlayerSpawnPointData | ResourceSpawnPointData | MobSpawnPointData;
}

// ============== ZONE DATA ==============

/**
 * Zone data - a defined area in the world with spawn points
 */
export interface ZoneData {
  id: string;
  name: string;
  biome: string;
  bounds: {
    x: number;
    z: number;
    width: number;
    height: number;
  };
  difficultyLevel: 0 | 1 | 2 | 3;
  isTown: boolean;
  hasBank: boolean;
  hasGeneralStore: boolean;
  spawnPoints: ZoneSpawnPoint[];
}

// ============== WORLD CONTENT ENTITIES ==============

/**
 * NPC entity - runtime instance of an NPC in the world
 */
export interface NPCEntity {
  id: string;
  npc: NPCLocation;
  mesh: THREE.Object3D;
  area: WorldArea;
}

/**
 * Resource entity - runtime instance of a resource in the world
 */
export interface ResourceEntity {
  id: string;
  resource: BiomeResource;
  mesh?: THREE.Object3D;
  instanceId?: number;
  meshType?: string;
  area: WorldArea;
  respawnTime: number;
  isActive: boolean;
}

/**
 * Mob entity - runtime instance of a mob in the world
 */
export interface MobEntity {
  id: string;
  mobData: MobData;
  mesh?: THREE.Object3D;
  instanceId?: number;
  meshType?: string;
  area: WorldArea;
  spawnPoint: MobSpawnPoint;
  currentHealth: number;
  lastRespawn: number;
  isAlive: boolean;
  homePosition: { x: number; y: number; z: number };
}

// ============== RESOURCE TYPES ==============

/**
 * Resource node data interface for world systems
 */
export interface ResourceNodeData {
  type: "tree" | "fishing_spot" | "ore_vein";
  position: Position3D;
  resourceType: string;
  id: string;
}

/**
 * Type for THREE.Mesh with properly typed userData for resources
 */
export interface ResourceMesh extends THREE.Mesh {
  userData: {
    entityId: string;
    type: "mob" | "npc" | "resource" | "item" | "player" | "static";
    name: string;
    interactable: boolean;
    mobData: {
      id: string;
      name: string;
      type: string;
      level: number;
      health: number;
      maxHealth: number;
    } | null;
    entityType: string;
    resourceType: string;
  };
}

// ============== WORLD CHUNKS ==============

/**
 * World chunk - a section of the world with runtime state
 */
export interface WorldChunk {
  id: string;
  chunkX: number;
  chunkZ: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  area: WorldArea;

  // Runtime state
  npcs: NPCEntity[];
  resources: ResourceEntity[];
  mobs: MobEntity[];
  terrainMesh?: THREE.Object3D;
  isLoaded: boolean;

  // Persistent state
  data: Record<string, unknown>;
  lastActivity: Date;
  playerCount: number;
  needsReset: boolean;

  // Chunk properties
  biome: string;
  heightData: number[];
  resourceStates: Record<string, boolean>;
  mobSpawnStates: Record<string, MobSpawnPoint>;
  playerModifications: Record<string, unknown>;
  chunkSeed: number;
  lastActiveTime: Date;
}

// ============== SPECIAL LOCATIONS ==============

/**
 * Death location data - where a player died and their items dropped
 */
export interface DeathLocationData {
  playerId: string;
  deathPosition: { x: number; y: number; z: number };
  timestamp: number;
  items: InventoryItem[]; // Items dropped at death location (headstone)
}

/**
 * Treasure location - treasure chest spawn locations
 */
export interface TreasureLocation {
  id: string;
  position: { x: number; y: number; z: number };
  difficulty: 1 | 2 | 3;
  areaId: string;
  description: string;
  respawnTime: number; // milliseconds
  maxItems: number;
}

// ============== VEGETATION RUNTIME TYPES ==============

/**
 * Runtime vegetation instance data
 * Used by VegetationSystem to track placed instances
 */
export interface VegetationInstance {
  /** Unique instance ID */
  id: string;
  /** Asset ID this instance uses */
  assetId: string;
  /** Category of vegetation */
  category: VegetationCategory;
  /** World position */
  position: { x: number; y: number; z: number };
  /** Rotation (Euler angles in radians) */
  rotation: { x: number; y: number; z: number };
  /** Scale multiplier */
  scale: number;
  /** Tile key this instance belongs to */
  tileKey: string;
  /** Matrix index in the InstancedMesh (runtime only) */
  matrixIndex?: number;
}

/**
 * Vegetation tile data for persistence
 * Stores vegetation state for a terrain tile
 */
export interface VegetationTileData {
  /** Tile key (format: "tileX_tileZ") */
  tileKey: string;
  /** Biome this tile belongs to */
  biome: string;
  /** All vegetation instances in this tile */
  instances: VegetationInstance[];
  /** Timestamp when this tile was generated */
  generatedAt: number;
  /** Seed used for procedural generation */
  seed: number;
}

// ============== PROCEDURAL TOWN TYPES ==============

/**
 * Town size category determines building count and services
 */
export type TownSize = "hamlet" | "village" | "town";

/**
 * Building types available in towns
 */
export type TownBuildingType =
  | "bank"
  | "store"
  | "anvil"
  | "house"
  | "well"
  | "inn"
  | "smithy"
  | "simple-house"
  | "long-house"
  | "church"
  | "cathedral"
  | "chapel"
  | "keep"
  | "fortress"
  | "castle"
  | "guild-hall"
  | "town-hall"
  | "mansion"
  | "manor";

/**
 * A building placed within a town
 */
export interface TownBuilding {
  /** Unique building ID */
  id: string;
  /** Type of building */
  type: TownBuildingType;
  /** World position of building center */
  position: { x: number; y: number; z: number };
  /** Y-axis rotation in radians */
  rotation: number;
  /** Building footprint size */
  size: { width: number; depth: number };
  /** Entrance position (calculated from building center + rotation) */
  entrance?: { x: number; z: number };
}

/**
 * Town layout type - how roads pass through the town
 */
export type TownLayoutType =
  | "terminus" // Single road ends here (dead end)
  | "throughway" // Single road passes through (2 entry points opposite)
  | "fork" // Road forks into two (3 entry points, Y-shape)
  | "crossroads"; // Two roads cross (4 entry points, X-shape)

/**
 * Entry point where a road enters the town
 */
export interface TownEntryPoint {
  /** Direction angle in radians (0 = +X, PI/2 = +Z) */
  angle: number;
  /** Position at the edge of the safe zone */
  position: { x: number; z: number };
  /** Connected road ID (set after road generation) */
  roadId?: string;
}

/**
 * Internal road segment within a town
 */
export interface TownInternalRoad {
  /** Start position (world coordinates) */
  start: { x: number; z: number };
  /** End position (world coordinates) */
  end: { x: number; z: number };
  /** Whether this is the main street */
  isMain: boolean;
}

/**
 * Walkway path from road to building entrance
 */
export interface TownPath {
  /** Start position - connection point on road edge */
  start: { x: number; z: number };
  /** End position - building entrance */
  end: { x: number; z: number };
  /** Path width in meters (typically 1-2m) */
  width: number;
  /** ID of building this path leads to */
  buildingId: string;
}

/**
 * Types of landmarks that can appear in towns
 */
export type TownLandmarkType =
  | "well" // Central water source
  | "fountain" // Decorative fountain (larger towns)
  | "market_stall" // Trading booth
  | "signpost" // Direction sign at entrances
  | "building_sign" // Hanging sign on building facade (clickable)
  | "bench" // Seating
  | "barrel" // Storage decoration
  | "crate" // Cargo decoration
  | "lamppost" // Street lighting
  | "tree" // Decorative tree
  | "planter" // Flower planter
  | "fence_post" // Fence post at lot boundaries
  | "fence_gate"; // Gate in fence (at building entrances)

/**
 * Landmark/decoration placed in the town
 */
export interface TownLandmark {
  /** Unique landmark ID */
  id: string;
  /** Type of landmark */
  type: TownLandmarkType;
  /** World position */
  position: { x: number; y: number; z: number };
  /** Y-axis rotation in radians */
  rotation: number;
  /** Size in meters */
  size: { width: number; depth: number; height: number };
  /** Optional metadata for specific landmark types */
  metadata?: TownLandmarkMetadata;
}

/**
 * Metadata for specific landmark types
 */
export interface TownLandmarkMetadata {
  /** For signposts: destination town name */
  destination?: string;
  /** For signposts: destination town ID */
  destinationId?: string;
  /** For building signs: the building type (inn, bank, etc.) */
  buildingType?: string;
  /** For building signs: display name shown when clicked */
  buildingName?: string;
  /** For building signs: the building ID this sign belongs to */
  buildingId?: string;
  /** For fence posts: which building lot this belongs to */
  lotBuildingId?: string;
  /** For fence posts: corner index (0-3 for rectangular lots) */
  cornerIndex?: number;
}

/**
 * Central plaza/public square
 */
export interface TownPlaza {
  /** Center position (world coordinates) */
  position: { x: number; z: number };
  /** Radius of the plaza */
  radius: number;
  /** Shape of the plaza */
  shape: "circle" | "square" | "octagon";
  /** Surface material */
  material: "cobblestone" | "dirt" | "grass";
}

/**
 * Procedurally generated town data
 * Towns are safe zones with buildings and services
 */
export interface ProceduralTown {
  /** Unique town ID */
  id: string;
  /** Town name (generated from seed) */
  name: string;
  /** World position of town center */
  position: { x: number; y: number; z: number };
  /** Town size category */
  size: TownSize;
  /** Safe zone radius in meters */
  safeZoneRadius: number;
  /** Biome the town is located in */
  biome: string;
  /** Buildings placed in this town */
  buildings: TownBuilding[];
  /** Suitability score used for placement (higher = better location) */
  suitabilityScore: number;
  /** Connected road IDs */
  connectedRoads: string[];
  /** Town layout type (how roads pass through) */
  layoutType?: TownLayoutType;
  /** Entry points where roads enter the town */
  entryPoints?: TownEntryPoint[];
  /** Internal road segments within the town */
  internalRoads?: TownInternalRoad[];
  /** Walkway paths from roads to building entrances */
  paths?: TownPath[];
  /** Landmarks and decorations (wells, benches, etc.) */
  landmarks?: TownLandmark[];
  /** Central plaza/public square */
  plaza?: TownPlaza;
}

// ============== POINTS OF INTEREST (POI) TYPES ==============

/**
 * Point of Interest category - what type of destination this is
 */
export type POICategory =
  | "dungeon" // Cave, mine entrance, ruins
  | "shrine" // Small religious site, altar
  | "landmark" // Natural landmark (waterfall, ancient tree, rock formation)
  | "resource_area" // Mining area, lumber camp
  | "ruin" // Ancient structure, abandoned building
  | "camp" // Bandit camp, hunter camp
  | "crossing" // Bridge, ford, mountain pass
  | "waystation" // Rest stop along roads
  | "fishing_spot"; // Lakeside fishing location at water's edge

/**
 * Point of Interest - A destination that roads can connect to
 * POIs are smaller than towns but important enough to warrant road access
 */
export interface PointOfInterest {
  /** Unique POI ID */
  id: string;
  /** Display name */
  name: string;
  /** Category of POI */
  category: POICategory;
  /** World position */
  position: { x: number; y: number; z: number };
  /** Importance score (0-1) - higher = more likely to get road connection */
  importance: number;
  /** Radius of the POI area in meters */
  radius: number;
  /** Biome the POI is located in */
  biome: string;
  /** Connected road IDs */
  connectedRoads: string[];
  /** Entry point where road connects (computed) */
  entryPoint?: { x: number; z: number; angle: number };
  /** Associated world area ID (if any) */
  areaId?: string;
  /** Whether this POI is procedurally generated */
  procedural: boolean;
}

/**
 * POI generation configuration
 */
export interface POIConfig {
  /** Number of POIs to generate per category */
  countPerCategory: Partial<Record<POICategory, number>>;
  /** Minimum distance from towns */
  minDistanceFromTowns: number;
  /** Minimum distance between POIs */
  minPOISpacing: number;
  /** Maximum distance a road will extend to connect a POI */
  maxRoadExtensionDistance: number;
  /** Importance threshold for automatic road connection */
  importanceThresholdForRoad: number;
}

// ============== PROCEDURAL ROAD TYPES ==============

/**
 * A single point along a road path
 */
export interface RoadPathPoint {
  /** World X coordinate */
  x: number;
  /** World Z coordinate */
  z: number;
  /** Terrain height at this point (computed) */
  y: number;
}

/**
 * Road material type affects visual appearance
 */
export type RoadMaterial = "dirt" | "cobblestone" | "stone";

/**
 * Road endpoint type - what a road connects to
 */
export type RoadEndpointType = "town" | "poi";

/**
 * A road connection between two locations (towns and/or POIs)
 */
export interface ProceduralRoad {
  /** Unique road ID */
  id: string;
  /** Source endpoint type */
  fromType: RoadEndpointType;
  /** Source town ID (when fromType is 'town') */
  fromTownId: string;
  /** Source POI ID (when fromType is 'poi') */
  fromPOIId?: string;
  /** Destination endpoint type */
  toType: RoadEndpointType;
  /** Destination town ID (when toType is 'town') */
  toTownId: string;
  /** Destination POI ID (when toType is 'poi') */
  toPOIId?: string;
  /** Path points from source to destination */
  path: RoadPathPoint[];
  /** Road width in meters */
  width: number;
  /** Road material for visual rendering */
  material: RoadMaterial;
  /** Total road length in meters */
  length: number;
}

/**
 * A road segment within a single terrain tile
 * Used for efficient spatial queries during rendering
 */
export interface RoadTileSegment {
  /** Start point within tile (local coordinates) */
  start: { x: number; z: number };
  /** End point within tile (local coordinates) */
  end: { x: number; z: number };
  /** Road width */
  width: number;
  /** Parent road ID */
  roadId: string;
}

/**
 * Edge of a tile where a road exits
 */
export type TileEdge = "north" | "south" | "east" | "west";

/**
 * Represents a point where a road exits a tile boundary.
 * Used for cross-tile road continuity - adjacent tiles can pick up
 * these exit points to continue the road seamlessly.
 */
export interface RoadBoundaryExit {
  /** ID of the road that exits */
  roadId: string;
  /** Position where road crosses the boundary (world coordinates) */
  position: { x: number; z: number };
  /** Direction the road was heading when it hit the boundary (radians) */
  direction: number;
  /** Tile coordinates where the exit occurs */
  tileX: number;
  tileZ: number;
  /** Which edge of the tile the road exits through */
  edge: TileEdge;
}

/**
 * Complete procedural road network data
 */
export interface RoadNetwork {
  /** All towns in the network */
  towns: ProceduralTown[];
  /** All points of interest in the network */
  pois: PointOfInterest[];
  /** All roads connecting towns and POIs */
  roads: ProceduralRoad[];
  /** World seed used for generation */
  seed: number;
  /** Generation timestamp */
  generatedAt: number;
  /** Boundary exit points for cross-tile continuity */
  boundaryExits?: RoadBoundaryExit[];
}

// ============== WORLD CONFIG MANIFEST TYPES ==============

/**
 * Terrain configuration from world-config.json
 */
export interface TerrainConfigManifest {
  /** Size of each terrain tile in meters (default: 100) */
  tileSize: number;
  /** World grid size in tiles (default: 100 = 10km x 10km) */
  worldSize: number;
  /** Vertices per tile for mesh resolution (default: 64) */
  tileResolution: number;
  /** Maximum terrain height variation in meters (default: 30) */
  maxHeight: number;
  /** Height threshold below which water appears (default: 5.4) */
  waterThreshold: number;
  /** Scale multiplier for biome noise generation (default: 1.0) */
  biomeScale: number;
  /** Near fog distance in meters (default: 150) */
  fogNear: number;
  /** Far fog distance in meters (default: 350) */
  fogFar: number;
  /** Camera far plane distance in meters (default: 400) */
  cameraFar: number;
}

/**
 * Town size configuration
 */
export interface TownSizeConfigManifest {
  minBuildings: number;
  maxBuildings: number;
  radius: number;
  safeZoneRadius: number;
}

/**
 * Building type configuration
 */
export interface BuildingTypeConfigManifest {
  width: number;
  depth: number;
  priority: number;
}

/**
 * Town landmark generation configuration from world-config.json
 */
export interface TownLandmarkConfigManifest {
  /** Enable fences around building lots (villages and towns) */
  fencesEnabled: boolean;
  /** Probability of fence post at each valid corner (0-1) */
  fenceDensity: number;
  /** Fence post height in meters */
  fencePostHeight: number;
  /** Enable lampposts for villages (always enabled for towns) */
  lamppostsInVillages: boolean;
  /** Spacing between lampposts in meters */
  lamppostSpacing: number;
  /** Enable market stalls in town plazas */
  marketStallsEnabled: boolean;
  /** Enable decorative elements (barrels, crates, planters) */
  decorationsEnabled: boolean;
}

/**
 * Town generation configuration from world-config.json
 */
export interface TownConfigManifest {
  /** Number of towns to generate (default: 25) */
  townCount: number;
  /** Minimum spacing between towns in meters (default: 800) */
  minTownSpacing: number;
  /** Radius for flatness sampling (default: 40) */
  flatnessSampleRadius: number;
  /** Number of points to sample for flatness (default: 16) */
  flatnessSampleCount: number;
  /** Water threshold for town placement (default: 5.4) */
  waterThreshold: number;
  /** Minimum optimal distance from water (default: 30) */
  optimalWaterDistanceMin: number;
  /** Maximum optimal distance from water (default: 150) */
  optimalWaterDistanceMax: number;
  /** Configuration for each town size category */
  townSizes: {
    hamlet: TownSizeConfigManifest;
    village: TownSizeConfigManifest;
    town: TownSizeConfigManifest;
  };
  /** Configuration for each building type */
  buildingTypes: Record<string, BuildingTypeConfigManifest>;
  /** Landmark generation configuration */
  landmarks?: TownLandmarkConfigManifest;
  /** Biome suitability scores for town placement (0-1) */
  biomeSuitability: Record<string, number>;
}

/**
 * Road generation configuration from world-config.json
 */
export interface RoadConfigManifest {
  /** Road width in meters (default: 4) */
  roadWidth: number;
  /** Step size for A* pathfinding (default: 20) */
  pathStepSize: number;
  /** Maximum iterations for path search (default: 10000) */
  maxPathIterations: number;
  /** Ratio of extra connections beyond MST (default: 0.25) */
  extraConnectionsRatio: number;
  /** Chaikin smoothing iterations (default: 2) */
  smoothingIterations: number;
  /** Noise scale for path displacement (default: 0.01) */
  noiseDisplacementScale: number;
  /** Noise strength for path displacement (default: 3) */
  noiseDisplacementStrength: number;
  /** Minimum spacing between path points (default: 4) */
  minPointSpacing: number;
  /** Biome cost multipliers for pathfinding */
  costBiomeMultipliers: Record<string, number>;
  /** Base movement cost (default: 1.0) */
  costBase: number;
  /** Slope penalty multiplier (default: 5.0) */
  costSlopeMultiplier: number;
  /** Water crossing penalty (default: 1000) */
  costWaterPenalty: number;
  /** A* heuristic weight (default: 2.5) */
  heuristicWeight: number;
}

/**
 * POI generation configuration manifest
 */
export interface POIConfigManifest {
  /** Number of POIs to generate per category */
  countPerCategory: Partial<Record<POICategory, number>>;
  /** Minimum distance from towns in meters (default: 100) */
  minDistanceFromTowns: number;
  /** Minimum distance between POIs in meters (default: 200) */
  minPOISpacing: number;
  /** Maximum distance a road will extend to connect a POI (default: 500) */
  maxRoadExtensionDistance: number;
  /** Importance threshold for automatic road connection (default: 0.5) */
  importanceThresholdForRoad: number;
  /** Biome suitability for POI categories */
  biomeSuitability?: Partial<Record<POICategory, Record<string, number>>>;
}

/** Frozen functional tree anchor, admitted through centered terrain ownership. */
export interface CompactResourceGroveAnchor {
  /** Checked coordinate-derived identity; never forwarded as instanceId. */
  readonly id: string;
  readonly subType: "general" | "oak";
  readonly position: Readonly<{ x: number; y: number; z: number }>;
  readonly scale: number;
  readonly rotation: number;
}

interface CompactResourceGroveRegions {
  readonly regions: readonly {
    readonly id: "west-ridge-foot" | "southern-meadow" | "eastern-shoulder";
    readonly bounds: Readonly<{
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    }>;
    readonly anchors: readonly CompactResourceGroveAnchor[];
  }[];
}

/** Historical full-size layout and explicitly versioned grouped successor. */
export type CompactResourceGrovesManifest = CompactResourceGroveRegions &
  (
    | {
        readonly schemaVersion: 1;
        readonly layoutId: "compact-functional-groves-v1";
        readonly terrainProfileId:
          | "compact-duel-island-v4"
          | "compact-duel-island-v5"
          | "compact-duel-island-v6";
      }
    | {
        readonly schemaVersion: 2;
        readonly layoutId: "compact-functional-groves-v2";
        readonly terrainProfileId:
          "compact-duel-island-v5" | "compact-duel-island-v6";
      }
  );

/**
 * Exact, optional preparation lodge placement and immutable layout recipe.
 */
export interface CompactPreparationLodgeManifest {
  readonly schemaVersion: 1;
  readonly layoutId: "compact-preparation-lodge-v1";
  readonly terrainProfileId:
    | "compact-duel-island-v4"
    | "compact-duel-island-v5"
    | "compact-duel-island-v6";
  readonly position: Readonly<{ x: number; z: number }>;
  readonly rotation: number;
  readonly layoutSeed: "compact-bank-lodge01:360,318:8x8:south";
  readonly recipeId: "compact-bank-lodge01-v1";
}

/** Optional open architecture with terrain support, never an indoor/floor owner. */
export type CompactServiceCourtManifest = Readonly<{
  schemaVersion: 1;
  layoutId: "compact-service-court-v1";
  terrainProfileId: "compact-duel-island-v6";
  position: Readonly<{ x: 336.5; z: 337.5 }>;
  rotation: 0;
  recipeId: "open-timber-smithy-v1";
}>;

/** Complete configuration loaded from assets/manifests/world-config.json. */
export interface WorldConfigManifest {
  /** Manifest version for compatibility checking */
  version: number;
  /** Explicit, validated terrain identity consumed by every world height path. */
  terrainProfile?: import("../../systems/shared/world/WorldTerrainProfile").WorldTerrainProfile;
  /** Terrain generation configuration */
  terrain: TerrainConfigManifest;
  /** Town generation configuration */
  towns: TownConfigManifest;
  /** Road generation configuration */
  roads: RoadConfigManifest;
  /** POI generation configuration */
  pois?: POIConfigManifest;
  /** World seed for procedural generation */
  seed: number;
  /** Version-2 compact-only frozen functional trees, using normal tile ownership. */
  compactResourceGroves?: CompactResourceGrovesManifest;
  /** Optional, explicitly admitted preparation architecture; no town/NPC generation. */
  compactPreparationLodge?: CompactPreparationLodgeManifest;
  compactServiceCourt?: CompactServiceCourtManifest;
}

// ============== BUILDINGS MANIFEST TYPES ==============

/**
 * Size category for manifest-defined towns
 */
export type ManifestTownSize = "sm" | "md" | "lg";

/**
 * A building defined in the buildings manifest
 */
export interface ManifestBuilding {
  /** Unique building ID */
  id: string;
  /** Building type */
  type: TownBuildingType;
  /** Position relative to town center or absolute */
  position: { x: number; y: number; z: number };
  /** Y-axis rotation in radians */
  rotation: number;
  /** Building footprint size */
  size: { width: number; depth: number };
}

/**
 * A town defined in the buildings manifest
 */
export interface ManifestTown {
  /** Unique town ID */
  id: string;
  /** Town display name */
  name: string;
  /** World position of town center */
  position: { x: number; y: number; z: number };
  /** Town size category */
  size: ManifestTownSize;
  /** Whether this town should always be kept (not replaced by procedural generation) */
  keep: boolean;
  /** Safe zone radius in meters */
  safeZoneRadius: number;
  /** Buildings in this town */
  buildings: ManifestBuilding[];
}

/**
 * Building type definition in manifest
 */
export interface ManifestBuildingType {
  /** Display label */
  label: string;
  /** Width range [min, max] in tiles */
  widthRange: [number, number];
  /** Depth range [min, max] in tiles */
  depthRange: [number, number];
  /** Number of floors */
  floors: number;
  /** Whether building has a basement */
  hasBasement: boolean;
  /** Props/NPCs in this building type */
  props?: string[];
}

/**
 * Size definition in manifest
 */
export interface ManifestSizeDefinition {
  /** Display label */
  label: string;
  /** Minimum buildings for this size */
  minBuildings: number;
  /** Maximum buildings for this size */
  maxBuildings: number;
  /** Town radius in meters */
  radius: number;
  /** Safe zone radius in meters */
  safeZoneRadius: number;
}

/**
 * Complete buildings manifest
 * Loaded from assets/manifests/buildings.json
 */
export interface BuildingsManifest {
  /** Manifest version */
  version: number;
  /** Pre-defined towns with buildings */
  towns: ManifestTown[];
  /** Building type definitions */
  buildingTypes: Record<string, ManifestBuildingType>;
  /** Size category definitions */
  sizeDefinitions: Record<ManifestTownSize, ManifestSizeDefinition>;
}
