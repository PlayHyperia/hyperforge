import { describe, expect, it, vi } from "vitest";

import * as schema from "../schema.js";
import {
  QuestRepository,
  type ApplyQuestKillProgressReceiptRequest,
} from "./QuestRepository.js";

const OPERATION_ID =
  "ground-item-mob-loot:123e4567-e89b-42d3-a456-426614174000";
const PLAYER_ID = "kill-repository-player";
const QUEST_ID = "goblin_slayer";
const STARTED_AT = 1_786_396_000_000;
const CREATED_AT = 1_788_087_600_000;

const request: ApplyQuestKillProgressReceiptRequest = {
  operationId: OPERATION_ID,
  playerId: PLAYER_ID,
  questId: QUEST_ID,
  questStartedAt: STARTED_AT,
  capturedStage: "kill_goblins",
  mobId: "goblin-life-1",
  mobType: "goblin",
  quantity: 1,
  createdAt: CREATED_AT,
  expectedCurrentStage: "kill_goblins",
  expectedProgress: {},
  resultingStage: "kill_goblins",
  resultingProgress: { kills: 1 },
};

function createFixture(
  options: {
    resolution?: string | null;
    resolvedAt?: number | null;
    resultingStage?: string | null;
    resultingProgress?: Record<string, number> | null;
    persistedProgress?: Record<string, number>;
  } = {},
) {
  const receipt = {
    id: 1,
    operationId: OPERATION_ID,
    playerId: PLAYER_ID,
    questId: QUEST_ID,
    questStartedAt: STARTED_AT,
    capturedStage: "kill_goblins",
    mobId: "goblin-life-1",
    mobType: "goblin",
    quantity: 1,
    createdAt: CREATED_AT,
    resolution: options.resolution ?? null,
    resolvedAt: options.resolvedAt ?? null,
    resultingStage: options.resultingStage ?? null,
    resultingProgress: options.resultingProgress ?? null,
  };
  const quest = {
    id: 7,
    playerId: PLAYER_ID,
    questId: QUEST_ID,
    status: "in_progress",
    startedAt: STARTED_AT,
    currentStage: "kill_goblins",
    stageProgress: options.persistedProgress ?? {},
  };
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const tx = {
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === schema.questKillProgressReceipts ? [receipt] : [quest],
        }),
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: unknown) => ({
        where: () => {
          updates.push({ table, values });
          return {
            then: (resolve: (value: undefined) => void) => resolve(undefined),
            returning: async () => [{ id: quest.id }],
          };
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push({ table, values });
      }),
    })),
  };
  const repository = new QuestRepository({} as never, {} as never);
  (
    repository as unknown as {
      withTransaction: <T>(
        callback: (candidate: typeof tx) => Promise<T>,
      ) => Promise<T>;
    }
  ).withTransaction = async (callback) => callback(tx);
  return { repository, tx, updates, inserts };
}

describe("QuestRepository durable kill progress", () => {
  it("applies exactly one kill and resolves its immutable receipt atomically", async () => {
    const fixture = createFixture();

    await expect(
      fixture.repository.applyKillProgressReceipt(request),
    ).resolves.toEqual({
      status: "applied",
      currentStage: "kill_goblins",
      stageProgress: { kills: 1 },
    });
    expect(fixture.updates).toEqual(
      expect.arrayContaining([
        {
          table: schema.questProgress,
          values: {
            currentStage: "kill_goblins",
            stageProgress: { kills: 1 },
          },
        },
        expect.objectContaining({
          table: schema.questKillProgressReceipts,
          values: expect.objectContaining({
            resolution: "applied",
            resultingStage: "kill_goblins",
            resultingProgress: { kills: 1 },
          }),
        }),
      ]),
    );
    expect(fixture.inserts).toContainEqual(
      expect.objectContaining({
        table: schema.questAuditLog,
        values: expect.objectContaining({
          metadata: expect.objectContaining({
            source: "mob_loot",
            operationId: OPERATION_ID,
            mobId: "goblin-life-1",
            mobType: "goblin",
          }),
        }),
      }),
    );
  });

  it("replays the stored result without mutating quest state again", async () => {
    const fixture = createFixture({
      resolution: "applied",
      resolvedAt: CREATED_AT + 1,
      resultingStage: "kill_goblins",
      resultingProgress: { kills: 1 },
    });

    await expect(
      fixture.repository.applyKillProgressReceipt(request),
    ).resolves.toEqual({
      status: "replayed",
      currentStage: "kill_goblins",
      stageProgress: { kills: 1 },
    });
    expect(fixture.updates).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  it("rejects a caller-proposed count that does not equal the receipt delta", async () => {
    const fixture = createFixture();

    await expect(
      fixture.repository.applyKillProgressReceipt({
        ...request,
        resultingProgress: { kills: 2 },
      }),
    ).rejects.toThrow("quest_kill_progress_result_invalid");
    expect(fixture.updates).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  it("rejects applying a receipt against a stage other than its captured stage", async () => {
    const fixture = createFixture();

    await expect(
      fixture.repository.applyKillProgressReceipt({
        ...request,
        expectedCurrentStage: "return_to_guard",
      }),
    ).rejects.toThrow("quest_kill_progress_request_invalid");
    expect(fixture.tx.select).not.toHaveBeenCalled();
    expect(fixture.updates).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });
});
