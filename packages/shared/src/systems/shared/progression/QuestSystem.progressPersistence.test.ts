import { afterEach, describe, expect, it, vi } from "vitest";

import { EventType } from "../../../types/events";
import type { PlayerQuestState } from "../../../types/game/quest-types";
import type { World } from "../../../types/index";
import { EventBus } from "../infrastructure/EventBus";
import { QuestSystem } from "./QuestSystem";

const PLAYER_ID = "player-quest-progress";
const QUEST_ID = "lumberjacks_first_lesson";
const QUEST_STARTED_AT = 1_786_388_400_000;

type GatheringReceipt = {
  operationId: string;
  playerId: string;
  questId: string;
  questStartedAt: number;
  capturedStage: string;
  rewardItemId: string;
  rewardQuantity: number;
  createdAt: number;
};

type ApplyResult = {
  status: "applied";
  currentStage: string;
  stageProgress: Record<string, number>;
};

type QuestRepositoryDouble = {
  getPendingGatheringProgressReceipts: ReturnType<typeof vi.fn>;
  applyGatheringProgressReceipt: ReturnType<typeof vi.fn>;
  retireGatheringProgressReceipt: ReturnType<typeof vi.fn>;
  ignoreGatheringProgressReceipt: ReturnType<typeof vi.fn>;
};

