import { describe, expect, it, vi } from "vitest";

import type { Database } from "../../database/client.js";
import type { AgentAutonomyProgressionAttempt } from "../agentAutonomyProgression.js";
import {
  getOrdinaryGatheringRewardOperationId,
  resolveOrdinaryGatheringRecovery,
} from "../ordinaryAgentGathering.js";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

function gatheringAttempt(
  overrides: Partial<AgentAutonomyProgressionAttempt> = {},
): AgentAutonomyProgressionAttempt {
  return {
    attemptId: ATTEMPT_ID,
    characterId: "agent-1",
    phase: "ordinary_progression",
    goalType: "gathering",
    actionType: "gather",
    decisionSource: "scripted",
    startedAt: 1_000,
    ...overrides,
  };
}

function validOperationState() {
  return {
    version: 2,
    requestFingerprint: "a".repeat(64),
    resourceId: "tree_23_-10",
    depleteAfterCommit: false,
    respawnTicks: 10,
    depletedUntil: null,
    skill: "woodcutting",
    xpAmount: 25,
    reward: { itemId: "logs", quantity: 1, stackable: false },
    secondaryItemId: null,
    awardedXp: 25,
    operationCommittedXp: 125,
  };
}

function mockDatabase(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select } as unknown as Database,
    select,
    from,
    where,
    limit,
  };
}

describe("ordinary autonomous gathering recovery", () => {
  it("derives the first gathering reward identity from the immutable attempt", () => {
    expect(getOrdinaryGatheringRewardOperationId(ATTEMPT_ID)).toBe(
      `gathering-reward:${ATTEMPT_ID}`,
    );
  });

  it("recovers completion only from the exact completed gathering receipt", async () => {
    const database = mockDatabase([
      {
        playerId: "agent-1",
        operationType: "gathering_reward",
        operationState: validOperationState(),
        completed: true,
      },
    ]);

    await expect(
      resolveOrdinaryGatheringRecovery(database.db, gatheringAttempt()),
    ).resolves.toEqual({
      attemptedActionType: "gather",
      appliedActionType: "gather",
      outcome: "completed",
    });
    expect(database.limit).toHaveBeenCalledWith(1);
  });

  it("leaves a missing or incomplete reward receipt unresolved", async () => {
    await expect(
      resolveOrdinaryGatheringRecovery(mockDatabase([]).db, gatheringAttempt()),
    ).resolves.toBeNull();
    await expect(
      resolveOrdinaryGatheringRecovery(
        mockDatabase([
          {
            playerId: "agent-1",
            operationType: "gathering_reward",
            operationState: validOperationState(),
            completed: false,
          },
        ]).db,
        gatheringAttempt(),
      ),
    ).resolves.toBeNull();
  });

  it("fails closed on receipt identity or payload corruption", async () => {
    await expect(
      resolveOrdinaryGatheringRecovery(
        mockDatabase([
          {
            playerId: "different-agent",
            operationType: "gathering_reward",
            operationState: validOperationState(),
            completed: true,
          },
        ]).db,
        gatheringAttempt(),
      ),
    ).rejects.toThrow("ordinary_gathering_recovery_receipt_identity_mismatch");

    await expect(
      resolveOrdinaryGatheringRecovery(
        mockDatabase([
          {
            playerId: "agent-1",
            operationType: "gathering_reward",
            operationState: { ...validOperationState(), reward: null },
            completed: true,
          },
        ]).db,
        gatheringAttempt(),
      ),
    ).rejects.toThrow("ordinary_gathering_recovery_receipt_invalid");
  });

  it("does not inspect gathering receipts for a different action", async () => {
    const database = mockDatabase([]);
    await expect(
      resolveOrdinaryGatheringRecovery(
        database.db,
        gatheringAttempt({ actionType: "attack" }),
      ),
    ).resolves.toBeNull();
    expect(database.select).not.toHaveBeenCalled();
  });
});
