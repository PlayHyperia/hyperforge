/**
 * Connection Handler Module - WebSocket connection management
 *
 * Handles incoming WebSocket connections including authentication,
 * snapshot creation, and player initialization.
 *
 * This is the most complex module in ServerNetwork as it orchestrates many systems:
 * - Authentication (Privy, JWT)
 * - Character system (loading character list)
 * - Resource system (sending resource snapshot)
 * - LiveKit (optional video chat integration)
 *
 * Responsibilities:
 * - Validate incoming connections
 * - Check player limit
 * - Authenticate users (URL param or first-message auth)
 * - Create and send initial snapshot
 * - Register socket in sockets map
 * - Emit player joined event
 *
 * SECURITY: Supports first-message authentication pattern
 * - If authToken is NOT in URL params, server waits for 'authenticate' packet
 * - This prevents token exposure in server logs, browser history, referrer headers
 * - See: handleDeferredAuthentication() for the first-message auth flow
 *
 * Usage:
 * ```typescript
 * const handler = new ConnectionHandler(world, sockets, broadcast, spawn);
 * await handler.handleConnection(ws, params);
 * ```
 */

import type { World } from "@hyperforge/shared";
import {
  Socket,
  EventType,
  getDuelArenaConfig,
  writePacket,
  readPacket,
  uuid,
  ALL_WORLD_AREAS,
} from "@hyperforge/shared";
import type {
  ConnectionParams,
  NodeWebSocket,
  ServerSocket,
  ResourceSystem,
  NetworkWithSocket,
  SystemDatabase,
} from "../../shared/types";
import { STREAMING_PUBLIC_DELAY_MS } from "../../streaming/streaming-policy.js";
import { resolveStreamingViewerAccessToken } from "../../streaming/stream-viewer-access-token.js";
import {
  AgentCredentialAuthenticationError,
  authenticateUser,
  checkUserBan,
  isLoadTestMode,
  PresentedCredentialAuthenticationError,
  verifyStreamingViewerCredentials,
} from "./authentication";
import { loadCharacterList } from "./character-selection";
import type { BroadcastManager } from "./broadcast";
import type { UwsWebSocketAdapter } from "../../startup/UwsWebSocketAdapter";
import type { SpatialIndex } from "./SpatialIndex";
import { errMsg } from "../../shared/errMsg.js";
import { isLoopbackAddress } from "./loopback-address.js";

/**
 * Format ban message for display to user
 *
 * @param banInfo - Ban information from checkUserBan
 * @returns Human-readable ban message
 */
function formatBanMessage(banInfo: {
  reason?: string;
  expiresAt?: number | null;
  bannedByName?: string;
}): string {
  let message = "You have been banned";

  if (banInfo.bannedByName) {
    message += ` by ${banInfo.bannedByName}`;
  }

  if (banInfo.reason) {
    message += `. Reason: ${banInfo.reason}`;
  }

  if (banInfo.expiresAt) {
    const now = new Date();
    const diffMs = banInfo.expiresAt - now.getTime();

    if (diffMs > 0) {
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffHours / 24);

      if (diffDays > 0) {
        message += `. Ban expires in ${diffDays} day${diffDays > 1 ? "s" : ""}`;
      } else if (diffHours > 0) {
        message += `. Ban expires in ${diffHours} hour${diffHours > 1 ? "s" : ""}`;
      } else {
        const diffMinutes = Math.floor(diffMs / (1000 * 60));
        message += `. Ban expires in ${diffMinutes} minute${diffMinutes > 1 ? "s" : ""}`;
      }
    }
  } else {
    message += ". This ban is permanent.";
  }

  return message;
}

const STREAMING_VIEWER_ACCESS_TOKEN = resolveStreamingViewerAccessToken();
const IS_PLAYWRIGHT_TEST = process.env.PLAYWRIGHT_TEST === "true";
let lastSpectatorTargetMissingWarnAt = 0;

/**
 * ConnectionHandler - Manages WebSocket connection flow
 *
 * Orchestrates the complex connection sequence from initial WebSocket
 * to fully-initialized player.
 */
export class ConnectionHandler {
  private spatialIndex: SpatialIndex | null = null;

  /**
   * Create a ConnectionHandler
   *
   * @param world - Game world instance
   * @param sockets - Map of active sockets (modified by reference)
   * @param broadcast - Broadcast manager for sending messages
   * @param db - Database instance for authentication
   */
  constructor(
    private world: World,
    private sockets: Map<string, ServerSocket>,
    private broadcast: BroadcastManager,
    private db: SystemDatabase,
    private spectatorsByPlayer: Map<string, Set<string>> = new Map(),
  ) {}

  /** Set spatial index for spectator region topic subscriptions. */
  setSpatialIndex(index: SpatialIndex): void {
    this.spatialIndex = index;
  }

  private isLoopbackWs(ws: NodeWebSocket): boolean {
    const rawAddress =
      ws.__remoteAddress ||
      (
        ws as NodeWebSocket & {
          _socket?: { remoteAddress?: string | null };
        }
      )._socket?.remoteAddress;

    if (!rawAddress) return false;
    return isLoopbackAddress(rawAddress);
  }

  private hasStreamingViewerAccessToken(params: ConnectionParams): boolean {
    if (!STREAMING_VIEWER_ACCESS_TOKEN) return false;
    return params.streamToken === STREAMING_VIEWER_ACCESS_TOKEN;
  }

  private hasStreamingBypassAccess(
    ws: NodeWebSocket,
    params: ConnectionParams,
  ): boolean {
    if (process.env.NODE_ENV === "development") return true;
    return this.hasStreamingViewerAccessToken(params) || this.isLoopbackWs(ws);
  }

