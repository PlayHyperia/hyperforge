import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDuelEventListeners } from "../duel-events";

type Handler = (payload: unknown) => void;

function createHarness(
  entities: Map<string, { data: Record<string, unknown> }>,
  sockets: Map<string, { send: ReturnType<typeof vi.fn> }> = new Map(),
) {
  const handlers = new Map<string, Set<Handler>>();
  const world = {
    entities: {
      get: (id: string) => entities.get(id),
    },
    on: (event: string, handler: Handler) => {
      const eventHandlers = handlers.get(event) ?? new Set<Handler>();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
    },
    off: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) {
      handler(payload);
    }
  };

  const cleanup = registerDuelEventListeners({
    world: world as never,
    broadcastManager: {} as never,
    getSocketByPlayerId: (id) => sockets.get(id) as never,
    processedDuelSettlements: new Set(),
    executeDuelStakeTransferWithRetry: vi.fn(async () => undefined),
  });

  return { cleanup, emit };
}

const sessionPayload = {
  duelId: "duel-1",
  challengerId: "agent-a",
  challengerName: "Agent A",
  targetId: "agent-b",
  targetName: "Agent B",
};

const fightPayload = {
  duelId: "duel-1",
  arenaId: 1,
  challengerId: "agent-a",
  targetId: "agent-b",
  bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("duel socket delivery", () => {
  it("does not report missing sockets for server-owned agents", () => {
    const entities = new Map([
      ["agent-a", { data: { isAgent: true } }],
      ["agent-b", { data: { owner: "embedded-agent:agent-b" } }],
    ]);
    const harness = createHarness(entities);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    harness.emit("duel:session:created", sessionPayload);
    harness.emit("duel:fight:start", fightPayload);

    expect(warn).not.toHaveBeenCalled();
    harness.cleanup();
  });

  it("still reports missing sockets for client-owned contestants", () => {
    const entities = new Map([
      ["agent-a", { data: { isAgent: false } }],
      ["agent-b", { data: {} }],
    ]);
    const harness = createHarness(entities);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    harness.emit("duel:session:created", sessionPayload);
    harness.emit("duel:fight:start", fightPayload);

    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining("challenger agent-a"),
      expect.stringContaining("target agent-b"),
      expect.stringContaining("challenger agent-a"),
      expect.stringContaining("target agent-b"),
    ]);
    harness.cleanup();
  });

  it("delivers private preparation identity only to the two selected sockets", () => {
    const entities = new Map([
      ["agent-a", { data: { isAgent: true } }],
      ["agent-b", { data: { isAgent: true } }],
    ]);
    const agentASend = vi.fn();
    const agentBSend = vi.fn();
    const sockets = new Map([
      ["agent-a", { send: agentASend }],
      ["agent-b", { send: agentBSend }],
    ]);
    const harness = createHarness(entities, sockets);
    const preparationId = "11111111-1111-4111-8111-111111111111";

    harness.emit("duel:on-deck", {
      preparationId,
      selectedAt: 1_000,
      expiresAt: 61_000,
      agent1Id: "agent-a",
      agent1Name: "Agent A",
      agent1OpponentHistory: [{ private: "not-for-socket" }],
      agent2Id: "agent-b",
      agent2Name: "Agent B",
      agent2OpponentHistory: [{ private: "not-for-socket" }],
    });

    expect(agentASend).toHaveBeenCalledWith("duelOnDeck", {
      preparationId,
      selectedAt: 1_000,
      expiresAt: 61_000,
      opponentId: "agent-b",
      opponentName: "Agent B",
    });
    expect(agentBSend).toHaveBeenCalledWith("duelOnDeck", {
      preparationId,
      selectedAt: 1_000,
      expiresAt: 61_000,
      opponentId: "agent-a",
      opponentName: "Agent A",
    });
    expect(JSON.stringify(agentASend.mock.calls)).not.toContain("private");
    expect(JSON.stringify(agentBSend.mock.calls)).not.toContain("private");
    harness.cleanup();
  });

  it("delivers only correlated scalar preparation status to its contestant socket", () => {
    const entities = new Map([
      ["agent-a", { data: { isAgent: true } }],
      ["agent-b", { data: { isAgent: true } }],
    ]);
    const agentASend = vi.fn();
    const agentBSend = vi.fn();
    const harness = createHarness(
      entities,
      new Map([
        ["agent-a", { send: agentASend }],
        ["agent-b", { send: agentBSend }],
      ]),
    );
    const preparationId = "11111111-1111-4111-8111-111111111111";

    harness.emit("duel:preparation:agent_plan_status", {
      preparationId,
      agentId: "agent-a",
      status: "ready_for_validation",
      planEvidence: { private: true },
    });
    harness.emit("duel:preparation:readiness", {
      preparationId,
      agentId: "agent-a",
      agent1Ready: true,
      agent2Ready: false,
    });

    expect(agentASend).toHaveBeenNthCalledWith(1, "duelPreparationStatus", {
      preparationId,
      status: "validating",
    });
    expect(agentASend).toHaveBeenNthCalledWith(2, "duelPreparationStatus", {
      preparationId,
      status: "ready",
    });
    expect(agentBSend).not.toHaveBeenCalled();
    expect(JSON.stringify(agentASend.mock.calls)).not.toContain("private");
    harness.cleanup();
  });

  it("delivers a bounded strategy request only to the authenticated contestant", () => {
    const entities = new Map([
      ["agent-a", { data: { isAgent: true } }],
      ["agent-b", { data: { isAgent: true } }],
    ]);
    const agentASend = vi.fn();
    const agentBSend = vi.fn();
    const harness = createHarness(
      entities,
      new Map([
        ["agent-a", { send: agentASend }],
        ["agent-b", { send: agentBSend }],
      ]),
    );
    const request = {
      requestId: "33333333-3333-4333-8333-333333333333",
      preparationId: "11111111-1111-4111-8111-111111111111",
      policyVersion: "duel-preparation-role-v3",
      protocolVersion: "external-duel-preparation-strategy-v5",
      expiresAt: 20_000,
      decisionDeadlineAt: 10_000,
      agentName: "Agent A",
      opponentName: "Agent B",
      ownPublicProfile: { narrative: "Adaptive.", pillars: ["patient"] },
      opponentPublicProfile: null,
      opponentHistorySummary: {
        sampleSize: 1,
        observedOpponentOpeningStyleFocus: "ranged",
        recent: [
          {
            result: "loss",
            ownOpeningStyle: "melee",
            opponentOpeningStyle: "ranged",
            winReason: "kill",
          },
        ],
      },
      availableRoles: ["melee", "ranged"],
      availablePrayerIds: [],
      preparationOptions: [
        {
          planOptionId: "44444444-4444-4444-8444-444444444444",
          primaryStyle: "melee",
          styleRank: 1,
          attackSupplyUnits: null,
          canUseShield: true,
        },
        {
          planOptionId: "55555555-5555-4555-8555-555555555555",
          primaryStyle: "ranged",
          styleRank: 1,
          attackSupplyUnits: 20,
          canUseShield: false,
        },
      ],
      foodOptions: [
        {
          foodOptionId: "66666666-6666-4666-8666-666666666666",
          recoveryRank: 1,
          quantity: 4,
        },
        {
          foodOptionId: "77777777-7777-4777-8777-777777777777",
          recoveryRank: 2,
          quantity: 2,
        },
      ],
      armorOptions: [
        {
          armorOptionId: "88888888-8888-4888-8888-888888888888",
          planOptionId: "44444444-4444-4444-8444-444444444444",
          offenseRank: 1,
          focusedDefenseRank: null,
          totalDefenseRank: 1,
        },
        {
          armorOptionId: "99999999-9999-4999-8999-999999999999",
          planOptionId: "55555555-5555-4555-8555-555555555555",
          offenseRank: 1,
          focusedDefenseRank: null,
          totalDefenseRank: 1,
        },
      ],
      deterministicPlanOptionId: "44444444-4444-4444-8444-444444444444",
      deterministicFoodOptionId: "66666666-6666-4666-8666-666666666666",
      deterministicArmorOptionId: "88888888-8888-4888-8888-888888888888",
      deterministicRole: "melee",
    };

    harness.emit("duel:preparation:external_strategy_request", {
      agentId: "agent-a",
      ...request,
      opponentHistory: [{ private: true }],
      bankItems: [{ private: true }],
    });

    expect(agentASend).toHaveBeenCalledWith("duelPreparationStrategy", request);
    expect(agentBSend).not.toHaveBeenCalled();
    expect(JSON.stringify(agentASend.mock.calls)).not.toContain("private");
    expect(JSON.stringify(agentASend.mock.calls)).not.toContain("agentId");
    expect(JSON.stringify(agentASend.mock.calls)).not.toMatch(
      /cycleId|finishedAt|ownDamage|opponentDamage/iu,
    );
    harness.cleanup();
  });
});
