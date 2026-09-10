/**
 * Socket Management Module
 *
 * Handles WebSocket connection health monitoring:
 * - Ping/pong health checks
 * - Socket disconnection detection
 * - Socket cleanup and player removal
 *
 * This module extracts socket management logic from ServerNetwork
 * to improve maintainability and separation of concerns.
 */

import type { ServerSocket } from "../../shared/types";
import { EventType, World, writePacket } from "@hyperforge/shared";
import { notifyFriendsOfStatusChange } from "./handlers/friends";
import type { BroadcastManager } from "./broadcast";

const WS_PING_INTERVAL_SEC = parseInt(
  process.env.WS_PING_INTERVAL_SEC || "5",
  10,
);
const WS_PING_MISS_TOLERANCE = parseInt(
  process.env.WS_PING_MISS_TOLERANCE || "3",
  10,
);
const WS_PING_GRACE_MS = parseInt(process.env.WS_PING_GRACE_MS || "5000", 10);
const IS_PLAYWRIGHT_TEST = process.env.PLAYWRIGHT_TEST === "true";
const DEBUG_SOCKET_DISCONNECT = process.env.DEBUG_SOCKET_DISCONNECT === "true";

// In E2E we churn browser contexts quickly. Prune sockets aggressively so
// stale connections do not retain world/player state and inflate memory.
const TEST_IDLE_SOCKET_TTL_MS = Math.max(
  5_000,
  parseInt(process.env.TEST_IDLE_SOCKET_TTL_MS || "20000", 10),
);
const TEST_PENDING_READY_TTL_MS = Math.max(
  5_000,
  parseInt(process.env.TEST_PENDING_READY_TTL_MS || "15000", 10),
);
const TEST_MAX_SOCKET_COUNT = Math.max(
  4,
  parseInt(process.env.TEST_MAX_SOCKET_COUNT || "8", 10),
);

/**
 * Socket health manager for WebSocket connection monitoring
 */
/** Duration to keep a player entity alive after combat disconnect (classic MMORPG: ~10s) */
const COMBAT_LOGOUT_DELAY_MS = Math.max(
  0,
  parseInt(process.env.COMBAT_LOGOUT_DELAY_MS || "10000", 10),
);

/** Duration to keep a player entity alive for reconnection (30 seconds) */
const RECONNECT_GRACE_MS = Math.max(
  0,
  parseInt(process.env.RECONNECT_GRACE_MS || "30000", 10),
);

/** Disconnected player state held during reconnection grace period */
interface DisconnectedPlayer {
  playerId: string;
  accountId: string;
  agentCredentialCharacterId?: string;
  disconnectedAt: number;
}

export class SocketManager {
  private socketFirstSeenAt: Map<string, number> = new Map();
  private socketMissedPongs: Map<string, number> = new Map();
  private intervalId: NodeJS.Timeout;
  /** Tracks pending combat-logout timers so they can be cancelled on reconnect */
  private combatLogoutTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Timestamps recorded before each WS ping, keyed by socket ID */
  private pingTimestamps: Map<string, number> = new Map();
  /** Most recent RTT measurement per socket, keyed by socket ID */
  private socketRTT: Map<string, number> = new Map();
  /** Reconnection grace timers, keyed by accountId */
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Disconnected players within grace period, keyed by accountId */
  private disconnectedPlayers: Map<string, DisconnectedPlayer> = new Map();
  /** Disconnect counter for opportunistic GC in E2E stress runs */
  private playwrightDisconnectGcCounter = 0;
  /** Reference to broadcast manager for bandwidth cleanup */
  private broadcastManager: BroadcastManager | null = null;

  /** Set broadcast manager for bandwidth budget cleanup on disconnect */
  setBroadcastManager(manager: BroadcastManager): void {
    this.broadcastManager = manager;
  }

  constructor(
    private sockets: Map<string, ServerSocket>,
    private world: World,
    private sendFn: (
      name: string,
      data: unknown,
      ignoreSocketId?: string,
    ) => void,
  ) {
    this.intervalId = setInterval(
      () => this.checkSockets(),
      WS_PING_INTERVAL_SEC * 1000,
    );
  }

