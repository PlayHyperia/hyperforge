import { describe, expect, it } from "vitest";

import type { World } from "../../../types/index";
import type {
  QuestDbStatus,
  QuestDefinition,
  QuestProgress,
  QuestStatus,
} from "../../../types/game/quest-types";
import { QuestSystem } from "./QuestSystem";

function questDefinition(): QuestDefinition {
  return {
    id: "forging_trial",
    name: "Forging Trial",
    description: "Forge an item and report back.",
    difficulty: "novice",
    questPoints: 1,
    replayable: false,
    requirements: { quests: [], skills: {}, items: [] },
    startNpc: "smith",
    stages: [
      {
        id: "start",
        type: "dialogue",
        description: "Speak to the smith.",
        npcId: "smith",
      },
      {
        id: "forge",
        type: "interact",
        description: "Forge one item.",
        target: "forged_item",
        count: 1,
      },
      {
        id: "return",
        type: "dialogue",
        description: "Return to the smith.",
        npcId: "smith",
      },
    ],
    rewards: { questPoints: 1, items: [], xp: {} },
  };
}

type QuestSystemInternals = {
  questDefinitions: Map<string, QuestDefinition>;
  advanceToNextStage: (
    playerId: string,
    questId: string,
    progress: QuestProgress,
    definition: QuestDefinition,
    emitMessages: boolean,
  ) => void;
  computeQuestStatus: (
    questId: string,
    row: {
      status: QuestDbStatus;
      currentStage: string | null;
      stageProgress: Record<string, number>;
    },
  ) => QuestStatus;
};

function createFixture() {
  const world = { $eventBus: undefined } as unknown as World;
  const system = new QuestSystem(world);
  const definition = questDefinition();
  const internals = system as unknown as QuestSystemInternals;
  internals.questDefinitions.set(definition.id, definition);
  return { definition, internals };
}

describe("QuestSystem terminal return stage", () => {
  it("preserves the authored return stage when the final objective completes", () => {
    const { definition, internals } = createFixture();
    const progress: QuestProgress = {
      playerId: "player-1",
      questId: definition.id,
      status: "in_progress",
      currentStage: "forge",
      stageProgress: { forged_item: 1 },
      startedAt: 1,
    };

    internals.advanceToNextStage(
      progress.playerId,
      progress.questId,
      progress,
      definition,
      false,
    );

    expect(progress.status).toBe("ready_to_complete");
    expect(progress.currentStage).toBe("return");
  });

  it("re-derives ready-to-complete from a persisted terminal dialogue", () => {
    const { definition, internals } = createFixture();

    expect(
      internals.computeQuestStatus(definition.id, {
        status: "in_progress",
        currentStage: "return",
        stageProgress: { forged_item: 1 },
      }),
    ).toBe("ready_to_complete");
  });
});
