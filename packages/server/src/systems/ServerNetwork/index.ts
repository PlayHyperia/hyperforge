/**
 * ServerNetwork - Authoritative multiplayer networking system
 *
 * Coordinates between specialized modules to handle all server networking:
 * - authentication.ts, character-selection.ts, movement modules
 * - socket-management.ts, broadcast.ts, save-manager.ts
 * - position-validator.ts, event-bridge.ts, initialization.ts
 * - connection-handler.ts, duel-events.ts, duel-settlement.ts
 * - handlers/* (chat, combat, inventory, processing, etc.)
 *
 * AUDIT-002 (ASSESSED): File is ~3K lines (116KB). ServerNetwork is already
 * heavily decomposed into 30+ modules including handlers/, services/, movement/
 * directories. This file is the coordinator that ties together:
 * - authentication.ts, character-selection.ts, socket-management.ts
 * - broadcast.ts, save-manager.ts, position-validator.ts, event-bridge.ts
 * - Full handlers/ directory (bank/, duel/, trade/, chat, combat, inventory, etc.)
 * Current structure is appropriate for a central networking coordinator.
 */

import type {
  ConnectionParams,
  NetworkWithSocket,
  NodeWebSocket,
  SpawnData,
  WorldOptions,
  SystemDatabase,
  ServerSocket,
} from "../../shared/types";
import {
  Socket,
  System,
  hasRole,
  isDatabaseInstance,
  World,
  EventType,
  CombatSystem,
  ResourceSystem,
  COMBAT_CONSTANTS,
  canPlayerPerformPreparationAction,
  worldToTile,
  tilesWithinMeleeRange,
  tileChebyshevDistance,
  getItem,
  DeathState,
  AttackType,
  WeaponType,
  type EventMap,
  writePacket,
  TERRAIN_CONSTANTS,
  TICK_DURATION_MS,
  MobEntity,
} from "@hyperforge/shared";

// Payload types (extracted to types.ts)
import type {
  QueueItem,
  NetworkHandler,
  PlayerDeathSystemWithTick,
  SpatialBroadcastPayload,
  AttackMobPayload,
  AttackPlayerPayload,
  LegacyInputPayload,
  SetAutocastPayload,
  AgentGoalSyncPayload,
  AgentThoughtSyncPayload,
  NpcInteractPayload,
  EntityInteractPayload,
  PlayerTeleportPayload,
  PlayerMovementCancelPayload,
  CoinAmountPayload,
  BankOpenPayload,
  BankDepositPayload,
  BankWithdrawPayload,
  BankDepositAllPayload,
  BankMovePayload,
  BankCreateTabPayload,
  BankDeleteTabPayload,
  BankMoveToTabPayload,
  BankItemPayload,
  BankSlotPayload,
  BankWithdrawToEquipmentPayload,
  BankDepositEquipmentPayload,
  DialogueResponsePayload,
  DialogueNpcPayload,
  QuestIdPayload,
  StoreOpenPayload,
  StoreItemPayload,
  StoreClosePayload,
  TradeRequestPayload,
  TradeRespondPayload,
  TradeItemPayload,
  TradeSlotPayload,
  TradeSetQuantityPayload,
  TradeIdPayload,
  DuelChallengePayload,
  DuelChallengeRespondPayload,
  DuelToggleRulePayload,
  DuelToggleEquipmentPayload,
  DuelIdPayload,
  DuelAddStakePayload,
  DuelRemoveStakePayload,
  FriendTargetNamePayload,
  FriendRequestIdPayload,
  FriendIdPayload,
  IgnoreIdPayload,
  PrivateMessagePayload,
  CorpseLootAllPayload,
} from "./types";

// Import modular components
import {
  handleCharacterListRequest,
  handleCharacterCreate,
  handleCharacterSelected,
  handleEnterWorld,
  collectInitialSyncEntities,
} from "./character-selection";
import { TileMovementManager } from "./tile-movement";
import { MobTileMovementManager } from "./mob-tile-movement";
import { ActionQueue } from "./action-queue";
import { TickSystem, TickPriority } from "../TickSystem";
import { SocketManager } from "./socket-management";
import { resolveReconnectAgentFlags } from "./reconnect-agent-flags.js";
import { BroadcastManager } from "./broadcast";
import { PacketPriority } from "./BandwidthBudget";
import { SpatialIndex } from "./SpatialIndex";
import { SaveManager } from "./save-manager";
import { PositionValidator } from "./position-validator";
import { EventBridge } from "./event-bridge";
import { InitializationManager } from "./initialization";
import { ConnectionHandler } from "./connection-handler";
import { InteractionSessionManager } from "./InteractionSessionManager";
import { handleChatAdded } from "./handlers/chat";
import {
  destroyAllRateLimiters,
  getGlobalSocketRateLimiter,
  getUnknownMessageRateLimiter,
} from "./services/SlidingWindowRateLimiter";
import {
  handleAttackPlayer,
  handleChangeAttackStyle,
  handleSetAutoRetaliate,
} from "./handlers/combat";
import {
  handlePickupItem,
  handleDropItem,
  handleEquipItem,
  handleUseItem,
  handleUnequipItem,
  handleMoveItem,
  handleCoinPouchWithdraw,
  handleXpLampUse,
} from "./handlers/inventory";
import {
  handlePrayerToggle,
  handlePrayerDeactivateAll,
  handleAltarPray,
} from "./handlers/prayer";
import { handleSetAutocast } from "./handlers/magic";
import { handleResourceGather } from "./handlers/resources";
import {
  handleActionBarSave,
  handleActionBarLoad,
} from "./handlers/action-bar";
import {
  handleBankOpen,
  handleBankDeposit,
  handleBankWithdraw,
  handleBankDepositAll,
  handleExternalAgentBankTransfer,
  handleExternalAgentBankRecovery,
  handleBankDepositCoins,
  handleBankWithdrawCoins,
  handleBankClose,
  handleBankMove,
  handleBankCreateTab,
  handleBankDeleteTab,
  handleBankMoveToTab,
  handleBankWithdrawPlaceholder,
  handleBankReleasePlaceholder,
  handleBankReleaseAllPlaceholders,
  handleBankToggleAlwaysPlaceholder,
  handleBankWithdrawToEquipment,
  handleBankDepositEquipment,
  handleBankDepositAllEquipment,
  handleRequestBankState,
} from "./handlers/bank";
import {
  handleEntityModified,
  handleEntityEvent,
  handleEntityRemoved,
  handleSettings,
} from "./handlers/entities";
import { handleCommand } from "./handlers/commands";
import {
  handleStoreOpen,
  handleStoreBuy,
  handleStoreSell,
  handleStoreClose,
} from "./handlers/store";
import {
  handleDialogueResponse,
  handleDialogueContinue,
  handleDialogueClose,
} from "./handlers/dialogue";
import {
  handleGetQuestList,
  handleGetQuestDetail,
  handleQuestAccept,
  handleQuestAbandon,
  handleQuestComplete,
} from "./handlers/quest";
import {
  handleResourceInteract,
  handleCookingSourceInteract,
  handleFiremakingRequest,
  handleCookingRequest,
  handleSmeltingSourceInteract,
  handleProcessingSmelting,
  handleSmithingSourceInteract,
  handleProcessingSmithing,
  handleCraftingSourceInteract,
  handleProcessingCrafting,
  handleFletchingSourceInteract,
  handleProcessingFletching,
  handleProcessingTanning,
  handleRunecraftingAltarInteract,
  handleProcessingRequestStatus,
  handleProcessingRequestRecovery,
  type ProcessingHandlerContext,
} from "./handlers/processing";
import { PendingAttackManager } from "./PendingAttackManager";
import { PendingGatherManager } from "./PendingGatherManager";
import { PendingCookManager } from "./PendingCookManager";
import { PendingTradeManager } from "./PendingTradeManager";
import { PendingDuelChallengeManager } from "./PendingDuelChallengeManager";
import { FollowManager } from "./FollowManager";
import { FaceDirectionManager } from "./FaceDirectionManager";
import { handleFollowPlayer, handleChangePlayerName } from "./handlers/player";
import {
  initHomeTeleportManager,
  getHomeTeleportManager,
  handleHomeTeleport,
  handleHomeTeleportCancel,
} from "./handlers/home-teleport";
import {
  handleTradeRequest,
  handleTradeRequestRespond,
  handleTradeAddItem,
  handleTradeRemoveItem,
  handleTradeSetQuantity,
  handleTradeAccept,
  handleTradeCancelAccept,
  handleTradeCancel,
} from "./handlers/trade";
import {
  handleFriendRequest,
  handleFriendAccept,
  handleFriendDecline,
  handleFriendRemove,
  handleIgnoreAdd,
  handleIgnoreRemove,
  handlePrivateMessage,
} from "./handlers/friends";
import { TradingSystem } from "../TradingSystem";
import { DuelSystem } from "../DuelSystem";
import { DuelScheduler, DuelBettingBridge } from "../DuelScheduler";
import {
  handleDuelChallenge,
  handleDuelChallengeRespond,
  handleDuelToggleRule,
  handleDuelToggleEquipment,
  handleDuelAcceptRules,
  handleDuelCancel,
  handleDuelAddStake,
  handleDuelRemoveStake,
  handleDuelAcceptStakes,
  handleDuelAcceptFinal,
  handleDuelForfeit,
} from "./handlers/duel";
import { handleDuelPreparationHostLease } from "./handlers/duel/preparation-host-lease";
import { handleDuelPreparationStrategy } from "./handlers/duel/preparation-strategy";
import { getDatabase } from "./handlers/common";
import { registerDuelEventListeners } from "./duel-events";
import type { UwsWebSocketAdapter } from "../../startup/UwsWebSocketAdapter";

const DEBUG_ATTACK_MOB =
  process.env.DEBUG_ATTACK_MOB === "true" ||
  process.env.DEBUG_ATTACK_MOB === "1";
const DEBUG_AGENT_DASHBOARD_SYNC =
  process.env.DEBUG_AGENT_DASHBOARD_SYNC === "true" ||
  process.env.DEBUG_AGENT_DASHBOARD_SYNC === "1";
const DEBUG_DUEL_PACKET_TRAFFIC =
  process.env.DEBUG_DUEL_PACKET_TRAFFIC === "true" ||
  process.env.DEBUG_DUEL_PACKET_TRAFFIC === "1";

interface NetworkMessageMetric {
  method: string;
  received: number;
  inFlight: number;
  peakInFlight: number;
  errors: number;
  lastSeenAt: number;
}
const IS_PLAYWRIGHT_TEST = process.env.PLAYWRIGHT_TEST === "true";
const PLAYWRIGHT_LOG_THROTTLE_MS = Math.max(
  1000,
  parseInt(process.env.PLAYWRIGHT_LOG_THROTTLE_MS || "15000", 10),
);
const playwrightWarningLogAt = new Map<string, number>();

function warnPlaywrightThrottled(
  key: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!IS_PLAYWRIGHT_TEST) {
    if (data) console.warn(message, data);
    else console.warn(message);
    return;
  }
  const now = Date.now();
  const last = playwrightWarningLogAt.get(key) ?? 0;
  if (now - last < PLAYWRIGHT_LOG_THROTTLE_MS) return;
  playwrightWarningLogAt.set(key, now);
  if (data) console.warn(message, data);
  else console.warn(message);
}

function traceAttackMob(stage: string, data?: Record<string, unknown>): void {
  if (!DEBUG_ATTACK_MOB) return;
  if (data && Object.keys(data).length > 0) {
    console.log(`[AttackMobTrace] ${stage}`, JSON.stringify(data));
    return;
  }
  console.log(`[AttackMobTrace] ${stage}`);
}
import { executeDuelStakeTransferWithRetry } from "./duel-settlement";

const defaultSpawn = '{ "position": [0, 50, 0], "quaternion": [0, 0, 0, 1] }';

/**
 * Normalize manifest weapon metadata into the runtime attack enum. Item JSON
 * uses uppercase values while the runtime enum is lowercase; returning the raw
 * manifest string makes ranged pathfinding fall through to melee positioning.
 * Magic weapons without a selected spell intentionally remain melee here.
 */
export function resolveWeaponAttackType(
  attackType?: string | null,
  weaponType?: string | null,
): AttackType {
  const normalizedAttackType = String(attackType ?? "")
    .trim()
    .toLowerCase();
  if (normalizedAttackType === AttackType.RANGED) {
    return AttackType.RANGED;
  }

  const normalizedWeaponType = String(weaponType ?? "")
    .trim()
    .toLowerCase();
  if (normalizedWeaponType === "bow" || normalizedWeaponType === "crossbow") {
    return AttackType.RANGED;
  }

  return AttackType.MELEE;
}

/**
 * Classify whether an attack request repeats an already authoritative intent.
 * Kept pure so socket and server-agent request behavior can share a precise,
 * directly testable target/type contract.
 */
export function classifyRedundantAttackRequest(
  targetId: string,
  targetType: "mob" | "player",
  combatData:
    | {
        inCombat?: boolean;
        targetId?: string;
        targetType?: "mob" | "player";
      }
    | null
    | undefined,
  pendingTargetId: string | null,
): "active_same_target" | "pending_same_target" | null {
  if (
    combatData?.inCombat &&
    combatData.targetType === targetType &&
    String(combatData.targetId ?? "") === targetId
  ) {
    return "active_same_target";
  }

  if (pendingTargetId === targetId) {
    return "pending_same_target";
  }

  return null;
}

/**
 * DuelCombatAI is the single movement owner while an arena fight is active.
 * Generic combat-follow is correct for normal click-to-attack play, but if it
 * also steers an AI dueler it replaces the kiting path and makes both actors
 * converge on the same target tile.
 */
export function isDuelAiMovementOwned(entityData: unknown): boolean {
  return (
    typeof entityData === "object" &&
    entityData !== null &&
    (entityData as { duelAiControlsMovement?: boolean })
      .duelAiControlsMovement === true
  );
}

/**
 * ServerNetwork - Authoritative multiplayer networking system
 *
 * Coordinates between specialized modules to handle all server networking.
 * This refactored version delegates most logic to focused modules while
 * maintaining the same external API.
 */
export class ServerNetwork extends System implements NetworkWithSocket {
  /** Unique network ID (incremented for each connection) */
  id: number;

  /** Counter for assigning network IDs */
  ids: number;

  /** Map of all active WebSocket connections by socket ID */
  sockets: Map<string, ServerSocket>;

  /** Flag indicating this is the server network (true) */
  isServer: boolean;

  /** Flag indicating this is a client network (false) */
  isClient: boolean;

  /** Queue of outgoing messages to be batched and sent */
  queue: QueueItem[];

  /** Database instance for persistence operations */
  db!: SystemDatabase;

  /** Default spawn point for new players */
  spawn: SpawnData;

  /** Maximum upload file size in bytes */
  maxUploadSize: number;

  /** Handler method registry */
  private handlers: Record<string, NetworkHandler> = {};

  /** Idempotency guard: prevents double-settlement of duel stakes */
  private processedDuelSettlements: Set<string> = new Set();

  /** Agent goal storage (characterId -> goal data) for dashboard display */
  static agentGoals: Map<string, unknown> = new Map();

  /** Agent available goals storage (characterId -> available goals) for dashboard selection */
  static agentAvailableGoals: Map<string, unknown[]> = new Map();

  /** Recent embedded-agent activity and aggregate session counters. */
  static agentActivity: Map<
    string,
    {
      recentActions: Array<{
        type: string;
        description: string;
        xpGained?: number;
        timestamp: number;
      }>;
      sessionStats: {
        kills: number;
        deaths: number;
        totalXpGained: number;
        goldEarned: number;
        resourcesGathered: Record<string, number>;
      };
    }
  > = new Map();

  /** Per-phase timing (ms) for tickHealth diagnostics */
  private _lastMobAITime = 0;
  private _lastMobMoveTime = 0;
  private _lastCombatTime = 0;

  /** Agent goals paused state (characterId -> boolean) for dashboard display */
  static agentGoalsPaused: Map<string, boolean> = new Map();

  /** Character ID to socket mapping for sending goal overrides */
  static characterSockets: Map<string, ServerSocket> = new Map();

  /** Agent personality traits (characterId -> traits) for dashboard display */
  static agentPersonality: Map<
    string,
    {
      sociability: number;
      helpfulness: number;
      adventurousness: number;
      chattiness: number;
      aggression: number;
      patience: number;
    }
  > = new Map();

  /** Agent desire scores (characterId -> scored candidates) for dashboard display */
  static agentDesireScores: Map<
    string,
    Array<{ goalType: string; score: number; breakdown: string }>
  > = new Map();

  /** Agent thought storage (characterId -> recent thoughts) for dashboard display */
  static agentThoughts: Map<
    string,
    Array<{
      id: string;
      type: "situation" | "evaluation" | "thinking" | "decision" | "action";
      content: string;
      timestamp: number;
      health?: {
        current: number;
        max: number;
        percent: number;
        urgency: "critical" | "warning" | "safe";
      };
      decisionPath?:
        "short-circuit" | "llm" | "scripted" | "planner" | "curiosity";
      providers?: string[];
    }>
  > = new Map();

  /** Long-term build / playstyle vision for embedded agents (dashboard + LLM refresh). */
  static agentCharacterVision: Map<
    string,
    {
      narrative: string;
      pillars: string[];
      updatedAt: number;
      source: "seed" | "llm" | "operator";
    }
  > = new Map();

  /** Maximum number of thoughts to keep per agent */
  static MAX_THOUGHTS_PER_AGENT = 50;

  /** Max distinct agent dashboard entries to retain in memory */
  static MAX_AGENT_DASHBOARD_ENTRIES = 512;

  /** Modular managers */
  private tileMovementManager!: TileMovementManager;
  private mobTileMovementManager!: MobTileMovementManager;
  private pendingAttackManager!: PendingAttackManager;
  private pendingGatherManager!: PendingGatherManager;
  private pendingCookManager!: PendingCookManager;
  private pendingTradeManager!: PendingTradeManager;
  private pendingDuelChallengeManager!: PendingDuelChallengeManager;
  private followManager!: FollowManager;
  private tradingSystem!: TradingSystem;
  private duelSystem!: DuelSystem;
  private duelScheduler!: DuelScheduler;
  private duelBettingBridge!: DuelBettingBridge;
  private actionQueue!: ActionQueue;
  private tickSystem!: TickSystem;
  private socketManager!: SocketManager;
  private broadcastManager!: BroadcastManager;
  private spatialIndex!: SpatialIndex;

