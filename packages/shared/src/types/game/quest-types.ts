/**
 * Quest Type Definitions
 *
 * Types for the manifest-driven quest system.
 * Quests are defined in quests.json and loaded at runtime.
 *
 * @see QUEST_SYSTEM_PLAN.md for implementation details
 */

// === Constants ===

/** Maximum length for quest IDs (security: prevent DoS via huge strings) */
export const MAX_QUEST_ID_LENGTH = 64;

/** Pattern for valid quest IDs: lowercase alphanumeric + underscore */
export const QUEST_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

// === Core Types ===

/**
 * Quest status values.
 * - "not_started": Player hasn't begun the quest
 * - "in_progress": Quest active, objectives not complete
 * - "ready_to_complete": Quest active, current stage objective IS complete (derived state)
 * - "completed": Quest finished, rewards claimed
 */
export type QuestStatus =
  "not_started" | "in_progress" | "ready_to_complete" | "completed";

/** Database-stored status values (ready_to_complete is derived, not stored) */
export type QuestDbStatus = "not_started" | "in_progress" | "completed";

/** Quest difficulty levels matching classic fantasy MMORPG */
export type QuestDifficulty =
  "novice" | "intermediate" | "experienced" | "master" | "grandmaster";

/** Types of quest stage objectives */
export type QuestStageType =
  "dialogue" | "kill" | "gather" | "travel" | "interact";

// === Quest Definition Types ===

/** Requirements to start a quest */
export interface QuestRequirements {
  /** Quest IDs that must be completed first */
  readonly quests: string[];
  /** Skill requirements: { "attack": 10, "woodcutting": 15 } */
  readonly skills: Record<string, number>;
  /** Item IDs the player must have */
  readonly items: string[];
}

/** A single stage within a quest */
export interface QuestStage {
  /** Unique stage identifier within this quest */
  readonly id: string;
  /** Type of objective */
  readonly type: QuestStageType;
  /** Human-readable description for quest journal */
  readonly description: string;
  /** NPC ID for dialogue stages */
  readonly npcId?: string;
  /** Target NPC/item ID for kill/gather stages */
  readonly target?: string;
  /** Required count for kill/gather stages */
  readonly count?: number;
  /** Location requirement for travel stages */
  readonly location?: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly radius: number;
  };
}

/** Items/effects granted when quest starts */
export interface QuestOnStart {
  /** Items given to player on quest start */
  readonly items?: Array<{
    readonly itemId: string;
    readonly quantity: number;
  }>;
  /** Dialogue node to jump to after starting */
  readonly dialogue?: string;
}

/** Rewards granted on quest completion */
export interface QuestRewards {
  /** Quest points awarded */
  readonly questPoints: number;
  /** Items given on completion */
  readonly items: Array<{ readonly itemId: string; readonly quantity: number }>;
  /** XP awarded per skill: { "attack": 500, "strength": 500 } */
  readonly xp: Record<string, number>;
}

/** Full quest definition from manifest */
export interface QuestDefinition {
  /** Unique quest identifier */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** Short description for quest list */
  readonly description: string;
  /** Difficulty rating */
  readonly difficulty: QuestDifficulty;
  /** Quest points awarded on completion */
  readonly questPoints: number;
  /** Whether quest can be done again (typically false) */
  readonly replayable: boolean;
  /** Requirements to start the quest */
  readonly requirements: QuestRequirements;
  /** NPC ID that starts this quest */
  readonly startNpc: string;
  /** Ordered list of quest stages */
  readonly stages: QuestStage[];
  /** Items/effects on quest start */
  readonly onStart?: QuestOnStart;
  /** Rewards on completion */
  readonly rewards: QuestRewards;
}

// === Player Progress Types ===

/** Progress data for a stage (e.g., kill count) */
export interface StageProgress {
  [key: string]: number;
}

/** Player's progress on a specific quest (mutable for system use) */
export interface QuestProgress {
  /** Player/character ID */
  playerId: string;
  /** Quest identifier */
  questId: string;
  /** Current status */
  status: QuestStatus;
  /** Current stage ID */
  currentStage: string;
  /** Progress within current stage */
  stageProgress: StageProgress;
  /** When quest was started (Unix ms) */
  startedAt?: number;
  /** When quest was completed (Unix ms) */
  completedAt?: number;
}

/** Complete quest state for a player (mutable for system use) */
export interface PlayerQuestState {
  /** Player/character ID */
  playerId: string;
  /** Total quest points earned */
  questPoints: number;
  /** Active quests mapped by quest ID */
  activeQuests: Map<string, QuestProgress>;
  /** Set of completed quest IDs */
  completedQuests: Set<string>;
}