  /**
   * Handle incoming WebSocket connection
   *
   * This is the main entry point for new connections. Performs the full
   * connection flow including validation, auth, terrain waiting, and snapshot.
   *
   * @param ws - WebSocket connection from client
   * @param params - Connection parameters (auth tokens, etc.)
   */
  async handleConnection(
    ws: NodeWebSocket,
    params: ConnectionParams,
  ): Promise<void> {
    try {
      // Validate WebSocket
      if (!ws || typeof ws.close !== "function") {
        console.error(
          "[ConnectionHandler] Invalid websocket provided to onConnection",
        );
        return;
      }

      // Check for spectator mode - spectators don't need authentication
      const isSpectator = params.mode === "spectator";

      if (isSpectator) {
        await this.handleSpectatorConnection(ws, params);
        return;
      }

      // Check for streaming mode - streaming viewers don't need authentication
      const isStreaming = params.mode === "streaming";

      if (isStreaming) {
        await this.handleStreamingConnection(ws, params);
        return;
      }

      // Check player limit (only for players, not spectators/streamers)
      if (!this.checkPlayerLimit(ws)) {
        return;
      }

      // Check if this is a load test bot (URL params come as strings)
      const loadTestBotParam = (params as { loadTestBot?: string | boolean })
        .loadTestBot;
      const requestedLoadTestBot =
        loadTestBotParam === "true" || loadTestBotParam === true;
      const isLoadTestBot = requestedLoadTestBot && isLoadTestMode();

      // SECURITY: Check if using first-message auth pattern (no authToken in URL)
      // This is the preferred pattern as it prevents token exposure in:
      // - Server logs (WebSocket URLs are often logged)
      // - Browser history
      // - Referrer headers
      const hasAuthTokenInUrl = Boolean(params.authToken);

      if (!hasAuthTokenInUrl && !isLoadTestBot) {
        // First-message auth: register pending connection and wait for authenticate packet
        await this.handleDeferredAuthentication(ws, params);
        return;
      }

      // Authenticate user (legacy: authToken in URL)
      const {
        user,
        authToken,
        agentCredentialCharacterId,
        agentCredentialSessionExpiresAt,
        agentCredentialSessionId,
        userWithPrivy,
      } = await authenticateUser(params, this.db);

      // SECURITY: Always check bans, even for load test bots in production
      // Only skip ban check if LOAD_TEST_MODE is explicitly enabled
      // This prevents attackers from bypassing bans by claiming to be load test bots
      const skipBanCheck = isLoadTestBot;

      if (!skipBanCheck) {
        // Check if user is banned
        const banInfo = await checkUserBan(user.id, this.db);
        if (banInfo.isBanned) {
          const banMessage = formatBanMessage(banInfo);
          console.log(
            `[ConnectionHandler] 🚫 Banned user ${user.id} (${user.name}) attempted to connect: ${banInfo.reason || "no reason"}`,
          );
          // Note: kick packet payload must be a string (client's onKick expects string code)
          const packet = writePacket("kick", `banned: ${banMessage}`);
          ws.send(packet);
          ws.close(4003, "Banned");
          return;
        }
      }

      // Get LiveKit options if available
      const livekit = await this.world.livekit?.getPlayerOpts?.(user.id);

      // Create socket
      const socket = this.createSocket(ws, user.id);
      socket.isLoadTestBot = isLoadTestBot;
      socket.agentCredentialCharacterId = agentCredentialCharacterId;
      socket.agentCredentialSessionId = agentCredentialSessionId;
      this.armAgentCredentialExpiry(socket, agentCredentialSessionExpiresAt);

      // Load character list
      const characters = await loadCharacterList(user.id, this.world);

      // Create and send snapshot
      await this.sendSnapshot(socket, {
        user,
        authToken,
        userWithPrivy,
        livekit,
        characters,
      });

      this.sendFireSnapshot(socket);

      // Send resource snapshot
      await this.sendResourceSnapshot(socket);

      // Clean up stale sockets for same account (sockets that lost connection but weren't cleaned up)
      // This handles edge cases like browser crashes or network drops where the old socket
      // is no longer alive but wasn't properly removed
      for (const [oldSocketId, oldSocket] of this.sockets) {
        if (
          oldSocket.accountId === socket.accountId &&
          oldSocketId !== socket.id
        ) {
          // Only remove if the old socket is dead (not alive)
          if (!oldSocket.alive) {
            console.log(
              `[ConnectionHandler] 🧹 Cleaning up stale socket ${oldSocketId} for account ${socket.accountId}`,
            );
            oldSocket.disconnect("stale_socket_cleanup");
          }
        }
      }

      // Register socket
      this.sockets.set(socket.id, socket);

      // Emit player joined event if player exists
      if (socket.player) {
        this.emitPlayerJoined(socket);
      }
    } catch (err) {
      if (
        err instanceof AgentCredentialAuthenticationError ||
        err instanceof PresentedCredentialAuthenticationError
      ) {
        console.warn("[ConnectionHandler] Rejected presented credential");
      } else {
        console.error("[ConnectionHandler] Error in handleConnection:", err);
      }
      try {
        const packet = writePacket("kick", "authentication_failed");
        ws.send(packet);
        ws.close(4001, "Authentication failed");
      } catch {
        // The transport may already be closed.
      }
    }
  }

  /**
   * Check if server has reached player limit
   *
   * Kicks connection if player limit is reached.
   *
   * @param ws - WebSocket to potentially kick
   * @returns True if connection can proceed, false if kicked
   * @private
   */
  private checkPlayerLimit(ws: NodeWebSocket): boolean {
    const playerLimit = this.world.settings.playerLimit;

    if (
      typeof playerLimit === "number" &&
      playerLimit > 0 &&
      this.sockets.size >= playerLimit
    ) {
      const packet = writePacket("kick", "player_limit");
      ws.send(packet);
      ws.close();
      return false;
    }

    return true;
  }

  /**
   * Create Socket instance for new connection
   *
   * @param ws - WebSocket connection
   * @param accountId - User account ID
   * @returns Configured ServerSocket
   * @private
   */
  private createSocket(ws: NodeWebSocket, accountId: string): ServerSocket {
    const socketId = uuid();

    const socket = new Socket({
      id: socketId,
      ws,
      network: this.world.network as unknown as NetworkWithSocket,
      player: undefined,
    }) as ServerSocket;
    socket.accountId = accountId;
    socket.createdAt = Date.now(); // Track creation time for reconnection grace period

    return socket;
  }

