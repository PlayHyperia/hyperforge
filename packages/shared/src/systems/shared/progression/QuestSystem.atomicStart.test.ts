import { describe, expect, it, vi } from "vitest";

import type {
  PlayerQuestState,
  QuestDefinition,
} from "../../../types/game/quest-types";
import { EventType } from "../../../types/events";
import { EventBus } from "../infrastructure/EventBus";
import { QuestSystem } from "./QuestSystem";

const PLAYER_ID = "quest-start-player";
const QUEST_ID = "starter_quest";
const STARTED_AT = 1_788_140_800_000;
const DEFINITION: QuestDefinition = {
  id: QUEST_ID,
  name: "Starter Quest",
  description: "Exercise durable quest acceptance.",
  difficulty: "novice",
  questPoints: 1,
  replayable: false,
  requirements: { quests: [], skills: {}, items: [] },
  startNpc: "mentor",
  stages: [
    { id: "talk_to_mentor", type: "dialogue", description: "Talk." },
    { id: "gather_supplies", type: "gather", description: "Gather." },
  ],
  onStart: { items: [{ itemId: "bronze_shortsword", quantity: 1 }] },
  rewards: { questPoints: 1, items: [], xp: {} },
};
const NO_STARTER_DEFINITION: QuestDefinition = {
  ...DEFINITION,
  id: "no_starter_quest",
  name: "No Starter Quest",
  onStart: undefined,
};

type StartInput = {
  questStartedAt: number;
  initialStage: string;
  items: Array<{ itemId: string; quantity: number }>;
};
type StartResult =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      receipt: {
        operationId: string;
        replayed: boolean;
        playerId: string;
        questId: string;
        questStartedAt: number;
        initialStage: string;
      };
    }
  | {
      ok: false;
      committed: false | "unknown";
      reason: string;
      retryable: boolean;
    };

function successReceipt(
  questId: string,
  input: StartInput,
  replayed = false,
): StartResult {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    receipt: {
      operationId: `quest-start:${"a".repeat(64)}`,
      replayed,
      playerId: PLAYER_ID,
      questId,
      questStartedAt: input.questStartedAt,
      initialStage: input.initialStage,
    },
  };
}

async function createFixture(
  commit: (
    playerId: string,
    questId: string,
    input: StartInput,
  ) => Promise<StartResult>,
  options?: {
    activeDefinition?: QuestDefinition;
    abandon?: () => Promise<void>;
  },
) {
  const eventBus = new EventBus();
  const commitAtomic = vi.fn(commit);
  const abandon = vi.fn(options?.abandon ?? (async () => {}));
  const world = {
    isServer: true,
    $eventBus: eventBus,
    entities: new Map(),
    getSkillLevel: () => 99,
    hasItem: () => true,
    getSystem: (name: string) => {
      if (name === "inventory") {
        return { commitQuestStartAtomic: commitAtomic };
      }
      if (name === "database") {
        return { getQuestRepository: () => ({ abandonQuest: abandon }) };
      }
      return undefined;
    },
  };
  const questSystem = new QuestSystem(world as never);
  await questSystem.init();
  const definitions = new Map<string, QuestDefinition>([
    [QUEST_ID, DEFINITION],
    [NO_STARTER_DEFINITION.id, NO_STARTER_DEFINITION],
  ]);
  (
    questSystem as unknown as {
      questDefinitions: Map<string, QuestDefinition>;
      playerStates: Map<string, PlayerQuestState>;
    }
  ).questDefinitions = definitions;
  const activeDefinition = options?.activeDefinition;
  (
    questSystem as unknown as {
      playerStates: Map<string, PlayerQuestState>;
    }
  ).playerStates.set(PLAYER_ID, {
    playerId: PLAYER_ID,
    questPoints: 0,
    activeQuests: new Map(
      activeDefinition
        ? [
            [
              activeDefinition.id,
              {
                playerId: PLAYER_ID,
                questId: activeDefinition.id,
                status: "in_progress" as const,
                currentStage: "gather_supplies",
                stageProgress: {},
                startedAt: STARTED_AT,
              },
            ],
          ]
        : [],
    ),
    completedQuests: new Set(),
  });
  return { questSystem, eventBus, commitAtomic, abandon };
}

