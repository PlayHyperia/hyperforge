/**
 * ClientNetwork.ts - Client-Side Networking System
 *
 * Manages WebSocket connection to game server and handles network communication.
 * Provides entity synchronization, latency compensation, and packet handling.
 *
 * Key Features:
 * - **WebSocket Client**: Persistent connection to game server
 * - **Entity Sync**: Replicates server entities to client
 * - **Interpolation**: Smooth movement between server updates
 * - **Packet System**: Efficient binary protocol using msgpackr
 * - **Reconnection**: Automatic reconnect with exponential backoff
 * - **Ping/Latency**: Round-trip time measurement
 * - **Buffering**: Handles network jitter and packet loss
 * - **Compression**: Optional packet compression for low bandwidth
 *
 * Network Architecture:
 * - Server is authoritative for all game state
 * - Client receives snapshots at 8Hz (every 125ms)
 * - Client interpolates between snapshots for smooth 60 FPS
 * - Client sends input at 30Hz for responsive controls
 * - Server validates all client actions
 *
 * Packet Types:
 * - **init**: Initial connection setup
 * - **snapshot**: World state update from server
 * - **entityAdded**: New entity spawned
 * - **entityModified**: Entity state changed
 * - **entityRemoved**: Entity destroyed
 * - **chatMessage**: Text chat from players
 * - **input**: Player input commands
 * - **ping**: Latency measurement
 *
 * Entity Interpolation:
 * - Maintains buffer of last 3 server snapshots
 * - Interpolates position/rotation between snapshots
 * - Compensates for network jitter
 * - Predicts movement for local player
 * - Server correction when prediction wrong
 *
 * Latency Compensation:
 * - Measures round-trip time (RTT)
 * - Adjusts interpolation delay based on RTT
 * - Client-side prediction for local player
 * - Server rewind for hit detection
 *
 * Connection States:
 * - Connecting: Initial WebSocket handshake
 * - Connected: Active connection, receiving packets
 * - Disconnected: Connection lost, attempting reconnect
 * - Error: Fatal error, manual reconnect required
 *
 * Error Handling:
 * - Graceful disconnect on server shutdown
 * - Auto-reconnect on network interruption
 * - Packet validation and error recovery
 * - Session restoration on reconnect
 *
 * Usage:
 * ```typescript
 * // Connect to server
 * await world.network.connect('wss://server.com/ws');
 *
 * // Send chat message
 * world.network.sendChat('Hello world!');
 *
 * // Get current latency
 * const ping = world.network.getPing();
 *
 * // Handle disconnection
 * world.network.on('disconnected', () => {
 *   console.log('Lost connection to server');
 * });
 * ```
 *
 * Related Systems:
 * - ServerNetwork: Server-side counterpart
 * - Entities: Manages replicated entities
 * - PlayerLocal: Sends input to server
 * - ClientInput: Captures player actions
 *
 * Dependencies:
 * - WebSocket API (browser native)
 * - msgpackr: Binary serialization
 * - EventBus: System events
 *
 * @see packets.ts for packet format
 * @see ServerNetwork.ts for server implementation
 *
 * AUDIT-003 (ASSESSED): File is ~5K lines (165KB). The 127 packet handlers are
 * simple event emitters that forward data to the world event bus. Extraction
 * modules exist (ConnectionManager.ts, InterpolationEngine.ts) but handlers
 * don't benefit from extraction - they're intentionally thin wrappers.
 * TileInterpolator is already extracted. Current structure is appropriate.
 */

// moment removed; use native Date
import { emoteUrls, Emotes } from "../../data/playerEmotes";
import { DataManager } from "../../data/DataManager";
import { EQUIPMENT_SLOT_NAMES } from "../../constants/EquipmentConstants";
import THREE from "../../extras/three/three";
import { readPacket, writePacket } from "../../platform/shared/packets";
import { storage } from "../../platform/shared/storage";
import type {
  ChatMessage,
  EntityData,
  SnapshotData,
  World,
  WorldOptions,
} from "../../types";
import type { Entity } from "../../entities/Entity";
import type { ResourceEntity } from "../../entities/world/ResourceEntity";
import { EventType, type EventMap } from "../../types/events";
import type {
  FishingInteractionPresentationPayload,
  FletchingInterfaceOpenPayload,
  ProcessingInteractionPresentationPayload,
} from "../../types/events";
import { normalizeProcessingInteractionPresentationState } from "../../types/game/processing-interaction-presentation";
import { DeathState } from "../../types/entities";
// Social system types - use shared types for consistency
import type {
  FriendsListSyncData,
  FriendRequest,
  FriendStatusUpdateData,
} from "../../types/game/social-types";
import type { AttackType } from "../../types/game/item-types";
import { uuid } from "../../utils";
import { SystemBase } from "../shared/infrastructure/SystemBase";
import { resolveClientConnectionAuthMode } from "./clientNetworkAuthPolicy";
import { PendingActionTracker } from "./network/PendingActionTracker";
import { WorldContentAdmission } from "../../runtime/WorldContentAdmission";
import {
  isStreamingLikeViewport,
  shouldAdmitNetworkEntityInViewport,
} from "../../runtime/clientViewportMode";
import { PlayerLocal } from "../../entities/player/PlayerLocal";
import { TileInterpolator } from "./TileInterpolator";
import { type TileCoord } from "../shared/movement/TileSystem"; // Internal import within shared package
import { generateGroundItemDropOperationId } from "../../utils/game/GroundItemSourceIdentity";

type ClientNetworkEnv = {
  PUBLIC_DISABLE_NETWORK?: string;
  DISABLE_NETWORK?: string;
  PUBLIC_INTERPOLATION_MAX_PER_FRAME?: string;
  INTERPOLATION_MAX_PER_FRAME?: string;
  LOAD_TEST_MODE?: string;
  NODE_ENV?: string;
};

const isTruthy = (value?: string): boolean =>
  value === "1" || value === "true" || value === "yes" || value === "on";

const isNetworkDisabled = (): boolean => {
  const runtimeEnv = (globalThis as { env?: ClientNetworkEnv }).env;
  const processEnv =
    typeof process !== "undefined" && typeof process.env !== "undefined"
      ? process.env
      : undefined;
  return (
    isTruthy(runtimeEnv?.PUBLIC_DISABLE_NETWORK) ||
    isTruthy(runtimeEnv?.DISABLE_NETWORK) ||
    isTruthy(processEnv?.PUBLIC_DISABLE_NETWORK) ||
    isTruthy(processEnv?.DISABLE_NETWORK)
  );
};

const readPositiveIntegerEnv = (...keys: string[]): number | null => {
  const runtimeEnv = (globalThis as { env?: ClientNetworkEnv }).env;
  const processEnv =
    typeof process !== "undefined" && typeof process.env !== "undefined"
      ? process.env
      : undefined;

  for (const key of keys) {
    const raw =
      runtimeEnv?.[key as keyof ClientNetworkEnv] ??
      processEnv?.[key as keyof typeof processEnv];
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }

  return null;
};

const _v3_1 = new THREE.Vector3();
const _quat_1 = new THREE.Quaternion();
const _combatFaceAxis = new THREE.Vector3(0, 1, 0);

/**
 * Entity interpolation state for smooth remote entity movement
 */
interface EntitySnapshot {
  position: Float32Array;
  rotation: Float32Array;
  timestamp: number;
}

/**
 * Tracks interpolation state for each remote entity
 */
interface InterpolationState {
  entityId: string;
  snapshots: EntitySnapshot[];
  snapshotIndex: number;
  snapshotCount: number;
  currentPosition: THREE.Vector3;
  currentRotation: THREE.Quaternion;
  tempPosition: THREE.Vector3;
  tempRotation: THREE.Quaternion;
  lastUpdate: number;
  lastInterpolatedTime: number;
}

// SnapshotData interface moved to shared types
// Social system payload types are now imported from ../../types/game/social-types

/** Shape of the cached inventory snapshot stored per player. */
export interface InventorySnapshot {
  playerId: string;
  items: Array<{ slot: number; itemId: string; quantity: number }>;
  coins: number;
  maxSlots: number;
}

/**
 * Client Network System
 *
 * Manages connection to game server and entity synchronization.
 * Runs only on client (browser).
 *
 * - runs on the client
 * - provides abstract network methods matching ServerNetwork
 *
 */
export class ClientNetwork extends SystemBase {
  ids: number;
  ws: WebSocket | null;
  apiUrl: string | null;
  id: string | null;
  isClient: boolean;
  isServer: boolean;
  connected: boolean;
  private readonly worldAdmission = new WorldContentAdmission(() =>
    DataManager.getWorldContentIdentity(),
  );
  private flushing = false;
  queue: Array<[string, unknown]>;
  /** Queue read index for O(1) dequeue (avoids shift() which is O(n)) */
  private _queueReadIndex = 0;
  /** Cached handler lookups to avoid string operations per packet */
  private _handlerCache = new Map<string, Function | null>();
  serverTimeOffset: number;
  /** Offset to sync world time with server for day/night cycle */
  worldTimeOffset: number;
  maxUploadSize: number;
  pendingModifications: Map<string, Array<Record<string, unknown>>> = new Map();
  pendingModificationTimestamps: Map<string, number> = new Map(); // Track when modifications were first queued
  pendingModificationLimitReached: Set<string> = new Set(); // Track entities that hit the limit (to avoid log spam)

  // Queue bounds configuration
  /** Max pending modifications per entity before dropping (oldest-first) */
  private readonly MAX_PENDING_MODIFICATIONS_PER_ENTITY = 50;
  /** Max total pending modifications across all entities before oldest-first eviction */
  private readonly MAX_TOTAL_PENDING_MODIFICATIONS = 500;
  /** Track total pending modification count for bounds checking */
  private totalPendingModificationCount = 0;

  // Reconnection state
  private isReconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastWsUrl: string | null = null;
  private lastInitOptions: Record<string, unknown> | null = null;
  private intentionalDisconnect: boolean = false;

  // Application-level keepalive to prevent Cloudflare/proxy WebSocket idle timeout
  // WS protocol-level ping/pong may not be counted as "activity" by reverse proxies
  private keepaliveIntervalId: ReturnType<typeof setInterval> | null = null;
  private static readonly KEEPALIVE_INTERVAL_MS = 30_000; // 30 seconds

  // Outgoing message queue (for messages sent while disconnected)
  private outgoingQueue: Array<{
    name: string;
    data: unknown;
    timestamp: number;
  }> = [];
  private maxOutgoingQueueSize: number = 100;
  private outgoingQueueSequence: number = 0;
  // Cache character list so UI can render even if it mounts after the packet arrives
  lastCharacterList: Array<{
    id: string;
    name: string;
    level?: number;
    lastLocation?: { x: number; y: number; z: number };
  }> | null = null;
  // Cache latest inventory per player so UI can hydrate even if it mounted late
  lastInventoryByPlayerId: Record<string, InventorySnapshot> = {};

  // Deduplication for combat damage packets — sendToNearby publishes to 9 region
  // topics, so players near region boundaries receive the same packet multiple times.
  // Map key → timestamp for periodic sweep (no per-key setTimeout).
  private readonly _recentDamageKeys = new Map<string, number>();
  private readonly _recentProjectileLaunchKeys = new Map<string, number>();
  private readonly _recentProjectileHitKeys = new Map<string, number>();
  private readonly _recentProjectileCancellationKeys = new Map<
    string,
    number
  >();
  private _projectileNetworkSourceId: string | null = null;
  private _highestProjectileNetworkSequence = 0;
  private readonly _missingProjectileNetworkSequences = new Set<number>();
  private readonly _terminalProjectileIds = new Map<string, number>();
  // Single tracker for all optimistic inventory mutations (shared by all callers).
  // Snapshots the cache before mutation; rolls back after 5s if no server confirmation.
  private inventoryTracker = new PendingActionTracker<InventorySnapshot>(5000);
  private inventoryPrunerInterval: ReturnType<typeof setInterval> | null = null;
  // Cache latest skills per player so UI can hydrate even if it mounted late
  lastSkillsByPlayerId: Record<
    string,
    Record<string, { level: number; xp: number }>
  > = {};
  // Cache latest equipment per player so UI can hydrate even if it mounted late
  lastEquipmentByPlayerId: Record<string, Record<string, unknown>> = {};
  // Cache latest attack style per player so UI can hydrate even if it mounted late
  // (mirrors skills caching pattern - prevents race condition on page refresh)
  lastAttackStyleByPlayerId: Record<
    string,
    {
      currentStyle: { id: string };
      availableStyles: unknown;
      canChange: boolean;
    }
  > = {};

  // Spectator mode state
  private spectatorFollowEntity: string | undefined;
  private spectatorTargetPending = false;
  private spectatorRetryInterval:
    ReturnType<typeof setInterval> | number | null = null;

  // Entity interpolation for smooth remote entity movement
  private interpolationStates: Map<string, InterpolationState> = new Map();
  private interpolationDelay: number = 100; // ms
  private maxSnapshots: number = 10;
  private extrapolationLimit: number = 500; // ms

  // Tile-based interpolation for classic fantasy MMORPG-style movement
  // Public to allow position sync on respawn/teleport
  public tileInterpolator: TileInterpolator = new TileInterpolator();

  // Authoritative combat target identity is retained separately from movement
  // packets. Streaming spectators render only remote players, so they cannot
  // rely on PlayerLocal's per-frame combat-facing path.
  private combatFaceTargets: Map<string, string> = new Map();
  // The streaming scheduler owns its frozen contestant pair for the entire
  // FIGHTING phase. Generic combat subsystems may transiently clear their own
  // engagement while an agent repositions; those packets must not release the
  // broadcast client's opponent-facing lock between scheduler ticks.
  private streamingDuelCombatFaceTargets: Map<string, string> = new Map();
  private processingFaceTargets: Map<
    string,
    { x: number; y: number; z: number }
  > = new Map();
  private streamingDuelContestantIds: Set<string> = new Set();
  // Entity ids intentionally omitted from arena-only snapshots. Tracking them
  // prevents later modification packets from accumulating in the out-of-order
  // queue while preserving the full snapshot behavior for playable clients.
  private streamingFilteredEntityIds: Set<string> = new Set();
  private streamingDuelFacingLocked = false;
  private streamingDuelFighting = false;

  // Track dead players to prevent position updates from entityModified packets
  // CRITICAL: Prevents race condition where entityModified packets arrive after death
  // and overwrite the respawn position for other players
  private deadPlayers: Set<string> = new Set();

  // Embedded viewport configuration (read once at init)
  private embeddedCharacterId: string | null = null;
  private isEmbeddedSpectator: boolean = false;

  constructor(world: World) {
    super(world, {
      name: "client-network",
      dependencies: { required: ["physics"], optional: [] },
      autoCleanup: true,
    });
    this.ids = -1;
    this.ws = null;
    this.apiUrl = null;
    this.id = null;
    this.isClient = true;
    this.isServer = false;
    this.connected = false;
    this.queue = [];
    this.serverTimeOffset = 0;
    this.worldTimeOffset = 0;
    this.maxUploadSize = 0;
  }

  /**
   * Deep-clone the current inventory cache for a player for rollback purposes.
   * Returns null if no cache exists yet.
   */
  snapshotInventory(playerId: string): InventorySnapshot | null {
    const cached = this.lastInventoryByPlayerId[playerId];
    if (!cached) return null;
    return {
      playerId: cached.playerId,
      items: cached.items.map((i) => ({ ...i })),
      coins: cached.coins,
      maxSlots: cached.maxSlots,
    };
  }

  /**
   * Optimistically remove an item from the inventory cache and emit an
   * immediate UI update. Automatically snapshots before mutation for
   * rollback if the server doesn't confirm within 5 seconds.
   */
  applyOptimisticRemoval(
    playerId: string,
    slot: number,
    quantity: number,
  ): void {
    const cached = this.lastInventoryByPlayerId[playerId];
    if (!cached) return;

    const itemIndex = cached.items.findIndex((i) => i.slot === slot);
    if (itemIndex === -1) return;

    // Snapshot before mutation for rollback on timeout
    const snapshot = this.snapshotInventory(playerId);
    if (snapshot) this.inventoryTracker.add(snapshot);
    this.ensureInventoryPruner();

    const item = cached.items[itemIndex];
    if (item.quantity <= quantity) {
      cached.items.splice(itemIndex, 1);
    } else {
      item.quantity -= quantity;
    }

    this.world.emit(EventType.INVENTORY_UPDATED, { ...cached });
  }

  /**
   * Schedule a single delayed prune check. Re-schedules itself only while
   * there are still pending optimistic actions, so the timer stops when idle
   * instead of ticking every 1s unconditionally.
   */
  private ensureInventoryPruner(): void {
    if (this.inventoryPrunerInterval) return;
    const runPrune = () => {
      const rollbacks = this.inventoryTracker.pruneStale();
      for (const snapshot of rollbacks) {
        this.lastInventoryByPlayerId[snapshot.playerId] = snapshot;
        this.world.emit(EventType.INVENTORY_UPDATED, { ...snapshot });
        console.warn(
          "[ClientNetwork] Optimistic inventory action timed out, rolling back",
        );
      }
      // Re-schedule only if more actions are still pending
      if (this.inventoryTracker.hasPending()) {
        this.inventoryPrunerInterval = setTimeout(
          runPrune,
          1000,
        ) as unknown as ReturnType<typeof setInterval>;
      } else {
        this.inventoryPrunerInterval = null;
      }
    };
    this.inventoryPrunerInterval = setTimeout(
      runPrune,
      1000,
    ) as unknown as ReturnType<typeof setInterval>;
  }

  public getSpectatorFollowEntity(): string | undefined {
    return this.spectatorFollowEntity;
  }

  /**
   * Determine whether an entity record matches a spectator target id.
   * Supports both entity-id and character-id addressing.
   */
  private isEntityMatchingSpectatorTarget(
    entityId: string | undefined,
    entity: unknown,
    targetId: string,
  ): boolean {
    if (!targetId) return false;
    if (entityId === targetId) return true;

    const candidate = entity as {
      id?: string;
      characterId?: string;
      data?: { id?: string; characterId?: string };
    };

    return (
      candidate?.id === targetId ||
      candidate?.characterId === targetId ||
      candidate?.data?.id === targetId ||
      candidate?.data?.characterId === targetId
    );
  }

  /**
   * Resolve spectator target entity by id or character-id aliases.
   */
  private resolveSpectatorTargetEntity(targetId: string): unknown | undefined {
    if (!targetId) return undefined;

    const directMatch =
      this.world.entities.items.get(targetId) ||
      this.world.entities.players.get(targetId);
    if (directMatch) return directMatch;

    for (const [id, entity] of this.world.entities.items.entries()) {
      if (this.isEntityMatchingSpectatorTarget(id, entity, targetId)) {
        return entity;
      }
    }

    for (const [id, player] of this.world.entities.players.entries()) {
      if (this.isEntityMatchingSpectatorTarget(id, player, targetId)) {
        return player;
      }
    }

    return undefined;
  }

  async init(options: WorldOptions): Promise<void> {
    const wsUrl = (options as { wsUrl?: string }).wsUrl;

    this.logger.debug(`init() called with wsUrl: ${wsUrl}`);
    this.logger.debug("Current WebSocket state", {
      hasExistingWs: !!this.ws,
      existingReadyState: this.ws?.readyState,
      connected: this.connected,
      id: this.id,
      initialized: this.initialized,
    } as unknown as Record<string, unknown>);

    const name = (options as { name?: string }).name;
    const avatar = (options as { avatar?: string }).avatar;

    if (!wsUrl) {
      if (isNetworkDisabled()) {
        this.logger.info(
          "[ClientNetwork] Network disabled via PUBLIC_DISABLE_NETWORK",
        );
        this.initialized = true;
        return;
      }
      console.error("[ClientNetwork] No WebSocket URL provided!");
      return;
    }

    // Store connection options for reconnection
    this.lastWsUrl = wsUrl;
    this.lastInitOptions = options as Record<string, unknown>;

    // CRITICAL: If we already have a WORKING WebSocket, don't recreate
    // But if it's closed or closing, we need to reconnect
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.connected) {
      this.logger.debug(
        "WebSocket already connected and working, skipping init",
      );
      this.initialized = true;
      return;
    }

