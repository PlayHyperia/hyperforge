import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { attackEntityAction } from "../actions/combat";
import { lightFireAction, cookFoodAction } from "../actions/skills";

function createRuntime(player: Record<string, unknown>) {
  const service = {
    isConnected: vi.fn().mockReturnValue(true),
    getPlayerEntity: vi.fn().mockReturnValue(player),
    getNearbyEntities: vi
      .fn()
      .mockReturnValue([{ id: "fire-1", name: "Campfire", type: "fire" }]),
  };

  return {
    getService: vi.fn().mockReturnValue(service),
  };
}

describe("alive validation handling", () => {
  it("treats undefined alive as alive for ATTACK_TARGET validate", async () => {
    const runtime = createRuntime({
      inCombat: false,
      alive: undefined,
      items: [],
    });

    const valid = await attackEntityAction.validate(
      runtime as never,
      { content: { text: "attack goblin" } } as never,
    );

    expect(valid).toBe(true);
  });

  it("treats undefined alive as alive for LIGHT_FIRE validate", async () => {
    const runtime = createRuntime({
      inCombat: false,
      alive: undefined,
      items: [
        { id: "1", name: "Tinderbox", quantity: 1 },
        { id: "2", name: "Logs", quantity: 5 },
      ],
    });

    const valid = await lightFireAction.validate(runtime as never);

    expect(valid).toBe(true);
  });

  it("treats undefined alive as alive for COOK_FOOD validate", async () => {
    const runtime = createRuntime({
      inCombat: false,
      alive: undefined,
      items: [{ id: "1", name: "Raw Shrimp", quantity: 3 }],
    });

    const valid = await cookFoodAction.validate(runtime as never);

    expect(valid).toBe(true);
  });

  it("does not trust a cooking-source display-name lookalike", async () => {
    const runtime = createRuntime({
      inCombat: false,
      alive: true,
      items: [{ id: "1", name: "Raw Shrimp", quantity: 1 }],
    });
    runtime
      .getService()
      .getNearbyEntities.mockReturnValue([
        { id: "spoof", name: "Cooking Fire", type: "decoration" },
      ]);

    expect(await cookFoodAction.validate(runtime as never)).toBe(false);
  });

  it("does not report cooking success without authoritative completion", async () => {
    const service = {
      isConnected: vi.fn().mockReturnValue(true),
      getPlayerEntity: vi.fn().mockReturnValue({
        inCombat: false,
        alive: true,
        items: [{ id: "1", name: "Raw Shrimp", quantity: 1 }],
      }),
      getNearbyEntities: vi
        .fn()
        .mockReturnValue([{ id: "fire-1", name: "Fire", type: "fire" }]),
      executeCooking: vi.fn().mockResolvedValue(false),
    };
    const runtime = { getService: vi.fn().mockReturnValue(service) };

    const result = await cookFoodAction.handler(
      runtime as never,
      { content: { text: "cook" } } as never,
    );
    expect(result).toMatchObject({ success: false });
  });

  it("does not report firemaking success without authoritative completion", async () => {
    const service = {
      isConnected: vi.fn().mockReturnValue(true),
      getPlayerEntity: vi.fn().mockReturnValue({
        inCombat: false,
        alive: true,
        items: [
          { id: "1", name: "Tinderbox", quantity: 1 },
          { id: "2", name: "Logs", quantity: 1 },
        ],
      }),
      executeFiremaking: vi.fn().mockResolvedValue(false),
    };
    const runtime = { getService: vi.fn().mockReturnValue(service) };

    const result = await lightFireAction.handler(
      runtime as never,
      { content: { text: "light fire" } } as never,
    );
    expect(result).toMatchObject({ success: false });
  });
});
