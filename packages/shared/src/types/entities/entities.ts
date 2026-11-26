/**
 * Entity-specific type definitions for the system
 * These types are shared across all entity implementations
 */

import type * as THREE from "../../extras/three/three";
import type { EntityData, Position3D, Quaternion } from "../core/base-types";
import type {
  EquipmentComponent,
  InventoryComponent,
  InventoryItem,
  Item,
  MovementComponent,
  NPCComponent,
  PlayerHealth,
  PlayerStamina,
  PrayerComponent,
  StatsComponent,
} from "../core";
import type {
  ResourceFootprint,
  FootprintSpec,
} from "../game/resource-processing-types";
import type { TileCoord } from "../../systems/shared/movement/TileSystem";

// Enums for better type safety instead of string literals
export enum EntityType {
  PLAYER = "player",
  MOB = "mob",
  ITEM = "item",
  NPC = "npc",
  RESOURCE = "resource",
  HEADSTONE = "headstone",
  STATIC = "static",
  BANK = "bank",
  FIRE = "fire",
  RANGE = "range",
  FURNACE = "furnace",
  ANVIL = "anvil",
  ALTAR = "altar",
  RUNECRAFTING_ALTAR = "runecrafting_altar",
  STARTER_CHEST = "starter_chest",
}

export enum InteractionType {
  ATTACK = "attack",
  PICKUP = "pickup",
  TALK = "talk",
  GATHER = "gather",
  HARVEST = "harvest",
  USE = "use",
  LOOT = "loot",
  BANK = "bank",
  TRADE = "trade",
  TRAIN = "train",
  QUEST = "quest",
  COOKING = "cooking",
  FIREMAKING = "firemaking",
  SMELTING = "smelting",
  SMITHING = "smithing",
  ALTAR = "altar",
  RUNECRAFTING = "runecrafting",
}

export enum PlayerCombatStyle {
  ATTACK = "attack",
  STRENGTH = "strength",
  DEFENSE = "defense",
  RANGED = "ranged",
}

// Mob types are now fully data-driven from mobs.json
// No enum needed - use string type with mob IDs from JSON

/**
 * Unified Mob AI State enum.
 * Short-form values for runtime use. Canonical definition — all AI state references should use this.
 */
export enum MobAIState {
  IDLE = "idle",
  WANDER = "wander",
  CHASE = "chase",
  ATTACK = "attack",
  COMBAT = "combat",
  RETURN = "return",
  FLEE = "flee",
  DEAD = "dead",
}

export enum NPCType {
  BANK = "bank",
  STORE = "store",
  QUEST_GIVER = "quest_giver",
  TRAINER = "trainer",
  HEALER = "healer",
  SCOREBOARD = "scoreboard",
  GUIDE = "guide",
}

export enum ResourceType {
  TREE = "tree",
  FISHING_SPOT = "fishing_spot",
  MINING_ROCK = "mining_rock",
}

export enum ItemRarity {
  ALWAYS = "always",
  COMMON = "common",
  UNCOMMON = "uncommon",
  RARE = "rare",
  EPIC = "epic",
  LEGENDARY = "legendary",
}

// Re-export for convenience
export type { Item, Position3D };

// Base Entity configuration - generic with strongly typed properties
export interface EntityConfig<TProperties = BaseEntityProperties> {
  id: string;
  name: string;
  type: EntityType;
  position: Position3D;
  rotation: Quaternion;
  scale: Position3D;
  visible: boolean;
  interactable: boolean;
  interactionType: InteractionType | null;
  interactionDistance: number;
  description: string;
  model: string | null; // GLB/VRM model URL
  properties: TProperties; // Strongly typed entity-specific data
}

// Entity interaction data interface
export interface EntityInteractionData {
  playerId: string;
  entityId: string;
  interactionType: string;
  position: Position3D;
  playerPosition: Position3D;
}

