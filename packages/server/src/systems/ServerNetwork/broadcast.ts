/**
 * Broadcast Module - Network message broadcasting
 *
 * Handles sending messages to clients via WebSocket connections.
 * Provides methods for broadcasting to all clients, specific clients,
 * or clients by player ID.
 *
 * Supports two broadcast paths:
 * 1. **Pub/Sub (uWS native)**: When a uWS app is available, uses native
 *    C++ fan-out via ws.publish(topic). One publish call replaces the
 *    entire JS iteration loop for sendToAll/sendToNearby/sendToSpectators.
 * 2. **Legacy JS iteration**: Falls back to per-socket iteration when
 *    uWS is not available (UWS_ENABLED=false).
 *
 * Unicast methods (sendToSocket, sendToPlayer) are unchanged.
 */

import type { ServerSocket } from "../../shared/types";
import { writePacket } from "@hyperforge/shared";
import type { SpatialIndex } from "./SpatialIndex";
import { BandwidthBudget, PacketPriority } from "./BandwidthBudget";
import type { UwsWebSocketAdapter } from "../../startup/UwsWebSocketAdapter";
import type * as uWS from "uWebSockets.js";

/**
 * BroadcastManager - Manages network message broadcasting
 *
 * Provides centralized broadcasting logic that can be shared across
 * ServerNetwork components.
 */
export class BroadcastManager {
  private spatialIndex: SpatialIndex | null = null;
  readonly bandwidthBudget = new BandwidthBudget();
  private readonly playerSocketIds = new Map<string, string>();
  private readonly socketPlayerIds = new Map<string, string>();

  /** Cumulative time (ms) spent in sendBufferedPacket since last reset */
  private _sendTimeAccumMs = 0;

  /** uWS app reference for pub/sub broadcasting (null = legacy JS path) */
  private uwsApp: uWS.TemplatedApp | null = null;

  /** Cumulative pub/sub publish count since last drain */
  private _pubsubPublishCount = 0;

  /**
   * Create a BroadcastManager
   *
   * @param sockets - Map of active socket connections (passed by reference)
   */
  constructor(private sockets: Map<string, ServerSocket>) {}

  /** Attach a spatial index for interest-managed broadcasts. */
  setSpatialIndex(index: SpatialIndex): void {
    this.spatialIndex = index;
  }

  /** Set the uWS app reference for native pub/sub broadcasting. */
  setUwsApp(app: uWS.TemplatedApp | null): void {
    this.uwsApp = app;
  }

  /**
   * Get the UwsWebSocketAdapter for a socket ID.
   * Derives it from the socket's underlying ws property (duck-typed).
   */
  getAdapter(socketId: string): UwsWebSocketAdapter | undefined {
    const socket = this.sockets.get(socketId);
    if (!socket) return undefined;
    // The socket's ws property is the NodeWebSocket — if it's a uWS adapter,
    // it will have subscribe/unsubscribe/publish methods
    const ws = socket.ws as unknown as UwsWebSocketAdapter | undefined;
    if (
      ws &&
      typeof ws.subscribe === "function" &&
      typeof ws.publish === "function" &&
      typeof ws.sendReliable === "function"
    ) {
      return ws;
    }
    return undefined;
  }

