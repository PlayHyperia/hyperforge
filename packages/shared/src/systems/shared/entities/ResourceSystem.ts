import { SystemBase } from "../infrastructure/SystemBase";
// NOTE: Import directly to avoid circular dependency through barrel file
import { TerrainSystem } from "../world/TerrainSystem";
import { uuid } from "../../../utils";
import type { World } from "../../../types";
import { ResourceEntity } from "../../../entities/world/ResourceEntity";
import type { Entity } from "../../../entities/Entity";
import type { EntityManager } from "./EntityManager";
import { EntityType, InteractionType } from "../../../types/entities";
import { disposeFishingSpotTextures } from "../../../entities/world/visuals/FishingSpotVisualStrategy";

import { EventType } from "../../../types/events";
import { Resource, ResourceDrop } from "../../../types/core/core";
import { PlayerID, ResourceID } from "../../../types/core/identifiers";
import {
  calculateDistance,
  calculateDistance2D,
} from "../../../utils/game/EntityUtils";
import {
  createPlayerID,
  createResourceID,
} from "../../../utils/IdentifierUtils";
import {
  centeredTerrainTileIndex,
  type TerrainResourceSpawnBatch,
  type TerrainResourceSpawnPoint,
} from "../../../types/world/terrain";
import {
  TICK_DURATION_MS,
  snapToTileCenter,
  worldToTile,
  isCardinallyAdjacentToResource,
  type TileCoord,
} from "../movement/TileSystem";
import { CollisionFlag } from "../movement/CollisionFlags";
import {
  FOOTPRINT_SIZES,
  type ResourceFootprint,
} from "../../../types/game/resource-processing-types";
import {
  getExternalResource,
  getExternalToolsForSkill,
} from "../../../utils/ExternalAssetUtils";
import type { GatheringToolData } from "../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import { isPositionInsideDuelArenaZone } from "../../../data/duel-manifest";
import { GATHERING_CONSTANTS } from "../../../constants/GatheringConstants";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import { findFishingSpotTiles, shuffleArray } from "../../../utils/ShoreUtils";
import { validateAuthoredTreeInstanceId } from "../../../data/ResourceInstanceIdentity";
import type { WorldArea } from "../../../types/world/world-types";
// Note: quaternionPool no longer used here - face rotation is deferred to FaceDirectionManager

// SOLID: Extracted pure utility functions
import { rollDrop as rollDropUtil } from "./gathering/DropRoller";
import {
  getToolCategory as getToolCategoryUtil,
  getToolDisplayName as getToolDisplayNameUtil,
  itemMatchesToolCategory,
  resolveGatheringPresentationEmote,
  resolveGatheringPresentationItemId,
} from "./gathering/ToolUtils";
import {
  computeSuccessRate as computeSuccessRateUtil,
  computeCycleTicks as computeCycleTicksUtil,
  getSuccessRateValues as getSuccessRateValuesUtil,
  ticksToMs as ticksToMsUtil,
} from "./gathering/SuccessRateCalculator";
import { DEBUG_GATHERING } from "./gathering/debug";
import type {
  AtomicGatheringRewardReceipt,
  InventorySystem,
} from "../character/InventorySystem";
import type { DatabaseSystem } from "../../../types/systems/system-interfaces";
import { canPlayerPerformPreparationAction } from "../interaction/ProcessingStationAuthority";
import { getGatheringRewardOperationIdForAttempt } from "../../../utils/game/GatheringReceiptIdentity";
import {
  firstFishingInteractionAttemptTick,
  initialFishingInteractionTransition,
  isSpecialFishingInteractionItemId,
  nextFishingInteractionTransition,
  resolveFishingInteractionBodyEmote,
  type FishingInteractionOutcome,
  type FishingInteractionPhase,
  type FishingInteractionPresentationState,
  type FishingInteractionTargetPosition,
  type SpecialFishingInteractionItemId,
} from "./gathering/FishingInteractionPresentation";

type ActiveFishingInteractionPresentation = {
  interactionId: string;
  itemId: SpecialFishingInteractionItemId;
  phase: FishingInteractionPhase;
  outcome: FishingInteractionOutcome;
  targetPosition: FishingInteractionTargetPosition;
  nextTransitionTick: number | null;
  firstAttemptTick: number;
  awaitingOperationId: string | null;
  phaseStartedAtServerTimeMs: number;
};

type PendingGatherReward = {
  operationId: string;
  playerId: PlayerID;
  resourceId: ResourceID;
  skill: "woodcutting" | "mining" | "fishing";
  drop: ResourceDrop;
  resourceName: string;
  respawnTicks: number;
  secondaryItemId: string | null;
  depletionMode: "none" | "chance" | "timer";
  shouldDeplete: boolean;
  state: "in_flight" | "retry_wait" | "settled";
  retryCount: number;
  retryAtTick: number;
  receipt: AtomicGatheringRewardReceipt | null;
  /** True only when this is the first reward for an autonomous action. */
  completionBound: boolean;
};

type GatheringRequest = {
  playerId: string;
  resourceId: string;
  playerPosition: { x: number; y: number; z: number };
  /** Optional immutable autonomy attempt whose first reward completes it. */
  completionAttemptId?: string;
};

type TerrainResourceRegistration = {
  spawnPoint: TerrainResourceSpawnPoint;
  resource: Resource;
  signature: string;
  entity: Entity | null;
};

type TerrainResourceLease = {
  key: string;
  isManifest: boolean;
  signature: string;
  active: boolean;
  registrations: Map<ResourceID, TerrainResourceRegistration>;
  completion: Promise<void>;
};

export interface ResourceEcologyStats {
  totalResources: number;
  availableResources: number;
  depletedResources: number;
  manifestResources: number;
  resourceVariants: number;
  forestryTimers: number;
  forestryActiveGatherers: number;
  scheduledRespawns: number;
  fishingMovementTimers: number;
  pendingFishingAreas: number;
  playerSkillSnapshots: number;
  gatherRateLimits: number;
  suspiciousPatternEntries: number;
  custody: ReturnType<ResourceSystem["getGatheringCustodyStats"]>;
}

export interface PendingFishingAreaDiagnostic {
  areaId: string;
  bounds: WorldArea["bounds"];
  bakedProbeCount: number;
  totalBakedProbes: number;
  collisionTiles: {
    total: number;
    water: number;
    steep: number;
    blocked: number;
    landAdjacentToWater: number;
  };
  discoveredShorePoints: number;
  center: {
    x: number;
    z: number;
    terrainHeight: number | null;
    waterSurface: number | null;
  };
}

/**
 * Player entity interface for emote operations.
 * Used for type-safe access to player emote properties.
 */
interface PlayerWithEmote {
  emote?: string;
  data?: {
    e?: string;
    gatheringToolPresentation?: {
      revision: number;
      itemId: string | null;
    };
    fishingInteractionPresentation?: FishingInteractionPresentationState;
  };
  markNetworkDirty?: () => void;
}

/**
 * Resource entity interface for respawn/deplete operations.
 * Used for type-safe access to resource entity methods.
 */
interface ResourceEntityMethods {
  respawn?: () => void;
  deplete?: () => void;
}

/**
 * ResourceSystem - Manages resource gathering for all skills (woodcutting, mining, fishing)
 *
 * ## Architecture
 *
 * ### Data Flow
 * 1. Client clicks resource → ResourceInteractionHandler
 * 2. Handler sends network message → resources.ts handler
 * 3. Handler emits RESOURCE_GATHER event with server-authoritative position
 * 4. ResourceSystem.startGathering() validates and creates session
 * 5. TickSystem calls processGatheringTick() every 600ms (classic MMORPG tick rate)
 * 6. On success: drops item via manifest data, awards XP, may deplete resource
 *
 * ### Manifest Integration
 * All resource data comes from resources.json manifest:
 * - harvestSkill, levelRequired: Skill validation
 * - toolRequired: Tool validation (via tools.json manifest)
 * - baseCycleTicks, depleteChance, respawnTicks: Timing configuration
 * - harvestYield: Drop table with itemId, itemName, quantity, chance, xpAmount, stackable
 *
 * ### Session Management
 * Active gathering sessions stored in activeGathering Map (keyed by PlayerID).
 * Sessions cache tuning data at start to avoid per-tick allocations (performance).
 * Sessions end on: resource depletion, player movement, inventory full, or disconnect.
 *
 * ### Security Features
 * - Rate limiting: 600ms minimum between gather requests (1 tick)
 * - Server-authoritative position: Client position ignored, uses world state
 * - Resource ID validation: Alphanumeric with length limit to prevent injection
 * - Proximity checks: Uses server-side player position for range validation
 *
 * ### Tool Tier System (Rules-Accurate, Manifest-Driven)
 * Tool definitions loaded from tools.json manifest:
 * - Woodcutting: Axe tier affects SUCCESS RATE (not speed), fixed 4-tick rolls
 * - Mining: Pickaxe tier affects ROLL FREQUENCY (not success), variable ticks
 * - Fishing: Equipment doesn't affect speed or success, fixed 5-tick rolls
 *
 * @see GATHERING_CONSTANTS for skill-specific mechanics
 * @see tools.json for tool definitions
 * @see resources.json for resource definitions
 */
export class ResourceSystem extends SystemBase {
  private resources = new Map<ResourceID, Resource>();

  // Tick-based gathering sessions (rules-accurate timing)
  // Session includes cached data to avoid per-tick allocations
  private activeGathering = new Map<
    PlayerID,
    {
      playerId: PlayerID;
      resourceId: ResourceID;
      startTick: number; // Tick when gathering started
      nextAttemptTick: number; // Next tick to roll for success
      cycleTickInterval: number; // Ticks between attempts
      attempts: number;
      successes: number;
      pendingRewardOperationId: string | null;
      /** Exact first-reward operation awaited by an autonomous action. */
      completionOperationId: string | null;
      // Skill being used (woodcutting, mining, fishing)
      skill: string;
      // Tool item ID being used (for visual display, e.g., fishing rod)
      toolItemId: string | null;
      fishingInteraction: ActiveFishingInteractionPresentation | null;
      // PERFORMANCE: Cached at session start to avoid per-tick allocations
      cachedTuning: {
        levelRequired: number;
        xpPerLog: number;
        depleteChance: number;
        respawnTicks: number;
      };
      cachedSuccessRate: number;
      cachedDrops: ResourceDrop[];
      cachedResourceName: string; // For messages without lookup
      // RULES ACCURACY: Store start position to detect movement (cancels gathering)
      cachedStartPosition: { x: number; y: number; z: number };
      // DEBUG: Cached for logging (only used when DEBUG_GATHERING=true)
      debugInfo?: {
        skill: string;
        variant: string;
        toolTier: string | null;
        lowHigh: { low: number; high: number };
      };
    }
  >();
  /** Monotonic public presentation authority, independent per player. */
  private gatheringToolPresentationRevisions = new Map<PlayerID, number>();
  /** Monotonic fishing phase authority, independent per player. */
  private fishingInteractionPresentationRevisions = new Map<PlayerID, number>();
  private fishingPresentationServerTick = 0;
  /** One unresolved durable reward per player; ambiguity always reuses its ID. */
  private pendingGatherRewards = new Map<PlayerID, PendingGatherReward>();
  /** Potentially depleting resources admit one reward commit at a time. */
  private gatheringRewardReservations = new Map<ResourceID, string>();
  private isDestroying = false;
  // Tick-based respawn tracking (replaces legacy setTimeout approach)
  private respawnAtTick = new Map<ResourceID, number>();
  private playerSkills = new Map<
    string,
    Record<string, { level: number; xp: number }>
  >();
  private resourceVariants = new Map<ResourceID, string>();
  // Track manifest-spawned resources (from world-areas.json) - these should NOT be deleted on tile unload
  private manifestResourceIds = new Set<ResourceID>();
  /** Current tile generation, including empty tiles and work awaiting persistence. */
  private terrainResourceLeases = new Map<string, TerrainResourceLease>();
  /** Keeps a replacement behind late EntityManager.init() completion and cleanup. */
  private terrainResourceTails = new Map<string, Promise<void>>();
  private terrainResourceRegistrations = new Map<
    ResourceID,
    { lease: TerrainResourceLease; registration: TerrainResourceRegistration }
  >();
  // Terrain system reference for height lookups
  private terrainSystem: TerrainSystem | null = null;

  /**
   * When true, batched entity spawn packets use HIGH priority to bypass
   * per-connection bandwidth throttling. Set to false to revert to NORMAL
   * priority (may cause sparse entities during rapid tile generation).
   */
  useHighPriorityBatch = true;

  // ===== FORESTRY-STYLE RESOURCE TIMERS (rules-accurate) =====
  /**
   * Per-resource depletion timer for Forestry-style tree mechanics.
   * - Timer starts on FIRST LOG (not first interaction)
   * - Counts down at 1 tick/tick while anyone is gathering
   * - Regenerates at 1 tick/tick when no one is gathering
   * - Tree depletes when timer=0 AND player receives a log
   * - Multiple players share the same timer (no penalty)
   *
   */
  private resourceTimers = new Map<
    ResourceID,
    {
      currentTicks: number; // Current timer value (counts down while gathering)
      maxTicks: number; // Max timer value from TREE_DESPAWN_TICKS
      hasReceivedFirstLog: boolean; // Timer only starts after first log
      activeGatherers: Set<PlayerID>; // Players currently gathering this resource
      lastUpdateTick: number; // For calculating tick deltas
    }
  >();

  // ===== SECURITY: Rate limiting to prevent gather request spam =====
  private gatherRateLimits = new Map<PlayerID, number>();

  // ===== SECURITY: Suspicious pattern tracking =====
  /**
   * Tracks suspicious patterns per player for security monitoring.
   * - rapidDisconnects: Count of disconnects during active gathering within 5s window
   * - lastDisconnect: Timestamp of last disconnect during active gather
   * - rapidGatherAttempts: Count of attempts on same resource within 60s window
   * - lastAttempt: Timestamp of last gather attempt
   */
  private suspiciousPatterns = new Map<
    PlayerID,
    {
      rapidDisconnects: number;
      lastDisconnect: number;
      rapidGatherAttempts: number;
      lastAttempt: number;
    }
  >();

  // ===== RULES ACCURACY: Fishing spot movement timers =====
  /**
   * Fishing spots don't deplete - they periodically move to nearby tiles.
   * Each spot has a random timer that triggers relocation.
   *
   */
  private fishingSpotMoveTimers = new Map<
    ResourceID,
    {
      moveAtTick: number; // Tick when spot will move
      originalPosition: { x: number; y: number; z: number }; // For reference
    }
  >();

  // ===== PERFORMANCE: Pre-allocated buffers for zero-allocation hot paths =====
  // These buffers are reused every tick to avoid GC pressure from array allocations
  // Pattern: buffer.length = 0 to clear, then push items, then process
  private readonly _completedSessionsBuffer: PlayerID[] = [];
  private readonly _completedSessionFailureReasons = new Map<
    PlayerID,
    string
  >();
  private readonly _respawnedResourcesBuffer: ResourceID[] = [];
  private readonly _spotsToMoveBuffer: ResourceID[] = [];

  /** Areas where fishing spots couldn't spawn because collision WATER flags
   *  weren't baked yet. Retried each tick until flags are available. */
  private pendingFishingAreas = new Map<string, WorldArea>();

  // =============================================================================
  // TOOL DATA - Now loaded from tools.json manifest
  // =============================================================================
  //
  // Tool definitions are in packages/server/world/assets/manifests/tools.json
  // Loaded at runtime via DataManager → getExternalToolsForSkill()
  //
  // RULES-ACCURATE MECHANICS:
  // - Woodcutting: tier affects success rate, roll frequency is fixed (4 ticks)
  // - Mining: rollTicks affects roll frequency, success rate is level-only
  // - Fishing: Equipment doesn't affect speed or success
  //
  // =============================================================================

  constructor(world: World) {
    super(world, {
      name: "resource",
      dependencies: {
        required: [], // Resource system can work independently
        optional: ["inventory", "skills", "ui", "terrain", "database"], // Better with inventory, skills, UI, terrain, and durable node state
      },
      autoCleanup: true,
    });
  }

  /**
   * Helper to send network messages (DRY principle)
   */
  private sendNetworkMessage(method: string, data: unknown): void {
    const network = this.world.network as
      { send?: (method: string, data: unknown) => void } | undefined;
    if (network?.send) {
      network.send(method, data);
    }
  }

  /**
   * Calculate all tiles occupied by a resource based on its anchor tile and footprint
   *
   * RULES ACCURACY: Multi-tile resources (like large trees) occupy multiple tiles.
   * The anchor tile is the SW corner, and this function returns all tiles
   * in the rectangular footprint.
   *
   * @param anchorTile - SW corner tile of the resource
   * @param footprint - Footprint type (standard=1×1, large=2×2, massive=3×3)
   * @returns Array of all occupied tile coordinates
   */
  private getOccupiedTiles(
    anchorTile: TileCoord,
    footprint: ResourceFootprint,
  ): TileCoord[] {
    const size = FOOTPRINT_SIZES[footprint];
    const tiles: TileCoord[] = [];

    for (let dx = 0; dx < size.x; dx++) {
      for (let dz = 0; dz < size.z; dz++) {
        tiles.push({
          x: anchorTile.x + dx,
          z: anchorTile.z + dz,
        });
      }
    }

    return tiles;
  }

