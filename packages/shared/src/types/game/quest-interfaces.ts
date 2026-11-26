/**
 * Quest System Interfaces
 *
 * Defines segregated interfaces for different aspects of quest functionality.
 * This follows Interface Segregation Principle (ISP) - callers only depend
 * on the methods they actually need.
 *
 * **Interface Overview:**
 * - `IQuestQuery` - Read-only quest information queries
 * - `IQuestProgress` - Active quest progress tracking
 * - `IQuestActions` - Quest state mutation actions
 *
 * **Usage:**
 * Handlers that only need to check quest status use `IQuestQuery`.
 * Systems that need to start/complete quests use `IQuestActions`.
 * This reduces coupling and makes dependencies explicit.
 */

import type {
  QuestDefinition,
  QuestStatus,
  QuestProgress,
} from "./quest-types";

/**
 * Read-only quest information queries
 *
 * Use this interface when you only need to read quest data
 * without modifying quest state.
 */
export interface IQuestQuery {
  /**
   * Get the status of a quest for a player
   * @param playerId - The player ID
   * @param questId - The quest identifier
   * @returns Quest status or "not_started" if never interacted
   */
  getQuestStatus(playerId: string, questId: string): QuestStatus;

  /**
   * Check whether a quest can be started at the current authoritative state.
   * Returns false for unknown players/quests and already active/completed quests.
   * The mutation path rechecks the same conditions before starting the quest.
   */
  canStartQuest(playerId: string, questId: string): boolean;

  /**
   * Get quest definition by ID
   * @param questId - The quest identifier
   * @returns Quest definition or undefined if not found
   */
  getQuestDefinition(questId: string): QuestDefinition | undefined;

  /**
   * Get all quest definitions
   * @returns Array of all quest definitions
   */
  getAllQuestDefinitions(): QuestDefinition[];

  /**
   * Get total quest points for a player
   * @param playerId - The player ID
   * @returns Number of quest points earned
   */
  getQuestPoints(playerId: string): number;

  /**
   * Check if a player has completed a specific quest
   * @param playerId - The player ID
   * @param questId - The quest identifier
   * @returns true if quest is completed
   */
  hasCompletedQuest(playerId: string, questId: string): boolean;
}

/**
 * Active quest progress tracking
 *
 * Use this interface when you need to access active quest progress
 * for UI display or progress checking.
 */
export interface IQuestProgress {
  /**
   * Get all active quests for a player
   * @param playerId - The player ID
   * @returns Array of active quest progress objects
   */
  getActiveQuests(playerId: string): QuestProgress[];
}

/**
 * Quest state mutation actions
 *
 * Use this interface when you need to modify quest state
 * (start, complete, etc.)
 */
export interface IQuestActions {
  /**
   * Request to start a quest - shows confirmation screen to player
   * @param playerId - The player ID
   * @param questId - The quest identifier
   * @returns true if request was successful
   */
  requestQuestStart(playerId: string, questId: string): boolean;

  /**
   * Actually start a quest for a player
   * @param playerId - The player ID
   * @param questId - The quest identifier
   * @returns true if quest was started successfully
   */
  startQuest(playerId: string, questId: string): Promise<boolean>;

  /**
   * Complete a quest for a player
   * @param playerId - The player ID
   * @param questId - The quest identifier
   * @returns true if quest was completed successfully
   */
  completeQuest(playerId: string, questId: string): Promise<boolean>;
}

/**
 * Combined interface for full quest system access
 *
 * QuestSystem implements this full interface, but callers should
 * prefer using the specific sub-interfaces when possible.
 */
export interface IQuestSystem
  extends IQuestQuery, IQuestProgress, IQuestActions {}
