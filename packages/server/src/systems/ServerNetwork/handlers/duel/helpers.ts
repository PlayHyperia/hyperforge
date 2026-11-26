/**
 * Duel Handler Helpers
 *
 * Shared utilities for duel packet handlers.
 * IMPORTANT: This module imports common utilities from ../common to ensure
 * consistent socket handling patterns across all handlers.
 */

import {
  type World,
  isPositionInsideDuelArenaZone,
  isPositionInsideDuelArenaLobby,
  isPositionInsideCombatArena,
} from "@hyperforge/shared";
import type { ServerSocket } from "../../../../shared/types";
import type { DuelSystem } from "../../../DuelSystem";
import type { PendingDuelChallengeManager } from "../../PendingDuelChallengeManager";
import { Logger, RateLimitService } from "../../services";
import { sendToSocket, getPlayerId } from "../common";

// ============================================================================
// Rate Limiter
// ============================================================================

/** Single rate limiter instance shared across all duel modules */
export const rateLimiter = new RateLimitService();

// ============================================================================
// System Getters
// ============================================================================

/**
 * Get DuelSystem from world
 */
export function getDuelSystem(world: World): DuelSystem | undefined {
  const worldWithDuel = world as { duelSystem?: DuelSystem };
  return worldWithDuel.duelSystem;
}

/**
 * Get PendingDuelChallengeManager from world
 */
export function getPendingDuelChallengeManager(
  world: World,
): PendingDuelChallengeManager | undefined {
  const worldWithPending = world as {
    pendingDuelChallengeManager?: PendingDuelChallengeManager;
  };
  return worldWithPending.pendingDuelChallengeManager;
}

// ============================================================================
// Player Utilities
// ============================================================================

/**
 * Get player name from world
 * Delegates to World.getPlayerDisplayName (Law of Demeter)
 */
export function getPlayerName(world: World, playerId: string): string {
  return world.getPlayerDisplayName(playerId);
}

/**
 * Get player combat level from world
 * Delegates to World.getPlayerCombatLevel (Law of Demeter)
 */
export function getPlayerCombatLevel(world: World, playerId: string): number {
  return world.getPlayerCombatLevel(playerId);
}

/**
 * Check if player is online
 */
export function isPlayerOnline(world: World, playerId: string): boolean {
  return world.entities.players?.has(playerId) ?? false;
}

/**
 * Get socket by player ID
 * Delegates to World.getPlayerSocket (Law of Demeter)
 */
export function getSocketByPlayerId(
  world: World,
  playerId: string,
): ServerSocket | undefined {
  return world.getPlayerSocket(playerId) as ServerSocket | undefined;
}

// ============================================================================
// Response Utilities
// ============================================================================

/**
 * Send duel error to socket
 */
export function sendDuelError(
  socket: ServerSocket,
  message: string,
  code: string,
): void {
  sendToSocket(socket, "duelError", { message, code });
}

/**
 * Send success toast to socket
 */
export function sendSuccessToast(socket: ServerSocket, message: string): void {
  sendToSocket(socket, "showToast", { type: "success", message });
}

// ============================================================================
// Auth Middleware
// ============================================================================

/**
 * Validate socket authentication and get DuelSystem in one call.
 * Eliminates the repeated playerId + duelSystem boilerplate in every handler.
 *
 * @returns { playerId, duelSystem } on success, null on failure (error already sent)
 */
export function withDuelAuth(
  socket: ServerSocket,
  world: World,
): {
  playerId: string;
  duelSystem: import("../../../DuelSystem").DuelSystem;
} | null {
  const playerId = getPlayerId(socket);
  if (!playerId) {
    sendDuelError(socket, "Not authenticated", "NOT_AUTHENTICATED");
    return null;
  }
  const duelSystem = getDuelSystem(world);
  if (!duelSystem) {
    sendDuelError(socket, "Duel system unavailable", "SYSTEM_ERROR");
    return null;
  }
  return { playerId, duelSystem };
}

// ============================================================================
// Packet Name Constants
// ============================================================================

/**
 * Duel packet event names sent to clients.
 * Centralizes magic strings to prevent typos and enable refactoring.
 */
export const DUEL_PACKETS = {
  SESSION_STARTED: "duelSessionStarted",
  CHALLENGE_SENT: "duelChallengeSent",
  CHALLENGE_RECEIVED: "duelChallengeReceived",
  RULES_UPDATED: "duelRulesUpdated",
  EQUIPMENT_UPDATED: "duelEquipmentUpdated",
  ACCEPTANCE_UPDATED: "duelAcceptanceUpdated",
  STATE_CHANGED: "duelStateChanged",
  STAKES_UPDATED: "duelStakesUpdated",
  CANCELLED: "duelCancelled",
  CHAT_ADDED: "chatAdded",
  ERROR: "duelError",
  TOAST: "showToast",
} as const;

