/**
 * EmbeddedHyperiaService - Direct world integration for embedded agents
 *
 * Unlike the plugin-hyperia WebSocket service, this service runs in the same
 * process as the server and has direct access to the World instance.
 *
 * This eliminates network latency and simplifies the architecture for
 * agents that run on the server itself.
 */

import {
  COMBAT_SPELLS,
  EventType,
  INTERACTION_DISTANCE,
  SessionType,
  type AttackType,
  getDuelArenaConfig,
  getItem,
  getProcessingRequestOperationId,
  getGatheringRewardOperationIdForAttempt,
  getGroundItemPickupOperationIdForAttempt,
  generateGroundItemDropOperationId,
  processingDataProvider,
  DEFAULT_AVATAR_URL,
  isPositionInsideCombatArena,
  ALL_WORLD_AREAS,
  type BoneBurialReceipt,
  type FoodConsumptionReceipt,
  type StreamingDuelFoodObservationContext,
  parseStreamingDuelExecutorObservationContext,
  type StreamingDuelExecutorCommand,
  type StreamingDuelExecutorCommandOutcome,
  type StreamingDuelExecutorCommandReceipt,
  type StreamingDuelExecutorObservationContext,
  type StreamingDuelPrayerObservationContext,
  type StreamingDuelStyleObservationContext,
  type OwnedDuelPreparationPlanReceipt,
  type OwnedDuelPreparationPlanRequest,
  type OwnedDuelPreparationPlanRecoveryRequest,
  type ProcessingRequestEnvelope,
  type ProcessingSkill,
  type RecoverableProcessingRequest,
  type PrayerActionReceipt,
  type World,
} from "@hyperforge/shared";
import { createHash } from "node:crypto";
import type { ServerSocket } from "../shared/types/index.js";
import { validatePhysicalBankAccess } from "../shared/PhysicalBankAccess.js";
import {
  handleStoreBuy,
  handleStoreSell,
  type StoreTransactionRequest,
  type StoreTransactionResult,
} from "../systems/ServerNetwork/handlers/store.js";
import { errMsg } from "../shared/errMsg.js";
import {
  createAgentBankFailureReceipt,
  executeAuthoritativeAgentBankTransfer,
  getDuelPreparationBankId,
  openAuthoritativeAgentBank,
  type AgentBankActionReceipt,
  type AgentBankRetainedItem,
  type AgentBankTransferItem,
} from "./AuthoritativeAgentBanking.js";
import { getAuthoritativeRuntimeMobType } from "./runtimeEntityIdentity.js";
import type {
  IEmbeddedHyperiaService,
  EmbeddedGameState,
  EquipmentActionReceipt,
  NearbyEntityData,
  AgentQuestProgress,
  AgentQuestInfo,
  DuelPreparationPlanExecutionRequest,
} from "./types.js";

/** World map data shape matching plugin-hyperia WorldMapData */
interface EmbeddedWorldMapData {
  towns: Array<{
    id: string;
    name: string;
    position: { x: number; y: number; z: number };
    size: string;
    biome: string;
    buildings: Array<{ type: string }>;
  }>;
  pois: Array<{
    id: string;
    name: string;
    category: string;
    position: { x: number; y: number; z: number };
    biome: string;
  }>;
  resources: Array<{
    type: string;
    resourceId: string;
    position: { x: number; y: number; z: number };
    areaId: string;
  }>;
  stations: Array<{
    id: string;
    type: string;
    position: { x: number; y: number; z: number };
    areaId: string;
  }>;
  npcs: Array<{
    id: string;
    type: string;
    name?: string;
    position: { x: number; y: number; z: number };
    areaId: string;
  }>;
}

interface EmbeddedInteractionArrival {
  interactionRange: number;
  footprintWidth: number;
  footprintDepth: number;
}

// Distance threshold for "nearby" entities (in world units)
const NEARBY_DISTANCE = 50;
/** Pre-computed squared distance for comparison without Math.sqrt */
const NEARBY_DISTANCE_SQ = NEARBY_DISTANCE * NEARBY_DISTANCE;
/** How many ticks a cached getNearbyEntities result is valid (for game-tick callers) */
const NEARBY_CACHE_TTL_TICKS = 2;
/** Time-based cache TTL for agent bridge callers (ms) — entities don't move
 *  fast enough to warrant scanning more than once per second */
const NEARBY_CACHE_TTL_MS = 1000;
/** Bound an agent tick on the exact gravestone custody receipt. */
const GRAVESTONE_LOOT_RESULT_TIMEOUT_MS = 5_000;

/**
 * Shared entity snapshot across all EmbeddedHyperiaService instances.
 * Instead of each agent scanning all 300+ entities independently, we scan once
 * per second and share the raw data. Each agent then filters by its own position.
 */
interface EntitySnapshot {
  id: string;
  position: [number, number, number];
  data: Record<string, unknown>;
  entity: unknown; // raw entity ref for isDead/isAlive checks
}
const SHARED_SNAPSHOT_TTL_MS = 1000;

/** Per-world snapshot cache. Keyed by world reference to prevent cross-contamination
 *  when multiple World instances coexist (e.g. in tests). */
const _snapshotCache = new WeakMap<
  object,
  { snapshot: EntitySnapshot[]; time: number }
>();

function getSharedEntitySnapshot(
  world: {
    entities: { items: { entries: () => IterableIterator<[string, unknown]> } };
  },
  getPos: (entity: unknown) => [number, number, number] | null,
): EntitySnapshot[] {
  const now = Date.now();
  const cached = _snapshotCache.get(world);
  if (
    cached &&
    now - cached.time < SHARED_SNAPSHOT_TTL_MS &&
    cached.snapshot.length > 0
  ) {
    return cached.snapshot;
  }
  const snapshot: EntitySnapshot[] = [];
  for (const [id, entity] of world.entities.items.entries()) {
    const data = (entity as { data?: Record<string, unknown> }).data;
    if (!data) continue;
    const pos = getPos(entity);
    if (!pos) continue;
    snapshot.push({ id, position: pos, data, entity });
  }
  _snapshotCache.set(world, { snapshot, time: now });
  return snapshot;
}

function normalizeEquipmentItemId(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const normalized = String(value).trim();
    return normalized || undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = record.itemId ?? record.id;
  if (typeof direct === "string" || typeof direct === "number") {
    const normalized = String(direct).trim();
    if (normalized) return normalized;
  }
  return normalizeEquipmentItemId(record.item);
}

function extractEquippedWeaponId(equipment: unknown): string | undefined {
  if (Array.isArray(equipment)) {
    const weapon = equipment.find((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const record = entry as Record<string, unknown>;
      return record.slotType === "weapon" || record.slot === "weapon";
    });
    return normalizeEquipmentItemId(weapon);
  }
  if (!equipment || typeof equipment !== "object") return undefined;
  return normalizeEquipmentItemId(
    (equipment as Record<string, unknown>).weapon,
  );
}

// Event handler type
type EventHandler = (data: unknown) => void;

/**
 * Local chat message structure for agent context
 */
interface LocalChatMessage {
  from: string; // Sender name
  fromId: string; // Sender entity ID
  text: string; // Message content
  timestamp: number; // When received
  distance: number; // Distance from agent when received
}

/**
 * EmbeddedHyperiaService provides direct World access for embedded agents
 *
 * Key differences from WebSocket-based HyperiaService:
 * - No network connection needed (same process)
 * - Direct entity manipulation through World
 * - Direct event subscription through World events
 * - No packet encoding/decoding overhead
 */
