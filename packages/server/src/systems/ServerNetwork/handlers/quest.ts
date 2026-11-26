/**
 * Quest Network Handlers
 *
 * Handles network messages for quest-related operations:
 * - getQuestList: Fetch all quests for a player
 * - getQuestDetail: Fetch detailed info for a specific quest
 */

import type { World } from "@hyperforge/shared";
import type { QuestSystem, QuestListPayload } from "@hyperforge/shared";
import {
  SystemLogger,
  isValidQuestId,
  createQuestSnapshot,
} from "@hyperforge/shared";
import type { ServerSocket } from "../../../shared/types";
import { sendToSocket, getPlayerId } from "./common";
import {
  getQuestListRateLimiter,
  getQuestDetailRateLimiter,
  getQuestAcceptRateLimiter,
  getQuestAbandonRateLimiter,
  getQuestCompleteRateLimiter,
} from "../services/SlidingWindowRateLimiter";

/** Logger for quest handlers */
const logger = new SystemLogger("QuestHandlers");
const SHOULD_LOG_MISSING_PLAYER = process.env.PLAYWRIGHT_TEST !== "true";

/**
 * Handle request for quest list
 */
export function handleGetQuestList(
  socket: ServerSocket,
  _data: Record<string, unknown>,
  world: World,
): void {
  const playerId = getPlayerId(socket);
  if (!playerId) {
    if (SHOULD_LOG_MISSING_PLAYER) {
      logger.warn("No playerId for getQuestList request");
    }
    return;
  }

  // Rate limit check
  if (!getQuestListRateLimiter().check(playerId)) {
    logger.debug(`Rate limit exceeded for ${playerId} on getQuestList`);
    return;
  }

  sendQuestListSnapshot(socket, world, playerId);
}

/** Server-owned changes push the same snapshot without another client RPC. */
function sendQuestListSnapshot(
  socket: ServerSocket,
  world: World,
  playerId: string,
): void {
  const questSystem = world.getSystem("quest") as QuestSystem | undefined;
  if (!questSystem) {
    logger.warn("QuestSystem not available");
    return;
  }

  // Get all quest definitions
  const allDefinitions = questSystem.getAllQuestDefinitions();

  // Get active quests for stage info
  const activeQuests = questSystem.getActiveQuests(playerId);

  // Build quest list with status for this player
  const quests = allDefinitions.map((def) => {
    const status = questSystem.getQuestStatus(playerId, def.id);
    const active = activeQuests.find((aq) => aq.questId === def.id);
    return createQuestSnapshot(def, status, active);
  });

  const questPoints = questSystem.getQuestPoints(playerId);

  // Send quest list to client via packet
  const payload: QuestListPayload = {
    quests,
    questPoints,
  };
  sendToSocket(socket, "questList", payload);
}

/**
 * Handle request for quest detail
 */
export function handleGetQuestDetail(
  socket: ServerSocket,
  data: { questId: string },
  world: World,
): void {
  const playerId = getPlayerId(socket);
  if (!playerId) {
    if (SHOULD_LOG_MISSING_PLAYER) {
      logger.warn("No playerId for getQuestDetail request");
    }
    return;
  }

  // Rate limit check
  if (!getQuestDetailRateLimiter().check(playerId)) {
    logger.debug(`Rate limit exceeded for ${playerId} on getQuestDetail`);
    return;
  }

  const { questId } = data;

  // Validate questId format (prevents log injection and invalid lookups)
  if (!isValidQuestId(questId)) {
    logger.warn("Invalid or missing questId format for getQuestDetail");
    return;
  }

  const questSystem = world.getSystem("quest") as QuestSystem | undefined;
  if (!questSystem) {
    logger.warn("QuestSystem not available");
    return;
  }

  const definition = questSystem.getQuestDefinition(questId);
  if (!definition) {
    // Safe to log questId now since it passed validation
    logger.warn(`Quest not found: ${questId}`);
    return;
  }

  const status = questSystem.getQuestStatus(playerId, questId);

  // Get active quest progress if in progress
  const activeQuests = questSystem.getActiveQuests(playerId);
  const activeQuest = activeQuests.find((q) => q.questId === questId);

  logger.debug(`getQuestDetail for ${questId}`, {
    activeQuest: activeQuest ? JSON.stringify(activeQuest) : null,
  });

  // Build detail response
  const detail = createQuestSnapshot(definition, status, activeQuest);

  logger.debug("Sending detail with stageProgress", {
    stageProgress: detail.stageProgress,
  });

  // Send quest detail to client via packet
  sendToSocket(socket, "questDetail", detail);
}