  /**
   * Broadcast message to all connected clients
   *
   * Sends a message to all active sockets except the one specified
   * by ignoreSocketId (useful for echoing player actions to others).
   *
   * @param name - Message type/name
   * @param data - Message payload
   * @param ignoreSocketId - Optional socket ID to exclude from broadcast
   * @returns Number of clients that received the message
   */
  sendToAll<T = unknown>(
    name: string,
    data: T,
    ignoreSocketId?: string,
    priority: PacketPriority = PacketPriority.NORMAL,
  ): number {
    const packet = writePacket(name, data);

    // Pub/sub fast path: single publish to "global" topic
    // Critical combat/state terminals need per-socket delivery semantics.
    // Topic fan-out can discard a publication for a backpressured subscriber
    // without identifying which client missed it, so reserve pub/sub for
    // replayable/lower-priority traffic and send critical packets directly.
    if (this.uwsApp && priority < PacketPriority.CRITICAL) {
      if (ignoreSocketId) {
        // ws.publish() excludes self — publish from the ignored socket's adapter
        const adapter = this.getAdapter(ignoreSocketId);
        if (adapter) {
          adapter.publish("global", packet, true);
          this._pubsubPublishCount++;
          return this.sockets.size - 1; // estimate
        }
      }
      // No exclusion or adapter not found — use app-level publish (includes everyone)
      this.uwsApp.publish("global", packet, true);
      this._pubsubPublishCount++;
      return this.sockets.size;
    }

    // Legacy JS iteration path
    let sentCount = 0;
    this.sockets.forEach((socket) => {
      if (socket.id === ignoreSocketId) {
        return;
      }
      if (this.sendBufferedPacket(socket, packet, priority)) {
        sentCount++;
      }
    });

    return sentCount;
  }

  /**
   * Broadcast to players near a world position (interest management).
   *
   * Uses the spatial index to find players within a 3×3 region grid
   * (~63×63 tiles). Falls back to sendToAll if no spatial index is set.
   *
   * When pub/sub is active, publishes to 9 region topics + spectator topic
   * instead of iterating individual sockets.
   *
   * @param name - Message type/name
   * @param data - Message payload
   * @param worldX - World X coordinate of the event
   * @param worldZ - World Z coordinate of the event
   * @param ignoreSocketId - Optional socket ID to exclude
   * @returns Number of clients that received the message
   */
  sendToNearby<T = unknown>(
    name: string,
    data: T,
    worldX: number,
    worldZ: number,
    ignoreSocketId?: string,
    priority: PacketPriority = PacketPriority.HIGH,
  ): number {
    if (!this.spatialIndex) {
      return this.sendToAll(name, data, ignoreSocketId, priority);
    }

    // Pub/sub fast path: publish to 9 region topics + spectator topic
    if (this.uwsApp && priority < PacketPriority.CRITICAL) {
      const packet = writePacket(name, data);
      const regionKeys = this.spatialIndex.getAdjacentRegionKeys(
        worldX,
        worldZ,
      );

      if (ignoreSocketId) {
        const adapter = this.getAdapter(ignoreSocketId);
        if (adapter) {
          // ws.publish() excludes self — perfect for ignoreSocketId
          for (let i = 0; i < 9; i++) {
            adapter.publish(
              this.spatialIndex.getRegionTopic(regionKeys[i]),
              packet,
              true,
            );
          }
          // Also publish to spectator topic so spectators get nearby events
          adapter.publish("spectator", packet, true);
          this._pubsubPublishCount += 10;
          return -1; // exact count not available with pub/sub
        }
      }

      // No exclusion — use app-level publish
      for (let i = 0; i < 9; i++) {
        this.uwsApp.publish(
          this.spatialIndex.getRegionTopic(regionKeys[i]),
          packet,
          true,
        );
      }
      this.uwsApp.publish("spectator", packet, true);
      this._pubsubPublishCount += 10;
      return -1; // exact count not available with pub/sub
    }

    // Legacy JS iteration path
    const nearbyPlayerIds = this.spatialIndex.getPlayersNear(worldX, worldZ);

    let packet: ArrayBuffer | null = null;
    let sentCount = 0;

    if (nearbyPlayerIds.length > 0) {
      packet = writePacket(name, data);
      for (const playerId of nearbyPlayerIds) {
        const socket = this.getPlayerSocket(playerId);
        if (socket && socket.id !== ignoreSocketId) {
          if (this.sendBufferedPacket(socket, packet, priority)) {
            sentCount++;
          }
        }
      }
    }

    // Spectator/stream sockets have no player entry in SpatialIndex.
    // Always forward nearby packets so camera-followed entities stay in sync.
    // NOTE: This must run even when nearbyPlayerIds is empty — agent-only
    // duels have no regular players nearby but spectators still need packets.
    for (const socket of this.sockets.values()) {
      if (socket.id === ignoreSocketId) continue;
      if (!socket.isSpectator) continue;
      if (!packet) packet = writePacket(name, data);
      if (this.sendBufferedPacket(socket, packet, priority)) {
        sentCount++;
      }
    }

    return sentCount;
  }