  async init(): Promise<void> {
    // Set up type-safe event subscriptions for resource management
    this.subscribe<TerrainResourceSpawnBatch>(
      EventType.RESOURCE_SPAWN_POINTS_REGISTERED,
      async (data) => {
        await this.registerTerrainResources(data);
      },
    );

    // Subscribe to direct harvest requests from ResourceEntity interactions
    this.subscribe(EventType.RESOURCE_HARVEST_REQUEST, (data) => {
      // Forward to RESOURCE_GATHER handler with correct format
      this.world.emit(EventType.RESOURCE_GATHER, {
        playerId: data.playerId,
        resourceId: data.entityId, // entityId is the resource entity ID
        playerPosition: undefined, // Will be looked up from player entity
      });
    });

    this.subscribe<{
      playerId: string;
      resourceId: string;
      playerPosition?: { x: number; y: number; z: number };
      completionAttemptId?: string;
    }>(EventType.RESOURCE_GATHER, (data) => {
      const playerPosition =
        data.playerPosition ||
        (() => {
          const player = this.world.getPlayer?.(data.playerId);
          return player &&
            (player as { position?: { x: number; y: number; z: number } })
              .position
            ? (player as { position: { x: number; y: number; z: number } })
                .position
            : { x: 0, y: 0, z: 0 };
        })();
      this.requestGathering({
        playerId: data.playerId,
        resourceId: data.resourceId,
        playerPosition,
        completionAttemptId: data.completionAttemptId,
      });
    });

    // Set up player gathering event subscriptions (RESOURCE_GATHER only to avoid loops)
    this.subscribe<{ playerId: string; resourceId: string }>(
      EventType.RESOURCE_GATHERING_STOPPED,
      (data) => this.stopGathering(data),
    );
    this.subscribe<{ id: string }>(EventType.PLAYER_UNREGISTERED, (data) =>
      this.cleanupPlayerGathering(data.id),
    );

    // RULES ACCURACY: Cancel gathering when player clicks to move anywhere
    // In classic MMORPG, gathering uses "weak queue" which is cancelled by ANY click (even same tile)
    // This ensures clicking ground under yourself cancels gathering, matching classic MMORPG behavior
    this.subscribe<{
      playerId: string;
      targetPosition: { x: number; y: number; z: number };
    }>(EventType.MOVEMENT_CLICK_TO_MOVE, (data) => {
      const playerId = createPlayerID(data.playerId);
      const session = this.activeGathering.get(playerId);
      if (session) {
        // Cancel gathering - player clicked to move (weak queue behavior)
        this.publishBoundGatheringFailure(session, "movement");
        this.emitTypedEvent(EventType.RESOURCE_GATHERING_STOPPED, {
          playerId: data.playerId,
          resourceId: session.resourceId,
        });
        this.resetGatheringEmote(data.playerId);
        this.activeGathering.delete(playerId);
      }
    });

    // RULES ACCURACY: Cancel gathering when player dies
    // Critical: Dead players cannot continue gathering
    this.subscribe<{ entityId: string; entityType: string }>(
      EventType.ENTITY_DEATH,
      (data) => {
        if (data.entityType === "player") {
          this.cancelGatheringForPlayer(data.entityId, "died");
        }
      },
    );

    // RULES ACCURACY: Cancel gathering when player teleports
    // Cannot gather from a resource across the map
    this.subscribe<{
      playerId: string;
      position: { x: number; y: number; z: number };
    }>(EventType.PLAYER_TELEPORT_REQUEST, (data) => {
      this.cancelGatheringForPlayer(data.playerId, "teleported");
    });

    // RULES ACCURACY: Cancel gathering when player initiates combat
    // Attacking a mob/player is a new action that replaces gathering
    this.subscribe<{
      attackerId?: string;
      playerId?: string;
      targetId: string;
      attackerType: string;
      targetType: string;
    }>(EventType.COMBAT_ATTACK_REQUEST, (data) => {
      const playerId = data.attackerId || data.playerId;
      if (playerId) {
        this.cancelGatheringForPlayer(playerId, "combat");
      }
    });

    this.subscribe<{ attackerId: string; targetId: string }>(
      EventType.COMBAT_STARTED,
      (data) => {
        this.cancelGatheringForPlayer(data.attackerId, "combat");
        if (data.targetId !== data.attackerId) {
          this.cancelGatheringForPlayer(data.targetId, "combat");
        }
      },
    );

    // RULES ACCURACY: Cancel gathering when player opens bank
    // Opening interface = new action
    this.subscribe<{ playerId: string; bankId?: string }>(
      EventType.BANK_OPEN,
      (data) => {
        this.cancelGatheringForPlayer(data.playerId, "bank_open");
      },
    );

    // RULES ACCURACY: Cancel gathering when player opens store
    // Opening interface = new action
    this.subscribe<{ playerId: string; storeId?: string }>(
      EventType.STORE_OPEN,
      (data) => {
        this.cancelGatheringForPlayer(data.playerId, "store_open");
      },
    );

    // RULES ACCURACY: Cancel gathering when player interacts with any entity
    // Clicking on an entity (NPC, player, object) = new action
    // Exception: Don't cancel if interacting with the same resource we're gathering
    this.subscribe<{
      playerId: string;
      entityId: string;
      interactionType: string;
    }>(EventType.ENTITY_INTERACT_REQUEST, (data) => {
      const playerId = createPlayerID(data.playerId);
      const session = this.activeGathering.get(playerId);
      // Only cancel if interacting with a DIFFERENT entity than what we're gathering
      if (session && session.resourceId !== data.entityId) {
        this.cancelGatheringForPlayer(data.playerId, "entity_interact");
      }
    });

    // RULES ACCURACY: Cancel gathering when player drops an item
    // Dropping is an action that should cancel gathering
    // Also prevents database deadlocks between inventory insert (gathering) and delete (drop)
    this.subscribe<{
      playerId: string;
      itemId: string;
      quantity?: number;
      slot?: number;
    }>(EventType.ITEM_DROP, (data) => {
      this.cancelGatheringForPlayer(data.playerId, "item_drop");
    });

    // RULES ACCURACY: Cancel gathering when equipping/unequipping items
    // In classic MMORPG, equipment changes are distinct actions that interrupt gathering
    this.subscribe<{
      playerId: string;
      itemId: string;
      slot?: string;
    }>(EventType.EQUIPMENT_EQUIP, (data) => {
      this.cancelGatheringForPlayer(data.playerId, "equip_item");
    });

    this.subscribe<{
      playerId: string;
      itemId: string;
      slot?: string;
    }>(EventType.EQUIPMENT_UNEQUIP, (data) => {
      this.cancelGatheringForPlayer(data.playerId, "unequip_item");
    });

    // Terrain resources now flow through RESOURCE_SPAWN_POINTS_REGISTERED only
    this.subscribe(EventType.TERRAIN_TILE_UNLOADED, (data) =>
      this.onTerrainTileUnloaded(data),
    );

    // Listen to skills updates for reactive patterns
    this.subscribe<{
      playerId: string;
      skills: Record<string, { level: number; xp: number }>;
    }>(EventType.SKILLS_UPDATED, (data) => {
      this.playerSkills.set(data.playerId, data.skills);
    });

    // Get terrain system for height lookups
    this.terrainSystem = this.world.getSystem(
      "terrain",
    ) as TerrainSystem | null;
  }

  private sendChat(_playerId: string | PlayerID, text: string): void {
    // Note: playerId unused - system messages are broadcast, not targeted
    const chat = this.world.chat;
    const msg = {
      id: uuid(),
      from: "System",
      fromId: null,
      body: text,
      text,
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
    };
    chat.add(msg, true);
  }

  /**
   * Set gathering emote for a player
   */
  private setGatheringEmote(playerId: string, emote: string): void {
    const playerEntity = this.world.getPlayer?.(playerId);
    if (playerEntity) {
      if (DEBUG_GATHERING) {
        console.log(
          `[ResourceSystem] 🪓 Setting ${emote} emote for ${playerId}`,
        );
      }

      // Set emote STRING KEY (players use emote strings which get mapped to URLs)
      const playerWithEmote = playerEntity as PlayerWithEmote;
      if (playerWithEmote.emote !== undefined) {
        playerWithEmote.emote = emote;
      }
      if (playerWithEmote.data) {
        playerWithEmote.data.e = emote;
      }

      // Send immediate network update for emote (same pattern as CombatSystem)
      // This ensures the emote update arrives at clients immediately
      if (this.world.isServer && this.world.network?.send) {
        this.world.network.send("entityModified", {
          id: playerId,
          e: emote,
        });
      }

      playerWithEmote.markNetworkDirty?.();
    }
  }

  /**
   * Reset gathering emote back to idle
   */
  private resetGatheringEmote(playerId: string): void {
    const playerEntity = this.world.getPlayer?.(playerId);
    if (playerEntity) {
      if (DEBUG_GATHERING) {
        console.log(
          `[ResourceSystem] 🪓 Resetting emote to idle for ${playerId}`,
        );
      }

      // Reset to idle
      const playerWithEmote = playerEntity as PlayerWithEmote;
      if (playerWithEmote.emote !== undefined) {
        playerWithEmote.emote = "idle";
      }
      if (playerWithEmote.data) {
        playerWithEmote.data.e = "idle";
      }

      // Send immediate network update for emote reset (same pattern as CombatSystem)
      if (this.world.isServer && this.world.network?.send) {
        this.world.network.send("entityModified", {
          id: playerId,
          e: "idle",
        });
      }

      playerWithEmote.markNetworkDirty?.();
    }
  }

  private setGatheringToolPresentationState(
    playerId: string,
    itemId: string | null,
  ): number {
    const pid = createPlayerID(playerId);
    const playerEntity = this.world.getPlayer?.(playerId) as
      PlayerWithEmote | undefined;
    const serializedRevision =
      playerEntity?.data?.gatheringToolPresentation?.revision;
    const validSerializedRevision =
      typeof serializedRevision === "number" &&
      Number.isSafeInteger(serializedRevision) &&
      serializedRevision >= 0
        ? serializedRevision
        : 0;
    const previousRevision = Math.max(
      this.gatheringToolPresentationRevisions.get(pid) ?? 0,
      validSerializedRevision,
    );
    const revision = previousRevision + 1;
    this.gatheringToolPresentationRevisions.set(pid, revision);

    if (playerEntity) {
      playerEntity.data ??= {};
      playerEntity.data.gatheringToolPresentation = { revision, itemId };
      playerEntity.markNetworkDirty?.();
    }
    return revision;
  }

  private showGatheringTool(playerId: string, itemId: string): void {
    const revision = this.setGatheringToolPresentationState(playerId, itemId);
    this.emitTypedEvent(EventType.GATHERING_TOOL_SHOW, {
      playerId,
      itemId,
      slot: "weapon",
      revision,
    });
  }

  private hideGatheringTool(playerId: string): void {
    const revision = this.setGatheringToolPresentationState(playerId, null);
    this.emitTypedEvent(EventType.GATHERING_TOOL_HIDE, {
      playerId,
      slot: "weapon",
      revision,
    });
    const playerEntity = this.world.getPlayer?.(playerId) as
      PlayerWithEmote | undefined;
    if (
      playerEntity?.data?.fishingInteractionPresentation &&
      playerEntity.data.fishingInteractionPresentation.phase !== "idle"
    ) {
      this.clearFishingInteractionPresentation(playerId);
    }
  }

  private publishFishingInteractionPresentation(
    playerId: string,
    session: {
      resourceId: ResourceID;
      attempts: number;
      fishingInteraction: ActiveFishingInteractionPresentation | null;
    },
  ): void {
    const interaction = session.fishingInteraction;
    if (!interaction) return;
    const pid = createPlayerID(playerId);
    const playerEntity = this.world.getPlayer?.(playerId) as
      PlayerWithEmote | undefined;
    const serializedRevision =
      playerEntity?.data?.fishingInteractionPresentation?.revision;
    const validSerializedRevision =
      typeof serializedRevision === "number" &&
      Number.isSafeInteger(serializedRevision) &&
      serializedRevision >= 0
        ? serializedRevision
        : 0;
    const revision =
      Math.max(
        this.fishingInteractionPresentationRevisions.get(pid) ?? 0,
        validSerializedRevision,
      ) + 1;
    this.fishingInteractionPresentationRevisions.set(pid, revision);
    const state: FishingInteractionPresentationState = {
      revision,
      interactionId: interaction.interactionId,
      resourceId: session.resourceId,
      itemId: interaction.itemId,
      phase: interaction.phase,
      outcome: interaction.outcome,
      attempt: session.attempts,
      serverTick: Math.max(
        0,
        this.fishingPresentationServerTick,
        this.world.currentTick || 0,
      ),
      phaseStartedAtServerTimeMs: interaction.phaseStartedAtServerTimeMs,
      targetPosition: { ...interaction.targetPosition },
    };
    if (playerEntity) {
      playerEntity.data ??= {};
      playerEntity.data.fishingInteractionPresentation = state;
      playerEntity.markNetworkDirty?.();
    }
    this.emitTypedEvent(EventType.FISHING_INTERACTION_PRESENTATION, {
      playerId,
      ...state,
    });
  }

  private clearFishingInteractionPresentation(playerId: string): void {
    const pid = createPlayerID(playerId);
    const playerEntity = this.world.getPlayer?.(playerId) as
      PlayerWithEmote | undefined;
    const serializedRevision =
      playerEntity?.data?.fishingInteractionPresentation?.revision;
    const validSerializedRevision =
      typeof serializedRevision === "number" &&
      Number.isSafeInteger(serializedRevision) &&
      serializedRevision >= 0
        ? serializedRevision
        : 0;
    const revision =
      Math.max(
        this.fishingInteractionPresentationRevisions.get(pid) ?? 0,
        validSerializedRevision,
      ) + 1;
    this.fishingInteractionPresentationRevisions.set(pid, revision);
    const state: FishingInteractionPresentationState = {
      revision,
      interactionId: null,
      resourceId: null,
      itemId: null,
      phase: "idle",
      outcome: "none",
      attempt: 0,
      serverTick: Math.max(
        0,
        this.fishingPresentationServerTick,
        this.world.currentTick || 0,
      ),
      phaseStartedAtServerTimeMs: performance.now(),
      targetPosition: null,
    };
    if (playerEntity) {
      playerEntity.data ??= {};
      playerEntity.data.fishingInteractionPresentation = state;
      playerEntity.markNetworkDirty?.();
    }
    this.emitTypedEvent(EventType.FISHING_INTERACTION_PRESENTATION, {
      playerId,
      ...state,
    });
  }

  private transitionFishingInteraction(
    playerId: PlayerID,
    session: {
      resourceId: ResourceID;
      attempts: number;
      fishingInteraction: ActiveFishingInteractionPresentation | null;
    },
    phase: FishingInteractionPhase,
    outcome: FishingInteractionOutcome,
    nextTransitionTick: number | null,
  ): void {
    if (!session.fishingInteraction) return;
    const previousBodyEmote = resolveFishingInteractionBodyEmote(
      session.fishingInteraction.itemId,
      session.fishingInteraction.phase,
    );
    if (session.fishingInteraction.phase !== phase) {
      session.fishingInteraction.phaseStartedAtServerTimeMs = performance.now();
    }
    session.fishingInteraction.phase = phase;
    session.fishingInteraction.outcome = outcome;
    session.fishingInteraction.nextTransitionTick = nextTransitionTick;
    const nextBodyEmote = resolveFishingInteractionBodyEmote(
      session.fishingInteraction.itemId,
      phase,
    );
    if (nextBodyEmote !== previousBodyEmote) {
      this.setGatheringEmote(playerId, nextBodyEmote);
    }
    this.publishFishingInteractionPresentation(playerId, session);
  }

  private advanceFishingInteractionPresentations(tickNumber: number): void {
    for (const [playerId, session] of this.activeGathering) {
      const interaction = session.fishingInteraction;
      if (
        !interaction ||
        interaction.nextTransitionTick === null ||
        tickNumber < interaction.nextTransitionTick ||
        (interaction.awaitingOperationId &&
          !(
            interaction.itemId === "harpoon" && interaction.phase === "striking"
          ))
      ) {
        continue;
      }

      const next = nextFishingInteractionTransition(
        interaction.itemId,
        interaction.phase,
        interaction.outcome,
        tickNumber,
      );
      if (!next) continue;
      this.transitionFishingInteraction(
        playerId,
        session,
        next.phase,
        next.outcome,
        next.nextTransitionTick,
      );
    }
  }

  private publishFishingAttemptPresentation(
    playerId: PlayerID,
    session: {
      resourceId: ResourceID;
      attempts: number;
      fishingInteraction: ActiveFishingInteractionPresentation | null;
    },
    successful: boolean,
    tickNumber: number,
  ): void {
    const interaction = session.fishingInteraction;
    if (!interaction) return;
    const outcome: FishingInteractionOutcome = successful ? "pending" : "miss";
    const nextTransitionTick =
      interaction.itemId === "harpoon"
        ? tickNumber + 1
        : !successful
          ? tickNumber + 2
          : null;
    const phase: FishingInteractionPhase =
      interaction.itemId === "harpoon"
        ? "striking"
        : successful
          ? "deployed"
          : "retrieving";
    this.transitionFishingInteraction(
      playerId,
      session,
      phase,
      outcome,
      nextTransitionTick,
    );
  }

  async start(): Promise<void> {
    // Resources will be spawned procedurally by TerrainSystem across all terrain tiles
    // No need for manual default spawning - TerrainSystem generates resources based on biome
    // NOTE: Gathering is now processed via processGatheringTick() called by TickSystem
    // The old 500ms interval has been removed in favor of rules-accurate 600ms tick-based processing
    // Registration happens in ServerNetwork/index.ts at TickPriority.RESOURCES

    // Load explicit resource placements from world-areas.json (server only)
    // This must be in start() not init() because network broadcast isn't ready during init()
    if (this.world.isServer) {
      await this.initializeWorldAreaResources();

      // SECURITY: Periodic cleanup of stale rate limit entries
      // Prevents memory leak from disconnected players
      this.createInterval(() => {
        const now = Date.now();
        for (const [playerId, timestamp] of this.gatherRateLimits) {
          if (now - timestamp > GATHERING_CONSTANTS.STALE_RATE_LIMIT_MS) {
            this.gatherRateLimits.delete(playerId);
          }
        }
      }, GATHERING_CONSTANTS.RATE_LIMIT_CLEANUP_INTERVAL_MS);
    }
  }

  update(_dt: number): void {}

  /**
   * Initialize resources from world-areas.json manifest
   * Called once on server startup to spawn explicit resource placements
   */
  private async initializeWorldAreaResources(): Promise<void> {
    // Type mapping: resources.json type → TerrainResourceSpawnPoint type
    const typeMap: Record<string, TerrainResourceSpawnPoint["type"]> = {
      tree: "tree",
      fishing_spot: "fish",
      herb_patch: "herb",
      rock: "rock",
      ore: "ore",
    };

    if (DEBUG_GATHERING) {
      console.log(
        `[ResourceSystem] initializeWorldAreaResources() called. ALL_WORLD_AREAS keys: ${Object.keys(ALL_WORLD_AREAS).join(", ")}`,
      );
    }

    for (const [areaId, area] of Object.entries(ALL_WORLD_AREAS)) {
      const hasResources = area.resources && area.resources.length > 0;
      const hasFishing = area.fishing?.enabled;
      if (!hasResources && !hasFishing) continue;
      if (DEBUG_GATHERING) {
        console.log(
          `[ResourceSystem] Processing area "${areaId}" with ${area.resources?.length ?? 0} resources${hasFishing ? " + fishing" : ""}`,
        );
      }

      const spawnPoints: TerrainResourceSpawnPoint[] = [];

      for (const r of area.resources) {
        // Look up resource in manifest to get authoritative type
        const resourceData = getExternalResource(r.resourceId);
        if (DEBUG_GATHERING) {
          console.log(
            `[ResourceSystem] getExternalResource("${r.resourceId}") returned: ${resourceData ? resourceData.type : "null"}`,
          );
        }
        if (!resourceData) {
          console.warn(
            `[ResourceSystem] Unknown resource ID in world-areas: ${r.resourceId}`,
          );
          continue;
        }

        // Map type (e.g., "fishing_spot" → "fish")
        const mappedType = typeMap[resourceData.type] || resourceData.type;

        // Extract subType by removing type prefix from resourceId
        // "tree_oak" - "tree_" = "oak"
        // "tree_normal" - "tree_" = "normal" → undefined
        const suffix = r.resourceId.replace(resourceData.type + "_", "");
        const subType = suffix === "normal" ? undefined : suffix;

        // Fishing retains its authored water-surface contract. Land is grounded
        // once, after tile-center snapping, by createResourceFromSpawnPoint.
        let groundedY = r.position.y;
        if (this.terrainSystem && resourceData.type === "fishing_spot") {
          const authoredHeight = this.terrainSystem
            .getWaterBodyRegistry()
            .getWaterSurfaceAt(r.position.x, r.position.z);
          if (Number.isFinite(authoredHeight)) {
            groundedY = authoredHeight;
          }
        }

        spawnPoints.push({
          position: { x: r.position.x, y: groundedY, z: r.position.z },
          type: mappedType as TerrainResourceSpawnPoint["type"],
          subType: subType as TerrainResourceSpawnPoint["subType"],
          instanceId: r.instanceId,
        });
      }

      if (spawnPoints.length > 0) {
        if (DEBUG_GATHERING) {
          console.log(
            `[ResourceSystem] Spawning ${spawnPoints.length} explicit resources for area "${areaId}"`,
          );
        }
        // Pass isManifest: true to protect these resources from tile unload deletion
        await this.registerTerrainResources({ spawnPoints, isManifest: true });
      }

      // Spawn dynamic fishing spots if configured for this area
      if (area.fishing?.enabled) {
        this.spawnDynamicFishingSpots(areaId, area);
      }
    }
  }

