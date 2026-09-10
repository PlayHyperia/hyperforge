/**
 * Item and Equipment Types
 * All item, inventory, and equipment-related type definitions
 */

import * as THREE from "../../extras/three/three";
import type { ItemRarity } from "../entities";
import type { Skills } from "../entities/entity-types";

// Item related enums
export enum WeaponType {
  SWORD = "sword",
  AXE = "axe",
  MACE = "mace",
  DAGGER = "dagger",
  SPEAR = "spear",
  BOW = "bow",
  CROSSBOW = "crossbow",
  STAFF = "staff",
  WAND = "wand",
  SHIELD = "shield",
  SCIMITAR = "scimitar",
  LONGSWORD = "longsword",
  TWO_HAND_SWORD = "two_hand_sword",
  HALBERD = "halberd",
  NONE = "none",
}

export enum ItemType {
  WEAPON = "weapon",
  ARMOR = "armor",
  FOOD = "food",
  RESOURCE = "resource",
  TOOL = "tool",
  MISC = "misc",
  CURRENCY = "currency",
  CONSUMABLE = "consumable",
  AMMUNITION = "ammunition",
}

// Combat related enums
/**
 * Combat attack types. Discriminated union for exhaustive switch handling.
 */
export enum AttackType {
  MELEE = "melee",
  RANGED = "ranged",
  MAGIC = "magic",
}

/**
 * Type guard for AttackType validation
 */
export function isValidAttackType(value: string): value is AttackType {
  return Object.values(AttackType).includes(value as AttackType);
}

// Equipment slot type enum - use this consistently
export enum EquipmentSlotName {
  WEAPON = "weapon",
  SHIELD = "shield",
  HELMET = "helmet",
  BODY = "body",
  LEGS = "legs",
  BOOTS = "boots",
  GLOVES = "gloves",
  CAPE = "cape",
  AMULET = "amulet",
  RING = "ring",
  ARROWS = "arrows",
}

// Type alias for equipment slot values - use this for type safety
export type EquipmentSlotType = `${EquipmentSlotName}`;

// Combat bonuses interface
export interface CombatBonuses {
  // Simple bonuses for backward compatibility
  attack?: number;
  defense?: number;
  ranged?: number;
  strength?: number;

  // Detailed combat bonuses
  attackStab?: number;
  attackSlash?: number;
  attackCrush?: number;
  attackRanged?: number;
  attackMagic?: number;
  defenseStab?: number;
  defenseSlash?: number;
  defenseCrush?: number;
  defenseRanged?: number;
  defenseMagic?: number;
  meleeStrength?: number;
  rangedStrength?: number;
  magicDamage?: number;
  prayer?: number;
  prayerBonus?: number;
}

// Simple item bonuses interface for equipment
export interface ItemBonuses {
  attack?: number;
  defense?: number;
  ranged?: number;
  strength?: number;
}

// Item stats interface
export interface ItemStats {
  attackStab?: number;
  attackSlash?: number;
  attackCrush?: number;
  attackRanged?: number;
  attackMagic?: number;
  defenseStab?: number;
  defenseSlash?: number;
  defenseCrush?: number;
  defenseRanged?: number;
  defenseMagic?: number;
  strength?: number;
  prayer?: number;
  weight?: number;
}

export interface ItemRequirement {
  level?: number;
  attack?: number;
  strength?: number;
  defense?: number;
  ranged?: number;
  skill?: string;
}

// Item types
export interface Item {
  id: string; // Unique item ID (e.g., "bronze_sword", "cooked_fish")
  name: string; // Display name
  type: ItemType; // Item category

  // On-chain numeric ID (assigned by generate-item-ids.ts, populated at runtime)
  // Used for ERC-1155 tokenId and MUD table keys. 0 means not yet assigned.
  numericId?: number;

  // Inventory properties - optional, DataManager provides defaults
  quantity?: number; // Default: 1
  stackable?: boolean; // Default: false
  maxStackSize?: number; // Default: 1 (only specify for stackable items)
  value?: number; // Default: 0
  weight?: number; // Default: 0.1

