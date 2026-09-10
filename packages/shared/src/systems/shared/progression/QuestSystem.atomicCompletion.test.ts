import { describe, expect, it, vi } from "vitest";

import type { QuestCompletionCommitReceipt } from "../../../types/network/database";
import type {
  PlayerQuestState,
  QuestDefinition,
} from "../../../types/game/quest-types";
import { EventType } from "../../../types/events";
import { EventBus } from "../infrastructure/EventBus";
import { QuestSystem } from "./QuestSystem";

const PLAYER_ID = "quest-completion-player";
const QUEST_ID = "receipt_quest";
const STARTED_AT = 1_788_137_200_000;
const DEFINITION: QuestDefinition = {
  id: QUEST_ID,
  name: "Receipt Quest",
  description: "Exercise the durable completion boundary.",
  difficulty: "novice",
  questPoints: 1,
  replayable: false,
  requirements: { quests: [], skills: {}, items: [] },
  startNpc: "mentor",
  stages: [
    {
      id: "return_to_mentor",
      type: "dialogue",
      description: "Return to the mentor.",
    },
  ],
  rewards: {
    questPoints: 1,
    items: [{ itemId: "xp_lamp_100", quantity: 1 }],
    xp: { attack: 500 },
  },
};

type CompletionResult =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      receipt: QuestCompletionCommitReceipt;
    }
  | {
      ok: false;
      committed: false | "unknown";
      reason: string;
      retryable: boolean;
    };

function durableReceipt(replayed = false): QuestCompletionCommitReceipt {
  return {
    operationId: `quest-completion:${"a".repeat(64)}`,
    playerId: PLAYER_ID,
    requestFingerprint: "b".repeat(64),
    replayed,
    questId: QUEST_ID,
    questStartedAt: STARTED_AT,
    expectedStage: "return_to_mentor",
    expectedProgress: { spoken: 1 },
    completedAt: STARTED_AT + 5_000,
    questPoints: 1,
    operationCommittedQuestPoints: 1,
    currentQuestPoints: 3,
    items: [{ itemId: "xp_lamp_100", quantity: 1, stackable: false }],
    xp: [{ skill: "attack", xpAmount: 500 }],
    progress: [
      {
        skill: "attack",
        xpAmount: 500,
        awardedXp: 500,
        operationCommittedXp: 500,
        currentXp: 500,
        currentLevel: 5,
      },
    ],
    prayer: null,
    committed: [
      {
        itemId: "xp_lamp_100",
        quantity: 1,
        slotIndex: 0,
        metadata: null,
      },
    ],
  };
}

async function createFixture(
  complete: () => Promise<CompletionResult>,
): Promise<{
  questSystem: QuestSystem;
  eventBus: EventBus;
  completeAtomic: ReturnType<typeof vi.fn<() => Promise<CompletionResult>>>;
}> {
  const eventBus = new EventBus();
  const completeAtomic = vi.fn(complete);
  const world = {
    isServer: true,
    $eventBus: eventBus,
    entities: new Map(),
    getSystem: (name: string) =>
      name === "inventory"
        ? { commitQuestCompletionAtomic: completeAtomic }
        : undefined,
  };
  const questSystem = new QuestSystem(world as never);
  await questSystem.init();
  (
    questSystem as unknown as {
      questDefinitions: Map<string, QuestDefinition>;
      playerStates: Map<string, PlayerQuestState>;
    }
  ).questDefinitions = new Map([[QUEST_ID, DEFINITION]]);
  (
    questSystem as unknown as {
      playerStates: Map<string, PlayerQuestState>;
    }
  ).playerStates.set(PLAYER_ID, {
    playerId: PLAYER_ID,
    questPoints: 0,
    activeQuests: new Map([
      [
        QUEST_ID,
        {
          playerId: PLAYER_ID,
          questId: QUEST_ID,
          status: "ready_to_complete",
          currentStage: "return_to_mentor",
          stageProgress: { spoken: 1 },
          startedAt: STARTED_AT,
        },
      ],
    ]),
    completedQuests: new Set(),
  });
  return { questSystem, eventBus, completeAtomic };
}

describe("QuestSystem atomic completion", () => {
  it("keeps live quest state unchanged until the durable receipt returns", async () => {
    let release: ((value: CompletionResult) => void) | undefined;
    const fixture = await createFixture(
      () =>
        new Promise<CompletionResult>((resolve) => {
          release = resolve;
        }),
    );

    const pending = fixture.questSystem.completeQuest(PLAYER_ID, QUEST_ID);
    await vi.waitFor(() =>
      expect(fixture.completeAtomic).toHaveBeenCalledOnce(),
    );
    expect(fixture.questSystem.getQuestStatus(PLAYER_ID, QUEST_ID)).toBe(
      "ready_to_complete",
    );
    expect(fixture.questSystem.getQuestPoints(PLAYER_ID)).toBe(0);
    expect(fixture.eventBus.getEventHistory()).toEqual([]);

    release?.({
      ok: true,
      committed: true,
      liveInventoryApplied: true,
      receipt: durableReceipt(),
    });
    await expect(pending).resolves.toBe(true);
    expect(fixture.questSystem.getQuestStatus(PLAYER_ID, QUEST_ID)).toBe(
      "completed",
    );
    expect(fixture.questSystem.getQuestPoints(PLAYER_ID)).toBe(3);

    const committed = fixture.eventBus.getEventHistory(
      EventType.QUEST_COMPLETION_COMMITTED,
    );
    expect(committed).toHaveLength(1);
    expect(committed[0].data).toMatchObject({
      playerId: PLAYER_ID,
      questId: QUEST_ID,
      replayed: false,
      progress: [{ skill: "attack", currentXp: 500 }],
    });
    const completed = fixture.eventBus.getEventHistory(
      EventType.QUEST_COMPLETED,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0].data).toMatchObject({ progressionCommitted: true });
    expect(
      fixture.eventBus.getEventHistory(EventType.INVENTORY_ITEM_ADDED),
    ).toEqual([]);
    fixture.questSystem.destroy();
  });

  it("leaves the quest ready and emits no completion when commit rejects", async () => {
    const fixture = await createFixture(async () => ({
      ok: false,
      committed: false,
      reason: "inventory_full",
      retryable: false,
    }));
    await expect(
      fixture.questSystem.completeQuest(PLAYER_ID, QUEST_ID),
    ).resolves.toBe(false);
    expect(fixture.questSystem.getQuestStatus(PLAYER_ID, QUEST_ID)).toBe(
      "ready_to_complete",
    );
    expect(fixture.questSystem.getQuestPoints(PLAYER_ID)).toBe(0);
    expect(fixture.eventBus.getEventHistory(EventType.QUEST_COMPLETED)).toEqual(
      [],
    );
    fixture.questSystem.destroy();
  });

  it("accepts a replay receipt once without emitting legacy reward mutations", async () => {
    const fixture = await createFixture(async () => ({
      ok: true,
      committed: true,
      liveInventoryApplied: true,
      receipt: durableReceipt(true),
    }));
    await expect(
      fixture.questSystem.completeQuest(PLAYER_ID, QUEST_ID),
    ).resolves.toBe(true);
    expect(
      fixture.eventBus.getEventHistory(EventType.QUEST_COMPLETION_COMMITTED)[0]
        .data,
    ).toMatchObject({ replayed: true });
    expect(
      fixture.eventBus.getEventHistory(EventType.INVENTORY_ITEM_ADDED),
    ).toEqual([]);
    fixture.questSystem.destroy();
  });
});
