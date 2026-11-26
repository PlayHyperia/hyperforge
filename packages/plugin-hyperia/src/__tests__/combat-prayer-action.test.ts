import { describe, expect, it, vi } from "vitest";
import { togglePrayerAction } from "../actions/combat.js";
import type { PrayerActionReceipt } from "../types.js";

function receipt(
  overrides: Partial<PrayerActionReceipt> = {},
): PrayerActionReceipt {
  return {
    success: true,
    committed: true,
    playerId: "agent-prayer",
    operationId: "network-prayer-toggle:operation",
    replayed: false,
    pointUnits: 10_000_000,
    points: 10,
    maxPoints: 20,
    activePrayers: ["rock_skin"],
    ...overrides,
  };
}

function runtimeWith(service: object) {
  return {
    getService: vi.fn().mockReturnValue(service),
  } as never;
}

describe("TOGGLE_PRAYER action", () => {
  it("advertises only manifest-driven behavior and an authored example", () => {
    expect(togglePrayerAction.description).toContain("current game manifest");
    expect(togglePrayerAction.description).toContain("rock_skin");
    expect(togglePrayerAction.description).not.toMatch(
      /protect_from_|piety|eagle_eye|mystic_might/u,
    );
  });

  it("fails closed before transport for an unknown Prayer", async () => {
    const executeTogglePrayer = vi.fn();
    const callback = vi.fn();
    const result = await togglePrayerAction.handler!(
      runtimeWith({ executeTogglePrayer }),
      { content: { text: "pray unknown_prayer" } } as never,
      undefined,
      undefined,
      callback,
    );

    expect(result).toMatchObject({ success: false });
    expect(executeTogglePrayer).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ error: true }),
    );
  });

  it("reports the exact committed state from the authoritative receipt", async () => {
    const executeTogglePrayer = vi.fn().mockResolvedValue(receipt());
    const callback = vi.fn();
    const result = await togglePrayerAction.handler!(
      runtimeWith({ executeTogglePrayer }),
      { content: { text: "activate rock skin" } } as never,
      undefined,
      undefined,
      callback,
    );

    expect(executeTogglePrayer).toHaveBeenCalledWith("rock_skin");
    expect(result).toMatchObject({
      success: true,
      text: "Prayer rock_skin is active.",
      data: { active: true },
    });
    expect(callback).toHaveBeenCalledWith({
      text: "Prayer rock_skin is active.",
      action: "TOGGLE_PRAYER",
    });
  });

  it("does not announce a rejected request as toggled", async () => {
    const executeTogglePrayer = vi.fn().mockResolvedValue(
      receipt({
        success: false,
        committed: false,
        activePrayers: [],
        reason: "level_requirement",
        message: "Requires prayer level 10",
      }),
    );
    const callback = vi.fn();
    const result = await togglePrayerAction.handler!(
      runtimeWith({ executeTogglePrayer }),
      { content: { text: "pray rock_skin" } } as never,
      undefined,
      undefined,
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      text: "Prayer request rejected: Requires prayer level 10",
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ error: true }),
    );
  });
});