describe("QuestSystem atomic start", () => {
  it("keeps quest state and presentation unchanged until starter custody commits", async () => {
    let release: ((value: StartResult) => void) | undefined;
    const fixture = await createFixture(
      (_playerId, _questId, input) =>
        new Promise<StartResult>((resolve) => {
          release = (value) => resolve(value);
          expect(input.items).toEqual([
            { itemId: "bronze_shortsword", quantity: 1 },
          ]);
        }),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(STARTED_AT);

    const pending = fixture.questSystem.startQuest(PLAYER_ID, QUEST_ID);
    await vi.waitFor(() => expect(fixture.commitAtomic).toHaveBeenCalledOnce());
    expect(fixture.questSystem.getQuestStatus(PLAYER_ID, QUEST_ID)).toBe(
      "not_started",
    );
    expect(fixture.eventBus.getEventHistory()).toEqual([]);
    const input = fixture.commitAtomic.mock.calls[0][2];
    release?.(successReceipt(QUEST_ID, input));

    await expect(pending).resolves.toBe(true);
    expect(fixture.questSystem.getQuestStatus(PLAYER_ID, QUEST_ID)).toBe(
      "in_progress",
    );
    expect(
      fixture.eventBus.getEventHistory(EventType.QUEST_STARTED),
    ).toHaveLength(1);
    expect(
      fixture.eventBus.getEventHistory(EventType.INVENTORY_ITEM_ADDED),
    ).toEqual([]);
    now.mockRestore();
    fixture.questSystem.destroy();
  });

  it("retains an uncertain incarnation identity and replays it on retry", async () => {
    let calls = 0;
    const fixture = await createFixture(async (_playerId, questId, input) => {
      calls++;
      return calls === 1
        ? {
            ok: false,
            committed: "unknown",
            reason: "persistence_ambiguous",
            retryable: true,
          }
        : successReceipt(questId, input, true);
    });
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(STARTED_AT)
      .mockReturnValue(STARTED_AT + 1_000);

    await expect(
      fixture.questSystem.startQuest(PLAYER_ID, QUEST_ID),
    ).resolves.toBe(false);
    await expect(
      fixture.questSystem.startQuest(PLAYER_ID, QUEST_ID),
    ).resolves.toBe(true);
    expect(fixture.commitAtomic).toHaveBeenCalledTimes(2);
    expect(fixture.commitAtomic.mock.calls[0][2]).toEqual(
      fixture.commitAtomic.mock.calls[1][2],
    );
    expect(
      fixture.eventBus.getEventHistory(EventType.QUEST_STARTED),
    ).toHaveLength(1);
    now.mockRestore();
    fixture.questSystem.destroy();
  });

  it("coalesces simultaneous acceptances into one commit and one start event", async () => {
    const fixture = await createFixture(async (_playerId, questId, input) =>
      successReceipt(questId, input),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(STARTED_AT);

    await expect(
      Promise.all([
        fixture.questSystem.startQuest(PLAYER_ID, QUEST_ID),
        fixture.questSystem.startQuest(PLAYER_ID, QUEST_ID),
      ]),
    ).resolves.toEqual([true, true]);
    expect(fixture.commitAtomic).toHaveBeenCalledOnce();
    expect(
      fixture.eventBus.getEventHistory(EventType.QUEST_STARTED),
    ).toHaveLength(1);
    now.mockRestore();
    fixture.questSystem.destroy();
  });

  it("rejects abandonment when starter custody was issued", async () => {
    const fixture = await createFixture(
      async (_playerId, questId, input) => successReceipt(questId, input),
      { activeDefinition: DEFINITION },
    );
    await expect(
      fixture.questSystem.abandonQuest(PLAYER_ID, QUEST_ID),
    ).resolves.toBe(false);
    expect(fixture.abandon).not.toHaveBeenCalled();
    expect(fixture.questSystem.getQuestStatus(PLAYER_ID, QUEST_ID)).toBe(
      "in_progress",
    );
    expect(fixture.eventBus.getEventHistory(EventType.QUEST_ABANDONED)).toEqual(
      [],
    );
    fixture.questSystem.destroy();
  });

  it("changes live state only after durable abandonment for a no-starter quest", async () => {
    let release: (() => void) | undefined;
    const fixture = await createFixture(
      async (_playerId, questId, input) => successReceipt(questId, input),
      {
        activeDefinition: NO_STARTER_DEFINITION,
        abandon: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
    );

    const pending = fixture.questSystem.abandonQuest(
      PLAYER_ID,
      NO_STARTER_DEFINITION.id,
    );
    await vi.waitFor(() => expect(fixture.abandon).toHaveBeenCalledOnce());
    expect(
      fixture.questSystem.getQuestStatus(PLAYER_ID, NO_STARTER_DEFINITION.id),
    ).toBe("in_progress");
    expect(fixture.abandon).toHaveBeenCalledWith(
      PLAYER_ID,
      NO_STARTER_DEFINITION.id,
      STARTED_AT,
    );
    release?.();

    await expect(pending).resolves.toBe(true);
    expect(
      fixture.questSystem.getQuestStatus(PLAYER_ID, NO_STARTER_DEFINITION.id),
    ).toBe("not_started");
    expect(
      fixture.eventBus.getEventHistory(EventType.QUEST_ABANDONED),
    ).toHaveLength(1);
    fixture.questSystem.destroy();
  });
});
