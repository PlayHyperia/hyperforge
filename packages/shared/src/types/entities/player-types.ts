/**
 * Player Types
 * All player-related type definitions
 */

import * as THREE from "../../extras/three/three";
import type { PlayerRow } from "../network/database";
import type { Item, EquipmentSlot } from "../game/item-types";
import type { Skills } from "./entity-types";
import {
  calculateCombatLevel as classicCombatLevel,
  normalizeCombatSkills,
} from "../../utils/game/CombatLevelCalculator";

// Core position and health structures
export interface PlayerPosition {
  x: number;
  y: number;
  z: number;
}

export interface PlayerHealth {
  current: number;
  max: number;
}

// Simple equipment structure for players (item references only)
export interface PlayerEquipmentItems {
  weapon: Item | null;
  shield: Item | null;
  helmet: Item | null;
  body: Item | null;
  legs: Item | null;
  boots: Item | null;
  gloves: Item | null;
  cape: Item | null;
  amulet: Item | null;
  ring: Item | null;
  arrows: Item | null;
}

// Combat and status
export interface PlayerCombatData {
  combatLevel: number;
  /** Backward-compatible combat stance/training selection key. */
  combatStyle?: "attack" | "strength" | "defense" | "ranged";
  /** Skill that receives XP from combat (canonical field). */
  trainingSkill?: "attack" | "strength" | "defense" | "ranged";
  inCombat: boolean;
  combatTarget: string | null;
  autoRetaliate: boolean; // classic MMORPG-style auto-retaliate setting (default: true)
}

// Stamina system
export interface PlayerStamina {
  current: number;
  max: number;
}

// Death and respawn
export interface PlayerDeathData {
  deathLocation: PlayerPosition | null;
  respawnTime: number;
}

/**
 * SINGLE AUTHORITATIVE PLAYER DATA INTERFACE
 * This replaces ALL other player data interfaces in the codebase
 */
export interface Player {
  // Core identity
  id: string;
  hyperiaPlayerId: string;
  name: string;

  // Health and status
  health: PlayerHealth;
  alive: boolean;
  stamina: PlayerStamina;

  // Position and movement
  position: PlayerPosition;

  // Progression
  skills: Skills;

  // Equipment and inventory
  equipment: PlayerEquipmentItems;
  inventory?: { items?: unknown[] }; // For interaction system compatibility
  coins: number;

  // Combat
  combat: PlayerCombatData;
  /** Persisted autocast selection restored before competitive preparation. */
  selectedSpell?: string | null;
  stats?: {
    attack: number;
    strength: number;
    defense: number;
    constitution: number;
  }; // For aggro system compatibility

  // Death system
  death: PlayerDeathData;

  // Session metadata
  lastAction: string | null;
  lastSaveTime: number;
  sessionId: string | null;

  // Hyperia integration properties
  node?: {
    position: THREE.Vector3;
    quaternion?: THREE.Quaternion;
  }; // Hyperia node reference
  data?: {
    id: string;
    name: string;
    health?: number;
    roles?: string[];
    owner?: string;
    effect?: unknown;
  }; // Hyperia entity data
  avatar?: {
    getHeight?: () => number;
    getHeadToHeight?: () => number;
    setEmote?: (emote: string) => void;
    getBoneTransform?: (boneName: string) => THREE.Matrix4 | null;
  }; // Hyperia avatar reference

  // Player methods for Hyperia compatibility
  setPosition?: (x: number, y: number, z: number) => void;
  setRotation?: (x: number, y: number, z: number, w: number) => void;

  // Loading state - true while client is loading assets, player immune to aggro/combat
  isLoading?: boolean;

  // Auto-retaliate initialization - top-level for entity creation, used to initialize combat.autoRetaliate
  autoRetaliate?: boolean;

  // === Rules-Accurate Face Direction System ===
  // Face target is set when interacting with objects/NPCs, processed at end of tick
  faceTarget?: {
    /** Target coordinates to face (tile position) */
    x: number;
    z: number;
  };
  /** Flag set when player moves during a tick - prevents face direction update */
  movedThisTick?: boolean;
}

/**
 * Migration utilities to convert from old interfaces
 */
