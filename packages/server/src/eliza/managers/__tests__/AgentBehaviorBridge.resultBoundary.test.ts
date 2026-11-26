import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentBehaviorBridge,
  resolveAgentBehaviorWorkerPath,
} from "../AgentBehaviorBridge";

type BridgeInternals = {
  schedules: Map<
    string,
    { nextTickAt: number; tickInProgress: boolean; lastEjectedAt: number }
  >;
  reconcileTickResults(
    dueAgents: Array<{ characterId: string; behaviorEpoch: number }>,
    results: Array<{ characterId: string; behaviorEpoch: number }>,
  ): Array<{ characterId: string; behaviorEpoch: number }>;
  applyTickResultsConcurrently(
    results: Array<{ characterId: string; behaviorEpoch: number }>,
  ): Promise<void>;
  applyTickResultWithDrain: (result: {
    characterId: string;
    behaviorEpoch: number;
  }) => Promise<void>;
};

function createBridgeInternals(): BridgeInternals {
  const bridge = Object.create(
    AgentBehaviorBridge.prototype,
  ) as BridgeInternals;
  bridge.schedules = new Map();
  return bridge;
}

describe("AgentBehaviorBridge worker result boundary", () => {
  it("uses a bundled sibling worker before generated fallbacks", () => {
    const thisFile = "/repo/packages/server/dist/index.js";
    const sibling = "/repo/packages/server/dist/agentBehaviorWorker.js";

    expect(
      resolveAgentBehaviorWorkerPath(
        thisFile,
        (candidate) => candidate === sibling,
        () => 1,
      ),
    ).toBe(sibling);
  });

  it("uses the freshest generated worker for a direct source bridge", () => {
    const thisFile =
      "/repo/packages/server/src/eliza/managers/AgentBehaviorBridge.ts";
    const productionWorker = path.resolve(
      path.dirname(thisFile),
      "../../../dist/agentBehaviorWorker.js",
    );
    const developmentWorker = path.resolve(
      path.dirname(thisFile),
      "../../../build/agentBehaviorWorker.js",
    );
    const modified = new Map([
      [productionWorker, 20],
      [developmentWorker, 10],
    ]);

    expect(
      resolveAgentBehaviorWorkerPath(
        thisFile,
        (candidate) => modified.has(candidate),
        (candidate) => modified.get(candidate) ?? 0,
      ),
    ).toBe(productionWorker);
  });

  it("accepts only one current result per dispatched agent and releases every missing fence", () => {
    const bridge = createBridgeInternals();
    for (const characterId of ["agent-a", "agent-b", "agent-c"]) {
      bridge.schedules.set(characterId, {
        nextTickAt: 0,
        tickInProgress: true,
        lastEjectedAt: 0,
      });
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const accepted = bridge.reconcileTickResults(
      [
        { characterId: "agent-a", behaviorEpoch: 4 },
        { characterId: "agent-b", behaviorEpoch: 7 },
        { characterId: "agent-c", behaviorEpoch: 9 },
      ],
      [
        { characterId: "agent-a", behaviorEpoch: 4 },
        { characterId: "agent-a", behaviorEpoch: 4 },
        { characterId: "agent-b", behaviorEpoch: 6 },
        { characterId: "agent-unknown", behaviorEpoch: 1 },
      ],
    );

    expect(accepted).toEqual([{ characterId: "agent-a", behaviorEpoch: 4 }]);
    expect(bridge.schedules.get("agent-a")?.tickInProgress).toBe(true);
    expect(bridge.schedules.get("agent-b")?.tickInProgress).toBe(false);
    expect(bridge.schedules.get("agent-c")?.tickInProgress).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("duplicate worker result for agent-a"),
        expect.stringContaining("stale worker result for agent-b"),
        expect.stringContaining("unexpected worker result for agent-unknown"),
      ]),
    );
  });

  it("does not let one long-running action delay another agent's result", async () => {
    const bridge = createBridgeInternals();
    let releaseSlow!: () => void;
    const slowAction = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const completed: string[] = [];
    bridge.applyTickResultWithDrain = vi.fn(async (result) => {
      if (result.characterId === "agent-slow") await slowAction;
      completed.push(result.characterId);
    });

    const apply = bridge.applyTickResultsConcurrently([
      { characterId: "agent-slow", behaviorEpoch: 1 },
      { characterId: "agent-fast", behaviorEpoch: 1 },
    ]);

    await vi.waitFor(() =>
      expect(bridge.applyTickResultWithDrain).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(completed).toEqual(["agent-fast"]));

    releaseSlow();
    await apply;
    expect(completed).toEqual(["agent-fast", "agent-slow"]);
  });
});
