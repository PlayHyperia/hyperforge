/**
 * EntityManager - Manages all entities in the world
 *
 * This system is responsible for:
 * - Creating and destroying entities
 * - Managing entity lifecycle
 * - Network synchronization
 * - Entity queries and lookups
 */

import { World } from "../../../core/World";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import { ticksToMs } from "../../../utils/game/CombatCalculations";
import { Entity, EntityConfig } from "../../../entities/Entity";
import { ItemEntity } from "../../../entities/world/ItemEntity";
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
  StarterChestEntity,
  type StarterChestEntityConfig,
} from "../../../entities/world/StarterChestEntity";
import {
  RangeEntity,
  type RangeEntityConfig,
} from "../../../entities/world/RangeEntity";
import { MobEntity } from "../../../entities/npc/MobEntity";
import { NPCEntity } from "../../../entities/npc/NPCEntity";
import { ResourceEntity } from "../../../entities/world/ResourceEntity";
import type {
  ItemEntityConfig,
  ItemSpawnData,
  MobEntityConfig,
  MobSpawnData,
  NPCEntityConfig,
  NPCEntityProperties as _NPCEntityProperties,
  NPCSpawnData as _NPCSpawnData,
  ResourceEntityConfig,
  ResourceEntityProperties as _ResourceEntityProperties,
  ResourceSpawnData as _ResourceSpawnData,
  HeadstoneEntityConfig,
  BankEntityConfig,
} from "../../../types/entities";
import {
  EntityType,
  InteractionType,
  ItemRarity,
  MobAIState,
  NPCType,
  ResourceType,
  DeathState,
} from "../../../types/entities";
import { NPCBehavior, NPCState } from "../../../types/core/core";
import { EventType } from "../../../types/events";
// NOTE: Import directly to avoid circular dependency through barrel file
// The barrel imports combat which imports MobEntity which extends Entity
import { TerrainSystem } from "../world/TerrainSystem";
import { isPositionInsideDuelArenaZone } from "../../../data/duel-manifest";
import { SystemBase } from "../infrastructure/SystemBase";
import type { GroundItemSystem } from "../economy/GroundItemSystem";
import { getItem } from "../../../data/items";
import { getNPCById } from "../../../data/npcs";
import { getExternalNPC } from "../../../utils/ExternalAssetUtils";
import { SpatialEntityRegistry } from "./SpatialEntityRegistry";
import { DISTANCE_CONSTANTS } from "../../../constants/GameConstants";
import {
  NetworkingComputeContext,
  isNetworkingComputeAvailable,
} from "../../../utils/compute";

export class EntityManager extends SystemBase {
  private entities = new Map<string, Entity>();
  private entitiesNeedingUpdate = new Set<string>();
  private networkDirtyEntities = new Set<string>();
  private nextEntityId = 1;

  /** Spatial partitioning registry for efficient entity queries */
  private spatialRegistry = new SpatialEntityRegistry();

  /** Type-indexed entity cache for O(1) getEntitiesByType queries */
  private entitiesByType = new Map<string, Set<string>>();

  /** Broadcast distance squared for network filtering */
  private readonly BROADCAST_DISTANCE_SQ =
    DISTANCE_CONSTANTS.SIMULATION_SQ.NETWORK_BROADCAST;

  // PERFORMANCE: Progressive entity update system to prevent main thread blocking
  /** Minimum entities to update per frame */
  private readonly MIN_ENTITY_UPDATES_PER_FRAME = 100;
  /** Upper bound for adaptive per-frame entity updates */
  private readonly MAX_ENTITY_UPDATES_PER_FRAME = 1200;
  /** Desired minimum per-entity update frequency */
  private readonly TARGET_ENTITY_UPDATE_HZ = 20;
  /** Expected simulation rates used for adaptive budget sizing */
  private readonly CLIENT_TARGET_FPS = 60;
  private readonly SERVER_TARGET_FPS = 30;
  /** Bounds scanning work when many entities are skipped/culled */
  private readonly MAX_ENTITY_INSPECTION_MULTIPLIER = 4;
  /** Minimum network updates to send per frame */
  private readonly MIN_NETWORK_UPDATES_PER_FRAME = 50;
  /** Upper bound for adaptive network update flushes */
  private readonly MAX_NETWORK_UPDATES_PER_FRAME = 1000;
  /** Aim to flush dirty entities within this many frames */
  private readonly NETWORK_FLUSH_TARGET_FRAMES = 3;
  /** Refresh active entity cache every N frames on server */
  private readonly ACTIVE_ENTITY_CACHE_REFRESH_INTERVAL_FRAMES = 3;
  /** Rotation index for round-robin entity processing */
  private _entityUpdateRotationIndex = 0;
  /** Cached array for iteration (avoids Set->Array conversion each frame) */
  private _entityUpdateArray: string[] = [];
  /** Server-only active entity update array (active chunks + round robin) */
  private _serverActiveUpdateArray: string[] = [];
  /** Flag to track if entity array needs refresh */
  private _entityArrayDirty = true;

  // OPTIMIZATION: Reusable Set for active entity checks (avoids allocation every frame)
  /** Cached Set for active entity IDs - reused each frame */
  private _activeEntityIdsCache = new Set<string>();
  /** Frame when active entities were last cached */
  private _activeEntitiesCacheFrame = -1;

  // OPTIMIZATION: Pre-allocated buffers for getEntitiesByType (avoids array allocation per call)
  /** Cached arrays for each entity type - reused across calls */
  private readonly _entitiesByTypeBuffers = new Map<string, Entity[]>();
  /** Pre-allocated buffer for getInterestedPlayers (avoids allocation per call) */
  private readonly _interestedPlayersBuffer: string[] = [];

  // OPTIMIZATION: Pre-allocated packet buffers for sendNetworkUpdates (avoids per-entity allocations)
  // These buffers are reused each iteration - data is serialized immediately before reuse
  /** Reusable position array [x, y, z] */
  private readonly _packetPositionBuffer: [number, number, number] = [0, 0, 0];
  /** Reusable quaternion array [x, y, z, w] */
  private readonly _packetQuaternionBuffer: [number, number, number, number] = [
    0, 0, 0, 1,
  ];
  /** Reusable update packet object */
  private readonly _updatePacketBuffer: {
    id: string;
    changes: Record<string, unknown>;
  } = { id: "", changes: {} };
  /** Reusable changes object */
  private readonly _changesBuffer: Record<string, unknown> = {};

  /** Network stats for monitoring interest filtering effectiveness */
  private networkStats = {
    interestFilteredUpdates: 0,
    broadcastUpdates: 0,
    totalPlayersNotified: 0,
    lastResetTime: Date.now(),
  };

  /** GPU compute context for accelerated interest filtering (server-side) */
  private networkingCompute: NetworkingComputeContext | null = null;
  private gpuComputeAvailable = false;

  constructor(world: World) {
    super(world, {
      name: "entity-manager",
      dependencies: {
        required: [], // Entity manager is foundational and can work independently
        optional: ["client-graphics", "database"], // Better with graphics and persistence
      },
      autoCleanup: false,
    });
  }

