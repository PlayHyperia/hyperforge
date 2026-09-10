import { describe, expect, it, vi } from "vitest";

import { handleDuelPreparationStrategy } from "../duel/preparation-strategy.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const preparationId = "22222222-2222-4222-8222-222222222222";

const decision = {
  planOptionId: "33333333-3333-4333-8333-333333333333",
  primaryStyle: "ranged",
  reason: "Preserve range.",
  tacticalStrategy: {
    approach: "balanced",
    tacticalMacro: "kite",
    attackStyle: "accurate",
    prayer: null,
    preferredCombatRole: "ranged",
    foodThreshold: 40,
    switchDefensiveAt: 30,
    reasoning: "Maintain space and adapt.",
  },
};

function harness(authenticated = true) {
  const emit = vi.fn();
  return {
    emit,
    socket: {
      player: authenticated ? { id: "external-agent" } : undefined,
    } as never,
    world: { emit } as never,
  };
}

describe("external duel preparation strategy response", () => {
  it("derives contestant identity from the authenticated socket", () => {
    const state = harness();
    handleDuelPreparationStrategy(
      state.socket,
      { requestId, preparationId, status: "selected", decision },
      state.world,
    );

    expect(state.emit).toHaveBeenCalledWith(
      "duel:preparation:external_strategy_response",
      {
        agentId: "external-agent",
        requestId,
        preparationId,
        status: "selected",
        decision,
      },
    );
  });

  it("rejects caller-selected identity and oversized decisions", () => {
    const state = harness();
    handleDuelPreparationStrategy(
      state.socket,
      {
        requestId,
        preparationId,
        status: "selected",
        decision,
        agentId: "forged-agent",
      },
      state.world,
    );
    handleDuelPreparationStrategy(
      state.socket,
      {
        requestId,
        preparationId,
        status: "selected",
        decision: { ...decision, reason: "x".repeat(5_000) },
      },
      state.world,
    );

    expect(state.emit).not.toHaveBeenCalled();
  });

  it("requires an authenticated contestant and exact fallback shape", () => {
    const unauthenticated = harness(false);
    handleDuelPreparationStrategy(
      unauthenticated.socket,
      { requestId, preparationId, status: "fallback", decision: null },
      unauthenticated.world,
    );
    expect(unauthenticated.emit).not.toHaveBeenCalled();

    const malformed = harness();
    handleDuelPreparationStrategy(
      malformed.socket,
      { requestId, preparationId, status: "fallback", decision },
      malformed.world,
    );
    expect(malformed.emit).not.toHaveBeenCalled();
  });
});