  /**
   * Dynamically spawn fishing spots at detected shore positions within an area.
   * Uses terrain height sampling to find valid water edges.
   *
   * @param areaId - Area identifier for logging
   * @param area - World area configuration with fishing config
   */
  private spawnDynamicFishingSpots(areaId: string, area: WorldArea): void {
    if (DEBUG_GATHERING) {
      console.log(
        `[ResourceSystem] 🎣 spawnDynamicFishingSpots called for ${areaId} ` +
          `bounds: (${area.bounds.minX},${area.bounds.minZ}) to (${area.bounds.maxX},${area.bounds.maxZ})`,
      );
    }

    if (!this.terrainSystem) {
      console.warn(
        `[ResourceSystem] No terrain system available - skipping dynamic fishing for ${areaId}`,
      );
      return;
    }

    // Debug: Sample heights across the bounds to find water
    const sampleStep = 50; // Sample every 50m
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    let waterCount = 0;
    let shoreCount = 0;
    let totalSamples = 0;
    let lowestPoint = { x: 0, z: 0, h: Infinity };

    for (let x = area.bounds.minX; x <= area.bounds.maxX; x += sampleStep) {
      for (let z = area.bounds.minZ; z <= area.bounds.maxZ; z += sampleStep) {
        const h = this.terrainSystem!.getHeightAt(x, z);
        totalSamples++;
        if (h < minHeight) {
          minHeight = h;
          lowestPoint = { x, z, h };
        }
        if (h > maxHeight) maxHeight = h;
        if (h < TERRAIN_CONSTANTS.WATER_THRESHOLD) waterCount++;
        if (h >= TERRAIN_CONSTANTS.WATER_THRESHOLD && h <= 20.0) shoreCount++;
      }
    }

    if (DEBUG_GATHERING) {
      console.log(
        `[ResourceSystem] 🎣 Terrain scan in ${areaId}: ` +
          `min=${minHeight.toFixed(1)}m, max=${maxHeight.toFixed(1)}m, ` +
          `water=${waterCount}/${totalSamples}, shore=${shoreCount}/${totalSamples}`,
      );
      console.log(
        `[ResourceSystem] 🎣 Lowest point: (${lowestPoint.x},${lowestPoint.z})=${lowestPoint.h.toFixed(2)}m`,
      );
      console.log(
        `[ResourceSystem] 🎣 Looking for: water < ${TERRAIN_CONSTANTS.WATER_THRESHOLD}m adjacent to shore ${TERRAIN_CONSTANTS.WATER_THRESHOLD}-20.0m`,
      );
    }

    const fishing = area.fishing!;

    // Find spots at the visible water's edge using collision flags + terrain probing.
    // Walks from walkable land into water direction to find where terrain drops
    // below water surface — the exact point where water becomes visible.
    const getHeight = this.terrainSystem.getHeightAt.bind(this.terrainSystem);
    const registry = this.terrainSystem.getWaterBodyRegistry();
    const getWaterSurface = registry.getWaterSurfaceAt.bind(registry);
    let shorePoints = findFishingSpotTiles(
      this.world.collision,
      area.bounds,
      getHeight,
      getWaterSurface,
      GATHERING_CONSTANTS.FISHING_SPOT_MOVE.shoreMinSpacing,
    );

    // Static fishing spots are the reliable launch baseline. Keep dynamic
    // ecology as supplemental variety without ever spawning a second entity
    // onto an authored spot's tile.
    const authoredFishingTiles = new Set(
      area.resources
        .filter(
          (resource) =>
            getExternalResource(resource.resourceId)?.type === "fishing_spot",
        )
        .map((resource) => {
          const tile = worldToTile(resource.position.x, resource.position.z);
          return `${tile.x},${tile.z}`;
        }),
    );
    shorePoints = shorePoints.filter((point) => {
      const tile = worldToTile(point.x, point.z);
      return !authoredFishingTiles.has(`${tile.x},${tile.z}`);
    });

    // If collision flags returned nothing, terrain tiles aren't baked yet
    // (called at server startup before tiles load). Queue for retry — the
    // collision-flag approach is the only one that guarantees alignment with
    // the water mesh, so we never fall back to height sampling.
    if (shorePoints.length === 0) {
      if (DEBUG_GATHERING) {
        console.log(
          `[ResourceSystem] 🎣 No collision WATER flags in ${areaId} — tiles not baked yet, deferring fishing spot spawn`,
        );
      }
      this.pendingFishingAreas.set(areaId, area);
      return;
    }

    // Collision flags were available and returned results — remove from pending
    this.pendingFishingAreas.delete(areaId);

    if (DEBUG_GATHERING) {
      console.log(
        `[ResourceSystem] 🎣 Found ${shorePoints.length} shore points in ${areaId}`,
      );
    }

    if (shorePoints.length === 0) {
      console.warn(
        `[ResourceSystem] ⚠️ No shore points found in ${areaId} - no dynamic fishing spots spawned. ` +
          `Area may not have walkable land adjacent to water.`,
      );
      return;
    }

    // Randomize order for variety
    shuffleArray(shorePoints);

    // Determine how many spots to spawn (at least one of each type if possible)
    const spotsToSpawn = Math.min(fishing.spotCount, shorePoints.length);

    // Build spawn points (round-robin through spot types to ensure variety)
    const spawnPoints: TerrainResourceSpawnPoint[] = [];
    const spawnedTypes: string[] = [];

    for (let i = 0; i < spotsToSpawn; i++) {
      const point = shorePoints[i];
      const spotTypeId = fishing.spotTypes[i % fishing.spotTypes.length];

      // Extract subType: "fishing_spot_net" -> "net"
      const subType = spotTypeId.replace("fishing_spot_", "");

      spawnPoints.push({
        position: { x: point.x, y: point.y, z: point.z },
        type: "fish",
        subType: subType as TerrainResourceSpawnPoint["subType"],
      });
      spawnedTypes.push(subType);
    }

    if (DEBUG_GATHERING) {
      console.log(
        `[ResourceSystem] 🎣 Spawning fishing spots in ${areaId}: ${spawnedTypes.join(", ")}`,
      );
    }

    // Use existing spawn infrastructure
    if (spawnPoints.length > 0) {
      if (DEBUG_GATHERING) {
        console.log(
          `[ResourceSystem] Spawning ${spawnPoints.length} dynamic fishing spots in ${areaId} ` +
            `(found ${shorePoints.length} shore points)`,
        );
      }
      this.registerTerrainResources({ spawnPoints, isManifest: true });
    }
  }

  /**
   * Handle terrain system resource registration (new procedural system)
   * @param data.spawnPoints - Resource spawn points to register
   * @param data.isManifest - If true, resources are from world-areas.json and won't be deleted on tile unload
   */
  private async registerTerrainResources(
    data: TerrainResourceSpawnBatch,
  ): Promise<void> {
    if (this.isDestroying) return;
    const { isManifest = false, owner } = data;
    if (isManifest && owner) {
      throw new Error(
        "[ResourceSystem] Authored resources cannot have a tile owner",
      );
    }
    if (
      owner &&
      (!Number.isSafeInteger(owner.tileX) || !Number.isSafeInteger(owner.tileZ))
    ) {
      throw new Error("[ResourceSystem] Invalid terrain resource owner");
    }
    // Older callers may omit the owner. Split those batches using the same
    // centered convention; production TerrainSystem always sends an owner.
    if (!isManifest && !owner) {
      const groups = new Map<string, TerrainResourceSpawnBatch>();
      for (const point of data.spawnPoints) {
        const tileX = centeredTerrainTileIndex(
          point.position.x,
          TERRAIN_CONSTANTS.TERRAIN_TILE_SIZE,
        );
        const tileZ = centeredTerrainTileIndex(
          point.position.z,
          TERRAIN_CONSTANTS.TERRAIN_TILE_SIZE,
        );
        const key = `${tileX},${tileZ}`;
        let group = groups.get(key);
        if (!group) {
          group = { owner: { tileX, tileZ }, spawnPoints: [] };
          groups.set(key, group);
        }
        group.spawnPoints.push(point);
      }
      await Promise.all(
        [...groups.values()].map((group) =>
          this.registerTerrainResources(group),
        ),
      );
      return;
    }

    const registrations = new Map<ResourceID, TerrainResourceRegistration>();
    for (const input of data.spawnPoints) {
      // Detach from the generator's mutable tile storage before the first await.
      const spawnPoint = { ...input, position: { ...input.position } };
      const { x, y, z } = spawnPoint.position;
      if (
        ![x, y, z].every(Number.isFinite) ||
        (spawnPoint.scale !== undefined &&
          (!Number.isFinite(spawnPoint.scale) || spawnPoint.scale <= 0)) ||
        (spawnPoint.rotation !== undefined &&
          !Number.isFinite(spawnPoint.rotation))
      ) {
        throw new Error("[ResourceSystem] Invalid terrain resource transform");
      }
      const resource = this.createResourceFromSpawnPoint(
        spawnPoint,
        isManifest,
      );
      if (!resource) continue;
      if (
        owner &&
        (centeredTerrainTileIndex(
          resource.position.x,
          TERRAIN_CONSTANTS.TERRAIN_TILE_SIZE,
        ) !== owner.tileX ||
          centeredTerrainTileIndex(
            resource.position.z,
            TERRAIN_CONSTANTS.TERRAIN_TILE_SIZE,
          ) !== owner.tileZ)
      ) {
        throw new Error(
          `[ResourceSystem] Resource ${resource.id} lies outside its tile owner`,
        );
      }
      const signature = JSON.stringify([
        spawnPoint.type,
        spawnPoint.subType ?? null,
        resource.position.x,
        resource.position.y,
        resource.position.z,
        spawnPoint.scale ?? 1,
        spawnPoint.rotation ?? null,
      ]);
      const id = createResourceID(resource.id);
      const duplicate = registrations.get(id);
      const existing = this.terrainResourceRegistrations.get(id);
      if (
        (duplicate && duplicate.signature !== signature) ||
        (existing && existing.registration.signature !== signature)
      ) {
        throw new Error(
          `[ResourceSystem] Conflicting registration for ${resource.id}`,
        );
      }
      registrations.set(id, { spawnPoint, resource, signature, entity: null });
    }
    const key = isManifest
      ? `manifest:${[...registrations.keys()].sort().join("|")}`
      : `tile:${owner!.tileX},${owner!.tileZ}`;
    const signature = JSON.stringify(
      [...registrations].map(([id, entry]) => [id, entry.signature]).sort(),
    );
    const previous = this.terrainResourceLeases.get(key);
    if (previous?.signature === signature) {
      await previous.completion;
      return;
    }
    for (const [id] of registrations) {
      const existing = this.terrainResourceRegistrations.get(id);
      if (!existing || existing.lease === previous) continue;
      if (isManifest && existing.lease.isManifest) {
        // Overlapping authored calls can repeat identical nodes without taking
        // ownership away from their original permanent batch.
        registrations.delete(id);
        continue;
      }
      throw new Error(`[ResourceSystem] Conflicting resource owner for ${id}`);
    }
    const priorCompletion = this.terrainResourceTails.get(key);
    if (previous) this.retireTerrainResourceLease(previous);
    const lease: TerrainResourceLease = {
      key,
      isManifest,
      signature,
      active: true,
      registrations,
      completion: Promise.resolve(),
    };
    this.terrainResourceLeases.set(key, lease);
    for (const [id, registration] of registrations) {
      this.terrainResourceRegistrations.set(id, { lease, registration });
    }
    const completion = (async () => {
      try {
        if (priorCompletion) await priorCompletion.catch(() => undefined);
        if (!this.isTerrainResourceLeaseCurrent(lease)) return;
        await this.spawnTerrainResourceLease(lease);
      } catch (error) {
        if (this.isTerrainResourceLeaseCurrent(lease))
          this.retireTerrainResourceLease(lease);
        throw error;
      }
    })();
    lease.completion = completion;
    this.terrainResourceTails.set(key, completion);
    try {
      await completion;
    } finally {
      if (this.terrainResourceTails.get(key) === completion)
        this.terrainResourceTails.delete(key);
    }
  }

  private isTerrainResourceLeaseCurrent(lease: TerrainResourceLease): boolean {
    return (
      !this.isDestroying &&
      lease.active &&
      this.terrainResourceLeases.get(lease.key) === lease
    );
  }

  /** An actual authoritative add can reuse a client-created terrain instance. */
  claimNetworkResourceOwnership(entity: Entity): void {
    if (
      this.world.isServer ||
      this.isDestroying ||
      !(entity instanceof ResourceEntity) ||
      this.world.entities.get(entity.id) !== entity
    )
      return;
    const registration = this.terrainResourceRegistrations.get(
      createResourceID(entity.id),
    )?.registration;
    if (registration?.entity === entity) registration.entity = null;
    if (registration) {
      registration.resource.isAvailable = !entity.config.depleted;
      registration.resource.position = {
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z,
      };
    }
  }

  private removeTerrainResourceState(id: ResourceID): void {
    for (const [playerId, session] of this.activeGathering) {
      if (session.resourceId === id)
        this.cancelGatheringForPlayer(playerId, "terrain_tile_unloaded");
    }
    this.resources.delete(id);
    this.resourceVariants.delete(id);
    this.resourceTimers.delete(id);
    this.respawnAtTick.delete(id);
    this.fishingSpotMoveTimers.delete(id);
    this.manifestResourceIds.delete(id);
  }

  private destroyOwnedTerrainEntity(entity: Entity): void {
    const manager = this.world.getSystem<EntityManager>("entity-manager");
    if (this.world.isServer) {
      // Never delete an entity which another owner installed under the same ID.
      if (
        manager?.getEntity(entity.id) === entity &&
        this.world.entities.get(entity.id) === entity
      )
        manager.destroyEntity(entity.id);
    } else if (this.world.entities.get(entity.id) === entity) {
      this.world.entities.remove(entity.id);
    }
  }

  private retireTerrainResourceLease(lease: TerrainResourceLease): void {
    lease.active = false;
    if (this.terrainResourceLeases.get(lease.key) === lease)
      this.terrainResourceLeases.delete(lease.key);
    for (const [id, registration] of lease.registrations) {
      if (this.terrainResourceRegistrations.get(id)?.lease !== lease) continue;
      this.terrainResourceRegistrations.delete(id);
      this.removeTerrainResourceState(id);
      if (registration.entity)
        this.destroyOwnedTerrainEntity(registration.entity);
    }
  }

  private async spawnTerrainResourceLease(
    lease: TerrainResourceLease,
  ): Promise<void> {
    const { isManifest } = lease;
    const preparedResources = [...lease.registrations.values()];
    const spawnPoints = preparedResources.map(({ spawnPoint }) => spawnPoint);

    if (!this.world.isServer) {
      for (const registration of preparedResources) {
        if (!this.isTerrainResourceLeaseCurrent(lease)) return;
        const { spawnPoint, resource } = registration;
        const existingEntity = this.world.entities.get(resource.id);
        if (
          existingEntity &&
          (!(existingEntity instanceof ResourceEntity) ||
            existingEntity.config.resourceId !==
              `${resource.type}_${spawnPoint.subType ?? "normal"}`)
        ) {
          throw new Error(
            `[ResourceSystem] Conflicting network resource: ${resource.id}`,
          );
        }
        if (existingEntity instanceof ResourceEntity) {
          resource.isAvailable = !existingEntity.config.depleted;
          resource.position = {
            x: existingEntity.position.x,
            y: existingEntity.position.y,
            z: existingEntity.position.z,
          };
        }

        const rid = createResourceID(resource.id);
        this.resources.set(rid, resource);
        if (isManifest) this.manifestResourceIds.add(rid);

        const yRotation = spawnPoint.rotation ?? Math.random() * Math.PI * 2;
        const footprint: ResourceFootprint = resource.footprint || "standard";
        const anchorTile = worldToTile(
          resource.position.x,
          resource.position.z,
        );
        const occupiedTiles = this.getOccupiedTiles(anchorTile, footprint);
        const baseScale = this.getScaleForResource(
          resource.type,
          spawnPoint.subType,
        );
        const scaleVariation = spawnPoint.scale ?? 1.0;
        const finalScale = baseScale * scaleVariation;
        const baseDepletedScale = this.getDepletedScaleForResource(
          resource.type,
          spawnPoint.subType,
        );
        const finalDepletedScale = baseDepletedScale * scaleVariation;

        const entityData = {
          id: resource.id,
          type: "resource" as const,
          name: resource.name,
          position: [
            resource.position.x,
            resource.position.y,
            resource.position.z,
          ] as [number, number, number],
          quaternion: [
            0,
            Math.sin(yRotation / 2),
            0,
            Math.cos(yRotation / 2),
          ] as [number, number, number, number],
          scale: { x: 1, y: 1, z: 1 },
          visible: true,
          interactable: true,
          interactionType: "harvest",
          interactionDistance: 3,
          description: `${resource.name} - Requires level ${resource.levelRequired} ${resource.skillRequired}`,
          model: this.getModelPathForResource(
            resource.type,
            spawnPoint.subType,
          ),
          properties: {},
          resourceType: resource.type === "ore" ? "mining_rock" : resource.type,
          resourceId: spawnPoint.subType
            ? `${resource.type}_${spawnPoint.subType}`
            : `${resource.type}_normal`,
          harvestSkill: resource.skillRequired,
          requiredLevel: resource.levelRequired,
          harvestTime: 3000,
          harvestYield: resource.drops.map((drop) => ({
            itemId: drop.itemId,
            quantity: drop.quantity,
            chance: drop.chance,
          })),
          respawnTime: resource.respawnTime,
          depleted: false,
          depletedModelPath: this.getDepletedModelPathForResource(
            resource.type,
            spawnPoint.subType,
          ),
          modelScale: finalScale,
          depletedModelScale: finalDepletedScale,
          lod1Model: this.getLod1ModelPathForResource(
            resource.type,
            spawnPoint.subType,
          ),
          lod1ModelScale: finalScale,
          procgenPreset: this.getProcgenPresetForResource(
            resource.type,
            spawnPoint.subType,
          ),
          modelVariants: this.getModelVariantsForResource(
            resource.type,
            spawnPoint.subType,
          ),
          footprint,
          anchorTile,
          occupiedTiles,
        };

        const entity = this.world.entities.add(entityData);
        if (!(entity instanceof ResourceEntity))
          throw new Error(
            `[ResourceSystem] Unexpected resource entity: ${resource.id}`,
          );
        // A snapshot may have installed this entity before its terrain tile.
        // Borrow it; unloading local terrain must not dispose network ownership.
        if (!existingEntity) registration.entity = entity;
      }
      return;
    }

    const activeResourceStates = new Map<
      string,
      { depletedAt: number; respawnAt: number }
    >();
    const databaseSystem = this.world.getSystem?.<DatabaseSystem>("database");
    if (
      databaseSystem &&
      typeof databaseSystem.getGatheringResourceStatesAsync === "function" &&
      preparedResources.length > 0
    ) {
      try {
        const persisted = await databaseSystem.getGatheringResourceStatesAsync(
          preparedResources.map(({ resource }) => resource.id),
        );
        if (!this.isTerrainResourceLeaseCurrent(lease)) return;
        for (const state of persisted) {
          if (
            Number.isSafeInteger(state.depletedAt) &&
            Number.isSafeInteger(state.respawnAt) &&
            state.respawnAt > Date.now()
          ) {
            activeResourceStates.set(state.resourceId, state);
          }
        }
      } catch (error) {
        console.error(
          "[ResourceSystem] Durable gathering state could not be loaded; refusing to expose this resource batch.",
          error,
        );
        throw error;
      }
    }

    // Preserve the existing resource input (properties: {}). EntityConfig's
    // general-purpose property type requires component fields, but the actual
    // Entity/ResourceEntity constructors supply defaults. Keep that narrow input
    // adapter; the returned instance and cleanup methods are now precisely typed.
    const entityManager:
      | {
          spawnEntity(
            config: unknown,
            options?: { suppressBroadcast?: boolean },
          ): Promise<Entity | null>;
          getEntity: EntityManager["getEntity"];
          destroyEntity: EntityManager["destroyEntity"];
        }
      | undefined = this.world.getSystem<EntityManager>("entity-manager");
    if (!entityManager?.spawnEntity) {
      throw new Error(
        "[ResourceSystem] EntityManager not available, cannot spawn resources!",
      );
    }

    let spawned = 0;
    const batchedEntityData: unknown[] = [];

    for (const registration of preparedResources) {
      if (!this.isTerrainResourceLeaseCurrent(lease)) return;
      const { spawnPoint, resource } = registration;
      try {
        if (this.world.entities.get(resource.id)) {
          throw new Error(
            `[ResourceSystem] Entity already owned: ${resource.id}`,
          );
        }
        const persistedState = activeResourceStates.get(resource.id);
        const isPersistedDepleted = Boolean(persistedState);
        if (persistedState) {
          resource.isAvailable = false;
          resource.lastDepleted = persistedState.depletedAt;
        }
        const rid = createResourceID(resource.id);
        // Track variant/subtype for tuning (e.g., 'tree_oak', 'ore_copper')
        const variant = spawnPoint.subType
          ? `${resource.type}_${spawnPoint.subType}`
          : `${resource.type}_normal`;

        // Spawn actual ResourceEntity instance
        // Use rotation from spawn point if available (deterministic from BiomeResourceGenerator)
        // Otherwise fall back to random rotation
        const yRotation = spawnPoint.rotation ?? Math.random() * Math.PI * 2;
        const quat = {
          x: 0,
          y: Math.sin(yRotation / 2),
          z: 0,
          w: Math.cos(yRotation / 2),
        };

        // RULES ACCURACY: Calculate tile footprint data for proper interaction positioning
        const footprint: ResourceFootprint = resource.footprint || "standard";
        const anchorTile = worldToTile(
          resource.position.x,
          resource.position.z,
        );
        const occupiedTiles = this.getOccupiedTiles(anchorTile, footprint);

        // Get base scale from manifest and multiply by spawn point variation
        const baseScale = this.getScaleForResource(
          resource.type,
          spawnPoint.subType,
        );
        const scaleVariation = spawnPoint.scale ?? 1.0;
        const finalScale = baseScale * scaleVariation;

        // Same for depleted model scale
        const baseDepletedScale = this.getDepletedScaleForResource(
          resource.type,
          spawnPoint.subType,
        );
        const finalDepletedScale = baseDepletedScale * scaleVariation;

        const resourceConfig = {
          id: resource.id,
          type: EntityType.RESOURCE,
          name: resource.name,
          position: {
            x: resource.position.x,
            y: resource.position.y,
            z: resource.position.z,
          },
          rotation: quat, // Quaternion from spawn point or random
          scale: { x: 1, y: 1, z: 1 }, // ALWAYS uniform scale - ResourceEntity handles mesh scale
          visible: true,
          interactable: true,
          interactionType: InteractionType.HARVEST,
          interactionDistance: 3,
          description: `${resource.name} - Requires level ${resource.levelRequired} ${resource.skillRequired}`,
          model: this.getModelPathForResource(
            resource.type,
            spawnPoint.subType,
          ),
          properties: {},
          // ResourceEntity specific
          // Map manifest type to ResourceType enum value
          // Manifest uses: "tree", "ore", "fishing_spot"
          // Enum expects: "tree", "mining_rock", "fishing_spot"
          resourceType: resource.type === "ore" ? "mining_rock" : resource.type,
          resourceId: spawnPoint.subType
            ? `${resource.type}_${spawnPoint.subType}`
            : `${resource.type}_normal`,
          harvestSkill: resource.skillRequired,
          requiredLevel: resource.levelRequired,
          harvestTime: 3000,
          harvestYield: resource.drops.map((drop) => ({
            itemId: drop.itemId,
            quantity: drop.quantity,
            chance: drop.chance,
          })),
          respawnTime: resource.respawnTime,
          depleted: isPersistedDepleted,
          // Manifest-driven model config with scale variation applied
          depletedModelPath: this.getDepletedModelPathForResource(
            resource.type,
            spawnPoint.subType,
          ),
          modelScale: finalScale,
          depletedModelScale: finalDepletedScale,
          // LOD support - use LOD1 model for medium distance rendering
          lod1Model: this.getLod1ModelPathForResource(
            resource.type,
            spawnPoint.subType,
          ),
          lod1ModelScale: finalScale, // Same scale variation as main model
          lod2Model: this.getLod2ModelPathForResource(
            resource.type,
            spawnPoint.subType,
          ),
          lod2ModelScale: finalScale, // Same scale variation as main model
          // Procgen preset for runtime procedural tree generation
          procgenPreset: this.getProcgenPresetForResource(
            resource.type,
            spawnPoint.subType,
          ),
          // Model variants for visual variation (hash-picked per instance)
          modelVariants: this.getModelVariantsForResource(
            resource.type,
            spawnPoint.subType,
          ),
          // RULES ACCURACY: Tile-based positioning for face direction and interaction
          footprint,
          anchorTile,
          occupiedTiles,
        };

        // Suppress individual broadcasts; we batch them below
        const spawnedEntity = await entityManager.spawnEntity(resourceConfig, {
          suppressBroadcast: true,
        });
        if (!spawnedEntity)
          throw new Error(
            `[ResourceSystem] Resource spawn refused: ${resource.id}`,
          );
        if (!this.isTerrainResourceLeaseCurrent(lease)) {
          this.destroyOwnedTerrainEntity(spawnedEntity);
          return;
        }
        registration.entity = spawnedEntity;
        this.resources.set(rid, resource);
        this.resourceVariants.set(rid, variant);
        if (isManifest) this.manifestResourceIds.add(rid);
        if (persistedState) {
          // The absolute durable deadline remains authoritative even if entity
          // initialization waited. Never restart its full respawn duration.
          this.respawnAtTick.set(
            rid,
            (this.world.currentTick || 0) +
              Math.max(
                1,
                Math.ceil(
                  (persistedState.respawnAt - Date.now()) / TICK_DURATION_MS,
                ),
              ),
          );
        }
        if (
          resource.type === "fishing_spot" ||
          resource.skillRequired === "fishing"
        ) {
          this.initializeFishingSpotTimer(rid, resource.position);
        }
        spawned++;
        batchedEntityData.push(spawnedEntity.serialize());
      } catch (err) {
        console.error(
          `[ResourceSystem] Failed to spawn resource "${spawnPoint.subType ?? "normal"}" (type=${spawnPoint.type}):`,
          err,
        );
        throw err;
      }
    }

    // Send all entities for this tile as a single batch packet to avoid
    // per-entity bandwidth-budget drops during rapid tile generation.
    // useHighPriorityBatch controls whether HIGH or NORMAL priority is used.
    if (
      this.isTerrainResourceLeaseCurrent(lease) &&
      batchedEntityData.length > 0 &&
      this.world.isServer
    ) {
      const network = this.world.network as {
        sendHighPriority?: (name: string, data: unknown) => void;
        send?: (name: string, data: unknown) => void;
      } | null;
      if (network) {
        if (
          this.useHighPriorityBatch &&
          typeof network.sendHighPriority === "function"
        ) {
          network.sendHighPriority("entitiesBatchAdded", batchedEntityData);
        } else if (typeof network.send === "function") {
          network.send("entitiesBatchAdded", batchedEntityData);
        }
      }
    }

    if (spawned > 0) {
      console.log(
        `[ResourceSystem] Spawned ${spawned}/${spawnPoints.length} resource entities (batch packet: ${batchedEntityData.length})${isManifest ? " (manifest)" : ""}`,
      );
    }
  }

