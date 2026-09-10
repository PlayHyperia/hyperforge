import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventType } from "../../../types/events";
import type { PlayerQuestState } from "../../../types/game/quest-types";
import type { World } from "../../../types/index";
import { generateKillToken } from "../../../utils/game/KillTokenUtils";
import { EventBus } from "../infrastructure/EventBus";
import { QuestSystem } from "./QuestSystem";

const PLAYER_ID = "player-kill-progress";
const QUEST_ID = "goblin_slayer";
const QUEST_STARTED_AT = 1_786_396_000_000;
const DEATH_TIMESTAMP = 1_788_087_600_000;
const OPERATION_ID =
  "ground-item-mob-loot:123e4567-e89b-42d3-a456-426614174000";
const SECRET = "kill-progress-regression-secret-with-enough-entropy";
const originalNodeEnv = process.env.NODE_ENV;
const originalKillTokenSecret = process.env.KILL_TOKEN_SECRET;

const committedReceipt = {
  operationId: OPERATION_ID,
  playerId: PLAYER_ID,
  questId: QUEST_ID,
  questStartedAt: QUEST_STARTED_AT,
  capturedStage: "kill_goblins",
  mobId: "goblin-life-1",
  mobType: "goblin",
  quantity: 1,
  createdAt: DEATH_TIMESTAMP,
};

function createRepository() {
  return {
    getPendingGatheringProgressReceipts: vi.fn().mockResolvedValue([]),
    applyGatheringProgressReceipt: vi.fn(),
    retireGatheringProgressReceipt: vi.fn(),
    ignoreGatheringProgressReceipt: vi.fn(),
    getPendingProcessingProgressReceipts: vi.fn().mockResolvedValue([]),
    applyProcessingProgressReceipt: vi.fn(),
    retireProcessingProgressReceipt: vi.fn(),
    ignoreProcessingProgressReceipt: vi.fn(),
    getPendingKillProgressReceipts: vi.fn().mockResolvedValue([]),
    applyKillProgressReceipt: vi.fn().mockResolvedValue({
      status: "applied",
      currentStage: "kill_goblins",
      stageProgress: { kills: 1 },
    }),
    retireKillProgressReceipt: vi.fn(),
    ignoreKillProgressReceipt: vi.fn(),
    updateProgress: vi.fn(),
  };
}

async function createFixture(repository = createRepository()) {
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
          currentStage: "kill_goblins",
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
  ).playerStates.set(PLAYER_ID, state);
  return { eventBus, repository, state, system };
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.KILL_TOKEN_SECRET = SECRET;
  vi.spyOn(Date, "now").mockReturnValue(DEATH_TIMESTAMP);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalKillTokenSecret === undefined) {
    delete process.env.KILL_TOKEN_SECRET;
  } else {
    process.env.KILL_TOKEN_SECRET = originalKillTokenSecret;
  }
});