  // Equipment properties - optional, only needed for equipable items
  equipSlot?: EquipmentSlotName | "2h" | null; // Default: null (not equipable)
  weaponType?: WeaponType | null; // Default: null
  equipable?: boolean; // Default: false (derived from equipSlot if not specified)
  attackType?: AttackType | null; // Default: null
  attackSpeed?: number; // Attack speed in game ticks (classic MMORPG-style: 4 = standard sword)
  attackRange?: number; // Attack range in tiles (1 = adjacent melee, 2 = halberd, 7+ = ranged)
  is2h?: boolean; // Explicit flag for 2-handed weapons (alternative to equipSlot: '2h')

  // Item properties
  description: string; // Item description
  examine: string; // Examine text
  tradeable: boolean; // Can be traded
  rarity: ItemRarity; // ItemRarity tier

  // Visual assets
  modelPath: string | null; // 3D model path for DROPPED items (null if no model exists yet)
  equippedModelPath?: string | null; // 3D model path for EQUIPPED items (hand-held weapons)
  /** SHA-256 identity for the default equipped model, used for cache-safe URLs. */
  equippedModelSha256?: string;
  /** Avatar-specific fitted equipped models, keyed by the exact registered avatar ID. */
  equippedModelPathsByAvatar?: Record<string, string>;
  /** SHA-256 identities matching equippedModelPathsByAvatar. */
  equippedModelSha256ByAvatar?: Record<string, string>;
  /**
   * Avatar-specific gathering presentation models. This keeps a tool's fitted
   * gathering attachment separate from its weapon-slot combat presentation.
   */
  gatheringModelPathsByAvatar?: Record<string, string>;
  /** SHA-256 identities matching gatheringModelPathsByAvatar. */
  gatheringModelSha256ByAvatar?: Record<string, string>;
  iconPath: string; // UI icon path

  // Ground item display overrides
  /** Scale for 3D model when displayed as ground item (default: 0.3) */
  modelScale?: number;
  /** Ground item Y positioning:
   *  - When <= 0: model bottom is bbox-snapped to terrain with this as offset (0 = flush)
   *  - When > 0: item floats at this height with bobbing animation
   *  - When undefined: defaults to 0.5 (standard floating ground item) */
  groundOffset?: number;

  // Consumable properties - only for food/consumables
  healAmount?: number; // Health restored when consumed

  // === BONE BURYING (Prayer XP) ===
  /** Prayer XP granted when this item is buried (for bones) */
  prayerXp?: number;
  /** Prayer level required to bury this item (for high-tier bones) */
  buryLevelRequired?: number;

  // Combat bonuses (for equipment) - optional for non-equipment items
  bonuses?: CombatBonuses;

  // Requirements to use/equip - optional, default: no requirements
  requirements?: {
    level: number;
    skills: Partial<Record<keyof Skills, number>>;
  };

  // === BANK NOTE SYSTEM ===
  /**
   * Can this item be converted to a bank note?
   * Auto-derived if not specified: tradeable && !stackable && type !== currency
   */
  noteable?: boolean;

  /**
   * ID of the noted version of this item.
   * Only present on BASE items (e.g., "logs" has notedItemId: "logs_noted")
   * Set automatically by NoteGenerator at runtime.
   */
  notedItemId?: string;

  /**
   * ID of the base (unnoted) version of this item.
   * Only present on NOTED items (e.g., "logs_noted" has baseItemId: "logs")
   * Set automatically by NoteGenerator at runtime.
   */
  baseItemId?: string;

  /**
   * True if this item IS a bank note.
   * Noted items are always stackable and cannot be equipped/consumed.
   */
  isNoted?: boolean;