// === Manifest Types ===

/** Quest manifest structure (quests.json) */
export interface QuestManifest {
  [questId: string]: QuestDefinition;
}

// === Dialogue Integration Types ===

/** Quest-based dialogue overrides for NPCs */
export interface QuestDialogueOverrides {
  /** Entry node when quest is in progress but objective incomplete */
  readonly in_progress?: string;
  /** Entry node when quest is in progress AND objective complete */
  readonly ready_to_complete?: string;
  /** Entry node after quest is completed */
  readonly completed?: string;
}

/** NPC dialogue with quest overrides */
export interface QuestAwareDialogue {
  /** Default entry node */
  readonly entryNodeId: string;
  /** Quest-specific entry node overrides */
  readonly questOverrides?: Record<string, QuestDialogueOverrides>;
  /** Dialogue nodes */
  readonly nodes: unknown[]; // Full type defined in dialogue-types.ts
}

// === Type Guards ===

/**
 * Validates a quest ID string
 */
export function isValidQuestId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_QUEST_ID_LENGTH &&
    QUEST_ID_PATTERN.test(id)
  );
}

/**
 * Validates a quest status value
 */
export function isValidQuestStatus(status: unknown): status is QuestStatus {
  return (
    status === "not_started" ||
    status === "in_progress" ||
    status === "ready_to_complete" ||
    status === "completed"
  );
}

/**
 * Validates a quest difficulty value
 */
export function isValidQuestDifficulty(
  difficulty: unknown,
): difficulty is QuestDifficulty {
  return (
    difficulty === "novice" ||
    difficulty === "intermediate" ||
    difficulty === "experienced" ||
    difficulty === "master" ||
    difficulty === "grandmaster"
  );
}

/**
 * Validates a quest stage type value
 */
export function isValidQuestStageType(type: unknown): type is QuestStageType {
  return (
    type === "dialogue" ||
    type === "kill" ||
    type === "gather" ||
    type === "travel" ||
    type === "interact"
  );
}

/** Result of quest definition validation */
export interface QuestValidationResult {
  valid: boolean;
  errors: string[];
}

const QUEST_REWARD_SKILL_IDS = new Set([
  "attack",
  "strength",
  "defense",
  "constitution",
  "ranged",
  "magic",
  "prayer",
  "woodcutting",
  "mining",
  "fishing",
  "firemaking",
  "cooking",
  "smithing",
  "agility",
  "crafting",
  "fletching",
  "runecrafting",
]);

function validateQuestRewardItems(
  questId: string,
  field: string,
  value: unknown,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${questId}: '${field}' must be an array`);
    return;
  }
  if (value.length > 28) {
    errors.push(`${questId}: '${field}' exceeds 28 distinct reward entries`);
    return;
  }
  const itemIds = new Set<string>();
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${questId}: '${field}[${index}]' must be an object`);
      return;
    }
    const reward = raw as Record<string, unknown>;
    const itemId = String(reward.itemId ?? "").trim();
    const quantity = Number(reward.quantity);
    if (
      !itemId ||
      itemId !== reward.itemId ||
      itemId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(itemId)
    ) {
      errors.push(`${questId}: '${field}[${index}].itemId' is invalid`);
    } else if (itemIds.has(itemId)) {
      errors.push(`${questId}: '${field}' repeats item '${itemId}'`);
    } else {
      itemIds.add(itemId);
    }
    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > 2_147_483_647
    ) {
      errors.push(`${questId}: '${field}[${index}].quantity' is invalid`);
    }
  });
}

/**
 * Validates a quest definition from manifest
 * Checks required fields, stage uniqueness, and type validity
 */
