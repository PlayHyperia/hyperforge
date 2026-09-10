/**
 * Gathering Module Exports
 *
 * Pure utility functions extracted from ResourceSystem.ts
 * for better modularity and testability.
 */

// Drop rolling functions
export { lerpSuccessRate, rollDrop, rollFishDrop } from "./DropRoller";

// Tool utility functions
export {
  getToolCategory,
  getToolDisplayName,
  isExactMatchFishingTool,
  itemMatchesToolCategory,
  resolveGatheringPresentationEmote,
  resolveGatheringPresentationItemId,
  EXACT_FISHING_TOOLS,
  type FishingToolId,
} from "./ToolUtils";

// Success rate calculations
export {
  computeSuccessRate,
  computeCycleTicks,
  getSuccessRateValues,
  ticksToMs,
} from "./SuccessRateCalculator";

// Type definitions
export type {
  GatheringSession,
  GatheringTuning,
  GatheringDebugInfo,
  ResourceTimer,
  FishingSpotTimer,
  SuccessRateValues,
  VariantTuning,
} from "./types";

// Debug configuration
export { DEBUG_GATHERING } from "./debug";
