/**
 * InteractionSessionManager
 *
 * Server-authoritative management of UI interaction sessions (store, bank, dialogue).
 *
 * PRODUCTION PATTERN (classic MMORPG/WoW style):
 * - Server is the single source of truth for UI state
 * - Server tracks active sessions per player
 * - Server validates distance and sends close packets when player moves away
 * - Client NEVER independently decides to close based on distance
 *
 * This prevents race conditions between server and client position sync,
 * which cause unreliable UI behavior under lag.
 *
 * Usage:
 * 1. Call openSession() when player opens a store/bank/dialogue
 * 2. Call closeSession() when player explicitly closes or disconnects
 * 3. The manager automatically validates distance each tick and sends close packets
 *
 * Implements ISessionReader interface for use by ValidationService (DIP principle).
 */

import {
  type World,
  EventType,
  SessionType,
  INTERACTION_DISTANCE,
  SESSION_CONFIG,
  chebyshevDistance,
  type ISessionReader,
  type InteractionSession as SharedInteractionSession,
  type SessionCloseReason,
} from "@hyperforge/shared";
import type { BroadcastManager } from "./broadcast";
import type { TickSystem } from "../TickSystem";
import { TickPriority } from "../TickSystem";

// Re-export SessionType for backward compatibility
export { SessionType };

/**
 * Internal session data (extends shared interface with server-specific fields)
 */
interface InternalSession extends SharedInteractionSession {
  socketId: string;
  lastValidatedAt: number;
}

/**
 * InteractionSessionManager
 *
 * Manages server-authoritative UI interaction sessions.
 * Implements ISessionReader for use by ValidationService (DIP principle).
 */
export class InteractionSessionManager implements ISessionReader {
  /** Active sessions by player ID */
  private sessions = new Map<string, InternalSession>();

  /** Tick counter for interval-based validation */
  private tickCounter = 0;

  /** Unsubscribe function from tick system */
  private unsubscribeTick: (() => void) | null = null;

  constructor(
    private world: World,
    private broadcast: BroadcastManager,
  ) {}

  /** Event listener unsubscribe functions */
  private eventUnsubscribers: (() => void)[] = [];

