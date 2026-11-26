import { describe, expect, it } from "vitest";

import type { EmbeddedBehaviorAction } from "../managers/AgentBehaviorTicker.js";
import {
  ORDINARY_PROCESSING_RETRY_BASE_DELAY_MS,
  ORDINARY_PROCESSING_RETRY_MAX_DELAY_MS,
  getOrdinaryProcessingIntent,
  isOrdinaryProcessingActionSuppressed,
  recordOrdinaryProcessingActionOutcome,
  snapshotOrdinaryProcessingRetrySuppressions,
  type OrdinaryProcessingRetryHolder,
} from "../ordinaryProcessingRetry.js";

const PROCESSING_ACTIONS: Array<
  [EmbeddedBehaviorAction, { actionType: string; intentId: string }]
> = [
  [
    { type: "cook", itemId: "raw_shrimp" },
    { actionType: "cook", intentId: "raw_shrimp" },
  ],
  [
    { type: "smelt", recipe: "iron_bar" },
    { actionType: "smelt", intentId: "iron_bar" },
  ],
  [
    { type: "smith", recipe: "iron_sword" },
    { actionType: "smith", intentId: "iron_sword" },
  ],
  [
    { type: "runecraft", runeType: "air" },
    { actionType: "runecraft", intentId: "air" },
  ],
  [
    { type: "craft", recipeId: "glass" },
    { actionType: "craft", intentId: "glass" },
  ],
  [
    { type: "fletch", recipeId: "shortbow:logs" },
    { actionType: "fletch", intentId: "shortbow:logs" },
  ],
  [
    { type: "tan", inputItemId: "cowhide" },
    { actionType: "tan", intentId: "cowhide" },
  ],
  [
    { type: "firemake", logsItemId: "oak_logs" },
    { actionType: "firemake", intentId: "oak_logs" },
  ],
];