  async init(): Promise<void> {
    // The World.register method already registers this system on the world object
    // No need for manual registration

    // Set up type-safe event subscriptions for entity management (16+ listeners!)
    // NOTE: We don't subscribe to ENTITY_SPAWNED here as that would create a circular loop
    // ENTITY_SPAWNED is emitted BY this system after spawning, not TO request spawning
    this.subscribe(EventType.ENTITY_DEATH, (data) =>
      this.handleEntityDestroy(
        data as { entityId: string; killedBy?: string; entityType?: string },
      ),
    );
    this.subscribe(EventType.ENTITY_INTERACT, (data) =>
      this.handleInteractionRequest({
        entityId: (data as { entityId: string }).entityId,
        playerId: (data as { playerId: string }).playerId,
        interactionType: (data as { action?: string }).action || "interact",
      }),
    );
    this.subscribe(EventType.ENTITY_MOVE_REQUEST, (data) =>
      this.handleMoveRequest(
        data as {
          entityId: string;
          position: { x: number; y: number; z: number };
        },
      ),
    );
    this.subscribe(EventType.ENTITY_PROPERTY_REQUEST, (data) =>
      this.handlePropertyRequest({
        entityId: (data as { entityId: string }).entityId,
        propertyName: (data as { property: string }).property,
        value: (data as { value: unknown }).value,
      }),
    );

    // Listen for specific entity type spawn requests
    // NOTE: Don't subscribe to ITEM_SPAWNED - that's an event we emit AFTER spawning, not a spawn request
    // Subscribing to it would cause duplicate spawns!
    // NOTE: Don't subscribe to ITEM_PICKUP - InventorySystem handles that and destroys the entity
    // Subscribe to ITEM_SPAWN for dropped/spawned items
    this.subscribe(EventType.ITEM_SPAWN, (data) => {
      const typedData = data as {
        itemId?: string;
        itemType?: string;
        position: { x: number; y: number; z: number };
        quantity?: number;
        droppedBy?: string;
      };
      const itemIdToUse =
        typedData.itemId || typedData.itemType || "unknown_item";
      void this.handleItemSpawn({
        customId: `item_${itemIdToUse}_${Date.now()}`,
        name: itemIdToUse,
        position: typedData.position,
        itemId: itemIdToUse,
        quantity: typedData.quantity || 1,
        droppedBy: typedData.droppedBy,
      }).catch((error) => {
        console.error(
          `[EntityManager] Refused ITEM_SPAWN without durable ground custody: ${String(error)}`,
        );
      });
    });
    // EntityManager should handle spawn REQUESTS, not completed spawns
    this.subscribe(EventType.MOB_NPC_SPAWN_REQUEST, (data) => {
      const typedData = data as {
        mobType: string;
        position: { x: number; y: number; z: number };
        level?: number;
        customId?: string;
      };
      this.handleMobSpawn({
        mobType: typedData.mobType,
        position: typedData.position,
        level: typedData.level || 1,
        customId: typedData.customId || `mob_${Date.now()}`,
        name: typedData.mobType,
      });
    });
    this.subscribe<{
      npcId: string;
      name: string;
      type: string;
      position: { x: number; y: number; z: number };
      services?: string[];
      modelPath?: string;
      storeId?: string;
    }>(EventType.NPC_SPAWN_REQUEST, (data) => this.handleNPCSpawnRequest(data));
    this.subscribe(EventType.MOB_NPC_ATTACKED, (data) => {
      const typedData = data as {
        mobId: string;
        damage: number;
        attackerId: string;
      };
      this.handleMobAttacked({
        entityId: typedData.mobId,
        damage: typedData.damage,
        attackerId: typedData.attackerId,
      });
    });
    this.subscribe(EventType.COMBAT_MOB_NPC_ATTACK, (data) => {
      const typedData = data as { mobId: string; targetId: string };
      this.handleMobAttack({
        mobId: typedData.mobId,
        targetId: typedData.targetId,
        damage: 0,
      });
    });
    // RESOURCE_GATHERED has different structure in EventMap
    // Map the string resourceType to the enum value
    this.subscribe(EventType.RESOURCE_GATHERED, (data) => {
      const typedData = data as { resourceType: string };
      const resourceTypeMap: Record<string, ResourceType> = {
        tree: ResourceType.TREE,
        rock: ResourceType.MINING_ROCK,
        ore: ResourceType.MINING_ROCK,
        herb: ResourceType.TREE, // Map herb to tree for now
        fish: ResourceType.FISHING_SPOT,
      };
      this.handleResourceSpawn({
        resourceId: `resource_${Date.now()}`,
        resourceType: resourceTypeMap[typedData.resourceType] || "tree",
        position: { x: 0, y: 0, z: 0 },
      });
    });
    this.subscribe(EventType.RESOURCE_HARVEST, (data) => {
      const typedData = data as {
        resourceId: string;
        playerId: string;
        success: boolean;
      };
      this.handleResourceHarvest({
        entityId: typedData.resourceId,
        playerId: typedData.playerId,
        amount: typedData.success ? 1 : 0,
      });
    });
    // NPC_INTERACTION has different structure in EventMap
    this.subscribe(EventType.NPC_INTERACTION, (data) => {
      const typedData = data as { npcId: string };
      this.handleNPCSpawn({
        customId: typedData.npcId,
        name: "NPC",
        npcType: NPCType.QUEST_GIVER, // Default to quest giver
        position: { x: 0, y: 0, z: 0 },
        model: null,
        dialogues: [],
        questGiver: true,
        shopkeeper: false,
        bankTeller: false,
      });
    });
    this.subscribe(EventType.NPC_DIALOGUE, (data) => {
      const typedData = data as {
        npcId: string;
        playerId: string;
        dialogueId: string;
      };
      this.handleNPCDialogue({
        entityId: typedData.npcId,
        playerId: typedData.playerId,
        dialogueId: typedData.dialogueId,
      });
    });

    // Network sync for clients
    if (this.world.isClient) {
      this.subscribe(EventType.CLIENT_CONNECT, (data) => {
        const typedData = data as { clientId: string };
        this.handleClientConnect({ playerId: typedData.clientId });
      });
      this.subscribe(EventType.CLIENT_DISCONNECT, (data) => {
        const typedData = data as { clientId: string };
        this.handleClientDisconnect({ playerId: typedData.clientId });
      });
    }
  }

  /**
   * Start method - called after init
   * Note: Stations are now spawned by StationSpawnerSystem from world-areas.json
   */
  async start(): Promise<void> {
    // Server spawns static world objects (banks, etc.)
    // Note: Some stations are also spawned by StationSpawnerSystem from world-areas.json
    if (this.world.isServer) {
      await this.spawnWorldObjects();

      // Initialize GPU compute for accelerated interest filtering (server-side only)
      if (isNetworkingComputeAvailable()) {
        this.networkingCompute = new NetworkingComputeContext({
          minInterestPairsForGPU: 500, // 10 entities × 50 players
          minAggroPairsForGPU: 500,
        });
        try {
          this.gpuComputeAvailable =
            await this.networkingCompute.initializeStandalone();
          if (this.gpuComputeAvailable) {
            console.log(
              "[EntityManager] GPU compute initialized for interest filtering",
            );
          }
        } catch (error) {
          console.warn(
            "[EntityManager] GPU compute initialization failed:",
            error,
          );
          this.gpuComputeAvailable = false;
        }
      }
    }
  }

  /**
   * Spawn static world objects
   *
   * NOTE: All stations (bank, furnace, anvil, altar, range) are now
   * spawned by StationSpawnerSystem from world-areas.json manifest.
   * This method is kept for potential future non-station world objects.
   */
  private async spawnWorldObjects(): Promise<void> {
    // All stations are now manifest-driven via StationSpawnerSystem
    // Nothing to spawn here currently
  }

  update(deltaTime: number): void {
    // SERVER: Only update entities in active chunks (near players)
    // CLIENT: Update all entities (client only has entities in visible range anyway)
    if (this.world.isServer) {
      this.updateServerEntities(deltaTime);
    } else {
      this.updateClientEntities(deltaTime);
    }
  }

  private getEntityUpdateBudget(entityCount: number): {
    maxUpdates: number;
    maxInspections: number;
  } {
    if (entityCount <= 0) {
      return { maxUpdates: 0, maxInspections: 0 };
    }

    const targetFps = this.world.isServer
      ? this.SERVER_TARGET_FPS
      : this.CLIENT_TARGET_FPS;
    const desiredUpdates = Math.ceil(
      (entityCount * this.TARGET_ENTITY_UPDATE_HZ) / targetFps,
    );

    const maxUpdates = Math.min(
      entityCount,
      Math.max(
        this.MIN_ENTITY_UPDATES_PER_FRAME,
        Math.min(this.MAX_ENTITY_UPDATES_PER_FRAME, desiredUpdates),
      ),
    );

    const maxInspections = Math.min(
      entityCount,
      Math.max(maxUpdates, maxUpdates * this.MAX_ENTITY_INSPECTION_MULTIPLIER),
    );

    return { maxUpdates, maxInspections };
  }