  private armAgentCredentialExpiry(
    socket: ServerSocket,
    expiresAt: string | undefined,
  ): void {
    if (!socket.agentCredentialSessionId || !expiresAt) return;
    const delayMs = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      socket.disconnect("agent_credentials_expired");
      return;
    }
    socket.agentCredentialExpiryTimeoutId = setTimeout(() => {
      socket.agentCredentialExpiryTimeoutId = undefined;
      try {
        socket.send("kick", "agent_credentials_expired");
      } finally {
        socket.disconnect("agent_credentials_expired");
      }
    }, delayMs);
    socket.agentCredentialExpiryTimeoutId.unref?.();
  }

  /**
   * Handle first-message authentication pattern
   *
   * SECURITY: This is the preferred auth pattern as it prevents token exposure in:
   * - Server logs (WebSocket URLs are often logged)
   * - Browser history
   * - Referrer headers
   *
   * Flow:
   * 1. Client connects without authToken in URL
   * 2. Server waits for 'authenticate' packet
   * 3. Client sends credentials in authenticate packet
   * 4. Server validates and completes connection
   * 5. Server sends authResult packet with success/failure
   *
   * @param ws - WebSocket connection
   * @param params - Connection parameters (without authToken)
   * @private
   */
  private async handleDeferredAuthentication(
    ws: NodeWebSocket,
    params: ConnectionParams,
  ): Promise<void> {
    const AUTH_TIMEOUT_MS = 30000; // 30 seconds to authenticate
    let authCompleted = false; // Guard against race conditions
    let isCleanedUp = false; // Prevent double cleanup

    // Error handler defined early so cleanup can reference it
    let errorHandler: ((err: Error) => void) | null = null;

    /**
     * SECURITY: Cleanup function to remove listeners and clear timeout.
     * Must be called from all exit paths to prevent resource leaks.
     */
    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      clearTimeout(authTimeout);
      try {
        ws.removeListener?.("message", messageHandler);
        ws.removeListener?.("close", closeHandler);
        if (errorHandler) {
          ws.removeListener?.("error", errorHandler);
        }
      } catch {
        // Ignore errors during cleanup (socket may be closing)
      }
    };

    // Set up timeout for authentication
    const authTimeout = setTimeout(() => {
      // SECURITY: Check if auth already completed to avoid race condition
      if (authCompleted) return;
      authCompleted = true;

      console.warn(
        "[ConnectionHandler] ⏱️ Authentication timeout - closing connection",
      );

      // Cleanup first to prevent message handler from firing
      cleanup();

      try {
        const packet = writePacket("authResult", {
          success: false,
          error: "Authentication timeout",
        });
        ws.send(packet);
        ws.close(4001, "Authentication timeout");
      } catch {
        // Socket may already be closed
      }
    }, AUTH_TIMEOUT_MS);

    // Set up message handler for authenticate packet
    // NOTE: ws package calls handler with (data, isBinary) signature
    const messageHandler = (
      message: ArrayBuffer | Buffer,
      _isBinary?: boolean,
    ) => {
      // Handle async logic inside
      (async () => {
        // SECURITY: Guard against race condition with timeout
        if (authCompleted) return;

        try {
          // Convert Buffer to ArrayBuffer if needed
          const buffer =
            message instanceof ArrayBuffer
              ? message
              : new Uint8Array(message).buffer;

          const [method, data] = readPacket(new Uint8Array(buffer));

          // Only handle authenticate packet.
          // readPacket can return either legacy "authenticate" or current
          // method-style "onAuthenticate" depending on packet codec version.
          if (method !== "authenticate" && method !== "onAuthenticate") {
            return;
          }

          // Mark as completed to prevent timeout from firing
          authCompleted = true;

          // Cleanup timeout and listeners
          cleanup();

          // Remove message handler
          ws.removeListener?.("message", messageHandler);

          // Extract auth credentials from packet
          const authData = data as {
            authToken?: string;
            privyUserId?: string;
            name?: string;
            avatar?: string;
          };

          const allowAnonymousDeferredAuth =
            process.env.PLAYWRIGHT_TEST === "true";

          if (!authData.authToken && !allowAnonymousDeferredAuth) {
            console.warn(
              "[ConnectionHandler] ❌ Authenticate packet missing authToken",
            );
            const packet = writePacket("authResult", {
              success: false,
              error: "Missing authentication token",
            });
            ws.send(packet);
            ws.close(4001, "Missing authentication token");
            return;
          }

          if (!authData.authToken && allowAnonymousDeferredAuth) {
            console.log(
              "[ConnectionHandler] ℹ️ Authenticate packet missing authToken; allowing anonymous fallback in PLAYWRIGHT_TEST",
            );
          }

          // Merge auth data with original params
          const authParams: ConnectionParams = {
            ...params,
            authToken: authData.authToken || "",
            privyUserId: authData.privyUserId,
            name: authData.name || params.name,
            avatar: authData.avatar || params.avatar,
          };

          // Authenticate user
          const {
            user,
            authToken,
            agentCredentialCharacterId,
            agentCredentialSessionExpiresAt,
            agentCredentialSessionId,
            userWithPrivy,
          } = await authenticateUser(authParams, this.db);

          // Check if user is banned
          const banInfo = await checkUserBan(user.id, this.db);
          if (banInfo.isBanned) {
            const banMessage = formatBanMessage(banInfo);
            console.log(
              `[ConnectionHandler] 🚫 Banned user ${user.id} (${user.name}) attempted to connect: ${banInfo.reason || "no reason"}`,
            );
            const packet = writePacket("authResult", {
              success: false,
              error: `banned: ${banMessage}`,
            });
            ws.send(packet);
            ws.close(4003, "Banned");
            return;
          }

          // Send auth success
          const successPacket = writePacket("authResult", {
            success: true,
          });
          ws.send(successPacket);

          console.log(
            `[ConnectionHandler] ✅ First-message auth successful for user ${user.id} (${user.name})`,
          );

          // Get LiveKit options if available
          const livekit = await this.world.livekit?.getPlayerOpts?.(user.id);

          // Create socket
          const socket = this.createSocket(ws, user.id);
          socket.agentCredentialCharacterId = agentCredentialCharacterId;
          socket.agentCredentialSessionId = agentCredentialSessionId;
          this.armAgentCredentialExpiry(
            socket,
            agentCredentialSessionExpiresAt,
          );

          // Load character list
          const characters = await loadCharacterList(user.id, this.world);

          // Create and send snapshot
          await this.sendSnapshot(socket, {
            user,
            authToken,
            userWithPrivy,
            livekit,
            characters,
          });

          this.sendFireSnapshot(socket);

          // Send resource snapshot
          await this.sendResourceSnapshot(socket);

          // Clean up stale sockets for same account
          for (const [oldSocketId, oldSocket] of this.sockets) {
            if (
              oldSocket.accountId === socket.accountId &&
              oldSocketId !== socket.id
            ) {
              if (!oldSocket.alive) {
                console.log(
                  `[ConnectionHandler] 🧹 Cleaning up stale socket ${oldSocketId} for account ${socket.accountId}`,
                );
                oldSocket.disconnect("stale_socket_cleanup");
              }
            }
          }

          // Register socket
          this.sockets.set(socket.id, socket);

          // Emit player joined event if player exists
          if (socket.player) {
            this.emitPlayerJoined(socket);
          }
        } catch (err) {
          // Ensure cleanup on error
          cleanup();
          if (
            err instanceof AgentCredentialAuthenticationError ||
            err instanceof PresentedCredentialAuthenticationError
          ) {
            console.warn("[ConnectionHandler] Rejected presented credential");
          } else {
            console.error(
              "[ConnectionHandler] Error in deferred authentication:",
              err,
            );
          }
          try {
            const packet = writePacket("authResult", {
              success: false,
              error: "Authentication failed",
            });
            ws.send(packet);
            ws.close(4001, "Authentication failed");
          } catch {
            // Socket may already be closed
          }
        }
      })(); // End of async IIFE
    };

    // Set up close handler to clean up on early disconnect
    const closeHandler = () => {
      cleanup();
    };

    // Error handler (assigned to variable defined earlier for cleanup)
    errorHandler = (err: Error) => {
      console.error("[ConnectionHandler] WebSocket error during auth:", err);
    };

    // Register message, close, and error handlers
    ws.on("error", errorHandler);
    ws.on("message", messageHandler);
    ws.on("close", closeHandler);

    console.log(
      "[ConnectionHandler] Waiting for first-message authentication...",
    );
  }

  /**
   * Create and send initial snapshot to client
   *
   * The snapshot contains everything the client needs to render the world:
   * server time, settings, chat, entities, character list, etc.
   *
   * @param socket - Socket to send snapshot to
   * @param data - Snapshot data from connection flow
   * @private
   */
  private async sendSnapshot(
    socket: ServerSocket,
    data: {
      user: { id: string; name: string };
      authToken?: string;
      userWithPrivy?: { privyUserId?: string | null };
      livekit?: unknown;
      characters: unknown[];
    },
  ): Promise<void> {
    const baseSnapshot = {
      id: socket.id,
      serverTime: performance.now(),
      worldTime: this.world.getTime(), // Synced world time for day/night cycle
      assetsUrl: this.world.assetsUrl,
      apiUrl: process.env.PUBLIC_API_URL,
      maxUploadSize: process.env.PUBLIC_MAX_UPLOAD_SIZE,
      settings: this.world.settings.serialize() || {},
      chat: this.world.chat.serialize() || [],
      entities: this.serializeEntities(socket),
      livekit: data.livekit,
      authToken: data.authToken || "",
      account: {
        accountId: data.user.id,
        name: data.user.name,
        providers: {
          privyUserId: data.userWithPrivy?.privyUserId || null,
        },
      },
      characters: data.characters,
      worldMap: this.serializeWorldMap(),
    };

    socket.send("snapshot", baseSnapshot);
  }

  /**
   * Serialize world map data for snapshot
   *
   * Provides lightweight location data so agents and clients can
   * navigate to distant locations without needing to discover them.
   * Includes towns, POIs, and manifest-driven resources/stations/NPCs
   * from ALL_WORLD_AREAS so agents have full world awareness.
   */
  private serializeWorldMap(): {
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
  } {
    const result: ReturnType<ConnectionHandler["serializeWorldMap"]> = {
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
        const towns = townSystem.getTowns();
        result.towns = towns.map((t) => ({
          id: t.id,
          name: t.name,
          position: { x: t.position.x, y: t.position.y, z: t.position.z },
          size: t.size,
          biome: t.biome,
          buildings: t.buildings.map((b) => ({ type: b.type })),
        }));
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
        const pois = poiSystem.getPOIs();
        result.pois = pois.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          position: { x: p.position.x, y: p.position.y, z: p.position.z },
          biome: p.biome,
        }));
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

    return result;
  }

  /**
   * Serialize all entities for snapshot
   *
   * Returns array of serialized entities, with player's own entity first
   * if they have one.
   *
   * @param socket - Socket requesting snapshot
   * @returns Array of serialized entities
   * @private
   */
  private serializeEntities(socket: ServerSocket): unknown[] {
    const allEntities: unknown[] = [];
    const isSpectator = socket.isSpectator === true;
    const duelParticipantIds = new Set(
      socket.spectatingDuelParticipantIds || [],
    );

    if (isSpectator) {
      // Spectators don't have a player entity. Prioritize focused snapshots
      // around the followed character to reduce join-time payload size.
      const followEntityId = socket.spectatingCharacterId;
      const followPos = this.getSpectatorFocusXZ(
        followEntityId,
        duelParticipantIds,
      );
      const radius = Number(process.env.SPECTATOR_SNAPSHOT_RADIUS || 110);
      const effectiveRadius = Number.isFinite(radius)
        ? Math.max(50, radius)
        : 110;
      const radiusSq = effectiveRadius * effectiveRadius;

      // Include both world items AND player entities — players live in a
      // separate collection and were previously missing from spectator snapshots,
      // which prevented the camera from ever locking to the followed agent.
      const entityCollections = [
        this.world.entities?.items,
        this.world.entities?.players,
      ].filter(Boolean) as Map<
        string,
        {
          id: string;
          data?: Record<string, unknown>;
          serialize: () => unknown;
          position?: unknown;
        }
      >[];
      for (const collection of entityCollections) {
        for (const [_entityId, entity] of (
          collection as Map<
            string,
            {
              id: string;
              data?: Record<string, unknown>;
              serialize: () => unknown;
              position?: unknown;
            }
          >
        ).entries()) {
          if (
            !this.shouldIncludeSpectatorEntity(
              entity as Parameters<typeof this.shouldIncludeSpectatorEntity>[0],
              followEntityId,
              duelParticipantIds,
              followPos,
              radiusSq,
            )
          ) {
            continue;
          }

          const serialized = (
            entity as { serialize: () => unknown }
          ).serialize() as Record<string, unknown>;
          this.applyAuthoritativeTransformSnapshot(entity, serialized, {
            groundPlayersToTerrain: true,
          });
          allEntities.push(serialized);
        }
      }
    } else if (socket.player) {
      // Normal players: serialize their player first, then other entities
      const selfSerialized = socket.player.serialize();
      this.applyAuthoritativeTransformSnapshot(socket.player, selfSerialized, {
        groundPlayersToTerrain: false,
      });
      allEntities.push(selfSerialized);

      if (this.world.entities?.items) {
        for (const [entityId, entity] of this.world.entities.items.entries()) {
          if (entityId !== socket.player.id) {
            const serialized = entity.serialize();
            this.applyAuthoritativeTransformSnapshot(entity, serialized, {
              groundPlayersToTerrain: false,
            });
            allEntities.push(serialized);
          }
        }
      }
    }

    return allEntities;
  }

  /**
   * Ensure snapshots use authoritative server transform when tile movement keeps
   * the latest coordinates in entity.data instead of node transform.
   */
  private applyAuthoritativeTransformSnapshot(
    entity: unknown,
    serialized: Record<string, unknown>,
    options: {
      groundPlayersToTerrain?: boolean;
    } = {},
  ): void {
    const data = (entity as { data?: Record<string, unknown> })?.data;
    if (!data) return;

    const shouldGroundPlayer =
      options.groundPlayersToTerrain === true &&
      (entity as { type?: string })?.type === "player";

    const dataPos = data.position as
      | [number, number, number]
      | { x: number; y?: number; z: number }
      | undefined;
    if (Array.isArray(dataPos) && dataPos.length >= 3) {
      let [x, y, z] = dataPos;
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        if (shouldGroundPlayer) {
          y = this.getGroundedSpectatorY(x, z, y);
        }
        serialized.position = [x, y, z];
      }
    } else if (dataPos && typeof dataPos === "object") {
      const x = (dataPos as { x?: number }).x;
      let y = (dataPos as { y?: number }).y;
      const z = (dataPos as { z?: number }).z;
      if (Number.isFinite(x) && Number.isFinite(z)) {
        let safeY = (y as number) || 0;
        if (shouldGroundPlayer) {
          safeY = this.getGroundedSpectatorY(x as number, z as number, safeY);
        }
        serialized.position = [x as number, safeY, z as number];
      }
    }

    const dataQuat = data.quaternion as
      [number, number, number, number] | undefined;
    if (Array.isArray(dataQuat) && dataQuat.length >= 4) {
      const [x, y, z, w] = dataQuat;
      if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(z) &&
        Number.isFinite(w)
      ) {
        serialized.quaternion = [x, y, z, w];
      }
    }
  }

  /**
   * Spectator-only safety: clamp wildly invalid player Y to terrain so
   * camera follow never anchors below the world due stale server coordinates.
   */
  private getGroundedSpectatorY(
    x: number,
    z: number,
    currentY: number,
  ): number {
    const terrain = this.world.getSystem("terrain") as {
      getHeightAt?: (x: number, z: number) => number;
    } | null;

    const terrainY = terrain?.getHeightAt?.(x, z);
    if (typeof terrainY !== "number" || !Number.isFinite(terrainY)) {
      return currentY;
    }

    if (currentY < terrainY - 1.5 || currentY > terrainY + 80) {
      return terrainY + 0.1;
    }

    return currentY;
  }

  private getEntityXZ(entity: unknown): { x: number; z: number } | null {
    if (!entity || typeof entity !== "object") return null;
    const maybePosition =
      (
        entity as {
          data?: {
            position?:
              [number, number, number] | { x?: number; y?: number; z?: number };
          };
          position?:
            [number, number, number] | { x?: number; y?: number; z?: number };
        }
      ).data?.position ??
      (
        entity as {
          position?:
            [number, number, number] | { x?: number; y?: number; z?: number };
        }
      ).position;

    if (Array.isArray(maybePosition) && maybePosition.length >= 3) {
      const x = Number(maybePosition[0]);
      const z = Number(maybePosition[2]);
      if (Number.isFinite(x) && Number.isFinite(z)) {
        return { x, z };
      }
    } else if (maybePosition && typeof maybePosition === "object") {
      const x = Number((maybePosition as { x?: number }).x);
      const z = Number((maybePosition as { z?: number }).z);
      if (Number.isFinite(x) && Number.isFinite(z)) {
        return { x, z };
      }
    }

    return null;
  }

  /**
   * Find a live entity by network id OR database character id.
   * Spectator `followEntity` / `spectatingCharacterId` is often the character UUID;
   * world maps are keyed by network entity id, so direct `.get(uuid)` misses the player.
   */
  private findEntityBySpectatorKey(
    entityOrCharacterId: string | undefined,
  ): unknown | undefined {
    if (!entityOrCharacterId) return undefined;
    const items = this.world.entities?.items;
    const players = this.world.entities?.players;

    const direct =
      items?.get(entityOrCharacterId) ?? players?.get(entityOrCharacterId);
    if (direct) return direct;

    const scan = (map: Map<string, unknown> | undefined) => {
      if (!map) return undefined;
      for (const [, entity] of map.entries()) {
        const e = entity as {
          id?: string;
          data?: { characterId?: string; id?: string };
        };
        if (
          e.id === entityOrCharacterId ||
          e.data?.characterId === entityOrCharacterId ||
          e.data?.id === entityOrCharacterId
        ) {
          return entity;
        }
      }
      return undefined;
    };

    return (
      scan(items as Map<string, unknown> | undefined) ??
      scan(players as Map<string, unknown> | undefined)
    );
  }

  /**
   * Resolve spectator snapshot focus position.
   *
   * Order:
   * 1. Explicit follow target position
   * 2. Active duel participant position
   * 3. Duel lobby center (safe bounded fallback)
   */
  private getSpectatorFocusXZ(
    followEntityId: string | undefined,
    duelParticipantIds: Set<string>,
  ): { x: number; z: number } | null {
    if (followEntityId) {
      const followEntity = this.findEntityBySpectatorKey(followEntityId);
      const followPos = this.getEntityXZ(followEntity);
      if (followPos) {
        return followPos;
      }
    }

    for (const participantId of duelParticipantIds) {
      const participant = this.findEntityBySpectatorKey(participantId);
      const participantPos = this.getEntityXZ(participant);
      if (participantPos) {
        return participantPos;
      }
    }

    const lobby = getDuelArenaConfig().lobbySpawnPoint;
    if (Number.isFinite(lobby.x) && Number.isFinite(lobby.z)) {
      return { x: lobby.x, z: lobby.z };
    }

    return null;
  }

  private shouldIncludeSpectatorEntity(
    entity: unknown,
    followEntityId: string | undefined,
    duelParticipantIds: Set<string>,
    followPos: { x: number; z: number } | null,
    radiusSq: number,
  ): boolean {
    if (!followPos) return true;

    const data = (entity as { data?: Record<string, unknown> }).data;
    const id = (entity as { id?: string }).id;
    const dataCharacterId =
      typeof data?.characterId === "string" ? data.characterId : undefined;
    const dataId = typeof data?.id === "string" ? data.id : undefined;

    // Always include explicit follow target and active duel contestants.
    // followEntityId may be character UUID while entity.id is network id — match both.
    if (followEntityId) {
      if (
        id === followEntityId ||
        dataCharacterId === followEntityId ||
        dataId === followEntityId
      ) {
        return true;
      }
    }
    if (
      id &&
      (duelParticipantIds.has(id) ||
        (dataCharacterId && duelParticipantIds.has(dataCharacterId)))
    ) {
      return true;
    }
    if (data?.inStreamingDuel === true) return true;

    const pos = this.getEntityXZ(entity);
    if (!pos) {
      // Keep non-spatial entities and edge cases.
      return true;
    }

    const dx = pos.x - followPos.x;
    const dz = pos.z - followPos.z;
    return dx * dx + dz * dz <= radiusSq;
  }

  private entityExists(entityId: string | undefined): boolean {
    if (!entityId) return false;
    return Boolean(this.findEntityBySpectatorKey(entityId));
  }

  private findAnySpectatableAgentId(): string | undefined {
    const players = this.world.entities?.players;
    if (players) {
      for (const [id, entity] of players.entries()) {
        const data = (entity as { data?: { isAgent?: boolean | number } }).data;
        if (
          id.startsWith("agent-") ||
          data?.isAgent === true ||
          data?.isAgent === 1
        ) {
          return id;
        }
      }
    }

    const entities = this.world.entities?.items;
    if (entities) {
      for (const [id, entity] of entities.entries()) {
        const typed = entity as {
          type?: string;
          data?: { isAgent?: boolean | number };
        };
        if (
          typed.type === "player" &&
          (id.startsWith("agent-") ||
            typed.data?.isAgent === true ||
            typed.data?.isAgent === 1)
        ) {
          return id;
        }
      }
    }

    return undefined;
  }

  private async getStreamingFollowContext(): Promise<{
    cameraTarget: string | undefined;
    contestants: string[];
    phase: string | undefined;
  }> {
    try {
      const { getStreamingDuelScheduler } =
        await import("../StreamingDuelScheduler/index.js");
      const scheduler = getStreamingDuelScheduler();
      const state = scheduler?.getStreamingState();
      const cycle = state?.cycle as
        | {
            phase?: string;
            agent1?: { id?: string } | null;
            agent2?: { id?: string } | null;
          }
        | undefined;

      const contestants = [
        cycle?.agent1?.id || undefined,
        cycle?.agent2?.id || undefined,
      ].filter((id): id is string => typeof id === "string" && id.length > 0);

      const cameraTarget =
        state?.cameraTarget || contestants[0] || contestants[1] || undefined;

      return {
        cameraTarget,
        contestants: Array.from(new Set(contestants)),
        phase: cycle?.phase,
      };
    } catch (err) {
      console.warn(
        "[ConnectionHandler] Failed to resolve streaming follow context:",
        errMsg(err),
      );
      return { cameraTarget: undefined, contestants: [], phase: undefined };
    }
  }

  /**
   * Send resource snapshot to client
   *
   * Provides current state of all resources (trees, rocks, etc.) including
   * availability and respawn times.
   *
   * @param socket - Socket to send resource snapshot to
   * @private
   */
  private async sendResourceSnapshot(socket: ServerSocket): Promise<void> {
    try {
      const resourceSystem = this.world.getSystem?.("resource") as
        ResourceSystem | undefined;
      const resources = resourceSystem?.getAllResources?.() || [];

      const payload = {
        resources: resources.map((r) => ({
          id: r.id,
          type: r.type,
          position: r.position,
          isAvailable: r.isAvailable,
          respawnAt:
            !r.isAvailable && r.lastDepleted && r.respawnTime
              ? r.lastDepleted + r.respawnTime
              : undefined,
        })),
      };

      this.broadcast.sendToSocket(socket.id, "resourceSnapshot", payload);
    } catch {
      // Resource system not available or error, skip
    }
  }

  /** Send authoritative active fires directly, including sockets not registered yet. */
  private sendFireSnapshot(socket: ServerSocket): void {
    try {
      const processing = this.world.getSystem?.("processing") as
        | {
            getActiveFirePayloads?: () => Array<{
              fireId: string;
              playerId: string;
              position: { x: number; y: number; z: number };
              createdAt: number;
              expiresAt: number;
            }>;
          }
        | undefined;
      for (const fire of processing?.getActiveFirePayloads?.() ?? []) {
        socket.send("fireCreated", {
          ...fire,
          serverObservedAt: Date.now(),
        });
      }
    } catch (error) {
      console.error(
        "[ConnectionHandler] Failed to send active fire snapshot:",
        error,
      );
    }
  }

  /**
   * Emit player joined event and broadcast to other clients
   *
   * Notifies all systems that a player has joined and broadcasts
   * their entity to other connected players.
   *
   * @param socket - Socket that joined
   * @private
   */
  private emitPlayerJoined(socket: ServerSocket): void {
    const playerId = socket.player!.data.id as string;
    const userId = socket.characterId || undefined;

    this.world.emit(EventType.PLAYER_JOINED, {
      playerId,
      userId,
      player:
        socket.player as unknown as import("@hyperforge/shared").PlayerLocal,
    });

    try {
      this.broadcast.sendToAll(
        "entityAdded",
        socket.player!.serialize(),
        socket.id,
      );
    } catch (err) {
      console.error(
        "[ConnectionHandler] Failed to broadcast entityAdded for new player:",
        err,
      );
    }
  }

  /**
   * Handle spectator connection
   *
   * Spectators are read-only connections that don't spawn players.
   * They receive entity updates but cannot send commands.
   *
   * SECURITY: Spectators must authenticate via JWT/Privy token to prove identity.
   * The server verifies the token and checks character ownership - we never trust
   * client-provided user IDs directly.
   *
   * @param ws - WebSocket connection
   * @param params - Connection parameters
   * @private
   */
  private async handleSpectatorConnection(
    ws: NodeWebSocket,
    params: ConnectionParams,
  ): Promise<void> {
    try {
      const requestedCharacterId = params.followEntity || params.characterId;
      const streamingContext = await this.getStreamingFollowContext();
      let characterId =
        requestedCharacterId ||
        streamingContext.cameraTarget ||
        streamingContext.contestants[0];

      if (!characterId) {
        const fallbackAgentId = this.findAnySpectatableAgentId();
        if (fallbackAgentId) {
          characterId = fallbackAgentId;
          console.log(
            `[ConnectionHandler] 👁️ Spectator fallback to live agent target: ${characterId}`,
          );
        }
      }

      if (!requestedCharacterId && characterId) {
        console.log(
          `[ConnectionHandler] 👁️ Spectator defaulting to active camera target: ${characterId}`,
        );
      }

      // SECURITY: Require character ID
      if (!characterId) {
        const now = Date.now();
        if (
          !IS_PLAYWRIGHT_TEST ||
          now - lastSpectatorTargetMissingWarnAt > 15000
        ) {
          lastSpectatorTargetMissingWarnAt = now;
          console.warn(
            "[ConnectionHandler] ❌ Spectator missing characterId/followEntity and no live fallback target",
          );
        }
        ws.close(4000, "No spectatable character available");
        return;
      }

      // Get database system for character lookup
      const databaseSystem = this.world.getSystem("database") as
        import("../DatabaseSystem").DatabaseSystem | undefined;

      if (!databaseSystem) {
        console.error(
          "[ConnectionHandler] ❌ DatabaseSystem not available for character lookup",
        );
        ws.close(5000, "Server error");
        return;
      }

      // Check if target character is an agent - agents can be spectated anonymously
      const targetCharacter = await databaseSystem
        .getDb()
        ?.query?.characters?.findFirst?.({
          where: (chars, ops) => ops.eq(chars.id, characterId),
        })
        .catch(() => null);

      const isAgentCharacter =
        targetCharacter?.isAgent === 1 || characterId.startsWith("agent-");

      // Spectator streams should stay focused on active duel participants —
      // BUT only for *anonymous/public* streaming views that did NOT explicitly
      // request a specific character.  Any viewer who supplied followEntity/characterId
      // in their URL params is deliberately watching a chosen agent and must never be
      // silently redirected to whoever happens to be duelling right now.
      // NOTE: authToken is intentionally NOT included in the WebSocket URL for embedded
      // spectators (see EmbeddedGameClient "SECURITY" comment) — agents can be watched
      // anonymously via the "trusted viewer path", so requiring authToken here would
      // always make this false for dashboard viewfinders, causing the pivot bug.
      const isExplicitDashboardSpectator = !!requestedCharacterId;

      if (
        isAgentCharacter &&
        streamingContext.contestants.length > 0 &&
        !isExplicitDashboardSpectator
      ) {
        const activeContestants = new Set(streamingContext.contestants);
        const targetIsLive = this.entityExists(characterId);
        const targetInActiveDuel = activeContestants.has(characterId);

        if (!targetIsLive || !targetInActiveDuel) {
          const fallbackTarget =
            streamingContext.cameraTarget || streamingContext.contestants[0];
          if (fallbackTarget && fallbackTarget !== characterId) {
            console.log(
              `[ConnectionHandler] 👁️ Spectator target ${characterId} is stale/non-duel; switching to active duel target ${fallbackTarget}`,
            );
            characterId = fallbackTarget;
          }
        }
      }

      const requiresRestrictedAccess = STREAMING_PUBLIC_DELAY_MS > 0;
      const canBypassAgentAuth = this.hasStreamingBypassAccess(ws, params);
      const shouldRequireAuthForAgent =
        isAgentCharacter && requiresRestrictedAccess && !canBypassAgentAuth;

      // Keep verifiedUserId in the outer scope because the authenticated
      // account id is reused later when the spectator socket is registered.
      let verifiedUserId: string | null = null;

      if (isAgentCharacter && !shouldRequireAuthForAgent) {
        console.log(
          `[ConnectionHandler] 🤖 Anonymous spectator watching agent ${characterId} (trusted viewer path)`,
        );
      } else {
        // SECURITY: Require authentication token for non-agent spectating and delayed public agent spectating.
        if (!params.authToken) {
          console.warn(
            isAgentCharacter
              ? "[ConnectionHandler] ❌ Spectator missing authToken or trusted stream access for delayed agent spectating"
              : "[ConnectionHandler] ❌ Spectator missing authToken for authentication (target is not an agent)",
          );
          ws.close(4001, "Authentication required for spectator mode");
          return;
        }

        // SECURITY: Authenticate the user via the same flow as regular connections.
        try {
          const { user } = await authenticateUser(params, this.db);
          verifiedUserId = user.id;
          console.log(
            `[ConnectionHandler] 🔐 Spectator authenticated as: ${verifiedUserId}`,
          );
        } catch (authErr) {
          console.warn(
            "[ConnectionHandler] ❌ Spectator authentication failed:",
            authErr,
          );
          ws.close(4001, "Authentication failed");
          return;
        }

        if (!verifiedUserId) {
          console.warn(
            "[ConnectionHandler] ❌ Spectator authentication returned no user",
          );
          ws.close(4001, "Authentication failed");
          return;
        }

        if (!isAgentCharacter) {
          // SECURITY: Verify this character belongs to the authenticated user.
          const characters =
            await databaseSystem.getCharactersAsync(verifiedUserId);
          const ownsCharacter = characters.some((c) => c.id === characterId);

          if (!ownsCharacter) {
            console.warn(
              `[ConnectionHandler] ❌ SECURITY: Verified user ${verifiedUserId} does not own character ${characterId}. Rejecting spectator.`,
            );
            ws.close(
              4003,
              "Permission denied - character not owned by this account",
            );
            return;
          }

          console.log(
            `[ConnectionHandler] ✅ Spectator ownership verified: ${verifiedUserId} owns ${characterId}`,
          );
        } else {
          console.log(
            `[ConnectionHandler] ✅ Authenticated spectator watching agent ${characterId}`,
          );
        }
      }

      // Create socket for spectator
      const socketId = uuid();

      const socket = new Socket({
        id: socketId,
        ws,
        network: this.world.network as unknown as NetworkWithSocket,
        player: undefined,
      }) as ServerSocket;

      // Mark as spectator (accountId may be undefined for anonymous agent spectating)
      socket.accountId = isAgentCharacter
        ? undefined
        : (verifiedUserId ?? undefined);
      socket.createdAt = Date.now();
      socket.isSpectator = true;
      socket.spectatingCharacterId = characterId;
      socket.spectatingDuelParticipantIds = streamingContext.contestants;

      // Send snapshot to spectator (no character list, no auth token)
      await this.sendSpectatorSnapshot(socket, {
        ...params,
        followEntity: characterId,
        characterId,
      });

      this.sendFireSnapshot(socket);

      // Send resource snapshot
      await this.sendResourceSnapshot(socket);

      // Register spectator socket
      this.sockets.set(socket.id, socket);

      // Index for fast region-subscription updates
      if (characterId) {
        let set = this.spectatorsByPlayer.get(characterId);
        if (!set) {
          set = new Set();
          this.spectatorsByPlayer.set(characterId, set);
        }
        set.add(socket.id);
      }

      // Subscribe to pub/sub topics for spectator broadcasting
      this.subscribeSpectatorTopics(socket, characterId);

      // Send inventory of spectated character to spectator
      await this.sendSpectatorInventory(socket, characterId);
    } catch (err) {
      console.error(
        "[ConnectionHandler] Error in handleSpectatorConnection:",
        err,
      );
    }
  }

  /**
   * Send inventory data of spectated character to spectator socket
   */
  private async sendSpectatorInventory(
    socket: ServerSocket,
    characterId: string,
  ): Promise<void> {
    try {
      const invSystem = this.world.getSystem?.("inventory") as
        | {
            getInventoryData?: (id: string) => {
              items: unknown[];
              coins: number;
              maxSlots: number;
            };
            isInventoryReady?: (id: string) => boolean;
          }
        | undefined;

      // Wait a bit for inventory to be ready if loading
      if (
        invSystem?.isInventoryReady &&
        !invSystem.isInventoryReady(characterId)
      ) {
        // Wait up to 2 seconds for inventory to be ready
        for (let i = 0; i < 20; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (invSystem.isInventoryReady(characterId)) break;
        }
      }

      const inv = invSystem?.getInventoryData
        ? invSystem.getInventoryData(characterId)
        : { items: [], coins: 0, maxSlots: 28 };

      const packet = {
        playerId: characterId,
        items: inv.items,
        coins: inv.coins,
        maxSlots: inv.maxSlots,
      };

      console.log(
        `[ConnectionHandler] Sending inventory to spectator ${socket.id} for character ${characterId}: ${inv.items.length} items`,
      );

      socket.send("inventoryUpdated", packet);
    } catch (err) {
      console.error(
        "[ConnectionHandler] Error sending spectator inventory:",
        err,
      );
    }
  }

  /**
   * Handle streaming mode connection
   *
   * Streaming mode is for public viewing of AI agent duels.
   * No authentication required - this is public entertainment content.
   *
   * @param ws - WebSocket connection
   * @param params - Connection parameters
   * @private
   */
  private async handleStreamingConnection(
    ws: NodeWebSocket,
    params: ConnectionParams,
  ): Promise<void> {
    try {
      const requiresRestrictedAccess = STREAMING_PUBLIC_DELAY_MS > 0;
      if (requiresRestrictedAccess) {
        const bypassSync = this.hasStreamingBypassAccess(ws, params);
        const bypassAuth = bypassSync
          ? true
          : await verifyStreamingViewerCredentials(params, this.db);
        if (!bypassSync && !bypassAuth) {
          console.warn(
            "[ConnectionHandler] 🚫 Rejected public streaming websocket: delayed public mode requires dev, loopback, streamToken, or verified login",
          );
          ws.close(4001, "Streaming viewer access denied");
          return;
        }
      }

      console.log("[ConnectionHandler] 📺 Streaming viewer connecting...");

      // Create socket for streaming viewer
      const socketId = uuid();

      const socket = new Socket({
        id: socketId,
        ws,
        network: this.world.network as unknown as NetworkWithSocket,
        player: undefined,
      }) as ServerSocket;

      // Mark as streaming viewer
      socket.createdAt = Date.now();
      socket.isSpectator = true; // Reuse spectator flag for similar behavior
      socket.isStreamingViewer = true;

      // Send streaming snapshot (similar to spectator but no follow entity)
      await this.sendStreamingSnapshot(socket);

      this.sendFireSnapshot(socket);

      // Send resource snapshot
      await this.sendResourceSnapshot(socket);

      // Register streaming viewer socket
      this.sockets.set(socket.id, socket);

      // Subscribe to pub/sub topics for spectator broadcasting
      const followCharId = socket.spectatingCharacterId;
      if (followCharId) {
        this.subscribeSpectatorTopics(socket, followCharId);
      } else {
        // Streaming viewer with no specific follow target — just subscribe spectator topic
        const adapter = this.getUwsAdapter(socket);
        if (adapter) {
          adapter.subscribe("spectator");
        }
      }

      console.log(
        `[ConnectionHandler] 📺 Streaming viewer connected: ${socketId}`,
      );
    } catch (err) {
      console.error(
        "[ConnectionHandler] Error in handleStreamingConnection:",
        err,
      );
    }
  }

  /**
   * Create and send streaming mode snapshot
   *
   * Streaming viewers receive world state but no player-specific data.
   *
   * @param socket - Streaming viewer socket
   * @private
   */
  private async sendStreamingSnapshot(socket: ServerSocket): Promise<void> {
    const streamingContext = await this.getStreamingFollowContext();
    const followEntity =
      streamingContext.cameraTarget || streamingContext.contestants[0];

    if (followEntity) {
      socket.spectatingCharacterId = followEntity;
      // Update spectator index
      let set = this.spectatorsByPlayer.get(followEntity);
      if (!set) {
        set = new Set();
        this.spectatorsByPlayer.set(followEntity, set);
      }
      set.add(socket.id);
    }
    socket.spectatingDuelParticipantIds = streamingContext.contestants;

    const streamingSnapshot = {
      id: socket.id,
      serverTime: performance.now(),
      worldTime: this.world.getTime(), // Synced world time for day/night cycle
      assetsUrl: this.world.assetsUrl,
      apiUrl: process.env.PUBLIC_API_URL,
      maxUploadSize: process.env.PUBLIC_MAX_UPLOAD_SIZE,
      settings: this.world.settings.serialize() || {},
      chat: [], // No chat for streaming viewers
      entities: this.serializeEntities(socket),
      livekit: undefined,
      authToken: "", // No auth for streaming
      account: {
        accountId: undefined,
        name: "Streaming Viewer",
        providers: {},
      },
      characters: [], // No character selection
      spectatorMode: true, // Mark as spectator for client behavior
      streamingMode: true, // Additional flag for streaming-specific behavior
      followEntity,
      worldMap: this.serializeWorldMap(), // World map data for terrain/navigation
    };

    socket.send("snapshot", streamingSnapshot);
  }

  /**
   * Reconcile the entity set owned by canonical streaming viewers when the
   * scheduler changes matchups. Streaming snapshots are intentionally focused
   * around the current arena, so an already-existing agent selected from
   * elsewhere in the world is not necessarily present in a connected viewer.
   * Teleport and combat packets cannot create that missing client entity.
   *
   * Deliver the contestant snapshots before the scheduler publishes their new
   * overlay state, and remove only contestants that this stream connection no
   * longer owns. Pinned dashboard/agent spectators are deliberately untouched.
   */
  syncStreamingContestants(contestantIds: string[]): void {
    const normalizedIds = Array.from(
      new Set(
        contestantIds.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      ),
    );
    const nextIds = new Set(normalizedIds);

    for (const socket of this.sockets.values()) {
      if (!socket.isStreamingViewer) continue;

      const previousIds = new Set(socket.spectatingDuelParticipantIds ?? []);
      for (const previousId of previousIds) {
        if (nextIds.has(previousId)) continue;
        const previousEntity = this.findEntityBySpectatorKey(previousId) as
          { id?: string } | undefined;
        socket.send("entityRemoved", previousEntity?.id ?? previousId);
      }

      const snapshots: Record<string, unknown>[] = [];
      for (const contestantId of normalizedIds) {
        const entity = this.findEntityBySpectatorKey(contestantId) as
          | {
              id?: string;
              serialize?: () => unknown;
            }
          | undefined;
        if (!entity || typeof entity.serialize !== "function") continue;
        const serialized = entity.serialize();
        if (!serialized || typeof serialized !== "object") continue;
        const snapshot = serialized as Record<string, unknown>;
        this.applyAuthoritativeTransformSnapshot(entity, snapshot, {
          groundPlayersToTerrain: true,
        });
        snapshots.push(snapshot);
      }

      socket.spectatingDuelParticipantIds = normalizedIds;
      if (snapshots.length > 0) {
        socket.send("entitiesBatchAdded", snapshots);
      }
    }
  }

  /**
   * Get the UwsWebSocketAdapter from a socket's ws (duck-typed check).
   */
  private getUwsAdapter(socket: ServerSocket): UwsWebSocketAdapter | null {
    const ws = socket.ws as unknown as UwsWebSocketAdapter | undefined;
    if (
      ws &&
      typeof ws.subscribe === "function" &&
      typeof ws.publish === "function"
    ) {
      return ws;
    }
    return null;
  }

  /**
   * Subscribe a spectator socket to pub/sub topics:
   * - "spectator" (all spectator broadcasts)
   * - "spectator:<charId>" (player-specific spectator broadcasts)
   * - 9 region topics around the followed player's position
   */
  private subscribeSpectatorTopics(
    socket: ServerSocket,
    characterId: string,
  ): void {
    const adapter = this.getUwsAdapter(socket);
    if (!adapter) return;

    adapter.subscribe("spectator");
    adapter.subscribe(`spectator:${characterId}`);

    // Subscribe to followed player's region topics
    // Use findEntityBySpectatorKey so it searches both items AND players collections
    const followedEntity = this.findEntityBySpectatorKey(characterId) as
      { position?: { x: number; z: number } } | undefined;
    if (followedEntity?.position && this.spatialIndex) {
      const regionKeys = this.spatialIndex.getAdjacentRegionKeys(
        followedEntity.position.x,
        followedEntity.position.z,
      );
      for (let i = 0; i < 9; i++) {
        adapter.subscribe(this.spatialIndex.getRegionTopic(regionKeys[i]));
      }
    }
  }

  /**
   * Create and send spectator snapshot
   *
   * Spectators receive a limited snapshot with no authentication or character data.
   *
   * @param socket - Spectator socket
   * @param params - Connection parameters (may include followEntity hint)
   * @private
   */
  private async sendSpectatorSnapshot(
    socket: ServerSocket,
    params: ConnectionParams,
  ): Promise<void> {
    const followEntityId =
      socket.spectatingCharacterId || params.followEntity || params.characterId;
    if (followEntityId) {
      socket.spectatingCharacterId = followEntityId;
    }
    if (
      !socket.spectatingDuelParticipantIds ||
      socket.spectatingDuelParticipantIds.length === 0
    ) {
      const streamingContext = await this.getStreamingFollowContext();
      socket.spectatingDuelParticipantIds = streamingContext.contestants;
    }

    const spectatorSnapshot = {
      id: socket.id,
      serverTime: performance.now(),
      assetsUrl: this.world.assetsUrl,
      apiUrl: process.env.PUBLIC_API_URL,
      maxUploadSize: process.env.PUBLIC_MAX_UPLOAD_SIZE,
      settings: this.world.settings.serialize() || {},
      chat: this.world.chat.serialize() || [],
      entities: this.serializeEntities(socket),
      livekit: undefined,
      authToken: "", // No auth for spectators
      account: {
        accountId: socket.accountId,
        name: "Spectator",
        providers: {},
      },
      characters: [], // No character selection for spectators
      spectatorMode: true, // Flag for client to recognize spectator mode
      followEntity: followEntityId, // Hint for which entity to follow
    };

    socket.send("snapshot", spectatorSnapshot);
  }
}
