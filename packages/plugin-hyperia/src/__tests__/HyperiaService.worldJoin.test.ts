import { afterEach, describe, expect, it, vi } from "vitest";

import { HyperiaService } from "../services/HyperiaService.js";

vi.mock("../systems/liveKit.js", () => ({
  AgentLiveKit: class {
    async stop(): Promise<void> {}
  },
}));

type TestInternals = {
  characterId: string;
  connectionState: { connected: boolean };
  gameState: { playerEntity: { id: string } | null };
  handleSnapshot: (snapshotData: Record<string, unknown>) => Promise<void>;
  rejoinWorldAfterReconnect: () => Promise<void>;
  ws: { send: ReturnType<typeof vi.fn> };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("HyperiaService world join", () => {
  it("coalesces overlapping snapshot and reconnect joins for one socket", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const service = new HyperiaService({
      agentId: "agent-world-join-test",
      character: { name: "World Join Test" },
      getSetting: vi.fn().mockReturnValue(null),
    } as never);
    const internals = service as unknown as TestInternals;
    internals.characterId = "agent-world-join-character";
    internals.connectionState.connected = true;
    internals.gameState.playerEntity = { id: internals.characterId };
    internals.ws = { send };

    const reconnectJoin = internals.rejoinWorldAfterReconnect();
    const snapshotJoin = internals.handleSnapshot({});

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([snapshotJoin, reconnectJoin]);

    expect(send).toHaveBeenCalledTimes(2);
  });
});
