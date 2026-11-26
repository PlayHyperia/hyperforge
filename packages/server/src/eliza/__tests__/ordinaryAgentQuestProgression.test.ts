import { describe, expect, it } from "vitest";

import type { AgentQuestInfo } from "../types";
import {
  findOrdinaryQuestEntrySkillTarget,
  getOrdinaryAgentQuestPriority,
  getProcessingActivitySkill,
} from "../ordinaryAgentQuestProgression";

function quest(
  questId: string,
  input: Partial<AgentQuestInfo> & {
    canStart: boolean;
    skills?: Record<string, number>;
  },
): AgentQuestInfo {
  return {
    questId,
    name: input.name ?? questId,
    description: input.description ?? questId,
    difficulty: input.difficulty ?? "novice",
    status: input.status ?? "not_started",
    canStart: input.canStart,
    requirements: input.requirements ?? {
      quests: [],
      skills: input.skills ?? {},
      items: [],
    },
    startNpc: input.startNpc ?? "guide",
    onStartItems: input.onStartItems ?? [],
    rewardItems: input.rewardItems ?? [],
    stages: input.stages ?? [],
  };
}

describe("ordinary quest-entry skill progression", () => {
  it("retains the existing authored quest order and omits resource quests when unavailable", () => {
    expect(getOrdinaryAgentQuestPriority(false)).toEqual(["goblin_slayer"]);
    expect(getOrdinaryAgentQuestPriority(true)).toEqual([
      "goblin_slayer",
      "lumberjacks_first_lesson",
      "fresh_catch",
      "rune_mysteries",
      "torvins_tools",
      "crafting_basics",
      "fletchers_introduction",
    ]);
  });

  it("always leaves a startable priority quest ahead of skill training", () => {
    expect(
      findOrdinaryQuestEntrySkillTarget({
        availableQuests: [
          quest("fresh_catch", { canStart: true }),
          quest("crafting_basics", {
            canStart: false,
            skills: { crafting: 7 },
          }),
        ],
        skills: { crafting: { level: 1 } },
        resourceSystemAvailable: true,
      }),
    ).toBeNull();
  });

  it("selects the first skill-only lock from the existing quest order", () => {
    expect(
      findOrdinaryQuestEntrySkillTarget({
        availableQuests: [
          quest("fletchers_introduction", {
            canStart: false,
            name: "Fletcher's Introduction",
            skills: { fletching: 5 },
          }),
          quest("crafting_basics", {
            canStart: false,
            name: "Crafting Basics",
            skills: { crafting: 7 },
          }),
        ],
        skills: {
          crafting: { level: 3 },
          fletching: { level: 1 },
        },
        resourceSystemAvailable: true,
      }),
    ).toEqual({
      questId: "crafting_basics",
      questName: "Crafting Basics",
      skill: "crafting",
      currentLevel: 3,
      targetLevel: 7,
    });
  });

  it("fails closed for item, prerequisite, malformed, and unexplained locks", () => {
    const unavailable = [
      quest("crafting_basics", {
        canStart: false,
        requirements: {
          quests: ["earlier_quest"],
          skills: { crafting: 7 },
          items: [],
        },
      }),
      quest("fletchers_introduction", {
        canStart: false,
        requirements: {
          quests: [],
          skills: { fletching: 5 },
          items: ["knife"],
        },
      }),
    ];
    expect(
      findOrdinaryQuestEntrySkillTarget({
        availableQuests: unavailable,
        skills: {
          crafting: { level: 1 },
          fletching: { level: 1 },
        },
        resourceSystemAvailable: true,
      }),
    ).toBeNull();

    expect(
      findOrdinaryQuestEntrySkillTarget({
        availableQuests: [
          quest("crafting_basics", {
            canStart: false,
            skills: { crafting: 100 },
          }),
        ],
        skills: { crafting: { level: 1 } },
        resourceSystemAvailable: true,
      }),
    ).toBeNull();
  });

  it("normalizes defense spelling and maps processing activities to their trained skill", () => {
    expect(
      findOrdinaryQuestEntrySkillTarget({
        availableQuests: [
          quest("crafting_basics", {
            canStart: false,
            skills: { defence: 7 },
          }),
        ],
        skills: { defense: { level: 4 } },
        resourceSystemAvailable: true,
      }),
    ).toEqual(
      expect.objectContaining({
        skill: "defense",
        currentLevel: 4,
        targetLevel: 7,
      }),
    );
    expect(getProcessingActivitySkill("smelting")).toBe("smithing");
    expect(getProcessingActivitySkill("fletching")).toBe("fletching");
    expect(getProcessingActivitySkill("tanning")).toBeNull();
  });
});
