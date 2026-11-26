import { describe, expect, it, vi } from "vitest";

import {
  executeOrdinaryStoreBuy,
  getOrdinaryStoreBuyOperationId,
  hasOrdinaryCoinRecoveryAuthorization,
  recordOrdinaryStoreBuyOutcome,
} from "../ordinaryAgentStore.js";
import type { OrdinaryStoreExecutionResult } from "../ordinaryAgentStore.js";
import type { AgentAutonomyProgressionAttempt } from "../agentAutonomyProgression.js";
import type { AgentInstance } from "../managers/AgentBehaviorTicker.js";

const attempt: AgentAutonomyProgressionAttempt = {
  attemptId: "11498de3-cfef-4d06-8e62-9626420517d8",
  characterId: "ordinary-store-agent",
  phase: "ordinary_progression",
  goalType: "provisioning",
  actionType: "storeBuy",
  decisionSource: "scripted",
  startedAt: 1_000,
};

function makeInstance(
  executeAuthoritativeStoreBuy: ReturnType<typeof vi.fn>,
): AgentInstance {
  return {
    state: "running",
    storeRetryAfter: 0,
    coinRecovery: null,
    service: {
      executeAuthoritativeStoreBuy,
      getInventoryItems: () => [],
      getEquippedItems: () => ({}),
    },
  } as unknown as AgentInstance;
}

