/**
 * ToolUtils - Pure utility functions for tool validation and categorization
 *
 * Extracted from ResourceSystem.ts for SOLID compliance (Single Responsibility).
 *
 * Tool validation uses the tools.json manifest as the single source of truth.
 * Each tool has an explicit `skill` field ("woodcutting", "mining", "fishing")
 * that determines which resources it can be used on — no substring matching.
 */

import { isNotedItemId } from "../../../../data/NoteGenerator";
import { getExternalTool } from "../../../../utils/ExternalAssetUtils";

/**
 * classic MMORPG fishing tools that require exact matching (not interchangeable)
 */
export const EXACT_FISHING_TOOLS = [
  "small_fishing_net",
  "fishing_rod",
  "fly_fishing_rod",
  "harpoon",
  "lobster_pot",
  "big_fishing_net",
] as const;

export type FishingToolId = (typeof EXACT_FISHING_TOOLS)[number];

/** Skill types matching the manifest's GatheringToolData.skill union */
type GatheringSkill = "woodcutting" | "mining" | "fishing";

/**
 * Track items that have already triggered the fallback warning (warn once per item).
 * Once the Set reaches MAX_FALLBACK_WARNINGS, no new entries are added and no further
 * warnings are logged. The Set entries persist for the lifetime of the process.
 */
const MAX_FALLBACK_WARNINGS = 50;
const fallbackWarned = new Set<string>();

/**
 * Reset the fallback warning cache.
 * @internal Exported for test isolation only — do not call in production code.
 */
export function _resetFallbackWarnings(): void {
  fallbackWarned.clear();
}

/**
 * Map from tool category to the skill it belongs to.
 * When a new gathering category is added (e.g., "knife" for crafting),
 * add an entry here so the manifest path handles it — otherwise the
 * fallback compares category===skill directly.
 *
 * NOTE: Fishing tools bypass this map via the exact-match path.
 * If you add a new category-matched gathering skill, you MUST add its category here.
 */
const CATEGORY_TO_SKILL: Partial<Record<string, GatheringSkill>> = {
  hatchet: "woodcutting",
  pickaxe: "mining",
};

/**
 * Extract tool category from toolRequired field
 *
 * e.g., "bronze_hatchet" -> "hatchet", "bronze_pickaxe" -> "pickaxe"
 *
 * RULES ACCURACY: Fishing tools use EXACT matching because:
 * - small_fishing_net catches shrimp/anchovies (level 1)
 * - fishing_rod + bait catches sardine/herring/pike (level 5+)
 * - fly_fishing_rod + feathers catches trout/salmon (level 20+)
 * These are NOT interchangeable like pickaxe tiers.
 *
 * @param toolRequired - The tool ID from resource manifest
 * @returns The tool category or exact ID for fishing tools
 */
export function getToolCategory(toolRequired: string): string {
  const lowerTool = toolRequired.toLowerCase();

  // RULES ACCURACY: Fishing tools require EXACT matching (not interchangeable)
  // Return the exact tool ID for fishing equipment
  if (EXACT_FISHING_TOOLS.includes(lowerTool as FishingToolId)) {
    return lowerTool; // Return exact ID, not category
  }

  // Handle common patterns (check pickaxe before axe since "pickaxe" contains "axe")
  if (lowerTool.includes("pickaxe") || lowerTool.includes("pick")) {
    return "pickaxe";
  }
  if (lowerTool.includes("hatchet") || lowerTool.includes("axe")) {
    return "hatchet";
  }

  // Fallback: take last segment after underscore
  const parts = toolRequired.split("_");
  return parts[parts.length - 1];
}

/**
 * Tool display name mapping
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  hatchet: "hatchet",
  pickaxe: "pickaxe",
  // rules-accurate fishing tool names
  small_fishing_net: "small fishing net",
  fishing_rod: "fishing rod",
  fly_fishing_rod: "fly fishing rod",
  harpoon: "harpoon",
  lobster_pot: "lobster pot",
  big_fishing_net: "big fishing net",
};

/**
 * Get human-readable display name for tool category
 *
 * @param category - Tool category or exact fishing tool ID
 * @returns Human-readable tool name
 */
export function getToolDisplayName(category: string): string {
  return TOOL_DISPLAY_NAMES[category] || category.replace(/_/g, " ");
}

/**
 * Check if a tool category is a fishing tool that requires exact matching
 *
 * @param category - Tool category to check
 * @returns True if this is a fishing tool requiring exact match
 */
export function isExactMatchFishingTool(category: string): boolean {
  return EXACT_FISHING_TOOLS.includes(category as FishingToolId);
}

