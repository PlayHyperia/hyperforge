import { isStartableAgentQuest, type AgentQuestInfo } from "./types.js";

/** Existing scripted quest order, shared by selection and entry-skill training. */
const BASE_QUEST_PRIORITY = ["goblin_slayer"] as const;
const RESOURCE_QUEST_PRIORITY = [
  "lumberjacks_first_lesson",
  "fresh_catch",
  "rune_mysteries",
  "torvins_tools",
  "crafting_basics",
  "fletchers_introduction",
] as const;

export interface OrdinaryQuestEntrySkillTarget {
  questId: string;
  questName: string;
  skill: string;
  currentLevel: number;
  targetLevel: number;
}

type PublicSkillSnapshot = Record<string, { level?: unknown } | undefined>;

export function getOrdinaryAgentQuestPriority(
  resourceSystemAvailable: boolean,
): string[] {
  return [
    ...BASE_QUEST_PRIORITY,
    ...(resourceSystemAvailable ? RESOURCE_QUEST_PRIORITY : []),
  ];
}

function normalizeSkillId(skill: string): string {
  return skill === "defence" ? "defense" : skill;
}

function readPublicSkillLevel(
  skills: PublicSkillSnapshot,
  skill: string,
): number {
  const level = Number(skills[normalizeSkillId(skill)]?.level ?? 1);
  return Number.isSafeInteger(level) && level >= 1 && level <= 99 ? level : 0;
}

/**
 * Resolve one deterministic entry-skill target from the existing quest order.
 * Startable quests always take precedence. Training is offered only when the
 * authored lock is skill-only; unknown, item-gated, and prerequisite-gated
 * states fail closed instead of being guessed from private custody/history.
 */
export function findOrdinaryQuestEntrySkillTarget(input: {
  availableQuests: AgentQuestInfo[];
  skills: PublicSkillSnapshot;
  resourceSystemAvailable: boolean;
}): OrdinaryQuestEntrySkillTarget | null {
  const priority = getOrdinaryAgentQuestPriority(input.resourceSystemAvailable);
  const questById = new Map(
    input.availableQuests.map((quest) => [quest.questId, quest]),
  );

  if (
    priority.some((questId) => {
      const quest = questById.get(questId);
      return quest ? isStartableAgentQuest(quest) : false;
    })
  ) {
    return null;
  }

  for (const questId of priority) {
    const quest = questById.get(questId);
    if (
      !quest ||
      quest.status !== "not_started" ||
      quest.canStart ||
      quest.requirements.quests.length > 0 ||
      quest.requirements.items.length > 0
    ) {
      continue;
    }

    const requirements = Object.entries(quest.requirements.skills).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    if (requirements.length === 0) continue;

    let invalid = false;
    const unmet: OrdinaryQuestEntrySkillTarget[] = [];
    for (const [authoredSkill, requiredValue] of requirements) {
      const targetLevel = Number(requiredValue);
      const skill = normalizeSkillId(authoredSkill);
      const currentLevel = readPublicSkillLevel(input.skills, skill);
      if (
        !Number.isSafeInteger(targetLevel) ||
        targetLevel < 1 ||
        targetLevel > 99 ||
        currentLevel === 0
      ) {
        invalid = true;
        break;
      }
      if (currentLevel < targetLevel) {
        unmet.push({
          questId: quest.questId,
          questName: quest.name,
          skill,
          currentLevel,
          targetLevel,
        });
      }
    }
    if (!invalid && unmet.length > 0) return unmet[0];
  }

  return null;
}

export function getProcessingActivitySkill(
  activity:
    | "cooking"
    | "smelting"
    | "smithing"
    | "crafting"
    | "fletching"
    | "firemaking"
    | "runecrafting"
    | "tanning",
): string | null {
  if (activity === "smelting") return "smithing";
  if (activity === "tanning") return null;
  return activity;
}
