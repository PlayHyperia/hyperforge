/**
 * Entities.ts - Entity Management System
 *
 * Central registry and lifecycle manager for all entities in the game world.
 * Manages players, mobs, NPCs, and generic entities with component-based architecture.
 *
 * Key Responsibilities:
 * - Entity creation and destruction (add/remove)
 * - Entity type registration and instantiation
 * - Component registration and management
 * - Player tracking (both local and remote)
 * - Entity lookup and iteration
 * - Entity lifecycle events (add/remove/modify)
 * - Hot update tracking (entities that need update() called each frame)
 *
 * Entity Types:
 * - GenericEntity: Base entity for props, items, etc.
 * - PlayerEntity: Base player (server-side)
 * - PlayerLocal: Local player with input handling (client-side)
 * - PlayerRemote: Remote networked players (client-side)
 * - MobEntity: Enemy creatures with AI
 * - NPCEntity: Non-hostile characters with dialogue
 *
 * Component System:
 * Entities can have components attached for modular functionality:
 * - CombatComponent: Health, attack, defense
 * - DataComponent: Custom entity data storage
 * - InteractionComponent: Player interaction handlers
 * - StatsComponent: Numeric stats (level, XP, etc.)
 * - UsageComponent: Item usage/consumption logic
 * - VisualComponent: 3D model, materials, animations
 *
 * Network Synchronization:
 * - Server creates entities and broadcasts to clients
 * - Clients receive entityAdded/entityModified/entityRemoved packets
 * - Entity state is serialized and replicated across network
 *
 * Usage:
 * ```typescript
 * // Create entity
 * const entity = world.entities.add({
 *   id: 'tree1',
 *   type: 'entity',
 *   position: { x: 10, y: 0, z: 5 }
 * });
 *
 * // Get entity
 * const tree = world.entities.get('tree1');
 *
 * // Remove entity
 * world.entities.remove('tree1');
 * ```
 *
 * Runs on: Both client and server
 * Used by: All systems that deal with entities
 * References: Entity.ts, PlayerEntity.ts, MobEntity.ts, NPCEntity.ts
 */

import { Entity } from "../../../entities/Entity";
import { PlayerLocal } from "../../../entities/player/PlayerLocal";
import { PlayerRemote } from "../../../entities/player/PlayerRemote";
import { PlayerEntity } from "../../../entities/player/PlayerEntity";
import { MobEntity } from "../../../entities/npc/MobEntity";
import { NPCEntity } from "../../../entities/npc/NPCEntity";
import { ItemEntity } from "../../../entities/world/ItemEntity";
import { ResourceEntity } from "../../../entities/world/ResourceEntity";
import { HeadstoneEntity } from "../../../entities/world/HeadstoneEntity";
import { BankEntity } from "../../../entities/world/BankEntity";
import {
  FurnaceEntity,
  type FurnaceEntityConfig,
} from "../../../entities/world/FurnaceEntity";
import {
  AnvilEntity,
  type AnvilEntityConfig,
} from "../../../entities/world/AnvilEntity";
import {
  AltarEntity,
  type AltarEntityConfig,
} from "../../../entities/world/AltarEntity";
import {
  RunecraftingAltarEntity,
  type RunecraftingAltarEntityConfig,
} from "../../../entities/world/RunecraftingAltarEntity";
import {
  RangeEntity,
  type RangeEntityConfig,
} from "../../../entities/world/RangeEntity";
import type {
  ComponentDefinition,
  EntityConstructor,
  EntityData,
  Entities as IEntities,
  Player,
  World,
} from "../../../types/index";
import { EventType } from "../../../types/events";
import { SystemBase } from "../infrastructure/SystemBase";
import type {
  MobEntityConfig,
  NPCEntityConfig,
  ItemEntityConfig,
  ResourceEntityConfig,
  HeadstoneData,
  HeadstoneEntityConfig,
  BankEntityConfig,
} from "../../../types/entities";
import {
  EntityType,
  InteractionType,
  MobAIState,
  NPCType,
  ItemRarity,
  ResourceType,
} from "../../../types/entities";
import { getNPCById } from "../../../data/npcs";
import { NPCBehavior, NPCState } from "../../../types/core/core";
import { AnimatedImpostorManager } from "../rendering/AnimatedImpostorManager";

/**
 * GenericEntity - Simple entity implementation for non-specialized entities.
 * Used for props, decorations, ground items, and other basic world objects.
 */
class GenericEntity extends Entity {
  constructor(world: World, data: EntityData, local?: boolean) {
    super(world, data, local);
  }
}

