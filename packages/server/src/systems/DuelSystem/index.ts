/**
 * DuelSystem - Server-authoritative player-to-player dueling (rules-accurate)
 *
 * Manages duel sessions with rules negotiation, stakes, and combat enforcement.
 *
 * Duel Flow:
 * 1. Player A challenges Player B (in Duel Arena zone)
 * 2. Player B accepts/declines challenge
 * 3. Rules screen: Both players toggle rules and accept
 * 4. Stakes screen: Both players stake items/gold and accept
 * 5. Confirmation screen: Read-only review, both accept
 * 6. Teleport to arena with countdown
 * 7. Combat with rule enforcement
 * 8. Winner receives stakes, loser respawns at hospital
 *
 * Security:
 * - All operations are server-authoritative
 * - Stakes are locked during duel
 * - Rules are validated for invalid combinations
 * - Arena bounds enforced server-side
 *
 * @see packages/shared/src/types/game/duel-types.ts for type definitions
 */

import type { World } from "@hyperforge/shared";
import {
  EventType,
  PlayerEntity,
  getDuelArenaConfig,
  getDuelArenaEgressPosition,
  isPositionInsideCombatArena,
  type DuelRules,
  type DuelState,
  type StakedItem,
  type PlayerID,
  createPlayerID,
  createSlotNumber,
  createItemID,
  validateRuleCombination,
  DuelErrorCode,
  getItem,
} from "@hyperforge/shared";
import { PendingDuelManager } from "./PendingDuelManager";
import { ArenaPoolManager } from "./ArenaPoolManager";
import {
  DuelSessionManager,
  type ServerDuelSession,
  type EquipmentRestrictions,
  getSessionOpponentId,
} from "./DuelSessionManager";
import { DuelCombatResolver } from "./DuelCombatResolver";
import {
  isPlayerDisconnectPayload,
  isEntityDeathPayload,
  isPlayerDeath,
} from "./validation";
import { AuditLogger, Logger } from "../ServerNetwork/services";
import {
  DISCONNECT_TIMEOUT_TICKS,
  SETUP_DISCONNECT_GRACE_TICKS,
  CLEANUP_INTERVAL_TICKS,
  SESSION_MAX_AGE_TICKS,
  DEATH_RESOLUTION_DELAY_TICKS,
  POSITION_TOLERANCE,
  MAX_STAKES_PER_PLAYER,
  ticksToMs,
  TICK_DURATION_MS,
} from "./config";
import { DUEL_ERRORS } from "./error-messages";
import { getDuelFoodItemForLevels, isDuelFoodItemId } from "../duelFood.js";
import {
  STREAMING_DUEL_ARENA_ID,
  STREAMING_DUEL_ARENA_RESERVATION_ID,
} from "./streaming-arena.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Exhaustiveness check helper for switch statements.
 * TypeScript will error if any enum value is not handled.
 */
function assertNever(value: never): never {
  throw new Error(
    `Unexpected value in exhaustive check: ${JSON.stringify(value)}`,
  );
}

// ============================================================================
// Types
// ============================================================================

// Re-export ServerDuelSession from DuelSessionManager for external use
export type {
  ServerDuelSession,
  EquipmentRestrictions,
} from "./DuelSessionManager";

/**
 * Result of a duel operation
 */
export type DuelOperationResult = {
  success: boolean;
  error?: string;
  errorCode?: DuelErrorCode;
};

type DuelFoodProvisionedSlot = {
  slot: number;
  itemId: string;
};

// ============================================================================
// DuelSystem Class
// ============================================================================

export class DuelSystem {
  private readonly world: World;

  /** Manager for pending duel challenges */
  public readonly pendingDuels: PendingDuelManager;

  /** Manager for arena pool */
  public readonly arenaPool: ArenaPoolManager;

  /** Manager for duel session CRUD operations */
  private readonly sessionManager: DuelSessionManager;

  /** Manager for combat resolution and stake transfers */
  private readonly combatResolver: DuelCombatResolver;

  /** Cleanup interval handle */
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Registered world event listeners (for cleanup in destroy()) */
  private readonly eventListeners: Array<{
    event: string;
    fn: (...args: unknown[]) => void;
  }> = [];

  /** Monotonic tick counter, incremented each processTick() call */
  private currentTick = 0;

  /** Duel-food slots provisioned for duel bots; cleared on duel end. */
  private duelBotFoodSlotsByPlayer: Map<string, DuelFoodProvisionedSlot[]> =
    new Map();

  /** True only while this instance owns the process-wide streaming arena. */
  private streamingArenaReserved = false;

  /** Prayer custody must settle before an ordinary duel can enter combat. */
  private readonly pendingFightStarts = new Map<string, Promise<void>>();

  /** Finished sessions remain fenced until their prayer restore barrier ends. */
  private readonly pendingResolutionCleanup = new Set<string>();

  /** Prevent lifecycle continuations from publishing after teardown. */
  private isDestroyed = false;

  constructor(world: World) {
    this.world = world;
    this.pendingDuels = new PendingDuelManager(world);
    this.arenaPool = new ArenaPoolManager();
    this.sessionManager = new DuelSessionManager(world);
    this.combatResolver = new DuelCombatResolver(world);
  }

  /**
   * Initialize the duel system
   */
  init(): void {
    this.isDestroyed = false;
    if (process.env.STREAMING_DUEL_ENABLED === "true") {
      if (
        !this.arenaPool.reserveSpecificArena(
          STREAMING_DUEL_ARENA_ID,
          STREAMING_DUEL_ARENA_RESERVATION_ID,
        )
      ) {
        throw new Error(
          `[DuelSystem] Streaming arena ${STREAMING_DUEL_ARENA_ID} is unavailable; refusing to start with split arena ownership`,
        );
      }
      this.streamingArenaReserved = true;
    }

    // Initialize pending duel manager
    try {
      this.pendingDuels.init();

      // Register arena wall collision to prevent players from escaping arenas
      this.arenaPool.registerArenaWallCollision(this.world.collision);
    } catch (error) {
      this.pendingDuels.destroy();
      this.releaseStreamingArenaReservation();
      throw error;
    }

    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, ticksToMs(CLEANUP_INTERVAL_TICKS));

    // Subscribe to player disconnect events with runtime validation
    const onPlayerLeft = (payload: unknown) => {
      if (!isPlayerDisconnectPayload(payload)) {
        Logger.warn("DuelSystem", "Invalid PLAYER_LEFT payload", { payload });
        return;
      }
      this.onPlayerDisconnect(payload.playerId);
    };
    this.world.on(EventType.PLAYER_LEFT, onPlayerLeft);
    this.eventListeners.push({
      event: EventType.PLAYER_LEFT,
      fn: onPlayerLeft,
    });

    const onPlayerLogout = (payload: unknown) => {
      if (!isPlayerDisconnectPayload(payload)) {
        Logger.warn("DuelSystem", "Invalid PLAYER_LOGOUT payload", { payload });
        return;
      }
      this.onPlayerDisconnect(payload.playerId);
    };
    this.world.on(EventType.PLAYER_LOGOUT, onPlayerLogout);
    this.eventListeners.push({
      event: EventType.PLAYER_LOGOUT,
      fn: onPlayerLogout,
    });

    // Subscribe to player death to end duel (ENTITY_DEATH is emitted when health reaches 0)
    const onEntityDeath = (payload: unknown) => {
      if (!isEntityDeathPayload(payload)) {
        Logger.warn("DuelSystem", "Invalid ENTITY_DEATH payload", { payload });
        return;
      }
      // Only handle player deaths
      if (isPlayerDeath(payload)) {
        this.handlePlayerDeath(payload.entityId);
      }
    };
    this.world.on(EventType.ENTITY_DEATH, onEntityDeath);
    this.eventListeners.push({
      event: EventType.ENTITY_DEATH,
      fn: onEntityDeath,
    });

    // Verify critical event listeners are registered after all systems initialize.
    // If ServerNetwork hasn't registered its duel:stakes:settle listener,
    // stake transfers will silently fire into the void.
    setTimeout(() => {
      const listenerCount =
        (
          this.world as { listenerCount?: (event: string) => number }
        ).listenerCount?.("duel:stakes:settle") ?? -1;
      if (listenerCount === 0) {
        Logger.error(
          "DuelSystem",
          "CRITICAL: No listener for duel:stakes:settle — stake transfers will fail!",
        );
      } else {
        Logger.debug("DuelSystem", "Listener verification passed", {
          "duel:stakes:settle": listenerCount,
        });
      }
    }, 0);