export function validateQuestDefinition(
  questId: string,
  definition: unknown,
): QuestValidationResult {
  const errors: string[] = [];

  if (!definition || typeof definition !== "object") {
    return {
      valid: false,
      errors: [`${questId}: Definition must be an object`],
    };
  }

  const def = definition as Record<string, unknown>;

  // Required string fields
  if (!def.id || typeof def.id !== "string") {
    errors.push(`${questId}: Missing or invalid 'id' field`);
  } else if (def.id !== questId) {
    errors.push(`${questId}: 'id' field doesn't match key (got '${def.id}')`);
  }

  if (!def.name || typeof def.name !== "string") {
    errors.push(`${questId}: Missing or invalid 'name' field`);
  }

  if (!def.description || typeof def.description !== "string") {
    errors.push(`${questId}: Missing or invalid 'description' field`);
  }

  if (!def.startNpc || typeof def.startNpc !== "string") {
    errors.push(`${questId}: Missing or invalid 'startNpc' field`);
  }

  // Difficulty validation
  if (!isValidQuestDifficulty(def.difficulty)) {
    errors.push(`${questId}: Invalid 'difficulty' value: ${def.difficulty}`);
  }

  // Quest points validation
  if (
    !Number.isSafeInteger(def.questPoints) ||
    Number(def.questPoints) < 0 ||
    Number(def.questPoints) > 1_000_000
  ) {
    errors.push(`${questId}: Invalid 'questPoints' value`);
  }

  // Stages validation
  if (!Array.isArray(def.stages) || def.stages.length === 0) {
    errors.push(`${questId}: 'stages' must be a non-empty array`);
  } else {
    const stageIds = new Set<string>();

    for (let i = 0; i < def.stages.length; i++) {
      const stage = def.stages[i] as Record<string, unknown>;

      if (!stage.id || typeof stage.id !== "string") {
        errors.push(`${questId}: Stage ${i} missing 'id' field`);
        continue;
      }

      if (stageIds.has(stage.id)) {
        errors.push(`${questId}: Duplicate stage ID '${stage.id}'`);
      }
      stageIds.add(stage.id);

      if (!isValidQuestStageType(stage.type)) {
        errors.push(
          `${questId}: Stage '${stage.id}' has invalid type: ${stage.type}`,
        );
      }

      if (!stage.description || typeof stage.description !== "string") {
        errors.push(`${questId}: Stage '${stage.id}' missing description`);
      }

      // Type-specific validation
      if (stage.type === "kill" || stage.type === "gather") {
        if (!stage.target || typeof stage.target !== "string") {
          errors.push(
            `${questId}: Stage '${stage.id}' (${stage.type}) missing 'target'`,
          );
        }
        if (typeof stage.count !== "number" || stage.count <= 0) {
          errors.push(
            `${questId}: Stage '${stage.id}' (${stage.type}) missing or invalid 'count'`,
          );
        }
      }
    }
  }

  // Requirements validation
  if (!def.requirements || typeof def.requirements !== "object") {
    errors.push(`${questId}: Missing 'requirements' object`);
  } else {
    const reqs = def.requirements as Record<string, unknown>;
    if (!Array.isArray(reqs.quests)) {
      errors.push(`${questId}: 'requirements.quests' must be an array`);
    }
    if (typeof reqs.skills !== "object" || reqs.skills === null) {
      errors.push(`${questId}: 'requirements.skills' must be an object`);
    }
    if (!Array.isArray(reqs.items)) {
      errors.push(`${questId}: 'requirements.items' must be an array`);
    }
  }

  // Rewards validation
  if (!def.rewards || typeof def.rewards !== "object") {
    errors.push(`${questId}: Missing 'rewards' object`);
  } else {
    const rewards = def.rewards as Record<string, unknown>;
    if (
      !Number.isSafeInteger(rewards.questPoints) ||
      Number(rewards.questPoints) < 0 ||
      Number(rewards.questPoints) > 1_000_000
    ) {
      errors.push(`${questId}: 'rewards.questPoints' must be a safe integer`);
    } else if (rewards.questPoints !== def.questPoints) {
      errors.push(
        `${questId}: 'rewards.questPoints' must match top-level 'questPoints'`,
      );
    }
    validateQuestRewardItems(questId, "rewards.items", rewards.items, errors);
    if (
      !rewards.xp ||
      typeof rewards.xp !== "object" ||
      Array.isArray(rewards.xp)
    ) {
      errors.push(`${questId}: 'rewards.xp' must be an object`);
    } else {
      for (const [skill, rawAmount] of Object.entries(
        rewards.xp as Record<string, unknown>,
      )) {
        const amount = Number(rawAmount);
        if (!QUEST_REWARD_SKILL_IDS.has(skill)) {
          errors.push(`${questId}: 'rewards.xp.${skill}' is not a skill`);
        }
        if (
          !Number.isSafeInteger(amount) ||
          amount <= 0 ||
          amount > 1_000_000
        ) {
          errors.push(`${questId}: 'rewards.xp.${skill}' is invalid`);
        }
      }
    }
  }

  if (def.onStart !== undefined) {
    if (!def.onStart || typeof def.onStart !== "object") {
      errors.push(`${questId}: 'onStart' must be an object`);
    } else {
      const onStart = def.onStart as Record<string, unknown>;
      if (onStart.items !== undefined) {
        validateQuestRewardItems(
          questId,
          "onStart.items",
          onStart.items,
          errors,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
