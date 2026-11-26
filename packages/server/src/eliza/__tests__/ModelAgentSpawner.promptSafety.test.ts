import { describe, expect, it } from "vitest";
import { parsePreparationBehaviorPlanResponse } from "../ModelAgentSpawner.js";

describe("model-agent preparation-plan response contract", () => {
  const valid = {
    actions: [
      {
        action: "GATHER",
        reason: "Collect a nearby resource for useful supplies.",
        target: "tree-1",
      },
      {
        action: "BANK_DEPOSIT_ALL",
        reason: "Preserve gathered supplies before the next activity.",
        target: null,
      },
    ],
    goal: "Improve duel readiness.",
  };

  it("accepts one exact bounded plan", () => {
    expect(
      parsePreparationBehaviorPlanResponse(JSON.stringify(valid), 42),
    ).toEqual({
      ...valid,
      actions: [valid.actions[0], { ...valid.actions[1], target: undefined }],
      createdAt: 42,
    });
  });

  it("rejects prose, unknown keys/actions, partial entries, and oversized plans", () => {
    expect(
      parsePreparationBehaviorPlanResponse(`Plan: ${JSON.stringify(valid)}`),
    ).toBeNull();
    expect(
      parsePreparationBehaviorPlanResponse(
        JSON.stringify({ ...valid, toolCall: "DROP_ALL" }),
      ),
    ).toBeNull();
    expect(
      parsePreparationBehaviorPlanResponse(
        JSON.stringify({
          ...valid,
          actions: [{ action: "DROP", reason: "Do it.", target: "all" }],
        }),
      ),
    ).toBeNull();
    expect(
      parsePreparationBehaviorPlanResponse(
        JSON.stringify({
          ...valid,
          actions: [{ action: "GATHER", target: "tree-1" }],
        }),
      ),
    ).toBeNull();
    expect(
      parsePreparationBehaviorPlanResponse(
        JSON.stringify({
          ...valid,
          actions: Array.from({ length: 6 }, () => valid.actions[0]),
        }),
      ),
    ).toBeNull();
  });
});