/**
 * Handle quest accept from client
 * Called when player clicks Accept on the quest start screen
 */
export async function handleQuestAccept(
  socket: ServerSocket,
  data: { questId: string },
  world: World,
): Promise<void> {
  const playerId = getPlayerId(socket);
  if (!playerId) {
    if (SHOULD_LOG_MISSING_PLAYER) {
      logger.warn("No playerId for questAccept request");
    }
    return;
  }

  // Rate limit check
  if (!getQuestAcceptRateLimiter().check(playerId)) {
    logger.debug(`Rate limit exceeded for ${playerId} on questAccept`);
    return;
  }

  const { questId } = data;

  // Validate questId format (prevents log injection and invalid lookups)
  if (!isValidQuestId(questId)) {
    logger.warn("Invalid or missing questId format for questAccept");
    return;
  }

  const questSystem = world.getSystem("quest") as QuestSystem | undefined;
  if (!questSystem) {
    logger.warn("QuestSystem not available");
    return;
  }

  // Start the quest (this will validate requirements and set status to in_progress)
  // Safe to use questId now since it passed validation
  const success = await questSystem.startQuest(playerId, questId);

  if (success) {
    logger.info(`Player ${playerId} started quest ${questId}`);
  } else {
    logger.warn(`Failed to start quest ${questId} for player ${playerId}`);
  }
}

/**
 * Handle quest abandon request from client
 * Called when player clicks "Abandon Quest" button
 */
export async function handleQuestAbandon(
  socket: ServerSocket,
  data: { questId: string },
  world: World,
): Promise<void> {
  const playerId = getPlayerId(socket);
  if (!playerId) {
    if (SHOULD_LOG_MISSING_PLAYER) {
      logger.warn("No playerId for questAbandon request");
    }
    return;
  }

  // Rate limit check
  if (!getQuestAbandonRateLimiter().check(playerId)) {
    logger.debug(`Rate limit exceeded for ${playerId} on questAbandon`);
    return;
  }

  const { questId } = data;

  // Validate questId format (prevents log injection and invalid lookups)
  if (!isValidQuestId(questId)) {
    logger.warn("Invalid or missing questId format for questAbandon");
    return;
  }

  const questSystem = world.getSystem("quest") as QuestSystem | undefined;
  if (!questSystem) {
    logger.warn("QuestSystem not available");
    return;
  }

  // Abandon the quest
  const success = await questSystem.abandonQuest(playerId, questId);

  if (success) {
    logger.info(`Player ${playerId} abandoned quest ${questId}`);
    sendQuestListSnapshot(socket, world, playerId);
  } else {
    logger.warn(`Failed to abandon quest ${questId} for player ${playerId}`);
  }
}

/**
 * Handle quest completion request from client
 * Called when player clicks "Complete Quest" button for a ready_to_complete quest
 */
export async function handleQuestComplete(
  socket: ServerSocket,
  data: { questId: string },
  world: World,
): Promise<void> {
  const playerId = getPlayerId(socket);
  if (!playerId) {
    if (SHOULD_LOG_MISSING_PLAYER) {
      logger.warn("No playerId for questComplete request");
    }
    return;
  }

  // Rate limit check
  if (!getQuestCompleteRateLimiter().check(playerId)) {
    logger.debug(`Rate limit exceeded for ${playerId} on questComplete`);
    return;
  }

  const { questId } = data;

  // Validate questId format (prevents log injection and invalid lookups)
  if (!isValidQuestId(questId)) {
    logger.warn("Invalid or missing questId format for questComplete");
    return;
  }

  const questSystem = world.getSystem("quest") as QuestSystem | undefined;
  if (!questSystem) {
    logger.warn("QuestSystem not available");
    return;
  }

  // Check if quest is ready to complete
  const status = questSystem.getQuestStatus(playerId, questId);
  if (status !== "ready_to_complete") {
    logger.warn(
      `Quest ${questId} is not ready to complete for ${playerId} (status: ${status})`,
    );
    return;
  }

  // Complete the quest
  const success = await questSystem.completeQuest(playerId, questId);

  if (success) {
    logger.info(`Player ${playerId} completed quest ${questId}`);
  } else {
    logger.warn(`Failed to complete quest ${questId} for player ${playerId}`);
  }
}
