/**
 * Quest Utilities
 *
 * Filtering, sorting, and helper functions for quest data.
 *
 * @packageDocumentation
 */

import type { QuestListPayload, QuestSnapshot } from "@hyperforge/shared";

// ============================================================================
// Quest Types
// ============================================================================

/** Quest state - lifecycle of a quest */
export type QuestState = "available" | "active" | "completed" | "failed";

/** Quest category */
export type QuestCategory = "main" | "side" | "daily" | "weekly" | "event";

/** Objective type */
export type ObjectiveType =
  | "kill"
  | "collect"
  | "talk"
  | "explore"
  | "escort"
  | "interact"
  | "craft"
  | "deliver";

/** Reward type */
export type RewardType =
  "xp" | "gold" | "item" | "reputation" | "unlock" | "xp_lamp" | "quest_points";

/** Single quest objective */
export interface QuestObjective {
  /** Unique identifier */
  id: string;
  /** Objective type */
  type: ObjectiveType;
  /** Description of what to do */
  description: string;
  /** Current progress count */
  current: number;
  /** Target progress count */
  target: number;
  /** Whether this objective is optional */
  optional?: boolean;
  /** Location hint (optional) */
  location?: string;
  /** Whether this objective is hidden until previous is complete */
  hidden?: boolean;
}

/** Quest reward */
export interface QuestReward {
  /** Reward type */
  type: RewardType;
  /** Display name */
  name: string;
  /** Amount (for XP, gold, reputation) */
  amount?: number;
  /** Item ID (for item rewards) */
  itemId?: string;
  /** Icon (emoji or URL) */
  icon?: string;
  /** Skill name for XP rewards */
  skill?: string;
}

/** Quest data structure */
export interface Quest {
  /** Unique identifier */
  id: string;
  /** Quest title */
  title: string;
  /** Brief description */
  description: string;
  /** Current state */
  state: QuestState;
  /** Authoritative claim eligibility, distinct from objective-work percentage. */
  readyToComplete?: boolean;
  /** Category */
  category: QuestCategory;
  /** Recommended level */
  level: number;
  /** Quest objectives */
  objectives: QuestObjective[];
  /** Quest rewards */
  rewards: QuestReward[];
  /** Whether quest is pinned to tracker */
  pinned: boolean;
  /** Quest giver NPC name */
  questGiver?: string;
  /** Quest giver location */
  questGiverLocation?: string;
  /** Prerequisite quest IDs */
  prerequisites?: string[];
  /** Quest chain ID (for linked quests) */
  chainId?: string;
  /** Position in quest chain (1-based) */
  chainPosition?: number;
  /** Total quests in chain */
  chainTotal?: number;
  /** Time limit in seconds (for timed quests) */
  timeLimit?: number;
  /** Remaining time in seconds */
  timeRemaining?: number;
  /** When the quest was started (timestamp) */
  startedAt?: number;
  /** When the quest was completed (timestamp) */
  completedAt?: number;
  /** Additional lore/story text */
  lore?: string;
}

