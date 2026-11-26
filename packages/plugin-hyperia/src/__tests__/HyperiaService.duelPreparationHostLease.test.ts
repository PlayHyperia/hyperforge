import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HyperiaService } from "../services/HyperiaService.js";

vi.mock("../systems/liveKit.js", () => ({
  AgentLiveKit: class {
    async stop(): Promise<void> {}
  },
}));

const preparationId = "11111111-1111-4111-8111-111111111111";
const preparationOptions = [
  {
    planOptionId: "22222222-2222-4222-8222-222222222222",
    primaryStyle: "melee",
    styleRank: 1,
    attackSupplyUnits: null,
    canUseShield: true,
  },
  {
    planOptionId: "33333333-3333-4333-8333-333333333333",
    primaryStyle: "ranged",
    styleRank: 1,
    attackSupplyUnits: 20,
    canUseShield: false,
  },
] as const;
const foodOptions = [
  {
    foodOptionId: "88888888-8888-4888-8888-888888888888",
    recoveryRank: 1,
    quantity: 4,
  },
  {
    foodOptionId: "99999999-9999-4999-8999-999999999999",
    recoveryRank: 2,
    quantity: 3,
  },
] as const;
const armorOptions = [
  {
    armorOptionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    planOptionId: preparationOptions[0].planOptionId,
    offenseRank: 1,
    focusedDefenseRank: null,
    totalDefenseRank: 1,
  },
  {
    armorOptionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    planOptionId: preparationOptions[1].planOptionId,
    offenseRank: 1,
    focusedDefenseRank: null,
    totalDefenseRank: 1,
  },
] as const;
const opponentHistorySummary = {
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
} as const;

type LeaseResponse = {
  action: "claim" | "heartbeat";
  preparationId: string;
  status: "active" | "rejected" | "unavailable";
  heartbeatAfterMs: number;
};

type TestInternals = {
  connectionState: { connected: boolean };
  gameState: { playerEntity: { id: string } | null };
  ws: object | null;
  sendCommand: (command: string, data: unknown) => void;
  broadcastEvent: (event: string, data: unknown) => void;
  updateGameStateFromPacket: (
    packetName: string,
    data: Record<string, unknown>,
  ) => void;
  handleDuelPreparationTransportClosure: (willReconnect: boolean) => void;
  resumeDuelPreparationHostLeaseAfterReconnect: () => void;
  handleDuelPreparationStrategyRequest: (data: unknown) => Promise<void>;
};

function createService(modelResponse: unknown = null) {
  const useModel = vi.fn().mockResolvedValue(modelResponse);
  const service = new HyperiaService({
    agentId: "external-preparation-agent",
    getSetting: vi.fn().mockReturnValue(null),
    useModel,
  } as never);
  const internals = service as unknown as TestInternals;
  const sendCommand = vi.fn();
  const broadcastEvent = vi.fn();
  internals.connectionState.connected = true;
  internals.gameState.playerEntity = { id: "external-preparation-agent" };
  internals.ws = {};
  internals.sendCommand = sendCommand;
  internals.broadcastEvent = broadcastEvent;
  return { internals, sendCommand, broadcastEvent, useModel };
}

function onDeck(internals: TestInternals): void {
  internals.updateGameStateFromPacket("duelOnDeck", {
    preparationId,
    selectedAt: 1_000,
    expiresAt: 61_000,
    opponentId: "opponent-agent",
    opponentName: "Opponent Agent",
  });
}

function settleLatest(
  internals: TestInternals,
  sendCommand: ReturnType<typeof vi.fn>,
  response: Omit<LeaseResponse, "preparationId">,
): void {
  const request = [...sendCommand.mock.calls]
    .reverse()
    .find(([command]) => command === "duelPreparationHostLease")?.[1] as {
    requestId: string;
  };
  internals.updateGameStateFromPacket("duelPreparationHostLease", {
    requestId: request.requestId,
    preparationId,
    ...response,
  });
}

