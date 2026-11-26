import { describe, expect, it, vi } from "vitest";

import type { AgentTickOutput } from "../../worker/workerTypes.js";
import type { AgentInstance } from "../AgentBehaviorTicker.js";
import { AgentBehaviorBridge } from "../AgentBehaviorBridge.js";

type BridgeProcessingInternals = {
  applyTickResult(result: AgentTickOutput): Promise<void>;
};

function makeInstance(
  executeFiremake: ReturnType<typeof vi.fn>,
  executeGather: ReturnType<typeof vi.fn> = vi.fn(),
): AgentInstance {
  return {
    config: {
      characterId: "processing-retry-agent",
      accountId: "processing-retry-account",
      name: "Processing Retry Agent",
    },
    service: {
      executeFiremake,
      executeGather,
      executeMove: vi.fn().mockResolvedValue(true),
      getQuestState: vi.fn().mockReturnValue([]),
      getAvailableQuests: vi.fn().mockReturnValue([]),
      getGameState: vi.fn().mockReturnValue(null),
    },
    chatRuntime: null,
    state: "running",
    startedAt: Date.now(),
    lastActivity: 0,
    behaviorEpoch: 7,
    goal: null,
    questsAccepted: new Set(),
    currentTargetId: null,
    lastGatherTargetId: null,
    lastGatherQueuedAt: 0,
    lastCombatChatAt: 0,
    pendingChatReaction: null,
    navigationTarget: null,
    operatorCommandAt: 0,
    ordinaryProcessingRetries: [],
  } as unknown as AgentInstance;
}

function firemakingResult(): AgentTickOutput {
  return {
    characterId: "processing-retry-agent",
    behaviorEpoch: 7,
    action: { type: "firemake", logsItemId: "logs" },
    updatedState: {
      goal: {
        type: "provisioning",
        description: "Process an authored Firemaking recipe",
      },
      questsAccepted: [],
      currentTargetId: null,
      lastGatherTargetId: null,
      lastGatherQueuedAt: 0,
      lastCombatChatAt: 0,
    },
  };
}

describe("AgentBehaviorBridge processing retry authority", () => {
  it("commits a gather throttle only after the exact first reward completes", async () => {
    const executeGather = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("reservation authority unavailable"))
      .mockResolvedValueOnce(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const instance = makeInstance(vi.fn(), executeGather);
    instance.lastGatherTargetId = "previous-resource";
    instance.lastGatherQueuedAt = 41;
    let attemptSequence = 0;
    const bridge = new AgentBehaviorBridge(
      { entities: { get: vi.fn() } } as never,
      (characterId) =>
        characterId === instance.config.characterId ? instance : undefined,
      () => [instance.config.characterId],
      undefined,
      async (_candidate, actionType, decisionSource) => {
        attemptSequence += 1;
        return {
          attemptId: `11111111-1111-4111-8111-${String(attemptSequence).padStart(12, "0")}`,
          characterId: instance.config.characterId,
          phase: "ordinary_progression",
          goalType: "gathering",
          actionType,
          decisionSource,
          startedAt: 100 + attemptSequence,
        };
      },
    );
    const internals = bridge as unknown as BridgeProcessingInternals;
    const gatherResult = (queuedAt: number): AgentTickOutput => ({
      characterId: "processing-retry-agent",
      behaviorEpoch: 7,
      action: { type: "gather", targetId: "contended-resource" },
      updatedState: {
        goal: {
          type: "gathering",
          description: "Gather an exact combat-supply dependency",
        },
        questsAccepted: [],
        currentTargetId: null,
        lastGatherTargetId: "contended-resource",
        lastGatherQueuedAt: queuedAt,
        lastCombatChatAt: 0,
      },
    });

    await internals.applyTickResult(gatherResult(100));
    expect(executeGather).toHaveBeenCalledTimes(1);
    expect(executeGather).toHaveBeenLastCalledWith(
      "contended-resource",
      "11111111-1111-4111-8111-000000000001",
    );
    expect(instance.lastGatherTargetId).toBe("previous-resource");
    expect(instance.lastGatherQueuedAt).toBe(41);

    await internals.applyTickResult(gatherResult(101));
    expect(executeGather).toHaveBeenCalledTimes(2);
    expect(instance.lastGatherTargetId).toBe("previous-resource");
    expect(instance.lastGatherQueuedAt).toBe(41);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Action gather failed"),
    );

    await internals.applyTickResult(gatherResult(102));
    expect(executeGather).toHaveBeenCalledTimes(3);
    expect(executeGather).toHaveBeenLastCalledWith(
      "contended-resource",
      "11111111-1111-4111-8111-000000000003",
    );
    expect(instance.lastGatherTargetId).toBe("contended-resource");
    expect(instance.lastGatherQueuedAt).toBe(102);

    await internals.applyTickResult({
      characterId: "processing-retry-agent",
      behaviorEpoch: 7,
      action: { type: "move", target: [5, 0, 5], runMode: true },
      updatedState: {
        goal: {
          type: "cooking",
          description: "Move to the authored range",
        },
        questsAccepted: [],
        currentTargetId: null,
        lastGatherTargetId: "contended-resource",
        lastGatherQueuedAt: 102,
        lastCombatChatAt: 0,
      },
    });
    expect(instance.lastGatherTargetId).toBeNull();
    expect(instance.lastGatherQueuedAt).toBe(0);
  });

  it("records rejection truth, blocks an immediate stale retry, and clears after a later success", async () => {
    const executeFiremake = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const instance = makeInstance(executeFiremake);
    let attemptSequence = 0;
    const bridge = new AgentBehaviorBridge(
      { entities: { get: vi.fn() } } as never,
      (characterId) =>
        characterId === instance.config.characterId ? instance : undefined,
      () => [instance.config.characterId],
      undefined,
      async (_candidate, actionType, decisionSource) => {
        attemptSequence += 1;
        return {
          attemptId: `22222222-2222-4222-8222-${String(attemptSequence).padStart(12, "0")}`,
          characterId: instance.config.characterId,
          phase: "ordinary_progression",
          goalType: "provisioning",
          actionType,
          decisionSource,
          startedAt: 200 + attemptSequence,
        };
      },
    );
    const internals = bridge as unknown as BridgeProcessingInternals;

    await internals.applyTickResult(firemakingResult());
    expect(executeFiremake).toHaveBeenCalledTimes(1);
    expect(executeFiremake).toHaveBeenLastCalledWith(
      "logs",
      "22222222-2222-4222-8222-000000000001",
    );
    expect(instance.ordinaryProcessingRetries).toEqual([
      expect.objectContaining({
        actionType: "firemake",
        intentId: "logs",
        consecutiveFailures: 1,
      }),
    ]);

    await internals.applyTickResult(firemakingResult());
    expect(executeFiremake).toHaveBeenCalledTimes(1);

    instance.ordinaryProcessingRetries[0].retryAfter = Date.now() - 1;
    await internals.applyTickResult(firemakingResult());
    expect(executeFiremake).toHaveBeenCalledTimes(2);
    expect(executeFiremake).toHaveBeenLastCalledWith(
      "logs",
      "22222222-2222-4222-8222-000000000002",
    );
    expect(instance.ordinaryProcessingRetries).toEqual([]);
  });
});