  /**
   * Get model path for resource type from manifest
   * Fails fast if manifest data not found
   */
  private getModelPathForResource(type: string, subType?: string): string {
    // Build resource ID to look up in manifest
    const variantKey = subType ? `${type}_${subType}` : `${type}_normal`;
    const manifestData = getExternalResource(variantKey);

    if (!manifestData) {
      throw new Error(
        `[ResourceSystem] Resource manifest not found for '${variantKey}'. ` +
          `Ensure resources.json is loaded and contains this resource type.`,
      );
    }

    const path = manifestData.modelPath;
    if (!path || path === "null") return "";
    return path;
  }

  /**
   * Get depleted model path for resource type from manifest
   * Fails fast if manifest data not found
   */
  private getDepletedModelPathForResource(
    type: string,
    subType?: string,
  ): string | null {
    const variantKey = subType ? `${type}_${subType}` : `${type}_normal`;
    const manifestData = getExternalResource(variantKey);

    if (!manifestData) {
      throw new Error(
        `[ResourceSystem] Resource manifest not found for '${variantKey}'. ` +
          `Ensure resources.json is loaded and contains this resource type.`,
      );
    }

    return manifestData.depletedModelPath;
  }

  /**
   * Get scale for resource type from manifest
   * Fails fast if manifest data not found
   */
  private getScaleForResource(type: string, subType?: string): number {
    const variantKey = subType ? `${type}_${subType}` : `${type}_normal`;
    const manifestData = getExternalResource(variantKey);

    if (!manifestData) {
      throw new Error(
        `[ResourceSystem] Resource manifest not found for '${variantKey}'. ` +
          `Ensure resources.json is loaded and contains this resource type.`,
      );
    }

    return manifestData.scale;
  }

  /**
   * Get LOD1 model path for resource type from manifest
   * Returns null if not specified (full model used until imposter)
   */
  private getLod1ModelPathForResource(
    type: string,
    subType?: string,
  ): string | null {
    const variantKey = subType ? `${type}_${subType}` : `${type}_normal`;
    const manifestData = getExternalResource(variantKey);

    if (!manifestData) {
      throw new Error(
        `[ResourceSystem] Resource manifest not found for '${variantKey}'. ` +
          `Ensure resources.json is loaded and contains this resource type.`,
      );
    }

    return manifestData.lod1ModelPath ?? null;
  }

  /**
   * Get LOD2 model path for resource type from manifest
   * Returns null if not specified (LOD1/full model used until imposter)
   */
  private getLod2ModelPathForResource(
    type: string,
    subType?: string,
  ): string | null {
    const variantKey = subType ? `${type}_${subType}` : `${type}_normal`;
    const manifestData = getExternalResource(variantKey);

    if (!manifestData) {
      throw new Error(
        `[ResourceSystem] Resource manifest not found for '${variantKey}'. ` +
          `Ensure resources.json is loaded and contains this resource type.`,
      );
    }

    return manifestData.lod2ModelPath ?? null;
  }

  /**
   * Get depleted scale for resource type from manifest
   * Fails fast if manifest data not found
   */
  private getDepletedScaleForResource(type: string, subType?: string): number {
    const variantKey = subType ? `${type}_${subType}` : `${type}_normal`;
    const manifestData = getExternalResource(variantKey);

    if (!manifestData) {
      throw new Error(
        `[ResourceSystem] Resource manifest not found for '${variantKey}'. ` +
          `Ensure resources.json is loaded and contains this resource type.`,
      );
    }

    return manifestData.depletedScale;
  }

  /**
   * Get procgen preset for resource type from manifest.
   * Returns undefined if not specified (will fall back to GLB model).
   */
  private getProcgenPresetForResource(
    type: string,
    subType?: string,
  ): string | undefined {
    const variantKey = subType ? `${type}_${subType}` : `${type}_normal`;
    const manifestData = getExternalResource(variantKey);

    if (!manifestData) {
      // Don't throw - procgen is optional
      return undefined;
    }

    return manifestData.procgenPreset;
  }

  /**
   * Get model variants for resource type from manifest.
   * Returns undefined if not specified (single model or procgen).
   */
  private getModelVariantsForResource(
    type: string,
    subType?: string,
  ): string[] | undefined {
    const variantKey = subType ? `${type}_${subType}` : `${type}_normal`;
    const manifestData = getExternalResource(variantKey);
    if (!manifestData?.modelVariants?.length) return undefined;
    return manifestData.modelVariants;
  }

  /**
   * Get drops for resource type from manifest
   * Fails fast if manifest data not found
   */
  private getDropsFromManifest(variantKey: string): ResourceDrop[] {
    const manifestData = getExternalResource(variantKey);

    if (!manifestData) {
      throw new Error(
        `[ResourceSystem] Resource manifest not found for '${variantKey}'. ` +
          `Ensure resources.json is loaded and contains this resource type.`,
      );
    }

    if (!manifestData.harvestYield || manifestData.harvestYield.length === 0) {
      throw new Error(
        `[ResourceSystem] Resource '${variantKey}' has no harvestYield defined in manifest.`,
      );
    }

    return manifestData.harvestYield.map((yield_) => ({
      itemId: yield_.itemId,
      itemName: yield_.itemName,
      quantity: yield_.quantity,
      chance: yield_.chance,
      xpAmount: yield_.xpAmount,
      stackable: yield_.stackable,
      // RULES ACCURACY: Include fishing priority rolling fields
      levelRequired: yield_.levelRequired,
      catchLow: yield_.catchLow,
      catchHigh: yield_.catchHigh,
    }));
  }

  /**
   * Create a Resource from a spawn point - ALL values come from resources.json manifest
   * No hardcoded values - manifest is the single source of truth
   */
  private createResourceFromSpawnPoint(
    spawnPoint: TerrainResourceSpawnPoint,
    groundAuthoredLand = false,
  ): Resource | undefined {
    const { position, type } = spawnPoint;
    const authoredId = validateAuthoredTreeInstanceId(
      spawnPoint.instanceId,
      type,
      groundAuthoredLand,
    );

    // Map spawn type to resource type for manifest lookup
    const resourceType: "tree" | "fishing_spot" | "ore" | "herb_patch" =
      type === "rock" || type === "ore" || type === "gem" || type === "rare_ore"
        ? "ore"
        : type === "fish"
          ? "fishing_spot"
          : type === "herb"
            ? "herb_patch"
            : "tree";

    // Build variant key for manifest lookup
    // e.g., "tree_normal", "tree_oak", "ore_copper", "fishing_spot_normal"
    // Uses subType if available, otherwise defaults to "_normal"
    const variantKey = spawnPoint.subType
      ? `${resourceType}_${spawnPoint.subType}`
      : `${resourceType}_normal`;

    // Get manifest data - fail fast if not found
    const manifestData = getExternalResource(variantKey);
    if (!manifestData) {
      throw new Error(
        `[ResourceSystem] Resource manifest not found for '${variantKey}'. ` +
          `Ensure resources.json is loaded and contains this resource type.`,
      );
    }

    // RULES ACCURACY: Snap position to tile center for proper face direction and interaction
    // This ensures resources are always at tile centers (e.g., 15.5, -9.5) not corners (15, -10)
    const snappedPosition = snapToTileCenter(position);
    if (groundAuthoredLand && resourceType !== "fishing_spot") {
      const terrain =
        this.terrainSystem ?? this.world.getSystem<TerrainSystem>("terrain");
      if (!terrain)
        throw new Error(
          "[ResourceSystem] Authored land requires terrain grounding",
        );
      snappedPosition.y = terrain.getResourceGroundHeight(
        snappedPosition.x,
        snappedPosition.z,
      );
      if (!Number.isFinite(snappedPosition.y))
        throw new Error("[ResourceSystem] Non-finite authored resource ground");
    }

    // Duel arena tiles should not contain harvestable resources or trees.
    if (isPositionInsideDuelArenaZone(snappedPosition.x, snappedPosition.z)) {
      return undefined;
    }

    // All values come from manifest - no hardcoding
    const resource: Resource = {
      id:
        authoredId ??
        `${type}_${snappedPosition.x.toFixed(0)}_${snappedPosition.z.toFixed(0)}`,
      type: resourceType,
      name: manifestData.name,
      position: {
        x: snappedPosition.x,
        y: snappedPosition.y,
        z: snappedPosition.z,
      },
      skillRequired: manifestData.harvestSkill,
      levelRequired: manifestData.levelRequired,
      toolRequired: manifestData.toolRequired || "",
      secondaryRequired: manifestData.secondaryRequired,
      respawnTime: this.ticksToMs(manifestData.respawnTicks),
      isAvailable: true,
      lastDepleted: 0,
      drops: this.getDropsFromManifest(variantKey),
    };

    return resource;
  }

  /**
   * Handle terrain tile unloading - remove resources from unloaded tiles.
   * Destroys the backing EntityManager entities so they don't leak and can be
   * re-broadcast when the tile is loaded again later.
   * Note: Manifest resources (from world-areas.json) are protected and never deleted.
   */
  private onTerrainTileUnloaded(data: {
    tileId: string;
    tileX: number;
    tileZ: number;
  }): void {
    const lease = this.terrainResourceLeases.get(
      `tile:${data.tileX},${data.tileZ}`,
    );
    if (lease) this.retireTerrainResourceLease(lease);
    const entityManager = this.world.getSystem("entity-manager") as {
      destroyEntity?: (id: string) => boolean;
    } | null;

    // Remove resources that belong to this tile (but not manifest resources)
    for (const [resourceId, resource] of this.resources) {
      // Skip manifest resources - they are permanent and shouldn't be deleted on tile unload
      if (this.manifestResourceIds.has(resourceId)) {
        continue;
      }

      // Terrain chunks are centered on tileIndex * size, so tile N spans
      // [(N - 0.5) * size, (N + 0.5) * size). Keep this identical to
      // TerrainSystem.worldToTerrainTileIndex, including negative coordinates.
      const terrainTileSize = TERRAIN_CONSTANTS.TERRAIN_TILE_SIZE;
      const resourceTileX = Math.floor(
        (resource.position.x + terrainTileSize * 0.5) / terrainTileSize,
      );
      const resourceTileZ = Math.floor(
        (resource.position.z + terrainTileSize * 0.5) / terrainTileSize,
      );

      if (resourceTileX === data.tileX && resourceTileZ === data.tileZ) {
        const gatheringPlayers: string[] = [];
        for (const [playerId, session] of this.activeGathering) {
          if (session.resourceId === resourceId) {
            gatheringPlayers.push(playerId);
          }
        }
        for (const playerId of gatheringPlayers) {
          this.cancelGatheringForPlayer(playerId, "terrain_tile_unloaded");
        }

        // Destroy the entity in EntityManager so it's removed from the
        // entities map and broadcast as entityRemoved to clients. Without
        // this, the entity lingers and the duplicate-ID check in
        // spawnEntity prevents it from being re-created on tile revisit.
        if (entityManager?.destroyEntity) {
          entityManager.destroyEntity(resource.id);
        }

        this.resources.delete(resourceId);
        this.resourceVariants.delete(resourceId);
        this.resourceTimers.delete(resourceId);
        this.respawnAtTick.delete(resourceId);
        this.fishingSpotMoveTimers.delete(resourceId);
      }
    }
  }

  /**
   * Start a gathering session for a player on a resource
   *
   * Validates:
   * - Rate limit not exceeded (600ms between requests)
   * - Resource ID format is valid (security)
   * - Resource exists and is available
   * - Player has required skill level (from manifest levelRequired)
   * - Player has required tool category (from manifest toolRequired)
   * - Tool level requirement met (from TOOL_TIERS)
   *
   * Creates tick-based gathering session processed by processGatheringTick().
   * Session data is cached at start to avoid per-tick allocations.
   *
   * @param data.playerId - Player attempting to gather
   * @param data.resourceId - Target resource entity ID
   * @param data.playerPosition - Player position (used for proximity fallback)
   *
   * @emits RESOURCE_GATHERING_STARTED on successful session start
   * @emits UI_MESSAGE on validation failure with error details
   *
   * @example
   * ```typescript
   * world.emit(EventType.RESOURCE_GATHER, {
   *   playerId: 'player_123',
   *   resourceId: 'tree_50_100',
   *   playerPosition: { x: 50, y: 0, z: 100 },
   * });
   * ```
   */
  /**
   * Direct server-authoritative admission boundary used by movement-to-gather.
   * The optional attempt is bound to exactly the first durable reward.
   */
  public requestGathering(data: GatheringRequest): boolean {
    return this.startGathering(data);
  }