  /**
   * Checks health of all WebSocket connections
   *
   * Sends ping to all sockets and disconnects those that didn't respond to the
   * previous ping (alive flag is false). This prevents zombie connections from
   * accumulating when clients close without proper disconnect.
   *
   * Called every PING_RATE (default 5 seconds) by the socket interval timer.
   */
  checkSockets(): void {
    const now = Date.now();
    const toDisconnect: Array<{ socket: ServerSocket; reason: string }> = [];
    const scheduledSocketIds = new Set<string>();
    this.sockets.forEach((socket) => {
      // Grace period for new sockets
      if (!this.socketFirstSeenAt.has(socket.id)) {
        this.socketFirstSeenAt.set(socket.id, now);
        this.socketMissedPongs.set(socket.id, 0);
        // Wrap onPong to capture RTT and send to client
        this.wrapPongHandler(socket);
        socket.ping?.();
        return;
      }

      const firstSeen = this.socketFirstSeenAt.get(socket.id) || now;
      const withinGrace = now - firstSeen < WS_PING_GRACE_MS;
      const socketAgeMs = now - (socket.createdAt || firstSeen);

      if (withinGrace) {
        // During grace, just ping and do not count misses
        socket.ping?.();
        return;
      }

      if (IS_PLAYWRIGHT_TEST) {
        // Socket stuck before player attach (common during rapid test teardown)
        if (
          !socket.player &&
          socket.pendingClientReady &&
          socketAgeMs > TEST_PENDING_READY_TTL_MS
        ) {
          if (!scheduledSocketIds.has(socket.id)) {
            toDisconnect.push({
              socket,
              reason: `pending_client_ready_ttl>${TEST_PENDING_READY_TTL_MS}ms`,
            });
            scheduledSocketIds.add(socket.id);
          }
          return;
        }

        // Idle unauthenticated/non-player sockets should never linger in E2E.
        if (!socket.player && socketAgeMs > TEST_IDLE_SOCKET_TTL_MS) {
          if (!scheduledSocketIds.has(socket.id)) {
            toDisconnect.push({
              socket,
              reason: `idle_socket_ttl>${TEST_IDLE_SOCKET_TTL_MS}ms`,
            });
            scheduledSocketIds.add(socket.id);
          }
          return;
        }
      }

      if (!socket.alive) {
        const misses = (this.socketMissedPongs.get(socket.id) || 0) + 1;
        this.socketMissedPongs.set(socket.id, misses);
        if (misses >= WS_PING_MISS_TOLERANCE) {
          if (!scheduledSocketIds.has(socket.id)) {
            toDisconnect.push({ socket, reason: `missed_pong x${misses}` });
            scheduledSocketIds.add(socket.id);
          }
          return;
        }
      } else {
        // Reset miss counter on successful pong seen in last interval
        this.socketMissedPongs.set(socket.id, 0);
      }

      // Record timestamp before ping for RTT calculation
      this.pingTimestamps.set(socket.id, Date.now());
      // Mark not-alive and send ping to solicit next pong
      socket.ping?.();
    });

    if (IS_PLAYWRIGHT_TEST && this.sockets.size > TEST_MAX_SOCKET_COUNT) {
      const sorted = [...this.sockets.values()].sort(
        (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
      );
      // Prefer pruning sockets without a player first.
      const pruneOrder = [
        ...sorted.filter((s) => !s.player),
        ...sorted.filter((s) => !!s.player),
      ];
      const overflow = this.sockets.size - TEST_MAX_SOCKET_COUNT;
      for (let i = 0; i < overflow && i < pruneOrder.length; i++) {
        const socket = pruneOrder[i];
        if (!scheduledSocketIds.has(socket.id)) {
          toDisconnect.push({
            socket,
            reason: `test_socket_cap>${TEST_MAX_SOCKET_COUNT}`,
          });
          scheduledSocketIds.add(socket.id);
        }
      }
    }

    toDisconnect.forEach(({ socket, reason }) => {
      const wsRef = socket.ws;
      try {
        if (!IS_PLAYWRIGHT_TEST || DEBUG_SOCKET_DISCONNECT) {
          console.warn(
            `[SocketManager] Disconnecting socket ${socket.id} due to ${reason}`,
          );
        }
      } catch {}
      // Ensure cleanup runs even if ws close event never fires.
      this.handleDisconnect(socket, reason);
      // Avoid recursive network.onDisconnect paths here - cleanup above already ran.
      try {
        wsRef?.close?.();
        wsRef?.terminate?.();
      } catch {}
      this.socketFirstSeenAt.delete(socket.id);
      this.socketMissedPongs.delete(socket.id);
    });
  }

  /**
   * Handles player disconnection and cleanup
   *
   * Performs cleanup when a player disconnects:
   * - Removes socket from tracking
   * - Emits player left event
   * - Destroys player entity
   * - Broadcasts entity removal to other clients
   */
  handleDisconnect(socket: ServerSocket, code?: number | string): void {
    if (!IS_PLAYWRIGHT_TEST || DEBUG_SOCKET_DISCONNECT) {
      console.log(
        `[SocketManager] 🔌 Socket ${socket.id} disconnected with code:`,
        code,
        {
          hadPlayer: !!socket.player,
          playerId: socket.player?.id,
        },
      );
    }

    // Remove socket from our tracking
    this.sockets.delete(socket.id);
    this.socketFirstSeenAt.delete(socket.id);
    this.socketMissedPongs.delete(socket.id);
    this.pingTimestamps.delete(socket.id);
    this.socketRTT.delete(socket.id);
    this.broadcastManager?.onSocketDisconnected(socket.id);

    if (socket.clientReadyTimeoutId) {
      clearTimeout(socket.clientReadyTimeoutId);
      socket.clientReadyTimeoutId = undefined;
    }
    if (socket.agentCredentialExpiryTimeoutId) {
      clearTimeout(socket.agentCredentialExpiryTimeoutId);
      socket.agentCredentialExpiryTimeoutId = undefined;
    }

    // Clear character claim for duplicate detection
    socket.characterId = undefined;

    // Clean up any socket-specific resources
    if (socket.player) {
      const playerId = socket.player.id;

      // Notify friends that this player went offline (fire and forget)
      notifyFriendsOfStatusChange(playerId, "offline", this.world).catch(
        (err) => {
          console.warn(
            "[SocketManager] Failed to notify friends of disconnect:",
            err,
          );
        },
      );

      // Check combat logout timer (classic MMORPG: can't log out for ~10s after combat)
      const combatSystem = this.world.getSystem("combat") as {
        canLogout?: (
          playerId: string,
          currentTick: number,
        ) => { allowed: boolean; reason?: string };
      } | null;

      const logoutCheck = combatSystem?.canLogout?.(
        playerId,
        this.world.currentTick,
      );

      if (logoutCheck && !logoutCheck.allowed) {
        // Player is in combat — delay entity removal (classic MMORPG combat-logging prevention)
        // Entity stays in-world and targetable during the grace period
        console.log(
          `[SocketManager] Combat logout delay for ${playerId}: ${logoutCheck.reason}`,
        );

        // Emit PLAYER_LEFT immediately so systems save data
        this.world.emit(EventType.PLAYER_LEFT, { playerId });

        // Schedule delayed entity removal
        const timer = setTimeout(() => {
          this.combatLogoutTimers.delete(playerId);
          if (this.world.entities?.remove) {
            this.world.entities.remove(playerId);
          }
          this.sendFn("entityRemoved", playerId);
        }, COMBAT_LOGOUT_DELAY_MS);

        this.combatLogoutTimers.set(playerId, timer);
      } else {
        // Not in combat — start reconnection grace period
        const accountId = socket.accountId;
        if (accountId) {
          if (RECONNECT_GRACE_MS <= 0) {
            this.world.emit(EventType.PLAYER_LEFT, { playerId });
            if (this.world.entities?.remove) {
              this.world.entities.remove(playerId);
            }
            this.sendFn("entityRemoved", playerId);
            // Continue into shared cleanup below so socket listeners/references
            // are always released, even in immediate-removal test mode.
          } else {
            const disconnectedAt = Date.now();
            const reconnectGraceExpiresAt = disconnectedAt + RECONNECT_GRACE_MS;
            console.log(
              `[SocketManager] Reconnect grace started for ${playerId} (account=${accountId}, ${RECONNECT_GRACE_MS / 1000}s)`,
            );

            // Persist ordinary disconnect state while telling competitive
            // systems that the authenticated entity and durable preparation
            // remain recoverable for this exact bounded grace window.
            this.world.emit(EventType.PLAYER_LEFT, {
              playerId,
              reconnectGraceActive: true,
              reconnectGraceExpiresAt,
            });

            // Store disconnected player state
            this.disconnectedPlayers.set(accountId, {
              playerId,
              accountId,
              agentCredentialCharacterId: socket.agentCredentialCharacterId,
              disconnectedAt,
            });

            // Schedule entity removal after grace period
            const timer = setTimeout(() => {
              this.reconnectTimers.delete(accountId);
              this.disconnectedPlayers.delete(accountId);
              console.log(
                `[SocketManager] Reconnect grace expired for ${playerId}, removing entity`,
              );
              if (this.world.entities?.remove) {
                this.world.entities.remove(playerId);
              }
              this.sendFn("entityRemoved", playerId);
            }, RECONNECT_GRACE_MS);

            this.reconnectTimers.set(accountId, timer);
          }
        } else {
          // No account ID (anonymous?) — immediate cleanup
          this.world.emit(EventType.PLAYER_LEFT, { playerId });

          if (this.world.entities?.remove) {
            this.world.entities.remove(playerId);
          }
          this.sendFn("entityRemoved", playerId);
        }
      }
    }

    // Prevent duplicate disconnect cleanup if the ws close event fires after
    // proactive timeout cleanup in checkSockets().
    socket.player = undefined;
    socket.pendingClientReady = false;
    socket.selectedCharacterId = undefined;
    socket.characterId = undefined;
    socket.agentCredentialCharacterId = undefined;
    socket.accountId = undefined;

    // Release references to heavy ws internals so stale socket objects are cheap.
    try {
      socket.ws?.removeListener?.(
        "message",
        socket.onMessage as unknown as Function,
      );
      socket.ws?.removeListener?.("pong", socket.onPong as unknown as Function);
      socket.ws?.removeListener?.(
        "close",
        socket.onClose as unknown as Function,
      );
      (
        socket.ws as { removeAllListeners?: () => void } | undefined
      )?.removeAllListeners?.();
    } catch {}

    if (IS_PLAYWRIGHT_TEST) {
      this.playwrightDisconnectGcCounter++;
      if (this.playwrightDisconnectGcCounter >= 8) {
        this.playwrightDisconnectGcCounter = 0;
        try {
          (
            globalThis as typeof globalThis & {
              Bun?: { gc?: (force?: boolean) => void };
            }
          ).Bun?.gc?.(true);
        } catch {
          // Best-effort GC hint only.
        }
      }
    }
  }

  /**
   * Attempt to reconnect a player to their existing entity within the grace period.
   *
   * @param accountId - Account ID of the reconnecting player
   * @param newSocket - New socket for the reconnected player
   * @returns The existing player entity ID if reconnection succeeded, null otherwise
   */
  tryReconnect(
    accountId: string,
    newSocket: ServerSocket,
    requestedCharacterId?: string,
  ): string | null {
    const disconnected = this.disconnectedPlayers.get(accountId);
    if (!disconnected) return null;

    if (
      (requestedCharacterId &&
        requestedCharacterId !== disconnected.playerId) ||
      (disconnected.agentCredentialCharacterId &&
        (newSocket.agentCredentialCharacterId !==
          disconnected.agentCredentialCharacterId ||
          disconnected.agentCredentialCharacterId !== disconnected.playerId))
    ) {
      return null;
    }

    // Cancel the grace timer
    const timer = this.reconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(accountId);
    }
    this.disconnectedPlayers.delete(accountId);

    // Verify entity still exists
    const entity = this.world.entities?.get(disconnected.playerId);
    if (!entity) {
      console.warn(
        `[SocketManager] Reconnect failed: entity ${disconnected.playerId} no longer exists`,
      );
      return null;
    }

    // Reassign entity to new socket
    newSocket.player = entity as ServerSocket["player"];
    newSocket.accountId = accountId;
    newSocket.characterId = disconnected.playerId;

    // Register socket
    this.sockets.set(newSocket.id, newSocket);

    const elapsed = Date.now() - disconnected.disconnectedAt;
    console.log(
      `[SocketManager] Reconnected ${disconnected.playerId} after ${elapsed}ms`,
    );

    // Notify friends they came back online
    notifyFriendsOfStatusChange(
      disconnected.playerId,
      "online",
      this.world,
    ).catch(() => {
      // Non-critical
    });

    return disconnected.playerId;
  }

