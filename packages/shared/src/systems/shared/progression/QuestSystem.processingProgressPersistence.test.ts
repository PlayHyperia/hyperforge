import { afterEach, describe, expect, it, vi } from "vitest";

import { EventType } from "../../../types/events";
import type { PlayerQuestState } from "../../../types/game/quest-types";
import type { World } from "../../../types/index";
import { EventBus } from "../infrastructure/EventBus";
import { QuestSystem } from "./QuestSystem";

const PLAYER_ID = "player-processing-progress";
const QUEST_ID = "fresh_catch";
const QUEST_STARTED_AT = 1_786_392_000_000;

type ProcessingReceipt = {
  operationId: string;
  playerId: string;
  questId: string;
  questStartedAt: number;
  capturedStage: string;
  targetId: string;
  quantity: number;
  createdAt: number;
};

type QuestRepositoryDouble = {
  getPendingProcessingProgressReceipts: ReturnType<typeof vi.fn>;
  applyProcessingProgressReceipt: ReturnType<typeof vi.fn>;
  retireProcessingProgressReceipt: ReturnType<typeof vi.fn>;
  ignoreProcessingProgressReceipt: ReturnType<typeof vi.fn>;
};

function receipt(
  operationId: string,
  quantity: number,
  targetId = "shrimp",
): ProcessingReceipt {
  return {
    operationId,
    playerId: PLAYER_ID,
    questId: QUEST_ID,
    questStartedAt: QUEST_STARTED_AT,
    capturedStage: "cook_shrimp",
    targetId,
    quantity,
    createdAt: QUEST_STARTED_AT + quantity,
  };
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
          currentStage: "cook_shrimp",
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

function emptyRepository(): QuestRepositoryDouble {
  return {
    getPendingProcessingProgressReceipts: vi.fn().mockResolvedValue([]),
    applyProcessingProgressReceipt: vi.fn(),
    retireProcessingProgressReceipt: vi.fn(),
    ignoreProcessingProgressReceipt: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QuestSystem durable processing progress", () => {
  it("treats every processing presentation event as a wake-up hint, never progress authority", async () => {
    const fixture = await createFixture(emptyRepository());

    fixture.eventBus.emitEvent(EventType.FIRE_CREATED, {
      fireId: "fire-1",
      playerId: PLAYER_ID,
      position: { x: 0, y: 0, z: 0 },
      createdAt: 1,
      expiresAt: 2,
      serverObservedAt: 1,
    });
    fixture.eventBus.emitEvent(EventType.COOKING_COMPLETED, {
      playerId: PLAYER_ID,
      rawItemId: "raw_shrimp",
      resultItemId: "shrimp",
      wasBurnt: false,
      xpGained: 30,
    });
    fixture.eventBus.emitEvent(EventType.SMELTING_SUCCESS, {
      playerId: PLAYER_ID,
      barItemId: "bronze_bar",
      xpGained: 6.2,
    });
    fixture.eventBus.emitEvent(EventType.SMITHING_COMPLETE, {
      playerId: PLAYER_ID,
      recipeId: "bronze_dagger",
      outputItemId: "bronze_dagger",
      totalSmithed: 1,
      totalXp: 12.5,
    });
    fixture.eventBus.emitEvent(EventType.RUNECRAFTING_COMPLETE, {
      playerId: PLAYER_ID,
      runeType: "air",
      runeItemId: "air_rune",
      essenceConsumed: 1,
      runesProduced: 100,
      multiplier: 1,
      xpAwarded: 5,
    });
    fixture.eventBus.emitEvent(EventType.CRAFTING_COMPLETE, {
      playerId: PLAYER_ID,
      recipeId: "leather_gloves",
      outputItemId: "leather_gloves",
      totalCrafted: 100,
      totalXp: 13.8,
    });
    fixture.eventBus.emitEvent(EventType.FLETCHING_COMPLETE, {
      playerId: PLAYER_ID,
      recipeId: "arrow_shaft",
      outputItemId: "arrow_shaft",
      totalCrafted: 150,
      totalXp: 5,
    });
    fixture.eventBus.emitEvent(EventType.TANNING_COMPLETE, {
      playerId: PLAYER_ID,
      inputItemId: "cowhide",
      outputItemId: "leather",
      totalTanned: 100,
      totalCost: 100,
    });
    await fixture.eventBus.waitForPendingHandlers();

    expect(
      fixture.repository.getPendingProcessingProgressReceipts,
    ).toHaveBeenCalledTimes(8);
    expect(
      fixture.repository.applyProcessingProgressReceipt,
    ).not.toHaveBeenCalled();
    expect(fixture.state.activeQuests.get(QUEST_ID)?.stageProgress).toEqual({});
    fixture.system.destroy();
  });

  it("applies committed receipts in order and advances from the persisted result", async () => {
    const receipts = [
      receipt("processing:cooking:first", 2),
      receipt("processing:cooking:second", 4),
    ];
    const applyProcessingProgressReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        status: "applied",
        currentStage: "cook_shrimp",
        stageProgress: { shrimp: 2 },
      })
      .mockResolvedValueOnce({
        status: "applied",
        currentStage: "return",
        stageProgress: { shrimp: 6 },
      });
    const repository: QuestRepositoryDouble = {
      getPendingProcessingProgressReceipts: vi.fn().mockResolvedValue(receipts),
      applyProcessingProgressReceipt,
      retireProcessingProgressReceipt: vi.fn(),
      ignoreProcessingProgressReceipt: vi.fn(),
    };
    const fixture = await createFixture(repository);

    fixture.eventBus.emitEvent(EventType.COOKING_COMPLETED, {
      playerId: PLAYER_ID,
      rawItemId: "forged-payload",
      resultItemId: "forged-payload",
      wasBurnt: true,
      xpGained: 0,
    });
    await fixture.eventBus.waitForPendingHandlers();

    expect(applyProcessingProgressReceipt).toHaveBeenCalledTimes(2);
    expect(applyProcessingProgressReceipt.mock.calls[0][0]).toMatchObject({
      ...receipts[0],
      expectedCurrentStage: "cook_shrimp",
      expectedProgress: {},
      resultingStage: "cook_shrimp",
      resultingProgress: { shrimp: 2 },
    });
    expect(applyProcessingProgressReceipt.mock.calls[1][0]).toMatchObject({
      ...receipts[1],
      expectedCurrentStage: "cook_shrimp",
      expectedProgress: { shrimp: 2 },
      resultingStage: "return",
      resultingProgress: { shrimp: 6 },
    });
    expect(fixture.state.activeQuests.get(QUEST_ID)).toMatchObject({
      status: "ready_to_complete",
      currentStage: "return",
      stageProgress: { shrimp: 6 },
    });
    fixture.system.destroy();
  });

  it("refreshes stale state and retries without duplicating the receipt quantity", async () => {
    const committedReceipt = receipt("processing:cooking:stale", 2);
    const applyProcessingProgressReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        status: "stale",
        currentStage: "cook_shrimp",
        stageProgress: { shrimp: 1 },
      })
      .mockResolvedValueOnce({
        status: "applied",
        currentStage: "cook_shrimp",
        stageProgress: { shrimp: 3 },
      });
    const fixture = await createFixture({
      getPendingProcessingProgressReceipts: vi
        .fn()
        .mockResolvedValue([committedReceipt]),
      applyProcessingProgressReceipt,
      retireProcessingProgressReceipt: vi.fn(),
      ignoreProcessingProgressReceipt: vi.fn(),
    });

    fixture.eventBus.emitEvent(EventType.COOKING_COMPLETED, {
      playerId: PLAYER_ID,
      rawItemId: "raw_shrimp",
      resultItemId: "shrimp",
      wasBurnt: false,
      xpGained: 30,
    });
    await fixture.eventBus.waitForPendingHandlers();

    expect(applyProcessingProgressReceipt).toHaveBeenCalledTimes(2);
    expect(
      applyProcessingProgressReceipt.mock.calls[1][0].resultingProgress,
    ).toEqual({ shrimp: 3 });
    expect(fixture.state.activeQuests.get(QUEST_ID)?.stageProgress).toEqual({
      shrimp: 3,
    });
    fixture.system.destroy();
  });

  it("drains missed gathering custody before processing and crosses both completed stages", async () => {
    const gatheringReceipt = {
      operationId: "gathering-reward:before-cooking",
      playerId: PLAYER_ID,
      questId: QUEST_ID,
      questStartedAt: QUEST_STARTED_AT,
      capturedStage: "catch_shrimp",
      rewardItemId: "raw_shrimp",
      rewardQuantity: 1,
      createdAt: QUEST_STARTED_AT,
    };
    const processingReceipt = {
      ...receipt("processing:cooking:after-gathering", 6),
      capturedStage: "catch_shrimp",
      createdAt: QUEST_STARTED_AT + 1,
    };
    const applyGatheringProgressReceipt = vi.fn().mockResolvedValue({
      status: "applied",
      currentStage: "cook_shrimp",
      stageProgress: { raw_shrimp: 6 },
    });
    const applyProcessingProgressReceipt = vi.fn().mockResolvedValue({
      status: "applied",
      currentStage: "cook_shrimp",
      stageProgress: { raw_shrimp: 6, shrimp: 6 },
    });
    const repository = {
      ...emptyRepository(),
      getPendingGatheringProgressReceipts: vi
        .fn()
        .mockResolvedValue([gatheringReceipt]),
      applyGatheringProgressReceipt,
      retireGatheringProgressReceipt: vi.fn(),
      ignoreGatheringProgressReceipt: vi.fn(),
      getPendingProcessingProgressReceipts: vi
        .fn()
        .mockResolvedValue([processingReceipt]),
      applyProcessingProgressReceipt,
    };
    const fixture = await createFixture(repository);
    fixture.state.activeQuests.set(QUEST_ID, {
      playerId: PLAYER_ID,
      questId: QUEST_ID,
      status: "in_progress",
      currentStage: "catch_shrimp",
      stageProgress: { raw_shrimp: 5 },
      startedAt: QUEST_STARTED_AT,
    });

    fixture.eventBus.emitEvent(EventType.COOKING_COMPLETED, {
      playerId: PLAYER_ID,
      rawItemId: "raw_shrimp",
      resultItemId: "shrimp",
      wasBurnt: false,
      xpGained: 30,
    });
    await fixture.eventBus.waitForPendingHandlers();

    expect(applyGatheringProgressReceipt).toHaveBeenCalledTimes(1);
    expect(applyProcessingProgressReceipt).toHaveBeenCalledTimes(1);
    expect(
      applyGatheringProgressReceipt.mock.invocationCallOrder[0],
    ).toBeLessThan(applyProcessingProgressReceipt.mock.invocationCallOrder[0]);
    expect(applyProcessingProgressReceipt.mock.calls[0][0]).toMatchObject({
      expectedCurrentStage: "cook_shrimp",
      expectedProgress: { raw_shrimp: 6 },
      resultingProgress: { raw_shrimp: 6, shrimp: 6 },
    });
    expect(fixture.state.activeQuests.get(QUEST_ID)).toMatchObject({
      status: "ready_to_complete",
      currentStage: "cook_shrimp",
      stageProgress: { raw_shrimp: 6, shrimp: 6 },
    });
    fixture.system.destroy();
  });

  it("consumes valid progress earned for a later interact stage without repetition", async () => {
    const questId = "crafting_basics";
    const committedReceipt: ProcessingReceipt = {
      ...receipt("processing:crafting:gloves", 5, "leather_gloves"),
      questId,
      capturedStage: "craft_gloves",
    };
    const applyProcessingProgressReceipt = vi.fn().mockResolvedValue({
      status: "applied",
      currentStage: "return",
      stageProgress: { leather_boots: 5, leather_gloves: 5 },
    });
    const fixture = await createFixture({
      getPendingProcessingProgressReceipts: vi
        .fn()
        .mockResolvedValue([committedReceipt]),
      applyProcessingProgressReceipt,
      retireProcessingProgressReceipt: vi.fn(),
      ignoreProcessingProgressReceipt: vi.fn(),
    });
    fixture.state.activeQuests.clear();
    fixture.state.activeQuests.set(questId, {
      playerId: PLAYER_ID,
      questId,
      status: "in_progress",
      currentStage: "craft_gloves",
      stageProgress: { leather_boots: 5 },
      startedAt: QUEST_STARTED_AT,
    });

    fixture.eventBus.emitEvent(EventType.CRAFTING_COMPLETE, {
      playerId: PLAYER_ID,
      recipeId: "leather_gloves",
      outputItemId: "leather_gloves",
      totalCrafted: 5,
      totalXp: 69,
    });
    await fixture.eventBus.waitForPendingHandlers();

    expect(applyProcessingProgressReceipt.mock.calls[0][0]).toMatchObject({
      expectedCurrentStage: "craft_gloves",
      expectedProgress: { leather_boots: 5 },
      resultingStage: "return",
      resultingProgress: { leather_boots: 5, leather_gloves: 5 },
    });
    expect(fixture.state.activeQuests.get(questId)).toMatchObject({
      status: "ready_to_complete",
      currentStage: "return",
      stageProgress: { leather_boots: 5, leather_gloves: 5 },
    });
    fixture.system.destroy();
  });

  it("ignores manifest-irrelevant outputs and retires abandoned incarnations", async () => {
    const irrelevant = receipt("processing:cooking:burnt", 1, "burnt_shrimp");
    const superseded = receipt("processing:cooking:abandoned", 1);
    const ignoreProcessingProgressReceipt = vi
      .fn()
      .mockResolvedValue("ignored");
    const retireProcessingProgressReceipt = vi
      .fn()
      .mockResolvedValue("retired");
    const fixture = await createFixture({
      getPendingProcessingProgressReceipts: vi
        .fn()
        .mockResolvedValueOnce([irrelevant])
        .mockResolvedValueOnce([superseded]),
      applyProcessingProgressReceipt: vi.fn(),
      retireProcessingProgressReceipt,
      ignoreProcessingProgressReceipt,
    });

    fixture.eventBus.emitEvent(EventType.COOKING_COMPLETED, {
      playerId: PLAYER_ID,
      rawItemId: "raw_shrimp",
      resultItemId: "burnt_shrimp",
      wasBurnt: true,
      xpGained: 0,
    });
    await fixture.eventBus.waitForPendingHandlers();
    expect(ignoreProcessingProgressReceipt).toHaveBeenCalledWith(irrelevant);

    fixture.state.activeQuests.delete(QUEST_ID);
    fixture.eventBus.emitEvent(EventType.COOKING_COMPLETED, {
      playerId: PLAYER_ID,
      rawItemId: "raw_shrimp",
      resultItemId: "shrimp",
      wasBurnt: false,
      xpGained: 30,
    });
    await fixture.eventBus.waitForPendingHandlers();

    expect(retireProcessingProgressReceipt).toHaveBeenCalledWith(superseded);
    expect(
      fixture.repository.applyProcessingProgressReceipt,
    ).not.toHaveBeenCalled();
    fixture.system.destroy();
  });
});