  // === COOKING DATA (from manifest) ===
  /**
   * Cooking properties for raw foods (shrimp, lobster, etc.)
   * Present only on items that can be cooked.
   */
  cooking?: {
    /** Item ID of the cooked result (e.g., "shrimp") */
    cookedItemId: string;
    /** Item ID of the burnt result (e.g., "burnt_shrimp") */
    burntItemId: string;
    /** Cooking level required */
    levelRequired: number;
    /** XP granted on successful cook */
    xp: number;
    /** Level at which burning stops (per cooking source) */
    stopBurnLevel: {
      fire: number;
      range: number;
    };
  };

  // === FIREMAKING DATA (from manifest) ===
  /**
   * Firemaking properties for logs.
   * Present only on items that can be used for firemaking.
   */
  firemaking?: {
    /** Firemaking level required */
    levelRequired: number;
    /** XP granted on successful fire */
    xp: number;
  };

  // === SMELTING DATA (from manifest) ===
  /**
   * Smelting properties for bars.
   * Present only on bar items that define their smelting recipe.
   * Note: Smelting data is on BARS, not ores - bars define what ores they need.
   */
  smelting?: {
    /** Primary ore required (e.g., "copper_ore", "iron_ore") */
    primaryOre: string;
    /** Secondary ore required (only for bronze: "tin_ore") */
    secondaryOre: string | null;
    /** Number of coal required (0 for bronze/iron/gold/silver) */
    coalRequired: number;
    /** Smithing level required to smelt */
    levelRequired: number;
    /** XP granted per bar smelted */
    xp: number;
    /** Success rate (0.5 = 50% for iron, 1.0 = always for others) */
    successRate: number;
    /** Time in game ticks (600ms per tick). Default: 4 ticks */
    ticks?: number;
  };

  // === SMITHING DATA (from manifest) ===
  /**
   * Smithing properties for items that can be smithed at an anvil.
   * Present on output items (swords, hatchets, pickaxes, etc.)
   * Note: Smithing data is on OUTPUT items - they define what bars they need.
   */
  smithing?: {
    /** Bar type required (e.g., "bronze_bar", "iron_bar") */
    barType: string;
    /** Number of bars required */
    barsRequired: number;
    /** Smithing level required */
    levelRequired: number;
    /** XP granted per item smithed */
    xp: number;
    /** Category for UI grouping ("sword", "hatchet", "pickaxe") */
    category: string;
    /** Time in game ticks (600ms per tick). Default: 4 ticks */
    ticks?: number;
    /** Number of items produced per action. Default: 1. Arrowtips produce 15. */
    outputQuantity?: number;
  };

  // === TIER-BASED EQUIPMENT SYSTEM ===
  /**
   * Equipment tier for deriving level requirements.
   * E.g., "bronze", "iron", "steel", "mithril", "adamant", "rune", "dragon"
   * Requirements are derived from tier-requirements.json at runtime.
   */
  tier?: string;

  // === GATHERING TOOL DATA ===
  /**
   * Tool-specific properties for gathering tools (hatchets, pickaxes, fishing rods)
   * Replaces the old tools.json - now embedded directly in items.
   */
  tool?: {
    /** Gathering skill this tool is for (woodcutting, mining, fishing) */
    skill: "woodcutting" | "mining" | "fishing";
    /** Priority for best tool selection (lower = better, 1 = best) */
    priority: number;
    /** For mining: ticks between roll attempts (rules-accurate) */
    rollTicks?: number;
  };

  // === RULES-ACCURATE INVENTORY ACTIONS ===
  /**
   * Explicit inventory context menu actions (rules-accurate).
   * First action is the left-click default.
   *
   * classic MMORPG stores this per-item, NOT derived from properties.
   * Common actions: "Eat", "Drink", "Wield", "Wear", "Bury", "Use", "Drop", "Examine"
   *
   * If not specified, falls back to type-based detection for compatibility.
   *
   * @example Food: ["Eat", "Use", "Drop", "Examine"]
   * @example Weapon: ["Wield", "Use", "Drop", "Examine"]
   * @example Potion: ["Drink", "Use", "Drop", "Examine"]
   * @example Generic: ["Use", "Drop", "Examine"]
   */
  inventoryActions?: string[];
}

