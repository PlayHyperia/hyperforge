/**
 * Duel Challenge Handlers
 *
 * Handles duel challenge initiation and response:
 * - handleDuelChallenge: Player A challenges Player B to a duel
 * - handleDuelChallengeRespond: Player B accepts/declines the challenge
 */

import {
  type World,
  type PlayerID,
  isValidPlayerID,
  uuid,
} from "@hyperforge/shared";
import type { ServerSocket } from "../../../../shared/types";
import { hasActiveInterfaceSession } from "../common";
import { Logger } from "../../services";
import { DUEL_ERRORS } from "../../../DuelSystem/error-messages";
import {
  rateLimiter,
  getDuelSystem,
  getPendingDuelChallengeManager,
  getPlayerName,
  getPlayerCombatLevel,
  getSocketByPlayerId,
  sendDuelError,
  sendToSocket,
  getPlayerId,
  isPlayerOnline,
  isInDuelArenaLobby,
  arePlayersInChallengeRange,
  arePlayersAdjacent,
  withDuelAuth,
  DUEL_PACKETS,
} from "./helpers";

// ============================================================================
// Challenge Handler
// ============================================================================

/**
 * Handle duel challenge from Player A to Player B
 *
 * Requirements:
 * - Both players must be in the Duel Arena zone
 * - Neither player can be in another duel
 * - Players must be within 15 tiles of each other (visibility range)
 * - If not adjacent, walk to player first then send challenge
 */