    Logger.info("DuelSystem", "Initialized");
  }

  /**
   * Cleanup when system is destroyed
   */
  destroy(): void {
    this.isDestroyed = true;
    // Remove world event listeners to prevent leaks
    for (const { event, fn } of this.eventListeners) {
      this.world.off(event, fn);
    }
    this.eventListeners.length = 0;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Cancel all active duels (pendingDisconnect/pendingResolution cleared with sessions)
    for (const [duelId] of this.sessionManager.getAllSessions()) {
      this.cancelDuel(duelId, "server_shutdown");
    }

    this.sessionManager.clearAllSessions();
    this.pendingDuels.destroy();
    this.duelBotFoodSlotsByPlayer.clear();
    this.pendingFightStarts.clear();
    this.pendingResolutionCleanup.clear();
    this.combatResolver.destroy();
    this.releaseStreamingArenaReservation();

    Logger.info("DuelSystem", "Destroyed");
  }

  private releaseStreamingArenaReservation(): void {
    if (!this.streamingArenaReserved) return;

    const released = this.arenaPool.releaseSpecificArena(
      STREAMING_DUEL_ARENA_ID,
      STREAMING_DUEL_ARENA_RESERVATION_ID,
    );
    if (!released) {
      Logger.error(
        "DuelSystem",
        "Streaming arena reservation ownership was lost before teardown",
        null,
        { arenaId: STREAMING_DUEL_ARENA_ID },
      );
    }
    this.streamingArenaReserved = false;
  }

  /**
   * Process tick - called every server tick
   */
  processTick(): void {
    this.currentTick++;

    // Process pending challenges (distance checks, timeouts)
    this.pendingDuels.processTick();

    // Process active duels
    for (const [_duelId, session] of this.sessionManager.getAllSessions()) {
      // Exhaustive switch ensures all states are handled
      switch (session.state) {
        case "RULES":
        case "STAKES":
        case "CONFIRMING":
          // Check for pending setup disconnect grace period expiry
          if (
            session.pendingSetupDisconnect &&
            this.currentTick >= session.pendingSetupDisconnect.cancelAtTick
          ) {
            const { playerId: dcPlayerId } = session.pendingSetupDisconnect;
            session.pendingSetupDisconnect = undefined;
            this.cancelDuel(session.duelId, "player_disconnected", dcPlayerId);
          }
          break;
        case "COUNTDOWN":
          this.processCountdown(session);
          break;
        case "FIGHTING":
          this.processActiveDuel(session);
          // Check for pending disconnect auto-forfeit (tick-based)
          if (
            session.pendingDisconnect &&
            this.currentTick >= session.pendingDisconnect.forfeitAtTick
          ) {
            const { playerId } = session.pendingDisconnect;
            session.pendingDisconnect = undefined;

            // Verify session is still in FIGHTING state
            if (session.state === "FIGHTING") {
              const winnerId = getSessionOpponentId(session, playerId);
              this.resolveDuel(session, winnerId, playerId, "forfeit");
            }
          }
          break;
        case "FINISHED":
          // Check for pending death resolution (tick-based)
          if (
            session.pendingResolution &&
            this.currentTick >= session.pendingResolution.resolveAtTick
          ) {
            const { winnerId, loserId, reason } = session.pendingResolution;
            session.pendingResolution = undefined;

            // Verify session still exists and is in correct state
            if (session.state === "FINISHED") {
              Logger.debug("DuelSystem", "Resolving duel after death (tick)", {
                duelId: session.duelId,
                winnerId,
                loserId,
                tick: this.currentTick,
              });
              this.resolveDuel(session, winnerId, loserId, reason);
            }
          }
          break;
        default:
          // TypeScript exhaustiveness check - ensures all DuelState values are handled
          assertNever(session.state);
      }
    }

    this.ejectNonDuelingPlayersFromCombatArenas();
  }

  // ============================================================================
  // Public API - Challenge Flow
  // ============================================================================

  /**
   * Create a duel challenge from challenger to target
   */
  createChallenge(
    challengerId: string,
    challengerName: string,
    challengerSocketId: string,
    challengerCombatLevel: number,
    targetId: string,
    targetName: string,
  ): DuelOperationResult & { challengeId?: string } {
    // Check for self-challenge
    if (challengerId === targetId) {
      return {
        success: false,
        error: DUEL_ERRORS.SELF_CHALLENGE,
        errorCode: DuelErrorCode.INVALID_TARGET,
      };
    }

    // Check if either player is already in a duel
    if (this.sessionManager.isPlayerInDuel(challengerId)) {
      return {
        success: false,
        error: DUEL_ERRORS.ALREADY_IN_DUEL,
        errorCode: DuelErrorCode.ALREADY_IN_DUEL,
      };
    }

    if (this.sessionManager.isPlayerInDuel(targetId)) {
      return {
        success: false,
        error: DUEL_ERRORS.TARGET_IN_DUEL,
        errorCode: DuelErrorCode.TARGET_BUSY,
      };
    }

    // Create pending challenge
    const result = this.pendingDuels.createChallenge(
      createPlayerID(challengerId),
      challengerName,
      challengerSocketId,
      challengerCombatLevel,
      createPlayerID(targetId),
      targetName,
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        errorCode: DuelErrorCode.CHALLENGE_PENDING,
      };
    }

    return {
      success: true,
      challengeId: result.challengeId,
    };
  }

  /**
   * Respond to a duel challenge (accept or decline)
   */
  respondToChallenge(
    challengeId: string,
    responderId: string,
    accept: boolean,
  ): DuelOperationResult & { duelId?: string } {
    if (accept) {
      const challenge = this.pendingDuels.acceptChallenge(
        challengeId,
        responderId,
      );
      if (!challenge) {
        return {
          success: false,
          error: DUEL_ERRORS.CHALLENGE_NOT_FOUND_EXPIRED,
          errorCode: DuelErrorCode.CHALLENGE_NOT_FOUND,
        };
      }

      // Create duel session
      const duelId = this.createDuelSession(
        challenge.challengerId,
        challenge.challengerName,
        challenge.targetId,
        challenge.targetName,
      );

      return { success: true, duelId };
    } else {
      const challenge = this.pendingDuels.declineChallenge(
        challengeId,
        responderId,
      );
      if (!challenge) {
        return {
          success: false,
          error: DUEL_ERRORS.CHALLENGE_NOT_FOUND,
          errorCode: DuelErrorCode.CHALLENGE_NOT_FOUND,
        };
      }

      // Emit decline event for notification
      this.world.emit("duel:challenge:declined", {
        challengeId,
        challengerId: challenge.challengerId,
        targetId: challenge.targetId,
      });

      return { success: true };
    }
  }

  // ============================================================================
  // Public API - Duel Session Management
  // ============================================================================

  /**
   * Get a duel session by ID
   */
  getDuelSession(duelId: string): ServerDuelSession | undefined {
    return this.sessionManager.getSession(duelId);
  }

  /**
   * Get the duel session a player is currently in
   */
  getPlayerDuel(playerId: string): ServerDuelSession | undefined {
    return this.sessionManager.getPlayerSession(playerId);
  }

  /**
   * Get the duel ID for a player
   */
  getPlayerDuelId(playerId: string): string | undefined {
    return this.sessionManager.getPlayerDuelId(playerId);
  }

  /**
   * Check if a player is in an active duel
   */
  isPlayerInDuel(playerId: string): boolean {
    return this.sessionManager.isPlayerInDuel(playerId);
  }

  /**
   * Get just the state of a duel session without exposing internals
   */
  getSessionState(duelId: string): DuelState | undefined {
    return this.sessionManager.getSession(duelId)?.state;
  }

  /**
   * Get inventory slots that are currently staked by a player.
   * Used to prevent trading/dropping staked items.
   */
  getStakedSlots(playerId: string): Set<number> {
    const session = this.sessionManager.getPlayerSession(playerId);
    if (!session) return new Set();

    const stakes = this.sessionManager.getPlayerStakes(session, playerId);
    return new Set((stakes ?? []).map((s) => s.inventorySlot));
  }

  /**
   * Cancel a duel session
   */
  cancelDuel(
    duelId: string,
    reason: string,
    cancelledBy?: string,
  ): DuelOperationResult {
    const session = this.sessionManager.getSession(duelId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_FOUND,
        errorCode: DuelErrorCode.DUEL_NOT_FOUND,
      };
    }

    // SAFETY: Never cancel a session that is already being resolved.
    // FINISHED means resolveDuel is pending (e.g., death animation delay).
    // Cancelling here would delete the session and prevent teleportation.
    if (session.state === "FINISHED") {
      Logger.warn(
        "DuelSystem",
        "Cannot cancel FINISHED duel - resolution pending",
        {
          duelId,
          reason,
          cancelledBy,
        },
      );
      return {
        success: false,
        error: DUEL_ERRORS.ALREADY_RESOLVING,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    // Return staked items to both players
    this.combatResolver.returnStakedItems(session);
    this.removeDuelBotFoodForPlayers(
      session.challengerId,
      session.targetId,
      "cancel",
    );

    // Release arena if one was reserved
    if (session.arenaId !== null) {
      this.releaseArena(session.arenaId, session.duelId);
    }

    // Clean up session
    this.sessionManager.deleteSession(duelId);

    // Emit cancel event
    this.world.emit("duel:cancelled", {
      duelId,
      challengerId: session.challengerId,
      targetId: session.targetId,
      reason,
      cancelledBy,
    });

    // AUDIT: Log duel cancellation if stakes were involved
    if (
      session.challengerStakes.length > 0 ||
      session.targetStakes.length > 0
    ) {
      AuditLogger.getInstance().logDuelCancelled(
        duelId,
        cancelledBy,
        reason,
        session.challengerId,
        session.targetId,
        session.challengerStakes,
        session.targetStakes,
      );
    }

    return { success: true };
  }

  // ============================================================================
  // Public API - Rules
  // ============================================================================

  /**
   * Toggle a duel rule
   */
  toggleRule(
    duelId: string,
    playerId: string,
    rule: keyof DuelRules,
  ): DuelOperationResult {
    const session = this.sessionManager.getSession(duelId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_FOUND,
        errorCode: DuelErrorCode.DUEL_NOT_FOUND,
      };
    }

    // Must be in RULES state
    if (session.state !== "RULES") {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_STATE_RULES,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    // Must be a participant
    if (playerId !== session.challengerId && playerId !== session.targetId) {
      return {
        success: false,
        error: DUEL_ERRORS.NOT_PARTICIPANT,
        errorCode: DuelErrorCode.NOT_PARTICIPANT,
      };
    }

    // Toggle the rule
    const newValue = !session.rules[rule];

    // Validate rule combination
    const tempRules = { ...session.rules, [rule]: newValue };
    const validationError = validateRuleCombination(tempRules);
    if (validationError !== null) {
      return {
        success: false,
        error: validationError,
        errorCode: DuelErrorCode.INVALID_RULE_COMBINATION,
      };
    }

    // Apply the change
    session.rules[rule] = newValue;

    // Reset both players' acceptance when rules change
    session.challengerAccepted = false;
    session.targetAccepted = false;

    // Emit update
    this.world.emit("duel:rules:updated", {
      duelId,
      rules: session.rules,
      modifiedBy: playerId,
    });

    return { success: true };
  }

  /**
   * Toggle equipment slot restriction
   */
  toggleEquipmentRestriction(
    duelId: string,
    playerId: string,
    slot: keyof ServerDuelSession["equipmentRestrictions"],
  ): DuelOperationResult {
    const session = this.sessionManager.getSession(duelId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_FOUND,
        errorCode: DuelErrorCode.DUEL_NOT_FOUND,
      };
    }

    // Must be in RULES state
    if (session.state !== "RULES") {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_STATE_EQUIPMENT,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    // Must be a participant
    if (playerId !== session.challengerId && playerId !== session.targetId) {
      return {
        success: false,
        error: DUEL_ERRORS.NOT_PARTICIPANT,
        errorCode: DuelErrorCode.NOT_PARTICIPANT,
      };
    }

    // Toggle the restriction
    session.equipmentRestrictions[slot] = !session.equipmentRestrictions[slot];

    // Reset both players' acceptance when equipment changes
    session.challengerAccepted = false;
    session.targetAccepted = false;

    // Emit update
    this.world.emit("duel:equipment:updated", {
      duelId,
      equipmentRestrictions: session.equipmentRestrictions,
      modifiedBy: playerId,
    });

    return { success: true };
  }

  /**
   * Accept current rules
   */
  acceptRules(duelId: string, playerId: string): DuelOperationResult {
    const session = this.sessionManager.getSession(duelId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_FOUND,
        errorCode: DuelErrorCode.DUEL_NOT_FOUND,
      };
    }

    if (session.state !== "RULES") {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_STATE_ACCEPT_RULES,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    return this.handleAcceptance(session, playerId, "STAKES");
  }

  // ============================================================================
  // Public API - Stakes
  // ============================================================================

  /**
   * Add an item to player's stakes
   */
  addStake(
    duelId: string,
    playerId: string,
    inventorySlot: number,
    itemId: string,
    quantity: number,
  ): DuelOperationResult {
    const session = this.sessionManager.getSession(duelId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_FOUND,
        errorCode: DuelErrorCode.DUEL_NOT_FOUND,
      };
    }

    // Must be in STAKES state
    if (session.state !== "STAKES") {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_STATE_STAKES,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    // Must be a participant
    const stakes = this.sessionManager.getPlayerStakes(session, playerId);
    if (!stakes) {
      return {
        success: false,
        error: DUEL_ERRORS.NOT_PARTICIPANT,
        errorCode: DuelErrorCode.NOT_PARTICIPANT,
      };
    }

    // Validate quantity is a positive integer
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_QUANTITY,
        errorCode: DuelErrorCode.INVALID_QUANTITY,
      };
    }

    // Enforce maximum stakes per player
    if (stakes.length >= MAX_STAKES_PER_PLAYER) {
      return {
        success: false,
        error: DUEL_ERRORS.MAX_STAKES_REACHED,
        errorCode: DuelErrorCode.INVALID_QUANTITY,
      };
    }

    // Check if this inventory slot is already staked
    // SECURITY: Reject duplicate slots to prevent item duplication via rapid clicking
    const existingIndex = stakes.findIndex(
      (s) => s.inventorySlot === inventorySlot,
    );
    if (existingIndex >= 0) {
      return {
        success: false,
        error: DUEL_ERRORS.ALREADY_STAKED,
        errorCode: DuelErrorCode.ALREADY_STAKED,
      };
    }

    // Server-side value lookup — never trust client-provided value
    const itemData = getItem(itemId);
    const serverValue = (itemData?.value ?? 0) * quantity;

    // Add new stake
    stakes.push({
      inventorySlot: createSlotNumber(inventorySlot),
      itemId: createItemID(itemId),
      quantity,
      value: serverValue,
    });

    // Reset both players' acceptance when stakes change
    session.challengerAccepted = false;
    session.targetAccepted = false;

    // Emit update
    this.world.emit("duel:stakes:updated", {
      duelId,
      challengerStakes: session.challengerStakes,
      targetStakes: session.targetStakes,
      modifiedBy: playerId,
    });

    return { success: true };
  }

  /**
   * Remove an item from player's stakes
   */
  removeStake(
    duelId: string,
    playerId: string,
    stakeIndex: number,
  ): DuelOperationResult {
    const session = this.sessionManager.getSession(duelId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_FOUND,
        errorCode: DuelErrorCode.DUEL_NOT_FOUND,
      };
    }

    // Must be in STAKES state
    if (session.state !== "STAKES") {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_STATE_STAKES,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    // Must be a participant
    const stakes = this.sessionManager.getPlayerStakes(session, playerId);
    if (!stakes) {
      return {
        success: false,
        error: DUEL_ERRORS.NOT_PARTICIPANT,
        errorCode: DuelErrorCode.NOT_PARTICIPANT,
      };
    }

    // Validate index is a non-negative integer within bounds
    if (
      !Number.isInteger(stakeIndex) ||
      stakeIndex < 0 ||
      stakeIndex >= stakes.length
    ) {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_STAKE_INDEX,
        errorCode: DuelErrorCode.STAKE_NOT_FOUND,
      };
    }

    // Remove the stake
    stakes.splice(stakeIndex, 1);

    // Reset both players' acceptance when stakes change
    session.challengerAccepted = false;
    session.targetAccepted = false;

    // Emit update
    this.world.emit("duel:stakes:updated", {
      duelId,
      challengerStakes: session.challengerStakes,
      targetStakes: session.targetStakes,
      modifiedBy: playerId,
    });

    return { success: true };
  }

  /**
   * Accept current stakes
   */
  acceptStakes(duelId: string, playerId: string): DuelOperationResult {
    const session = this.sessionManager.getSession(duelId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_FOUND,
        errorCode: DuelErrorCode.DUEL_NOT_FOUND,
      };
    }

    if (session.state !== "STAKES") {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_STATE_ACCEPT_STAKES,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    return this.handleAcceptance(session, playerId, "CONFIRMING");
  }

  // ============================================================================
  // Public API - Confirmation
  // ============================================================================

  /**
   * Accept final confirmation to start the duel
   */
  acceptFinal(
    duelId: string,
    playerId: string,
  ): DuelOperationResult & { arenaId?: number } {
    const session = this.sessionManager.getSession(duelId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_FOUND,
        errorCode: DuelErrorCode.DUEL_NOT_FOUND,
      };
    }

    if (session.state !== "CONFIRMING") {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_STATE_CONFIRM,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    // Validate participant
    if (playerId !== session.challengerId && playerId !== session.targetId) {
      return {
        success: false,
        error: DUEL_ERRORS.NOT_PARTICIPANT,
        errorCode: DuelErrorCode.NOT_PARTICIPANT,
      };
    }

    // Set acceptance
    const bothAccepted = this.sessionManager.setPlayerAcceptance(
      session,
      playerId,
      true,
    );

    if (!bothAccepted) {
      this.world.emit("duel:acceptance:updated", {
        duelId,
        challengerAccepted: session.challengerAccepted,
        targetAccepted: session.targetAccepted,
      });
      return { success: true };
    }

    // Both accepted — try to reserve an arena
    const arenaId = this.reserveArena(duelId);
    if (arenaId === null) {
      this.sessionManager.resetAcceptance(session);

      Logger.warn("DuelSystem", "Arena pool exhausted - all arenas in use", {
        duelId,
        totalArenas: this.arenaPool.totalArenas,
      });

      return {
        success: false,
        error: DUEL_ERRORS.NO_ARENA_AVAILABLE,
        errorCode: DuelErrorCode.NO_ARENA_AVAILABLE,
      };
    }

    // Arena reserved — reset acceptance and start countdown
    this.sessionManager.resetAcceptance(session);
    session.arenaId = arenaId;
    session.state = "COUNTDOWN";
    session.countdownStartedAt = Date.now();
    session.countdownStartTick = this.currentTick;
    session.lastCountdownTick = 3;

    // Teleport players to arena and apply equipment restrictions
    this.teleportPlayersToArena(session);
    this.applyEquipmentRestrictions(session);

    this.world.emit("duel:countdown:start", {
      duelId,
      arenaId,
      challengerId: session.challengerId,
      targetId: session.targetId,
    });

    // Emit initial countdown tick (3) immediately after teleport
    // This ensures players see "3" right away instead of waiting for first processTick
    this.world.emit("duel:countdown:tick", {
      duelId: session.duelId,
      count: 3,
      challengerId: session.challengerId,
      targetId: session.targetId,
    });

    return { success: true, arenaId };
  }

  // ============================================================================
  // Public API - Arena Management
  // ============================================================================

  /**
   * Reserve an available arena for a duel
   * Returns arena ID or null if none available
   */
  reserveArena(duelId: string): number | null {
    return this.arenaPool.reserveArena(duelId);
  }

  /**
   * Release an arena back to the pool
   */
  releaseArena(arenaId: number, duelId: string): void {
    if (this.arenaPool.releaseSpecificArena(arenaId, duelId)) {
      this.world.emit("duel:arena:released", { arenaId });
    } else {
      Logger.error(
        "DuelSystem",
        "Refused to release an arena owned by another lifecycle",
        null,
        { arenaId, duelId },
      );
    }
  }

  /**
   * Get spawn points for an arena
   */
  getArenaSpawnPoints(
    arenaId: number,
  ):
    | [{ x: number; y: number; z: number }, { x: number; y: number; z: number }]
    | undefined {
    return this.arenaPool.getSpawnPoints(arenaId);
  }

  /**
   * Get arena bounds for movement validation
   */
  getArenaBounds(arenaId: number) {
    return this.arenaPool.getArenaBounds(arenaId);
  }

  // ============================================================================
  // Public API - Rule Enforcement
  // ============================================================================

  /**
   * Check if a player is in an active duel (FIGHTING or FINISHED state)
   * CRITICAL: Include FINISHED state because when a player dies:
   * 1. DuelSystem.handlePlayerDeath() sets state to FINISHED
   * 2. THEN PlayerDeathSystem.handlePlayerDeath() checks isPlayerInActiveDuel()
   * Without FINISHED, PlayerDeathSystem would treat duel deaths as normal deaths
   */
  isPlayerInActiveDuel(playerId: string): boolean {
    const session = this.getPlayerDuel(playerId);
    // Include FINISHED state to handle the death animation window
    return session?.state === "FIGHTING" || session?.state === "FINISHED";
  }

  /**
   * Get active duel rules for a player (null if not in active duel)
   */
  getPlayerDuelRules(playerId: string): DuelRules | null {
    const session = this.getPlayerDuel(playerId);
    if (!session || session.state !== "FIGHTING") return null;
    return session.rules;
  }

  /**
   * Check if a specific rule is active for a player's duel
   */
  isDuelRuleActive(playerId: string, rule: keyof DuelRules): boolean {
    const rules = this.getPlayerDuelRules(playerId);
    return rules ? rules[rule] : false;
  }

  /**
   * Check if player can use ranged attacks (returns false if noRanged rule active)
   */
  canUseRanged(playerId: string): boolean {
    return !this.isDuelRuleActive(playerId, "noRanged");
  }

  /**
   * Check if player can use melee attacks (returns false if noMelee rule active)
   */
  canUseMelee(playerId: string): boolean {
    return !this.isDuelRuleActive(playerId, "noMelee");
  }

  /**
   * Check if player can use magic attacks (returns false if noMagic rule active)
   */
  canUseMagic(playerId: string): boolean {
    return !this.isDuelRuleActive(playerId, "noMagic");
  }

  /**
   * Check if player can use special attacks (returns false if noSpecialAttack rule active)
   */
  canUseSpecialAttack(playerId: string): boolean {
    return !this.isDuelRuleActive(playerId, "noSpecialAttack");
  }

  /**
   * Check if player can use prayer (returns false if noPrayer rule active)
   */
  canUsePrayer(playerId: string): boolean {
    return !this.isDuelRuleActive(playerId, "noPrayer");
  }

  /**
   * Check if player can use potions (returns false if noPotions rule active)
   */
  canUsePotions(playerId: string): boolean {
    return !this.isDuelRuleActive(playerId, "noPotions");
  }

  /**
   * Check if player can eat food (returns false if noFood rule active)
   */
  canEatFood(playerId: string): boolean {
    return !this.isDuelRuleActive(playerId, "noFood");
  }

  /**
   * Check if player can move
   * Returns false if:
   * - noMovement rule is active during FIGHTING state
   * - Player is in COUNTDOWN state (frozen before fight starts)
   */
  canMove(playerId: string): boolean {
    const session = this.getPlayerDuel(playerId);
    if (!session) return true; // Not in duel, can move freely

    // Freeze during countdown (rules-accurate)
    if (session.state === "COUNTDOWN") {
      return false;
    }

    // Check noMovement rule during fight
    if (session.state === "FIGHTING" && session.rules.noMovement) {
      return false;
    }

    return true;
  }

  /**
   * Check if player can forfeit (returns false if noForfeit rule active)
   */
  canForfeit(playerId: string): boolean {
    return !this.isDuelRuleActive(playerId, "noForfeit");
  }

  /**
   * Get the opponent ID for a player in a duel
   */
  getDuelOpponentId(playerId: string): string | null {
    const session = this.getPlayerDuel(playerId);
    if (!session) return null;
    return getSessionOpponentId(session, playerId);
  }

  // ============================================================================
  // Public API - Forfeit
  // ============================================================================

  /**
   * Handle a player forfeiting the duel
   */
  forfeitDuel(playerId: string): DuelOperationResult {
    const session = this.getPlayerDuel(playerId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.NOT_IN_DUEL,
        errorCode: DuelErrorCode.NOT_IN_DUEL,
      };
    }

    // Must be in FIGHTING state
    if (session.state !== "FIGHTING") {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_STARTED,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    // Check if noForfeit rule is active
    if (session.rules.noForfeit) {
      return {
        success: false,
        error: DUEL_ERRORS.CANNOT_FORFEIT,
        errorCode: DuelErrorCode.CANNOT_FORFEIT,
      };
    }

    // Determine winner and loser
    const winnerId = getSessionOpponentId(session, playerId);
    const loserId = playerId;

    // Mark as forfeited
    session.forfeitedBy = playerId;

    // Resolve the duel
    this.resolveDuel(session, winnerId, loserId, "forfeit");

    return { success: true };
  }

  // ============================================================================
  // Public API - Duel Start
  // ============================================================================

  /**
   * Start the duel countdown after both players confirm.
   * This teleports players to the arena and begins the 3-2-1 countdown.
   */
  startDuelCountdown(duelId: string): DuelOperationResult {
    const session = this.sessionManager.getSession(duelId);
    if (!session) {
      return {
        success: false,
        error: DUEL_ERRORS.DUEL_NOT_FOUND,
        errorCode: DuelErrorCode.DUEL_NOT_FOUND,
      };
    }

    if (session.state !== "COUNTDOWN" || session.arenaId === null) {
      return {
        success: false,
        error: DUEL_ERRORS.INVALID_STATE_COUNTDOWN,
        errorCode: DuelErrorCode.INVALID_STATE,
      };
    }

    // Teleport players to arena
    this.teleportPlayersToArena(session);

    // Apply equipment restrictions
    this.applyEquipmentRestrictions(session);

    // Mark countdown start time (if not already set)
    if (!session.countdownStartedAt) {
      session.countdownStartedAt = Date.now();
      session.countdownStartTick = this.currentTick;
    }

    // Initial countdown value will be processed in processTick
    session.lastCountdownTick = 3;

    return { success: true };
  }

  // ============================================================================
  // Private Methods - Countdown
  // ============================================================================

  /**
   * Process countdown state for a duel session
   */
  private processCountdown(session: ServerDuelSession): void {
    if (session.countdownStartTick === undefined || session.arenaId === null)
      return;

    // Tick-based countdown: derive elapsed time from game ticks (deterministic, drift-free)
    const elapsedTicks = this.currentTick - session.countdownStartTick;
    const elapsedMs = elapsedTicks * TICK_DURATION_MS;
    const countdownSeconds = Math.floor(elapsedMs / 1000);

    // Determine current countdown value (3, 2, 1, 0)
    let currentCount = 3 - countdownSeconds;
    if (currentCount < 0) currentCount = 0;

    // Check if we need to send a countdown tick
    if (
      session.lastCountdownTick === undefined ||
      currentCount < session.lastCountdownTick
    ) {
      session.lastCountdownTick = currentCount;

      // Emit countdown tick to both players
      this.world.emit("duel:countdown:tick", {
        duelId: session.duelId,
        count: currentCount,
        challengerId: session.challengerId,
        targetId: session.targetId,
      });

      // If countdown reached 0, start the fight!
      if (currentCount === 0) {
        this.startFight(session);
      }
    }
  }

  /**
   * Start the actual fight after countdown completes
   */
  private startFight(session: ServerDuelSession): void {
    if (
      this.isDestroyed ||
      session.state !== "COUNTDOWN" ||
      this.pendingFightStarts.has(session.duelId)
    ) {
      return;
    }

    // A production PlayerEntity with PrayerSystem custody must not enter the
    // fight until both exact restore operations have answered. Minimal test or
    // legacy worlds without that system retain the existing synchronous path.
    const restores = [
      this.restorePlayerStats(
        session.challengerId,
        `ordinary-duel-start-prayer:${session.duelId}:${session.challengerId}`,
      ),
      this.restorePlayerStats(
        session.targetId,
        `ordinary-duel-start-prayer:${session.duelId}:${session.targetId}`,
      ),
    ].filter((restore): restore is Promise<boolean> => restore !== null);

    if (restores.length === 0) {
      this.finalizeFightStart(session);
      return;
    }

    const pending = Promise.all(restores)
      .then((results) => {
        if (
          this.isDestroyed ||
          this.sessionManager.getSession(session.duelId) !== session ||
          session.state !== "COUNTDOWN"
        ) {
          return;
        }
        if (results.some((restored) => !restored)) {
          this.cancelDuel(session.duelId, "prayer_restore_failed");
          return;
        }
        this.finalizeFightStart(session);
      })
      .catch((error) => {
        Logger.error(
          "DuelSystem",
          "Prayer restoration failed before duel start",
          error instanceof Error ? error : null,
          { duelId: session.duelId },
        );
        if (
          !this.isDestroyed &&
          this.sessionManager.getSession(session.duelId) === session &&
          session.state === "COUNTDOWN"
        ) {
          this.cancelDuel(session.duelId, "prayer_restore_failed");
        }
      })
      .finally(() => {
        if (this.pendingFightStarts.get(session.duelId) === pending) {
          this.pendingFightStarts.delete(session.duelId);
        }
      });
    this.pendingFightStarts.set(session.duelId, pending);
    void pending;
  }

  private finalizeFightStart(session: ServerDuelSession): void {
    if (
      this.isDestroyed ||
      this.sessionManager.getSession(session.duelId) !== session ||
      session.state !== "COUNTDOWN"
    ) {
      return;
    }

    session.state = "FIGHTING";
    session.fightStartedAt = Date.now();

    // Fill duel bot inventories with food (fire-and-forget: in-memory add is
    // synchronous so food is available before the first combat tick at 600ms)
    const duelBotFoodItemId = this.getDuelBotFoodItemForMatchup(
      session.challengerId,
      session.targetId,
    );
    this.fillDuelBotInventory(session.challengerId, duelBotFoodItemId);
    this.fillDuelBotInventory(session.targetId, duelBotFoodItemId);

    // Get arena bounds for client-side enforcement
    const bounds = session.arenaId
      ? this.arenaPool.getArenaBounds(session.arenaId)
      : undefined;

    // Emit fight start event
    this.world.emit("duel:fight:start", {
      duelId: session.duelId,
      challengerId: session.challengerId,
      targetId: session.targetId,
      arenaId: session.arenaId,
      bounds,
    });
  }

  /**
   * Restore a player to full health, prayer, and stamina before a duel fight
   * rules-accurate: Players always start duels at full stats
   */
  private restorePlayerStats(
    playerId: string,
    operationId: string,
  ): Promise<boolean> | null {
    const playerEntity = this.world.entities?.get?.(playerId);
    if (!(playerEntity instanceof PlayerEntity)) return null;

    // Restore prayer points to max
    const prayerSystem = this.world.getSystem?.("prayer") as {
      restorePrayerPoints?: (
        playerId: string,
        amount: number,
        operationId: string,
      ) => Promise<{ success: boolean; reason?: string }>;
      getMaxPrayerPoints?: (playerId: string) => number;
    } | null;

    if (!prayerSystem?.restorePrayerPoints) {
      this.applyRestoredPlayerVitals(playerEntity);
      return null;
    }

    const maxPrayer = prayerSystem.getMaxPrayerPoints?.(playerId) ?? 99;
    return prayerSystem
      .restorePrayerPoints(playerId, maxPrayer, operationId)
      .then((receipt) => {
        if (!receipt.success) {
          Logger.warn("DuelSystem", "Prayer restore rejected before duel", {
            playerId,
            reason: receipt.reason ?? "unknown",
          });
          return false;
        }
        this.applyRestoredPlayerVitals(playerEntity);
        return true;
      });
  }

  private applyRestoredPlayerVitals(playerEntity: PlayerEntity): void {
    playerEntity.setHealth(playerEntity.getMaxHealth());
    const staminaComponent = playerEntity.getComponent("stamina");
    const staminaMax = staminaComponent?.data?.max;
    if (typeof staminaMax === "number") {
      playerEntity.setStamina(staminaMax);
    }
    playerEntity.markNetworkDirty();
  }

  private static readonly DUEL_BOT_FOOD_ITEM_OVERRIDE = (
    process.env.DUEL_BOT_FOOD_ITEM || ""
  ).trim();

  private static readonly DUEL_BOT_FOOD_COUNT = Math.max(
    0,
    Math.min(28, parseInt(process.env.DUEL_BOT_FOOD_COUNT || "10", 10) || 10),
  );

  /**
   * Fill a duel bot's inventory with food up to the configured count.
   * Only applies to entities flagged as `isDuelBot` (WebSocket-based DuelBots
   * from dev-duel.mjs). Human players and embedded agents are unaffected.
   *
   * Controlled by env vars:
   *   DUEL_BOT_FOOD_ITEM  - optional hard override for food item
   *   DUEL_BOT_FOOD_COUNT - how many to give per duel (default 10, max 28)
   */
  private fillDuelBotInventory(playerId: string, foodItemId: string): void {
    const entity = this.world.entities?.get?.(playerId);
    if (!entity || !entity.data?.isDuelBot) return;
    if (DuelSystem.DUEL_BOT_FOOD_COUNT <= 0) return;

    const inventorySystem = this.world.getSystem("inventory") as {
      addItemDirect?: (
        playerId: string,
        params: { itemId: string; quantity: number },
      ) => Promise<boolean>;
      getInventory?: (playerId: string) =>
        | {
            items: Array<{ slot: number; itemId: string; quantity: number }>;
          }
        | undefined;
    } | null;

    if (!inventorySystem?.addItemDirect) return;

    const inventory = inventorySystem.getInventory?.(playerId);
    const occupiedSlots = new Set(inventory?.items.map((i) => i.slot) ?? []);

    const maxSlots = 28;
    const addedSlots: DuelFoodProvisionedSlot[] = [];
    let filled = 0;
    for (
      let slot = 0;
      slot < maxSlots && filled < DuelSystem.DUEL_BOT_FOOD_COUNT;
      slot++
    ) {
      if (!occupiedSlots.has(slot)) {
        void inventorySystem.addItemDirect(playerId, {
          itemId: foodItemId,
          quantity: 1,
        });
        filled++;
        addedSlots.push({ slot, itemId: foodItemId });
      }
    }

    if (addedSlots.length > 0) {
      this.duelBotFoodSlotsByPlayer.set(playerId, addedSlots);
    } else {
      this.duelBotFoodSlotsByPlayer.delete(playerId);
    }

    if (filled > 0) {
      Logger.info(
        "DuelSystem",
        `Filled ${filled}/${DuelSystem.DUEL_BOT_FOOD_COUNT} inventory slots with ${foodItemId} for duel bot ${playerId}`,
      );
    }
  }

  private getDuelBotFoodItemForMatchup(
    challengerId: string,
    targetId: string,
  ): string {
    if (DuelSystem.DUEL_BOT_FOOD_ITEM_OVERRIDE.length > 0) {
      return DuelSystem.DUEL_BOT_FOOD_ITEM_OVERRIDE;
    }

    const worldWithCombatLookup = this.world as {
      getPlayerCombatLevel?: (playerId: string) => number;
    };
    const challengerLevel =
      worldWithCombatLookup.getPlayerCombatLevel?.(challengerId) ??
      this.getFallbackCombatLevel(challengerId);
    const targetLevel =
      worldWithCombatLookup.getPlayerCombatLevel?.(targetId) ??
      this.getFallbackCombatLevel(targetId);
    return getDuelFoodItemForLevels(challengerLevel, targetLevel);
  }

  private getFallbackCombatLevel(playerId: string): number {
    const entity = this.world.entities?.get?.(playerId) as
      | {
          combatLevel?: number;
          data?: { combatLevel?: number };
        }
      | undefined;

    return entity?.combatLevel ?? entity?.data?.combatLevel ?? 3;
  }

  private removeDuelBotFoodForPlayers(
    challengerId: string,
    targetId: string,
    reason: "resolve" | "cancel",
  ): void {
    this.removeDuelBotFoodForPlayer(challengerId, reason);
    this.removeDuelBotFoodForPlayer(targetId, reason);
  }

  private removeDuelBotFoodForPlayer(
    playerId: string,
    reason: "resolve" | "cancel",
  ): void {
    const trackedSlots = this.duelBotFoodSlotsByPlayer.get(playerId);
    if (!trackedSlots || trackedSlots.length === 0) {
      this.duelBotFoodSlotsByPlayer.delete(playerId);
      return;
    }

    this.duelBotFoodSlotsByPlayer.delete(playerId);

    const entity = this.world.entities?.get?.(playerId);
    if (!entity?.data?.isDuelBot) return;

    const inventorySystem = this.world.getSystem("inventory") as {
      getInventory?: (playerId: string) =>
        | {
            items: Array<{ slot: number; itemId: string; quantity: number }>;
          }
        | undefined;
      removeItem?: (params: {
        playerId: string;
        itemId: string;
        quantity: number;
        slot?: number;
      }) => Promise<boolean>;
    } | null;

    if (!inventorySystem?.getInventory || !inventorySystem?.removeItem) return;

    const inventory = inventorySystem.getInventory(playerId);
    if (!inventory) return;

    const itemsBySlot = new Map(
      inventory.items.map((item) => [item.slot, item] as const),
    );
    const trackedFoodItemIds = new Set(trackedSlots.map((slot) => slot.itemId));

    let removed = 0;
    for (const trackedSlot of trackedSlots) {
      const item = itemsBySlot.get(trackedSlot.slot);
      if (!item) continue;
      if (!isDuelFoodItemId(item.itemId, trackedSlot.itemId)) continue;

      void inventorySystem.removeItem({
        playerId,
        itemId: item.itemId,
        quantity: item.quantity,
        slot: item.slot,
      });
      removed++;
    }

    const refreshedInventory = inventorySystem.getInventory(playerId);
    if (refreshedInventory) {
      for (const item of refreshedInventory.items) {
        let shouldRemove = false;
        for (const duelFoodItemId of trackedFoodItemIds) {
          if (isDuelFoodItemId(item.itemId, duelFoodItemId)) {
            shouldRemove = true;
            break;
          }
        }
        if (!shouldRemove) continue;

        void inventorySystem.removeItem({
          playerId,
          itemId: item.itemId,
          quantity: item.quantity,
          slot: item.slot,
        });
        removed++;
      }
    }

    if (removed > 0) {
      Logger.info("DuelSystem", "Removed duel bot food", {
        playerId,
        reason,
        removed,
      });
    }
  }

  /**
   * Teleport both players to their arena spawn points
   */
  private teleportPlayersToArena(session: ServerDuelSession): void {
    if (session.arenaId === null) return;

    const spawnPoints = this.arenaPool.getSpawnPoints(session.arenaId);
    if (!spawnPoints) return;

    const [spawn1, spawn2] = spawnPoints;

    // Teleport challenger to spawn 1 (north)
    this.teleportPlayer(session.challengerId, spawn1, spawn2);

    // Teleport target to spawn 2 (south)
    this.teleportPlayer(session.targetId, spawn2, spawn1);
  }

  /**
   * Teleport a player to a position, facing toward a target position
   */
  private teleportPlayer(
    playerId: string,
    position: { x: number; y: number; z: number },
    faceToward: { x: number; y: number; z: number },
  ): void {
    const player = this.world.entities.players?.get(playerId);
    if (!player) return;

    // Calculate rotation to face the opponent
    const dx = faceToward.x - position.x;
    const dz = faceToward.z - position.z;
    const angle = Math.atan2(dx, dz);

    // Emit teleport event for orientation only — suppress the visual beam since
    // this is a housekeeping rotation adjustment, not a dramatic arena entrance.
    this.world.emit("player:teleport", {
      playerId,
      position: { x: position.x, y: position.y, z: position.z },
      rotation: angle,
      suppressEffect: true,
    });
  }

  /**
   * Apply equipment restrictions - unequip items in disabled slots
   */
  private applyEquipmentRestrictions(session: ServerDuelSession): void {
    const restrictions = session.equipmentRestrictions;
    const disabledSlots = (
      Object.keys(restrictions) as Array<keyof typeof restrictions>
    ).filter((slot) => restrictions[slot]);

    if (disabledSlots.length === 0) return;

    // Emit equipment restriction event for both players
    this.world.emit("duel:equipment:restrict", {
      duelId: session.duelId,
      challengerId: session.challengerId,
      targetId: session.targetId,
      disabledSlots,
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Shared acceptance logic for acceptRules, acceptStakes, and acceptFinal.
   * Validates participant, sets acceptance, checks if both accepted.
   * If both accepted, transitions to nextState and resets acceptance flags.
   * If not, emits acceptance update event.
   *
   * @returns NOT_PARTICIPANT error, or { bothAccepted } on success
   */
  private handleAcceptance(
    session: ServerDuelSession,
    playerId: string,
    nextState: DuelState,
  ): DuelOperationResult & { bothAccepted?: boolean } {
    // Validate participant
    if (playerId !== session.challengerId && playerId !== session.targetId) {
      return {
        success: false,
        error: DUEL_ERRORS.NOT_PARTICIPANT,
        errorCode: DuelErrorCode.NOT_PARTICIPANT,
      };
    }

    // Set acceptance via session manager
    const bothAccepted = this.sessionManager.setPlayerAcceptance(
      session,
      playerId,
      true,
    );

    if (bothAccepted) {
      session.state = nextState;
      this.sessionManager.resetAcceptance(session);

      this.world.emit("duel:state:changed", {
        duelId: session.duelId,
        state: nextState,
      });
    } else {
      this.world.emit("duel:acceptance:updated", {
        duelId: session.duelId,
        challengerAccepted: session.challengerAccepted,
        targetAccepted: session.targetAccepted,
      });
    }

    return { success: true, bothAccepted };
  }

  /**
   * Create a new duel session
   */
  private createDuelSession(
    challengerId: string,
    challengerName: string,
    targetId: string,
    targetName: string,
  ): string {
    // Delegate to session manager
    return this.sessionManager.createSession(
      challengerId,
      challengerName,
      targetId,
      targetName,
    );
  }

  /**
   * Handle player disconnect during duel (public API for ServerNetwork)
   */
  onPlayerDisconnect(playerId: string): void {
    // Cancel any pending challenges
    this.pendingDuels.cancelPlayerChallenges(playerId);

    // Check if player is in an active duel
    const duelId = this.sessionManager.getPlayerDuelId(playerId);
    if (!duelId) return;

    const session = this.sessionManager.getSession(duelId);
    if (!session) return;

    // If in FIGHTING state, start disconnect timer instead of immediate cancel
    if (session.state === "FIGHTING") {
      this.startDisconnectTimer(playerId, session);
      return;
    }

    // If in FINISHED state, resolution is already pending via tick-based scheduling.
    // Do NOT cancel — that would delete the session and prevent teleportation.
    if (session.state === "FINISHED") {
      Logger.debug("DuelSystem", "Ignoring disconnect - resolution pending", {
        playerId,
        duelId,
        state: session.state,
      });
      return;
    }

    // For setup states (RULES, STAKES, CONFIRMING), use a short grace period
    // so brief connection hiccups don't disrupt negotiation.
    // COUNTDOWN disconnects still cancel immediately (arena is reserved).
    if (
      session.state === "COUNTDOWN" ||
      session.pendingSetupDisconnect // already pending
    ) {
      this.cancelDuel(duelId, "player_disconnected", playerId);
      return;
    }

    session.pendingSetupDisconnect = {
      playerId,
      cancelAtTick: this.currentTick + SETUP_DISCONNECT_GRACE_TICKS,
    };

    // Notify opponent of the disconnect (they'll see a reconnect timer)
    this.world.emit("duel:player:disconnected", {
      duelId: session.duelId,
      playerId,
      challengerId: session.challengerId,
      targetId: session.targetId,
      timeoutMs: ticksToMs(SETUP_DISCONNECT_GRACE_TICKS),
    });

    Logger.debug("DuelSystem", "Setup disconnect grace started", {
      playerId,
      duelId,
      state: session.state,
      cancelAtTick: this.currentTick + SETUP_DISCONNECT_GRACE_TICKS,
    });
  }

  /**
   * Handle player reconnect during duel
   */
  onPlayerReconnect(playerId: string): void {
    // Clear any pending disconnect auto-forfeit or setup grace timer
    const duelId = this.sessionManager.getPlayerDuelId(playerId);
    if (!duelId) return;

    const session = this.sessionManager.getSession(duelId);
    if (!session) return;

    let cleared = false;

    if (
      session.pendingDisconnect &&
      session.pendingDisconnect.playerId === playerId
    ) {
      session.pendingDisconnect = undefined;
      cleared = true;
    }

    if (
      session.pendingSetupDisconnect &&
      session.pendingSetupDisconnect.playerId === playerId
    ) {
      session.pendingSetupDisconnect = undefined;
      cleared = true;
    }

    if (cleared) {
      // Notify both players that the disconnected player returned
      this.world.emit("duel:player:reconnected", {
        duelId,
        playerId,
        challengerId: session.challengerId,
        targetId: session.targetId,
      });
    }
  }

  /**
   * Start disconnect timer for player in active combat
   */
  private startDisconnectTimer(
    playerId: string,
    session: ServerDuelSession,
  ): void {
    // Don't start another timer if one already exists
    if (session.pendingDisconnect) return;

    // Notify opponent that player disconnected
    this.world.emit("duel:player:disconnected", {
      duelId: session.duelId,
      playerId,
      challengerId: session.challengerId,
      targetId: session.targetId,
      timeoutMs: ticksToMs(DISCONNECT_TIMEOUT_TICKS),
    });

    // If noForfeit rule is active, instant loss (can't forfeit, so disconnect = loss)
    if (session.rules.noForfeit) {
      const winnerId = getSessionOpponentId(session, playerId);
      this.resolveDuel(session, winnerId, playerId, "forfeit");
      return;
    }

    // Schedule disconnect auto-forfeit via tick-based processing (replaces setTimeout).
    // processTick() will check this and auto-forfeit if the player hasn't reconnected.
    session.pendingDisconnect = {
      playerId,
      forfeitAtTick: this.currentTick + DISCONNECT_TIMEOUT_TICKS,
    };
  }

  /**
   * Handle player death during duel
   */
  private handlePlayerDeath(playerId: string): void {
    const duelId = this.sessionManager.getPlayerDuelId(playerId);
    if (!duelId) return;

    const session = this.sessionManager.getSession(duelId);
    if (!session) return;

    // Only process deaths during active combat
    // SECURITY: If state is already FINISHED, resolution is in progress - ignore
    // This prevents race conditions when both players die simultaneously
    if (session.state !== "FIGHTING") {
      // Don't call cancelDuel here - if state is FINISHED, resolveDuel will handle cleanup
      // If state is something else (shouldn't happen), just ignore
      Logger.debug("DuelSystem", "Ignoring death - invalid state", {
        playerId,
        state: session.state,
      });
      return;
    }

    // Determine winner
    const winnerId = getSessionOpponentId(session, playerId);
    const loserId = playerId;

    // Set state to FINISHED immediately to prevent further deaths from being processed
    session.state = "FINISHED";

    // Schedule resolution via tick-based processing (replaces setTimeout).
    // processTick() will pick this up and call resolveDuel() after the delay.
    // This aligns death resolution with game time and avoids timer memory leaks.
    session.pendingResolution = {
      winnerId,
      loserId,
      reason: "death",
      resolveAtTick: this.currentTick + DEATH_RESOLUTION_DELAY_TICKS,
    };

    Logger.debug("DuelSystem", "Scheduled death resolution", {
      duelId: session.duelId,
      delayTicks: DEATH_RESOLUTION_DELAY_TICKS,
      resolveAtTick: session.pendingResolution.resolveAtTick,
      currentTick: this.currentTick,
    });
  }

  /**
   * Resolve a duel with a winner
   */
  private resolveDuel(
    session: ServerDuelSession,
    winnerId: string,
    loserId: string,
    reason: "death" | "forfeit",
  ): void {
    // Clear any pending tick-based scheduling to prevent double resolution
    session.pendingDisconnect = undefined;
    session.pendingResolution = undefined;

    // Delegate to combat resolver for stake transfer, health restoration, and teleportation.
    // Wrapped in try/catch so arena release and session cleanup ALWAYS happen,
    // even if the resolver throws (prevents zombie sessions and stuck arenas).
    try {
      this.combatResolver.resolveDuel(session, winnerId, loserId, reason);
    } catch (err) {
      Logger.error(
        "DuelSystem",
        "Combat resolver failed during duel resolution",
        err instanceof Error ? err : null,
        { duelId: session.duelId, winnerId, loserId, reason },
      );
    }
    if (!this.combatResolver.hasPendingResolution(session.duelId)) {
      this.completeResolutionCleanup(session);
      return;
    }

    if (this.pendingResolutionCleanup.has(session.duelId)) return;
    this.pendingResolutionCleanup.add(session.duelId);
    void this.combatResolver
      .waitForResolution(session.duelId)
      .then(() => {
        if (!this.isDestroyed) this.completeResolutionCleanup(session);
      })
      .finally(() => {
        this.pendingResolutionCleanup.delete(session.duelId);
      });
  }

  private completeResolutionCleanup(session: ServerDuelSession): void {
    if (this.sessionManager.getSession(session.duelId) !== session) return;
    this.removeDuelBotFoodForPlayers(
      session.challengerId,
      session.targetId,
      "resolve",
    );

    if (session.arenaId !== null) {
      this.releaseArena(session.arenaId, session.duelId);
    }
    this.sessionManager.deleteSession(session.duelId);
  }

  /**
   * Process active duel (rule enforcement)
   * Arena bounds are enforced by wall collision in CollisionMatrix as the primary
   * mechanism, but agents (and occasionally physics glitches) can still escape.
   * This tick-level check acts as a safety net: anyone who drifts outside the
   * arena AABB is immediately clamped back to just inside the boundary.
   */
  private processActiveDuel(session: ServerDuelSession): void {
    if (session.arenaId === null) return;

    // If noMovement rule is active, freeze players exactly at spawn points.
    if (session.rules.noMovement) {
      const spawnPoints = this.arenaPool.getSpawnPoints(session.arenaId);
      if (spawnPoints) {
        const [s0, s1] = spawnPoints;
        this.enforceNoMovement(session.challengerId, s0, s1);
        this.enforceNoMovement(session.targetId, s1, s0);
      }
    } else {
      // For all other duels, clamp players back inside the arena if they escape.
      // This catches agents whose AI pathfinding routes them through a wall gap and
      // mobs/players who are nudged out by physics.
      this.enforceArenaBounds(session.challengerId, session.arenaId);
      this.enforceArenaBounds(session.targetId, session.arenaId);
    }
  }

  /**
   * Clamp a dueling player's position back inside the arena boundary.
   * Uses a 1-unit inset from each wall so the player never re-teleports
   * on consecutive ticks due to floating-point rounding.
   */
  private enforceArenaBounds(playerId: string, arenaId: number): void {
    const player = this.world.entities.players?.get(playerId);
    if (!player?.position) return;

    const bounds = this.arenaPool.getArenaBounds(arenaId);
    if (!bounds) return;

    const { x, y, z } = player.position;
    const WALL_INSET = 1.0; // keep at least 1 unit away from the boundary

    const clampedX = Math.min(
      bounds.max.x - WALL_INSET,
      Math.max(bounds.min.x + WALL_INSET, x),
    );
    const clampedZ = Math.min(
      bounds.max.z - WALL_INSET,
      Math.max(bounds.min.z + WALL_INSET, z),
    );

    if (
      Math.abs(clampedX - x) > POSITION_TOLERANCE ||
      Math.abs(clampedZ - z) > POSITION_TOLERANCE
    ) {
      this.world.emit("player:teleport", {
        playerId,
        position: { x: clampedX, y, z: clampedZ },
        suppressEffect: true,
      });
    }
  }

  /**
   * Eject any player who is inside a duel combat arena without an active duel context.
   * This keeps combat pits reserved for active duel participants only.
   */
  /** Per-player cooldown to avoid teleporting the same player every tick. */
  private _ejectionCooldowns = new Map<string, number>();
  private _lastEjectionCooldownPruneAt = 0;

  private ejectNonDuelingPlayersFromCombatArenas(): void {
    const now = Date.now();
    this.pruneEjectionCooldowns(now);
    let egress: { x: number; y: number; z: number } | null = null;

    for (const [playerId, player] of this.world.entities.players) {
      const { position } = player;
      if (!position) continue;

      if (!isPositionInsideCombatArena(position.x, position.z)) {
        continue;
      }

      if (this.isPlayerInDuel(playerId)) {
        continue;
      }

      const duelFlags = (
        player as {
          data?: {
            inStreamingDuel?: boolean;
            preventRespawn?: boolean;
          };
        }
      ).data;
      const inStreamingDuel =
        duelFlags?.inStreamingDuel === true ||
        duelFlags?.preventRespawn === true;

      if (inStreamingDuel) {
        continue;
      }

      // Cooldown: don't re-eject the same player within 30 seconds
      const lastEjected = this._ejectionCooldowns.get(playerId) ?? 0;
      if (now - lastEjected < 30_000) {
        continue;
      }
      this._ejectionCooldowns.set(playerId, now);
      // Terrain height sampling can invoke procedural work. Resolve it lazily
      // and at most once for the rare tick that actually ejects somebody.
      egress ??= this.getArenaEgressPosition();

      this.world.emit("player:teleport", {
        playerId,
        position: { x: egress.x, y: egress.y, z: egress.z },
        rotation: 0,
        suppressEffect: true,
      });
    }
  }

  private pruneEjectionCooldowns(now: number): void {
    const cooldownMs = 30_000;
    if (now - this._lastEjectionCooldownPruneAt < cooldownMs) return;
    this._lastEjectionCooldownPruneAt = now;
    for (const [playerId, lastEjectedAt] of this._ejectionCooldowns) {
      if (now - lastEjectedAt >= cooldownMs) {
        this._ejectionCooldowns.delete(playerId);
      }
    }
  }

  private getArenaEgressPosition(): { x: number; y: number; z: number } {
    return getDuelArenaEgressPosition();
  }

  /**
   * Enforce no movement rule - keep player at spawn point
   */
  private enforceNoMovement(
    playerId: string,
    spawnPoint: { x: number; y: number; z: number },
    faceToward: { x: number; y: number; z: number },
  ): void {
    const player = this.world.entities.players?.get(playerId);
    if (!player?.position) return;

    const { x, z } = player.position;

    const dxp = Math.abs(x - spawnPoint.x);
    const dzp = Math.abs(z - spawnPoint.z);

    const rotDx = faceToward.x - spawnPoint.x;
    const rotDz = faceToward.z - spawnPoint.z;
    const angle = Math.atan2(rotDx, rotDz);

    if (dxp > POSITION_TOLERANCE || dzp > POSITION_TOLERANCE) {
      this.world.emit("player:teleport", {
        playerId,
        position: { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z },
        rotation: angle,
        suppressEffect: true,
      });
    }
  }

  /**
   * Clean up expired or stale sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();

    for (const [duelId, session] of this.sessionManager.getAllSessions()) {
      // Cancel sessions stuck in setup states for too long.
      // Exclude FIGHTING (active combat) and FINISHED (resolution pending).
      if (
        session.state !== "FIGHTING" &&
        session.state !== "FINISHED" &&
        now - session.createdAt > ticksToMs(SESSION_MAX_AGE_TICKS)
      ) {
        this.cancelDuel(duelId, "session_timeout");
      }
    }
  }
}