  /**
   * Wrap a socket's onPong handler to calculate RTT and send it to the client.
   * Called once when a socket is first seen. Wraps the existing onPong so
   * alive tracking continues to work.
   *
   * Works because Socket constructor binds ws "pong" to `this.onPong()` via
   * property lookup, so reassigning the property here takes effect.
   */
  private wrapPongHandler(socket: ServerSocket): void {
    const originalOnPong = socket.onPong;
    socket.onPong = () => {
      // Preserve original behavior (sets alive = true)
      originalOnPong();

      // Calculate RTT from stored ping timestamp
      const sentAt = this.pingTimestamps.get(socket.id);
      if (sentAt !== undefined) {
        const rtt = Date.now() - sentAt;
        this.socketRTT.set(socket.id, rtt);
        this.pingTimestamps.delete(socket.id);

        // Send server-measured RTT to client
        try {
          socket.sendPacket(writePacket("rtt", { rtt }));
        } catch {
          // Socket may have closed between pong and send
        }
      }
    };
  }

  /**
   * Get the most recent RTT measurement for a socket.
   *
   * @param socketId - Socket to query
   * @returns RTT in milliseconds, or -1 if no measurement available
   */
  getRTT(socketId: string): number {
    return this.socketRTT.get(socketId) ?? -1;
  }

  /**
   * Cleanup and stop socket monitoring
   */
  destroy(): void {
    clearInterval(this.intervalId);
    // Clear any pending combat logout timers
    for (const timer of this.combatLogoutTimers.values()) {
      clearTimeout(timer);
    }
    this.combatLogoutTimers.clear();
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.disconnectedPlayers.clear();
    this.socketFirstSeenAt.clear();
    this.socketMissedPongs.clear();
    this.pingTimestamps.clear();
    this.socketRTT.clear();
  }
}