describe("HyperiaService private-preparation host leases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims before on-deck behavior and maintains one non-overlapping heartbeat", async () => {
    const { internals, sendCommand, broadcastEvent } = createService();
    onDeck(internals);

    expect(broadcastEvent).not.toHaveBeenCalledWith(
      "DUEL_ON_DECK",
      expect.anything(),
    );
    const claim = sendCommand.mock.calls[0];
    expect(claim?.[0]).toBe("duelPreparationHostLease");
    expect(claim?.[1]).toMatchObject({
      action: "claim",
      preparationId,
      executableBuildId: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(claim?.[1]).not.toHaveProperty("agentId");

    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    expect(broadcastEvent).toHaveBeenCalledWith(
      "DUEL_ON_DECK",
      expect.objectContaining({ preparationId }),
    );

    await vi.advanceTimersByTimeAsync(3_000);
    const heartbeat = sendCommand.mock.calls.at(-1);
    expect(heartbeat?.[0]).toBe("duelPreparationHostLease");
    expect(heartbeat?.[1]).toMatchObject({
      action: "heartbeat",
      preparationId,
      ownerId: (claim?.[1] as { ownerId: string }).ownerId,
      executableBuildId: (claim?.[1] as { executableBuildId: string })
        .executableBuildId,
    });

    // An unresolved heartbeat owns the only in-flight slot.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(
      sendCommand.mock.calls.filter(
        ([command, payload]) =>
          command === "duelPreparationHostLease" &&
          (payload as { action?: string }).action === "heartbeat",
      ),
    ).toHaveLength(1);
    settleLatest(internals, sendCommand, {
      action: "heartbeat",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();
  });

  it("retries transient claim failure with the same immutable host identity", async () => {
    const { internals, sendCommand, broadcastEvent } = createService();
    onDeck(internals);
    const first = sendCommand.mock.calls[0]?.[1] as {
      ownerId: string;
      preparationId: string;
      executableBuildId: string;
    };

    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "unavailable",
      heartbeatAfterMs: 1_000,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = sendCommand.mock.calls.at(-1)?.[1] as {
      ownerId: string;
      preparationId: string;
      executableBuildId: string;
    };
    expect(retry).toMatchObject({
      ownerId: first.ownerId,
      preparationId: first.preparationId,
      executableBuildId: first.executableBuildId,
    });
    expect(broadcastEvent).not.toHaveBeenCalled();

    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();
    expect(broadcastEvent).toHaveBeenCalledOnce();
  });

  it("retains exact owner across abnormal reconnect but clears on terminal events", async () => {
    const { internals, sendCommand, broadcastEvent } = createService();
    onDeck(internals);
    const ownerId = (sendCommand.mock.calls[0]?.[1] as { ownerId: string })
      .ownerId;
    const executableBuildId = (
      sendCommand.mock.calls[0]?.[1] as { executableBuildId: string }
    ).executableBuildId;
    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();

    internals.handleDuelPreparationTransportClosure(true);
    internals.connectionState.connected = true;
    internals.ws = {};
    internals.resumeDuelPreparationHostLeaseAfterReconnect();
    const reconnectClaim = sendCommand.mock.calls.at(-1)?.[1] as {
      action: string;
      ownerId: string;
      executableBuildId: string;
    };
    expect(reconnectClaim).toMatchObject({
      action: "claim",
      ownerId,
      executableBuildId,
    });
    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();

    internals.updateGameStateFromPacket("duelCancelled", {
      preparationId,
      duelId: null,
    });
    const sentBefore = sendCommand.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sendCommand).toHaveBeenCalledTimes(sentBefore);
    expect(broadcastEvent).toHaveBeenCalledWith(
      "DUEL_CANCELLED",
      expect.anything(),
    );
  });

  it("never starts preparation after deterministic claim rejection", async () => {
    const { internals, sendCommand, broadcastEvent } = createService();
    onDeck(internals);
    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "rejected",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();

    expect(broadcastEvent).not.toHaveBeenCalledWith(
      "DUEL_ON_DECK",
      expect.anything(),
    );
    const sentBefore = sendCommand.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sendCommand).toHaveBeenCalledTimes(sentBefore);
  });

  it("fails closed on a mismatched acknowledgement and retries the exact claim", async () => {
    const { internals, sendCommand, broadcastEvent } = createService();
    onDeck(internals);
    const request = sendCommand.mock.calls[0]?.[1] as {
      requestId: string;
      ownerId: string;
    };
    internals.updateGameStateFromPacket("duelPreparationHostLease", {
      requestId: request.requestId,
      preparationId: "22222222-2222-4222-8222-222222222222",
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();
    expect(broadcastEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendCommand.mock.calls.at(-1)?.[1]).toMatchObject({
      action: "claim",
      preparationId,
      ownerId: request.ownerId,
    });
  });

  it("revokes an announced local preparation before claiming a replacement", async () => {
    const { internals, sendCommand, broadcastEvent } = createService();
    onDeck(internals);
    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();

    const replacementId = "33333333-3333-4333-8333-333333333333";
    internals.updateGameStateFromPacket("duelOnDeck", {
      preparationId: replacementId,
      selectedAt: 2_000,
      expiresAt: 62_000,
      opponentId: "replacement-opponent",
      opponentName: "Replacement Opponent",
    });

    expect(broadcastEvent).toHaveBeenCalledWith("DUEL_PREPARATION_REVOKED", {
      preparationId,
      reason: "host_lease_inactive",
    });
    expect(sendCommand.mock.calls.at(-1)?.[1]).toMatchObject({
      action: "claim",
      preparationId: replacementId,
    });
  });

  it("forwards only exact correlated private preparation status", () => {
    const { internals, broadcastEvent } = createService();

    internals.updateGameStateFromPacket("duelPreparationStatus", {
      preparationId,
      status: "ready",
      bankItems: [{ itemId: "must-not-forward", quantity: 99 }],
    });
    internals.updateGameStateFromPacket("duelPreparationStatus", {
      preparationId: "malformed",
      status: "ready",
    });
    internals.updateGameStateFromPacket("duelPreparationStatus", {
      preparationId,
      status: "unknown",
    });

    expect(broadcastEvent).toHaveBeenCalledOnce();
    expect(broadcastEvent).toHaveBeenCalledWith("DUEL_PREPARATION_STATUS", {
      preparationId,
      status: "ready",
    });
    expect(JSON.stringify(broadcastEvent.mock.calls)).not.toContain(
      "must-not-forward",
    );
  });

  it("ignores strategy requests until the exact private-preparation lease is active", async () => {
    const { internals, sendCommand, useModel } = createService("{}");
    onDeck(internals);

    await internals.handleDuelPreparationStrategyRequest({
      requestId: "77777777-7777-4777-8777-777777777777",
      preparationId,
      policyVersion: "duel-preparation-role-v3",
      protocolVersion: "external-duel-preparation-strategy-v5",
      expiresAt: 61_000,
      decisionDeadlineAt: 5_000,
      agentName: "External Agent",
      opponentName: "Opponent Agent",
      ownPublicProfile: null,
      opponentPublicProfile: null,
      opponentHistorySummary,
      availableRoles: ["melee", "ranged"],
      availablePrayerIds: [],
      preparationOptions,
      foodOptions,
      armorOptions,
      deterministicPlanOptionId: preparationOptions[0].planOptionId,
      deterministicFoodOptionId: foodOptions[0].foodOptionId,
      deterministicArmorOptionId: armorOptions[0].armorOptionId,
      deterministicRole: "melee",
    });

    expect(useModel).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalledWith(
      "duelPreparationStrategy",
      expect.anything(),
    );
  });

  it("uses the external ElizaOS model once and returns only a strict bounded strategy", async () => {
    const decision = {
      armorOptionId: armorOptions[1].armorOptionId,
      planOptionId: preparationOptions[1].planOptionId,
      foodOptionId: foodOptions[1].foodOptionId,
      primaryStyle: "ranged",
      reason: "Open at range and adapt.",
      tacticalStrategy: {
        approach: "balanced",
        tacticalMacro: "kite",
        attackStyle: "accurate",
        prayer: null,
        preferredCombatRole: "ranged",
        foodThreshold: 40,
        switchDefensiveAt: 30,
        reasoning: "Preserve distance until finishing pressure is safe.",
      },
    };
    const { internals, sendCommand, useModel } = createService(
      JSON.stringify(decision),
    );
    onDeck(internals);
    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();

    const strategyRequest = {
      requestId: "44444444-4444-4444-8444-444444444444",
      preparationId,
      policyVersion: "duel-preparation-role-v3",
      protocolVersion: "external-duel-preparation-strategy-v5",
      expiresAt: 61_000,
      decisionDeadlineAt: 5_000,
      agentName: "External Agent",
      opponentName: "Opponent Agent",
      ownPublicProfile: { narrative: "Adaptive.", pillars: ["patient"] },
      opponentPublicProfile: null,
      opponentHistorySummary,
      availableRoles: ["melee", "ranged"],
      availablePrayerIds: [],
      preparationOptions,
      foodOptions,
      armorOptions,
      deterministicPlanOptionId: preparationOptions[0].planOptionId,
      deterministicFoodOptionId: foodOptions[0].foodOptionId,
      deterministicArmorOptionId: armorOptions[0].armorOptionId,
      deterministicRole: "melee",
    };
    await internals.handleDuelPreparationStrategyRequest(strategyRequest);

    expect(useModel).toHaveBeenCalledOnce();
    const prompt = useModel.mock.calls[0]?.[1]?.prompt as string;
    expect(prompt).toContain("BEGIN_EXTERNAL_DUEL_STRATEGY_CONTEXT_JSON");
    expect(prompt).toContain("styleRank");
    expect(prompt).toContain("recoveryRank");
    expect(prompt).toContain("focusedDefenseRank");
    expect(prompt).toContain("opponentHistorySummary");
    expect(prompt).not.toContain("cycleId");
    expect(prompt).not.toContain("finishedAt");
    expect(prompt).not.toContain("ownDamage");
    expect(prompt).not.toContain("opponentDamage");
    expect(prompt).toContain(foodOptions[1].foodOptionId);
    expect(prompt).not.toContain("itemId");
    expect(prompt).not.toContain('"opponentHistory":');
    expect(sendCommand).toHaveBeenCalledWith("duelPreparationStrategy", {
      requestId: strategyRequest.requestId,
      preparationId,
      status: "selected",
      decision,
    });

    await internals.handleDuelPreparationStrategyRequest({
      ...strategyRequest,
      requestId: "55555555-5555-4555-8555-555555555555",
    });
    expect(useModel).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith(
      "duelPreparationStrategy",
      expect.objectContaining({
        requestId: "55555555-5555-4555-8555-555555555555",
        status: "selected",
      }),
    );

    await internals.handleDuelPreparationStrategyRequest({
      ...strategyRequest,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      opponentHistorySummary: {
        sampleSize: 0,
        observedOpponentOpeningStyleFocus: null,
        recent: [],
      },
    });
    expect(useModel).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith("duelPreparationStrategy", {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      preparationId,
      status: "fallback",
      decision: null,
    });
  });

  it("falls back without leaking malformed model output", async () => {
    const { internals, sendCommand, useModel } = createService(
      JSON.stringify({ primaryStyle: "ranged", itemId: "private-item" }),
    );
    onDeck(internals);
    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();
    await internals.handleDuelPreparationStrategyRequest({
      requestId: "66666666-6666-4666-8666-666666666666",
      preparationId,
      policyVersion: "duel-preparation-role-v3",
      protocolVersion: "external-duel-preparation-strategy-v5",
      expiresAt: 61_000,
      decisionDeadlineAt: 5_000,
      agentName: "External Agent",
      opponentName: "Opponent Agent",
      ownPublicProfile: null,
      opponentPublicProfile: null,
      opponentHistorySummary,
      availableRoles: ["melee", "ranged"],
      availablePrayerIds: [],
      preparationOptions,
      foodOptions,
      armorOptions,
      deterministicPlanOptionId: preparationOptions[0].planOptionId,
      deterministicFoodOptionId: foodOptions[0].foodOptionId,
      deterministicArmorOptionId: armorOptions[0].armorOptionId,
      deterministicRole: "melee",
    });

    expect(useModel).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith("duelPreparationStrategy", {
      requestId: "66666666-6666-4666-8666-666666666666",
      preparationId,
      status: "fallback",
      decision: null,
    });
    expect(JSON.stringify(sendCommand.mock.calls)).not.toContain(
      "private-item",
    );
  });

  it("returns one fallback before the exact deadline when the model never settles", async () => {
    const neverSettles = new Promise<string>(() => undefined);
    const { internals, sendCommand, useModel } = createService(neverSettles);
    onDeck(internals);
    settleLatest(internals, sendCommand, {
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    await Promise.resolve();

    const strategyRequest = {
      requestId: "77777777-7777-4777-8777-777777777777",
      preparationId,
      policyVersion: "duel-preparation-role-v3",
      protocolVersion: "external-duel-preparation-strategy-v5",
      expiresAt: 61_000,
      decisionDeadlineAt: 5_000,
      agentName: "External Agent",
      opponentName: "Opponent Agent",
      ownPublicProfile: null,
      opponentPublicProfile: null,
      opponentHistorySummary,
      availableRoles: ["melee", "ranged"],
      availablePrayerIds: [],
      preparationOptions,
      foodOptions,
      armorOptions,
      deterministicPlanOptionId: preparationOptions[0].planOptionId,
      deterministicFoodOptionId: foodOptions[0].foodOptionId,
      deterministicArmorOptionId: armorOptions[0].armorOptionId,
      deterministicRole: "melee",
    };
    const response =
      internals.handleDuelPreparationStrategyRequest(strategyRequest);
    await Promise.resolve();
    expect(useModel).toHaveBeenCalledOnce();
    expect(
      sendCommand.mock.calls.filter(
        ([command]) => command === "duelPreparationStrategy",
      ),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_899);
    expect(
      sendCommand.mock.calls.filter(
        ([command]) => command === "duelPreparationStrategy",
      ),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await response;
    expect(Date.now()).toBe(4_900);
    expect(
      sendCommand.mock.calls.filter(
        ([command]) => command === "duelPreparationStrategy",
      ),
    ).toEqual([
      [
        "duelPreparationStrategy",
        {
          requestId: strategyRequest.requestId,
          preparationId,
          status: "fallback",
          decision: null,
        },
      ],
    ]);

    await vi.advanceTimersByTimeAsync(200);
    expect(useModel).toHaveBeenCalledOnce();
    expect(
      sendCommand.mock.calls.filter(
        ([command]) => command === "duelPreparationStrategy",
      ),
    ).toHaveLength(1);
  });
});