describe("QuestSystem durable kill progress", () => {
  it("treats NPC_DIED as a wake-up hint and advances only from a committed mob-loot receipt", async () => {
    const fixture = await createFixture();
    const killToken = await generateKillToken(
      committedReceipt.mobId,
      PLAYER_ID,
      DEATH_TIMESTAMP,
      OPERATION_ID,
      "aggressive",
      10,
    );

    fixture.eventBus.emitEvent(EventType.NPC_DIED, {
      mobId: committedReceipt.mobId,
      mobType: committedReceipt.mobType,
      level: 2,
      killedBy: PLAYER_ID,
      position: { x: 1, y: 0, z: 1 },
      timestamp: DEATH_TIMESTAMP,
      lootOperationId: OPERATION_ID,
      killToken,
      attackStyle: "aggressive",
      damageDealt: 10,
    });
    await fixture.eventBus.waitForPendingHandlers();

    expect(fixture.state.activeQuests.get(QUEST_ID)?.stageProgress).toEqual({});
    expect(fixture.repository.applyKillProgressReceipt).not.toHaveBeenCalled();

    fixture.repository.getPendingKillProgressReceipts.mockResolvedValue([
      committedReceipt,
    ]);
    await (
      fixture.system as unknown as {
        queueQuestReceiptDrain: (playerId: string) => Promise<void>;
      }
    ).queueQuestReceiptDrain(PLAYER_ID);

    expect(fixture.repository.applyKillProgressReceipt).toHaveBeenCalledWith({
      ...committedReceipt,
      expectedCurrentStage: "kill_goblins",
      expectedProgress: {},
      resultingStage: "kill_goblins",
      resultingProgress: { kills: 1 },
    });
    expect(fixture.state.activeQuests.get(QUEST_ID)?.stageProgress).toEqual({
      kills: 1,
    });
    fixture.system.destroy();
  });

  it("refreshes stale durable state and applies the kill exactly once", async () => {
    const repository = createRepository();
    repository.getPendingKillProgressReceipts.mockResolvedValue([
      committedReceipt,
    ]);
    repository.applyKillProgressReceipt
      .mockResolvedValueOnce({
        status: "stale",
        currentStage: "kill_goblins",
        stageProgress: { kills: 2 },
      })
      .mockResolvedValueOnce({
        status: "applied",
        currentStage: "kill_goblins",
        stageProgress: { kills: 3 },
      });
    const fixture = await createFixture(repository);

    await (
      fixture.system as unknown as {
        queueQuestReceiptDrain: (playerId: string) => Promise<void>;
      }
    ).queueQuestReceiptDrain(PLAYER_ID);

    expect(repository.applyKillProgressReceipt).toHaveBeenCalledTimes(2);
    expect(
      repository.applyKillProgressReceipt.mock.calls[1]?.[0],
    ).toMatchObject({
      expectedProgress: { kills: 2 },
      resultingProgress: { kills: 3 },
    });
    expect(fixture.state.activeQuests.get(QUEST_ID)?.stageProgress).toEqual({
      kills: 3,
    });
    fixture.system.destroy();
  });

  it("ignores irrelevant committed mobs and retires abandoned incarnations", async () => {
    const repository = createRepository();
    repository.getPendingKillProgressReceipts.mockResolvedValue([
      { ...committedReceipt, mobId: "rat-life-1", mobType: "rat" },
    ]);
    const irrelevant = await createFixture(repository);
    await (
      irrelevant.system as unknown as {
        queueQuestReceiptDrain: (playerId: string) => Promise<void>;
      }
    ).queueQuestReceiptDrain(PLAYER_ID);
    expect(repository.ignoreKillProgressReceipt).toHaveBeenCalledOnce();
    expect(repository.applyKillProgressReceipt).not.toHaveBeenCalled();
    irrelevant.system.destroy();

    const abandonedRepository = createRepository();
    abandonedRepository.getPendingKillProgressReceipts.mockResolvedValue([
      committedReceipt,
    ]);
    abandonedRepository.retireKillProgressReceipt.mockResolvedValue("retired");
    const abandoned = await createFixture(abandonedRepository);
    abandoned.state.activeQuests.delete(QUEST_ID);
    await (
      abandoned.system as unknown as {
        queueQuestReceiptDrain: (playerId: string) => Promise<void>;
      }
    ).queueQuestReceiptDrain(PLAYER_ID);
    expect(abandonedRepository.retireKillProgressReceipt).toHaveBeenCalledWith(
      committedReceipt,
    );
    expect(abandonedRepository.applyKillProgressReceipt).not.toHaveBeenCalled();
    abandoned.system.destroy();
  });

  it("never carries a delayed kill receipt across quest-stage boundaries", async () => {
    const repository = createRepository();
    repository.getPendingKillProgressReceipts.mockResolvedValue([
      committedReceipt,
    ]);
    const fixture = await createFixture(repository);
    const progress = fixture.state.activeQuests.get(QUEST_ID);
    expect(progress).toBeDefined();
    progress!.currentStage = "return_to_guard";
    progress!.stageProgress = { kills: 1 };

    await (
      fixture.system as unknown as {
        queueQuestReceiptDrain: (playerId: string) => Promise<void>;
      }
    ).queueQuestReceiptDrain(PLAYER_ID);

    expect(repository.ignoreKillProgressReceipt).toHaveBeenCalledWith(
      committedReceipt,
    );
    expect(repository.applyKillProgressReceipt).not.toHaveBeenCalled();
    expect(progress!.stageProgress).toEqual({ kills: 1 });
    fixture.system.destroy();
  });

  it("rejects malformed durable kill receipts before quest mutation", async () => {
    const repository = createRepository();
    repository.getPendingKillProgressReceipts.mockResolvedValue([
      { ...committedReceipt, quantity: 2 },
    ]);
    const fixture = await createFixture(repository);

    await expect(
      (
        fixture.system as unknown as {
          queueQuestReceiptDrain: (playerId: string) => Promise<void>;
        }
      ).queueQuestReceiptDrain(PLAYER_ID),
    ).rejects.toThrow("quest_kill_progress_receipt_invalid");
    expect(repository.applyKillProgressReceipt).not.toHaveBeenCalled();
    expect(fixture.state.activeQuests.get(QUEST_ID)?.stageProgress).toEqual({});
    fixture.system.destroy();
  });
});