/**
 * Entity type registry - maps type strings to entity constructors.
 * LAZY INITIALIZATION: Entity classes are imported on first access to avoid circular dependencies.
 * New entity types can be registered at runtime via registerEntityType().
 */
let _entityTypesInitialized = false;
const EntityTypes: Record<string, EntityConstructor> = {
  entity: GenericEntity as EntityConstructor,
};

/**
 * Initialize entity type registry with all built-in entity types.
 * Called lazily on first access.
 */
function initializeEntityTypes(): void {
  if (_entityTypesInitialized) return;
  _entityTypesInitialized = true;

  EntityTypes.player = PlayerEntity as EntityConstructor;
  EntityTypes.playerLocal = PlayerLocal as EntityConstructor;
  EntityTypes.playerRemote = PlayerRemote as EntityConstructor;
  EntityTypes.item = ItemEntity as unknown as EntityConstructor;
  EntityTypes.mob = MobEntity as unknown as EntityConstructor;
  EntityTypes.npc = NPCEntity as unknown as EntityConstructor;
  EntityTypes.resource = ResourceEntity as unknown as EntityConstructor;
  EntityTypes.headstone = HeadstoneEntity as unknown as EntityConstructor;
  EntityTypes.bank = BankEntity as unknown as EntityConstructor;
  EntityTypes.furnace = FurnaceEntity as unknown as EntityConstructor;
  EntityTypes.anvil = AnvilEntity as unknown as EntityConstructor;
  EntityTypes.altar = AltarEntity as unknown as EntityConstructor;
  EntityTypes.range = RangeEntity as unknown as EntityConstructor;
}

/**
 * Get an entity constructor by type name.
 * Initializes the entity type registry on first call.
 */
function getEntityType(type: string): EntityConstructor | undefined {
  initializeEntityTypes();
  return EntityTypes[type];
}

/**
 * Entities System - Central entity registry and lifecycle manager.
 *
 * Manages all entities in the world including players, mobs, NPCs, and props.
 * Provides component-based architecture for modular entity functionality.
 */
export class Entities extends SystemBase implements IEntities {
  items: Map<string, Entity>;
  players: Map<string, Player>;
  player?: Player;
  apps: Map<string, Entity>;
  private hot: Set<Entity>;
  private removed: string[];
  private componentRegistry = new Map<string, ComponentDefinition>();

  constructor(world: World) {
    super(world, {
      name: "entities",
      dependencies: { required: ["physics"], optional: [] },
      autoCleanup: true,
    });
    this.items = new Map();
    this.players = new Map();
    this.player = undefined;
    this.apps = new Map();
    this.hot = new Set();
    this.removed = [];
  }

  get(id: string): Entity | null {
    // Check items first, then players (for remote player entity lookup)
    return this.items.get(id) || this.players.get(id) || null;
  }

  values(): IterableIterator<Entity> {
    return this.items.values();
  }

  getPlayer(entityId: string): Player | null {
    const player = this.players.get(entityId);
    if (!player) {
      // Don't throw - return null for disconnected players
      // This allows systems to gracefully handle missing players
      return null;
    }
    return player;
  }

  registerComponentType(definition: ComponentDefinition): void {
    this.componentRegistry.set(definition.type, definition);
  }

  getComponentDefinition(type: string): ComponentDefinition | undefined {
    return this.componentRegistry.get(type);
  }

  // TypeScript-specific methods for interface compliance
  has(entityId: string): boolean {
    return this.items.has(entityId);
  }

  set(entityId: string, entity: Entity): void {
    this.items.set(entityId, entity);
    if (entity.isPlayer) {
      this.players.set(entityId, entity as Player);
    }
  }