describe("ordinary processing retry policy", () => {
  it.each(PROCESSING_ACTIONS)(
    "derives an exact stable intent from %j",
    (action, expected) => {
      expect(getOrdinaryProcessingIntent(action)).toEqual(expected);
    },
  );

  it("suppresses only the exact rejected recipe and preserves alternate work", () => {
    const holder: OrdinaryProcessingRetryHolder = {};
    const rejectedAt = 1_000_000;
    const rejected = { type: "fletch", recipeId: "shortbow:logs" } as const;
    const alternate = { type: "fletch", recipeId: "longbow:logs" } as const;

    const state = recordOrdinaryProcessingActionOutcome(
      holder,
      rejected,
      { outcome: "rejected", appliedActionType: null },
      rejectedAt,
    );

    expect(state).toMatchObject({
      actionType: "fletch",
      intentId: "shortbow:logs",
      consecutiveFailures: 1,
      retryAfter: rejectedAt + ORDINARY_PROCESSING_RETRY_BASE_DELAY_MS,
    });
    expect(
      isOrdinaryProcessingActionSuppressed(
        holder.ordinaryProcessingRetries,
        rejected,
        rejectedAt + 1,
      ),
    ).toBe(true);
    expect(
      isOrdinaryProcessingActionSuppressed(
        holder.ordinaryProcessingRetries,
        alternate,
        rejectedAt + 1,
      ),
    ).toBe(false);
    expect(
      isOrdinaryProcessingActionSuppressed(
        holder.ordinaryProcessingRetries,
        { type: "attack", targetId: "mob" },
        rejectedAt + 1,
      ),
    ).toBe(false);
  });

  it("backs repeated failures off exponentially and caps the delay", () => {
    const holder: OrdinaryProcessingRetryHolder = {};
    const action = { type: "tan", inputItemId: "cowhide" } as const;
    let now = 2_000_000;
    let state = recordOrdinaryProcessingActionOutcome(
      holder,
      action,
      { outcome: "failed", appliedActionType: null },
      now,
    );
    expect(state?.retryAfter).toBe(
      now + ORDINARY_PROCESSING_RETRY_BASE_DELAY_MS,
    );

    for (let attempt = 2; attempt <= 8; attempt += 1) {
      now = state!.retryAfter;
      state = recordOrdinaryProcessingActionOutcome(
        holder,
        action,
        { outcome: "rejected", appliedActionType: null },
        now,
      );
    }

    expect(state).toMatchObject({ consecutiveFailures: 8 });
    expect(state!.retryAfter - now).toBe(
      ORDINARY_PROCESSING_RETRY_MAX_DELAY_MS,
    );
  });

  it("clears an exact retry history only after that processing action completes", () => {
    const holder: OrdinaryProcessingRetryHolder = {};
    const action = { type: "firemake", logsItemId: "logs" } as const;
    const now = 3_000_000;
    recordOrdinaryProcessingActionOutcome(
      holder,
      action,
      { outcome: "rejected", appliedActionType: null },
      now,
    );

    recordOrdinaryProcessingActionOutcome(
      holder,
      action,
      { outcome: "completed", appliedActionType: "firemake" },
      now + ORDINARY_PROCESSING_RETRY_BASE_DELAY_MS,
    );

    expect(holder.ordinaryProcessingRetries).toEqual([]);
  });

  it("ends a bank-miss acquisition cycle only after an authored processing action completes", () => {
    const holder: OrdinaryProcessingRetryHolder = {
      ordinaryProcessingAcquisition: { expiresAt: 3_500_000 },
      bankStageRetryAfter: 3_500_000,
    };
    const action = { type: "smelt", recipe: "bronze_bar" } as const;

    recordOrdinaryProcessingActionOutcome(
      holder,
      action,
      { outcome: "rejected", appliedActionType: null },
      3_100_000,
    );
    expect(holder.ordinaryProcessingAcquisition).toEqual({
      expiresAt: 3_500_000,
    });
    expect(holder.bankStageRetryAfter).toBe(3_500_000);

    recordOrdinaryProcessingActionOutcome(
      holder,
      action,
      { outcome: "completed", appliedActionType: "smelt" },
      3_130_000,
    );
    expect(holder.ordinaryProcessingAcquisition).toBeNull();
    expect(holder.bankStageRetryAfter).toBe(0);
  });

  it("does not classify a useful cook fallback as a recipe rejection", () => {
    const holder: OrdinaryProcessingRetryHolder = {};
    const action = { type: "cook", itemId: "raw_shrimp" } as const;

    recordOrdinaryProcessingActionOutcome(
      holder,
      action,
      { outcome: "dispatched", appliedActionType: "gather" },
      4_000_000,
    );

    expect(holder.ordinaryProcessingRetries).toBeUndefined();
  });

  it("sends only active suppressions to the worker and resets quiet history", () => {
    const holder: OrdinaryProcessingRetryHolder = {};
    const action = { type: "smelt", recipe: "iron_bar" } as const;
    const rejectedAt = 5_000_000;
    recordOrdinaryProcessingActionOutcome(
      holder,
      action,
      { outcome: "rejected", appliedActionType: null },
      rejectedAt,
    );

    expect(
      snapshotOrdinaryProcessingRetrySuppressions(holder, rejectedAt + 1),
    ).toEqual([
      {
        actionType: "smelt",
        intentId: "iron_bar",
        retryAfter: rejectedAt + ORDINARY_PROCESSING_RETRY_BASE_DELAY_MS,
      },
    ]);
    expect(
      snapshotOrdinaryProcessingRetrySuppressions(
        holder,
        rejectedAt + ORDINARY_PROCESSING_RETRY_BASE_DELAY_MS,
      ),
    ).toEqual([]);
    expect(holder.ordinaryProcessingRetries).toHaveLength(1);

    snapshotOrdinaryProcessingRetrySuppressions(
      holder,
      rejectedAt + ORDINARY_PROCESSING_RETRY_MAX_DELAY_MS * 2 + 1,
    );
    expect(holder.ordinaryProcessingRetries).toEqual([]);
  });

  it("starts from a fresh live reassessment after process restart", () => {
    const priorProcess: OrdinaryProcessingRetryHolder = {};
    const action = { type: "craft", recipeId: "glass" } as const;
    const now = 6_000_000;
    recordOrdinaryProcessingActionOutcome(
      priorProcess,
      action,
      { outcome: "rejected", appliedActionType: null },
      now,
    );

    const replacementProcess: OrdinaryProcessingRetryHolder = {};
    expect(
      isOrdinaryProcessingActionSuppressed(
        replacementProcess.ordinaryProcessingRetries,
        action,
        now + 1,
      ),
    ).toBe(false);
    expect(
      snapshotOrdinaryProcessingRetrySuppressions(replacementProcess, now + 1),
    ).toEqual([]);
  });
});
