import { afterEach, describe, expect, it, vi } from "vitest";
import { HyperiaService } from "../services/HyperiaService";
import type { PrayerActionReceipt } from "../types";

vi.mock("../systems/liveKit.js", () => ({
  AgentLiveKit: class {
    async stop(): Promise<void> {}
  },
}));

type PrayerTestInternals = {
  cancelPendingPrayerResponses: (message: string) => void;
  characterId: string;
  connectionState: { connected: boolean };
  gameState: {
    playerEntity: {
      id: string;
      activePrayers?: string[];
      prayerPointUnits?: number;
      prayerPoints?: number;
      prayerMaxPoints?: number;
    } | null;
  };
  sendCommand: (command: string, data: unknown) => void;
  updateGameStateFromPacket: (packetName: string, data: unknown) => void;
  ws: object | null;
};

function createService() {
  const service = new HyperiaService({
    agentId: "agent-prayer",
    getSetting: vi.fn().mockReturnValue(null),
  } as never);
  const internals = service as unknown as PrayerTestInternals;
  const sendCommand = vi.fn();
  internals.characterId = "agent-prayer";
  internals.connectionState.connected = true;
  internals.ws = {};
  internals.gameState.playerEntity = {
    id: "agent-prayer",
    activePrayers: [],
    prayerPointUnits: 10_000_000,
    prayerPoints: 10,
    prayerMaxPoints: 20,
  };
  internals.sendCommand = sendCommand;
  return { service, internals, sendCommand };
}

function authoritativeReceipt(
  requestId: string,
  overrides: Partial<PrayerActionReceipt> = {},
) {
  return {
    requestId,
    success: true,
    committed: true,
    playerId: "agent-prayer",
    operationId: "network-prayer-toggle:server-owned-operation",
    replayed: false,
    pointUnits: 9_000_000,
    points: 9,
    maxPoints: 20,
    activePrayers: ["rock_skin"],
    ...overrides,
  };
}

describe("HyperiaService Prayer acknowledgements", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles only from the exact correlated authoritative receipt", async () => {
    const { service, internals, sendCommand } = createService();
    const pending = service.executeTogglePrayer("rock_skin");
    const sent = sendCommand.mock.calls[0]?.[1] as {
      prayerId: string;
      requestId: string;
      timestamp: number;
    };
    expect(sent).toMatchObject({
      prayerId: "rock_skin",
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      timestamp: expect.any(Number),
    });

    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    internals.updateGameStateFromPacket(
      "prayerActionReceipt",
      authoritativeReceipt("00000000-0000-4000-8000-000000000001"),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    internals.updateGameStateFromPacket(
      "prayerActionReceipt",
      authoritativeReceipt(sent.requestId),
    );
    await expect(pending).resolves.toMatchObject({
      success: true,
      activePrayers: ["rock_skin"],
    });
    expect(internals.gameState.playerEntity).toMatchObject({
      activePrayers: ["rock_skin"],
      prayerPointUnits: 9_000_000,
      prayerPoints: 9,
      prayerMaxPoints: 20,
    });
  });

  it("fails closed on timeout without inventing a committed transition", async () => {
    vi.useFakeTimers();
    const { service } = createService();
    const pending = service.executeTogglePrayer("rock_skin");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toMatchObject({
      success: false,
      committed: false,
      reason: "persistence_failed",
      message:
        "Prayer request timed out before an authoritative receipt arrived",
      activePrayers: [],
    });
  });

  it("releases an in-flight waiter when the transport closes", async () => {
    const { service, internals } = createService();
    const pending = service.executeTogglePrayer("rock_skin");
    internals.cancelPendingPrayerResponses("connection closed");

    await expect(pending).resolves.toMatchObject({
      success: false,
      committed: false,
      message: "connection closed",
    });
  });
});