export class EmbeddedHyperiaService implements IEmbeddedHyperiaService {
  private world: World;
  private characterId: string;
  private accountId: string;
  private name: string;
  private avatarUrl?: string;
  private eventHandlers: Map<string, EventHandler[]> = new Map();
  private worldListeners: Array<{
    event: string;
    fn: (...args: unknown[]) => void;
  }> = [];
  private playerEntityId: string | null = null;
  /** Authoritative bank session; never survives despawn or duel entry. */
  private activeBankId: string | null = null;
  /** Present only for a durable private, pre-market bank capability. */
  private activeBankPreparationId: string | null = null;
  /**
   * Exact private preparation that owns this player's combat-admission fence.
   * The fence outlives bank readiness and is released only when that exact
   * preparation freezes or terminates.
   */
  private activeDuelPreparationCombatFenceId: string | null = null;
  /**
   * Monotonic process-local fence for asynchronous bank-open receipts. A
   * terminal preparation event or a newer open can arrive while PostgreSQL is
   * returning the older receipt; only the newest still-live request may
   * install a bank capability or publish BANK_OPEN.
   */
  private bankOpenRevision = 0;
  private pendingDuelPreparationBankOpen: {
    preparationId: string;
    revision: number;
  } | null = null;
  private isActive: boolean = false;
  /** Cancels the single authoritative processing completion wait on shutdown. */
  private cancelPendingProcessingAction: (() => void) | null = null;
  /** Cancels the single exact first-reward gathering wait on shutdown. */
  private cancelPendingGatherAction: (() => void) | null = null;
  /**
   * One serialized authority lane prevents concurrent controller actions from
   * overtaking an executor command whose durable outcome is still ambiguous.
   */
  private streamingDuelExecutorCommandTail: Promise<void> = Promise.resolve();
  /** Last staged command without a confirmed durable outcome in this process. */
  private pendingStreamingDuelExecutorCommand: StreamingDuelExecutorCommandReceipt | null =
    null;
  /** Exact reason returned by the most recent authoritative style request. */
  private lastStyleChangeFailureReason: string | null = null;
  private lastGatherFailureReason: string | null = null;
  private static readonly PROCESSING_COMPLETION_TIMEOUT_MS = 30_000;
  private static readonly PROCESSING_STATUS_RETRY_MS = 5_000;
  /** When set, all executeMove targets are clamped to this XZ rectangle. */
  private _arenaBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  } | null = null;
  /**
   * When false, the AgentBehaviorTicker skips this agent's autonomous tick.
   * Set to false while the agent is in the duel arena so it doesn't wander
   * off to do quests or explore between DuelCombatAI ticks.
   */
  private _autonomousEnabled: boolean = true;
  /**
   * Durable competitive snapshots fence ordinary behavior by preparation ID
   * until the active scheduler has recovered and retired each exact row.
   */
  private readonly competitiveRecoveryCustodyHolds = new Set<string>();
  /** Set after we re-emit PLAYER_REGISTERED to bootstrap quest state. */
  private _questStateBootstrapEmitted: boolean = false;
  /** Reusable buffer for getNearbyEntities to reduce per-tick allocations. */
  private nearbyBuffer: NearbyEntityData[] = [];

  /** Cached getNearbyEntities result to avoid full world scan every tick */
  private _nearbyCache: NearbyEntityData[] = [];
  private _nearbyCacheTick = -1;
  private _nearbyCacheTime = 0;

  /** Double-buffer for getNearbyEntities to avoid slice() allocations */
  private _nearbyBufferA: NearbyEntityData[] = [];
  private _nearbyBufferB: NearbyEntityData[] = [];
  private _useBufferA = true;

  /** Pool of reusable NearbyEntityData objects to avoid per-entity allocations */
  private _nearbyEntityPool: NearbyEntityData[] = [];
  private _nearbyEntityPoolIndex = 0;

  /** Cached getAllNPCPositions result — NPCs don't move, cache for 10s */
  private _npcPositionsCache: Array<{
    id: string;
    name: string;
    npcId: string;
    position: [number, number, number];
  }> = [];
  private _npcPositionsCacheTime = 0;
  private static readonly NPC_CACHE_TTL_MS = 10_000;

  /** Cached getGameState result to avoid per-tick allocations */
  private _gameStateCache: EmbeddedGameState | null = null;
  private _gameStateCacheTick = -1;

  /** Cached inventory/equipment to avoid repeated system lookups */
  private _inventoryCache: Array<{
    slot: number;
    itemId: string;
    quantity: number;
  }> = [];
  private _inventoryCacheTick = -1;
  private _equipmentCache: Record<string, string | null> = {};
  private _equipmentCacheTick = -1;

  /** Local chat message buffer - stores recent messages from nearby entities */
  private localChatBuffer: LocalChatMessage[] = [];
  private static readonly LOCAL_CHAT_BUFFER_SIZE = 10;
  private static readonly LOCAL_CHAT_RADIUS = NEARBY_DISTANCE; // 50m

  constructor(
    world: World,
    characterId: string,
    accountId: string,
    name: string,
    avatarUrl?: string,
  ) {
    this.world = world;
    this.characterId = characterId;
    this.accountId = accountId;
    this.name = name;
    this.avatarUrl = avatarUrl;
  }

  /**
   * Attach the direct authoritative action facade to a player entity that is
   * owned by a separate authenticated socket. Competitive preparation and the
   * deterministic duel controller can then use the same server-side receipts
   * as embedded agents without spawning, replacing, or later removing that
   * socket-owned entity.
   */
  attachExistingPlayer(): boolean {
    if (this.isActive) return this.playerEntityId === this.characterId;
    if (!this.world.entities.get(this.characterId)) return false;
    this.playerEntityId = this.characterId;
    this.isActive = true;
    this.subscribeToWorldEvents();
    return true;
  }

  /** Release an attached facade without changing socket-owned world state. */
  detachExistingPlayer(): void {
    this.releaseActiveDuelPreparationCombatFence();
    this.isActive = false;
    this.bankOpenRevision += 1;
    this.pendingDuelPreparationBankOpen = null;
    this.activeBankId = null;
    this.activeBankPreparationId = null;
    this.cancelPendingProcessingAction?.();
    this.cancelPendingProcessingAction = null;
    this.cancelPendingGatherAction?.();
    this.cancelPendingGatherAction = null;
    for (const { event, fn } of this.worldListeners) {
      this.world.off(event, fn);
    }
    this.worldListeners = [];
    this.playerEntityId = null;
    this._nearbyCache = [];
    this._nearbyCacheTick = -1;
    this.localChatBuffer = [];
    this.eventHandlers.clear();
  }

  /**
   * Initialize the service and spawn the agent's player entity
   */
  async initialize(): Promise<void> {
    const traceEnabled = process.env.EMBEDDED_AGENT_INIT_TRACE === "true";
    const startTime = Date.now();
    const trace = (step: string) => {
      if (!traceEnabled) return;
      const elapsed = Date.now() - startTime;
      console.debug(
        `[EmbeddedHyperiaService][Trace] ${this.characterId} ${step} (+${elapsed}ms)`,
      );
    };

    // Check if player entity already exists
    const existingEntity = this.world.entities.get(this.characterId);
    if (existingEntity) {
      this.playerEntityId = this.characterId;
      this.isActive = true;
      this.subscribeToWorldEvents();
      // Emit PLAYER_REGISTERED so QuestSystem (and other systems) load state
      // for this agent. The normal entities.add() path emits this, but when
      // the entity already exists we skip that path entirely.
      this.emitDualChannel("player:registered", {
        playerId: this.characterId,
      });
      await this.recoverDurableProcessingRequest();
      return;
    }

    // Load character data from database
    const databaseSystem = this.world.getSystem("database") as
      | {
          getPlayerAsync: (characterId: string) => Promise<{
            name?: string;
            avatar?: string | null;
            wallet?: string | null;
            positionX?: number;
            positionY?: number;
            positionZ?: number;
            attackLevel?: number;
            attackXp?: number;
            strengthLevel?: number;
            strengthXp?: number;
            defenseLevel?: number;
            defenseXp?: number;
            constitutionLevel?: number;
            constitutionXp?: number;
            rangedLevel?: number;
            rangedXp?: number;
            woodcuttingLevel?: number;
            woodcuttingXp?: number;
            miningLevel?: number;
            miningXp?: number;
            fishingLevel?: number;
            fishingXp?: number;
            firemakingLevel?: number;
            firemakingXp?: number;
            cookingLevel?: number;
            cookingXp?: number;
            smithingLevel?: number;
            smithingXp?: number;
            magicLevel?: number;
            magicXp?: number;
            prayerLevel?: number;
            prayerXp?: number;
            selectedSpell?: string | null;
            coins?: number;
          } | null>;
          recoverPendingAmmunitionShotOperationsAsync?: (
            characterId: string,
          ) => Promise<unknown[]>;
          recoverPendingProjectileRuneCostOperationsAsync?: (
            characterId: string,
          ) => Promise<unknown[]>;
        }
      | undefined;

    if (!databaseSystem) {
      throw new Error("DatabaseSystem not available");
    }
    if (databaseSystem.recoverPendingProjectileRuneCostOperationsAsync) {
      await databaseSystem.recoverPendingProjectileRuneCostOperationsAsync(
        this.characterId,
      );
    }
    if (databaseSystem.recoverPendingAmmunitionShotOperationsAsync) {
      await databaseSystem.recoverPendingAmmunitionShotOperationsAsync(
        this.characterId,
      );
    }

    // Stream-mode agents default to a DB-free startup path to avoid blocking
    // stream health on remote database latency/transient stalls.
    const skipPersistentLoad =
      this.shouldUseStreamingSpawnPosition() &&
      process.env.STREAMING_AGENT_SKIP_DB_LOAD !== "false";

    // Get saved player data (position, skills) when persistence is enabled.
    // Cast to include magic/prayer skills which may not be in the older type definition.
    let savedData:
      | (Awaited<ReturnType<typeof databaseSystem.getPlayerAsync>> & {
          magicLevel?: number;
          magicXp?: number;
          prayerLevel?: number;
          prayerXp?: number;
          selectedSpell?: string | null;
        })
      | null = null;
    if (!skipPersistentLoad) {
      trace("before getPlayerAsync");
      savedData = (await databaseSystem.getPlayerAsync(this.characterId)) as
        | (Awaited<ReturnType<typeof databaseSystem.getPlayerAsync>> & {
            magicLevel?: number;
            magicXp?: number;
            prayerLevel?: number;
            prayerXp?: number;
            selectedSpell?: string | null;
          })
        | null;
      trace("after getPlayerAsync");

      if (!savedData) {
        throw new Error(
          `Character ${this.characterId} not found for account ${this.accountId}`,
        );
      }
    } else {
      trace("skipping getPlayerAsync (STREAMING_AGENT_SKIP_DB_LOAD fast path)");
    }

    // Determine spawn position
    const hasSavedPosition = savedData?.positionX !== undefined;
    let position: [number, number, number];
    if (this.shouldUseStreamingSpawnPosition()) {
      position = this.getStreamingAgentSpawnPosition();
    } else if (hasSavedPosition) {
      const playerPosition = savedData as NonNullable<typeof savedData>;
      position = [
        playerPosition.positionX ?? 0,
        playerPosition.positionY ?? 10,
        playerPosition.positionZ ?? 0,
      ];
    } else {
      position = this.getStreamingAgentSpawnPosition();
      console.warn(
        `[EmbeddedHyperiaService] No saved spawn for ${this.characterId}; using dynamic fallback spawn`,
      );
    }

    // A process loss or disconnect can persist the last arena coordinate after
    // the scheduler has already retired its ownership. Never respawn an
    // embedded agent inside a combat ring without a new authoritative cycle.
    if (isPositionInsideCombatArena(position[0], position[2])) {
      position = this.getStreamingAgentSpawnPosition();
    }

    // Snap agent spawns to terrain height for consistent grounded placement.
    trace("before groundSpawnPosition");
    position = this.groundSpawnPosition(position);
    trace("after groundSpawnPosition");

    // Load skills from saved data
    const skills = {
      attack: {
        level: savedData?.attackLevel || 1,
        xp: savedData?.attackXp || 0,
      },
      strength: {
        level: savedData?.strengthLevel || 1,
        xp: savedData?.strengthXp || 0,
      },
      defense: {
        level: savedData?.defenseLevel || 1,
        xp: savedData?.defenseXp || 0,
      },
      constitution: {
        level: savedData?.constitutionLevel || 10,
        xp: savedData?.constitutionXp || 0,
      },
      ranged: {
        level: savedData?.rangedLevel || 1,
        xp: savedData?.rangedXp || 0,
      },
      magic: { level: savedData?.magicLevel || 1, xp: savedData?.magicXp || 0 },
      prayer: {
        level: savedData?.prayerLevel || 1,
        xp: savedData?.prayerXp || 0,
      },
      woodcutting: {
        level: savedData?.woodcuttingLevel || 1,
        xp: savedData?.woodcuttingXp || 0,
      },
      mining: {
        level: savedData?.miningLevel || 1,
        xp: savedData?.miningXp || 0,
      },
      fishing: {
        level: savedData?.fishingLevel || 1,
        xp: savedData?.fishingXp || 0,
      },
      firemaking: {
        level: savedData?.firemakingLevel || 1,
        xp: savedData?.firemakingXp || 0,
      },
      cooking: {
        level: savedData?.cookingLevel || 1,
        xp: savedData?.cookingXp || 0,
      },
      smithing: {
        level: savedData?.smithingLevel || 1,
        xp: savedData?.smithingXp || 0,
      },
    };

    // Calculate health from constitution
    const health = skills.constitution.level;

    const addedEntity = this.world.entities.add
      ? this.world.entities.add({
          id: this.characterId,
          type: "player",
          position,
          quaternion: [0, 0, 0, 1],
          owner: `embedded-agent:${this.characterId}`,
          userId: this.accountId,
          name: savedData?.name || this.name,
          health,
          maxHealth: health,
          avatar:
            savedData?.avatar ||
            this.avatarUrl ||
            this.world.settings?.avatar?.url ||
            DEFAULT_AVATAR_URL,
          wallet: savedData?.wallet || undefined,
          roles: [],
          skills,
          selectedSpell: savedData?.selectedSpell ?? null,
          autoRetaliate: true,
          isLoading: false, // Embedded agents start ready
          isAgent: true, // Mark as AI agent
        })
      : undefined;

    if (!addedEntity) {
      throw new Error("Failed to spawn player entity");
    }

    this.playerEntityId = this.characterId;
    this.isActive = true;

    // Broadcast entityAdded to all connected clients so they see the agent
    const networkSystem = this.world.getSystem("network") as
      { send?: (name: string, data: unknown) => void } | undefined;
    if (networkSystem?.send) {
      const serialized =
        typeof (addedEntity as { serialize?: () => unknown }).serialize ===
        "function"
          ? (addedEntity as { serialize: () => unknown }).serialize()
          : (addedEntity as { data?: unknown }).data;
      networkSystem.send("entityAdded", serialized);
    }

    // Emit player joined event
    this.world.emit(EventType.PLAYER_JOINED, {
      playerId: this.characterId,
      player:
        addedEntity as unknown as import("@hyperforge/shared").PlayerLocal,
      isEmbeddedAgent: true,
    });

    // Subscribe to world events
    this.subscribeToWorldEvents();

    // Explicitly emit PLAYER_REGISTERED on both channels so QuestSystem,
    // CoinPouchSystem, etc. load this agent's persisted state from the DB.
    // Entities.addEntity() already emits this via emitTypedEvent, but we
    // re-emit to guarantee it reaches EventBus subscribers even if there
    // was a race during entity creation.
    this.emitDualChannel("player:registered", {
      playerId: this.characterId,
    });
    await this.recoverDurableProcessingRequest();
  }

  /**
   * Subscribe to world events and forward to registered handlers
   */
  private subscribeToWorldEvents(): void {
    // Guard: prevent duplicate subscriptions if initialize() is called
    // multiple times without stop() in between.
    if (this.worldListeners.length > 0) {
      return;
    }

    const track = (event: string, fn: (...args: unknown[]) => void) => {
      this.world.on(event, fn);
      this.worldListeners.push({ event, fn });
    };

    // Subscribe to entity events
    track(EventType.ENTITY_CREATED, (data) => {
      this.broadcastEvent("ENTITY_JOINED", data);
    });

    track(EventType.ENTITY_MODIFIED, (data) => {
      this.broadcastEvent("ENTITY_UPDATED", data);
    });

    track(EventType.ENTITY_REMOVE, (data) => {
      this.broadcastEvent("ENTITY_LEFT", data);
    });

    // Subscribe to inventory events
    track(EventType.INVENTORY_UPDATED, (data) => {
      const eventData = data as { playerId?: string };
      if (eventData.playerId === this.characterId) {
        this.broadcastEvent("INVENTORY_UPDATED", data);
      }
    });

    // Subscribe to skills events
    track(EventType.SKILLS_UPDATED, (data) => {
      const eventData = data as { playerId?: string };
      if (eventData.playerId === this.characterId) {
        this.broadcastEvent("SKILLS_UPDATED", data);
      }
    });

    // Subscribe to chat events - filter by proximity and add to local buffer
    track(EventType.CHAT_MESSAGE, (data) => {
      this.handleChatMessage(data);
      this.broadcastEvent("CHAT_MESSAGE", data);
    });
  }

  /**
   * Handle incoming chat message - filter by proximity and add to local buffer
   */
  private handleChatMessage(data: unknown): void {
    const msg = data as {
      playerId?: string;
      fromId?: string;
      text?: string;
      body?: string;
      from?: string;
    };

    const senderId = msg.playerId || msg.fromId;
    const messageText = msg.text || msg.body;
    const senderName = msg.from || "Unknown";

    // Skip if no sender ID, message text, or if it's our own message
    if (!senderId || !messageText || senderId === this.characterId) {
      return;
    }

    // Get sender position
    const senderEntity = this.world.entities.get(senderId);
    if (!senderEntity) {
      return;
    }

    const senderPos = this.getEntityPosition(senderEntity);
    if (!senderPos) {
      return;
    }

    // Get our position
    const player = this.playerEntityId
      ? this.world.entities.get(this.playerEntityId)
      : null;
    if (!player) {
      return;
    }

    const playerPos = this.getEntityPosition(player);
    if (!playerPos) {
      return;
    }

    // Calculate distance
    const dx = senderPos[0] - playerPos[0];
    const dz = senderPos[2] - playerPos[2];
    const distance = Math.sqrt(dx * dx + dz * dz);

    // Only track messages within local chat radius (50m)
    if (distance > EmbeddedHyperiaService.LOCAL_CHAT_RADIUS) {
      return;
    }

    // Add to buffer (newest first)
    this.localChatBuffer.unshift({
      from: senderName,
      fromId: senderId,
      text: messageText,
      timestamp: Date.now(),
      distance,
    });

    // Trim buffer to max size
    if (
      this.localChatBuffer.length >
      EmbeddedHyperiaService.LOCAL_CHAT_BUFFER_SIZE
    ) {
      this.localChatBuffer.length =
        EmbeddedHyperiaService.LOCAL_CHAT_BUFFER_SIZE;
    }
  }

  /**
   * Broadcast event to registered handlers
   */
  private broadcastEvent(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (err) {
          console.error(
            `[EmbeddedHyperiaService] Event handler error for ${event}:`,
            err,
          );
        }
      });
    }
  }

  /**
   * Stop the service and remove the player entity
   */
  async stop(): Promise<void> {
    this.releaseActiveDuelPreparationCombatFence();
    this.isActive = false;
    this.bankOpenRevision += 1;
    this.pendingDuelPreparationBankOpen = null;
    this.activeBankId = null;
    this.activeBankPreparationId = null;
    this.cancelPendingProcessingAction?.();
    this.cancelPendingProcessingAction = null;
    this.cancelPendingGatherAction?.();
    this.cancelPendingGatherAction = null;

    // Remove world event listeners to prevent leaks on agent restart
    for (const { event, fn } of this.worldListeners) {
      this.world.off(event, fn);
    }
    this.worldListeners = [];

    // Remove player entity and notify clients
    if (this.playerEntityId && this.world.entities?.remove) {
      const networkSystem = this.world.getSystem("network") as
        { send?: (name: string, data: unknown) => void } | undefined;
      if (networkSystem?.send) {
        networkSystem.send("entityRemoved", this.playerEntityId);
      }

      this.world.entities.remove(this.playerEntityId);
      this.world.emit(EventType.PLAYER_LEFT, {
        playerId: this.playerEntityId,
      });
    }

    this.playerEntityId = null;

    // Invalidate nearby entities cache
    this._nearbyCache = [];
    this._nearbyCacheTick = -1;

    // Clear local chat buffer
    this.localChatBuffer = [];

    this.eventHandlers.clear();
  }

  // ============================================================================
  // IEmbeddedHyperiaService Implementation
  // ============================================================================

  getWorld(): World {
    return this.world;
  }

  /**
   * Update the authoritative display name used by future agent output and by
   * the live player entity. Character persistence is owned by AgentManager.
   */
  setDisplayName(displayName: string): void {
    const normalizedName = displayName.trim();
    if (!normalizedName) {
      throw new Error("Embedded agent display name cannot be empty");
    }

    this.name = normalizedName;

    if (!this.playerEntityId) {
      return;
    }

    const entity = this.world.entities.get(this.playerEntityId) as
      | {
          data?: Record<string, unknown>;
          modify?: (changes: { name: string }) => void;
          markNetworkDirty?: () => void;
        }
      | undefined;
    if (!entity) {
      return;
    }

    if (entity.data) {
      entity.data.name = normalizedName;
    }
    entity.modify?.({ name: normalizedName });
    entity.markNetworkDirty?.();
    this.world.emit(EventType.ENTITY_MODIFIED, {
      id: this.playerEntityId,
      changes: { name: normalizedName },
    });
  }

  invalidateNearbyEntityCache(): void {
    this._nearbyCacheTick = -1;
    this._nearbyCacheTime = 0;
    _snapshotCache.delete(this.world as unknown as object);
  }

  getGameState(): EmbeddedGameState | null {
    if (!this.playerEntityId || !this.isActive) {
      return null;
    }

    // Return cached result if same tick (avoids per-tick allocations)
    const currentTick = this.world.currentTick ?? 0;
    if (currentTick === this._gameStateCacheTick && this._gameStateCache) {
      return this._gameStateCache;
    }

    const player = this.world.entities.get(this.playerEntityId);
    if (!player) {
      return null;
    }

    const data = player.data as Record<string, unknown>;
    const position = this.getEntityPosition(player);
    const skills = (data.skills || {}) as Record<
      string,
      { level: number; xp: number }
    >;
    const inventory = this.getInventoryItems();
    const equippedRaw = this.getEquippedItems();
    const liveEquipment = (
      this.world.getSystem("equipment") as {
        getPlayerEquipment?: (
          playerId: string,
        ) => Record<
          string,
          { itemId?: string | number | null; quantity?: number } | null
        >;
      } | null
    )?.getPlayerEquipment?.(this.playerEntityId);

    // Reuse equipment object if possible
    const equipment = this._gameStateCache?.equipment || {};
    // Clear old keys
    for (const key in equipment) {
      delete equipment[key];
    }
    for (const [slot, itemId] of Object.entries(equippedRaw)) {
      if (itemId) {
        const rawQuantity = Number(liveEquipment?.[slot]?.quantity ?? 1);
        equipment[slot] = {
          itemId,
          quantity:
            Number.isSafeInteger(rawQuantity) && rawQuantity > 0
              ? rawQuantity
              : 1,
        };
      }
    }

    // Reuse or create game state object
    if (!this._gameStateCache) {
      this._gameStateCache = {
        playerId: this.playerEntityId,
        position,
        health: (data.health as number) || 10,
        maxHealth: (data.maxHealth as number) || 10,
        alive: data.alive !== false,
        skills,
        inventory,
        equipment,
        nearbyEntities: this.getNearbyEntities(),
        inCombat: !!(data.inCombat || data.combatTarget),
        currentTarget: (data.combatTarget as string) || null,
        selectedSpell:
          typeof data.selectedSpell === "string" ? data.selectedSpell : null,
        activePrayers: (data.activePrayers as string[]) || [],
        prayerPointUnits: Number(data.prayerPointUnits ?? 0),
        prayerPoints: Number(data.prayerPoints ?? 0),
        prayerMaxPoints: Number(data.prayerMaxPoints ?? 1),
      };
    } else {
      // Update existing cached object in-place
      this._gameStateCache.playerId = this.playerEntityId;
      this._gameStateCache.position = position;
      this._gameStateCache.health = (data.health as number) || 10;
      this._gameStateCache.maxHealth = (data.maxHealth as number) || 10;
      this._gameStateCache.alive = data.alive !== false;
      this._gameStateCache.skills = skills;
      this._gameStateCache.inventory = inventory;
      this._gameStateCache.equipment = equipment;
      this._gameStateCache.nearbyEntities = this.getNearbyEntities();
      this._gameStateCache.inCombat = !!(data.inCombat || data.combatTarget);
      this._gameStateCache.currentTarget =
        (data.combatTarget as string) || null;
      this._gameStateCache.selectedSpell =
        typeof data.selectedSpell === "string" ? data.selectedSpell : null;
      this._gameStateCache.activePrayers =
        (data.activePrayers as string[]) || [];
      this._gameStateCache.prayerPointUnits = Number(
        data.prayerPointUnits ?? 0,
      );
      this._gameStateCache.prayerPoints = Number(data.prayerPoints ?? 0);
      this._gameStateCache.prayerMaxPoints = Number(data.prayerMaxPoints ?? 1);
    }

    this._gameStateCacheTick = currentTick;
    return this._gameStateCache;
  }

  /**
   * Facing yaw for dashboard scripted intents (attack/gather target cone).
   * Prefer live entity node euler Y; fall back to serialized quaternion in data.
   */
  getPlayerYaw(): number | null {
    if (!this.playerEntityId || !this.isActive) {
      return null;
    }
    const player = this.world.entities.get(this.playerEntityId);
    if (!player) {
      return null;
    }

    const node = (
      player as {
        node?: { rotation?: { y?: number } };
      }
    ).node;
    const eulerY = node?.rotation?.y;
    if (typeof eulerY === "number" && Number.isFinite(eulerY)) {
      return eulerY;
    }

    const quat = (player as { data?: { quaternion?: number[] } }).data
      ?.quaternion;
    if (
      Array.isArray(quat) &&
      quat.length >= 4 &&
      quat.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      const [x, y, z, w] = quat as [number, number, number, number];
      // Y-axis yaw from quaternion (Y-up, consistent with Three.js body yaw)
      return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
    }

    return null;
  }

  // ============================================================================
  // Local Chat Methods
  // ============================================================================

  /**
   * Get recent chat messages from nearby players/agents
   * Returns messages within 50m, newest first, up to 10 messages
   */
  getLocalChatMessages(): LocalChatMessage[] {
    return this.localChatBuffer;
  }

  /**
   * Owner message from POST /api/agents/:id/message (dashboard / viewport).
   * Cannot rely on CHAT_MESSAGE alone: Chat emits playerId = Privy account id,
   * which is not a world entity id, so handleChatMessage drops it before the buffer.
   */
  ingestOwnerDashboardMessage(text: string, ownerAccountId: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.isActive) {
      return;
    }
    this.localChatBuffer.unshift({
      from: "Dashboard",
      fromId: ownerAccountId,
      text: trimmed,
      timestamp: Date.now(),
      distance: 0,
    });
    if (
      this.localChatBuffer.length >
      EmbeddedHyperiaService.LOCAL_CHAT_BUFFER_SIZE
    ) {
      this.localChatBuffer.length =
        EmbeddedHyperiaService.LOCAL_CHAT_BUFFER_SIZE;
    }
  }

  /**
   * Send a chat message from this agent
   * Message will be broadcast to all clients and appear as overhead bubble
   * @returns The chat message id (for dashboard / API callers)
   */
  async sendChatMessage(text: string): Promise<string> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }
    // Validate message
    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new Error("Chat message cannot be empty");
    }

    // Enforce length limit (255 chars like player chat)
    const finalText =
      trimmedText.length > 255 ? trimmedText.slice(0, 255) : trimmedText;

    // Get player entity for name
    const player = this.world.entities.get(this.playerEntityId);
    const playerData = player?.data as { name?: string } | undefined;
    const playerName = playerData?.name || this.name;

    // Create chat message
    const chatMessage = {
      id: `${this.playerEntityId}-${Date.now()}`,
      from: playerName,
      fromId: this.playerEntityId,
      body: finalText,
      text: finalText,
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
      type: "chat",
      userName: playerName,
      userId: this.playerEntityId,
    };

    // Add to world chat system (triggers overhead bubble + broadcast)
    const chatSystem = this.world.chat as {
      add?: (msg: unknown, broadcast?: boolean) => void;
    };
    if (chatSystem?.add) {
      chatSystem.add(chatMessage, true);
    } else {
      // Fallback: emit chat event directly
      this.world.emit(EventType.CHAT_MESSAGE, {
        playerId: this.playerEntityId,
        text: finalText,
      });

      // Broadcast via network
      const networkSystem = this.world.getSystem("network") as
        { send?: (name: string, data: unknown) => void } | undefined;
      if (networkSystem?.send) {
        networkSystem.send("chatAdded", chatMessage);
      }
    }

    return chatMessage.id;
  }

  getNearbyEntities(): NearbyEntityData[] {
    if (!this.playerEntityId || !this.isActive) {
      return [];
    }

    // Return cached result if still fresh (avoids full world scan every tick)
    const currentTick = this.world.currentTick ?? 0;
    const now = Date.now();
    if (
      this._nearbyCacheTick >= 0 &&
      (currentTick - this._nearbyCacheTick < NEARBY_CACHE_TTL_TICKS ||
        now - this._nearbyCacheTime < NEARBY_CACHE_TTL_MS)
    ) {
      return this._nearbyCache;
    }

    const player = this.world.entities.get(this.playerEntityId);
    if (!player) {
      return [];
    }

    const playerPos = this.getEntityPosition(player);
    if (!playerPos) {
      return [];
    }

    // Use double-buffering: write to inactive buffer, then swap
    const nearby = this._useBufferA ? this._nearbyBufferA : this._nearbyBufferB;
    nearby.length = 0;
    this._nearbyEntityPoolIndex = 0;

    // Use shared entity snapshot (scanned once per second across ALL agent instances)
    // instead of each agent independently iterating all 300+ world entities
    const snapshot = getSharedEntitySnapshot(
      this.world as unknown as Parameters<typeof getSharedEntitySnapshot>[0],
      (e) =>
        this.getEntityPosition(
          e as Parameters<typeof this.getEntityPosition>[0],
        ),
    );
    const equipmentSystem = this.world.getSystem("equipment") as {
      getPlayerEquipment?: (playerId: string) => unknown;
    } | null;

    for (const entry of snapshot) {
      if (entry.id === this.playerEntityId) continue; // Skip self

      // Distance-squared comparison (avoids expensive Math.sqrt per entity)
      const dx = entry.position[0] - playerPos[0];
      const dy = entry.position[1] - playerPos[1];
      const dz = entry.position[2] - playerPos[2];
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > NEARBY_DISTANCE_SQ) continue;

      // Only compute sqrt for entities that pass the filter
      const distance = Math.sqrt(distSq);

      const entityData = entry.data;

      // Determine entity type
      const entityType = this.categorizeEntity(entityData);
      const resourceConfig =
        entityType === "resource"
          ? (
              entry.entity as {
                config?: {
                  resourceId?: string;
                  resourceType?: string;
                  requiredLevel?: number;
                  levelRequired?: number;
                };
              }
            ).config
          : undefined;

      // Skip dead mobs — prevents agents from attacking corpses
      if (entityType === "mob") {
        const ent = entry.entity as {
          isDead?: () => boolean;
          isAlive?: () => boolean;
        };
        if (
          (typeof ent.isDead === "function" && ent.isDead()) ||
          (typeof ent.isAlive === "function" && !ent.isAlive()) ||
          entityData.alive === false ||
          entityData.dead === true ||
          entityData.health === 0 ||
          entityData.isDead === true
        ) {
          continue;
        }
      }

      // PlayerEntity stores full Item objects (`id`) while equipment slot views
      // use `itemId`, and durable snapshots are arrays keyed by `slotType`.
      // Normalize all authoritative shapes so combat policy can observe the
      // opponent's actual weapon instead of silently treating it as unknown.
      const equippedWeapon =
        entityType === "player"
          ? (extractEquippedWeaponId(
              equipmentSystem?.getPlayerEquipment?.(entry.id),
            ) ?? extractEquippedWeaponId(entityData.equipment))
          : undefined;

      // Reuse object from pool or create new one (pool grows once, then reuses)
      let entityObj = this._nearbyEntityPool[this._nearbyEntityPoolIndex];
      if (!entityObj) {
        entityObj = {} as NearbyEntityData;
        this._nearbyEntityPool[this._nearbyEntityPoolIndex] = entityObj;
      }
      this._nearbyEntityPoolIndex++;

      // Update object in-place
      entityObj.id = entry.id;
      entityObj.name = (entityData.name as string) || entry.id;
      entityObj.type = entityType;
      entityObj.position = entry.position;
      entityObj.distance = distance;
      entityObj.health = entityData.health as number | undefined;
      entityObj.maxHealth = entityData.maxHealth as number | undefined;
      entityObj.level = entityData.level as number | undefined;
      entityObj.mobType =
        entityType === "mob"
          ? getAuthoritativeRuntimeMobType(entry.entity, entityData)
          : undefined;
      entityObj.itemId = entityData.itemId as string | undefined;
      entityObj.resourceId =
        typeof entityData.resourceId === "string"
          ? entityData.resourceId
          : resourceConfig?.resourceId;
      entityObj.resourceType =
        typeof entityData.resourceType === "string"
          ? entityData.resourceType
          : resourceConfig?.resourceType;
      entityObj.requiredLevel =
        typeof entityData.requiredLevel === "number"
          ? entityData.requiredLevel
          : typeof entityData.levelRequired === "number"
            ? entityData.levelRequired
            : typeof resourceConfig?.requiredLevel === "number"
              ? resourceConfig.requiredLevel
              : typeof resourceConfig?.levelRequired === "number"
                ? resourceConfig.levelRequired
                : undefined;
      entityObj.equippedWeapon = equippedWeapon;

      nearby.push(entityObj);
    }

    // Sort by distance
    nearby.sort((a, b) => a.distance - b.distance);

    // Swap buffers - the inactive buffer becomes the cache
    this._useBufferA = !this._useBufferA;
    this._nearbyCache = nearby;
    this._nearbyCacheTick = currentTick;
    this._nearbyCacheTime = Date.now();

    return this._nearbyCache;
  }

  /** Emit a processing event via EventBus (which ProcessingSystem subscribes to) with EventEmitter fallback */
  private emitProcessingEvent(
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    if (this.world.$eventBus) {
      this.world.$eventBus.emitEvent(eventType, data, "EmbeddedHyperiaService");
    } else {
      this.world.emit(eventType, data);
    }
  }

  /**
   * Submit one processing action and wait for its authoritative post-receipt
   * completion event. Exact authority-progress events reset the inactivity
   * watchdog so a safely reconciling action cannot be mistaken for failure.
   */
  private waitForProcessingTerminalAcknowledgementRetry(
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted === true) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let finished = false;
      const finish = (elapsed: boolean): void => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        resolve(elapsed);
      };
      const onAbort = (): void => finish(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(
        () => finish(true),
        EmbeddedHyperiaService.PROCESSING_STATUS_RETRY_MS,
      );
      (timeout as unknown as { unref?: () => void }).unref?.();
    });
  }

  private async acknowledgeProcessingTerminal(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const playerId = this.playerEntityId;
    if (!playerId) return false;
    const database = this.world.getSystem("database") as
      | {
          acknowledgeProcessingRequestAsync?: (
            playerId: string,
            requestId: string,
          ) => Promise<boolean>;
        }
      | undefined;
    if (!database?.acknowledgeProcessingRequestAsync) return false;
    const canRetry = (): boolean => this.isActive && signal?.aborted !== true;
    while (canRetry()) {
      try {
        return (
          (await database.acknowledgeProcessingRequestAsync(
            playerId,
            requestId,
          )) === true
        );
      } catch {
        if (!canRetry()) return false;
        if (
          !(await this.waitForProcessingTerminalAcknowledgementRetry(signal))
        ) {
          return false;
        }
      }
    }
    return false;
  }

  private resumeRecoverableProcessingRequest(
    request: RecoverableProcessingRequest,
  ): Promise<boolean> {
    const playerId = this.playerEntityId;
    if (!playerId) return Promise.resolve(false);
    const envelope = request.envelope;
    switch (envelope.skill) {
      case "firemaking":
        return this.awaitProcessingCompletion(
          EventType.FIRE_CREATED,
          (data) => data.playerId === playerId,
          (data) => typeof data.fireId === "string" && data.fireId.length > 0,
          envelope,
          (requestId) =>
            this.emitProcessingEvent(EventType.PROCESSING_FIREMAKING_REQUEST, {
              playerId,
              logsId: envelope.logsId,
              logsSlot: envelope.logsSlot,
              tinderboxSlot: envelope.tinderboxSlot,
              requestId,
            }),
          request.requestId,
        );
      case "cooking":
        return this.awaitProcessingCompletion(
          EventType.COOKING_COMPLETED,
          (data) =>
            data.playerId === playerId && data.rawItemId === envelope.rawFoodId,
          (data) =>
            typeof data.resultItemId === "string" &&
            data.resultItemId.length > 0,
          envelope,
          (requestId) =>
            this.emitProcessingEvent(EventType.PROCESSING_COOKING_REQUEST, {
              playerId,
              fishSlot: envelope.rawFoodSlot,
              ...(envelope.sourceType === "range"
                ? { rangeId: envelope.sourceId }
                : { fireId: envelope.sourceId }),
              sourceType: envelope.sourceType,
              requestId,
            }),
          request.requestId,
        );
      case "smelting":
        return this.awaitProcessingCompletion(
          EventType.SMELTING_COMPLETE,
          (data) =>
            data.playerId === playerId && data.barItemId === envelope.barItemId,
          (data) =>
            typeof data.totalSmelted === "number" &&
            typeof data.totalFailed === "number" &&
            data.totalSmelted + data.totalFailed > 0,
          envelope,
          (requestId) => {
            this.emitProcessingEvent(EventType.SMELTING_INTERACT, {
              playerId,
              furnaceId: envelope.furnaceId,
            });
            this.emitProcessingEvent(EventType.PROCESSING_SMELTING_REQUEST, {
              playerId,
              barItemId: envelope.barItemId,
              furnaceId: envelope.furnaceId,
              quantity: 1,
              requestId,
            });
          },
          request.requestId,
        );
      case "smithing":
        return this.awaitProcessingCompletion(
          EventType.SMITHING_COMPLETE,
          (data) =>
            data.playerId === playerId && data.recipeId === envelope.recipeId,
          (data) =>
            typeof data.totalSmithed === "number" && data.totalSmithed > 0,
          envelope,
          (requestId) => {
            this.emitProcessingEvent(EventType.SMITHING_INTERACT, {
              playerId,
              anvilId: envelope.anvilId,
            });
            this.emitProcessingEvent(EventType.PROCESSING_SMITHING_REQUEST, {
              playerId,
              recipeId: envelope.recipeId,
              anvilId: envelope.anvilId,
              quantity: 1,
              requestId,
            });
          },
          request.requestId,
        );
      case "crafting":
        return this.awaitProcessingCompletion(
          EventType.CRAFTING_COMPLETE,
          (data) =>
            data.playerId === playerId && data.recipeId === envelope.recipeId,
          (data) =>
            typeof data.totalCrafted === "number" && data.totalCrafted > 0,
          envelope,
          (requestId) => {
            if (envelope.stationId) {
              this.emitProcessingEvent(EventType.CRAFTING_INTERACT, {
                playerId,
                triggerType: "furnace",
                stationId: envelope.stationId,
              });
            }
            this.emitProcessingEvent(EventType.PROCESSING_CRAFTING_REQUEST, {
              playerId,
              recipeId: envelope.recipeId,
              quantity: 1,
              requestId,
            });
          },
          request.requestId,
        );
      case "fletching":
        return this.awaitProcessingCompletion(
          EventType.FLETCHING_COMPLETE,
          (data) =>
            data.playerId === playerId && data.recipeId === envelope.recipeId,
          (data) =>
            typeof data.totalCrafted === "number" && data.totalCrafted > 0,
          envelope,
          (requestId) =>
            this.emitProcessingEvent(EventType.PROCESSING_FLETCHING_REQUEST, {
              playerId,
              recipeId: envelope.recipeId,
              quantity: 1,
              requestId,
            }),
          request.requestId,
        );
      case "runecrafting":
        return this.awaitProcessingCompletion(
          EventType.RUNECRAFTING_COMPLETE,
          (data) =>
            data.playerId === playerId && data.runeType === envelope.runeType,
          (data) =>
            typeof data.essenceConsumed === "number" &&
            data.essenceConsumed > 0 &&
            typeof data.runesProduced === "number" &&
            data.runesProduced > 0,
          envelope,
          (requestId) =>
            this.emitProcessingEvent(EventType.RUNECRAFTING_INTERACT, {
              playerId,
              altarId: envelope.altarId,
              runeType: envelope.runeType,
              requestId,
            }),
          request.requestId,
        );
      case "tanning":
        return this.awaitProcessingCompletion(
          EventType.TANNING_COMPLETE,
          (data) =>
            data.playerId === playerId &&
            data.inputItemId === envelope.inputItemId,
          (data) =>
            typeof data.totalTanned === "number" && data.totalTanned > 0,
          envelope,
          (requestId) => {
            this.emitProcessingEvent(EventType.TANNING_INTERACT, {
              playerId,
              npcId: envelope.tannerNpcId,
              npcEntityId: envelope.tannerEntityId,
            });
            this.emitProcessingEvent(EventType.TANNING_REQUEST, {
              playerId,
              inputItemId: envelope.inputItemId,
              quantity: 1,
              requestId,
            });
          },
          request.requestId,
        );
    }
  }

  private async recoverDurableProcessingRequest(): Promise<void> {
    if (!this.playerEntityId) return;
    const database = this.world.getSystem("database") as
      | {
          getRecoverableProcessingRequestAsync?: (
            playerId: string,
          ) => Promise<RecoverableProcessingRequest | null>;
        }
      | undefined;
    if (!database?.getRecoverableProcessingRequestAsync) return;
    for (;;) {
      const request = await database.getRecoverableProcessingRequestAsync(
        this.playerEntityId,
      );
      if (!request) return;
      if (request.status === "committed" || request.status === "rejected") {
        if (!(await this.acknowledgeProcessingTerminal(request.requestId))) {
          throw new Error("processing_request_acknowledgement_failed");
        }
        continue;
      }
      await this.resumeRecoverableProcessingRequest(request);
      // Re-read durable truth after every local outcome. Only a committed or
      // rejected receipt may be acknowledged and cleared.
    }
  }

  private awaitProcessingCompletion(
    eventType: string,
    matches: (data: Record<string, unknown>) => boolean,
    succeeded: (data: Record<string, unknown>) => boolean,
    envelope: ProcessingRequestEnvelope,
    submit: (requestId: string) => void,
    recoveredRequestId?: string,
  ): Promise<boolean> {
    if (this.cancelPendingProcessingAction) {
      return Promise.resolve(false);
    }

    const skill = this.processingSkillForCompletionEvent(eventType);
    if (!skill) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const requestId = recoveredRequestId ?? crypto.randomUUID();
      const terminalAcknowledgementAbort = new AbortController();
      let settled = false;
      let unsubscribeCompletion = () => {};
      let unsubscribeProgress = () => {};
      let unsubscribeRejection = () => {};
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let durableStatusGeneration = 0;
      let committedReconciliationStarted = false;

      const releaseSingleFlight = (): void => {
        if (this.cancelPendingProcessingAction === cancel) {
          this.cancelPendingProcessingAction = null;
        }
      };

      const finish = (result: boolean, terminal = false): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        unsubscribeCompletion();
        unsubscribeProgress();
        unsubscribeRejection();
        if (!terminal) {
          releaseSingleFlight();
          resolve(result);
          return;
        }
        void this.acknowledgeProcessingTerminal(
          requestId,
          terminalAcknowledgementAbort.signal,
        )
          .then((acknowledged) => {
            if (!acknowledged && this.isActive) {
              console.warn(
                `[EmbeddedHyperiaService] Processing terminal waiter acknowledgement remains unresolved for ${requestId}`,
              );
            }
            releaseSingleFlight();
            // The exact completion/rejection event is emitted only after the
            // durable terminal receipt. Waiter acknowledgement is cleanup;
            // losing its response must never rewrite committed action truth.
            resolve(result);
          })
          .catch(() => {
            releaseSingleFlight();
            resolve(result);
          });
      };
      const cancel = (): void => {
        if (settled) {
          terminalAcknowledgementAbort.abort();
          return;
        }
        finish(false);
      };
      const finishCommitted = (): void => {
        if (settled || committedReconciliationStarted) return;
        committedReconciliationStarted = true;
        if (timeout) clearTimeout(timeout);
        const questSystem = this.world.getSystem("quest") as
          | {
              reconcileDurableProgress?: (playerId: string) => Promise<void>;
            }
          | undefined;
        if (!this.playerEntityId || !questSystem?.reconcileDurableProgress) {
          finish(true, true);
          return;
        }
        void questSystem
          .reconcileDurableProgress(this.playerEntityId)
          .then(() => finish(true, true))
          .catch(() => finish(false, true));
      };
      const dispatch = async (): Promise<void> => {
        const operationId = getProcessingRequestOperationId(skill, requestId);
        const database = this.world.getSystem("database") as
          | {
              beginProcessingRequestAsync?: (
                playerId: string,
                operationId: string,
                requestId: string,
                skill: ProcessingSkill,
                envelope: ProcessingRequestEnvelope,
              ) => Promise<
                "accepted" | "pending" | "committed" | "busy" | "rejected"
              >;
            }
          | undefined;
        if (
          !operationId ||
          !this.playerEntityId ||
          !database?.beginProcessingRequestAsync
        ) {
          finish(false);
          return;
        }
        try {
          const result = await database.beginProcessingRequestAsync(
            this.playerEntityId,
            operationId,
            requestId,
            skill,
            envelope,
          );
          if (result === "committed") {
            finishCommitted();
            return;
          }
          if (result === "pending") {
            armInactivityTimeout();
            return;
          }
          if (result !== "accepted") {
            finish(false, result === "rejected");
            return;
          }
          submit(requestId);
        } catch {
          finish(false);
        }
      };
      const requestDurableStatus = (terminalHint = false): void => {
        if (timeout) clearTimeout(timeout);
        const statusGeneration = ++durableStatusGeneration;
        const operationId = getProcessingRequestOperationId(skill, requestId);
        const database = this.world.getSystem("database") as
          | {
              getProcessingActionCommitStatusAsync?: (
                playerId: string,
                operationId: string,
              ) => Promise<
                | "committed"
                | "pending"
                | "interrupted"
                | "rejected"
                | "not_found"
              >;
            }
          | undefined;
        if (
          operationId &&
          this.playerEntityId &&
          database?.getProcessingActionCommitStatusAsync
        ) {
          void database
            .getProcessingActionCommitStatusAsync(
              this.playerEntityId,
              operationId,
            )
            .then((status) => {
              if (statusGeneration !== durableStatusGeneration) return;
              if (status === "committed") finishCommitted();
              else if (status === "interrupted") {
                durableStatusGeneration += 1;
                armInactivityTimeout();
                void dispatch();
              } else if (status === "rejected") {
                finish(false, true);
              } else if (status === "not_found") {
                finish(false);
              }
            })
            .catch(() => {
              // The fail-closed retry below remains authoritative.
            });
        } else if (terminalHint) {
          finish(false, true);
          return;
        }
        timeout = setTimeout(
          requestDurableStatus,
          EmbeddedHyperiaService.PROCESSING_STATUS_RETRY_MS,
        );
        (timeout as unknown as { unref?: () => void }).unref?.();
      };
      const armInactivityTimeout = (): void => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(
          requestDurableStatus,
          EmbeddedHyperiaService.PROCESSING_COMPLETION_TIMEOUT_MS,
        );
        (timeout as unknown as { unref?: () => void }).unref?.();
      };
      const handle = (raw: unknown): void => {
        const wrapper = raw as { type?: unknown; data?: unknown } | null;
        const candidate =
          wrapper &&
          typeof wrapper === "object" &&
          typeof wrapper.type === "string" &&
          wrapper.data &&
          typeof wrapper.data === "object"
            ? wrapper.data
            : raw;
        if (!candidate || typeof candidate !== "object") return;
        const data = candidate as Record<string, unknown>;
        if (data.requestId === requestId && matches(data)) {
          if (succeeded(data)) {
            // Family completion is a presentation terminal. Confirm the
            // durable operation before awaiting its quest projection.
            requestDurableStatus(true);
          } else {
            // A family completion packet is presentation evidence, not
            // custody authority. If it is malformed or reports no completed
            // work, reconcile the exact immutable request before deciding.
            requestDurableStatus(true);
          }
        }
      };
      const handleRejection = (raw: unknown): void => {
        const wrapper = raw as { type?: unknown; data?: unknown } | null;
        const candidate =
          wrapper &&
          typeof wrapper === "object" &&
          typeof wrapper.type === "string" &&
          wrapper.data &&
          typeof wrapper.data === "object"
            ? wrapper.data
            : raw;
        if (!candidate || typeof candidate !== "object") return;
        const data = candidate as Record<string, unknown>;
        if (
          data.requestId === requestId &&
          data.playerId === this.playerEntityId &&
          data.skill === skill
        ) {
          // A late rejection notification must not overwrite an operation
          // that the database has already committed. The durable request
          // status distinguishes committed, rejected, and still-pending work.
          requestDurableStatus(true);
        }
      };
      const handleProgress = (raw: unknown): void => {
        const wrapper = raw as { type?: unknown; data?: unknown } | null;
        const candidate =
          wrapper &&
          typeof wrapper === "object" &&
          typeof wrapper.type === "string" &&
          wrapper.data &&
          typeof wrapper.data === "object"
            ? wrapper.data
            : raw;
        if (!candidate || typeof candidate !== "object") return;
        const data = candidate as Record<string, unknown>;
        if (
          data.requestId === requestId &&
          data.playerId === this.playerEntityId &&
          data.skill === skill
        ) {
          if (data.phase === "committed") {
            finishCommitted();
            return;
          }
          durableStatusGeneration += 1;
          armInactivityTimeout();
        }
      };

      this.cancelPendingProcessingAction = cancel;
      if (this.world.$eventBus) {
        const completionSubscription = this.world.$eventBus.subscribe(
          eventType,
          handle,
        );
        const rejectionSubscription = this.world.$eventBus.subscribe(
          EventType.PROCESSING_REQUEST_REJECTED,
          handleRejection,
        );
        const progressSubscription = this.world.$eventBus.subscribe(
          EventType.PROCESSING_REQUEST_PROGRESS,
          handleProgress,
        );
        unsubscribeCompletion = () => completionSubscription.unsubscribe();
        unsubscribeProgress = () => progressSubscription.unsubscribe();
        unsubscribeRejection = () => rejectionSubscription.unsubscribe();
      } else {
        this.world.on(eventType, handle);
        this.world.on(EventType.PROCESSING_REQUEST_PROGRESS, handleProgress);
        this.world.on(EventType.PROCESSING_REQUEST_REJECTED, handleRejection);
        unsubscribeCompletion = () => this.world.off(eventType, handle);
        unsubscribeProgress = () =>
          this.world.off(EventType.PROCESSING_REQUEST_PROGRESS, handleProgress);
        unsubscribeRejection = () =>
          this.world.off(
            EventType.PROCESSING_REQUEST_REJECTED,
            handleRejection,
          );
      }

      armInactivityTimeout();

      void dispatch();
    });
  }

  private processingSkillForCompletionEvent(
    eventType: string,
  ): ProcessingSkill | null {
    switch (eventType) {
      case EventType.FIRE_CREATED:
        return "firemaking";
      case EventType.COOKING_COMPLETED:
        return "cooking";
      case EventType.SMELTING_COMPLETE:
        return "smelting";
      case EventType.SMITHING_COMPLETE:
        return "smithing";
      case EventType.CRAFTING_COMPLETE:
        return "crafting";
      case EventType.FLETCHING_COMPLETE:
        return "fletching";
      case EventType.RUNECRAFTING_COMPLETE:
        return "runecrafting";
      case EventType.TANNING_COMPLETE:
        return "tanning";
      default:
        return null;
    }
  }

  /** Emit on both EventBus AND EventEmitter — needed when different systems listen on different channels */
  private emitDualChannel(
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    if (this.world.$eventBus) {
      this.world.$eventBus.emitEvent(eventType, data, "EmbeddedHyperiaService");
    }
    this.world.emit(eventType, data);
  }

  setArenaBounds(bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  }): void {
    this._arenaBounds = bounds;
    // Also store on entity data so TileMovementManager.movePlayerToward() can
    // clamp ALL movement paths (combat follow, pending attack walk, etc.) —
    // not just the ones routed through executeMove().
    if (this.playerEntityId) {
      const entity = this.world.entities.get(this.playerEntityId);
      if (entity) {
        (entity.data as Record<string, unknown>).arenaBounds = bounds;
      }
    }
  }

  clearArenaBounds(): void {
    this._arenaBounds = null;
    if (this.playerEntityId) {
      const entity = this.world.entities.get(this.playerEntityId);
      if (entity) {
        (entity.data as Record<string, unknown>).arenaBounds = null;
      }
    }
  }

  /**
   * Disable or re-enable the agent's autonomous behavior loop.
   * Called by DuelOrchestrator when placing agents in the arena (disable) or
   * returning them to the overworld (re-enable), ensuring agents never try to
   * wander off to quests while a DuelCombatAI is running.
   */
  setAutonomousBehaviorEnabled(enabled: boolean): void {
    this._autonomousEnabled = enabled;
  }

  isAutonomousEnabled(): boolean {
    return (
      this._autonomousEnabled && this.competitiveRecoveryCustodyHolds.size === 0
    );
  }

  /** The configured baseline, excluding temporary competitive recovery holds. */
  isAutonomousBehaviorConfigured(): boolean {
    return this._autonomousEnabled;
  }

  setCompetitiveRecoveryCustodyHold(
    preparationId: string,
    active: boolean,
  ): void {
    if (active) {
      this.competitiveRecoveryCustodyHolds.add(preparationId);
    } else {
      this.competitiveRecoveryCustodyHolds.delete(preparationId);
    }
  }

  private streamingDuelExecutorFingerprint(
    playerId: string,
    publicActionObservation: StreamingDuelExecutorObservationContext,
    command: StreamingDuelExecutorCommand,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          playerId,
          publicActionObservation,
          command,
        }),
        "utf8",
      )
      .digest("hex");
  }

  private enqueueStreamingDuelExecutorCommand<T>(
    execute: () => Promise<T>,
  ): Promise<T> {
    const operation = this.streamingDuelExecutorCommandTail.then(
      execute,
      execute,
    );
    this.streamingDuelExecutorCommandTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private executeStreamingDuelExecutorCommand(
    command: StreamingDuelExecutorCommand,
  ): Promise<boolean> | boolean {
    if (command.kind === "engagement") {
      return this.executeAttack(command.targetId);
    }
    if (command.mode === "combat_approach") {
      return this.executeCombatApproach(command.targetId);
    }
    return this.executeMove([...command.target], command.runMode);
  }

  private executeDurableStreamingDuelCommand(
    rawContext: StreamingDuelExecutorObservationContext,
    command: StreamingDuelExecutorCommand,
    execute: () => Promise<boolean> | boolean,
  ): Promise<StreamingDuelExecutorCommandReceipt> {
    return this.enqueueStreamingDuelExecutorCommand(() =>
      this.executeDurableStreamingDuelCommandInLane(
        rawContext,
        command,
        execute,
        true,
      ),
    );
  }

  private async executeDurableStreamingDuelCommandInLane(
    rawContext: StreamingDuelExecutorObservationContext,
    command: StreamingDuelExecutorCommand,
    execute: () => Promise<boolean> | boolean,
    reconcilePriorCommand: boolean,
  ): Promise<StreamingDuelExecutorCommandReceipt> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("streaming_duel_executor_agent_inactive");
    }
    const publicActionObservation =
      parseStreamingDuelExecutorObservationContext(rawContext);
    if (
      !publicActionObservation ||
      publicActionObservation.actorId !== this.playerEntityId ||
      (publicActionObservation.action === "movement" &&
        command.kind !== "movement") ||
      (publicActionObservation.action === "engagement" &&
        command.kind !== "engagement") ||
      ((command.kind === "engagement" ||
        (command.kind === "movement" && command.mode === "combat_approach")) &&
        command.targetId !== publicActionObservation.opponentId)
    ) {
      throw new Error("streaming_duel_executor_context_invalid");
    }

    const database = this.world.getSystem("database") as
      | {
          stageStreamingDuelExecutorCommandAsync?: (request: {
            operationId: string;
            playerId: string;
            requestFingerprint: string;
            publicActionObservation: StreamingDuelExecutorObservationContext;
            command: StreamingDuelExecutorCommand;
          }) => Promise<StreamingDuelExecutorCommandReceipt>;
          completeStreamingDuelExecutorCommandAsync?: (request: {
            operationId: string;
            playerId: string;
            requestFingerprint: string;
            publicActionObservation: StreamingDuelExecutorObservationContext;
            command: StreamingDuelExecutorCommand;
            outcome: StreamingDuelExecutorCommandOutcome;
          }) => Promise<StreamingDuelExecutorCommandReceipt>;
        }
      | undefined;
    if (
      !database?.stageStreamingDuelExecutorCommandAsync ||
      !database.completeStreamingDuelExecutorCommandAsync
    ) {
      throw new Error("streaming_duel_executor_database_unavailable");
    }

    const requestFingerprint = this.streamingDuelExecutorFingerprint(
      this.playerEntityId,
      publicActionObservation,
      command,
    );
    const request = {
      operationId: publicActionObservation.operationId,
      playerId: this.playerEntityId,
      requestFingerprint,
      publicActionObservation,
      command,
    };
    const callWithAmbiguousRetry = async <T>(
      call: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await call();
      } catch (firstError) {
        try {
          return await call();
        } catch (retryError) {
          throw new Error(
            `streaming_duel_executor_persistence_failed: ${errMsg(retryError)} (first: ${errMsg(firstError)})`,
          );
        }
      }
    };
    const validateReceipt = (
      receipt: StreamingDuelExecutorCommandReceipt,
    ): void => {
      if (
        typeof receipt.replayed !== "boolean" ||
        typeof receipt.completed !== "boolean" ||
        (receipt.outcome !== null &&
          receipt.outcome !== "accepted" &&
          receipt.outcome !== "rejected" &&
          receipt.outcome !== "error") ||
        receipt.operationId !== request.operationId ||
        receipt.playerId !== request.playerId ||
        receipt.requestFingerprint !== request.requestFingerprint ||
        JSON.stringify(receipt.publicActionObservation) !==
          JSON.stringify(request.publicActionObservation) ||
        JSON.stringify(receipt.command) !== JSON.stringify(request.command)
      ) {
        throw new Error("streaming_duel_executor_receipt_invalid");
      }
    };

    const priorCommand = this.pendingStreamingDuelExecutorCommand;
    if (
      reconcilePriorCommand &&
      priorCommand &&
      priorCommand.operationId !== request.operationId
    ) {
      await this.executeDurableStreamingDuelCommandInLane(
        priorCommand.publicActionObservation,
        priorCommand.command,
        () => this.executeStreamingDuelExecutorCommand(priorCommand.command),
        false,
      );
    }

    const staged = await callWithAmbiguousRetry(() =>
      database.stageStreamingDuelExecutorCommandAsync!(request),
    );
    validateReceipt(staged);
    if (staged.completed) {
      if (!staged.outcome) {
        throw new Error("streaming_duel_executor_receipt_invalid");
      }
      if (
        this.pendingStreamingDuelExecutorCommand?.operationId ===
        staged.operationId
      ) {
        this.pendingStreamingDuelExecutorCommand = null;
      }
      return staged;
    }
    if (staged.outcome !== null) {
      throw new Error("streaming_duel_executor_receipt_invalid");
    }
    this.pendingStreamingDuelExecutorCommand = staged;

    let outcome: StreamingDuelExecutorCommandOutcome;
    try {
      outcome = (await execute()) === true ? "accepted" : "rejected";
    } catch {
      outcome = "error";
    }
    const completed = await callWithAmbiguousRetry(() =>
      database.completeStreamingDuelExecutorCommandAsync!({
        ...request,
        outcome,
      }),
    );
    validateReceipt(completed);
    if (!completed.completed || completed.outcome !== outcome) {
      throw new Error("streaming_duel_executor_receipt_invalid");
    }
    if (
      this.pendingStreamingDuelExecutorCommand?.operationId ===
      completed.operationId
    ) {
      this.pendingStreamingDuelExecutorCommand = null;
    }
    return completed;
  }

  async executeDuelMove(
    target: [number, number, number],
    runMode: boolean,
    publicActionObservation: StreamingDuelExecutorObservationContext,
  ): Promise<StreamingDuelExecutorCommandReceipt> {
    const command: StreamingDuelExecutorCommand = Object.freeze({
      kind: "movement",
      mode: "ground",
      target: Object.freeze([...target]) as readonly [number, number, number],
      runMode,
    });
    return this.executeDurableStreamingDuelCommand(
      publicActionObservation,
      command,
      () => this.executeMove([...target], runMode),
    );
  }

  async executeDuelCombatApproach(
    targetId: string,
    publicActionObservation: StreamingDuelExecutorObservationContext,
  ): Promise<StreamingDuelExecutorCommandReceipt> {
    const command: StreamingDuelExecutorCommand = Object.freeze({
      kind: "movement",
      mode: "combat_approach",
      targetId,
      targetType: "player",
    });
    return this.executeDurableStreamingDuelCommand(
      publicActionObservation,
      command,
      () => this.executeCombatApproach(targetId),
    );
  }

  async executeDuelAttack(
    targetId: string,
    publicActionObservation: StreamingDuelExecutorObservationContext,
  ): Promise<StreamingDuelExecutorCommandReceipt> {
    const command: StreamingDuelExecutorCommand = Object.freeze({
      kind: "engagement",
      targetId,
      targetType: "player",
    });
    return this.executeDurableStreamingDuelCommand(
      publicActionObservation,
      command,
      () => this.executeAttack(targetId),
    );
  }

  async recoverPendingStreamingDuelExecutorCommands(
    cycleId: string,
  ): Promise<StreamingDuelExecutorCommandReceipt[]> {
    if (!this.playerEntityId || !this.isActive) return [];
    const database = this.world.getSystem("database") as
      | {
          listPendingStreamingDuelExecutorCommandsAsync?: (
            cycleId: string,
          ) => Promise<StreamingDuelExecutorCommandReceipt[]>;
        }
      | undefined;
    if (!database?.listPendingStreamingDuelExecutorCommandsAsync) return [];
    const pending =
      await database.listPendingStreamingDuelExecutorCommandsAsync(cycleId);
    const recovered: StreamingDuelExecutorCommandReceipt[] = [];
    for (const receipt of pending) {
      if (
        receipt.playerId !== this.playerEntityId ||
        receipt.publicActionObservation.cycleId !== cycleId
      ) {
        continue;
      }
      recovered.push(await this.recoverStreamingDuelExecutorCommand(receipt));
    }
    return recovered;
  }

  async recoverStreamingDuelExecutorCommand(
    receipt: StreamingDuelExecutorCommandReceipt,
  ): Promise<StreamingDuelExecutorCommandReceipt> {
    if (
      !this.playerEntityId ||
      receipt.playerId !== this.playerEntityId ||
      receipt.publicActionObservation.actorId !== this.playerEntityId ||
      receipt.completed ||
      receipt.outcome !== null
    ) {
      throw new Error("streaming_duel_executor_recovery_invalid");
    }
    return this.executeDurableStreamingDuelCommand(
      receipt.publicActionObservation,
      receipt.command,
      () => this.executeStreamingDuelExecutorCommand(receipt.command),
    );
  }

  async executeMove(
    target: [number, number, number],
    runMode: boolean = false,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }
    if (target.some((coordinate) => !Number.isFinite(coordinate))) {
      return false;
    }

    // Clamp movement target to arena bounds when in arena mode.
    // This prevents out-of-bounds moves at the source, avoiding the need for
    // reactive correction teleports that produce unwanted visual effects.
    if (this._arenaBounds) {
      const b = this._arenaBounds;
      const PAD = 2.0;
      target = [
        Math.min(b.maxX - PAD, Math.max(b.minX + PAD, target[0])),
        target[1],
        Math.min(b.maxZ - PAD, Math.max(b.minZ + PAD, target[2])),
      ];
    } else if (isPositionInsideCombatArena(target[0], target[2])) {
      // Not in a duel — reject moves into combat arenas to prevent
      // the agent from walking into arenas and triggering ejection loops.
      return false;
    }

    const networkMoveResult = this.requestNetworkMove(
      target,
      runMode,
      this._arenaBounds
        ? undefined
        : this.resolveInteractionMovementArrival(target),
    );
    if (networkMoveResult !== null) {
      return networkMoveResult;
    }

    // Legacy movement system fallback (tests/mocks)
    const movementSystem = this.world.getSystem("movement") as
      | {
          requestMovement?: (
            entityId: string,
            target: [number, number, number],
            options?: { runMode?: boolean },
          ) => void;
        }
      | undefined;
    if (movementSystem?.requestMovement) {
      movementSystem.requestMovement(this.playerEntityId, target, { runMode });
      return true;
    }

    // Movement authority is unavailable. Never turn an infrastructure fault
    // into a direct transform mutation that bypasses routing and collision.
    console.warn(
      "[EmbeddedHyperiaService] Authoritative movement system not available",
    );
    return false;
  }

  /**
   * Confirm that the combat system—not the mirrored entity flags—currently
   * owns an active engagement with the exact duel opponent. DuelCombatAI uses
   * this to avoid submitting a second pursuit/attack driver after the combat
   * tick loop has taken authority.
   */
  isAuthoritativelyInCombatWith(targetId: string): boolean {
    if (!this.playerEntityId || !this.isActive) {
      return false;
    }
    const combatSystem = this.world.getSystem("combat") as
      | {
          isInCombat?: (entityId: string) => boolean;
          getCombatData?: (entityId: string) => {
            inCombat?: boolean;
            targetId?: unknown;
          } | null;
        }
      | undefined;
    if (!combatSystem?.isInCombat || !combatSystem.getCombatData) {
      return false;
    }
    if (!combatSystem.isInCombat(this.playerEntityId)) {
      return false;
    }
    const combatData = combatSystem.getCombatData(this.playerEntityId);
    return (
      combatData?.inCombat === true && String(combatData.targetId) === targetId
    );
  }

  /**
   * Ask the same server network authority that admits attacks whether the
   * current live tiles satisfy this player's equipped weapon range. Euclidean
   * presentation distance is insufficient for range-one melee because a
   * diagonal neighbour is visually close but not a legal attack tile.
   */
  isTargetInAuthoritativeAttackRange(targetId: string): boolean {
    if (!this.playerEntityId || !this.isActive) {
      return false;
    }
    const player = this.world.entities.get(this.playerEntityId) as
      { position?: { x: number; z: number } } | undefined;
    const target = this.world.entities.get(targetId) as
      { position?: { x: number; z: number } } | undefined;
    if (!player?.position || !target?.position) {
      return false;
    }
    const networkSystem = this.world.getSystem("network") as
      | {
          getPlayerWeaponRange?: (playerId: string) => number;
          getPlayerAttackType?: (playerId: string) => AttackType;
          isInAttackRange?: (
            attackerTile: { x: number; z: number },
            targetTile: { x: number; z: number },
            attackType: AttackType,
            range: number,
          ) => boolean;
        }
      | undefined;
    if (
      !networkSystem?.getPlayerWeaponRange ||
      !networkSystem.getPlayerAttackType ||
      !networkSystem.isInAttackRange
    ) {
      return false;
    }
    const range = networkSystem.getPlayerWeaponRange(this.playerEntityId);
    if (!Number.isSafeInteger(range) || range < 1) {
      return false;
    }
    return networkSystem.isInAttackRange(
      {
        x: Math.floor(player.position.x),
        z: Math.floor(player.position.z),
      },
      {
        x: Math.floor(target.position.x),
        z: Math.floor(target.position.z),
      },
      networkSystem.getPlayerAttackType(this.playerEntityId),
      range,
    );
  }

  /**
   * Approach the current duel target through the combat-aware pathfinder.
   * Ground-click movement intentionally disengages combat; melee chase must
   * preserve the active target and weapon cooldown while closing to a valid
   * attack tile.
   */
  executeCombatApproach(targetId: string): boolean {
    if (!this.playerEntityId || !this.isActive) {
      return false;
    }
    const networkSystem = this.world.getSystem("network") as
      | {
          requestServerCombatApproach?: (
            playerId: string,
            targetId: string,
          ) => boolean;
        }
      | undefined;
    return (
      networkSystem?.requestServerCombatApproach?.(
        this.playerEntityId,
        targetId,
      ) === true
    );
  }

  async executeAttack(targetId: string): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }

    const targetEntity = this.world.entities.get(targetId);
    if (!targetEntity) return false;

    // Guard: don't chase targets inside combat arenas when not in a duel
    if (!this._arenaBounds) {
      const targetPos = this.getEntityPosition(targetEntity);
      if (
        targetPos &&
        isPositionInsideCombatArena(targetPos[0], targetPos[2])
      ) {
        return false;
      }
    }

    // Guard: abort if target is dead (race condition between tick check and attack)
    const te = targetEntity as unknown as {
      isDead?: () => boolean;
      isAlive?: () => boolean;
    };
    if (
      (typeof te.isDead === "function" && te.isDead()) ||
      (typeof te.isAlive === "function" && !te.isAlive())
    ) {
      return false;
    }

    const targetType: "player" | "mob" =
      targetEntity?.type === "player" ? "player" : "mob";

    // Use the server network's walk-to-and-attack pipeline (same as real players)
    const networkSystem = this.world.getSystem("network") as
      | {
          requestServerAttack?: (
            playerId: string,
            targetId: string,
            targetType: "mob" | "player",
          ) => boolean;
        }
      | undefined;

    if (networkSystem?.requestServerAttack) {
      return (
        networkSystem.requestServerAttack(
          this.playerEntityId,
          targetId,
          targetType,
        ) === true
      );
    }
    console.warn(
      "[EmbeddedHyperiaService] Network system requestServerAttack not available",
    );
    return false;
  }

  async executeGather(
    resourceId: string,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    this.lastGatherFailureReason = null;
    if (!this.playerEntityId || !this.isActive) {
      this.lastGatherFailureReason = "service_inactive";
      throw new Error("Agent not spawned");
    }

    // Guard: don't gather resources inside combat arenas when not in a duel
    if (!this._arenaBounds) {
      const resEntity = this.world.entities.get(resourceId);
      if (resEntity) {
        const resPos = this.getEntityPosition(resEntity);
        if (resPos && isPositionInsideCombatArena(resPos[0], resPos[2])) {
          this.lastGatherFailureReason = "arena_resource_outside_duel";
          return false;
        }
      }
    }

    // Use PendingGatherManager which handles cardinal tile pathfinding,
    // anchor tile lookup, and face direction automatically.
    const networkSystem = this.world.getSystem("network") as unknown as {
      pendingGatherManager?: {
        queuePendingGather: (
          playerId: string,
          resourceId: string,
          currentTick: number,
          runMode?: boolean,
          completionAttemptId?: string,
        ) => boolean;
      };
      tickSystem?: { getCurrentTick: () => number };
    } | null;

    if (!networkSystem?.pendingGatherManager || !networkSystem.tickSystem) {
      // There is no synchronous acceptance receipt on the legacy event path.
      // Reporting success there can advance autonomous state even when the
      // resource authority rejects the request, so embedded agents require the
      // same pathfinding/contention authority used by connected players.
      this.lastGatherFailureReason = "authority_unavailable";
      return false;
    }

    if (autonomyAttemptId === undefined) {
      const accepted = networkSystem.pendingGatherManager.queuePendingGather(
        this.playerEntityId,
        resourceId,
        networkSystem.tickSystem.getCurrentTick(),
        true,
      );
      this.lastGatherFailureReason = accepted ? null : "admission_rejected";
      return accepted;
    }

    const operationId =
      getGatheringRewardOperationIdForAttempt(autonomyAttemptId);
    if (!operationId) {
      this.lastGatherFailureReason = "invalid_operation_identity";
      return false;
    }
    if (this.cancelPendingGatherAction) {
      this.lastGatherFailureReason = "concurrent_request";
      return false;
    }
    const playerId = this.playerEntityId;
    const pendingGatherManager = networkSystem.pendingGatherManager;
    const currentTick = networkSystem.tickSystem.getCurrentTick();

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (result: boolean, failureReason?: string): void => {
        if (settled) return;
        settled = true;
        this.lastGatherFailureReason = result
          ? null
          : (failureReason ?? "completion_rejected");
        unsubscribe();
        if (this.cancelPendingGatherAction === cancel) {
          this.cancelPendingGatherAction = null;
        }
        resolve(result);
      };
      const cancel = (): void => finish(false, "cancelled");
      const handleCompletion = (raw: unknown): void => {
        const wrapper = raw as { type?: unknown; data?: unknown } | null;
        const candidate =
          wrapper &&
          typeof wrapper === "object" &&
          typeof wrapper.type === "string" &&
          wrapper.data &&
          typeof wrapper.data === "object"
            ? wrapper.data
            : raw;
        if (!candidate || typeof candidate !== "object") return;
        const data = candidate as Record<string, unknown>;
        if (
          data.playerId !== playerId ||
          data.resourceId !== resourceId ||
          data.operationId !== operationId
        ) {
          return;
        }
        if (data.successful !== true) {
          finish(
            false,
            typeof data.failureReason === "string" && data.failureReason
              ? data.failureReason
              : "completion_rejected",
          );
          return;
        }
        const validReward =
          typeof data.rewardItemId === "string" &&
          data.rewardItemId.length > 0 &&
          Number.isSafeInteger(data.rewardQuantity) &&
          Number(data.rewardQuantity) > 0;
        finish(validReward, validReward ? undefined : "invalid_reward_receipt");
      };

      this.cancelPendingGatherAction = cancel;
      if (this.world.$eventBus) {
        const subscription = this.world.$eventBus.subscribe(
          EventType.RESOURCE_GATHERING_COMPLETED,
          handleCompletion,
        );
        unsubscribe = () => subscription.unsubscribe();
      } else {
        this.world.on(EventType.RESOURCE_GATHERING_COMPLETED, handleCompletion);
        unsubscribe = () =>
          this.world.off(
            EventType.RESOURCE_GATHERING_COMPLETED,
            handleCompletion,
          );
      }

      const accepted =
        pendingGatherManager.queuePendingGather(
          playerId,
          resourceId,
          currentTick,
          true,
          autonomyAttemptId,
        ) === true;
      if (!accepted) finish(false, "admission_rejected");
    });
  }

  getLastGatherFailureReason(): string | null {
    return this.lastGatherFailureReason;
  }

  async executePickup(
    itemId: string,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }

    if (!this.world.entities.get(itemId)) {
      return false;
    }

    const operationId =
      autonomyAttemptId === undefined
        ? undefined
        : (getGroundItemPickupOperationIdForAttempt(autonomyAttemptId) ??
          undefined);
    if (autonomyAttemptId !== undefined && !operationId) return false;

    const networkSystem = this.world.getSystem("network") as
      | {
          requestServerPickup?: (
            playerId: string,
            entityId: string,
            operationId?: string,
          ) => Promise<boolean>;
        }
      | undefined;
    if (!networkSystem?.requestServerPickup) return false;

    return networkSystem.requestServerPickup(
      this.playerEntityId,
      itemId,
      operationId,
    );
  }

  async executeLootGravestone(
    gravestoneId: string,
    autonomyAttemptId: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) {
      return false;
    }
    const normalizedGravestoneId = gravestoneId.trim();
    const normalizedAttemptId =
      typeof autonomyAttemptId === "string" ? autonomyAttemptId.trim() : "";
    if (
      !normalizedGravestoneId ||
      normalizedGravestoneId.length > 256 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        normalizedAttemptId,
      ) ||
      !this.world.entities.get(normalizedGravestoneId)
    ) {
      return false;
    }

    const playerId = this.playerEntityId;
    const transactionId = `agent-grave-loot:${normalizedAttemptId}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (success: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.world.off(EventType.LOOT_RESULT, handleResult);
        if (success) {
          this._inventoryCacheTick = -1;
          this._gameStateCacheTick = -1;
          this.invalidateNearbyEntityCache();
        }
        resolve(success);
      };
      const handleResult = (raw: unknown): void => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        const result = raw as {
          playerId?: unknown;
          transactionId?: unknown;
          success?: unknown;
        };
        if (
          result.playerId !== playerId ||
          result.transactionId !== transactionId
        ) {
          return;
        }
        finish(result.success === true);
      };
      const timeout = setTimeout(
        () => finish(false),
        GRAVESTONE_LOOT_RESULT_TIMEOUT_MS,
      );
      this.world.on(EventType.LOOT_RESULT, handleResult);
      try {
        this.world.emit(EventType.CORPSE_LOOT_ALL_REQUEST, {
          corpseId: normalizedGravestoneId,
          playerId,
          transactionId,
        });
      } catch {
        finish(false);
      }
    });
  }

  async executeDrop(itemId: string, quantity: number = 1): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }
    const inventorySystem = this.world.getSystem("inventory") as
      | {
          dropOwnedItemAtomic?: (
            playerId: string,
            operationId: string,
            requestedItemId: string,
            requestedQuantity: number,
          ) => Promise<{ ok: boolean }>;
        }
      | undefined;
    if (!inventorySystem?.dropOwnedItemAtomic) return false;

    let operationId: string;
    try {
      operationId = generateGroundItemDropOperationId();
    } catch {
      return false;
    }
    const result = await inventorySystem.dropOwnedItemAtomic(
      this.playerEntityId,
      operationId,
      itemId,
      quantity,
    );
    if (result.ok) {
      this._inventoryCacheTick = -1;
      this._gameStateCacheTick = -1;
      this.invalidateNearbyEntityCache();
    }
    return result.ok;
  }

  async executeEquip(itemId: string): Promise<EquipmentActionReceipt> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }

    const playerId = this.playerEntityId;
    const equipmentSystem = this.world.getSystem("equipment") as
      | {
          equipOwnedItem?: (
            requestedPlayerId: string,
            requestedItemId: string,
          ) => Promise<EquipmentActionReceipt>;
        }
      | undefined;
    if (!equipmentSystem?.equipOwnedItem) {
      return {
        ok: false,
        playerId,
        itemId,
        slot: null,
        changed: false,
        reason: "equipment_system_unavailable",
      };
    }

    const receipt = await equipmentSystem.equipOwnedItem(playerId, itemId);
    // The equipment cache is tick-scoped. A completed action must be visible to
    // the next observation even when it resolves inside the same world tick.
    this._equipmentCacheTick = -1;
    this._gameStateCacheTick = -1;
    return receipt;
  }

  async executeUnequipOwned(slot: string): Promise<EquipmentActionReceipt> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }
    const playerId = this.playerEntityId;
    const equipmentSystem = this.world.getSystem("equipment") as
      | {
          unequipOwnedItem?: (
            requestedPlayerId: string,
            requestedSlot: string,
          ) => Promise<EquipmentActionReceipt>;
        }
      | undefined;
    if (!equipmentSystem?.unequipOwnedItem) {
      return {
        ok: false,
        playerId,
        itemId: "",
        slot,
        changed: false,
        reason: "equipment_system_unavailable",
      };
    }

    const receipt = await equipmentSystem.unequipOwnedItem(playerId, slot);
    this._equipmentCacheTick = -1;
    this._gameStateCacheTick = -1;
    return receipt;
  }

  async executeDuelPreparationPlan(
    request: DuelPreparationPlanExecutionRequest,
  ): Promise<OwnedDuelPreparationPlanReceipt> {
    const playerId = this.playerEntityId ?? this.characterId;
    const baseFailure = (
      reason:
        | "player_missing"
        | "equipment_system_unavailable"
        | "preparation_capability_unavailable",
    ): OwnedDuelPreparationPlanReceipt => ({
      ok: false,
      playerId,
      operationId: String(request.operationId ?? "").trim(),
      preparationId: String(request.preparationId ?? "").trim(),
      changed: false,
      replayed: false,
      reason,
    });
    if (!this.playerEntityId || !this.isActive) {
      return baseFailure("player_missing");
    }
    if (
      this.activeBankPreparationId !== request.preparationId ||
      this.activeBankId !== getDuelPreparationBankId(request.preparationId)
    ) {
      return baseFailure("preparation_capability_unavailable");
    }

    const equipmentSystem = this.world.getSystem("equipment") as
      | {
          commitOwnedDuelPreparationPlan?: (
            requestedPlayerId: string,
            requestedPlan: OwnedDuelPreparationPlanRequest,
          ) => Promise<OwnedDuelPreparationPlanReceipt>;
        }
      | undefined;
    if (!equipmentSystem?.commitOwnedDuelPreparationPlan) {
      return baseFailure("equipment_system_unavailable");
    }

    const receipt = await equipmentSystem.commitOwnedDuelPreparationPlan(
      this.playerEntityId,
      request,
    );
    if (receipt.ok) {
      this._equipmentCacheTick = -1;
      this._gameStateCacheTick = -1;
    }
    return receipt;
  }

  async executeDuelPreparationCustodyRefresh(
    preparationId: string,
  ): Promise<boolean> {
    if (
      !this.playerEntityId ||
      !this.isActive ||
      this.activeBankPreparationId !== preparationId ||
      this.activeBankId !== getDuelPreparationBankId(preparationId)
    ) {
      return false;
    }
    const equipmentSystem = this.world.getSystem("equipment") as
      | {
          refreshOwnedDuelPreparationCustodyFromPersistence?: (
            requestedPlayerId: string,
          ) => Promise<boolean>;
        }
      | undefined;
    if (!equipmentSystem?.refreshOwnedDuelPreparationCustodyFromPersistence) {
      return false;
    }
    const refreshed =
      await equipmentSystem.refreshOwnedDuelPreparationCustodyFromPersistence(
        this.playerEntityId,
      );
    if (refreshed) {
      this._inventoryCacheTick = -1;
      this._equipmentCacheTick = -1;
      this._gameStateCacheTick = -1;
    }
    return refreshed;
  }

  async executeDuelPreparationPlanRecovery(
    operationId: string,
    preparationId: string,
  ): Promise<OwnedDuelPreparationPlanReceipt | null> {
    if (
      !this.playerEntityId ||
      !this.isActive ||
      this.activeBankPreparationId !== preparationId ||
      this.activeBankId !== getDuelPreparationBankId(preparationId)
    ) {
      return null;
    }
    const equipmentSystem = this.world.getSystem("equipment") as
      | {
          recoverOwnedDuelPreparationPlan?: (
            requestedPlayerId: string,
            request: OwnedDuelPreparationPlanRecoveryRequest,
          ) => Promise<OwnedDuelPreparationPlanReceipt | null>;
        }
      | undefined;
    if (!equipmentSystem?.recoverOwnedDuelPreparationPlan) return null;
    const receipt = await equipmentSystem.recoverOwnedDuelPreparationPlan(
      this.playerEntityId,
      { operationId, preparationId },
    );
    if (receipt?.ok) {
      this._equipmentCacheTick = -1;
      this._gameStateCacheTick = -1;
    }
    return receipt;
  }

  async executeUse(
    itemId: string,
    publicActionObservation?: StreamingDuelFoodObservationContext,
  ): Promise<FoodConsumptionReceipt> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }

    const items = this.getInventoryItems();
    const item = items.find((i) => i.itemId === itemId);
    const failure = (
      reason: FoodConsumptionReceipt["reason"],
    ): FoodConsumptionReceipt => ({
      ok: false,
      committed: false,
      consumed: false,
      playerId: this.playerEntityId!,
      itemId,
      operationId: "",
      replayed: false,
      healedAmount: 0,
      newHealth: this.getGameState()?.health ?? null,
      reason,
    });
    if (!item) return failure("item_not_owned");

    const playerSystem = this.world.getSystem("player") as
      | {
          consumeFoodAtomic?: (
            playerId: string,
            requestedItemId: string,
            slot: number,
            operationId: string,
            observation?: StreamingDuelFoodObservationContext,
          ) => Promise<FoodConsumptionReceipt>;
        }
      | undefined;
    if (!playerSystem?.consumeFoodAtomic) {
      return failure("atomic_persistence_unavailable");
    }

    const operationId = `food-debit:${crypto.randomUUID()}`;
    const receipt = publicActionObservation
      ? await playerSystem.consumeFoodAtomic(
          this.playerEntityId,
          itemId,
          item.slot,
          operationId,
          publicActionObservation,
        )
      : await playerSystem.consumeFoodAtomic(
          this.playerEntityId,
          itemId,
          item.slot,
          operationId,
        );
    this._gameStateCacheTick = -1;
    return receipt;
  }

  async executeBury(
    itemId: string,
    operationId?: string,
  ): Promise<BoneBurialReceipt> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }
    const normalizedOperationId =
      operationId ??
      `bone-burial:${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const failure = (
      reason: BoneBurialReceipt["reason"],
      retryable: boolean,
    ): BoneBurialReceipt => ({
      ok: false,
      committed: false,
      liveStateApplied: false,
      playerId: this.playerEntityId!,
      itemId,
      operationId: normalizedOperationId,
      replayed: false,
      awardedXp: 0,
      currentXp: null,
      currentLevel: null,
      retryable,
      reason,
    });
    const item = getItem(itemId);
    if (!item?.prayerXp || item.prayerXp <= 0) {
      return failure("invalid_request", false);
    }
    const playerSystem = this.world.getSystem("player") as
      | {
          buryBoneAtomic?: (
            playerId: string,
            requestedItemId: string,
            requestedOperationId: string,
          ) => Promise<BoneBurialReceipt>;
        }
      | undefined;
    if (!playerSystem?.buryBoneAtomic) {
      return failure("atomic_persistence_unavailable", true);
    }
    const receipt = await playerSystem.buryBoneAtomic(
      this.playerEntityId,
      itemId,
      normalizedOperationId,
    );
    if (receipt.committed) this._gameStateCacheTick = -1;
    return receipt;
  }

  async executePrayer(prayerId: string): Promise<PrayerActionReceipt> {
    return this.executePrayerToggle(prayerId);
  }

  async executeChat(message: string): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) {
      throw new Error("Agent not spawned");
    }

    const chatSystem = this.world.getSystem("chat") as
      | {
          add?: (
            message: {
              id: string;
              from: string;
              fromId: string;
              body: string;
              text: string;
              timestamp: number;
              createdAt: string;
            },
            broadcast?: boolean,
          ) => void;
        }
      | undefined;

    if (chatSystem?.add) {
      chatSystem.add(
        {
          id: crypto.randomUUID(),
          from: this.name,
          fromId: this.playerEntityId,
          body: message,
          text: message,
          timestamp: Date.now(),
          createdAt: new Date().toISOString(),
        },
        true,
      );
      return true;
    }
    console.warn("[EmbeddedHyperiaService] Chat system not available");
    return false;
  }

  async executeStop(): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) {
      return false;
    }

    // Stop current movement
    let applied = this.cancelNetworkMove();
    if (!applied) {
      const movementSystem = this.world.getSystem("movement") as
        | {
            cancelMovement?: (entityId: string) => void;
          }
        | undefined;

      if (movementSystem?.cancelMovement) {
        movementSystem.cancelMovement(this.playerEntityId);
        applied = true;
      }
    }

    // Cancel combat via CombatSystem (keeps internal tracking in sync)
    const combatSystem = this.world.getSystem("combat") as {
      forceEndCombat?: (entityId: string) => void;
      waitForProjectileCustodySettlements?: () => Promise<void>;
    } | null;
    if (combatSystem?.forceEndCombat) {
      try {
        combatSystem.forceEndCombat(this.playerEntityId);
        applied = true;
      } catch {
        // Fall through to manual cleanup
      }
    }

    // A ranged or magic admission can already be awaiting its durable debit
    // when preparation stops combat. forceEndCombat() fences the launch and
    // starts the matching refund/cancellation, but the private bank must not
    // snapshot custody until that terminal operation has settled.
    if (combatSystem?.waitForProjectileCustodySettlements) {
      await combatSystem.waitForProjectileCustodySettlements();
    }

    // Projectile settlement can change equipped ammunition or inventory runes
    // without advancing the world tick. Preparation reads custody immediately
    // after this barrier, so same-tick observation caches must be discarded or
    // the whole-plan delta can be computed from quantities that no longer exist.
    this._inventoryCacheTick = -1;
    this._equipmentCacheTick = -1;
    this._gameStateCacheTick = -1;

    // Clear any remaining combat state (including serialized fields)
    const player = this.world.entities.get(this.playerEntityId);
    if (player) {
      player.data.combatTarget = null;
      player.data.inCombat = false;
      (player.data as Record<string, unknown>).ct = null;
      (player.data as Record<string, unknown>).c = false;
      (player.data as Record<string, unknown>).attackTarget = null;
      applied = true;
    }
    return applied;
  }

  /**
   * Reject every new combat admission involving this selected contestant until
   * the exact private preparation freezes or terminates. Re-delivery of the
   * same preparation is idempotent; another preparation cannot steal it.
   */
  beginDuelPreparationCombatFence(preparationId: string): boolean {
    if (!this.playerEntityId || !this.isActive || !preparationId) return false;
    if (
      this.activeDuelPreparationCombatFenceId &&
      this.activeDuelPreparationCombatFenceId !== preparationId
    ) {
      return false;
    }
    const combatSystem = this.world.getSystem("combat") as
      | {
          beginDuelPreparationCombatFence?: (
            entityId: string,
            exactPreparationId: string,
          ) => boolean;
        }
      | undefined;
    if (
      combatSystem?.beginDuelPreparationCombatFence?.(
        this.playerEntityId,
        preparationId,
      ) !== true
    ) {
      return false;
    }
    this.activeDuelPreparationCombatFenceId = preparationId;
    return true;
  }

  /** Release only the exact preparation that owns this player's combat fence. */
  endDuelPreparationCombatFence(preparationId: string): boolean {
    if (
      !preparationId ||
      this.activeDuelPreparationCombatFenceId !== preparationId
    ) {
      return false;
    }
    return this.releaseActiveDuelPreparationCombatFence();
  }

  private releaseActiveDuelPreparationCombatFence(): boolean {
    const preparationId = this.activeDuelPreparationCombatFenceId;
    if (!preparationId) return false;
    const playerEntityId = this.playerEntityId;
    this.activeDuelPreparationCombatFenceId = null;
    if (!playerEntityId) return false;
    const combatSystem = this.world.getSystem("combat") as
      | {
          endDuelPreparationCombatFence?: (
            entityId: string,
            exactPreparationId: string,
          ) => boolean;
        }
      | undefined;
    return (
      combatSystem?.endDuelPreparationCombatFence?.(
        playerEntityId,
        preparationId,
      ) === true
    );
  }

  async executePrayerToggle(
    prayerId: string,
    publicActionObservation?: StreamingDuelPrayerObservationContext,
  ): Promise<PrayerActionReceipt> {
    const operationId = `agent-prayer-toggle:${crypto.randomUUID()}`;
    const failure = (
      reason: PrayerActionReceipt["reason"],
      message: string,
    ): PrayerActionReceipt => ({
      success: false,
      committed: false,
      playerId: this.playerEntityId ?? "",
      operationId,
      replayed: false,
      pointUnits: 0,
      points: 0,
      maxPoints: 1,
      activePrayers: [],
      reason,
      message,
    });
    if (!this.playerEntityId || !this.isActive) {
      return failure("player_not_initialized", "Agent not spawned");
    }
    if (!prayerId || typeof prayerId !== "string" || prayerId.length === 0) {
      return failure("invalid_request", "Invalid prayer");
    }

    const prayerSystem = this.world.getSystem("prayer") as {
      togglePrayer?: (
        playerId: string,
        prayerId: string,
        operationId?: string,
        observation?: StreamingDuelPrayerObservationContext,
      ) => Promise<PrayerActionReceipt>;
    } | null;

    if (!prayerSystem?.togglePrayer) {
      return failure(
        "atomic_persistence_unavailable",
        "Prayer system unavailable",
      );
    }

    try {
      const receipt = publicActionObservation
        ? await prayerSystem.togglePrayer(
            this.playerEntityId,
            prayerId,
            operationId,
            publicActionObservation,
          )
        : await prayerSystem.togglePrayer(
            this.playerEntityId,
            prayerId,
            operationId,
          );
      this._gameStateCacheTick = -1;
      return receipt;
    } catch (err) {
      console.warn(
        `[EmbeddedHyperiaService] Prayer toggle failed for ${prayerId}:`,
        errMsg(err),
      );
      return failure("persistence_failed", "Prayer toggle failed");
    }
  }

  private static readonly VALID_STYLES = new Set([
    "accurate",
    "aggressive",
    "defensive",
    "controlled",
    "rapid",
    "longrange",
  ]);

  /**
   * Preserve the authoritative rejection category for the duel controller's
   * launch diagnostics. The boolean compatibility API remains intentionally
   * small for ordinary agents, but a paid duel must not collapse a database,
   * equipment, or projection failure into an undifferentiated rejection.
   */
  getLastStyleChangeFailureReason(): string | null {
    return this.lastStyleChangeFailureReason;
  }

  async executeChangeStyle(
    newStyle: string,
    publicActionObservation?: StreamingDuelStyleObservationContext,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) {
      this.lastStyleChangeFailureReason = "service_inactive";
      return false;
    }

    if (!EmbeddedHyperiaService.VALID_STYLES.has(newStyle)) {
      this.lastStyleChangeFailureReason = "invalid_style";
      console.warn(
        `[EmbeddedHyperiaService] Invalid attack style: ${newStyle}`,
      );
      return false;
    }

    const player = this.world.entities.get(this.playerEntityId);
    if (!player) {
      this.lastStyleChangeFailureReason = "player_missing";
      return false;
    }

    const playerSystem = this.world.getSystem("player") as
      | {
          changeAttackStyleAtomic?: (
            playerId: string,
            requestedStyle: string,
            observation?: StreamingDuelStyleObservationContext,
          ) => Promise<{
            ok: boolean;
            currentStyle: string | null;
            reason?: string;
          }>;
        }
      | undefined;
    if (playerSystem?.changeAttackStyleAtomic) {
      const receipt = await playerSystem.changeAttackStyleAtomic(
        this.playerEntityId,
        newStyle,
        publicActionObservation,
      );
      const accepted = receipt.ok && receipt.currentStyle === newStyle;
      this.lastStyleChangeFailureReason = accepted
        ? null
        : (receipt.reason ??
          (receipt.ok ? "committed_style_mismatch" : "request_rejected"));
      return accepted;
    }

    // Unit/legacy worlds may lack PlayerSystem. Never downgrade a duel receipt
    // to an unverified event, but preserve the historical diagnostic fallback.
    if (publicActionObservation) {
      this.lastStyleChangeFailureReason = "atomic_persistence_unavailable";
      return false;
    }
    this.world.emit(EventType.ATTACK_STYLE_CHANGED, {
      playerId: this.playerEntityId,
      newStyle,
    });
    this.lastStyleChangeFailureReason = null;
    return true;
  }

  /** Select a validated combat spell and verify the authoritative post-state. */
  async executeSetAutocast(spellId: string | null): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    const player = this.world.entities.get(this.playerEntityId);
    if (!player?.data) return false;

    if (spellId !== null) {
      const spell = COMBAT_SPELLS[spellId];
      const skills = (
        player.data as {
          skills?: Record<string, { level?: number }>;
        }
      ).skills;
      const magicLevel = Number(skills?.magic?.level ?? 1);
      if (
        !spell ||
        !Number.isSafeInteger(magicLevel) ||
        magicLevel < spell.level
      ) {
        return false;
      }
    }

    const database = this.world.getSystem("database") as {
      savePlayerAsync?: (
        playerId: string,
        data: { selectedSpell: string | null },
      ) => Promise<void>;
    } | null;
    if (!database?.savePlayerAsync) return false;
    try {
      await database.savePlayerAsync(this.playerEntityId, {
        selectedSpell: spellId,
      });
    } catch (error) {
      console.warn(
        `[EmbeddedHyperiaService] Autocast persistence failed for ${spellId ?? "none"}:`,
        errMsg(error),
      );
      return false;
    }

    (player.data as { selectedSpell?: string | null }).selectedSpell = spellId;
    const worldPlayer = (
      this.world as {
        getPlayer?: (id: string) => { data?: Record<string, unknown> } | null;
      }
    ).getPlayer?.(this.playerEntityId);
    if (worldPlayer?.data) worldPlayer.data.selectedSpell = spellId;
    this.world.emit(EventType.PLAYER_SET_AUTOCAST, {
      playerId: this.playerEntityId,
      spellId,
    });
    this._gameStateCacheTick = -1;

    const entityPostState = (player.data as { selectedSpell?: string | null })
      .selectedSpell;
    const worldPostState = worldPlayer?.data?.selectedSpell;
    return (
      entityPostState === spellId &&
      (!worldPlayer?.data || worldPostState === spellId)
    );
  }

  async executeHomeTeleport(): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;

    const player = this.world.entities.get(this.playerEntityId);
    if (!player) return false;

    if (player.data.inCombat) {
      console.warn(
        "[EmbeddedHyperiaService] Cannot home teleport while in combat",
      );
      return false;
    }

    if (player.data.inStreamingDuel) {
      console.warn(
        "[EmbeddedHyperiaService] Cannot home teleport during a duel",
      );
      return false;
    }

    this.world.emit(EventType.HOME_TELEPORT_REQUEST, {
      playerId: this.playerEntityId,
    });
    return true;
  }

  // =========================================================================
  // Banking
  // =========================================================================

  async executeBankOpen(bankId: string): Promise<AgentBankActionReceipt> {
    if (!this.playerEntityId || !this.isActive) {
      return createAgentBankFailureReceipt(
        "open",
        this.playerEntityId,
        bankId,
        "player_unavailable",
      );
    }

    const openRevision = ++this.bankOpenRevision;
    this.pendingDuelPreparationBankOpen = null;
    this.activeBankId = null;
    this.activeBankPreparationId = null;
    const receipt = await openAuthoritativeAgentBank({
      world: this.world,
      playerId: this.playerEntityId,
      bankId,
    });
    if (openRevision !== this.bankOpenRevision) return receipt;
    if (receipt.success) {
      this.activeBankId = bankId;
      this.activeBankPreparationId = null;
      // Session/camera observers may react to this event, but item custody is
      // handled only by the committed database transaction path below.
      this.world.emit(EventType.BANK_OPEN, {
        playerId: this.playerEntityId,
        bankId,
        operationId: receipt.operationId,
      });
    } else {
      this.activeBankId = null;
      this.activeBankPreparationId = null;
    }
    return receipt;
  }

  /**
   * Open the agent's own bank through a durable on-deck capability. This is a
   * separate entry point so ordinary autonomous actions cannot request remote
   * banking merely by choosing a synthetic bank identifier.
   */
  async executeDuelPreparationBankOpen(
    preparationId: string,
  ): Promise<AgentBankActionReceipt> {
    const bankId = getDuelPreparationBankId(preparationId);
    if (!this.playerEntityId || !this.isActive) {
      return createAgentBankFailureReceipt(
        "open",
        this.playerEntityId,
        bankId,
        "player_unavailable",
      );
    }
    const openRevision = ++this.bankOpenRevision;
    this.pendingDuelPreparationBankOpen = {
      preparationId,
      revision: openRevision,
    };
    this.activeBankId = null;
    this.activeBankPreparationId = null;
    let receipt: AgentBankActionReceipt;
    try {
      receipt = await openAuthoritativeAgentBank({
        world: this.world,
        playerId: this.playerEntityId,
        bankId,
        preparationId,
      });
    } catch (error) {
      if (
        this.pendingDuelPreparationBankOpen?.preparationId === preparationId &&
        this.pendingDuelPreparationBankOpen.revision === openRevision
      ) {
        this.pendingDuelPreparationBankOpen = null;
      }
      throw error;
    }
    if (
      openRevision !== this.bankOpenRevision ||
      this.pendingDuelPreparationBankOpen?.preparationId !== preparationId ||
      this.pendingDuelPreparationBankOpen.revision !== openRevision
    ) {
      return receipt;
    }
    this.pendingDuelPreparationBankOpen = null;
    if (receipt.success) {
      this.activeBankId = bankId;
      this.activeBankPreparationId = preparationId;
      this.world.emit(EventType.BANK_OPEN, {
        playerId: this.playerEntityId,
        bankId,
        preparationId,
        operationId: receipt.operationId,
      });
    } else {
      this.activeBankId = null;
      this.activeBankPreparationId = null;
    }
    return receipt;
  }

  /**
   * Drop the process-local handle as soon as readiness or a terminal
   * preparation event is observed. The database remains the authority and
   * independently rejects stale transfers; this prevents accidental retries
   * from carrying a capability farther than its intended lifecycle.
   */
  revokeDuelPreparationBankAccess(preparationId: string): void {
    if (this.pendingDuelPreparationBankOpen?.preparationId === preparationId) {
      this.bankOpenRevision += 1;
      this.pendingDuelPreparationBankOpen = null;
    }
    if (this.activeBankPreparationId === preparationId) {
      this.activeBankId = null;
      this.activeBankPreparationId = null;
    }
  }

  async executeBankDeposit(
    itemId: string,
    quantity: number = 1,
    operationId?: string,
  ): Promise<AgentBankActionReceipt> {
    if (!this.playerEntityId || !this.isActive) {
      return createAgentBankFailureReceipt(
        "deposit",
        this.playerEntityId,
        this.activeBankId,
        "player_unavailable",
        { operationId, itemId, quantity },
      );
    }
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: this.world,
      playerId: this.playerEntityId,
      bankId: this.activeBankId,
      action: "deposit",
      itemId,
      quantity,
      operationId,
      preparationId: this.activeBankPreparationId ?? undefined,
    });
    if (receipt.success) {
      this.world.emit(EventType.BANK_DEPOSIT_SUCCESS, receipt);
    }
    return receipt;
  }

  async executeBankWithdraw(
    itemId: string,
    quantity: number = 1,
    operationId?: string,
  ): Promise<AgentBankActionReceipt> {
    if (!this.playerEntityId || !this.isActive) {
      return createAgentBankFailureReceipt(
        "withdraw",
        this.playerEntityId,
        this.activeBankId,
        "player_unavailable",
        { operationId, itemId, quantity },
      );
    }
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: this.world,
      playerId: this.playerEntityId,
      bankId: this.activeBankId,
      action: "withdraw",
      itemId,
      quantity,
      operationId,
      preparationId: this.activeBankPreparationId ?? undefined,
    });
    if (receipt.success) {
      this.world.emit(EventType.BANK_WITHDRAW_SUCCESS, receipt);
    }
    return receipt;
  }

  async executeBankWithdrawPlan(
    items: AgentBankTransferItem[],
    operationId?: string,
  ): Promise<AgentBankActionReceipt> {
    const requestedQuantity = items.reduce(
      (total, item) => total + Number(item.quantity || 0),
      0,
    );
    if (!this.playerEntityId || !this.isActive) {
      return createAgentBankFailureReceipt(
        "withdraw",
        this.playerEntityId,
        this.activeBankId,
        "player_unavailable",
        { operationId, quantity: requestedQuantity },
      );
    }
    // Composite components remain private. The authoritative transaction
    // reloads live inventory, but no component list is broadcast to observers.
    return executeAuthoritativeAgentBankTransfer({
      world: this.world,
      playerId: this.playerEntityId,
      bankId: this.activeBankId,
      action: "withdraw",
      withdrawItems: items,
      operationId,
      preparationId: this.activeBankPreparationId ?? undefined,
    });
  }

  getPrivateCoinBalance(): number | null {
    if (!this.playerEntityId || !this.isActive) return null;
    const coinPouch = this.world.getSystem("coin-pouch") as {
      isPlayerInitialized?: (playerId: string) => boolean;
      getCoins?: (playerId: string) => number;
    } | null;
    if (
      !coinPouch?.getCoins ||
      coinPouch.isPlayerInitialized?.(this.playerEntityId) !== true
    ) {
      return null;
    }
    const coins = Number(coinPouch.getCoins(this.playerEntityId));
    return Number.isSafeInteger(coins) && coins >= 0 ? coins : null;
  }

  async executeBankDepositAll(
    operationId?: string,
    retainedItems?: AgentBankRetainedItem[],
    requestedBankId?: string,
  ): Promise<AgentBankActionReceipt> {
    if (!this.playerEntityId || !this.isActive) {
      return createAgentBankFailureReceipt(
        "deposit_all",
        this.playerEntityId,
        this.activeBankId,
        "player_unavailable",
        { operationId },
      );
    }

    if (this.activeBankPreparationId && this.activeBankId) {
      const receipt = await executeAuthoritativeAgentBankTransfer({
        world: this.world,
        playerId: this.playerEntityId,
        bankId: this.activeBankId,
        action: "deposit_all",
        operationId,
        retainedItems,
        preparationId: this.activeBankPreparationId,
      });
      if (receipt.success && !receipt.replayed) {
        this.world.emit(EventType.BANK_DEPOSIT_SUCCESS, receipt);
      }
      return receipt;
    }

    // Ordinary autonomy may use only an exact loaded bank entity within the
    // same shared physical boundary enforced by the custody service.
    const player = this.world.entities.get(this.playerEntityId);
    if (!player) {
      return createAgentBankFailureReceipt(
        "deposit_all",
        this.playerEntityId,
        null,
        "player_unavailable",
        { operationId },
      );
    }
    const playerPos = this.getEntityPosition(player);
    if (!playerPos) {
      return createAgentBankFailureReceipt(
        "deposit_all",
        this.playerEntityId,
        null,
        "player_unavailable",
        { operationId },
      );
    }

    const requestedExactBankId = requestedBankId?.trim() || null;
    let bankId: string | null = requestedExactBankId;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const [id, entity] of this.world.entities.items.entries()) {
      const data = (entity as { data?: Record<string, unknown> }).data;
      const runtimeEntityType = (entity as { entityType?: unknown }).entityType;
      if (
        data?.type !== "bank" &&
        data?.entityType !== "bank" &&
        runtimeEntityType !== "bank"
      ) {
        continue;
      }
      if (bankId && id !== bankId) continue;
      const pos = this.getEntityPosition(entity);
      if (!pos) continue;
      const dist = Math.max(
        Math.abs(pos[0] - playerPos[0]),
        Math.abs(pos[2] - playerPos[2]),
      );
      if (dist < bestDist) {
        bestDist = dist;
        bankId = id;
      }
    }
    if (!bankId) {
      return createAgentBankFailureReceipt(
        "deposit_all",
        this.playerEntityId,
        null,
        "bank_target_invalid",
        { operationId },
      );
    }
    if (!requestedExactBankId) {
      const accessFailure = validatePhysicalBankAccess(
        this.world,
        this.playerEntityId,
        bankId,
      );
      if (accessFailure) {
        return createAgentBankFailureReceipt(
          "deposit_all",
          this.playerEntityId,
          bankId,
          accessFailure,
          { operationId },
        );
      }
    }
    // The custody transaction performs the final range and duel-state check
    // after it has acquired the per-player mutation locks. Avoiding a separate
    // open-then-transfer phase removes the movement race and also lets an exact
    // committed replay reconcile after the player has moved away.
    const receipt = await executeAuthoritativeAgentBankTransfer({
      world: this.world,
      playerId: this.playerEntityId,
      bankId,
      action: "deposit_all",
      operationId,
      retainedItems,
    });
    if (receipt.success && !receipt.replayed) {
      this.world.emit(EventType.BANK_DEPOSIT_SUCCESS, receipt);
    }
    return receipt;
  }

  // =========================================================================
  // Shopping
  // =========================================================================

  private async executeSecureStoreTransaction(
    handler: (
      socket: ServerSocket,
      data: StoreTransactionRequest,
      world: World,
    ) => Promise<StoreTransactionResult>,
    storeId: string,
    itemId: string,
    quantity: number,
    operationId?: string,
  ): Promise<StoreTransactionResult> {
    const rejected = (): StoreTransactionResult => ({
      status: "rejected",
      operationId: operationId ?? null,
      replayed: false,
    });
    if (!this.playerEntityId || !this.isActive) return rejected();
    if (
      !storeId ||
      !itemId ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      return rejected();
    }

    const player = this.world.entities.get(this.playerEntityId);
    if (!player) return rejected();
    const playerData = (player as { data?: Record<string, unknown> }).data;
    const duelSystem = this.world.getSystem("duel") as {
      isPlayerInDuel?: (playerId: string) => boolean;
    } | null;
    if (
      playerData?.inStreamingDuel === true ||
      duelSystem?.isPlayerInDuel?.(this.playerEntityId)
    ) {
      return rejected();
    }

    const playerPosition = this.getEntityPosition(player);
    if (!playerPosition) return rejected();

    let targetEntityId: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [entityId, entity] of this.world.entities.items.entries()) {
      const data = (entity as { data?: Record<string, unknown> }).data;
      const configuredStoreId = (
        entity as unknown as {
          config?: { storeId?: unknown };
        }
      ).config?.storeId;
      const candidateStoreId =
        typeof data?.storeId === "string"
          ? data.storeId
          : typeof configuredStoreId === "string"
            ? configuredStoreId
            : null;
      if (candidateStoreId !== storeId) continue;

      const position = this.getEntityPosition(entity);
      if (!position) continue;
      const distance = Math.max(
        Math.abs(position[0] - playerPosition[0]),
        Math.abs(position[2] - playerPosition[2]),
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        targetEntityId = entityId;
      }
    }

    if (
      !targetEntityId ||
      nearestDistance > INTERACTION_DISTANCE[SessionType.STORE]
    ) {
      return rejected();
    }

    const sessionManager = (
      this.world as World & {
        interactionSessionManager?: {
          openSession(params: {
            playerId: string;
            socketId: string;
            sessionType: typeof SessionType.STORE;
            targetEntityId: string;
            targetStoreId?: string;
          }): void;
          closeSession(
            playerId: string,
            reason?: "user_action",
            sendPacket?: boolean,
          ): void;
        };
      }
    ).interactionSessionManager;
    if (!sessionManager) return rejected();

    let transactionSucceeded = false;
    const socketId = `embedded-store-${this.playerEntityId}`;
    const internalSocket = {
      id: socketId,
      player,
      send: (packet: string, payload: unknown) => {
        const update = payload as { playerId?: unknown } | null;
        if (
          packet === "inventoryUpdated" &&
          update?.playerId === this.playerEntityId
        ) {
          transactionSucceeded = true;
        }
      },
    } as unknown as ServerSocket;

    sessionManager.openSession({
      playerId: this.playerEntityId,
      socketId,
      sessionType: SessionType.STORE,
      targetEntityId,
      targetStoreId: storeId,
    });
    try {
      const result = await handler(
        internalSocket,
        {
          storeId,
          itemId,
          quantity,
          ...(operationId ? { operationId } : {}),
        },
        this.world,
      );
      if (result.status !== "committed" || transactionSucceeded) return result;
      // The database commit is durable, but live inventory/coin confirmation
      // did not complete. The caller must retry the same operation ID.
      return {
        status: "unknown",
        operationId: result.operationId,
        replayed: false,
      };
    } finally {
      sessionManager.closeSession(this.playerEntityId, "user_action", false);
    }
  }

  async executeStoreBuy(
    storeId: string,
    itemId: string,
    quantity: number = 1,
  ): Promise<boolean> {
    return (
      (
        await this.executeSecureStoreTransaction(
          handleStoreBuy,
          storeId,
          itemId,
          quantity,
        )
      ).status === "committed"
    );
  }

  async executeAuthoritativeStoreBuy(
    storeId: string,
    itemId: string,
    quantity: number,
    operationId: string,
  ): Promise<StoreTransactionResult> {
    return this.executeSecureStoreTransaction(
      handleStoreBuy,
      storeId,
      itemId,
      quantity,
      operationId,
    );
  }

  async executeStoreSell(
    storeId: string,
    itemId: string,
    quantity: number = 1,
  ): Promise<boolean> {
    return (
      (
        await this.executeSecureStoreTransaction(
          handleStoreSell,
          storeId,
          itemId,
          quantity,
        )
      ).status === "committed"
    );
  }

  async executeAuthoritativeStoreSell(
    storeId: string,
    itemId: string,
    quantity: number,
    operationId: string,
  ): Promise<StoreTransactionResult> {
    return this.executeSecureStoreTransaction(
      handleStoreSell,
      storeId,
      itemId,
      quantity,
      operationId,
    );
  }

  // =========================================================================
  // Crafting / Processing
  // =========================================================================

  async executeCook(
    itemId: string,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    const playerId = this.playerEntityId;
    if (!itemId) return false;

    // Find the inventory slot containing the raw food
    const inventory = this.getInventoryItems();
    const slot = inventory.find((s) => s.itemId === itemId);
    if (!slot) return false;

    const processingSystem = this.world.getSystem("processing") as {
      canPlayerUseCookingSource?: (
        playerId: string,
        sourceId: string,
        sourceType: "fire" | "range",
      ) => boolean;
      getActiveFires?: () => Map<
        string,
        {
          id: string;
          isActive: boolean;
          position: { x: number; y: number; z: number };
        }
      >;
    } | null;
    if (!processingSystem?.canPlayerUseCookingSource) return false;

    for (const entity of this.world.entities.values()) {
      if (
        (entity as { entityType?: unknown }).entityType !== "range" ||
        typeof entity.id !== "string" ||
        !processingSystem.canPlayerUseCookingSource(
          playerId,
          entity.id,
          "range",
        )
      ) {
        continue;
      }
      return this.awaitProcessingCompletion(
        EventType.COOKING_COMPLETED,
        (data) => data.playerId === playerId && data.rawItemId === itemId,
        (data) =>
          typeof data.resultItemId === "string" && data.resultItemId.length > 0,
        {
          skill: "cooking",
          rawFoodId: itemId,
          rawFoodSlot: slot.slot,
          sourceId: entity.id,
          sourceType: "range",
        },
        (requestId) =>
          this.emitProcessingEvent(EventType.PROCESSING_COOKING_REQUEST, {
            playerId,
            fishSlot: slot.slot,
            rangeId: entity.id,
            sourceType: "range" as const,
            requestId,
          }),
        autonomyAttemptId,
      );
    }

    for (const [fireId, fire] of processingSystem.getActiveFires?.() ?? []) {
      if (
        !fire.isActive ||
        !processingSystem.canPlayerUseCookingSource(playerId, fireId, "fire")
      ) {
        continue;
      }
      return this.awaitProcessingCompletion(
        EventType.COOKING_COMPLETED,
        (data) => data.playerId === playerId && data.rawItemId === itemId,
        (data) =>
          typeof data.resultItemId === "string" && data.resultItemId.length > 0,
        {
          skill: "cooking",
          rawFoodId: itemId,
          rawFoodSlot: slot.slot,
          sourceId: fireId,
          sourceType: "fire",
        },
        (requestId) =>
          this.emitProcessingEvent(EventType.PROCESSING_COOKING_REQUEST, {
            playerId,
            fishSlot: slot.slot,
            fireId,
            sourceType: "fire" as const,
            requestId,
          }),
        autonomyAttemptId,
      );
    }

    return false;
  }

  async executeSmelt(
    recipe: string,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    const playerId = this.playerEntityId;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(recipe)) return false;

    const smeltingSystem = this.world.getSystem("smelting") as
      | {
          canPlayerUseFurnace?: (
            playerId: string,
            furnaceId: string,
          ) => boolean;
          canPlayerUseActiveFurnace?: (playerId: string) => boolean;
        }
      | undefined;
    if (!smeltingSystem?.canPlayerUseFurnace) return false;

    let furnaceId: string | null = null;
    for (const entity of this.world.entities.values()) {
      if (
        (entity as { entityType?: unknown }).entityType !== "furnace" ||
        typeof entity.id !== "string" ||
        !smeltingSystem.canPlayerUseFurnace(playerId, entity.id)
      ) {
        continue;
      }
      furnaceId = entity.id;
      break;
    }
    if (!furnaceId) return false;

    this.emitProcessingEvent(EventType.SMELTING_INTERACT, {
      playerId,
      furnaceId,
    });
    if (smeltingSystem.canPlayerUseActiveFurnace?.(playerId) !== true) {
      return false;
    }
    return this.awaitProcessingCompletion(
      EventType.SMELTING_COMPLETE,
      (data) => data.playerId === playerId && data.barItemId === recipe,
      (data) =>
        typeof data.totalSmelted === "number" &&
        typeof data.totalFailed === "number" &&
        data.totalSmelted + data.totalFailed > 0,
      {
        skill: "smelting",
        barItemId: recipe,
        furnaceId,
        quantity: 1,
      },
      (requestId) =>
        this.emitProcessingEvent(EventType.PROCESSING_SMELTING_REQUEST, {
          playerId,
          barItemId: recipe,
          furnaceId,
          quantity: 1,
          requestId,
        }),
      autonomyAttemptId,
    );
  }

  async executeSmith(
    recipe: string,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    const playerId = this.playerEntityId;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(recipe)) return false;

    const smithingSystem = this.world.getSystem("smithing") as
      | {
          canPlayerUseAnvil?: (playerId: string, anvilId: string) => boolean;
          canPlayerUseActiveAnvil?: (playerId: string) => boolean;
        }
      | undefined;
    if (!smithingSystem?.canPlayerUseAnvil) return false;

    let anvilId: string | null = null;
    for (const entity of this.world.entities.values()) {
      if (
        (entity as { entityType?: unknown }).entityType !== "anvil" ||
        typeof entity.id !== "string" ||
        !smithingSystem.canPlayerUseAnvil(playerId, entity.id)
      ) {
        continue;
      }
      anvilId = entity.id;
      break;
    }
    if (!anvilId) return false;

    this.emitProcessingEvent(EventType.SMITHING_INTERACT, {
      playerId,
      anvilId,
    });
    if (smithingSystem.canPlayerUseActiveAnvil?.(playerId) !== true) {
      return false;
    }
    return this.awaitProcessingCompletion(
      EventType.SMITHING_COMPLETE,
      (data) => data.playerId === playerId && data.recipeId === recipe,
      (data) => typeof data.totalSmithed === "number" && data.totalSmithed > 0,
      {
        skill: "smithing",
        recipeId: recipe,
        anvilId,
        quantity: 1,
      },
      (requestId) =>
        this.emitProcessingEvent(EventType.PROCESSING_SMITHING_REQUEST, {
          playerId,
          recipeId: recipe,
          anvilId,
          quantity: 1,
          requestId,
        }),
      autonomyAttemptId,
    );
  }

  async executeFiremake(
    logsItemId?: string,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    const playerId = this.playerEntityId;

    const inventory = this.getInventoryItems();
    const tinderboxSlot = inventory.find((i) => i.itemId === "tinderbox");
    if (!tinderboxSlot) return false;

    // Select only logs authored by the loaded firemaking recipe manifest.
    // A supplied inventory ID is not sufficient authority to submit an action.
    const burnableLogIds = processingDataProvider.getBurnableLogIds();
    const logsSlot = logsItemId
      ? burnableLogIds.has(logsItemId)
        ? inventory.find((i) => i.itemId === logsItemId)
        : undefined
      : inventory.find((i) => burnableLogIds.has(i.itemId));
    if (!logsSlot) return false;

    const processingSystem = this.world.getSystem("processing") as
      { canPlayerLightFireHere?: (playerId: string) => boolean } | undefined;
    if (processingSystem?.canPlayerLightFireHere?.(playerId) !== true) {
      return false;
    }

    return this.awaitProcessingCompletion(
      EventType.FIRE_CREATED,
      (data) => data.playerId === playerId,
      (data) => typeof data.fireId === "string" && data.fireId.length > 0,
      {
        skill: "firemaking",
        logsId: logsSlot.itemId,
        logsSlot: logsSlot.slot,
        tinderboxSlot: tinderboxSlot.slot,
      },
      (requestId) =>
        this.emitProcessingEvent(EventType.PROCESSING_FIREMAKING_REQUEST, {
          playerId,
          logsId: logsSlot.itemId,
          logsSlot: logsSlot.slot,
          tinderboxSlot: tinderboxSlot.slot,
          requestId,
        }),
      autonomyAttemptId,
    );
  }

  async executeRunecraft(
    runeType: string,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    const playerId = this.playerEntityId;

    const inventory = this.getInventoryItems();
    const hasEssence = inventory.some(
      (item) =>
        (item.itemId === "rune_essence" || item.itemId === "pure_essence") &&
        item.quantity > 0,
    );
    if (!hasEssence) {
      return false;
    }

    const normalizedRuneType = runeType
      .trim()
      .toLowerCase()
      .replace(/_rune$/, "");
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(normalizedRuneType)) return false;

    const player = this.world.entities.get(playerId);
    if (!player) return false;
    const playerPosition = this.getEntityPosition(player);
    if (!playerPosition) return false;
    const position = {
      x: playerPosition[0],
      y: playerPosition[1],
      z: playerPosition[2],
    };

    let altarId: string | null = null;
    for (const entity of this.world.entities.values()) {
      const altar = entity as unknown as {
        id?: unknown;
        entityType?: unknown;
        runeType?: unknown;
        isPlayerInRange?: (candidate: typeof position) => boolean;
      };
      if (
        altar.entityType !== "runecrafting_altar" ||
        typeof altar.id !== "string" ||
        altar.runeType !== normalizedRuneType ||
        typeof altar.isPlayerInRange !== "function"
      ) {
        continue;
      }
      try {
        if (altar.isPlayerInRange(position)) {
          altarId = altar.id;
          break;
        }
      } catch {
        // A malformed entity must not make the agent invoke runecrafting.
      }
    }
    if (!altarId) return false;

    return this.awaitProcessingCompletion(
      EventType.RUNECRAFTING_COMPLETE,
      (data) =>
        data.playerId === playerId && data.runeType === normalizedRuneType,
      (data) =>
        typeof data.essenceConsumed === "number" &&
        data.essenceConsumed > 0 &&
        typeof data.runesProduced === "number" &&
        data.runesProduced > 0,
      {
        skill: "runecrafting",
        altarId,
        runeType: normalizedRuneType,
      },
      (requestId) =>
        this.emitProcessingEvent(EventType.RUNECRAFTING_INTERACT, {
          playerId,
          altarId,
          runeType: normalizedRuneType,
          requestId,
        }),
      autonomyAttemptId,
    );
  }

  async executeCraft(
    recipeId: string,
    quantity: number = 1,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    const playerId = this.playerEntityId;
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(recipeId) ||
      !Number.isSafeInteger(quantity) ||
      quantity !== 1
    ) {
      return false;
    }

    const craftingSystem = this.world.getSystem("crafting") as
      | {
          getRecipeStation?: (id: string) => "none" | "furnace" | null;
          canPlayerUseCraftingFurnace?: (
            playerId: string,
            furnaceId: string,
          ) => boolean;
          canPlayerUseActiveCraftingFurnace?: (playerId: string) => boolean;
        }
      | undefined;
    const station = craftingSystem?.getRecipeStation?.(recipeId);
    if (!station) return false;
    let recoveryStationId: string | undefined;

    if (station === "furnace") {
      if (!craftingSystem?.canPlayerUseCraftingFurnace) return false;
      let furnaceId: string | null = null;
      for (const entity of this.world.entities.values()) {
        if (
          (entity as { entityType?: unknown }).entityType !== "furnace" ||
          typeof entity.id !== "string" ||
          !craftingSystem.canPlayerUseCraftingFurnace(playerId, entity.id)
        ) {
          continue;
        }
        furnaceId = entity.id;
        break;
      }
      if (!furnaceId) return false;
      recoveryStationId = furnaceId;
      this.emitProcessingEvent(EventType.CRAFTING_INTERACT, {
        playerId,
        triggerType: "furnace",
        stationId: furnaceId,
      });
      if (
        craftingSystem.canPlayerUseActiveCraftingFurnace?.(playerId) !== true
      ) {
        return false;
      }
    }

    return this.awaitProcessingCompletion(
      EventType.CRAFTING_COMPLETE,
      (data) => data.playerId === playerId && data.recipeId === recipeId,
      (data) => typeof data.totalCrafted === "number" && data.totalCrafted > 0,
      {
        skill: "crafting",
        recipeId,
        quantity: 1,
        ...(recoveryStationId ? { stationId: recoveryStationId } : {}),
      },
      (requestId) =>
        this.emitProcessingEvent(EventType.PROCESSING_CRAFTING_REQUEST, {
          playerId,
          recipeId,
          quantity,
          requestId,
        }),
      autonomyAttemptId,
    );
  }

  async executeFletch(
    recipeId: string,
    quantity: number = 1,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    const playerId = this.playerEntityId;
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(recipeId) ||
      !Number.isSafeInteger(quantity) ||
      quantity !== 1
    ) {
      return false;
    }

    return this.awaitProcessingCompletion(
      EventType.FLETCHING_COMPLETE,
      (data) => data.playerId === playerId && data.recipeId === recipeId,
      (data) => typeof data.totalCrafted === "number" && data.totalCrafted > 0,
      {
        skill: "fletching",
        recipeId,
        quantity: 1,
      },
      (requestId) =>
        this.emitProcessingEvent(EventType.PROCESSING_FLETCHING_REQUEST, {
          playerId,
          recipeId,
          quantity,
          requestId,
        }),
      autonomyAttemptId,
    );
  }

  async executeTan(
    inputItemId: string,
    quantity: number = 1,
    autonomyAttemptId?: string,
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    const playerId = this.playerEntityId;
    if (
      !inputItemId ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > 10_000 ||
      (autonomyAttemptId !== undefined && quantity !== 1)
    ) {
      return false;
    }

    const tanningSystem = this.world.getSystem("tanning") as
      | {
          canPlayerUseTanner?: (
            playerId: string,
            npcEntityId: string,
            expectedNpcId?: string,
          ) => boolean;
          canPlayerUseActiveTanner?: (playerId: string) => boolean;
        }
      | undefined;
    if (!tanningSystem?.canPlayerUseTanner) return false;

    let npcEntityId: string | null = null;
    let npcId: string | null = null;
    for (const [entityId, entity] of this.world.entities.items.entries()) {
      const candidate = entity as unknown as {
        config?: { npcType?: unknown; npcId?: unknown };
        data?: { npcType?: unknown; npcId?: unknown };
      };
      const candidateType =
        candidate.config?.npcType ?? candidate.data?.npcType;
      const candidateNpcId = candidate.config?.npcId ?? candidate.data?.npcId;
      if (candidateType !== "tanner" || typeof candidateNpcId !== "string") {
        continue;
      }
      if (
        tanningSystem.canPlayerUseTanner(playerId, entityId, candidateNpcId)
      ) {
        npcEntityId = entityId;
        npcId = candidateNpcId;
        break;
      }
    }
    if (!npcEntityId || !npcId) return false;

    this.emitProcessingEvent(EventType.TANNING_INTERACT, {
      playerId,
      npcId,
      npcEntityId,
    });
    if (tanningSystem.canPlayerUseActiveTanner?.(playerId) !== true) {
      return false;
    }

    return this.awaitProcessingCompletion(
      EventType.TANNING_COMPLETE,
      (data) => data.playerId === playerId && data.inputItemId === inputItemId,
      (data) => typeof data.totalTanned === "number" && data.totalTanned > 0,
      {
        skill: "tanning",
        inputItemId,
        quantity: 1,
        tannerEntityId: npcEntityId,
        tannerNpcId: npcId,
      },
      (requestId) =>
        this.emitProcessingEvent(EventType.TANNING_REQUEST, {
          playerId,
          inputItemId,
          quantity,
          requestId,
        }),
      autonomyAttemptId,
    );
  }

  // =========================================================================
  // Quest / NPC Interaction
  // =========================================================================

  async executeNpcInteract(
    npcId: string,
    interaction: string = "talk",
  ): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    if (!npcId) return false;

    this.world.emit(EventType.NPC_INTERACTION, {
      playerId: this.playerEntityId,
      npcId,
      interaction,
    });
    return true;
  }

  async executeQuestAccept(questId: string): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    if (!questId) return false;

    // Look up which NPC starts this quest
    const questSystem = this.world.getSystem("quest") as {
      getQuestDefinition?: (id: string) => { startNpc?: string } | undefined;
    } | null;
    const questDef = questSystem?.getQuestDefinition?.(questId);
    const startNpcId = questDef?.startNpc;

    if (startNpcId) {
      // Drive through the NPC dialogue to accept the quest naturally.
      // 1. Trigger NPC interaction to start dialogue
      const npcEntity = this.findNpcEntityById(startNpcId);
      if (npcEntity) {
        this.world.emit(EventType.NPC_INTERACTION, {
          playerId: this.playerEntityId,
          npcId: startNpcId,
          npc: {
            id: startNpcId,
            name: npcEntity.name,
            type: "npc",
          },
          npcEntityId: npcEntity.entityId,
          interaction: "talk",
        });

        // 2. Auto-select dialogue responses that lead to quest acceptance.
        //    The dialogue system is synchronous on the server — each emit
        //    is processed before the next line runs.
        this.driveDialogueToQuestAccept(startNpcId, questId);
        return true;
      }
    }

    // Fallback: direct accept if NPC not found
    this.world.emit(EventType.QUEST_START_ACCEPTED, {
      playerId: this.playerEntityId,
      questId,
    });
    return true;
  }

  /**
   * Find an NPC world entity by its manifest npcId (e.g. "captain_rowan").
   */
  private findNpcEntityById(
    npcId: string,
  ): { entityId: string; name: string } | null {
    for (const [id, entity] of this.world.entities.items.entries()) {
      const data = entity.data as Record<string, unknown>;
      const entityNpcId =
        (data.npcId as string) || (data.customId as string) || "";
      if (
        entityNpcId === npcId ||
        (data.npcType &&
          ((data.name as string) || "")
            .toLowerCase()
            .includes(npcId.replace(/_/g, " ").toLowerCase()))
      ) {
        return { entityId: id, name: (data.name as string) || npcId };
      }
    }
    return null;
  }

  /**
   * Automatically drive through a dialogue tree to reach and select the
   * response that triggers `startQuest:<questId>`.
   *
   * Walks through the dialogue by selecting responses that lead toward the
   * quest acceptance effect. Handles multi-step dialogue trees (greeting →
   * quest_offer → quest_accepted).
   */
  private driveDialogueToQuestAccept(npcId: string, questId: string): void {
    if (!this.playerEntityId) return;

    const startQuestEffect = `startQuest:${questId}`;
    const completeQuestEffect = `completeQuest:${questId}`;
    const targetEffect = startQuestEffect;

    // Walk through up to 10 dialogue steps to avoid infinite loops.
    // Server-side events are synchronous — no delays needed.
    for (let step = 0; step < 10; step++) {
      const dialogueSystem = this.world.getSystem("dialogue") as {
        activeDialogues?: Map<
          string,
          {
            npcId: string;
            currentNodeId: string;
            isTerminal?: boolean;
            pendingEffect?: string;
            dialogueTree: {
              nodes: Array<{
                id: string;
                text: string;
                effect?: string;
                responses?: Array<{
                  text: string;
                  nextNodeId: string;
                  effect?: string;
                }>;
              }>;
            };
          }
        >;
      } | null;

      if (!dialogueSystem?.activeDialogues) break;

      const dialogueState = dialogueSystem.activeDialogues.get(
        this.playerEntityId,
      );
      if (!dialogueState || dialogueState.npcId !== npcId) break;

      const currentNode = dialogueState.dialogueTree.nodes.find(
        (n) => n.id === dialogueState.currentNodeId,
      );
      if (!currentNode) break;

      // Terminal node — send continue to execute pending effect and end dialogue
      if (!currentNode.responses || currentNode.responses.length === 0) {
        this.world.emit(EventType.DIALOGUE_CONTINUE, {
          playerId: this.playerEntityId,
          npcId,
        });
        break;
      }

      // Find the response that has the quest effect directly
      let bestResponseIndex = currentNode.responses.findIndex(
        (r) => r.effect === targetEffect || r.effect === completeQuestEffect,
      );

      // If no direct quest effect, pick the first response that isn't a
      // farewell/decline (heuristic: avoid responses containing "later",
      // "no", "goodbye", "farewell")
      if (bestResponseIndex < 0) {
        bestResponseIndex = currentNode.responses.findIndex((r) => {
          const text = r.text.toLowerCase();
          return (
            !text.includes("later") &&
            !text.includes("no ") &&
            !text.includes("goodbye") &&
            !text.includes("farewell") &&
            !text.includes("maybe")
          );
        });
      }

      // Last resort: pick the first response
      if (bestResponseIndex < 0) {
        bestResponseIndex = 0;
      }

      // Select this response
      this.world.emit(EventType.DIALOGUE_RESPONSE, {
        playerId: this.playerEntityId,
        npcId,
        responseIndex: bestResponseIndex,
      });
    }

    // If the quest still hasn't started (QUEST_START_CONFIRM screen), auto-accept
    this.world.emit(EventType.QUEST_START_ACCEPTED, {
      playerId: this.playerEntityId,
      questId,
    });
  }

  async executeQuestComplete(questId: string): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    if (!questId) return false;

    const questSystem = this.world.getSystem("quest") as {
      getQuestDefinition?: (id: string) => { startNpc?: string } | undefined;
      completeQuest?: (playerId: string, questId: string) => Promise<boolean>;
    } | null;

    // Try dialogue-driven completion first (NPC has completeQuest effect in dialogue)
    const questDef = questSystem?.getQuestDefinition?.(questId);
    const startNpcId = questDef?.startNpc;

    if (startNpcId) {
      const npcEntity = this.findNpcEntityById(startNpcId);
      if (npcEntity) {
        this.world.emit(EventType.NPC_INTERACTION, {
          playerId: this.playerEntityId,
          npcId: startNpcId,
          npc: {
            id: startNpcId,
            name: npcEntity.name,
            type: "npc",
          },
          npcEntityId: npcEntity.entityId,
          interaction: "talk",
        });

        // The DialogueSystem will use quest overrides to go to "quest_complete"
        // node which has a `completeQuest:quest_id` effect on the terminal node
        this.driveDialogueToQuestAccept(startNpcId, questId);

        // Check if dialogue drove the completion
        const postState = this.getQuestState();
        if (!postState.some((q) => q.questId === questId)) {
          return true;
        }
      }
    }

    // Fallback: direct QuestSystem completion
    if (!questSystem?.completeQuest) return false;
    return await questSystem.completeQuest(this.playerEntityId, questId);
  }

  /**
   * Query active quest state directly from QuestSystem.
   * Returns current stage, progress, and objective details for each active quest.
   */
  getQuestState(): AgentQuestProgress[] {
    if (!this.playerEntityId || !this.isActive) return [];

    const questSystem = this.world.getSystem("quest") as {
      getActiveQuests?: (playerId: string) => Array<{
        questId: string;
        status: string;
        currentStage: string;
        stageProgress: Record<string, number>;
      }>;
      getQuestDefinition?: (questId: string) =>
        | {
            id: string;
            name: string;
            description: string;
            startNpc: string;
            stages: Array<{
              id: string;
              type: string;
              description: string;
              target?: string;
              count?: number;
              npcId?: string;
            }>;
          }
        | undefined;
    } | null;

    if (!questSystem?.getActiveQuests || !questSystem.getQuestDefinition) {
      return [];
    }

    const activeQuests = questSystem.getActiveQuests(this.playerEntityId);

    // If QuestSystem returned empty, it may not have loaded this agent's state.
    // Re-emit PLAYER_REGISTERED once so the async DB load runs; by the next
    // behavior tick (8s later) the data will be available.
    if (activeQuests.length === 0 && !this._questStateBootstrapEmitted) {
      this._questStateBootstrapEmitted = true;
      this.emitDualChannel("player:registered", {
        playerId: this.playerEntityId,
      });
    }

    return activeQuests.map((progress) => {
      const definition = questSystem.getQuestDefinition!(progress.questId);
      const currentStage = definition?.stages.find(
        (s) => s.id === progress.currentStage,
      );
      return {
        questId: progress.questId,
        name: definition?.name || progress.questId,
        status: progress.status,
        currentStage: progress.currentStage,
        stageDescription: currentStage?.description || "",
        stageProgress: progress.stageProgress,
        stageType: (currentStage?.type ||
          "unknown") as AgentQuestProgress["stageType"],
        stageTarget: currentStage?.target,
        stageCount: currentStage?.count,
        startNpc: definition?.startNpc || "",
      };
    });
  }

  /**
   * Query all quest definitions with their status for this agent.
   * Used to discover which quests are available to start.
   */
  getAvailableQuests(): AgentQuestInfo[] {
    if (!this.playerEntityId || !this.isActive) return [];

    const questSystem = this.world.getSystem("quest") as {
      getAllQuestDefinitions?: () => Array<{
        id: string;
        name: string;
        description: string;
        difficulty: string;
        startNpc: string;
        requirements: {
          quests: string[];
          skills: Record<string, number>;
          items: string[];
        };
        stages: Array<{
          id: string;
          type: string;
          description: string;
          target?: string;
          count?: number;
        }>;
        onStart?: {
          items?: Array<{ itemId: string; quantity: number }>;
        };
        rewards: {
          questPoints: number;
          items: Array<{ itemId: string; quantity: number }>;
          xp: Record<string, number>;
        };
      }>;
      getQuestStatus?: (playerId: string, questId: string) => string;
      canStartQuest?: (playerId: string, questId: string) => boolean;
    } | null;

    if (!questSystem?.getAllQuestDefinitions || !questSystem.getQuestStatus) {
      return [];
    }

    const allDefs = questSystem.getAllQuestDefinitions();
    return allDefs.map((def) => {
      const requirements = def.requirements ?? {
        quests: [],
        skills: {},
        items: [],
      };
      return {
        questId: def.id,
        name: def.name,
        description: def.description,
        difficulty: def.difficulty,
        status: questSystem.getQuestStatus!(this.playerEntityId!, def.id),
        canStart:
          questSystem.canStartQuest?.(this.playerEntityId!, def.id) === true,
        requirements: {
          quests: [...requirements.quests],
          skills: { ...requirements.skills },
          items: [...requirements.items],
        },
        startNpc: def.startNpc,
        onStartItems: def.onStart?.items || [],
        rewardItems: def.rewards.items,
        stages: def.stages.map((s) => ({
          id: s.id,
          type: s.type,
          description: s.description,
          target: s.target,
          count: s.count,
        })),
      };
    });
  }

  /**
   * Get the agent's actual inventory from InventorySystem (not entity data).
   * Entity data.inventory is often empty — the real inventory lives in
   * InventorySystem's playerInventories Map.
   * Uses tick-based caching to avoid per-tick allocations.
   */
  getInventoryItems(): Array<{
    slot: number;
    itemId: string;
    quantity: number;
  }> {
    if (!this.playerEntityId || !this.isActive) return [];

    // Return cached result if same tick
    const currentTick = this.world.currentTick ?? 0;
    if (currentTick === this._inventoryCacheTick) {
      return this._inventoryCache;
    }

    const inventorySystem = this.world.getSystem("inventory") as {
      getInventory?: (playerId: string) =>
        | {
            items: Array<{
              slot: number;
              itemId: string;
              quantity: number;
              item: { id: string; name: string; type: string };
            }>;
          }
        | undefined;
    } | null;

    if (!inventorySystem?.getInventory) return [];

    const inv = inventorySystem.getInventory(this.playerEntityId);
    if (!inv) return [];

    // Reuse existing cache array, updating in-place where possible
    const items = inv.items;
    this._inventoryCache.length = items.length;
    for (let i = 0; i < items.length; i++) {
      const src = items[i];
      let dst = this._inventoryCache[i];
      if (!dst) {
        dst = { slot: 0, itemId: "", quantity: 0 };
        this._inventoryCache[i] = dst;
      }
      dst.slot = src.slot;
      dst.itemId = src.itemId;
      dst.quantity = src.quantity;
    }

    this._inventoryCacheTick = currentTick;
    return this._inventoryCache;
  }

  /** Slot names for equipment - defined once to avoid per-call array creation */
  private static readonly EQUIPMENT_SLOT_NAMES = [
    "weapon",
    "shield",
    "helmet",
    "body",
    "legs",
    "boots",
    "gloves",
    "cape",
    "amulet",
    "ring",
    "arrows",
  ] as const;

  /**
   * Get the agent's currently equipped items from EquipmentSystem.
   * Uses tick-based caching to avoid per-tick allocations.
   */
  getEquippedItems(): Record<string, string | null> {
    if (!this.playerEntityId || !this.isActive) return {};

    // Return cached result if same tick
    const currentTick = this.world.currentTick ?? 0;
    if (currentTick === this._equipmentCacheTick) {
      return this._equipmentCache;
    }

    const equipmentSystem = this.world.getSystem("equipment") as {
      getPlayerEquipment?: (
        playerId: string,
      ) => Record<string, unknown> | undefined;
    } | null;

    if (!equipmentSystem?.getPlayerEquipment) return {};

    const eq = equipmentSystem.getPlayerEquipment(this.playerEntityId);
    if (!eq) return {};

    // Update cached object in-place
    for (const slot of EmbeddedHyperiaService.EQUIPMENT_SLOT_NAMES) {
      const slotData = eq[slot] as
        { itemId?: string | number | null } | null | undefined;
      if (slotData?.itemId) {
        this._equipmentCache[slot] = String(slotData.itemId);
      } else {
        this._equipmentCache[slot] = null;
      }
    }

    this._equipmentCacheTick = currentTick;
    return this._equipmentCache;
  }

  /** Force the next combat observation to read a newly committed loadout. */
  invalidateCombatLoadoutObservation(): void {
    this._equipmentCacheTick = -1;
    this._gameStateCacheTick = -1;
  }

  /**
   * Get the equipped weapon's attack speed in game ticks.
   * Returns the weapon's attackSpeed from item data, or the default (4 ticks).
   */
  getWeaponAttackSpeed(): number {
    const DEFAULT_SPEED = 4;
    if (!this.playerEntityId || !this.isActive) return DEFAULT_SPEED;

    const equipmentSystem = this.world.getSystem("equipment") as {
      getPlayerEquipment?: (
        playerId: string,
      ) => { weapon?: { item?: { attackSpeed?: number; id?: string } } } | null;
    } | null;

    if (!equipmentSystem?.getPlayerEquipment) return DEFAULT_SPEED;

    const eq = equipmentSystem.getPlayerEquipment(this.playerEntityId);
    if (!eq?.weapon?.item) return DEFAULT_SPEED;

    const weapon = eq.weapon.item;
    if (weapon.attackSpeed && weapon.attackSpeed > 0) {
      return weapon.attackSpeed;
    }

    // Fallback: look up from item database
    if (weapon.id) {
      const itemData = getItem(weapon.id);
      if (itemData?.attackSpeed && itemData.attackSpeed > 0) {
        return itemData.attackSpeed;
      }
    }

    return DEFAULT_SPEED;
  }

  /**
   * Get the authoritative weapon/spell range used by ServerNetwork. Duel AI
   * keeps one tile inside this limit so movement and projectile cadence do not
   * fight over an unreachable standoff point.
   */
  getWeaponAttackRange(): number {
    const DEFAULT_RANGE = 1;
    if (!this.playerEntityId || !this.isActive) return DEFAULT_RANGE;

    const networkSystem = this.world.getSystem("network") as
      | {
          getPlayerWeaponRange?: (playerId: string) => number;
        }
      | undefined;
    const range = networkSystem?.getPlayerWeaponRange?.(this.playerEntityId);
    return typeof range === "number" && Number.isFinite(range) && range > 0
      ? range
      : DEFAULT_RANGE;
  }

  /**
   * Get positions of all NPC entities in the world, regardless of distance.
   * Used for quest navigation - agents need to find specific quest NPCs.
   */
  getAllNPCPositions(): Array<{
    id: string;
    name: string;
    npcId: string;
    position: [number, number, number];
  }> {
    if (!this.isActive) return [];

    // NPCs are stationary — cache for 10 seconds to avoid full entity scan per agent
    const now = Date.now();
    if (
      this._npcPositionsCache.length > 0 &&
      now - this._npcPositionsCacheTime <
        EmbeddedHyperiaService.NPC_CACHE_TTL_MS
    ) {
      return this._npcPositionsCache;
    }

    // Use shared entity snapshot (scanned once per second across ALL agent instances)
    const snapshot = getSharedEntitySnapshot(
      this.world as unknown as Parameters<typeof getSharedEntitySnapshot>[0],
      (e) =>
        this.getEntityPosition(
          e as Parameters<typeof this.getEntityPosition>[0],
        ),
    );

    const npcs: Array<{
      id: string;
      name: string;
      npcId: string;
      position: [number, number, number];
    }> = [];

    for (const entry of snapshot) {
      if (!entry.data.npcType && entry.data.type !== "npc") continue;

      const npcId =
        (entry.data.npcId as string) ||
        (entry.data.customId as string) ||
        entry.id;

      npcs.push({
        id: entry.id,
        name: (entry.data.name as string) || npcId,
        npcId,
        position: entry.position,
      });
    }

    this._npcPositionsCache = npcs;
    this._npcPositionsCacheTime = now;
    return npcs;
  }

  // =========================================================================
  // World Map Data (for agent navigation)
  // =========================================================================

  /** Cached world map — built once since map data doesn't change at runtime */
  private _worldMapCache: EmbeddedWorldMapData | null = null;

  /**
   * Get world map data including towns, POIs, resources, stations, and NPCs.
   * Built from ALL_WORLD_AREAS manifest + world systems (TownSystem, POISystem).
   * Matches the shape returned by HyperiaService.getWorldMap() on the client.
   */
  getWorldMap(): EmbeddedWorldMapData | undefined {
    if (this._worldMapCache) return this._worldMapCache;

    const result: EmbeddedWorldMapData = {
      towns: [],
      pois: [],
      resources: [],
      stations: [],
      npcs: [],
    };

    try {
      // Get towns from TownSystem
      const townSystem = this.world.getSystem("towns") as
        | {
            getTowns?: () => Array<{
              id: string;
              name: string;
              position: { x: number; y: number; z: number };
              size: string;
              biome: string;
              buildings: Array<{ type: string }>;
            }>;
          }
        | undefined;

      if (townSystem?.getTowns) {
        for (const t of townSystem.getTowns()) {
          result.towns.push({
            id: t.id,
            name: t.name,
            position: { x: t.position.x, y: t.position.y, z: t.position.z },
            size: t.size,
            biome: t.biome,
            buildings: t.buildings.map((b) => ({ type: b.type })),
          });
        }
      }

      // Get POIs from POISystem
      const poiSystem = this.world.getSystem("pois") as
        | {
            getPOIs?: () => Array<{
              id: string;
              name: string;
              category: string;
              position: { x: number; y: number; z: number };
              biome: string;
            }>;
          }
        | undefined;

      if (poiSystem?.getPOIs) {
        for (const p of poiSystem.getPOIs()) {
          result.pois.push({
            id: p.id,
            name: p.name,
            category: p.category,
            position: { x: p.position.x, y: p.position.y, z: p.position.z },
            biome: p.biome,
          });
        }
      }

      // Get resources, stations, and NPCs from ALL_WORLD_AREAS manifest
      for (const area of Object.values(ALL_WORLD_AREAS)) {
        for (const resource of area.resources) {
          result.resources.push({
            type: resource.type,
            resourceId: resource.resourceId,
            position: {
              x: resource.position.x,
              y: resource.position.y,
              z: resource.position.z,
            },
            areaId: area.id,
          });
        }

        if (area.stations) {
          for (const station of area.stations) {
            result.stations.push({
              id: station.id,
              type: station.type,
              position: {
                x: station.position.x,
                y: station.position.y,
                z: station.position.z,
              },
              areaId: area.id,
            });
          }
        }

        for (const npc of area.npcs) {
          result.npcs.push({
            id: npc.id,
            type: npc.type,
            name: npc.name,
            position: {
              x: npc.position.x,
              y: npc.position.y,
              z: npc.position.z,
            },
            areaId: area.id,
          });
        }
      }
    } catch {
      // Graceful fallback — map data is optional
    }

    this._worldMapCache = result;
    return result;
  }

  /**
   * Compact world-map lines for dashboard LLM prompts (chat + character vision).
   * Uses player position when spawned to sort nearest towns/POIs/resources.
   */
  formatMapAwarenessForLlm(): string {
    const map = this.getWorldMap();
    if (!map) {
      return "(World map summary unavailable.)";
    }
    const total =
      map.towns.length +
      map.pois.length +
      map.resources.length +
      map.stations.length +
      map.npcs.length;
    if (total === 0) {
      return "(No static map entries loaded.)";
    }

    const pos = this.getGameState()?.position;
    const distSq = (
      a: [number, number, number],
      b: { x: number; y: number; z: number },
    ): number => {
      const dx = a[0] - b.x;
      const dy = a[1] - b.y;
      const dz = a[2] - b.z;
      return dx * dx + dy * dy + dz * dz;
    };

    const lines: string[] = [];

    if (pos) {
      const nearestTowns = map.towns
        .map((t) => ({ t, d: distSq(pos, t.position) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 6);
      if (nearestTowns.length > 0) {
        lines.push(
          `Nearest towns: ${nearestTowns
            .map(
              ({ t, d }) =>
                `${t.name} (~${Math.sqrt(d).toFixed(0)}m, ${t.biome})`,
            )
            .join("; ")}`,
        );
      }

      const nearestPois = map.pois
        .map((p) => ({ p, d: distSq(pos, p.position) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 5);
      if (nearestPois.length > 0) {
        lines.push(
          `Nearest POIs: ${nearestPois
            .map(
              ({ p, d }) =>
                `${p.name} [${p.category}] (~${Math.sqrt(d).toFixed(0)}m)`,
            )
            .join("; ")}`,
        );
      }

      const nearestRes = map.resources
        .map((r) => ({ r, d: distSq(pos, r.position) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 5);
      if (nearestRes.length > 0) {
        lines.push(
          `Nearest resource nodes: ${nearestRes
            .map(
              ({ r, d }) =>
                `${r.type}/${r.resourceId} (~${Math.sqrt(d).toFixed(0)}m, ${r.areaId})`,
            )
            .join("; ")}`,
        );
      }

      const nearestSt = map.stations
        .map((s) => ({ s, d: distSq(pos, s.position) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 4);
      if (nearestSt.length > 0) {
        lines.push(
          `Nearest stations: ${nearestSt
            .map(
              ({ s, d }) =>
                `${s.id} [${s.type}] (~${Math.sqrt(d).toFixed(0)}m)`,
            )
            .join("; ")}`,
        );
      }
    } else {
      if (map.towns.length > 0) {
        lines.push(
          `Towns (sample): ${map.towns
            .slice(0, 8)
            .map((t) => `${t.name} (${t.biome})`)
            .join(", ")}`,
        );
      }
      if (map.pois.length > 0) {
        lines.push(
          `POIs (sample): ${map.pois
            .slice(0, 6)
            .map((p) => `${p.name} [${p.category}]`)
            .join(", ")}`,
        );
      }
    }

    lines.push(
      `World map counts: ${map.towns.length} towns, ${map.pois.length} POIs, ${map.resources.length} resources, ${map.stations.length} stations, ${map.npcs.length} manifest NPCs.`,
    );

    return lines.join("\n");
  }

  // =========================================================================
  // Combat Advanced
  // =========================================================================

  async executeUnequip(slot: string): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    if (!slot) return false;

    return (await this.executeUnequipOwned(slot)).ok;
  }

  async executeSetAutoRetaliate(enabled: boolean): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;

    const player = this.world.entities.get(this.playerEntityId);
    if (!player) return false;

    player.data.autoRetaliate = enabled;
    return true;
  }

  // =========================================================================
  // Prayer Advanced
  // =========================================================================

  async executePrayerDeactivateAll(): Promise<PrayerActionReceipt> {
    const operationId = `agent-prayer-deactivate-all:${crypto.randomUUID()}`;
    const failure = (
      reason: PrayerActionReceipt["reason"],
      message: string,
    ): PrayerActionReceipt => ({
      success: false,
      committed: false,
      playerId: this.playerEntityId ?? "",
      operationId,
      replayed: false,
      pointUnits: 0,
      points: 0,
      maxPoints: 1,
      activePrayers: [],
      reason,
      message,
    });
    if (!this.playerEntityId || !this.isActive) {
      return failure("player_not_initialized", "Agent not spawned");
    }

    const prayerSystem = this.world.getSystem("prayer") as {
      deactivateAllPrayers?: (
        playerId: string,
        operationId?: string,
      ) => Promise<PrayerActionReceipt>;
    } | null;

    if (!prayerSystem?.deactivateAllPrayers) {
      return failure(
        "atomic_persistence_unavailable",
        "Prayer system unavailable",
      );
    }
    try {
      const receipt = await prayerSystem.deactivateAllPrayers(
        this.playerEntityId,
        operationId,
      );
      this._gameStateCacheTick = -1;
      return receipt;
    } catch (error) {
      console.warn(
        "[EmbeddedHyperiaService] Prayer deactivation failed:",
        errMsg(error),
      );
      return failure("persistence_failed", "Prayer deactivation failed");
    }
  }

  // =========================================================================
  // Trading
  // =========================================================================

  async executeTradeRequest(targetPlayerId: string): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    if (!targetPlayerId) return false;

    this.world.emit("trade:request", {
      playerId: this.playerEntityId,
      targetPlayerId,
    });
    return true;
  }

  // =========================================================================
  // Utility
  // =========================================================================

  async executeFollow(targetEntityId: string): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;
    if (!targetEntityId) return false;

    const target = this.world.entities.get(targetEntityId);
    if (!target) return false;

    const targetPos = this.getEntityPosition(target);
    if (!targetPos) return false;

    return this.executeMove(targetPos, true);
  }

  async executeRespawn(): Promise<boolean> {
    if (!this.playerEntityId || !this.isActive) return false;

    const deathSystem = this.world.getSystem("player-death") as
      | {
          requestPlayerRespawn?: (playerId: string) => Promise<boolean>;
        }
      | undefined;
    if (!deathSystem?.requestPlayerRespawn) return false;

    try {
      return await deathSystem.requestPlayerRespawn(this.playerEntityId);
    } catch (error) {
      console.warn(
        "[EmbeddedHyperiaService] Respawn request failed:",
        errMsg(error),
      );
      return false;
    }
  }

  isSpawned(): boolean {
    return this.isActive && this.playerEntityId !== null;
  }

  getPlayerId(): string | null {
    return this.playerEntityId;
  }

  onGameEvent(event: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  offGameEvent(event: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Normalize position to [x, y, z] array format
   */
  private normalizePosition(pos: unknown): [number, number, number] | null {
    if (Array.isArray(pos) && pos.length >= 3) {
      return [pos[0], pos[1], pos[2]];
    }
    if (pos && typeof pos === "object" && "x" in pos) {
      const objPos = pos as { x: number; y?: number; z?: number };
      return [objPos.x, objPos.y ?? 0, objPos.z ?? 0];
    }
    return null;
  }

  /**
   * Prefer authoritative entity transform, then fall back to serialized data.
   */
  private getEntityPosition(entity: {
    position?: { x?: number; y?: number; z?: number };
    data?: { position?: unknown };
  }): [number, number, number] | null {
    const x = entity.position?.x;
    const y = entity.position?.y;
    const z = entity.position?.z;
    if (
      typeof x === "number" &&
      Number.isFinite(x) &&
      typeof y === "number" &&
      Number.isFinite(y) &&
      typeof z === "number" &&
      Number.isFinite(z)
    ) {
      return [x, y, z];
    }

    return this.normalizePosition(entity.data?.position);
  }

  /**
   * Read an entity's current authoritative transform without the shared
   * nearby-entity snapshot cache. Duel steering uses this for both contestants
   * because a one-second perception snapshot is long enough for two running
   * actors to cross and choose converging paths.
   */
  getLiveEntityPosition(entityId: string): [number, number, number] | null {
    const entity = this.world.entities.get(entityId);
    return entity ? this.getEntityPosition(entity) : null;
  }

  /**
   * Resolve exact server-owned interaction geometry for stations, stores, and
   * authored resources so embedded agents stop on a legal adjacent tile.
   */
  private resolveInteractionMovementArrival(
    target: [number, number, number],
  ): EmbeddedInteractionArrival | undefined {
    const targetTileX = Math.floor(target[0]);
    const targetTileZ = Math.floor(target[2]);
    for (const entity of this.world.entities.values()) {
      const runtime = entity as unknown as {
        entityType?: unknown;
        type?: unknown;
        data?: Record<string, unknown>;
        config?: Record<string, unknown>;
        getInteractionRange?: () => unknown;
        getInteractionFootprint?: () => unknown;
      };
      const runtimeType = String(
        runtime.entityType ?? runtime.data?.type ?? runtime.type ?? "",
      ).toLowerCase();
      const npcType = String(
        runtime.config?.npcType ?? runtime.data?.npcType ?? "",
      ).toLowerCase();
      const isPreparationStation =
        runtimeType === "furnace" ||
        runtimeType === "anvil" ||
        runtimeType === "range" ||
        runtimeType === "runecrafting_altar" ||
        runtimeType === "bank" ||
        npcType === "tanner" ||
        typeof (runtime.config?.storeId ?? runtime.data?.storeId) === "string";
      const isAuthoredResource =
        runtimeType === "resource" ||
        typeof (runtime.config?.resourceId ?? runtime.data?.resourceId) ===
          "string";
      if (!isPreparationStation && !isAuthoredResource) continue;

      const position = this.getEntityPosition(entity);
      if (
        !position ||
        Math.floor(position[0]) !== targetTileX ||
        Math.floor(position[2]) !== targetTileZ
      ) {
        continue;
      }

      const interactionRange = Number(runtime.getInteractionRange?.());
      const footprint = runtime.getInteractionFootprint?.() as
        { width?: unknown; depth?: unknown } | undefined;
      const footprintWidth = Number(footprint?.width ?? 1);
      const footprintDepth = Number(footprint?.depth ?? 1);
      if (
        !Number.isFinite(interactionRange) ||
        interactionRange < 1 ||
        interactionRange > 10 ||
        !Number.isSafeInteger(footprintWidth) ||
        footprintWidth < 1 ||
        footprintWidth > 10 ||
        !Number.isSafeInteger(footprintDepth) ||
        footprintDepth < 1 ||
        footprintDepth > 10
      ) {
        continue;
      }
      return { interactionRange, footprintWidth, footprintDepth };
    }
    return undefined;
  }

  private requestNetworkMove(
    target: [number, number, number],
    runMode: boolean,
    interactionArrival?: EmbeddedInteractionArrival,
  ): boolean | null {
    if (!this.playerEntityId) {
      return false;
    }

    const networkSystem = this.world.getSystem("network") as
      | {
          requestServerMove?: (
            playerId: string,
            target: [number, number, number],
            options?: {
              runMode?: boolean;
              interactionArrival?: EmbeddedInteractionArrival;
            },
          ) => boolean;
        }
      | undefined;

    if (!networkSystem?.requestServerMove) {
      return null;
    }

    return (
      networkSystem.requestServerMove(this.playerEntityId, target, {
        runMode,
        ...(interactionArrival ? { interactionArrival } : {}),
      }) !== false
    );
  }

  private cancelNetworkMove(): boolean {
    if (!this.playerEntityId) {
      return false;
    }

    const networkSystem = this.world.getSystem("network") as
      | {
          cancelServerMove?: (playerId: string) => boolean;
        }
      | undefined;

    if (!networkSystem?.cancelServerMove) {
      return false;
    }

    return networkSystem.cancelServerMove(this.playerEntityId) !== false;
  }

  /**
   * Read the authoritative tile path immediately after a server-agent move.
   * Used only for duel launch telemetry; normal agent behavior does not poll it.
   */
  getMovementDebugState(): {
    activePath: boolean;
    currentTile: { x: number; z: number } | null;
    nextTile: { x: number; z: number } | null;
    destinationTile: { x: number; z: number } | null;
    remainingPathTiles: number;
    moveSeq: number;
  } | null {
    if (!this.playerEntityId) return null;

    const networkSystem = this.world.getSystem("network") as
      | {
          getServerMovementDebug?: (playerId: string) => {
            activePath: boolean;
            currentTile: { x: number; z: number } | null;
            nextTile: { x: number; z: number } | null;
            destinationTile: { x: number; z: number } | null;
            remainingPathTiles: number;
            moveSeq: number;
          } | null;
        }
      | undefined;
    return networkSystem?.getServerMovementDebug?.(this.playerEntityId) ?? null;
  }

  /**
   * Categorize an entity by its data
   */
  private categorizeEntity(
    data: Record<string, unknown>,
  ): "player" | "mob" | "npc" | "item" | "resource" | "object" {
    if (data.type === "player") return "player";
    if (data.mobType || data.type === "mob") return "mob";
    if (data.npcType || data.type === "npc") return "npc";
    if (data.itemId || data.type === "item" || data.isItem) return "item";
    if (data.resourceType || data.type === "resource") return "resource";
    const typeStr = String(data.type || "").toLowerCase();
    if (
      typeStr === "tree" ||
      typeStr === "rock" ||
      typeStr === "ore" ||
      typeStr === "fishing_spot" ||
      typeStr === "mining_rock"
    ) {
      return "resource";
    }
    return "object";
  }

  /**
   * Ground spawn position directly to terrain height so agents do not
   * spawn hovering above or clipping below terrain.
   */
  private shouldUseStreamingSpawnPosition(): boolean {
    return (
      this.characterId.startsWith("agent-") &&
      process.env.STREAMING_DUEL_ENABLED !== "false"
    );
  }

  private getStreamingAgentSpawnPosition(): [number, number, number] {
    const lobby = getDuelArenaConfig().lobbySpawnPoint;

    // Stable deterministic spread around the lobby to prevent overlapping spawns.
    let hash = 0;
    for (let i = 0; i < this.characterId.length; i++) {
      hash = (hash * 31 + this.characterId.charCodeAt(i)) >>> 0;
    }

    const angle = ((hash % 360) * Math.PI) / 180;
    const radius = 6 + (hash % 4); // 6-9m ring around lobby center

    return [
      lobby.x + Math.cos(angle) * radius,
      lobby.y,
      lobby.z + Math.sin(angle) * radius,
    ];
  }

  private groundSpawnPosition(
    position: [number, number, number],
  ): [number, number, number] {
    const terrain = this.world.getSystem("terrain") as
      | {
          getHeightAt?: (x: number, z: number) => number;
        }
      | undefined;

    const terrainY = terrain?.getHeightAt?.(position[0], position[2]);
    if (typeof terrainY !== "number" || !Number.isFinite(terrainY)) {
      return position;
    }

    return [position[0], terrainY + 0.1, position[2]];
  }
}