  private getNetworkUpdateBudget(dirtyCount: number): number {
    if (dirtyCount <= 0) return 0;

    const desiredPerFrame = Math.ceil(
      dirtyCount / this.NETWORK_FLUSH_TARGET_FRAMES,
    );
    return Math.min(
      dirtyCount,
      Math.max(
        this.MIN_NETWORK_UPDATES_PER_FRAME,
        Math.min(this.MAX_NETWORK_UPDATES_PER_FRAME, desiredPerFrame),
      ),
    );
  }

  private refreshActiveEntityCacheIfNeeded(): Set<string> {
    const frame = this.world.frame ?? 0;
    const shouldRefresh =
      this._activeEntitiesCacheFrame < 0 ||
      frame - this._activeEntitiesCacheFrame >=
        this.ACTIVE_ENTITY_CACHE_REFRESH_INTERVAL_FRAMES ||
      this._entityArrayDirty;

    if (!shouldRefresh) {
      return this._activeEntityIdsCache;
    }

    this._activeEntityIdsCache.clear();
    for (const entityId of this.spatialRegistry.getActiveEntities()) {
      this._activeEntityIdsCache.add(entityId);
    }
    this._activeEntitiesCacheFrame = frame;
    return this._activeEntityIdsCache;
  }

  private syncEntityNetworkState(entityId: string, entity: Entity): void {
    if (!entity.networkDirty) return;

    this.networkDirtyEntities.add(entityId);
    entity.networkDirty = false;

    // Keep spatial index current for interest filtering and active chunk membership.
    if (this.world.isServer) {
      const pos = entity.position;
      this.spatialRegistry.updateEntityPosition(entityId, pos.x, pos.z);
    }
  }

  /**
   * Server-side entity update - only processes entities in active chunks
   * This significantly reduces CPU load when players are spread out
   *
   * OPTIMIZATION: Uses progressive updates to prevent main thread blocking.
   * Updates MAX_ENTITY_UPDATES_PER_FRAME entities per frame using round-robin rotation.
   * All entities still get updated, just spread across multiple frames.
   */
  private updateServerEntities(deltaTime: number): void {
    // Refresh cached entity array if needed
    if (this._entityArrayDirty) {
      this._entityUpdateArray = Array.from(this.entitiesNeedingUpdate);
      this._entityArrayDirty = false;
      // Reset rotation when array changes to ensure fair distribution
      this._entityUpdateRotationIndex = 0;
    }

    const activeEntityIds = this.refreshActiveEntityCacheIfNeeded();
    this._serverActiveUpdateArray.length = 0;
    for (const entityId of activeEntityIds) {
      if (this.entitiesNeedingUpdate.has(entityId)) {
        this._serverActiveUpdateArray.push(entityId);
      }
    }

    const entityArray = this._serverActiveUpdateArray;
    const entityCount = entityArray.length;
    if (entityCount === 0) {
      if (this.networkDirtyEntities.size > 0) {
        this.sendNetworkUpdates();
      }
      return;
    }

    // PERFORMANCE: Process entities in batches using round-robin
    // This ensures all entities get updated fairly, just spread across frames
    const frameBudget = this.world.frameBudget;
    const { maxUpdates, maxInspections } =
      this.getEntityUpdateBudget(entityCount);
    let updatesThisFrame = 0;
    let inspected = 0;

    // Start from where we left off last frame
    const startIndex = this._entityUpdateRotationIndex % entityCount;
    let i = startIndex;

    do {
      if (inspected >= maxInspections || updatesThisFrame >= maxUpdates) break;

      // Check frame budget every 20 entities to avoid overhead
      if (inspected > 0 && inspected % 20 === 0) {
        if (frameBudget && !frameBudget.hasTimeRemaining(2)) {
          break; // Over budget, continue next frame
        }
      }

      const entityId = entityArray[i];
      const entity = this.entities.get(entityId);

      if (entity) {
        entity.update(deltaTime);
        updatesThisFrame++;
        this.syncEntityNetworkState(entityId, entity);
      }

      // Move to next entity (wrap around)
      i = (i + 1) % entityCount;
      inspected++;
    } while (i !== startIndex);

    // Save rotation index for next frame
    this._entityUpdateRotationIndex = i;

    // Send network updates (also rate-limited)
    if (this.networkDirtyEntities.size > 0) {
      this.sendNetworkUpdates();
    }
  }

  /**
   * Client-side entity update - updates all entities
   * Client only receives entities in visible range from server
   *
   * OPTIMIZATION: Uses progressive updates with frame budget checks.
   * Visual smoothness is prioritized over updating all entities every frame.
   */
  private updateClientEntities(deltaTime: number): void {
    // Refresh cached entity array if needed
    if (this._entityArrayDirty) {
      this._entityUpdateArray = Array.from(this.entitiesNeedingUpdate);
      this._entityArrayDirty = false;
      this._entityUpdateRotationIndex = 0;
    }

    const entityArray = this._entityUpdateArray;
    const entityCount = entityArray.length;
    if (entityCount === 0) return;

    const frameBudget = this.world.frameBudget;
    const { maxUpdates, maxInspections } =
      this.getEntityUpdateBudget(entityCount);
    let updatesThisFrame = 0;
    let inspected = 0;

    // Start from where we left off last frame
    const startIndex = this._entityUpdateRotationIndex % entityCount;
    let i = startIndex;

    do {
      if (inspected >= maxInspections || updatesThisFrame >= maxUpdates) break;

      // Check frame budget periodically
      if (inspected > 0 && inspected % 20 === 0) {
        if (frameBudget && !frameBudget.hasTimeRemaining(1)) {
          break; // Over budget
        }
      }

      const entityId = entityArray[i];
      const entity = this.entities.get(entityId);
      if (entity) {
        entity.update(deltaTime);
        updatesThisFrame++;
      }

      i = (i + 1) % entityCount;
      inspected++;
    } while (i !== startIndex);

    // Save rotation index for next frame
    this._entityUpdateRotationIndex = i;
  }

  fixedUpdate(deltaTime: number): void {
    // Fixed update for physics
    // Use for-of instead of forEach to avoid callback allocation each frame
    for (const entity of this.entities.values()) {
      entity.fixedUpdate(deltaTime);
      if (this.world.isServer) {
        this.syncEntityNetworkState(entity.id, entity);
      }
    }
  }