export class PlayerMigration {
  /**
   * Convert from old PlayerRow to new Player
   */
  static fromPlayerRow(old: PlayerRow, hyperiaPlayerId: string): Player {
    // Validate health values to prevent NaN
    const maxHealth =
      Number.isFinite(old.maxHealth) && old.maxHealth > 0 ? old.maxHealth : 100;
    const currentHealth = Number.isFinite(old.health)
      ? Math.min(old.health, maxHealth)
      : maxHealth;

    return {
      id: old.playerId,
      hyperiaPlayerId,
      name: old.name,
      health: { current: currentHealth, max: maxHealth },
      alive: currentHealth > 0,
      stamina: { current: 100, max: 100 }, // Assuming default stamina
      position: { x: old.positionX, y: old.positionY, z: old.positionZ },
      skills: {
        attack: { level: old.attackLevel, xp: old.attackXp },
        strength: { level: old.strengthLevel, xp: old.strengthXp },
        defense: { level: old.defenseLevel, xp: old.defenseXp },
        constitution: { level: old.constitutionLevel, xp: old.constitutionXp },
        ranged: { level: old.rangedLevel, xp: old.rangedXp },
        magic: { level: old.magicLevel || 1, xp: old.magicXp || 0 },
        prayer: { level: old.prayerLevel || 1, xp: old.prayerXp || 0 },
        woodcutting: {
          level: old.woodcuttingLevel || 1,
          xp: old.woodcuttingXp || 0,
        },
        mining: { level: old.miningLevel || 1, xp: old.miningXp || 0 },
        fishing: { level: old.fishingLevel || 1, xp: old.fishingXp || 0 },
        firemaking: {
          level: old.firemakingLevel || 1,
          xp: old.firemakingXp || 0,
        },
        cooking: { level: old.cookingLevel || 1, xp: old.cookingXp || 0 },
        smithing: { level: old.smithingLevel || 1, xp: old.smithingXp || 0 },
        agility: { level: old.agilityLevel || 1, xp: old.agilityXp || 0 },
        crafting: { level: old.craftingLevel || 1, xp: old.craftingXp || 0 },
        fletching: { level: old.fletchingLevel || 1, xp: old.fletchingXp || 0 },
        runecrafting: {
          level: old.runecraftingLevel || 1,
          xp: old.runecraftingXp || 0,
        },
      },
      equipment: {
        weapon: null,
        shield: null,
        helmet: null,
        body: null,
        legs: null,
        boots: null,
        gloves: null,
        cape: null,
        amulet: null,
        ring: null,
        arrows: null,
      },
      coins: old.coins,
      combat: {
        combatLevel: old.combatLevel,
        trainingSkill: "attack",
        inCombat: false,
        combatTarget: null,
        autoRetaliate: true, // classic MMORPG default: ON
      },
      selectedSpell: old.selectedSpell ?? null,
      death: {
        deathLocation: null,
        respawnTime: 0,
      },
      lastAction: null,
      lastSaveTime: old.lastLogin,
      sessionId: null,
    };
  }

  /**
   * Convert from old PlayerState to new Player
   */
  static fromPlayerState(old: {
    id?: string;
    name?: string;
    position?: { x: number; y: number; z: number };
    health?: { current: number; max: number };
    skills?: Skills;
    equipment?: Record<string, Item>;
    combatLevel?: number;
    inCombat?: boolean;
    combatTarget?: string;
    coins?: number;
    deathLocation?: { x: number; y: number; z: number };
    lastAction?: string;
  }): Partial<Player> {
    const partialData: Partial<Player> = {
      id: old.id,
      name: old.name,
      position: old.position,
      health: old.health,
      skills: old.skills,
      equipment: old.equipment
        ? {
            weapon: null,
            shield: null,
            helmet: null,
            body: null,
            legs: null,
            boots: null,
            gloves: null,
            cape: null,
            amulet: null,
            ring: null,
            arrows: null,
          }
        : undefined,
      combat: {
        combatLevel: old.combatLevel || 1,
        trainingSkill: "attack",
        inCombat: old.inCombat || false,
        combatTarget: old.combatTarget || null,
        autoRetaliate: true, // classic MMORPG default: ON
      },
      coins: old.coins,
      death: {
        deathLocation: old.deathLocation || null,
        respawnTime: 0,
      },
      lastAction: old.lastAction || null,
    };
    return partialData;
  }

  /**
   * Get default starting skills
   */
  static getDefaultSkills(): Skills {
    const defaultSkill = { level: 1, xp: 0 };
    return {
      attack: defaultSkill,
      strength: defaultSkill,
      defense: defaultSkill,
      constitution: { level: 10, xp: 1154 }, // Constitution starts at level 10
      ranged: defaultSkill,
      magic: defaultSkill,
      prayer: defaultSkill,
      woodcutting: defaultSkill,
      mining: defaultSkill,
      fishing: defaultSkill,
      firemaking: defaultSkill,
      cooking: defaultSkill,
      smithing: defaultSkill,
      agility: defaultSkill,
      crafting: defaultSkill,
      fletching: defaultSkill,
      runecrafting: defaultSkill,
    };
  }

  /**
   * Calculate combat level from skills (delegates to rules-accurate CombatLevelCalculator)
   */
  static calculateCombatLevel(skills: Skills): number {
    return classicCombatLevel(
      normalizeCombatSkills({
        attack: skills.attack?.level || 1,
        strength: skills.strength?.level || 1,
        defense: skills.defense?.level || 1,
        hitpoints: skills.constitution?.level || 10,
        ranged: skills.ranged?.level || 1,
        magic: skills.magic?.level || 1,
        prayer: skills.prayer?.level || 1,
      }),
    );
  }

