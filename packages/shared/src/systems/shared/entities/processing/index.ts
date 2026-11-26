/**
 * Processing Module Exports
 *
 * Firemaking and cooking system types and utilities.
 */

// Type definitions
export type {
  ProcessingTuning,
  ProcessingDebugInfo,
  FiremakingSession,
  CookingSession,
  Fire,
  CookingSource,
} from "./types";

// Debug configuration
export { DEBUG_PROCESSING } from "./debug";

// Firemaking calculator
export {
  calculateFiremakingSuccess,
  getFiremakingXP,
  getFiremakingLevelRequired,
  meetsFiremakingLevel,
  isValidLog,
  getRandomFireDuration,
  getValidLogIds,
} from "./FiremakingCalculator";

// Cooking calculator
export {
  getStopBurnLevel,
  calculateBurnChance,
  rollBurn,
  getCookingXP,
  getCookingLevelRequired,
  meetsCookingLevel,
  isValidRawFood,
  getCookedItemId,
  getBurntItemId,
  getValidRawFoodIds,
} from "./CookingCalculator";

// Log utilities
export {
  isValidLog as isValidLogType,
  getValidLogIds as getAllValidLogIds,
  getLogDisplayData,
  getAllLogsSortedByLevel,
} from "./LogUtils";
export type { LogDisplayData } from "./LogUtils";

// Food utilities
export {
  isValidRawFood as isValidRawFoodType,
  getValidRawFoodIds as getAllValidRawFoodIds,
  getCookedItemId as getFoodCookedId,
  getBurntItemId as getFoodBurntId,
  getFoodDisplayData,
  getAllFoodsSortedByLevel,
  isRangeBetter,
  getRecommendedCookingSource,
} from "./FoodUtils";
export type { FoodDisplayData } from "./FoodUtils";

// Fire manager
export { FireManager, getFireManager, resetFireManager } from "./FireManager";

// The older callback-driven session/pending managers are intentionally not
// exported. ProcessingSystem is the sole runtime action boundary because it
// couples inventory and XP through durable idempotent receipts.