// Base entity data interfaces
export interface BaseEntityData extends EntityData {
  id: string;
  type: string;
  name: string;
  level: number;
  health: number;
  maxHealth: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

/**
 * Death state enum for player death system
 * Single source of truth - synced via entity data
 */
export enum DeathState {
  ALIVE = "alive",
  DYING = "dying", // Playing death animation, position frozen
  DEAD = "dead", // Brief state for gravestone spawn
}

// Player entity data
export interface PlayerEntityData extends BaseEntityData {
  playerId: string;
  playerName: string;
  /** Server-owned AI player, retained through PlayerEntity serialization. */
  isAgent?: boolean;
  /** AI player whose runtime is embedded in the authoritative server. */
  isEmbeddedAgent?: boolean;
  level: number;
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  combatStyle: PlayerCombatStyle;
  equipment: Record<string, Item | null>;
  inventory: Item[];
  skills: Record<string, { level: number; xp: number }>;
  // Death state - synced to all clients automatically via entityModified
  deathState?: DeathState;
  deathPosition?: [number, number, number]; // Frozen position during death animation
  respawnTick?: number; // Tick when respawn should occur
}

// Bank entity data
export interface BankEntityData extends BaseEntityData {
  bankId: string;
  townId: string;
  capacity: number;
  interactionDistance: number;
}

// Item entity config
export interface ItemEntityConfig extends EntityConfig<ItemEntityProperties> {
  type: EntityType.ITEM;
  itemType: string;
  itemId: string;
  quantity: number;
  stackable: boolean;
  value: number;
  weight: number;
  rarity: ItemRarity;
  requirements: Record<string, number>;
  effects: Array<{ type: string; value: number; duration: number }>;
  armorSlot: string | null;
  // Additional properties needed for Item compatibility
  examine?: string;
  modelPath?: string;
  iconPath?: string;
  healAmount?: number;
  // Ground item display overrides
  modelScale?: number;
  groundOffset?: number;
}

// Mob entity config
export interface MobEntityConfig extends EntityConfig<MobEntityProperties> {
  type: EntityType.MOB;
  mobType: string; // Mob ID from mobs.json (e.g., 'goblin', 'bandit')
  level: number;
  maxHealth: number;
  currentHealth: number;
  attack: number; // Attack level for accuracy calculations (classic MMORPG-style)
  attackPower: number; // Strength-based, determines max hit
  defense: number;
  defenseBonus: number; // Equipment/armor defense bonus
  attackSpeedTicks: number;
  moveSpeed: number;
  aggressive: boolean; // If true, mob attacks players on sight; if false, only retaliates
  retaliates: boolean; // If true, mob fights back when attacked; if false, mob is peaceful
  attackable: boolean; // If true, players can attack this mob; if false, mob cannot be targeted
  movementType: "stationary" | "wander" | "patrol"; // Controls idle movement behavior
  aggroRange: number;
  combatRange: number;
  wanderRadius: number; // Fixed distance from spawn point (classic fantasy MMORPG-style)
  leashRange?: number; // Max chase distance from spawn (defaults to 10, classic MMORPG-style two-tier range)
  respawnTime: number;
  xpReward: number;
  lootTable: Array<{
    itemId: string;
    chance: number;
    minQuantity: number;
    maxQuantity: number;
  }>;
  spawnPoint: Position3D;
  aiState: MobAIState;
  targetPlayerId: string | null;
  lastAttackTime: number;
  deathTime: number | null;

  /** Attack type: melee (default), ranged, or magic */
  attackType?: "melee" | "ranged" | "magic";
  /** Spell ID for magic mobs (e.g., "wind_strike") */
  spellId?: string;
  /** Arrow ID for ranged mobs (e.g., "bronze_arrow") */
  arrowId?: string;