  /**
   * Initialize the session manager
   *
   * Registers with the tick system for periodic validation and sets up event listeners.
   *
   * @param tickSystem - The server's tick system
   */
  initialize(tickSystem: TickSystem): void {
    // Register tick listener for periodic session validation
    this.unsubscribeTick = tickSystem.onTick(
      (tickNumber: number) => this.onTick(tickNumber),
      TickPriority.BROADCAST - 1, // Run just before broadcast
    );

    // Listen for store open requests to create sessions
    // This fires AFTER EventBridge sends the storeState packet
    const storeOpenHandler = (event: unknown) => {
      const data = event as {
        playerId: string;
        npcEntityId?: string;
        storeId?: string;
      };
      if (data.playerId && data.npcEntityId) {
        const socket = this.broadcast.getPlayerSocket(data.playerId);
        if (socket) {
          const targetEntity = this.world.entities?.get?.(
            data.npcEntityId,
          ) as unknown as
            | {
                data?: { storeId?: unknown };
                config?: { storeId?: unknown };
              }
            | undefined;
          const runtimeStoreId =
            typeof targetEntity?.data?.storeId === "string"
              ? targetEntity.data.storeId
              : typeof targetEntity?.config?.storeId === "string"
                ? targetEntity.config.storeId
                : undefined;
          this.openSession({
            playerId: data.playerId,
            socketId: socket.id,
            sessionType: "store",
            targetEntityId: data.npcEntityId,
            targetStoreId: data.storeId ?? runtimeStoreId,
          });
        }
      }
    };
    this.world.on(EventType.STORE_OPEN_REQUEST, storeOpenHandler);
    this.eventUnsubscribers.push(() =>
      this.world.off(EventType.STORE_OPEN_REQUEST, storeOpenHandler),
    );

    // NOTE: We intentionally do NOT listen for STORE_CLOSE events here.
    // User-initiated closes should NOT clear the server session because:
    // 1. If user clicks another NPC, the storeClose arrives BEFORE the new open event
    // 2. This causes the session to be deleted before the new session can close it
    // 3. Result: no storeClose packet is sent when opening new UI
    //
    // Instead, sessions are only closed by:
    // - New session opening (openSession calls closeSession first)
    // - Distance validation (player walks too far)
    // - Player disconnect
    //
    // This is the correct server-authoritative pattern used by classic MMORPG/WoW.

    // Listen for bank open events to create sessions
    // We listen for BOTH BANK_OPEN (direct click) and BANK_OPEN_REQUEST (via dialogue)
    const bankOpenHandler = (event: unknown) => {
      const data = event as {
        playerId: string;
        bankId?: string;
        bankEntityId?: string;
        npcEntityId?: string; // From BANK_OPEN_REQUEST (dialogue)
      };
      // Handle both direct open (bankEntityId) and dialogue open (npcEntityId)
      const entityId = data.bankEntityId || data.npcEntityId || data.bankId;
      if (data.playerId && entityId) {
        const socket = this.broadcast.getPlayerSocket(data.playerId);
        if (socket) {
          this.openSession({
            playerId: data.playerId,
            socketId: socket.id,
            sessionType: "bank",
            targetEntityId: entityId,
          });
        }
      }
    };
    // Listen for direct bank opens (clicking "Use Bank" on NPC)
    this.world.on(EventType.BANK_OPEN, bankOpenHandler);
    this.eventUnsubscribers.push(() =>
      this.world.off(EventType.BANK_OPEN, bankOpenHandler),
    );
    // Also listen for bank opens via dialogue effects
    this.world.on(EventType.BANK_OPEN_REQUEST, bankOpenHandler);
    this.eventUnsubscribers.push(() =>
      this.world.off(EventType.BANK_OPEN_REQUEST, bankOpenHandler),
    );

    // NOTE: We intentionally do NOT listen for BANK_CLOSE events here.
    // Same reasoning as STORE_CLOSE above - user-initiated closes should not
    // clear the server session to avoid race conditions with new UI opens.

    // Listen for dialogue start events to create sessions
    const dialogueStartHandler = (event: unknown) => {
      const data = event as {
        playerId: string;
        npcId?: string;
        npcEntityId?: string;
      };
      const entityId = data.npcEntityId || data.npcId;
      if (data.playerId && entityId) {
        const socket = this.broadcast.getPlayerSocket(data.playerId);
        if (socket) {
          this.openSession({
            playerId: data.playerId,
            socketId: socket.id,
            sessionType: "dialogue",
            targetEntityId: entityId,
          });
        }
      }
    };
    // Use string literal due to TypeScript type resolution issue across packages
    // The EventType.DIALOGUE_START enum exists but TypeScript can't resolve it
    this.world.on(
      "dialogue:start" as keyof typeof EventType,
      dialogueStartHandler,
    );
    this.eventUnsubscribers.push(() =>
      this.world.off(
        "dialogue:start" as keyof typeof EventType,
        dialogueStartHandler,
      ),
    );

    // NOTE: We intentionally do NOT listen for DIALOGUE_END events here.
    // Same reasoning as STORE_CLOSE above - user-initiated closes should not
    // clear the server session to avoid race conditions with new UI opens.

    // rules-accurate: Close bank/store/dialogue if player is attacked
    // In classic MMORPG, being attacked (even a splash/miss) interrupts banking
    const combatDamageHandler = (event: unknown) => {
      const data = event as {
        targetId?: string;
        targetType?: "player" | "mob";
      };
      // Guard: ensure required fields exist (defensive against malformed events)
      if (!data.targetId || data.targetType !== "player") {
        return;
      }
      // rules-accurate: Close session when player is ATTACKED, not just when taking damage
      // Even a splash/miss (damage=0) interrupts banking - being in combat matters
      if (this.sessions.has(data.targetId)) {
        this.closeSession(data.targetId, "combat");
      }
    };
    this.world.on(EventType.COMBAT_DAMAGE_DEALT, combatDamageHandler);
    this.eventUnsubscribers.push(() =>
      this.world.off(EventType.COMBAT_DAMAGE_DEALT, combatDamageHandler),
    );
  }

  /**
   * Destroy the session manager
   *
   * Cleans up tick subscription, event listeners, and closes all sessions.
   */
  destroy(): void {
    // Unsubscribe from tick system
    if (this.unsubscribeTick) {
      this.unsubscribeTick();
      this.unsubscribeTick = null;
    }

    // Unsubscribe from events
    for (const unsubscribe of this.eventUnsubscribers) {
      unsubscribe();
    }
    this.eventUnsubscribers = [];

    this.sessions.clear();
  }

  /**
   * Open a new interaction session
   *
   * Replaces any existing session for the player (can only have one UI open).
   */
  openSession(params: {
    playerId: string;
    socketId: string;
    sessionType: SessionType;
    targetEntityId: string;
    targetStoreId?: string;
  }): void {
    // Close any existing session for this player
    this.closeSession(params.playerId, "new_session");

    const session: InternalSession = {
      playerId: params.playerId,
      socketId: params.socketId,
      sessionType: params.sessionType,
      targetEntityId: params.targetEntityId,
      targetStoreId: params.targetStoreId,
      openedAtTick: this.tickCounter,
      lastValidatedAt: this.tickCounter,
    };

    this.sessions.set(params.playerId, session);
  }