export interface EquipmentSlot {
  id: string;
  name: string;
  slot: EquipmentSlotName;
  itemId: string | number | null;
  item: Item | null;
  quantity?: number; // For stackable items like arrows
  visualMesh?: THREE.Object3D | THREE.Mesh;
}

export interface Equipment {
  weapon: EquipmentSlot | null;
  shield: EquipmentSlot | null;
  helmet: EquipmentSlot | null;
  body: EquipmentSlot | null;
  legs: EquipmentSlot | null;
  boots: EquipmentSlot | null;
  gloves: EquipmentSlot | null;
  cape: EquipmentSlot | null;
  amulet: EquipmentSlot | null;
  ring: EquipmentSlot | null;
  arrows: EquipmentSlot | null;
}

// Inventory item with full item data (used by InventorySystem)
export interface InventorySlotItem {
  slot: number;
  itemId: string;
  quantity: number;
  item: Item;
}

export type StoreItemCategory =
  "tools" | "ammunition" | "consumables" | "weapons" | "armor";

// Store types
export interface StoreItem {
  id: string;
  itemId: string;
  name: string;
  price: number;
  description: string;
  category: StoreItemCategory;
  stockQuantity: number; // -1 for unlimited
  restockTime: number; // 0 for no restock
}

export interface Store {
  id: string;
  name: string;
  /** @deprecated Position comes from the NPC entity, not the store */
  position?: { x: number; y: number; z: number };
  items: StoreItem[];
  npcName: string;
  buyback: boolean;
  buybackRate: number; // 0-1 percentage
}

// Banking types
export interface BankItem {
  id: string;
  name: string;
  quantity: number;
  stackable: boolean;
}

// Starting items
export interface StartingItem {
  id: string;
  name: string;
  quantity: number;
  stackable: boolean;
  equipped: boolean; // Whether to auto-equip on spawn
  slot: EquipmentSlotName | null;
}

// Equipment requirements
export interface LevelRequirement {
  attack: number;
  strength: number;
  defense: number;
  ranged: number;
  constitution: number;
}

export interface EquipmentDataJSON {
  levelRequirements: {
    weapons: Record<string, LevelRequirement>;
    shields: Record<string, LevelRequirement>;
    armor: {
      helmets: Record<string, LevelRequirement>;
      body: Record<string, LevelRequirement>;
      legs: Record<string, LevelRequirement>;
    };
    ammunition: Record<string, LevelRequirement>;
  };
  equipmentColors: Record<string, string>;
  starterEquipment: Array<{
    itemId: string;
    slot: string;
    autoEquip: boolean;
  }>;
}

export interface StarterEquipmentItem {
  itemId: string;
  slot: string;
  autoEquip: boolean;
}

// Item Action System types
export interface ItemAction {
  id: string;
  label: string;
  callback: (playerId: string, itemId: string, slot: number | null) => void;
  priority: number; // Lower number = higher priority in menu
  condition: ((item: Item, playerId: string) => boolean) | null;
}

export interface ItemContextMenu {
  playerId: string;
  itemId: string;
  slot: number | null;
  actions: ItemAction[];
  position: { x: number; y: number };
  visible: boolean;
}

// Ground items
export interface GroundItem {
  id: string;
  item: Item;
  position: THREE.Vector3;
  mesh: THREE.Mesh;
  droppedBy: string | null;
  droppedAt: number;
  despawnTime: number;
}

// === BANK NOTE TYPE GUARDS ===

/**
 * Type guard: Check if item can be noted (has noted variant)
 */
export function isNoteableItem(
  item: Item,
): item is Item & { noteable: true; notedItemId: string } {
  return item.noteable === true && typeof item.notedItemId === "string";
}

/**
 * Type guard: Check if item IS a note (has base item reference)
 */
export function isNotedItem(
  item: Item,
): item is Item & { isNoted: true; baseItemId: string } {
  return item.isNoted === true && typeof item.baseItemId === "string";
}