// ============================================================================
// State Validation
// ============================================================================

/** Valid duel session states */
type DuelSessionState =
  "RULES" | "STAKES" | "CONFIRMING" | "COUNTDOWN" | "FIGHTING" | "FINISHED";

/**
 * Validate that a duel session exists, the player is a participant,
 * and the session is in one of the expected states.
 *
 * Returns the session on success, or null on failure (error already sent to socket).
 * This eliminates repeated boilerplate across handlers and ensures every handler
 * guards against out-of-state requests before doing any expensive work (DB queries, etc.).
 */
export function assertDuelState(
  socket: ServerSocket,
  duelSystem: import("../../../DuelSystem").DuelSystem,
  duelId: string,
  playerId: string,
  expectedStates: DuelSessionState[],
): ReturnType<typeof duelSystem.getDuelSession> | null {
  const session = duelSystem.getDuelSession(duelId);
  if (!session) {
    sendDuelError(socket, "Duel not found", "DUEL_NOT_FOUND");
    return null;
  }

  // Verify player is a participant
  if (playerId !== session.challengerId && playerId !== session.targetId) {
    sendDuelError(socket, "You're not in this duel", "NOT_PARTICIPANT");
    return null;
  }

  // Verify session is in an expected state
  if (!expectedStates.includes(session.state as DuelSessionState)) {
    sendDuelError(
      socket,
      "This action is not available right now.",
      "INVALID_STATE",
    );
    return null;
  }

  return session;
}

// Re-export common utilities for convenience
export { sendToSocket, getPlayerId } from "../common";

// ============================================================================
// Zone Utilities
// ============================================================================

/**
 * Check if player is in Duel Arena zone
 * Uses shared admitted protection, independent of optional zone-detection.
 */
export function isInDuelArenaZone(world: World, playerId: string): boolean {
  const player = world.entities.players?.get(playerId);
  if (!player?.position) {
    Logger.debug("DuelZone", "No player or position found", { playerId });
    return false;
  }

  const { x, z } = player.position;

  const inBounds = isPositionInsideDuelArenaZone(x, z);

  Logger.debug("DuelZone", "Zone check result", {
    playerId,
    position: { x, z },
    inBounds,
  });

  return inBounds;
}

/**
 * Check if player is inside a combat arena (not the lobby)
 * Uses manifest-driven config via isPositionInsideCombatArena()
 */
export function isInsideCombatArena(world: World, playerId: string): boolean {
  const player = world.entities.players?.get(playerId);
  if (!player?.position) return false;

  return isPositionInsideCombatArena(player.position.x, player.position.z);
}

/**
 * Check if player is in the Duel Arena lobby (can challenge)
 * Uses the actual arrival court in explicitly admitted facility layouts.
 */
export function isInDuelArenaLobby(world: World, playerId: string): boolean {
  const player = world.entities.players?.get(playerId);
  return (
    !!player?.position &&
    isPositionInsideDuelArenaLobby(player.position.x, player.position.z)
  );
}

/**
 * Check if two players are within challenge range (15 tiles)
 * Used for visibility/clickability range
 */
export function arePlayersInChallengeRange(
  world: World,
  player1Id: string,
  player2Id: string,
): boolean {
  const player1 = world.entities.players?.get(player1Id);
  const player2 = world.entities.players?.get(player2Id);

  if (!player1?.position || !player2?.position) return false;

  const dx = Math.abs(player1.position.x - player2.position.x);
  const dz = Math.abs(player1.position.z - player2.position.z);
  const distance = Math.max(dx, dz); // Chebyshev distance

  return distance <= 15;
}

/**
 * Check if two players are adjacent (1 tile range)
 * Used for actual challenge delivery (after walking to player)
 */
export function arePlayersAdjacent(
  world: World,
  player1Id: string,
  player2Id: string,
): boolean {
  const player1 = world.entities.players?.get(player1Id);
  const player2 = world.entities.players?.get(player2Id);

  if (!player1?.position || !player2?.position) return false;

  const dx = Math.abs(player1.position.x - player2.position.x);
  const dz = Math.abs(player1.position.z - player2.position.z);
  const distance = Math.max(dx, dz); // Chebyshev distance

  return distance <= 1;
}