  async spawnEntity(
    config: EntityConfig,
    options?: { suppressBroadcast?: boolean },
  ): Promise<Entity | null> {
    // CRITICAL: Only server should spawn entities
    // Clients receive entities via snapshot/network sync
    if (!this.world.isServer) {
      console.warn(
        `[EntityManager] Client attempted to spawn entity ${config.id || "unknown"} - blocked (entities come from server)`,
      );
      return null;
    }

    // Generate entity ID if not provided
    if (!config.id) {
      config.id = `entity_${this.nextEntityId++}`;
    }

    // Check if entity already exists
    if (this.entities.has(config.id)) {
      return this.entities.get(config.id) || null;
    }

    // VALIDATE config before creating entity
    if (
      !config.position ||
      !Number.isFinite(config.position.x) ||
      !Number.isFinite(config.position.y) ||
      !Number.isFinite(config.position.z)
    ) {
      throw new Error(
        `Invalid position for entity ${config.id}: ${JSON.stringify(config.position)}`,
      );
    }

    if (config.position.y < -200 || config.position.y > 2000) {
      throw new Error(
        `Entity spawn position out of range: Y=${config.position.y} (expected 0-100)`,
      );
    }

    // Keep duel arena floors clean of clutter and death remnants.
    if (
      isPositionInsideDuelArenaZone(config.position.x, config.position.z) &&
      (config.type === EntityType.ITEM || config.type === EntityType.HEADSTONE)
    ) {
      return null;
    }

    let entity: Entity;

    switch (config.type) {
      case "item":
        entity = new ItemEntity(this.world, config as ItemEntityConfig);
        break;
      case EntityType.HEADSTONE:
      case "headstone":
        entity = new HeadstoneEntity(
          this.world,
          config as HeadstoneEntityConfig,
        );
        break;
      case EntityType.BANK:
      case "bank":
        entity = new BankEntity(this.world, config as BankEntityConfig);
        break;
      case "mob":
        entity = new MobEntity(this.world, config as MobEntityConfig);
        break;
      case "resource":
        entity = new ResourceEntity(this.world, config as ResourceEntityConfig);
        break;
      case "npc":
        entity = new NPCEntity(this.world, config as NPCEntityConfig);
        break;
      case EntityType.FURNACE:
      case "furnace":
        entity = new FurnaceEntity(this.world, config as FurnaceEntityConfig);
        break;
      case EntityType.ANVIL:
      case "anvil":
        entity = new AnvilEntity(this.world, config as AnvilEntityConfig);
        break;
      case EntityType.ALTAR:
      case "altar":
        entity = new AltarEntity(this.world, config as AltarEntityConfig);
        break;
      case EntityType.RUNECRAFTING_ALTAR:
      case "runecrafting_altar":
        entity = new RunecraftingAltarEntity(
          this.world,
          config as unknown as RunecraftingAltarEntityConfig,
        );
        break;
      case EntityType.STARTER_CHEST:
      case "starter_chest":
        entity = new StarterChestEntity(
          this.world,
          config as StarterChestEntityConfig,
        );
        break;
      case EntityType.RANGE:
      case "range":
        entity = new RangeEntity(this.world, config as RangeEntityConfig);
        break;
      default:
        throw new Error(`[EntityManager] Unknown entity type: ${config.type}`);
    }

    // Initialize entity (this will throw if it fails)
    await entity.init();

    // Store entity
    this.entities.set(config.id, entity);
    this.entitiesNeedingUpdate.add(config.id);
    this._entityArrayDirty = true; // Mark for cache refresh

    // Update type index for O(1) getEntitiesByType queries
    let typeSet = this.entitiesByType.get(config.type);
    if (!typeSet) {
      typeSet = new Set();
      this.entitiesByType.set(config.type, typeSet);
    }
    typeSet.add(config.id);

    // Register with world entities system so other systems can find it
    this.world.entities.set(config.id, entity);

    // Register with spatial registry (server-side only)
    // This enables efficient spatial queries for entity updates and network filtering
    if (this.world.isServer) {
      this.spatialRegistry.addEntity(
        config.id,
        config.position.x,
        config.position.z,
        config.type,
        false,
      );
    }

    // Broadcast entityAdded to all clients (server-only)
    // Single broadcast point to prevent duplicate packets.
    // When suppressBroadcast is true, the caller is responsible for batching
    // and sending entities (e.g. ResourceSystem batches per-tile).
    if (this.world.isServer && !options?.suppressBroadcast) {
      const network = this.world.network;
      if (network && typeof network.send === "function") {
        try {
          network.send("entityAdded", entity.serialize());
        } catch (error) {
          console.warn(
            `[EntityManager] Failed to broadcast entity ${config.id}:`,
            error,
          );
        }
      }
    }

    // Emit spawn event using world.emit to avoid type mismatch
    this.emitTypedEvent(EventType.ENTITY_SPAWNED, {
      entityId: config.id,
      entityType: config.type,
      position: config.position,
      entityData: entity.getNetworkData(),
    });

    return entity;
  }

  /** Track entities currently being destroyed to prevent re-entrant calls */
  private destroyingEntities = new Set<string>();

  destroyEntity(entityId: string): boolean {
    // Guard against re-entrant destruction (prevents infinite loop)
    // This can happen when ENTITY_DEATH event triggers handleEntityDestroy
    // which calls destroyEntity again
    if (this.destroyingEntities.has(entityId)) {
      return false;
    }

    const entity = this.getEntity(entityId);
    if (!entity) {
      return false;
    }

    // Mark as being destroyed before any events are emitted
    this.destroyingEntities.add(entityId);

    try {
      // Send entityRemoved packet to all clients before destroying
      const network = this.world.network;
      if (network && network.isServer) {
        try {
          network.send("entityRemoved", entityId);
        } catch (error) {
          console.warn(
            `[EntityManager] Failed to send entityRemoved packet for ${entityId}:`,
            error,
          );
        }
      }

      // Emit destroy event BEFORE removing entity from tracking
      // This allows event handlers to still look up the entity if needed
      this.emitTypedEvent(EventType.ENTITY_DEATH, {
        entityId,
        entityType: entity.type,
      });

      // Call entity destroy method
      entity.destroy();
    } finally {
      // Always clean up the guard
      this.destroyingEntities.delete(entityId);
    }

    // Remove from tracking
    this.entities.delete(entityId);
    this.entitiesNeedingUpdate.delete(entityId);
    this.networkDirtyEntities.delete(entityId);
    this._entityArrayDirty = true; // Mark for cache refresh

    // Remove from type index
    const typeSet = this.entitiesByType.get(entity.type);
    if (typeSet) {
      typeSet.delete(entityId);
    }

    // Remove from spatial registry (server-side only)
    if (this.world.isServer) {
      this.spatialRegistry.removeEntity(entityId);
    }

    // Remove from world entities system
    this.world.entities.remove(entityId);

    return true;
  }

  getEntity(entityId: string): Entity | undefined {
    const entity = this.entities.get(entityId);
    if (entity) {
      return entity;
    }
    for (const e of this.entities.values()) {
      //console.log(`[EntityManager] Entity: ${e.id} - ${e.type} - ${entityId}, is same: ${e.id === entityId}`);
      if (e.id === entityId) {
        return e;
      }
    }
  }

  /**
   * Get all entities (for debugging and iteration)
   */
  getAllEntities(): Map<string, Entity> {
    return this.entities;
  }

  /**
   * Get entities near a position within broadcast distance
   * Used for initial entity sync when a player joins or moves into a new area
   *
   * @param x - World X position
   * @param z - World Z position
   * @param radius - Optional radius override (defaults to NETWORK_BROADCAST distance)
   * @returns Array of entities within range
   */
  getEntitiesNearPosition(x: number, z: number, radius?: number): Entity[] {
    const searchRadius = radius ?? Math.sqrt(this.BROADCAST_DISTANCE_SQ);
    const results = this.spatialRegistry.getEntitiesInRange(x, z, searchRadius);

    return results
      .map((r) => this.entities.get(r.entityId))
      .filter((e): e is Entity => e !== undefined);
  }

  /**
   * Get players who should receive updates about an entity at a given position
   * Used for interest-based network filtering
   *
   * @param entityX - Entity world X position
   * @param entityZ - Entity world Z position
   * @param entityType - Optional entity type for type-specific distances
   * @returns Array of player IDs who should receive the update
   */
  /**
   * Get players who should receive updates about an entity at a given position.
   * Returns a reusable internal buffer - callers must consume before the next call.
   */
  getInterestedPlayers(
    entityX: number,
    entityZ: number,
    entityType?: string,
  ): string[] {
    // Get type-specific distance or default
    let broadcastDistSq = this.BROADCAST_DISTANCE_SQ;
    if (entityType) {
      const typeDistances: Record<string, number> = {
        mob: DISTANCE_CONSTANTS.RENDER_SQ.MOB,
        npc: DISTANCE_CONSTANTS.RENDER_SQ.NPC,
        player: DISTANCE_CONSTANTS.RENDER_SQ.PLAYER,
        item: DISTANCE_CONSTANTS.RENDER_SQ.ITEM,
      };
      broadcastDistSq = typeDistances[entityType] ?? this.BROADCAST_DISTANCE_SQ;
    }

    // Get all player positions
    const playerPositions = this.spatialRegistry.getPlayerPositions();

    // PERF: Reuse buffer to avoid allocation per call
    const interestedPlayers = this._interestedPlayersBuffer;
    interestedPlayers.length = 0;

    // Check each player's distance to the entity
    for (const player of playerPositions) {
      const dx = entityX - player.x;
      const dz = entityZ - player.z;
      const distSq = dx * dx + dz * dz;

      if (distSq <= broadcastDistSq) {
        interestedPlayers.push(player.entityId);
      }
    }

    return interestedPlayers;
  }