/** Do not admit partial legacy rows: they cannot describe the quest denominator. */
export function isQuestListPayload(data: unknown): data is QuestListPayload {
  if (!data || typeof data !== "object") return false;
  const payload = data as Record<string, unknown>;
  if (
    !Array.isArray(payload.quests) ||
    typeof payload.questPoints !== "number" ||
    !Number.isFinite(payload.questPoints)
  )
    return false;
  return payload.quests.every((value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const quest = value as Record<string, unknown>;
    if (
      typeof quest.id !== "string" ||
      typeof quest.name !== "string" ||
      typeof quest.description !== "string" ||
      typeof quest.currentStage !== "string" ||
      typeof quest.startNpc !== "string" ||
      typeof quest.questPoints !== "number" ||
      !Number.isFinite(quest.questPoints) ||
      typeof quest.status !== "string" ||
      typeof quest.difficulty !== "string" ||
      ![
        "novice",
        "intermediate",
        "experienced",
        "master",
        "grandmaster",
      ].includes(quest.difficulty) ||
      ![
        "not_started",
        "in_progress",
        "ready_to_complete",
        "completed",
      ].includes(String(quest.status)) ||
      !Array.isArray(quest.stages) ||
      !quest.stageProgress ||
      typeof quest.stageProgress !== "object" ||
      Array.isArray(quest.stageProgress)
    )
      return false;
    if (
      !Object.values(quest.stageProgress).every(
        (count) =>
          typeof count === "number" && Number.isFinite(count) && count >= 0,
      )
    )
      return false;
    return quest.stages.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const stage = entry as Record<string, unknown>;
      return (
        typeof stage.id === "string" &&
        typeof stage.description === "string" &&
        typeof stage.type === "string" &&
        ["dialogue", "kill", "gather", "travel", "interact"].includes(
          String(stage.type),
        ) &&
        (stage.target === undefined || typeof stage.target === "string") &&
        (!["kill", "gather"].includes(stage.type) ||
          (typeof stage.count === "number" &&
            typeof stage.target === "string")) &&
        (stage.count === undefined ||
          (typeof stage.count === "number" &&
            Number.isFinite(stage.count) &&
            stage.count > 0))
      );
    });
  });
}

/** One projection for list, mobile detail, and detached desktop detail. */
export function questFromSnapshot(snapshot: QuestSnapshot): Quest {
  const currentStageIndex = snapshot.stages.findIndex(
    (stage) => stage.id === snapshot.currentStage,
  );
  // Recovery may derive ready from only the current objective; never infer
  // completion of later work from that status alone.
  const finishedObjectives = snapshot.status === "completed";
  const objectiveTypes = {
    kill: "kill",
    gather: "collect",
    travel: "explore",
    interact: "interact",
  } as const;
  const objectives: QuestObjective[] = [];
  snapshot.stages.forEach((stage, index) => {
    if (stage.type === "dialogue") return;
    const target = stage.count ?? 1;
    let current = 0;
    if (snapshot.status !== "not_started") {
      if (
        finishedObjectives ||
        (currentStageIndex >= 0 && index < currentStageIndex)
      )
        current = target;
      else if (stage.type === "kill" && index === currentStageIndex)
        current = snapshot.stageProgress.kills ?? 0;
      else if (
        (stage.type === "gather" || stage.type === "interact") &&
        stage.target
      )
        current = snapshot.stageProgress[stage.target] ?? 0;
    }
    objectives.push({
      id: stage.id,
      type: objectiveTypes[stage.type],
      description: stage.description,
      current: Number.isFinite(current)
        ? Math.max(0, Math.min(current, target))
        : 0,
      target,
      optional: false,
    });
  });
  return {
    id: snapshot.id,
    title: snapshot.name,
    description: snapshot.description,
    state:
      snapshot.status === "not_started"
        ? "available"
        : snapshot.status === "completed"
          ? "completed"
          : "active",
    readyToComplete: snapshot.status === "ready_to_complete",
    category: "main",
    level: 1,
    objectives,
    rewards: [
      {
        type: "quest_points",
        name: "Quest Points",
        amount: snapshot.questPoints,
      },
    ],
    pinned: false,
  };
}

// ============================================================================
// Sort Functions
// ============================================================================

/** Sort options for quests */
export type QuestSortOption =
  "name" | "level" | "progress" | "category" | "recent";

/** Sort direction */
export type SortDirection = "asc" | "desc";

/**
 * Calculate overall progress of a quest (0-100)
 */
export function calculateQuestProgress(quest: Quest): number {
  const requiredObjectives = quest.objectives.filter((o) => !o.optional);
  if (requiredObjectives.length === 0) {
    // Dialogue-only quests can be ready even without counted objectives.
    return quest.state === "completed" || quest.readyToComplete ? 100 : 0;
  }

  const totalProgress = requiredObjectives.reduce((acc, obj) => {
    return acc + Math.min(obj.current / obj.target, 1);
  }, 0);

  return Math.round((totalProgress / requiredObjectives.length) * 100);
}