export function handleDuelChallenge(
  socket: ServerSocket,
  data: { targetPlayerId: string },
  world: World,
): void {
  Logger.debug("DuelChallenge", "Received challenge request", {
    targetPlayerId: data.targetPlayerId,
  });

  const playerId = getPlayerId(socket);
  if (!playerId) {
    Logger.debug("DuelChallenge", "Failed: Not authenticated");
    sendDuelError(socket, "Not authenticated", "NOT_AUTHENTICATED");
    return;
  }

  Logger.debug("DuelChallenge", "Processing challenge", {
    challengerId: playerId,
    targetId: data.targetPlayerId,
  });

  // FIRST CHECK: Zone validation before any other processing
  // This prevents consuming rate limit tokens for invalid requests
  // Must be in lobby area (not inside a combat arena)
  if (!isInDuelArenaLobby(world, playerId)) {
    Logger.debug(
      "DuelChallenge",
      "Failed: Challenger not in duel arena lobby",
      {
        playerId,
      },
    );
    sendDuelError(
      socket,
      "You must be in the Duel Arena lobby to challenge players.",
      "NOT_IN_DUEL_ARENA",
    );
    return;
  }

  const duelSystem = getDuelSystem(world);
  if (!duelSystem) {
    Logger.debug("DuelChallenge", "Failed: Duel system unavailable");
    sendDuelError(socket, "Duel system unavailable", "SYSTEM_ERROR");
    return;
  }

  // Reject before consuming a token, queueing movement or creating an invite.
  // createChallenge rechecks after movement, and final confirmation reserves
  // atomically; this early feedback never grants ownership of the ring.
  if (duelSystem.arenaPool.getAvailableCount() === 0) {
    sendDuelError(socket, DUEL_ERRORS.NO_ARENA_AVAILABLE, "NO_ARENA_AVAILABLE");
    return;
  }

  // Rate limit check (only after zone validation passes)
  const rateLimitOk = rateLimiter.tryOperation(playerId);
  if (!rateLimitOk) {
    Logger.debug("DuelChallenge", "Failed: Rate limited", { playerId });
    sendDuelError(
      socket,
      "Please wait before challenging again",
      "RATE_LIMITED",
    );
    return;
  }

  // Validate target player exists and is online
  const targetPlayerId = data.targetPlayerId;
  if (!isValidPlayerID(targetPlayerId)) {
    Logger.debug("DuelChallenge", "Failed: Invalid player ID", {
      targetPlayerId,
    });
    sendDuelError(socket, "Invalid player", "INVALID_PLAYER");
    return;
  }

  if (playerId === targetPlayerId) {
    Logger.debug("DuelChallenge", "Failed: Self-challenge", { playerId });
    sendDuelError(socket, "You cannot challenge yourself", "SELF_CHALLENGE");
    return;
  }

  if (!isPlayerOnline(world, targetPlayerId)) {
    Logger.debug("DuelChallenge", "Failed: Target offline", { targetPlayerId });
    sendDuelError(socket, "Player is not online", "PLAYER_OFFLINE");
    return;
  }

  // Check target player is also in Duel Arena lobby (not in combat arena)
  if (!isInDuelArenaLobby(world, targetPlayerId)) {
    Logger.debug("DuelChallenge", "Failed: Target not in duel arena lobby", {
      targetPlayerId,
    });
    sendDuelError(
      socket,
      "That player is not in the Duel Arena lobby.",
      "TARGET_NOT_IN_DUEL_ARENA",
    );
    return;
  }

  // Check visibility range (15 tiles) - must be able to see target to initiate
  if (!arePlayersInChallengeRange(world, playerId, targetPlayerId)) {
    Logger.debug("DuelChallenge", "Failed: Out of visibility range", {
      playerId,
      targetPlayerId,
    });
    sendDuelError(socket, "That player is too far away.", "OUT_OF_RANGE");
    return;
  }

  // Interface blocking check
  if (hasActiveInterfaceSession(world, playerId)) {
    Logger.debug("DuelChallenge", "Failed: Challenger has interface open", {
      playerId,
    });
    sendDuelError(
      socket,
      "You can't challenge while using another interface.",
      "INTERFACE_OPEN",
    );
    return;
  }

  if (hasActiveInterfaceSession(world, targetPlayerId)) {
    Logger.debug("DuelChallenge", "Failed: Target has interface open", {
      targetPlayerId,
    });
    sendDuelError(socket, "That player is busy.", "PLAYER_BUSY");
    return;
  }

  // Get challenger info
  const challengerName = getPlayerName(world, playerId);
  const challengerLevel = getPlayerCombatLevel(world, playerId);
  const targetName = getPlayerName(world, targetPlayerId);

  /**
   * Send the actual duel challenge to target player
   * Called immediately if adjacent, or after walking to player
   */
  const sendChallengeToTarget = () => {
    // Re-validate that both players are still valid
    if (!isPlayerOnline(world, targetPlayerId)) {
      sendDuelError(socket, "Player is no longer available.", "PLAYER_OFFLINE");
      return;
    }

    // Re-check interface blocking (may have changed while walking)
    if (hasActiveInterfaceSession(world, targetPlayerId)) {
      sendDuelError(socket, "That player is busy.", "PLAYER_BUSY");
      return;
    }

    // Re-validate lobby status (target may have left lobby while challenger walked over)
    if (!isInDuelArenaLobby(world, targetPlayerId)) {
      sendDuelError(
        socket,
        "That player has left the duel arena.",
        "NOT_IN_LOBBY",
      );
      return;
    }

    // Create duel challenge
    const result = duelSystem.createChallenge(
      playerId as PlayerID,
      challengerName,
      socket.id,
      challengerLevel,
      targetPlayerId as PlayerID,
      targetName,
    );

    if (!result.success) {
      Logger.debug("DuelChallenge", "Failed to create challenge", {
        error: result.error,
        errorCode: result.errorCode,
      });
      sendDuelError(
        socket,
        result.error ?? "Unknown error",
        result.errorCode || "UNKNOWN",
      );
      return;
    }

    Logger.debug("DuelChallenge", "Challenge created", {
      challengeId: result.challengeId,
      challengerId: playerId,
      targetId: targetPlayerId,
    });

    // Send notification to target player as classic MMORPG-style chat message
    const targetSocket = getSocketByPlayerId(world, targetPlayerId);
    if (targetSocket) {
      // Send as clickable chat message (like trade requests)
      const chatMessage = {
        id: uuid(),
        from: "",
        fromId: playerId,
        body: `${challengerName} wishes to duel with you.`,
        text: `${challengerName} wishes to duel with you.`,
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
        type: "duel_challenge" as const,
        challengeId: result.challengeId,
      };
      sendToSocket(targetSocket, DUEL_PACKETS.CHAT_ADDED, chatMessage);

      // Send structured challenge data for UI modal
      sendToSocket(targetSocket, "duelChallengeIncoming", {
        challengeId: result.challengeId,
        fromPlayerId: playerId,
        fromPlayerName: challengerName,
        fromPlayerLevel: challengerLevel,
      });
    } else {
      Logger.debug("DuelChallenge", "Target socket not found", {
        targetPlayerId,
      });
      // Target socket not found - cancel the challenge
      duelSystem.pendingDuels.cancelChallenge(result.challengeId!);
      sendDuelError(socket, "Player is not available.", "PLAYER_OFFLINE");
      return;
    }

    // Send confirmation to challenger
    sendToSocket(socket, DUEL_PACKETS.CHALLENGE_SENT, {
      challengeId: result.challengeId,
      targetPlayerId,
      targetPlayerName: targetName,
    });

    // Also add chat message for challenger
    const challengerChatMessage = {
      id: uuid(),
      from: "",
      body: `Sending duel challenge to ${targetName}...`,
      text: `Sending duel challenge to ${targetName}...`,
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
      type: "system" as const,
    };
    sendToSocket(socket, DUEL_PACKETS.CHAT_ADDED, challengerChatMessage);
  };

  // Check if already adjacent - if so, send challenge immediately
  if (arePlayersAdjacent(world, playerId, targetPlayerId)) {
    Logger.debug("DuelChallenge", "Players adjacent, sending challenge", {
      playerId,
      targetPlayerId,
    });
    sendChallengeToTarget();
    return;
  }

  // Not adjacent - use PendingDuelChallengeManager to walk up to target first
  const pendingChallengeManager = getPendingDuelChallengeManager(world);
  if (!pendingChallengeManager) {
    Logger.warn("DuelChallenge", "PendingDuelChallengeManager not available");
    sendDuelError(
      socket,
      "You need to be closer to challenge that player.",
      "TOO_FAR",
    );
    return;
  }

  Logger.debug("DuelChallenge", "Queueing walk-to-player challenge", {
    playerId,
    targetPlayerId,
  });

  // Queue pending challenge - player will walk up to target, then send challenge
  pendingChallengeManager.queuePendingChallenge(
    playerId,
    targetPlayerId,
    sendChallengeToTarget,
  );
}

