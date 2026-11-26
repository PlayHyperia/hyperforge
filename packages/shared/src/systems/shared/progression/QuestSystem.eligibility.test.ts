import { describe, expect, it, vi } from "vitest";

import type { World } from "../../../types/index";
import type {
  PlayerQuestState,
  QuestDefinition,
} from "../../../types/game/quest-types";
import { QuestSystem } from "./QuestSystem";

function questDefinition(): QuestDefinition {
  return {
    id: "qualified_crafter",
    name: "Qualified Crafter",
    description: "A quest with prerequisite, skill, and item requirements.",
    difficulty: "novice",
    questPoints: 1,
    replayable: false,
    requirements: {
      quests: ["training_complete"],
      skills: { crafting: 7 },
      items: ["needle"],
    },
    startNpc: "crafting_supplier",
    stages: [
      {
        id: "start",
        type: "dialogue",
        description: "Speak to the crafting supplier.",
        npcId: "crafting_supplier",
      },
    ],
    rewards: { questPoints: 1, items: [], xp: {} },
  };
}

function createFixture() {
  let craftingLevel = 7;
  let hasNeedle = true;
  const world = {
    $eventBus: undefined,
    getSkillLevel: vi.fn(() => craftingLevel),
    hasItem: vi.fn(() => hasNeedle),
  } as unknown as World;
  const system = new QuestSystem(world);
  const definition = questDefinition();
  const state: PlayerQuestState = {
    playerId: "player-1",
    questPoints: 0,
    activeQuests: new Map(),
    completedQuests: new Set(["training_complete"]),
  };
  const internals = system as unknown as {
    questDefinitions: Map<string, QuestDefinition>;
    playerStates: Map<string, PlayerQuestState>;
  };
  internals.questDefinitions.set(definition.id, definition);
  internals.playerStates.set(state.playerId, state);

  return {
    system,
    state,
    setCraftingLevel(level: number) {
      craftingLevel = level;
    },
    setHasNeedle(value: boolean) {
      hasNeedle = value;
    },
  };
}

describe("QuestSystem authoritative start eligibility", () => {
  it("fails closed for unknown players and quest definitions", () => {
    const { system } = createFixture();

    expect(system.canStartQuest("missing-player", "qualified_crafter")).toBe(
      false,
    );
    expect(system.canStartQuest("player-1", "missing-quest")).toBe(false);
  });

  it("requires every authored prerequisite, skill, and held item", () => {
    const fixture = createFixture();

    expect(fixture.system.canStartQuest("player-1", "qualified_crafter")).toBe(
      true,
    );

    fixture.setCraftingLevel(6);
    expect(fixture.system.canStartQuest("player-1", "qualified_crafter")).toBe(
      false,
    );

    fixture.setCraftingLevel(7);
    fixture.setHasNeedle(false);
    expect(fixture.system.canStartQuest("player-1", "qualified_crafter")).toBe(
      false,
    );

    fixture.setHasNeedle(true);
    fixture.state.completedQuests.delete("training_complete");
    expect(fixture.system.canStartQuest("player-1", "qualified_crafter")).toBe(
      false,
    );
  });

  it("rejects quests that are already active or completed", () => {
    const fixture = createFixture();
    fixture.state.activeQuests.set("qualified_crafter", {
      playerId: "player-1",
      questId: "qualified_crafter",
      status: "in_progress",
      currentStage: "start",
      stageProgress: {},
    });

    expect(fixture.system.canStartQuest("player-1", "qualified_crafter")).toBe(
      false,
    );

    fixture.state.activeQuests.clear();
    fixture.state.completedQuests.add("qualified_crafter");
    expect(fixture.system.canStartQuest("player-1", "qualified_crafter")).toBe(
      false,
    );
  });
});