  /**
   * Index of spectator sockets grouped by the player they're following.
   * Avoids O(N) scan over all sockets when updating region subscriptions.
   */
  private spectatorsByPlayer = new Map<string, Set<string>>();
  private saveManager!: SaveManager;
  private positionValidator!: PositionValidator;
  private eventBridge!: EventBridge;
  private initializationManager!: InitializationManager;
  private connectionHandler!: ConnectionHandler;
  private interactionSessionManager!: InteractionSessionManager;
  private faceDirectionManager!: FaceDirectionManager;

  /** Time sync state - broadcast world time every 5 seconds for day/night sync */
  private worldTimeSyncAccumulator = 0;
  private readonly WORLD_TIME_SYNC_INTERVAL = 5; // seconds

  // Rate Limiting for Processing Requests
  /** Rate limiter for processing requests (playerId -> lastRequestTime) */
  private readonly processingRateLimiter = new Map<string, number>();
  /** Minimum time between processing requests (500ms) */
  private readonly PROCESSING_COOLDOWN_MS = 500;
  /** Prune stale processing cooldown entries after 10 minutes */
  private readonly PROCESSING_RATE_LIMIT_TTL_MS = 10 * 60 * 1000;

  /** World listeners tracked for deterministic teardown */
  private worldListeners: Array<{
    event: string;
    fn: (...args: unknown[]) => void;
  }> = [];

  /** Cleanup function for duel event listeners */
  private cleanupDuelEventListeners: (() => void) | null = null;
  private _lagProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopLagProbe: (() => void) | null = null;
  private readonly messageMetrics = new Map<string, NetworkMessageMetric>();

  constructor(world: World) {
    super(world);
    this.id = 0;
    this.ids = -1;
    this.sockets = new Map();
    this.isServer = true;
    this.isClient = false;
    this.queue = [];
    this.spawn = JSON.parse(defaultSpawn);
    this.maxUploadSize = 50; // Default 50MB upload limit

    // Initialize managers will happen in init() after world.db is set
  }

  // Rate Limiting Helper

  /**
   * Check if a player can make a processing request (rate limiting).
   * Prevents spam by requiring PROCESSING_COOLDOWN_MS between requests.
   *
   * @param playerId - The player ID to check
   * @returns true if request is allowed, false if rate limited
   */
  private canProcessRequest(playerId: string): boolean {
    const now = Date.now();
    if (this.processingRateLimiter.size > 1024) {
      this.pruneProcessingRateLimiter(now);
    }
    const lastRequest = this.processingRateLimiter.get(playerId) ?? 0;

    if (now - lastRequest < this.PROCESSING_COOLDOWN_MS) {
      console.warn(
        `[ServerNetwork] Rate limited processing request from ${playerId}`,
      );
      return false;
    }

    this.processingRateLimiter.set(playerId, now);
    return true;
  }

  private pruneProcessingRateLimiter(now: number): void {
    const cutoff = now - this.PROCESSING_RATE_LIMIT_TTL_MS;
    for (const [playerId, lastRequest] of this.processingRateLimiter) {
      if (lastRequest < cutoff) {
        this.processingRateLimiter.delete(playerId);
      }
    }
  }

  private onWorld<T = unknown>(event: string, fn: (payload: T) => void): void {
    const listener = fn as unknown as (...args: unknown[]) => void;
    this.world.on(event, listener);
    this.worldListeners.push({ event, fn: listener });
  }

  private clearWorldListeners(): void {
    for (const { event, fn } of this.worldListeners) {
      this.world.off(event, fn);
    }
    this.worldListeners = [];
  }

  private static capAgentDashboardMap<T>(map: Map<string, T>): void {
    while (map.size > ServerNetwork.MAX_AGENT_DASHBOARD_ENTRIES) {
      const oldestKey = map.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      map.delete(oldestKey);
    }
  }

  private trimAgentDashboardCaches(): void {
    ServerNetwork.capAgentDashboardMap(ServerNetwork.agentGoals);
    ServerNetwork.capAgentDashboardMap(ServerNetwork.agentAvailableGoals);
    ServerNetwork.capAgentDashboardMap(ServerNetwork.agentActivity);
    ServerNetwork.capAgentDashboardMap(ServerNetwork.agentGoalsPaused);
    ServerNetwork.capAgentDashboardMap(ServerNetwork.agentThoughts);
    ServerNetwork.capAgentDashboardMap(ServerNetwork.characterSockets);
    ServerNetwork.capAgentDashboardMap(ServerNetwork.agentPersonality);
    ServerNetwork.capAgentDashboardMap(ServerNetwork.agentDesireScores);
    ServerNetwork.capAgentDashboardMap(ServerNetwork.agentCharacterVision);
  }

  /**
   * Initialize managers after database is available
   *
   * Managers need access to world and database, so we initialize them
   * after world.init() sets world.db.
   */
  private initializeManagers(): void {
    // Broadcast manager (needed by many others)
    this.broadcastManager = new BroadcastManager(this.sockets);

    // Spatial index for interest management (sendToNearby)
    this.spatialIndex = new SpatialIndex();
    this.broadcastManager.setSpatialIndex(this.spatialIndex);

    // Note: uWS pub/sub is wired later via enablePubSub() after uWS server starts

    // Tick system for classic fantasy MMORPG-style 600ms ticks
    this.tickSystem = new TickSystem();

    // Tile-based movement manager (classic fantasy MMORPG-style)
    // Use sendToNearby for movement broadcasts — position is extracted from
    // the data payload's player entity rather than from the packet itself.
    this.tileMovementManager = new TileMovementManager(
      this.world,
      (name: string, data: unknown, ignoreSocketId?: string) => {
        const payload = data as SpatialBroadcastPayload;
        const entity = payload?.id
          ? this.world.entities?.get(payload.id)
          : null;
        if (entity?.position) {
          // Keep SpatialIndex in sync with tile movement so the player
          // stays within their own broadcast radius
          if (payload.id) {
            const moveRegionChange = this.spatialIndex.updatePlayerPosition(
              payload.id,
              entity.position.x,
              entity.position.z,
            );
            if (moveRegionChange) {
              this.updatePlayerRegionSubscriptions(
                payload.id,
                moveRegionChange.oldKey,
                moveRegionChange.newKey,
              );
            }
          }
          this.broadcastManager.sendToNearby(
            name,
            data,
            entity.position.x,
            entity.position.z,
            ignoreSocketId,
          );
        } else {
          this.broadcastManager.sendToAll(name, data, ignoreSocketId);
        }
      },
    );

    // Wire movement anti-cheat auto-kick: when a player exceeds the
    // violation threshold, disconnect them with a reason packet.
    this.tileMovementManager.setAntiCheatKickCallback(
      (playerId: string, reason: string) => {
        for (const [, socket] of this.sockets) {
          if (socket.player?.id === playerId) {
            const kickPacket = writePacket("kick", reason);
            socket.ws?.send?.(kickPacket);
            socket.ws?.close?.(4002, "Anti-cheat kick");
            break;
          }
        }
      },
    );

    // Action queue for classic MMORPG-style input processing
    this.actionQueue = new ActionQueue();

    // Set up action queue handlers - these execute the actual game logic
    this.actionQueue.setHandlers({
      movement: (socket, data) => {
        this.tileMovementManager.handleMoveRequest(socket, data);
      },
      combat: (socket, data) => {
        // Combat actions trigger the combat system
        const playerEntity = socket.player;
        if (!playerEntity) {
          traceAttackMob("action_queue:drop:no_player_on_socket", {
            socketId: socket.id,
          });
          return;
        }

        const payload = data as AttackMobPayload;
        const targetId = payload.mobId || payload.targetId;
        if (!targetId) {
          traceAttackMob("action_queue:drop:missing_target_id", {
            playerId: playerEntity.id,
            socketId: socket.id,
          });
          return;
        }
        traceAttackMob("action_queue:emit_combat_attack_request", {
          playerId: playerEntity.id,
          targetId,
          tick: this.world.currentTick,
        });
        this.world.emit(EventType.COMBAT_ATTACK_REQUEST, {
          attackerId: playerEntity.id,
          targetId,
          attackerType: "player",
          targetType: "mob",
          attackType: AttackType.MELEE,
        });
      },
      interaction: (socket, data) => {
        // Generic interaction handler - can be extended for object/NPC interactions
        console.log(
          `[ActionQueue] Interaction from ${socket.player?.id}:`,
          data,
        );
      },
    });

    if (DEBUG_ATTACK_MOB) {
      this.onWorld(EventType.COMBAT_ATTACK_REQUEST, (event) => {
        const payload =
          event as EventMap[typeof EventType.COMBAT_ATTACK_REQUEST];
        if (payload.attackerType !== "player" || payload.targetType !== "mob") {
          return;
        }
        traceAttackMob("event:combat_attack_request_emitted", {
          attackerId: payload.attackerId,
          targetId: payload.targetId,
          attackType: payload.attackType,
          tick: this.world.currentTick,
        });
      });
    }

    // FIRST: Update world.currentTick on each tick so all systems can read it
    // This must run before any other tick processing (INPUT is earliest priority)
    // Mobs use this to run AI only once per tick instead of every frame
    this.tickSystem.onTick(
      (tickNumber) => {
        this.world.currentTick = tickNumber;
      },
      TickPriority.INPUT,
      "currentTick",
    );

    // SECOND: Process duel state transitions BEFORE action queue
    // CRITICAL: Must run before ActionQueue so COUNTDOWN→FIGHTING transition
    // happens before movement validation (which calls canMove())
    // Without this ordering, there's a race condition where movement requests
    // are rejected because they see COUNTDOWN state, but state changes to
    // FIGHTING later in the same tick
    this.tickSystem.onTick(
      () => {
        this.duelSystem.processTick();
      },
      TickPriority.INPUT,
      "duelSystem",
    );

    // Register action queue to process inputs at INPUT priority
    this.tickSystem.onTick(
      (tickNumber) => {
        this.actionQueue.processTick(tickNumber);
      },
      TickPriority.INPUT,
      "actionQueue",
    );

    // Register tile movement to run on each tick (after inputs)
    this.tickSystem.onTick(
      (tickNumber) => {
        const wallStart = performance.now();
        const cpuStart = process.cpuUsage();
        this.tileMovementManager.onTick(tickNumber);
        const wallMs = performance.now() - wallStart;
        if (wallMs > 50) {
          const cpu = process.cpuUsage(cpuStart);
          const context = this.tileMovementManager.getPerformanceContext();
          console.warn(
            `[Tick] playerMovement slow ${JSON.stringify({
              tickNumber,
              wallMs: Number(wallMs.toFixed(2)),
              cpuUserMs: Number((cpu.user / 1000).toFixed(2)),
              cpuSystemMs: Number((cpu.system / 1000).toFixed(2)),
              ...context,
            })}`,
          );
        }
      },
      TickPriority.MOVEMENT,
      "playerMovement",
    );

    // Mob tile-based movement manager (same tick system as players)
    // Use sendToNearby for mob movement broadcasts
    this.mobTileMovementManager = new MobTileMovementManager(
      this.world,
      (name: string, data: unknown, ignoreSocketId?: string) => {
        const payload = data as SpatialBroadcastPayload;
        const entity = payload?.id
          ? this.world.entities?.get(payload.id)
          : null;
        if (entity?.position) {
          this.broadcastManager.sendToNearby(
            name,
            data,
            entity.position.x,
            entity.position.z,
            ignoreSocketId,
          );
        } else {
          this.broadcastManager.sendToAll(name, data, ignoreSocketId);
        }
      },
    );

    // RULES-ACCURATE: Process mob AI BEFORE mob movement each tick
    // AI state machine (IDLE → WANDER → CHASE → ATTACK → RETURN) decides movement targets,
    // then mob tile movement executes the path on the same tick.
    // Without this, mobs stand idle forever because MobEntity.serverUpdate() defers
    // AI ticking to the tick system for deterministic classic MMORPG ordering.
    const MOB_AI_DELTA_SECONDS = TICK_DURATION_MS / 1000;

    // Use type-indexed entity lookup instead of iterating all 221+ entities
    const getEntityManager = () =>
      this.world.getSystem("entity-manager") as
        | { getEntitiesByType?: (type: string) => Array<{ id: string }> }
        | undefined;

    this.tickSystem.onTick(
      () => {
        const t0 = Date.now();
        const em = getEntityManager();
        const mobs = em?.getEntitiesByType?.("mob") ?? [];
        let mobCount = 0;
        for (const entry of mobs) {
          const entity = this.world.entities.get(entry.id);
          if (!entity || !(entity instanceof MobEntity)) continue;
          // Run for ALL mobs including dead ones — runAITick handles death state
          // (position locking, respawn timer) since mobs are no longer in the hot set
          entity.runAITick(MOB_AI_DELTA_SECONDS);
          mobCount++;
        }
        const mobAIMs = Date.now() - t0;
        this._lastMobAITime = mobAIMs;
        if (mobAIMs > 30) {
          console.warn(`[Tick] MobAI: ${mobAIMs}ms for ${mobCount} mobs`);
        }
      },
      TickPriority.MOVEMENT,
      "mobAI",
    );

    // Register mob tile movement to run on each tick (same priority as player movement)
    // Runs AFTER mob AI so paths set by AI are executed this tick
    this.tickSystem.onTick(
      (tickNumber) => {
        const t0 = Date.now();
        this.mobTileMovementManager.onTick(tickNumber);
        this._lastMobMoveTime = Date.now() - t0;
      },
      TickPriority.MOVEMENT,
      "mobMovement",
    );

    // Pending attack manager - server-authoritative tracking of "walk to mob and attack" actions
    // This replaces unreliable client-side tracking with 100% reliable server-side logic
    this.pendingAttackManager = new PendingAttackManager(
      this.world,
      this.tileMovementManager,
      // getMobPosition helper - get from world entity (mobs spawned via MobNPCSpawnerSystem with gdd_* IDs)
      (mobId: string) => {
        const mobEntity = this.world.entities.get(mobId) as {
          position?: { x: number; y: number; z: number };
          getPosition?: () => { x: number; y: number; z: number };
          data?: { position?: unknown };
        } | null;
        if (!mobEntity) return null;
        const p = mobEntity.position;
        if (
          p &&
          typeof p.x === "number" &&
          typeof p.y === "number" &&
          typeof p.z === "number"
        ) {
          return { x: p.x, y: p.y, z: p.z };
        }
        if (typeof mobEntity.getPosition === "function") {
          return mobEntity.getPosition();
        }
        const raw = mobEntity.data?.position;
        if (Array.isArray(raw) && raw.length >= 3) {
          const [x, y, z] = raw as number[];
          if (
            [x, y, z].every((n) => typeof n === "number" && Number.isFinite(n))
          ) {
            return { x, y, z };
          }
        }
        return null;
      },
      // isMobAlive helper — Entity/MobEntity use getHealth() / data.health; config.currentHealth alone was always undefined → mobs looked dead and pending attacks were cleared every tick.
      (mobId: string) => {
        const mobEntity = this.world.entities.get(mobId) as {
          getHealth?: () => number;
          data?: { health?: number };
          config?: { currentHealth?: number };
        } | null;
        if (!mobEntity) return false;
        if (typeof mobEntity.getHealth === "function") {
          return mobEntity.getHealth() > 0;
        }
        if (typeof mobEntity.data?.health === "number") {
          return mobEntity.data.health > 0;
        }
        if (typeof mobEntity.config?.currentHealth === "number") {
          return mobEntity.config.currentHealth > 0;
        }
        return false;
      },
    );

    // Register pending attack processing BEFORE combat (so attacks can initiate combat this tick)
    this.tickSystem.onTick(
      (tickNumber) => {
        this.pendingAttackManager.processTick(tickNumber);
      },
      TickPriority.MOVEMENT,
      "pendingAttack",
    );

    // Water hazard recovery - automatically teleport agents out of water
    this.tickSystem.onTick(
      () => {
        const terrain = this.world.getSystem("terrain") as {
          getHeightAt?: (x: number, z: number) => number;
        } | null;

        if (!terrain?.getHeightAt) return;

        // Only check agent players, not all 221+ entities
        const em = getEntityManager();
        const players = em?.getEntitiesByType?.("player") ?? [];
        for (const entry of players) {
          const entity = this.world.entities.get(entry.id);
          if (entity && entity.data?.isAgent && entity.position) {
            const { x, z } = entity.position;
            const y = terrain.getHeightAt(x, z);

            if (
              typeof y === "number" &&
              Number.isFinite(y) &&
              y < TERRAIN_CONSTANTS.WATER_THRESHOLD
            ) {
              console.warn(
                `[WaterRecovery] Agent ${entity.id} is in water (y=${y}), teleporting home.`,
              );

              // Get safe spawn position
              const [spawnX, baseY, spawnZ] = this.spawn.position;
              const spawnTerrainHeight = terrain.getHeightAt(spawnX, spawnZ);
              const safeY =
                typeof spawnTerrainHeight === "number" &&
                Number.isFinite(spawnTerrainHeight)
                  ? spawnTerrainHeight + 0.1
                  : baseY;

              this.world.emit("player:teleport", {
                playerId: entity.id,
                position: { x: spawnX, y: safeY, z: spawnZ },
                rotation: 0,
              });
            }
          }
        }
      },
      TickPriority.MOVEMENT,
      "waterRecovery",
    );

    // Pending gather manager - server-authoritative tracking of "walk to resource and gather" actions
    // Uses same approach as PendingAttackManager: movePlayerToward with meleeRange=1 for cardinal-only
    this.pendingGatherManager = new PendingGatherManager(
      this.world,
      this.tileMovementManager,
      (name, data) => this.broadcastManager.sendToAll(name, data),
    );

    // Register pending gather processing (same priority as movement)
    this.tickSystem.onTick(
      (tickNumber) => {
        this.pendingGatherManager.processTick(tickNumber);
      },
      TickPriority.MOVEMENT,
      "pendingGather",
    );

    // Pending cook manager - server-authoritative tracking of "walk to fire and cook" actions
    // Uses same approach as PendingGatherManager: movePlayerToward with meleeRange=1 for cardinal-only
    // FireRegistry is now injected via constructor (DIP)
    const processingSystem = this.world.getSystem("processing") as unknown as {
      getActiveFires: () => Map<
        string,
        {
          id: string;
          position: { x: number; y: number; z: number };
          isActive: boolean;
          playerId: string;
          createdAt: number;
          duration: number;
          mesh?: unknown;
        }
      >;
    };
    this.pendingCookManager = new PendingCookManager(
      this.world,
      this.tileMovementManager,
      processingSystem,
    );

    // Register pending cook processing (same priority as movement)
    this.tickSystem.onTick(
      (tickNumber) => {
        this.pendingCookManager.processTick(tickNumber);
      },
      TickPriority.MOVEMENT,
      "pendingCook",
    );

    // Follow manager - server-authoritative tracking of players following other players
    // classic MMORPG-style: follower walks behind leader, re-paths when leader moves
    this.followManager = new FollowManager(
      this.world,
      this.tileMovementManager,
    );

    // Register follow processing (same priority as movement)
    // Pass tick number for rules-accurate 1-tick delay tracking
    this.tickSystem.onTick(
      (tickNumber) => {
        this.followManager.processTick(tickNumber);
      },
      TickPriority.MOVEMENT,
      "followManager",
    );

    // Pending trade manager - server-authoritative "walk to player and trade" system
    // classic MMORPG-style: if player clicks to trade someone far away, walk up first
    this.pendingTradeManager = new PendingTradeManager(
      this.world,
      this.tileMovementManager,
    );

    // Register pending trade processing (same priority as movement)
    this.tickSystem.onTick(
      () => {
        this.pendingTradeManager.processTick();
      },
      TickPriority.MOVEMENT,
      "pendingTrade",
    );

    // Store pending trade manager on world so trade handlers can access it
    (
      this.world as { pendingTradeManager?: PendingTradeManager }
    ).pendingTradeManager = this.pendingTradeManager;

    // Pending duel challenge manager - server-authoritative "walk to player and challenge" system
    // classic MMORPG-style: if player clicks to challenge someone far away, walk up first
    this.pendingDuelChallengeManager = new PendingDuelChallengeManager(
      this.world,
      this.tileMovementManager,
    );

    // Register pending duel challenge processing (same priority as movement)
    this.tickSystem.onTick(
      () => {
        this.pendingDuelChallengeManager.processTick();
      },
      TickPriority.MOVEMENT,
      "pendingDuel",
    );

    // Store pending duel challenge manager on world so handlers can access it
    (
      this.world as {
        pendingDuelChallengeManager?: PendingDuelChallengeManager;
      }
    ).pendingDuelChallengeManager = this.pendingDuelChallengeManager;

    // Trading system - server-authoritative player-to-player trading
    // Manages trade sessions, item offers, acceptance state, and atomic swaps
    this.tradingSystem = new TradingSystem(this.world);
    this.tradingSystem.init();

    // Store trading system on world so handlers can access it
    (this.world as { tradingSystem?: TradingSystem }).tradingSystem =
      this.tradingSystem;

    // Duel system - server-authoritative player-to-player dueling (classic MMORPG-style)
    // Manages duel sessions, rules negotiation, stakes, and combat enforcement
    this.duelSystem = new DuelSystem(this.world);

    // Store duel system on world so handlers can access it
    (this.world as { duelSystem?: DuelSystem }).duelSystem = this.duelSystem;

    // Register duel system in systemsByName so it can be found via getSystem("duel")
    // This is required for combat.ts to detect duel combat and bypass PvP zone checks
    // NOTE: We use systemsByName directly instead of addSystem() because DuelSystem
    // doesn't implement the full System lifecycle interface (preTick, postTick, etc.)
    (this.world as { systemsByName: Map<string, unknown> }).systemsByName.set(
      "duel",
      this.duelSystem,
    );

    // Register duel world-event listeners before DuelSystem.init() so the duel
    // stake-settlement safety check sees the listener graph in its ready state.
    this.cleanupDuelEventListeners = registerDuelEventListeners({
      world: this.world,
      broadcastManager: this.broadcastManager,
      getSocketByPlayerId: this.getSocketByPlayerId.bind(this),
      processedDuelSettlements: this.processedDuelSettlements,
      executeDuelStakeTransferWithRetry: (winnerId, loserId, stakes, duelId) =>
        executeDuelStakeTransferWithRetry(
          {
            world: this.world,
            getSocketByPlayerId: this.getSocketByPlayerId.bind(this),
          },
          winnerId,
          loserId,
          stakes,
          duelId,
        ),
    });

    this.duelSystem.init();

    // DuelScheduler - automated agent-vs-agent duel pairing for continuous PvP
    // Disable it automatically when streaming duel mode owns orchestration.
    const legacyDuelSchedulerEnabled =
      process.env.DUEL_SCHEDULER_ENABLED !== "false" &&
      process.env.STREAMING_DUEL_ENABLED !== "true";
    if (legacyDuelSchedulerEnabled) {
      this.duelScheduler = new DuelScheduler(this.world);
      this.duelScheduler.init();

      // Store duel scheduler on world for external access
      (this.world as { duelScheduler?: DuelScheduler }).duelScheduler =
        this.duelScheduler;
    }

    // DuelBettingBridge - connects duel results to Solana prediction markets
    // Creates betting markets when duels are scheduled and resolves them when complete
    // Enable via DUEL_BETTING_ENABLED=true environment variable
    this.duelBettingBridge = new DuelBettingBridge(this.world);
    this.duelBettingBridge.init();

    // Store betting bridge on world for external access
    (
      this.world as { duelBettingBridge?: DuelBettingBridge }
    ).duelBettingBridge = this.duelBettingBridge;

    // Listen for player teleport events (used by duel system)
    this.onWorld("player:teleport", (event) => {
      const { playerId, position, rotation, suppressEffect } =
        event as PlayerTeleportPayload;

      // Validate position before processing
      if (
        !position ||
        typeof position.x !== "number" ||
        typeof position.z !== "number" ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.z)
      ) {
        console.warn(
          `[ServerNetwork] player:teleport received invalid position for ${playerId}:`,
          position,
        );
        return;
      }

      // Update player position on server
      const player = this.world.entities.players?.get(playerId);
      if (player?.position) {
        player.position.x = position.x;
        player.position.y = position.y ?? 0;
        player.position.z = position.z;
      }

      // Clear any in-progress movement by cleaning up the player's movement state
      this.tileMovementManager.cleanup(playerId);

      // CRITICAL: Sync position to TileMovementManager after teleport
      // Without this, movement system uses stale position and player appears stuck
      const resolvedPosition = this.tileMovementManager.syncPlayerPosition(
        playerId,
        position,
      );

      // Update the spatial index only after collision-safe relocation has resolved
      // the authoritative destination. Otherwise nearby routing and the teleport
      // packet can disagree about the player's actual tile.
      const teleportRegionChange = this.spatialIndex.updatePlayerPosition(
        playerId,
        resolvedPosition.x,
        resolvedPosition.z,
      );
      if (teleportRegionChange) {
        this.resubscribePlayerRegionTopics(
          playerId,
          teleportRegionChange.oldKey,
          resolvedPosition.x,
          resolvedPosition.z,
        );
      }

      // Clear any pending actions from before teleport (e.g., queued movements, combat actions)
      // This prevents stale actions from executing after teleport
      this.actionQueue.cleanup(playerId);

      // Send teleport to the teleporting player
      const socket = this.getSocketByPlayerId(playerId);
      const teleportPacket = {
        playerId,
        position: [
          resolvedPosition.x,
          resolvedPosition.y,
          resolvedPosition.z,
        ] as [number, number, number],
        rotation,
        ...(suppressEffect ? { suppressEffect: true } : {}),
      };
      if (socket) {
        socket.send("playerTeleport", teleportPacket);
      }

      // Broadcast teleport to ALL other clients so they see the teleport
      // This is critical for duel arena - both players need to see each other teleport
      // We send playerTeleport (not entityModified) because remote players have tile state
      // and entityModified position updates are skipped for tile-controlled entities
      this.broadcastManager.sendToAll(
        "playerTeleport",
        teleportPacket,
        socket?.id,
      );

      // CRITICAL: Sync animation state after teleport to prevent T-pose
      // Without this, remote players may show default pose until next animation change
      this.broadcastManager.sendToAll("entityModified", {
        id: playerId,
        changes: {
          e: "idle",
        },
      });
    });

