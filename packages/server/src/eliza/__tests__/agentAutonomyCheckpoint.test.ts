import { describe, expect, it } from "vitest";

import {
  hydrateAgentFromAutonomyCheckpoint,
  normalizeAgentAutonomyCheckpoint,
} from "../agentAutonomyCheckpoint";
import type { AgentInstance } from "../managers/AgentBehaviorTicker";

function validCheckpoint() {
  return {
    schemaVersion: 3,
    characterId: "agent-1",
    revision: 7,
    goal: { type: "combat", description: "Train safely near town" },
    plan: {
      steps: ["Find a legal target", "Reassess health", "Return to town"],
      currentStep: 1,
      createdAt: 1_000,
      goal: "Train safely near town",
    },
    memories: ["The west field has low-level creatures"],
    recentActionLog: [{ tick: 12, action: "gather", result: "Collected wood" }],
    tickCounter: 13,
    lastAppliedActionType: "gather",
    lastAppliedAt: 2_000,
    lastAttemptedActionType: "gather",
    lastActionOutcome: "dispatched",
    lastAttemptedAt: 2_000,
    requiresReassessment: true,
    updatedAt: 2_000,
  };
}

describe("agent autonomy checkpoints", () => {
  it("accepts bounded advisory context with no executable action payload", () => {
    const checkpoint = normalizeAgentAutonomyCheckpoint(validCheckpoint());

    expect(checkpoint).toMatchObject({
      characterId: "agent-1",
      revision: 7,
      tickCounter: 13,
      lastAppliedActionType: "gather",
      lastAttemptedActionType: "gather",
      lastActionOutcome: "dispatched",
      requiresReassessment: true,
    });
    expect(checkpoint).not.toHaveProperty("pendingAction");
    expect(checkpoint).not.toHaveProperty("targetId");
  });

  it("persists only the bounded server-derived bank purposes", () => {
    const checkpoint = normalizeAgentAutonomyCheckpoint({
      ...validCheckpoint(),
      goal: {
        type: "banking",
        description: "Stage survival food",
        bankPurpose: "survival_food",
      },
    });

    expect(checkpoint.goal).toEqual({
      type: "banking",
      description: "Stage survival food",
      bankPurpose: "survival_food",
    });
    expect(
      normalizeAgentAutonomyCheckpoint({
        ...validCheckpoint(),
        goal: {
          type: "banking",
          description: "Check exact combat supplies",
          bankPurpose: "combat_supply",
        },
      }).goal,
    ).toEqual({
      type: "banking",
      description: "Check exact combat supplies",
      bankPurpose: "combat_supply",
    });
    for (const goal of [
      {
        type: "banking",
        description: "Stage arbitrary custody",
        bankPurpose: "arbitrary_items",
      },
      {
        type: "combat",
        description: "Invalid cross-purpose goal",
        bankPurpose: "survival_food",
      },
    ]) {
      expect(() =>
        normalizeAgentAutonomyCheckpoint({ ...validCheckpoint(), goal }),
      ).toThrow("agent_autonomy_checkpoint_goal_invalid");
    }
  });

  it.each([
    ["a replayable recovery flag", { requiresReassessment: false }],
    ["an unknown action type", { lastAppliedActionType: "transferFunds" }],
    ["an unknown action outcome", { lastActionOutcome: "pretended_success" }],
    ["an incomplete attempt bundle", { lastAttemptedAt: null }],
    [
      "a dispatched action without an applied action",
      { lastAppliedActionType: null, lastAppliedAt: null },
    ],
    [
      "an out-of-range plan step",
      { plan: { ...validCheckpoint().plan, currentStep: 3 } },
    ],
    [
      "an executable field hidden in the goal",
      { goal: { ...validCheckpoint().goal, targetId: "mob-1" } },
    ],
    [
      "too many memories",
      { memories: Array.from({ length: 13 }, (_, index) => `memory-${index}`) },
    ],
  ])("rejects %s", (_label, mutation) => {
    expect(() =>
      normalizeAgentAutonomyCheckpoint({
        ...validCheckpoint(),
        ...mutation,
      }),
    ).toThrow(/agent_autonomy_checkpoint/u);
  });

  it("hydrates isolated context, clears any pending command, and requires a fresh decision", () => {
    const checkpoint = normalizeAgentAutonomyCheckpoint(validCheckpoint());
    const instance = {
      config: { characterId: "agent-1" },
      goal: null,
      pendingLlmResult: {
        action: { type: "attack", targetId: "stale-target" },
      },
    } as unknown as AgentInstance;

    hydrateAgentFromAutonomyCheckpoint(instance, checkpoint);

    expect(instance.goal).toEqual(checkpoint.goal);
    expect(instance.llmPlan).toEqual(checkpoint.plan);
    expect(instance.memories).toEqual(checkpoint.memories);
    expect(instance.pendingLlmResult).toBeUndefined();
    expect(instance.autonomyCheckpointRevision).toBe(7);
    expect(instance.autonomyRecoveryPending).toBe(true);
  });

  it("never hydrates one agent from another agent's checkpoint", () => {
    const instance = {
      config: { characterId: "agent-2" },
    } as unknown as AgentInstance;

    expect(() =>
      hydrateAgentFromAutonomyCheckpoint(
        instance,
        normalizeAgentAutonomyCheckpoint(validCheckpoint()),
      ),
    ).toThrow("agent_autonomy_checkpoint_character_mismatch");
  });
});