  private startGathering(data: GatheringRequest): boolean {
    const completionOperationId =
      data.completionAttemptId === undefined
        ? null
        : getGatheringRewardOperationIdForAttempt(data.completionAttemptId);
    if (
      data.completionAttemptId !== undefined &&
      completionOperationId === null
    ) {
      return false;
    }
    const reject = (
      skill = "unknown",
      failureReason = "request_rejected",
    ): false => {
      if (completionOperationId) {
        this.emitTypedEvent(EventType.RESOURCE_GATHERING_COMPLETED, {
          playerId: data.playerId,
          resourceId: data.resourceId,
          successful: false,
          skill,
          operationId: completionOperationId,
          failureReason,
        });
      }
      return false;
    };

    // Only server should handle actual gathering logic
    if (!this.world.isServer) {
      return false;
    }

    if (!canPlayerPerformPreparationAction(this.world, data.playerId)) {
      return reject("unknown", "action_not_allowed");
    }

    const playerId = createPlayerID(data.playerId);

    // ===== SECURITY: Rate limiting - prevent gather request spam =====
    // Silently drops requests faster than 1 tick (600ms), just like classic MMORPG
    // This allows normal spam clicking without punishment
    const now = Date.now();
    const lastAttempt = this.gatherRateLimits.get(playerId);
    if (lastAttempt && now - lastAttempt < GATHERING_CONSTANTS.RATE_LIMIT_MS) {
      // Silently drop rapid requests (classic MMORPG behavior - no punishment for spam clicking)
      return reject("unknown", "rate_limited");
    }
    this.gatherRateLimits.set(playerId, now);

    // An ambiguous commit must finish under its original idempotency key before
    // this player can begin another harvest. Starting a second action here
    // could turn a lost database response into a duplicate reward. Movement may
    // already have canceled the original session and applied an arrival emote;
    // clear that presentation and explain the bounded fail-closed rejection.
    if (this.pendingGatherRewards.has(playerId)) {
      if (!this.activeGathering.has(playerId)) {
        this.resetGatheringEmote(data.playerId);
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: data.playerId,
          message:
            "Your previous gathering result is still being reconciled. Please try again in a moment.",
          type: "info",
        });
      }
      return reject("unknown", "reward_reconciliation_pending");
    }

    // ===== SECURITY: Validate resource ID format =====
    if (!this.isValidResourceId(data.resourceId)) {
      console.warn(
        "[ResourceSystem] Invalid resource ID format:",
        data.resourceId,
      );
      return reject("unknown", "invalid_resource_id");
    }

    const resourceId = createResourceID(data.resourceId);

    let resource = this.resources.get(resourceId);

    if (!resource) {
      for (const r of this.resources.values()) {
        const derived = `${r.type}_${Math.round(r.position.x)}_${Math.round(r.position.z)}`;
        if (derived === (data.resourceId || "")) {
          resource = r;
          break;
        }
      }
    }

    if (!resource) {
      let nearest: Resource | null = null;
      let nearestDist = Infinity;
      for (const r of this.resources.values()) {
        if (!r.isAvailable) continue;
        const d = calculateDistance(data.playerPosition, r.position);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = r;
        }
      }
      if (
        nearest &&
        nearestDist < GATHERING_CONSTANTS.PROXIMITY_SEARCH_RADIUS
      ) {
        console.warn(
          "[ResourceSystem] Matched nearest resource",
          nearest.id,
          "at",
          nearestDist.toFixed(2),
          "m",
        );
        resource = nearest;
      } else {
        console.warn(
          "[ResourceSystem] Resource not found for id",
          data.resourceId,
          "available ids:",
          Array.from(this.resources.keys()).slice(0, 10),
        );
        this.sendChat(data.playerId, `Resource not found. Please try again.`);
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: data.playerId,
          message: `Resource not found: ${data.resourceId}`,
          type: "error",
        });
        return reject("unknown", "resource_missing");
      }
    }

    // ===== FIX #488: Prevent duplicate sessions on spam click =====
    // Check AFTER resource resolution so we compare the exact resolved resource ID
    const existingSession = this.activeGathering.get(playerId);
    if (existingSession) {
      // If already gathering this EXACT resource, silently ignore (prevents duplicate rewards)
      if (existingSession.resourceId === resource.id) {
        if (!completionOperationId) return true;
        if (
          existingSession.pendingRewardOperationId === null &&
          (existingSession.completionOperationId === null ||
            existingSession.completionOperationId === completionOperationId)
        ) {
          existingSession.completionOperationId = completionOperationId;
          return true;
        }
        return false;
      }
      // If switching to a DIFFERENT resource, cancel the old session first
      this.cancelGatheringForPlayer(playerId, "switch_resource");
    }

    // Check if resource is available
    if (!resource.isAvailable) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: data.playerId,
        message: `This ${resource.type.replace("_", " ")} is depleted. Please wait for it to respawn.`,
        type: "info",
      });
      return reject(resource.skillRequired, "resource_unavailable");
    }

    // ===== CARDINAL ADJACENCY CHECK =====
    // Validate player is on a cardinal tile (N/E/S/W) adjacent to the resource
    // This prevents gathering while standing ON the resource or from diagonal tiles
    const footprint = resource.footprint || "standard";
    const size = FOOTPRINT_SIZES[footprint];
    const resourceAnchorTile = worldToTile(
      resource.position.x,
      resource.position.z,
    );
    const playerTile = worldToTile(
      data.playerPosition.x,
      data.playerPosition.z,
    );

    // FISHING: Use simple world-distance check (shore/water boundary doesn't align with tiles)
    // OTHER SKILLS: Use strict tile-based cardinal adjacency
    const isFishing = resource.skillRequired === "fishing";

    if (isFishing) {
      // Fishing uses 2D (X/Z) world-distance check - player can be up to 4m away from the fishing spot
      // This is more forgiving since the player stands on shore and casts into water
      // IMPORTANT: Use 2D distance because fishing spots are in water (different Y than player on shore)
      // This matches PendingGatherManager which also uses 2D distance for fishing arrival checks
      const worldDistance = calculateDistance2D(
        data.playerPosition,
        resource.position,
      );

      if (worldDistance > GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE) {
        console.warn(
          `[ResourceSystem] Player ${data.playerId} at (${data.playerPosition.x.toFixed(1)}, ${data.playerPosition.z.toFixed(1)}) ` +
            `is ${worldDistance.toFixed(1)}m from fishing spot at (${resource.position.x.toFixed(1)}, ${resource.position.z.toFixed(1)}). ` +
            `Max range: ${GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE}m. Rejecting gather.`,
        );
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: data.playerId,
          message: `Move closer to the fishing spot.`,
          type: "info",
        });
        return reject(resource.skillRequired, "out_of_range");
      }

      if (DEBUG_GATHERING) {
        console.log(
          `[ResourceSystem] ✅ Player ${data.playerId} is ${worldDistance.toFixed(1)}m from fishing spot (max ${GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE}m). Proceeding with fishing.`,
        );
      }
    } else {
      // Non-fishing resources use strict tile-based cardinal adjacency
      // Check if player is standing ON the resource
      const isOnResource =
        playerTile.x >= resourceAnchorTile.x &&
        playerTile.x < resourceAnchorTile.x + size.x &&
        playerTile.z >= resourceAnchorTile.z &&
        playerTile.z < resourceAnchorTile.z + size.z;

      if (isOnResource) {
        console.warn(
          `[ResourceSystem] Player ${data.playerId} at tile (${playerTile.x}, ${playerTile.z}) is ON resource ` +
            `at anchor (${resourceAnchorTile.x}, ${resourceAnchorTile.z}) with footprint ${size.x}x${size.z}. Rejecting gather.`,
        );
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: data.playerId,
          message: `You can't gather while standing on the resource. Move to an adjacent tile.`,
          type: "error",
        });
        return reject(resource.skillRequired, "standing_on_resource");
      }

      // Check if player is on a cardinal adjacent tile (not diagonal)
      const isOnCardinal = isCardinallyAdjacentToResource(
        playerTile,
        resourceAnchorTile,
        size.x,
        size.z,
      );

      if (!isOnCardinal) {
        console.warn(
          `[ResourceSystem] Player ${data.playerId} at tile (${playerTile.x}, ${playerTile.z}) is NOT on cardinal tile ` +
            `adjacent to resource at (${resourceAnchorTile.x}, ${resourceAnchorTile.z}). Rejecting gather.`,
        );
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: data.playerId,
          message: `Move closer to the ${resource.name.toLowerCase()}.`,
          type: "info",
        });
        return reject(resource.skillRequired, "invalid_approach");
      }

      if (DEBUG_GATHERING) {
        console.log(
          `[ResourceSystem] ✅ Player ${data.playerId} at tile (${playerTile.x}, ${playerTile.z}) is on CARDINAL tile ` +
            `adjacent to resource at anchor (${resourceAnchorTile.x}, ${resourceAnchorTile.z}). Proceeding with gather.`,
        );
      }
    }

    // Check player skill level (reactive pattern)
    const cachedSkills = this.playerSkills.get(data.playerId);
    const skillLevel = cachedSkills?.[resource.skillRequired]?.level ?? 1;

    if (
      resource.levelRequired !== undefined &&
      skillLevel < resource.levelRequired
    ) {
      this.resetGatheringEmote(data.playerId);
      this.sendChat(
        data.playerId,
        `You need level ${resource.levelRequired} ${resource.skillRequired} to use this resource.`,
      );
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: data.playerId,
        message: `You need level ${resource.levelRequired} ${resource.skillRequired} to use this resource.`,
        type: "error",
      });
      return reject(resource.skillRequired, "level_required");
    }

    // Tool check using manifest's toolRequired field (classic fantasy MMORPG-style: any tier qualifies; tier affects speed)
    if (resource.toolRequired) {
      const toolCategory = this.getToolCategory(resource.toolRequired);
      const hasTool = this.playerHasToolCategory(data.playerId, toolCategory);

      if (!hasTool) {
        this.resetGatheringEmote(data.playerId);
        const toolName = this.getToolDisplayName(toolCategory);
        this.sendChat(
          data.playerId,
          `You need a ${toolName} to harvest the ${resource.name.toLowerCase()}.`,
        );
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: data.playerId,
          message: `You need a ${toolName} to harvest the ${resource.name.toLowerCase()}.`,
          type: "error",
        });
        return reject(resource.skillRequired, "tool_required");
      }

      // Enforce tool level requirement using manifest-driven tool system
      const bestTool = this.getToolForResource(
        data.playerId,
        resource.skillRequired,
        resource.toolRequired,
      );
      if (bestTool) {
        const cached = this.playerSkills.get(data.playerId);
        const currentSkillLevel = cached?.[resource.skillRequired]?.level ?? 1;
        if (currentSkillLevel < bestTool.levelRequired) {
          this.resetGatheringEmote(data.playerId);
          const toolName = this.getToolDisplayName(toolCategory);
          this.emitTypedEvent(EventType.UI_MESSAGE, {
            playerId: data.playerId,
            message: `You need level ${bestTool.levelRequired} ${resource.skillRequired} to use this ${toolName}.`,
            type: "error",
          });
          return reject(resource.skillRequired, "tool_level_required");
        }
      }
    }

    // RULES ACCURACY: Check for secondary consumable (bait, feathers, etc.)
    if (resource.secondaryRequired) {
      const hasSecondary = this.playerHasItem(
        data.playerId,
        resource.secondaryRequired,
      );
      if (!hasSecondary) {
        this.resetGatheringEmote(data.playerId);
        const secondaryName = resource.secondaryRequired.replace(/_/g, " ");
        this.sendChat(data.playerId, `You need ${secondaryName} to fish here.`);
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: data.playerId,
          message: `You need ${secondaryName} to fish here.`,
          type: "error",
        });
        return reject(resource.skillRequired, "secondary_required");
      }
    }

    // Start a timed gathering session with rules-accurate messages
    const resourceName = resource.name || resource.type.replace("_", " ");

    // RULES ACCURACY: Skill-specific gathering start messages
    const gatheringStartMessage = (() => {
      switch (resource.skillRequired) {
        case "woodcutting":
          return `You swing your axe at the ${resourceName.toLowerCase()}.`;
        case "mining":
          return `You swing your pickaxe at the ${resourceName.toLowerCase()}.`;
        case "fishing":
          return "You attempt to catch some fish.";
        default:
          return `You start gathering from the ${resourceName.toLowerCase()}.`;
      }
    })();

    // Create tick-based session
    const sessionResourceId = createResourceID(resource.id);

    // Get current tick from world (rules-accurate tick-based timing)
    const currentTick = this.world.currentTick || 0;

    // Compute tick-based cycle interval
    const variant = this.resourceVariants.get(sessionResourceId);
    if (!variant) {
      console.error(
        `[ResourceSystem] No variant tracked for resource '${resource.id}' (type: ${resource.type}). ` +
          `Was the resource registered via spawnResources()?`,
      );
      return reject(resource.skillRequired, "variant_missing");
    }
    const tuned = this.getVariantTuning(variant);

    // Resolve the resource-authoritative tool used for mechanical metadata.
    const toolInfo = this.getToolForResource(
      data.playerId,
      resource.skillRequired,
      resource.toolRequired,
    );
    const presentationToolItemId = resolveGatheringPresentationItemId(
      resource.skillRequired,
      resource.toolRequired,
      toolInfo?.itemId,
    );
    const fishingInteraction = isSpecialFishingInteractionItemId(
      presentationToolItemId,
    )
      ? (() => {
          const initial = initialFishingInteractionTransition(
            presentationToolItemId,
            currentTick,
          );
          return {
            interactionId: `fishing:${uuid()}${uuid()}`,
            itemId: presentationToolItemId,
            phase: initial.phase,
            outcome: "none" as const,
            targetPosition: {
              x: resource.position.x,
              y: resource.position.y,
              z: resource.position.z,
            },
            nextTransitionTick: initial.nextTransitionTick,
            firstAttemptTick: firstFishingInteractionAttemptTick(
              presentationToolItemId,
              currentTick,
            ),
            awaitingOperationId: null,
            phaseStartedAtServerTimeMs: performance.now(),
          } satisfies ActiveFishingInteractionPresentation;
        })()
      : null;

    // RULES-ACCURATE: Compute cycle ticks based on skill-specific mechanics
    // - Woodcutting: Fixed 4 ticks (axe affects success rate, not speed)
    // - Mining: Variable ticks based on pickaxe tier
    // - Fishing: Fixed 5 ticks
    const cycleTickInterval = this.computeCycleTicks(
      resource.skillRequired,
      tuned,
      toolInfo,
    );

    // PERFORMANCE: Pre-compute success rate to avoid per-tick calculation
    // RULES-ACCURATE: Uses LERP formula with skill-specific tables
    // - Woodcutting: Tree type + axe tier determines success
    // - Mining/Fishing: Resource type only (tool doesn't affect success)
    const successRate = this.computeSuccessRate(
      skillLevel,
      resource.skillRequired,
      variant,
      toolInfo?.tier ?? null,
    );

    // RULES ACCURACY: Get server-authoritative player position for movement detection
    const player = this.world.getPlayer?.(data.playerId);
    const startPosition = player?.position
      ? { x: player.position.x, y: player.position.y, z: player.position.z }
      : {
          x: data.playerPosition.x,
          y: data.playerPosition.y,
          z: data.playerPosition.z,
        };

    // RULES ACCURACY: Rotate player to face the resource (instant rotation like classic MMORPG)
    // This happens before session starts so animation plays in correct direction
    const footprintForRotation = resource.footprint || "standard";
    if (DEBUG_GATHERING) {
      console.log(
        `[ResourceSystem] startGathering: Calling rotatePlayerToFaceResource for ${data.playerId}, ` +
          `resource at (${resource.position.x.toFixed(1)}, ${resource.position.z.toFixed(1)}), ` +
          `footprint=${footprintForRotation}, player at (${startPosition.x.toFixed(1)}, ${startPosition.z.toFixed(1)})`,
      );
    }
    this.rotatePlayerToFaceResource(
      data.playerId,
      resource.position,
      footprintForRotation,
    );

    // Get low/high values for debug logging
    const toolTier = toolInfo?.tier ?? null;
    const lowHigh = this.getSuccessRateValues(
      resource.skillRequired,
      variant,
      toolTier,
    );

    // Schedule first attempt on next tick with CACHED data
    this.activeGathering.set(playerId, {
      playerId,
      resourceId: sessionResourceId,
      startTick: currentTick,
      nextAttemptTick: currentTick + 1, // First attempt next tick
      cycleTickInterval,
      attempts: 0,
      successes: 0,
      pendingRewardOperationId: null,
      completionOperationId,
      // Store skill and tool for visual display
      skill: resource.skillRequired,
      toolItemId: presentationToolItemId,
      fishingInteraction,
      // PERFORMANCE: Cache everything needed during tick processing
      cachedTuning: tuned,
      cachedSuccessRate: successRate,
      cachedDrops: resource.drops,
      cachedResourceName: resourceName,
      // RULES ACCURACY: Store position to detect movement (any movement cancels gathering)
      cachedStartPosition: startPosition,
      // DEBUG: Store for logging (only used when DEBUG_GATHERING=true)
      debugInfo: DEBUG_GATHERING
        ? {
            skill: resource.skillRequired,
            variant,
            toolTier,
            lowHigh,
          }
        : undefined,
    });

    // DEBUG: Log session start with classic tick-based mechanics details
    if (DEBUG_GATHERING) {
      const mechanics =
        GATHERING_CONSTANTS.SKILL_MECHANICS[
          resource.skillRequired as keyof typeof GATHERING_CONSTANTS.SKILL_MECHANICS
        ];
      console.log(
        `[Gathering DEBUG] ═══════════════════════════════════════════════════════`,
      );
      console.log(`[Gathering DEBUG] Session started for ${playerId}`);
      console.log(
        `[Gathering DEBUG] Resource: ${variant} (${resource.skillRequired})`,
      );
      console.log(
        `[Gathering DEBUG] Tool: ${toolInfo?.itemId ?? "none"} (tier: ${toolTier ?? "none"})`,
      );
      console.log(
        `[Gathering DEBUG] Mechanics: ${mechanics?.type ?? "unknown"}`,
      );
      console.log(
        `[Gathering DEBUG] Cycle: ${cycleTickInterval} ticks (${(cycleTickInterval * 0.6).toFixed(1)}s)`,
      );
      console.log(
        `[Gathering DEBUG] Success Rate: ${(successRate * 100).toFixed(1)}% (low=${lowHigh.low}, high=${lowHigh.high}, level=${skillLevel})`,
      );
      console.log(
        `[Gathering DEBUG] ═══════════════════════════════════════════════════════`,
      );
    }

    // FORESTRY: Track as active gatherer for timer-based resources
    this.addActiveGatherer(playerId, sessionResourceId, currentTick);

    // Preserve exact fishing-tool presentation authority in network state.
    // Clients animate only certified tool keys and otherwise fall back to idle,
    // so a net, pot, or harpoon cannot be misrepresented as a rod cast.
    const emote = fishingInteraction
      ? resolveFishingInteractionBodyEmote(
          fishingInteraction.itemId,
          fishingInteraction.phase,
        )
      : resolveGatheringPresentationEmote(
          resource.skillRequired,
          resource.toolRequired,
          presentationToolItemId,
        );
    this.setGatheringEmote(data.playerId, emote);

    // Emit gathering started event with tick timing info for client progress bar
    this.emitTypedEvent(EventType.RESOURCE_GATHERING_STARTED, {
      playerId: data.playerId,
      resourceId: resource.id,
      skill: resource.skillRequired,
      cycleTicks: cycleTickInterval,
      tickDurationMs: TICK_DURATION_MS,
    });

    // Show the selected gathering tool in hand, temporarily overriding the
    // combat loadout for every gathering skill.
    if (presentationToolItemId) {
      this.showGatheringTool(data.playerId, presentationToolItemId);
    }
    if (fishingInteraction) {
      const session = this.activeGathering.get(playerId);
      if (session)
        this.publishFishingInteractionPresentation(playerId, session);
    }

    // Send the authoritative gathering start message through chat and UI.
    this.sendChat(data.playerId, gatheringStartMessage);
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId: data.playerId,
      message: gatheringStartMessage,
      type: "info",
    });

    // Broadcast toast to client via network
    this.sendNetworkMessage("showToast", {
      playerId: data.playerId,
      message: gatheringStartMessage,
      type: "info",
    });
    return true;
  }

  private publishBoundGatheringFailure(
    session: {
      playerId: PlayerID;
      resourceId: ResourceID;
      skill: string;
      completionOperationId: string | null;
    },
    failureReason: string,
  ): void {
    const operationId = session.completionOperationId;
    if (!operationId) return;
    session.completionOperationId = null;
    this.emitTypedEvent(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: session.playerId,
      resourceId: session.resourceId,
      successful: false,
      skill: session.skill,
      operationId,
      failureReason,
    });
  }

  private stopGathering(
    data: { playerId: string | PlayerID },
    failureReason = "stopped",
  ): void {
    const playerId = createPlayerID(data.playerId);
    const session = this.activeGathering.get(playerId);
    if (session) {
      this.publishBoundGatheringFailure(session, failureReason);
      // FORESTRY: Remove from active gatherers (timer will regenerate if no other gatherers)
      this.removeActiveGatherer(playerId, session.resourceId);

      this.activeGathering.delete(playerId);

      // Reset emote back to idle when gathering stops
      this.resetGatheringEmote(data.playerId);

      // Hide the gathering tool visual and restore the combat loadout.
      if (session.toolItemId) {
        this.hideGatheringTool(data.playerId);
      }

      this.emitTypedEvent(EventType.RESOURCE_GATHERING_STOPPED, {
        playerId: data.playerId,
        resourceId: session.resourceId,
      });
    }
  }

  private cleanupPlayerGathering(playerId: string): void {
    const pid = createPlayerID(playerId);
    const session = this.activeGathering.get(pid);

    if (session) {
      this.publishBoundGatheringFailure(session, "disconnected");
      // SECURITY: Track rapid disconnect during active gather (potential bot/exploit)
      const now = Date.now();
      const patterns = this.suspiciousPatterns.get(pid) || {
        rapidDisconnects: 0,
        lastDisconnect: 0,
        rapidGatherAttempts: 0,
        lastAttempt: 0,
      };

      // Check for rapid disconnect pattern (multiple disconnects within 5s while gathering)
      if (now - patterns.lastDisconnect < 5000) {
        patterns.rapidDisconnects++;
        if (patterns.rapidDisconnects > 3) {
          this.logSuspiciousPattern(
            pid,
            `rapid-disconnect-during-gather (${patterns.rapidDisconnects}x in 5s)`,
          );
        }
      } else {
        // Reset counter if >5s since last disconnect
        patterns.rapidDisconnects = 1;
      }
      patterns.lastDisconnect = now;
      this.suspiciousPatterns.set(pid, patterns);

      // classic MMORPG-STYLE: Hide gathering tool visual and restore equipped weapon
      if (session.toolItemId) {
        this.hideGatheringTool(playerId);
      }

      // FORESTRY: Remove from active gatherers before deleting session
      this.removeActiveGatherer(pid, session.resourceId);
    }
    this.activeGathering.delete(pid);
    this.gatheringToolPresentationRevisions.delete(pid);
    this.fishingInteractionPresentationRevisions.delete(pid);
    // SECURITY: Clean up rate limit tracking on disconnect
    this.gatherRateLimits.delete(pid);
    this.playerSkills.delete(playerId);
  }

  /**
   * Log suspicious activity pattern for security monitoring.
   * Could be extended to emit to analytics system or trigger alerts.
   *
   * @param playerId - Player exhibiting suspicious behavior
   * @param pattern - Description of the suspicious pattern
   */
  private logSuspiciousPattern(playerId: PlayerID, pattern: string): void {
    console.warn(
      `[Security] Suspicious pattern detected: ${pattern} for player ${playerId}`,
    );
    // Could emit to analytics system for monitoring
    // this.emitTypedEvent(EventType.SECURITY_ALERT, { playerId, pattern });
  }

  /**
   * Cancel gathering for a player due to an action/event (classic MMORPG weak queue behavior)
   * Used by event subscriptions to cancel gathering when player performs another action.
   *
   * @param playerId - The player whose gathering should be cancelled
   * @param reason - Debug reason for logging (e.g., "died", "teleported", "combat")
   */
  private cancelGatheringForPlayer(playerId: string, reason: string): void {
    const pid = createPlayerID(playerId);
    const session = this.activeGathering.get(pid);
    if (session) {
      this.publishBoundGatheringFailure(session, reason);
      if (DEBUG_GATHERING) {
        console.log(
          `[ResourceSystem] Cancelling gather for ${playerId} - reason: ${reason}`,
        );
      }
      // FORESTRY: Remove from active gatherers (timer will regenerate if no other gatherers)
      this.removeActiveGatherer(pid, session.resourceId);

      // classic MMORPG-STYLE: Hide gathering tool visual and restore equipped weapon
      if (session.toolItemId) {
        this.hideGatheringTool(playerId);
      }

      this.emitTypedEvent(EventType.RESOURCE_GATHERING_STOPPED, {
        playerId: playerId,
        resourceId: session.resourceId,
      });
      this.resetGatheringEmote(playerId);
      this.activeGathering.delete(pid);
    }
  }

  /**
   * Set face target for player to face a resource (rules-accurate deferred rotation)
   *
   * RULES ACCURACY: Face direction is NOT applied immediately. Instead:
   * 1. A faceTarget is set on the player
   * 2. At END of the server tick, if player did NOT move, rotation is applied
   * 3. If player moved, rotation is skipped but faceTarget persists
   * 4. Player will face the resource when they eventually stop moving
   *
   * For multi-tile resources (2×2, 3×3), the player faces the center of the
   * occupied tile area, not just a single tile.
   *
   *
   * @param playerId - The player to set face target for
   * @param resourcePosition - The position of the resource (tile-centered)
   * @param footprint - The resource's tile footprint (defaults to "standard")
   */
  private rotatePlayerToFaceResource(
    playerId: string,
    resourcePosition: { x: number; y: number; z: number },
    footprint: ResourceFootprint = "standard",
  ): void {
    // RULES ACCURACY: Use FaceDirectionManager for deferred tick-end processing
    // The manager will apply rotation at end of tick only if player didn't move
    //
    // CARDINAL-ONLY: Uses deterministic cardinal face direction for AAA quality.
    // Player standing N of resource faces S, E faces W, S faces N, W faces E.
    const faceManager = (
      this.world as {
        faceDirectionManager?: {
          setFaceTarget: (playerId: string, x: number, z: number) => void;
          setCardinalFaceTarget: (
            playerId: string,
            anchorTile: { x: number; z: number },
            footprintX: number,
            footprintZ: number,
          ) => void;
        };
      }
    ).faceDirectionManager;

    if (faceManager) {
      const size = FOOTPRINT_SIZES[footprint];
      const anchorTile = worldToTile(resourcePosition.x, resourcePosition.z);

      if (DEBUG_GATHERING) {
        console.log(
          `[ResourceSystem] rotatePlayerToFaceResource: ` +
            `resourcePos=(${resourcePosition.x.toFixed(1)}, ${resourcePosition.z.toFixed(1)}), ` +
            `anchorTile=(${anchorTile.x}, ${anchorTile.z}), size=${size.x}x${size.z}`,
        );
      }

      // Use cardinal-only face direction for deterministic behavior
      if (faceManager.setCardinalFaceTarget) {
        if (DEBUG_GATHERING) {
          console.log(`[ResourceSystem] Using setCardinalFaceTarget`);
        }
        faceManager.setCardinalFaceTarget(playerId, anchorTile, size.x, size.z);
      } else {
        // Fallback to legacy center-based targeting
        if (DEBUG_GATHERING) {
          console.log(
            `[ResourceSystem] FALLBACK: Using setFaceTarget (no setCardinalFaceTarget)`,
          );
        }
        const targetX = anchorTile.x + size.x / 2;
        const targetZ = anchorTile.z + size.z / 2;
        faceManager.setFaceTarget(playerId, targetX, targetZ);
      }
    } else {
      console.warn(
        `[ResourceSystem] rotatePlayerToFaceResource: No faceManager found!`,
      );
    }
  }

  /**
   * Process resource timers for Forestry-style depletion/regeneration.
   * Called every tick to:
   * - Decrement timers for resources being gathered
   * - Regenerate timers for resources not being gathered
   *
   * @param tickNumber - Current server tick
   */
  private processResourceTimers(tickNumber: number): void {
    for (const [resourceId, timer] of this.resourceTimers) {
      // A durable reward request snapshots the timer's depletion decision.
      // Do not let the timer cross zero while that exact request is in flight.
      if (this.gatheringRewardReservations.has(resourceId)) {
        timer.lastUpdateTick = tickNumber;
        continue;
      }
      const ticksDelta = tickNumber - timer.lastUpdateTick;
      timer.lastUpdateTick = tickNumber;

      if (timer.activeGatherers.size > 0 && timer.hasReceivedFirstLog) {
        // Being gathered AND first log received - decrement timer
        // RULES ACCURACY: Timer only counts down AFTER first log is received
        const oldTicks = timer.currentTicks;
        timer.currentTicks = Math.max(
          0,
          timer.currentTicks -
            ticksDelta * GATHERING_CONSTANTS.TIMER_REGEN_PER_TICK,
        );
        if (oldTicks !== timer.currentTicks) {
          if (DEBUG_GATHERING) {
            console.log(
              `[Forestry] ⏬ ${resourceId}: timer ${oldTicks} → ${timer.currentTicks} ` +
                `(${timer.activeGatherers.size} gatherer${timer.activeGatherers.size > 1 ? "s" : ""})`,
            );
          }
        }
      } else if (
        timer.activeGatherers.size === 0 &&
        timer.hasReceivedFirstLog
      ) {
        // Not being gathered but was started - regenerate
        const oldTicks = timer.currentTicks;
        timer.currentTicks = Math.min(
          timer.maxTicks,
          timer.currentTicks +
            ticksDelta * GATHERING_CONSTANTS.TIMER_REGEN_PER_TICK,
        );

        if (oldTicks !== timer.currentTicks) {
          if (DEBUG_GATHERING) {
            console.log(
              `[Forestry] ⏫ ${resourceId}: timer REGEN ${oldTicks} → ${timer.currentTicks}/${timer.maxTicks} (no gatherers)`,
            );
          }
        }

        // If fully regenerated, reset the "first log" state
        if (timer.currentTicks >= timer.maxTicks) {
          if (DEBUG_GATHERING) {
            console.log(
              `[Forestry] ✅ ${resourceId}: timer FULLY REGENERATED - resetting firstLog flag`,
            );
          }
          timer.hasReceivedFirstLog = false;
        }
      }
    }
  }

  /**
   * Add a player to a resource's active gatherers set.
   * Creates the timer structure if it doesn't exist (for Forestry resources).
   *
   * @param playerId - Player starting to gather
   * @param resourceId - Resource being gathered
   * @param tickNumber - Current tick for timer initialization
   */
  private addActiveGatherer(
    playerId: PlayerID,
    resourceId: ResourceID,
    tickNumber: number,
  ): void {
    // Only track for timer-based resources
    const despawnTicks = this.getResourceDespawnTicks(resourceId);
    if (despawnTicks <= 0) {
      if (DEBUG_GATHERING) {
        console.log(
          `[Forestry] ℹ️ ${resourceId}: NOT timer-based (despawnTicks=0), using chance depletion`,
        );
      }
      return;
    }

    let timer = this.resourceTimers.get(resourceId);
    if (!timer) {
      // Create timer structure (but don't start countdown yet - that's on first log)
      timer = {
        currentTicks: despawnTicks,
        maxTicks: despawnTicks,
        hasReceivedFirstLog: false,
        activeGatherers: new Set(),
        lastUpdateTick: tickNumber,
      };
      this.resourceTimers.set(resourceId, timer);
      if (DEBUG_GATHERING) {
        console.log(
          `[Forestry] 🌲 ${resourceId}: Created timer structure (${despawnTicks} ticks max)`,
        );
      }
    }

    timer.activeGatherers.add(playerId);
    if (DEBUG_GATHERING) {
      console.log(
        `[Forestry] 👤+ ${resourceId}: Added gatherer ${playerId} ` +
          `(now ${timer.activeGatherers.size} total, timer=${timer.currentTicks}/${timer.maxTicks}, started=${timer.hasReceivedFirstLog})`,
      );
    }
  }

  /**
   * Remove a player from a resource's active gatherers set.
   *
   * @param playerId - Player stopping gathering
   * @param resourceId - Resource that was being gathered
   */
  private removeActiveGatherer(
    playerId: PlayerID,
    resourceId: ResourceID,
  ): void {
    const timer = this.resourceTimers.get(resourceId);
    if (timer) {
      const hadPlayer = timer.activeGatherers.has(playerId);
      timer.activeGatherers.delete(playerId);
      if (hadPlayer) {
        if (DEBUG_GATHERING) {
          console.log(
            `[Forestry] 👤- ${resourceId}: Removed gatherer ${playerId} ` +
              `(now ${timer.activeGatherers.size} total, timer=${timer.currentTicks}/${timer.maxTicks})` +
              (timer.activeGatherers.size === 0 && timer.hasReceivedFirstLog
                ? " - will start REGENERATING"
                : ""),
          );
        }
      }
    }
  }

  /**
   * Handle receiving a log from a Forestry-timer resource.
   * Initializes the timer on first log and checks for depletion.
   *
   * @param playerId - Player who received the log
   * @param resourceId - Resource being gathered
   * @param tickNumber - Current tick
   * @returns true if resource should deplete, false otherwise
   */
  private handleForestryLog(
    playerId: PlayerID,
    resourceId: ResourceID,
    tickNumber: number,
  ): boolean {
    const timer = this.resourceTimers.get(resourceId);
    if (!timer) {
      if (DEBUG_GATHERING) {
        console.log(
          `[Forestry] ⚠️ ${resourceId}: handleForestryLog called but no timer exists!`,
        );
      }
      return false;
    }

    // First log starts the timer countdown
    if (!timer.hasReceivedFirstLog) {
      timer.hasReceivedFirstLog = true;
      timer.lastUpdateTick = tickNumber;
      if (DEBUG_GATHERING) {
        console.log(
          `[Forestry] 🪵 ${resourceId}: FIRST LOG received by ${playerId}! ` +
            `Timer NOW ACTIVE: ${timer.currentTicks}/${timer.maxTicks} ticks`,
        );
      }
    } else {
      if (DEBUG_GATHERING) {
        console.log(
          `[Forestry] 🪵 ${resourceId}: Log received by ${playerId}, ` +
            `timer=${timer.currentTicks}/${timer.maxTicks}`,
        );
      }
    }

    // Check if tree should deplete (timer at 0 AND player receives log)
    if (timer.currentTicks <= 0) {
      if (DEBUG_GATHERING) {
        console.log(
          `[Forestry] 🌳💥 ${resourceId}: Timer=0 AND log received - TREE FALLS! ` +
            `(${timer.activeGatherers.size} gatherers were active)`,
        );
      }
      // Clean up timer
      this.resourceTimers.delete(resourceId);
      return true; // Deplete the resource
    }

    return false; // Don't deplete yet
  }

  /**
   * Process resource respawns on tick (rules-accurate tick-based timing)
   * Replaces setTimeout-based respawn with deterministic tick counting
   */
  private processRespawns(tickNumber: number): void {
    // PERFORMANCE: Use pre-allocated buffer to avoid GC pressure
    const respawnedResources = this._respawnedResourcesBuffer;
    respawnedResources.length = 0;

    for (const [resourceId, respawnTick] of this.respawnAtTick.entries()) {
      if (tickNumber >= respawnTick) {
        const resource = this.resources.get(resourceId);
        if (resource) {
          resource.isAvailable = true;
          resource.lastDepleted = 0;

          // Call entity respawn method if available
          const ent = this.world.entities.get(resourceId);
          // ResourceEntity has a respawn method - check if entity is ResourceEntity
          const resourceEntity = ent as ResourceEntityMethods | undefined;
          if (resourceEntity?.respawn) {
            resourceEntity.respawn();
          }

          this.emitTypedEvent(EventType.RESOURCE_RESPAWNED, {
            resourceId: resourceId,
            position: resource.position,
          });
          this.sendNetworkMessage("resourceRespawned", {
            resourceId: resourceId,
            position: resource.position,
            depleted: false,
          });
        }
        respawnedResources.push(resourceId);
      }
    }

    // Clean up processed respawns
    for (const resourceId of respawnedResources) {
      this.respawnAtTick.delete(resourceId);
    }
  }

  /**
   * Initialize a fishing spot movement timer with random delay.
   * RULES ACCURACY: Fishing spots move periodically instead of depleting.
   */
  private initializeFishingSpotTimer(
    resourceId: ResourceID,
    position: { x: number; y: number; z: number },
  ): void {
    const currentTick = this.world.currentTick || 0;
    const { baseTicks, varianceTicks } = GATHERING_CONSTANTS.FISHING_SPOT_MOVE;

    // Random delay: baseTicks ± varianceTicks
    const randomVariance =
      Math.floor(Math.random() * varianceTicks * 2) - varianceTicks;
    const moveAtTick = currentTick + baseTicks + randomVariance;

    this.fishingSpotMoveTimers.set(resourceId, {
      moveAtTick,
      originalPosition: { ...position },
    });

    if (DEBUG_GATHERING) {
      console.log(
        `[Fishing] Initialized spot ${resourceId} move timer: will move at tick ${moveAtTick} (${((moveAtTick - currentTick) * 0.6).toFixed(0)}s)`,
      );
    }
  }

  /**
   * Process fishing spot movement on each tick.
   * RULES ACCURACY: Fishing spots don't deplete - they move to nearby tiles periodically.
   *
   */
  private processFishingSpotMovement(tickNumber: number): void {
    // PERFORMANCE: Use pre-allocated buffer to avoid GC pressure
    const spotsToMove = this._spotsToMoveBuffer;
    spotsToMove.length = 0;

    for (const [resourceId, timer] of this.fishingSpotMoveTimers.entries()) {
      if (tickNumber >= timer.moveAtTick) {
        spotsToMove.push(resourceId);
      }
    }

    for (const resourceId of spotsToMove) {
      this.relocateFishingSpot(resourceId, tickNumber);
    }
  }

  /**
   * Relocate a fishing spot to a nearby valid shore position.
   * Uses terrain-based shore detection to find valid water edges.
   * Cancels gathering for any players fishing at the old location.
   */
  private relocateFishingSpot(
    resourceId: ResourceID,
    _currentTick: number,
  ): void {
    const resource = this.resources.get(resourceId);
    if (!resource) {
      this.fishingSpotMoveTimers.delete(resourceId);
      return;
    }

    const timer = this.fishingSpotMoveTimers.get(resourceId);
    if (!timer) return;

    // If no terrain system, stay put and try again later
    if (!this.terrainSystem) {
      this.initializeFishingSpotTimer(resourceId, resource.position);
      return;
    }

    const oldPos = resource.position;

    // Search for valid water edge points near current position
    const { relocateRadius, relocateMinDistance } =
      GATHERING_CONSTANTS.FISHING_SPOT_MOVE;
    const searchRadius = relocateRadius;
    const searchBounds = {
      minX: oldPos.x - searchRadius,
      maxX: oldPos.x + searchRadius,
      minZ: oldPos.z - searchRadius,
      maxZ: oldPos.z + searchRadius,
    };

    const registry = this.terrainSystem.getWaterBodyRegistry();
    const nearbyShorePoints = findFishingSpotTiles(
      this.world.collision,
      searchBounds,
      this.terrainSystem.getHeightAt.bind(this.terrainSystem),
      registry.getWaterSurfaceAt.bind(registry),
      GATHERING_CONSTANTS.FISHING_SPOT_MOVE.shoreMinSpacing,
    );

    const occupiedFishingTiles = new Set<string>();
    for (const [otherId, otherResource] of this.resources) {
      if (
        otherId === resourceId ||
        (otherResource.type !== "fishing_spot" &&
          otherResource.skillRequired !== "fishing")
      ) {
        continue;
      }
      const tile = worldToTile(
        otherResource.position.x,
        otherResource.position.z,
      );
      occupiedFishingTiles.add(`${tile.x},${tile.z}`);
    }

    // Honor the declared movement envelope and never merge two live spots.
    const candidates = nearbyShorePoints.filter((p) => {
      const dist = Math.sqrt((p.x - oldPos.x) ** 2 + (p.z - oldPos.z) ** 2);
      const tile = worldToTile(p.x, p.z);
      return (
        dist >= relocateMinDistance &&
        dist <= relocateRadius &&
        !occupiedFishingTiles.has(`${tile.x},${tile.z}`)
      );
    });

    // If no valid spots nearby, stay put and try again later
    if (candidates.length === 0) {
      if (DEBUG_GATHERING) {
        console.log(
          `[Fishing] Spot ${resourceId} couldn't find new shore position - staying put`,
        );
      }
      this.initializeFishingSpotTimer(resourceId, resource.position);
      return;
    }

    // Pick random candidate
    const newPos = candidates[Math.floor(Math.random() * candidates.length)];

    // Cancel gathering for any players fishing at this spot
    for (const [playerId, session] of this.activeGathering.entries()) {
      if (session.resourceId === resourceId) {
        // Send message to player
        this.sendChat(playerId, "The fishing spot has moved!");
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId,
          message: "The fishing spot has moved!",
          type: "info",
        });

        // Stop gathering
        this.stopGathering({ playerId }, "resource_moved");
      }
    }

    // Update resource position
    resource.position = { x: newPos.x, y: newPos.y, z: newPos.z };

    // Update entity position if it exists
    const entity = this.world.entities.get(resourceId);
    if (entity?.position) {
      if (typeof entity.position.set === "function") {
        entity.position.set(newPos.x, newPos.y, newPos.z);
      } else {
        entity.position.x = newPos.x;
        entity.position.y = newPos.y;
        entity.position.z = newPos.z;
      }
      const entityData = entity.data as
        | {
            position?:
              [number, number, number] | { x: number; y: number; z: number };
          }
        | undefined;
      if (Array.isArray(entityData?.position)) {
        entityData.position[0] = newPos.x;
        entityData.position[1] = newPos.y;
        entityData.position[2] = newPos.z;
      } else if (entityData?.position) {
        entityData.position.x = newPos.x;
        entityData.position.y = newPos.y;
        entityData.position.z = newPos.z;
      }
      const resourceEntity = entity as unknown as {
        config?: { position?: { x: number; y: number; z: number } };
        markNetworkDirty?: () => void;
      };
      if (resourceEntity.config?.position) {
        resourceEntity.config.position = { ...resource.position };
      }
      resourceEntity.markNetworkDirty?.();
    }

    // Broadcast position update to clients
    this.sendNetworkMessage("fishingSpotMoved", {
      resourceId: resourceId,
      oldPosition: oldPos,
      newPosition: resource.position,
    });

    if (DEBUG_GATHERING) {
      console.log(
        `[Fishing] Spot ${resourceId} moved from ` +
          `(${oldPos.x.toFixed(1)}, ${oldPos.z.toFixed(1)}) to ` +
          `(${newPos.x.toFixed(1)}, ${newPos.z.toFixed(1)})`,
      );
    }

    // Reset timer for next movement
    this.initializeFishingSpotTimer(resourceId, resource.position);
  }

  private launchGatheringRewardCommit(pending: PendingGatherReward): void {
    const inventorySystem =
      this.world.getSystem?.<InventorySystem>("inventory");
    if (!inventorySystem?.commitGatheringRewardAtomic) {
      pending.receipt = {
        ok: false,
        committed: false,
        liveInventoryApplied: false,
        playerId: pending.playerId,
        operationId: pending.operationId,
        replayed: false,
        skill: pending.skill,
        xpAmount: pending.drop.xpAmount,
        reward: null,
        secondaryItemId: pending.secondaryItemId,
        retryable: true,
        reason: "atomic_persistence_unavailable",
      };
      pending.state = "settled";
      return;
    }

    pending.state = "in_flight";
    pending.receipt = null;
    void inventorySystem
      .commitGatheringRewardAtomic(pending.playerId, pending.operationId, {
        resourceId: pending.resourceId,
        depleteAfterCommit: pending.shouldDeplete,
        respawnTicks: pending.respawnTicks,
        skill: pending.skill,
        xpAmount: pending.drop.xpAmount,
        rewardItemId: pending.drop.itemId,
        rewardQuantity: pending.drop.quantity,
        secondaryItemId: pending.secondaryItemId,
      })
      .then((receipt) => {
        if (
          this.isDestroying ||
          this.pendingGatherRewards.get(pending.playerId) !== pending
        ) {
          return;
        }
        pending.receipt = receipt;
        pending.state = "settled";
      })
      .catch((error) => {
        if (
          this.isDestroying ||
          this.pendingGatherRewards.get(pending.playerId) !== pending
        ) {
          return;
        }
        console.error(
          `[ResourceSystem] Gathering reward ${pending.operationId} returned an unexpected error:`,
          error,
        );
        pending.receipt = {
          ok: false,
          committed: false,
          liveInventoryApplied: false,
          playerId: pending.playerId,
          operationId: pending.operationId,
          replayed: false,
          skill: pending.skill,
          xpAmount: pending.drop.xpAmount,
          reward: null,
          secondaryItemId: pending.secondaryItemId,
          retryable: true,
          reason: "persistence_ambiguous",
        };
        pending.state = "settled";
      });
  }

  private releaseGatheringRewardReservation(
    pending: PendingGatherReward,
  ): void {
    if (
      this.gatheringRewardReservations.get(pending.resourceId) ===
      pending.operationId
    ) {
      this.gatheringRewardReservations.delete(pending.resourceId);
    }
  }

  private processPendingGatherRewards(tickNumber: number): void {
    for (const pending of this.pendingGatherRewards.values()) {
      if (pending.state === "retry_wait") {
        if (tickNumber >= pending.retryAtTick) {
          this.launchGatheringRewardCommit(pending);
        }
        continue;
      }
      if (pending.state !== "settled" || !pending.receipt) continue;

      const receipt = pending.receipt;
      if (!receipt.ok) {
        if (receipt.retryable) {
          pending.retryCount++;
          const delayTicks = Math.min(2 ** Math.min(pending.retryCount, 6), 50);
          pending.retryAtTick = tickNumber + delayTicks;
          pending.receipt = null;
          pending.state = "retry_wait";
          const session = this.activeGathering.get(pending.playerId);
          if (
            pending.retryCount === 1 &&
            session?.fishingInteraction?.awaitingOperationId ===
              pending.operationId
          ) {
            this.transitionFishingInteraction(
              pending.playerId,
              session,
              session.fishingInteraction.itemId === "harpoon"
                ? "recovering"
                : "deployed",
              "verifying",
              null,
            );
          }
          if (pending.retryCount === 1 || pending.retryCount % 10 === 0) {
            console.warn(
              `[ResourceSystem] Retaining unresolved gathering reward ${pending.operationId}; retry ${pending.retryCount} in ${delayTicks} ticks (${receipt.reason}).`,
            );
          }
          continue;
        }

        this.pendingGatherRewards.delete(pending.playerId);
        this.releaseGatheringRewardReservation(pending);
        const session = this.activeGathering.get(pending.playerId);
        if (session?.pendingRewardOperationId === pending.operationId) {
          session.pendingRewardOperationId = null;
        }
        const message =
          receipt.reason === "inventory_full"
            ? `Your inventory is too full to hold any more ${pending.drop.itemName.toLowerCase()}.`
            : receipt.reason === "secondary_missing"
              ? `You no longer have the required ${pending.secondaryItemId?.replace(/_/g, " ") ?? "supplies"}.`
              : receipt.reason === "resource_unavailable"
                ? `The ${pending.resourceName.toLowerCase()} was depleted by another gatherer.`
                : "That gathering result could not be validated. Please try again.";
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message,
          type: "warning",
        });
        if (pending.completionBound) {
          this.emitTypedEvent(EventType.RESOURCE_GATHERING_COMPLETED, {
            playerId: pending.playerId,
            resourceId: pending.resourceId,
            successful: false,
            skill: pending.skill,
            operationId: pending.operationId,
            failureReason: receipt.reason,
          });
        }
        this.cancelGatheringForPlayer(
          pending.playerId,
          `reward_${receipt.reason}`,
        );
        continue;
      }

      this.emitTypedEvent(EventType.SKILLS_PROGRESS_COMMITTED, {
        playerId: receipt.playerId,
        operationId: receipt.operationId,
        replayed: receipt.replayed,
        skill: receipt.skill,
        xpAmount: receipt.xpAmount,
        awardedXp: receipt.awardedXp,
        operationCommittedXp: receipt.operationCommittedXp,
        currentXp: receipt.currentXp,
        currentLevel: receipt.currentLevel,
      });
      this.pendingGatherRewards.delete(pending.playerId);
      this.releaseGatheringRewardReservation(pending);
      const session = this.activeGathering.get(pending.playerId);
      if (session?.pendingRewardOperationId === pending.operationId) {
        session.pendingRewardOperationId = null;
        session.successes++;
        if (
          session.fishingInteraction?.awaitingOperationId ===
          pending.operationId
        ) {
          session.fishingInteraction.awaitingOperationId = null;
          this.transitionFishingInteraction(
            pending.playerId,
            session,
            session.fishingInteraction.itemId === "harpoon"
              ? "recovering"
              : "retrieving",
            "caught",
            tickNumber +
              (session.fishingInteraction.itemId === "harpoon" ? 1 : 2),
          );
        }
        // A persistence outage can resolve after the cycle that was scheduled
        // when this roll began. Do not execute a catch-up roll in the same
        // authoritative tick: retain the normal schedule when it is still in
        // the future, otherwise restart one existing full cycle from recovery.
        if (session.nextAttemptTick <= tickNumber) {
          session.nextAttemptTick = tickNumber + session.cycleTickInterval;
        }
      }

      this.sendChat(
        pending.playerId,
        `You receive ${pending.drop.quantity}x ${pending.drop.itemName}.`,
      );
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: pending.playerId,
        message: `You get some ${pending.drop.itemName.toLowerCase()}. (+${receipt.awardedXp} ${pending.skill} XP)`,
        type: "success",
      });
      if (!receipt.liveInventoryApplied) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message:
            "Your reward is safely recorded, but the live inventory view needs to resynchronize.",
          type: "warning",
        });
      }

      // Publish quest-facing gathering truth for every committed reward, not
      // only for the subset of rolls that also deplete the source. The durable
      // operation identity lets downstream consumers reject non-custody events.
      this.emitTypedEvent(EventType.RESOURCE_GATHERING_COMPLETED, {
        playerId: pending.playerId,
        resourceId: pending.resourceId,
        successful: true,
        skill: pending.skill,
        operationId: pending.operationId,
        rewardItemId: pending.drop.itemId,
        rewardQuantity: pending.drop.quantity,
      });

      const resource = this.resources.get(pending.resourceId);
      if (!resource?.isAvailable) continue;
      if (pending.depletionMode === "timer") {
        this.handleForestryLog(
          pending.playerId,
          pending.resourceId,
          tickNumber,
        );
      }
      const depletedUntil = receipt.depletedUntil;
      if (depletedUntil === null || depletedUntil <= Date.now()) continue;

      resource.isAvailable = false;
      resource.lastDepleted =
        depletedUntil - pending.respawnTicks * TICK_DURATION_MS;
      const resourceEntity = this.world.entities.get(pending.resourceId) as
        ResourceEntityMethods | undefined;
      resourceEntity?.deplete?.();
      this.emitTypedEvent(EventType.RESOURCE_DEPLETED, {
        resourceId: pending.resourceId,
        position: resource.position,
      });
      this.sendChat(
        pending.playerId,
        `The ${pending.resourceName.toLowerCase()} is depleted.`,
      );
      this.sendNetworkMessage("resourceDepleted", {
        resourceId: pending.resourceId,
        position: resource.position,
        depleted: true,
      });
      this.respawnAtTick.set(
        pending.resourceId,
        tickNumber +
          Math.max(
            1,
            Math.ceil((depletedUntil - Date.now()) / TICK_DURATION_MS),
          ),
      );
    }
  }

  /**
   * Process all active gathering sessions on each server tick (rules-accurate 600ms)
   *
   * Called by TickSystem at RESOURCES priority. Handles:
   * 1. Resource respawn checks (tick-based, not setTimeout)
   * 2. Proximity validation (server-authoritative position)
   * 3. Inventory capacity checks
   * 4. Success/failure rolls using cached success rate
   * 5. Drop rolling from manifest harvestYield
   * 6. XP awards and inventory updates
   * 7. Resource depletion with tick-based respawn scheduling
   *
   * Uses cached session data to avoid per-tick allocations (performance).
   * Sessions are cleaned up immediately when conditions fail.
   *
   * @param tickNumber - Current server tick number for timing calculations
   *
   * @emits SKILLS_PROGRESS_COMMITTED after the durable gathering receipt commits
   * @emits RESOURCE_GATHERING_STOPPED when session ends
   * @emits RESOURCE_DEPLETED when resource is exhausted
   */
  public processGatheringTick(tickNumber: number): void {
    this.fishingPresentationServerTick = Math.max(
      this.fishingPresentationServerTick,
      tickNumber,
    );
    // Resolve committed rewards and retry only ambiguous receipts before any
    // new success rolls. This keeps world depletion on authoritative ticks.
    this.processPendingGatherRewards(tickNumber);

    // Advance exact net/pot/harpoon public state before evaluating the next
    // attempt. Transitions are server-tick-owned, so clients never infer a
    // release or world placement from local animation time.
    this.advanceFishingInteractionPresentations(tickNumber);

    // Process respawns first (tick-based)
    this.processRespawns(tickNumber);

    // RULES ACCURACY: Process fishing spot movement
    this.processFishingSpotMovement(tickNumber);

    // Retry deferred fishing spot spawns (waiting for collision flags to bake).
    // Only check every 10 ticks (~6s) to avoid pointless iteration.
    if (this.pendingFishingAreas.size > 0 && tickNumber % 10 === 0) {
      for (const [areaId, area] of this.pendingFishingAreas) {
        // Retry only after every terrain tile intersecting the fishing area has
        // baked walkability. A zero collision flag means "walkable", not "not
        // ready"; the previous center/corner flag probe could therefore leave
        // a valid pond pending forever.
        let fullyBaked = true;
        const sampleStep = 50;
        for (
          let x = area.bounds.minX;
          x <= area.bounds.maxX && fullyBaked;
          x += sampleStep
        ) {
          for (
            let z = area.bounds.minZ;
            z <= area.bounds.maxZ;
            z += sampleStep
          ) {
            if (!this.terrainSystem?.hasBakedWalkabilityAt(x, z)) {
              fullyBaked = false;
              break;
            }
          }
        }
        if (fullyBaked) {
          this.spawnDynamicFishingSpots(areaId, area);
        }
      }
    }

    // FORESTRY: Process resource timers (depletion/regeneration)
    this.processResourceTimers(tickNumber);

    // Process active gathering sessions
    // PERFORMANCE: Use pre-allocated buffer to avoid GC pressure
    const completedSessions = this._completedSessionsBuffer;
    completedSessions.length = 0;
    const completedSessionFailureReasons = this._completedSessionFailureReasons;
    completedSessionFailureReasons.clear();

    for (const [playerId, session] of this.activeGathering.entries()) {
      const resource = this.resources.get(session.resourceId);
      if (!resource?.isAvailable) {
        // Resource depleted, end session
        completedSessions.push(playerId);
        completedSessionFailureReasons.set(playerId, "resource_unavailable");
        continue;
      }

      if (session.pendingRewardOperationId) continue;
      if (this.gatheringRewardReservations.has(session.resourceId)) continue;

      // Only process when it's time for the next attempt (tick-based)
      if (tickNumber < session.nextAttemptTick) continue;
      if (
        session.fishingInteraction &&
        tickNumber < session.fishingInteraction.firstAttemptTick
      ) {
        continue;
      }

      // RULES ACCURACY: Server-authoritative movement detection
      // In classic MMORPG, ANY movement cancels gathering (weak queue action)
      // Position is fetched from world state, never from client payload
      const p = this.world.getPlayer?.(playerId);
      const playerPos =
        p && (p as { position?: { x: number; y: number; z: number } }).position
          ? (p as { position: { x: number; y: number; z: number } }).position
          : null;

      if (!playerPos) {
        // Player not found - cancel session
        this.emitTypedEvent(EventType.RESOURCE_GATHERING_STOPPED, {
          playerId: playerId,
          resourceId: session.resourceId,
        });
        completedSessions.push(playerId);
        completedSessionFailureReasons.set(playerId, "player_missing");
        continue;
      }

      // Check if player moved from their starting position (classic MMORPG: any movement cancels)
      const startPos = session.cachedStartPosition;
      const epsilon = GATHERING_CONSTANTS.POSITION_EPSILON;
      const movedX = Math.abs(playerPos.x - startPos.x) > epsilon;
      const movedZ = Math.abs(playerPos.z - startPos.z) > epsilon;

      if (movedX || movedZ) {
        // Player moved - cancel gathering (classic MMORPG: weak queue cancelled on any movement)
        if (DEBUG_GATHERING) {
          console.log(
            `[ResourceSystem] Cancelling gather for ${playerId} - player moved from (${startPos.x.toFixed(2)}, ${startPos.z.toFixed(2)}) to (${playerPos.x.toFixed(2)}, ${playerPos.z.toFixed(2)})`,
          );
        }
        this.emitTypedEvent(EventType.RESOURCE_GATHERING_STOPPED, {
          playerId: playerId,
          resourceId: session.resourceId,
        });
        this.resetGatheringEmote(playerId);
        completedSessions.push(playerId);
        completedSessionFailureReasons.set(playerId, "movement");
        continue;
      }

      // Secondary check: still within interaction range (safety net)
      if (
        calculateDistance(playerPos, resource.position) >
        GATHERING_CONSTANTS.DEFAULT_INTERACTION_RANGE
      ) {
        this.emitTypedEvent(EventType.RESOURCE_GATHERING_STOPPED, {
          playerId: playerId,
          resourceId: session.resourceId,
        });
        this.resetGatheringEmote(playerId);
        completedSessions.push(playerId);
        completedSessionFailureReasons.set(playerId, "out_of_range");
        continue;
      }

      // RULES ACCURACY: Check for secondary consumable (bait, feathers) on each tick
      // Stop gathering if player runs out of bait/feathers
      if (resource.secondaryRequired) {
        const hasSecondary = this.playerHasItem(
          playerId,
          resource.secondaryRequired,
        );
        if (!hasSecondary) {
          const secondaryName = resource.secondaryRequired.replace(/_/g, " ");
          this.emitTypedEvent(EventType.UI_MESSAGE, {
            playerId: playerId,
            message: `You have run out of ${secondaryName}.`,
            type: "warning",
          });
          this.emitTypedEvent(EventType.RESOURCE_GATHERING_STOPPED, {
            playerId: playerId,
            resourceId: session.resourceId,
          });
          this.resetGatheringEmote(playerId);
          completedSessions.push(playerId);
          completedSessionFailureReasons.set(playerId, "secondary_missing");
          continue;
        }
      }

      // PERFORMANCE: Use cached tuning data (zero allocation per tick)
      const tuned = session.cachedTuning;

      // Schedule next attempt (tick-based)
      session.nextAttemptTick = tickNumber + session.cycleTickInterval;
      session.attempts++;

      // PERFORMANCE: Use cached success rate (zero allocation per tick)
      const roll = Math.random();
      const isSuccessful = roll < session.cachedSuccessRate;
      this.publishFishingAttemptPresentation(
        playerId,
        session,
        isSuccessful,
        tickNumber,
      );

      // DEBUG: Log each roll result
      if (DEBUG_GATHERING) {
        const debug = session.debugInfo;
        console.log(
          `[Gathering DEBUG] Roll #${session.attempts}: ${(roll * 100).toFixed(1)}% vs ${(session.cachedSuccessRate * 100).toFixed(1)}% → ${isSuccessful ? "SUCCESS" : "FAIL"} ` +
            `(${debug?.skill ?? "?"} | ${debug?.variant ?? "?"} | ${debug?.toolTier ?? "no tool"})`,
        );
      }

      if (isSuccessful) {
        // RULES ACCURACY: Get player's skill level for priority-based fish rolling
        const cachedSkills = this.playerSkills.get(playerId);
        const playerSkillLevel =
          cachedSkills?.[resource.skillRequired]?.level ?? 1;

        // PERFORMANCE: Roll against cached drop table (avoids resource lookup)
        // For fishing, this uses classic MMORPG priority rolling with per-fish catch rates
        const drop = this.rollDrop(session.cachedDrops, playerSkillLevel);
        const usesTimer = this.usesTimerBasedDepletion(session.resourceId);
        const canChanceDeplete =
          !usesTimer &&
          resource.skillRequired !== "fishing" &&
          (tuned.depleteChance ?? 1) > 0;
        const timer = usesTimer
          ? this.resourceTimers.get(session.resourceId)
          : undefined;
        const shouldDeplete = usesTimer
          ? timer?.hasReceivedFirstLog === true && timer.currentTicks <= 0
          : canChanceDeplete && Math.random() < (tuned.depleteChance ?? 1);
        const completionOperationId = session.completionOperationId;
        session.completionOperationId = null;
        const pending: PendingGatherReward = {
          operationId:
            completionOperationId ?? `gathering-reward:${uuid()}${uuid()}`,
          playerId,
          resourceId: session.resourceId,
          skill: resource.skillRequired as PendingGatherReward["skill"],
          drop,
          resourceName: session.cachedResourceName,
          respawnTicks: tuned.respawnTicks,
          secondaryItemId: resource.secondaryRequired ?? null,
          depletionMode: usesTimer
            ? "timer"
            : canChanceDeplete
              ? "chance"
              : "none",
          shouldDeplete,
          state: "in_flight",
          retryCount: 0,
          retryAtTick: tickNumber,
          receipt: null,
          completionBound: completionOperationId !== null,
        };
        session.pendingRewardOperationId = pending.operationId;
        if (session.fishingInteraction) {
          session.fishingInteraction.awaitingOperationId = pending.operationId;
        }
        this.pendingGatherRewards.set(playerId, pending);
        if (usesTimer || canChanceDeplete) {
          this.gatheringRewardReservations.set(
            session.resourceId,
            pending.operationId,
          );
        }
        this.launchGatheringRewardCommit(pending);
      } else {
        // Failure feedback (optional gentle info)
        // PERFORMANCE: Use cached resource name
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: playerId,
          message: `You fail to gather from the ${session.cachedResourceName.toLowerCase()}.`,
          type: "info",
        });
      }
    }

    // Clean up completed sessions
    for (const playerId of completedSessions) {
      const session = this.activeGathering.get(playerId);
      if (session) {
        this.publishBoundGatheringFailure(
          session,
          completedSessionFailureReasons.get(playerId) ?? "session_invalidated",
        );
        // FORESTRY: Remove from active gatherers (timer will regenerate if no other gatherers)
        this.removeActiveGatherer(playerId, session.resourceId);
        if (session.toolItemId) {
          this.hideGatheringTool(playerId);
        }
      }
      this.activeGathering.delete(playerId);
      // Reset emote back to idle when gathering completes
      this.resetGatheringEmote(playerId);
    }
    completedSessionFailureReasons.clear();
  }

  // Legacy completeGathering() method removed - continuous loop in updateGathering() handles all gathering now

  // ===== Tuning helpers (TICK-BASED for classic MMORPG accuracy) =====
  // Standard woodcutting = 4 ticks (2.4 seconds) per attempt
  private getVariantTuning(variantKey: string): {
    levelRequired: number;
    xpPerLog: number;
    baseCycleTicks: number; // Ticks between attempts (600ms each)
    depleteChance: number;
    respawnTicks: number; // Respawn time in ticks
  } {
    // Load from manifest - fail fast if not found
    const manifestData = getExternalResource(variantKey);

    if (!manifestData) {
      throw new Error(
        `[ResourceSystem] Resource manifest not found for '${variantKey}'. ` +
          `Ensure resources.json is loaded and contains this resource type.`,
      );
    }

    if (!manifestData.harvestYield || manifestData.harvestYield.length === 0) {
      throw new Error(
        `[ResourceSystem] Resource '${variantKey}' has no harvestYield defined in manifest.`,
      );
    }

    // Get XP from first harvest yield entry
    const xpPerLog = manifestData.harvestYield[0].xpAmount;
    return {
      levelRequired: manifestData.levelRequired,
      xpPerLog,
      baseCycleTicks: manifestData.baseCycleTicks,
      depleteChance: manifestData.depleteChance,
      respawnTicks: manifestData.respawnTicks,
    };
  }

  /**
   * Compute gathering cycle in ticks (rules-accurate, skill-specific).
   * SERVER-SIDE: Rolls for dragon/crystal pickaxe bonus speed here to maintain determinism.
   * @see gathering/SuccessRateCalculator.ts for implementation
   */
  private computeCycleTicks(
    skill: string,
    tuned: { levelRequired: number; baseCycleTicks: number },
    toolData: GatheringToolData | null,
  ): number {
    // Roll for dragon/crystal pickaxe bonus speed server-side
    // Dragon: 1/6 chance (0.167), Crystal: 1/4 chance (0.25)
    const bonusRollTriggered =
      toolData?.bonusTickChance !== undefined &&
      Math.random() < toolData.bonusTickChance;

    return computeCycleTicksUtil(
      skill,
      tuned.baseCycleTicks,
      toolData,
      bonusRollTriggered,
    );
  }

  /**
   * Convert ticks to milliseconds for client progress bar.
   * @see gathering/SuccessRateCalculator.ts for implementation
   */
  private ticksToMs(ticks: number): number {
    return ticksToMsUtil(ticks);
  }

  /**
   * Compute success rate using classic MMORPG's LERP interpolation formula.
   * @see gathering/SuccessRateCalculator.ts for implementation
   */
  private computeSuccessRate(
    skillLevel: number,
    skill: string,
    resourceVariant: string,
    toolTier: string | null,
  ): number {
    return computeSuccessRateUtil(skillLevel, skill, resourceVariant, toolTier);
  }

  /**
   * Get low/high success rate values from the appropriate table.
   * @see gathering/SuccessRateCalculator.ts for implementation
   */
  private getSuccessRateValues(
    skill: string,
    resourceVariant: string,
    toolTier: string | null,
  ): { low: number; high: number } {
    return getSuccessRateValuesUtil(skill, resourceVariant, toolTier);
  }

  /**
   * Roll against harvestYield chances to determine drop.
   * @see gathering/DropRoller.ts for implementation
   */
  private rollDrop(drops: ResourceDrop[], playerLevel?: number): ResourceDrop {
    return rollDropUtil(drops, playerLevel, DEBUG_GATHERING);
  }

  /**
   * SECURITY: Validate resource ID format to prevent injection attacks
   * Valid IDs are alphanumeric with underscores/hyphens, reasonable length
   */
  private isValidResourceId(resourceId: string): boolean {
    if (!resourceId || typeof resourceId !== "string") {
      return false;
    }
    if (resourceId.length > GATHERING_CONSTANTS.MAX_RESOURCE_ID_LENGTH) {
      return false;
    }
    // Only allow alphanumeric, underscores, hyphens, and periods
    if (!GATHERING_CONSTANTS.VALID_RESOURCE_ID_PATTERN.test(resourceId)) {
      return false;
    }
    return true;
  }

  /**
   * Get best tool for a skill from player inventory (manifest-driven)
   * Returns tool data from tools.json manifest
   *
   * Tools are loaded from packages/server/world/assets/manifests/tools.json
   * and sorted by priority (1 = best, higher = worse)
   *
   * @param playerId - Player to check inventory for
   * @param skill - Skill name (woodcutting, mining, fishing)
   */
  private getBestTool(
    playerId: string,
    skill: string,
  ): GatheringToolData | null {
    // Get tools for this skill from manifest, sorted by priority (best first)
    const skillTools = getExternalToolsForSkill(
      skill as "woodcutting" | "mining" | "fishing",
    );

    if (skillTools.length === 0) {
      // No tools defined for this skill in manifest
      return null;
    }

    // Build a set of item IDs from inventory
    const inventorySystem = this.world.getSystem?.("inventory") as {
      getInventory?: (playerId: string) => {
        items?: Array<{ itemId?: string }>;
      };
    } | null;

    const inv = inventorySystem?.getInventory?.(playerId);
    const items = inv?.items || [];

    const playerItemIds = new Set(
      items.map((item) => item?.itemId).filter(Boolean),
    );

    // Also check equipped weapon slot (tools go in weapon slot)
    const equipmentSystem = this.world.getSystem?.("equipment") as {
      getPlayerEquipment?: (playerId: string) =>
        | {
            weapon?: { itemId?: string | number | null };
          }
        | undefined;
    } | null;

    if (equipmentSystem?.getPlayerEquipment) {
      const equipment = equipmentSystem.getPlayerEquipment(playerId);
      const weaponItemId = equipment?.weapon?.itemId;

      if (weaponItemId) {
        const itemIdStr =
          typeof weaponItemId === "number"
            ? weaponItemId.toString()
            : weaponItemId;
        playerItemIds.add(itemIdStr);
      }
    }

    // Check tools in priority order (best first) - exact itemId match
    for (const tool of skillTools) {
      if (playerItemIds.has(tool.itemId)) {
        return tool;
      }
    }

    return null; // No tool found for this skill
  }

  /**
   * Resolve mechanical tool authority for one resource. Fishing equipment is
   * exact and non-interchangeable, so an unrelated higher-priority fishing item
   * must never supply level or presentation authority for the active spot.
   */
  private getToolForResource(
    playerId: string,
    skill: string,
    requiredToolId: string | null | undefined,
  ): GatheringToolData | null {
    if (skill !== "fishing") return this.getBestTool(playerId, skill);
    if (!requiredToolId) return null;
    return (
      getExternalToolsForSkill("fishing").find(
        (tool) => tool.itemId === requiredToolId,
      ) ?? null
    );
  }

  /**
   * Extract tool category from toolRequired field.
   * @see gathering/ToolUtils.ts for implementation
   */
  private getToolCategory(toolRequired: string): string {
    return getToolCategoryUtil(toolRequired);
  }

  /**
   * Get display name for tool category.
   * @see gathering/ToolUtils.ts for implementation
   */
  private getToolDisplayName(category: string): string {
    return getToolDisplayNameUtil(category);
  }

  /**
   * Get the despawn ticks for a resource based on its type (Forestry system).
   * Returns 0 for resources that use chance-based depletion (regular trees, mining).
   *
   * @param resourceId - The resource ID to look up
   * @returns Despawn time in ticks, or 0 if chance-based
   */
  private getResourceDespawnTicks(resourceId: ResourceID): number {
    // Get the variant key (e.g., "tree_oak", "tree_willow")
    const variantKey = this.resourceVariants.get(resourceId);
    if (!variantKey) return 0;

    // Extract tree type from variant key (e.g., "tree_oak" -> "oak")
    const parts = variantKey.split("_");
    const resourceType = parts[0];
    const subType = parts.length > 1 ? parts[1] : "tree";

    // Only trees use the Forestry timer system
    if (resourceType !== "tree") {
      return 0; // Mining, fishing, etc. use chance-based or don't deplete
    }

    // Map subType to TREE_DESPAWN_TICKS key
    const treeType = subType === "normal" ? "tree" : subType;
    const despawnTicks =
      GATHERING_CONSTANTS.TREE_DESPAWN_TICKS[
        treeType as keyof typeof GATHERING_CONSTANTS.TREE_DESPAWN_TICKS
      ];

    return despawnTicks ?? 0;
  }

  /**
   * Check if a resource uses timer-based depletion (Forestry) vs chance-based.
   *
   * @param resourceId - The resource ID
   * @returns true if uses Forestry timer, false if chance-based
   */
  private usesTimerBasedDepletion(resourceId: ResourceID): boolean {
    return this.getResourceDespawnTicks(resourceId) > 0;
  }

  /**
   * Check if player has a specific item in their inventory
   * Used for secondary consumable checks (bait, feathers, etc.)
   */
  private playerHasItem(playerId: string, itemId: string): boolean {
    const inventorySystem = this.world.getSystem?.("inventory") as {
      getInventory?: (playerId: string) => {
        items?: Array<{ itemId?: string; quantity?: number }>;
      };
    } | null;

    if (!inventorySystem?.getInventory) {
      return false;
    }

    const inv = inventorySystem.getInventory(playerId);
    const items = inv?.items || [];

    return items.some(
      (item) =>
        item?.itemId?.toLowerCase() === itemId.toLowerCase() &&
        (item.quantity ?? 1) > 0,
    );
  }

  /**
   * Check if player has any tool matching the required category.
   * Checks both inventory AND equipped items (tools in weapon slot).
   * @see gathering/ToolUtils.ts for matching logic
   */
  private playerHasToolCategory(playerId: string, category: string): boolean {
    // Check inventory first
    const inventorySystem = this.world.getSystem?.("inventory") as {
      getInventory?: (playerId: string) => {
        items?: Array<{ itemId?: string }>;
      };
    } | null;

    if (inventorySystem?.getInventory) {
      const inv = inventorySystem.getInventory(playerId);
      const items = inv?.items || [];

      const hasInInventory = items.some((item) => {
        if (!item?.itemId) return false;
        return itemMatchesToolCategory(item.itemId, category);
      });

      if (hasInInventory) {
        return true;
      }
    }

    // Check equipped items (tools go in weapon slot)
    const equipmentSystem = this.world.getSystem?.("equipment") as {
      getPlayerEquipment?: (playerId: string) =>
        | {
            weapon?: { itemId?: string | number | null };
          }
        | undefined;
    } | null;

    if (equipmentSystem?.getPlayerEquipment) {
      const equipment = equipmentSystem.getPlayerEquipment(playerId);
      const weaponItemId = equipment?.weapon?.itemId;

      if (weaponItemId) {
        const itemIdStr =
          typeof weaponItemId === "number"
            ? weaponItemId.toString()
            : weaponItemId;
        if (itemMatchesToolCategory(itemIdStr, category)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get all resources for testing/debugging
   */
  getAllResources(): Resource[] {
    return Array.from(this.resources.values());
  }

  /**
   * Get resources by type
   */
  getResourcesByType(type: string): Resource[] {
    return this.getAllResources().filter((resource) => resource.type === type);
  }

  /** Resolve an available authoritative resource by its manifest variant. */
  getAvailableResourceByVariant(variant: string): Resource | undefined {
    for (const [resourceId, resourceVariant] of this.resourceVariants) {
      if (resourceVariant !== variant) continue;
      const resource = this.resources.get(resourceId);
      if (resource?.isAvailable) return resource;
    }
    return undefined;
  }

  /**
   * Check if a player has the required tool for a resource.
   * Used by PendingGatherManager to decide whether to set arrival emotes.
   */
  playerHasRequiredToolForResource(
    playerId: string,
    resourceId: string,
  ): boolean {
    const resource = this.resources.get(createResourceID(resourceId));
    if (!resource?.toolRequired) return true;
    const category = this.getToolCategory(resource.toolRequired);
    return this.playerHasToolCategory(playerId, category);
  }

  /**
   * Get resource by ID
   */
  getResource(resourceId: string): Resource | undefined {
    return this.resources.get(createResourceID(resourceId));
  }

  /** Operational snapshot for detecting stuck or accumulating reward custody. */
  getGatheringCustodyStats(): {
    activeSessions: number;
    pendingRewards: number;
    inFlightRewards: number;
    retryWaitingRewards: number;
    resourceReservations: number;
    maxRetryCount: number;
  } {
    let inFlightRewards = 0;
    let retryWaitingRewards = 0;
    let maxRetryCount = 0;
    for (const pending of this.pendingGatherRewards.values()) {
      if (pending.state === "in_flight") inFlightRewards++;
      if (pending.state === "retry_wait") retryWaitingRewards++;
      maxRetryCount = Math.max(maxRetryCount, pending.retryCount);
    }
    return {
      activeSessions: this.activeGathering.size,
      pendingRewards: this.pendingGatherRewards.size,
      inFlightRewards,
      retryWaitingRewards,
      resourceReservations: this.gatheringRewardReservations.size,
      maxRetryCount,
    };
  }

  /**
   * Read-only operational snapshot for long-running population and resource
   * ecology verification. Every retained lifecycle index is represented so a
   * production soak can detect contradictory state or unbounded growth.
   */
  getResourceEcologyStats(): ResourceEcologyStats {
    let availableResources = 0;
    for (const resource of this.resources.values()) {
      if (resource.isAvailable) availableResources++;
    }

    let forestryActiveGatherers = 0;
    for (const timer of this.resourceTimers.values()) {
      forestryActiveGatherers += timer.activeGatherers.size;
    }

    return {
      totalResources: this.resources.size,
      availableResources,
      depletedResources: this.resources.size - availableResources,
      manifestResources: this.manifestResourceIds.size,
      resourceVariants: this.resourceVariants.size,
      forestryTimers: this.resourceTimers.size,
      forestryActiveGatherers,
      scheduledRespawns: this.respawnAtTick.size,
      fishingMovementTimers: this.fishingSpotMoveTimers.size,
      pendingFishingAreas: this.pendingFishingAreas.size,
      playerSkillSnapshots: this.playerSkills.size,
      gatherRateLimits: this.gatherRateLimits.size,
      suspiciousPatternEntries: this.suspiciousPatterns.size,
      custody: this.getGatheringCustodyStats(),
    };
  }

  /**
   * Bounded, read-only launch diagnostics for fishing areas that are still
   * waiting on live shoreline discovery. This runs only when an operator asks
   * for the admin memory report; it never adds work to the authoritative tick.
   */
  getPendingFishingAreaDiagnostics(): PendingFishingAreaDiagnostic[] {
    if (!this.terrainSystem || this.pendingFishingAreas.size === 0) return [];

    const terrain = this.terrainSystem;
    const registry = terrain.getWaterBodyRegistry();
    const blockingFlags =
      CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE | CollisionFlag.BLOCKED;
    const diagnostics: PendingFishingAreaDiagnostic[] = [];

    for (const [areaId, area] of this.pendingFishingAreas) {
      const probePositions = [
        [area.bounds.minX, area.bounds.minZ],
        [area.bounds.minX, area.bounds.maxZ],
        [area.bounds.maxX, area.bounds.minZ],
        [area.bounds.maxX, area.bounds.maxZ],
        [
          (area.bounds.minX + area.bounds.maxX) / 2,
          (area.bounds.minZ + area.bounds.maxZ) / 2,
        ],
      ] as const;
      const bakedProbeCount = probePositions.reduce(
        (count, [x, z]) =>
          count + (terrain.hasBakedWalkabilityAt(x, z) ? 1 : 0),
        0,
      );

      let total = 0;
      let water = 0;
      let steep = 0;
      let blocked = 0;
      let landAdjacentToWater = 0;
      const minX = Math.floor(area.bounds.minX);
      const maxX = Math.floor(area.bounds.maxX);
      const minZ = Math.floor(area.bounds.minZ);
      const maxZ = Math.floor(area.bounds.maxZ);
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          total++;
          const flags = this.world.collision.getFlags(x, z);
          if ((flags & CollisionFlag.WATER) !== 0) water++;
          if ((flags & CollisionFlag.STEEP_SLOPE) !== 0) steep++;
          if ((flags & CollisionFlag.BLOCKED) !== 0) blocked++;
          if ((flags & blockingFlags) !== 0) continue;
          if (
            this.world.collision.hasFlags(x - 1, z, CollisionFlag.WATER) ||
            this.world.collision.hasFlags(x + 1, z, CollisionFlag.WATER) ||
            this.world.collision.hasFlags(x, z - 1, CollisionFlag.WATER) ||
            this.world.collision.hasFlags(x, z + 1, CollisionFlag.WATER)
          ) {
            landAdjacentToWater++;
          }
        }
      }

      const shorePoints = findFishingSpotTiles(
        this.world.collision,
        area.bounds,
        terrain.getHeightAt.bind(terrain),
        registry.getWaterSurfaceAt.bind(registry),
        GATHERING_CONSTANTS.FISHING_SPOT_MOVE.shoreMinSpacing,
      );
      const centerX = (area.bounds.minX + area.bounds.maxX) / 2;
      const centerZ = (area.bounds.minZ + area.bounds.maxZ) / 2;
      const terrainHeight = terrain.getHeightAt(centerX, centerZ);
      const waterSurface = registry.getWaterSurfaceAt(centerX, centerZ);

      diagnostics.push({
        areaId,
        bounds: { ...area.bounds },
        bakedProbeCount,
        totalBakedProbes: probePositions.length,
        collisionTiles: {
          total,
          water,
          steep,
          blocked,
          landAdjacentToWater,
        },
        discoveredShorePoints: shorePoints.length,
        center: {
          x: centerX,
          z: centerZ,
          terrainHeight: Number.isFinite(terrainHeight) ? terrainHeight : null,
          waterSurface: Number.isFinite(waterSurface) ? waterSurface : null,
        },
      });
    }

    return diagnostics;
  }

  /**
   * Check if a player is actively gathering a specific resource.
   * Used to prevent repeated gather requests from creating unnecessary objects.
   *
   * @param playerId - The player ID
   * @param resourceId - The resource ID to check
   * @returns true if player is actively gathering this exact resource
   */
  isPlayerGatheringResource(playerId: string, resourceId: string): boolean {
    const session = this.activeGathering.get(playerId as PlayerID);
    if (!session) return false;
    const normalizedResourceId = createResourceID(resourceId);
    return session.resourceId === normalizedResourceId;
  }

  /**
   * Bind a newly-started autonomous action to the next reward of an already
   * active session. An in-flight reward or a different waiter fails closed.
   */
  bindGatheringCompletionAttempt(
    playerId: string,
    resourceId: string,
    attemptId: string,
  ): boolean {
    const operationId = getGatheringRewardOperationIdForAttempt(attemptId);
    if (!operationId) return false;
    const session = this.activeGathering.get(createPlayerID(playerId));
    if (
      !session ||
      session.resourceId !== createResourceID(resourceId) ||
      session.pendingRewardOperationId !== null
    ) {
      return false;
    }
    if (
      session.completionOperationId !== null &&
      session.completionOperationId !== operationId
    ) {
      return false;
    }
    session.completionOperationId = operationId;
    return true;
  }

  /**
   * Cleanup when system is destroyed
   * Clears all active sessions, resources, and rate limits
   */
  destroy(): void {
    this.isDestroying = true;
    for (const lease of this.terrainResourceLeases.values()) {
      this.retireTerrainResourceLease(lease);
    }
    this.terrainResourceLeases.clear();
    this.terrainResourceRegistrations.clear();
    // Pending tails keep their own lease references and exact entity cleanup.
    // Do not allow a destroyed system to retain completed queue entries.
    this.terrainResourceTails.clear();

    // Clear all active gathering sessions
    this.activeGathering.clear();
    this.gatheringToolPresentationRevisions.clear();
    this.fishingInteractionPresentationRevisions.clear();
    this.pendingGatherRewards.clear();
    this.gatheringRewardReservations.clear();

    // Clear tick-based respawn tracking
    this.respawnAtTick.clear();

    // FORESTRY: Clear resource timer tracking
    this.resourceTimers.clear();

    // RULES ACCURACY: Clear fishing spot movement timers
    this.fishingSpotMoveTimers.clear();

    // Clear all resource data
    this.resources.clear();
    this.resourceVariants.clear();
    this.manifestResourceIds.clear();
    this.playerSkills.clear();
    this.pendingFishingAreas.clear();

    // SECURITY: Clear rate limit tracking
    this.gatherRateLimits.clear();
    this.suspiciousPatterns.clear();

    // Dispose shared GPU resources (cached textures) used by fishing spot glow
    disposeFishingSpotTextures();

    // Call parent cleanup (automatically clears all tracked timers, intervals, and listeners)
    super.destroy();
  }
}