  /**
   * Get all entities of a specific type.
   * OPTIMIZATION: Uses type-indexed cache for O(n) where n = entities of that type,
   * instead of O(total entities) linear scan.
   *
   * Returns a reusable internal buffer - callers must consume before the next call
   * with the same type. Do NOT store the returned array reference.
   */
  getEntitiesByType(type: string): Entity[] {
    const typeSet = this.entitiesByType.get(type);
    if (!typeSet || typeSet.size === 0) return [];

    // PERF: Reuse buffer per entity type to avoid allocation per call
    let buffer = this._entitiesByTypeBuffers.get(type);
    if (!buffer) {
      buffer = [];
      this._entitiesByTypeBuffers.set(type, buffer);
    }
    buffer.length = 0;

    for (const entityId of typeSet) {
      const entity = this.entities.get(entityId);
      if (entity) {
        buffer.push(entity);
      }
    }
    return buffer;
  }

  /**
   * Get entities within range of a position.
   * OPTIMIZATION: Uses spatial registry for O(1) chunk-based query instead of O(n) linear scan.
   */
  getEntitiesInRange(
    center: { x: number; y: number; z: number },
    range: number,
    type?: string,
  ): Entity[] {
    // Use spatial registry for efficient 2D query, then filter by 3D distance
    const results = this.spatialRegistry.getEntitiesInRange(
      center.x,
      center.z,
      range,
      type,
    );
    const entities: Entity[] = [];

    for (const result of results) {
      const entity = this.entities.get(result.entityId);
      if (!entity) continue;

      // Verify 3D distance (spatial registry only checks 2D)
      const distance = entity.getDistanceTo(center);
      if (distance <= range) {
        entities.push(entity);
      }
    }

    return entities;
  }

  // ========== PLAYER SPATIAL REGISTRATION ==========
  // These methods allow ServerNetwork to register players with the spatial registry
  // Players don't go through spawnEntity(), so they need separate registration

  /**
   * Register a player with the spatial registry
   * Called by ServerNetwork when a player connects/spawns
   *
   * @param playerId - Player entity ID
   * @param x - World X position
   * @param z - World Z position
   */
  registerPlayer(playerId: string, x: number, z: number): void {
    if (!this.world.isServer) return;
    this.spatialRegistry.addEntity(playerId, x, z, "player", true);
  }

  /**
   * Unregister a player from the spatial registry
   * Called by ServerNetwork when a player disconnects
   *
   * @param playerId - Player entity ID
   */
  unregisterPlayer(playerId: string): void {
    if (!this.world.isServer) return;
    this.spatialRegistry.removeEntity(playerId);
    this._activeEntityIdsCache.delete(playerId);
    this._activeEntitiesCacheFrame = -1;
  }

  /**
   * Update a player's position in the spatial registry
   * Called by ServerNetwork/TileMovementManager when player moves
   *
   * @param playerId - Player entity ID
   * @param x - New world X position
   * @param z - New world Z position
   */
  updatePlayerPosition(playerId: string, x: number, z: number): void {
    if (!this.world.isServer) return;
    this.spatialRegistry.updateEntityPosition(playerId, x, z);
  }

  private handleEntityDestroy(data: { entityId: string }): void {
    this.destroyEntity(data.entityId);
  }

  private async handleInteractionRequest(data: {
    entityId: string;
    playerId: string;
    interactionType?: string;
  }): Promise<void> {
    const entity = this.getEntity(data.entityId);
    if (!entity) {
      return;
    }
    await entity.handleInteraction({
      ...data,
      interactionType: data.interactionType || "interact",
      position: entity.getPosition(),
      playerPosition: { x: 0, y: 0, z: 0 }, // Default player position - would be provided by actual system
    });
  }

  private handleMoveRequest(data: {
    entityId: string;
    position: { x: number; y: number; z: number };
  }): void {
    const entity = this.getEntity(data.entityId);
    if (!entity) {
      return;
    }
    // Do not override local player physics-driven movement. Let PlayerLocal handle motion.
    const isLocalPlayer =
      entity.isPlayer &&
      this.world.entities.player &&
      entity.id === this.world.entities.player.id;
    if (isLocalPlayer) {
      return;
    }
    entity.setPosition(data.position.x, data.position.y, data.position.z);
  }

  private handlePropertyRequest(data: {
    entityId: string;
    propertyName: string;
    value: unknown;
  }): void {
    const entity = this.getEntity(data.entityId);
    if (!entity) {
      return;
    }
    entity.setProperty(data.propertyName, data.value);
  }

  private async handleItemSpawn(data: ItemSpawnData): Promise<void> {
    const itemIdToUse = data.itemId || data.id || "unknown_item";
    const itemData = getItem(itemIdToUse);
    const quantity = Number(data.quantity ?? 1);
    if (
      !this.world.isServer ||
      !itemData ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      throw new Error("item_spawn_request_invalid");
    }
    const groundItems = this.world.getSystem<GroundItemSystem>("ground-items");
    if (!groundItems) {
      throw new Error("item_spawn_ground_custody_unavailable");
    }
    const sourceId = await groundItems.spawnGroundItem(
      itemData.id,
      quantity,
      data.position,
      {
        despawnTime: ticksToMs(COMBAT_CONSTANTS.GROUND_ITEM_DESPAWN_TICKS),
        droppedBy: data.droppedBy,
      },
    );
    if (!sourceId) throw new Error("item_spawn_ground_custody_rejected");
  }

  private handleItemPickup(data: { entityId: string; playerId: string }): void {
    const entity = this.getEntity(data.entityId);
    if (!entity) {
      return;
    }

    // Get properties before destroying
    const itemId = entity.getProperty("itemId");
    const quantity = entity.getProperty("quantity");

    this.destroyEntity(data.entityId);

    this.emitTypedEvent(EventType.ITEM_PICKUP, {
      playerId: data.playerId,
      item: itemId,
      quantity: quantity,
    });
  }

  async handleMobSpawn(data: MobSpawnData): Promise<void> {
    // Strong type assumption - MobSpawnData.position is always Position3D with valid coordinates
    // If invalid coordinates are passed, that's a bug in the calling code
    let position = data.position;
    if (!position) {
      throw new Error("[EntityManager] Mob spawn position is required");
    }

    const mobType = data.mobType;
    if (!mobType) {
      throw new Error("[EntityManager] Mob type is required");
    }

    const level = data.level || 1;

    // Ground to terrain height map explicitly for server/client authoritative spawn
    const terrain = this.world.getSystem<TerrainSystem>("terrain");
    if (terrain) {
      const th = terrain.getHeightAt(position.x, position.z);
      if (Number.isFinite(th)) {
        position = { x: position.x, y: th, z: position.z };
      }
    }

    // Get NPC data to access modelPath
    const npcDataFromDB = getNPCById(mobType);
    const modelPath = npcDataFromDB?.appearance.modelPath;

    if (!modelPath) {
      throw new Error(`[EntityManager] Mob ${mobType} has no model path`);
    }

    // CRITICAL FIX: Always use the provided customId to ensure client/server ID consistency
    // Only generate a new ID if customId is not provided (fallback case)
    const mobId = data.customId || `mob_${this.nextEntityId++}`;

    // Get scale from manifest (default to 1.0 if not specified)
    const manifestScale = npcDataFromDB?.appearance?.scale ?? 1;

    const config: MobEntityConfig = {
      id: mobId,
      name: `Mob: ${data.name || mobType || "Unknown"} (Lv${level})`,
      type: EntityType.MOB,
      position: position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: manifestScale, y: manifestScale, z: manifestScale },
      visible: true,
      interactable: true,
      interactionType: InteractionType.ATTACK,
      interactionDistance: 5,
      description: `${mobType} (Level ${level})`,
      model: modelPath,
      // MobEntity specific fields
      mobType: mobType, // Mob ID from mobs.json
      level: level,
      currentHealth: this.getMobMaxHealth(mobType, level),
      maxHealth: this.getMobMaxHealth(mobType, level),
      attack: this.getMobAttack(mobType, level),
      attackPower: this.getMobAttackPower(mobType, level),
      defense: this.getMobDefense(mobType, level),
      defenseBonus: this.getMobDefenseBonus(mobType),
      attackSpeedTicks: this.getMobAttackSpeedTicks(mobType),
      moveSpeed: this.getMobMoveSpeed(mobType),
      aggressive: npcDataFromDB?.combat.aggressive ?? true, // Default to aggressive if not specified
      retaliates: npcDataFromDB?.combat.retaliates ?? true, // Default to retaliating if not specified
      attackable: npcDataFromDB?.combat.attackable ?? true, // Default to attackable if not specified
      movementType: npcDataFromDB?.movement.type ?? "wander", // Default to wander if not specified
      aggroRange: this.getMobAggroRange(mobType),
      combatRange: this.getMobCombatRange(mobType),
      attackType: npcDataFromDB?.combat.attackType ?? "melee",
      spellId: npcDataFromDB?.combat.spellId,
      arrowId: npcDataFromDB?.combat.arrowId,
      leashRange: this.getMobLeashRange(mobType),
      wanderRadius: this.getMobWanderRadius(mobType),
      xpReward: this.getMobXPReward(mobType, level),
      lootTable: this.getMobLootTable(mobType),
      respawnTime: 300000, // 5 minutes default
      spawnPoint: position,
      aiState: MobAIState.IDLE,
      lastAttackTime: 0,
      properties: {
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: {
          current: this.getMobMaxHealth(mobType, level),
          max: this.getMobMaxHealth(mobType, level),
        },
        level: level,
      },
      targetPlayerId: null,
      deathTime: null,
    };

