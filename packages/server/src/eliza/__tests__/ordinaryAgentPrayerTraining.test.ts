import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  executeOrdinaryBoneBurial,
  getOrdinaryBoneBurialOperationId,
} from "../ordinaryAgentPrayerTraining";
import type { AgentInstance } from "../managers/AgentBehaviorTicker";

function makeInstance(executeBury: ReturnType<typeof vi.fn>): AgentInstance {
  return {
    state: "running",
    service: { executeBury },
  } as unknown as AgentInstance;
}

describe("ordinary agent prayer training", () => {
  it("accepts every buryable resource in the production item manifest", async () => {
    const manifestPath = new URL(
      "../../../world/assets/manifests/items/resources.json",
      import.meta.url,
    );
    const resources = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as Array<{
      id?: unknown;
      prayerXp?: unknown;
      buryLevelRequired?: unknown;
      inventoryActions?: unknown;
    }>;
    const buryable = resources.filter(
      (resource) =>
        Array.isArray(resource.inventoryActions) &&
        resource.inventoryActions.includes("Bury"),
    );

    expect(buryable.map((resource) => resource.id)).toEqual([
      "bones",
      "big_bones",
      "dragon_bones",
    ]);
    for (const resource of buryable) {
      expect(Number.isSafeInteger(resource.prayerXp)).toBe(true);
      expect(resource.prayerXp).toEqual(expect.any(Number));
      expect(resource.prayerXp as number).toBeGreaterThan(0);
      expect(resource.buryLevelRequired ?? 1).toEqual(expect.any(Number));
      expect(Number.isSafeInteger(resource.buryLevelRequired ?? 1)).toBe(true);
    }
  });

  it("derives a stable namespace-separated UUIDv5 from the immutable attempt", () => {
    const attemptId = "e564ace4-fe5d-4022-9e8d-5cf6c7252841";
    expect(getOrdinaryBoneBurialOperationId(attemptId)).toBe(
      getOrdinaryBoneBurialOperationId(attemptId),
    );
    expect(getOrdinaryBoneBurialOperationId(attemptId)).not.toBe(attemptId);
    expect(getOrdinaryBoneBurialOperationId(attemptId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("replays the exact operation until committed custody is live", async () => {
    const executeBury = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        committed: true,
        liveStateApplied: false,
        retryable: true,
        reason: "live_state_apply_failed",
      })
      .mockResolvedValueOnce({
        ok: true,
        committed: true,
        liveStateApplied: true,
        replayed: true,
        retryable: false,
      });
    const attempt = {
      attemptId: "ebd7fe46-722c-4894-9c30-e99ae3f51901",
    } as never;
    const result = await executeOrdinaryBoneBurial(
      makeInstance(executeBury),
      "bones",
      attempt,
    );

    expect(result).toMatchObject({
      settled: true,
      applied: true,
      reconciliationAttempts: 2,
    });
    expect(executeBury).toHaveBeenCalledTimes(2);
    expect(executeBury.mock.calls[0]).toEqual(executeBury.mock.calls[1]);
    expect(executeBury.mock.calls[0]).toEqual([
      "bones",
      getOrdinaryBoneBurialOperationId("ebd7fe46-722c-4894-9c30-e99ae3f51901"),
    ]);
  });

  it("does not retry a definitive rejection", async () => {
    const executeBury = vi.fn(async () => ({
      ok: false,
      committed: false,
      liveStateApplied: false,
      retryable: false,
      reason: "item_missing",
    }));
    await expect(
      executeOrdinaryBoneBurial(makeInstance(executeBury), "bones", {
        attemptId: "dce573d7-2817-4af5-8f79-06eec7e53d67",
      } as never),
    ).resolves.toMatchObject({
      settled: true,
      applied: false,
      reconciliationAttempts: 1,
    });
    expect(executeBury).toHaveBeenCalledOnce();
  });
});