  /**
   * Send message to specific socket by socket ID
   *
   * Looks up the socket by ID and sends the message if found.
   * Fails silently if socket doesn't exist.
   *
   * @param socketId - Target socket ID
   * @param name - Message type/name
   * @param data - Message payload
   * @returns True if socket was found and message sent
   */
  sendToSocket<T = unknown>(
    socketId: string,
    name: string,
    data: T,
    priority: PacketPriority = PacketPriority.NORMAL,
  ): boolean {
    const socket = this.sockets.get(socketId);
    if (socket) {
      if (priority >= PacketPriority.CRITICAL) {
        return this.sendBufferedPacket(
          socket,
          writePacket(name, data),
          priority,
        );
      }
      socket.send(name, data);
      return true;
    }
    return false;
  }

  /**
   * Send message to specific player by player ID
   *
   * Iterates through all sockets to find the one associated with
   * the given player ID, then sends the message.
   *
   * This is less efficient than sendToSocket() but useful when you
   * only have a player ID instead of socket ID.
   *
   * @param playerId - Target player ID
   * @param name - Message type/name
   * @param data - Message payload
   * @returns True if player was found and message sent
   */
  sendToPlayer<T = unknown>(
    playerId: string,
    name: string,
    data: T,
    priority: PacketPriority = PacketPriority.NORMAL,
  ): boolean {
    const socket = this.getPlayerSocket(playerId);
    if (socket) {
      if (priority >= PacketPriority.CRITICAL) {
        return this.sendBufferedPacket(
          socket,
          writePacket(name, data),
          priority,
        );
      }
      socket.send(name, data);
      return true;
    }
    return false;
  }

  /**
   * Get the socket for a specific player
   *
   * Looks up the socket by player ID. Useful for accessing player
   * entity data or sending targeted messages.
   *
   * @param playerId - Target player ID
   * @returns The socket if found, undefined otherwise
   */
  getPlayerSocket(playerId: string): ServerSocket | undefined {
    const cachedSocketId = this.playerSocketIds.get(playerId);
    if (cachedSocketId) {
      const cachedSocket = this.sockets.get(cachedSocketId);
      if (this.isSocketForPlayer(cachedSocket, playerId)) {
        return cachedSocket;
      }
      this.playerSocketIds.delete(playerId);
      this.socketPlayerIds.delete(cachedSocketId);
    }

    for (const socket of this.sockets.values()) {
      if (this.isSocketForPlayer(socket, playerId)) {
        this.trackPlayerSocket(socket, playerId);
        return socket;
      }
    }
    return undefined;
  }

  /**
   * Send message to a player AND any spectators watching that player
   *
   * This ensures spectators see real-time feedback like XP drops, damage numbers,
   * and other player-specific events that would normally only go to the player.
   *
   * @param playerId - Target player ID (also the character ID spectators follow)
   * @param name - Message type/name
   * @param data - Message payload
   * @returns Number of sockets that received the message (1 for player + N spectators)
   */
  sendToPlayerAndSpectators<T = unknown>(
    playerId: string,
    name: string,
    data: T,
  ): number {
    let sentCount = 0;
    const playerSocket = this.getPlayerSocket(playerId);

    if (playerSocket) {
      playerSocket.send(name, data);
      sentCount++;
    }

    // Pub/sub path: publish to spectator:<playerId> topic
    if (this.uwsApp) {
      const packet = writePacket(name, data);
      this.uwsApp.publish(`spectator:${playerId}`, packet, true);
      this._pubsubPublishCount++;
      return sentCount + 1; // estimate spectators
    }

    // Legacy JS iteration path
    for (const socket of this.sockets.values()) {
      const socketWithSpectator = socket as ServerSocket & {
        isSpectator?: boolean;
        spectatingCharacterId?: string;
      };
      if (playerSocket && socket.id === playerSocket.id) {
        continue;
      }
      if (
        socketWithSpectator.isSpectator &&
        socketWithSpectator.spectatingCharacterId === playerId
      ) {
        socket.send(name, data);
        sentCount++;
      }
    }

    return sentCount;
  }

