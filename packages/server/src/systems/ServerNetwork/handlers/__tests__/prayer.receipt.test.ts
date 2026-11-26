import { describe, expect, it, vi } from "vitest";
import { handlePrayerToggle } from "../prayer";
import type {
  PrayerActionReceipt,
  PrayerCustodyView,
  World,
} from "@hyperforge/shared";

function custody(
  overrides: Partial<PrayerCustodyView> = {},
): PrayerCustodyView {
  return {
    ready: true,
    persistenceHealthy: true,
    pointUnits: 10_000_000,
    points: 10,
    maxPoints: 20,
    activePrayers: [],
    ...overrides,
  };
}

function createHarness(playerId: string, receiptOverrides = {}) {
  const executePrayerToggleRequest = vi.fn(
    async (
      requestedPlayerId: string,
      _prayerId: string,
      operationId: string,
    ): Promise<PrayerActionReceipt> => ({
      success: true,
      committed: true,
      playerId: requestedPlayerId,
      operationId,
      replayed: false,
      pointUnits: 9_000_000,
      points: 9,
      maxPoints: 20,
      activePrayers: ["rock_skin"],
      ...receiptOverrides,
    }),
  );
  const prayerSystem = {
    executePrayerToggleRequest,
    getPrayerCustody: vi.fn().mockReturnValue(custody()),
  };
  const world = {
    emit: vi.fn(),
    getSystem: vi.fn((name: string) =>
      name === "prayer" ? prayerSystem : null,
    ),
  } as unknown as World;
  const send = vi.fn();
  const socket = { player: { id: playerId }, send } as never;
  return { executePrayerToggleRequest, send, socket, world };
}

describe("Prayer network receipts", () => {
  it("returns the exact server receipt under the client correlation ID", async () => {
    const harness = createHarness("prayer-receipt-player-1");
    const requestId = "00000000-0000-4000-8000-000000000001";

    await handlePrayerToggle(
      harness.socket,
      { prayerId: "rock_skin", requestId, timestamp: Date.now() },
      harness.world,
    );

    expect(harness.executePrayerToggleRequest).toHaveBeenCalledWith(
      "prayer-receipt-player-1",
      "rock_skin",
      expect.stringMatching(
        /^network-prayer-toggle:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    );
    expect(harness.send).toHaveBeenCalledWith(
      "prayerActionReceipt",
      expect.objectContaining({
        requestId,
        success: true,
        committed: true,
        playerId: "prayer-receipt-player-1",
        activePrayers: ["rock_skin"],
      }),
    );
    expect(
      (harness.world as never as { emit: ReturnType<typeof vi.fn> }).emit,
    ).not.toHaveBeenCalled();
  });

  it("returns and surfaces an authoritative rejection without claiming success", async () => {
    const harness = createHarness("prayer-receipt-player-2", {
      success: false,
      committed: false,
      pointUnits: 10_000_000,
      points: 10,
      activePrayers: [],
      reason: "level_requirement",
      message: "Requires prayer level 10",
    });
    const requestId = "00000000-0000-4000-8000-000000000002";

    await handlePrayerToggle(
      harness.socket,
      { prayerId: "rock_skin", requestId, timestamp: Date.now() },
      harness.world,
    );

    expect(harness.send).toHaveBeenCalledWith("showToast", {
      message: "Requires prayer level 10",
      type: "error",
    });
    expect(harness.send).toHaveBeenCalledWith(
      "prayerActionReceipt",
      expect.objectContaining({
        requestId,
        success: false,
        committed: false,
        reason: "level_requirement",
      }),
    );
  });
});