    // Clean up any existing WebSocket (closed, closing, or connecting but failed)
    if (this.ws) {
      this.logger.debug(
        `Cleaning up old WebSocket (state: ${this.ws.readyState})`,
      );
      try {
        this.ws.removeEventListener("message", this.onPacket);
        this.ws.removeEventListener("close", this.onClose);
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close();
        }
      } catch {
        this.logger.debug("Error cleaning up old WebSocket");
      }
      this.ws = null;
      this.connected = false;
      this.id = null;
    }

    this.worldAdmission.beginConnection();
    this.connected = false;
    this.intentionalDisconnect = false;
    // Packets from a previous transport cannot be replayed into this admission.
    this.queue.length = 0;
    this._queueReadIndex = 0;

    // AUTHENTICATION: Include authToken in URL for reliable authentication
    // The server supports both URL-based auth and first-message auth.
    // Using URL-based auth for reliability - it works consistently across all environments.

    // Check if wsUrl already contains an authToken (e.g., legacy embedded viewport)
    const urlHasAuthToken = wsUrl.includes("authToken=");

    let authToken = "";
    let privyUserId = "";
    const isPlaywrightRuntime =
      process.env.PLAYWRIGHT_TEST === "true" ||
      (typeof window !== "undefined" &&
        (
          window as Window & {
            __PLAYWRIGHT_TEST__?: boolean;
          }
        ).__PLAYWRIGHT_TEST__ === true);

    if (!urlHasAuthToken && typeof localStorage !== "undefined") {
      // Get auth credentials from localStorage
      const privyToken = localStorage.getItem("privy_auth_token");
      const privyId = localStorage.getItem("privy_user_id");

      if (privyToken && privyId && !isPlaywrightRuntime) {
        authToken = privyToken;
        privyUserId = privyId;
      } else if (!isPlaywrightRuntime) {
        // Fall back to legacy auth token
        // Strong type assumption - storage.get returns unknown, we expect string
        const legacyToken = storage?.get("authToken");
        authToken = (legacyToken as string) || "";
      }
    }

    // For embedded spectator viewfinders (dashboard agent live view), the spectator
    // JWT is passed as a URL param on the iframe and stored in __HYPERIA_CONFIG__.authToken.
    // It is intentionally NOT put in the WebSocket URL by EmbeddedGameClient (security
    // concern about token leaking in logs), but the server requires it to pass the
    // STREAMING_PUBLIC_DELAY_MS access gate for agent spectating.  Use it here if no
    // other authToken was found, so the connection is authenticated.
    if (
      !authToken &&
      !urlHasAuthToken &&
      typeof window !== "undefined" &&
      !isPlaywrightRuntime
    ) {
      const embeddedAuth = (
        window as {
          __HYPERIA_CONFIG__?: { authToken?: string };
        }
      ).__HYPERIA_CONFIG__?.authToken;
      if (embeddedAuth) {
        authToken = embeddedAuth;
      }
    }

    // Build WebSocket URL with authToken included.
    // Note: For `mode=streaming`, the server may require `authToken` + `privyUserId` in the
    // query string at connect time (`verifyStreamingViewerCredentials`) when public delay is
    // enabled — streaming does not use the deferred first-message auth path on the server.
    let url: string;
    if (urlHasAuthToken) {
      // URL already has authToken (legacy embedded mode) - use as-is
      url = wsUrl;
      this.logger.debug("Using authToken from URL (legacy embedded mode)");
    } else if (authToken) {
      // Add auth params to URL for URL-based authentication.
      // privyUserId is required for Privy token verification on server.
      const queryParts = [`authToken=${encodeURIComponent(authToken)}`];
      if (privyUserId) {
        queryParts.push(`privyUserId=${encodeURIComponent(privyUserId)}`);
      }
      const separator = wsUrl.includes("?") ? "&" : "?";
      url = `${wsUrl}${separator}${queryParts.join("&")}`;
      this.logger.debug("Using URL-based authentication");
    } else {
      // No auth token available
      url = wsUrl;
      this.logger.debug("No authToken available");
    }
    // Add non-sensitive params to URL
    const hasParams = url.includes("?");
    if (name) url += `${hasParams ? "&" : "?"}name=${encodeURIComponent(name)}`;
    if (avatar) {
      const separator = url.includes("?") ? "&" : "?";
      url += `${separator}avatar=${encodeURIComponent(avatar)}`;
    }

    // Read embedded configuration once at initialization
    if (typeof window !== "undefined") {
      const isEmbedded = (window as { __HYPERIA_EMBEDDED__?: boolean })
        .__HYPERIA_EMBEDDED__;
      const embeddedConfig = (
        window as {
          __HYPERIA_CONFIG__?: {
            mode?: string;
            characterId?: string;
            followEntity?: string;
          };
        }
      ).__HYPERIA_CONFIG__;

      if (isEmbedded && embeddedConfig) {
        this.isEmbeddedSpectator = embeddedConfig.mode === "spectator";
        // Use followEntity as fallback so the onStreamingState guard fires even
        // when the dashboard specifies an agent via followEntity (not characterId).
        const originalFollowTarget =
          embeddedConfig.characterId || embeddedConfig.followEntity || null;
        this.embeddedCharacterId = originalFollowTarget;
        // Freeze the original follow target on window so it survives HMR re-instantiation
        // and can't be overwritten by streaming state broadcasts.
        if (
          originalFollowTarget &&
          !(window as { __HYPERIA_ORIGINAL_FOLLOW__?: string })
            .__HYPERIA_ORIGINAL_FOLLOW__
        ) {
          (
            window as { __HYPERIA_ORIGINAL_FOLLOW__?: string }
          ).__HYPERIA_ORIGINAL_FOLLOW__ = originalFollowTarget;
        }

        this.logger.debug("[ClientNetwork] Embedded config loaded", {
          isSpectator: this.isEmbeddedSpectator,
          hasCharacterId: !!this.embeddedCharacterId,
        });

        // CRITICAL: Add mode, characterId, and followEntity to the WebSocket URL
        // so the server's ConnectionHandler can use them to target the correct agent.
        // Without these params, params.characterId and params.followEntity are undefined
        // on the server, so requestedCharacterId is null and the server falls back to
        // whatever streaming duel is active — causing the "random guy near a tree" bug.
        if (embeddedConfig.mode && !url.includes("mode=")) {
          url += `${url.includes("?") ? "&" : "?"}mode=${encodeURIComponent(embeddedConfig.mode)}`;
        }
        if (embeddedConfig.characterId && !url.includes("characterId=")) {
          url += `&characterId=${encodeURIComponent(embeddedConfig.characterId)}`;
        }
        if (embeddedConfig.followEntity && !url.includes("followEntity=")) {
          url += `&followEntity=${encodeURIComponent(embeddedConfig.followEntity)}`;
        }
      }
    }

    const isStreamingConnection = /[?&]mode=streaming(?:[&#]|$)/.test(url);
    const isSpectatorConnection = /[?&]mode=spectator(?:[&#]|$)/.test(url);
    // Load-test clients are authenticated by the server from their explicit
    // connection flag and receive a snapshot immediately. Waiting for an
    // auth-result packet here deadlocks that supported local-only handshake.
    const connectionAuthMode = resolveClientConnectionAuthMode({
      url,
      urlHasAuthToken,
      authToken,
      embeddedSpectator: this.isEmbeddedSpectator,
      allowLoadTestBypass:
        process.env.LOAD_TEST_MODE === "true" &&
        process.env.NODE_ENV !== "production",
    });
    const useFirstMessageAuth = connectionAuthMode === "first-message";
    const connectionTimeoutMs =
      isStreamingConnection || isSpectatorConnection ? 120_000 : 30_000;

    return new Promise((resolve, reject) => {
      const transport = new WebSocket(url);
      this.ws = transport;
      transport.binaryType = "arraybuffer";

      const timeout = setTimeout(() => {
        if (this.ws !== transport) {
          reject(new Error("WebSocket connection superseded"));
          return;
        }
        this.logger.warn("WebSocket connection timeout");
        reject(new Error("WebSocket connection timeout"));
      }, connectionTimeoutMs);

      // Handler for first-message auth response
      const handleAuthResult = (event: MessageEvent) => {
        if (this.ws !== transport || this.worldAdmission.rejected) return;
        const packet = readPacket(event.data as ArrayBuffer);
        if (!packet || packet.length === 0) return;

        const [method, data] = packet;
        if (method === "onAuthResult") {
          const result = data as { success: boolean; error?: string };

          // Remove auth handler - we're done with auth phase
          transport.removeEventListener("message", handleAuthResult);

          if (result.success) {
            this.logger.debug("First-message authentication successful");
            // Auth successful - complete connection setup
            this.completeConnectionSetup(timeout, resolve);
          } else {
            const errorMessage = `Authentication failed: ${result.error || "Unknown error"}`;
            this.logger.error(errorMessage);
            clearTimeout(timeout);
            reject(new Error(errorMessage));
          }
        }
      };

      transport.addEventListener("open", () => {
        if (this.ws !== transport || this.worldAdmission.rejected) return;
        this.logger.debug("WebSocket connected successfully");

        if (useFirstMessageAuth) {
          // First-message auth: send authenticate packet and wait for response
          this.logger.debug("Sending first-message authentication...");

          // Add auth result handler BEFORE sending authenticate packet
          transport.addEventListener("message", handleAuthResult);

          // Send authentication credentials
          const authPacket = writePacket("authenticate", {
            authToken,
            privyUserId,
            name,
            avatar,
          });
          transport.send(authPacket);

          // Don't resolve yet - wait for authResult
        } else {
          // Legacy URL-based auth: complete immediately
          this.completeConnectionSetup(timeout, resolve);
        }
      });

      transport.addEventListener("message", this.onPacket);
      transport.addEventListener("close", this.onClose);

      transport.addEventListener("error", (e) => {
        clearTimeout(timeout);
        if (this.ws !== transport) {
          reject(new Error("WebSocket connection superseded"));
          return;
        }
        const isExpectedDisconnect =
          transport.readyState === WebSocket.CLOSED ||
          transport.readyState === WebSocket.CLOSING;
        if (!isExpectedDisconnect) {
          // Extract error message - handle both browser ErrorEvent and Node.js Event
          const errorMessage =
            e instanceof Error
              ? e.message
              : typeof ErrorEvent !== "undefined" && e instanceof ErrorEvent
                ? e.message
                : String(e);
          this.logger.error(`WebSocket error: ${errorMessage}`);
          reject(e);
        }
      });
    });
  }

  /**
   * Complete the connection setup after authentication (or immediately for legacy URL auth)
   * Extracted to avoid code duplication between first-message auth and legacy auth paths
   */
  private completeConnectionSetup(
    timeout: ReturnType<typeof setTimeout>,
    resolve: () => void,
  ): void {
    // World.init must finish before the packet loop starts: resolve transport
    // setup here, but do not claim world admission or flush gameplay messages.
    this.initialized = true;
    clearTimeout(timeout);
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    // Start application-level keepalive to prevent Cloudflare/proxy idle timeout.
    // WS protocol-level ping/pong frames may not count as "activity" for reverse proxies,
    // so we send a lightweight application-level packet periodically.
    if (this.keepaliveIntervalId) {
      clearInterval(this.keepaliveIntervalId);
    }
    this.keepaliveIntervalId = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(writePacket("keepalive", Date.now()));
        } catch {
          // Socket may have closed between check and send
        }
      }
    }, ClientNetwork.KEEPALIVE_INTERVAL_MS);

    resolve();
  }

  preFixedUpdate() {
    this.flush();

    // Periodically clean up stale pending modifications (every ~5 seconds at 60fps = ~300 frames)
    // Only check occasionally to avoid performance impact
    if (Math.random() < 0.003) {
      this.cleanupStalePendingModifications();
    }
  }

  /**
   * Clean up pending modifications that are too old (entity never arrived)
   */
  private cleanupStalePendingModifications(): void {
    const now = performance.now();
    const staleTimeout = 10000; // 10 seconds

    for (const [
      entityId,
      timestamp,
    ] of this.pendingModificationTimestamps.entries()) {
      const age = now - timestamp;
      if (age > staleTimeout) {
        // Silent cleanup to avoid log spam - update count first
        const list = this.pendingModifications.get(entityId);
        if (list) {
          this.totalPendingModificationCount -= list.length;
        }
        this.pendingModifications.delete(entityId);
        this.pendingModificationTimestamps.delete(entityId);
        this.pendingModificationLimitReached.delete(entityId);
      }
    }
  }

  send<T = unknown>(name: string, data?: T) {
    if (this.worldAdmission.rejected) return;
    if (
      this.connected &&
      this.worldAdmission.admitted &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      // console.debug(`[ClientNetwork] Sending packet: ${name}`, data)
      const packet = writePacket(name, data);
      this.ws.send(packet);
    } else if (
      this.isReconnecting ||
      (this.ws && this.ws.readyState === WebSocket.OPEN)
    ) {
      // Queue message for later delivery when reconnected
      this.queueOutgoingMessage(name, data);
    } else {
      console.warn(
        `[ClientNetwork] Cannot send ${name} - WebSocket not open. State:`,
        {
          hasWs: !!this.ws,
          readyState: this.ws?.readyState,
          connected: this.connected,
          id: this.id,
          isReconnecting: this.isReconnecting,
        },
      );
    }
  }

  /**
   * Queue an outgoing message for delivery when reconnected
   */
  private queueOutgoingMessage<T>(name: string, data?: T): void {
    // Don't queue certain messages that don't make sense after reconnection
    const skipQueuePatterns = ["ping", "pong", "heartbeat"];
    if (skipQueuePatterns.some((pattern) => name.includes(pattern))) {
      return;
    }

    // Enforce queue size limit (LRU - remove oldest)
    if (this.outgoingQueue.length >= this.maxOutgoingQueueSize) {
      const dropped = this.outgoingQueue.shift();
      this.logger.debug(
        `Outgoing queue full, dropped oldest message: ${dropped?.name}`,
      );
    }

    this.outgoingQueue.push({
      name,
      data,
      timestamp: Date.now(),
    });
    this.outgoingQueueSequence++;

    this.logger.debug(
      `Queued message for reconnection: ${name} (queue size: ${this.outgoingQueue.length})`,
    );
  }

  /**
   * Flush queued outgoing messages after reconnection
   */
  private flushOutgoingQueue(): void {
    if (
      !this.connected ||
      !this.worldAdmission.admitted ||
      this.outgoingQueue.length === 0
    ) {
      return;
    }

    this.logger.debug(`Flushing ${this.outgoingQueue.length} queued messages`);

    // Filter out stale messages (older than 30 seconds)
    const staleThreshold = 30000;
    const now = Date.now();
    const validMessages = this.outgoingQueue.filter(
      (msg) => now - msg.timestamp < staleThreshold,
    );

    const staleCount = this.outgoingQueue.length - validMessages.length;
    if (staleCount > 0) {
      this.logger.debug(
        `Dropped ${staleCount} stale messages from outgoing queue`,
      );
    }

    // Send valid messages
    for (const msg of validMessages) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const packet = writePacket(msg.name, msg.data);
        this.ws.send(packet);
        this.logger.debug(`Sent queued message: ${msg.name}`);
      }
    }

    // Clear the queue
    this.outgoingQueue = [];
    this.outgoingQueueSequence = 0;
  }

  enqueue(method: string, data: unknown) {
    if (this.worldAdmission.rejected) return;
    this.queue.push([method, data]);
  }

  async flush() {
    // Don't process queue if WebSocket is not connected
    if (
      this.flushing ||
      this.worldAdmission.rejected ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    this.flushing = true;
    const transport = this.ws;
    try {
      // OPTIMIZATION: Use read index instead of shift() - O(1) vs O(n)
      // Process from _queueReadIndex to queue.length, with per-frame limit to prevent jank
      const MAX_PACKETS_PER_FRAME = 50; // Prevent packet storm from blocking main thread
      let packetsProcessed = 0;

      while (
        this._queueReadIndex < this.queue.length &&
        packetsProcessed < MAX_PACKETS_PER_FRAME &&
        this.ws === transport &&
        transport.readyState === WebSocket.OPEN &&
        !this.worldAdmission.rejected
      ) {
        const packet = this.queue[this._queueReadIndex++];
        const method = packet[0];
        const data = packet[1];
        packetsProcessed++;

        // Broadcasts can arrive before the initial snapshot. Its authoritative
        // state supersedes these deltas; never apply them before admission.
        if (!this.worldAdmission.allowsPacket(method)) continue;

        // OPTIMIZATION: Cache handler lookups to avoid string operations per packet
        let handler = this._handlerCache.get(method);
        if (handler === undefined) {
          // First time seeing this method - look it up and cache
          handler = (this as Record<string, unknown>)[method] as
            Function | undefined;
          if (!handler) {
            // Try onX format (e.g., onSnapshot)
            const onName = `on${method.charAt(0).toUpperCase()}${method.slice(1)}`;
            handler = (this as Record<string, unknown>)[onName] as
              Function | undefined;
          }
          // Cache result (even if null, to avoid repeated lookups)
          this._handlerCache.set(method, handler ?? null);
        }

        if (!handler) {
          console.error(`[ClientNetwork] No handler for packet '${method}'`);
          continue; // Skip unknown packets instead of throwing to avoid breaking queue
        }

        try {
          // Strong type assumption - handler is a function
          const result = handler.call(this, data);
          if (result instanceof Promise) {
            await result;
          }
        } catch (err) {
          console.error(
            `[ClientNetwork] Error handling packet '${method}':`,
            err,
          );
          // Continue processing remaining packets even if one fails
        }
      }

      // Compact processed entries periodically without discarding unread packets.
      // A frame can intentionally leave work behind at MAX_PACKETS_PER_FRAME; clearing
      // the whole array here used to drop that tail whenever the read index crossed
      // 1,000 during a packet burst (including adjacent combat terminal packets).
      if (this._queueReadIndex > 1000) {
        if (this._queueReadIndex >= this.queue.length) {
          this.queue.length = 0;
        } else {
          this.queue = this.queue.slice(this._queueReadIndex);
        }
        this._queueReadIndex = 0;
      }
    } finally {
      this.flushing = false;
    }
  }

  getTime() {
    return (performance.now() + this.serverTimeOffset) / 1000; // seconds
  }

  onPacket = (e: MessageEvent) => {
    if (
      this.worldAdmission.rejected ||
      (e.currentTarget && e.currentTarget !== this.ws)
    )
      return;
    const result = readPacket(e.data);
    if (result && result[0]) {
      const [method, data] = result;
      this.enqueue(method, data);
    }
  };

  /**
   * Handler for authResult packets.
   * This is a no-op because auth is handled by the temporary handleAuthResult listener
   * during the connection phase. This method exists to prevent "No handler" warnings
   * when the packet is also received by the general onPacket handler.
   */
  onAuthResult(_data: { success: boolean; error?: string }): void {
    // Auth is already handled in connect() by the temporary handleAuthResult listener.
    // This handler exists to satisfy the flush() method's handler lookup.
    this.logger.debug("onAuthResult received (already handled during connect)");
  }

  async onSnapshot(data: SnapshotData) {
    // This must precede every snapshot side effect, including enterWorld.
    const admission = this.worldAdmission.admitSnapshot(
      data?.worldContentIdentity,
    );
    if (admission === null) {
      this.rejectWorldAdmission();
      return;
    }
    this.id = data.id; // Store our network ID
    this.connected = true; // Mark as connected when we get the snapshot

    // CRITICAL: Ensure world.network points to this instance and has our ID
    if (
      !this.world.network ||
      (this.world.network as { id?: string }).id !== this.id
    ) {
      (this.world as { network?: unknown }).network = this;
    }

    // Check if this is a spectator connection (from server snapshot)
    const isSpectatorMode =
      (data as { spectatorMode?: boolean }).spectatorMode === true;
    const followEntityId = (data as { followEntity?: string }).followEntity;

    if (isSpectatorMode) {
      this.logger.info(
        "👁️ Spectator mode detected - skipping character selection and enterWorld",
      );
      this.logger.info(
        `👁️ Spectator snapshot contains ${data.entities?.length || 0} entities`,
      );
      // Spectators don't spawn player entities - they just receive broadcasts
      // Store followEntity for camera setup after entities are loaded
      if (followEntityId) {
        this.logger.info(`👁️ Spectator will follow entity: ${followEntityId}`);
        this.spectatorFollowEntity = followEntityId;
      }
      // Continue to entity processing below
    } else {
      // Auto-enter world if in character-select mode and we have a selected character
      const isCharacterSelectMode =
        Array.isArray(data.entities) &&
        data.entities.length === 0 &&
        Array.isArray((data as { characters?: unknown[] }).characters);

      console.log("[PlayerLoading] Snapshot received", {
        entitiesCount: data.entities?.length ?? "undefined",
        hasCharacters: Array.isArray(
          (data as { characters?: unknown[] }).characters,
        ),
        isCharacterSelectMode,
      });

      // Handle character selection and world entry (non-spectators only)
      if (isCharacterSelectMode) {
        // Get characterId from embedded config (read at init) OR sessionStorage
        // NOTE: sessionStorage is per-tab, preventing cross-tab character conflicts
        // (localStorage was causing Tab B to overwrite Tab A's character selection)
        const characterId =
          this.embeddedCharacterId ||
          (typeof sessionStorage !== "undefined"
            ? sessionStorage.getItem("selectedCharacterId")
            : null);

        console.log("[PlayerLoading] Character select mode detected", {
          characterId,
          isEmbedded: this.isEmbeddedSpectator,
        });

        if (characterId) {
          // Embedded spectator mode needs characterSelected packet first
          if (this.isEmbeddedSpectator) {
            this.send("characterSelected", { characterId });
          }

          // Both modes need enterWorld to spawn the character
          console.log(
            `[PlayerLoading] Sending enterWorld with characterId: ${characterId}`,
          );
          this.send("enterWorld", { characterId });
        } else {
          if (process.env.PLAYWRIGHT_TEST === "true") {
            console.log(
              "[PlayerLoading] No characterId available in PLAYWRIGHT_TEST, sending anonymous enterWorld",
            );
            this.send("enterWorld", {});
          } else {
            console.warn(
              "[PlayerLoading] No characterId available, skipping auto-enter world",
            );
          }
        }
      }
    }
    // Ensure Physics is fully initialized before processing entities
    // This is needed because PlayerLocal uses physics extensions during construction
    const physicsSystem = this.world.physics as
      { physics?: unknown } | undefined;
    const needsLocalPhysics = !isSpectatorMode;
    if (physicsSystem && !physicsSystem.physics && needsLocalPhysics) {
      // Wait a bit for Physics to initialize
      let attempts = 0;
      while (!physicsSystem.physics && attempts < 50) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (!this.worldAdmission.isCurrent(admission)) return;
        attempts++;
      }
      if (!physicsSystem.physics) {
        this.logger.error("Physics failed to initialize after waiting");
      }
    } else if (!physicsSystem && needsLocalPhysics) {
      this.logger.warn("Physics system unavailable while processing snapshot");
    }

    // Already set above
    this.serverTimeOffset = data.serverTime - performance.now();
    this.apiUrl = data.apiUrl || null;

    // Sync world time for day/night cycle (all clients see same time)
    const worldTime = (data as { worldTime?: number }).worldTime;
    if (worldTime !== undefined) {
      this.worldTimeOffset = worldTime - this.world.getTime();
    }
    this.maxUploadSize = data.maxUploadSize || 10 * 1024 * 1024; // Default 10MB

    // Use assetsUrl from server (always absolute URL to CDN)
    this.world.assetsUrl = data.assetsUrl || "/";
    if (typeof window !== "undefined") {
      const windowWithAssets = window as Window & {
        __CDN_URL?: string;
        __ASSETS_URL?: string;
      };
      if (data.assetsUrl) {
        windowWithAssets.__ASSETS_URL = data.assetsUrl;
        windowWithAssets.__CDN_URL = data.assetsUrl;
      }
    }

    const loader = this.world.loader!;
    // Assume preload and execPreload methods exist on loader
    // preload environment model and avatar
    if (loader) {
      if (
        data.settings &&
        typeof data.settings === "object" &&
        "model" in data.settings
      ) {
        const settings = data.settings as { model?: string };
        if (settings?.model) {
          loader.preload("model", settings.model);
        }
      } else if (this.world.environment?.base?.model) {
        loader.preload("model", this.world.environment.base.model);
      }
      if (
        data.settings &&
        typeof data.settings === "object" &&
        "avatar" in data.settings
      ) {
        const settings = data.settings as { avatar?: { url?: string } };
        if (settings?.avatar?.url) {
          loader.preload("avatar", settings.avatar.url);
        }
      }
      // preload emotes
      for (const url of emoteUrls) {
        loader.preload("emote", url as string);
      }
      // We'll preload local player avatar after entities are deserialized
    }

    // Deserialize settings if method exists
    if (data.settings) {
      try {
        this.world.settings.deserialize(data.settings);
      } catch (err) {
        this.logger.error(
          "Failed to deserialize settings snapshot:",
          err instanceof Error ? err : undefined,
        );
      }
    }

    if (data.chat) {
      try {
        this.world.chat.deserialize(data.chat);
      } catch (err) {
        this.logger.error(
          "Failed to deserialize chat snapshot:",
          err instanceof Error ? err : undefined,
        );
      }
    }
    // Deserialize entities if method exists
    if (data.entities) {
      const snapshotEntities = this.filterNetworkEntities(data.entities);
      try {
        await this.world.entities.deserialize(snapshotEntities);
        if (!this.worldAdmission.isCurrent(admission)) return;
      } catch (err) {
        this.logger.error(
          "Failed to deserialize entity snapshot:",
          err instanceof Error ? err : undefined,
        );
        return;
      }

      // Now preload local player avatar after entities are created
      if (loader) {
        let playerAvatarPreloaded = false;
        for (const entity of this.world.entities.values()) {
          if (
            entity.data?.type === "player" &&
            entity.data?.owner === this.id
          ) {
            const url = entity.data.sessionAvatar || entity.data.avatar;
            if (typeof url === "string" && url.length > 0) {
              loader.preload("avatar", url);
              playerAvatarPreloaded = true;
              break;
            }
          }
        }
        if (!playerAvatarPreloaded) {
          // Try from the raw data if entity iteration didn't work
          for (const item of snapshotEntities) {
            const entity = item as {
              type?: string;
              owner?: string;
              sessionAvatar?: string;
              avatar?: string;
            };
            if (entity.type === "player" && entity.owner === this.id) {
              const url = entity.sessionAvatar || entity.avatar;
              if (typeof url === "string" && url.length > 0) {
                loader.preload("avatar", url);
                playerAvatarPreloaded = true;
                break;
              }
            }
          }
        }
        // Now execute preload after all assets are queued
        loader.execPreload();
      }

      // Set initial serverPosition for local player immediately to avoid Y=0 flash
      for (const entityData of snapshotEntities) {
        if (
          entityData &&
          entityData.type === "player" &&
          entityData.owner === this.id
        ) {
          const local = this.world.entities.get(entityData.id);
          if (local instanceof PlayerLocal) {
            // Force the position immediately
            const pos = entityData.position as [number, number, number];
            local.position.set(pos[0], pos[1], pos[2]);

            // Also update server position for reconciliation
            local.updateServerPosition(pos[0], pos[1], pos[2]);
          } else {
            this.logger.warn(
              "Local player entity not found after deserialize!",
            );
          }
        }
      }
      // Apply pending modifications to all newly added entities
      for (const entityData of snapshotEntities) {
        if (entityData && entityData.id) {
          this.applyPendingModifications(entityData.id);
        }
      }
    }

    // Character-select mode: if server sent an empty entity list with account info,
    // surface the character list/modal immediately even if the dedicated packet hasn't arrived yet.
    if (
      Array.isArray(data.entities) &&
      data.entities.length === 0 &&
      (data as { account?: unknown }).account
    ) {
      const list = this.lastCharacterList || [];
      this.world.emit(EventType.CHARACTER_LIST, { characters: list });
    }

    // Spectator mode: Auto-follow the target entity after entities are loaded
    const spectatorFollowId = this.spectatorFollowEntity;
    if (isSpectatorMode && spectatorFollowId) {
      // Mark that we're waiting for spectator target
      this.spectatorTargetPending = true;

      const MAX_RETRY_SECONDS = 15;
      let retryCount = 0;

      // Helper to set camera target
      const setCameraTarget = (entity: unknown) => {
        const camera =
          (this.world.getSystem("client-camera-system") as
            { setTarget?: (target: unknown) => void } | undefined) ??
          (this.world.getSystem("client-camera") as
            { setTarget?: (target: unknown) => void } | undefined) ??
          (this.world.getSystem("camera") as
            { setTarget?: (target: unknown) => void } | undefined);
        if (camera?.setTarget) {
          this.logger.info(
            `👁️ Setting camera target to entity ${spectatorFollowId}`,
          );
          camera.setTarget(entity);
        } else {
          this.logger.warn(
            "👁️ Camera system not found or missing setTarget method",
          );
        }
      };

      // Helper to attempt following the entity
      const attemptFollow = (): boolean => {
        if (!this.worldAdmission.isCurrent(admission)) return false;
        const targetEntity =
          this.resolveSpectatorTargetEntity(spectatorFollowId);

        if (targetEntity) {
          // Found the entity - clear pending state and interval
          this.spectatorTargetPending = false;
          if (this.spectatorRetryInterval) {
            clearInterval(
              this.spectatorRetryInterval as ReturnType<typeof setInterval>,
            );
            this.spectatorRetryInterval = null;
          }
          this.logger.info(
            `👁️ Spectator following entity ${spectatorFollowId}`,
          );
          setCameraTarget(targetEntity);
          return true;
        }
        return false;
      };

      // Try immediately after a short delay for entity initialization
      setTimeout(() => {
        if (!this.worldAdmission.isCurrent(admission)) return;
        if (!attemptFollow()) {
          this.logger.info(
            `👁️ Spectator target entity ${spectatorFollowId} not found - starting retry loop`,
          );

          // Start retry interval - check every 1 second for up to 15 seconds
          this.spectatorRetryInterval = setInterval(() => {
            if (!this.worldAdmission.isCurrent(admission)) {
              if (this.spectatorRetryInterval !== null) {
                clearInterval(
                  this.spectatorRetryInterval as ReturnType<typeof setInterval>,
                );
                this.spectatorRetryInterval = null;
              }
              return;
            }
            retryCount++;

            if (attemptFollow()) {
              this.logger.info(
                `👁️ Found spectator target after ${retryCount}s`,
              );
              return;
            }

            if (retryCount >= MAX_RETRY_SECONDS) {
              if (this.spectatorRetryInterval !== null) {
                clearInterval(
                  this.spectatorRetryInterval as ReturnType<typeof setInterval>,
                );
              }
              this.spectatorRetryInterval = null;
              this.spectatorTargetPending = false;
              this.logger.error(
                `👁️ Agent entity ${spectatorFollowId} not found after ${MAX_RETRY_SECONDS}s`,
              );
            } else if (retryCount % 5 === 0) {
              // Log progress every 5 seconds to avoid spam
              this.logger.info(
                `👁️ Still waiting for agent entity (${retryCount}/${MAX_RETRY_SECONDS}s)...`,
              );
            }
          }, 1000);
        }
      }, 100);
    }

    if (data.livekit) {
      try {
        this.world.livekit?.deserialize(data.livekit);
      } catch (err) {
        this.logger.error(
          "Failed to deserialize LiveKit snapshot:",
          err instanceof Error ? err : undefined,
        );
      }
    }

    storage?.set("authToken", data.authToken);

    // Transport reconnection is not success until its world snapshot validates.
    if (this.isReconnecting) {
      this.emitTypedEvent("NETWORK_RECONNECTED", {
        attempts: this.reconnectAttempts,
      });
      this.world.chat.add(
        {
          id: uuid(),
          from: "System",
          fromId: undefined,
          body: "Connection restored.",
          text: "Connection restored.",
          timestamp: Date.now(),
          createdAt: new Date().toISOString(),
        },
        false,
      );
    }
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.flushOutgoingQueue();
  }

  /** Persistent diagnostic; cleared only by a fresh matching admission. */
  get worldAdmissionError(): string | null {
    return this.worldAdmission.failure;
  }

  /** Exact remote digest validated for this transport, never a pending/stale hash. */
  get admittedWorldContentIdentity(): string | null {
    return this.worldAdmission.admittedIdentity;
  }

  private rejectWorldAdmission(): void {
    const reason =
      this.worldAdmission.failure ??
      "World snapshot arrived outside an active connection.";
    this.worldAdmission.reject(reason);
    this.connected = false;
    this.intentionalDisconnect = true;
    this.cancelReconnect();
    this.queue.length = 0;
    this._queueReadIndex = 0;
    this.outgoingQueue = [];
    this.outgoingQueueSequence = 0;
    if (this.keepaliveIntervalId) {
      clearInterval(this.keepaliveIntervalId);
      this.keepaliveIntervalId = null;
    }
    this.logger.error(reason);
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.ws.close(4005, "World content mismatch; update assets and reload");
    }
  }

  onSettingsModified = (data: { key: string; value: unknown }) => {
    this.world.settings.set(
      data.key,
      data.value as string | number | boolean | null | { url: string },
    );
  };

  onChatAdded = (msg: ChatMessage) => {
    // Add message to chat if method exists
    this.world.chat.add(msg, false);
  };

  onChatCleared = () => {
    // Clear chat if method exists
    this.world.chat.clear();
  };

  onSystemMessage = (data: { message: string; type: string }) => {
    // Add system message to chat (from UI_MESSAGE events)
    // These are server-generated messages like equipment requirements, combat info, etc.
    const chatMessage: ChatMessage = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from: "", // Empty from = system message (no [PlayerName] prefix)
      body: data.message,
      text: data.message,
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
    };
    this.world.chat.add(chatMessage, false);
  };

  /**
   * Handler for enterWorldApproved packet.
   * The actual game state transition is handled by CharacterSelectScreen,
   * this handler just prevents the "no handler" warning.
   */
  onEnterWorldApproved = (_data: { playerId: string; characterId: string }) => {
    // Handled by CharacterSelectScreen socket listener
  };

  onEntityAdded = (data: EntityData) => {
    if (this.filterNetworkEntities([data]).length === 0) return;

    // Add entity if method exists
    const newEntity = this.world.entities.add(data);
    if (newEntity) {
      this.applyPendingModifications(newEntity.id);
      // If this is the local player added after character select, force-set initial position
      const isLocalPlayer =
        (data as { type?: string; owner?: string }).type === "player" &&
        (data as { owner?: string }).owner === this.id;
      if (
        isLocalPlayer &&
        Array.isArray((data as { position?: number[] }).position)
      ) {
        let pos = (data as { position?: number[] }).position as [
          number,
          number,
          number,
        ];
        // Safety clamp: never allow Y < 5 to prevent under-map spawn
        if (pos[1] < 5) {
          console.warn(
            `[ClientNetwork] Clamping invalid spawn Y=${pos[1]} to safe height 50`,
          );
          pos = [pos[0], 50, pos[2]];
        }
        if (newEntity instanceof PlayerLocal) {
          newEntity.position.set(pos[0], pos[1], pos[2]);
          newEntity.updateServerPosition(pos[0], pos[1], pos[2]);
        }
      }

      // Check if this is the spectator target entity we're waiting for
      const spectatorFollowId = this.spectatorFollowEntity;
      const isWaitingForTarget = this.spectatorTargetPending;
      const targetSpawned = Boolean(
        spectatorFollowId &&
        (this.isEntityMatchingSpectatorTarget(
          data.id,
          data as unknown,
          spectatorFollowId,
        ) ||
          this.isEntityMatchingSpectatorTarget(
            newEntity.id,
            newEntity,
            spectatorFollowId,
          )),
      );

      if (isWaitingForTarget && targetSpawned) {
        this.logger.info(
          `👁️ Spectator target entity ${spectatorFollowId} just spawned!`,
        );

        // Clear retry interval if running
        if (this.spectatorRetryInterval) {
          clearInterval(
            this.spectatorRetryInterval as ReturnType<typeof setInterval>,
          );
          this.spectatorRetryInterval = null;
        }
        this.spectatorTargetPending = false;

        // Set camera to follow this entity
        const camera =
          (this.world.getSystem("client-camera-system") as
            { setTarget?: (target: unknown) => void } | undefined) ??
          (this.world.getSystem("client-camera") as
            { setTarget?: (target: unknown) => void } | undefined) ??
          (this.world.getSystem("camera") as
            { setTarget?: (target: unknown) => void } | undefined);
        if (camera?.setTarget) {
          this.logger.info(
            `👁️ Setting camera target to newly spawned entity ${spectatorFollowId}`,
          );
          camera.setTarget(newEntity);
        }
      }
    }
  };

  onEntitiesBatchAdded = (batch: EntityData[]) => {
    if (!Array.isArray(batch)) return;
    for (const data of this.filterNetworkEntities(batch)) {
      const newEntity = this.world.entities.add(data);
      if (newEntity) {
        this.applyPendingModifications(newEntity.id);
      }
    }
  };

  onEntityModified = (
    data: { id: string; changes?: Record<string, unknown> } & Record<
      string,
      unknown
    >,
  ) => {
    const { id } = data;
    if (this.streamingFilteredEntityIds.has(id)) return;

    const entity = this.world.entities.get(id);
    if (!entity) {
      // Limit queued modifications per entity to avoid unbounded growth
      const list = this.pendingModifications.get(id) || [];
      const now = performance.now();

      // Check if modifications are too old (>10 seconds) and drop them
      if (list.length > 0) {
        const firstTimestamp =
          this.pendingModificationTimestamps.get(id) || now;
        const age = now - firstTimestamp;
        if (age > 10000) {
          // Entity never arrived, clear the stale modifications (silent)
          this.totalPendingModificationCount -= list.length;
          this.pendingModifications.delete(id);
          this.pendingModificationTimestamps.delete(id);
          this.pendingModificationLimitReached.delete(id);
          return;
        }
      }

      // Check global limit - evict oldest entity's modifications if needed
      if (
        this.totalPendingModificationCount >=
        this.MAX_TOTAL_PENDING_MODIFICATIONS
      ) {
        // Find oldest entity's modifications to evict
        let oldestEntityId: string | null = null;
        let oldestTimestamp = Infinity;
        for (const [
          entityId,
          timestamp,
        ] of this.pendingModificationTimestamps.entries()) {
          if (timestamp < oldestTimestamp && entityId !== id) {
            oldestTimestamp = timestamp;
            oldestEntityId = entityId;
          }
        }
        if (oldestEntityId) {
          const evictedList = this.pendingModifications.get(oldestEntityId);
          if (evictedList) {
            this.totalPendingModificationCount -= evictedList.length;
          }
          this.pendingModifications.delete(oldestEntityId);
          this.pendingModificationTimestamps.delete(oldestEntityId);
          this.pendingModificationLimitReached.delete(oldestEntityId);
        }
      }

      if (list.length < this.MAX_PENDING_MODIFICATIONS_PER_ENTITY) {
        list.push(data);
        this.pendingModifications.set(id, list);
        this.totalPendingModificationCount++;

        // Track timestamp of first modification
        if (list.length === 1) {
          this.pendingModificationTimestamps.set(id, now);
        }
      } else if (!this.pendingModificationLimitReached.has(id)) {
        // Mark once then stop logging to avoid spam
        this.pendingModificationLimitReached.add(id);
      }
      // No more logging after limit is reached to prevent spam
      return;
    }
    // Accept both normalized { changes: {...} } and flat payloads { id, ...changes }
    const changes =
      data.changes ??
      Object.fromEntries(
        Object.entries(data).filter(([k]) => k !== "id" && k !== "changes"),
      );

    // Resources relocate atomically; they are not characters walking a path.
    // In particular, a fishing spot's authoritative Y is its water surface.
    // A routine p/q update must not create combat-facing state whose next
    // TileInterpolator update would replace that Y with the pond bed height.
    if (entity.type === "resource") {
      const resource = entity as ResourceEntity;
      this.deleteInterpolationState(id);
      this.tileInterpolator.removeEntity(id);
      // Keep normal data updates, but do not merge unvalidated transform aliases
      // into canonical data.position/data.quaternion before applying them.
      const {
        p,
        q,
        position: namedPosition,
        quaternion,
        ...restChanges
      } = changes;
      entity.modify(restChanges);
      const position = p ?? namedPosition;
      if (
        Array.isArray(position) &&
        position.length === 3 &&
        position.every(Number.isFinite)
      ) {
        this.applyResourcePosition(resource, {
          x: position[0],
          y: position[1],
          z: position[2],
        });
      }
      const rotation = q ?? quaternion;
      if (
        Array.isArray(rotation) &&
        rotation.length === 4 &&
        rotation.every(Number.isFinite)
      ) {
        entity.node.quaternion.set(
          rotation[0],
          rotation[1],
          rotation[2],
          rotation[3],
        );
        resource.config.rotation = {
          x: rotation[0],
          y: rotation[1],
          z: rotation[2],
          w: rotation[3],
        };
        entity.data.quaternion = [
          rotation[0],
          rotation[1],
          rotation[2],
          rotation[3],
        ];
      }
      if (typeof changes.e === "string") entity.data.emote = changes.e;
      this.world.emit(EventType.ENTITY_MODIFIED, { id, changes });
      return;
    }

    // Check if this is the local player
    const isLocal = (() => {
      const localEntityId = this.world.entities.player?.id;
      if (localEntityId && id === localEntityId) return true;
      const ownerId = (entity as { data?: { owner?: string } }).data?.owner;
      return !!(this.id && ownerId && ownerId === this.id);
    })();

    const hasP = Object.prototype.hasOwnProperty.call(changes, "p");
    const hasV = Object.prototype.hasOwnProperty.call(changes, "v");
    const hasQ = Object.prototype.hasOwnProperty.call(changes, "q");

    if (isLocal && (hasP || hasV || hasQ)) {
      // Local player - apply directly through entity.modify()
      // BUT: Skip position AND rotation updates if tile movement is active
      // (let tile interpolator handle them smoothly - server values cause twitching)
      if (this.tileInterpolator.hasState(id)) {
        // Tile movement active - strip position and rotation
        const { p, q, ...restChanges } = changes as Record<string, unknown>;
        entity.modify(restChanges);
      } else {
        entity.modify(changes);
      }
    } else {
      // Remote entities - use interpolation for smooth movement
      // CRITICAL: If entity is DEAD (or entering DEAD state), clear interpolation buffer
      // This prevents sliding from stale snapshots that were added before death
      const entityData = entity.serialize();

      // CRITICAL FIX: Use NEW state if present, otherwise use current state
      // This ensures when mob respawns (changes.aiState='idle'), it's treated as alive
      // and position updates are applied correctly
      const newState = changes.aiState || entityData.aiState;

      // Detect mob respawn: entity's current aiState is 'dead' but incoming state is NOT 'dead'.
      // This needs special handling because entity.data.e may still be 'death' (stale emote
      // from the death animation). Without this check, isDeadMob stays true after respawn,
      // causing tile state to be cleared every packet and position updates to malfunction.
      const currentAiState =
        (entity.data as { aiState?: string })?.aiState ?? entityData.aiState;
      const isMobRespawning =
        currentAiState === "dead" &&
        typeof changes.aiState === "string" &&
        changes.aiState !== "dead";

      if (isMobRespawning) {
        // Clean slate: clear ALL movement/interpolation state for this entity
        this.interpolationStates.delete(id);
        if (this.tileInterpolator.hasState(id)) {
          this.tileInterpolator.removeEntity(id);
        }

        // Clear stale 'death' emote so subsequent packets don't think mob is still dead
        // (also cleared in MobEntity.modify() respawn block as defense in depth)
        (entity.data as Record<string, unknown>).e = undefined;
        (entity.data as Record<string, unknown>).emote = undefined;

        // Apply ALL changes including position (p) — mob must snap to new spawn point
        entity.modify(changes);

        // Set up tile state at new spawn position for subsequent tile-based movement
        const changesObj = changes as Record<string, unknown>;
        if (hasP && hasQ) {
          const pArr = changesObj.p as number[];
          this.tileInterpolator.setCombatRotation(
            id,
            changesObj.q as number[],
            { x: pArr[0], y: pArr[1], z: pArr[2] },
          );
        }

        // Sync emote if present
        if (typeof changes.e === "string") {
          entity.data.emote = changes.e;
        }
        return;
      }

      const newEmote =
        (changes as { e?: string }).e || (entityData as { e?: string }).e;

      // Check both mob death (aiState) and player death (emote)
      // AAA QUALITY: Also check entity.data.deathState (single source of truth)
      // AND deadPlayers set for backward compatibility
      const isDeadMob = newState === "dead" || newEmote === "death";
      const entityDeathState = (entity.data as { deathState?: DeathState })
        ?.deathState;
      const isDeadByEntityState =
        entityDeathState === DeathState.DYING ||
        entityDeathState === DeathState.DEAD;
      const isDeadPlayer = this.deadPlayers.has(id) || isDeadByEntityState;
      const isDead = isDeadMob || isDeadPlayer;

      // Mob AI state tracking (no logging needed in production)

      // Clear interpolation buffer for ANY dead entity (defense in depth)
      if (isDead && this.interpolationStates.has(id)) {
        this.deleteInterpolationState(id);
      }

      // CRITICAL: Clear tile state when entity dies - they need death/respawn positions
      // Without this, position is stripped and entity can't receive death position or respawn position
      if (isDead && this.tileInterpolator.hasState(id)) {
        this.tileInterpolator.removeEntity(id);
      }

      // Skip adding new interpolation snapshots for dead entities
      // Also skip for entities using tile movement (tile interpolator handles them)
      const hasTileState = this.tileInterpolator.hasState(id);
      if (hasP && !isDead && !hasTileState) {
        this.addInterpolationSnapshot(
          id,
          changes as {
            p?: [number, number, number];
            q?: [number, number, number, number];
            v?: [number, number, number];
          },
        );
      }

      // CRITICAL: For dead PLAYERS specifically, strip position entirely from entityModified
      // This prevents race condition where stale position packets overwrite respawn position
      // Dead mobs need position for death animation placement (different from players)
      if (isDeadPlayer && hasP) {
        const { p, q, ...restChanges } = changes as Record<string, unknown>;
        entity.modify(restChanges);
      } else if (hasTileState && !isDead) {
        // AAA ARCHITECTURE: TileInterpolator is Single Source of Truth for transform
        // When TileInterpolator controls an entity:
        // - Position: TileInterpolator handles (strip from entityModified)
        // - Rotation: Route to TileInterpolator.setCombatRotation() for combat facing
        //
        // This prevents race conditions where multiple systems fight over rotation.
        // TileInterpolator.setCombatRotation() will apply rotation when entity is standing still,
        // and ignore it when moving (movement direction takes priority, rules-accurate).
        const changesTyped = changes as Record<string, unknown>;
        const { p, q, ...restChanges } = changesTyped;

        // Route combat rotation to TileInterpolator (single source of truth)
        if (q && Array.isArray(q) && q.length === 4) {
          // Pass entity position so state creation uses correct position (not origin)
          const applied = this.tileInterpolator.setCombatRotation(
            id,
            q as number[],
            entity.position,
          );
          // If TileInterpolator didn't apply it (entity moving), that's intentional
          // Movement direction wins over combat rotation while moving
          if (!applied) {
            // Entity is moving - combat rotation ignored (rules-accurate)
          }
        }

        // Apply non-transform changes (emote, health, combat state, etc.)
        entity.modify(restChanges);
      } else {
        // For stationary entities (no TileInterpolator state), route combat rotation
        // to TileInterpolator which will create a minimal state and apply the quaternion.
        // This fixes magic/ranged attacks where the player doesn't move toward the target
        // but still needs to face them.
        const changesObj = changes as Record<string, unknown>;
        if (
          changesObj.q &&
          Array.isArray(changesObj.q) &&
          (changesObj.q as number[]).length === 4
        ) {
          // Pass position to setCombatRotation so new state uses correct position (not origin).
          // Prefer server position from packet, fall back to entity's current position.
          const pArr = changesObj.p as number[] | undefined;
          const posForState =
            pArr && pArr.length === 3
              ? { x: pArr[0], y: pArr[1], z: pArr[2] }
              : {
                  x: entity.position.x,
                  y: entity.position.y,
                  z: entity.position.z,
                };
          this.tileInterpolator.setCombatRotation(
            id,
            changesObj.q as number[],
            posForState,
          );
          // Strip q (TileInterpolator handles rotation) but KEEP p in modify.
          // MobEntity.modify() needs p to snap position on respawn (death→idle transition).
          // Base Entity.modify() just Object.assign's data — p doesn't auto-set position.
          const { q, ...restChanges } = changesObj;
          entity.modify(restChanges);
        } else {
          entity.modify(changes);
        }
      }

      // Sync entity.data.emote from abbreviated 'e' key
      // entity.modify() sets data.e via Object.assign, but the animation system
      // reads data.emote (set explicitly in onTileMovementEnd). Without this sync,
      // emote resets via entityModified (e.g., from failed gathering) are ignored
      // by the animation system since it never sees the updated emote property.
      if (typeof changes.e === "string") {
        entity.data.emote = changes.e;
      }
    }

    // Re-emit normalized change event so other systems can react
    this.world.emit(EventType.ENTITY_MODIFIED, { id, changes });
  };

  /**
   * Add snapshot for entity interpolation (client-side only, remote entities only)
   */
  private addInterpolationSnapshot(
    entityId: string,
    changes: {
      p?: [number, number, number];
      q?: [number, number, number, number];
      v?: [number, number, number];
    },
  ): void {
    let state = this.interpolationStates.get(entityId);
    if (!state) {
      state = this.createInterpolationState(entityId);
      this.interpolationStates.set(entityId, state);
      this._interpolationStatesDirty = true;
    }

    const snapshot = state.snapshots[state.snapshotIndex];

    if (changes.p) {
      snapshot.position[0] = changes.p[0];
      snapshot.position[1] = changes.p[1];
      snapshot.position[2] = changes.p[2];
    }

    if (changes.q) {
      snapshot.rotation[0] = changes.q[0];
      snapshot.rotation[1] = changes.q[1];
      snapshot.rotation[2] = changes.q[2];
      snapshot.rotation[3] = changes.q[3];
    } else {
      snapshot.rotation[0] = state.currentRotation.x;
      snapshot.rotation[1] = state.currentRotation.y;
      snapshot.rotation[2] = state.currentRotation.z;
      snapshot.rotation[3] = state.currentRotation.w;
    }

    snapshot.timestamp = performance.now();
    state.snapshotIndex = (state.snapshotIndex + 1) % this.maxSnapshots;
    state.snapshotCount = Math.min(state.snapshotCount + 1, this.maxSnapshots);
    state.lastUpdate = performance.now();
  }

  /**
   * Create interpolation state with pre-allocated buffers
   */
  private createInterpolationState(entityId: string): InterpolationState {
    const entity = this.world.entities.get(entityId);
    const position =
      entity && "position" in entity
        ? (entity.position as THREE.Vector3).clone()
        : new THREE.Vector3();

    const rotation = entity?.node?.quaternion
      ? entity.node.quaternion.clone()
      : new THREE.Quaternion();

    const snapshots: EntitySnapshot[] = [];
    for (let i = 0; i < this.maxSnapshots; i++) {
      snapshots.push({
        position: new Float32Array(3),
        rotation: new Float32Array(4),
        timestamp: 0,
      });
    }

    return {
      entityId,
      snapshots,
      snapshotIndex: 0,
      snapshotCount: 0,
      currentPosition: position,
      currentRotation: rotation,
      tempPosition: new THREE.Vector3(),
      tempRotation: new THREE.Quaternion(),
      lastUpdate: performance.now(),
      lastInterpolatedTime: performance.now(),
    };
  }

  private getOldestInterpolationSnapshotIndex(
    state: InterpolationState,
  ): number {
    if (state.snapshotCount === 0) {
      return 0;
    }

    return state.snapshotCount === this.maxSnapshots ? state.snapshotIndex : 0;
  }

  private getLatestInterpolationSnapshotIndex(
    state: InterpolationState,
  ): number {
    if (state.snapshotCount === 0) {
      return 0;
    }

    if (state.snapshotCount < this.maxSnapshots) {
      return state.snapshotCount - 1;
    }

    return (state.snapshotIndex - 1 + this.maxSnapshots) % this.maxSnapshots;
  }

  private getInterpolationSnapshotAt(
    state: InterpolationState,
    chronologicalIndex: number,
  ): EntitySnapshot {
    const oldestIndex = this.getOldestInterpolationSnapshotIndex(state);
    return state.snapshots[
      (oldestIndex + chronologicalIndex) % this.maxSnapshots
    ];
  }

  // PERFORMANCE: Track rotation index for progressive interpolation
  private _interpolationRotationIndex = 0;
  private readonly MAX_INTERPOLATIONS_PER_FRAME =
    readPositiveIntegerEnv(
      "PUBLIC_INTERPOLATION_MAX_PER_FRAME",
      "INTERPOLATION_MAX_PER_FRAME",
    ) ?? 500;
  private readonly INTERPOLATION_BUDGET_CHECK_INTERVAL = 20;
  // OPTIMIZATION: Cached array for interpolation states to avoid Array.from() every frame
  private _interpolationStatesArray: Array<[string, InterpolationState]> = [];
  private _interpolationStatesDirty = true;

  /** Helper to delete interpolation state and mark cache dirty */
  private deleteInterpolationState(entityId: string): boolean {
    const deleted = this.interpolationStates.delete(entityId);
    if (deleted) this._interpolationStatesDirty = true;
    return deleted;
  }

  /**
   * Update interpolation for remote entities (called in lateUpdate)
   *
   * OPTIMIZATION: Uses progressive processing with frame budget awareness.
   * Prioritizes nearby entities and rotates through others across frames.
   */
  private updateInterpolation(delta: number): void {
    const now = performance.now();
    const renderTime = now - this.interpolationDelay;

    // OPTIMIZATION: Use cached array, only rebuild when states change.
    // forEach avoids the iterator object allocation that .entries() creates.
    if (this._interpolationStatesDirty) {
      this._interpolationStatesArray.length = 0;
      this.interpolationStates.forEach((state, entityId) => {
        this._interpolationStatesArray.push([entityId, state]);
      });
      this._interpolationStatesDirty = false;
      this._interpolationRotationIndex = 0; // Reset rotation on change
    }
    const statesArray = this._interpolationStatesArray;
    const totalStates = statesArray.length;
    if (totalStates === 0) return;

    const frameBudget = this.world.frameBudget;
    const localPlayerId = this.world.entities.player?.id;
    let processed = 0;
    let inspected = 0;
    const maxInterpolations = Math.min(
      this.MAX_INTERPOLATIONS_PER_FRAME,
      totalStates,
    );

    // Start from rotation index
    const startIndex = this._interpolationRotationIndex % totalStates;
    let i = startIndex;

    while (inspected < maxInterpolations && processed < maxInterpolations) {
      // Check frame budget periodically
      if (
        inspected > 0 &&
        inspected % this.INTERPOLATION_BUDGET_CHECK_INTERVAL === 0
      ) {
        if (frameBudget && !frameBudget.hasTimeRemaining(1)) {
          break; // Over budget
        }
      }

      const [entityId, state] = statesArray[i];
      i = (i + 1) % totalStates;
      inspected++;

      // Skip local player - tile interpolation handles local player movement
      if (entityId === localPlayerId) {
        this.deleteInterpolationState(entityId);
        continue;
      }

      // Skip entities that have ANY tile interpolation state
      // Once an entity uses tile movement, ALL position updates should come from tile packets
      // Using hasState() instead of isInterpolating() prevents position conflicts when entity is stationary
      if (this.tileInterpolator.hasState(entityId)) {
        continue;
      }

      const entity = this.world.entities.get(entityId);
      if (!entity) {
        this.deleteInterpolationState(entityId);
        continue;
      }

      // CRITICAL: Skip interpolation for entities controlled by TileInterpolator
      // TileInterpolator handles position and rotation for tile-based movement
      if (entity.data?.tileInterpolatorControlled === true) {
        continue; // Don't interpolate - TileInterpolator handles this entity
      }

      // CRITICAL: Skip interpolation for dead mobs to prevent death animation sliding
      // Dead mobs lock their position client-side for classic fantasy MMORPG-style stationary death
      // Access entity.data directly instead of serialize() to avoid per-frame allocation
      if ((entity.data as { aiState?: string })?.aiState === "dead") {
        continue; // Don't interpolate - let MobEntity maintain locked death position
      }

      const elapsedSinceLastInterpolation = Math.max(
        0,
        (now - state.lastInterpolatedTime) / 1000,
      );
      const effectiveDelta =
        elapsedSinceLastInterpolation > 0
          ? elapsedSinceLastInterpolation
          : delta;
      state.lastInterpolatedTime = now;

      this.interpolateEntityPosition(
        entity,
        state,
        renderTime,
        now,
        effectiveDelta,
      );
      processed++;
    }

    // Save rotation index for next frame
    this._interpolationRotationIndex = i;
  }

  /**
   * Interpolate entity position for smooth movement
   */
  private interpolateEntityPosition(
    entity: Entity,
    state: InterpolationState,
    renderTime: number,
    now: number,
    delta: number,
  ): void {
    if (state.snapshotCount < 2) {
      if (state.snapshotCount === 1) {
        const snapshot =
          state.snapshots[this.getLatestInterpolationSnapshotIndex(state)];
        state.tempPosition.set(
          snapshot.position[0],
          snapshot.position[1],
          snapshot.position[2],
        );
        state.tempRotation.set(
          snapshot.rotation[0],
          snapshot.rotation[1],
          snapshot.rotation[2],
          snapshot.rotation[3],
        );
        this.applyInterpolated(
          entity,
          state.tempPosition,
          state.tempRotation,
          state,
          delta,
        );
      }
      return;
    }

    // Find two snapshots to interpolate between
    let older: EntitySnapshot | null = null;
    let newer: EntitySnapshot | null = null;

    for (let i = 0; i < state.snapshotCount - 1; i++) {
      const curr = this.getInterpolationSnapshotAt(state, i);
      const next = this.getInterpolationSnapshotAt(state, i + 1);

      if (curr.timestamp <= renderTime && next.timestamp >= renderTime) {
        older = curr;
        newer = next;
        break;
      }
    }

    if (older && newer) {
      const snapshotSpan = newer.timestamp - older.timestamp;
      const t =
        snapshotSpan > 0 ? (renderTime - older.timestamp) / snapshotSpan : 1;

      state.tempPosition.set(
        older.position[0] + (newer.position[0] - older.position[0]) * t,
        older.position[1] + (newer.position[1] - older.position[1]) * t,
        older.position[2] + (newer.position[2] - older.position[2]) * t,
      );

      state.tempRotation
        .set(
          older.rotation[0] + (newer.rotation[0] - older.rotation[0]) * t,
          older.rotation[1] + (newer.rotation[1] - older.rotation[1]) * t,
          older.rotation[2] + (newer.rotation[2] - older.rotation[2]) * t,
          older.rotation[3] + (newer.rotation[3] - older.rotation[3]) * t,
        )
        .normalize();

      this.applyInterpolated(
        entity,
        state.tempPosition,
        state.tempRotation,
        state,
        delta,
      );
    } else {
      // Use most recent snapshot
      const timeSinceUpdate = now - state.lastUpdate;
      if (timeSinceUpdate < this.extrapolationLimit) {
        const last =
          state.snapshots[this.getLatestInterpolationSnapshotIndex(state)];
        state.tempPosition.set(
          last.position[0],
          last.position[1],
          last.position[2],
        );
        state.tempRotation.set(
          last.rotation[0],
          last.rotation[1],
          last.rotation[2],
          last.rotation[3],
        );
        this.applyInterpolated(
          entity,
          state.tempPosition,
          state.tempRotation,
          state,
          delta,
        );
      }
    }
  }

  /**
   * Apply interpolated values to entity
   */
  private applyInterpolated(
    entity: Entity,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
    state: InterpolationState,
    delta: number,
  ): void {
    const smoothingRate = 5.0;
    const smoothingFactor = 1.0 - Math.exp(-smoothingRate * delta);

    state.currentPosition.lerp(position, smoothingFactor);
    state.currentRotation.slerp(rotation, smoothingFactor);

    if ("position" in entity) {
      const entityPos = entity.position as THREE.Vector3;
      entityPos.copy(state.currentPosition);
    }

    if (entity.node) {
      entity.node.position.copy(state.currentPosition);
      entity.node.quaternion.copy(state.currentRotation);
    }

    const player = entity as Entity & {
      base?: { position: THREE.Vector3; quaternion: THREE.Quaternion };
    };
    if (player.base) {
      player.base.position.copy(state.currentPosition);
      player.base.quaternion.copy(state.currentRotation);
    }
  }

  onEntityEvent = (event: {
    id: string;
    version: number;
    name: string;
    data?: unknown;
  }) => {
    const { id, version, name, data } = event;
    // If event is broadcast world event, re-emit on world so systems can react
    if (id === "world") {
      this.world.emit(name, data);
      return;
    }
    const entity = this.world.entities.get(id);
    if (!entity) return;
    // Trigger entity event if method exists
    entity.onEvent(version, name, data, this.id || "");
  };

  // Dedicated resource packet handlers
  onResourceSnapshot = (data: {
    resources: Array<{
      id: string;
      type: string;
      position: { x: number; y: number; z: number };
      isAvailable: boolean;
      respawnAt?: number;
    }>;
  }) => {
    for (const r of data.resources) {
      this.world.emit(EventType.RESOURCE_SPAWNED, {
        id: r.id,
        type: r.type,
        position: r.position,
      });
      if (!r.isAvailable)
        this.world.emit(EventType.RESOURCE_DEPLETED, {
          resourceId: r.id,
          position: r.position,
        });
    }
  };
  onResourceSpawnPoints = (data: {
    spawnPoints: Array<{
      id: string;
      type: string;
      position: { x: number; y: number; z: number };
    }>;
  }) => {
    this.world.emit(EventType.RESOURCE_SPAWN_POINTS_REGISTERED, data);
  };
  onResourceSpawned = (data: {
    id: string;
    type: string;
    position: { x: number; y: number; z: number };
  }) => {
    this.world.emit(EventType.RESOURCE_SPAWNED, data);
  };
  onResourceDepleted = (data: {
    resourceId: string;
    position?: { x: number; y: number; z: number };
    depleted?: boolean;
  }) => {
    // Update the ResourceEntity visual
    interface EntityWithNetworkUpdate {
      updateFromNetwork?: (data: Record<string, unknown>) => void;
    }
    const entity = this.world.entities.get(
      data.resourceId,
    ) as EntityWithNetworkUpdate | null;
    if (entity && typeof entity.updateFromNetwork === "function") {
      entity.updateFromNetwork({ depleted: true });
    }

    // Also emit the event for other systems
    this.world.emit(EventType.RESOURCE_DEPLETED, data);
  };

  onResourceRespawned = (data: {
    resourceId: string;
    position?: { x: number; y: number; z: number };
    depleted?: boolean;
  }) => {
    // Update the ResourceEntity visual
    const entity = this.world.entities.get(data.resourceId);
    interface EntityWithNetworkUpdate {
      updateFromNetwork?: (data: Record<string, unknown>) => void;
    }
    const entityWithUpdate = entity as EntityWithNetworkUpdate | null;
    if (
      entityWithUpdate &&
      typeof entityWithUpdate.updateFromNetwork === "function"
    ) {
      entityWithUpdate.updateFromNetwork({ depleted: false });
    }

    // Also emit the event for other systems
    this.world.emit(EventType.RESOURCE_RESPAWNED, data);
  };

  /**
   * Handle fire created packet from server
   * Creates the fire visual on the client
   */
  onFireCreated = (data: {
    fireId: string;
    playerId: string;
    position: { x: number; y: number; z: number };
    createdAt: number;
    expiresAt: number;
    serverObservedAt: number;
    requestId?: string;
  }) => {
    // Debug log removed — fires per fire spell during combat
    this.world.emit(EventType.FIRE_CREATED, data);
  };

  /**
   * Handle fire extinguished packet from server
   * Removes the fire visual on the client
   */
  onFireExtinguished = (data: { fireId: string }) => {
    // Debug log removed — fires per fire spell expiry
    this.world.emit(EventType.FIRE_EXTINGUISHED, data);
  };

  onFireLightingStarted = (data: {
    playerId: string;
    position: { x: number; y: number; z: number };
  }) => {
    this.world.emit(EventType.FIRE_LIGHTING_STARTED, data);
  };

  onFireLightingCancelled = (data: { playerId: string }) => {
    this.world.emit(EventType.FIRE_LIGHTING_CANCELLED, data);
  };

  private applyResourcePosition(
    entity: ResourceEntity,
    position: { x: number; y: number; z: number },
  ): void {
    if (![position.x, position.y, position.z].every(Number.isFinite)) return;
    this.deleteInterpolationState(entity.id);
    this.tileInterpolator.removeEntity(entity.id);
    // Do not mark the replicated entity network-dirty or retain packet objects.
    entity.position.set(position.x, position.y, position.z);
    entity.config.position = { ...position };
    entity.data.position = [position.x, position.y, position.z];
  }

  onFishingSpotMoved = (data: {
    resourceId: string;
    oldPosition: { x: number; y: number; z: number };
    newPosition: { x: number; y: number; z: number };
  }) => {
    // Update the fishing spot entity position
    const entity = this.world.entities.get(data.resourceId);
    if (entity?.type === "resource") {
      this.applyResourcePosition(entity as ResourceEntity, data.newPosition);
    }

    // Emit event for other systems that might need to react
    this.world.emit(EventType.RESOURCE_SPAWNED, {
      id: data.resourceId,
      type: "fishing_spot",
      position: data.newPosition,
    });
  };

  onInventoryUpdated = (data: {
    playerId: string;
    items: Array<{ slot: number; itemId: string; quantity: number }>;
    coins: number;
    maxSlots: number;
  }) => {
    // Server sent authoritative inventory — discard all pending rollbacks
    this.inventoryTracker.clear();

    const snapshot = {
      ...data,
      items: Array.isArray(data.items)
        ? data.items.map((item) => ({ ...item }))
        : [],
    };
    // Cache latest snapshot for late-mounting UI
    this.lastInventoryByPlayerId[data.playerId] = snapshot;
    // Re-emit with typed event so UI updates without waiting for local add
    this.world.emit(EventType.INVENTORY_UPDATED, snapshot);
  };

  onGroundItemDropResult = (
    data: EventMap[EventType.ITEM_DROP_RESULT],
  ): void => {
    this.world.emit(EventType.ITEM_DROP_RESULT, data);
  };

  onCoinsUpdated = (data: { playerId: string; coins: number }) => {
    // Update cached inventory coins
    if (this.lastInventoryByPlayerId[data.playerId]) {
      this.lastInventoryByPlayerId[data.playerId].coins = data.coins;
    }
    // Emit event for UI to update coin display
    this.world.emit(EventType.INVENTORY_UPDATE_COINS, {
      playerId: data.playerId,
      coins: data.coins,
    });
  };

  onPlayerWeightUpdated = (data: { playerId: string; weight: number }) => {
    // Update local player's weight for stamina drain calculation
    const localPlayer = this.world.getPlayer?.();
    if (
      localPlayer &&
      data.playerId === localPlayer.id &&
      localPlayer instanceof PlayerLocal
    ) {
      localPlayer.totalWeight = data.weight;
      // Emit event for UI components (e.g., EquipmentPanel) to update weight display
      this.world.emit(EventType.PLAYER_WEIGHT_CHANGED, {
        playerId: data.playerId,
        weight: data.weight,
      });
    }
  };

  onEquipmentUpdated = (data: {
    playerId: string;
    equipment: {
      weapon?: { item?: unknown; itemId?: string } | null;
      shield?: { item?: unknown; itemId?: string } | null;
      helmet?: { item?: unknown; itemId?: string } | null;
      body?: { item?: unknown; itemId?: string } | null;
      legs?: { item?: unknown; itemId?: string } | null;
      arrows?: { item?: unknown; itemId?: string } | null;
      [key: string]: { item?: unknown; itemId?: string } | null | undefined;
    };
  }) => {
    // Cache latest equipment for late-mounting UI
    this.lastEquipmentByPlayerId = this.lastEquipmentByPlayerId || {};
    this.lastEquipmentByPlayerId[data.playerId] = data.equipment;

    // CRITICAL: Update local player's equipment so systems can access it
    // Equipment format from server: { weapon: { item: Item, itemId: string }, ... }
    // Local player format: { weapon: Item | null, ... }
    const localPlayer = this.world.getPlayer?.();
    interface PlayerWithEquipment {
      equipment: {
        weapon: unknown;
        shield: unknown;
        helmet: unknown;
        body: unknown;
        legs: unknown;
        arrows: unknown;
      };
    }
    if (localPlayer && data.playerId === localPlayer.id) {
      const rawEq = data.equipment;
      if (rawEq && "equipment" in localPlayer) {
        const playerWithEquipment = localPlayer as PlayerWithEquipment;
        playerWithEquipment.equipment = {
          weapon: rawEq.weapon?.item || null,
          shield: rawEq.shield?.item || null,
          helmet: rawEq.helmet?.item || null,
          body: rawEq.body?.item || null,
          legs: rawEq.legs?.item || null,
          arrows: rawEq.arrows?.item || null,
        };
      }
    }

    // Re-emit as UI update event for the active client UI hooks to handle
    // Include playerId so UI can filter for local player only
    this.world.emit(EventType.UI_UPDATE, {
      component: "equipment",
      data: {
        playerId: data.playerId,
        equipment: data.equipment,
      },
    });

    // CRITICAL: Also emit PLAYER_EQUIPMENT_CHANGED for each slot
    // so EquipmentVisualSystem can attach/remove 3D models to the avatar
    if (data.equipment) {
      const equipment = data.equipment;
      // Use the server's canonical slots, including boots/gloves and accessories.
      // Omitting a slot prevents its real replicated equip AND clear events.
      for (const slot of EQUIPMENT_SLOT_NAMES) {
        const slotData = equipment[slot];
        // Emit for ALL slots, including null (to remove items on death)
        interface SlotDataWithItem {
          itemId?: string;
          item?: { id?: string };
        }
        const slotDataWithItem = slotData as SlotDataWithItem | undefined;
        const itemId =
          slotDataWithItem?.itemId || slotDataWithItem?.item?.id || null;
        this.world.emit(EventType.PLAYER_EQUIPMENT_CHANGED, {
          playerId: data.playerId,
          slot: slot,
          itemId: itemId,
        });
      }
    }
  };

  onSkillsUpdated = (data: {
    playerId: string;
    skills: Record<string, { level: number; xp: number }>;
  }) => {
    // Cache latest snapshot for late-mounting UI
    this.lastSkillsByPlayerId = this.lastSkillsByPlayerId || {};
    this.lastSkillsByPlayerId[data.playerId] = data.skills;
    // Re-emit with typed event so UI updates
    this.world.emit(EventType.SKILLS_UPDATED, data);
  };

  // --- Prayer state handlers ---

  /** Cache for prayer state by player ID */
  lastPrayerStateByPlayerId: Record<
    string,
    { points: number; maxPoints: number; active: string[] }
  > = {};

  onPrayerStateSync = (data: {
    playerId: string;
    points: number;
    maxPoints: number;
    active: string[];
  }) => {
    // Cache latest prayer state for late-mounting UI
    this.lastPrayerStateByPlayerId[data.playerId] = {
      points: data.points,
      maxPoints: data.maxPoints,
      active: data.active,
    };
    // Re-emit with typed event so UI updates
    this.world.emit(EventType.PRAYER_STATE_SYNC, data);
  };

  onPrayerToggled = (data: {
    playerId: string;
    prayerId: string;
    active: boolean;
    points: number;
  }) => {
    // Update cache if it exists
    const cached = this.lastPrayerStateByPlayerId[data.playerId];
    if (cached) {
      cached.points = data.points;
      if (data.active) {
        if (!cached.active.includes(data.prayerId)) {
          cached.active.push(data.prayerId);
        }
      } else {
        cached.active = cached.active.filter((id) => id !== data.prayerId);
      }
    }
    // Re-emit with typed event so UI updates
    this.world.emit(EventType.PRAYER_TOGGLED, data);
  };

  /**
   * Consume the correlated server receipt. Browser clients rely on the normal
   * Prayer events for UI, while agent transports use this packet to gate local
   * decisions. Keeping a handler here prevents append-only protocol warnings.
   */
  onPrayerActionReceipt = (data: {
    playerId: string;
    pointUnits: number;
    points: number;
    maxPoints: number;
    activePrayers: string[];
  }) => {
    if (!data?.playerId || !Array.isArray(data.activePrayers)) return;
    this.lastPrayerStateByPlayerId[data.playerId] = {
      points: data.points,
      maxPoints: data.maxPoints,
      active: [...data.activePrayers],
    };
  };

  onPrayerPointsChanged = (data: {
    playerId: string;
    points: number;
    maxPoints: number;
    reason?: string;
  }) => {
    // Update cache if it exists
    const cached = this.lastPrayerStateByPlayerId[data.playerId];
    if (cached) {
      cached.points = data.points;
      cached.maxPoints = data.maxPoints;
    }
    // Re-emit with typed event so UI updates
    this.world.emit(EventType.PRAYER_POINTS_CHANGED, data);
  };

  /**
   * Handle world time sync from server - keeps day/night cycle in sync across all clients
   */
  onWorldTimeSync = (data: { worldTime: number }) => {
    // Calculate offset between server's world time and our local world time
    this.worldTimeOffset = data.worldTime - this.world.getTime();
  };

  /**
   * Get the synced world time (adjusted for server offset)
   * Use this for day/night cycle instead of world.getTime()
   */
  getSyncedWorldTime(): number {
    return this.world.getTime() + this.worldTimeOffset;
  }

  // --- Bank state handler ---
  onBankState = (data: {
    playerId: string;
    bankId?: string;
    items: Array<{
      itemId: string;
      quantity: number;
      slot: number;
      tabIndex?: number;
    }>;
    tabs?: Array<{ tabIndex: number; iconItemId: string | null }>;
    alwaysSetPlaceholder?: boolean;
    maxSlots: number;
    isOpen?: boolean;
  }) => {
    // Emit as UI update for BankPanel to handle
    this.world.emit(EventType.UI_UPDATE, {
      playerId: data.playerId,
      component: "bank",
      data: {
        bankId: data.bankId,
        items: data.items,
        tabs: data.tabs,
        alwaysSetPlaceholder: data.alwaysSetPlaceholder,
        maxSlots: data.maxSlots,
        isOpen: data.isOpen ?? true,
      },
    });
  };

  // --- Bank close handler (server-authoritative) ---
  // Server sends this when player moves too far from bank
  onBankClose = (data: { reason: string; sessionType: string }) => {
    // Emit UI update to close the bank
    this.world.emit(EventType.UI_UPDATE, {
      component: "bank",
      data: {
        isOpen: false,
        reason: data.reason,
      },
    });
  };

  // --- Store state handler ---
  onStoreState = (data: {
    storeId: string;
    storeName: string;
    buybackRate: number;
    items: Array<{
      id: string;
      itemId: string;
      name: string;
      price: number;
      stockQuantity: number;
      description?: string;
      category?: string;
    }>;
    isOpen: boolean;
    npcEntityId?: string;
  }) => {
    // Emit as UI update for StorePanel to handle
    this.world.emit(EventType.UI_UPDATE, {
      component: "store",
      data: {
        storeId: data.storeId,
        storeName: data.storeName,
        buybackRate: data.buybackRate,
        items: data.items,
        isOpen: data.isOpen,
        npcEntityId: data.npcEntityId,
      },
    });
  };

  // --- Store close handler (server-authoritative) ---
  // Server sends this when player moves too far from shopkeeper
  onStoreClose = (data: { reason: string; sessionType: string }) => {
    // Emit UI update to close the store
    this.world.emit(EventType.UI_UPDATE, {
      component: "store",
      data: {
        isOpen: false,
        reason: data.reason,
      },
    });
  };

  // --- Smelting/Smithing interface handlers ---
  onCookingComplete = (data: {
    rawItemId: string;
    resultItemId: string;
    wasBurnt: boolean;
    xpGained: number;
    requestId?: string;
  }) => {
    this.world.emit(EventType.COOKING_COMPLETE, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  onSmeltingInterfaceOpen = (data: {
    furnaceId: string;
    availableBars: Array<{
      barItemId: string;
      levelRequired: number;
      primaryOre: string;
      secondaryOre: string | null;
      coalRequired: number;
    }>;
  }) => {
    // Emit as UI update for SmeltingPanel to handle
    this.world.emit(EventType.UI_UPDATE, {
      component: "smelting",
      data: {
        isOpen: true,
        furnaceId: data.furnaceId,
        availableBars: data.availableBars,
      },
    });
  };

  onSmeltingComplete = (data: {
    barItemId: string;
    totalSmelted: number;
    totalFailed: number;
    totalXp: number;
    requestId?: string;
  }) => {
    this.world.emit(EventType.SMELTING_COMPLETE, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  onSmithingInterfaceOpen = (data: {
    anvilId: string;
    availableRecipes: Array<{
      itemId: string;
      name: string;
      barType: string;
      barsRequired: number;
      levelRequired: number;
      xp: number;
      category: string;
    }>;
  }) => {
    // Emit as UI update for SmithingPanel to handle
    this.world.emit(EventType.UI_UPDATE, {
      component: "smithing",
      data: {
        isOpen: true,
        anvilId: data.anvilId,
        availableRecipes: data.availableRecipes,
      },
    });
  };

  onSmithingComplete = (data: {
    recipeId: string;
    outputItemId: string;
    totalSmithed: number;
    totalXp: number;
    requestId?: string;
  }) => {
    this.world.emit(EventType.SMITHING_COMPLETE, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  // --- Crafting interface handler ---
  onCraftingInterfaceOpen = (data: {
    availableRecipes: Array<{
      output: string;
      name: string;
      category: string;
      inputs: Array<{ item: string; amount: number }>;
      tools: string[];
      level: number;
      xp: number;
      meetsLevel: boolean;
      hasInputs: boolean;
    }>;
    station: string;
  }) => {
    this.world.emit(EventType.UI_UPDATE, {
      component: "crafting",
      data: {
        isOpen: true,
        availableRecipes: data.availableRecipes,
        station: data.station,
      },
    });
  };

  onCraftingClose = (_data: { reason?: string }) => {
    this.world.emit(EventType.UI_UPDATE, {
      component: "craftingClose",
      data: _data,
    });
  };

  onCraftingComplete = (data: {
    recipeId: string;
    outputItemId: string;
    totalCrafted: number;
    totalXp: number;
    requestId?: string;
  }) => {
    this.world.emit(EventType.CRAFTING_COMPLETE, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  // --- Fletching interface handler ---
  onFletchingInterfaceOpen = (
    data: Omit<FletchingInterfaceOpenPayload, "playerId">,
  ) => {
    this.world.emit(EventType.FLETCHING_INTERFACE_OPEN, {
      playerId: this.world?.entities?.player?.id || "",
      availableRecipes: data.availableRecipes,
    });
  };

  onFletchingComplete = (data: {
    recipeId: string;
    outputItemId: string;
    totalCrafted: number;
    totalXp: number;
    requestId?: string;
  }) => {
    this.world.emit(EventType.FLETCHING_COMPLETE, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  onFletchingClose = (_data: { reason?: string }) => {
    this.world.emit(EventType.UI_UPDATE, {
      component: "fletchingClose",
      data: _data,
    });
  };

  // --- Tanning interface handler ---
  onTanningInterfaceOpen = (data: {
    availableRecipes: Array<{
      input: string;
      output: string;
      cost: number;
      name: string;
      hasHide: boolean;
      hideCount: number;
    }>;
  }) => {
    this.world.emit(EventType.UI_UPDATE, {
      component: "tanning",
      data: {
        isOpen: true,
        availableRecipes: data.availableRecipes,
      },
    });
  };

  onTanningClose = (_data: { reason?: string }) => {
    this.world.emit(EventType.UI_UPDATE, {
      component: "tanningClose",
      data: _data,
    });
  };

  onTanningComplete = (data: {
    inputItemId: string;
    outputItemId: string;
    totalTanned: number;
    totalCost: number;
    requestId?: string;
  }) => {
    this.world.emit(EventType.TANNING_COMPLETE, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  onRunecraftingComplete = (data: {
    runeType: string;
    runeItemId: string;
    essenceConsumed: number;
    runesProduced: number;
    multiplier: number;
    xpAwarded: number;
    requestId?: string;
  }) => {
    this.world.emit(EventType.RUNECRAFTING_COMPLETE, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  onProcessingRejected = (data: {
    requestId: string;
    skill:
      | "firemaking"
      | "cooking"
      | "smelting"
      | "smithing"
      | "crafting"
      | "fletching"
      | "runecrafting"
      | "tanning";
    reason:
      | "busy"
      | "invalid_request"
      | "not_authorized"
      | "requirements_not_met"
      | "resources_unavailable"
      | "capacity_unavailable"
      | "interrupted"
      | "persistence_rejected";
    retryable: boolean;
  }) => {
    this.world.emit(EventType.PROCESSING_REQUEST_REJECTED, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  onProcessingProgress = (data: {
    requestId: string;
    skill:
      | "firemaking"
      | "cooking"
      | "smelting"
      | "smithing"
      | "crafting"
      | "fletching"
      | "runecrafting"
      | "tanning";
    phase: "accepted" | "working" | "reconciling" | "committed";
  }) => {
    this.world.emit(EventType.PROCESSING_REQUEST_PROGRESS, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  onProcessingRequestStatus = (data: {
    requestId: string;
    queryId: string;
    skill:
      | "firemaking"
      | "cooking"
      | "smelting"
      | "smithing"
      | "crafting"
      | "fletching"
      | "runecrafting"
      | "tanning";
    status: "committed" | "not_found" | "unavailable";
  }) => {
    this.world.emit(EventType.PROCESSING_REQUEST_STATUS, {
      playerId: this.world?.entities?.player?.id || "",
      ...data,
    });
  };

  // --- Dialogue handlers ---
  onDialogueStart = (data: {
    npcId: string;
    npcName: string;
    nodeId: string;
    text: string;
    responses: Array<{ text: string; nextNodeId: string; effect?: string }>;
    npcEntityId?: string;
  }) => {
    // Emit as UI update for DialoguePanel to handle
    this.world.emit(EventType.UI_UPDATE, {
      component: "dialogue",
      data: {
        npcId: data.npcId,
        npcName: data.npcName,
        text: data.text,
        responses: data.responses,
        npcEntityId: data.npcEntityId,
      },
    });
  };

  onDialogueNodeChange = (data: {
    npcId: string;
    nodeId: string;
    text: string;
    responses: Array<{ text: string; nextNodeId: string; effect?: string }>;
  }) => {
    // Emit as UI update for DialoguePanel to handle - preserve npcName from previous state
    this.world.emit(EventType.UI_UPDATE, {
      component: "dialogue",
      data: {
        npcId: data.npcId,
        npcName: "", // Will be preserved by UI from existing state
        text: data.text,
        responses: data.responses,
      },
    });
  };

  onDialogueEnd = (data: { npcId: string }) => {
    // Emit UI update to close dialogue panel
    this.world.emit(EventType.UI_UPDATE, {
      component: "dialogueEnd",
      data: { npcId: data.npcId },
    });
  };

  // --- Dialogue close handler (server-authoritative) ---
  // Server sends this when player moves too far from NPC during dialogue
  onDialogueClose = (data: { reason: string; sessionType: string }) => {
    // Emit UI update to close the dialogue
    this.world.emit(EventType.UI_UPDATE, {
      component: "dialogueEnd",
      data: {
        reason: data.reason,
        serverClose: true,
      },
    });
  };

  // --- Character selection (flag-gated by server) ---
  onCharacterList = (data: {
    characters: Array<{
      id: string;
      name: string;
      level?: number;
      lastLocation?: { x: number; y: number; z: number };
    }>;
  }) => {
    // Cache and re-emit so UI can show the modal
    this.lastCharacterList = data.characters || [];
    this.world.emit(EventType.CHARACTER_LIST, data);
    // Auto-select previously chosen character if available
    // NOTE: Use sessionStorage (per-tab) to prevent cross-tab character conflicts
    const storedId =
      typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem("selectedCharacterId")
        : null;
    if (
      storedId &&
      Array.isArray(data.characters) &&
      data.characters.some((c) => c.id === storedId)
    ) {
      this.requestCharacterSelect(storedId);
    }
  };
  onCharacterCreated = (data: { id: string; name: string }) => {
    // Re-emit for UI to update lists
    this.world.emit(EventType.CHARACTER_CREATED, data);
  };
  onCharacterSelected = (data: { characterId: string | null }) => {
    this.world.emit(EventType.CHARACTER_SELECTED, data);
  };

  // --- Quest system handlers ---
  onQuestList = (data: {
    quests: Array<{
      id: string;
      name: string;
      status: string;
      difficulty: string;
      questPoints: number;
    }>;
    questPoints: number;
  }) => {
    // Emit for QuestJournal to update
    this.emit("questList", data);
  };

  onQuestDetail = (data: {
    id: string;
    name: string;
    description: string;
    status: string;
    difficulty: string;
    questPoints: number;
    currentStage: string;
    stageProgress: Record<string, number>;
    stages: Array<{
      id: string;
      description: string;
      type: string;
      target?: string;
      count?: number;
    }>;
  }) => {
    // Emit for QuestJournal to update
    this.emit("questDetail", data);
  };

  onQuestStartConfirm = (data: {
    questId: string;
    questName: string;
    description: string;
    difficulty: string;
    requirements: {
      quests: string[];
      skills: Record<string, number>;
      items: string[];
    };
    rewards: {
      questPoints: number;
      items: Array<{ itemId: string; quantity: number }>;
      xp: Record<string, number>;
    };
  }) => {
    // Emit QUEST_START_CONFIRM event for the active client UI to show QuestStartScreen
    // Add playerId since server doesn't send it (packet is already routed to this player)
    const playerId = this.world?.entities?.player?.id || "";
    this.world.emit(EventType.QUEST_START_CONFIRM, { ...data, playerId });
  };

  onQuestStarted = (data: { questId: string; questName: string }) => {
    const playerId = this.world?.entities?.player?.id || "";
    this.world.emit(EventType.QUEST_STARTED, { ...data, playerId });
  };

  onQuestProgressed = (data: {
    questId: string;
    stage: string;
    progress: Record<string, number>;
    description: string;
  }) => {
    // Emit QUEST_PROGRESSED event for QuestJournal to update
    const playerId = this.world?.entities?.player?.id || "";
    this.world.emit(EventType.QUEST_PROGRESSED, { ...data, playerId });
  };

  onQuestCompleted = (data: {
    questId: string;
    questName: string;
    rewards: {
      questPoints: number;
      items: Array<{ itemId: string; quantity: number }>;
      xp: Record<string, number>;
    };
  }) => {
    // Emit QUEST_COMPLETED event for the active client UI to show completion screen
    const playerId = this.world?.entities?.player?.id || "";
    this.world.emit(EventType.QUEST_COMPLETED, { ...data, playerId });
  };

  // --- Trade packet handlers ---

  /**
   * Incoming trade request from another player
   */
  onTradeIncoming = (data: {
    tradeId: string;
    fromPlayerId: string;
    fromPlayerName: string;
    fromPlayerLevel: number;
  }) => {
    this.world.emit(EventType.TRADE_REQUEST_RECEIVED, data);
    // Also emit as UI update for modal handling
    this.world.emit(EventType.UI_UPDATE, {
      component: "tradeRequest",
      data: {
        visible: true,
        tradeId: data.tradeId,
        fromPlayer: {
          id: data.fromPlayerId,
          name: data.fromPlayerName,
          level: data.fromPlayerLevel,
        },
      },
    });
  };

  /**
   * Trade session started (both players accepted)
   */
  onTradeStarted = (data: {
    tradeId: string;
    partnerId: string;
    partnerName: string;
    partnerLevel: number;
  }) => {
    this.world.emit(EventType.TRADE_STARTED, data);
    // Emit UI update to open trade panel
    this.world.emit(EventType.UI_UPDATE, {
      component: "trade",
      data: {
        isOpen: true,
        tradeId: data.tradeId,
        partner: {
          id: data.partnerId,
          name: data.partnerName,
          level: data.partnerLevel,
        },
        myOffer: [],
        myAccepted: false,
        theirOffer: [],
        theirAccepted: false,
      },
    });
  };

  /**
   * Trade state updated (items changed, acceptance changed)
   */
  onTradeUpdated = (data: {
    tradeId: string;
    myOffer: {
      items: Array<{
        inventorySlot: number;
        itemId: string;
        quantity: number;
        tradeSlot: number;
      }>;
      accepted: boolean;
    };
    theirOffer: {
      items: Array<{
        inventorySlot: number;
        itemId: string;
        quantity: number;
        tradeSlot: number;
      }>;
      accepted: boolean;
    };
  }) => {
    this.world.emit(EventType.TRADE_UPDATED, data);
    // Emit UI update
    this.world.emit(EventType.UI_UPDATE, {
      component: "tradeUpdate",
      data: {
        tradeId: data.tradeId,
        myOffer: data.myOffer.items,
        myAccepted: data.myOffer.accepted,
        theirOffer: data.theirOffer.items,
        theirAccepted: data.theirOffer.accepted,
      },
    });
  };

  /**
   * Trade completed successfully
   */
  onTradeCompleted = (data: {
    tradeId: string;
    receivedItems: Array<{ itemId: string; quantity: number }>;
  }) => {
    this.world.emit(EventType.TRADE_COMPLETED, data);
    // Close trade panel
    this.world.emit(EventType.UI_UPDATE, {
      component: "tradeClose",
      data: { tradeId: data.tradeId, reason: "completed" },
    });
  };

  /**
   * Trade cancelled
   */
  onTradeCancelled = (data: {
    tradeId: string;
    reason: string;
    message: string;
  }) => {
    this.world.emit(EventType.TRADE_CANCELLED, data);
    // Close trade panel and request modal
    this.world.emit(EventType.UI_UPDATE, {
      component: "tradeClose",
      data: {
        tradeId: data.tradeId,
        reason: data.reason,
        message: data.message,
      },
    });
  };

  /**
   * Trade operation error
   */
  onTradeError = (data: { message: string; code: string }) => {
    this.world.emit(EventType.TRADE_ERROR, data);
    // Show toast with error message
    this.world.emit(EventType.UI_TOAST, {
      message: data.message,
      type: "error",
    });
  };

  // --- Duel Arena packet handlers ---

  /**
   * Duel challenge sent confirmation
   */
  onDuelChallengeSent = (data: {
    challengeId: string;
    targetPlayerId: string;
    targetPlayerName: string;
  }) => {
    console.log("[ClientNetwork] Duel challenge sent:", data);
    this.world.emit(EventType.UI_TOAST, {
      message: `Challenge sent to ${data.targetPlayerName}`,
      type: "info",
    });
  };

  /**
   * Incoming duel challenge from another player
   */
  onDuelChallengeIncoming = (data: {
    challengeId: string;
    fromPlayerId: string;
    fromPlayerName: string;
    fromPlayerLevel: number;
  }) => {
    console.log("[ClientNetwork] Duel challenge incoming:", data);
    // Emit UI update for potential modal handling
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelChallenge",
      data: {
        visible: true,
        challengeId: data.challengeId,
        fromPlayer: {
          id: data.fromPlayerId,
          name: data.fromPlayerName,
          level: data.fromPlayerLevel,
        },
      },
    });
  };

  /**
   * Duel session started (both players accepted challenge)
   */
  onDuelSessionStarted = (data: {
    duelId: string;
    opponentId: string;
    opponentName: string;
    isChallenger: boolean;
  }) => {
    // Debug log removed — fires on every duel start
    // Emit UI update to open duel panel
    this.world.emit(EventType.UI_UPDATE, {
      component: "duel",
      data: {
        isOpen: true,
        duelId: data.duelId,
        opponent: {
          id: data.opponentId,
          name: data.opponentName,
        },
        isChallenger: data.isChallenger,
      },
    });
  };

  /**
   * Duel challenge was declined
   */
  onDuelChallengeDeclined = (data: {
    challengeId: string;
    declinedBy?: string;
  }) => {
    console.log("[ClientNetwork] Duel challenge declined:", data);
    if (data.declinedBy) {
      this.world.emit(EventType.UI_TOAST, {
        message: `${data.declinedBy} declined your duel challenge.`,
        type: "info",
      });
    }
    // Close any duel challenge modal
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelChallenge",
      data: { visible: false },
    });
  };

  /**
   * Duel operation error
   */
  onDuelError = (data: { message: string; code: string }) => {
    console.log("[ClientNetwork] Duel error:", data);
    this.world.emit(EventType.UI_TOAST, {
      message: data.message,
      type: "error",
    });
  };

  /**
   * Duel rules updated (rule toggled)
   */
  onDuelRulesUpdated = (data: {
    duelId: string;
    rules: Record<string, boolean>;
    challengerAccepted: boolean;
    targetAccepted: boolean;
    modifiedBy: string;
  }) => {
    console.log("[ClientNetwork] Duel rules updated:", data);
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelRulesUpdate",
      data,
    });
  };

  /**
   * Duel equipment restrictions updated
   */
  onDuelEquipmentUpdated = (data: {
    duelId: string;
    equipmentRestrictions: Record<string, boolean>;
    challengerAccepted: boolean;
    targetAccepted: boolean;
    modifiedBy: string;
  }) => {
    console.log("[ClientNetwork] Duel equipment updated:", data);
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelEquipmentUpdate",
      data,
    });
  };

  /**
   * Duel acceptance state updated
   */
  onDuelAcceptanceUpdated = (data: {
    duelId: string;
    challengerAccepted: boolean;
    targetAccepted: boolean;
    state: string;
    movedToStakes: boolean;
  }) => {
    console.log("[ClientNetwork] Duel acceptance updated:", data);
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelAcceptanceUpdate",
      data,
    });
  };

  /**
   * Duel stakes updated (add/remove stake)
   */
  onDuelStakesUpdated = (data: {
    duelId: string;
    challengerStakes: Array<{
      inventorySlot: number;
      itemId: string;
      quantity: number;
      value: number;
    }>;
    targetStakes: Array<{
      inventorySlot: number;
      itemId: string;
      quantity: number;
      value: number;
    }>;
    challengerAccepted: boolean;
    targetAccepted: boolean;
    modifiedBy: string;
  }) => {
    console.log("[ClientNetwork] Duel stakes updated:", data);
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelStakesUpdate",
      data,
    });
  };

  /**
   * Duel state/phase changed
   */
  onDuelStateChanged = (data: {
    duelId: string;
    state: string;
    rules?: Record<string, boolean>;
    equipmentRestrictions?: Record<string, boolean>;
  }) => {
    // Debug log removed — fires on every duel state transition
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelStateChange",
      data,
    });
  };

  /**
   * Duel cancelled
   */
  onDuelCancelled = (data: {
    duelId: string;
    reason: string;
    cancelledBy?: string;
  }) => {
    console.log("[ClientNetwork] Duel cancelled:", data);
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelClose",
      data,
    });
    if (data.cancelledBy) {
      this.world.emit(EventType.UI_TOAST, {
        message: "Duel has been cancelled.",
        type: "info",
      });
    }
  };

  /**
   * Duel countdown start (3-2-1-FIGHT!)
   */
  onDuelCountdownStart = (data: {
    duelId: string;
    countdownSeconds: number;
    challengerPosition: { x: number; y: number; z: number };
    targetPosition: { x: number; y: number; z: number };
  }) => {
    // Debug log removed — fires on every duel countdown start
    // Close the duel panel
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelClose",
      data: { duelId: data.duelId },
    });
    // Emit countdown event for UI overlay
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelCountdown",
      data,
    });
  };

  /**
   * Duel countdown tick (3, 2, 1, 0)
   */
  onDuelCountdownTick = (data: {
    duelId: string;
    count: number;
    challengerId: string;
    targetId: string;
  }) => {
    // Debug log removed — fires on every countdown tick with object serialization
    // Update UI overlay (fullscreen countdown)
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelCountdownTick",
      data,
    });
    // Emit for 3D countdown splat system (numbers over players' heads)
    this.world.emit(EventType.DUEL_COUNTDOWN_TICK, data);
  };

  /**
   * Duel fight begins (countdown finished)
   */
  onDuelFightBegin = (data: {
    duelId: string;
    challengerId: string;
    targetId: string;
  }) => {
    // Debug log removed — fires on duel fight begin
    this.world.emit(EventType.UI_UPDATE, {
      component: "duelFightBegin",
      data,
    });
  };

  /**
   * Duel fight start with arena ID and bounds
   */
  onDuelFightStart = (data: {
    duelId: string;
    arenaId: number;
    opponentId?: string;
    bounds?: {
      min: { x: number; y: number; z: number };
      max: { x: number; y: number; z: number };
    };
  }) => {
    // Debug log removed — fires on duel fight start

    // Store active duel state on world so systems can access it
    // This allows PlayerInteractionHandler to show Attack option during duels
    // Bounds are used for client-side movement restriction feedback
    (
      this.world as {
        activeDuel?: {
          duelId: string;
          arenaId: number;
          opponentId?: string;
          bounds?: {
            min: { x: number; y: number; z: number };
            max: { x: number; y: number; z: number };
          };
        };
      }
    ).activeDuel = {
      duelId: data.duelId,
      arenaId: data.arenaId,
      opponentId: data.opponentId,
      bounds: data.bounds,
    };

    this.world.emit(EventType.UI_UPDATE, {
      component: "duelFightStart",
      data,
    });
  };

  /**
   * Duel ended (winner declared)
   */
  onDuelEnded = (data: {
    duelId: string;
    winnerId: string;
    loserId: string;
    reason: string;
    rewards?: Array<{ itemId: string; quantity: number }>;
  }) => {
    // Debug log removed — fires at end of every duel

    // Clear active duel state from world
    (
      this.world as {
        activeDuel?: { duelId: string; arenaId: number; opponentId?: string };
      }
    ).activeDuel = undefined;

    this.world.emit(EventType.UI_UPDATE, {
      component: "duelEnded",
      data,
    });
  };

  /**
   * Duel completed with full results (stakes transferred)
   */
  onDuelCompleted = (data: {
    duelId: string;
    winner: boolean;
    opponentName: string;
    itemsReceived: Array<{ itemId: string; quantity: number }>;
    itemsLost: Array<{ itemId: string; quantity: number }>;
  }) => {
    // Debug log removed — fires at end of every duel

    // Clear active duel state from world
    (
      this.world as {
        activeDuel?: { duelId: string; arenaId: number; opponentId?: string };
      }
    ).activeDuel = undefined;

    this.world.emit(EventType.UI_UPDATE, {
      component: "duelCompleted",
      data,
    });
  };

  // --- Social/Friend system handlers ---

  /**
   * Full friends list sync from server
   */
  onFriendsListSync = (data: FriendsListSyncData): void => {
    // Get SocialSystem and update state
    const socialSystem = this.world.getSystem("social") as {
      handleSync?: (syncData: FriendsListSyncData) => void;
    } | null;
    if (socialSystem?.handleSync) {
      socialSystem.handleSync(data);
    }
  };

  /**
   * Friend status update (online/offline/location change)
   */
  onFriendStatusUpdate = (data: FriendStatusUpdateData): void => {
    const socialSystem = this.world.getSystem("social") as {
      handleStatusUpdate?: (updateData: FriendStatusUpdateData) => void;
    } | null;
    if (socialSystem?.handleStatusUpdate) {
      socialSystem.handleStatusUpdate(data);
    }
  };

  /**
   * Incoming friend request
   */
  onFriendRequestIncoming = (data: FriendRequest): void => {
    const socialSystem = this.world.getSystem("social") as {
      addIncomingRequest?: (requestData: FriendRequest) => void;
    } | null;

    if (socialSystem?.addIncomingRequest) {
      socialSystem.addIncomingRequest(data);
    }

    // Show notification toast
    this.world.emit(EventType.UI_TOAST, {
      message: `${data.fromName} wants to be your friend!`,
      type: "info",
    });
  };

  /**
   * Private message received
   */
  onPrivateMessageReceived = (data: {
    fromId: string;
    fromName: string;
    toId: string;
    toName: string;
    content: string;
    timestamp: number;
  }) => {
    // Emit for chat system to display
    this.world.emit(EventType.CHAT_MESSAGE, {
      id: `pm-${data.timestamp}`,
      from: data.fromName,
      fromId: data.fromId,
      body: data.content,
      text: data.content,
      timestamp: data.timestamp,
      createdAt: new Date(data.timestamp).toISOString(),
      type: "private",
      isPrivate: true,
    });
  };

  /**
   * Private message failed to send
   */
  onPrivateMessageFailed = (data: {
    reason:
      | "offline"
      | "ignored"
      | "not_friends"
      | "player_not_found"
      | "rate_limited";
    targetName: string;
  }) => {
    const reasonMessages: Record<typeof data.reason, string> = {
      offline: `${data.targetName} is offline.`,
      ignored: `${data.targetName} is not accepting messages from you.`,
      not_friends: `You must be friends with ${data.targetName} to message them.`,
      player_not_found: `Player "${data.targetName}" not found.`,
      rate_limited: "You are sending messages too quickly.",
    };
    this.world.emit(EventType.UI_TOAST, {
      message: reasonMessages[data.reason],
      type: "error",
    });
  };

  /**
   * Social operation error
   */
  onSocialError = (data: { code: string; message: string }) => {
    this.world.emit(EventType.UI_TOAST, {
      message: data.message,
      type: "error",
    });
  };

  // --- Test/Debug packet handlers (visual only, no state changes) ---

  /**
   * Test level up popup (visual only)
   * Used by /testlevelup command - does NOT modify actual skill levels
   */
  onTestLevelUp = (data: {
    skill: string;
    oldLevel: number;
    newLevel: number;
  }) => {
    // Only emit UI event - no state modification
    this.world.emit(EventType.SKILLS_LEVEL_UP, {
      skill: data.skill,
      oldLevel: data.oldLevel,
      newLevel: data.newLevel,
      timestamp: Date.now(),
    });
  };

  /**
   * Test XP drop animation (visual only)
   * Used by /testxp command - does NOT modify actual XP
   */
  onTestXpDrop = (data: { skill: string; amount: number }) => {
    // Only emit UI event - no state modification
    this.world.emit(EventType.XP_DROP_RECEIVED, {
      skill: data.skill,
      xpGained: data.amount,
      newXp: data.amount,
      newLevel: 50, // Mock level for visual
      position: { x: 0, y: 0, z: 0 },
    });
  };

  /**
   * Test death screen (visual only)
   * Used by /testdeath command - does NOT actually kill the player
   */
  onTestDeathScreen = (data: { cause?: string }) => {
    // Only emit UI event - no state modification
    const playerId = this.world?.entities?.player?.id || "";
    this.world.emit(EventType.UI_DEATH_SCREEN, {
      playerId,
      deathLocation: { x: 0, y: 0, z: 0 },
      cause: data.cause || "Test death screen",
    });
  };

  // Friend convenience methods
  sendFriendRequest(targetName: string) {
    this.send("friendRequest", { targetName });
  }

  acceptFriendRequest(requestId: string) {
    this.send("friendAccept", { requestId });
  }

  declineFriendRequest(requestId: string) {
    this.send("friendDecline", { requestId });
  }

  removeFriend(friendId: string) {
    this.send("friendRemove", { friendId });
  }

  addToIgnoreList(targetName: string) {
    this.send("ignoreAdd", { targetName });
  }

  removeFromIgnoreList(ignoredId: string) {
    this.send("ignoreRemove", { ignoredId });
  }

  sendPrivateMessage(targetName: string, content: string) {
    this.send("privateMessage", { targetName, content });
  }

  /**
   * Trade moved to confirmation screen (classic MMORPG two-screen flow)
   */
  onTradeConfirmScreen = (data: {
    tradeId: string;
    myOffer: Array<{
      inventorySlot: number;
      itemId: string;
      quantity: number;
      tradeSlot: number;
    }>;
    theirOffer: Array<{
      inventorySlot: number;
      itemId: string;
      quantity: number;
      tradeSlot: number;
    }>;
    myOfferValue: number;
    theirOfferValue: number;
  }) => {
    this.world.emit(EventType.TRADE_CONFIRM_SCREEN, data);
    // Emit UI update to switch to confirmation screen
    this.world.emit(EventType.UI_UPDATE, {
      component: "tradeConfirm",
      data: {
        tradeId: data.tradeId,
        screen: "confirm",
        myOffer: data.myOffer,
        theirOffer: data.theirOffer,
        myOfferValue: data.myOfferValue,
        theirOfferValue: data.theirOfferValue,
        // Reset acceptance state for confirmation screen
        myAccepted: false,
        theirAccepted: false,
      },
    });
  };

  // Trade convenience methods
  requestTrade(targetPlayerId: string) {
    this.send("tradeRequest", { targetPlayerId });
  }

  respondToTradeRequest(tradeId: string, accept: boolean) {
    this.send("tradeRequestRespond", { tradeId, accept });
  }

  addItemToTrade(tradeId: string, inventorySlot: number, quantity?: number) {
    this.send("tradeAddItem", { tradeId, inventorySlot, quantity });
  }

  removeItemFromTrade(tradeId: string, tradeSlot: number) {
    this.send("tradeRemoveItem", { tradeId, tradeSlot });
  }

  acceptTrade(tradeId: string) {
    this.send("tradeAccept", { tradeId });
  }

  cancelTradeAccept(tradeId: string) {
    this.send("tradeCancelAccept", { tradeId });
  }

  cancelTrade(tradeId: string) {
    this.send("tradeCancel", { tradeId });
  }

  // Convenience methods
  requestCharacterCreate(name: string) {
    this.send("characterCreate", { name });
  }
  requestCharacterSelect(characterId: string) {
    this.send("characterSelected", { characterId });
  }
  requestEnterWorld() {
    this.send("enterWorld", {});
  }

  // Inventory actions
  dropItem(itemId: string, slot?: number, quantity?: number): string {
    const operationId = generateGroundItemDropOperationId();
    this.send("dropItem", { itemId, slot, quantity, operationId });
    return operationId;
  }

  // Prayer actions
  togglePrayer(prayerId: string) {
    this.send("prayerToggle", { prayerId, timestamp: Date.now() });
  }

  deactivateAllPrayers() {
    this.send("prayerDeactivateAll", { timestamp: Date.now() });
  }

  prayAtAltar(altarId: string) {
    this.send("altarPray", { altarId, timestamp: Date.now() });
  }

  // Magic autocast actions
  setAutocast(spellId: string | null) {
    this.send("setAutocast", { spellId, timestamp: Date.now() });
  }

  onEntityRemoved = (id: string) => {
    this.streamingFilteredEntityIds.delete(id);
    this.processingFaceTargets.delete(id);
    // An entity can disappear before the explicit combat-clear packet during a
    // death/disconnect. Drop both its own target and any references to it so a
    // stale facing mode cannot survive entity removal.
    this.combatFaceTargets.delete(id);
    this.streamingDuelCombatFaceTargets.delete(id);
    this.streamingDuelContestantIds.delete(id);
    for (const [playerId, targetId] of this.streamingDuelCombatFaceTargets) {
      if (targetId !== id) continue;
      this.streamingDuelCombatFaceTargets.delete(playerId);
      this.streamingDuelContestantIds.delete(playerId);
      this.combatFaceTargets.delete(playerId);
      this.tileInterpolator.clearCombatRotation(playerId);
    }
    for (const [playerId, targetId] of this.combatFaceTargets) {
      if (targetId !== id) continue;
      this.combatFaceTargets.delete(playerId);
      this.streamingDuelCombatFaceTargets.delete(playerId);
      this.tileInterpolator.clearCombatRotation(playerId);
    }
    // Remove from interpolation tracking
    this.deleteInterpolationState(id);
    // Remove from tile interpolation tracking (classic fantasy MMORPG-style movement)
    this.tileInterpolator.removeEntity(id);
    // Clean up pending modifications tracking - decrement count first
    this.clearPendingModifications(id);
    // Clean up dead players tracking
    this.deadPlayers.delete(id);
    // Remove from entities system
    this.world.entities.remove(id);
  };

  /**
   * Update interpolation in lateUpdate (after entity updates)
   */
  lateUpdate(delta: number): void {
    this.updateInterpolation(delta);

    // Recompute against current remote positions every frame. This keeps a
    // strafing/kiting fighter visually locked to a moving opponent instead of
    // preserving the direction from the first attack packet.
    this.refreshCombatFaceRotations();
    this.refreshProcessingFaceRotations();

    // Get terrain system for height lookups
    const terrain = this.world.getSystem("terrain") as {
      getHeightAt?: (x: number, z: number) => number | null;
    } | null;

    // Get building collision service for building proximity and step height checks
    const townSystem = this.world.getSystem("towns") as {
      getCollisionService?: () => {
        isNearBuildingForElevation: (x: number, z: number) => boolean;
        getStepHeightAtWorld: (x: number, z: number) => number | null;
      };
    } | null;
    const collisionService = townSystem?.getCollisionService?.();

    // Update tile-based interpolation (classic fantasy MMORPG-style)
    this.tileInterpolator.update(
      delta,
      (id: string) => {
        const entity = this.world.entities.get(id);
        if (!entity) return undefined;
        // Cast to access base (players have VRM on base, rotation should be set there)
        const entityWithBase = entity as typeof entity & {
          base?: THREE.Object3D;
        };
        return {
          position: entity.position as THREE.Vector3,
          node: entity.node as THREE.Object3D | undefined,
          base: entityWithBase.base,
          data: entity.data as Record<string, unknown>,
          // modify() triggers PlayerLocal's emote handling (avatar animation updates)
          modify: (data: Record<string, unknown>) => entity.modify(data),
        };
      },
      // Pass terrain height function for smooth Y updates.
      // getHeightAt() is bridge-aware (returns deck height on bridge tiles),
      // so no per-caller bridge check is needed.
      terrain?.getHeightAt
        ? (x: number, z: number) => terrain.getHeightAt!(x, z)
        : undefined,
      // Callback when entity finishes moving - emit ENTITY_MODIFIED for InteractionSystem
      // This enables event-based pending interactions (NPC trade, bank open, etc.)
      (entityId: string, position: { x: number; y: number; z: number }) => {
        this.world.emit(EventType.ENTITY_MODIFIED, {
          id: entityId,
          changes: {
            e: "idle",
            p: [position.x, position.y, position.z],
          },
        });
      },
      // Pass building proximity check for preserving server Y near buildings
      // Uses bounding box which includes door approach areas
      collisionService
        ? (x: number, z: number) =>
            collisionService.isNearBuildingForElevation(x, z)
        : undefined,
      // Pass step height function for smooth entrance stair walking
      collisionService
        ? (x: number, z: number) => collisionService.getStepHeightAtWorld(x, z)
        : undefined,
      this.world.frameBudget
        ? (minimumMs: number = 1) =>
            this.world.frameBudget!.hasTimeRemaining(minimumMs)
        : undefined,
    );
  }

  onGatheringComplete = (data: {
    playerId: string;
    resourceId: string;
    successful: boolean;
  }) => {
    // Forward to local event system for UI updates (progress bar, animation)
    this.world.emit(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: data.playerId,
      resourceId: data.resourceId,
      successful: data.successful,
      skill: "woodcutting", // Will be refined later
    });
  };

  // Show the authoritative gathering tool visual.
  onGatheringToolShow = (data: {
    playerId: string;
    itemId: string;
    slot: string;
    revision?: number;
  }) => {
    // Forward to local event system for EquipmentVisualSystem
    this.world.emit(EventType.GATHERING_TOOL_SHOW, {
      playerId: data.playerId,
      itemId: data.itemId,
      slot: data.slot,
      revision: data.revision,
    });
  };

  onGatheringToolHide = (data: {
    playerId: string;
    slot: string;
    revision?: number;
  }) => {
    // Forward to local event system for EquipmentVisualSystem
    this.world.emit(EventType.GATHERING_TOOL_HIDE, {
      playerId: data.playerId,
      slot: data.slot,
      revision: data.revision,
    });
  };

  onFishingInteractionPresentation = (
    data: FishingInteractionPresentationPayload,
  ) => {
    this.world.emit(EventType.FISHING_INTERACTION_PRESENTATION, data);
  };

  onProcessingInteractionPresentation = (
    data: ProcessingInteractionPresentationPayload,
  ) => {
    if (typeof data?.playerId !== "string") return;
    const playerId = data.playerId.trim();
    if (!playerId || playerId.length > 256) return;
    const { playerId: _playerId, ...rawState } = data;
    const state = normalizeProcessingInteractionPresentationState(rawState);
    if (!state) return;

    if (state.phase === "working" && state.targetPosition) {
      this.processingFaceTargets.set(playerId, state.targetPosition);
      this.applyProcessingFaceRotation(playerId, state.targetPosition);
    } else {
      this.processingFaceTargets.delete(playerId);
      if (!this.combatFaceTargets.has(playerId)) {
        this.tileInterpolator.clearCombatRotation(playerId);
      }
    }
    this.world.emit(EventType.PROCESSING_INTERACTION_PRESENTATION, {
      playerId,
      ...state,
    });
  };

  onPlayerState = (data: unknown) => {
    // Forward player state updates from server to local UI_UPDATE event
    const playerData = data as {
      playerId?: string;
      skills?: Record<string, { level: number; xp: number }>;
    };

    // Cache skills if provided
    if (playerData.playerId && playerData.skills) {
      this.lastSkillsByPlayerId = this.lastSkillsByPlayerId || {};
      this.lastSkillsByPlayerId[playerData.playerId] = playerData.skills;
    }

    this.world.emit(EventType.UI_UPDATE, {
      component: "player",
      data: data,
    });
  };

  onShowToast = (data: {
    playerId?: string;
    message: string;
    type: string;
  }) => {
    // If playerId is provided, only show toast for local player
    // If playerId is NOT provided, show toast anyway (server sent directly to us)
    const localPlayer = this.world.getPlayer();
    const shouldShow =
      !data.playerId || (localPlayer && localPlayer.id === data.playerId);

    if (shouldShow) {
      // Forward to local event system for toast display
      this.world.emit(EventType.UI_TOAST, {
        message: data.message,
        type: data.type,
      });
    }
  };

  onDeathScreen = (data: {
    playerId: string;
    message: string;
    killedBy: string;
    respawnTime: number;
  }) => {
    // Only show death screen for local player
    const localPlayer = this.world.getPlayer();
    if (localPlayer && localPlayer.id === data.playerId) {
      // Ensure input is blocked BEFORE death screen shows
      // This prevents the race condition where death screen appears
      // but player can still briefly send inputs
      this.world.emit(EventType.PLAYER_SET_DEAD, {
        playerId: data.playerId,
        isDead: true,
      });

      // Forward to local event system for death screen display
      this.world.emit(EventType.UI_DEATH_SCREEN, {
        message: data.message,
        killedBy: data.killedBy,
        respawnTime: data.respawnTime,
      });
    }
  };

  onDeathScreenClose = (data: { playerId: string }) => {
    // Only close death screen for local player
    const localPlayer = this.world.getPlayer();
    if (localPlayer && localPlayer.id === data.playerId) {
      // Forward to local event system to close death screen
      this.world.emit(EventType.UI_DEATH_SCREEN_CLOSE, {
        playerId: data.playerId,
      });
    }
  };

  onPlayerSetDead = (data: {
    playerId: string;
    isDead: boolean;
    deathPosition?: number[];
  }) => {
    const localPlayer = this.world.getPlayer();
    const isLocalPlayer = localPlayer && localPlayer.id === data.playerId;

    if (isLocalPlayer) {
      // Forward to local event system so PlayerLocal can handle it
      this.world.emit(EventType.PLAYER_SET_DEAD, {
        playerId: data.playerId,
        isDead: data.isDead,
        deathPosition: data.deathPosition,
      });
    } else {
      // For OTHER players: handle both death and respawn states
      // AAA QUALITY: Track dead players in deadPlayers Set AND entity.data.deathState
      // Both are needed for backward compatibility and entity-based checks
      if (data.isDead) {
        this.deadPlayers.add(data.playerId);
      }
      // NOTE: Do NOT remove from deadPlayers when isDead=false!
      // The onPlayerRespawned handles removal.
      // Removing here would undo our position blocking during death animation.

      // Check both main entities and players collection
      const entity =
        this.world.entities.get(data.playerId) ||
        this.world.entities.players?.get(data.playerId);

      // Debug log removed — fires on every player death during duel

      // CRITICAL FIX: Clear tileInterpolatorControlled flag so position updates work
      // This flag was blocking PlayerRemote.modify() and update() from applying positions
      if (entity?.data) {
        entity.data.tileInterpolatorControlled = false;
      }

      if (data.isDead) {
        // Player is dying - clear interpolation state and show death animation
        if (this.tileInterpolator.hasState(data.playerId)) {
          this.tileInterpolator.removeEntity(data.playerId);
        }
        if (this.interpolationStates.has(data.playerId)) {
          this.deleteInterpolationState(data.playerId);
        }

        // AAA QUALITY: Set entity.data.deathState (single source of truth)
        if (entity?.data) {
          entity.data.deathState = DeathState.DYING;

          // CRITICAL FIX: Always set death emote when player dies (duel or regular death)
          // This ensures death animation plays even if earlier 'idle' packets arrived
          // from CombatAnimationManager's scheduled emote resets
          entity.data.emote = "death";
          entity.data.e = "death";

          // CRITICAL: Also directly trigger the avatar's death animation (like PlayerLocal does)
          // Setting data.emote alone waits for update() loop - direct call is immediate
          const entityWithAvatar = entity as {
            avatar?: { setEmote?: (emote: string) => void };
            lastEmote?: string;
          };
          if (entityWithAvatar.avatar?.setEmote) {
            entityWithAvatar.avatar.setEmote(Emotes.DEATH);
            entityWithAvatar.lastEmote = Emotes.DEATH;
          }

          if (data.deathPosition) {
            // Handle both array [x,y,z] and object {x,y,z} formats
            if (Array.isArray(data.deathPosition)) {
              entity.data.deathPosition = data.deathPosition as [
                number,
                number,
                number,
              ];
            } else {
              const pos = data.deathPosition as {
                x: number;
                y: number;
                z: number;
              };
              entity.data.deathPosition = [pos.x, pos.y, pos.z];
            }
          }
        }

        // CRITICAL FIX: Set entity position to death position AND show death animation
        // Without this, the entity stays at whatever interpolated position it was at
        // on the killer's screen, not where the player actually died
        if (entity && data.deathPosition) {
          // Handle both array [x,y,z] and object {x,y,z} formats
          let x: number, y: number, z: number;
          let posArray: [number, number, number];
          if (Array.isArray(data.deathPosition)) {
            [x, y, z] = data.deathPosition;
            posArray = data.deathPosition as [number, number, number];
          } else {
            const pos = data.deathPosition as {
              x: number;
              y: number;
              z: number;
            };
            x = pos.x;
            y = pos.y;
            z = pos.z;
            posArray = [x, y, z];
          }

          // CRITICAL: Stop TileInterpolator movement to prevent position fighting
          // This ensures the death animation plays at the correct position
          if (this.tileInterpolator) {
            this.tileInterpolator.stopMovement(data.playerId, { x, y, z });
          }

          // Apply death position and emote together
          entity.modify({
            p: posArray,
            e: "death",
            visible: true,
          });

          // Also update position directly for immediate visual feedback
          if (entity.position) {
            entity.position.x = x;
            entity.position.y = y;
            entity.position.z = z;
          }
          if (entity.node?.position) {
            entity.node.position.set(x, y, z);
          }

          // Update base position for VRM avatars
          const entityWithBase = entity as {
            base?: {
              position: { set: (x: number, y: number, z: number) => void };
            };
          };
          if (entityWithBase.base?.position) {
            entityWithBase.base.position.set(x, y, z);
          }

          // Update lerp position to prevent interpolation fighting
          const playerRemote = entity as {
            lerpPosition?: {
              pushArray: (arr: number[], teleport: number | null) => void;
            };
            teleport?: number;
          };
          if (playerRemote.lerpPosition) {
            playerRemote.teleport = (playerRemote.teleport || 0) + 1;
            playerRemote.lerpPosition.pushArray(
              posArray,
              playerRemote.teleport,
            );
          }
        } else if (entity) {
          // Fallback if no death position provided
          console.log(
            `[ClientNetwork] Calling entity.modify({ e: "death" }) for ${data.playerId}`,
          );
          entity.modify({ e: "death", visible: true });
        } else {
          console.warn(
            `[ClientNetwork] No entity found for death animation: ${data.playerId}`,
          );
        }
      } else {
        // Player is respawning (isDead = false) - clear stale state
        // NOTE: Do NOT reset emote to idle here! The killed player may click
        // respawn before the death animation finishes for OTHER players.
        // Let onPlayerRespawned handle setting idle emote when position updates.
        if (this.tileInterpolator.hasState(data.playerId)) {
          this.tileInterpolator.removeEntity(data.playerId);
        }
        if (this.interpolationStates.has(data.playerId)) {
          this.deleteInterpolationState(data.playerId);
        }
        // Death animation continues until onPlayerRespawned sets idle emote
      }
    }
  };

  onPlayerRespawned = (data: {
    playerId: string;
    spawnPosition: number[] | { x: number; y: number; z: number };
    townName?: string;
    deathLocation?: number[];
  }) => {
    const localPlayer = this.world.getPlayer();
    const isLocalPlayer = localPlayer && localPlayer.id === data.playerId;

    if (isLocalPlayer) {
      // Forward to local event system so PlayerLocal can handle it
      this.world.emit(EventType.PLAYER_RESPAWNED, {
        playerId: data.playerId,
        spawnPosition: data.spawnPosition,
        townName: data.townName,
        deathLocation: data.deathLocation,
      });
    } else {
      // Debug log removed — fires on every player respawn after duel

      // SERVER-AUTHORITATIVE DEATH: Server now freezes position broadcasts during death animation
      // Client just needs to apply the spawn position when PLAYER_RESPAWNED arrives

      // Remove from dead players tracking - server has finished death animation timing
      this.deadPlayers.delete(data.playerId);

      // Clear any stale tile/interpolation state
      if (this.tileInterpolator.hasState(data.playerId)) {
        this.tileInterpolator.removeEntity(data.playerId);
      }
      if (this.interpolationStates.has(data.playerId)) {
        this.deleteInterpolationState(data.playerId);
      }

      // Convert spawnPosition to array format if needed
      let posArray: [number, number, number];
      if (Array.isArray(data.spawnPosition)) {
        posArray = data.spawnPosition as [number, number, number];
      } else {
        const sp = data.spawnPosition as { x: number; y: number; z: number };
        posArray = [sp.x, sp.y, sp.z];
      }

      // Apply respawn position and reset emote to idle
      const entity =
        this.world.entities.get(data.playerId) ||
        this.world.entities.players?.get(data.playerId);

      if (entity) {
        // AAA QUALITY: Clear entity.data.deathState (single source of truth)
        if (entity.data) {
          entity.data.tileInterpolatorControlled = false;
          entity.data.deathState = DeathState.ALIVE;
          entity.data.deathPosition = undefined;
        }

        // Update lerpPosition with teleport snap
        const playerRemote = entity as {
          lerpPosition?: {
            pushArray: (arr: number[], teleport: number | null) => void;
          };
          teleport?: number;
        };
        if (playerRemote.lerpPosition) {
          playerRemote.teleport = (playerRemote.teleport || 0) + 1;
          playerRemote.lerpPosition.pushArray(posArray, playerRemote.teleport);
        }

        // Apply position and idle emote
        entity.modify({
          p: posArray,
          e: "idle",
          visible: true,
        });

        // Direct position updates for immediate visual feedback
        if (entity.position) {
          entity.position.x = posArray[0];
          entity.position.y = posArray[1];
          entity.position.z = posArray[2];
        }
        if (entity.node?.position) {
          entity.node.position.set(posArray[0], posArray[1], posArray[2]);
        }

        const entityWithBase = entity as {
          base?: {
            position: { set: (x: number, y: number, z: number) => void };
            updateTransform?: () => void;
          };
        };
        if (entityWithBase.base?.position) {
          entityWithBase.base.position.set(
            posArray[0],
            posArray[1],
            posArray[2],
          );
          if (entityWithBase.base.updateTransform) {
            entityWithBase.base.updateTransform();
          }
        }
      }
    }
  };

  onAttackStyleChanged = (data: {
    playerId: string;
    currentStyle: unknown;
    availableStyles: unknown;
    canChange: boolean;
    cooldownRemaining?: number;
  }) => {
    // Cache for late-mounting UI (same pattern as skills)
    this.lastAttackStyleByPlayerId[data.playerId] = {
      currentStyle: data.currentStyle as { id: string },
      availableStyles: data.availableStyles,
      canChange: data.canChange,
    };

    // Emit unconditionally — packet is already filtered server-side for this
    // player, and gating on localPlayer causes race conditions where the packet
    // arrives before the player entity is created
    this.world.emit(EventType.UI_ATTACK_STYLE_CHANGED, data);
  };

  onAttackStyleUpdate = (data: {
    playerId: string;
    currentStyle: unknown;
    availableStyles: unknown;
    canChange: boolean;
  }) => {
    // Cache for late-mounting UI (same pattern as skills)
    this.lastAttackStyleByPlayerId[data.playerId] = {
      currentStyle: data.currentStyle as { id: string },
      availableStyles: data.availableStyles,
      canChange: data.canChange,
    };

    // Forward to local event system so UI can update
    // CRITICAL: Emit unconditionally - same reason as onAttackStyleChanged
    this.world.emit(EventType.UI_ATTACK_STYLE_UPDATE, data);
  };

  onAutoRetaliateChanged = (data: { enabled: boolean }) => {
    // Require the player entity to exist — this.id is the socket/connection UUID,
    // not the player entity ID, so it cannot be used as a fallback. If the player
    // entity isn't created yet, the UI isn't mounted to receive this event anyway.
    const playerId = this.world.getPlayer()?.id;
    if (!playerId) return;

    this.world.emit(EventType.UI_AUTO_RETALIATE_CHANGED, {
      playerId,
      enabled: data.enabled,
    });
  };

  onCombatDamageDealt = (data: {
    projectileId?: string;
    attackerId: string;
    targetId: string;
    damage: number;
    attackType?: AttackType;
    targetType: "player" | "mob";
    isCritical?: boolean;
    position: { x: number; y: number; z: number };
    tick?: number;
  }) => {
    // Deduplicate: sendToNearby publishes to 9 region topics, so players near
    // region boundaries receive the same packet 2-3x. Include the server tick
    // so same-damage rapid hits on different ticks are NOT dropped.
    // Use | separator (not -) to avoid collisions if IDs contain hyphens.
    // If tick is missing (rolling deploy), fall back to ms timestamp rounded to
    // 125ms (one server tick at 8Hz) so distinct hits aren't collapsed to tick 0.
    const tick = data.tick ?? Math.floor(performance.now() / 125);
    const dedupKey = data.projectileId
      ? `projectile|${data.projectileId}`
      : `${data.attackerId}|${data.targetId}|${data.damage}|${tick}`;
    if (this._recentDamageKeys.has(dedupKey)) {
      return; // Already processed this damage event
    }

    // Periodic sweep: clear stale entries (>500ms old) when map exceeds threshold.
    // Soft threshold at 150 (close to hard cap of 200) avoids unnecessary sweeps
    // during normal combat while still catching buildup before the hard cap.
    const now = performance.now();
    if (this._recentDamageKeys.size > 150) {
      // Deleting from a Map during for...of is safe per ES spec (§24.1.5.4).
      for (const [key, ts] of this._recentDamageKeys) {
        if (now - ts > 500) this._recentDamageKeys.delete(key);
      }
      // Hard cap: if sweep didn't clear enough (all entries <500ms old),
      // drop oldest-inserted entries to prevent unbounded growth. Trims to 100
      // (below the 150 sweep threshold) so we don't re-trigger on the next packet.
      if (this._recentDamageKeys.size > 200) {
        const excess = this._recentDamageKeys.size - 100;
        let dropped = 0;
        for (const key of this._recentDamageKeys.keys()) {
          this._recentDamageKeys.delete(key);
          if (++dropped >= excess) break;
        }
      }
    }

    this._recentDamageKeys.set(dedupKey, now);

    // Forward to local event system so DamageSplatSystem can show visual feedback
    this.world.emit(EventType.COMBAT_DAMAGE_DEALT, data);
  };

  onProjectileLaunched = (data: {
    projectileId?: string;
    attackerId: string;
    targetId: string;
    projectileType: string;
    sourcePosition: { x: number; y: number; z: number };
    targetPosition: { x: number; y: number; z: number };
    spellId?: string;
    delayMs?: number;
    arrowId?: string;
    travelDurationMs?: number;
    tick?: number;
    networkEventId?: string;
  }) => {
    this.observeProjectileNetworkEvent(data.networkEventId);
    if (
      data.projectileId &&
      this._terminalProjectileIds.has(data.projectileId)
    ) {
      return;
    }
    const eventIdentity = this.getProjectileNetworkEventIdentity(
      data.networkEventId,
      data.tick,
    );
    const source = data.sourcePosition;
    const target = data.targetPosition;
    const dedupKey = eventIdentity.startsWith("event:")
      ? `launch|${eventIdentity}`
      : [
          "launch",
          eventIdentity,
          data.attackerId,
          data.targetId,
          data.projectileType,
          data.spellId ?? "",
          data.arrowId ?? "",
          data.delayMs ?? "",
          data.travelDurationMs ?? "",
          source.x,
          source.y,
          source.z,
          target.x,
          target.y,
          target.z,
        ].join("|");
    if (
      !this.shouldProcessSpatialCombatPacket(
        this._recentProjectileLaunchKeys,
        dedupKey,
      )
    ) {
      return;
    }

    // Forward to local event system so ProjectileRenderer can show visual effects
    this.world.emit(EventType.COMBAT_PROJECTILE_LAUNCHED, data);
  };

  onProjectileHit = (data: {
    projectileId?: string;
    attackerId: string;
    targetId: string;
    damage: number;
    projectileType: string;
    position?: { x: number; y: number; z: number } | null;
    tick?: number;
    networkEventId?: string;
  }) => {
    this.observeProjectileNetworkEvent(data.networkEventId);
    if (data.projectileId) {
      this.rememberTerminalProjectile(data.projectileId);
    }
    const eventIdentity = this.getProjectileNetworkEventIdentity(
      data.networkEventId,
      data.tick,
    );
    const position = data.position;
    const dedupKey = eventIdentity.startsWith("event:")
      ? `hit|${eventIdentity}`
      : [
          "hit",
          eventIdentity,
          data.attackerId,
          data.targetId,
          data.damage,
          data.projectileType,
          position?.x ?? "",
          position?.y ?? "",
          position?.z ?? "",
        ].join("|");
    if (
      !this.shouldProcessSpatialCombatPacket(
        this._recentProjectileHitKeys,
        dedupKey,
      )
    ) {
      return;
    }

    this.world.emit(EventType.COMBAT_PROJECTILE_HIT, data);
  };

  onProjectileCancelled = (data: {
    projectileId: string;
    attackerId: string;
    targetId: string;
    projectileType: "arrow" | "spell";
    reason:
      | "combat_ended"
      | "entity_died"
      | "player_respawned"
      | "player_disconnected"
      | "combat_state_missing"
      | "projectile_expired";
    tick?: number;
    networkEventId?: string;
  }) => {
    this.observeProjectileNetworkEvent(data.networkEventId);
    this.rememberTerminalProjectile(data.projectileId);
    const eventIdentity = this.getProjectileNetworkEventIdentity(
      data.networkEventId,
      data.tick,
    );
    const dedupKey = eventIdentity.startsWith("event:")
      ? `cancel|${eventIdentity}`
      : [
          "cancel",
          eventIdentity,
          data.projectileId,
          data.attackerId,
          data.targetId,
          data.reason,
        ].join("|");
    if (
      !this.shouldProcessSpatialCombatPacket(
        this._recentProjectileCancellationKeys,
        dedupKey,
      )
    ) {
      return;
    }

    this.world.emit(EventType.COMBAT_PROJECTILE_CANCELLED, data);
  };

  onProjectileEventReplay = (data: {
    sourceId?: unknown;
    requestedFromSequence?: unknown;
    requestedToSequence?: unknown;
    complete?: unknown;
    events?: unknown;
  }) => {
    if (
      typeof data?.sourceId !== "string" ||
      !Number.isSafeInteger(data.requestedFromSequence) ||
      !Number.isSafeInteger(data.requestedToSequence) ||
      !Array.isArray(data.events)
    ) {
      return;
    }

    if (
      this._projectileNetworkSourceId &&
      data.sourceId !== this._projectileNetworkSourceId
    ) {
      this._projectileNetworkSourceId = data.sourceId;
      this._highestProjectileNetworkSequence = 0;
      this._missingProjectileNetworkSequences.clear();
      return;
    }

    const events = data.events
      .filter(
        (
          event,
        ): event is {
          sequence: number;
          name:
            | "projectileLaunched"
            | "projectileHit"
            | "projectileCancelled"
            | "combatDamageDealt";
          data: unknown;
        } =>
          !!event &&
          typeof event === "object" &&
          Number.isSafeInteger((event as { sequence?: unknown }).sequence) &&
          [
            "projectileLaunched",
            "projectileHit",
            "projectileCancelled",
            "combatDamageDealt",
          ].includes(String((event as { name?: unknown }).name)),
      )
      .sort((left, right) => left.sequence - right.sequence);

    for (const event of events) {
      switch (event.name) {
        case "projectileLaunched":
          this.onProjectileLaunched(event.data as never);
          break;
        case "projectileHit":
          this.onProjectileHit(event.data as never);
          break;
        case "projectileCancelled":
          this.onProjectileCancelled(event.data as never);
          break;
        case "combatDamageDealt":
          this.onCombatDamageDealt(event.data as never);
          break;
      }
    }

    const fromSequence = data.requestedFromSequence as number;
    const toSequence = data.requestedToSequence as number;
    for (let sequence = fromSequence; sequence <= toSequence; sequence += 1) {
      this._missingProjectileNetworkSequences.delete(sequence);
    }
  };

  private observeProjectileNetworkEvent(networkEventId?: string): void {
    if (typeof networkEventId !== "string") return;
    const separator = networkEventId.lastIndexOf(":");
    if (separator <= 0 || separator === networkEventId.length - 1) return;

    const sourceId = networkEventId.slice(0, separator);
    const sequence = Number(networkEventId.slice(separator + 1));
    if (
      sourceId.length === 0 ||
      sourceId.length > 64 ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0
    ) {
      return;
    }

    if (sourceId !== this._projectileNetworkSourceId) {
      this._projectileNetworkSourceId = sourceId;
      this._highestProjectileNetworkSequence = sequence;
      this._missingProjectileNetworkSequences.clear();
      return;
    }

    if (sequence > this._highestProjectileNetworkSequence + 1) {
      const fromSequence = Math.max(
        this._highestProjectileNetworkSequence + 1,
        sequence - 64,
      );
      const toSequence = sequence - 1;
      for (let missing = fromSequence; missing <= toSequence; missing += 1) {
        this._missingProjectileNetworkSequences.add(missing);
      }
      this.send("requestProjectileEventReplay", {
        sourceId,
        fromSequence,
        toSequence,
      });
    }

    this._highestProjectileNetworkSequence = Math.max(
      this._highestProjectileNetworkSequence,
      sequence,
    );
    this._missingProjectileNetworkSequences.delete(sequence);
  }

  private rememberTerminalProjectile(projectileId: string): void {
    this._terminalProjectileIds.set(projectileId, performance.now());
    while (this._terminalProjectileIds.size > 512) {
      const oldest = this._terminalProjectileIds.keys().next().value as
        string | undefined;
      if (!oldest) break;
      this._terminalProjectileIds.delete(oldest);
    }
  }

  private getProjectileNetworkEventIdentity(
    networkEventId: string | undefined,
    tick: number | undefined,
  ): string {
    if (
      typeof networkEventId === "string" &&
      networkEventId.length > 0 &&
      networkEventId.length <= 160
    ) {
      return `event:${networkEventId}`;
    }
    if (Number.isSafeInteger(tick) && (tick as number) >= 0) {
      return `tick:${tick}`;
    }
    // Rolling-deploy compatibility for packets from an older server. Multiple
    // nearby-topic copies arrive together, while a genuine later projectile is
    // assigned to a different 125 ms server-tick-sized bucket.
    return `legacy:${Math.floor(performance.now() / 125)}`;
  }

  private shouldProcessSpatialCombatPacket(
    recentKeys: Map<string, number>,
    dedupKey: string,
  ): boolean {
    if (recentKeys.has(dedupKey)) return false;

    const now = performance.now();
    if (recentKeys.size > 150) {
      for (const [key, timestamp] of recentKeys) {
        if (now - timestamp > 5_000) recentKeys.delete(key);
      }
      if (recentKeys.size > 200) {
        const excess = recentKeys.size - 100;
        let dropped = 0;
        for (const key of recentKeys.keys()) {
          recentKeys.delete(key);
          if (++dropped >= excess) break;
        }
      }
    }

    recentKeys.set(dedupKey, now);
    return true;
  }

  private applyCombatFaceRotation(playerId: string, targetId: string): boolean {
    const player = this.world.entities.get(playerId);
    const target = this.world.entities.get(targetId);
    if (!player?.position || !target?.position) return false;

    const dx = target.position.x - player.position.x;
    const dz = target.position.z - player.position.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return false;
    if (dx * dx + dz * dz < 1e-8) return false;

    // Registered player avatars face local -Z, so the target-space yaw needs
    // a half-turn compensation before TileInterpolator owns the rendered base.
    const angle = Math.atan2(dx, dz) + Math.PI;
    _quat_1.setFromAxisAngle(_combatFaceAxis, angle);
    const lockTarget =
      this.streamingDuelFacingLocked &&
      this.streamingDuelCombatFaceTargets.get(playerId) === targetId;
    return this.tileInterpolator.setCombatRotation(
      playerId,
      _quat_1,
      player.position,
      lockTarget,
    );
  }

  private refreshCombatFaceRotations(): void {
    for (const [playerId, targetId] of this.combatFaceTargets) {
      this.applyCombatFaceRotation(playerId, targetId);
    }
  }

  private applyProcessingFaceRotation(
    playerId: string,
    targetPosition: { x: number; y: number; z: number },
  ): boolean {
    if (this.combatFaceTargets.has(playerId)) return false;
    const player = this.world.entities.get(playerId);
    if (!player?.position) return false;
    const dx = targetPosition.x - player.position.x;
    const dz = targetPosition.z - player.position.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return false;
    if (dx * dx + dz * dz < 1e-8) return false;
    const angle = Math.atan2(dx, dz) + Math.PI;
    _quat_1.setFromAxisAngle(_combatFaceAxis, angle);
    return this.tileInterpolator.setCombatRotation(
      playerId,
      _quat_1,
      player.position,
      false,
    );
  }

  private refreshProcessingFaceRotations(): void {
    for (const [playerId, targetPosition] of this.processingFaceTargets) {
      this.applyProcessingFaceRotation(playerId, targetPosition);
    }
  }

  private clearPlayerHitReaction(playerId: string): void {
    const player = this.world.entities.get(playerId) as
      { avatar?: { clearHitReaction?: () => void } } | null | undefined;
    player?.avatar?.clearHitReaction?.();
  }

  private clearCombatFaceRotation(playerId: string, force = false): void {
    const streamingTarget = this.streamingDuelCombatFaceTargets.get(playerId);
    if (!force && this.streamingDuelFacingLocked && streamingTarget) {
      this.combatFaceTargets.set(playerId, streamingTarget);
      this.applyCombatFaceRotation(playerId, streamingTarget);
      return;
    }
    this.combatFaceTargets.delete(playerId);
    this.tileInterpolator.clearCombatRotation(playerId);
  }

  private syncStreamingDuelCombatFaceTargets(cycle: {
    phase: string;
    agent1: unknown | null;
    agent2: unknown | null;
  }): void {
    const readId = (agent: unknown): string | null => {
      if (!agent || typeof agent !== "object") return null;
      const id = (agent as { id?: unknown }).id;
      return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
    };
    const wasFighting = this.streamingDuelFighting;
    const previousContestantIds = [...this.streamingDuelContestantIds];
    const agent1Id = readId(cycle.agent1);
    const agent2Id = readId(cycle.agent2);
    const contestantIds = [agent1Id, agent2Id].filter(
      (id): id is string => id !== null,
    );
    this.streamingDuelContestantIds = new Set(contestantIds);
    const fighting =
      cycle.phase === "FIGHTING" &&
      agent1Id !== null &&
      agent2Id !== null &&
      agent1Id !== agent2Id;
    const facingLocked =
      (cycle.phase === "ANNOUNCEMENT" ||
        cycle.phase === "COUNTDOWN" ||
        fighting) &&
      agent1Id !== null &&
      agent2Id !== null &&
      agent1Id !== agent2Id;
    const nextTargets = facingLocked
      ? new Map([
          [agent1Id, agent2Id],
          [agent2Id, agent1Id],
        ])
      : new Map<string, string>();

    // A draw, cancellation, or ordinary resolution can arrive while a recent
    // recoil is still active. Clear the additive pose at the authoritative
    // FIGHTING boundary instead of letting it bleed into terminal presentation.
    if (wasFighting && !fighting) {
      for (const playerId of new Set([
        ...previousContestantIds,
        ...contestantIds,
      ])) {
        this.clearPlayerHitReaction(playerId);
      }
    }

    for (const [playerId, previousTarget] of this
      .streamingDuelCombatFaceTargets) {
      if (nextTargets.get(playerId) === previousTarget) continue;
      this.streamingDuelCombatFaceTargets.delete(playerId);
      if (this.combatFaceTargets.get(playerId) === previousTarget) {
        this.clearCombatFaceRotation(playerId, true);
      }
    }
    this.streamingDuelFacingLocked = facingLocked;
    this.streamingDuelFighting = fighting;
    for (const [playerId, targetId] of nextTargets) {
      this.streamingDuelCombatFaceTargets.set(playerId, targetId);
      this.combatFaceTargets.set(playerId, targetId);
      this.applyCombatFaceRotation(playerId, targetId);
    }
  }

  onCombatFaceTarget = (data: { playerId: string; targetId: string }) => {
    const streamingTarget = this.streamingDuelCombatFaceTargets.get(
      data.playerId,
    );
    if (this.streamingDuelFacingLocked && streamingTarget) {
      this.combatFaceTargets.set(data.playerId, streamingTarget);
      this.applyCombatFaceRotation(data.playerId, streamingTarget);
      this.world.emit(EventType.COMBAT_FACE_TARGET, {
        playerId: data.playerId,
        targetId: streamingTarget,
      });
      return;
    }
    if (
      !this.streamingDuelFacingLocked &&
      this.streamingDuelContestantIds.has(data.playerId)
    ) {
      return;
    }
    this.combatFaceTargets.set(data.playerId, data.targetId);
    // Apply immediately when both entities already exist; the retained mapping
    // retries in lateUpdate when packet ordering delivers an entity later.
    this.applyCombatFaceRotation(data.playerId, data.targetId);
    // Preserve the local event for PlayerLocal and existing presentation hooks.
    this.world.emit(EventType.COMBAT_FACE_TARGET, data);
  };

  onCombatEnded = (data: { attackerId: string; targetId: string }) => {
    // Explicit face-clear packets remain the normal path. Combat-ended is a
    // defensive terminal cleanup for disconnect/death ordering.
    this.clearCombatFaceRotation(data.attackerId);
    this.clearCombatFaceRotation(data.targetId);
    this.world.emit(EventType.COMBAT_ENDED, data);
  };

  onCombatClearFaceTarget = (data: { playerId: string }) => {
    this.clearCombatFaceRotation(data.playerId);
    // Forward to local event system so PlayerLocal stops rotating toward target.
    this.world.emit(EventType.COMBAT_CLEAR_FACE_TARGET, data);
  };

  onXpDrop = (data: {
    skill: string;
    xpGained: number;
    newXp: number;
    newLevel: number;
    position: { x: number; y: number; z: number };
  }) => {
    // Forward to local event system so XPDropSystem and XPProgressOrb can show visual feedback
    this.world.emit(EventType.XP_DROP_RECEIVED, data);
  };

  onPlayerUpdated = (data: {
    health: number;
    maxHealth: number;
    alive: boolean;
  }) => {
    const localPlayer = this.world.getPlayer();
    if (!localPlayer) {
      // Embedded spectator sessions and stream modes intentionally have no local player.
      if (this.isEmbeddedSpectator || isStreamingLikeViewport()) {
        return;
      }
      console.warn("[ClientNetwork] onPlayerUpdated: No local player found");
      return;
    }

    // Use modify() to update entity - this triggers PlayerLocal.modify()
    // which updates _playerHealth (the field the UI reads)
    localPlayer.modify({
      health: data.health,
      maxHealth: data.maxHealth,
    });

    // Update alive status
    if ("alive" in localPlayer) {
      (localPlayer as { alive: boolean }).alive = data.alive;
    }

    // Emit health update event for UI
    this.world.emit(EventType.PLAYER_HEALTH_UPDATED, {
      playerId: localPlayer.id,
      health: data.health,
      maxHealth: data.maxHealth,
    });
  };

  onCorpseLoot = (data: {
    corpseId: string;
    playerId: string;
    lootItems: Array<{ itemId: string; quantity: number }>;
    position: { x: number; y: number; z: number };
  }) => {
    console.log(
      `[ClientNetwork] Received corpseLoot packet for ${data.corpseId} with ${data.lootItems?.length || 0} items`,
    );
    // Forward to local event system so UI can open loot window
    this.world.emit(EventType.CORPSE_CLICK, data);
  };

  private clearPendingModifications(entityId: string): void {
    const pending = this.pendingModifications.get(entityId);
    if (pending) {
      this.totalPendingModificationCount = Math.max(
        0,
        this.totalPendingModificationCount - pending.length,
      );
    }
    this.pendingModifications.delete(entityId);
    this.pendingModificationTimestamps.delete(entityId);
    this.pendingModificationLimitReached.delete(entityId);
  }

  private filterNetworkEntities(entities: EntityData[]): EntityData[] {
    const admitted: EntityData[] = [];
    for (const entity of entities) {
      if (!shouldAdmitNetworkEntityInViewport(entity.type)) {
        this.streamingFilteredEntityIds.add(entity.id);
        this.clearPendingModifications(entity.id);
        continue;
      }
      this.streamingFilteredEntityIds.delete(entity.id);
      admitted.push(entity);
    }
    return admitted;
  }

  applyPendingModifications = (entityId: string) => {
    const pending = this.pendingModifications.get(entityId);
    if (pending && pending.length > 0) {
      this.logger.info(
        `Applying ${pending.length} pending modifications for entity ${entityId}`,
      );
      pending.forEach((mod) => this.onEntityModified({ ...mod, id: entityId }));

      // Clean up tracking structures - decrement count first
      this.totalPendingModificationCount -= pending.length;
      this.pendingModifications.delete(entityId);
      this.pendingModificationTimestamps.delete(entityId);
      this.pendingModificationLimitReached.delete(entityId);
    }
  };

  onPlayerTeleport = (data: {
    playerId: string;
    position: [number, number, number];
    rotation?: number;
    suppressEffect?: boolean;
  }) => {
    const pos = _v3_1.set(data.position[0], data.position[1], data.position[2]);

    // Check if this is the local player
    const localPlayer = this.world.entities.player;
    const isLocalPlayer =
      localPlayer instanceof PlayerLocal && localPlayer.id === data.playerId;

    // Convert rotation angle to quaternion if provided
    // Server sends angle as atan2(dx, dz) - need to add PI for VRM models
    let rotationQuat: [number, number, number, number] | undefined;
    if (data.rotation !== undefined) {
      const angle = data.rotation + Math.PI; // VRM 1.0+ compensation
      const halfAngle = angle / 2;
      rotationQuat = [0, Math.sin(halfAngle), 0, Math.cos(halfAngle)];
    }

    if (isLocalPlayer) {
      // Local player teleport
      // CRITICAL: Reset tile interpolator state BEFORE teleporting
      // Otherwise the tile movement system will immediately pull player back
      this.tileInterpolator.syncPosition(data.playerId, {
        x: pos.x,
        y: pos.y,
        z: pos.z,
      });

      // Clear the tile movement flags on player data
      localPlayer.data.tileInterpolatorControlled = false;
      localPlayer.data.tileMovementActive = false;

      // Cancel any pending client-side actions (walk-to actions, interactions)
      // This prevents stale actions from executing after teleport
      const interactionRouter = this.world.getSystem("interaction-router") as {
        cancelCurrentAction?: () => void;
      } | null;
      if (interactionRouter?.cancelCurrentAction) {
        interactionRouter.cancelCurrentAction();
      }

      // Now teleport the player
      localPlayer.teleport(pos);

      // Apply rotation if provided
      if (rotationQuat && localPlayer.base) {
        localPlayer.base.quaternion.set(
          rotationQuat[0],
          rotationQuat[1],
          rotationQuat[2],
          rotationQuat[3],
        );
      }

      // Note: localPlayer.teleport() above already emits PLAYER_TELEPORTED
      // for VFX — do not emit again here to avoid duplicate effects.
    } else {
      // Remote player teleport - update their position so we see them move
      const remotePlayer = this.world.entities.players?.get(data.playerId);
      if (remotePlayer) {
        // Reset tile interpolator state for this remote player
        this.tileInterpolator.syncPosition(data.playerId, {
          x: pos.x,
          y: pos.y,
          z: pos.z,
        });

        // Update lerpPosition with teleport snap so PlayerRemote.update()
        // doesn't revert to a stale position on the next frame
        const remoteWithLerp = remotePlayer as {
          lerpPosition?: {
            pushArray: (arr: number[], teleport: number | null) => void;
          };
          teleport?: number;
        };
        if (remoteWithLerp.lerpPosition) {
          remoteWithLerp.teleport = (remoteWithLerp.teleport || 0) + 1;
          remoteWithLerp.lerpPosition.pushArray(
            [pos.x, pos.y, pos.z],
            remoteWithLerp.teleport,
          );
        }

        // Update their position directly
        if (remotePlayer.position) {
          remotePlayer.position.x = pos.x;
          remotePlayer.position.y = pos.y;
          remotePlayer.position.z = pos.z;
        }

        // Also update node position if available
        if (remotePlayer.node) {
          remotePlayer.node.position.set(pos.x, pos.y, pos.z);
        }

        // Update base position + transform for immediate VRM visual update
        const remoteWithBase = remotePlayer as {
          base?: {
            position: { set: (x: number, y: number, z: number) => void };
            updateTransform?: () => void;
          };
        };
        if (remoteWithBase.base?.position) {
          remoteWithBase.base.position.set(pos.x, pos.y, pos.z);
          if (remoteWithBase.base.updateTransform) {
            remoteWithBase.base.updateTransform();
          }
        }

        // Emit event for teleport visual effects (duel arena teleports, etc.)
        this.world.emit(EventType.PLAYER_TELEPORTED, {
          playerId: data.playerId,
          position: { x: pos.x, y: pos.y, z: pos.z },
          ...(data.suppressEffect ? { suppressEffect: true } : {}),
        });

        // Apply rotation if provided
        if (rotationQuat) {
          // Set on TileInterpolator for consistent rotation management
          this.tileInterpolator.setCombatRotation(data.playerId, rotationQuat);

          // Also set directly on entity for immediate visual update
          if (remotePlayer.base) {
            (
              remotePlayer.base as {
                quaternion?: {
                  set: (x: number, y: number, z: number, w: number) => void;
                };
              }
            ).quaternion?.set(
              rotationQuat[0],
              rotationQuat[1],
              rotationQuat[2],
              rotationQuat[3],
            );
          }
        }
      }
    }
  };

  onPlayerPush = (data: { force: [number, number, number] }) => {
    const player = this.world.entities.player;
    if (player instanceof PlayerLocal) {
      const force = _v3_1.set(data.force[0], data.force[1], data.force[2]);
      player.push(force);
    }
  };

  onPlayerSessionAvatar = (data: { playerId: string; avatar: string }) => {
    const player = this.world.entities.player as {
      setSessionAvatar?: (url: string) => void;
    };
    if (player?.setSessionAvatar) {
      player.setSessionAvatar(data.avatar);
    }
  };

  // Handle compressed updates (deprecated - compression disabled)
  onCompressedUpdate = (_packet: unknown) => {
    // Compression disabled - this handler is a no-op
  };

  onPong = (time: number) => {
    if (this.world.stats) {
      this.world.stats.onPong(time);
    }
  };

  /**
   * Handle server-measured RTT (Round-Trip Time) packet.
   * This is the WebSocket-level ping/pong RTT measured by the server.
   */
  onRtt = (data: { rtt: number }) => {
    if (this.world.stats) {
      this.world.stats.onServerRTT(data.rtt);
    }
  };

  /**
   * Handle server tick health stats for DevStats panel.
   */
  onTickHealth = (data: {
    currentTick: number;
    missedTicks: number;
    lateTicks: number;
    maxLateness: number;
    lastResetTick: number;
    lastTickDuration: number;
    tickDurations?: {
      samples: number;
      average: number;
      p50: number;
      p95: number;
      p99: number;
      max: number;
    };
    tickLateness?: {
      samples: number;
      average: number;
      p50: number;
      p95: number;
      p99: number;
      max: number;
    };
    isHealthy: boolean;
    phaseTimings?: { mobAI: number; mobMove: number; combat: number };
    eventLoopLag?: number;
    transport?: string;
    connections?: number;
    broadcastMs?: number;
    pubsubPublishes?: number;
  }) => {
    (this.world as { tickHealth?: typeof data }).tickHealth = data;
  };

  /**
   * Handle server acknowledgment of a successful session reconnection.
   */
  onReconnected = (data: { characterId: string }) => {
    this.logger.info(
      `[ClientNetwork] Server confirmed reconnection for character ${data.characterId}`,
    );
    this.emitTypedEvent("SESSION_RESTORED", {
      characterId: data.characterId,
    });
  };

  onKick = (code: string) => {
    // Emit a typed UI event for kicks
    this.emitTypedEvent("UI_KICK", {
      playerId: this.id || "unknown",
      reason: code || "unknown",
    });
  };

  /**
   * Handle enter world rejection (e.g., character already logged in)
   * This triggers a redirect back to character select with an error message
   */
  onEnterWorldRejected = (data: { reason: string; message: string }) => {
    console.warn(
      "[ClientNetwork] Enter world rejected:",
      data.reason,
      data.message,
    );
    // Emit as a kick event with the duplicate_user code
    // This will show the proper overlay and let the user know
    this.emitTypedEvent("UI_KICK", {
      playerId: this.id || "unknown",
      reason: "duplicate_user",
    });
  };

  // ==== Home Teleport Handlers ====

  /**
   * Handle home teleport cast started
   * Server confirms casting has begun, client shows progress UI
   */
  onHomeTeleportStart = (data: { castTimeMs: number }) => {
    this.world.emit(EventType.HOME_TELEPORT_CAST_START, {
      castTimeMs: data.castTimeMs,
    });
  };

  /**
   * Handle home teleport failed
   * Server rejected teleport request (combat, cooldown, etc.)
   */
  onHomeTeleportFailed = (data: { reason: string; remainingMs?: number }) => {
    this.world.emit(EventType.HOME_TELEPORT_FAILED, {
      reason: data.reason,
      ...(typeof data.remainingMs === "number"
        ? { remainingMs: data.remainingMs }
        : {}),
    });
  };

  /**
   * Handle position reconciliation from server
   *
   * Server sends this when it corrects our position (e.g., falling through terrain,
   * anti-cheat correction). We snap to the server-authoritative position.
   *
   * @param data - Reconciliation data including corrected position and reason
   */
  onPositionReconcile = (data: {
    position: [number, number, number];
    reason: "emergency" | "drift";
    serverTick: number;
  }) => {
    const localPlayer = this.world.entities.player;
    if (!(localPlayer instanceof PlayerLocal)) return;

    const pos = _v3_1.set(data.position[0], data.position[1], data.position[2]);

    // Log for debugging
    if (data.reason === "emergency") {
      console.warn(
        `[ClientNetwork] Position reconciliation (${data.reason}): y=${pos.y}`,
      );
    }

    // Reset tile interpolator state to prevent it from reverting to old position
    this.tileInterpolator.syncPosition(localPlayer.id, {
      x: pos.x,
      y: pos.y,
      z: pos.z,
    });

    // Clear movement flags
    localPlayer.data.tileInterpolatorControlled = false;
    localPlayer.data.tileMovementActive = false;

    // Apply the corrected position
    localPlayer.teleport(pos);

    // Emit event for any UI that cares about position corrections
    this.world.emit("positionReconciled", {
      position: { x: pos.x, y: pos.y, z: pos.z },
      reason: data.reason,
    });
  };

  // ==== Tile Movement Handlers (classic fantasy MMORPG-style) ====

  /**
   * Handle tile position update from server
   * Server sends this every tick (600ms) when an entity moves
   */
  onEntityTileUpdate = (data: {
    id: string;
    tile: TileCoord;
    worldPos: [number, number, number];
    quaternion?: [number, number, number, number];
    emote: string;
    tickNumber: number;
    moveSeq?: number;
  }) => {
    // Use pre-allocated Vector3 to avoid allocation per network message
    _v3_1.set(data.worldPos[0], data.worldPos[1], data.worldPos[2]);

    // Get entity's current position as fallback for smooth interpolation
    // (in case tileMovementStart was missed due to packet loss)
    const entity = this.world.entities.get(data.id);
    const entityCurrentPos = entity?.position as THREE.Vector3 | undefined;

    // Update tile interpolator with tick number and moveSeq for proper sequencing
    this.tileInterpolator.onTileUpdate(
      data.id,
      data.tile,
      _v3_1,
      data.emote,
      data.quaternion,
      entityCurrentPos,
      data.tickNumber,
      data.moveSeq,
    );

    // CRITICAL: Set the flag IMMEDIATELY after tile update
    // This prevents race conditions where entityModified packets arrive after this
    // and apply stale server rotation, causing flickering
    if (entity?.data) {
      entity.data.tileInterpolatorControlled = true;
    }

    // Also update the entity data for consistency
    if (entity) {
      entity.data.emote = data.emote;
      // DON'T update quaternion here - TileInterpolator handles rotation smoothly
      // Storing server quaternion in entity.data could cause other code to read and apply it
      // if (data.quaternion) {
      //   entity.data.quaternion = data.quaternion;
      // }
    }
  };

  /**
   * Handle movement path started
   *
   * classic MMORPG Model: Client receives FULL PATH and walks through it at fixed speed.
   * Server tick updates are for sync/verification only.
   */
  onTileMovementStart = (data: {
    id: string;
    startTile?: TileCoord;
    path: TileCoord[];
    running: boolean;
    destinationTile?: TileCoord;
    moveSeq?: number;
    emote?: string;
    tilesPerTick?: number; // Mob-specific speed (optional, defaults to walk/run speed)
    isContinuation?: boolean; // Append to existing path instead of resetting interpolator
  }) => {
    if (this.processingFaceTargets.delete(data.id)) {
      if (!this.combatFaceTargets.has(data.id)) {
        this.tileInterpolator.clearCombatRotation(data.id);
      }
    }
    // Get entity's current position for smooth start (fallback if startTile not provided)
    const entity = this.world.entities.get(data.id);
    const currentPosition = entity?.position as THREE.Vector3 | undefined;

    // A movement state can be absent after lifecycle cleanup even though the
    // canonical stream pairing is still frozen. Re-establish the locked duel
    // rotation before the path is interpreted so a newly-created interpolator
    // state never initializes from the travel heading for one rendered frame.
    const streamingTarget = this.streamingDuelCombatFaceTargets.get(data.id);
    if (this.streamingDuelFacingLocked && streamingTarget) {
      this.combatFaceTargets.set(data.id, streamingTarget);
      this.applyCombatFaceRotation(data.id, streamingTarget);
    }

    // Pass server's authoritative path to interpolator
    // startTile: where server knows entity IS (authoritative)
    // path: complete path from server (no client recalculation)
    // destinationTile: final target for verification
    // moveSeq: packet ordering to ignore stale packets
    // emote: bundled animation (classic MMORPG-style)
    // tilesPerTick: mob-specific speed (for faster/slower mobs)
    this.tileInterpolator.onMovementStart(
      data.id,
      data.path,
      data.running,
      currentPosition,
      data.startTile,
      data.destinationTile,
      data.moveSeq,
      data.emote,
      data.tilesPerTick,
      data.isContinuation,
    );

    // CRITICAL: Set the flag IMMEDIATELY when movement starts
    // This prevents race conditions where entityModified packets arrive before update() runs
    // and apply stale server rotation, causing flickering between north/south
    if (entity?.data) {
      entity.data.tileInterpolatorControlled = true;
      // Apply emote immediately - don't wait for interpolator update() cycle
      // This ensures animation matches movement from the very first frame
      // Use modify() to trigger PlayerLocal's emote handling (avatar animation update)
      if (data.emote) {
        entity.modify({ e: data.emote });
      }
    }
  };

  /**
   * Handle entity arrived at destination
   */
  onTileMovementEnd = (data: {
    id: string;
    tile: TileCoord;
    worldPos: [number, number, number];
    moveSeq?: number;
    emote?: string;
    quaternion?: [number, number, number, number];
  }) => {
    // Use pre-allocated Vector3 to avoid allocation per network message
    _v3_1.set(data.worldPos[0], data.worldPos[1], data.worldPos[2]);
    // Let TileInterpolator handle the arrival smoothly
    // It will snap only if already at destination, otherwise let interpolation finish
    // moveSeq ensures stale end packets are ignored
    // Pass emote so it's applied atomically with movement end (prevents race condition)
    this.tileInterpolator.onMovementEnd(
      data.id,
      data.tile,
      _v3_1,
      data.moveSeq,
      data.emote,
    );

    // Get entity for flag and emote updates
    const entity = this.world.entities.get(data.id);

    // CRITICAL: Keep the flag set - TileInterpolator might still be finishing interpolation
    // The flag will be managed by TileInterpolator during its update cycle
    if (entity?.data) {
      entity.data.tileInterpolatorControlled = true;
    }

    // Apply rotation from server if provided (atomic delivery with movement end)
    // This is bundled with tileMovementEnd to ensure client applies it immediately
    // even when TileInterpolator has state (which normally filters out server rotation)
    if (data.quaternion && entity) {
      _quat_1.set(
        data.quaternion[0],
        data.quaternion[1],
        data.quaternion[2],
        data.quaternion[3],
      );
      entity.data.quaternion = data.quaternion;
      // Apply ONLY to node quaternion (not base) - matches movement code pattern
      // Setting both node AND base causes double rotation due to parent-child hierarchy
      if (entity.node) {
        entity.node.quaternion.copy(_quat_1);
      }
    }

    // Apply emote from server only when interpolation has fully finished
    // Short paths can still be interpolating when movement end arrives; applying
    // the arrival emote immediately causes skating (idle while still moving).
    const isInterpolating = this.tileInterpolator.isInterpolating(data.id);
    if (data.emote && entity && !isInterpolating) {
      entity.data.emote = data.emote;
      entity.modify({ e: data.emote });
    } else if (!data.emote && !isInterpolating) {
      // No emote from server and not interpolating - default to idle
      if (entity) {
        entity.data.emote = "idle";
      }
    }
  };

  // --- Action Bar State Handler ---
  // Cache action bar state so UI can hydrate even if it mounts late
  lastActionBarState: {
    barId: string;
    slotCount: number;
    slots: Array<{ slotIndex: number; itemId?: string; actionId?: string }>;
  } | null = null;

  onActionBarState = (data: {
    barId: string;
    slotCount: number;
    slots: Array<{ slotIndex: number; itemId?: string; actionId?: string }>;
  }) => {
    // Cache for late-mounting UI
    this.lastActionBarState = data;

    // Emit UI event for ActionBarPanel to handle
    this.world.emit(EventType.UI_UPDATE, {
      component: "actionBar",
      data,
    });
  };

  // --- Player Name Changed Handler ---
  onPlayerNameChanged = (data: { name: string }) => {
    // Update local player name if applicable
    const localPlayer = this.world.getPlayer();
    if (localPlayer) {
      // Update player data
      if (localPlayer.data) {
        localPlayer.data.name = data.name;
      }
      // Emit event for UI to update
      this.world.emit(EventType.UI_UPDATE, {
        component: "playerName",
        data: { name: data.name },
      });
    }
  };

  // --- Loot Result Handler ---
  // Handles loot transaction results from server for optimistic update reconciliation
  onLootResult = (data: {
    transactionId: string;
    success: boolean;
    itemId?: string;
    quantity?: number;
    reason?: string;
    timestamp: number;
  }) => {
    // Emit event for LootWindowPanel to handle transaction result
    this.world.emit(EventType.UI_UPDATE, {
      component: "lootResult",
      data,
    });
  };

  // --- Smelting Close Handler ---
  // Server sends this when player walks away from furnace or smelting completes
  onSmeltingClose = (data: { reason?: string }) => {
    this.world.emit(EventType.UI_UPDATE, {
      component: "smeltingClose",
      data,
    });
  };

  // --- Smithing Close Handler ---
  // Server sends this when player walks away from anvil or smithing completes
  onSmithingClose = (data: { reason?: string }) => {
    this.world.emit(EventType.UI_UPDATE, {
      component: "smithingClose",
      data,
    });
  };

  onClose = (code: CloseEvent) => {
    if (code.currentTarget && code.currentTarget !== this.ws) return;
    this.worldAdmission.close();
    console.error("[ClientNetwork] 🔌 WebSocket CLOSED:", {
      code: code.code,
      reason: code.reason,
      wasClean: code.wasClean,
      currentId: this.id,
      intentionalDisconnect: this.intentionalDisconnect,
    });
    this.connected = false;

    // Emit a typed network disconnect event
    this.emitTypedEvent("NETWORK_DISCONNECTED", {
      code: code.code,
      reason: code.reason || "closed",
    });

    // Clean up optimistic inventory tracker on disconnect
    if (this.inventoryPrunerInterval) {
      clearTimeout(this.inventoryPrunerInterval);
      this.inventoryPrunerInterval = null;
    }
    this.inventoryTracker.clear();

    // Don't attempt reconnection if this was intentional (user logout, etc.)
    if (this.intentionalDisconnect) {
      this.world.chat.add(
        {
          id: uuid(),
          from: "System",
          fromId: undefined,
          body: "You have been disconnected.",
          text: "You have been disconnected.",
          timestamp: Date.now(),
          createdAt: new Date().toISOString(),
        },
        false,
      );
      return;
    }

    // Don't reconnect for certain close codes (e.g., server rejected auth)
    const noReconnectCodes = [
      4001, // Authentication failed
      4002, // Invalid token
      4003, // Banned
      4004, // Server full
      4005, // World content identity mismatch (requires an asset/client update)
      1000, // Normal closure (server initiated clean disconnect)
    ];
    if (noReconnectCodes.includes(code.code)) {
      this.logger.debug(`Not reconnecting due to close code: ${code.code}`);
      this.world.chat.add(
        {
          id: uuid(),
          from: "System",
          fromId: undefined,
          body: "You have been disconnected.",
          text: "You have been disconnected.",
          timestamp: Date.now(),
          createdAt: new Date().toISOString(),
        },
        false,
      );
      return;
    }

    // Attempt automatic reconnection
    this.attemptReconnect();
  };

  /**
   * Attempt to reconnect to the server with exponential backoff
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        `Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up`,
      );
      this.isReconnecting = false;
      this.emitTypedEvent("NETWORK_RECONNECT_FAILED", {
        attempts: this.reconnectAttempts,
        reason: "max_attempts_exceeded",
      });
      this.world.chat.add(
        {
          id: uuid(),
          from: "System",
          fromId: undefined,
          body: "Connection lost. Please refresh the page to reconnect.",
          text: "Connection lost. Please refresh the page to reconnect.",
          timestamp: Date.now(),
          createdAt: new Date().toISOString(),
        },
        false,
      );
      return;
    }

    if (!this.lastWsUrl) {
      this.logger.error("Cannot reconnect - no previous WebSocket URL stored");
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, up to 30s max
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      30000,
    );

    this.logger.debug(
      `Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
    );

    // Emit reconnecting event with attempt info
    this.emitTypedEvent("NETWORK_RECONNECTING", {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
    });

    // Show reconnecting message only on first attempt
    if (this.reconnectAttempts === 1) {
      this.world.chat.add(
        {
          id: uuid(),
          from: "System",
          fromId: undefined,
          body: "Connection lost. Attempting to reconnect...",
          text: "Connection lost. Attempting to reconnect...",
          timestamp: Date.now(),
          createdAt: new Date().toISOString(),
        },
        false,
      );
    }

    this.reconnectTimeoutId = setTimeout(async () => {
      try {
        // Clean up old WebSocket reference
        if (this.ws) {
          try {
            this.ws.removeEventListener("message", this.onPacket);
            this.ws.removeEventListener("close", this.onClose);
          } catch {
            // Ignore cleanup errors
          }
          this.ws = null;
        }

        // Re-initialize with stored options
        await this.init(this.lastInitOptions as WorldOptions);
      } catch (error) {
        this.logger.error(
          "Reconnect attempt failed:",
          error instanceof Error ? error : undefined,
        );
        // Try again
        this.attemptReconnect();
      }
    }, delay);
  }

  /**
   * Cancel any pending reconnection attempts
   */
  cancelReconnect(): void {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
  }

  /**
   * Check if currently attempting to reconnect
   */
  get reconnecting(): boolean {
    return this.isReconnecting;
  }

  destroy = () => {
    this.worldAdmission.close();
    // Mark as intentional disconnect to prevent reconnection
    this.intentionalDisconnect = true;
    this.cancelReconnect();

    // Clear keepalive interval
    if (this.keepaliveIntervalId) {
      clearInterval(this.keepaliveIntervalId);
      this.keepaliveIntervalId = null;
    }

    if (this.ws) {
      this.ws.removeEventListener("message", this.onPacket);
      this.ws.removeEventListener("close", this.onClose);
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
    // Clear any pending queue items
    this.queue.length = 0;
    this._queueReadIndex = 0;
    // Clear outgoing queue
    this.outgoingQueue = [];
    this.outgoingQueueSequence = 0;
    this.connected = false;
    // Clear interpolation states
    this.interpolationStates.clear();
    // Clear tile interpolation states
    this.tileInterpolator.clear();
    this.combatFaceTargets.clear();
    this.streamingDuelCombatFaceTargets.clear();
    this.processingFaceTargets.clear();
    this.streamingDuelContestantIds.clear();
    this.streamingFilteredEntityIds.clear();
    this.streamingDuelFacingLocked = false;
    this.streamingDuelFighting = false;
    // Clear pending modifications tracking
    this.pendingModifications.clear();
    this.pendingModificationTimestamps.clear();
    this.pendingModificationLimitReached.clear();
    this.totalPendingModificationCount = 0;
    this._recentDamageKeys.clear();
    this._recentProjectileLaunchKeys.clear();
    this._recentProjectileHitKeys.clear();
    this._recentProjectileCancellationKeys.clear();
    this._projectileNetworkSourceId = null;
    this._highestProjectileNetworkSequence = 0;
    this._missingProjectileNetworkSequences.clear();
    this._terminalProjectileIds.clear();
    // Clear dead players tracking
    this.deadPlayers.clear();
  };

  // Plugin-specific upload method
  async upload(file: File): Promise<string> {
    const apiUrl =
      this.apiUrl ||
      (typeof window !== "undefined" ? window.location.origin : null);
    if (!apiUrl) {
      throw new Error("Upload failed: API URL not configured");
    }

    if (this.maxUploadSize > 0 && file.size > this.maxUploadSize) {
      throw new Error(
        `Upload failed: file exceeds max size (${this.maxUploadSize} bytes)`,
      );
    }

    const formData = new FormData();
    formData.append("file", file, file.name);

    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/upload`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const message =
        errorText ||
        `Upload failed: HTTP ${response.status} ${response.statusText}`;
      throw new Error(message);
    }

    const payload = (await response.json()) as { filename?: string };
    if (!payload.filename) {
      throw new Error("Upload failed: missing filename in response");
    }

    return payload.filename;
  }

  // --- Streaming Mode packet handlers ---

  /**
   * Streaming mode state update
   * Broadcasts streaming duel cycle state to viewers
   */
  onStreamingState = (data: {
    type: string;
    cycle: {
      cycleId: string;
      phase: string;
      cycleStartTime: number;
      phaseStartTime: number;
      phaseEndTime: number;
      timeRemaining: number;
      agent1: unknown | null;
      agent2: unknown | null;
      countdown: number | null;
      fightStartTime: number | null;
      arenaPositions: {
        agent1: [number, number, number];
        agent2: [number, number, number];
      } | null;
      winnerId: string | null;
      winnerName: string | null;
      outcome: "win" | "draw" | null;
      winReason: string | null;
    };
    leaderboard: unknown[];
    cameraTarget: string | null;
  }) => {
    this.syncStreamingDuelCombatFaceTargets(data.cycle);
    // Re-emit on world for streaming UI components to consume
    this.world.emit("streaming:state:update", data);

    const nextTargetId =
      typeof data.cameraTarget === "string" && data.cameraTarget.length > 0
        ? data.cameraTarget
        : null;

    // Embedded spectators should follow scheduler camera target changes
    // (prevents stale followEntity from pinning the camera to inactive agents).
    if (!this.isEmbeddedSpectator || !nextTargetId) {
      return;
    }

    // Dashboard viewfinders have an explicit embeddedCharacterId — they are
    // deliberately watching a specific agent and must NOT be hijacked by the
    // streaming scheduler's cameraTarget (which points at whoever is currently
    // dueling, not the agent the dashboard selected).  Only anonymous/streaming
    // viewers with no pinned character should follow the scheduler's camera.
    // Check instance field AND the frozen window value so HMR re-instantiation
    // (which resets class fields to null) doesn't bypass this guard.
    const frozenFollow =
      this.embeddedCharacterId ||
      (typeof window !== "undefined" &&
        (window as { __HYPERIA_ORIGINAL_FOLLOW__?: string })
          .__HYPERIA_ORIGINAL_FOLLOW__) ||
      null;
    if (frozenFollow) {
      return;
    }

    if (nextTargetId === this.spectatorFollowEntity) {
      return;
    }

    const previousTargetId = this.spectatorFollowEntity;
    this.spectatorFollowEntity = nextTargetId;
    this.spectatorTargetPending = true;

    if (typeof window !== "undefined") {
      const w = window as Window & {
        __HYPERIA_CONFIG__?: { followEntity?: string };
      };
      if (w.__HYPERIA_CONFIG__) {
        w.__HYPERIA_CONFIG__.followEntity = nextTargetId;
      }
    }

    this.logger.info(
      `👁️ Spectator retarget: ${previousTargetId || "none"} -> ${nextTargetId}`,
    );

    if (this.spectatorRetryInterval) {
      clearInterval(
        this.spectatorRetryInterval as ReturnType<typeof setInterval>,
      );
      this.spectatorRetryInterval = null;
    }

    const camera =
      (this.world.getSystem("client-camera-system") as
        { setTarget?: (target: unknown) => void } | undefined) ??
      (this.world.getSystem("client-camera") as
        { setTarget?: (target: unknown) => void } | undefined) ??
      (this.world.getSystem("camera") as
        { setTarget?: (target: unknown) => void } | undefined);

    const findTargetEntity = () =>
      this.resolveSpectatorTargetEntity(nextTargetId);

    const targetEntity = findTargetEntity();
    if (targetEntity && camera?.setTarget) {
      camera.setTarget(targetEntity);
      this.spectatorTargetPending = false;
      return;
    }

    let retryCount = 0;
    const MAX_RETRY_SECONDS = 10;
    this.spectatorRetryInterval = setInterval(() => {
      retryCount++;
      const resolvedEntity = findTargetEntity();

      if (resolvedEntity && camera?.setTarget) {
        camera.setTarget(resolvedEntity);
        this.spectatorTargetPending = false;
        if (this.spectatorRetryInterval) {
          clearInterval(
            this.spectatorRetryInterval as ReturnType<typeof setInterval>,
          );
          this.spectatorRetryInterval = null;
        }
        return;
      }

      if (retryCount >= MAX_RETRY_SECONDS) {
        if (this.spectatorRetryInterval) {
          clearInterval(
            this.spectatorRetryInterval as ReturnType<typeof setInterval>,
          );
          this.spectatorRetryInterval = null;
        }
      }
    }, 1000);
  };

  // Plugin-specific disconnect method
  async disconnect(): Promise<void> {
    // console.debug('[ClientNetwork] Disconnect called')
    // Mark as intentional disconnect to prevent reconnection
    this.intentionalDisconnect = true;
    this.cancelReconnect();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    return Promise.resolve();
  }
}