  /**
   * Broadcast to spectator sockets only.
   *
   * Streaming state updates only need to reach spectator clients (viewers
   * watching duel streams), not every connected player. This reduces
   * bandwidth by skipping regular gameplay sockets.
   *
   * @param name - Message type/name
   * @param data - Message payload
   * @returns Number of spectator sockets that received the message
   */
  sendToSpectators<T = unknown>(
    name: string,
    data: T,
    priority: PacketPriority = PacketPriority.NORMAL,
  ): number {
    // Pub/sub fast path
    if (this.uwsApp && priority < PacketPriority.CRITICAL) {
      const packet = writePacket(name, data);
      this.uwsApp.publish("spectator", packet, true);
      this._pubsubPublishCount++;
      return -1; // exact count not available
    }

    // Legacy JS iteration path
    let packet: ArrayBuffer | null = null;
    let sentCount = 0;

    for (const socket of this.sockets.values()) {
      if (!socket.isSpectator) continue;
      if (!packet) packet = writePacket(name, data);
      if (this.sendBufferedPacket(socket, packet, priority)) {
        sentCount++;
      }
    }

    return sentCount;
  }

  /**
   * Clean up bandwidth tracking for a disconnected socket.
   */
  onSocketDisconnected(socketId: string): void {
    const playerId = this.socketPlayerIds.get(socketId);
    if (playerId && this.playerSocketIds.get(playerId) === socketId) {
      this.playerSocketIds.delete(playerId);
    }
    this.socketPlayerIds.delete(socketId);
    this.bandwidthBudget.removeConnection(socketId);
  }

  private isSocketForPlayer(
    socket: ServerSocket | undefined,
    playerId: string,
  ): socket is ServerSocket {
    return (
      !!socket &&
      (socket.player?.id === playerId || socket.characterId === playerId)
    );
  }

  private trackPlayerSocket(socket: ServerSocket, playerId: string): void {
    this.playerSocketIds.set(playerId, socket.id);
    this.socketPlayerIds.set(socket.id, playerId);
  }

  /**
   * Read and reset accumulated send time (ms).
   * Called by tickHealth broadcast to report broadcast overhead.
   */
  drainSendTimeMs(): number {
    const ms = this._sendTimeAccumMs;
    this._sendTimeAccumMs = 0;
    return Math.round(ms * 100) / 100; // 2 decimal places
  }

  /**
   * Read and reset accumulated pub/sub publish count.
   * Called by tickHealth broadcast to report pub/sub throughput.
   */
  drainPubsubStats(): number {
    const count = this._pubsubPublishCount;
    this._pubsubPublishCount = 0;
    return count;
  }

  private sendBufferedPacket(
    socket: ServerSocket,
    packet: ArrayBuffer,
    priority: PacketPriority,
  ): boolean {
    const packetBytes = packet.byteLength;
    if (!this.bandwidthBudget.canSend(socket.id, packetBytes, priority)) {
      return false;
    }

    const t0 = performance.now();
    try {
      const adapter = this.getAdapter(socket.id);
      if (
        priority >= PacketPriority.CRITICAL &&
        adapter &&
        !adapter.sendReliable(packet)
      ) {
        this._sendTimeAccumMs += performance.now() - t0;
        return false;
      }
      if (priority < PacketPriority.CRITICAL || !adapter) {
        socket.sendPacket(packet);
      }
      this.bandwidthBudget.recordSend(socket.id, packetBytes);
      const trackedPlayerId = socket.player?.id || socket.characterId;
      if (trackedPlayerId) {
        this.trackPlayerSocket(socket, trackedPlayerId);
      }
      this._sendTimeAccumMs += performance.now() - t0;
      return true;
    } catch {
      this._sendTimeAccumMs += performance.now() - t0;
      this.onSocketDisconnected(socket.id);
      return false;
    }
  }
}