/** Objective progress and server claim eligibility must both be satisfied. */
export function canClaimQuest(quest: Quest): boolean {
  return (
    quest.state === "active" &&
    calculateQuestProgress(quest) === 100 &&
    areAllObjectivesComplete(quest) &&
    (quest.readyToComplete ?? true)
  );
}

/**
 * Check if an objective is complete
 */
export function isObjectiveComplete(objective: QuestObjective): boolean {
  return objective.current >= objective.target;
}

/**
 * Check if all required objectives are complete
 */
export function areAllObjectivesComplete(quest: Quest): boolean {
  return quest.objectives
    .filter((o) => !o.optional)
    .every((o) => isObjectiveComplete(o));
}

/**
 * Sort quests by specified option
 */
export function sortQuests(
  quests: Quest[],
  sortBy: QuestSortOption,
  direction: SortDirection = "asc",
): Quest[] {
  const sorted = [...quests].sort((a, b) => {
    let comparison = 0;

    switch (sortBy) {
      case "name":
        comparison = a.title.localeCompare(b.title);
        break;

      case "level":
        comparison = a.level - b.level;
        break;

      case "progress":
        comparison = calculateQuestProgress(a) - calculateQuestProgress(b);
        break;

      case "category": {
        const categoryOrder: Record<QuestCategory, number> = {
          main: 0,
          side: 1,
          daily: 2,
          weekly: 3,
          event: 4,
        };
        comparison = categoryOrder[a.category] - categoryOrder[b.category];
        break;
      }

      case "recent":
        comparison = (a.startedAt || 0) - (b.startedAt || 0);
        break;
    }

    return direction === "asc" ? comparison : -comparison;
  });

  return sorted;
}

// ============================================================================
// Filter Functions
// ============================================================================

/** Filter options for quests */
export interface QuestFilterOptions {
  /** Filter by state(s) */
  states?: QuestState[];
  /** Filter by category/categories */
  categories?: QuestCategory[];
  /** Filter by minimum level */
  minLevel?: number;
  /** Filter by maximum level */
  maxLevel?: number;
  /** Filter to pinned only */
  pinnedOnly?: boolean;
  /** Search text (matches title, description) */
  searchText?: string;
  /** Filter by quest chain ID */
  chainId?: string;
  /** Filter to quests with time limits */
  timedOnly?: boolean;
}

/**
 * Filter quests based on options
 */
export function filterQuests(
  quests: Quest[],
  options: QuestFilterOptions,
): Quest[] {
  return quests.filter((quest) => {
    // Filter by states
    if (options.states && options.states.length > 0) {
      if (!options.states.includes(quest.state)) {
        return false;
      }
    }

    // Filter by categories
    if (options.categories && options.categories.length > 0) {
      if (!options.categories.includes(quest.category)) {
        return false;
      }
    }

    // Filter by level range
    if (options.minLevel !== undefined && quest.level < options.minLevel) {
      return false;
    }
    if (options.maxLevel !== undefined && quest.level > options.maxLevel) {
      return false;
    }

    // Filter by pinned
    if (options.pinnedOnly && !quest.pinned) {
      return false;
    }

    // Filter by search text
    if (options.searchText) {
      const searchLower = options.searchText.toLowerCase();
      const matchesTitle = quest.title.toLowerCase().includes(searchLower);
      const matchesDescription = quest.description
        .toLowerCase()
        .includes(searchLower);
      const matchesGiver = quest.questGiver
        ?.toLowerCase()
        .includes(searchLower);

      if (!matchesTitle && !matchesDescription && !matchesGiver) {
        return false;
      }
    }

    // Filter by chain
    if (options.chainId && quest.chainId !== options.chainId) {
      return false;
    }

    // Filter by timed
    if (options.timedOnly && !quest.timeLimit) {
      return false;
    }

    return true;
  });
}

