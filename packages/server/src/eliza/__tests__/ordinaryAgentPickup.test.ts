import { describe, expect, it, vi } from "vitest";

import type { Database } from "../../database/client.js";
import type { AgentAutonomyProgressionAttempt } from "../agentAutonomyProgression.js";
import {
  getOrdinaryPickupOperationId,
  resolveOrdinaryPickupRecovery,
} from "../ordinaryAgentPickup.js";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

function pickupAttempt(
  overrides: Partial<AgentAutonomyProgressionAttempt> = {},
): AgentAutonomyProgressionAttempt {
  return {
    attemptId: ATTEMPT_ID,
    characterId: "agent-1",
    phase: "ordinary_progression",
    goalType: "provisioning",
    actionType: "pickup",
    decisionSource: "scripted",
    startedAt: 1_000,
    ...overrides,
  };
}

function validReceiptState() {
  return {
    version: 1,
    requestFingerprint: "a".repeat(64),
    sourceEntityId: "ground_item_22222222-2222-4222-8222-222222222222",
    itemId: "air_rune",
    quantity: 2,
    stackable: true,
    operationCommittedCoins: null,
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
    limit,
  };
}

describe("ordinary autonomous pickup recovery", () => {
  it("derives the exact pickup operation from the outer attempt", () => {
    expect(getOrdinaryPickupOperationId(ATTEMPT_ID)).toBe(
      `ground-item-pickup:${ATTEMPT_ID}`,
    );
    expect(() => getOrdinaryPickupOperationId("not-an-attempt")).toThrow(
      "ordinary_pickup_attempt_id_invalid",
    );
  });

  it("recovers completion only from the exact committed pickup receipt", async () => {
    const database = mockDatabase([
      {
        playerId: "agent-1",
        operationType: "ground_item_pickup",
        operationState: validReceiptState(),
        completed: true,
      },
    ]);

    await expect(
      resolveOrdinaryPickupRecovery(database.db, pickupAttempt()),
    ).resolves.toEqual({
      attemptedActionType: "pickup",
      appliedActionType: "pickup",
      outcome: "completed",
    });
    expect(database.limit).toHaveBeenCalledWith(1);
  });

  it("leaves missing or nonterminal pickup truth unresolved", async () => {
    await expect(
      resolveOrdinaryPickupRecovery(mockDatabase([]).db, pickupAttempt()),
    ).resolves.toBeNull();
    await expect(
      resolveOrdinaryPickupRecovery(
        mockDatabase([
          {
            playerId: "agent-1",
            operationType: "ground_item_pickup",
            operationState: validReceiptState(),
            completed: false,
          },
        ]).db,
        pickupAttempt(),
      ),
    ).resolves.toBeNull();
  });

  it("fails closed on receipt identity, type, or payload corruption", async () => {
    for (const row of [
      {
        playerId: "different-agent",
        operationType: "ground_item_pickup",
        operationState: validReceiptState(),
        completed: true,
      },
      {
        playerId: "agent-1",
        operationType: "unrelated_operation",
        operationState: validReceiptState(),
        completed: true,
      },
    ]) {
      await expect(
        resolveOrdinaryPickupRecovery(mockDatabase([row]).db, pickupAttempt()),
      ).rejects.toThrow("ordinary_pickup_recovery_receipt_identity_mismatch");
    }

    await expect(
      resolveOrdinaryPickupRecovery(
        mockDatabase([
          {
            playerId: "agent-1",
            operationType: "ground_item_pickup",
            operationState: {
              ...validReceiptState(),
              quantity: 0,
            },
            completed: true,
          },
        ]).db,
        pickupAttempt(),
      ),
    ).rejects.toThrow("ordinary_pickup_recovery_receipt_invalid");
  });

  it("does not query pickup receipts for another action", async () => {
    const database = mockDatabase([]);
    await expect(
      resolveOrdinaryPickupRecovery(
        database.db,
        pickupAttempt({ actionType: "attack" }),
      ),
    ).resolves.toBeNull();
    expect(database.select).not.toHaveBeenCalled();
  });
});