/**
 * Resolve the item whose model must be presented for a gathering session.
 *
 * Fishing resources require distinct, non-interchangeable equipment. Their
 * presentation must therefore follow the resource's exact `toolRequired`
 * authority, even when another fishing item has a better manifest priority.
 * Woodcutting and mining continue to present the best usable tier selected by
 * the gathering system.
 */
export function resolveGatheringPresentationItemId(
  skill: string,
  requiredToolId: string | null | undefined,
  selectedToolItemId: string | null | undefined,
): string | null {
  if (skill === "fishing") {
    if (!requiredToolId) return null;
    const exactToolId = getToolCategory(requiredToolId);
    return isExactMatchFishingTool(exactToolId) ? exactToolId : null;
  }

  const normalizedSelectedToolId = selectedToolItemId?.trim();
  return normalizedSelectedToolId || null;
}

/**
 * Resolve the symbolic emote carried by authoritative movement/entity state.
 *
 * Fishing uses the exact required item ID as its emote authority. The client
 * deliberately maps only art-certified item IDs to animation assets; an exact
 * but uncertified net, pot, or harpoon key therefore falls back to idle instead
 * of displaying a misleading rod cast. Woodcutting and mining retain their
 * established skill-family keys.
 */
export function resolveGatheringPresentationEmote(
  skill: string,
  requiredToolId: string | null | undefined,
  selectedToolItemId: string | null | undefined,
): string {
  if (skill === "fishing") {
    return (
      resolveGatheringPresentationItemId(
        skill,
        requiredToolId,
        selectedToolItemId,
      ) ?? "idle"
    );
  }
  if (skill === "woodcutting") return "chopping";
  if (skill === "mining") return "mining";
  return "idle";
}

/**
 * Check if an item ID matches the required tool category.
 *
 * Uses the tools.json manifest as the single source of truth:
 * - Looks up the item in the manifest to get its declared skill
 * - Compares the skill against the expected skill for the category
 * - Fishing tools require exact ID match (not interchangeable)
 *
 * This prevents cross-skill tool usage (e.g., pickaxe for woodcutting)
 * which was possible with the old substring-matching approach.
 *
 * @param itemId - The item ID from player inventory
 * @param category - The required tool category
 * @returns True if the item satisfies the tool requirement
 */
export function itemMatchesToolCategory(
  itemId: string,
  category: string,
): boolean {
  // Noted items are bank notes - cannot be used as tools
  if (isNotedItemId(itemId)) {
    return false;
  }

  const lowerItemId = itemId.toLowerCase();

  // If category is an exact fishing tool, require exact match
  if (isExactMatchFishingTool(category)) {
    return lowerItemId === category;
  }

  // Manifest-based validation: look up the item in tools.json
  const toolData = getExternalTool(lowerItemId);
  if (toolData) {
    // Tool exists in manifest — check if its skill matches the required category.
    // For known categories (hatchet, pickaxe), compare via CATEGORY_TO_SKILL.
    // For unknown categories, compare the skill directly against the category string.
    const expectedSkill = CATEGORY_TO_SKILL[category] ?? category;
    return toolData.skill === expectedSkill;
  }

  // Fallback for tools not in the manifest — substring matching with cross-skill guards.
  // Warn once per item, capped at MAX_FALLBACK_WARNINGS total unique items.
  if (
    fallbackWarned.size < MAX_FALLBACK_WARNINGS &&
    !fallbackWarned.has(lowerItemId)
  ) {
    fallbackWarned.add(lowerItemId);
    console.warn(
      `[ToolUtils] Item "${itemId}" not found in tools manifest — using fallback matching for category "${category}"`,
    );
  }

  // Substring fallback — intentionally conservative to avoid false positives.
  // All known gathering tools should be in tools.json; this is a safety net only.
  // For hatchet, we only match "hatchet" (not bare "axe") to avoid combat weapons
  // like battleaxe, greataxe, etc. that would otherwise false-positive.
  if (category === "hatchet") {
    if (lowerItemId.includes("pickaxe") || lowerItemId.includes("pick")) {
      return false;
    }
    return lowerItemId.includes("hatchet");
  }
  if (category === "pickaxe") {
    if (lowerItemId.includes("hatchet")) {
      return false;
    }
    return lowerItemId.includes("pickaxe") || lowerItemId.includes("pick");
  }

  // Unknown category with no manifest entry — reject rather than substring match.
  // All gathering tools must be in tools.json; this forces manifest completeness.
  return false;
}