function receipt(operationId: string, quantity: number): GatheringReceipt {
  return {
    operationId,
    playerId: PLAYER_ID,
    questId: QUEST_ID,
    questStartedAt: QUEST_STARTED_AT,
    capturedStage: "chop_logs",
    rewardItemId: "logs",
    rewardQuantity: quantity,
    createdAt: QUEST_STARTED_AT + quantity,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function createFixture(repository: QuestRepositoryDouble) {
  const eventBus = new EventBus();
  const world = {
    isServer: true,
    $eventBus: eventBus,
    getSystem: vi.fn((name: string) =>
      name === "database"
        ? {
            getQuestRepository: () => repository,
          }
        : undefined,
    ),
  } as unknown as World;
  const system = new QuestSystem(world);
  await system.init();

  const state: PlayerQuestState = {
    playerId: PLAYER_ID,
    questPoints: 0,
    activeQuests: new Map([
      [
        QUEST_ID,
        {
          playerId: PLAYER_ID,
          questId: QUEST_ID,
          status: "in_progress",
          currentStage: "chop_logs",
          stageProgress: {},
          startedAt: QUEST_STARTED_AT,
        },
      ],
    ]),
    completedQuests: new Set(),
  };
  (
    system as unknown as {
      playerStates: Map<string, PlayerQuestState>;
    }
  ).playerStates.set(state.playerId, state);

  return { eventBus, repository, state, system };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QuestSystem source-authentic progress persistence", () => {
  it("ignores generic claims and resolves only a durable gathering receipt", async () => {
    const apply = deferred<ApplyResult>();
    const committedReceipt = receipt("gathering-reward:committed-1", 2);
    const fixture = await createFixture({
      getPendingGatheringProgressReceipts: vi
        .fn()
        .mockResolvedValue([committedReceipt]),
      applyGatheringProgressReceipt: vi.fn(() => apply.promise),
      retireGatheringProgressReceipt: vi.fn(),
      ignoreGatheringProgressReceipt: vi.fn(),
    });
    const progress = fixture.state.activeQuests.get(QUEST_ID)!;

    fixture.eventBus.emitEvent(EventType.INVENTORY_ITEM_ADDED, {
      playerId: PLAYER_ID,
      item: { itemId: "logs", quantity: 6, slot: 0 },
    });
    fixture.eventBus.emitEvent(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: PLAYER_ID,
      resourceId: "tree-unsigned",
      successful: true,
      skill: "woodcutting",
      rewardItemId: "logs",
      rewardQuantity: 6,
    });
    await flushPromises();
    expect(progress.stageProgress).toEqual({});
    expect(
      fixture.repository.getPendingGatheringProgressReceipts,
    ).not.toHaveBeenCalled();

    fixture.eventBus.emitEvent(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: PLAYER_ID,
      resourceId: "tree-authored",
      successful: true,
      skill: "woodcutting",
      operationId: committedReceipt.operationId,
      rewardItemId: "logs",
      rewardQuantity: 2,
    });
    expect(fixture.eventBus.getPendingHandlerCount()).toBe(1);
    expect(progress.stageProgress).toEqual({});

    await vi.waitFor(() =>
      expect(
        fixture.repository.applyGatheringProgressReceipt,
      ).toHaveBeenCalledTimes(1),
    );
    expect(
      fixture.repository.applyGatheringProgressReceipt.mock.calls[0][0],
    ).toMatchObject({
      ...committedReceipt,
      expectedCurrentStage: "chop_logs",
      resultingStage: "chop_logs",
      resultingProgress: { logs: 2 },
    });
    apply.resolve({
      status: "applied",
      currentStage: "chop_logs",
      stageProgress: { logs: 2 },
    });
    await fixture.eventBus.waitForPendingHandlers();
    expect(progress.stageProgress).toEqual({ logs: 2 });
    expect(fixture.eventBus.getPendingHandlerCount()).toBe(0);
    fixture.system.destroy();
  });

  it("drains overlapping durable receipts in immutable commit order", async () => {
    const receipts = [
      receipt("gathering-reward:first", 1),
      receipt("gathering-reward:second", 1),
    ];
    const applies = [deferred<ApplyResult>(), deferred<ApplyResult>()];
    const applyGatheringProgressReceipt = vi
      .fn()
      .mockImplementationOnce(() => applies[0].promise)
      .mockImplementationOnce(() => applies[1].promise);
    const fixture = await createFixture({
      getPendingGatheringProgressReceipts: vi.fn().mockResolvedValue(receipts),
      applyGatheringProgressReceipt,
      retireGatheringProgressReceipt: vi.fn(),
      ignoreGatheringProgressReceipt: vi.fn(),
    });

    fixture.eventBus.emitEvent(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: PLAYER_ID,
      resourceId: "tree-first",
      successful: true,
      skill: "woodcutting",
      operationId: receipts[0].operationId,
      rewardItemId: "logs",
      rewardQuantity: 1,
    });

    await vi.waitFor(() =>
      expect(applyGatheringProgressReceipt).toHaveBeenCalledTimes(1),
    );
    expect(
      applyGatheringProgressReceipt.mock.calls[0][0].resultingProgress,
    ).toEqual({ logs: 1 });

    applies[0].resolve({
      status: "applied",
      currentStage: "chop_logs",
      stageProgress: { logs: 1 },
    });
    await vi.waitFor(() =>
      expect(applyGatheringProgressReceipt).toHaveBeenCalledTimes(2),
    );
    expect(
      applyGatheringProgressReceipt.mock.calls[1][0].resultingProgress,
    ).toEqual({ logs: 2 });

    applies[1].resolve({
      status: "applied",
      currentStage: "chop_logs",
      stageProgress: { logs: 2 },
    });
    await fixture.eventBus.waitForPendingHandlers();
    expect(fixture.state.activeQuests.get(QUEST_ID)?.stageProgress).toEqual({
      logs: 2,
    });
    expect(fixture.eventBus.getPendingHandlerCount()).toBe(0);
    fixture.system.destroy();
  });

  it("retires a receipt only after its captured quest incarnation is gone", async () => {
    const oldReceipt = receipt("gathering-reward:abandoned", 1);
    const retireGatheringProgressReceipt = vi.fn().mockResolvedValue("retired");
    const fixture = await createFixture({
      getPendingGatheringProgressReceipts: vi
        .fn()
        .mockResolvedValue([oldReceipt]),
      applyGatheringProgressReceipt: vi.fn(),
      retireGatheringProgressReceipt,
      ignoreGatheringProgressReceipt: vi.fn(),
    });
    fixture.state.activeQuests.delete(QUEST_ID);

    fixture.eventBus.emitEvent(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: PLAYER_ID,
      resourceId: "tree-abandoned",
      successful: true,
      skill: "woodcutting",
      operationId: oldReceipt.operationId,
      rewardItemId: "logs",
      rewardQuantity: 1,
    });
    await fixture.eventBus.waitForPendingHandlers();

    expect(retireGatheringProgressReceipt).toHaveBeenCalledWith(oldReceipt);
    expect(
      fixture.repository.applyGatheringProgressReceipt,
    ).not.toHaveBeenCalled();
    fixture.system.destroy();
  });

  it("resolves a committed item that is irrelevant to the quest manifest without credit", async () => {
    const irrelevantReceipt = {
      ...receipt("gathering-reward:irrelevant", 1),
      rewardItemId: "raw_shrimp",
    };
    const ignoreGatheringProgressReceipt = vi.fn().mockResolvedValue("ignored");
    const fixture = await createFixture({
      getPendingGatheringProgressReceipts: vi
        .fn()
        .mockResolvedValue([irrelevantReceipt]),
      applyGatheringProgressReceipt: vi.fn(),
      retireGatheringProgressReceipt: vi.fn(),
      ignoreGatheringProgressReceipt,
    });

    fixture.eventBus.emitEvent(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: PLAYER_ID,
      resourceId: "fishing-spot",
      successful: true,
      skill: "fishing",
      operationId: irrelevantReceipt.operationId,
      rewardItemId: irrelevantReceipt.rewardItemId,
      rewardQuantity: irrelevantReceipt.rewardQuantity,
    });
    await fixture.eventBus.waitForPendingHandlers();

    expect(ignoreGatheringProgressReceipt).toHaveBeenCalledWith(
      irrelevantReceipt,
    );
    expect(
      fixture.repository.applyGatheringProgressReceipt,
    ).not.toHaveBeenCalled();
    expect(fixture.state.activeQuests.get(QUEST_ID)?.stageProgress).toEqual({});
    fixture.system.destroy();
  });
});