// ============================================================================
// Challenge Response Handler
// ============================================================================

/**
 * Handle response to a duel challenge (accept or decline)
 */
export function handleDuelChallengeRespond(
  socket: ServerSocket,
  data: { challengeId: string; accept: boolean },
  world: World,
): void {
  const auth = withDuelAuth(socket, world);
  if (!auth) return;
  const { playerId, duelSystem } = auth;

  const { challengeId, accept } = data;

  // Validate challengeId
  if (!challengeId || typeof challengeId !== "string") {
    sendDuelError(socket, "Invalid challenge", "INVALID_CHALLENGE");
    return;
  }

  // Get the challenge to verify it exists and get challenger info
  const challenge = duelSystem.pendingDuels.getChallenge(challengeId);
  if (!challenge) {
    sendDuelError(
      socket,
      "Challenge not found or expired.",
      "CHALLENGE_EXPIRED",
    );
    return;
  }

  // Verify the responder is the target
  if (challenge.targetId !== playerId) {
    sendDuelError(
      socket,
      "You cannot respond to this challenge.",
      "NOT_TARGET",
    );
    return;
  }

  // Interface blocking check for target
  if (accept && hasActiveInterfaceSession(world, playerId)) {
    sendDuelError(
      socket,
      "You can't accept while using another interface.",
      "INTERFACE_OPEN",
    );
    return;
  }

  // Process the response
  const result = duelSystem.respondToChallenge(challengeId, playerId, accept);

  if (!result.success) {
    sendDuelError(
      socket,
      result.error ?? "Unknown error",
      result.errorCode || "UNKNOWN",
    );
    return;
  }

  const challengerSocket = getSocketByPlayerId(world, challenge.challengerId);

  if (accept) {
    // Challenge accepted - duel session created
    // Notify both players to open duel interface

    // Notify target (responder)
    sendToSocket(socket, DUEL_PACKETS.SESSION_STARTED, {
      duelId: result.duelId,
      opponentId: challenge.challengerId,
      opponentName: challenge.challengerName,
      isChallenger: false,
    });

    // Notify challenger
    if (challengerSocket) {
      sendToSocket(challengerSocket, DUEL_PACKETS.SESSION_STARTED, {
        duelId: result.duelId,
        opponentId: challenge.targetId,
        opponentName: challenge.targetName,
        isChallenger: true,
      });

      // Chat message for challenger
      const acceptChatMessage = {
        id: uuid(),
        from: "",
        body: `${challenge.targetName} has accepted your duel challenge!`,
        text: `${challenge.targetName} has accepted your duel challenge!`,
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
        type: "system" as const,
      };
      sendToSocket(
        challengerSocket,
        DUEL_PACKETS.CHAT_ADDED,
        acceptChatMessage,
      );
    }
  } else {
    // Challenge declined
    // Notify target that they declined
    sendToSocket(socket, "duelChallengeDeclined", {
      challengeId,
    });

    // Notify challenger that their challenge was declined
    if (challengerSocket) {
      sendToSocket(challengerSocket, "duelChallengeDeclined", {
        challengeId,
        declinedBy: challenge.targetName,
      });

      // Chat message for challenger
      const declineChatMessage = {
        id: uuid(),
        from: "",
        body: `${challenge.targetName} has declined your duel challenge.`,
        text: `${challenge.targetName} has declined your duel challenge.`,
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
        type: "system" as const,
      };
      sendToSocket(
        challengerSocket,
        DUEL_PACKETS.CHAT_ADDED,
        declineChatMessage,
      );
    }
  }
}