  /**
   * If true, this NPC walks through other NPCs (classic MMORPG boss behavior)
   *
   * Used for: GWD generals, Dagannoth Kings, raid bosses, etc.
   * When true, the NPC's tiles don't block other entities from moving.
   *
   * NPC size is determined by getNPCSize(mobType) in LargeNPCSupport.ts
   * Boss sizes are pre-defined: goblin=1x1, general_graardor=2x2, etc.
   *
   * @default false
   * @see NPC_ENTITY_COLLISION_PLAN.md
   */
  ignoresEntityCollision?: boolean;
}

// NPC entity config
export interface NPCEntityConfig extends EntityConfig<NPCEntityProperties> {
  npcType: NPCType;
  npcId: string;
  /** Exact stores.json identity for store-capable NPCs. */
  storeId?: string;
  dialogueLines: string[];
  services: string[];
  questIds?: string[];
  inventory: Array<{
    itemId: string;
    quantity: number;
    price: number;
  }>;
  skillsOffered: string[];
  questsAvailable: string[];
}

// Resource entity config
export interface ResourceEntityConfig extends EntityConfig<ResourceEntityProperties> {
  resourceType: ResourceType;
  resourceId: string;
  harvestSkill: string;
  requiredLevel: number;
  harvestTime: number;
  respawnTime: number;
  harvestYield: Array<{
    itemId: string;
    quantity: number;
    chance: number;
  }>;
  depleted: boolean;
  lastHarvestTime: number;
  depletedModelPath?: string | null;
  modelScale?: number;
  depletedModelScale?: number;
  /**
   * Procgen preset name for procedural tree generation.
   * Maps to @hyperforge/procgen presets (e.g., "blackOak", "weepingWillow").
   * If specified, runtime procedural generation will be used instead of GLB model.
   */
  procgenPreset?: string;
  /**
   * Multiple GLB model paths for visual variation.
   * Each instance deterministically picks one based on entity ID hash.
   * LOD files follow naming convention: model_lod1.glb, model_lod2.glb
   */
  modelVariants?: string[];
  /**
   * Path to LOD1 (low-poly ~30%) model for medium-distance rendering
   * If not specified, full model is used until LOD2 or imposter distance
   * Recommended for trees and large resources to improve mid-range performance
   */
  lod1Model?: string | null;
  /**
   * Scale for LOD1 model (defaults to modelScale if not specified)
   */
  lod1ModelScale?: number;
  /**
   * Path to LOD2 (very low-poly ~10%) model for far-distance rendering
   * If not specified, LOD1 is used until imposter distance
   * Recommended for trees and large resources to improve far-range performance
   */
  lod2Model?: string | null;
  /**
   * Scale for LOD2 model (defaults to modelScale if not specified)
   */
  lod2ModelScale?: number;
  /**
   * LOD configuration for this resource
   */
  lodConfig?: {
    /** Distance to switch from LOD0 to LOD1 (default: 50) */
    lod1Distance?: number;
    /** Distance to switch from LOD1 to LOD2 (default: 100) */
    lod2Distance?: number;
    /** Distance to switch to imposter billboard (default: 150) */
    imposterDistance?: number;
  };
  /**
   * Tile footprint - how many tiles this resource occupies
   * Defaults to "standard" (1×1) if not specified
   * @see ResourceFootprint
   */
  footprint?: ResourceFootprint;
  /**
   * Anchor tile (SW corner) for this resource
   * Calculated from position when spawned
   */
  anchorTile?: TileCoord;
  /**
   * All tiles this resource occupies
   * Calculated from anchorTile and footprint when spawned
   */
  occupiedTiles?: TileCoord[];
}

// Component interfaces
export interface HealthComponent {
  current: number;
  max: number;
  regenerationRate: number;
  isDead: boolean;
}

export interface VisualComponent {
  mesh: THREE.Mesh | null;
  nameSprite: THREE.Sprite | null;
  healthSprite: THREE.Sprite | null;
  isVisible: boolean;
  currentAnimation: string | null;
  animationTime: number;
}

// Entity combat component
export interface EntityCombatComponent {
  level: number;
  health: number;
  maxHealth: number;
  attackLevel: number;
  strengthLevel: number;
  defenseLevel: number;
  rangedLevel: number;
  inCombat: boolean;
  combatTarget: string | null;
  lastAttackTime: number;
  combatStyle: PlayerCombatStyle;
}

// Strongly typed properties for different entity types
export interface BaseEntityProperties {
  movementComponent: MovementComponent | null;
  combatComponent: EntityCombatComponent | null;
  healthComponent: HealthComponent | null;
  visualComponent: VisualComponent | null;
  // Basic entity data that all entities have
  health: PlayerHealth; // Health format with current and max values
  level: number;
}

// Player-specific properties
export interface PlayerEntityProperties extends BaseEntityProperties {
  statsComponent: StatsComponent;
  inventoryComponent: InventoryComponent;
  equipmentComponent: EquipmentComponent;
  prayerComponent: PrayerComponent | null;
  // Player specific data
  health: PlayerHealth; // Health format with current and max values
  level: number;
  playerId: string;
  playerName: string;
  stamina: PlayerStamina; // Changed from separate stamina/maxStamina to use PlayerStamina
  combatStyle: PlayerCombatStyle;
}

// NPC-specific properties
export interface NPCEntityProperties extends BaseEntityProperties {
  npcComponent: NPCComponent;
  dialogue: string[];
  shopInventory: Array<{ itemId: string; price: number; quantity: number }>;
  questGiver: boolean;
}

// Mob-specific properties
export interface MobEntityProperties extends BaseEntityProperties {
  // Mobs use combat and movement components from base
}

// Item-specific properties
export interface ItemEntityProperties extends BaseEntityProperties {
  itemId: string;
  /** Runtime custody classification; pickup authority accepts only durable ground sources. */
  custodyPolicy?: "durable_ground" | "display_only" | "diagnostic_only";
  custodySourceId?: string;
  harvestable: boolean;
  dialogue: string[];
  quantity: number;
  stackable: boolean;
  value: number;
  weight: number;
  rarity: ItemRarity;
}

// Resource-specific properties
export interface ResourceEntityProperties extends BaseEntityProperties {
  // Resources can have health and visual components
  resourceType: ResourceType;
  harvestable: boolean;
  respawnTime: number;
  toolRequired: string;
  skillRequired: string;
  xpReward: number;
}

// Bank-specific properties
export interface BankEntityProperties extends BaseEntityProperties {
  bankId: string;
  townId: string;
}

// Bank storage item
export interface BankStorageItem extends Item {
  storedAt: number;
  bankId: string;
}

// Headstone data for death locations
export interface HeadstoneData {
  playerId: string;
  playerName: string;
  deathTime: number;
  deathMessage: string;
  position: Position3D;
  items: InventoryItem[];
  itemCount: number;
  despawnTime: number;
  // Loot protection (for wilderness/PvP deaths)
  lootProtectionUntil?: number; // Timestamp when loot protection expires
  protectedFor?: string; // Player ID who has loot protection (killer in PvP)
  zoneType?: string; // Death zone type for audit logging (e.g., "safe_area", "wilderness")
}

export interface LocalHeadstoneData extends Omit<HeadstoneData, "deathTime"> {
  id: string;
  createdAt: number;
}

// Headstone entity config
export interface HeadstoneEntityConfig extends EntityConfig<BaseEntityProperties> {
  headstoneData: HeadstoneData;
}

// Bank entity config
export interface BankEntityConfig extends EntityConfig<BaseEntityProperties> {
  properties: BaseEntityProperties & {
    bankId: string;
  };
  /** Collision footprint - predefined ("standard", "large") or custom { width, depth } */
  footprint?: FootprintSpec;
}

// Spawn data interfaces for entity creation
export interface ItemSpawnData {
  id?: string;
  itemId?: string; // Alias for id, either id or itemId must be provided
  customId?: string;
  name?: string;
  position: Position3D;
  model?: string | null;
  quantity?: number;
  stackable?: boolean;
  value?: number;
  droppedBy?: string;
}

export interface ItemSpawnerStats {
  totalItems: number;
  shopItems: number;
  treasureItems: number;
  chestItems: number;
  resourceItems: number;
  lootItems: number;
  byType: Record<string, number>;
  byLocation?: Record<string, number>;
  spawnedItems?: number;
}

export interface MobSpawnData {
  mobType: string;
  position: Position3D;
  level: number;
  customId: string;
  name: string;
}

export interface ResourceSpawnData {
  customId: string;
  name: string;
  position: Position3D;
  model: string | null;
  resourceType: ResourceType;
  respawnTime: number;
  toolRequired: string;
  skillRequired: string;
  xpReward: number;
}

export interface NPCSpawnData {
  customId: string;
  name: string;
  position: Position3D;
  model: string | null;
  npcType: NPCType;
  dialogues: Array<{
    text: string;
    options: Array<{
      text: string;
      action: string | null;
      nextDialogue: number | null;
    }>;
  }>;
  questGiver: boolean;
  shopkeeper: boolean;
  bankTeller: boolean;
}

// Component interface for ECS system
export interface Component<T = Record<string, string | number | boolean>> {
  name: string;
  data: T;
  update(deltaTime: number): void;
  destroy(): void;
}