    // Listen for movement cancel events (used by duel system to prevent escaping arena)
    this.onWorld("player:movement:cancel", (event) => {
      const { playerId } = event as PlayerMovementCancelPayload;

      // Clear movement state
      this.tileMovementManager.cleanup(playerId);
    });

    // rules-accurate face direction manager
    // Defers rotation until end of tick, only applies if player didn't move
    this.faceDirectionManager = new FaceDirectionManager(this.world);

    // Wire up the send function so FaceDirectionManager can broadcast rotation changes
    this.faceDirectionManager.setSendFunction((name, data) => {
      const payload = data as SpatialBroadcastPayload;
      const entity = payload?.id ? this.world.entities?.get(payload.id) : null;
      if (entity?.position) {
        this.broadcastManager.sendToNearby(
          name,
          data,
          entity.position.x,
          entity.position.z,
        );
      } else {
        this.broadcastManager.sendToAll(name, data);
      }
    });

    // Register face direction processing - runs AFTER all movement at COMBAT priority
    // classic MMORPG: Face direction mask is processed at end of tick if entity didn't move
    this.tickSystem.onTick(
      () => {
        // Get all player IDs from the players map (not items)
        const entitiesSystem = this.world.entities as {
          players?: Map<string, { id: string }>;
        } | null;

        if (!entitiesSystem?.players) {
          return;
        }

        const playerIds: string[] = [];
        for (const [playerId] of entitiesSystem.players) {
          playerIds.push(playerId);
        }

        if (playerIds.length > 0) {
          this.faceDirectionManager.processFaceDirection(playerIds);
        }
      },
      TickPriority.COMBAT,
      "faceDirection",
    );

    // Reset movement flags at the START of each tick (INPUT priority)
    this.tickSystem.onTick(
      () => {
        this.faceDirectionManager.resetMovementFlags();
      },
      TickPriority.INPUT,
      "resetMoveFlags",
    );

    // Store face direction manager on world so ResourceSystem can access it
    (
      this.world as { faceDirectionManager?: FaceDirectionManager }
    ).faceDirectionManager = this.faceDirectionManager;

    // Register combat system to process on each tick (after movement, before AI)
    // This is rules-accurate: combat runs on the game tick, not per-frame
    this.tickSystem.onTick(
      (tickNumber) => {
        const t0 = Date.now();
        const combatSystem = this.world.getSystem(
          "combat",
        ) as CombatSystem | null;
        if (combatSystem) {
          combatSystem.processCombatTick(tickNumber);
        }
        this._lastCombatTime = Date.now() - t0;
      },
      TickPriority.COMBAT,
      "combat",
    );

    // Register death system to process on each tick (after combat)
    // Handles gravestone expiration and ground item despawn (rules-accurate tick-based timing)
    this.tickSystem.onTick(
      (tickNumber) => {
        const playerDeathSystem = this.world.getSystem(
          "player-death",
        ) as unknown as PlayerDeathSystemWithTick | undefined;
        if (
          playerDeathSystem &&
          typeof playerDeathSystem.processTick === "function"
        ) {
          playerDeathSystem.processTick(tickNumber);
        }
      },
      TickPriority.COMBAT,
      "playerDeath",
    );

    // Register loot system to process on each tick (after combat)
    // Handles mob corpse despawn (rules-accurate tick-based timing)
    this.tickSystem.onTick(
      (tickNumber) => {
        const lootSystem = this.world.getSystem("loot") as unknown as
          PlayerDeathSystemWithTick | undefined;
        if (lootSystem && typeof lootSystem.processTick === "function") {
          lootSystem.processTick(tickNumber);
        }
      },
      TickPriority.COMBAT,
      "loot",
    );

    // Register resource gathering system to process on each tick (after combat)
    // rules-accurate: Woodcutting attempts every 4 ticks (2.4 seconds)
    this.tickSystem.onTick(
      (tickNumber) => {
        const resourceSystem = this.world.getSystem(
          "resource",
        ) as ResourceSystem | null;
        if (
          resourceSystem &&
          typeof resourceSystem.processGatheringTick === "function"
        ) {
          resourceSystem.processGatheringTick(tickNumber);
        }
      },
      TickPriority.RESOURCES,
      "resources",
    );

    // Register home teleport system to process on each tick
    // Handles cast completion and combat interruption checks
    this.tickSystem.onTick(
      (tickNumber) => {
        const manager = getHomeTeleportManager();
        if (manager) {
          manager.processTick(tickNumber, (playerId: string) => {
            return this.broadcastManager.getPlayerSocket(playerId);
          });
        }
      },
      TickPriority.RESOURCES,
      "homeTeleport",
    );

    // Event loop lag detector — measures max time the event loop was blocked
    // between ticks using a high-frequency setTimeout probe
    let _maxEventLoopLag = 0;
    let _lagProbeExpected = Date.now();
    let _lagProbeStopped = false;
    const lagProbe = () => {
      if (_lagProbeStopped) return;
      const now = Date.now();
      const lag = now - _lagProbeExpected - 50; // Subtract expected 50ms interval
      if (lag > 0) {
        if (lag > _maxEventLoopLag) {
          _maxEventLoopLag = lag;
        }
        // Log significant blocks to server console to help identify the source
        if (lag > 200) {
          console.warn(
            `[EventLoop] ⚠️ Blocked for ${lag}ms at tick ${this.world.currentTick}`,
          );
        }
      }
      _lagProbeExpected = now + 50;
      this._lagProbeTimer = setTimeout(lagProbe, 50);
    };
    this._lagProbeTimer = setTimeout(lagProbe, 50);
    // Expose stop function for destroy() cleanup
    this._stopLagProbe = () => {
      _lagProbeStopped = true;
      if (this._lagProbeTimer) {
        clearTimeout(this._lagProbeTimer);
        this._lagProbeTimer = null;
      }
    };

    // Broadcast tick health stats to clients for DevStats panel (every 5th tick = 3s)
    this.tickSystem.onTick(
      (tickNumber) => {
        if (tickNumber % 5 !== 0) return;
        const stats = this.tickSystem.getTickHealthStats();
        // Include per-phase timing breakdown so DevStats can show WHERE time goes
        const phaseTimings = {
          mobAI: this._lastMobAITime,
          mobMove: this._lastMobMoveTime,
          combat: this._lastCombatTime,
        };
        const eventLoopLag = _maxEventLoopLag;
        _maxEventLoopLag = 0; // Reset after reporting
        const broadcastMs = this.broadcastManager.drainSendTimeMs();
        const pubsubPublishes = this.broadcastManager.drainPubsubStats();
        const payload: Record<string, unknown> = {
          ...stats,
          phaseTimings,
          eventLoopLag,
          broadcastMs,
          pubsubPublishes,
        };
        // Only expose internal server state in non-production environments
        if (process.env.NODE_ENV !== "production") {
          payload.transport =
            process.env.UWS_ENABLED !== "false" ? "uws" : "ws";
          payload.connections = this.sockets.size;
          payload.handlerTimings =
            this.tickSystem.getHandlerTimingPercentiles();
        }
        this.broadcastManager.sendToAll("tickHealth", payload);
      },
      TickPriority.BROADCAST,
      "tickHealthBroadcast",
    );

    // NOTE: Explicit GC scheduling removed — Bun.gc(false) callbacks piled up
    // when ticks fell behind, creating a death spiral of competing GC passes.
    // Let the runtime handle GC naturally.

    // Socket manager
    this.socketManager = new SocketManager(
      this.sockets,
      this.world,
      this.broadcastManager.sendToAll.bind(this.broadcastManager),
    );
    this.socketManager.setBroadcastManager(this.broadcastManager);

    // Clean up player state when player disconnects (prevents memory leak)
    this.onWorld(EventType.PLAYER_LEFT, (event: { playerId: string }) => {
      this.tileMovementManager.cleanup(event.playerId);
      this.actionQueue.cleanup(event.playerId);
      this.spatialIndex.removePlayer(event.playerId);
      const entityManager = this.world.getSystem("entity-manager") as {
        unregisterPlayer?: (playerId: string) => void;
      } | null;
      entityManager?.unregisterPlayer?.(event.playerId);
      this.processingRateLimiter.delete(event.playerId);
      // Release agent dashboard socket reference so disconnected socket can be GC'd
      ServerNetwork.characterSockets.delete(event.playerId);
      ServerNetwork.agentGoals.delete(event.playerId);
      ServerNetwork.agentAvailableGoals.delete(event.playerId);
      ServerNetwork.agentActivity.delete(event.playerId);
      ServerNetwork.agentGoalsPaused.delete(event.playerId);
      ServerNetwork.agentThoughts.delete(event.playerId);
      ServerNetwork.agentPersonality.delete(event.playerId);
      ServerNetwork.agentDesireScores.delete(event.playerId);
    });

    // Seed spatial index on initial join so sendToNearby() works from first tick
    // Also subscribe the socket to its 9 region topics for pub/sub
    this.onWorld(EventType.PLAYER_JOINED, (payload: unknown) => {
      const event = payload as {
        playerId: string;
        player: { position: { x: number; y: number; z: number } };
      };
      if (event.player?.position) {
        const resolvedPosition = this.tileMovementManager.syncPlayerPosition(
          event.playerId,
          event.player.position,
        );
        this.spatialIndex.updatePlayerPosition(
          event.playerId,
          resolvedPosition.x,
          resolvedPosition.z,
        );
        // Subscribe to region topics for pub/sub
        this.subscribePlayerRegionTopics(
          event.playerId,
          resolvedPosition.x,
          resolvedPosition.z,
        );
      }
    });