// ============================================================================
// Grouping Functions
// ============================================================================

/**
 * Group quests by category
 */
export function groupQuestsByCategory(
  quests: Quest[],
): Record<QuestCategory, Quest[]> {
  const groups: Record<QuestCategory, Quest[]> = {
    main: [],
    side: [],
    daily: [],
    weekly: [],
    event: [],
  };

  quests.forEach((quest) => {
    groups[quest.category].push(quest);
  });

  return groups;
}

/**
 * Group quests by state
 */
export function groupQuestsByState(
  quests: Quest[],
): Record<QuestState, Quest[]> {
  const groups: Record<QuestState, Quest[]> = {
    available: [],
    active: [],
    completed: [],
    failed: [],
  };

  quests.forEach((quest) => {
    groups[quest.state].push(quest);
  });

  return groups;
}

/**
 * Get quests in a chain, sorted by position
 */
export function getQuestChain(quests: Quest[], chainId: string): Quest[] {
  return quests
    .filter((q) => q.chainId === chainId)
    .sort((a, b) => (a.chainPosition || 0) - (b.chainPosition || 0));
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Category display configuration */
export interface CategoryConfig {
  label: string;
  icon: string;
  color: string;
}

/** Category display configurations */
export const CATEGORY_CONFIG: Record<QuestCategory, CategoryConfig> = {
  main: { label: "Main Quest", icon: "crown", color: "#c9a54a" },
  side: { label: "Side Quest", icon: "scroll", color: "#5bc0de" },
  daily: { label: "Daily", icon: "sun", color: "#f0ad4e" },
  weekly: { label: "Weekly", icon: "calendar", color: "#5cb85c" },
  event: { label: "Event", icon: "star", color: "#d9534f" },
};

/** State display configuration */
export interface StateConfig {
  label: string;
  icon: string;
  color: string;
}

/** State display configurations */
export const STATE_CONFIG: Record<QuestState, StateConfig> = {
  available: { label: "Available", icon: "circle", color: "#5bc0de" },
  active: { label: "In Progress", icon: "play", color: "#f0ad4e" },
  completed: { label: "Completed", icon: "check", color: "#5cb85c" },
  failed: { label: "Failed", icon: "x", color: "#d9534f" },
};

/** Objective type display configuration */
export interface ObjectiveTypeConfig {
  label: string;
  icon: string;
  verb: string;
}

/** Objective type configurations */
export const OBJECTIVE_TYPE_CONFIG: Record<ObjectiveType, ObjectiveTypeConfig> =
  {
    kill: { label: "Defeat", icon: "swords", verb: "Defeat" },
    collect: { label: "Collect", icon: "package", verb: "Collect" },
    talk: { label: "Talk", icon: "message-circle", verb: "Talk to" },
    explore: { label: "Explore", icon: "compass", verb: "Explore" },
    escort: { label: "Escort", icon: "users", verb: "Escort" },
    interact: { label: "Interact", icon: "hand", verb: "Interact with" },
    craft: { label: "Craft", icon: "hammer", verb: "Craft" },
    deliver: { label: "Deliver", icon: "send", verb: "Deliver" },
  };

/**
 * Format time remaining as a string
 */
export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "Expired";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Get next available quest in a chain
 */
export function getNextChainQuest(
  quests: Quest[],
  currentQuest: Quest,
): Quest | undefined {
  if (!currentQuest.chainId) return undefined;

  const chain = getQuestChain(quests, currentQuest.chainId);
  const currentIndex = chain.findIndex((q) => q.id === currentQuest.id);

  if (currentIndex >= 0 && currentIndex < chain.length - 1) {
    return chain[currentIndex + 1];
  }

  return undefined;
}

/**
 * Check if quest prerequisites are met
 */
export function arePrerequisitesMet(
  quest: Quest,
  completedQuestIds: Set<string>,
): boolean {
  if (!quest.prerequisites || quest.prerequisites.length === 0) {
    return true;
  }

  return quest.prerequisites.every((prereqId) =>
    completedQuestIds.has(prereqId),
  );
}

/**
 * Get reward summary text
 */
export function getRewardSummary(rewards: QuestReward[]): string {
  const parts: string[] = [];

  const xpRewards = rewards.filter((r) => r.type === "xp");
  const goldReward = rewards.find((r) => r.type === "gold");
  const itemCount = rewards.filter((r) => r.type === "item").length;

  if (xpRewards.length > 0) {
    const totalXp = xpRewards.reduce((sum, r) => sum + (r.amount || 0), 0);
    parts.push(`${totalXp.toLocaleString()} XP`);
  }

  if (goldReward && goldReward.amount) {
    parts.push(`${goldReward.amount.toLocaleString()} Gold`);
  }

  if (itemCount > 0) {
    parts.push(`${itemCount} Item${itemCount > 1 ? "s" : ""}`);
  }

  return parts.join(", ") || "No rewards";
}

// ============================================================================
// Type Adapters (shared ↔ client)
// ============================================================================

/**
 * Shared package quest status type (from @hyperforge/shared)
 * Matches: "not_started" | "in_progress" | "ready_to_complete" | "completed"
 */
export type SharedQuestStatus =
  "not_started" | "in_progress" | "ready_to_complete" | "completed";

/**
 * Shared package quest difficulty type (from @hyperforge/shared)
 */
export type SharedQuestDifficulty =
  "novice" | "intermediate" | "experienced" | "master" | "grandmaster";

/**
 * Shared package quest rewards structure
 */
export interface SharedQuestRewards {
  questPoints: number;
  items: Array<{ itemId: string; quantity: number }>;
  xp: Record<string, number>;
}

/**
 * Convert shared QuestStatus to client QuestState
 */
export function statusToState(status: SharedQuestStatus): QuestState {
  switch (status) {
    case "not_started":
      return "available";
    case "in_progress":
    case "ready_to_complete":
      return "active";
    case "completed":
      return "completed";
    default:
      return "available";
  }
}

/**
 * Convert client QuestState to shared QuestStatus
 */
export function stateToStatus(state: QuestState): SharedQuestStatus {
  switch (state) {
    case "available":
      return "not_started";
    case "active":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      // No direct mapping - treat as not started
      return "not_started";
    default:
      return "not_started";
  }
}

/**
 * Convert shared QuestDifficulty to a display level
 */
export function difficultyToLevel(difficulty: SharedQuestDifficulty): number {
  const levels: Record<SharedQuestDifficulty, number> = {
    novice: 1,
    intermediate: 25,
    experienced: 50,
    master: 75,
    grandmaster: 99,
  };
  return levels[difficulty] || 1;
}

/**
 * Convert shared QuestRewards to client QuestReward[]
 */
export function convertRewards(rewards: SharedQuestRewards): QuestReward[] {
  const result: QuestReward[] = [];

  // Quest points
  if (rewards.questPoints > 0) {
    result.push({
      type: "quest_points",
      name: "Quest Points",
      amount: rewards.questPoints,
      icon: "🏆",
    });
  }

  // XP rewards
  for (const [skill, amount] of Object.entries(rewards.xp)) {
    result.push({
      type: "xp",
      name: `${skill.charAt(0).toUpperCase() + skill.slice(1)} XP`,
      amount,
      skill,
      icon: "⭐",
    });
  }

  // Item rewards
  for (const item of rewards.items) {
    // Check if it's an XP lamp
    const isXpLamp = item.itemId.includes("xp_lamp");
    result.push({
      type: isXpLamp ? "xp_lamp" : "item",
      name: item.itemId,
      amount: item.quantity,
      itemId: item.itemId,
      icon: isXpLamp ? "🪔" : "📦",
    });
  }

  return result;
}
