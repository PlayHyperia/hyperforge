/**
 * Firemaking Calculator
 *
 * rules-accurate firemaking success rate calculations.
 * Uses data from items.json manifest via ProcessingDataProvider.
 *
 */

import { PROCESSING_CONSTANTS } from "../../../../constants/ProcessingConstants";
import { processingDataProvider } from "../../../../data/ProcessingDataProvider";

/**
 * Calculate firemaking success rate using classic MMORPG LERP formula.
 *
 * classic MMORPG Formula: successChance = (low + (high - low) * (level - 1) / 98) / 256
 * - At level 1: 65/256 = 25.4%
 * - At level 43: 256/256 = 100% (capped)
 * - At level 99: 513/256 = 100% (capped)
 *
 * @param level - Player's firemaking level (1-99)
 * @returns Success probability (0-1)
 *
 */
export function calculateFiremakingSuccess(level: number): number {
  const { low, high } = PROCESSING_CONSTANTS.FIREMAKING_SUCCESS_RATE;
  const successNumerator = low + ((high - low) * (level - 1)) / 98;
  return Math.min(successNumerator / 256, 1.0);
}

/**
 * Get firemaking XP for a log type.
 *
 * @param logId - Log item ID (e.g., "logs", "oak_logs")
 * @returns XP amount, or 0 if invalid log
 */
export function getFiremakingXP(logId: string): number {
  return processingDataProvider.getFiremakingXP(logId);
}

/**
 * Get required firemaking level for a log type.
 *
 * @param logId - Log item ID
 * @returns Required level, or 1 if invalid log
 */
export function getFiremakingLevelRequired(logId: string): number {
  return processingDataProvider.getFiremakingLevel(logId);
}

/**
 * Check if player meets firemaking level requirement for a log type.
 *
 * @param playerLevel - Player's firemaking level
 * @param logId - Log item ID
 * @returns True if player can burn this log type
 */
export function meetsFiremakingLevel(
  playerLevel: number,
  logId: string,
): boolean {
  const required = getFiremakingLevelRequired(logId);
  return playerLevel >= required;
}

/**
 * Check if an item ID is a valid log type.
 *
 * @param itemId - Item ID to check
 * @returns True if valid log
 */
export function isValidLog(itemId: string): boolean {
  return processingDataProvider.isBurnableLog(itemId);
}

/**
 * Get random fire duration in ticks.
 *
 * Fires last 60-119 seconds.
 * At 600ms/tick: 100-198 ticks.
 *
 * @returns Duration in ticks
 */
export function getRandomFireDuration(): number {
  const { minDurationTicks, maxDurationTicks } = PROCESSING_CONSTANTS.FIRE;
  return (
    minDurationTicks +
    Math.floor(Math.random() * (maxDurationTicks - minDurationTicks + 1))
  );
}

/**
 * Get all valid log IDs.
 *
 * @returns Set of valid log item IDs
 */
export function getValidLogIds(): Set<string> {
  return processingDataProvider.getBurnableLogIds();
}