    // Keep spatial index updated so sendToNearby() works
    // Also update pub/sub region subscriptions on region change
    this.onWorld(EventType.PLAYER_POSITION_UPDATED, (payload: unknown) => {
      const event = payload as {
        playerId: string;
        position: { x: number; z: number };
      };
      const regionChange = this.spatialIndex.updatePlayerPosition(
        event.playerId,
        event.position.x,
        event.position.z,
      );
      // Update pub/sub subscriptions on region change
      if (regionChange) {
        this.updatePlayerRegionSubscriptions(
          event.playerId,
          regionChange.oldKey,
          regionChange.newKey,
        );
      }
    });

    // Reset agility progress on death (small penalty - lose accumulated tiles toward next XP grant)
    this.onWorld(EventType.ENTITY_DEATH, (eventData) => {
      const event = eventData as { entityId: string; entityType: string };
      if (event.entityType === "player") {
        this.tileMovementManager.resetAgilityProgress(event.entityId);
      }
    });

    // Sync tile position when player respawns at spawn point
    // CRITICAL: Without this, TileMovementManager has stale tile position from death location
    // and paths would be calculated from wrong starting tile
    this.onWorld(EventType.PLAYER_RESPAWNED, (eventData) => {
      const event = eventData as EventMap[typeof EventType.PLAYER_RESPAWNED];
      if (event.playerId && event.spawnPosition) {
        const pos = event.spawnPosition;
        // spawnPosition can be {x,y,z} or number[] — normalize
        const position = Array.isArray(pos)
          ? { x: pos[0], y: pos[1], z: pos[2] }
          : pos;
        // Validate position before syncing
        if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) {
          console.warn(
            `[ServerNetwork] PLAYER_RESPAWNED invalid position for ${event.playerId}:`,
            position,
          );
          return;
        }
        const resolvedPosition = this.tileMovementManager.syncPlayerPosition(
          event.playerId,
          position,
        );
        const respawnRegionChange = this.spatialIndex.updatePlayerPosition(
          event.playerId,
          resolvedPosition.x,
          resolvedPosition.z,
        );
        // Full region resubscription on respawn
        if (respawnRegionChange) {
          this.resubscribePlayerRegionTopics(
            event.playerId,
            respawnRegionChange.oldKey,
            resolvedPosition.x,
            resolvedPosition.z,
          );
        }
        // Also clear any pending actions from before death
        this.actionQueue.cleanup(event.playerId);
        console.log(
          `[ServerNetwork] Synced tile position for respawned player ${event.playerId} at (${resolvedPosition.x}, ${resolvedPosition.z})`,
        );
      }
    });

    // Sync tile position when player teleports home
    // CRITICAL: Without this, TileMovementManager has stale tile position from pre-teleport location
    // and paths would be calculated from wrong starting tile, causing player to snap back
    this.onWorld(EventType.HOME_TELEPORT_COMPLETE, (eventData) => {
      const event = eventData as {
        playerId: string;
        position: { x: number; y: number; z: number };
      };
      if (event.playerId && event.position) {
        // Validate position before syncing
        if (
          !Number.isFinite(event.position.x) ||
          !Number.isFinite(event.position.z)
        ) {
          console.warn(
            `[ServerNetwork] HOME_TELEPORT_COMPLETE invalid position for ${event.playerId}:`,
            event.position,
          );
          return;
        }
        const resolvedPosition = this.tileMovementManager.syncPlayerPosition(
          event.playerId,
          event.position,
        );
        const homeRegionChange = this.spatialIndex.updatePlayerPosition(
          event.playerId,
          resolvedPosition.x,
          resolvedPosition.z,
        );
        if (homeRegionChange) {
          this.resubscribePlayerRegionTopics(
            event.playerId,
            homeRegionChange.oldKey,
            resolvedPosition.x,
            resolvedPosition.z,
          );
        }
        // Clear any pending actions from before teleport
        this.actionQueue.cleanup(event.playerId);
      }
    });

    // Handle mob tile movement requests from MobEntity AI
    this.onWorld(EventType.MOB_NPC_MOVE_REQUEST, (event) => {
      const moveEvent = event as {
        mobId: string;
        targetPos: { x: number; y: number; z: number };
        targetEntityId?: string;
        tilesPerTick?: number;
      };
      this.mobTileMovementManager.requestMoveTo(
        moveEvent.mobId,
        moveEvent.targetPos,
        moveEvent.targetEntityId || null,
        moveEvent.tilesPerTick,
      );
    });

    // Initialize mob tile movement state on spawn
    // This ensures mobs have proper tile state from the moment they're created
    this.onWorld(EventType.MOB_NPC_SPAWNED, (event) => {
      const spawnEvent = event as {
        mobId: string;
        mobType: string;
        position: { x: number; y: number; z: number };
      };
      this.mobTileMovementManager.initializeMob(
        spawnEvent.mobId,
        spawnEvent.position,
        2, // Default walk speed: 2 tiles per tick
      );
    });

    // Clean up mob tile movement state on mob death
    // This immediately clears stale tile state when mob dies
    this.onWorld(EventType.NPC_DIED, (event) => {
      const diedEvent = event as EventMap[typeof EventType.NPC_DIED];
      this.mobTileMovementManager.cleanup(diedEvent.mobId);
    });

    // Clean up mob tile movement state on mob despawn (backup cleanup)
    this.onWorld(EventType.MOB_NPC_DESPAWNED, (event) => {
      const despawnEvent = event as { mobId: string };
      this.mobTileMovementManager.cleanup(despawnEvent.mobId);
    });

    // CRITICAL: Reinitialize mob tile state on respawn
    // Without this, the mob's tile state has stale currentTile from death location
    // causing teleportation when the mob starts moving again
    this.onWorld(EventType.MOB_NPC_RESPAWNED, (event) => {
      const respawnEvent =
        event as EventMap[typeof EventType.MOB_NPC_RESPAWNED];
      // Clear old state and initialize at new spawn position
      this.mobTileMovementManager.cleanup(respawnEvent.mobId);
      this.mobTileMovementManager.initializeMob(
        respawnEvent.mobId,
        respawnEvent.position,
        2, // Default walk speed: 2 tiles per tick
      );
    });

    // Combat follow: When player is in combat but out of range, move toward target
    // classic MMORPG-style: "if the clicked entity is an NPC or player, a new pathfinding attempt
    // will be started every tick, until a target tile can be found"
    this.onWorld(EventType.COMBAT_FOLLOW_TARGET, (event) => {
      const followEvent =
        event as EventMap[typeof EventType.COMBAT_FOLLOW_TARGET];
      const follower = this.world.entities.get(followEvent.playerId);
      if (isDuelAiMovementOwned(follower?.data)) {
        return;
      }
      // Use classic MMORPG-style pathfinding with appropriate range and type
      // MELEE: Cardinal-only for range 1, RANGED/MAGIC: Chebyshev distance
      this.tileMovementManager.movePlayerToward(
        followEvent.playerId,
        followEvent.targetPosition,
        true, // Run toward target
        followEvent.attackRange ?? 1, // Default to standard melee range
        followEvent.attackType ?? AttackType.MELEE, // Default to melee if not specified
      );
    });

    this.onWorld(EventType.COMBAT_STARTED, (event) => {
      const { attackerId, targetId } =
        event as EventMap[typeof EventType.COMBAT_STARTED];
      this.cancelPendingPreparationApproaches(attackerId);
      if (targetId !== attackerId) {
        this.cancelPendingPreparationApproaches(targetId);
      }
    });

    // rules-accurate: Cancel pending attack when player clicks elsewhere
    this.onWorld(EventType.PENDING_ATTACK_CANCEL, (event) => {
      const { playerId } =
        event as EventMap[typeof EventType.PENDING_ATTACK_CANCEL];
      this.pendingAttackManager.cancelPendingAttack(playerId);
    });

    // rules-accurate: Move player to adjacent tile after lighting fire
    // Priority: West → East → South → North (handled by ProcessingSystem)
    // Uses proper tile movement for smooth walking animation (not teleport)
    this.onWorld(EventType.FIREMAKING_MOVE_REQUEST, (event) => {
      const payload =
        event as EventMap[typeof EventType.FIREMAKING_MOVE_REQUEST];
      const { playerId, position } = payload;

      // Get player entity
      const socket = this.broadcastManager.getPlayerSocket(playerId);
      const player = socket?.player;
      if (!player) {
        console.warn(
          `[ServerNetwork] Cannot find player for firemaking move: ${playerId}`,
        );
        return;
      }

      // rules-accurate: Use tile movement system for smooth walking animation
      // Walking (not running) to adjacent tile, meleeRange=0 means go directly to tile
      // This sends tileMovementStart packet for smooth client interpolation
      this.tileMovementManager.movePlayerToward(
        playerId,
        position,
        false, // classic MMORPG firemaking step is a walk, not a run
        0, // meleeRange=0 = non-combat, go directly to the tile
      );
    });

    // Handle player emote changes from ProcessingSystem (firemaking, cooking)
    this.onWorld(EventType.PLAYER_SET_EMOTE, (event) => {
      const { playerId, emote } =
        event as EventMap[typeof EventType.PLAYER_SET_EMOTE];

      // Broadcast emote change to nearby clients
      const entity = this.world.entities?.get(playerId);
      if (entity?.position) {
        this.broadcastManager.sendToNearby(
          "entityModified",
          { id: playerId, changes: { e: emote } },
          entity.position.x,
          entity.position.z,
        );
      } else {
        this.broadcastManager.sendToAll("entityModified", {
          id: playerId,
          changes: { e: emote },
        });
      }
    });

    // Save manager
    this.saveManager = new SaveManager(this.world, this.db);

    // Position validator - pass getSocketByPlayerId for client reconciliation
    this.positionValidator = new PositionValidator(
      this.world,
      this.sockets,
      this.broadcastManager,
      this.getSocketByPlayerId.bind(this),
    );

    // Event bridge
    this.eventBridge = new EventBridge(this.world, this.broadcastManager);

    // Interaction session manager (server-authoritative UI sessions)
    this.interactionSessionManager = new InteractionSessionManager(
      this.world,
      this.broadcastManager,
    );
    this.interactionSessionManager.initialize(this.tickSystem);

    // Store session manager on world so handlers can access it (single source of truth)
    // This replaces the previous pattern of storing entity IDs on socket properties
    (
      this.world as { interactionSessionManager?: InteractionSessionManager }
    ).interactionSessionManager = this.interactionSessionManager;

    // Clean up interaction sessions, pending attacks, follows, gathers, cooks, trades, duels, and home teleport when player disconnects
    this.onWorld(EventType.PLAYER_LEFT, (event: { playerId: string }) => {
      this.interactionSessionManager.onPlayerDisconnect(event.playerId);
      this.pendingAttackManager.onPlayerDisconnect(event.playerId);
      this.followManager.onPlayerDisconnect(event.playerId);
      this.pendingGatherManager.onPlayerDisconnect(event.playerId);
      this.pendingCookManager.onPlayerDisconnect(event.playerId);
      this.pendingTradeManager.onPlayerDisconnect(event.playerId);
      this.pendingDuelChallengeManager.onPlayerDisconnect(event.playerId);
      this.duelSystem.onPlayerDisconnect(event.playerId);
      const homeTeleportManager = getHomeTeleportManager();
      if (homeTeleportManager) {
        homeTeleportManager.onPlayerDisconnect(event.playerId);
      }
    });

    // Handle player reconnection (clears disconnect timer if active duel)
    this.onWorld(EventType.PLAYER_JOINED, (event: { playerId: string }) => {
      this.duelSystem.onPlayerReconnect(event.playerId);
    });

    // Initialization manager
    this.initializationManager = new InitializationManager(this.world, this.db);

    // Connection handler
    this.connectionHandler = new ConnectionHandler(
      this.world,
      this.sockets,
      this.broadcastManager,
      this.db,
      this.spectatorsByPlayer,
    );
    this.connectionHandler.setSpatialIndex(this.spatialIndex);

    // Register handlers
    this.registerHandlers();

    // Start the core game tick loop
    // Without this, the server is completely frozen (no movement, combat, or AI processing)
    this.tickSystem.start();
  }

  /**
   * Register all packet handlers
   *
   * Sets up the handler registry with delegates to modular handlers.
   */
  private registerHandlers(): void {
    // Character selection handlers
    this.handlers["characterSelected"] = (socket, data) =>
      handleCharacterSelected(
        socket,
        data,
        this.broadcastManager.sendToSocket.bind(this.broadcastManager),
      );

    this.handlers["enterWorld"] = (socket, data) =>
      this.handleEnterWorldWithReconnect(socket, data);

    // Echo game-level ping back as pong so client can measure RTT
    this.handlers["onPing"] = (socket, data) => {
      socket.send("pong", data);
    };

    this.handlers["onChatAdded"] = (socket, data) =>
      handleChatAdded(
        socket,
        data,
        this.world,
        this.broadcastManager.sendToAll.bind(this.broadcastManager),
      );

    this.handlers["onCommand"] = (socket, data) =>
      handleCommand(
        socket,
        data,
        this.world,
        this.db,
        this.broadcastManager.sendToAll.bind(this.broadcastManager),
        this.isBuilder.bind(this),
        this.sockets,
      );

    this.handlers["onEntityModified"] = (socket, data) =>
      handleEntityModified(
        socket,
        data,
        this.world,
        this.broadcastManager.sendToAll.bind(this.broadcastManager),
      );

    this.handlers["onEntityEvent"] = (socket, data) =>
      handleEntityEvent(socket, data, this.world);

    this.handlers["onEntityRemoved"] = (socket, data) =>
      handleEntityRemoved(socket, data, this.world);

    this.handlers["onSettingsModified"] = (socket, data) =>
      handleSettings(
        socket,
        data,
        this.world,
        this.broadcastManager.sendToAll.bind(this.broadcastManager),
      );

    // Processing / skill handlers (delegated to handlers/processing.ts)
    const processingCtx: ProcessingHandlerContext = {
      world: this.world,
      pendingGatherManager: this.pendingGatherManager,
      pendingCookManager: this.pendingCookManager,
      tileMovementManager: this.tileMovementManager,
      tickSystem: this.tickSystem,
      canProcessRequest: this.canProcessRequest.bind(this),
    };

    this.handlers["onResourceInteract"] = (socket, data) =>
      handleResourceInteract(socket, data, processingCtx);

    // Legacy: Direct gather (used after server has pathed player)
    this.handlers["onResourceGather"] = (socket, data) =>
      handleResourceGather(socket, data, this.world);

    this.handlers["onCookingSourceInteract"] = (socket, data) =>
      handleCookingSourceInteract(socket, data, processingCtx);

    this.handlers["onFiremakingRequest"] = (socket, data) =>
      handleFiremakingRequest(socket, data, processingCtx);
    this.handlers["firemakingRequest"] = this.handlers["onFiremakingRequest"];

    this.handlers["onCookingRequest"] = (socket, data) =>
      handleCookingRequest(socket, data, processingCtx);
    this.handlers["cookingRequest"] = this.handlers["onCookingRequest"];

    this.handlers["onSmeltingSourceInteract"] = (socket, data) =>
      handleSmeltingSourceInteract(socket, data, processingCtx);

    this.handlers["onSmithingSourceInteract"] = (socket, data) =>
      handleSmithingSourceInteract(socket, data, processingCtx);

    this.handlers["onProcessingSmelting"] = (socket, data) =>
      handleProcessingSmelting(socket, data, processingCtx);

    this.handlers["onProcessingSmithing"] = (socket, data) =>
      handleProcessingSmithing(socket, data, processingCtx);

    this.handlers["onCraftingSourceInteract"] = (socket, data) =>
      handleCraftingSourceInteract(socket, data, processingCtx);

    this.handlers["onProcessingCrafting"] = (socket, data) =>
      handleProcessingCrafting(socket, data, processingCtx);

    this.handlers["onFletchingSourceInteract"] = (socket, data) =>
      handleFletchingSourceInteract(socket, data, processingCtx);

    this.handlers["onProcessingFletching"] = (socket, data) =>
      handleProcessingFletching(socket, data, processingCtx);

    this.handlers["onProcessingTanning"] = (socket, data) =>
      handleProcessingTanning(socket, data, processingCtx);

    this.handlers["onRunecraftingAltarInteract"] = (socket, data) =>
      handleRunecraftingAltarInteract(socket, data, processingCtx);
    this.handlers["runecraftingAltarInteract"] =
      this.handlers["onRunecraftingAltarInteract"];

    this.handlers["onProcessingRequestStatus"] = (socket, data) =>
      handleProcessingRequestStatus(socket, data, processingCtx);
    this.handlers["processingRequestStatus"] =
      this.handlers["onProcessingRequestStatus"];

    this.handlers["onProcessingRequestRecovery"] = (socket, data) =>
      handleProcessingRequestRecovery(socket, data, processingCtx);
    this.handlers["processingRequestRecovery"] =
      this.handlers["onProcessingRequestRecovery"];

    // Movement is processed immediately — pathfinding and tileMovementStart broadcast
    // happen on packet receipt, not at the next tick boundary. Walking itself still
    // advances on the 600ms tick schedule via onTick(). This matches the documented
    // 30 Hz client input rate and removes the 0–600ms ActionQueue delay.
    this.handlers["onMoveRequest"] = (socket, data) => {
      // Cancel any pending actions when player moves elsewhere (classic MMORPG behavior)
      if (socket.player) {
        this.cancelAllPendingActions(socket.player.id, socket);
      }
      this.tileMovementManager.handleMoveRequest(socket, data);
    };

    this.handlers["onInput"] = (socket, data) => {
      // Legacy input handler - convert clicks to immediate move request
      const payload = data as LegacyInputPayload;
      if (payload.type === "click" && Array.isArray(payload.target)) {
        // Cancel any pending actions when player moves elsewhere (classic MMORPG behavior)
        if (socket.player) {
          this.cancelAllPendingActions(socket.player.id, socket);
        }
        this.tileMovementManager.handleMoveRequest(socket, {
          target: payload.target,
          runMode: payload.runMode,
        });
      }
    };

    // Combat - server-authoritative "walk to and attack" system
    // classic MMORPG-style: If in attack range, start combat immediately; otherwise queue pending attack
    // Melee range is CARDINAL ONLY for range 1, ranged/magic use Chebyshev distance
    this.handlers["onAttackMob"] = (socket, data) => {
      const playerEntity = socket.player;
      if (!playerEntity) {
        traceAttackMob("drop:no_player_on_socket", {
          socketId: socket.id,
          accountId: socket.accountId,
        });
        return;
      }

      const payload = data as AttackMobPayload;
      const targetId = payload.mobId || payload.targetId;
      traceAttackMob("packet:received", {
        socketId: socket.id,
        playerId: playerEntity.id,
        payloadMobId: payload.mobId,
        payloadTargetId: payload.targetId,
        tick: this.world.currentTick,
      });
      if (!targetId) {
        traceAttackMob("drop:missing_target_id", {
          socketId: socket.id,
          playerId: playerEntity.id,
        });
        return;
      }

      // Get mob entity directly from world entities
      const mobEntity = this.world.entities.get(targetId) as {
        position?: { x: number; y: number; z: number };
        config?: { currentHealth?: number; maxHealth?: number };
        type?: string;
      } | null;

      if (!mobEntity || !mobEntity.position) {
        traceAttackMob("drop:target_not_found_or_no_position", {
          playerId: playerEntity.id,
          targetId,
          hasMobEntity: Boolean(mobEntity),
        });
        return;
      }

      const redundantReason = this.getRedundantAttackReason(
        playerEntity.id,
        targetId,
        "mob",
      );
      if (redundantReason) {
        traceAttackMob("action:noop_redundant_same_target", {
          playerId: playerEntity.id,
          targetId,
          reason: redundantReason,
          tick: this.world.currentTick,
        });
        return;
      }

      // Cancel any existing combat, pending attacks, and queued actions when switching targets.
      // Re-clicking the same active/pending target is intentionally ignored above so repeated
      // clicks cannot reset attack timers or stall combat.
      this.world.emit(EventType.COMBAT_STOP_ATTACK, {
        attackerId: playerEntity.id,
      });
      this.cancelPendingPreparationApproaches(playerEntity.id);
      this.pendingAttackManager.cancelPendingAttack(playerEntity.id);
      this.actionQueue.cancelActions(playerEntity.id);
      this.followManager.stopFollowing(playerEntity.id);
      if (mobEntity.type !== "mob") {
        traceAttackMob("drop:target_not_mob", {
          playerId: playerEntity.id,
          targetId,
          targetType: mobEntity.type ?? null,
        });
        return;
      }
      const targetHealth = mobEntity.config?.currentHealth ?? 0;
      if (targetHealth <= 0) {
        traceAttackMob("drop:target_dead", {
          playerId: playerEntity.id,
          targetId,
          targetHealth,
        });
        return;
      }

      // Get player's weapon range and attack type from equipment system
      const attackRange = this.getPlayerWeaponRange(playerEntity.id);
      const attackType = this.getPlayerAttackType(playerEntity.id);

      // Get tiles for range check
      const playerPos = playerEntity.position;
      const playerTile = worldToTile(playerPos.x, playerPos.z);
      const targetTile = worldToTile(
        mobEntity.position.x,
        mobEntity.position.z,
      );
      const inRange = this.isInAttackRange(
        playerTile,
        targetTile,
        attackType,
        attackRange,
      );

      traceAttackMob("range:checked", {
        playerId: playerEntity.id,
        targetId,
        attackType,
        attackRange,
        playerTileX: playerTile.x,
        playerTileZ: playerTile.z,
        targetTileX: targetTile.x,
        targetTileZ: targetTile.z,
        inRange,
      });

      // Check if in attack range (melee uses cardinal-only, ranged/magic use Chebyshev)
      if (inRange) {
        // In range - start combat immediately via action queue
        traceAttackMob("action:queue_combat_now", {
          playerId: playerEntity.id,
          targetId,
          tick: this.world.currentTick,
        });
        this.actionQueue.queueCombat(socket, data);
      } else {
        // Not in range - queue pending attack (server handles classic MMORPG-style pathfinding)
        traceAttackMob("action:queue_pending_attack", {
          playerId: playerEntity.id,
          targetId,
          attackRange,
          attackType,
          tick: this.world.currentTick,
        });
        this.pendingAttackManager.queuePendingAttack(
          playerEntity.id,
          targetId,
          this.world.currentTick,
          attackRange,
          "mob",
          attackType,
        );
      }
    };

    // PvP - attack another player (only in PvP zones)
    this.handlers["onAttackPlayer"] = (socket, data) => {
      const playerEntity = socket.player;
      if (!playerEntity) return;

      const payload = data as AttackPlayerPayload;
      const targetPlayerId = payload.targetPlayerId;
      if (!targetPlayerId) return;

      // Get target player entity
      const targetPlayer = this.world.entities?.players?.get(
        targetPlayerId,
      ) as {
        position?: { x: number; y: number; z: number };
      } | null;

      if (!targetPlayer || !targetPlayer.position) return;

      const redundantReason = this.getRedundantAttackReason(
        playerEntity.id,
        targetPlayerId,
        "player",
      );
      if (redundantReason) return;

      // Cancel any existing combat, pending attacks, and queued actions when switching targets.
      // Re-clicking the same active/pending target is intentionally ignored above so repeated
      // clicks cannot reset attack timers or stall combat.
      this.world.emit(EventType.COMBAT_STOP_ATTACK, {
        attackerId: playerEntity.id,
      });
      this.cancelPendingPreparationApproaches(playerEntity.id);
      this.pendingAttackManager.cancelPendingAttack(playerEntity.id);
      this.actionQueue.cancelActions(playerEntity.id);
      this.followManager.stopFollowing(playerEntity.id);

      // Get player's weapon range and attack type from equipment system
      const attackRange = this.getPlayerWeaponRange(playerEntity.id);
      const attackType = this.getPlayerAttackType(playerEntity.id);

      // Get tiles for range check
      const playerPos = playerEntity.position;
      const playerTile = worldToTile(playerPos.x, playerPos.z);
      const targetTile = worldToTile(
        targetPlayer.position.x,
        targetPlayer.position.z,
      );

      // Check if in attack range (melee uses cardinal-only, ranged/magic use Chebyshev)
      if (
        this.isInAttackRange(playerTile, targetTile, attackType, attackRange)
      ) {
        // In range - validate zones and start combat immediately
        handleAttackPlayer(socket, data, this.world);
      } else {
        // Not in range - validate zones first, then queue pending attack
        // Zone validation happens in handleAttackPlayer, so we do basic checks here
        const zoneSystem = this.world.getSystem("zone-detection") as {
          isPvPEnabled?: (pos: { x: number; z: number }) => boolean;
        } | null;

        if (zoneSystem?.isPvPEnabled) {
          const attackerPos = playerEntity.position;
          if (
            !attackerPos ||
            !zoneSystem.isPvPEnabled({ x: attackerPos.x, z: attackerPos.z })
          ) {
            // Attacker not in PvP zone - silently ignore
            return;
          }
          if (
            !zoneSystem.isPvPEnabled({
              x: targetPlayer.position.x,
              z: targetPlayer.position.z,
            })
          ) {
            // Target not in PvP zone - silently ignore
            return;
          }
        }

        // Queue pending attack - will move toward target and attack when in range
        this.pendingAttackManager.queuePendingAttack(
          playerEntity.id,
          targetPlayerId,
          this.world.currentTick,
          attackRange,
          "player", // PvP target type
          attackType,
        );
      }
    };

    // Follow another player (classic MMORPG-style)
    this.handlers["onFollowPlayer"] = (socket, data) => {
      const playerEntity = socket.player;
      if (!playerEntity) return;

      // Cancel any pending attack when starting to follow
      this.pendingAttackManager.cancelPendingAttack(playerEntity.id);

      // Validate and start following
      handleFollowPlayer(socket, data, this.world, this.followManager);
    };

    this.handlers["onChangeAttackStyle"] = (socket, data) =>
      handleChangeAttackStyle(socket, data, this.world);

    this.handlers["onSetAutoRetaliate"] = (socket, data) =>
      handleSetAutoRetaliate(socket, data, this.world);

    // Autocast spell selection (F2P magic combat)
    this.handlers["onSetAutocast"] = (socket, data) => {
      const playerEntity = socket.player;
      if (!playerEntity) return;

      const payload = data as SetAutocastPayload;
      const spellId = payload.spellId;

      // Validate spell ID if provided
      if (spellId !== null && spellId !== undefined) {
        if (typeof spellId !== "string" || spellId.length > 50) {
          return;
        }
      }

      // Emit event to update player's selected spell
      this.world.emit(EventType.PLAYER_SET_AUTOCAST, {
        playerId: playerEntity.id,
        spellId: spellId ?? null,
      });
    };

    this.handlers["onPickupItem"] = (socket, data) =>
      handlePickupItem(socket, data, this.world);

    // Gravestone loot-all: client requests to loot all items from a gravestone
    this.handlers["onCorpseLootAll"] = (socket, data) => {
      const player = socket.player;
      if (!player) return;
      const payload = data as CorpseLootAllPayload;
      if (!payload.corpseId) return;
      this.world.emit(EventType.CORPSE_LOOT_ALL_REQUEST, {
        corpseId: payload.corpseId,
        playerId: player.id,
      });
    };
    this.handlers["corpseLootAll"] = this.handlers["onCorpseLootAll"];

    this.handlers["onDropItem"] = (socket, data) =>
      handleDropItem(socket, data, this.world);

    this.handlers["onEquipItem"] = (socket, data) =>
      handleEquipItem(socket, data, this.world);

    this.handlers["onUseItem"] = (socket, data) =>
      handleUseItem(socket, data, this.world);

    this.handlers["onUnequipItem"] = (socket, data) =>
      handleUnequipItem(socket, data, this.world);

    this.handlers["onMoveItem"] = (socket, data) =>
      handleMoveItem(socket, data, this.world);

    this.handlers["onCoinPouchWithdraw"] = (socket, data) =>
      handleCoinPouchWithdraw(socket, data as CoinAmountPayload, this.world);

    this.handlers["onXpLampUse"] = (socket, data) =>
      handleXpLampUse(socket, data, this.world);

    // Prayer handlers
    this.handlers["onPrayerToggle"] = (socket, data) =>
      handlePrayerToggle(socket, data, this.world);
    this.handlers["prayerToggle"] = this.handlers["onPrayerToggle"];

    this.handlers["onPrayerDeactivateAll"] = (socket, data) =>
      handlePrayerDeactivateAll(socket, data, this.world);
    this.handlers["prayerDeactivateAll"] =
      this.handlers["onPrayerDeactivateAll"];

    this.handlers["onAltarPray"] = (socket, data) =>
      handleAltarPray(socket, data, this.world);
    this.handlers["altarPray"] = this.handlers["onAltarPray"];

    // Magic handlers
    this.handlers["onSetAutocast"] = (socket, data) =>
      handleSetAutocast(socket, data, this.world);
    this.handlers["setAutocast"] = this.handlers["onSetAutocast"];

    // Action bar handlers
    this.handlers["onActionBarSave"] = (socket, data) =>
      handleActionBarSave(socket, data, this.world);
    this.handlers["actionBarSave"] = this.handlers["onActionBarSave"];

    this.handlers["onActionBarLoad"] = (socket, data) =>
      handleActionBarLoad(socket, data, this.world);
    this.handlers["actionBarLoad"] = this.handlers["onActionBarLoad"];

    // Player name change handler
    this.handlers["changePlayerName"] = (socket, data) =>
      handleChangePlayerName(
        socket,
        data,
        this.world,
        this.broadcastManager.sendToAll.bind(this.broadcastManager),
      );

    // Death/respawn handlers
    this.handlers["onRequestRespawn"] = (socket, _data) => {
      const playerEntity = socket.player;
      if (playerEntity) {
        // Validate player is actually dead before allowing respawn
        // This prevents clients from sending fake respawn requests
        const entityData = playerEntity.data as
          { deathState?: DeathState } | undefined;
        const isDead =
          entityData?.deathState === DeathState.DYING ||
          entityData?.deathState === DeathState.DEAD;

        if (!isDead) {
          console.warn(
            `[ServerNetwork] Rejected respawn request from ${playerEntity.id} - player is not dead`,
          );
          return;
        }

        console.log(
          `[ServerNetwork] Received respawn request from player ${playerEntity.id}`,
        );
        this.world.emit(EventType.PLAYER_RESPAWN_REQUEST, {
          playerId: playerEntity.id,
        });
      } else {
        console.warn(
          "[ServerNetwork] requestRespawn: no player entity on socket",
        );
      }
    };

    // Home teleport handlers
    this.handlers["onHomeTeleport"] = (socket, data) =>
      handleHomeTeleport(
        socket,
        data,
        this.world,
        this.tickSystem.getCurrentTick(),
      );
    this.handlers["homeTeleport"] = (socket, data) =>
      handleHomeTeleport(
        socket,
        data,
        this.world,
        this.tickSystem.getCurrentTick(),
      );

    this.handlers["onHomeTeleportCancel"] = (socket, data) =>
      handleHomeTeleportCancel(socket, data);
    this.handlers["homeTeleportCancel"] = (socket, data) =>
      handleHomeTeleportCancel(socket, data);

    // Character selection handlers
    // Support both with and without "on" prefix for client compatibility
    this.handlers["onCharacterListRequest"] = (socket) =>
      handleCharacterListRequest(socket, this.world);
    this.handlers["characterListRequest"] = (socket) =>
      handleCharacterListRequest(socket, this.world);

    this.handlers["onCharacterCreate"] = (socket, data) =>
      handleCharacterCreate(
        socket,
        data,
        this.world,
        this.broadcastManager.sendToSocket.bind(this.broadcastManager),
      );
    this.handlers["characterCreate"] = (socket, data) =>
      handleCharacterCreate(
        socket,
        data,
        this.world,
        this.broadcastManager.sendToSocket.bind(this.broadcastManager),
      );

    this.handlers["onCharacterSelected"] = (socket, data) =>
      handleCharacterSelected(
        socket,
        data,
        this.broadcastManager.sendToSocket.bind(this.broadcastManager),
      );
    this.handlers["characterSelected"] = (socket, data) =>
      handleCharacterSelected(
        socket,
        data,
        this.broadcastManager.sendToSocket.bind(this.broadcastManager),
      );

    this.handlers["onEnterWorld"] = (socket, data) =>
      this.handleEnterWorldWithReconnect(socket, data);
    this.handlers["enterWorld"] = (socket, data) =>
      this.handleEnterWorldWithReconnect(socket, data);

    // Client ready handler - player is now active and can be targeted
    // Sent by client when all assets have finished loading
    this.handlers["onClientReady"] = (socket) => {
      if (!socket.player) {
        // Spectators do not own a player entity and still emit clientReady after
        // finishing viewport load. Treat this as expected.
        if (socket.isSpectator === true) {
          return;
        }

        const isRegistered = this.sockets.has(socket.id);
        const hasIdentity =
          !!socket.accountId ||
          !!socket.characterId ||
          !!socket.selectedCharacterId;

        // Ignore stale clientReady packets from sockets already removed from
        // active registry (observed during rapid reconnect/disconnect churn).
        if (!isRegistered) {
          if (IS_PLAYWRIGHT_TEST) {
            warnPlaywrightThrottled(
              "clientReady_stale_socket",
              "[PlayerLoading] Ignoring clientReady from stale socket",
              {
                socketId: socket.id,
                accountId: socket.accountId,
                characterId: socket.characterId,
                selectedCharacterId: socket.selectedCharacterId,
              },
            );
          }
          return;
        }

        // Anonymous sockets should not buffer readiness in E2E mode.
        if (IS_PLAYWRIGHT_TEST && !hasIdentity) {
          warnPlaywrightThrottled(
            "clientReady_missing_identity",
            "[PlayerLoading] Ignoring clientReady without account/character identity",
            {
              socketId: socket.id,
              isRegistered,
            },
          );
          return;
        }

        socket.pendingClientReady = true;
        warnPlaywrightThrottled(
          "clientReady_buffered",
          "[PlayerLoading] clientReady received before player attach; buffering",
          {
            socketId: socket.id,
            accountId: socket.accountId,
            characterId: socket.characterId,
            selectedCharacterId: socket.selectedCharacterId,
            isRegistered,
          },
        );
        return;
      }

      const player = socket.player;

      // Validate ownership - only the owning socket can mark player as ready
      if (player.data.owner !== socket.id) {
        console.warn(
          `[PlayerLoading] clientReady rejected: socket ${socket.id} doesn't own player ${player.id}`,
        );
        return;
      }

      // Ignore duplicate clientReady packets (idempotent)
      if (!player.data.isLoading) {
        return;
      }

      console.log(
        `[PlayerLoading] Received clientReady from player ${player.id}`,
      );
      console.log(
        `[PlayerLoading] Player ${player.id} isLoading: ${player.data.isLoading} -> false`,
      );

      // Mark player as no longer loading
      player.data.isLoading = false;
      if (socket.clientReadyTimeoutId) {
        clearTimeout(socket.clientReadyTimeoutId);
        socket.clientReadyTimeoutId = undefined;
      }

      // Broadcast state change to all clients
      this.broadcastManager.sendToAll("entityModified", {
        id: player.id,
        changes: { isLoading: false },
      });

      console.log(
        `[PlayerLoading] Player ${player.id} now active and targetable`,
      );

      // Emit event for other systems
      this.world.emit(EventType.PLAYER_READY, {
        playerId: player.id,
      });
    };

    // Agent goal sync handler - stores goal and available goals for dashboard display
    this.handlers["onSyncGoal"] = (socket, data) => {
      const goalData = data as AgentGoalSyncPayload;
      if (goalData.characterId) {
        // Store goal
        ServerNetwork.agentGoals.set(goalData.characterId, goalData.goal);

        // Store available goals if provided
        if (goalData.availableGoals) {
          ServerNetwork.agentAvailableGoals.set(
            goalData.characterId,
            goalData.availableGoals,
          );
        }

        // Store personality traits if provided
        if (goalData.personality) {
          ServerNetwork.agentPersonality.set(
            goalData.characterId,
            goalData.personality,
          );
        }

        // Store desire scores if provided
        if (goalData.desireScores) {
          ServerNetwork.agentDesireScores.set(
            goalData.characterId,
            goalData.desireScores,
          );
        }

        // Track socket for this character (for sending goal overrides)
        ServerNetwork.characterSockets.set(goalData.characterId, socket);
        this.trimAgentDashboardCaches();

        if (DEBUG_AGENT_DASHBOARD_SYNC) {
          console.log(
            `[ServerNetwork] Goal synced for character ${goalData.characterId}:`,
            goalData.goal ? "active" : "cleared",
            goalData.availableGoals
              ? `(${goalData.availableGoals.length} available goals)`
              : "",
          );
        }
      }
    };

    // Agent thought sync handler - stores agent thought process for dashboard display
    this.handlers["onSyncAgentThought"] = (_socket, data) => {
      const thoughtData = data as AgentThoughtSyncPayload;

      if (thoughtData.characterId && thoughtData.thought) {
        // Get existing thoughts or create new array
        const thoughts =
          ServerNetwork.agentThoughts.get(thoughtData.characterId) || [];

        // Add new thought at the beginning (most recent first)
        thoughts.unshift(thoughtData.thought);

        // Limit stored thoughts
        if (thoughts.length > ServerNetwork.MAX_THOUGHTS_PER_AGENT) {
          thoughts.length = ServerNetwork.MAX_THOUGHTS_PER_AGENT;
        }

        ServerNetwork.agentThoughts.set(thoughtData.characterId, thoughts);
        this.trimAgentDashboardCaches();

        if (DEBUG_AGENT_DASHBOARD_SYNC) {
          console.log(
            `[ServerNetwork] Agent thought synced for character ${thoughtData.characterId}: [${thoughtData.thought.type}]`,
          );
        }
      }
    };

    // Bank handlers
    this.handlers["onBankOpen"] = (socket, data) =>
      handleBankOpen(socket, data as BankOpenPayload, this.world);

    this.handlers["onBankDeposit"] = (socket, data) =>
      handleBankDeposit(socket, data as BankDepositPayload, this.world);

    this.handlers["onBankWithdraw"] = (socket, data) =>
      handleBankWithdraw(socket, data as BankWithdrawPayload, this.world);

    this.handlers["onBankDepositAll"] = (socket, data) =>
      handleBankDepositAll(socket, data as BankDepositAllPayload, this.world);

    this.handlers["onBankDepositCoins"] = (socket, data) =>
      handleBankDepositCoins(socket, data as CoinAmountPayload, this.world);

    this.handlers["onBankWithdrawCoins"] = (socket, data) =>
      handleBankWithdrawCoins(socket, data as CoinAmountPayload, this.world);

    this.handlers["onBankClose"] = (socket, data) =>
      handleBankClose(socket, data, this.world);

    this.handlers["onBankMove"] = (socket, data) =>
      handleBankMove(socket, data as BankMovePayload, this.world);

    // Bank tab handlers
    this.handlers["onBankCreateTab"] = (socket, data) =>
      handleBankCreateTab(socket, data as BankCreateTabPayload, this.world);

    this.handlers["onBankDeleteTab"] = (socket, data) =>
      handleBankDeleteTab(socket, data as BankDeleteTabPayload, this.world);

    this.handlers["onBankMoveToTab"] = (socket, data) =>
      handleBankMoveToTab(socket, data as BankMoveToTabPayload, this.world);

    // Bank placeholder handlers (modern MMORPG style: qty=0 in bank_storage)
    this.handlers["onBankWithdrawPlaceholder"] = (socket, data) =>
      handleBankWithdrawPlaceholder(
        socket,
        data as BankItemPayload,
        this.world,
      );

    this.handlers["onBankReleasePlaceholder"] = (socket, data) =>
      handleBankReleasePlaceholder(socket, data as BankSlotPayload, this.world);

    this.handlers["onBankReleaseAllPlaceholders"] = (socket, data) =>
      handleBankReleaseAllPlaceholders(socket, data, this.world);

    this.handlers["onBankToggleAlwaysPlaceholder"] = (socket, data) =>
      handleBankToggleAlwaysPlaceholder(socket, data, this.world);

    // Bank equipment tab handlers (modern MMORPG-style equipment view)
    this.handlers["onBankWithdrawToEquipment"] = (socket, data) =>
      handleBankWithdrawToEquipment(
        socket,
        data as BankWithdrawToEquipmentPayload,
        this.world,
      );

    this.handlers["onBankDepositEquipment"] = (socket, data) =>
      handleBankDepositEquipment(
        socket,
        data as BankDepositEquipmentPayload,
        this.world,
      );

    this.handlers["onBankDepositAllEquipment"] = (socket, data) =>
      handleBankDepositAllEquipment(socket, data, this.world);

    // Bank handler aliases without "on" prefix for client compatibility
    // Client sends "bankDeposit", server has "onBankDeposit"
    this.handlers["bankOpen"] = this.handlers["onBankOpen"];
    this.handlers["bankDeposit"] = this.handlers["onBankDeposit"];
    this.handlers["bankWithdraw"] = this.handlers["onBankWithdraw"];
    this.handlers["bankDepositAll"] = this.handlers["onBankDepositAll"];
    this.handlers["onExternalAgentBankTransfer"] = (socket, data) =>
      handleExternalAgentBankTransfer(socket, data, this.world);
    this.handlers["externalAgentBankTransfer"] =
      this.handlers["onExternalAgentBankTransfer"];
    this.handlers["onExternalAgentBankRecovery"] = (socket, data) =>
      handleExternalAgentBankRecovery(socket, data, this.world);
    this.handlers["externalAgentBankRecovery"] =
      this.handlers["onExternalAgentBankRecovery"];
    this.handlers["onDuelPreparationHostLease"] = (socket, data) =>
      handleDuelPreparationHostLease(socket, data, this.world);
    this.handlers["duelPreparationHostLease"] =
      this.handlers["onDuelPreparationHostLease"];
    this.handlers["onDuelPreparationStrategy"] = (socket, data) =>
      handleDuelPreparationStrategy(socket, data, this.world);
    this.handlers["duelPreparationStrategy"] =
      this.handlers["onDuelPreparationStrategy"];
    this.handlers["bankDepositCoins"] = this.handlers["onBankDepositCoins"];
    this.handlers["bankWithdrawCoins"] = this.handlers["onBankWithdrawCoins"];
    this.handlers["bankClose"] = this.handlers["onBankClose"];
    this.handlers["bankMove"] = this.handlers["onBankMove"];
    this.handlers["bankCreateTab"] = this.handlers["onBankCreateTab"];
    this.handlers["bankDeleteTab"] = this.handlers["onBankDeleteTab"];
    this.handlers["bankMoveToTab"] = this.handlers["onBankMoveToTab"];
    this.handlers["bankWithdrawPlaceholder"] =
      this.handlers["onBankWithdrawPlaceholder"];
    this.handlers["bankReleasePlaceholder"] =
      this.handlers["onBankReleasePlaceholder"];
    this.handlers["bankReleaseAllPlaceholders"] =
      this.handlers["onBankReleaseAllPlaceholders"];
    this.handlers["bankToggleAlwaysPlaceholder"] =
      this.handlers["onBankToggleAlwaysPlaceholder"];
    this.handlers["bankWithdrawToEquipment"] =
      this.handlers["onBankWithdrawToEquipment"];
    this.handlers["bankDepositEquipment"] =
      this.handlers["onBankDepositEquipment"];
    this.handlers["bankDepositAllEquipment"] =
      this.handlers["onBankDepositAllEquipment"];

    // Bank state query (no bank NPC required)
    this.handlers["onRequestBankState"] = (socket, data) =>
      handleRequestBankState(socket, data, this.world);
    this.handlers["requestBankState"] = this.handlers["onRequestBankState"];

    // Application-level keepalive (no-op on server — its only purpose is to keep
    // Cloudflare/reverse-proxy WebSocket connections alive by sending application data)
    this.handlers["onKeepalive"] = () => {
      // Intentionally empty — receiving this packet is enough to reset proxy idle timers
    };
    this.handlers["keepalive"] = this.handlers["onKeepalive"];

    // NPC interaction handler - client clicked on NPC
    this.handlers["onNpcInteract"] = (socket, data) => {
      const playerEntity = socket.player;
      if (!playerEntity) return;

      const payload = data as NpcInteractPayload;

      // Emit NPC_INTERACTION event for DialogueSystem to handle
      // npcId is the entity instance ID, pass as npcEntityId for distance checking
      this.world.emit(EventType.NPC_INTERACTION, {
        playerId: playerEntity.id,
        npcId: payload.npcId,
        npc: payload.npc,
        npcEntityId: payload.npcId,
      });
    };

    // Dialogue handlers (with input validation)
    this.handlers["onDialogueResponse"] = (socket, data) =>
      handleDialogueResponse(
        socket,
        data as DialogueResponsePayload,
        this.world,
      );

    this.handlers["onDialogueContinue"] = (socket, data) =>
      handleDialogueContinue(socket, data as DialogueNpcPayload, this.world);

    this.handlers["onDialogueClose"] = (socket, data) =>
      handleDialogueClose(socket, data as DialogueNpcPayload, this.world);

    // Quest handlers
    this.handlers["onGetQuestList"] = (socket, data) =>
      handleGetQuestList(socket, data as Record<string, unknown>, this.world);
    this.handlers["getQuestList"] = this.handlers["onGetQuestList"];

    this.handlers["onGetQuestDetail"] = (socket, data) =>
      handleGetQuestDetail(socket, data as QuestIdPayload, this.world);
    this.handlers["getQuestDetail"] = this.handlers["onGetQuestDetail"];

    this.handlers["onQuestAccept"] = (socket, data) =>
      handleQuestAccept(socket, data as QuestIdPayload, this.world);
    this.handlers["questAccept"] = this.handlers["onQuestAccept"];

    this.handlers["onQuestAbandon"] = (socket, data) =>
      handleQuestAbandon(socket, data as QuestIdPayload, this.world);
    this.handlers["questAbandon"] = this.handlers["onQuestAbandon"];

    this.handlers["onQuestComplete"] = (socket, data) =>
      handleQuestComplete(socket, data as QuestIdPayload, this.world);
    this.handlers["questComplete"] = this.handlers["onQuestComplete"];

    // Store handlers
    this.handlers["onStoreOpen"] = (socket, data) =>
      handleStoreOpen(socket, data as StoreOpenPayload, this.world);

    this.handlers["onStoreBuy"] = async (socket, data) => {
      await handleStoreBuy(socket, data as StoreItemPayload, this.world);
    };

    this.handlers["onStoreSell"] = async (socket, data) => {
      await handleStoreSell(socket, data as StoreItemPayload, this.world);
    };

    this.handlers["onStoreClose"] = (socket, data) =>
      handleStoreClose(socket, data as StoreClosePayload, this.world);

    // Generic entity interaction handler - for entities like starter chests
    this.handlers["onEntityInteract"] = async (socket, data) => {
      const playerEntity = socket.player;
      if (!playerEntity) {
        console.warn(
          "[ServerNetwork] entityInteract: no player entity on socket",
        );
        return;
      }

      const payload = data as EntityInteractPayload;

      console.log(
        `[ServerNetwork] entityInteract received: entityId=${payload.entityId}, interactionType=${payload.interactionType}, playerId=${playerEntity.id}`,
      );

      if (!payload.entityId) {
        console.warn("[ServerNetwork] entityInteract missing entityId");
        return;
      }

      // Find the entity in the world
      const entity = this.world.entities.get(payload.entityId);
      if (!entity) {
        console.warn(
          `[ServerNetwork] entityInteract: entity ${payload.entityId} not found`,
        );
        return;
      }

      console.log(
        `[ServerNetwork] Found entity: type=${entity.type}, name=${entity.name}`,
      );

      // Autonomous clients may select the Tanner service without navigating a
      // conversational UI. Bind that shortcut to the exact live NPC identity;
      // TanningSystem independently revalidates type, manifest ID, range, and
      // duel state before creating the session.
      if (payload.interactionType === "tan") {
        const networkData = entity.getNetworkData();
        const npcType = networkData.npcType;
        const npcId = networkData.npcId;
        if (npcType !== "tanner" || typeof npcId !== "string" || !npcId) {
          console.warn(
            `[ServerNetwork] Rejected tanning interaction for non-Tanner entity ${payload.entityId}`,
          );
          return;
        }
        this.world.emit(EventType.TANNING_INTERACT, {
          playerId: playerEntity.id,
          npcId,
          npcEntityId: payload.entityId,
        });
        return;
      }

      // Check if entity has handleInteraction method
      const interactableEntity = entity as unknown as {
        handleInteraction?: (data: {
          playerId: string;
          entityId: string;
          interactionType: string;
          position: { x: number; y: number; z: number };
          playerPosition: { x: number; y: number; z: number };
        }) => Promise<void>;
      };

      if (typeof interactableEntity.handleInteraction === "function") {
        console.log(
          `[ServerNetwork] Calling handleInteraction on ${entity.type} entity`,
        );
        try {
          // Build full EntityInteractionData
          const entityPos = entity.position ?? { x: 0, y: 0, z: 0 };
          const playerPos = playerEntity.position ?? { x: 0, y: 0, z: 0 };

          await interactableEntity.handleInteraction({
            playerId: playerEntity.id,
            entityId: payload.entityId,
            interactionType: payload.interactionType || "interact",
            position: { x: entityPos.x, y: entityPos.y, z: entityPos.z },
            playerPosition: { x: playerPos.x, y: playerPos.y, z: playerPos.z },
          });
          console.log(
            `[ServerNetwork] handleInteraction completed for ${entity.type}`,
          );
        } catch (err) {
          console.error(`[ServerNetwork] Error in entity interaction: ${err}`);
        }
      } else {
        console.warn(
          `[ServerNetwork] Entity ${payload.entityId} has no handleInteraction method`,
        );
      }
    };
    // Also register without "on" prefix for client compatibility
    this.handlers["entityInteract"] = this.handlers["onEntityInteract"];

    // Trade handlers
    this.handlers["onTradeRequest"] = (socket, data) =>
      handleTradeRequest(socket, data as TradeRequestPayload, this.world);

    this.handlers["tradeRequest"] = (socket, data) =>
      handleTradeRequest(socket, data as TradeRequestPayload, this.world);

    this.handlers["onTradeRequestRespond"] = (socket, data) =>
      handleTradeRequestRespond(
        socket,
        data as TradeRespondPayload,
        this.world,
      );
    this.handlers["tradeRequestRespond"] =
      this.handlers["onTradeRequestRespond"];

    this.handlers["onTradeAddItem"] = (socket, data) => {
      const db = getDatabase(this.world);
      if (!db) {
        console.error(
          "[ServerNetwork] Database not available for trade add item",
        );
        return;
      }
      handleTradeAddItem(socket, data as TradeItemPayload, this.world, db);
    };

    this.handlers["tradeAddItem"] = (socket, data) => {
      const db = getDatabase(this.world);
      if (!db) {
        console.error(
          "[ServerNetwork] Database not available for trade add item",
        );
        return;
      }
      handleTradeAddItem(socket, data as TradeItemPayload, this.world, db);
    };

    this.handlers["onTradeRemoveItem"] = (socket, data) =>
      handleTradeRemoveItem(socket, data as TradeSlotPayload, this.world);

    this.handlers["tradeRemoveItem"] = (socket, data) =>
      handleTradeRemoveItem(socket, data as TradeSlotPayload, this.world);

    this.handlers["onTradeSetItemQuantity"] = (socket, data) => {
      const db = getDatabase(this.world);
      if (!db) {
        console.error(
          "[ServerNetwork] Database not available for trade set quantity",
        );
        return;
      }
      handleTradeSetQuantity(
        socket,
        data as TradeSetQuantityPayload,
        this.world,
        db,
      );
    };

    this.handlers["tradeSetItemQuantity"] = (socket, data) => {
      const db = getDatabase(this.world);
      if (!db) {
        console.error(
          "[ServerNetwork] Database not available for trade set quantity",
        );
        return;
      }
      handleTradeSetQuantity(
        socket,
        data as TradeSetQuantityPayload,
        this.world,
        db,
      );
    };

    this.handlers["onTradeAccept"] = (socket, data) => {
      const db = getDatabase(this.world);
      if (!db) {
        console.error(
          "[ServerNetwork] Database not available for trade accept",
        );
        return;
      }
      handleTradeAccept(socket, data as TradeIdPayload, this.world, db);
    };

    this.handlers["tradeAccept"] = (socket, data) => {
      const db = getDatabase(this.world);
      if (!db) {
        console.error(
          "[ServerNetwork] Database not available for trade accept",
        );
        return;
      }
      handleTradeAccept(socket, data as TradeIdPayload, this.world, db);
    };

    this.handlers["onTradeCancelAccept"] = (socket, data) =>
      handleTradeCancelAccept(socket, data as TradeIdPayload, this.world);

    this.handlers["tradeCancelAccept"] = (socket, data) =>
      handleTradeCancelAccept(socket, data as TradeIdPayload, this.world);

    this.handlers["onTradeCancel"] = (socket, data) =>
      handleTradeCancel(socket, data as TradeIdPayload, this.world);

    this.handlers["tradeCancel"] = (socket, data) =>
      handleTradeCancel(socket, data as TradeIdPayload, this.world);

    // Duel handlers
    this.handlers["onDuelChallenge"] = (socket, data) =>
      handleDuelChallenge(socket, data as DuelChallengePayload, this.world);

    this.handlers["duel:challenge"] = (socket, data) =>
      handleDuelChallenge(socket, data as DuelChallengePayload, this.world);

    // Also register with "on" prefix (packet transformation adds this)
    this.handlers["onDuel:challenge"] = (socket, data) =>
      handleDuelChallenge(socket, data as DuelChallengePayload, this.world);

    this.handlers["onDuelChallengeRespond"] = (socket, data) =>
      handleDuelChallengeRespond(
        socket,
        data as DuelChallengeRespondPayload,
        this.world,
      );

    this.handlers["duel:challenge:respond"] = (socket, data) =>
      handleDuelChallengeRespond(
        socket,
        data as DuelChallengeRespondPayload,
        this.world,
      );

    // Also register with "on" prefix (packet transformation adds this)
    this.handlers["onDuel:challenge:respond"] = (socket, data) =>
      handleDuelChallengeRespond(
        socket,
        data as DuelChallengeRespondPayload,
        this.world,
      );

    // Duel rules handlers (register with both formats for packet routing)
    this.handlers["duel:toggle:rule"] = (socket, data) =>
      handleDuelToggleRule(socket, data as DuelToggleRulePayload, this.world);
    this.handlers["onDuel:toggle:rule"] = this.handlers["duel:toggle:rule"];

    this.handlers["duel:toggle:equipment"] = (socket, data) =>
      handleDuelToggleEquipment(
        socket,
        data as DuelToggleEquipmentPayload,
        this.world,
      );
    this.handlers["onDuel:toggle:equipment"] =
      this.handlers["duel:toggle:equipment"];

    this.handlers["duel:accept:rules"] = (socket, data) =>
      handleDuelAcceptRules(socket, data as DuelIdPayload, this.world);
    this.handlers["onDuel:accept:rules"] = this.handlers["duel:accept:rules"];

    this.handlers["duel:cancel"] = (socket, data) =>
      handleDuelCancel(socket, data as DuelIdPayload, this.world);
    this.handlers["onDuel:cancel"] = this.handlers["duel:cancel"];

    // Duel stakes handlers
    this.handlers["duel:add:stake"] = (socket, data) => {
      const db = getDatabase(this.world);
      if (!db) {
        console.error(
          "[ServerNetwork] Database not available for duel add stake",
        );
        return;
      }
      handleDuelAddStake(socket, data as DuelAddStakePayload, this.world, db);
    };
    this.handlers["onDuel:add:stake"] = this.handlers["duel:add:stake"];

    this.handlers["duel:remove:stake"] = (socket, data) => {
      const db = getDatabase(this.world);
      if (!db) {
        console.error(
          "[ServerNetwork] Database not available for duel remove stake",
        );
        return;
      }
      handleDuelRemoveStake(
        socket,
        data as DuelRemoveStakePayload,
        this.world,
        db,
      );
    };
    this.handlers["onDuel:remove:stake"] = this.handlers["duel:remove:stake"];

    this.handlers["duel:accept:stakes"] = (socket, data) =>
      handleDuelAcceptStakes(socket, data as DuelIdPayload, this.world);
    this.handlers["onDuel:accept:stakes"] = this.handlers["duel:accept:stakes"];

    this.handlers["duel:accept:final"] = (socket, data) =>
      handleDuelAcceptFinal(socket, data as DuelIdPayload, this.world);
    this.handlers["onDuel:accept:final"] = this.handlers["duel:accept:final"];

    this.handlers["duel:forfeit"] = (socket, data) =>
      handleDuelForfeit(socket, data as DuelIdPayload, this.world);
    this.handlers["onDuel:forfeit"] = this.handlers["duel:forfeit"];

    // Friend/Social handlers
    this.handlers["onFriendRequest"] = (socket, data) =>
      handleFriendRequest(socket, data as FriendTargetNamePayload, this.world);
    this.handlers["friendRequest"] = this.handlers["onFriendRequest"];

    this.handlers["onFriendAccept"] = (socket, data) =>
      handleFriendAccept(socket, data as FriendRequestIdPayload, this.world);
    this.handlers["friendAccept"] = this.handlers["onFriendAccept"];

    this.handlers["onFriendDecline"] = (socket, data) =>
      handleFriendDecline(socket, data as FriendRequestIdPayload, this.world);
    this.handlers["friendDecline"] = this.handlers["onFriendDecline"];

    this.handlers["onFriendRemove"] = (socket, data) =>
      handleFriendRemove(socket, data as FriendIdPayload, this.world);
    this.handlers["friendRemove"] = this.handlers["onFriendRemove"];

    this.handlers["onIgnoreAdd"] = (socket, data) =>
      handleIgnoreAdd(socket, data as FriendTargetNamePayload, this.world);
    this.handlers["ignoreAdd"] = this.handlers["onIgnoreAdd"];

    this.handlers["onIgnoreRemove"] = (socket, data) =>
      handleIgnoreRemove(socket, data as IgnoreIdPayload, this.world);
    this.handlers["ignoreRemove"] = this.handlers["onIgnoreRemove"];

    this.handlers["onPrivateMessage"] = (socket, data) =>
      handlePrivateMessage(socket, data as PrivateMessagePayload, this.world);
    this.handlers["privateMessage"] = this.handlers["onPrivateMessage"];
  }

  /**
   * Enter world handler with reconnection support.
   *
   * If the player disconnected within the 30-second grace period, their entity
   * is still alive in-world. This method checks for that case first and
   * re-associates the entity with the new socket, skipping the full spawn flow.
   */
  private async handleEnterWorldWithReconnect(
    socket: ServerSocket,
    data: unknown,
  ): Promise<void> {
    const accountId = socket.accountId;
    if (accountId) {
      const requestedCharacterId =
        (data as { characterId?: string } | null)?.characterId ||
        socket.selectedCharacterId ||
        socket.agentCredentialCharacterId ||
        socket.characterId;
      const reconnectedPlayerId = this.socketManager.tryReconnect(
        accountId,
        socket,
        requestedCharacterId,
      );
      if (reconnectedPlayerId) {
        const sendToFn = this.broadcastManager.sendToSocket.bind(
          this.broadcastManager,
        );
        const sendFn = this.broadcastManager.sendToAll.bind(
          this.broadcastManager,
        );

        // Update entity ownership to new socket
        const entity = this.world.entities?.get(reconnectedPlayerId);
        if (entity) {
          entity.data.owner = socket.id;
        }

        const relevantEntities =
          entity && "position" in entity
            ? collectInitialSyncEntities(
                this.world,
                entity.position.x,
                entity.position.z,
                reconnectedPlayerId,
              )
            : [];
        const relevantEntityIds = new Set(
          relevantEntities.map((entry) => entry.id),
        );

        if (entity) {
          sendToFn(socket.id, "entityAdded", entity.serialize());
        }
        for (const ent of relevantEntities) {
          sendToFn(socket.id, "entityAdded", ent.serialize());
        }

        // Re-emit PLAYER_JOINED so systems re-initialize for this session
        const reconnectAgentFlags = resolveReconnectAgentFlags(entity);
        this.world.emit(EventType.PLAYER_JOINED, {
          playerId: reconnectedPlayerId,
          userId: reconnectedPlayerId,
          player:
            socket.player as unknown as import("@hyperforge/shared").PlayerLocal,
          isReconnect: true,
          ...reconnectAgentFlags,
        });

        // Re-send existing players' equipment to the reconnected client
        // (initial join flow sends this but packets may be lost during socket reconnect)
        const equipSys = this.world.getSystem?.("equipment") as
          | {
              getPlayerEquipment?: (
                id: string,
              ) => Record<string, unknown> | undefined;
            }
          | undefined;
        if (equipSys?.getPlayerEquipment && this.world.entities?.items) {
          for (const [entityId, ent] of this.world.entities.items.entries()) {
            if (
              entityId !== reconnectedPlayerId &&
              relevantEntityIds.has(entityId) &&
              (ent as { type?: string }).type === "player"
            ) {
              const eq = equipSys.getPlayerEquipment(entityId);
              if (eq) {
                sendToFn(socket.id, "equipmentUpdated", {
                  playerId: entityId,
                  equipment: eq,
                });
              }
            }
          }
        }

        // Notify client of successful reconnection
        sendToFn(socket.id, "reconnected", {
          characterId: reconnectedPlayerId,
        });

        // Also send enterWorldApproved so client proceeds to game
        sendToFn(socket.id, "enterWorldApproved", {
          characterId: reconnectedPlayerId,
        });

        // Broadcast updated entity ownership to other clients
        sendFn(
          "entityModified",
          { id: reconnectedPlayerId, changes: { owner: socket.id } },
          socket.id,
        );

        console.log(
          `[ServerNetwork] Reconnected player ${reconnectedPlayerId} on socket ${socket.id}`,
        );
        return;
      }
    }

    // Normal spawn flow
    return handleEnterWorld(
      socket,
      data,
      this.world,
      this.spawn,
      this.broadcastManager.sendToAll.bind(this.broadcastManager),
      this.broadcastManager.sendToSocket.bind(this.broadcastManager),
    );
  }

  async init(options: WorldOptions): Promise<void> {
    // Validate that db exists and has the expected shape
    if (!options.db || !isDatabaseInstance(options.db)) {
      throw new Error(
        "[ServerNetwork] Valid database instance not provided in options",
      );
    }

    this.db = options.db;

    // Initialize managers now that db is available
    this.initializeManagers();
  }

  async start(): Promise<void> {
    if (!this.db) {
      throw new Error("[ServerNetwork] Database not available in start method");
    }

    // Load spawn configuration
    this.spawn = await this.initializationManager.loadSpawnPoint();

    // Initialize home teleport manager with spawn point
    initHomeTeleportManager(
      this.world,
      this.spawn,
      this.broadcastManager.sendToAll.bind(this.broadcastManager),
    );

    // Hydrate entities from database
    await this.initializationManager.hydrateEntities();

    // Load world settings
    await this.initializationManager.loadSettings();

    // Start save manager (timer + settings watcher)
    this.saveManager.start();

    // Setup event bridge (world events → network messages)
    this.eventBridge.setupEventListeners();

    // Start tick system (600ms classic fantasy MMORPG-style ticks)
    this.tickSystem.start();
    console.log(
      "[ServerNetwork] Tick system started (600ms ticks) with action queue",
    );
  }

  override destroy(): void {
    this.clearWorldListeners();
    this.processingRateLimiter.clear();
    this.processedDuelSettlements.clear();
    this.queue.length = 0;
    ServerNetwork.characterSockets.clear();
    ServerNetwork.agentGoals.clear();
    ServerNetwork.agentAvailableGoals.clear();
    ServerNetwork.agentActivity.clear();
    ServerNetwork.agentGoalsPaused.clear();
    ServerNetwork.agentThoughts.clear();
    ServerNetwork.agentPersonality.clear();
    ServerNetwork.agentDesireScores.clear();

    // Clean up duel event listeners to prevent memory leak
    if (this.cleanupDuelEventListeners) {
      this.cleanupDuelEventListeners();
      this.cleanupDuelEventListeners = null;
    }

    // Destroy trading system first - cancels all active trades and clears cleanup interval
    if (this.tradingSystem) {
      this.tradingSystem.destroy();
    }

    // Destroy duel system - cancels all active duels and pending challenges
    if (this.duelSystem) {
      this.duelSystem.destroy();
    }

    this.socketManager.destroy();
    this.spatialIndex.destroy();
    this.saveManager.destroy();
    this.interactionSessionManager.destroy();
    this.eventBridge.destroy();
    destroyAllRateLimiters();
    this.messageMetrics.clear();
    this.tickSystem.stop();

    // Stop event loop lag probe to prevent leaked setTimeout loop
    if (this._stopLagProbe) {
      this._stopLagProbe();
      this._stopLagProbe = null;
    }

    for (const [_id, socket] of this.sockets) {
      socket.close?.();
    }
    this.sockets.clear();
  }

  override preFixedUpdate(): void {
    const qLen = this.queue.length;
    const t0 = Date.now();
    this.flush();
    const elapsed = Date.now() - t0;
    if (elapsed > 50) {
      console.warn(
        `[ServerNetwork] flush() took ${elapsed}ms for ${qLen} queued messages`,
      );
    }
  }

  override update(dt: number): void {
    // Validate player positions periodically
    this.positionValidator.update(dt);

    // Broadcast world time periodically for day/night cycle sync
    this.worldTimeSyncAccumulator += dt;
    if (this.worldTimeSyncAccumulator >= this.WORLD_TIME_SYNC_INTERVAL) {
      this.worldTimeSyncAccumulator = 0;
      this.broadcastManager.sendToAll("worldTimeSync", {
        worldTime: this.world.getTime(),
      });
    }
  }

  /**
   * Broadcast message to all connected clients
   *
   * Delegates to BroadcastManager.
   */
  send<T = unknown>(name: string, data: T, ignoreSocketId?: string): void {
    this.broadcastManager.sendToAll(name, data, ignoreSocketId);
  }

  /**
   * Enable uWS native pub/sub broadcasting.
   * Called from main.ts after the uWS server is created.
   */
  enablePubSub(uwsApp: unknown): void {
    this.broadcastManager.setUwsApp(
      uwsApp as import("uWebSockets.js").TemplatedApp,
    );
    console.log("[ServerNetwork] uWS pub/sub broadcasting enabled");
  }

  /**
   * Broadcast message with HIGH priority (bypasses bandwidth throttling for
   * NORMAL-priority traffic). Use for batched entity spawns that must not be
   * silently dropped by the per-connection bandwidth budget.
   */
  sendHighPriority<T = unknown>(
    name: string,
    data: T,
    ignoreSocketId?: string,
  ): void {
    this.broadcastManager.sendToAll(
      name,
      data,
      ignoreSocketId,
      PacketPriority.HIGH,
    );
  }

  /**
   * Broadcast message to spectator sockets only.
   *
   * Delegates to BroadcastManager.sendToSpectators().
   */
  sendToSpectators<T = unknown>(name: string, data: T): void {
    this.broadcastManager.sendToSpectators(name, data);
  }

  /** Keep long-lived canonical stream viewers aligned with matchup rotation. */
  syncStreamingContestants(contestantIds: string[]): void {
    this.connectionHandler.syncStreamingContestants(contestantIds);
  }

  /**
   * Send message to specific socket
   *
   * Delegates to BroadcastManager.
   */
  sendTo<T = unknown>(socketId: string, name: string, data: T): void {
    this.broadcastManager.sendToSocket(socketId, name, data);
  }

  /**
   * Delegate socket health checking to SocketManager
   */
  checkSockets(): void {
    this.socketManager.checkSockets();
  }

  /**
   * Get socket by player ID
   */
  getSocketByPlayerId(playerId: string): ServerSocket | undefined {
    // Try using BroadcastManager first
    if (this.broadcastManager?.getPlayerSocket) {
      return this.broadcastManager.getPlayerSocket(playerId);
    }

    // Fallback to searching sockets map
    for (const [, socket] of this.sockets) {
      if (socket.player?.id === playerId) {
        return socket;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Pub/Sub subscription helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the UwsWebSocketAdapter for a player's socket.
   * Returns undefined if player not connected or not on uWS transport.
   */
  private getUwsAdapterForPlayer(
    playerId: string,
  ): UwsWebSocketAdapter | undefined {
    const socket = this.getSocketByPlayerId(playerId);
    if (!socket) return undefined;
    return this.broadcastManager.getAdapter(socket.id);
  }

  /**
   * Subscribe a player's socket to 9 region topics around a position.
   * Called on PLAYER_JOINED.
   */
  private subscribePlayerRegionTopics(
    playerId: string,
    worldX: number,
    worldZ: number,
  ): void {
    const adapter = this.getUwsAdapterForPlayer(playerId);
    if (!adapter) return;
    const regionKeys = this.spatialIndex.getAdjacentRegionKeys(worldX, worldZ);
    for (let i = 0; i < 9; i++) {
      adapter.subscribe(this.spatialIndex.getRegionTopic(regionKeys[i]));
    }
  }

  /**
   * Compute diff of old vs new 3×3 region grids and update subscriptions.
   * Called on position updates that cross a region boundary.
   */
  private updatePlayerRegionSubscriptions(
    playerId: string,
    oldKey: number,
    newKey: number,
  ): void {
    const diff = this.spatialIndex.getRegionSubscriptionDiff(oldKey, newKey);
    const adapter = this.getUwsAdapterForPlayer(playerId);
    if (adapter) {
      for (const key of diff.unsubscribe) {
        adapter.unsubscribe(this.spatialIndex.getRegionTopic(key));
      }
      for (const key of diff.subscribe) {
        adapter.subscribe(this.spatialIndex.getRegionTopic(key));
      }
    }

    // Also update any spectators following this player
    this.updateSpectatorRegionSubscriptions(playerId, diff);
  }

  /**
   * Full region resubscription — unsub all old 9, sub all new 9.
   * Called on teleport/respawn where the player may jump many regions.
   */
  private resubscribePlayerRegionTopics(
    playerId: string,
    oldKey: number,
    worldX: number,
    worldZ: number,
  ): void {
    // Unsub old 9 regions, sub new 9 regions
    const oldKeys = this.spatialIndex.getAdjacentRegionKeysFromKey(oldKey);
    const newKeys = this.spatialIndex.getAdjacentRegionKeys(worldX, worldZ);

    const adapter = this.getUwsAdapterForPlayer(playerId);
    if (adapter) {
      for (let i = 0; i < 9; i++) {
        adapter.unsubscribe(this.spatialIndex.getRegionTopic(oldKeys[i]));
      }
      for (let i = 0; i < 9; i++) {
        adapter.subscribe(this.spatialIndex.getRegionTopic(newKeys[i]));
      }
    }

    // Update spectators following this player (embedded agents have no adapter
    // but may have spectator viewfinders that need region resubscription).
    const oldKeySet = new Set(oldKeys);
    const subKeys: number[] = [];
    const unsubKeys: number[] = [];
    for (let i = 0; i < 9; i++) {
      if (!oldKeySet.has(newKeys[i])) subKeys.push(newKeys[i]);
    }
    const newKeySet = new Set(newKeys);
    for (let i = 0; i < 9; i++) {
      if (!newKeySet.has(oldKeys[i])) unsubKeys.push(oldKeys[i]);
    }
    if (subKeys.length > 0 || unsubKeys.length > 0) {
      this.updateSpectatorRegionSubscriptions(playerId, {
        subscribe: subKeys,
        unsubscribe: unsubKeys,
      });
    }
  }

  /**
   * Update spectator region subscriptions when a followed player changes region.
   * Typically 0-2 spectators per player.
   */
  private updateSpectatorRegionSubscriptions(
    followedPlayerId: string,
    diff: { subscribe: number[]; unsubscribe: number[] },
  ): void {
    const spectatorIds = this.spectatorsByPlayer.get(followedPlayerId);
    if (!spectatorIds || spectatorIds.size === 0) return;

    for (const socketId of spectatorIds) {
      const spectAdapter = this.broadcastManager.getAdapter(socketId);
      if (!spectAdapter) continue;
      for (const key of diff.unsubscribe) {
        spectAdapter.unsubscribe(this.spatialIndex.getRegionTopic(key));
      }
      for (const key of diff.subscribe) {
        spectAdapter.subscribe(this.spatialIndex.getRegionTopic(key));
      }
    }
  }

  /**
   * Server-initiated player movement for non-socket actors (embedded agents).
   * Routes through the same tile movement pipeline as normal player input.
   */
  requestServerMove(
    playerId: string,
    target: [number, number, number],
    options?: {
      runMode?: boolean;
      interactionArrival?: {
        interactionRange: number;
        footprintWidth: number;
        footprintDepth: number;
      };
    },
  ): boolean {
    if (!this.tileMovementManager || !this.world.entities.get(playerId)) {
      return false;
    }

    this.cancelPendingPreparationApproaches(playerId);
    return this.tileMovementManager.movePlayerToward(
      playerId,
      { x: target[0], y: target[1], z: target[2] },
      options?.runMode ?? false,
      0, // non-combat destination
      undefined,
      options?.interactionArrival,
    );
  }

  /**
   * Server-authoritative ground-item pickup for non-socket actors. Admission
   * uses the same duel, preparation, distance, protection, inventory-capacity,
   * world-removal, and persistence authorities as the live inventory system.
   */
  async requestServerPickup(
    playerId: string,
    entityId: string,
    operationId?: string,
  ): Promise<boolean> {
    if (!canPlayerPerformPreparationAction(this.world, playerId)) return false;

    const player = this.world.entities.get(playerId) as {
      position?: { x: number; y: number; z: number };
    } | null;
    const item = this.world.entities.get(entityId) as {
      position?: { x: number; y: number; z: number };
    } | null;
    if (!player?.position || !item?.position) return false;

    const duelSystem = this.world.getSystem("duel") as
      { isPlayerInActiveDuel?: (id: string) => boolean } | undefined;
    if (duelSystem?.isPlayerInActiveDuel?.(playerId)) return false;

    const dx = player.position.x - item.position.x;
    const dz = player.position.z - item.position.z;
    const pickupRange = COMBAT_CONSTANTS.PICKUP_RANGE ?? 2.5;
    if (Math.sqrt(dx * dx + dz * dz) > pickupRange) return false;

    const inventorySystem = this.world.getSystem("inventory") as
      | {
          pickupGroundItem?: (request: {
            playerId: string;
            entityId: string;
            operationId?: string;
          }) => Promise<boolean>;
        }
      | undefined;
    if (!inventorySystem?.pickupGroundItem) return false;

    return inventorySystem.pickupGroundItem({
      playerId,
      entityId,
      ...(operationId ? { operationId } : {}),
    });
  }

  /**
   * Server-owned combat approach for embedded duel agents. Unlike a ground
   * click, this preserves combat intent/cooldown and paths to the nearest valid
   * tile for the equipped weapon. DuelCombatAI uses it for melee pressure while
   * retaining explicit ownership of projectile-role spacing.
   */
  requestServerCombatApproach(playerId: string, targetId: string): boolean {
    if (!this.tileMovementManager || !this.world.entities.get(playerId)) {
      return false;
    }
    const targetEntity = this.world.entities.get(targetId) as {
      position?: { x: number; y: number; z: number };
    } | null;
    if (!targetEntity?.position) {
      return false;
    }

    return this.tileMovementManager.movePlayerToward(
      playerId,
      targetEntity.position,
      true,
      this.getPlayerWeaponRange(playerId),
      this.getPlayerAttackType(playerId),
    );
  }

  /**
   * Server-initiated movement cancel for non-socket actors (embedded agents).
   */
  cancelServerMove(playerId: string): boolean {
    if (!this.tileMovementManager || !this.world.entities.get(playerId)) {
      return false;
    }

    this.tileMovementManager.stopPlayer(playerId);
    return true;
  }

  /** Read-only path state for launch diagnostics on embedded duel agents. */
  getServerMovementDebug(playerId: string): {
    activePath: boolean;
    currentTile: { x: number; z: number } | null;
    nextTile: { x: number; z: number } | null;
    destinationTile: { x: number; z: number } | null;
    remainingPathTiles: number;
    moveSeq: number;
  } | null {
    if (!this.tileMovementManager || !this.world.entities.get(playerId)) {
      return null;
    }
    return this.tileMovementManager.getPlayerMovementDebug(playerId);
  }

  /**
   * Determine whether an incoming attack request is redundant.
   * Re-clicking the same active/pending target should be a no-op so we don't
   * reset combat state and push nextAttackTick forward.
   */
  private getRedundantAttackReason(
    playerId: string,
    targetId: string,
    targetType: "mob" | "player",
  ): "active_same_target" | "pending_same_target" | null {
    const combatSystem = this.world.getSystem("combat") as {
      getCombatData?: (entityId: string) => {
        inCombat?: boolean;
        targetId?: string;
        targetType?: "mob" | "player";
      } | null;
    } | null;

    const combatData = combatSystem?.getCombatData?.(playerId);
    const pendingTargetId = this.pendingAttackManager.hasPendingAttack(playerId)
      ? this.pendingAttackManager.getPendingAttackTarget(playerId)
      : null;

    return classifyRedundantAttackRequest(
      targetId,
      targetType,
      combatData,
      pendingTargetId,
    );
  }

  /**
   * Server-initiated attack for non-socket actors (embedded agents).
   * Uses the same walk-to-and-attack pipeline as real players.
   */
  requestServerAttack(
    playerId: string,
    targetId: string,
    targetType: "mob" | "player" = "mob",
  ): boolean {
    const playerEntity = this.world.entities.get(playerId);
    if (!this.tileMovementManager || !playerEntity) {
      return false;
    }

    const targetEntity = this.world.entities.get(targetId) as {
      position?: { x: number; y: number; z: number };
    } | null;
    if (!targetEntity?.position) {
      return false;
    }

    // Match the socket attack handlers: re-clicking an authoritative active
    // or pending target is idempotent. DuelCombatAI periodically verifies its
    // engagement, and allowing that keep-alive through would compete with its
    // standoff movement (a pending ranged attack can stop the separation path
    // as soon as the actors become adjacent). It can also reset combat cadence.
    if (this.getRedundantAttackReason(playerId, targetId, targetType)) {
      return true;
    }

    this.cancelPendingPreparationApproaches(playerId);
    this.pendingAttackManager.cancelPendingAttack(playerId);

    const attackRange = this.getPlayerWeaponRange(playerId);
    const attackType = this.getPlayerAttackType(playerId);

    const playerTile = worldToTile(
      playerEntity.position.x,
      playerEntity.position.z,
    );
    const targetTile = worldToTile(
      targetEntity.position.x,
      targetEntity.position.z,
    );

    if (this.isInAttackRange(playerTile, targetTile, attackType, attackRange)) {
      this.world.emit(EventType.COMBAT_ATTACK_REQUEST, {
        attackerId: playerId,
        targetId,
        attackerType: "player",
        targetType,
        attackType,
      });
    } else {
      // The duel AI has already installed a deliberate standoff path. Queueing
      // generic walk-to-attack here would replace it; the AI retries engagement
      // after its own controller brings the fighter into authoritative range.
      if (isDuelAiMovementOwned(playerEntity.data)) {
        return false;
      }
      this.pendingAttackManager.queuePendingAttack(
        playerId,
        targetId,
        this.world.currentTick,
        attackRange,
        targetType,
        attackType,
      );
    }
    return true;
  }

  private getOrCreateMessageMetric(method: string): NetworkMessageMetric {
    let metric = this.messageMetrics.get(method);
    if (!metric) {
      metric = {
        method,
        received: 0,
        inFlight: 0,
        peakInFlight: 0,
        errors: 0,
        lastSeenAt: 0,
      };
      this.messageMetrics.set(method, metric);
    }
    return metric;
  }

  getMessageDiagnostics(limit: number = 20): NetworkMessageMetric[] {
    return Array.from(this.messageMetrics.values())
      .sort((a, b) => {
        if (b.inFlight !== a.inFlight) {
          return b.inFlight - a.inFlight;
        }
        if (b.peakInFlight !== a.peakInFlight) {
          return b.peakInFlight - a.peakInFlight;
        }
        return b.received - a.received;
      })
      .slice(0, limit)
      .map((metric) => ({ ...metric }));
  }

  enqueue(socket: ServerSocket | Socket, method: string, data: unknown): void {
    // CRITICAL SECURITY: Global rate limiting to prevent DoS attacks (100 msg/sec per socket)
    const socketId = (socket as ServerSocket).id;
    if (socketId) {
      const globalLimiter = getGlobalSocketRateLimiter();
      if (!globalLimiter.check(socketId)) {
        // Rate limit exceeded - kick the socket
        console.warn(
          `[ServerNetwork] Socket ${socketId} exceeded global rate limit (100/sec), disconnecting`,
        );
        try {
          (socket as ServerSocket).send("error", {
            code: "RATE_LIMITED",
            message: "Too many requests",
          });
          // Use ws.close with code/reason since Socket.close() takes no args
          (socket as ServerSocket).ws?.close?.(4029, "Rate limited");
        } catch {
          // Socket may already be closing
        }
        return;
      }
    }
    const metric = this.getOrCreateMessageMetric(method);
    metric.received++;
    metric.lastSeenAt = Date.now();
    this.queue.push([socket as ServerSocket, method, data]);
  }

  /**
   * Delegate disconnection handling to SocketManager
   */
  onDisconnect(socket: ServerSocket | Socket, code?: number | string): void {
    // Clean up spectator index before socket is removed
    const ss = socket as ServerSocket;
    if (ss.isSpectator && ss.spectatingCharacterId) {
      const set = this.spectatorsByPlayer.get(ss.spectatingCharacterId);
      if (set) {
        set.delete(ss.id);
        if (set.size === 0)
          this.spectatorsByPlayer.delete(ss.spectatingCharacterId);
      }
    }
    this.socketManager.handleDisconnect(ss, code);
  }

  flush(): void {
    if (this.queue.length === 0) {
      return;
    }

    const queuedMessages = this.queue;
    this.queue = [];

    for (const [socket, method, data] of queuedMessages) {
      // Debug: Log duel-related packets
      if (
        DEBUG_DUEL_PACKET_TRAFFIC &&
        (method.includes("duel") || method.includes("Duel"))
      ) {
        console.log(`[ServerNetwork] Received duel packet: ${method}`, data);
      }

      const handler = this.handlers[method];
      if (handler) {
        const metric = this.getOrCreateMessageMetric(method);
        const result = handler.call(this, socket, data);
        if (result && typeof result.then === "function") {
          metric.inFlight++;
          if (metric.inFlight > metric.peakInFlight) {
            metric.peakInFlight = metric.inFlight;
          }
          result
            .catch((err: Error) => {
              metric.errors++;
              console.error(
                `[ServerNetwork] Error in async handler ${method}:`,
                err,
              );
            })
            .finally(() => {
              metric.inFlight = Math.max(0, metric.inFlight - 1);
            });
        }
      } else {
        // SECURITY: Rate limit unknown message types to prevent log spam DoS
        const socketId = socket.id;
        if (socketId) {
          const unknownLimiter = getUnknownMessageRateLimiter();
          if (unknownLimiter.check(socketId)) {
            // Only log if under rate limit to prevent log spam attacks
            console.warn(`[ServerNetwork] No handler for packet: ${method}`);
          }
          // If rate limited, silently drop to prevent log flooding
        } else {
          console.warn(`[ServerNetwork] No handler for packet: ${method}`);
        }
      }
    }
  }

  getTime(): number {
    return performance.now() / 1000; // seconds
  }

  isAdmin(player: { data?: { roles?: string[] } }): boolean {
    return hasRole(player.data?.roles as string[] | undefined, "admin");
  }

  /**
   * Check if player has moderator permissions (mod or admin role)
   * Moderators can use advanced commands like /teleport
   */
  isMod(player: { data?: { roles?: string[] } }): boolean {
    return hasRole(player.data?.roles as string[] | undefined, "mod", "admin");
  }

  isBuilder(player: { data?: { roles?: string[] } }): boolean {
    return this.world.settings.public || this.isAdmin(player);
  }

  /**
   * Get player's attack range in tiles
   * Cancel all pending actions for a player (attack, gather, cook, follow,
   * trade, duel, home teleport).
   * Called when a player initiates a new action that supersedes existing ones.
   */
  private cancelAllPendingActions(
    playerId: string,
    socket?: { send: (name: string, data: unknown) => void },
  ): void {
    this.pendingAttackManager.cancelPendingAttack(playerId);
    this.cancelPendingPreparationApproaches(playerId);
    this.followManager.stopFollowing(playerId);
    this.pendingTradeManager.cancelPendingTrade(playerId);
    this.pendingDuelChallengeManager.cancelPendingChallenge(playerId);
    const homeTeleportManager = getHomeTeleportManager();
    if (homeTeleportManager?.isCasting(playerId)) {
      homeTeleportManager.cancelCasting(playerId, "Player moved");
      if (socket) {
        socket.send("homeTeleportFailed", {
          reason: "Interrupted by movement",
        });
        socket.send("showToast", {
          message: "Home teleport canceled",
          type: "info",
        });
      }
    }
  }

  private cancelPendingPreparationApproaches(playerId: string): void {
    this.pendingGatherManager.cancelPendingGather(playerId);
    this.pendingCookManager.cancelPendingCook(playerId, "interrupted");
  }

  /**
   * Spell selection takes priority (magic range = 10)
   * Otherwise uses equipped weapon's attackRange from manifest
   * Returns 1 for unarmed (punching)
   */
  getPlayerWeaponRange(playerId: string): number {
    // Check if player has a spell selected - if so, use magic range regardless of weapon
    const playerEntity = this.world.getPlayer?.(playerId);
    const selectedSpell = (playerEntity?.data as { selectedSpell?: string })
      ?.selectedSpell;

    if (selectedSpell) {
      return 10; // Standard magic attack range
    }

    const equipmentSystem = this.world.getSystem("equipment") as
      | {
          getPlayerEquipment?: (id: string) => {
            weapon?: {
              item?: {
                attackRange?: number;
                attackType?: string;
                id?: string;
              };
            };
          } | null;
        }
      | undefined;

    if (equipmentSystem?.getPlayerEquipment) {
      const equipment = equipmentSystem.getPlayerEquipment(playerId);

      if (equipment?.weapon?.item) {
        const weaponItem = equipment.weapon.item;

        // rules-accurate: Magic weapons (staffs/wands) without autocast
        // default to melee range (1 tile bonk). The selectedSpell check above
        // already returns 10 for magic range when a spell is selected.
        const isMagicWeapon =
          String(weaponItem.attackType || "").toLowerCase() === "magic" ||
          (weaponItem.id &&
            String(getItem(weaponItem.id)?.attackType || "").toLowerCase() ===
              "magic");

        if (!isMagicWeapon) {
          // Non-magic weapons use their attackRange (e.g., bows)
          if (weaponItem.attackRange) {
            return weaponItem.attackRange;
          }

          // Fallback: look up from items manifest
          if (weaponItem.id) {
            const itemData = getItem(weaponItem.id);
            if (itemData?.attackRange) {
              return itemData.attackRange;
            }
          }
        }
        // Magic weapons without autocast fall through to melee range (1)
      }
    }

    // Default to 1 tile (unarmed/punching, or magic weapon without autocast)
    return 1;
  }

  /**
   * Get the attack type from the player's equipped weapon or selected spell
   * Returns AttackType.MELEE if no weapon or melee weapon equipped and no spell selected
   *
   * rules-accurate: You can cast spells without a staff - the staff just provides
   * magic attack bonus and elemental staves give infinite runes
   */
  getPlayerAttackType(playerId: string): AttackType {
    // Check if player has a spell selected - if so, use magic regardless of weapon
    const playerEntity = this.world.getPlayer?.(playerId);
    const selectedSpell = (playerEntity?.data as { selectedSpell?: string })
      ?.selectedSpell;

    if (selectedSpell) {
      return AttackType.MAGIC;
    }

    const equipmentSystem = this.world.getSystem("equipment") as
      | {
          getPlayerEquipment?: (id: string) => {
            weapon?: {
              item?: {
                attackType?: string;
                weaponType?: string;
              };
            };
          } | null;
        }
      | undefined;

    if (equipmentSystem?.getPlayerEquipment) {
      const equipment = equipmentSystem.getPlayerEquipment(playerId);

      if (equipment?.weapon?.item) {
        const weaponItem = equipment.weapon.item;

        return resolveWeaponAttackType(
          weaponItem.attackType,
          weaponItem.weaponType,
        );
      }
    }

    return AttackType.MELEE;
  }

  /**
   * Check if player is within attack range based on attack type
   * Melee uses cardinal-only for range 1, ranged/magic uses Chebyshev distance
   */
  isInAttackRange(
    attackerTile: { x: number; z: number },
    targetTile: { x: number; z: number },
    attackType: AttackType,
    range: number,
  ): boolean {
    if (attackType === AttackType.MELEE) {
      return tilesWithinMeleeRange(attackerTile, targetTile, range);
    }

    // Ranged/Magic use Chebyshev distance (8-directional)
    const distance = tileChebyshevDistance(attackerTile, targetTile);
    return distance <= range && distance > 0;
  }

  /**
   * Handle incoming WebSocket connection
   *
   * Delegates to ConnectionHandler for the full connection flow.
   */
  async onConnection(
    ws: NodeWebSocket,
    params: ConnectionParams,
  ): Promise<void> {
    await this.connectionHandler.handleConnection(ws, params);
  }
}
