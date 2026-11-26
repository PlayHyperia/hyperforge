import { describe, expect, it, vi } from "vitest";

import { AutonomousBehaviorManager } from "../managers/autonomous-behavior-manager.js";

const preparationId = "11111111-1111-4111-8111-111111111111";

function harness() {
  const service = {
    getPlayerEntity: vi.fn(() => ({
      id: "external-agent",
      health: { current: 20, max: 20 },
      items: [],
      inCombat: false,
    })),
    executeMove: vi.fn(async () => undefined),
    openBank: vi.fn(async () => true),
    bankDepositAll: vi.fn(async () => true),
    bankWithdraw: vi.fn(async () => true),
    closeBank: vi.fn(async () => undefined),
    requestQuestList: vi.fn(),
    requestBankState: vi.fn(),
  };
  const runtime = {
    agentId: "external-agent",
    character: { name: "External Agent" },
    getSetting: vi.fn(() => null),
    getService: vi.fn(() => service),
    useModel: vi.fn(),
  };
  const manager = new AutonomousBehaviorManager(runtime as never);
  (manager as unknown as { service: unknown }).service = service;
  return { manager, service };
}

describe("external private duel preparation", () => {
  it("suspends legacy bank/navigation mutations and accepts only correlated readiness", async () => {
    const { manager, service } = harness();
    const internals = manager as unknown as {
      onDuelOnDeck(data: Record<string, unknown>): void;
      duelPrepTick(): Promise<void>;
      duelPreparationStatusEventHandler(data: unknown): void;
      duelPrepStep: string;
    };

    internals.onDuelOnDeck({
      preparationId,
      opponentId: "opponent",
      opponentName: "Opponent",
    });
    await internals.duelPrepTick();

    expect(internals.duelPrepStep).toBe("server_authoritative");
    expect(service.executeMove).not.toHaveBeenCalled();
    expect(service.openBank).not.toHaveBeenCalled();
    expect(service.bankDepositAll).not.toHaveBeenCalled();
    expect(service.bankWithdraw).not.toHaveBeenCalled();

    internals.duelPreparationStatusEventHandler({
      preparationId: "22222222-2222-4222-8222-222222222222",
      status: "ready",
    });
    expect(internals.duelPrepStep).toBe("server_authoritative");

    internals.duelPreparationStatusEventHandler({
      preparationId,
      status: "ready",
    });
    expect(internals.duelPrepStep).toBe("ready");
  });

  it("does not start a second plugin combat controller for a server-authoritative fight", async () => {
    const { manager } = harness();
    const internals = manager as unknown as {
      onDuelOnDeck(data: Record<string, unknown>): void;
      onDuelSessionStarted(data: unknown): void;
      onDuelFightStart(data: unknown): void;
      duelCombatTick(): Promise<void>;
      tick(): Promise<void>;
    };
    const combatTick = vi
      .spyOn(internals, "duelCombatTick")
      .mockResolvedValue(undefined);

    internals.onDuelOnDeck({
      preparationId,
      opponentId: "opponent",
      opponentName: "Opponent",
    });
    internals.onDuelSessionStarted({
      duelId: "duel-1",
      opponentId: "opponent",
      opponentName: "Opponent",
    });
    internals.onDuelFightStart({
      duelId: "duel-1",
      opponentId: "opponent",
      bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
    });
    await internals.tick();

    expect(combatTick).not.toHaveBeenCalled();
  });
});