  create(
    name: string,
    options?: Partial<EntityData> & { type?: string },
  ): Entity {
    const data: EntityData = {
      id: `entity-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: options?.type || "entity",
      name,
      ...options,
    };
    return this.add(data, true);
  }

  add(data: EntityData, local?: boolean): Entity {
    // Check if entity already exists to prevent duplicates
    const existingEntity = this.items.get(data.id);
    if (existingEntity) {
      // Duplicate add detected; return existing without logging per-frame
      return existingEntity;
    }

    let EntityClass: EntityConstructor;

    if (data.type === "player") {
      // Check if we're on the server
      const network = this.world.network || this.world.getSystem("network");
      const isServer = network?.isServer === true;

      if (isServer) {
        // On server, always use the base player entity type
        EntityClass = getEntityType("player")!;
      } else {
        // On client, determine if local or remote based on ownership
        const isLocal = data.owner === network?.id;
        EntityClass = getEntityType(isLocal ? "playerLocal" : "playerRemote")!;
      }
    } else if (data.type === "mob") {
      // Client-side: build a real MobEntity from snapshot data so models load
      const positionArray = (data.position || [0, 0, 0]) as [
        number,
        number,
        number,
      ];
      const quaternionArray = (data.quaternion || [0, 0, 0, 1]) as [
        number,
        number,
        number,
        number,
      ];
      // Derive mobType from name: "Mob: goblin (Lv1)" -> goblin
      const name = data.name || "Mob";
      const mobTypeMatch = name.match(/Mob:\s*([^()]+)/i);
      const derivedMobType = (mobTypeMatch ? mobTypeMatch[1].trim() : name)
        .toLowerCase()
        .replace(/\s+/g, "_");
      const npcData = getNPCById(derivedMobType);
      const fallbackModelPath = npcData?.appearance.modelPath || null;

      // CRITICAL: Use server's model path if provided, only derive from NPC data as fallback
      const networkModel = (data as { model?: string }).model;
      const finalModelPath = networkModel || fallbackModelPath;

      // Get scale from network data (sent by server from manifest)
      // Handle both object format {x,y,z} from getNetworkData and array [x,y,z] from serialize
      const rawScale = (
        data as {
          scale?:
            { x: number; y: number; z: number } | [number, number, number];
        }
      ).scale;
      let finalScale = { x: 1, y: 1, z: 1 };
      if (rawScale) {
        if (Array.isArray(rawScale)) {
          finalScale = { x: rawScale[0], y: rawScale[1], z: rawScale[2] };
        } else {
          finalScale = rawScale;
        }
      }

      // Extract mob data sent from server (see MobEntity.serialize())
      const networkData = data as {
        level?: number;
        currentHealth?: number;
        maxHealth?: number;
        mobType?: string;
        aiState?: MobAIState;
        targetPlayerId?: string | null;
      };
      const mobLevel = networkData.level || 1;
      const mobCurrentHealth = networkData.currentHealth || 100;
      const mobMaxHealth = networkData.maxHealth || 100;
      const mobType = networkData.mobType || derivedMobType;

      const mobConfig: MobEntityConfig = {
        id: data.id,
        name: name,
        type: EntityType.MOB,
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
        rotation: {
          x: quaternionArray[0],
          y: quaternionArray[1],
          z: quaternionArray[2],
          w: quaternionArray[3],
        },
        scale: finalScale,
        visible: true,
        interactable: true,
        interactionType: InteractionType.ATTACK,
        interactionDistance: 5,
        description: name,
        model: finalModelPath,
        // Use server-provided mob data, with sensible defaults
        mobType: mobType,
        level: mobLevel,
        currentHealth: mobCurrentHealth,
        maxHealth: mobMaxHealth,
        attack: 1, // Default attack level for accuracy
        attackPower: 10,
        defense: 2,
        defenseBonus: 0, // Default no armor
        attackSpeedTicks: 4,
        moveSpeed: 3.0, // Walking speed (matches player walk)
        aggressive: true, // Default to aggressive for backwards compatibility
        retaliates: true, // Default to retaliating for backwards compatibility
        attackable: true, // Default to attackable for backwards compatibility
        movementType: "wander", // Default to wander for backwards compatibility
        aggroRange: 15.0, // 15 meters detection range
        combatRange: 1.5, // 1.5 meters melee range
        wanderRadius: 10, // 10 meter wander radius from spawn (classic fantasy MMORPG-style)
        xpReward: 10,
        lootTable: [],
        respawnTime: 300000,
        spawnPoint: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
        aiState: networkData.aiState || MobAIState.IDLE,
        lastAttackTime: 0,
        properties: {
          movementComponent: null,
          combatComponent: null,
          healthComponent: null,
          visualComponent: null,
          health: { current: mobCurrentHealth, max: mobMaxHealth },
          level: mobLevel,
        },
        targetPlayerId: networkData.targetPlayerId || null,
        deathTime: null,
      };

      // Construct specialized mob entity so it can load its 3D model on the client
      // MobEntityConfig is compatible with MobEntity constructor
      const MobEntityClass = getEntityType("mob")!;
      const entity = new MobEntityClass(this.world, mobConfig);
      this.items.set(entity.id, entity);

      // Initialize entity if it has an init method
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "item") {
      // Client-side: build a real ItemEntity from snapshot data so models load
      const positionArray = (data.position || [0, 0, 0]) as [
        number,
        number,
        number,
      ];
      const quaternionArray = (data.quaternion || [0, 0, 0, 1]) as [
        number,
        number,
        number,
        number,
      ];
      const name = data.name || "Item";

      // Extract itemId from network data (ItemEntity.getNetworkData() puts it at top level)
      const networkData = data as Record<string, unknown>;
      const itemId = (networkData.itemId as string) || data.id;
      const itemType = (networkData.itemType as string) || "misc";
      const quantity = (networkData.quantity as number) || 1;
      const stackable = (networkData.stackable as boolean) || false;
      const value = (networkData.value as number) || 0;
      const weight = (networkData.weight as number) || 0;
      const rarity = (networkData.rarity as string) || "common";
      const modelPath = (networkData.model as string) || null;
      const modelScale = networkData.modelScale as number | undefined;
      const groundOffset = networkData.groundOffset as number | undefined;
      const networkProperties =
        networkData.properties && typeof networkData.properties === "object"
          ? (networkData.properties as Record<string, unknown>)
          : {};
      const custodyPolicy =
        (networkData.custodyPolicy as string | undefined) ??
        (networkProperties.custodyPolicy as string | undefined);
      const custodySourceId =
        (networkData.custodySourceId as string | undefined) ??
        (networkProperties.custodySourceId as string | undefined);
      const pickupEnabled =
        networkData.interactable !== false &&
        custodyPolicy !== "display_only" &&
        custodyPolicy !== "diagnostic_only";

      const itemConfig: ItemEntityConfig = {
        id: data.id,
        name: name,
        type: EntityType.ITEM,
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
        rotation: {
          x: quaternionArray[0],
          y: quaternionArray[1],
          z: quaternionArray[2],
          w: quaternionArray[3],
        },
        scale: { x: 1, y: 1, z: 1 },
        visible: true,
        interactable: pickupEnabled,
        interactionType: pickupEnabled ? InteractionType.PICKUP : null,
        interactionDistance: 2,
        description: name,
        model: modelPath,
        // ItemEntityConfig required fields
        itemId: itemId,
        itemType: itemType,
        quantity: quantity,
        stackable: stackable,
        value: value,
        weight: weight,
        rarity: (rarity as ItemRarity) || ItemRarity.COMMON,
        requirements: { level: 1 },
        effects: [],
        armorSlot: null,
        examine: "",
        modelPath: modelPath || "",
        iconPath: "",
        healAmount: 0,
        modelScale: modelScale,
        groundOffset: groundOffset,
        properties: {
          movementComponent: null,
          combatComponent: null,
          healthComponent: null,
          visualComponent: null,
          health: { current: 1, max: 1 },
          level: 1,
          // ItemEntityProperties required fields
          itemId: itemId,
          custodyPolicy: custodyPolicy as
            "durable_ground" | "display_only" | "diagnostic_only" | undefined,
          custodySourceId,
          harvestable: false,
          dialogue: [],
          quantity: quantity,
          stackable: stackable,
          value: value,
          weight: weight,
          rarity: (rarity as ItemRarity) || ItemRarity.COMMON,
        },
      };

      const ItemEntityClass = getEntityType("item")!;
      const entity = new ItemEntityClass(this.world, itemConfig);
      this.items.set(entity.id, entity);

      // Initialize entity if it has an init method
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "npc") {
      // Client-side: build a real NPCEntity from snapshot data so models load
      const positionArray = (data.position || [0, 0, 0]) as [
        number,
        number,
        number,
      ];
      const quaternionArray = (data.quaternion || [0, 0, 0, 1]) as [
        number,
        number,
        number,
        number,
      ];

      // Use network data if available, otherwise derive from name
      const name = data.name || "NPC";
      const networkData = data as {
        npcType?: string;
        npcId?: string;
        storeId?: string;
        services?: string[];
      };

      // Use npcType from network data, otherwise derive from name prefix
      let derivedNPCType: NPCType = NPCType.QUEST_GIVER;
      if (networkData.npcType) {
        // Map string to NPCType enum
        if (networkData.npcType === "bank") derivedNPCType = NPCType.BANK;
        else if (networkData.npcType === "store")
          derivedNPCType = NPCType.STORE;
        else if (networkData.npcType === "trainer")
          derivedNPCType = NPCType.TRAINER;
        else if (networkData.npcType === "quest_giver")
          derivedNPCType = NPCType.QUEST_GIVER;
      } else {
        // Fallback: derive from name prefix
        const npcTypeMatch = name.match(/^(Bank|Store|Trainer|Quest):/i);
        if (npcTypeMatch) {
          const prefix = npcTypeMatch[1].toLowerCase();
          if (prefix === "bank") derivedNPCType = NPCType.BANK;
          else if (prefix === "store") derivedNPCType = NPCType.STORE;
          else if (prefix === "trainer") derivedNPCType = NPCType.TRAINER;
        }
      }

      // CRITICAL: Use npcId from network data (manifest ID like "bank_clerk")
      // NOT data.id (entity instance ID like "npc_bank_clerk_123")
      const npcId = networkData.npcId || data.id;
      const services = networkData.services || [];
      const questIds = (networkData as { questIds?: string[] }).questIds;
      // CRITICAL: Use model from network data for NPC model loading
      const modelPath = (networkData as { model?: string }).model || null;

      const npcConfig: NPCEntityConfig = {
        id: data.id,
        name: name,
        type: EntityType.NPC,
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
        rotation: {
          x: quaternionArray[0],
          y: quaternionArray[1],
          z: quaternionArray[2],
          w: quaternionArray[3],
        },
        scale: { x: 1, y: 1, z: 1 },
        visible: true,
        interactable: true,
        interactionType: InteractionType.TALK,
        interactionDistance: 3,
        description: name,
        model: modelPath, // Use model path from network data
        // Use network data for NPCEntity fields
        npcType: derivedNPCType,
        npcId: npcId,
        storeId: networkData.storeId,
        dialogueLines: ["Hello there!"],
        services: services,
        questIds: questIds,
        inventory: [],
        skillsOffered: [],
        questsAvailable: [],
        properties: {
          movementComponent: null,
          combatComponent: null,
          healthComponent: null,
          visualComponent: null,
          health: { current: 100, max: 100 },
          level: 1,
          npcComponent: {
            behavior: NPCBehavior.FRIENDLY,
            state: NPCState.IDLE,
            currentTarget: null,
            spawnPoint: {
              x: positionArray[0],
              y: positionArray[1],
              z: positionArray[2],
            },
            wanderRadius: 0,
            aggroRange: 0,
            isHostile: false,
            combatLevel: 1,
            aggressionLevel: 0,
            dialogueLines: ["Hello there!"],
            dialogue: null,
            services: services, // Use services from network data
          },
          dialogue: [],
          shopInventory: [],
          questGiver: false,
        },
      };

      // Construct specialized NPC entity so it can load its 3D model on the client when available
      // NPCEntityConfig is compatible with NPCEntity constructor
      const NPCEntityClass = getEntityType("npc")!;
      const entity = new NPCEntityClass(this.world, npcConfig);
      this.items.set(entity.id, entity);

      // Initialize entity if it has an init method
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "resource") {
      // Client-side: build a real ResourceEntity from snapshot data
      const positionArray = (data.position || [0, 0, 0]) as [
        number,
        number,
        number,
      ];
      const quaternionArray = (data.quaternion || [0, 0, 0, 1]) as [
        number,
        number,
        number,
        number,
      ];

      const resourceConfig: ResourceEntityConfig = {
        id: data.id,
        name: data.name || "Resource",
        type: EntityType.RESOURCE,
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
        rotation: {
          x: quaternionArray[0],
          y: quaternionArray[1],
          z: quaternionArray[2],
          w: quaternionArray[3],
        },
        scale: { x: 1, y: 1, z: 1 },
        visible: true,
        interactable: true,
        interactionType: InteractionType.GATHER,
        interactionDistance:
          (data as { interactionDistance?: number }).interactionDistance || 3,
        description:
          (data as { description?: string }).description || "A resource",
        model: (data as { model?: string }).model || null,
        properties: {
          movementComponent: null,
          combatComponent: null,
          healthComponent: null,
          visualComponent: null,
          health: { current: 1, max: 1 },
          level: 1,
          resourceType: ResourceType.TREE,
          harvestable: true,
          respawnTime: 60000,
          toolRequired: "none",
          skillRequired: "none",
          xpReward: 10,
        },
        // Map resourceType string to ResourceType enum
        // Manifest uses: "tree", "ore", "fishing_spot"
        // Enum expects: "tree", "mining_rock", "fishing_spot"
        resourceType:
          (data as { resourceType?: string }).resourceType === "tree"
            ? ResourceType.TREE
            : (data as { resourceType?: string }).resourceType ===
                "fishing_spot"
              ? ResourceType.FISHING_SPOT
              : (data as { resourceType?: string }).resourceType ===
                    "mining_rock" ||
                  (data as { resourceType?: string }).resourceType === "ore"
                ? ResourceType.MINING_ROCK
                : ResourceType.TREE,
        resourceId:
          (data as { resourceId?: string }).resourceId || "tree_normal",
        harvestSkill:
          (data as { harvestSkill?: string }).harvestSkill || "woodcutting",
        requiredLevel: (data as { requiredLevel?: number }).requiredLevel || 1,
        harvestTime: (data as { harvestTime?: number }).harvestTime || 3000,
        harvestYield:
          (
            data as {
              harvestYield?: Array<{
                itemId: string;
                quantity: number;
                chance: number;
              }>;
            }
          ).harvestYield || [],
        respawnTime: (data as { respawnTime?: number }).respawnTime || 60000,
        depleted: (data as { depleted?: boolean }).depleted || false,
        lastHarvestTime: 0,
        modelScale: (data as { modelScale?: number }).modelScale,
        depletedModelScale: (data as { depletedModelScale?: number })
          .depletedModelScale,
        depletedModelPath: (data as { depletedModelPath?: string })
          .depletedModelPath,
        procgenPreset: (data as { procgenPreset?: string }).procgenPreset,
        modelVariants: (data as { modelVariants?: string[] }).modelVariants,
      };

      const ResourceEntityClass = getEntityType("resource")!;
      const entity = new ResourceEntityClass(this.world, resourceConfig);
      this.items.set(entity.id, entity);

      // Initialize entity
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "headstone") {
      // Client-side: build a real HeadstoneEntity from snapshot data
      const positionArray = (data.position || [0, 0, 0]) as [
        number,
        number,
        number,
      ];
      const quaternionArray = (data.quaternion || [0, 0, 0, 1]) as [
        number,
        number,
        number,
        number,
      ];
      const name = data.name || "Corpse";

      // Extract headstone data from network data
      const networkData = data as { headstoneData?: HeadstoneData };
      const headstoneData: HeadstoneData = networkData.headstoneData || {
        playerId: data.id,
        playerName: name,
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
        deathTime: Date.now(),
        deathMessage: "Unknown cause of death",
        itemCount: 0,
        items: [],
        despawnTime: Date.now() + 900000, // 15 minutes default
      };

      const headstoneConfig: HeadstoneEntityConfig = {
        id: data.id,
        name: name,
        type: EntityType.HEADSTONE,
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
        rotation: {
          x: quaternionArray[0],
          y: quaternionArray[1],
          z: quaternionArray[2],
          w: quaternionArray[3],
        },
        scale: { x: 1, y: 1, z: 1 },
        visible: true,
        interactable: true,
        interactionType: InteractionType.LOOT,
        interactionDistance: 2,
        description: headstoneData.deathMessage || "A corpse",
        model: null,
        properties: {
          movementComponent: null,
          combatComponent: null,
          healthComponent: null,
          visualComponent: null,
          health: { current: 1, max: 1 },
          level: 1,
        },
        headstoneData: headstoneData,
      };

      const HeadstoneEntityClass = getEntityType("headstone")!;
      const entity = new HeadstoneEntityClass(this.world, headstoneConfig);
      this.items.set(entity.id, entity);

      // Initialize entity if it has an init method
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "bank") {
      // Build BankEntity from network data (similar to HeadstoneEntity handling)
      const positionArray = (data.position || [0, 40, -25]) as [
        number,
        number,
        number,
      ];
      const quaternionArray = (data.quaternion || [0, 0, 0, 1]) as [
        number,
        number,
        number,
        number,
      ];
      const name = data.name || "Bank";
      const networkData = data as { properties?: { bankId?: string } };

      const bankConfig: BankEntityConfig = {
        id: data.id,
        name: name,
        type: EntityType.BANK,
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
        rotation: {
          x: quaternionArray[0],
          y: quaternionArray[1],
          z: quaternionArray[2],
          w: quaternionArray[3],
        },
        scale: { x: 1, y: 1, z: 1 },
        visible: true,
        interactable: true,
        interactionType: InteractionType.BANK,
        interactionDistance: 3,
        description: "A secure place to store your items.",
        model: null,
        properties: {
          movementComponent: null,
          combatComponent: null,
          healthComponent: null,
          visualComponent: null,
          health: { current: 1, max: 1 },
          level: 1,
          bankId: networkData.properties?.bankId || "spawn_bank",
        },
      };

      const BankEntityClass = getEntityType("bank")!;
      const entity = new BankEntityClass(this.world, bankConfig);
      this.items.set(entity.id, entity);

      // Initialize entity if it has an init method
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "furnace") {
      // Build FurnaceEntity from network data
      const positionArray = (data.position || [0, 40, 15]) as [
        number,
        number,
        number,
      ];
      const name = data.name || "Furnace";

      const furnaceConfig: FurnaceEntityConfig & { type: string } = {
        id: data.id,
        name: name,
        type: "furnace",
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
      };

      const FurnaceEntityClass = getEntityType("furnace")!;
      const entity = new FurnaceEntityClass(
        this.world,
        furnaceConfig as unknown as EntityData,
      );
      this.items.set(entity.id, entity);

      // Initialize entity if it has an init method
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "anvil") {
      // Build AnvilEntity from network data
      const positionArray = (data.position || [0, 40, 15]) as [
        number,
        number,
        number,
      ];
      const name = data.name || "Anvil";

      const anvilConfig: AnvilEntityConfig & { type: string } = {
        id: data.id,
        name: name,
        type: "anvil",
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
      };

      const AnvilEntityClass = getEntityType("anvil")!;
      const entity = new AnvilEntityClass(
        this.world,
        anvilConfig as unknown as EntityData,
      );
      this.items.set(entity.id, entity);

      // Initialize entity if it has an init method
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "altar") {
      // Build AltarEntity from network data
      const positionArray = (data.position || [3, 40, -25]) as [
        number,
        number,
        number,
      ];
      const name = data.name || "Altar";

      const altarConfig: AltarEntityConfig & { type: string } = {
        id: data.id,
        name: name,
        type: "altar",
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
      };

      const AltarEntityClass = getEntityType("altar")!;
      const entity = new AltarEntityClass(
        this.world,
        altarConfig as unknown as EntityData,
      );
      this.items.set(entity.id, entity);

      // Initialize entity if it has an init method
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "runecrafting_altar") {
      // Build RunecraftingAltarEntity from network data
      const positionArray = (data.position || [0, 40, 0]) as [
        number,
        number,
        number,
      ];
      const runeType = (data.runeType as string) || "air";
      const name =
        data.name ||
        `${runeType.charAt(0).toUpperCase()}${runeType.slice(1)} Altar`;

      const rcAltarConfig: RunecraftingAltarEntityConfig = {
        id: data.id,
        name: name,
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
        runeType: (data.runeType as string) || "air",
      };

      const entity = new RunecraftingAltarEntity(this.world, rcAltarConfig);
      this.items.set(entity.id, entity);

      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else if (data.type === "range") {
      // Build RangeEntity from network data
      const positionArray = (data.position || [-17, 40, -13]) as [
        number,
        number,
        number,
      ];
      const name = data.name || "Cooking Range";

      const rangeConfig: RangeEntityConfig & { type: string } = {
        id: data.id,
        name: name,
        type: "range",
        position: {
          x: positionArray[0],
          y: positionArray[1],
          z: positionArray[2],
        },
      };

      const RangeEntityClass = getEntityType("range")!;
      const entity = new RangeEntityClass(
        this.world,
        rangeConfig as unknown as EntityData,
      );
      this.items.set(entity.id, entity);

      // Initialize entity if it has an init method
      if (entity.init) {
        (entity.init() as Promise<void>)?.catch((err) =>
          this.logger.error(`Entity ${entity.id} async init failed`, err),
        );
      }

      return entity;
    } else {
      // Use getEntityType to trigger lazy initialization
      // getEntityType("entity") always exists (it's GenericEntity)
      EntityClass = getEntityType(data.type) ?? getEntityType("entity")!;
    }

    // All entity constructors now accept EntityData
    const entity = new EntityClass(this.world, data, local);
    this.items.set(entity.id, entity);

    if (data.type === "player") {
      this.players.set(entity.id, entity as Player);

      const network = this.world.network || this.world.getSystem("network");

      // On client, emit enter events for remote players
      if (network?.isClient && data.owner !== network.id) {
        this.world.emit(EventType.PLAYER_JOINED, {
          playerId: entity.id,
          player: entity as PlayerLocal,
        });
      }

      // On server, emit PLAYER_REGISTERED for all player entities
      if (network?.isServer) {
        this.world.emit(EventType.PLAYER_REGISTERED, { playerId: entity.id });
      }

      // Set local player if this entity is owned by us
      if (data.owner === network?.id) {
        if (this.player) {
          console.warn(
            `[Entities] WARNING: Replacing existing local player ${this.player.id} with ${entity.id}!`,
          );
        }
        this.player = entity as Player;
        // Emit PLAYER_JOINED for local player so PlayerSystem can track them
        this.world.emit(EventType.PLAYER_JOINED, {
          playerId: entity.id,
          player: entity as PlayerLocal,
        });
        this.world.emit(EventType.PLAYER_REGISTERED, { playerId: entity.id });
      }
    }

    // Initialize the entity
    const initPromise = entity.init() as Promise<void>;
    if (initPromise) {
      initPromise
        .then(() => {})
        .catch((err) => {
          this.logger.error(
            `Entity ${entity.id} (type: ${data.type}) async init failed:`,
            err,
          );
          console.error(`[Entities] Entity ${entity.id} init() failed:`, err);
          // Error logged above
        });
    }

    return entity;
  }

  remove(id: string): boolean {
    const entity = this.items.get(id);
    if (!entity) {
      // Entity already removed - this is expected during:
      // - Duplicate removal calls (race condition)
      // - Client receiving entityRemoved for already-removed entity
      // - Cleanup during rapid interactions (spam clicking)
      // Silently return false - not an error condition
      return false;
    }

    // Broadcast entityRemoved to all clients BEFORE destroying (server-only)
    // This notifies clients to remove the entity from their local cache
    const network = this.world.network;
    if (network && network.isServer) {
      try {
        network.send("entityRemoved", id);
      } catch (error) {
        console.warn(`[Entities] Failed to send entityRemoved packet:`, error);
      }
    }

    if (entity.isPlayer) {
      this.players.delete(entity.id);
      this.emitTypedEvent("PLAYER_LEFT", { playerId: entity.id });
      // PLAYER_CLEANUP/PLAYER_UNREGISTERED are consumed by many server systems
      // (inventory, banking, processing, death state, etc.). Emit them when the
      // entity is actually removed so reconnect-grace sessions are not cleaned
      // prematurely.
      this.world.emit(EventType.PLAYER_CLEANUP, { playerId: entity.id });
      this.world.emit(EventType.PLAYER_UNREGISTERED, {
        id: entity.id,
        playerId: entity.id,
      });
    }

    entity.destroy(true);
    this.items.delete(id);
    this.removed.push(id);
    return true;
  }

  // TypeScript interface compliance method
  destroyEntity(entityId: string): boolean {
    return this.remove(entityId);
  }

  setHot(entity: Entity, hot: boolean): void {
    if (hot) {
      this.hot.add(entity);
    } else {
      this.hot.delete(entity);
    }
  }

  override fixedUpdate(delta: number): void {
    // Iterate Set directly instead of Array.from to avoid allocation each frame
    for (const entity of this.hot) {
      entity.fixedUpdate?.(delta);
    }
  }

  override update(delta: number): void {
    // Iterate Set directly instead of Array.from to avoid allocation each frame
    // Check frame budget periodically to prevent blocking when many entities are hot
    const frameBudget = this.world.frameBudget;
    let count = 0;
    for (const entity of this.hot) {
      // Check frame budget every 30 entities to avoid overhead
      if (
        count > 0 &&
        count % 30 === 0 &&
        frameBudget &&
        !frameBudget.hasTimeRemaining(1)
      ) {
        break; // Skip remaining entities this frame to maintain smoothness
      }
      entity.update(delta);
      count++;
    }
  }

  override lateUpdate(delta: number): void {
    // Iterate Set directly instead of Array.from to avoid allocation each frame
    for (const entity of this.hot) {
      entity.lateUpdate?.(delta);
    }

    // Update animated impostor manager for mob/NPC walking animations at distance
    // This advances the animation frame counter for all instanced animated impostors
    if (!this.world.isServer) {
      const animatedManager = AnimatedImpostorManager.getInstance(this.world);
      animatedManager.update(performance.now());
    }
  }

  serialize(): EntityData[] {
    const data: EntityData[] = [];
    this.items.forEach((entity) => {
      data.push(entity.serialize());
    });
    return data;
  }

  async deserialize(datas: EntityData[]): Promise<void> {
    for (const data of datas) {
      this.add(data);
    }
  }

  override destroy(): void {
    // Create array of IDs to avoid modifying map while iterating
    const entityIds = Array.from(this.items.keys());
    for (const id of entityIds) {
      this.remove(id);
    }

    this.items.clear();
    this.players.clear();
    this.hot.clear();
    this.removed = [];
  }

  // TypeScript interface compliance methods
  getLocalPlayer(): Player | null {
    return this.player || null;
  }

  getAll(): Entity[] {
    return Array.from(this.items.values());
  }

  getAllPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  // Alias for World.ts compatibility
  getPlayers(): Player[] {
    return this.getAllPlayers();
  }

  getRemovedIds(): string[] {
    const ids = [...new Set(this.removed)]; // Remove duplicates
    this.removed = [];
    return ids;
  }

  // Missing lifecycle methods
  postFixedUpdate(): void {
    // Add postLateUpdate calls for entities
    // Iterate Set directly instead of Array.from to avoid allocation each frame
    for (const entity of this.hot) {
      entity.postLateUpdate?.(0);
    }
  }
}
