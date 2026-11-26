import { describe, expect, it, vi } from "vitest";

import type { Database } from "../../database/client.js";
import type { AgentAutonomyProgressionAttempt } from "../agentAutonomyProgression.js";
import {
  getOrdinaryProcessingOperationId,
  resolveOrdinaryProcessingRecovery,
} from "../ordinaryAgentProcessing.js";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

function processingAttempt(
  actionType: AgentAutonomyProgressionAttempt["actionType"] = "fletch",
  overrides: Partial<AgentAutonomyProgressionAttempt> = {},
): AgentAutonomyProgressionAttempt {
  return {
    attemptId: ATTEMPT_ID,
    characterId: "agent-1",
    phase: "ordinary_progression",
    goalType: "provisioning",
    actionType,
    decisionSource: "scripted",
    startedAt: 1_000,
    ...overrides,
  };
}

function validCommittedState(skill = "fletching") {
  return {
    version: 1,
    requestFingerprint: "a".repeat(64),
    skill,
    xpAmount: 5,
    inputs: [{ itemId: "logs", quantity: 1 }],
    requiredItems: [],
    consumables: [],
    consumableStates: [],
    outputs: [{ itemId: "arrow_shaft", quantity: 15, stackable: true }],
    awardedXp: 5,
    operationCommittedXp: 105,
  };
}

function validRejectedState() {
  return {
    version: 1,
    requestId: ATTEMPT_ID,
    skill: "fletching",
    ownerId: "server-authority-1",
    acceptedAt: 900,
    heartbeatAt: 950,
    envelope: {
      skill: "fletching",
      recipeId: "arrow_shaft",
      quantity: 1,
    },
    reason: "requirements_not_met",
    retryable: false,
    rejectedAt: 975,
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

describe("ordinary autonomous processing recovery", () => {
  it("maps every processing action to the exact attempt-bound request receipt", () => {
    expect(getOrdinaryProcessingOperationId("firemake", ATTEMPT_ID)).toBe(
      `processing-request:firemaking:${ATTEMPT_ID}`,
    );
    expect(getOrdinaryProcessingOperationId("cook", ATTEMPT_ID)).toBe(
      `processing-request:cooking:${ATTEMPT_ID}`,
    );
    expect(getOrdinaryProcessingOperationId("smelt", ATTEMPT_ID)).toBe(
      `processing-request:smelting:${ATTEMPT_ID}`,
    );
    expect(getOrdinaryProcessingOperationId("smith", ATTEMPT_ID)).toBe(
      `processing-request:smithing:${ATTEMPT_ID}`,
    );
    expect(getOrdinaryProcessingOperationId("craft", ATTEMPT_ID)).toBe(
      `processing-request:crafting:${ATTEMPT_ID}`,
    );
    expect(getOrdinaryProcessingOperationId("fletch", ATTEMPT_ID)).toBe(
      `processing-request:fletching:${ATTEMPT_ID}`,
    );
    expect(getOrdinaryProcessingOperationId("runecraft", ATTEMPT_ID)).toBe(
      `processing-request:runecrafting:${ATTEMPT_ID}`,
    );
    expect(getOrdinaryProcessingOperationId("tan", ATTEMPT_ID)).toBe(
      `processing-request:tanning:${ATTEMPT_ID}`,
    );
  });

  it("recovers completion only from the exact completed processing receipt", async () => {
    const database = mockDatabase([
      {
        playerId: "agent-1",
        operationType: "processing_action",
        operationState: validCommittedState(),
        completed: true,
      },
    ]);

    await expect(
      resolveOrdinaryProcessingRecovery(database.db, processingAttempt()),
    ).resolves.toEqual({
      attemptedActionType: "fletch",
      appliedActionType: "fletch",
      outcome: "completed",
    });
    expect(database.limit).toHaveBeenCalledWith(1);
  });

  it("recovers an exact durable rejection without pretending work applied", async () => {
    await expect(
      resolveOrdinaryProcessingRecovery(
        mockDatabase([
          {
            playerId: "agent-1",
            operationType: "processing_request_rejected",
            operationState: validRejectedState(),
            completed: true,
          },
        ]).db,
        processingAttempt(),
      ),
    ).resolves.toEqual({
      attemptedActionType: "fletch",
      appliedActionType: null,
      outcome: "rejected",
    });
  });

  it("uses the custody skill stored by smelting and tanning commits", async () => {
    for (const [actionType, skill] of [
      ["smelt", "smithing"],
      ["tan", "crafting"],
    ] as const) {
      await expect(
        resolveOrdinaryProcessingRecovery(
          mockDatabase([
            {
              playerId: "agent-1",
              operationType: "processing_action",
              operationState: validCommittedState(skill),
              completed: true,
            },
          ]).db,
          processingAttempt(actionType),
        ),
      ).resolves.toEqual({
        attemptedActionType: actionType,
        appliedActionType: actionType,
        outcome: "completed",
      });
    }
  });

  it("leaves a missing or nonterminal request unresolved", async () => {
    await expect(
      resolveOrdinaryProcessingRecovery(
        mockDatabase([]).db,
        processingAttempt(),
      ),
    ).resolves.toBeNull();
    await expect(
      resolveOrdinaryProcessingRecovery(
        mockDatabase([
          {
            playerId: "agent-1",
            operationType: "processing_request",
            operationState: {
              version: 1,
              requestId: ATTEMPT_ID,
              skill: "fletching",
              ownerId: "server-authority-1",
              acceptedAt: 900,
              heartbeatAt: 950,
            },
            completed: false,
          },
        ]).db,
        processingAttempt(),
      ),
    ).resolves.toBeNull();
  });

  it("fails closed on receipt identity, type, or payload corruption", async () => {
    await expect(
      resolveOrdinaryProcessingRecovery(
        mockDatabase([
          {
            playerId: "different-agent",
            operationType: "processing_action",
            operationState: validCommittedState(),
            completed: true,
          },
        ]).db,
        processingAttempt(),
      ),
    ).rejects.toThrow("ordinary_processing_recovery_receipt_identity_mismatch");

    await expect(
      resolveOrdinaryProcessingRecovery(
        mockDatabase([
          {
            playerId: "agent-1",
            operationType: "unrelated_operation",
            operationState: validCommittedState(),
            completed: true,
          },
        ]).db,
        processingAttempt(),
      ),
    ).rejects.toThrow("ordinary_processing_recovery_receipt_identity_mismatch");

    await expect(
      resolveOrdinaryProcessingRecovery(
        mockDatabase([
          {
            playerId: "agent-1",
            operationType: "processing_action",
            operationState: {
              ...validCommittedState(),
              requestFingerprint: "not-a-fingerprint",
            },
            completed: true,
          },
        ]).db,
        processingAttempt(),
      ),
    ).rejects.toThrow("ordinary_processing_recovery_receipt_invalid");
  });

  it("does not inspect processing receipts for a different action", async () => {
    const database = mockDatabase([]);
    await expect(
      resolveOrdinaryProcessingRecovery(
        database.db,
        processingAttempt("attack"),
      ),
    ).resolves.toBeNull();
    expect(database.select).not.toHaveBeenCalled();
  });
});