  /**
   * Create a new player with default values
   */
  static createNewPlayer(
    id: string,
    hyperiaPlayerId: string,
    name: string,
  ): Player {
    const skills = this.getDefaultSkills();
    // Health should equal constitution level (starting at 10)
    const constitutionLevel = skills.constitution.level;
    return {
      id,
      hyperiaPlayerId,
      name,
      health: { current: constitutionLevel, max: constitutionLevel },
      alive: true,
      stamina: { current: 100, max: 100 },
      position: { x: 0, y: 0, z: 0 },
      skills,
      equipment: {
        weapon: null,
        shield: null,
        helmet: null,
        body: null,
        legs: null,
        boots: null,
        gloves: null,
        cape: null,
        amulet: null,
        ring: null,
        arrows: null,
      },
      coins: 0,
      combat: {
        combatLevel: 1,
        trainingSkill: "attack",
        inCombat: false,
        combatTarget: null,
        autoRetaliate: true, // classic MMORPG default: ON
      },
      death: {
        deathLocation: null,
        respawnTime: 0,
      },
      lastAction: null,
      lastSaveTime: Date.now(),
      sessionId: null,
    };
  }
}

// Type guard to check if object is Player
export function isPlayer(obj: unknown): obj is Player {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const candidate = obj as Record<string, unknown>;

  return !!(
    "id" in candidate &&
    typeof candidate.id === "string" &&
    "hyperiaPlayerId" in candidate &&
    typeof candidate.hyperiaPlayerId === "string" &&
    "name" in candidate &&
    typeof candidate.name === "string" &&
    "health" in candidate &&
    candidate.health &&
    "position" in candidate &&
    candidate.position &&
    "skills" in candidate &&
    candidate.skills &&
    "equipment" in candidate &&
    candidate.equipment &&
    "combat" in candidate &&
    candidate.combat
  );
}

// Player stats interface for UI
export interface PlayerStats {
  level: number;
  health: PlayerHealth;
  skills: Skills;
  combatLevel: number;
  equipment: PlayerEquipmentItems;
  inCombat: boolean;
  /** Prayer points (current/max) for prayer system UI */
  prayerPoints?: { current: number; max: number };
}

// Attack style state
export interface PlayerAttackStyleState {
  playerId: string;
  selectedStyle: string;
}

// Authentication interfaces
export interface PlayerIdentity {
  hyperiaUserId: string;
  hyperiaUserName: string;
  hyperiaUserRoles: string[];

  rpgPlayerId: string;
  rpgPlayerName: string;
  clientMachineId: string;

  hyperiaJwtToken?: string;
  clientPersistentToken: string;

  sessionId: string;
  loginTime: Date;
  lastActivity: Date;
  isGuest: boolean;
}

export interface AuthenticationResult {
  success: boolean;
  identity?: PlayerIdentity;
  error?: string;
  isNewPlayer: boolean;
  isReturningPlayer: boolean;
}

// Player inventory state
export interface PlayerInventoryState {
  playerId: string;
  items: Array<{
    id: string;
    itemId: string;
    quantity: number;
    slot: number;
    metadata: Record<string, number | string | boolean> | null;
  }>;
  coins: number;
}

// Player spawn data interface
export interface PlayerSpawnData {
  playerId: string;
  position: THREE.Vector3;
  spawnTime: number;
  hasStarterEquipment: boolean;
  aggroTriggered: boolean;
}

// Player bank storage - in-memory model (used by NPCSystem and legacy code)
export interface PlayerBankStorage {
  playerId: string;
  items: Map<string, number>; // itemId -> quantity
  lastAccessed: number;
}

/**
 * Player bank storage - full model matching database schema
 * Single source of truth for bank data structure in DB-backed systems
 */
export interface PlayerBankItemDB {
  readonly itemId: string;
  readonly quantity: number;
  readonly slot: number;
  readonly tabIndex: number;
}

export interface PlayerBankTabDB {
  readonly tabIndex: number;
  readonly iconItemId: string | null;
}

export interface PlayerBankStorageDB {
  readonly playerId: string;
  readonly items: ReadonlyArray<PlayerBankItemDB>;
  readonly tabs: ReadonlyArray<PlayerBankTabDB>;
  readonly alwaysSetPlaceholder: boolean;
  readonly maxSlots: number;
  readonly lastAccessed?: number;
}

// Player inventory with full item data (used by InventorySystem)
export interface PlayerInventory {
  playerId: string;
  items: Array<{
    slot: number;
    itemId: string;
    quantity: number;
    item: Item;
  }>;
  coins: number;
}

// Player equipment with stats
export interface PlayerEquipment {
  playerId: string;
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
  totalStats: {
    attack: number;
    strength: number;
    defense: number;
    ranged: number;
    constitution: number;
    rangedAttack: number;
    rangedStrength: number;
    magicAttack: number;
    magicDefense: number;
    // Per-style melee defence bonuses (classic MMORPG combat triangle)
    defenseStab: number;
    defenseSlash: number;
    defenseCrush: number;
    defenseRanged: number;
    // Per-style melee attack bonuses
    attackStab: number;
    attackSlash: number;
    attackCrush: number;
  };
}