    const entity = await this.spawnEntity(config);

    // Emit MOB_NPC_SPAWNED event to notify other systems (like AggroSystem)
    // that a mob has been successfully spawned
    if (entity) {
      this.emitTypedEvent(EventType.MOB_NPC_SPAWNED, {
        mobId: config.id,
        mobType: mobType,
        position: position,
      });
    }
  }

  private handleMobAttacked(_data: {
    entityId: string;
    damage: number;
    attackerId: string;
  }): void {
    // NO-OP: MobEntity.takeDamage() now calls die() directly when health reaches 0
    // This event handler is kept for backward compatibility but does nothing
    // Event chain: CombatSystem → takeDamage() → die() (no EntityManager involved)
  }

  private handleMobAttack(data: {
    mobId: string;
    targetId: string;
    damage: number;
  }): void {
    const mob = this.entities.get(data.mobId);
    if (!mob) {
      return;
    }

    const damage = mob.getProperty("attackPower");

    this.emitTypedEvent(EventType.PLAYER_DAMAGE, {
      playerId: data.targetId,
      damage,
      source: data.mobId,
      sourceType: "mob",
    });
  }

  private handleClientConnect(data: { playerId: string }): void {
    // Send all current entities to new client
    const entityData = Array.from(this.entities.values()).map((entity) => ({
      type: entity.type,
      data: entity.getNetworkData(),
    }));

    this.emitTypedEvent(EventType.CLIENT_ENTITY_SYNC, {
      playerId: data.playerId,
      entities: entityData,
    });
  }

  private handleClientDisconnect(data: { playerId: string }): void {
    // Clean up any player-specific entity data
    this.entities.forEach((entity, entityId) => {
      if (entity.getProperty("ownerId") === data.playerId) {
        this.destroyEntity(entityId);
      }
    });
  }

  private sendNetworkUpdates(): void {
    // Only send network updates on the server
    if (!this.world.isServer) {
      this.networkDirtyEntities.clear();
      return;
    }

    // Check for network with interest-based sending capability
    const network = this.world.network as {
      send?: (method: string, data: unknown, excludeId?: string) => void;
      sendToPlayer?: (
        playerId: string,
        method: string,
        data: unknown,
      ) => boolean;
    };

    if (!network || !network.send) {
      // No network system, clear dirty entities and return
      this.networkDirtyEntities.clear();
      return;
    }

    // Use interest-based filtering if sendToPlayer is available
    const useInterestFiltering = typeof network.sendToPlayer === "function";

    // PERFORMANCE: Process network updates with frame budget awareness.
    // Iterate Set directly to avoid per-frame allocation.
    let updatesThisFrame = 0;
    const maxUpdates = this.getNetworkUpdateBudget(
      this.networkDirtyEntities.size,
    );
    const frameBudget = this.world.frameBudget;
    if (maxUpdates === 0) return;

    for (const entityId of this.networkDirtyEntities) {
      // Check frame budget periodically
      if (updatesThisFrame > 0 && updatesThisFrame % 10 === 0) {
        if (frameBudget && !frameBudget.hasTimeRemaining(1)) {
          // Over budget - remaining entities will be processed next frame
          // (they'll still be in networkDirtyEntities)
          break;
        }
      }

      if (updatesThisFrame >= maxUpdates) break;

      // Remove from dirty set BEFORE processing (even if we skip, don't re-send)
      this.networkDirtyEntities.delete(entityId);
      // CRITICAL FIX: Players are in world.players, not EntityManager.entities
      // Check both locations to find the entity
      let entity = this.entities.get(entityId);
      if (!entity && this.world.getPlayer) {
        const playerEntity = this.world.getPlayer(entityId);
        if (playerEntity) {
          entity = playerEntity;
        }
      }

      if (entity) {
        // Get current position from entity
        const pos = entity.position;
        // Get rotation: prefer node.quaternion (client) but fallback to entity.rotation (server)
        const rot = entity.node?.quaternion ?? entity.rotation;

        // Get interested players (only those within broadcast distance)
        // For player entities, always broadcast to nearby players (they need to see each other)
        const interestedPlayers = useInterestFiltering
          ? this.getInterestedPlayers(pos.x, pos.z, entity.type)
          : null;

        // Get network data from entity (includes health and other properties)
        const networkData = entity.getNetworkData();

        // AAA QUALITY: Check entity.data.deathState directly (single source of truth)
        // During death animation, we lock the player's broadcast position to their death location
        // This prevents any position updates from reaching clients until respawn
        let skipPositionBroadcast = false;
        if (entity.type === "player" && entity.data) {
          const entityData = entity.data as {
            deathState?: DeathState;
            deathPosition?: [number, number, number];
          };

          if (
            entityData.deathState === DeathState.DYING ||
            entityData.deathState === DeathState.DEAD
          ) {
            // Player is dead - freeze position to death location
            skipPositionBroadcast = true;
          }
        }

        // PERF: Build update packet using pre-allocated buffers
        // Clear the changes buffer (reused each iteration)
        const changes = this._changesBuffer;
        for (const key in changes) delete changes[key];

        // Copy network data properties into changes buffer
        for (const key in networkData) {
          changes[key] = networkData[key];
        }

        // Add position/quaternion unless skipped (dead player)
        if (!skipPositionBroadcast) {
          // Populate position buffer
          this._packetPositionBuffer[0] = pos.x;
          this._packetPositionBuffer[1] = pos.y;
          this._packetPositionBuffer[2] = pos.z;
          changes.p = this._packetPositionBuffer;

          // Populate quaternion buffer if rotation exists
          if (rot) {
            this._packetQuaternionBuffer[0] = rot.x;
            this._packetQuaternionBuffer[1] = rot.y;
            this._packetQuaternionBuffer[2] = rot.z;
            this._packetQuaternionBuffer[3] = rot.w;
            changes.q = this._packetQuaternionBuffer;
          }
        }

        // Populate packet buffer
        this._updatePacketBuffer.id = entityId;
        this._updatePacketBuffer.changes = changes;

        // INTEREST-BASED FILTERING: Send only to nearby players
        if (
          interestedPlayers &&
          interestedPlayers.length > 0 &&
          network.sendToPlayer
        ) {
          for (const playerId of interestedPlayers) {
            network.sendToPlayer(
              playerId,
              "entityModified",
              this._updatePacketBuffer,
            );
          }
          this.networkStats.interestFilteredUpdates++;
          this.networkStats.totalPlayersNotified += interestedPlayers.length;
        } else {
          // Fallback: Broadcast to all clients
          network.send!("entityModified", this._updatePacketBuffer);
          this.networkStats.broadcastUpdates++;
        }

        updatesThisFrame++;
      }
      // Entity not found - this is expected when:
      // - Items are picked up between marking dirty and sync
      // - Mobs die between marking dirty and sync
      // - Any entity is removed during the frame
      // Silently skip - not an error condition
    }

    // Note: We don't clear all dirty entities anymore - only processed ones are removed above
    // This allows remaining entities to be processed in the next frame
  }

  /**
   * Get the spatial entity registry for external queries
   * Used by systems like InterestManager for network filtering
   */
  getSpatialRegistry(): SpatialEntityRegistry {
    return this.spatialRegistry;
  }

  getDebugInfo(): {
    totalEntities: number;
    entitiesByType: Record<string, number>;
    entitiesNeedingUpdate: number;
    networkDirtyEntities: number;
    spatialStats?: {
      totalChunks: number;
      activeChunks: number;
      totalEntities: number;
      playerCount: number;
      avgEntitiesPerChunk: number;
    };
    networkStats?: {
      interestFilteredUpdates: number;
      broadcastUpdates: number;
      totalPlayersNotified: number;
      interestFilteringRatio: number;
      uptimeSeconds: number;
    };
  } {
    const result: ReturnType<typeof this.getDebugInfo> = {
      totalEntities: this.entities.size,
      entitiesByType: this.getEntityTypeCount(),
      entitiesNeedingUpdate: this.entitiesNeedingUpdate.size,
      networkDirtyEntities: this.networkDirtyEntities.size,
    };

    // Add spatial registry stats (server-side only)
    if (this.world.isServer) {
      result.spatialStats = this.spatialRegistry.getStats();

      // Add network stats to verify interest filtering effectiveness
      const total =
        this.networkStats.interestFilteredUpdates +
        this.networkStats.broadcastUpdates;
      result.networkStats = {
        interestFilteredUpdates: this.networkStats.interestFilteredUpdates,
        broadcastUpdates: this.networkStats.broadcastUpdates,
        totalPlayersNotified: this.networkStats.totalPlayersNotified,
        interestFilteringRatio:
          total > 0 ? this.networkStats.interestFilteredUpdates / total : 0,
        uptimeSeconds: Math.floor(
          (Date.now() - this.networkStats.lastResetTime) / 1000,
        ),
      };
    }

    return result;
  }

  /** Reset network stats (useful for benchmarking) */
  resetNetworkStats(): void {
    this.networkStats = {
      interestFilteredUpdates: 0,
      broadcastUpdates: 0,
      totalPlayersNotified: 0,
      lastResetTime: Date.now(),
    };
  }

  private getEntityTypeCount(): Record<string, number> {
    const counts: Record<string, number> = {};

    this.entities.forEach((entity) => {
      counts[entity.type] = (counts[entity.type] || 0) + 1;
    });

    return counts;
  }

  /**
   * Helper method to create a simple test item entity with minimal configuration
   */
  async createTestItem(config: {
    id?: string;
    name: string;
    position: { x: number; y: number; z: number };
    itemId?: string;
    quantity?: number;
  }): Promise<Entity | null> {
    const itemConfig: ItemEntityConfig = {
      id: config.id || `test_item_${this.nextEntityId++}`,
      type: EntityType.ITEM,
      name: config.name,
      position: config.position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: false,
      interactionType: null,
      interactionDistance: 2,
      description: `Test item: ${config.name}`,
      model: null,
      // ItemEntityConfig-specific fields
      itemType: config.itemId || "test-item",
      itemId: config.itemId || "test-item",
      quantity: config.quantity || 1,
      stackable: false,
      value: 0,
      weight: 0,
      rarity: ItemRarity.COMMON,
      requirements: {},
      effects: [],
      armorSlot: null,
      // Properties field
      properties: {
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: {
          current: 1,
          max: 1,
        },
        level: 1,
        itemId: config.itemId || "test-item",
        custodyPolicy: "diagnostic_only",
        harvestable: false,
        dialogue: [],
        quantity: config.quantity || 1,
        stackable: false,
        value: 0,
        weight: 0,
        rarity: ItemRarity.COMMON,
      },
    };

    return this.spawnEntity(itemConfig);
  }

  public getScaledMobStats(
    mobType: string,
    level: number,
  ): {
    maxHealth: number;
    attack: number;
    attackPower: number;
    defense: number;
    defenseBonus: number;
    attackSpeedTicks: number;
    moveSpeed: number;
    aggroRange: number;
    combatRange: number;
    wanderRadius: number;
    xpReward: number;
  } {
    return {
      maxHealth: this.getMobMaxHealth(mobType, level),
      attack: this.getMobAttack(mobType, level),
      attackPower: this.getMobAttackPower(mobType, level),
      defense: this.getMobDefense(mobType, level),
      defenseBonus: this.getMobDefenseBonus(mobType),
      attackSpeedTicks: this.getMobAttackSpeedTicks(mobType),
      moveSpeed: this.getMobMoveSpeed(mobType),
      aggroRange: this.getMobAggroRange(mobType),
      combatRange: this.getMobCombatRange(mobType),
      wanderRadius: this.getMobWanderRadius(mobType),
      xpReward: this.getMobXPReward(mobType, level),
    };
  }

  // Helper methods for mob stats calculation - NOW DATA-DRIVEN!
  // All values loaded from mobs.json instead of hardcoded

  private getMobMaxHealth(mobType: string, level: number): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return Math.max(1, 100 + (level - 1) * 10);
    }
    // Scale health based on level difference from base level
    // Clamp to minimum of 1 to prevent negative/zero health when spawned below base level
    return Math.max(
      1,
      npcData.stats.health + (level - npcData.stats.level) * 10,
    );
  }

  private getMobAttack(mobType: string, level: number): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return Math.max(1, 1 + (level - 1)); // Default attack scaling
    }
    // Clamp to minimum of 1 to prevent negative attack when spawned below base level
    return Math.max(1, npcData.stats.attack + (level - npcData.stats.level));
  }

  private getMobAttackPower(mobType: string, level: number): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return Math.max(1, 5 + (level - 1) * 2);
    }
    // FIX: Use strength for attackPower (max hit), not attack (accuracy)
    // Clamp to minimum of 1 to prevent negative attack power when spawned below base level
    return Math.max(
      1,
      npcData.stats.strength + (level - npcData.stats.level) * 2,
    );
  }

  private getMobDefense(mobType: string, level: number): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return Math.max(0, 2 + (level - 1));
    }
    // Defense can be 0 for very weak mobs (no armor)
    return Math.max(0, npcData.stats.defense + (level - npcData.stats.level));
  }

  private getMobDefenseBonus(mobType: string): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return 0; // Default: no armor bonus
    }
    return npcData.stats.defenseBonus ?? 0;
  }

  private getMobAttackSpeedTicks(mobType: string): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return 4; // Default: 4 ticks (2.4 seconds, standard sword speed)
    }
    return npcData.combat.attackSpeedTicks;
  }

  private getMobMoveSpeed(mobType: string): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return 3.0; // Default: 3 units/sec (walking speed, matches player walk)
    }
    return npcData.movement.speed;
  }

  private getMobWanderRadius(mobType: string): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return 10; // Default: 10 meter wander radius from spawn
    }
    return npcData.movement.wanderRadius;
  }

  private getMobAggroRange(mobType: string): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return 15.0; // Default: 15 meters detection range (increased from 10)
    }
    return npcData.combat.aggroRange;
  }

  private getMobCombatRange(mobType: string): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return 1.5; // Default: 1.5 meters melee range
    }
    return npcData.combat.combatRange;
  }

  private getMobLeashRange(mobType: string): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return COMBAT_CONSTANTS.DEFAULTS.NPC.LEASH_RANGE; // Extended default: 42 tiles
    }
    // leashRange from manifest, or fallback to default
    return (
      npcData.combat.leashRange ?? COMBAT_CONSTANTS.DEFAULTS.NPC.LEASH_RANGE
    );
  }

  private getMobXPReward(mobType: string, level: number): number {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return 10 * level;
    }
    const levelDiff = level - npcData.stats.level;
    return npcData.combat.xpReward + levelDiff * 5;
  }

  private getMobLootTable(mobType: string): Array<{
    itemId: string;
    chance: number;
    minQuantity: number;
    maxQuantity: number;
  }> {
    const npcData = getNPCById(mobType);
    if (!npcData) {
      return [{ itemId: "coins", chance: 0.5, minQuantity: 1, maxQuantity: 5 }];
    }

    // Convert unified NPCData drops to expected format
    const allDrops: Array<{
      itemId: string;
      chance: number;
      minQuantity: number;
      maxQuantity: number;
    }> = [];

    // Add default drop if enabled
    if (npcData.drops.defaultDrop.enabled) {
      allDrops.push({
        itemId: npcData.drops.defaultDrop.itemId,
        chance: 1.0,
        minQuantity: npcData.drops.defaultDrop.quantity,
        maxQuantity: npcData.drops.defaultDrop.quantity,
      });
    }

    // Add all drop tiers
    for (const drop of npcData.drops.always) {
      allDrops.push({
        itemId: drop.itemId,
        chance: drop.chance,
        minQuantity: drop.minQuantity,
        maxQuantity: drop.maxQuantity,
      });
    }

    for (const drop of npcData.drops.common) {
      allDrops.push({
        itemId: drop.itemId,
        chance: drop.chance,
        minQuantity: drop.minQuantity,
        maxQuantity: drop.maxQuantity,
      });
    }

    for (const drop of npcData.drops.uncommon) {
      allDrops.push({
        itemId: drop.itemId,
        chance: drop.chance,
        minQuantity: drop.minQuantity,
        maxQuantity: drop.maxQuantity,
      });
    }

    for (const drop of npcData.drops.rare) {
      allDrops.push({
        itemId: drop.itemId,
        chance: drop.chance,
        minQuantity: drop.minQuantity,
        maxQuantity: drop.maxQuantity,
      });
    }

    for (const drop of npcData.drops.veryRare) {
      allDrops.push({
        itemId: drop.itemId,
        chance: drop.chance,
        minQuantity: drop.minQuantity,
        maxQuantity: drop.maxQuantity,
      });
    }

    return allDrops.length > 0
      ? allDrops
      : [{ itemId: "coins", chance: 0.5, minQuantity: 1, maxQuantity: 5 }];
  }

  private getItemWeight(_itemId: string): number {
    // Default weight for items - could be expanded with item data
    return 1;
  }

  private handleResourceSpawn(data: {
    resourceId: string;
    position: { x: number; y: number; z: number };
    resourceType: string;
  }): void {
    // Resource spawn logic
    this.spawnResource(data.resourceId, data.position, data.resourceType);
  }

  private async spawnResource(
    resourceId: string,
    position: { x: number; y: number; z: number },
    resourceType: string,
  ): Promise<Entity | null> {
    // Create readable resource name
    const resourceName = resourceType
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());

    const config: ResourceEntityConfig = {
      id: resourceId,
      type: EntityType.RESOURCE,
      name: `Resource: ${resourceName}`,
      position: position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: true,
      interactionType: InteractionType.GATHER,
      interactionDistance: 3,
      description: `A ${resourceType} resource`,
      model: null,
      resourceType: resourceType as ResourceType,
      resourceId: resourceId,
      harvestSkill: "woodcutting",
      requiredLevel: 1,
      harvestTime: 3000, // 3 seconds to harvest
      respawnTime: 60000,
      harvestYield: [{ itemId: "wood", quantity: 1, chance: 1.0 }],
      depleted: false,
      lastHarvestTime: 0,
      properties: {
        health: {
          current: 1,
          max: 1,
        },
        resourceType: resourceType as ResourceType,
        harvestable: true,
        respawnTime: 60000,
        toolRequired: "none",
        skillRequired: "none",
        xpReward: 10,
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        level: 1,
      },
    };

    return this.spawnEntity(config);
  }

  private async handleResourceHarvest(_data: {
    entityId: string;
    playerId: string;
    amount: number;
  }): Promise<void> {
    // Resource harvest logic would go here
    // For now, just log it
  }

  private async handleNPCSpawnRequest(data: {
    npcId: string;
    name: string;
    type: string;
    position: { x: number; y: number; z: number };
    services?: string[];
    modelPath?: string;
    storeId?: string;
  }): Promise<void> {
    const externalNPC = getExternalNPC(data.npcId);
    const resolvedName = data.name?.trim() || externalNPC?.name || data.npcId;
    const resolvedServices =
      data.services && data.services.length > 0
        ? data.services
        : externalNPC?.services.enabled
          ? externalNPC.services.types
          : [];

    // Determine NPC type prefix based on services/type
    let typePrefix = "NPC";
    if (
      data.type === "bank" ||
      resolvedServices.includes("bank") ||
      resolvedServices.includes("banking")
    ) {
      typePrefix = "Bank";
    } else if (
      data.storeId ||
      data.type === "general_store" ||
      resolvedServices.includes("shop") ||
      resolvedServices.includes("buy_items")
    ) {
      typePrefix = "Store";
    } else if (data.type === "skill_trainer") {
      typePrefix = "Trainer";
    } else if (data.type === "quest_giver") {
      typePrefix = "Quest";
    }

    // Try to get model path from external NPCs if not provided
    let modelPath: string | null = null;
    if (data.modelPath) {
      modelPath = data.modelPath;
    } else {
      if (externalNPC && externalNPC.appearance.modelPath) {
        modelPath = externalNPC.appearance.modelPath as string;
      }
    }

    const config: NPCEntityConfig = {
      id: `npc_${data.npcId}_${this.nextEntityId++}`,
      name: `${typePrefix}: ${resolvedName}`,
      type: EntityType.NPC,
      position: data.position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: true,
      interactionType: InteractionType.TALK,
      interactionDistance: 3,
      description: externalNPC?.description || resolvedName,
      model: modelPath,
      npcType: this.mapTypeToNPCType(data.type),
      npcId: data.npcId,
      storeId: data.storeId,
      dialogueLines: [],
      services: resolvedServices,
      questIds: externalNPC?.services.questIds,
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
          spawnPoint: data.position,
          wanderRadius: 0,
          aggroRange: 0,
          isHostile: false,
          combatLevel: 1,
          aggressionLevel: 0,
          dialogueLines: [],
          dialogue: null,
          services: resolvedServices,
        },
        dialogue: [],
        shopInventory: [],
        questGiver: data.type === "quest_giver",
      },
    };

    const npcEntity = await this.spawnEntity(config);

    // Register only the exact manifest identity. Positional guesses can silently
    // connect an NPC to the wrong inventory and are unsafe for conserved items.
    if (data.storeId && npcEntity) {
      this.emitTypedEvent(EventType.STORE_REGISTER_NPC, {
        npcId: npcEntity.id,
        storeId: data.storeId,
        position: data.position,
        name: resolvedName,
        area: "town",
      });
    }
  }

  private mapTypeToNPCType(type: string): NPCType {
    switch (type) {
      case "bank":
        return NPCType.BANK;
      case "general_store":
      case "armor_store":
      case "crafting_store":
      case "magic_store":
      case "range_store":
        return NPCType.STORE;
      case "skill_trainer":
        return NPCType.TRAINER;
      case "quest_giver":
        return NPCType.QUEST_GIVER;
      default:
        return NPCType.QUEST_GIVER;
    }
  }

  private handleNPCSpawn(_data: {
    customId: string;
    name: string;
    npcType: NPCType;
    position: { x: number; y: number; z: number };
    model: unknown;
    dialogues: string[];
    questGiver: boolean;
    shopkeeper: boolean;
    bankTeller: boolean;
  }): void {
    // NPC spawn logic
  }

  private handleNPCDialogue(_data: {
    entityId: string;
    playerId: string;
    dialogueId: string;
  }): void {
    // NPC dialogue logic
  }

  /**
   * Cleanup when system is destroyed
   */
  destroy(): void {
    // Clean up all entities
    for (const entity of this.entities.values()) {
      if (entity) {
        // Assume destroy method exists on entities
        entity.destroy();
      }
    }
    this.entities.clear();

    // Clear tracking sets
    this.entitiesNeedingUpdate.clear();
    this.networkDirtyEntities.clear();
    this._entityArrayDirty = true; // Mark for cache refresh
    this._entityUpdateArray = []; // Clear cached array
    this._entitiesByTypeBuffers.clear(); // Clear entity type buffers

    // Clear spatial registry
    this.spatialRegistry.clear();

    // Reset entity ID counter
    this.nextEntityId = 1;

    // Cleanup GPU compute context
    if (this.networkingCompute) {
      this.networkingCompute.destroy();
      this.networkingCompute = null;
      this.gpuComputeAvailable = false;
    }

    // Call parent cleanup
    super.destroy();
  }
}