describe("ordinary autonomous store reconciliation", () => {
  it("derives one stable UUID distinct from the autonomy attempt ID", () => {
    const first = getOrdinaryStoreBuyOperationId(attempt.attemptId);
    expect(first).toBe(getOrdinaryStoreBuyOperationId(attempt.attemptId));
    expect(first).not.toBe(attempt.attemptId);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("retries an ambiguous response with the exact same operation ID", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        status: "unknown",
        operationId: getOrdinaryStoreBuyOperationId(attempt.attemptId),
        replayed: false,
      })
      .mockResolvedValueOnce({
        status: "committed",
        operationId: getOrdinaryStoreBuyOperationId(attempt.attemptId),
        replayed: true,
      });
    const result = await executeOrdinaryStoreBuy(
      makeInstance(execute),
      "tool_store",
      "bronze_hatchet",
      1,
      attempt,
    );

    expect(result).toMatchObject({
      settled: true,
      applied: true,
      reconciliationAttempts: 2,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
    expect(execute).toHaveBeenCalledWith(
      "tool_store",
      "bronze_hatchet",
      1,
      getOrdinaryStoreBuyOperationId(attempt.attemptId),
    );
  });

  it("settles a definite business rejection without retrying", async () => {
    const execute = vi.fn(async () => ({
      status: "rejected",
      operationId: getOrdinaryStoreBuyOperationId(attempt.attemptId),
      replayed: false,
    }));
    const result = await executeOrdinaryStoreBuy(
      makeInstance(execute),
      "tool_store",
      "bronze_hatchet",
      1,
      attempt,
    );
    expect(result).toMatchObject({
      settled: true,
      applied: false,
      reconciliationAttempts: 1,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("leaves an ambiguous attempt unsettled when process shutdown fences it", async () => {
    let instance: AgentInstance;
    const execute = vi.fn(async () => {
      instance.state = "stopped";
      return {
        status: "unknown" as const,
        operationId: getOrdinaryStoreBuyOperationId(attempt.attemptId),
        replayed: false as const,
      };
    });
    instance = makeInstance(execute);
    const result = await executeOrdinaryStoreBuy(
      instance,
      "tool_store",
      "bronze_hatchet",
      1,
      attempt,
    );
    expect(result).toMatchObject({
      settled: false,
      applied: false,
      reconciliationAttempts: 1,
    });
  });

  it("authorizes only a still-needed exact insufficient-coin recovery", () => {
    const now = 10_000;
    const instance = makeInstance(vi.fn());
    const insufficient: OrdinaryStoreExecutionResult = {
      settled: true,
      applied: false,
      receipt: {
        status: "rejected",
        operationId: "5a434c2e-c605-41cb-b7d7-aa80fb46672b",
        replayed: false,
        reason: "insufficient_coins",
      },
      operationId: "5a434c2e-c605-41cb-b7d7-aa80fb46672b",
      reconciliationAttempts: 1,
    };
    recordOrdinaryStoreBuyOutcome(
      instance,
      insufficient,
      { storeId: "tool_store", itemId: "bronze_hatchet", quantity: 1 },
      now,
    );

    expect(instance.storeRetryAfter).toBe(now + 30_000);
    expect(instance.coinRecovery).toEqual({
      storeId: "tool_store",
      itemId: "bronze_hatchet",
      quantity: 1,
      expiresAt: now + 300_000,
    });
    expect(
      hasOrdinaryCoinRecoveryAuthorization(instance, now + 1, undefined, {
        coinBalance: 0,
        unitPrice: 50,
      }),
    ).toBe(true);

    vi.spyOn(instance.service, "getInventoryItems").mockReturnValue([
      { slot: 0, itemId: "bronze_hatchet", quantity: 1 },
    ]);
    expect(
      hasOrdinaryCoinRecoveryAuthorization(instance, now + 2, undefined, {
        coinBalance: 0,
        unitPrice: 50,
      }),
    ).toBe(false);
    expect(instance.coinRecovery).toBeNull();
  });

  it("stops guaranteed-drop recovery and releases the retry once the exact purchase is affordable", () => {
    const now = 20_000;
    const instance = makeInstance(vi.fn());
    recordOrdinaryStoreBuyOutcome(
      instance,
      {
        settled: true,
        applied: false,
        receipt: {
          status: "rejected",
          operationId: "c1a3e807-0a4a-4e07-9eba-cc49e23770c5",
          replayed: false,
          reason: "insufficient_coins",
        },
        operationId: "c1a3e807-0a4a-4e07-9eba-cc49e23770c5",
        reconciliationAttempts: 1,
      },
      { storeId: "tool_store", itemId: "bronze_hatchet", quantity: 2 },
      now,
    );

    expect(
      hasOrdinaryCoinRecoveryAuthorization(instance, now + 1, undefined, {
        coinBalance: 99,
        unitPrice: 50,
      }),
    ).toBe(true);
    expect(instance.storeRetryAfter).toBe(50_000);

    expect(
      hasOrdinaryCoinRecoveryAuthorization(instance, now + 2, undefined, {
        coinBalance: 100,
        unitPrice: 50,
      }),
    ).toBe(false);
    expect(instance.coinRecovery).toBeNull();
    expect(instance.storeRetryAfter).toBe(0);
  });

  it("never authorizes technical, ambiguous, or unrelated store rejection", () => {
    const instance = makeInstance(vi.fn());
    instance.coinRecovery = {
      storeId: "old_store",
      itemId: "old_item",
      quantity: 1,
      expiresAt: 99_000,
    };
    const rejected: OrdinaryStoreExecutionResult = {
      settled: true,
      applied: false,
      receipt: {
        status: "rejected",
        operationId: null,
        replayed: false,
      },
      operationId: "b75238bf-12fb-473f-8fb6-a85c72f8b6b0",
      reconciliationAttempts: 1,
    };
    recordOrdinaryStoreBuyOutcome(
      instance,
      rejected,
      { storeId: "tool_store", itemId: "bronze_hatchet", quantity: 1 },
      10_000,
    );

    expect(instance.coinRecovery).toBeNull();
    expect(hasOrdinaryCoinRecoveryAuthorization(instance, 10_001)).toBe(false);
  });

  it("fails closed when the exact failed purchase no longer has price authority", () => {
    const instance = makeInstance(vi.fn());
    instance.storeRetryAfter = 40_000;
    instance.coinRecovery = {
      storeId: "missing_store",
      itemId: "missing_item",
      quantity: 1,
      expiresAt: 300_000,
    };

    expect(
      hasOrdinaryCoinRecoveryAuthorization(instance, 10_000, undefined, {
        coinBalance: 0,
        unitPrice: null,
      }),
    ).toBe(false);
    expect(instance.coinRecovery).toBeNull();
    expect(instance.storeRetryAfter).toBe(40_000);
  });

  it("pauses recovery without discarding identity when private coin authority is unavailable", () => {
    const instance = makeInstance(vi.fn());
    instance.storeRetryAfter = 40_000;
    instance.coinRecovery = {
      storeId: "tool_store",
      itemId: "bronze_hatchet",
      quantity: 1,
      expiresAt: 300_000,
    };

    expect(
      hasOrdinaryCoinRecoveryAuthorization(instance, 10_000, undefined, {
        coinBalance: null,
        unitPrice: 50,
      }),
    ).toBe(false);
    expect(instance.coinRecovery).not.toBeNull();
    expect(instance.storeRetryAfter).toBe(40_000);
  });
});
