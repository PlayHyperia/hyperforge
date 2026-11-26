/**
 * Validation Chain
 *
 * Pre-transaction validation shared by all handlers.
 * Returns BaseHandlerContext if all checks pass.
 *
 * Validation order (defense in depth):
 * 1. Player exists on socket
 * 2. Rate limit not exceeded
 * 3. Player within distance of target
 * 4. Database available
 *
 * This consolidates ~25-30 lines of validation code that was duplicated
 * across every handler function.
 */

import {
  type World,
  SessionType,
  INTERACTION_DISTANCE,
  chebyshevDistance,
} from "@hyperforge/shared";
import type { ServerSocket } from "../../../../shared/types";
import type { RateLimitService } from "../../services";
import type { BaseHandlerContext, ValidationResult } from "./types";
import type { InteractionSessionManager } from "../../InteractionSessionManager";
import { validatePhysicalBankAccess } from "../../../../shared/PhysicalBankAccess";
import {
  getPlayerId,
  getDatabase,
  getSessionManager,
  getEntityPosition,
  sendErrorToast,
} from "./helpers";

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * User-friendly names for session types (used in error messages).
 * Maps internal session type to what users see.
 */
const SESSION_TYPE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  store: "shopkeeper",
  bank: "bank",
  dialogue: "NPC",
};

// ============================================================================
// DISTANCE VALIDATION
// ============================================================================

/**
 * Verify player is within interaction distance of session target.
 * Uses Chebyshev distance (classic MMORPG-style square range).
 *
 * @returns Error message if invalid, null if valid
 */
function verifyDistanceToTarget(
  socket: ServerSocket,
  world: World,
  sessionType: SessionType,
): string | null {
  const playerId = socket.player?.id;
  if (!playerId) {
    return "Player not found";
  }

  // Get target from session manager (single source of truth)
  const sessionManager = getSessionManager(world) as
    Pick<InteractionSessionManager, "getSession" | "closeSession"> | undefined;
  const session = sessionManager?.getSession(playerId);

  if (!session?.targetEntityId) {
    const typeName = SESSION_TYPE_DISPLAY_NAMES[sessionType] || sessionType;
    return `Session expired - please reopen the ${typeName}`;
  }

  if (sessionType === SessionType.BANK) {
    // Bank mutations must use the bank session opened for this exact target,
    // never a nearby dialogue/store session or a role that has since changed.
    if (session.sessionType !== SessionType.BANK) {
      return "Session expired - please reopen the bank";
    }
    const failure = validatePhysicalBankAccess(
      world,
      playerId,
      session.targetEntityId,
    );
    if (!failure) return null;
    sessionManager?.closeSession(
      playerId,
      failure === "bank_out_of_range"
        ? "distance"
        : failure === "duel_locked"
          ? "combat"
          : "target_gone",
    );
    if (failure === "bank_out_of_range") return "You are too far from the bank";
    if (failure === "duel_locked") return "You can't use a bank during a duel.";
    return failure === "player_unavailable"
      ? "Player not found"
      : "Target no longer exists";
  }

  // Get target entity from world
  const targetEntity = world.entities?.get?.(session.targetEntityId);
  if (!targetEntity) {
    return "Target no longer exists";
  }

  // Get target position
  const targetPos = getEntityPosition(targetEntity);
  if (!targetPos) {
    return "Target position not found";
  }

  // Get player position
  const playerEntity = socket.player;
  if (!playerEntity?.position) {
    return "Player position not found";
  }

  // Chebyshev distance check (classic MMORPG-style)
  const distance = chebyshevDistance(playerEntity.position, targetPos);
  const maxDistance = INTERACTION_DISTANCE[sessionType];

  if (distance > maxDistance) {
    const typeName = SESSION_TYPE_DISPLAY_NAMES[sessionType] || sessionType;
    return `You are too far from the ${typeName}`;
  }

  return null;
}

// ============================================================================
// MAIN VALIDATION FUNCTION
// ============================================================================

/**
 * Validate all common requirements for transaction handlers.
 *
 * This is the entry point for all transaction handlers.
 * If this returns success, the handler has a valid context to work with.
 *
 * Checks performed:
 * 1. Player exists on socket (authenticated)
 * 2. Rate limit not exceeded (50ms between operations)
 * 3. Player within distance of target NPC (Chebyshev ≤ 2 tiles)
 * 4. Database available
 *
 * Usage:
 * ```typescript
 * const result = validateTransactionRequest(socket, world, SessionType.STORE, rateLimiter);
 * if (!result.success) {
 *   return; // Error already sent to client
 * }
 * // Use result.context for transaction
 * ```
 *
 * @param socket - Client socket
 * @param world - Game world
 * @param sessionType - Type of session (store/bank/dialogue)
 * @param rateLimiter - Rate limiter service instance
 * @returns ValidationResult with BaseHandlerContext on success
 */
export function validateTransactionRequest(
  socket: ServerSocket,
  world: World,
  sessionType: SessionType,
  rateLimiter: RateLimitService,
): ValidationResult<BaseHandlerContext> {
  // Step 1: Validate player exists on socket
  const playerId = getPlayerId(socket);
  if (!playerId) {
    console.warn(
      `[ValidationChain] No player on socket for ${sessionType} operation`,
    );
    return { success: false, error: "PLAYER_NOT_FOUND" };
  }

  // Step 2: Rate limiting (50ms between operations)
  if (!rateLimiter.tryOperation(playerId)) {
    sendErrorToast(socket, "Please wait before trying again");
    return { success: false, error: "RATE_LIMITED" };
  }

  // Step 3: Distance verification (Chebyshev ≤ 2 tiles)
  const distanceError = verifyDistanceToTarget(socket, world, sessionType);
  if (distanceError) {
    sendErrorToast(socket, distanceError);
    return { success: false, error: "DISTANCE_INVALID" };
  }

  // Step 4: Database availability
  const db = getDatabase(world);
  if (!db) {
    console.error(
      `[ValidationChain] Database not available for ${sessionType} operation`,
    );
    sendErrorToast(socket, "Server error - please try again");
    return { success: false, error: "DB_UNAVAILABLE" };
  }

  // All checks passed - return valid context
  return {
    success: true,
    context: {
      playerId,
      socket,
      world,
      db,
      sessionType,
    },
  };
}