  /**
   * Close a player's interaction session
   *
   * @param playerId - Player whose session to close
   * @param reason - Why the session is closing (for logging)
   * @param sendPacket - Whether to send close packet to client (default true)
   */
  closeSession(
    playerId: string,
    reason: SessionCloseReason = "user_action",
    sendPacket = true,
  ): void {
    const session = this.sessions.get(playerId);
    if (!session) {
      return;
    }

    this.sessions.delete(playerId);

    // Send close packet to client (unless closing due to disconnect or new_session)
    // When reason is "new_session", we're replacing the session with a new one,
    // so we don't want to close the UI - the new UI will just replace it.
    // This fixes the bug where reopening bank without moving would immediately close.
    if (sendPacket && reason !== "disconnect" && reason !== "new_session") {
      const packetName = this.getClosePacketName(session.sessionType);
      this.broadcast.sendToPlayer(playerId, packetName, {
        reason,
        sessionType: session.sessionType,
      });
    }
  }

  /**
   * Check if a player has an active session
   */
  hasSession(playerId: string): boolean {
    return this.sessions.has(playerId);
  }

  /**
   * Get a player's active session
   * Returns the shared interface type (ISessionReader contract)
   */
  getSession(playerId: string): SharedInteractionSession | undefined {
    return this.sessions.get(playerId);
  }

  /**
   * Handle player disconnect - close any active session
   */
  onPlayerDisconnect(playerId: string): void {
    this.closeSession(playerId, "disconnect", false);
  }

  /**
   * Tick handler - validates sessions periodically
   */
  private onTick(tickNumber: number): void {
    this.tickCounter = tickNumber;

    // Only validate every N ticks to reduce CPU usage
    if (tickNumber % SESSION_CONFIG.VALIDATION_INTERVAL_TICKS !== 0) {
      return;
    }

    this.validateAllSessions();
  }

  /**
   * Validate all active sessions
   *
   * Checks distance and timeout for each session and closes those that fail.
   */
  private validateAllSessions(): void {
    for (const [playerId, session] of this.sessions) {
      const ticksSinceOpen = this.tickCounter - session.openedAtTick;

      // Skip sessions in grace period
      if (ticksSinceOpen < SESSION_CONFIG.GRACE_PERIOD_TICKS) {
        continue;
      }

      // Close zombie sessions that have been open too long (30 min default)
      if (ticksSinceOpen >= SESSION_CONFIG.MAX_SESSION_TICKS) {
        this.closeSession(playerId, "timeout");
        continue;
      }

      const validationResult = this.validateSession(session);
      if (!validationResult.valid) {
        this.closeSession(playerId, validationResult.reason);
      }

      session.lastValidatedAt = this.tickCounter;
    }
  }

  /**
   * Validate a single session
   *
   * Checks if player is still in range of the target entity.
   */
  private validateSession(session: InternalSession): {
    valid: boolean;
    reason: Extract<SessionCloseReason, "distance" | "target_gone">;
  } {
    // Get player entity
    const playerSocket = this.broadcast.getPlayerSocket(session.playerId);
    const playerEntity = playerSocket?.player;
    if (!playerEntity?.position) {
      // Player not found - might have disconnected, will be cleaned up
      return { valid: true, reason: "distance" };
    }

    // Get target entity
    const targetEntity = this.world.entities?.get?.(session.targetEntityId);
    if (!targetEntity) {
      // Target entity no longer exists
      return { valid: false, reason: "target_gone" };
    }

    // Get target position
    const targetPos =
      (targetEntity as { position?: { x: number; z: number } }).position ||
      (targetEntity as { base?: { position?: { x: number; z: number } } }).base
        ?.position;
    if (!targetPos) {
      // Target has no position - shouldn't happen, but treat as gone
      return { valid: false, reason: "target_gone" };
    }

    // Calculate distance (Chebyshev/classic MMORPG-style) using shared function and constants
    const distance = chebyshevDistance(playerEntity.position, targetPos);
    const maxDistance = INTERACTION_DISTANCE[session.sessionType];

    if (distance > maxDistance) {
      return { valid: false, reason: "distance" };
    }

    return { valid: true, reason: "distance" };
  }

  /**
   * Get the appropriate close packet name for a session type
   */
  private getClosePacketName(sessionType: SessionType): string {
    switch (sessionType) {
      case "store":
        return "storeClose";
      case "bank":
        return "bankClose";
      case "dialogue":
        return "dialogueClose";
    }
  }

  /**
   * Get current session count (for monitoring)
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
